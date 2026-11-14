// 后台刷新，前台不卡（PRD-refresh.md）。
//
// 病根是实测出来的：本会话 272MB 源，build() 一次 11.6 秒，而它是同步的——旧 data.json
// 处理器 await 它的那 11.6 秒里整个 hub 停摆（App 壳、别的会话、连 /health 都答不了）。
// store 里已经有完整派生结构，把已有的画出来只要 readView（149ms），根本不必等 build。
//
// 所以分成两条线程：主线程只服务缓存、只做便宜的事（stat 签名、读 notes/requests 小表、
// 算 lagSec）；build/readView/statusSnapshot 这些重算挪进一个懒起的 worker，算完整份 post
// 回来，主线程原子换缓存。请求一律即时返回，后台还没算完就返回上一次真实构建并标 refreshing。
//
// 【2026-11-13 卡死修复】主线程里曾留着「worker 起不来就内联算一遍」的兜底，以及
// /projects.json、项目页直接同步调 projectsOf / projectLive / insights 的路径。2836 本账本时
// 这些单次 9.7–13.5 秒，5 秒轮询让事件循环永远清不空，连 /health 都排不上队（页面
// Failed to fetch）。现在主线程**没有任何全库重活**：status/sessions/usage/projects/project
// 一律走 worker + 单飞缓存，缓存冷开返回结构完整的空壳并标 refreshing，绝不 await 重算、
// 绝不内联兜底。worker 挂了就留旧快照，下一轮再试。
//
// worker 懒起 + unref：--rebuild 0 且模型层没变的自测路径从不 spawn 它；hub stop() 时 terminate。
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { readView } from './view.mjs';
import { readNotes, readRequests } from './notes.mjs';
// 宿主进程探测走 spawnSync('tasklist')：主线程能跑，但 worker 线程里会死锁（同步阻塞工作线程，
// 连 5s 超时都触发不了 → status job 永不完成、仪表盘永远空白）。所以改在主线程算好 running，
// 通过 job 传给 worker，worker 里的 statusSnapshot 收到 running 就不自己 spawn。
import { detectRunningHosts } from './status.mjs';

// core＝readView 真正读的结构与模型层；human＝人写的两张小表。分开签名，才能把
// 「写了一条标注」这种便宜变化内联补掉，而把「模型层改写/重建」交给后台 worker。
const CORE_FILES = ['ledger.json', 'facts.json', 'claims.json', 'index.md', 'summaries.json', 'phases.json', 'chapters.json', 'topics.json'];
const HUMAN_FILES = ['notes.json', 'requests.jsonl'];

const sigFiles = (dir, files) => files.map((f) => {
  try { const s = fs.statSync(path.join(dir, f)); return `${s.mtimeMs}:${s.size}`; } catch { return '0'; }
}).join('|');
export const coreSig = (dir) => sigFiles(dir, CORE_FILES);
export const humanSig = (dir) => sigFiles(dir, HUMAN_FILES);

/** 内联补丁人写层：字段与 readView 的 notes/meta 逐字一致（view.mjs 的 humanNotes/requestsPending）。
 *  绕过 hub 直接改文件（closeRequest）也靠 mtime 签名当场认出来，下一轮 GET 立刻新鲜。 */
export function patchHuman(payload, dir) {
  const human = readNotes(dir);
  const queue = readRequests(dir);
  payload.notes = human.notes;
  payload.meta.humanNotes = human.notes.length;
  payload.meta.requestsPending = queue.rows.filter((r) => !r.done).length;
  if (queue.bad) payload.meta.requestsBad = queue.bad; else delete payload.meta.requestsBad;
}

/** 落后秒数＝源最后写入 − 账本构建（源不比账本新就是 0）。口径与旧 data.json 处理器逐字一致。 */
export function applyDynamicMeta(payload) {
  try {
    const src = payload.meta?.sourceFile;
    const builtMs = Date.parse(payload.meta?.builtAt ?? '');
    if (src) {
      const srcMs = fs.statSync(src).mtimeMs;
      payload.meta.sourceMtime = new Date(srcMs).toISOString();
      payload.meta.lagSec = Number.isFinite(builtMs) ? Math.max(0, Math.round((srcMs - builtMs) / 1000)) : null;
    } else payload.meta.lagSec = null;
  } catch { payload.meta.lagSec = null; }
}

/** 一个 hub 一份刷新管理器：懒起单例 worker + 视图缓存 + App 快照缓存。 */
export function createRefresh() {
  let worker = null;
  let seq = 0;
  const pending = new Map();        // job id -> {resolve,reject}
  const views = new Map();          // dir -> {core,human,payload}
  const jobs = new Map();           // dir -> {pending,lastBuiltMs}
  const builds = new Map();         // dir -> {pending,payload}：未建账会话的占位与在飞 build
  let sweepPending = false;         // 在飞的自动建账 sweep（一次只跑一个）
  // 全库级快照的统一缓存：key -> {payload,at,job}。at=0 表示还没有真实数据，
  // 此时返回结构完整的空壳，等 worker 算完原子替换；同一 key 同时只飞一个 job。
  const cache = new Map();

  function dropWorker() {
    for (const [, p] of pending) p.reject(new Error('刷新 worker 已退出'));
    pending.clear();
    worker = null;
  }

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(new URL('./refresh-worker.mjs', import.meta.url));
    worker.unref();   // 不占住事件循环：自测进程能正常退出
    worker.on('message', (m) => {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m); else p.reject(new Error(m.error || '后台刷新失败'));
    });
    worker.on('error', (e) => { for (const [, p] of pending) p.reject(e); pending.clear(); try { worker.terminate(); } catch { /* 已死 */ } worker = null; });
    worker.on('exit', dropWorker);
    return worker;
  }

  function dispatch(job) {
    const w = ensureWorker();
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      w.postMessage({ ...job, id });
    });
  }

  /** 后台重算一段会话的视图：源比账本新且 TTL 到就 build，否则只 readView。一次只跑一个。 */
  function backgroundView(root, st, js, rebuildSec, coreChanged) {
    if (js.pending) return;
    const entry = views.get(st.dir);
    const sf = entry?.payload?.meta?.sourceFile || null;
    let srcMs = 0;
    if (sf) { try { srcMs = fs.statSync(sf).mtimeMs; } catch { /* 源被清了：不 build */ } }
    const builtMs = Date.parse(entry?.payload?.meta?.builtAt ?? '') || 0;
    const ttlOk = rebuildSec > 0 && (Date.now() - js.lastBuiltMs >= rebuildSec * 1000);
    const needBuild = ttlOk && srcMs > builtMs;   // 源没比账本新就不 build：看静止会话零 CPU
    if (!needBuild && !coreChanged) return;
    js.pending = true;
    dispatch({ kind: 'view', root, dir: st.dir, rebuild: needBuild })
      .then((m) => {
        js.pending = false; js.lastBuiltMs = Date.now();
        views.set(st.dir, { core: m.core, human: m.human, payload: m.payload });
        st.lastError = null;
      })
      .catch((e) => {
        js.pending = false; js.lastBuiltMs = Date.now();
        st.lastError = String(e?.message ?? e).split('\n')[0];
      });
  }

  /** 未建账会话的占位载荷：空结构＋building 标记。前台据此显示「正在建账」骨架，不崩。 */
  function buildingPlaceholder(st) {
    return {
      schema: 1,
      meta: {
        sessionId: st.id, building: true, refreshing: true,
        sourceFile: st.sourceFile ?? null, segs: 0, verified: 0, boundaries: 0,
      },
      nodes: [], tasks: [], steps: [], phases: [], chapters: [], notes: [],
      brief: null, tail: null,
    };
  }

  /** 冷开遇 ledger 不存在：派后台 build，即时回占位（绝不内联 build）。建完下一轮出真视图。 */
  function buildingView(root, st) {
    const dir = st.dir;
    let b = builds.get(dir);
    if (!b) { b = { pending: false, payload: buildingPlaceholder(st) }; builds.set(dir, b); }
    if (!b.pending && st.sourceFile) {
      b.pending = true;
      dispatch({ kind: 'build', root, dir, sourceFile: st.sourceFile })
        .then(() => { b.pending = false; builds.delete(dir); st.lastError = null; })
        .catch((e) => { b.pending = false; st.lastError = String(e?.message ?? e).split('\n')[0]; });
    }
    b.payload.meta.refreshing = b.pending;
    return { payload: b.payload, refreshing: b.pending };
  }

  /** 即时返回会话视图（命中缓存 0ms）。冷开内联 readView 一次；重算一律后台。 */
  function getView(root, st, rebuildSec) {
    const dir = st.dir;
    // 未建账（打开一段旧对话）：后台建账＋占位，不在主线程 build（PRD-load §2.4）。
    if (!fs.existsSync(path.join(dir, 'ledger.json'))) return buildingView(root, st);
    const core = coreSig(dir), human = humanSig(dir);
    let js = jobs.get(dir);
    if (!js) { js = { pending: false, lastBuiltMs: 0 }; jobs.set(dir, js); }
    let entry = views.get(dir);
    let coreChanged = false;
    if (!entry) {
      // 冷开：store 已有完整结构，readView 一次就能画（最坏 149ms，仅一次）。绝不内联 build。
      const payload = readView(dir);
      entry = { core, human, payload };
      views.set(dir, entry);
      js.lastBuiltMs = Date.parse(payload.meta?.builtAt ?? '') || 0;
    } else if (entry.core !== core) {
      coreChanged = true;   // 模型层/重建落盘变了：返回旧的，后台重算
    } else if (entry.human !== human) {
      patchHuman(entry.payload, dir);
      entry.human = human;
    }
    backgroundView(root, st, js, rebuildSec, coreChanged);
    applyDynamicMeta(entry.payload);
    return { payload: entry.payload, refreshing: js.pending };
  }

  const EMPTY_STATUS = {
    at: new Date().toISOString(), hosts: [], lessons: [], memories: [], dims: [], recent: [], repo: '',
    totals: { sessions: 0, segments: 0, blocks: 0, sums: 0, phases: 0, titles: 0, verified: 0, live: 0, chapters: 0, lessons: 0, memory: {} },
  };
  const EMPTY_SESSIONS = { groups: [], current: null, counts: { sessions: 0, skipped: 0 } };
  const EMPTY_PROJECT_DETAIL = {
    live: { ok: false, at: new Date().toISOString(), members: 0, liveCount: 0, session: null, step: null, pendingBytes: null },
    insights: { experience: { groups: [], total: 0, sessions: 0 }, profile: { project: {}, user: {} }, memory: null },
  };
  const EMPTY_USAGE = {
    ok: false, at: new Date().toISOString(), refreshing: true, basis: '', scanned: { files: 0, hostFiles: 0, errors: [] },
    totals: {}, sources: [], sessions: [], injections: [], readback: {},
  };

  /** 唯一的全库快照通道：命中即回；过期/冷开回旧值或空壳 + 派一个后台 job；绝不阻塞请求。
   *  冷开给后台 1.5s 宽限：小夹具（worker 里 status→projects 串行排队）能出真数据，
   *  真机 2836 本算不完就回空壳并标 refreshing，5 秒后轮询补上。等待是 await（不占事件循环），
   *  /health 与别的请求照常即时响应——这才是不卡死的关键，不是把等待压到 0。 */
  const COLD_WAIT_MS = 1500;
  async function cached(key, ttlMs, job, fallback, pick, { fresh = false } = {}) {
    let e = cache.get(key);
    if (!e) { e = { payload: fallback, at: 0, job: null }; cache.set(key, e); }
    if (fresh) e.at = 0;
    if (e.at && Date.now() - e.at < ttlMs) return { payload: e.payload, refreshing: !!e.job };
    if (!e.job) {
      e.job = dispatch(job)
        .then((m) => { e.payload = pick(m); e.at = Date.now(); })
        .catch(() => { /* worker 挂了：留旧快照/空壳，下一轮再试，绝不内联兜底 */ })
        .finally(() => { e.job = null; });
    }
    if (!e.at) await Promise.race([e.job, new Promise((r) => setTimeout(r, COLD_WAIT_MS))]);
    return { payload: e.payload, refreshing: !!e.job };
  }

  /** App 快照（status + sessions 共用一份）：冷开也给结构完整的空壳，5 秒后轮询出真数据。
   *  running 在主线程算（detectRunningHosts 走 spawnSync，worker 里会死锁），通过 job 传进 worker，
   *  避免 worker 内同步派 tasklist 卡死。 */
  async function appSnapshot(root, opts = {}) {
    const running = detectRunningHosts();
    return cached('app', 8000, { kind: 'status', root, running },
      { status: EMPTY_STATUS, sessions: EMPTY_SESSIONS },
      (m) => ({ status: m.status, sessions: m.sessions }), opts);
  }

  /** 自动建账 sweep：派给后台 worker，串行、封顶。主线程只负责派发，不 listSessions/build。
   *  一次只跑一个（sweepPending）；off 模式直接不派。节流（15s）由调用方 map 把握。 */
  function sweep(root, { mode = 'active', liveMin = 15, cap = 1 } = {}) {
    if (sweepPending || mode === 'off') return;
    sweepPending = true;
    dispatch({ kind: 'sweep', root, mode, liveMin, cap })
      .then(() => { sweepPending = false; })
      .catch(() => { sweepPending = false; });
  }

  /** 用量统计：首次要读几百 MB 宿主日志，只能走 worker；主线程冷开也即时回空壳。 */
  async function getUsage(root, { fresh = false } = {}) {
    return cached('usage', 30000, { kind: 'usage', root, force: fresh },
      EMPTY_USAGE, (m) => m.payload, { fresh });
  }

  /** 项目清单：projectsOf 要遍历全部账本（实测 11.7s），只能走 worker。 */
  async function getProjects(root, { fresh = false } = {}) {
    return cached('projects', 15000, { kind: 'projects', root },
      { projects: [], membersByKey: {}, rootKeys: [] },
      (m) => ({ projects: m.projects, membersByKey: m.membersByKey ?? {}, rootKeys: m.rootKeys ?? [] }), { fresh });
  }

  /** 项目页实时/经验/画像/记忆欠项：四条全库重活合成一个后台 job。 */
  async function getProjectDetail(root, key, { fresh = false } = {}) {
    return cached(`project|${root}|${key}`, 15000, { kind: 'project', root, key },
      EMPTY_PROJECT_DETAIL, (m) => ({ live: m.live, insights: m.insights }), { fresh });
  }

  return {
    getView,
    getUsage,
    getProjects,
    getProjectDetail,
    sweep,
    async getStatus(root, opts = {}) { const a = await appSnapshot(root, opts); return { payload: a.payload.status, refreshing: a.refreshing }; },
    async getSessions(root, opts = {}) { const a = await appSnapshot(root, opts); return { payload: a.payload.sessions, refreshing: a.refreshing }; },
    invalidateApp() { const e = cache.get('app'); if (e) e.at = 0; },
    stop() { if (worker) { try { worker.terminate(); } catch { /* 已死 */ } } dropWorker(); for (const e of cache.values()) e.job = null; sweepPending = false; },
  };
}
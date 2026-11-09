// map — 一个 hub 服务所有会话：固定端口 + 按会话路径（/s/<会话>/）。
//
// 旧口径是「一段会话一张画布、一段会话一个端口」（8765 起往后扫）：两个 agent
// 同时用就是两个端口两个网址，谁先起谁占着。现在只有一个服务、一个地址，
// 会话由路径决定；`/` 是会话库，`/s/<sid>/` 是某段会话的画布。
// 契约见 tool/PRD-maphub.md。
//
// The page (./../web) is a shell plus a JSON poll, not a server-rendered document:
// re-rendering from /data.json keeps selection and scroll alive across refreshes.
// The payload publishes only what the route layer already publishes — structure,
// anchors, one-liners. Bodies stay in the runner's JSONL: the map points at them with
// an anchor, `convledger body Sxx` re-reads them.
// 画布服务过的会话会在 store 里留一份逐字归档（source.jsonl）；源日志被运行器清掉后，
// /body 改读归档并在正文首行声明——这张画布的价值之一是让这段对话不随运行器消失。
// Bound to 127.0.0.1 and Host-fenced, the same posture other local bridges use.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { build } from './build.mjs';
import { loadLedger, renderBody, resolveSegments, storeDir, writeStore, syncArchive, archiveState } from './store.mjs';
import { readView } from './view.mjs';
import { handoffText } from './brief.mjs';
import { syncOpencodeSession } from './opencode.mjs';
import { appendNote, appendRequest } from './notes.mjs';
import { BODY_BUDGET_TOKENS } from './cost.mjs';
import { findSession, libraryOf } from './library.mjs';
import { projectsOf } from './projects.mjs';
import { readState, stateFile } from './state-io.mjs';
import { projectView } from './progress.mjs';
import { projectLive } from './project-live.mjs';
import { listSessions } from './project.mjs';
import { projectPageHtml } from './project-page.mjs';
import { readPrefs, writePrefs } from './prefs.mjs';
import { projectExperience, projectProfile } from './insights.mjs';

const WEB = new URL('../web/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1').replace(/\\/g, '/');
// fixed allowlist, not a path join: the url comes from a browser.
// `/` 是会话库；`/s/<sid>/` 出流程图；`/atlas` 留作旧别名（跳到最近写入的那段会话）。
const ASSETS = {
  '/': ['hub.html', 'text/html; charset=utf-8'],
  '/hub.css': ['hub.css', 'text/css; charset=utf-8'],
  '/hub.js': ['hub.js', 'text/javascript; charset=utf-8'],
  '/atlas.css': ['atlas.css', 'text/css; charset=utf-8'],
  '/atlas.js': ['atlas.js', 'text/javascript; charset=utf-8'],
  '/architecture': ['architecture.html', 'text/html; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/icon-small.svg': ['icon-small.svg', 'image/svg+xml'],
  '/agent-icons/qoder.png': ['agents/qoder.png', 'image/png'],
  '/agent-icons/claude-code.png': ['agents/claude-code.png', 'image/png'],
  '/agent-icons/workbuddy.png': ['agents/workbuddy.png', 'image/png'],
  '/agent-icons/opencode.png': ['agents/opencode.png', 'image/png'],
  '/agent-icons/codex.png': ['agents/codex.png', 'image/png'],
};
const CANVAS = ['atlas.html', 'text/html; charset=utf-8'];

export function asset(url) {
  const hit = ASSETS[String(url).split('?')[0]];
  if (!hit) return null;
  return { type: hit[1], body: fs.readFileSync(path.join(WEB, hit[0])) };
}

/** 架构页的工作路线图：读当前任务最多的项目，实时生成；不把快照写进 HTML。 */
function roadmapNow(root) {
  let best = null;
  try {
    const list = projectsOf(root, { withSteps: false }).projects.filter((p) => p.root);
    for (const p of list) {
      try {
        const st = readState(root, p.key).state;
        if (!best || (st.tasks?.length ?? 0) > (best.state.tasks?.length ?? 0)) best = { key: p.key, state: st };
      } catch { /* 这个项目的状态读不了，跳过 */ }
    }
  } catch { /* 没有项目层 */ }
  if (!best) return { project: null, revision: 0, milestones: [], tasks: [] };
  const v = projectView(best.state);
  return {
    project: best.key,
    revision: v.revision,
    milestones: v.milestones.map((m) => ({ id: m.id, short: m.short, title: m.title, goal: m.goal })),
    tasks: v.tasks.map((t) => ({
      id: t.id, pm: t.milestoneId, short: t.short, title: t.title,
      status: t.status, result: t.result, remaining: t.remaining,
      accept: (t.acceptance ?? []).map((a) => a.condition),
    })),
  };
}

const HOST_OK = (host, port) => {
  const h = String(host || '').toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === '127.0.0.1' || h === 'localhost';
};

// The page is the only legitimate writer, and it is same-origin. A cross-origin page
// cannot send application/json without a preflight this server never grants, and a
// missing Origin (curl, the probe) is allowed — the Host fence already keeps other
// hosts out. Reads stay open to both origins only in the sense that same-origin pages
// send no Origin on GET; a hostile GET cannot write anything.
const ORIGIN_OK = (origin, port) => !origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;

const readBody = (req, limit = 64 * 1024) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on('data', (d) => {
    size += d.length;
    if (size > limit) { reject(new Error(`请求体超过 ${limit} 字节`)); req.destroy(); return; }
    chunks.push(d);
  });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

/** hub 的探活：只认 {hub:true}。端口上活着别的服务不算数——地址稳定优先。 */
export async function probeHub(port, { tries = 2, timeout = 1500 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeout) });
      if (r.ok) {
        const j = await r.json();
        if (j?.hub === true) return j;
        return null;
      }
    } catch { /* 重试一次再判 */ }
  }
  return null;
}

export const hubFile = (root) => path.join(path.dirname(root), 'hub.json');

function listenOnce(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (e) => { server.off('listening', onListening); reject(e); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

const iso = (t) => {
  if (t == null || t === '') return null;
  const v = typeof t === 'string' && /^\d{10,13}$/.test(t) ? Number(t) : t;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** 每段会话一份运行态：归档同步一次，重建按 TTL 节流。没人看的会话不重建。 */
const SESS = new Map();   // `${root}\0${id}` -> state
function stateOf(root, id) {
  const key = `${root}\0${id}`;
  let st = SESS.get(key);
  if (!st) {
    st = { id, dir: storeDir(root, id), lastError: null, lastBuiltMs: 0, building: null, synced: false };
    SESS.set(key, st);
  }
  return st;
}

function syncArchiveOnce(st) {
  if (st.synced) return;
  st.synced = true;
  try {
    const file = JSON.parse(fs.readFileSync(path.join(st.dir, 'ledger.json'), 'utf8')).sourceFile;
    if (file) syncArchive(st.dir, file);
  } catch { /* 账本还读不到：重建会把原因写进 lastError */ }
}

function rebuildOnce(root, st) {
  const ledger = JSON.parse(fs.readFileSync(path.join(st.dir, 'ledger.json'), 'utf8'));
  const file = ledger.sourceFile;
  // OpenCode 的画布源是投影文件：重建前先把 DB 里新到的消息投影进来（没变就不动）。
  if (ledger.runner === 'opencode') {
    try { syncOpencodeSession(ledger.sessionId); }
    catch (e) { st.lastError = `OpenCode 投影同步失败：${String(e?.message ?? e).split('\n')[0]}`; }
  }
  if (!file || !fs.existsSync(file)) {
    // 源被运行器清掉不是「画面该消失」：最后一次构建还在、归档还在，
    // 如实说清楚，页面继续可看、/body 继续可读。
    const a = archiveState(st.dir);
    st.lastError = a.exists
      ? `源日志不在（${file}），画面用最后一次构建；正文读归档（${a.bytes} 字节，同步于 ${a.syncedAt}）`
      : `找不到源日志 ${file}，也没有归档——只能看最后一次构建`;
    return;
  }
  syncArchive(st.dir, file);
  writeStore(root, build(file, { storeRoot: root }));
  st.lastError = null;
}

async function ensureFresh(root, st, rebuildSec) {
  if (rebuildSec <= 0) { syncArchiveOnce(st); return; }
  if (Date.now() - st.lastBuiltMs < rebuildSec * 1000) return;
  if (!st.building) {
    st.building = Promise.resolve()
      .then(() => { try { rebuildOnce(root, st); } catch (e) { st.lastError = String(e?.message ?? e).split('\n')[0]; } st.lastBuiltMs = Date.now(); })
      .finally(() => { st.building = null; });
  }
  await st.building;
}

/** 旧别名 /atlas 落点：最近写入的那段会话（源 mtime 优先，归档/builtAt 兜底）。 */
function newestSession(root) {
  try {
    const all = libraryOf(root).groups.flatMap((g) => g.sessions);
    all.sort((a, b) => String(b.lastWriteAt ?? b.builtAt ?? '').localeCompare(String(a.lastWriteAt ?? a.builtAt ?? '')));
    return all[0]?.id ?? null;
  } catch { return null; }
}

/** 有任务状态的项目清单：只读 progress-state.json，名字从项目层取（取不到就用键）。 */
let projCache = { at: 0, data: [] };
function projectSummaries(root) {
  if (Date.now() - projCache.at < 5000) return projCache.data;
  const dir = path.resolve(root, '..', 'projects');
  let names = new Map();
  try { names = new Map(projectsOf(root, { withSteps: false }).projects.map((p) => [p.key, p.name])); } catch { /* 名字取不到就用键 */ }
  const rows = [];
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { /* 还没有 projects 目录 */ }
  for (const key of entries) {
    if (!/^p-[0-9a-f]{12}$/.test(key) || !fs.existsSync(path.join(dir, key, 'progress-state.json'))) continue;
    try {
      const state = readState(root, key).state;
      const v = projectView(state);
      rows.push({ key, name: names.get(key) ?? key, revision: state.revision, tasks: v.tasks.length, counts: v.counts.project });
    } catch { /* 坏状态不列 */ }
  }
  rows.sort((a, b) => b.revision - a.revision || a.name.localeCompare(b.name));
  projCache = { at: Date.now(), data: rows };
  return rows;
}


// 新会话自动入库：页面每次被请求时（15 秒一次）扫一遍源目录，源日志超过 20KB 但还没有
// ledger.json 的会话直接建账，下次刷新就在左栏里。只对默认 store 生效——测试用的临时
// store 绝不能去扫真会话。
const DEFAULT_STORE = path.resolve(WEB, '..', 'out', 'store').replace(/\\/g, '/');
// 项目页 5 秒轮询：经验要读最近几本账的视图，别每 5 秒重算一遍；缓存 15 秒。
const insightsCache = new Map();
function insightsOf(root, key) {
  const id = `${root}|${key}`;
  const now = Date.now();
  const hit = insightsCache.get(id);
  if (hit && now - hit.at < 15000) return hit.data;
  const data = { experience: projectExperience(root, key), profile: projectProfile(root, key) };
  insightsCache.set(id, { at: now, data });
  return data;
}
let sweepAt = 0, sweepBusy = false;
function sweepNewSessions(root) {
  if (String(root).replace(/\\/g, '/') !== DEFAULT_STORE) return;
  const now = Date.now();
  if (sweepBusy || now - sweepAt < 15000) return;
  sweepAt = now; sweepBusy = true;
  setTimeout(() => {
    try {
      const have = new Set(fs.existsSync(root) ? fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'ledger.json'))) : []);
      const fresh = listSessions().filter((s) => s.bytes > 20000 && !have.has(s.sessionId));
      for (const s of fresh) {
        try { writeStore(root, build(s.file, { storeRoot: root })); } catch { /* 一段建不起来不拖垮别的 */ }
      }
    } catch { /* 扫不动就等下一次 */ }
    finally { sweepBusy = false; }
  }, 0);
}
export async function serveMap(opts = {}) {
  const { root, rebuildSec = 20, pidFile = null } = opts;
  const port0 = opts.port ?? opts.ports?.[0] ?? 8765;
  const startedAt = new Date().toISOString();

  const server = http.createServer(async (req, res) => {
    if (!HOST_OK(req.headers.host, port0)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('只允许本机访问\n');
    }
    const u = new URL(String(req.url || '/'), `http://127.0.0.1:${port0}`);
    const url = u.pathname;
    const method = String(req.method || 'GET').toUpperCase();
    const send = (code, type, body) => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    const json = (code, obj) => send(code, 'application/json; charset=utf-8', JSON.stringify(obj));
    const redirect = (location) => { res.writeHead(302, { location, 'cache-control': 'no-store' }); res.end(); };
    if (method === 'GET') sweepNewSessions(root);

    try {
      // ---- 项目任务页：/p/<键>/（只读，服务端渲染） ----
      const pm = url.match(/^\/p\/([^/]+)(\/.*)?$/);
      if (pm) {
        if (method !== 'GET') return send(405, 'text/plain; charset=utf-8', '只支持 GET\n');
        let key = pm[1];
        try { key = decodeURIComponent(key); } catch { /* 非法转义按原样找 */ }
        if (!/^p-[0-9a-f]{12}$/.test(key)) return send(404, 'text/plain; charset=utf-8', `项目键不合法：${String(key).slice(0, 40)}\n`);
        // 没有状态文件就没有这个项目页：readState 会给空状态，但空状态不该变成一个 200 的假页面
        if (!fs.existsSync(stateFile(root, key))) return send(404, 'text/plain; charset=utf-8', `这个项目还没有任务状态（${key}）\n`);
        let state;
        try { state = readState(root, key).state; } catch (e) { return send(404, 'text/plain; charset=utf-8', `这个项目没有任务状态：${String(e?.message ?? e).split('\n')[0]}\n`); }
        const rest = pm[2] ?? '';
        if (!rest) return redirect(`/p/${key}/`);
        if (rest === '/data.json') return json(200, {
          ...projectView(state), live: projectLive(root, key, state),
          insights: insightsOf(root, key)
        });
        if (rest !== '/') return send(404, 'text/plain; charset=utf-8', `未知路径 ${url}（项目页：/p/<键>/、/p/<键>/data.json）\n`);
        const name = (projectSummaries(root).find((p) => p.key === key) ?? {}).name ?? key;
        return send(200, 'text/html; charset=utf-8', projectPageHtml(projectView(state), {
          name, key, live: projectLive(root, key, state),
          insights: { experience: projectExperience(root, key), profile: projectProfile(root, key) }
        }));
      }
      if (url === '/projects.json') {
        if (method !== 'GET') return send(405, 'text/plain; charset=utf-8', '只支持 GET\n');
        return json(200, { projects: projectSummaries(root) });
      }

      // ---- 会话画布：/s/<spec>/... ----
      const m = url.match(/^\/s\/([^/]+)(\/.*)?$/);
      if (m) {
        let spec = m[1];
        try { spec = decodeURIComponent(spec); } catch { /* 非法转义按原样找，找不到就 404 */ }
        const id = findSession(root, spec);
        if (!id) return send(404, 'text/plain; charset=utf-8', `没有以 ${String(spec).slice(0, 40)} 开头的已建账会话；先 convledger sessions 看有哪些\n`);
        // 缺尾斜杠、或只给了前缀：跳到规范地址，页面里的相对路径才站得住。
        const rest = m[2] ?? '';
        if (!rest) return redirect(`/s/${id}/`);
        if (spec !== id) return redirect(`/s/${id}${rest}`);
        const st = stateOf(root, id);
        // 第一次接触这段会话就把源日志增量镜像进归档：health 也要如实报归档在不在。
        syncArchiveOnce(st);

        if (rest === '/') {
          try {
            // 常驻页不会热替换样式；给 CSS/JS 带上文件 mtime 版本，刷新一次必拿新文件。
            const cssFile = path.join(WEB, 'atlas.css');
            const jsFile = path.join(WEB, 'atlas.js');
            const ver = Math.max(fs.statSync(cssFile).mtimeMs, fs.statSync(jsFile).mtimeMs).toString(36);
            const html = fs.readFileSync(path.join(WEB, CANVAS[0]), 'utf8')
              .replace('href="/atlas.css"', `href="/atlas.css?v=${ver}"`)
              .replace('src="/atlas.js"', `src="/atlas.js?v=${ver}"`);
            return send(200, CANVAS[1], html);
          }
          catch (e) { return send(500, 'text/plain; charset=utf-8', '前端文件读不到：' + String(e.message ?? e) + '\n'); }
        }
        if (rest === '/data.json') {
          await ensureFresh(root, st, rebuildSec);
          try {
            const v = readView(st.dir);
            // 页面要能看出画的和源差多远：落后秒数＝源最后写入时刻 − 账本构建时刻（源不比账本新就是 0）。
            try {
              const src = v.meta?.sourceFile;
              const builtMs = Date.parse(v.meta?.builtAt ?? '');
              if (src) {
                const srcMs = fs.statSync(src).mtimeMs;
                v.meta.sourceMtime = new Date(srcMs).toISOString();
                v.meta.lagSec = Number.isFinite(builtMs) ? Math.max(0, Math.round((srcMs - builtMs) / 1000)) : null;
              } else v.meta.lagSec = null;
            } catch { v.meta.lagSec = null; }
            return send(200, 'application/json; charset=utf-8', JSON.stringify(v));
          }
          catch (e) { return send(500, 'text/plain; charset=utf-8', '这段会话的账本读不到：' + String(e?.message ?? e).split('\n')[0] + '\n'); }
        }
        if (rest === '/sessions.json') {
          if (method !== 'GET') return send(405, 'text/plain; charset=utf-8', '只支持 GET\n');
          try { return json(200, libraryOf(root, { current: id })); }
          catch (e) { return send(500, 'text/plain; charset=utf-8', '会话清单读不到：' + String(e?.message ?? e) + '\n'); }
        }
        if (rest === '/body') {
          if (method !== 'GET') return send(405, 'text/plain; charset=utf-8', '只支持 GET\n');
          const specSeg = u.searchParams.get('seg');
          if (!specSeg) return send(400, 'text/plain; charset=utf-8', '要带 ?seg=S07\n');
          const { ledger } = loadLedger(root, id);
          let segs;
          try { segs = resolveSegments(ledger, specSeg); }
          catch (e) { return send(404, 'text/plain; charset=utf-8', String(e.message ?? e) + '\n'); }
          const asked = +(u.searchParams.get('max') ?? 4000);
          const max = Number.isFinite(asked) && asked > 0 ? Math.min(asked, BODY_BUDGET_TOKENS) : 4000;
          const r = renderBody(ledger, segs, { max });
          return send(200, 'text/plain; charset=utf-8', r.text + (r.warnings.length ? `\n${r.warnings.join('\n')}` : '') + (r.stopped ? `\n续读：convledger body ${r.stopped.segment} --after ${r.stopped.line - 1}\n` : ''));
        }
        if (rest === '/handoff') {
          if (method !== 'GET') return send(405, 'text/plain; charset=utf-8', '只支持 GET\n');
          // 接手页只有一份渲染器：src/brief.mjs 的 handoffText。页面自己拼九格就会和
          // `convledger handoff` 漂开——那一页是要被粘进别的会话的，漂了就等于说谎。
          const arg = u.searchParams.get('chapter');
          const r = handoffText(readView(st.dir), arg === 'all' ? 'all' : arg ? +arg : null);
          if (r.error) return send(404, 'text/plain; charset=utf-8', r.error + '\n');
          return send(200, 'text/plain; charset=utf-8', r.text);
        }
        if (rest === '/note' || rest === '/request') {
          if (method !== 'POST') return send(405, 'text/plain; charset=utf-8', '只支持 POST\n');
          if (!ORIGIN_OK(req.headers.origin, port0)) return send(403, 'text/plain; charset=utf-8', '只接受本页写\n');
          if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return send(415, 'text/plain; charset=utf-8', '要 application/json\n');
          let body;
          try { body = JSON.parse(await readBody(req)); }
          catch (e) { return send(400, 'text/plain; charset=utf-8', '请求体不是 JSON：' + String(e.message ?? e) + '\n'); }
          const segsOf = () => new Set(loadLedger(root, id).ledger.segments.map((s) => s.id));
          const r = rest === '/note' ? appendNote(st.dir, body, segsOf()) : appendRequest(st.dir, body);
          if (!r.ok) return json(400, { ok: false, errors: r.errors });
          return json(200, { ok: true, ...(r.note ? { note: r.note } : {}), ...(r.request ? { request: r.request } : {}) });
        }
        if (rest === '/health') {
          // 探活只读 ledger/facts 两份 JSON，不走 readView（那要逐段读卡片）：
          // 它得永远答得快。
          const l = JSON.parse(fs.readFileSync(path.join(st.dir, 'ledger.json'), 'utf8'));
          let f = {};
          try { f = JSON.parse(fs.readFileSync(path.join(st.dir, 'facts.json'), 'utf8')); } catch { /* 没 facts 就少几格 */ }
          return json(200, {
            ok: true, hub: true, session: id, runner: l.runner, cwd: l.cwd,
            models: f.session?.models ?? [], model: f.session?.model ?? null, startedAt: iso(f.session?.span?.[0]), endedAt: iso(f.session?.span?.[1]),
            segments: l.segments.length, turns: f.turns?.total, rebuiltAt: String(l.builtAt ?? '').slice(0, 16).replace('T', ' '),
            archive: archiveState(st.dir), lastError: st.lastError,
          });
        }
        return send(404, 'text/plain; charset=utf-8', `未知路径 ${url}（会话画布：/s/<id>/、/s/<id>/data.json、/s/<id>/body?seg=S07、/s/<id>/handoff?chapter=N；写：/s/<id>/note、/s/<id>/request）\n`);
      }

      // ---- 静态资源（固定白名单） ----
      if (method === 'GET' && ASSETS[url]) {
        try { return send(200, ASSETS[url][1], asset(url).body); }
        catch (e) { return send(500, 'text/plain; charset=utf-8', '前端文件读不到：' + String(e.message ?? e) + '\n'); }
      }

      // ---- 补账档位：本机共用，页面读一次、改一次 ----
      if (url === '/prefs.json') {
        if (method !== 'GET') return send(405, 'text/plain; charset=utf-8', '只支持 GET\n');
        return json(200, readPrefs(root));
      }
      if (url === '/prefs') {
        if (method !== 'POST') return send(405, 'text/plain; charset=utf-8', '只支持 POST\n');
        if (!ORIGIN_OK(req.headers.origin, port0)) return send(403, 'text/plain; charset=utf-8', '只接受本页写\n');
        if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return send(415, 'text/plain; charset=utf-8', '要 application/json\n');
        let body;
        try { body = JSON.parse(await readBody(req)); }
        catch (e) { return send(400, 'text/plain; charset=utf-8', '请求体不是 JSON：' + String(e.message ?? e) + '\n'); }
        try { return json(200, { ok: true, prefs: writePrefs(root, body) }); }
        catch (e) { return json(400, { ok: false, errors: [String(e?.message ?? e).split('\n')[0]] }); }
      }

      // ---- hub 自身 ----
      if (url === '/architecture.json') {
        try { return json(200, roadmapNow(root)); }
        catch (e) { return json(500, { ok: false, error: String(e?.message ?? e).split('\n')[0] }); }
      }
      if (url === '/health') {
        // 只数目录，不读账本：hub 探活要永远答得快（libraryOf 会逐个读标题）。
        let sessions = null;
        try { sessions = fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'ledger.json'))).length; } catch { /* store 还没建 */ }
        return json(200, { ok: true, hub: true, port: port0, pid: process.pid, startedAt, rebuildSec, sessions });
      }
      if (url === '/sessions.json') {
        if (method !== 'GET') return send(405, 'text/plain; charset=utf-8', '只支持 GET\n');
        try { return json(200, libraryOf(root, { current: null })); }
        catch (e) { return send(500, 'text/plain; charset=utf-8', '会话清单读不到：' + String(e?.message ?? e) + '\n'); }
      }
      // 旧书签：403/404 都不该出现在「我打开过这张图」的地址上。
      if (url === '/atlas') {
        const id = newestSession(root);
        return redirect(id ? `/s/${id}/` : '/');
      }
      if (url === '/open') {
        if (method !== 'GET') return send(405, 'text/plain; charset=utf-8', '只支持 GET\n');
        const id = findSession(root, u.searchParams.get('session'));
        if (!id) return send(404, 'text/plain; charset=utf-8', `没有以 ${String(u.searchParams.get('session') ?? '').slice(0, 40)} 开头的已建账会话\n`);
        return redirect(`/s/${id}/`);
      }
      if (url === '/data.json' || url === '/body' || url === '/handoff' || url === '/note' || url === '/request') {
        return send(404, 'text/plain; charset=utf-8', `根地址不再服务单段会话的数据；会话画布在 /s/<会话>/ 下（例如 /s/<sid>/data.json）\n`);
      }
      return send(404, 'text/plain; charset=utf-8', `未知路径 ${url}（会话库 /、画布 /s/<id>/、hub 探活 /health）\n`);
    } catch (e) {
      return send(500, 'text/plain; charset=utf-8', String(e && e.message ? e.message : e) + '\n');
    }
  });

  try {
    await listenOnce(server, port0);
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    const hub = await probeHub(port0);
    if (hub) return { reused: true, hub: true, port: port0, dir: null, health: hub, lastError: null, stop: () => {} };
    throw new Error(`端口 ${port0} 被占用，而且不是本工具的 hub（先腾出来，或换 --port）`);
  }

  if (pidFile) {
    try { fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, port: port0, startedAt })); }
    catch { /* pid 文件写不了不影响服务 */ }
  }
  server.on('close', () => {
    if (!pidFile) return;
    try {
      const o = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
      if (o.pid === process.pid) fs.rmSync(pidFile, { force: true });
    } catch { /* 文件已经不在 */ }
  });

  return {
    server, hub: true, port: port0, startedAt, dir: null, view: null, lastError: null,
    archive: null, reused: false,
    stop: () => { server.close(); server.closeAllConnections?.(); },
  };
}

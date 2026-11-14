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
import crypto from 'node:crypto';
import { loadLedger, renderBody, resolveSegments, storeDir, syncArchive, archiveState } from './store.mjs';
import { readView } from './view.mjs';
import { handoffText } from './brief.mjs';
import { appendNote, appendRequest } from './notes.mjs';
import { BODY_BUDGET_TOKENS } from './cost.mjs';
import { findSession, isDefaultStore, LIVE_MIN } from './library.mjs';
import { readState, stateFile } from './state-io.mjs';
import { projectView } from './progress.mjs';
import { sourceIndex } from './project.mjs';
import { projectPageHtml, projectEmptyHtml } from './project-page.mjs';
import { readPrefs, writePrefs } from './prefs.mjs';
import { readLlm, writeLlm, clearLlm, setEnabled, llmOn, maskKey, probeEndpoints, detectBridge, pickModel, testLlm, saveKeyEntry, listSavedKeys, useSavedKey, removeSavedKey, ensureActiveSaved } from './llm.mjs';
import { runIntegration } from './status.mjs';
import { createRefresh } from './refresh.mjs';

const WEB = new URL('../web/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1').replace(/\\/g, '/');
const CLI = new URL('../bin/convledger.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1').replace(/\\/g, '/');
// fixed allowlist, not a path join: the url comes from a browser.
// `/` 是会话库；`/s/<sid>/` 出流程图；`/atlas` 留作旧别名（跳到最近写入的那段会话）。
const ASSETS = {
  '/': ['hub.html', 'text/html; charset=utf-8'],
  '/hub.css': ['hub.css', 'text/css; charset=utf-8'],
  '/hub.js': ['hub.js', 'text/javascript; charset=utf-8'],
  '/atlas.css': ['atlas.css', 'text/css; charset=utf-8'],
  '/atlas.js': ['atlas.js', 'text/javascript; charset=utf-8'],
  '/architecture': ['architecture.html', 'text/html; charset=utf-8'],
  '/vendor/three.module.min.js': ['vendor/three.module.min.js', 'text/javascript; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/icon-small.svg': ['icon-small.svg', 'image/svg+xml'],
  '/favicon.ico': ['convledger.ico', 'image/x-icon'],
  '/convledger.ico': ['convledger.ico', 'image/x-icon'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/app': ['app.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/icons/icon-192.png': ['icons/icon-192.png', 'image/png'],
  '/icons/icon-512.png': ['icons/icon-512.png', 'image/png'],
  '/icons/icon-192-v2.png': ['icons/icon-192-v2.png', 'image/png'],
  '/icons/icon-512-v2.png': ['icons/icon-512-v2.png', 'image/png'],
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
/** 门禁钥匙单独落盘：hub.json 只记进程与端口，人走灯灭时会删；token 不能跟着消失，
 *  否则每次重启都换钥匙，已开着的应用窗会停在启动页（2026-11-14 用户报障）。 */
export const hubTokenFile = (root) => path.join(path.dirname(root), 'hub-token');

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

/** 每段会话一份运行态：归档同步一次。重算与节流交给 refresh 管理器（后台 worker）。 */
const SESS = new Map();   // `${root}\0${id}` -> state
function stateOf(root, id) {
  const key = `${root}\0${id}`;
  let st = SESS.get(key);
  if (!st) {
    st = { id, dir: storeDir(root, id), lastError: null, synced: false, sourceFile: null };
    // 源文件：已建账读 ledger；未建账（打开旧对话）从廉价源索引取，供后台 build 用。
    try { st.sourceFile = JSON.parse(fs.readFileSync(path.join(st.dir, 'ledger.json'), 'utf8')).sourceFile ?? null; } catch { /* 还没建账 */ }
    if (!st.sourceFile && isDefaultStore(root)) st.sourceFile = sourceIndex().byId.get(id)?.file ?? null;
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

/** 旧别名 /atlas 落点：最近写入的那段会话（源 mtime 优先，归档/builtAt 兜底）。 */
async function newestSession(root, refresh) {
  try {
    // 从 worker 快照缓存取；缓存还没算好就返回 null，绝不在 /atlas 这一跳同步扫全库。
    const all = ((await refresh.getSessions(root)).payload.groups ?? []).flatMap((g) => g.sessions ?? []);
    all.sort((a, b) => String(b.lastWriteAt ?? b.builtAt ?? '').localeCompare(String(a.lastWriteAt ?? a.builtAt ?? '')));
    return all[0]?.id ?? null;
  } catch { return null; }
}

// 【2026-11-13 卡死修复】项目清单、项目成员、项目页 live/经验/画像/记忆欠项这些全库重活
// 原先都在主线程同步跑（projectsOf 11.7s、projectLive 9.7s），5 秒轮询把事件循环堵死。
// 现在统一由 createRefresh() 的 worker 缓存供货，主线程只回缓存、只标 refreshing。
// 新会话自动入库（PRD-load）：只对默认 store 生效（DEFAULT_STORE 由 library 统一给出）——
// 测试用的临时 store 绝不能去扫真会话。建账本身全在后台 worker，主线程只派发。
// 主线程每 15s 一次 GET 触发：空闲就派一个 sweep 给 worker。主线程不再 listSessions/build——
// 那正是多 agent＋长对话把机器卡死重启的病根（旧版在这里同步建全机旧对话）。
let sweepAt = 0;
function sweepNewSessions(root, refresh) {
  if (!isDefaultStore(root)) return;
  const now = Date.now();
  if (now - sweepAt < 15000) return;
  sweepAt = now;
  const { autoBuild } = readPrefs(root);
  refresh.sweep(root, { mode: autoBuild, liveMin: LIVE_MIN, cap: 1 });
}
export async function serveMap(opts = {}) {
  const { root, rebuildSec = 20, pidFile = null } = opts;
  const port0 = opts.port ?? opts.ports?.[0] ?? 8765;
  const startedAt = new Date().toISOString();
  // 重算与节流全交给它：视图先回缓存、后台 worker 再算新的，前台永不阻塞。
  const refresh = createRefresh();
  // ---- 门禁 token（2026-11-14 用户要求：浏览器 Web 入口下线，只留桌面应用窗）----
  // token 落在本机 out/hub.json。已有合法 token 就沿用——hub 重启不换钥匙，
  // 已开着的应用窗停几秒后轮询自动恢复，不用重开窗口；首次（没记录）才生成新的。
  const keyFile = opts.keyFile ?? hubTokenFile(root);
  const hubToken = (() => {
    // 先读专用钥匙文件，再兼容旧版只存在 hub.json 里的 token；都没有才生成。
    for (const f of [keyFile, pidFile]) {
      if (!f) continue;
      try {
        const raw = fs.readFileSync(f, 'utf8').trim();
        const t = raw.startsWith('{') ? JSON.parse(raw).token : raw;
        if (typeof t === 'string' && /^[0-9a-f]{48}$/.test(t)) return t;
      } catch { /* 换下一个来源 */ }
    }
    return crypto.randomBytes(24).toString('hex');
  })();
  try {
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, hubToken);
  } catch { /* 写不出钥匙文件＝老窗口下次重启会掉线；本次仍可用 */ }
  // ---- 人走灯灭：应用窗活着时页面 4s 一轮询（后台页 10s）；10 分钟零请求＝窗口已关，
  // hub 自己退出，不留常驻后台。双击图标随时能再拉起来。
  let lastSeen = Date.now();

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
    // /health 排在所有轮询、派生与派活之前，且完全不碰磁盘：探活永远 <1ms。
    // 旧版要 readdirSync + 逐目录 existsSync（2836 次 stat），且排在重活后面，
    // 主线程被 projectSummaries 占住时连探活都排不上队 → 页面 Failed to fetch。
    if (url === '/health' && method === 'GET') {
      return json(200, { ok: true, hub: true, port: port0, pid: process.pid, startedAt, rebuildSec, sessions: null });
    }
    // ---- 门禁：token 在 query（?k=）/ cookie（hubk）/ 头（x-hub-key）任一即可 ----
    // /health 豁免（探活只回 pid/port，不含 token）；其余一律要票。
    // 图标/清单也豁免：窗口图标（任务栏）与 PWA 清单由浏览器外壳裸取、常常不带 cookie，
    // 被挡成 403 会让任务栏回退成浏览器自己的 logo（2026-11-14 用户报障）。
    const PUBLIC_STATIC = new Set(['/favicon.ico', '/convledger.ico', '/manifest.webmanifest',
      '/icon.svg', '/icon-small.svg', '/icons/icon-192.png', '/icons/icon-512.png',
      '/icons/icon-192-v2.png', '/icons/icon-512-v2.png']);
    const qk = u.searchParams.get('k') || '';
    const cookieKey = String(req.headers.cookie || '').match(/(?:^|;\s*)hubk=([0-9a-f]+)/)?.[1] || '';
    const supplied = [qk,
      cookieKey,
      String(req.headers['x-hub-key'] || '')]
      .find((v) => v.length === hubToken.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(hubToken)));
    const isPublic = method === 'GET' && PUBLIC_STATIC.has(url);
    // 请求留痕（2026-11-14 排查启动卡死）：只记路径与钥匙来源位，不记 token 本身。
    try {
      const note = `${qk ? 'k' : '-'}${req.headers.cookie ? 'c' : '-'}${req.headers['x-hub-key'] ? 'h' : '-'} → ${supplied ? 'pass' : isPublic ? 'pub' : '403'}`;
      fs.appendFileSync(path.join(path.dirname(root), 'hub-requests.log'), `${new Date().toISOString()} ${method} ${url.slice(0, 120)} auth=${note}\n`);
    } catch { /* 留痕失败不影响服务 */ }
    if (!supplied && !isPublic) {
      return send(403, 'text/plain; charset=utf-8', '403 · 本看板只对桌面应用窗口开放（浏览器 Web 入口已下线）。\n从桌面图标打开，或跑 convledger app。\n');
    }
    lastSeen = Date.now();
    // 带 ?k= 的响应刷新 cookie：老窗口里可能还躺着上一任 token 的 cookie，
    // 只补「没有 cookie」会让 /app.js 继续拿旧钥匙 403、启动页永远转圈（2026-11-14 事故）。
    if (qk === supplied && cookieKey !== hubToken) {
      res.setHeader('set-cookie', `hubk=${hubToken}; Path=/; SameSite=Strict; Max-Age=31536000`);
    }
    if (method === 'GET') sweepNewSessions(root, refresh);

    try {
      // ---- 项目工作台：/p/<键>/（只读，服务端渲染） ----
      const pm = url.match(/^\/p\/([^/]+)(\/.*)?$/);
      if (pm) {
        if (method !== 'GET') return send(405, 'text/plain; charset=utf-8', '只支持 GET\n');
        let key = pm[1];
        try { key = decodeURIComponent(key); } catch { /* 非法转义按原样找 */ }
        if (!/^p-[0-9a-f]{12}$/.test(key)) return send(404, 'text/plain; charset=utf-8', `项目键不合法：${String(key).slice(0, 40)}\n`);
        const rest = pm[2] ?? '';
        if (!rest) return redirect(`/p/${key}/`);
        const from = u.searchParams.get('from') || '';
        // 没有状态文件不是“错误页”：从画布点过来的人要知道为什么空、下一步做什么、怎么回去。
        // 这个键在本机有会话就渲染空状态页；一个会话都没有才回 404（页面同样带导航）。
        if (!fs.existsSync(stateFile(root, key))) {
          // 取这个项目键下"有哪些会话、叫什么"。默认 store（真机几千本）走 worker 缓存，绝不
          // 主线程同步 projectsOf（11.7s 会堵死事件循环）；非默认 store（测试/临时夹具，很小）
          // 直接同步 projectsOf——冷开缓存是空壳，只有它才能准确判出"有会话、只是还没跑收尾"。
          let members = [];
          let name = '';
          if (isDefaultStore(root)) {
            const cachedProjects = (await refresh.getProjects(root)).payload;
            members = cachedProjects.membersByKey?.[key] ?? [];
            name = (cachedProjects.projects ?? []).find((p) => p.key === key)?.name ?? '';
          } else {
            try {
              // 动态 import：主线程静态依赖里不许出现 projectsOf（卡死根因闸门）；
              // 这里只在非默认 store（测试/临时夹具，体量小）时，按需惰性加载一次。
              const { projectsOf } = await import('./projects.mjs');
              const project = projectsOf(root, { withSteps: false }).projects.find((p) => p.key === key) ?? null;
              members = project?.members ?? [];
              name = project?.name ?? '';
            } catch { /* 取不到就按未知项目处理 */ }
          }
          const sessions = [...members].sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0) || String(b.lastAt ?? '').localeCompare(String(a.lastAt ?? '')));
          if (!sessions.length) return send(404, 'text/html; charset=utf-8', projectEmptyHtml({ key, from, known: false, cli: CLI }));
          return send(200, 'text/html; charset=utf-8', projectEmptyHtml({
            key, name, cwd: sessions[0]?.cwd ?? '', sessions, from, cli: CLI,
          }));
        }
        let state;
        try { state = readState(root, key).state; } catch (e) {
          return send(200, 'text/html; charset=utf-8', projectEmptyHtml({ key, from, error: String(e?.message ?? e).split('\n')[0], cli: CLI }));
        }
        // 四条全库重活（live / 经验 / 画像 / 记忆欠项）全部来自后台 worker 的缓存。
        const detail = (await refresh.getProjectDetail(root, key)).payload;
        if (rest === '/data.json') return json(200, { ...projectView(state), ...detail });
        if (rest !== '/') return send(404, 'text/plain; charset=utf-8', `未知路径 ${url}（项目工作台：/p/<键>/、/p/<键>/data.json）\n`);
        const name = ((await refresh.getProjects(root)).payload.projects ?? []).find((p) => p.key === key)?.name ?? key;
        return send(200, 'text/html; charset=utf-8', projectPageHtml(projectView(state), { name, key, ...detail }));
      }
      if (url === '/projects.json') {
        if (method !== 'GET') return send(405, 'text/plain; charset=utf-8', '只支持 GET\n');
        const r = await refresh.getProjects(root, { fresh: !!u.searchParams.get('force') });
        return json(200, { ...r.payload, refreshing: r.refreshing });
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
          try {
            // 先回已算好的视图（readView 命中缓存 0–1ms），重算在后台 worker 里进行。
            // refreshing 告诉前台「正在更新最新信息」，画布据此转小圈，但不冻结交互。
            const { payload, refreshing } = refresh.getView(root, st, rebuildSec);
            payload.meta.refreshing = refreshing;
            return send(200, 'application/json; charset=utf-8', JSON.stringify(payload));
          }
          catch (e) { return send(500, 'text/plain; charset=utf-8', '这段会话的账本读不到：' + String(e?.message ?? e).split('\n')[0] + '\n'); }
        }
        if (rest === '/sessions.json') {
          if (method !== 'GET') return send(405, 'text/plain; charset=utf-8', '只支持 GET\n');
          // 画布内嵌的会话清单：用 worker 快照，只把 current 标记就地改成本段会话。
          // 原来 libraryOf(root,{current:id}) 在主线程同步扫全库，画布一开就卡住整个 hub。
          try {
            const p = (await refresh.getSessions(root)).payload;
            const groups = (p.groups ?? []).map((g) => ({
              ...g, sessions: (g.sessions ?? []).map((s) => ({ ...s, current: s.id === id })),
            }));
            // 顶层 current 也要标成本段会话（缓存快照本身 current=null）；画布据此认出「本页」。
            return json(200, { ...p, current: id, groups });
          }
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
          // 它得永远答得快。未建账会话（正在后台建账）也答得快，如实标 building。
          let l;
          try { l = JSON.parse(fs.readFileSync(path.join(st.dir, 'ledger.json'), 'utf8')); }
          catch { return json(200, { ok: true, hub: true, session: id, building: true, segments: 0, archive: archiveState(st.dir), lastError: st.lastError }); }
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

      // 应用壳的样式/脚本带文件版本：改完刷新一次必拿新文件，不吃旧缓存。
      if (method === 'GET' && url === '/app') {
        try {
          const ver = (f) => Math.round(fs.statSync(path.join(WEB, f)).mtimeMs).toString(36);
          const html = fs.readFileSync(path.join(WEB, 'app.html'), 'utf8')
            .replace('href="/app.css"', `href="/app.css?v=${ver('app.css')}"`)
            .replace('src="/app.js"', `src="/app.js?v=${ver('app.js')}"`);
          return send(200, 'text/html; charset=utf-8', html);
        } catch (e) { return send(500, 'text/plain; charset=utf-8', '应用壳读不到：' + String(e.message ?? e) + '\n'); }
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

      // ---- 模型后端：在页面里填一个 API key 就接上（key 只存本机，回执一律脱敏） ----
      // 钥匙串：贴过的 key 记在 llm.json 的 savedKeys 里，页面上永远只见脱敏值；
      // 换端不用重贴，点列表里的「用」就切过去（2026-11-14 用户要求）。
      const llmView = () => {
        ensureActiveSaved(root);   // 老配置 / 环境变量接的 key 也收进串里，口径统一
        const c = readLlm(root);
        return {
          configured: c.configured,
          baseURL: c.baseURL ?? null,
          model: c.model ?? null,
          provider: c.provider ?? null,
          enabled: c.enabled !== false,
          autoOn: llmOn(root),
          models: Array.isArray(c.models) ? c.models.slice(0, 60) : [],
          keyMasked: c.apiKey ? maskKey(c.apiKey) : null,
          savedKeys: listSavedKeys(root),
          source: c.source,
          updatedAt: c.updatedAt ?? null,
        };
      };
      if (url === '/llm.json') {
        if (method !== 'GET') return send(405, 'text/plain; charset=utf-8', '只支持 GET\n');
        return json(200, llmView());
      }
      if (url === '/llm') {
        if (method !== 'POST') return send(405, 'text/plain; charset=utf-8', '只支持 POST\n');
        if (!ORIGIN_OK(req.headers.origin, port0)) return send(403, 'text/plain; charset=utf-8', '只接受本页写\n');
        if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return send(415, 'text/plain; charset=utf-8', '要 application/json\n');
        let body;
        try { body = JSON.parse(await readBody(req)); }
        catch (e) { return send(400, 'text/plain; charset=utf-8', '请求体不是 JSON：' + String(e.message ?? e) + '\n'); }
        if (body?.clear) { clearLlm(root); return json(200, { ok: true, config: llmView() }); }
        if (typeof body?.enabled === 'boolean' && !body?.apiKey && !body?.bridge && !body?.baseURL) {
          // 只翻开关：没接模型时开开关没有意义，明确拒绝。
          if (body.enabled && !readLlm(root).configured) {
            return json(400, { ok: false, errors: ['还没接模型——先填 key 再开这个开关'] });
          }
          setEnabled(root, body.enabled);
          return json(200, { ok: true, config: llmView() });
        }
        const key = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
        const base = typeof body?.baseURL === 'string' ? body.baseURL.trim().replace(/\/$/, '') : '';
        const model = typeof body?.model === 'string' ? body.model.trim() : '';
        try {
          let picked = null;
          if (body?.bridge && !key) {
            const b = await detectBridge();
            if (!b.ok) return json(400, { ok: false, errors: [`OW Bridge 没接上：${b.reason}`] });
            picked = { baseURL: b.baseURL, apiKey: b.apiKey, models: b.models, provider: 'ow-bridge', label: b.label };
          } else if (!key) {
            return json(400, { ok: false, errors: ['要给一个 API key（或用「读本机 OW Bridge」）'] });
          } else if (base) {
            const p = await probeEndpoints(key, { endpoints: [{ id: 'custom', label: base, baseURL: base }] });
            if (!p.hit) return json(400, { ok: false, errors: [`${base} 没通过：${p.tried[0]?.reason ?? '未知原因'}`] });
            picked = { baseURL: base, apiKey: key, models: p.hit.models, provider: 'custom', label: base };
          } else {
            const p = await probeEndpoints(key);
            if (!p.hit) {
              return json(400, {
                ok: false,
                errors: ['没有一个候选端点认这个 key'],
                tried: p.tried.map((t) => ({ label: t.label, reason: t.reason ?? '不通' })),
              });
            }
            picked = { baseURL: p.hit.baseURL, apiKey: key, models: p.hit.models, provider: p.hit.id, label: p.hit.label };
          }
          const useModel = model || pickModel(picked.models);
          if (!useModel) return json(400, { ok: false, errors: ['这个端点没返回任何模型，请手动填一个模型名'] });
          writeLlm(root, { ...picked, model: useModel });
          // 接上的 key 顺手收进钥匙串：下次换回来不用重贴
          saveKeyEntry(root, { apiKey: picked.apiKey, baseURL: picked.baseURL, provider: picked.provider, label: picked.label, model: useModel, models: picked.models });
          return json(200, { ok: true, config: llmView() });
        } catch (e) {
          return json(400, { ok: false, errors: [String(e?.message ?? e).split('\n')[0]] });
        }
      }
      if (url === '/llm/test') {
        if (method !== 'POST') return send(405, 'text/plain; charset=utf-8', '只支持 POST\n');
        if (!ORIGIN_OK(req.headers.origin, port0)) return send(403, 'text/plain; charset=utf-8', '只接受本页写\n');
        const cfg = readLlm(root);
        if (!cfg.configured) return json(400, { ok: false, errors: ['还没接模型'] });
        try {
          const r = await testLlm(cfg);
          return json(200, { ok: true, ms: r.ms, reply: r.reply, usage: r.usage, model: cfg.model });
        } catch (e) {
          return json(400, { ok: false, errors: [String(e?.message ?? e).split('\n')[0]] });
        }
      }
      // ---- 钥匙串操作：切到某条贴过的 key / 删一条（明文永远不出本机、不回页面） ----
      if (url === '/llm/keys') {
        if (method !== 'POST') return send(405, 'text/plain; charset=utf-8', '只支持 POST\n');
        if (!ORIGIN_OK(req.headers.origin, port0)) return send(403, 'text/plain; charset=utf-8', '只接受本页写\n');
        if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return send(415, 'text/plain; charset=utf-8', '要 application/json\n');
        let body;
        try { body = JSON.parse(await readBody(req)); }
        catch (e) { return send(400, 'text/plain; charset=utf-8', '请求体不是 JSON：' + String(e.message ?? e) + '\n'); }
        const action = String(body?.action || '');
        const id = String(body?.id || '').trim();
        try {
          if (action === 'use') {
            const c = useSavedKey(root, id);
            return json(200, { ok: true, config: llmView(), note: `已切到 ${c.model ?? '（未选模型）'}（${c.baseURL}）` });
          }
          if (action === 'remove') {
            removeSavedKey(root, id);
            return json(200, { ok: true, config: llmView() });
          }
          return json(400, { ok: false, errors: [`未知操作：${action}（只认 use / remove）`] });
        } catch (e) {
          return json(400, { ok: false, errors: [String(e?.message ?? e).split('\n')[0]] });
        }
      }

      // ---- 状态看板：只读快照 + 一键接入 ----
      if (url === '/status.json') {
        if (method !== 'GET') return send(405, 'text/plain; charset=utf-8', '只支持 GET\n');
        try {
          const fresh = !!u.searchParams.get('force');
          if (fresh) refresh.invalidateApp();
          const { payload, refreshing } = await refresh.getStatus(root, { fresh });
          return json(200, { ...payload, refreshing });
        }
        catch (e) { return json(500, { ok: false, error: String(e?.message ?? e).split('\n')[0] }); }
      }
      // 用量看板：宿主日志的 token/credits 统计。首次要读几百 MB 宿主日志，
      // 一律走后台 worker；主线程即时回缓存并标 refreshing，绝不因统计停摆（PRD-usage §3.5）。
      if (url === '/usage.json') {
        if (method !== 'GET') return send(405, 'text/plain; charset=utf-8', '只支持 GET\n');
        try {
          const fresh = !!u.searchParams.get('force');
          const { payload, refreshing } = await refresh.getUsage(root, { fresh });
          return json(200, { ...payload, refreshing });
        } catch (e) {
          return json(500, { ok: false, error: String(e?.message ?? e).split('\n')[0] });
        }
      }
      if (url === '/status/action') {
        if (method !== 'POST') return send(405, 'text/plain; charset=utf-8', '只支持 POST\n');
        if (!ORIGIN_OK(req.headers.origin, port0)) return send(403, 'text/plain; charset=utf-8', '只接受本页写\n');
        if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return send(415, 'text/plain; charset=utf-8', '要 application/json\n');
        let body;
        try { body = JSON.parse(await readBody(req)); }
        catch (e) { return send(400, 'text/plain; charset=utf-8', '请求体不是 JSON：' + String(e.message ?? e) + '\n'); }
        const client = String(body?.client || '');
        const action = String(body?.action || '');
        const OK_CLIENTS = ['qoder', 'claude-code', 'workbuddy', 'opencode', 'codex'];
        if (!OK_CLIENTS.includes(client)) return json(400, { ok: false, error: `未知 agent：${client}` });
        if (!['hooks', 'skill', 'connect', 'disconnect'].includes(action)) return json(400, { ok: false, error: `未知操作：${action}` });
        try {
          const r = runIntegration(client, action, { root });
          refresh.invalidateApp();   // 让下一次轮询在后台重算，立刻看到新状态
          return json(200, r);
        } catch (e) {
          return json(500, { ok: false, error: String(e?.message ?? e).split('\n')[0] });
        }
      }
      // 全局暂停：写暂停标记（之后 setup/upgrade/宿主事件都不自动起 hub），回完响应就停掉本进程、
      // 释放后台内存。恢复：双击桌面「convledger 地图」或跑 convledger map（会先删标记再起）。
      if (url === '/hub/pause') {
        if (method !== 'POST') return send(405, 'text/plain; charset=utf-8', '只支持 POST\n');
        if (!ORIGIN_OK(req.headers.origin, port0)) return send(403, 'text/plain; charset=utf-8', '只接受本页写\n');
        const marker = path.resolve(root, '..', 'HUB-PAUSED');
        try {
          fs.mkdirSync(path.dirname(marker), { recursive: true });
          fs.writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), by: 'app', port: port0 }, null, 1));
        } catch { /* 写不了标记也照样停，至少这次停住 */ }
        json(200, { ok: true, paused: true, note: '常驻服务即将停止；双击桌面「convledger 地图」或跑 convledger map 恢复' });
        try { refresh.stop(); } catch { /* 已停 */ }
        setTimeout(() => process.exit(0), 200);
        return;
      }
      if (url === '/sessions.json') {
        if (method !== 'GET') return send(405, 'text/plain; charset=utf-8', '只支持 GET\n');
        try {
          const fresh = !!u.searchParams.get('force');
          if (fresh) refresh.invalidateApp();
          const { payload, refreshing } = await refresh.getSessions(root, { fresh });
          return json(200, { ...payload, refreshing });
        }
        catch (e) { return send(500, 'text/plain; charset=utf-8', '会话清单读不到：' + String(e?.message ?? e) + '\n'); }
      }
      // 旧书签：状态页并入应用看板，别再维护第二份。
      if (url === '/status') return redirect('/app');
      // 用量看板是 App 壳的第六个视图；单独地址只做跳转，不维护第二份页面。
      if (url === '/usage') return redirect('/app?view=usage');
      // 旧书签：403/404 都不该出现在「我打开过这张图」的地址上。
      if (url === '/atlas') {
        const id = await newestSession(root, refresh);
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
    try { fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, port: port0, startedAt, token: hubToken })); }
    catch { /* 写不出来＝启动方拿不到 token＝谁都进不来；窗口会显示 403 页的指引 */ }
  }
  server.on('close', () => {
    if (!pidFile) return;
    try {
      const o = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
      if (o.pid === process.pid) fs.rmSync(pidFile, { force: true });
    } catch { /* 文件已经不在 */ }
  });

  // 人走灯灭：10 分钟零请求就退（窗口关了／没人开）。清掉 pid 文件再走，别留僵尸记录。
  const idleTimer = setInterval(() => {
    if (Date.now() - lastSeen < 10 * 60 * 1000) return;
    try { if (pidFile) fs.rmSync(pidFile, { force: true }); } catch { /* 没有就算了 */ }
    try { refresh.stop(); } catch { /* 已停 */ }
    try { server.close(); server.closeAllConnections?.(); } catch { /* 已关 */ }
    setTimeout(() => process.exit(0), 1500).unref();
  }, 60 * 1000);
  idleTimer.unref();

  return {
    server, hub: true, port: port0, startedAt, dir: null, view: null, lastError: null,
    archive: null, reused: false, token: hubToken,
    stop: () => { refresh.stop(); server.close(); server.closeAllConnections?.(); },
  };
}

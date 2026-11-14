// 用量看板的数据层（PRD-usage.md）。
//
// 只读宿主已经落盘的日志，按「宿主上报」记账：有 token 就记 token，没有就写未上报并给原因，
// 绝不拿字符数估算冒充宿主计数。唯一用到估算的是本工具自己的注入/回读（hook-probe/trace），
// 那两栏单独标「本工具估算」。
//
// 宿主日志是 append-only 且单文件可达数百 MB，所以按文件缓存「已读偏移 + 去重键 + 小计」：
// 没变直接复用，只增长就从上次完整行边界续读。缓存是派生数据，删了下次全量重扫。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { opencodeDb } from './opencode.mjs';
import { codexSrc } from './codex.mjs';
import { hostTitleFor } from './host-titles.mjs';
import { readInternal } from './internal.mjs';

const require = createRequire(import.meta.url);
// v2：按回合/模型调用记录用量，才能归因到「后台收尾 / 回填 / 工具回合」。
const CACHE_VERSION = 2;

export const SOURCE_LABELS = {
  qoder: 'Qoder',
  'claude-code': 'Claude Code',
  workbuddy: 'WorkBuddy',
  opencode: 'OpenCode',
  codex: 'Codex',
};

const REASON = {
  qoder: '宿主日志里 token 字段全为 0：Qoder 只上报 credits 与上下文占用率',
  codex: 'rollout 里没有 token_count 事件：这版 Codex 没有上报 token',
  opencode: 'OpenCode 库不可读（需要 Node ≥22.5 的 node:sqlite）',
};

const emptyTokens = () => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 });
const hasTokens = (t) => !!(t && (t.input || t.cacheRead || t.cacheWrite || t.output || t.reasoning));
// 真实用量只算会新增消耗的部分：未缓存输入 + 缓存写 + 输出。
// 缓存命中（cacheRead）单列展示、不进入合计——用户口径：读缓存不算真实消耗。
const realOf = (t) => (t ? t.input + t.cacheWrite + t.output : null);
const allOf = (t) => (t ? t.input + t.cacheRead + t.cacheWrite + t.output : null);
const addNums = (dst, src) => {
  for (const k of Object.keys(dst)) dst[k] += Number(src?.[k]) || 0;
  return dst;
};
const iso = (ms) => (Number.isFinite(+ms) ? new Date(+ms).toISOString() : null);
const round = (n, d = 3) => Math.round((Number(n) || 0) * 10 ** d) / 10 ** d;
const safeStat = (file) => { try { return fs.statSync(file); } catch { return null; } };
const homeOf = () => (process.env.CONVLEDGER_USAGE_HOME || os.homedir()).replace(/\\/g, '/');
const cacheFile = (root) => path.join(path.dirname(root), 'usage-cache.json');
const probeFile = (root) => (process.env.CONVLEDGER_HOOK_LOG || path.join(path.dirname(root), 'hook-probe.jsonl')).replace(/\\/g, '/');

const roots = () => {
  const home = homeOf();
  return {
    qoder: process.env.CONVLEDGER_QODER_ROOT || `${home}/.qoder/projects`,
    'claude-code': process.env.CONVLEDGER_CLAUDE_ROOT || `${home}/.claude/projects`,
    workbuddy: process.env.CONVLEDGER_WORKBUDDY_ROOT || `${home}/.workbuddy/projects`,
  };
};

/** 一层目录里的会话文件；Qoder 的 subagents 子目录归到父会话（同一段对话的用量）。 */
function hostFiles(host) {
  const root = roots()[host];
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    if (d.name === 'memory' || d.name === 'subagents') continue;
    const mains = [];
    let files = [];
    try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const file = path.join(dir, f.name);
      mains.push(file);
      out.push({ host, file, session: f.name.slice(0, -6) });
    }
    if (host === 'qoder' && mains.length) {
      const parent = path.basename(mains[0], '.jsonl');
      let subs = [];
      try { subs = fs.readdirSync(path.join(dir, 'subagents'), { withFileTypes: true }); } catch { /* 没有子代理目录 */ }
      for (const f of subs) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
        out.push({ host, file: path.join(dir, 'subagents', f.name), session: parent });
      }
    }
  }
  return out;
}

function codexFiles() {
  const out = [];
  const walk = (dir) => {
    let es = [];
    try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ host: 'codex', file: p, session: '' });
    }
  };
  walk(codexSrc());
  return out;
}

/** 从上次完整行边界续读；返回可消费的文本与消费到的字节偏移。 */
function readChunk(file, from) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= from) return { text: '', consumed: 0, size };
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    const end = buf.lastIndexOf(0x0a) + 1;
    return { text: end > 0 ? buf.subarray(0, end).toString('utf8') : '', consumed: end, size };
  } finally {
    fs.closeSync(fd);
  }
}

const bump = (map, key, n = 1) => { if (key) map[key] = (map[key] || 0) + n; };

const msOf = (host, j) => {
  if (host === 'workbuddy') {
    const n = Number(j.timestamp);
    return Number.isFinite(n) ? n : (Date.parse(j.timestamp) || 0);
  }
  return Date.parse(j.timestamp) || 0;
};

function finishTurn(acc) {
  if (acc.turn && acc.turn.tool) acc.toolTurns = (acc.toolTurns || 0) + 1;
  acc.turn = { tool: false, keys: [] };
}

function markTool(acc, n) {
  if (!n) return;
  acc.toolCalls = (acc.toolCalls || 0) + n;
  if (!acc.turn) acc.turn = { tool: false, keys: [] };
  acc.turn.tool = true;
  for (const idx of acc.turn.keys) if (acc.calls[idx]) acc.calls[idx][3] = 1;
}

function addCall(acc, call, toolCount) {
  if (acc.turn && acc.turn.tool) call[3] = 1;
  const idx = acc.calls.length;
  acc.calls.push(call);
  acc.callIdx.set(call[2], idx);
  if (!acc.turn) acc.turn = { tool: false, keys: [] };
  acc.turn.keys.push(idx);
  if (toolCount) { markTool(acc, toolCount); call[3] = 1; }
}

/** 一条记录里的 convledger 调用数：命令/参数里出现 convledger 就算用本工具。 */
function convledgerCalls(host, j) {
  if (host === 'qoder' || host === 'claude-code') {
    const c = j.message && j.message.content;
    if (!Array.isArray(c)) return 0;
    return c.filter((b) => b && b.type === 'tool_use' && /convledger/i.test(JSON.stringify(b.input || {}))).length;
  }
  if (host === 'workbuddy') {
    if (j.type !== 'function_call') return 0;
    return /convledger/i.test(`${j.name || ''} ${j.arguments || ''}`) ? 1 : 0;
  }
  return 0;
}

/** 人类回合边界：只认真人输入，工具结果/系统提醒不算新回合。 */
function isHuman(host, j) {
  if (host === 'qoder') return j.type === 'user' && !!j.humanInput;
  if (host === 'claude-code') {
    if (j.type !== 'user' || j.isSidechain) return false;
    if (j.toolUseResult) return false;
    const c = j.message && j.message.content;
    const blocks = Array.isArray(c) ? c : [];
    if (blocks.some((b) => b && b.type === 'tool_result')) return false;
    const text = typeof c === 'string' ? c : blocks.map((b) => (b && b.text) || '').join('');
    return !!text.trim() && !/^\s*</.test(text);
  }
  if (host === 'workbuddy') {
    if (j.type !== 'message' || j.role !== 'user') return false;
    const c = j.content;
    const text = Array.isArray(c) ? c.map((b) => (b && b.text) || '').join('') : String(c || '');
    return !!text.trim() && !/^\s*</.test(text);
  }
  return false;
}

function parseLine(host, line, acc) {
  if (!line) return;
  // 人回合边界不一定带 usage，先按宿主特征认出来；其余行仍用子串挡掉九成无关行。
  const humanHint = host === 'qoder' ? line.includes('"humanInput"')
    : host === 'claude-code' ? (line.includes('"type":"user"') || line.includes('"type": "user"'))
      : host === 'workbuddy' ? (line.includes('"role":"user"') || line.includes('"role": "user"')) : false;
  const usageHint = host === 'qoder' ? line.includes('"usage"')
    : host === 'claude-code' ? line.includes('"usage"')
      : host === 'workbuddy' ? line.includes('"rawUsage"')
        : host === 'codex' ? (line.includes('"token_count"') || line.includes('"session_meta"')) : false;
  if (!humanHint && !usageHint) return;
  acc.n = (acc.n || 0) + 1;
  let j;
  try { j = JSON.parse(line); } catch { return; }
  if (isHuman(host, j)) { finishTurn(acc); return; }
  if (host === 'qoder') {
    const u = j.usage || (j.message && j.message.usage);
    const tools = convledgerCalls(host, j);
    if (!u) { markTool(acc, tools); return; }
    const key = u.request_id || (j.message && j.message.id) || j.uuid || `line:${acc.n}`;
    if (acc.keys.has(key)) {
      markTool(acc, tools);
      if (tools && acc.callIdx.has(key)) acc.calls[acc.callIdx.get(key)][3] = 1;
      return;
    }
    acc.keys.add(key);
    acc.events++;
    const credits = Number(u.credits) || 0;
    acc.credits += credits;
    acc.ratio = Math.max(acc.ratio, Number(u.context_usage_ratio) || 0);
    const t = {
      input: u.input_tokens, cacheRead: u.cache_read_input_tokens,
      cacheWrite: u.cache_creation_input_tokens, output: u.output_tokens,
    };
    addNums(acc.tokens, t);
    bump(acc.models, (j.message && j.message.model) || j.model);
    addCall(acc, [msOf(host, j), realOf(t) || 0, key, 0, credits], tools);
    return;
  }
  if (host === 'claude-code') {
    const m = j.message || {};
    const u = m.usage;
    const tools = convledgerCalls(host, j);
    if (!u) { markTool(acc, tools); return; }
    const key = m.id || j.requestId || j.uuid || `line:${acc.n}`;
    if (acc.keys.has(key)) {
      markTool(acc, tools);
      if (tools && acc.callIdx.has(key)) acc.calls[acc.callIdx.get(key)][3] = 1;
      return;
    }
    acc.keys.add(key);
    acc.events++;
    const t = {
      input: u.input_tokens, cacheRead: u.cache_read_input_tokens,
      cacheWrite: u.cache_creation_input_tokens, output: u.output_tokens,
    };
    addNums(acc.tokens, t);
    bump(acc.models, m.model);
    addCall(acc, [msOf(host, j), realOf(t) || 0, key, 0, 0], tools);
    return;
  }
  if (host === 'workbuddy') {
    const pd = j.providerData || {};
    const u = pd.rawUsage;
    const tools = convledgerCalls(host, j);
    if (!u) { markTool(acc, tools); return; }
    const key = pd.messageId || j.id || `line:${acc.n}`;
    if (acc.keys.has(key)) {
      markTool(acc, tools);
      if (tools && acc.callIdx.has(key)) acc.calls[acc.callIdx.get(key)][3] = 1;
      return;
    }
    acc.keys.add(key);
    acc.events++;
    const prompt = Number(u.prompt_tokens) || 0;
    const hit = Number(u.prompt_cache_hit_tokens) || Number(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
    const miss = Number(u.prompt_cache_miss_tokens);
    const t = {
      input: Number.isFinite(miss) ? miss : Math.max(0, prompt - hit),
      cacheRead: hit,
      cacheWrite: u.prompt_cache_write_tokens,
      output: u.completion_tokens,
      reasoning: u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens,
    };
    addNums(acc.tokens, t);
    bump(acc.models, pd.requestModelName || pd.model);
    addCall(acc, [msOf(host, j), realOf(t) || 0, key, 0, 0], tools);
    return;
  }
  if (host === 'codex') {
    if (j.type === 'session_meta' && j.payload) {
      acc.metaId = acc.metaId || j.payload.id || null;
      acc.cwd = acc.cwd || j.payload.cwd || null;
      acc.title = acc.title || j.payload.title || null;
      return;
    }
    if (!line.includes('token_count')) return;
    const info = j.payload && j.payload.info;
    if (!info) return;
    const last = info.last_token_usage || null;
    if (last) {
      acc.events++;
      const cached = Number(last.cached_input_tokens) || 0;
      addNums(acc.tokens, {
        // Codex 的 input_tokens 含缓存命中；真实未缓存输入要减掉。
        input: Math.max(0, (Number(last.input_tokens) || 0) - cached), cacheRead: cached,
        cacheWrite: last.cache_write_input_tokens, output: last.output_tokens,
        reasoning: last.reasoning_output_tokens,
      });
      acc.tokenEvents = (acc.tokenEvents || 0) + 1;
      return;
    }
    // 只有累计快照时不能求和：取最后一份，标 cumulative，页面口径照实写。
    const total = info.total_token_usage;
    if (total && (total.input_tokens || total.output_tokens)) {
      acc.events++;
      acc.tokenEvents = (acc.tokenEvents || 0) + 1;
      const cached = Number(total.cached_input_tokens) || 0;
      acc.tokens = {
        input: Math.max(0, (Number(total.input_tokens) || 0) - cached), cacheRead: cached,
        cacheWrite: total.cache_write_input_tokens || 0, output: total.output_tokens || 0,
        reasoning: total.reasoning_output_tokens || 0,
      };
      acc.cumulative = true;
    }
  }
}

/** 单个文件的增量扫描；返回缓存行。文件被清空/截短就从 0 重来。 */
function scanFile(entry, prev) {
  const st = safeStat(entry.file);
  if (!st) return null;
  const reusable = prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs && prev.offset === st.size;
  if (reusable) return { ...prev, host: entry.host, session: entry.host === 'codex' ? prev.session : entry.session, file: entry.file };
  const fresh = !prev || st.size < (prev.offset || 0);
  const acc = fresh
    ? {
      tokens: emptyTokens(), keys: new Set(), events: 0, credits: 0, ratio: 0, models: {}, lines: 0, n: 0,
      metaId: null, cwd: null, title: null, tokenEvents: 0, cumulative: false,
      calls: [], turn: { tool: false, keys: [] }, toolTurns: 0, toolCalls: 0,
    }
    : {
      tokens: { ...emptyTokens(), ...(prev.tokens || {}) }, keys: new Set(prev.keys || []), events: prev.events || 0,
      credits: prev.credits || 0, ratio: prev.ratio || 0, models: { ...(prev.models || {}) }, lines: 0, n: prev.lines || 0,
      metaId: prev.metaId || null, cwd: prev.cwd || null, title: prev.title || null,
      tokenEvents: prev.tokenEvents || 0, cumulative: !!prev.cumulative,
      calls: (prev.calls || []).map((c) => c.slice()),
      turn: prev.turn ? { tool: !!prev.turn.tool, keys: (prev.turn.keys || []).slice() } : { tool: false, keys: [] },
      toolTurns: prev.toolTurns || 0, toolCalls: prev.toolCalls || 0,
    };
  acc.callIdx = new Map(acc.calls.map((c, i) => [c[2], i]));
  const from = fresh ? 0 : (prev.offset || 0);
  const chunk = readChunk(entry.file, from);
  if (!chunk) return prev || null;
  for (const line of chunk.text.split('\n')) parseLine(entry.host, line, acc);
  acc.lines = (prev && !fresh ? prev.lines || 0 : 0) + chunk.text.split('\n').length - 1;
  const session = entry.host === 'codex' ? (acc.metaId || entry.session || path.basename(entry.file, '.jsonl')) : entry.session;
  return {
    host: entry.host,
    session,
    file: entry.file,
    size: st.size,
    mtimeMs: st.mtimeMs,
    offset: from + chunk.consumed,
    tokens: acc.tokens,
    tokenEvents: acc.tokenEvents,
    cumulative: acc.cumulative,
    keys: [...acc.keys],
    events: acc.events,
    credits: acc.credits,
    ratio: acc.ratio,
    models: acc.models,
    lines: acc.lines,
    cwd: acc.cwd,
    title: acc.title,
    metaId: acc.metaId,
    calls: acc.calls,
    turn: acc.turn,
    toolTurns: acc.toolTurns,
    toolCalls: acc.toolCalls,
  };
}

function loadCache(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c && c.version === CACHE_VERSION && c.files && typeof c.files === 'object') return c;
  } catch { /* 没缓存/坏了：全量重扫 */ }
  return { version: CACHE_VERSION, files: {}, opencode: null };
}

function saveCache(file, cache) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache));
  } catch { /* 缓存写不进去不影响本次结果 */ }
}

/** OpenCode 是会话级累计值，不按消息求和。 */
function scanOpencode(prev, force) {
  const dbFile = opencodeDb();
  const st = safeStat(dbFile);
  const wal = safeStat(`${dbFile}-wal`);
  const sig = st ? `${st.size}:${st.mtimeMs}|${wal ? `${wal.size}:${wal.mtimeMs}` : ''}` : 'missing';
  if (!force && prev && prev.sig === sig) return { sig, rows: prev.rows, error: prev.error || null };
  if (!st) return { sig, rows: [], error: `没有 OpenCode 库：${dbFile}` };
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); }
  catch { return { sig, rows: [], error: REASON.opencode }; }
  let db;
  try { db = new DatabaseSync(dbFile, { readOnly: true }); }
  catch (e) { return { sig, rows: [], error: `OpenCode 库打不开：${String(e?.message ?? e).split('\n')[0]}` }; }
  try {
    const hasV2 = db.prepare("select name from sqlite_master where type='table' and name='session_v2'").all().length > 0;
    const table = hasV2 ? 'session_v2' : 'session';
    let counts = new Map();
    try {
      counts = new Map(db.prepare('select session_id, count(*) c from session_message group by session_id').all().map((r) => [r.session_id, r.c]));
    } catch { /* 旧版没有 session_message：会话行照出，消息数留空 */ }
    const rows = db.prepare(`select id, title, directory, cost, tokens_input, tokens_output, tokens_reasoning,
      tokens_cache_read, tokens_cache_write, time_created, time_updated from ${table}`).all().map((r) => ({
      host: 'opencode',
      session: String(r.id),
      file: dbFile,
      size: st.size,
      mtimeMs: st.mtimeMs,
      tokens: {
        input: r.tokens_input || 0, cacheRead: r.tokens_cache_read || 0,
        cacheWrite: r.tokens_cache_write || 0, output: r.tokens_output || 0,
        reasoning: r.tokens_reasoning || 0,
      },
      events: counts.get(r.id) ?? null,
      credits: 0,
      cost: Number(r.cost) || 0,
      ratio: 0,
      models: {},
      cwd: r.directory || null,
      title: r.title || null,
      lastWriteAt: iso(r.time_updated) || iso(r.time_created),
    }));
    return { sig, rows, error: null };
  } catch (e) {
    return { sig, rows: [], error: `OpenCode 用量读不到：${String(e?.message ?? e).split('\n')[0]}` };
  } finally {
    try { db.close(); } catch { /* 已关 */ }
  }
}

function ledgerIndex(root) {
  const out = {};
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let l;
    try { l = JSON.parse(fs.readFileSync(path.join(root, d.name, 'ledger.json'), 'utf8')); } catch { continue; }
    out[String(l.sessionId || d.name)] = { runner: l.runner || null, cwd: l.cwd || null, builtAt: l.builtAt || null };
  }
  return out;
}

function metaFor(row, ledgers) {
  const led = ledgers[row.session] || {};
  let title = row.title || null;
  // 自测把 HOME 换到夹具时不去读真机宿主库：统计只该读配置的那几个根。
  if (!title && !process.env.CONVLEDGER_USAGE_HOME) {
    try { title = hostTitleFor(row.session, { sourceFile: row.file, runner: row.host }); } catch { /* 标题读不到就用会话号 */ }
  }
  const cwd = row.cwd || led.cwd || null;
  return {
    runner: row.host,
    title: title || null,
    workspace: cwd,
    project: cwd ? cwd.split(/[\\/]/).filter(Boolean).slice(-2).join('/') : null,
    sid8: row.session.slice(0, 8),
    built: !!ledgers[row.session],
  };
}

function mergeRows(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.host}|${r.session}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        host: r.host, session: r.session, file: r.file, title: r.title || null, cwd: r.cwd || null,
        tokens: emptyTokens(), tokensSeen: false, events: 0, credits: 0, cost: 0, ratio: 0,
        models: {}, lastWriteAt: r.lastWriteAt || iso(r.mtimeMs), cumulative: false,
        calls: new Map(), toolTurns: 0, toolCalls: 0, openTool: false,
      };
      groups.set(key, g);
    }
    for (const c of r.calls || []) {
      const prev = g.calls.get(c[2]);
      if (prev) { if (c[3]) prev[3] = 1; prev[4] = Math.max(prev[4] || 0, c[4] || 0); }
      else g.calls.set(c[2], c.slice());
    }
    g.toolTurns += Number(r.toolTurns) || 0;
    g.toolCalls += Number(r.toolCalls) || 0;
    if (r.turn && r.turn.tool) g.openTool = true;
    if (hasTokens(r.tokens)) { g.tokensSeen = true; addNums(g.tokens, r.tokens); }
    g.events += Number(r.events) || 0;
    g.credits += Number(r.credits) || 0;
    g.cost += Number(r.cost) || 0;
    g.ratio = Math.max(g.ratio, Number(r.ratio) || 0);
    for (const k of Object.keys(r.models || {})) g.models[k] = (g.models[k] || 0) + r.models[k];
    if (r.mtimeMs && (!g.lastWriteMs || r.mtimeMs > g.lastWriteMs)) g.lastWriteMs = r.mtimeMs;
    if (r.lastWriteAt && (!g.lastWriteAt || Date.parse(r.lastWriteAt) > Date.parse(g.lastWriteAt))) g.lastWriteAt = r.lastWriteAt;
    if (r.cumulative) g.cumulative = true;
    if (!g.cwd && r.cwd) g.cwd = r.cwd;
  }
  return [...groups.values()].map((g) => ({
    ...g,
    calls: [...g.calls.values()],
    toolTurns: g.toolTurns + (g.openTool ? 1 : 0),
    tokens: g.tokensSeen ? g.tokens : null,
    lastWriteAt: g.lastWriteAt || iso(g.lastWriteMs) || null,
    total: g.tokensSeen ? realOf(g.tokens) : null,
    all: g.tokensSeen ? allOf(g.tokens) : null,
  }));
}

function readInjections(root, ledgers) {
  const file = probeFile(root);
  const out = { count: 0, tokens: 0, max: 0, truncated: 0, lastAt: null, events: {}, bySession: [], recent: [] };
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { return out; }
  const rows = [];
  for (const line of lines) {
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (String(e.action || '') !== 'inject') continue;
    const tokens = Number(e.tokens) || 0;
    if (!tokens) continue;
    const row = {
      ts: e.ts || null, event: e.event || '?', session: e.session || e.ledger || null,
      tokens, truncated: !!e.truncated, source: e.source || null, freshContext: !!e.freshContext,
      origin: e.origin || null, ms: Number(e.ms) || null,
    };
    rows.push(row);
    out.count++;
    out.tokens += tokens;
    out.max = Math.max(out.max, tokens);
    if (row.truncated) out.truncated++;
    if (row.ts && (!out.lastAt || Date.parse(row.ts) > Date.parse(out.lastAt))) out.lastAt = row.ts;
    out.events[row.event] = (out.events[row.event] || 0) + 1;
  }
  const byS = new Map();
  for (const r of rows) {
    if (!r.session) continue;
    let s = byS.get(r.session);
    if (!s) { s = { session: r.session, count: 0, tokens: 0 }; byS.set(r.session, s); }
    s.count++; s.tokens += r.tokens;
  }
  out.bySession = [...byS.values()].map((s) => ({ ...s, ...metaFor({ session: s.session, host: (ledgers[s.session] && ledgers[s.session].runner) || null, file: null }, ledgers) }))
    .sort((a, b) => b.tokens - a.tokens).slice(0, 20);
  // 页面要能逐条看「每一段注入」：给全量注入行（上限 2000 条，防探针年久膨胀）。
  out.recent = rows.slice(-2000).reverse().map((r) => ({ ...r, ...metaFor({ session: r.session, host: (ledgers[r.session] && ledgers[r.session].runner) || null, file: null }, ledgers) }));
  return out;
}

function readReadback(root, ledgers) {
  const out = { count: 0, tokens: 0, byOp: [], bySession: [] };
  const byOp = new Map();
  const byS = new Map();
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let lines = [];
    try { lines = fs.readFileSync(path.join(root, d.name, 'trace.jsonl'), 'utf8').split('\n'); } catch { continue; }
    let s = byS.get(d.name);
    if (!s) { s = { session: d.name, count: 0, tokens: 0 }; byS.set(d.name, s); }
    for (const line of lines) {
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      const tokens = Number(e.tokens) || 0;
      if (!tokens) continue;
      out.count++; out.tokens += tokens; s.count++; s.tokens += tokens;
      const op = e.op || '?';
      byOp.set(op, (byOp.get(op) || 0) + tokens);
    }
  }
  out.byOp = [...byOp.entries()].map(([op, tokens]) => ({ op, tokens })).sort((a, b) => b.tokens - a.tokens);
  out.bySession = [...byS.values()].map((s) => ({ ...s, ...metaFor({ session: s.session, host: (ledgers[s.session] && ledgers[s.session].runner) || null, file: null }, ledgers) }))
    .sort((a, b) => b.tokens - a.tokens).slice(0, 12);
  return out;
}

/**
 * 工具相关归因（PRD-usage §3.4）：
 * - 后台收尾会话：整段都是本工具派出去的工作，整会话真实用量都算；
 * - 回填上下文：每次注入后第一个模型调用（宿主上报），同一调用只算一次；
 * - 工具回合：含 convledger 调用的整个真人回合（同一回合后续模型调用也处理工具结果）；
 * - 其余对话：普通对话，只展示、不进入工具相关合计。
 */
function attributeUsage(rows, injections, internalSet) {
  const bySession = new Map(rows.map((r) => [r.session, r]));
  const matched = new Map();
  let matchedEvents = 0, unmatchedEvents = 0, backgroundEvents = 0;
  for (const ev of injections.recent || []) {
    ev.matched = false;
    ev.background = false;
    if (!ev.session) { unmatchedEvents++; continue; }
    const row = bySession.get(ev.session);
    if (!row) { unmatchedEvents++; continue; }
    if (internalSet.has(ev.session)) { ev.background = true; backgroundEvents++; continue; }
    const ts = Date.parse(ev.ts) || 0;
    const hit = ts && (row.calls || []).filter((c) => c[0] && c[0] >= ts).sort((a, b) => a[0] - b[0])[0];
    if (!hit) { unmatchedEvents++; continue; }
    ev.matched = true;
    ev.real = Math.round(hit[1] || 0);
    ev.credits = hit[4] || 0;
    ev.callTs = iso(hit[0]);
    matched.set(`${ev.session}|${hit[2]}`, hit);
    matchedEvents++;
  }

  const bySessionCat = new Map();
  const totals = {
    background: { real: 0, credits: 0, calls: 0, sessions: 0 },
    injection: { real: 0, credits: 0, calls: 0, events: matchedEvents, unmatched: unmatchedEvents, background: backgroundEvents },
    turns: { real: 0, credits: 0, calls: 0, turnCount: 0 },
    ordinary: { real: 0, credits: 0, calls: 0 },
  };
  for (const r of rows) {
    const c = {
      background: { real: 0, credits: 0, calls: 0 },
      injection: { real: 0, credits: 0, calls: 0 },
      turns: { real: 0, credits: 0, calls: 0 },
      ordinary: { real: 0, credits: 0, calls: 0 },
    };
    const calls = r.calls || [];
    if (internalSet.has(r.session)) {
      c.background.sessions = 1;
      if (calls.length) {
        for (const call of calls) {
          c.background.real += call[1] || 0;
          c.background.credits += call[4] || 0;
          c.background.calls++;
        }
      } else {
        c.background.real += r.total || 0;
        c.background.credits += r.credits || 0;
        c.background.calls += r.events || 0;
      }
    } else if (calls.length) {
      for (const call of calls) {
        const key = `${r.session}|${call[2]}`;
        if (matched.has(key)) {
          c.injection.real += call[1] || 0;
          c.injection.credits += call[4] || 0;
          c.injection.calls++;
        } else if (call[3]) {
          c.turns.real += call[1] || 0;
          c.turns.credits += call[4] || 0;
          c.turns.calls++;
        } else {
          c.ordinary.real += call[1] || 0;
          c.ordinary.credits += call[4] || 0;
          c.ordinary.calls++;
        }
      }
    } else {
      // OpenCode 只有会话级累计，没有逐调用记录：非后台会话只能落到普通对话。
      c.ordinary.real += r.total || 0;
      c.ordinary.credits += r.credits || 0;
      c.ordinary.calls += r.events || 0;
    }
    // 兜底：逐调用合计与宿主会话合计不一致时，差额算普通对话，绝不凭空消失。
    const hostReal = r.total || 0;
    const hostCredits = r.credits || 0;
    const knownReal = c.background.real + c.injection.real + c.turns.real + c.ordinary.real;
    const knownCredits = c.background.credits + c.injection.credits + c.turns.credits + c.ordinary.credits;
    if (hostReal > knownReal) c.ordinary.real += hostReal - knownReal;
    if (hostCredits > knownCredits) c.ordinary.credits += hostCredits - knownCredits;

    c.toolReal = c.background.real + c.injection.real + c.turns.real;
    c.toolCredits = c.background.credits + c.injection.credits + c.turns.credits;
    c.toolCalls = Number(r.toolCalls) || 0;
    c.modelCalls = c.background.calls + c.injection.calls + c.turns.calls;
    c.toolTurns = Number(r.toolTurns) || 0;
    c.allToolCalls = Number(r.toolCalls) || 0;
    bySessionCat.set(r.session, c);
    for (const k of ['background', 'injection', 'turns', 'ordinary']) {
      totals[k].real += Math.round(c[k].real);
      totals[k].credits += c[k].credits;
      totals[k].calls += c[k].calls;
    }
    if (c.background.sessions) totals.background.sessions++;
    totals.turns.turnCount += c.toolTurns;
    totals.turns.allToolCalls = (totals.turns.allToolCalls || 0) + c.allToolCalls;
  }
  totals.totalReal = Math.round(totals.background.real + totals.injection.real + totals.turns.real);
  totals.totalCredits = round(totals.background.credits + totals.injection.credits + totals.turns.credits);
  return { bySession: bySessionCat, totals };
}

/** 生成整份用量报告。force=true 时忽略文件缓存重扫（页面「刷新」用）。 */
export function usageReport(root, { force = false } = {}) {
  const started = Date.now();
  const cache = loadCache(cacheFile(root));
  const nextFiles = {};
  let dirty = false;
  const errors = [];
  const entries = [
    ...hostFiles('qoder'), ...hostFiles('claude-code'), ...hostFiles('workbuddy'), ...codexFiles(),
  ];
  for (const e of entries) {
    const prev = force ? null : cache.files[e.file];
    let row = null;
    try { row = scanFile(e, prev); } catch (err) { errors.push(`${e.file}: ${String(err?.message ?? err).split('\n')[0]}`); }
    if (!row) continue;
    nextFiles[e.file] = row;
    if (!prev || prev.size !== row.size || prev.mtimeMs !== row.mtimeMs || prev.offset !== row.offset) dirty = true;
  }
  if (Object.keys(cache.files).length !== Object.keys(nextFiles).length) dirty = true;
  const oc = scanOpencode(cache.opencode, force);
  if (!cache.opencode || cache.opencode.sig !== oc.sig || force) dirty = true;
  if (dirty) saveCache(cacheFile(root), { version: CACHE_VERSION, files: nextFiles, opencode: oc });

  const ledgers = ledgerIndex(root);
  const ocRows = (oc.rows || []).map((r) => ({ ...r }));
  const merged = mergeRows([...Object.values(nextFiles), ...ocRows]);
  for (const r of merged) Object.assign(r, metaFor(r, ledgers));
  const internalSet = new Set(Object.keys(readInternal(root).sids || {}));
  const injections = readInjections(root, ledgers);
  const attr = attributeUsage(merged, injections, internalSet);

  // 宿主级汇总：没有 token 的源一律 tokens=null，不当 0。
  const sourceIds = ['qoder', 'claude-code', 'workbuddy', 'opencode', 'codex'];
  const sources = sourceIds.map((id) => {
    const rows = merged.filter((r) => r.host === id);
    const withTokens = rows.filter((r) => r.tokensSeen);
    const tokens = withTokens.length ? withTokens.reduce((a, r) => addNums(a, r.tokens), emptyTokens()) : null;
    const credit = rows.reduce((a, r) => a + (Number(r.credits) || 0), 0);
    const cost = rows.reduce((a, r) => a + (Number(r.cost) || 0), 0);
    const lastMs = rows.reduce((a, r) => Math.max(a, Date.parse(r.lastWriteAt || '') || 0), 0);
    let reason = null;
    if (!tokens || !hasTokens(tokens)) {
      reason = id === 'opencode' ? (oc.error || REASON.opencode) : (REASON[id] || '这个来源没有上报 token');
    }
    const cats = rows.map((r) => attr.bySession.get(r.session)).filter(Boolean);
    const sumCat = (k) => Math.round(cats.reduce((a, c) => a + (c[k] && c[k].real ? c[k].real : 0), 0));
    return {
      id, label: SOURCE_LABELS[id], sessions: rows.length, withUsage: withTokens.filter((r) => realOf(r.tokens) > 0).length,
      tokens, total: tokens ? realOf(tokens) : null, all: tokens ? allOf(tokens) : null,
      cacheRead: tokens ? tokens.cacheRead : null, credits: round(credit), cost: round(cost, 4),
      events: rows.reduce((a, r) => a + (Number(r.events) || 0), 0),
      toolReal: Math.round(cats.reduce((a, c) => a + c.toolReal, 0)),
      toolCredits: round(cats.reduce((a, c) => a + c.toolCredits, 0)),
      backgroundReal: sumCat('background'), injectionReal: sumCat('injection'), turnReal: sumCat('turns'), ordinaryReal: sumCat('ordinary'),
      contextPeak: rows.reduce((a, r) => Math.max(a, Number(r.ratio) || 0), 0),
      toolNote: id === 'opencode' ? '只有会话级累计：后台会话可整段归因，普通会话无法按调用归因'
        : id === 'qoder' ? 'token 未上报：工具归因只能给 credits'
          : id === 'codex' ? '无 token_count：有回合结构但无用量' : null,
      lastWriteAt: lastMs ? iso(lastMs) : null, reason,
    };
  });

  const reporting = sources.filter((s) => s.tokens);
  const totals = reporting.reduce((a, s) => addNums(a, s.tokens), emptyTokens());
  const total = realOf(totals);
  const all = allOf(totals);
  const sessionRows = merged
    .map((r) => {
      const c = attr.bySession.get(r.session) || {};
      return {
        id: r.session, sid8: r.sid8, source: r.host, sourceLabel: SOURCE_LABELS[r.host],
        title: r.title, workspace: r.workspace, project: r.project, built: r.built,
        tokens: r.tokensSeen ? r.tokens : null, total: r.tokensSeen ? realOf(r.tokens) : null, all: r.tokensSeen ? allOf(r.tokens) : null,
        credits: r.credits ? round(r.credits) : 0, cost: r.cost ? round(r.cost, 4) : 0,
        events: r.events || null, ratio: r.ratio || 0, models: r.models || {},
        toolReal: Math.round(c.toolReal || 0), toolCredits: round(c.toolCredits || 0),
        toolTurns: c.toolTurns || 0, toolCalls: c.toolCalls || 0,
        backgroundReal: Math.round(c.background?.real || 0), injectionReal: Math.round(c.injection?.real || 0), turnReal: Math.round(c.turns?.real || 0),
        ordinaryReal: Math.round(c.ordinary?.real || 0),
        lastWriteAt: r.lastWriteAt, cumulative: !!r.cumulative,
      };
    })
    .sort((a, b) => (b.toolReal || 0) - (a.toolReal || 0) || (b.total || 0) - (a.total || 0) || b.credits - a.credits || Date.parse(b.lastWriteAt || 0) - Date.parse(a.lastWriteAt || 0));

  injections.real = Math.round(attr.totals.injection.real);
  injections.credits = round(attr.totals.injection.credits);
  injections.matched = attr.totals.injection.events;
  injections.modelCalls = attr.totals.injection.calls;
  injections.unmatched = attr.totals.injection.unmatched;
  injections.backgroundEvents = attr.totals.injection.background;
  const readback = readReadback(root, ledgers);
  const notes = [];
  if (!reporting.length) notes.push('本机没有任何来源上报 token：Qoder 只报 credits，Codex 这版没有 token_count。');
  if (oc.error) notes.push(oc.error);
  notes.push('工具相关 = 后台收尾会话整段 + 注入后第一个模型调用 + 含 convledger 调用的真人回合；普通对话不计数。');
  notes.push('真实用量 = 未缓存输入 + 缓存写 + 输出；缓存命中单列展示，不进入合计。');
  notes.push('汇总只加有上报的来源；未上报的来源不计 0，也不估算。');
  notes.push('注入与回读是文本体积估算（CJK 每字 1、拉丁 4 字符 1），不是真实 token 消耗，不计入。');

  return {
    ok: true,
    at: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    basis: '工具相关真实用量 = 后台收尾 + 回填后首个调用 + 含 convledger 调用的回合；真实 = 未缓存输入 + 缓存写 + 输出，缓存命中不计',
    scanned: { files: entries.length, hostFiles: Object.keys(nextFiles).length, errors: errors.slice(0, 5) },
    totals: {
      tokens: totals, total, all, cacheRead: totals.cacheRead, cacheShare: all ? totals.cacheRead / all : 0,
      sessions: merged.length, reportingSources: reporting.length, missingSources: sources.length - reporting.length,
      credits: round(sources.reduce((a, s) => a + s.credits, 0)),
      cost: round(sources.reduce((a, s) => a + s.cost, 0), 4),
      events: sources.reduce((a, s) => a + s.events, 0),
      tool: attr.totals,
      toolReal: attr.totals.totalReal,
      toolCredits: attr.totals.totalCredits,
      ordinaryReal: Math.round(attr.totals.ordinary.real),
      ordinaryCredits: round(attr.totals.ordinary.credits),
    },
    sources,
    sessions: sessionRows,
    injections,
    readback,
    notes,
  };
}

/** 给 CLI 渲染用的一行口径。 */
export function usageLines(r) {
  const n = (v) => (v == null ? '—' : String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ','));
  const t = r.totals.tokens;
  const tool = r.totals.tool || {};
  const out = [
    `用量 · ${r.at.slice(0, 16).replace('T', ' ')} · 扫 ${r.scanned.files} 个文件 · ${r.elapsedMs}ms`,
    `工具相关真实 ${n(tool.totalReal)} tok · 后台 ${n(tool.background?.real)} · 回填 ${n(tool.injection?.real)} · 工具回合 ${n(tool.turns?.real)} · 普通对话 ${n(tool.ordinary?.real)}（不计）`,
    `宿主真实 ${n(r.totals.total)} tok（输入 ${n(t.input)} + 输出 ${n(t.output)}） · 缓存命中 ${n(t.cacheRead)}（不计） · credits ${n(r.totals.credits)}`,
  ];
  for (const s of r.sources) {
    out.push(`  ${s.label}：${s.sessions} 会话 · 工具相关 ${n(s.toolReal)} tok · 宿主真实 ${n(s.total)} tok（缓存 ${n(s.cacheRead)} 不计）${s.credits ? ` · credits ${n(s.credits)}` : ''}${s.tokens ? '' : ` · 未上报（${s.reason}）`}`);
  }
  out.push(`回填 ${r.injections.matched || 0} 次 / ${n(r.injections.real)} tok 实际（未匹配 ${r.injections.unmatched || 0}） · 注入文本体积 ${n(r.injections.tokens)} tok（估算，不计入）`);
  out.push(`回读 ${r.readback.count} 次 / ${n(r.readback.tokens)} tok（文本体积估算，不计入）`);
  for (const s of r.sessions.slice(0, 8)) {
    out.push(`  ${s.sourceLabel} · ${s.title || s.project || s.sid8}：工具相关 ${n(s.toolReal)} tok · 宿主真实 ${n(s.total)} tok${s.credits ? ` · credits ${n(s.credits)}` : ''}`);
  }
  return out.join('\n');
}

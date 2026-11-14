// OpenCode = 第四个来源。数据在 SQLite（message/part），而整条管线是「JSONL + 行锚点」，
// 所以这里把一段会话投影成 append-only JSONL（out/opencode/<sid>/<sid>.jsonl），再走现有派生。
// DB 是真相；投影是可删可重建的派生缓存，锚点指向投影的字节，不是宿主的原始行。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 与 hooks/opencode.mjs 同一个开关：投影根可被 CONVLEDGER_OPENCODE_OUT 改写。
// 源扫描（listSessions 的 opencode 适配器）也认它，隔离测试才关得住真机投影。
export const OPENCODE_ROOT = process.env.CONVLEDGER_OPENCODE_OUT || path.join(TOOL, 'out', 'opencode');

export function opencodeDb(env = process.env) {
  return env.CONVLEDGER_OPENCODE_DB || path.join(os.homedir(), '.local/share/opencode/opencode.db');
}

function openDb(dbFile) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); }
  catch { return { error: `这台机器的 Node ${process.versions.node} 没有 node:sqlite（需要 ≥22.5）——OpenCode 来源先跳过，其他来源不受影响` }; }
  if (!fs.existsSync(dbFile)) return { error: `没有 OpenCode 库：${dbFile}` };
  try { return { db: new DatabaseSync(dbFile, { readOnly: true }) }; }
  catch (e) { return { error: `OpenCode 库打不开：${String(e?.message ?? e).split('\n')[0]}` }; }
}

const iso = (ms) => (Number.isFinite(+ms) ? new Date(+ms).toISOString() : null);
const parseJson = (s) => { try { return JSON.parse(s); } catch { return {}; } };
const cleanCwd = (p) => (typeof p === 'string' ? p.replace(/\\/g, '/') : p ?? null);

/** 一段会话的第一行：runner 身份 + cwd + 标题；detect() 就认 opencode:true。 */
function sessionMeta(s) {
  return {
    type: 'system', subtype: 'opencode-session', opencode: true,
    uuid: s.id, timestamp: iso(s.time_created), cwd: s.directory,
    sessionId: s.id, slug: s.slug, title: s.title, agent: s.agent ?? null, model: s.model ?? null,
  };
}

/** 一条 message + 它的 parts → 若干投影行。工具结果合成一条 user(tool_result)，
 *  压缩 part 合成一条 isCompactSummary——两者都沿用现有管线的认法。 */
function projectMessage(m, parts, cwd) {
  const data = parseJson(m.data);
  const role = data.role === 'assistant' ? 'assistant' : 'user';
  const ts = iso(m.time_created);
  const blocks = [];
  const results = [];
  let compacted = false;
  let hasText = false;
  for (const p of parts) {
    const d = parseJson(p.data);
    if (d.type === 'text' && typeof d.text === 'string' && d.text) { blocks.push({ type: 'text', text: d.text }); hasText = true; }
    else if (d.type === 'reasoning' && typeof d.text === 'string' && d.text) blocks.push({ type: 'thinking', thinking: d.text });
    else if (d.type === 'tool') {
      const id = String(d.callID || p.id);
      blocks.push({ type: 'tool_use', id, name: d.tool || 'tool', input: d.state?.input ?? {} });
      const out = d.state?.output ?? d.state?.metadata?.output ?? '';
      results.push({ id, content: typeof out === 'string' ? out : JSON.stringify(out), error: d.state?.status === 'error' || d.state?.status === 'failed' });
    } else if (d.type === 'compaction') compacted = true;
  }
  const recs = [];
  if (blocks.length) {
    recs.push({
      type: role, opencode: true, uuid: m.id, timestamp: ts, cwd,
      humanInput: role === 'user' && hasText ? true : undefined,
      __model: role === 'assistant' ? (data.modelID ?? null) : undefined,
      message: { content: blocks },
    });
  }
  for (const r of results) {
    recs.push({
      type: 'user', opencode: true, uuid: `${r.id}#result`, timestamp: ts, cwd,
      message: { content: [{ type: 'tool_result', tool_use_id: r.id, content: r.content, is_error: !!r.error }] },
    });
  }
  if (compacted) {
    recs.push({
      type: 'user', opencode: true, uuid: `${m.id}#compact`, isCompactSummary: true, timestamp: ts, cwd,
      message: { content: [{ type: 'text', text: '（OpenCode 压缩点）' }] },
    });
  }
  return recs;
}

/** 新版插头（OpenCode ≥2.x）：会话在 session_v2、消息在 session_message（data 是 JSON）。 */
function hasNewSchema(db) {
  try {
    const t = db.prepare("select count(*) c from sqlite_master where type='table' and name='session_v2'").get();
    if (!t || !t.c) return false;
    return db.prepare('select count(*) c from session_message').get().c > 0;
  } catch { return false; }
}

/** 新版会话列表：lastmsg（最近一条消息的 time_updated）= 真正的新鲜度，别信 session_v2.time_updated。 */
function listSessionsNew(db) {
  return db.prepare(`select s.id, s.slug, s.title, s.directory, s.model, s.agent, s.time_created, s.time_updated,
      (select count(*) from session_message m where m.session_id=s.id) n,
      (select max(m.time_updated) from session_message m where m.session_id=s.id) lastmsg
    from session_v2 s order by coalesce(lastmsg, s.time_updated) desc`).all().map((s) => ({ ...s, schema: 'v2' }));
}

/** 新版投影：session_message.data 里 user.text / assistant.content[]（reasoning/text/tool）→ 规范记录。 */
function projectSessionNew(db, s) {
  const msgs = db.prepare('select id, type, seq, time_created, data from session_message where session_id=? order by seq, time_created').all(s.id);
  const lines = [JSON.stringify({
    type: 'system', subtype: 'opencode-session', opencode: true, uuid: s.id, sessionId: s.id,
    timestamp: iso(s.time_created), cwd: cleanCwd(s.directory), title: s.title, agent: s.agent ?? null, model: typeof s.model === 'string' ? s.model : (s.model?.id ?? null),
  })];
  for (const m of msgs) {
    const d = parseJson(m.data);
    const ts = iso(m.time_created);
    if (m.type === 'user') {
      const text = typeof d.text === 'string' ? d.text : '';
      if (text) lines.push(JSON.stringify({ type: 'user', opencode: true, uuid: m.id, humanInput: true, timestamp: ts, cwd: cleanCwd(s.directory), message: { content: [{ type: 'text', text }] } }));
    } else if (m.type === 'assistant') {
      const blocks = []; const results = [];
      for (const p of (Array.isArray(d.content) ? d.content : [])) {
        const t = p && p.type;
        if (t === 'reasoning' && p.text) blocks.push({ type: 'thinking', thinking: p.text });
        else if (t === 'text' && p.text) blocks.push({ type: 'text', text: p.text });
        else if (p && (p.tool || /tool/.test(String(t)))) {
          const id = String(p.callID ?? p.toolCallId ?? p.id ?? '');
          blocks.push({ type: 'tool_use', id, name: p.tool || p.name || 'tool', input: p.state?.input ?? p.input ?? {} });
          const out = p.state?.output ?? p.output ?? '';
          results.push({ id, content: typeof out === 'string' ? out : JSON.stringify(out), error: p.state?.status === 'error' || p.state?.status === 'failed' });
        }
      }
      if (blocks.length) lines.push(JSON.stringify({ type: 'assistant', opencode: true, uuid: m.id, timestamp: ts, cwd: cleanCwd(s.directory), __model: d.model?.id ?? null, message: { content: blocks } }));
      for (const r of results) lines.push(JSON.stringify({ type: 'user', opencode: true, uuid: `${r.id}#result`, timestamp: ts, cwd: cleanCwd(s.directory), message: { content: [{ type: 'tool_result', tool_use_id: r.id, content: r.content, is_error: !!r.error }] } }));
    }
    // system（注入的 instructions / 通知）→ 跳过
  }
  return lines;
}

/** 投影一段会话（按 time_created,id 排序；同一会话增量只在尾部追加）。 */
export function projectSession(db, session) {
  if (session.schema === 'v2') return projectSessionNew(db, session);
  const msgs = db.prepare('select id,time_created,data from message where session_id=? order by time_created,id').all(session.id);
  const parts = db.prepare('select id,message_id,time_created,data from part where session_id=? order by time_created,id').all(session.id);
  const byMsg = new Map();
  for (const p of parts) {
    if (!byMsg.has(p.message_id)) byMsg.set(p.message_id, []);
    byMsg.get(p.message_id).push(p);
  }
  const lines = [JSON.stringify(sessionMeta(session))];
  for (const m of msgs) for (const r of projectMessage(m, byMsg.get(m.id) ?? [], session.directory)) lines.push(JSON.stringify(r));
  return lines;
}

let memo = null, memoAt = 0;
const SYNC_TTL = 5000;   // 驻留 hub 里别一次同步就冻住：最多每 5 秒重读一次 DB

/**
 * 增量同步：会话 time_updated / message 数没变就不重写；变了整段重写（前缀不变，追加式）。
 * 投影文件的 mtime 设成 session.time_updated，让「最近写入」的判定如实。
 */
export function syncOpencodeProjections({ dbFile = opencodeDb(), outDir = OPENCODE_ROOT, force = false } = {}) {
  if (!force && memo && Date.now() - memoAt < SYNC_TTL) return memo;
  const o = openDb(dbFile);
  if (o.error) { memo = { ok: false, error: o.error, sessions: 0, written: 0 }; return memo; }
  const { db } = o;
  try {
    const sessions = hasNewSchema(db)
      ? listSessionsNew(db)
      : db.prepare(`select s.id, s.slug, s.title, s.directory, s.model, s.agent, s.time_created, s.time_updated,
      (select count(*) from message m where m.session_id = s.id) as n
      from session s order by s.time_updated desc`).all().map((s) => ({ ...s, schema: 'v1' }));
    const marker = path.join(outDir, '.sync.json');
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { /* 首次或坏了都重写 */ }
    const sig = JSON.stringify(sessions.map((s) => [s.id, s.time_updated, s.n, s.lastmsg || 0]));
    if (!force && prev && prev.sig === sig) { memoAt = Date.now(); memo = { ok: true, sessions: sessions.length, written: 0, dbFile }; return memo; }
    fs.mkdirSync(outDir, { recursive: true });
    let written = 0;
    for (const s of sessions) {
      if (!s.n) continue;
      const dir = path.join(outDir, s.id);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${s.id}.jsonl`);
      const body = projectSession(db, s).join('\n') + '\n';
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, file);
      try { const tsMs = s.schema === 'v2' ? (s.lastmsg || s.time_updated) : s.time_updated; const t = new Date(tsMs); fs.utimesSync(file, t, t); } catch { /* 时间戳只是判新用的，设不了不影响 */ }
      written++;
    }
    fs.writeFileSync(marker, JSON.stringify({ sig, at: new Date().toISOString() }));
    memoAt = Date.now();
    memo = { ok: true, sessions: sessions.length, written, dbFile };
    return memo;
  } catch (e) {
    memo = { ok: false, error: String(e?.message ?? e).split('\n')[0], sessions: 0, written: 0, dbFile };
    return memo;
  } finally { try { db.close(); } catch { /* 只读连接 */ } }
}

/** 只同步一段会话（hub 重建前用）：按 session.time_updated + 消息数判有没有变，
 *  变了整段重写；没变一次 IO 都不做。 */
export function syncOpencodeSession(sessionId, { dbFile = opencodeDb(), outDir = OPENCODE_ROOT } = {}) {
  const o = openDb(dbFile);
  if (o.error) return { ok: false, error: o.error, written: 0 };
  try {
    const s = hasNewSchema(o.db)
      ? (listSessionsNew(o.db).find((x) => x.id === sessionId) ?? null)
      : (o.db.prepare(`select s.id, s.slug, s.title, s.directory, s.model, s.agent, s.time_created, s.time_updated,
      (select count(*) from message m where m.session_id = s.id) as n
      from session s where s.id = ?`).get(sessionId) ?? null);
    if (!s) return { ok: false, error: `没有这段 OpenCode 会话：${sessionId}`, written: 0 };
    if (!s.n) return { ok: true, written: 0 };
    const dir = path.join(outDir, s.id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${s.id}.jsonl`);
    const marker = path.join(outDir, `.sync-${s.id}.json`);
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { /* 首次 */ }
    const sig = JSON.stringify([s.time_updated, s.n, s.lastmsg || 0]);
    if (prev && prev.sig === sig && fs.existsSync(file)) return { ok: true, written: 0 };
    const body = projectSession(o.db, s).join('\n') + '\n';
    fs.writeFileSync(`${file}.tmp`, body);
    fs.renameSync(`${file}.tmp`, file);
    try { const tsMs = s.schema === 'v2' ? (s.lastmsg || s.time_updated) : s.time_updated; const t = new Date(tsMs); fs.utimesSync(file, t, t); } catch { /* 时间戳只用于判新 */ }
    fs.writeFileSync(marker, JSON.stringify({ sig }));
    // 全局 marker 作废：下次 listSessions 会重新比一遍
    try { fs.rmSync(path.join(outDir, '.sync.json'), { force: true }); } catch { /* 没有就算 */ }
    return { ok: true, written: 1 };
  } finally { try { o.db.close(); } catch { /* 只读连接 */ } }
}

/** 测试与 CLI 都要能重来：清掉进程内记忆。 */
export function resetOpencodeMemo() { memo = null; }

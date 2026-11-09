// 宿主标题：桌面端会话列表显示的名字，不在账本里，而在各宿主自己的标题表：
// Qoder 的 main.sqlite(chat_sessions.title)、WorkBuddy 的 workbuddy.db(sessions.custom_title||title)、
// OpenCode 的 opencode.db(session.title)。会话库优先用这份标题，跟工作区左侧逐字一致；
// Claude Code 没有可读的标题表，直接回落到账本派生（与它自己 resume 列表显示首条提问同源）。
// 读不到（库被锁、旧 Node）就返回 null，调用方继续用上次的标题。只读，不写宿主库。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { opencodeDb } from './opencode.mjs';

const require = createRequire(import.meta.url);
const TTL_MS = 5000;

/** 候选库：测试可用 CONVLEDGER_QODER_DB 指定；正式环境扫 AppData 下的 Qoder 安装。 */
export function qoderDbs() {
  const override = String(process.env.CONVLEDGER_QODER_DB ?? '').trim();
  if (override) return [override];
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  let names = [];
  try { names = fs.readdirSync(roaming).filter((n) => /^com\.qoder\.app/.test(n)); } catch { return []; }
  return names
    .map((n) => path.join(roaming, n, 'main.sqlite'))
    .filter((f) => fs.existsSync(f));
}

const stamp = (file) => {
  try { const s = fs.statSync(file); return `${file}:${s.mtimeMs}:${s.size}`; }
  catch { return `${file}:-`; }
};

function readTitles(files) {
  const map = new Map();
  let DatabaseSync = null;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { return null; }
  if (!DatabaseSync) return null;
  let opened = false;
  for (const file of files) {
    let db = null;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      opened = true;
      const rows = db.prepare("select session_id, title from chat_sessions where title is not null and trim(title) <> ''").all();
      for (const r of rows) {
        const id = String(r.session_id ?? '');
        const title = String(r.title ?? '').trim();
        if (id && title && !map.has(id)) map.set(id, title);
      }
    } catch { /* 宿主库在写/不可读：跳过，别把清单拖垮 */ }
    finally { try { db?.close(); } catch { /* 已关 */ } }
  }
  // 一个库都没打开（被锁、权限）时返回 null，让调用方继续用上一次的标题，别瞬间退回派生题名。
  return opened || !files.length ? map : null;
}

let cache = { key: '', at: 0, map: new Map() };

/** 整张表按库文件（含 -wal）的 mtime+size 失效；5 秒 TTL 防止每 4 秒轮询都去 stat 一堆候选。 */
export function hostTitleMap() {
  const files = qoderDbs();
  const key = files.join('|') + '|' + files.map((f) => `${stamp(f)}|${stamp(`${f}-wal`)}`).join('|');
  const now = Date.now();
  if (cache.key === key && now - cache.at < TTL_MS) return cache.map;
  const map = readTitles(files);
  cache = { key, at: now, map: map ?? cache.map };
  return cache.map;
}

export function hostTitleFor(sessionId, { sourceFile = null, runner = null } = {}) {
  const id = String(sessionId ?? '').trim();
  if (!id) return null;
  if (runner === 'workbuddy') return workbuddyTitles().get(id) ?? (sourceFile ? workbuddyTitle(sourceFile) : null);
  if (runner === 'opencode') return opencodeTitles().get(id) ?? null;
  return hostTitleMap().get(id) ?? null;
}

let ocCache = { key: '', title: new Map() };

/** OpenCode 的官方标题在 SQLite 的 session.title；只读、按库文件 mtime+size 失效。 */
function opencodeTitles() {
  const file = opencodeDb();
  const key = stamp(file);
  if (ocCache.key === key) return ocCache.title;
  const map = new Map();
  let DatabaseSync = null;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* 老 Node：回落账本 */ }
  if (DatabaseSync) {
    let db = null;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      const rows = db.prepare("select id, title from session where title is not null and trim(title) <> ''").all();
      for (const r of rows) {
        const id = String(r.id ?? ''), title = String(r.title ?? '').trim();
        if (id && title) map.set(id, title);
      }
    } catch { /* 库在写/不可读：回落账本 */ }
    finally { try { db?.close(); } catch { /* 已关 */ } }
  }
  ocCache = { key, title: map };
  return map;
}

/** WorkBuddy 的官方标题在主库 sessions 表：custom_title（用户改名）优先，其次 title。
 *  测试可用 CONVLEDGER_WORKBUDDY_DB 指定；读不到就回落到源 JSONL 的 ai-title。 */
export function workbuddyDb() {
  const override = String(process.env.CONVLEDGER_WORKBUDDY_DB ?? '').trim();
  if (override) return override;
  return path.join(os.homedir(), '.workbuddy', 'workbuddy.db');
}

let wbCache = { key: '', title: new Map() };

function workbuddyTitles() {
  const file = workbuddyDb();
  const key = `${stamp(file)}|${stamp(`${file}-wal`)}`;
  if (wbCache.key === key) return wbCache.title;
  const map = new Map();
  let DatabaseSync = null;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* 老 Node：回落 ai-title */ }
  if (DatabaseSync && fs.existsSync(file)) {
    let db = null;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      const rows = db.prepare('select id, title, custom_title from sessions').all();
      for (const r of rows) {
        const id = String(r.id ?? '');
        const title = String(r.custom_title ?? '').trim() || String(r.title ?? '').trim();
        if (id && title) map.set(id, title);
      }
    } catch { /* 库在写/不可读：回落 ai-title */ }
    finally { try { db?.close(); } catch { /* 已关 */ } }
  }
  wbCache = { key, title: map };
  return map;
}

const WB_CACHE = new Map();   // sourceFile -> { key, title }
const WB_CHUNK = 512 * 1024;

function titleFromLines(text) {
  let title = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (line.indexOf('ai-title') < 0) continue;
    try {
      const j = JSON.parse(line);
      if (j?.type === 'ai-title' && String(j.aiTitle ?? '').trim()) title = String(j.aiTitle).trim();
    } catch { /* 半行/坏行跳过 */ }
  }
  return title;
}

/** 主库读不到时的回落：WorkBuddy 也会把标题写成 ai-title 记录，常在文件头，重命名可能追加在尾部。
 *  只读首尾各 512KB，并按源文件 mtime+size 缓存；再读不到才回落账本派生标题。 */
function workbuddyTitle(file) {
  const key = stamp(file);
  const hit = WB_CACHE.get(file);
  if (hit && hit.key === key) return hit.title;
  let title = null;
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(Math.min(WB_CHUNK, st.size));
      const n = fs.readSync(fd, head, 0, head.length, 0);
      title = titleFromLines(head.toString('utf8', 0, n));
      if (!title && st.size > WB_CHUNK * 2) {
        const tail = Buffer.alloc(WB_CHUNK);
        const at = Math.max(0, st.size - WB_CHUNK);
        const m = fs.readSync(fd, tail, 0, tail.length, at);
        title = titleFromLines(tail.toString('utf8', 0, m));
      }
    } finally { fs.closeSync(fd); }
  } catch { /* 源读不了：交给账本派生 */ }
  WB_CACHE.set(file, { key, title });
  return title;
}

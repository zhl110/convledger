// 画像的自动触发：不是工具自己去分析，而是「有新会话、画像落后」时把任务交给当前 agent。
// 判据只用账本派生数：画像表最后写入时间 vs 各会话源文件最后写入时间；
// 至少 2 段会话更新过才值得动（画像证据必须跨会话），同一批只催一次。
// 工具零模型调用；写不写、写成什么，仍由 agent 按 G4 自己判断，闸门照旧。
//
// 廉价扫描（PRD-load §2.5）：Stop hook 每轮都是新进程，libraryOf 的缓存是冷的，
// 调它等于每次 Stop 都对全机几百段会话跑一遍 outstandingFor。这里只读每个已建账
// ledger.json 的头（sessionId/sourceFile/builtAt）再 stat 源，不跑 outstandingFor、
// 不算整理度、也不扫宿主目录列未建账会话——画像证据必须来自已建账的会话，旧对话不催。
import fs from 'node:fs';
import path from 'node:path';
import { readUserMemories } from './memories.mjs';
import { readInternal } from './internal.mjs';
import { MEMORY_PROJECT_LESSON_DUE, MEMORY_PROJECT_SESSION_DUE, MEMORY_USER_SESSION_DUE } from './cost.mjs';

const MARK = 'profile-prompt.json';

/** 记忆归纳到期判定（PRD-memory §十二）：只看增量，不看日历。
 *  与 profileDue 同一套廉价扫描：只读已建账会话的 ledger 头与源 mtime，不 build、不算整理度。
 *  阈值全在 cost.mjs——这里不出现数字，调阈值不用改这个文件。
 *  返回的 counts 是「自上次归纳以来新增了多少」，不是总量。 */
export function memoryDue(root, projectKey) {
  const sessions = builtSessions(root);
  const outRoot = path.resolve(root, '..');
  const latestAt = (doc) => (doc?.entries || []).reduce((m, e) => Math.max(m, Date.parse(e.at || 0) || 0), 0);

  const lastUser = latestAt(readJson(path.join(outRoot, 'user', 'memories.json')));
  const userNew = sessions.filter((s) => !lastUser || (Date.parse(s.lastWriteAt) || 0) > lastUser);

  // 项目成员＝同步状态里已分析过的会话（checkpoints 用完整 id）。没同步过就没有成员，也就无从归纳。
  const projDir = path.join(outRoot, 'projects', projectKey);
  const st = readJson(path.join(projDir, 'progress-state.json')) ?? {};
  const members = new Set(Object.keys(st.checkpoints || {}));
  const inProject = sessions.filter((s) => members.has(s.id));
  const lastProj = latestAt(readJson(path.join(projDir, 'memories.json')));
  const projNew = inProject.filter((s) => !lastProj || (Date.parse(s.lastWriteAt) || 0) > lastProj);
  let lessons = 0;
  for (const s of projNew) {
    const sums = readJson(path.join(root, s.id, 'summaries.json'));
    for (const b of Object.values(sums?.blocks || {})) {
      if (b.lesson && (!lastProj || (Date.parse(b.at || 0) || 0) > lastProj)) lessons++;
    }
  }
  return {
    project: {
      due: lessons >= MEMORY_PROJECT_LESSON_DUE || projNew.length >= MEMORY_PROJECT_SESSION_DUE,
      lessons, sessions: projNew.length,
      lastAt: lastProj ? new Date(lastProj).toISOString() : null,
    },
    user: {
      due: userNew.length >= MEMORY_USER_SESSION_DUE,
      sessions: userNew.length,
      lastAt: lastUser ? new Date(lastUser).toISOString() : null,
    },
  };
}

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

/** 一段已建账会话「最后一次有动静」的时刻，与 library.statusOf 同一条回落链：
 *  源 mtime（源还在且非空）→ 归档 source.jsonl 的 mtime → builtAt。只 stat，不 build。 */
function lastWriteOf(dir, ledger) {
  let last = null;
  if (ledger.sourceFile) {
    try {
      const s = fs.statSync(ledger.sourceFile);
      if (s.size > 0) last = s.mtimeMs;
    } catch { /* 源被宿主清了：回落归档 */ }
  }
  if (last == null) {
    try { last = fs.statSync(path.join(dir, 'source.jsonl')).mtimeMs; } catch { /* 没归档 */ }
  }
  if (last == null && ledger.builtAt) last = Date.parse(ledger.builtAt) || null;
  return last == null ? null : new Date(last).toISOString();
}

/** 只扫已建账会话：每个 store 子目录读 ledger.json 取头三字段，再 stat 源算 lastWriteAt。
 *  只读 store 自己的子目录，绝不扫宿主源目录——临时 store 的夹具因此关得住真机对话。 */
// 进程内 5 秒缓存：outstanding 被画布轮询、每条命令、每次 hook 反复调用，而一次扫描要读
// 几千个 ledger.json 再 stat 源。5 秒内的重复调用共用同一份结果——判定看的是「增量够没够」，
// 慢 5 秒不影响任何结论。
let SESS_CACHE = { at: 0, root: null, stamp: 0, rows: null };

function builtSessions(root) {
  const now = Date.now();
  // 命中条件除时间外还要看 store 目录本身的 mtime：新增/删除会话会改它，
  // 只按时间缓存会让「刚建了一段会话」在 5 秒内看不见（测试与真机都踩）。
  let stamp = 0;
  try { stamp = fs.statSync(root).mtimeMs; } catch { stamp = 0; }
  if (SESS_CACHE.rows && SESS_CACHE.root === root && SESS_CACHE.stamp === stamp && now - SESS_CACHE.at < 5000) return SESS_CACHE.rows;
  let dirents = [];
  try { dirents = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    const ledger = readJson(path.join(dir, 'ledger.json'));
    if (!ledger?.sessionId) continue;
    const lastWriteAt = lastWriteOf(dir, ledger);
    if (lastWriteAt) out.push({ id: ledger.sessionId, lastWriteAt, sourceFile: ledger.sourceFile || null });
  }
  SESS_CACHE = { at: now, root, stamp, rows: out };
  return out;
}

/** 源文件头 8KB 含 convledger-internal 哨兵 → 是本工具派的后台会话（分析器），不算「用户新会话」。
 *  否则每派一段后台会话就多一段「新会话」→ 画像永远到期 → 又派 → 无限自增。 */
function headHasSentinel(file) {
  if (!file) return false;
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    fs.closeSync(fd);
    return buf.subarray(0, n).toString('utf8').includes('convledger-internal');
  } catch { return false; }
}

export function profileDue(root) {
  let table;
  try { table = readUserMemories(root); } catch { table = { entries: [] }; }
  const entries = (table.entries ?? []).filter((e) => e.class === '画像');
  const lastAt = entries.reduce((max, e) => Math.max(max, Date.parse(e.at) || 0), 0);

  const sessions = builtSessions(root)
    .sort((a, b) => String(b.lastWriteAt).localeCompare(String(a.lastWriteAt)));
  if (sessions.length < 2) return { due: false, reason: `sessions(${sessions.length}/2)` };
  // 「新会话」剔除本工具自己的后台会话（登记表 + 源哨兵两道），否则分析器一多就自我催到无限。
  const internalSet = new Set(Object.keys(readInternal(root).sids));
  const newer = sessions.filter((s) => (Date.parse(s.lastWriteAt) || 0) > lastAt).filter((s) => !internalSet.has(s.id) && !headHasSentinel(s.sourceFile));
  if (newer.length < 2) return { due: false, reason: `newer(${newer.length}/2)` };

  // 指纹用「变新了的会话集合」，不用 mtime：活跃会话每轮都在长，按 mtime 会反复催。
  const fingerprint = newer.map((s) => s.id).sort().join(",");
  let mark = null;
  try { mark = JSON.parse(fs.readFileSync(path.join(root, MARK), 'utf8')); } catch { mark = null; }
  if (mark?.fingerprint === fingerprint) return { due: false, reason: 'already-asked', fingerprint };
  return { due: true, fingerprint, newer: newer.length, sessions: sessions.length, lastAt };
}

export function markProfilePrompt(root, fingerprint) {
  try {
    fs.writeFileSync(path.join(root, MARK), JSON.stringify({ at: new Date().toISOString(), fingerprint }, null, 1));
  } catch { /* 标记写不了就下次再问，好过不说 */ }
}
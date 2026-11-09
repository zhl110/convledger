// 会话库：流程图左栏那份「已经导入的会话」清单。
// 只认 store/ 里有 ledger.json 的目录——用户说的是「工具里已经导入的」，
// 没建账的原始 JSONL 不在这里出现。
// 「进行中」账本里没有这个字段，唯一诚实的信号是源 JSONL 的 mtime：
// 会话在跑，宿主就一直在追加；不写了就转灰。精确到最后写入时刻由 idleMin 给出。
import fs from 'node:fs';
import path from 'node:path';
import { archiveState } from './store.mjs';
import { hostTitleFor } from './host-titles.mjs';
import { outstandingFor } from './outstanding.mjs';

export const LIVE_MIN = 15;
export const RUNNER_LABEL = { qoder: 'Qoder', 'claude-code': 'Claude Code', workbuddy: 'WorkBuddy', opencode: 'OpenCode' };
const GROUP_ORDER = ['qoder', 'claude-code', 'workbuddy'];
// 缓存上限必须大于一台机器上可能的会话数：200 上限撞上 237 个会话时，
// 每次装填都把最早的挤出去，整理层等于每轮全量重算。
const CACHE_MAX = 800;
const CACHE = new Map();   // dir -> { key: 'mtime:size:overlay-mtime', st }

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

const mtimeOf = (file) => {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
};

/** 模型层的三个表各改了哪一刻：取最新一个 mtime，读不到给 null。 */
function organizedAt(dir) {
  const at = Math.max(mtimeOf(path.join(dir, 'summaries.json')), mtimeOf(path.join(dir, 'phases.json')), mtimeOf(path.join(dir, 'claims.json')));
  return at ? new Date(at).toISOString() : null;
}

/** 只读文件头：标题兜底用 index.md 的第一行数据，不必把整份 35KB 拉进来。 */
function readHead(file, bytes) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const b = Buffer.alloc(bytes);
      const n = fs.readSync(fd, b, 0, bytes, 0);
      return b.toString('utf8', 0, n);
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

const cwdTail = (cwd) => String(cwd ?? '').replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/');
const workspaceOf = (cwd) => String(cwd ?? '').replace(/\\/g, '/').split('/').filter(Boolean).slice(-1)[0] ?? '';

/** 标题四级回落，全是已有文件里的话：模型写的任务题名 → 块题名 → 阶段短名 → 段的一句话 → 目录名。 */
function titleOf(dir, cwd) {
  const sums = readJson(path.join(dir, 'summaries.json'));
  const task = sums?.tasks ? Object.values(sums.tasks).find((x) => x && x.title) : null;
  if (task) return { title: String(task.title), titleFrom: 'tasks' };
  const block = sums?.blocks ? Object.values(sums.blocks).find((x) => x && x.title) : null;
  if (block) return { title: String(block.title), titleFrom: 'blocks' };
  const phases = readJson(path.join(dir, 'phases.json'));
  const phase = (phases?.phases ?? []).find((x) => x && x.short);
  if (phase) return { title: String(phase.short), titleFrom: 'phases' };
  const line = readHead(path.join(dir, 'index.md'), 16384).split(/\r?\n/).find((l) => /^\|\s*S\d{2,}\s*\|/.test(l));
  if (line) {
    const one = (line.split('|')[6] ?? '').trim();
    if (one) return { title: one, titleFrom: 'index' };
  }
  const tail = cwdTail(cwd);
  return { title: tail || '（未命名会话）', titleFrom: 'cwd' };
}

function staticOf(dir) {
  const file = path.join(dir, 'ledger.json');
  const st = fs.statSync(file);
  // 缓存键要一起认模型层：只记 ledger 的 mtime 时，补完综述那一行不会变。
  const key = `${st.mtimeMs}:${st.size}:${organizedAt(dir) ?? 0}`;
  const hit = CACHE.get(dir);
  if (hit && hit.key === key) return hit.st;
  const l = readJson(file);
  if (!l || !l.sessionId) return null;
  const cwd = l.cwd ?? '';
  let organize;
  try {
    // 欠项与整理度出自同一个函数：outstanding 说没有欠项，这里就不能说「没整理」。
    // 不带 cwd＝不数项目级候选，那一栏属于项目页不属于这一行。
    const o = outstandingFor({ storeRoot: path.dirname(dir), sessionId: l.sessionId, cwd: null });
    const w = o.written;
    const touched = w.sums > 0 || w.phases > 0 || w.titles > 0 || w.verified > 0;
    organize = {
      blocks: o.blocks,
      sums: w.sums, sumsDropped: w.sumsDropped,
      titles: w.titles, titlesOf: w.titlesOf,
      phases: w.phases, phasesDropped: w.phasesDropped,
      verified: w.verified,
      gaps: o.items.length,
      level: !touched ? 'none' : (o.items.length ? 'part' : 'full'),
      at: organizedAt(dir),
    };
  } catch { organize = null; }
  const entry = {
    id: l.sessionId,
    sid8: String(l.sessionId).slice(0, 8),
    runner: l.runner || 'unknown',
    cwd,
    cwdTail: cwdTail(cwd),
    workspace: workspaceOf(cwd),
    segments: (l.segments ?? []).length,
    sourceBytes: l.sourceBytes ?? 0,
    builtAt: l.builtAt ?? null,
    sourceFile: l.sourceFile ?? null,
    ...titleOf(dir, cwd),
    archive: archiveState(dir),
    organize,
  };
  CACHE.set(dir, { key, st: entry });
  if (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
  return entry;
}

function statusOf(dir, entry, now) {
  let sourceExists = false;
  let srcMtime = null;
  if (entry.sourceFile) {
    try {
      const s = fs.statSync(entry.sourceFile);
      sourceExists = s.size > 0;
      srcMtime = s.mtimeMs;
    } catch { /* 源被运行器清了：下面回落归档 */ }
  }
  // 源没了仍要回答「最后一次有动静是什么时候」：归档的 mtime 就是最后一次同步的时刻。
  let last = sourceExists ? srcMtime : null;
  if (last == null && entry.archive.exists) {
    try { last = fs.statSync(path.join(dir, 'source.jsonl')).mtimeMs; } catch { /* 归档也读不到 */ }
  }
  if (last == null && entry.builtAt) last = Date.parse(entry.builtAt) || null;
  const idleMin = last == null ? null : Math.max(0, Math.round((now - last) / 60000));
  return {
    sourceExists,
    sourceMissing: !sourceExists,
    lastWriteAt: last == null ? null : new Date(last).toISOString(),
    idleMin,
    live: sourceExists && idleMin != null && idleMin <= LIVE_MIN,
  };
}

/** 已建账的会话 id：全等优先，其次前缀（与 --session 的语义一致）。 */
export function findSession(root, spec) {
  if (!spec) return null;
  if (!fs.existsSync(root)) return null;
  const ids = fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'ledger.json')));
  return ids.find((x) => x === spec) ?? ids.find((x) => x.startsWith(spec)) ?? null;
}

/** 清单本体。静态部分走缓存；live / idleMin 每次现算，不然点会停在旧状态。 */
export function libraryOf(root, { current = null, now = Date.now(), liveMin = LIVE_MIN } = {}) {
  const dirs = fs.existsSync(root)
    ? fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name))
    : [];
  const entries = [];
  let skipped = 0;
  for (const dir of dirs) {
    if (!fs.existsSync(path.join(dir, 'ledger.json'))) continue;   // 还没建账
    try {
      const st = staticOf(dir);
      if (!st) { skipped++; continue; }
      // 宿主标题优先：桌面端左侧怎么叫，这里就怎么叫；没有才回落到账本派生标题。
      const host = hostTitleFor(st.id, { sourceFile: st.sourceFile, runner: st.runner });
      const shown = host ? { ...st, title: host, titleFrom: 'host' } : st;
      entries.push({ ...shown, ...statusOf(dir, shown, now), current: shown.id === current });
    } catch { skipped++; }
  }
  const byRunner = new Map();
  for (const e of entries) {
    if (!byRunner.has(e.runner)) byRunner.set(e.runner, []);
    byRunner.get(e.runner).push(e);
  }
  const runners = [...byRunner.keys()].sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a), ib = GROUP_ORDER.indexOf(b);
    if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    return a.localeCompare(b);
  });
  const groups = runners.map((runner) => {
    const list = byRunner.get(runner).sort((a, b) => (b.live - a.live)
      || String(b.lastWriteAt ?? '').localeCompare(String(a.lastWriteAt ?? ''))
      || String(b.builtAt ?? '').localeCompare(String(a.builtAt ?? '')));
    return {
      runner, label: RUNNER_LABEL[runner] || runner,
      count: list.length, live: list.filter((x) => x.live).length,
      organized: list.filter((x) => x.organize && x.organize.level !== 'none').length,
      sessions: list,
    };
  });
  return {
    schema: 1,
    current,
    liveMin,
    at: new Date(now).toISOString(),
    counts: {
      sessions: entries.length, live: entries.filter((x) => x.live).length, skipped,
      // 「整理过」＝模型层至少写过一样且还有效；只建了结构账的不算。
      organized: entries.filter((x) => x.organize && x.organize.level !== 'none').length,
    },
    groups,
  };
}

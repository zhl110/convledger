// export — 把记忆层写成能直接读、能认出「谁/何时/哪个项目」的文件。
// 统一收在工具自己的目录里，不再往每个项目工作目录塞一份：
//   tool/out/exports/projects/<项目名>--<项目键>/PROGRESS.md
//   tool/out/exports/projects/<项目名>--<项目键>/USER-PROFILE.md
//   tool/out/exports/projects/<项目名>--<项目键>/INDEX.md
//   tool/out/exports/projects/<项目名>--<项目键>/archive/<时间>_<类型>_<agent>_<会话>[_s<步>].md
//   tool/out/exports/INDEX.md  跨项目总索引
// 旧位置 <项目>/convledger-export/ 会被下一次导出自动复制过来（不删旧目录；显式 --migrate-legacy 才搬走）。
//
// 零模型调用：全部由账本 + 记忆表现算，和 `convledger memory` 同一套口径。
// 内容变了才存快照（指纹＝正文 sha256 前 12 位，写在首行元信息里），每项目合计保留最近 30 份。
// 源头永远是 out/projects/<key>/memories.json 与 out/user/memories.json，这里全是派生品。
import fs from 'node:fs';
import path from 'node:path';
import { memoryRead, userPortraitText, readProjectMemories, readUserMemories } from './memories.mjs';
import { readState } from './state-io.mjs';
import { projectView, STATUS_LABEL } from './progress.mjs';
import { readView } from './view.mjs';
import { briefText } from './brief.mjs';
import { readRequests } from './notes.mjs';
import { storeDir } from './store.mjs';
import { projectsOf } from './projects.mjs';
import { projectExperience, sessionNotesMarkdown } from './insights.mjs';
import { sha } from './lib.mjs';

export const EXPORT_DIR = 'convledger-export';
export const KEEP_SNAPSHOTS = 30;
export const EXPORT_FILES = { progress: 'PROGRESS.md', profile: 'USER-PROFILE.md', index: 'INDEX.md' };
/** 覆盖守卫：文件首行必须带这个前缀，否则当成手写文件，不碰。 */
export const MARK = '<!-- convledger-export';
/** 正文完整性标记：紧随元信息之后的独立一行；check 用它重算正文哈希，
 *  手改正文但保留首行 fp 的情况会被认出来。 */
const BODY_MARK = '<!-- convledger-export body=';
export const KIND_LABEL = { progress: '项目进度', profile: '用户画像' };
/** 模板版本：渲染骨架（元信息/空行/标题）变了就 bump，否则指纹相同会把旧文件一直留着。 */
const TEMPLATE = 'v4';

const pad = (n) => (n < 10 ? '0' : '') + n;
function localTime(d) {
  const off = -d.getTimezoneOffset();
  const zone = `UTC${off >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}（${zone}）`;
}
const fileStamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const day = (t) => String(t ?? '').slice(0, 10) || '—';
/** 先写临时文件再改名：崩在半路也不会留下半截 PROGRESS.md。 */
function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** 导出统一收在工具自己的派生目录：out/exports/projects/<项目名>--<项目键>/。 */
export function exportRoot(root) {
  return path.join(path.dirname(root), 'exports', 'projects');
}

/** 目录名：项目名可读 + 项目键短码，重名也不会撞。 */
export function exportDirName(project) {
  let name = String(project?.name || '').trim();
  // 未归组项目的 name 可能是哈希/时间戳：改用工作目录最后一段，读起来才像人话。
  if (!name || /^[0-9a-f]{8,}$/i.test(name) || /^\d{4}-\d{2}-\d{2}/.test(name)) {
    name = path.basename(String(project?.root || project?.cwd || '').replace(/\\/g, '/')) || name;
  }
  const slug = name
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'project';
  const key = String(project?.key || '').replace(/^p-/, '').slice(0, 8) || 'unknown';
  return `${slug}--${key}`;
}

export function exportPaths(root, project) {
  const dir = path.join(exportRoot(root), exportDirName(project));
  return {
    dir,
    archive: path.join(dir, 'archive'),
    progress: path.join(dir, EXPORT_FILES.progress),
    profile: path.join(dir, EXPORT_FILES.profile),
    index: path.join(dir, EXPORT_FILES.index),
  };
}

/** 旧位置：<项目>/convledger-export/。只用于迁移与「旧位置还有东西」的提示。 */
export function legacyExportPaths(cwd) {
  const dir = path.join(cwd, EXPORT_DIR);
  return {
    dir,
    archive: path.join(dir, 'archive'),
    progress: path.join(dir, EXPORT_FILES.progress),
    profile: path.join(dir, EXPORT_FILES.profile),
    index: path.join(dir, EXPORT_FILES.index),
  };
}

/** 把旧位置的整棵树复制到新位置（不覆盖已有文件）。返回搬了多少个文件。 */
function copyLegacyInto(legacy, dest) {
  if (!fs.existsSync(legacy.dir)) return 0;
  let n = 0;
  const walk = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, ent.name), b = path.join(to, ent.name);
      if (ent.isDirectory()) walk(a, b);
      else if (!fs.existsSync(b)) { fs.copyFileSync(a, b); n++; }
    }
  };
  walk(legacy.dir, dest.dir);
  return n;
}

/** 显式迁移：复制旧位置到新位置后把旧目录删掉（只在 --migrate-legacy 时调用）。 */
export function migrateLegacyExports(root, project, { dryRun = false } = {}) {
  const cwd = project?.root || project?.cwd || '';
  if (!cwd) return { ok: false, moved: 0, reason: '项目没有 cwd（未归组）' };
  const legacy = legacyExportPaths(cwd);
  if (!fs.existsSync(legacy.dir)) return { ok: true, moved: 0, reason: '没有旧位置' };
  const dest = exportPaths(root, project);
  if (dryRun) return { ok: true, dryRun: true, from: legacy.dir, to: dest.dir };
  const moved = copyLegacyInto(legacy, dest);
  fs.rmSync(legacy.dir, { recursive: true, force: true });
  return { ok: true, moved, from: legacy.dir, to: dest.dir };
}
export const globalIndexFile = (root) => path.join(path.dirname(root), 'exports', 'INDEX.md');

/** 首行元信息：既是覆盖守卫的标记，也是 INDEX 的取数来源（一行看懂谁/何时/多大/第几步）。 */
function metaLine({ kind, project, at, fp, sid, runner, model, step }) {
  return `${MARK} v2 kind=${kind} project=${project.key} at=${at.toISOString()} fp=${fp}`
    + ` sid=${sid ?? '—'} runner=${runner ?? '—'}${model ? ` model=${String(model).replace(/\s+/g, '-')}` : ''}${step != null ? ` step=${step}` : ''} -->`;
}

function readMetaLine(file) {
  try {
    const first = fs.readFileSync(file, 'utf8').split('\n', 1)[0];
    if (!first.startsWith(MARK)) return null;
    const out = {};
    for (const m of first.matchAll(/(\w+)=([^\s>]+)/g)) out[m[1]] = m[2];
    return out;
  } catch { return null; }
}

const metaBlock = (rows) => [
  `<!-- convledger-export v2 — 工具派生，别手改；源头是账本与记忆表。刷新：\`convledger export\`（写记忆时自动）。 -->`,
  `<!-- 内容来自本机账本与记忆表，可能含路径/命令/原文；要入库请先自查敏感内容。 -->`,
  '',
  '## 元信息',
  ...rows.map(([k, v]) => `- **${k}**：${v}`),
  '',
];

function latestModel(root, member) {
  if (!member) return '';
  try { return JSON.parse(fs.readFileSync(path.join(storeDir(root, member.id), 'facts.json'), 'utf8')).session?.models?.join(' / ') ?? ''; }
  catch { return ''; }
}

/** 项目任务投影：PROGRESS 的权威部分是 PT/PM 的当前状态，不是记忆里的「进度」文字。 */
function taskBlock(root, project) {
  let state;
  try { state = readState(root, project.key).state; } catch (e) {
    return { text: `## 任务进度（读不到）\n- ${String(e.message).split('\n')[0]}\n`, revision: null, counts: null, sessions: [], actors: [] };
  }
  if (!state.tasks?.length) return { text: '', revision: state.revision, counts: null, sessions: [], actors: [] };
  const v = projectView(state);
  const c = v.counts.project;
  const out = [
    '## 任务进度（工具复算，权威）',
    `- 版本 r${state.revision} · 完成 ${c.done}/${c.inScope} · 进行中 ${c.active} · 受阻 ${c.blocked} · 待验证 ${c.awaiting} · 未知 ${c.unknown} · 未开始 ${c.planned} · 取消 ${c.cancelled}`,
  ];
  if (v.counts.unorganized) out.push(`- 待整理材料 ${v.counts.unorganized} 条 · 待证候选 ${v.counts.candidatesPending} 条`);
  const sessions = Object.entries(state.checkpoints ?? {}).map(([sid, cp]) => ({ session: sid, to: cp.analyzedThrough, at: cp.at, mode: cp.sourceMode }));
  if (sessions.length) out.push(`- 分析覆盖：${sessions.map((s) => `${s.session.slice(0, 8)} 到字节 ${s.to}${s.mode === 'archived' ? '（归档）' : ''}`).join(' · ')}`);
  for (const m of v.counts.milestones) {
    const meta = v.milestones.find((x) => x.id === m.id) ?? {};
    out.push('');
    out.push(`### ${m.id} ${meta.short ?? ''}（完成 ${m.done}/${m.inScope}）`);
    for (const t of v.tasks.filter((x) => x.milestoneId === m.id)) {
      const tail = t.status === 'done' ? t.result : t.status === 'blocked' ? `受阻：${t.blocker}` : (t.remaining ?? t.nextAction ?? t.result);
      out.push(`- ${t.id} [${STATUS_LABEL[t.status] ?? t.status}] ${t.short}${tail ? ` · ${tail}` : ''}`);
    }
  }
  const actors = [...new Set(state.tasks.map((t) => t.actor).filter(Boolean))];
  out.push('');
  out.push('> 状态依据每条任务的验收项；没有验收记录的完成不会被算作完成。下面的记忆是模型归纳，不是当前任务状态。');
  return { text: out.join('\n') + '\n', revision: state.revision, counts: c, sessions, actors };
}

/** 最新会话的阶段那几行：直接复用 brief 的原样取用口径，不在这里重新发明措辞。 */
function latestStages(root, project) {
  const latest = [...project.members].sort((a, b) => String(b.lastAt ?? '').localeCompare(String(a.lastAt ?? '')))[0];
  if (!latest) return { latest: null, lines: [], steps: null };
  try {
    const dir = storeDir(root, latest.id);
    const v = readView(dir);
    const lines = briefText(v, readRequests(dir).rows)
      .split('\n')
      .filter((l) => /^阶段 |^  做了：|^  成了：|^尾段：/.test(l));
    return { latest, lines, steps: v.mainSteps };
  } catch {
    return { latest, lines: [], steps: null };
  }
}

const MENTRY = /^- \[(M\d+)\] .*$/gm;
const STAGE_LINE = /^阶段 \d+ ·/gm;
const memMap = (t) => {
  const m = new Map();
  for (const x of t.matchAll(MENTRY)) m.set(x[1], x[0]);
  return m;
};
const stagesOf = (t) => (t.match(STAGE_LINE) ?? []).length;
const tally = (label, arr) => `${label} ${arr.length}${arr.length ? `（${arr.slice(0, 5).join(' ')}${arr.length > 5 ? ' …' : ''}）` : ''}`;

/** 与上一份进度快照比：步、阶段段数、记忆条目的增/删/改。接手的人先看这一段。 */
function deltaLines(prevText, curBody, curStep) {
  if (!prevText) return ['- 这是第一份快照（没有可比较的上一份）'];
  const ps = Number((prevText.split('\n', 1)[0].match(/step=(\d+)/) ?? [])[1]);
  const pm = memMap(prevText);
  const cm = memMap(curBody);
  const added = [...cm.keys()].filter((k) => !pm.has(k));
  const gone = [...pm.keys()].filter((k) => !cm.has(k));
  // 同一个编号但那一行变了＝修订；只比编号会把「改写了一条」报成没变。
  const revised = [...cm.keys()].filter((k) => pm.has(k) && pm.get(k) !== cm.get(k));
  const out = [];
  out.push(`- 主线步：${Number.isFinite(ps) ? ps : '—'} → ${curStep ?? '—'}`);
  out.push(`- 阶段：${stagesOf(prevText)} 段 → ${stagesOf(curBody)} 段`);
  out.push(`- 记忆：${tally('新增', added)} · ${tally('修订', revised)} · ${tally('消失', gone)}`);
  if (!added.length && !gone.length && !revised.length && ps === curStep && stagesOf(prevText) === stagesOf(curBody)) {
    out.push('- 步、阶段、记忆都没变；指纹变了多半是计数/统计字段变了（例如新增了段或请求）');
  }
  return out;
}

function previousProgress(root, project) {
  const p = exportPaths(root, project);
  let names = [];
  try { names = fs.readdirSync(p.archive).filter((n) => kindOf(n) === 'progress').sort(); } catch { return null; }
  const last = names.at(-1);
  try { return last ? fs.readFileSync(path.join(p.archive, last), 'utf8') : null; } catch { return null; }
}

function progressParts(root, project, { prevText = null } = {}) {
  const memo = memoryRead(root, project, { withUser: false, maxPerClass: 20 });
  const tasks = taskBlock(root, project);
  const { latest, lines, steps } = latestStages(root, project);
  const since = `${day(project.firstAt)} → ${day(project.lastAt)}`;
  const out = [];
  out.push('## 概况');
  out.push(`- 项目 ${project.name} \`${project.key}\` · ${project.counts.sessions} 个会话 · ${project.counts.segments} 段 · ${since}${project.counts.live ? ` · ${project.counts.live} 进行中` : ''}`);
  out.push(`- 工作目录 \`${project.root || project.cwd || '（没有 cwd，未归组）'}\``);
  if (latest) out.push(`- 最新会话 ${latest.sid8} · ${latest.segments} 段${steps != null ? ` / ${steps} 步` : ''} · 最后写入 ${day(latest.lastAt)}`);
  if (tasks.text) out.push('', tasks.text);
  out.push('');
  out.push(`## 阶段（最新会话${latest ? ` ${latest.sid8}` : ''}）`);
  if (!lines.length) out.push('- 没有阶段说明（阶段层还没写；块层与原文仍可查）');
  else for (const l of lines) out.push(l);
  out.push('');
  // 块经验：按会话 + 阶段收拢，缺了就写 0 条，不拿「规则」冒充经验。
  const exp = projectExperience(root, project.key, { maxSessions: 6, maxLessons: 40, maxGroups: 20 });
  out.push('## 经验（按阶段）');
  if (!exp.groups.length) out.push('- 块综述还没写 lesson（可复用经验 0 条）');
  else for (const g of exp.groups) {
    out.push(`### ${g.sid8} · ${g.label}`);
    for (const it of g.items) out.push(`- 第 ${it.step ?? '—'} 步 · 块 ${it.block} — ${it.lesson}${it.need ? `（当时的要求：${it.need}）` : ''}`);
  }
  out.push('');
  // memoryRead 的头一行是它自己的 H1（带会话数与日期），这里已经有「概况」，去掉。
  const body = memo.text.split('\n');
  while (body.length && !body[0].trim()) body.shift();
  if (body[0]?.startsWith('# ')) body.shift();
  out.push(...body);
  out.push(`- 最近会话：${[...project.members]
    .sort((a, b) => String(b.lastAt ?? '').localeCompare(String(a.lastAt ?? '')))
    .slice(0, 5)
    .map((m) => `${m.sid8}(${m.runner},${m.segments}段,${day(m.lastAt)})`)
    .join(' · ')}`);
  const base = out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
  // 增量是历史相关的：它不进指纹，否则每次导出后「上一份」就变成自己，check 永远过期。
  return { body: base, delta: deltaLines(prevText, base, memo.now?.step), now: memo.now, latest, tasks };
}

function progressText(root, project, { now }) {
  const p = progressParts(root, project, { prevText: previousProgress(root, project) });
  const fp = sha(`${TEMPLATE}
${p.body}`);
  const latest = p.latest;
  const lines = metaBlock([
    ['项目', `${project.name}（\`${project.key}\`）`],
    ['工作目录', `\`${project.root || project.cwd}\``],
    ['生成时间', localTime(now)],
    ['生成会话', `${latest?.sid8 ?? '—'}（${latest?.runner ?? '—'}${latestModel(root, latest) ? ` · ${latestModel(root, latest)}` : ''}）· 第 ${p.now?.step ?? '—'} 步`],
    ['账本', `${project.counts.segments} 段 · ${project.counts.sessions} 个会话 · 最后写入 ${day(project.lastAt)}`],
    ['任务版本', p.tasks.revision != null ? `r${p.tasks.revision}` : '（尚无任务状态）'],
    ['记忆版本', `项目 r${readProjectMemories(root, project.key).revision} · 用户 r${readUserMemories(root).revision}`],
    ['任务作者', p.tasks.actors.join('、') || '—'],
    ['分析覆盖', p.tasks.sessions.length ? p.tasks.sessions.map((s) => `${s.session.slice(0, 8)}→字节 ${s.to}${s.mode === 'archived' ? '（归档）' : ''}`).join(' · ') : '—'],
    ['内容指纹', `${fp}（正文变了才会存新快照）`],
    ['用户画像', `同目录 \`${EXPORT_FILES.profile}\`（跨项目）`],
  ]);
  const title = `# 项目进度 · ${project.name}\n\n`;
  const at = p.body.indexOf('## 阶段');
  const withDelta = at > 0
    ? p.body.slice(0, at) + `## 自上一份快照以来\n${p.delta.join('\n')}\n\n` + p.body.slice(at)
    : p.body;
  const payload = `${title}${lines.join('\n')}\n${withDelta}\n`;
  return { text: `${metaLine({ kind: 'progress', project, at: now, fp, sid: latest?.sid8, runner: latest?.runner, model: latestModel(root, latest), step: p.now?.step })}\n${BODY_MARK}${sha(`${TEMPLATE}\n${payload}`)} -->\n${payload}`, body: p.body, fp, step: p.now?.step, latest };
}

function profileText(root, project, { now }) {
  const p = userPortraitText(root);
  const fp = sha(`${TEMPLATE}
${p.text}`);
  const latest = [...project.members].sort((a, b) => String(b.lastAt ?? '').localeCompare(String(a.lastAt ?? '')))[0];
  const lines = metaBlock([
    ['范围', '用户级（所有项目共用一份；本项目里是快照）'],
    ['项目', `${project.name}（\`${project.key}\`）`],
    ['生成时间', localTime(now)],
    ['生成会话', `${latest?.sid8 ?? '—'}（${latest?.runner ?? '—'}）`],
    ['条目', `画像 ${p.counts.images} 条 · 晋升规则 ${p.counts.rules} 条${p.counts.stale ? ` · 失效 ${p.counts.stale} 条` : ''}`],
    ['内容指纹', `${fp}（正文变了才会存新快照）`],
    ['写入口', '`memory --put --scope user`（画像）· `memory --promote`（规则，跨 ≥2 个项目）'],
  ]);
  const payload = `# 用户画像 / 工作方式（跨项目）\n\n${lines.join('\n')}\n${p.text}\n`;
  return { text: `${metaLine({ kind: 'profile', project, at: now, fp, sid: latest?.sid8, runner: latest?.runner })}\n${BODY_MARK}${sha(`${TEMPLATE}\n${payload}`)} -->\n${payload}`, body: p.text, fp, latest };
}

const kindOf = (name) => (/^\d{4}-\d{2}-\d{2}_\d{4,6}_(progress|profile)_/.exec(name)?.[1] ?? null);

/** 每个项目**合计**只留最近 KEEP_SNAPSHOTS 份（progress + profile 一起算）；
 *  名字按时间可排序，所以不读文件时间；不是本工具生成的快照名一律不碰。 */
export const snapshotNames = (dir) => { try { return fs.readdirSync(dir).filter((n) => kindOf(n)); } catch { return []; } };
export function prunePreview(dir, keep = KEEP_SNAPSHOTS) {
  return snapshotNames(dir).sort().slice(0, Math.max(0, snapshotNames(dir).length - keep));
}
function pruneTotal(dir, keep = KEEP_SNAPSHOTS) {
  const extra = prunePreview(dir, keep);
  for (const n of extra) { try { fs.rmSync(path.join(dir, n)); } catch { /* 删不了就留着 */ } }
  return extra;
}

function writeIndex(p) {
  const rows = [];
  let names = [];
  try { names = fs.readdirSync(p.archive); } catch { /* 还没归档 */ }
  for (const name of names) {
    if (!kindOf(name)) continue;
    const m = readMetaLine(path.join(p.archive, name));
    let bytes = 0;
    try { bytes = fs.statSync(path.join(p.archive, name)).size; } catch { /* 刚被删 */ }
    rows.push({ name, at: m?.at ?? '', kind: kindOf(name), sid: m?.sid ?? '—', runner: m?.runner ?? '—', step: m?.step ?? '—', fp: m?.fp ?? '—', bytes });
  }
  rows.sort((a, b) => String(b.at).localeCompare(String(a.at)) || String(b.name).localeCompare(String(a.name)));
  const L = [
    `${MARK} v2 kind=index project=${p.project.key} at=${p.now.toISOString()} fp=— -->`,
    `# 导出清单 · ${p.project.name}`,
    '',
    '## 元信息',
    `- **项目**：${p.project.name}（\`${p.project.key}\`）`,
    `- **生成时间**：${localTime(p.now)}`,
    `- **现存快照**：${rows.length} 份（每项目合计保留最近 ${KEEP_SNAPSHOTS} 份；自动刷新不删，显式 export 才剪）`,
    `- **稳定入口**：\`${EXPORT_FILES.progress}\`（项目进度）· \`${EXPORT_FILES.profile}\`（用户画像）`,
    '',
    '| 时间 | 类型 | agent | 会话 | 步 | 指纹 | 字节 | 文件 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) L.push(`| ${String(r.at).replace('T', ' ').slice(0, 19)} | ${KIND_LABEL[r.kind] ?? r.kind} | ${r.runner} | ${r.sid} | ${r.step} | ${r.fp} | ${r.bytes} | \`archive/${r.name}\` |`);
  writeAtomic(p.index, L.join('\n') + '\n');
}

/** 跨项目总索引：工具侧 out/exports/INDEX.md，换项目接手先看它。 */
export function writeGlobalIndex(root, { now = new Date() } = {}) {
  const file = globalIndexFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rows = [];
  let projects = [];
  try { projects = projectsOf(root, { withSteps: false }).projects; } catch { projects = []; }
  for (const project of projects) {
    const cwd = project.root || project.cwd || '';
    if (!cwd) continue;
    const p = exportPaths(root, project);
    if (!fs.existsSync(p.progress)) continue;
    const meta = readMetaLine(p.progress) ?? {};
    let snapshots = 0;
    let names = [];
    try { names = fs.readdirSync(p.archive); } catch { /* 没有归档 */ }
    for (const n of names) if (kindOf(n) === 'progress') snapshots++;
    let mtime = null;
    try { mtime = fs.statSync(p.progress).mtime.toISOString(); } catch { /* 读不到 */ }
    rows.push({ project, dir: p.dir, at: meta.at ?? mtime ?? '', snapshots, runner: meta.runner ?? '—', step: meta.step ?? '—', live: project.counts.live > 0 });
  }
  rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const L = [
    `${MARK} v2 kind=global-index at=${now.toISOString()} fp=— -->`,
    '# 跨项目导出总索引',
    '',
    `> 工具派生；生成于 ${localTime(now)}。每个项目的稳定入口在工具目录下：\`out/exports/projects/<项目名>--<项目键>/${EXPORT_FILES.progress}\`。`,
    `> 共 ${rows.length} 个项目有导出；没有导出的项目不在此列（\`convledger export --all\` 可一次补全）。`,
    '',
    '| 最近导出 | 项目 | agent | 第几步 | 快照 | 进行中 | 目录 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) L.push(`| ${String(r.at).replace('T', ' ').slice(0, 19)} | ${r.project.name}（\`${r.project.key}\`） | ${r.runner} | ${r.step} | ${r.snapshots} | ${r.live ? '是' : '—'} | \`${r.dir}\` |`);
  writeAtomic(file, L.join('\n') + '\n');
  return { file, projects: rows.length };
}

/**
 * 写两份导出。内容没变就不动文件；每项目合计只留最近 30 份快照，且只在显式导出时剪。
 * 不抛错——调用方（memory --put）不该因为导出失败而失败。
 */
export function writeProjectExports(root, project, { force = false, now = new Date(), prune = false } = {}) {
  const cwd = project?.root || project?.cwd || '';
  if (!cwd) return record(root, project, { ok: false, files: [], skipped: ['项目没有 cwd（未归组），导出无处可写'], pruned: [] });
  // 目录不在了也照常导出：导出已收在工具目录，不再依赖项目目录存在。
  const p = exportPaths(root, project);
  // 旧位置还有导出：先原样复制过来（不删旧目录），让老机器/老文档仍能找到历史快照。
  let migrated = 0;
  const legacy = legacyExportPaths(cwd);
  if (!fs.existsSync(p.progress) && fs.existsSync(legacy.dir)) {
    try { migrated = copyLegacyInto(legacy, p); } catch { /* 复制失败不影响新写 */ }
  }
  // junction / 符号链接可能把写入引到别处：本地工具，遇到就拒绝，不猜。
  try {
    if (fs.lstatSync(p.dir).isSymbolicLink()) return record(root, project, { ok: false, files: [], skipped: [`${p.dir} 是符号链接，拒绝写入`], pruned: [] });
  } catch { /* 目录还不存在，正常 */ }
  fs.mkdirSync(p.archive, { recursive: true });
  // 这次导出想写的是哪几版：任务 revision + 两张记忆表的 revision。
  let desired = null;
  try {
    desired = {
      tasks: readState(root, project.key).revision,
      memProject: readProjectMemories(root, project.key).revision,
      memUser: readUserMemories(root).revision,
    };
  } catch { desired = null; }
  p.project = project;
  p.now = now;
  const files = [];
  const skipped = [];
  const pruned = [];
  const notes = [];
  if (migrated) notes.push(`已从旧位置复制 ${migrated} 个文件到工具目录（旧目录未删；要搬走跑 export --migrate-legacy）`);
  for (const [kind, made] of [['progress', progressText(root, project, { now })], ['profile', profileText(root, project, { now })]]) {
    const live = p[kind];
    const prev = readMetaLine(live);
    // 首行指纹相同还不够：文件正文可能被手改过。正文标记对得上才叫「没变」。
    let prevIntact = false;
    if (prev && fs.existsSync(live)) {
      const integ = fileIntegrity(fs.readFileSync(live, 'utf8'));
      prevIntact = !!integ && integ.recorded === integ.actual;
    }
    if (prev && prev.fp === made.fp && prevIntact) { skipped.push(`${path.basename(live)}：内容没变，未重写`); continue; }
    if (fs.existsSync(live) && !prev && !force) { skipped.push(`${path.basename(live)} 已存在且不是本工具生成的；不覆盖（要覆盖加 --force）`); continue; }
    try {
      writeAtomic(live, made.text);
      const latest = made.latest;
      const name = `${fileStamp(now)}_${kind}_${latest?.runner ?? 'unknown'}_${latest?.sid8 ?? 'nosession'}${kind === 'progress' && made.step != null ? `_s${made.step}` : ''}_${made.fp.slice(0, 6)}.md`;
      writeAtomic(path.join(p.archive, name), made.text);
      files.push({ kind, path: live, archive: path.join(p.archive, name), bytes: Buffer.byteLength(made.text) });
    } catch (e) {
      skipped.push(`${live} 写不了：${String(e?.message ?? e).split('\n')[0]}`);
    }
  }
  // 单会话笔记：给「拿走总结/回档」用；内容没变就不重写。
  const notesDir = path.join(p.dir, 'sessions');
  try {
    fs.mkdirSync(notesDir, { recursive: true });
    const members = [...project.members]
      .sort((a, b) => String(b.lastAt ?? '').localeCompare(String(a.lastAt ?? '')))
      .slice(0, 12);
    for (const m of members) {
      const md = sessionNotesMarkdown(root, m.id);
      if (!md) continue;
      const file = path.join(notesDir, `${m.sid8}-notes.md`);
      let prev = null;
      try { prev = fs.readFileSync(file, 'utf8'); } catch { /* 新文件 */ }
      if (prev === md) continue;
      writeAtomic(file, md);
      files.push({ kind: 'notes', path: file, bytes: Buffer.byteLength(md) });
    }
  } catch (e) { skipped.push(`会话笔记写不了：${String(e?.message ?? e).split('\n')[0]}`); }
  if (prune) {
    try { pruned.push(...pruneTotal(p.archive).map((n) => `archive/${n}`)); } catch (e) { skipped.push(`裁剪失败：${String(e?.message ?? e).split('\n')[0]}`); }
  } else {
    const would = prunePreview(p.archive);
    if (would.length) skipped.push(`超过合计 ${KEEP_SNAPSHOTS} 份 ${would.length} 个（未删；确认后跑 export 才会剪）`);
  }
  try { writeIndex(p); } catch (e) { skipped.push(`INDEX.md 写不了：${String(e?.message ?? e).split('\n')[0]}`); }
  try { writeGlobalIndex(root, { now }); } catch (e) { skipped.push(`跨项目总索引写不了：${String(e?.message ?? e).split('\n')[0]}`); }
  return record(root, project, { ok: files.length > 0, dir: p.dir, files, skipped: [...notes, ...skipped], pruned, desired, migrated });
}

/** 最近一次导出尝试：成功/跳过原因都留痕，`export --list` 会带一行。 */
export const lastRunFile = (root) => path.join(path.dirname(root), 'exports', 'last.json');
function record(root, project, result) {
  try {
    const file = lastRunFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeAtomic(file, JSON.stringify({
      at: new Date().toISOString(),
      project: project ? { key: project.key, name: project.name, dir: project.root || project.cwd || '' } : null,
      ok: !!result.ok,
      kinds: (result.files ?? []).map((f) => f.kind),
      skipped: result.skipped ?? [],
      pruned: (result.pruned ?? []).length,
      desired: result.desired ?? null,
      succeeded: (result.files ?? []).map((f) => f.kind),
    }, null, 1) + '\n');
  } catch { /* 留痕写不了不影响导出结果 */ }
  return result;
}

/** 新鲜度自检：文件指纹与「现在重新渲染」的指纹比对，不写任何东西。 */
/** 正文自带的完整性标记：记录的是「标记行之后全部内容」的哈希。
 *  手改正文而首行指纹不动时，只有它能认出来。 */
function fileIntegrity(raw) {
  const i = raw.indexOf(BODY_MARK);
  if (i < 0) return null;
  const nl = raw.indexOf('\n', i);
  if (nl < 0) return null;
  const m = raw.slice(i, nl).match(/body=([0-9a-f]+)/);
  if (!m) return null;
  return { recorded: m[1], actual: sha(`${TEMPLATE}\n${raw.slice(nl + 1)}`) };
}

export function checkExports(root, project, { now = new Date() } = {}) {
  const cwd = project?.root || project?.cwd || '';
  if (!cwd) return { ok: false, items: [], error: '项目没有 cwd（未归组）' };
  const paths = exportPaths(root, project);
  const legacy = legacyExportPaths(cwd);
  const legacyHas = fs.existsSync(legacy.dir);
  const items = [];
  for (const [kind, made] of [['progress', progressText(root, project, { now })], ['profile', profileText(root, project, { now })]]) {
    const file = paths[kind];
    const meta = readMetaLine(file);
    let status;
    let note = null;
    let actualFp = null;
    if (!fs.existsSync(file)) {
      status = legacyHas ? 'legacy' : 'missing';
      note = legacyHas ? `旧位置还有导出：${legacy.dir}（跑 convledger export 复制到工具目录，或 export --migrate-legacy 搬走）` : null;
    }
    else if (!meta) status = 'unmanaged';
    else if (meta.project !== project.key || meta.kind !== kind) { status = 'foreign'; note = '首行指向另一个项目/类型'; }
    else {
      const raw = fs.readFileSync(file, 'utf8');
      const integ = fileIntegrity(raw);
      const intact = !!integ && integ.recorded === integ.actual;
      status = intact && meta.fp === made.fp ? 'fresh' : 'stale';
      if (!integ) note = '缺少正文完整性标记（旧版本或手写）';
      else if (!intact) note = '正文与标记对不上（文件被手改）';
    }
    items.push({ kind, file, status, fp: made.fp, actualFp, prevFp: meta?.fp ?? null, at: meta?.at ?? null, note });
  }
  return { ok: items.every((x) => x.status === 'fresh'), items, dir: paths.dir };
}

// 项目记忆层（memories.json）：模型跨会话归纳「这个项目到哪、踩过什么坑、什么是通用规则」。
// 工具一次模型都不调——写的是读模型，这里只做机械校验（PRD-memory §五 G0–G7）：
// 一条不过整批不写，与 claims / summaries / phases 同一纪律。
//
// 与单会话层的分工：claims 是逐段认识增量，summaries 是逐块综述，phases 是阶段括号；
// 记忆是跨会话的第二层，每条证据都带 sid + 段锚点哈希，读时逐条复算，账本一变就失效。
// 记忆永远不是 claim：basis 恒为 'model'，不进六条判据，永不写成 verified。
//
// 落盘位置是 store 根的兄弟目录：out/store → out/projects/<key>/。out/ 已被
// .gitignore 挡住——表里含会话逐字引文，永不入库。
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { blocksOf, readJsonl, stripInjected, tok, num } from './lib.mjs';
import { normalizeRecords } from './project.mjs';
import { build } from './build.mjs';
import { effectiveSource, writeStore } from './store.mjs';
import { readRequests } from './notes.mjs';
import { projectKey, projectsOf } from './projects.mjs';
import { normCwd } from './current.mjs';
import { readView, TOOLISH, NOSAY } from './view.mjs';
import { containsVerbatim, factTokens, norm, overlapShare } from './claims.mjs';
import { movesOf } from './topics.mjs';
import {
  MEMORY_DIGEST_TOKENS, MEMORY_EVIDENCE_MAX, MEMORY_QUOTE_MAX, MEMORY_TEXT_MAX, MEMORY_TOPIC_MAX,
  REVISION_SHARE, SUMMARY_MIN_QUOTE_OVERLAP,
} from './cost.mjs';

/** 项目表的四类。画像天生跨项目，归用户表（P3），项目表不收。 */
export const MEMORY_CLASSES = ['进度', '经验', '规则', '探索'];
/** 记忆的维度：和 class 正交。class 说「这是进度/经验/规则/探索」，dimension 说
 *  它回答用户的哪一类约束（目标、边界、验收、分工……）。旧条目可以没有 dimension。 */
export const MEMORY_DIMENSIONS = ['目标', '边界', '规则', '偏好', '背景', '验收', '分工', '反馈', '性格'];
const EXPERIENCE_MOVES = ['ruleout', 'decision', 'insight'];

const SEG_RE = /^S\d{2,}$/;
const normWs = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

// ── 表结构 v2：revision、操作日志与历史与条目同表 ──────────────────────────
// v1 没有这三样；读到 v1 先把它逐字备份成 memories.json.v1.bak，再补字段写回 v2。
// 未知 schema 一律拒绝——把别人的表当空表重写一次，旧结论就没了。
export const MEMORIES_SCHEMA = 'convledger-memories/2';
const LEGACY_SCHEMA = 'convledger-memories/1';
const sha256 = (x) => crypto.createHash('sha256').update(x).digest('hex');

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, JSON.stringify(obj, null, 1) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

function readMemoriesDoc(file, base) {
  const empty = { ...base, schema: MEMORIES_SCHEMA, revision: 0, entries: [], appliedOperations: [], history: [] };
  if (!fs.existsSync(file)) return empty;
  let parsed;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); parsed = JSON.parse(raw); } catch (e) {
    throw new Error(`${file} 读不了（${String(e.message).split('\n')[0]}）— 修它，否则下一批记忆会把它覆盖掉`);
  }
  const schema = parsed?.schema;
  if (schema !== MEMORIES_SCHEMA && schema !== LEGACY_SCHEMA) {
    throw Object.assign(new Error(`${file} 是未知 schema（${schema ?? '缺失'}）——拒绝按空表读/写`), { code: 'unknown-schema' });
  }
  const doc = {
    ...base, schema: MEMORIES_SCHEMA,
    revision: Number.isInteger(parsed.revision) ? parsed.revision : 1,
    entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    appliedOperations: Array.isArray(parsed.appliedOperations) ? parsed.appliedOperations : [],
    history: Array.isArray(parsed.history) ? parsed.history : [],
  };
  if (schema === LEGACY_SCHEMA) {
    const backup = `${file}.v1.bak`;
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, raw);
    writeJsonAtomic(file, doc);
  }
  return doc;
}

// ── 路径：身份表与记忆表都放在 store 根的兄弟目录下 ─────────────────────────

export const projectMemoryDir = (root, key) => path.resolve(root, '..', 'projects', key).replace(/\\/g, '/');

export function readProjectMemories(root, key) {  return readMemoriesDoc(path.join(projectMemoryDir(root, key), 'memories.json'), { scope: 'project', project: key });
}

function writeProjectMemories(root, key, entries, patch = {}) {
  const file = path.join(projectMemoryDir(root, key), 'memories.json');
  const prev = readJson(file) ?? {};
  writeJsonAtomic(file, {
    schema: MEMORIES_SCHEMA, scope: 'project', project: key,
    revision: patch.revision ?? ((Number.isInteger(prev.revision) ? prev.revision : 0) + 1),
    entries,
    appliedOperations: patch.appliedOperations ?? (Array.isArray(prev.appliedOperations) ? prev.appliedOperations : []),
    history: patch.history ?? (Array.isArray(prev.history) ? prev.history : []),
  });
}

// ── 用户表（out/user/memories.json）：画像 + 晋升来的通用规则 ──────────────
// 与项目表同一形状，但作用域不同：画像只在用户表（G9），规则只能经 --promote
// 从 ≥2 个项目的等价条目合成（G8）。表里含跨项目逐字引文，out/ 已挡住入库。

export const userMemoryDir = (root) => path.resolve(root, '..', 'user').replace(/\\/g, '/');

export function readUserMemories(root) {
  return readMemoriesDoc(path.join(userMemoryDir(root), 'memories.json'), { scope: 'user' });
}

/** 协作画像：从两张记忆表里挑出「和这个人一起干活要守的」几条，供 brief 注入。
 *  只读两个 JSON 文件——走 buildContext 会把 store 里几千本账全读一遍，那是 put 时才付得起的代价，
 *  不能放在每轮注入里。项目表按项目规则取；用户表先保底 验收/边界/反馈，再按当前任务词挑剩下的。 */
const CORE_DIMS = ['验收', '边界', '反馈'];
// 场景是固定的任务类型，不是用户记忆正文里的关键词。一个场景对应几类约束；
// 画像条目可带 scenes（多标签）与 dimension；选择时关键词、条目场景、维度兜底合并使用。
const SCENE_DIMS = {
  // 活动 / 阶段
  plan: ['目标', '边界', '分工', '规则'],
  research: ['背景', '偏好', '目标'],
  design: ['偏好', '反馈', '验收', '目标'],
  build: ['规则', '验收', '边界'],
  test: ['验收', '反馈', '规则'],
  review: ['验收', '反馈'],
  deliver: ['验收', '分工', '反馈'],
  operate: ['规则', '偏好'],
  closeout: ['验收', '规则', '偏好'],
  // 产物 / 领域
  ui: ['偏好', '验收', '反馈'],
  web: ['偏好', '验收', '反馈'],
  graphic: ['偏好', '反馈', '验收'],
  docs: ['目标', '反馈', '规则'],
  data: ['背景', '验收', '规则'],
  code: ['规则', '验收', '边界'],
  arch: ['目标', '边界', '规则'],
  tooling: ['偏好', '规则'],
  config: ['规则', '边界'],
  // 互动 / 习惯
  'tool-choice': ['偏好', '规则'],
  workflow: ['规则', '分工', '偏好'],
  scope: ['边界', '分工'],
  feedback: ['反馈', '验收'],
  quality: ['验收', '反馈'],
  pacing: ['偏好', '分工'],
  // 环境
  local: ['边界', '背景'],
  'multi-agent': ['分工', '边界'],
  host: ['边界', '规则'],
  project: ['目标', '边界'],
  general: ['目标', '偏好', '性格', '分工'],
};

export const MEMORY_SCENES = Object.keys(SCENE_DIMS);

const STOP_BIGRAMS = new Set(['这个', '我们', '就是', '可以', '需要', '一下', '还是', '一个', '没有', '不是', '什么', '现在', '已经', '如果', '因为', '所以', '但是', '然后', '以及', '这些']);

function contextTerms(text) {
  const src = String(text ?? '').toLowerCase();
  const terms = new Set();
  for (const w of src.match(/[a-z][a-z0-9._+\/-]{2,}|\d{2,}/g) || []) terms.add(w);
  const han = src.replace(/[^\u3400-\u9fff]+/g, '');
  for (let i = 0; i < han.length - 1; i++) {
    const t = han.slice(i, i + 2);
    if (!STOP_BIGRAMS.has(t)) terms.add(t);
  }
  return terms;
}

function dimOf(e) { return String(e?.dimension || e?.class || '记忆'); }

function pickCollab(list, cls, max, { core, dims, sceneSet, terms, projectKey }) {
  const rows = (list || []).filter((e) => e && e.text && e.class === cls)
    .map((e) => {
      const dim = dimOf(e);
      const di = dims ? dims.indexOf(dim) : -1;
      const explicit = Array.isArray(e.scenes) && e.scenes.length
        ? e.scenes.filter((x) => MEMORY_SCENES.includes(x))
        : null;
      const sceneHit = explicit ? explicit.some((x) => sceneSet.has(x)) : false;
      const coreIdx = CORE_DIMS.indexOf(dim);
      const text = `${e.topic || ''} ${e.text || ''} ${dim}`.toLowerCase();
      let hits = 0;
      for (const t of terms) if (text.includes(t) && ++hits >= 6) break;
      let score = coreIdx >= 0 ? 100 - coreIdx * 5 : 0;
      score += hits * 12; // 关键词命中优先，用来找得更准
      if (sceneHit) score += 50; // 条目自身有场景标签：直接命中
      else if (!explicit && di >= 0) score += 30 - di * 2; // 旧条目没有标签时按维度兜底
      if (projectKey && (e.evidence || []).some((x) => x?.project === projectKey)) score += 4;
      // 项目规则不按用户场景过滤（dims=null 时始终占位）；用户画像没有标签时才按维度兜底。
      return { e, dim, score, hits, inScene: dims === null ? true : (sceneHit || (!explicit && di >= 0)) };
    })
    .sort((a, b) => b.score - a.score
      || String(b.e.at || '').localeCompare(String(a.e.at || ''))
      || String(a.e.id || '').localeCompare(String(b.e.id || '')));
  const out = [];
  const seen = new Set();
  if (core) {
    for (const dim of CORE_DIMS) {
      const hit = rows.find((r) => r.dim === dim && !seen.has(dim));
      if (!hit || out.length >= max) continue;
      out.push(hit); seen.add(dim);
    }
  }
  for (const r of rows) {
    if (out.length >= max) break;
    if (seen.has(r.dim)) continue;
    if (!r.inScene && !r.hits) continue; // 场景不相关且关键词也没命中，才不占位
    seen.add(r.dim); out.push(r);
  }
  return out.map((r) => ({ tag: r.dim, text: String(r.e.text) }));
}

export function collabBrief(root, projectKey, { projectMax = 2, userMax = 5, scenes = [], context = '' } = {}) {
  const dims = [];
  for (const scene of scenes) for (const d of SCENE_DIMS[scene] || []) if (!dims.includes(d)) dims.push(d);
  if (!dims.length) dims.push(...SCENE_DIMS.general);
  const sceneSet = new Set(scenes.length ? scenes : ['general']);
  const terms = contextTerms(context);
  const out = [];
  // 项目规则是项目内约束；用户画像关键词、条目场景标签、维度兜底三路合并。
  try { out.push(...pickCollab(readProjectMemories(root, projectKey).entries, '规则', projectMax, { core: false, dims: null, sceneSet, terms, projectKey })); }
  catch { /* 表读不动就当没有 */ }
  try { out.push(...pickCollab(readUserMemories(root).entries, '画像', userMax, { core: true, dims, sceneSet, terms, projectKey })); }
  catch { /* 同上 */ }
  return out;
}

function writeUserMemories(root, entries, patch = {}) {
  const file = path.join(userMemoryDir(root), 'memories.json');
  const prev = readJson(file) ?? {};
  writeJsonAtomic(file, {
    schema: MEMORIES_SCHEMA, scope: 'user',
    revision: patch.revision ?? ((Number.isInteger(prev.revision) ? prev.revision : 0) + 1),
    entries,
    appliedOperations: patch.appliedOperations ?? (Array.isArray(prev.appliedOperations) ? prev.appliedOperations : []),
    history: patch.history ?? (Array.isArray(prev.history) ? prev.history : []),
  });
}

/** 身份表只在第一次写记忆时创建：它是因为账本被删后记忆仍要知道「这是哪个项目」，
 *  不是成员缓存——成员每次从 ledger.json 现算，缓存一定会漂。 */
function writeProjectIdentity(root, project) {
  const dir = projectMemoryDir(root, project.key);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'project.json');
  if (fs.existsSync(file)) return;
  fs.writeFileSync(file, JSON.stringify({
    schema: 'convledger-project/1', key: project.key, root: project.root, name: project.name,
    createdAt: new Date().toISOString(),
  }, null, 1) + '\n');
}

// ── 项目解析与上下文 ─────────────────────────────────────────────────────

/** --project 的解析顺序：键/名字 > 当前 cwd 所属项目 > 只有一个项目时用它 > 报错。 */
export function resolveProject(root, spec = '', { cwd = '' } = {}) {
  const all = projectsOf(root, { withSteps: false }).projects;
  const s = String(spec ?? '').trim();
  if (s) {
    const byKey = all.find((p) => p.key === s);
    if (byKey) return byKey;
    const low = s.toLowerCase();
    const exact = all.filter((p) => p.name.toLowerCase() === low);
    if (exact.length === 1) return exact[0];
    const prefix = all.filter((p) => p.name.toLowerCase().startsWith(low));
    if (prefix.length === 1) return prefix[0];
    if (prefix.length > 1) throw new Error(`项目名「${s}」不唯一：${prefix.map((p) => `${p.name}（${p.key}）`).join(' / ')}——用键指`);
    throw new Error(`没有项目「${s}」：用 convledger projects 看（共 ${all.length} 个）`);
  }
  const normed = cwd ? normCwd(cwd) : '';
  if (normed) {
    const hit = all.find((p) => projectKey(normed) === p.key);
    if (hit) return hit;
  }
  if (all.length === 1) return all[0];
  throw new Error(`store 里有 ${all.length} 个项目，用 --project <键|名字> 指一个（convledger projects 看清单）`);
}

/**
 * 一次校验要的所有东西：每个成员的账本、claims、按段索引；请求按「会话+rid」索引。
 * 用户作用域把全部项目一起装进同一个上下文，证据靠 project 键消歧。
 * 视图与真人原话按需加载——只读记忆时不需要它们，进度闸与 say 闸才需要。
 */
export function buildContext(root, projects) {
  const members = [];
  const bySid = new Map();
  const projectOf = new Map();
  const requestIndex = new Map();
  for (const project of projects) {
    for (const m of project.members) {
      const ledger = JSON.parse(fs.readFileSync(path.join(m.dir, 'ledger.json'), 'utf8'));
      const claims = readJson(path.join(m.dir, 'claims.json')) ?? {};
      const id = String(ledger.sessionId ?? m.id);
      if (bySid.has(id)) continue;
      const member = { id, sid8: id.slice(0, 8), dir: m.dir, ledger, claims, segById: new Map((ledger.segments ?? []).map((s) => [s.id, s])) };
      for (const r of readRequests(m.dir).rows) requestIndex.set(`${id}|${r.id}`, r);
      members.push(member);
      bySid.set(id, member);
      projectOf.set(id, project);
    }
  }
  return { root, projects, members, bySid, projectOf, requestIndex, views: new Map(), speech: new Map() };
}

export function memoryContext(root, project) {
  return { ...buildContext(root, [project]), project };
}

/** 用户作用域：全部项目一个上下文。画像证据天生跨项目，sid 前缀要靠 project 键消歧。 */
export function userContext(root) {
  const ctx = buildContext(root, projectsOf(root, { withSteps: false }).projects);
  ctx.project = null;
  return ctx;
}

/** 证据里写的是 8 位前缀（demo0001）；完整 id 与唯一前缀都收。
 *  project 给了就先收窄到那个项目——跨项目上下文里两个会话可能撞前 8 位。 */
function memberOf(ctx, sid, project = '') {
  const s = String(sid ?? '').trim();
  if (!s) return null;
  const scope = project ? ctx.members.filter((m) => ctx.projectOf.get(m.id)?.key === project) : ctx.members;
  const exact = scope.find((m) => m.id === s);
  if (exact) return exact;
  const hits = scope.filter((m) => m.id.startsWith(s));
  return hits.length === 1 ? hits[0] : null;
}

function viewOf(ctx, member) {
  if (!ctx.views.has(member.id)) ctx.views.set(member.id, readView(member.dir));
  return ctx.views.get(member.id);
}

function recordsOf(ctx, member) {
  if (!member.records) {
    const ef = effectiveSource(member.ledger);
    member.records = ef.file && fs.existsSync(ef.file)
      ? normalizeRecords(member.ledger.runner, readJsonl(ef.file))
      : [];
  }
  return member.records;
}

/** 这一段里真人说的话，工具回执与压缩摘要一律挡在门外。
 *  Qoder 把工具结果也存成 user 记录，所以只认 humanInput；压缩摘要是 runner 写的
 *  段落，不是人说的话，`isCompactSummary` 再挡一层（claims 的 who 也先判它）。 */
function speechOf(ctx, member, seg) {
  const key = `${member.id}|${seg.id}`;
  if (ctx.speech.has(key)) return ctx.speech.get(key);
  const parts = [];
  for (const r of recordsOf(ctx, member)) {
    if (r.__line < seg.lineFrom) continue;
    if (r.__line > seg.lineTo) break;
    if (!r.humanInput || r.isCompactSummary) continue;
    for (const b of blocksOf(r)) {
      if (b?.type !== 'text') continue;
      for (const line of String(stripInjected(b.text ?? '')).split('\n')) {
        const v = line.trim();
        if (!v || TOOLISH.test(v) || NOSAY.test(v)) continue;
        parts.push(v);
      }
    }
  }
  const text = parts.join('\n');
  ctx.speech.set(key, text);
  return text;
}

function stepOf(ctx, e) {
  const m = memberOf(ctx, e.sid);
  if (!m) return null;
  return viewOf(ctx, m).steps.find((s) => s.segIds.includes(e.seg)) ?? null;
}

/** 「进度」的接地材料：该段所属块与阶段的全部事实（步号、段号、计数、claim 原文、产物）。
 *  记忆可以归纳，但不许报出账本里没有的步号/数字/文件名。 */
function progressGround(ctx, e) {
  const m = memberOf(ctx, e.sid);
  if (!m) return '';
  const v = viewOf(ctx, m);
  const s = v.steps.find((x) => x.segIds.includes(e.seg));
  if (!s || s.step == null) return '';
  const out = [`${m.sid8} 步${s.step} 块${s.i} ${s.span ?? ''} 段=${s.segIds.join(' ')} 句=${s.h0 ?? ''}-${s.h1 ?? ''}`];
  for (const id of s.segIds) {
    const n = v.nodes.find((x) => x.id === id);
    if (!n) continue;
    if (n.say) out.push(`你（${id}）：${n.say}`);
    const c = m.claims[id];
    if (c?.basis === 'verified' && c.text) out.push(`我（${id}）：${c.text}`);
    if (n.files?.length) out.push(`产物（${id}）：${n.files.join(' ')}`);
  }
  const ph = v.phases.find((p) => p.from <= s.step && s.step <= p.to);
  if (ph) out.push([`阶段${ph.n} 步${ph.from}-${ph.to}`, ph.short, ph.doing, ph.effect, ph.state, ph.plan, ph.track].filter(Boolean).join(' '));
  return out.join('\n');
}

const movesFor = (ctx, e) => {
  const m = memberOf(ctx, e.sid);
  return m ? movesOf(m.claims[e.seg]) : [];
};

// ── 闸门 G0–G5（写入口） ────────────────────────────────────────────────

/** 一条证据：claim 引文逐字等于该段已证增量；say 引文是该段真人原话的连续片段。
 *  用户作用域（画像/晋升规则）的证据必须带 project：跨项目上下文里会话 id 不能自己
 *  说明「这是哪个项目」，而读时新鲜度也要按项目复核。 */
function checkEvidence(raw, i, ctx, errors, { requireProject = false } = {}) {
  const e = raw ?? {};
  const label = `证据${i + 1}`;
  let projectKey = '';
  if (requireProject) {
    const want = String(e.project ?? '').trim();
    const p = want
      ? ctx.projects.find((x) => x.key === want)
        ?? ctx.projects.find((x) => x.name.toLowerCase() === want.toLowerCase())
      : null;
    if (!p) {
      errors.push(`${label}: 用户表证据要带 project（项目键或名字），收到「${want || '（空）'}」`);
      return null;
    }
    projectKey = p.key;
  }
  const m = memberOf(ctx, e.sid, projectKey);
  if (!m) {
    errors.push(`${label}: 会话「${String(e.sid ?? '').trim() || '（空）'}」${requireProject ? '不在任何项目的账本里' : `不在这个项目的账本里${projectKey ? `（${projectKey}）` : ''}`}`);
    return null;
  }
  const tag = { ...(projectKey ? { project: projectKey } : {}) };
  // 探索类可以用一条仍 pending 的请求当证据：没有引文，只有 rid
  if (e.rid != null && e.rid !== '') {
    const rid = String(e.rid).trim().toUpperCase();
    const row = ctx.requestIndex.get(`${m.id}|${rid}`);
    if (!row) { errors.push(`${label}: ${m.sid8} 没有请求 ${rid}`); return null; }
    if (row.done) { errors.push(`${label}: 请求 ${rid} 已经办结，不能当「未完成探索」的证据`); return null; }
    return { ...tag, rid, sid: m.sid8 };
  }
  const segId = String(e.seg ?? '').trim().toUpperCase();
  const kind = String(e.kind ?? '').trim();
  const quote = normWs(e.quote);
  const hash = String(e.hash ?? '').trim();
  if (!SEG_RE.test(segId)) { errors.push(`${label}: seg 要是段号（S07），收到「${e.seg ?? '（空）'}」`); return null; }
  const seg = m.segById.get(segId);
  if (!seg) { errors.push(`${label}: ${m.sid8} 没有段 ${segId}`); return null; }
  const now = String(seg.contentHash ?? '').slice(0, 12);
  if (hash !== now) {
    errors.push(`${label}: 锚点对不上——${m.sid8}:${segId} 现在是 ${now}，收到的 ${hash || '（空）'} 是旧账（先重建再写）`);
    return null;
  }
  if (kind !== 'claim' && kind !== 'say') { errors.push(`${label}: kind 要是 claim 或 say，收到「${kind || '（空）'}」`); return null; }
  if (!quote) { errors.push(`${label}: quote 为空——记忆的证据必须是一句可回源的话`); return null; }
  if (quote.length > MEMORY_QUOTE_MAX) { errors.push(`${label}: 引文 ${quote.length} 字 > ${MEMORY_QUOTE_MAX}——证据是一句话，不是素材库`); return null; }
  if (kind === 'claim') {
    const c = m.claims[segId];
    if (!c || c.basis !== 'verified') { errors.push(`${label}: ${m.sid8}:${segId} 没有已证增量，claim 类证据引不到`); return null; }
    if (normWs(c.text) !== quote) { errors.push(`${label}: 引文不是逐字原文——该段已证增量是「${c.text}」`); return null; }
  } else {
    const ef = effectiveSource(m.ledger);
    if (!ef.file || !fs.existsSync(ef.file)) {
      errors.push(`${label}: ${m.sid8}:${segId} 读不到正文（源与归档都不在），say 类证据无法核对`);
      return null;
    }
    const speech = speechOf(ctx, m, seg);
    if (!speech) { errors.push(`${label}: ${m.sid8}:${segId} 没有真人原话（工具回执与压缩摘要不算）`); return null; }
    if (!normWs(speech).includes(quote)) {
      errors.push(`${label}: 引文不是这一段里真人的连续原话（工具回执不算）：「${quote.slice(0, 40)}…」`);
      return null;
    }
  }
  return { ...tag, sid: m.sid8, seg: segId, hash, quote, kind };
}

/** G4：每类各有各的证据门槛，不是一句「有证据」就过。 */
function classGate(cls, text, evidence, ctx, errors) {
  if (cls === '进度') {
    if (!evidence.some((e) => e.seg && stepOf(ctx, e)?.step != null)) {
      errors.push('进度: 至少一条证据要落在有主线步号的块里');
      return;
    }
    const ground = evidence.map((e) => progressGround(ctx, e)).filter(Boolean).join('\n');
    const missing = factTokens(text).filter((f) => !containsVerbatim(ground, f));
    if (missing.length) {
      errors.push(`进度: text 里的 ${missing.slice(0, 6).join(' / ')} 在证据所属块与阶段的事实里逐字找不到——不编进度`);
    }
    return;
  }
  const moves = evidence.flatMap((e) => (e.kind === 'claim' ? movesFor(ctx, e) : []));
  if (cls === '经验' && !moves.some((m) => EXPERIENCE_MOVES.includes(m))) {
    errors.push(`经验: 至少一条 claim 证据的 move 要是 ${EXPERIENCE_MOVES.join('/')}`);
  } else if (cls === '规则' && !moves.includes('rule')) {
    errors.push('规则: 至少一条 claim 证据的 move 要是 rule（与 convledger rules 同源）');
  } else if (cls === '探索' && !moves.includes('open') && !evidence.some((e) => e.rid)) {
    errors.push('探索: 要有 move=open 的已证增量，或一条仍 pending 的请求');
  }
}

/** G5 的后半段：同类已有条目说的是同一件事时，必须带 revises 改成修订，不能新增第二条。 */
function duplicateGate(cls, text, existing, errors) {
  const dup = existing
    .filter((e) => e.class === cls)
    .map((e) => ({ id: e.id, share: Math.max(overlapShare(e.text, text), overlapShare(text, e.text)) }))
    .filter((x) => x.share >= REVISION_SHARE);
  if (dup.length) {
    errors.push(`与已有 ${dup.map((x) => `${x.id}（重合 ${Math.round(x.share * 100)}%）`).join('、')} 是同一件事：要带 revises 改成修订，不能新增一条`);
  }
}

function checkDimension(input, errors) {
  const d = String(input?.dimension ?? '').trim();
  if (d && !MEMORY_DIMENSIONS.includes(d)) {
    errors.push(`dimension 要是 ${MEMORY_DIMENSIONS.join(`/`)}，收到「${d}」`);
  }
  return d || null;
}

function checkScenes(input, errors) {
  if (input?.scenes == null) return [];
  if (!Array.isArray(input.scenes)) { errors.push('scenes 要是数组（可为空）'); return []; }
  const out = [...new Set(input.scenes.map((x) => String(x).trim()).filter(Boolean))];
  const bad = out.filter((x) => !MEMORY_SCENES.includes(x));
  if (bad.length) errors.push(`scenes 里有未知场景：${bad.join('/')}；可用：${MEMORY_SCENES.join('/')}`);
  return out;
}

/** 校验一条记忆（G0–G5）。返回的行没有 id——id 由 put 按落盘顺序分配/沿用。
 *  修订的类别门槛按「旧证据 + 新证据」合并后那一条算：追加一条引文不该把原本
 *  过了 G4 的规则改红。 */
export function validateMemoryEntry(input, ctx, { existing = [] } = {}) {
  const errors = [];
  const cls = String(input?.class ?? '').trim();
  const topic = String(input?.topic ?? '').trim();
  const text = normWs(input?.text);
  const evidenceIn = Array.isArray(input?.evidence) ? input.evidence : [];
  const dimension = checkDimension(input, errors);
  const scenes = checkScenes(input, errors);

  // G0 形状
  if (!MEMORY_CLASSES.includes(cls)) {
    errors.push(cls === '画像'
      ? '画像 是用户作用域（跨项目）的类别，项目表不收'
      : `class 要是 ${MEMORY_CLASSES.join('/')}，收到「${cls || '（空）'}」`);
  }
  if (!topic) errors.push('topic 为空：一条记忆得有个可指的名字');
  else if (tok(topic) > MEMORY_TOPIC_MAX) errors.push(`topic ${tok(topic)}t > ${MEMORY_TOPIC_MAX}t：它不是句子，是个把手`);
  if (!text) errors.push('text 为空：蒸馏出来的那一句话才是记忆本体');
  else if (tok(text) > MEMORY_TEXT_MAX) errors.push(`text ${tok(text)}t > ${MEMORY_TEXT_MAX}t：一句话记不完就拆成两条`);
  if (!evidenceIn.length) errors.push('evidence 为空：没有证据的记忆不收');
  if (evidenceIn.length > MEMORY_EVIDENCE_MAX) errors.push(`evidence ${evidenceIn.length} 条 > ${MEMORY_EVIDENCE_MAX}`);

  // G5 前半段先解析 revises：类别门槛要用合并后的证据
  const want = input?.revises == null || input.revises === '' ? null : String(input.revises).trim().toUpperCase();
  let target = null;
  if (want) {
    target = existing.find((e) => String(e.id).toUpperCase() === want) ?? null;
    if (!target) errors.push(`revises: 没有条目 ${want}`);
    else if (target.class !== cls) { errors.push(`revises: ${want} 是「${target.class}」，不能改写成「${cls}」`); target = null; }
  }

  // G1/G2 锚点与逐字引文
  const evidence = [];
  evidenceIn.forEach((e, i) => {
    const r = checkEvidence(e, i, ctx, errors);
    if (r) evidence.push(r);
  });
  const usable = evidence.length === evidenceIn.length;

  // G3 反截段：蒸馏必须是新句子，不许把真人原话剪一段当记忆
  const nv = norm(text);
  if (usable && nv.length >= SUMMARY_MIN_QUOTE_OVERLAP) {
    const cut = evidence.find((e) => e.kind === 'say' && norm(e.quote).includes(nv));
    if (cut) errors.push(`text 是 kind=say 引文的连续截段（「${cut.quote.slice(0, 40)}…」）：蒸馏必须是新句子`);
  }

  // G4 类别证据（修订算合并后的证据）
  if (usable && MEMORY_CLASSES.includes(cls)) {
    classGate(cls, text, target ? mergeEvidence(target.evidence, evidence) : evidence, ctx, errors);
  }

  // G5 后半段：不带 revises 却与同类条目重合，就是重复
  if (!errors.length && !want) duplicateGate(cls, text, existing, errors);

  return {
    ok: !errors.length,
    errors,
    row: { class: cls, topic, text, dimension, scenes, evidence, revises: target ? target.id : null },
  };
}

// ── 写入口（G6 全有或全无） ─────────────────────────────────────────────

const nextId = (entries) => {
  const used = new Set(entries.map((e) => e.id));
  let n = 1;
  while (used.has(`M${String(n).padStart(2, '0')}`)) n++;
  return `M${String(n).padStart(2, '0')}`;
};

const evidenceKey = (e) => [e.project ?? '', e.sid, e.seg ?? '', e.kind ?? '', e.quote ?? '', e.rid ?? ''].join('|');
function mergeEvidence(old = [], add = []) {
  const seen = new Set(old.map(evidenceKey));
  const out = old.slice();
  for (const e of add) {
    const k = evidenceKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

/** 先按当前源重建这个项目的全部账本，再算哈希（与 summarise/phases --put 同一顺序）。
 *  源已不在的成员跳过——它只能按归档账本校验，明说在回执里。 */
export function rebuildProject(root, project) {
  const rebuilt = [];
  const skipped = [];
  for (const m of project.members) {
    const ledger = readJson(path.join(m.dir, 'ledger.json'));
    const src = String(ledger?.sourceFile ?? '');
    if (!src || !fs.existsSync(src)) { skipped.push(m.id); continue; }
    writeStore(root, build(src, { storeRoot: root }));
    rebuilt.push(m.id);
  }
  return { rebuilt, skipped };
}

/**
 * 落一批项目记忆。任一错误 → 一条都不写（G6），且回执逐条给理由。
 * 修订沿用被打回那条的 id，只追加新证据、替换 text；新增按落盘顺序取 M01…
 */
export function putProjectMemories(root, project, entries, { rebuild = true, now = new Date().toISOString(), operationId = null } = {}) {
  if (!Array.isArray(entries) || !entries.length) return { ok: false, errors: ['记忆是空的：要一个条目数组'], written: 0 };
  const built = rebuild ? rebuildProject(root, project) : { rebuilt: [], skipped: [] };
  const ctx = memoryContext(root, project);
  const table = readProjectMemories(root, project.key);

  // 同一次发布重放：认出 operationId 直接回原结果，不再校验也不再写一遍
  const requestSha = operationId ? sha256(JSON.stringify(entries)) : null;
  if (operationId) {
    const prevOp = (table.appliedOperations ?? []).find((o) => o.operationId === operationId);
    if (prevOp) {
      if (prevOp.requestSha !== requestSha) {
        return { ok: false, replayed: false, errors: [`operationId ${operationId} 已用于另一批内容——不能改写已发布的结果`], built, written: 0 };
      }
      return { ok: true, replayed: true, errors: [], entries: table.entries, added: prevOp.added ?? [], revised: prevOp.revised ?? [], built, dir: projectMemoryDir(root, project.key) };
    }
  }
  const working = table.entries.map((e) => JSON.parse(JSON.stringify(e)));
  const added = [];
  const revised = [];
  const errors = [];

  entries.forEach((input, idx) => {
    const r = validateMemoryEntry(input, ctx, { existing: working });
    if (!r.ok) {
      const who = input?.topic ? `（${input.topic}）` : '';
      errors.push(...r.errors.map((x) => `第 ${idx + 1} 条${who}: ${x}`));
      return;
    }
    if (r.row.revises) {
      const t = working.find((e) => e.id === r.row.revises);
      t.text = r.row.text;
      t.evidence = mergeEvidence(t.evidence, r.row.evidence);
      if (r.row.dimension) t.dimension = r.row.dimension;
      if (r.row.scenes?.length) t.scenes = r.row.scenes;
      t.at = now;
      t.basis = 'model';
      revised.push(t.id);
      return;
    }
    const row = {
      id: nextId(working), class: r.row.class, topic: r.row.topic, text: r.row.text, dimension: r.row.dimension,
      scenes: r.row.scenes, evidence: r.row.evidence, revises: null, promoted_to: null, basis: 'model', at: now,
    };
    working.push(row);
    added.push(row.id);
  });

  if (errors.length) return { ok: false, errors, built, written: 0 };
  writeProjectIdentity(root, project);
  const applied = operationId
    ? [...(table.appliedOperations ?? []), { operationId, requestSha, added, revised, at: now }].slice(-200)
    : (table.appliedOperations ?? []);
  const history = [
    ...(table.history ?? []),
    ...added.map((id) => ({ id, action: 'published', at: now, operationId })),
    ...revised.map((id) => ({ id, action: 'revised', at: now, operationId })),
  ].slice(-500);
  writeProjectMemories(root, project.key, working, {
    revision: (table.revision ?? 0) + 1, appliedOperations: applied, history,
  });
  return { ok: true, replayed: false, errors: [], entries: working, added, revised, built, dir: projectMemoryDir(root, project.key) };
}

/**
 * 把一个批次里的候选发布进记忆表：复用 G0–G5/G9 的原判据，不在这里生成一个字。
 * operationId 约定为 `pub-<batchId>`：同批重放认得出，已发布结果不会被改写。
 */
export function publishCandidates(root, project, candidates, { operationId, now } = {}) {
  const entries = (candidates ?? []).map((c) => ({
    class: c.class, topic: c.topic, text: c.text, evidence: c.evidence, revises: c.revises ?? null,
  }));
  return putProjectMemories(root, project, entries, { operationId, now });
}

// ── 用户表写入口（G8/G9）：画像与晋升副本 ──────────────────────────────

/** 校验一条用户表记忆。--put --scope user 只收 画像；规则只能经 --promote（G8）。
 *  画像的证据门槛（G4 画像行）：≥2 个不同会话，每个至少 1 条 say——一次会话里的
 *  偏好是印象，不是画像。 */
export function validateUserEntry(input, ctx, { existing = [] } = {}) {
  const errors = [];
  const cls = String(input?.class ?? '').trim();
  const topic = String(input?.topic ?? '').trim();
  const text = normWs(input?.text);
  const evidenceIn = Array.isArray(input?.evidence) ? input.evidence : [];
  const dimension = checkDimension(input, errors);
  const scenes = checkScenes(input, errors);

  // G9 作用域
  if (cls !== '画像') {
    if (cls === '规则') errors.push('规则 不能直接写用户表：只能经 memory --promote 从 ≥2 个项目的等价条目合成（G8）');
    else if (MEMORY_CLASSES.includes(cls)) errors.push(`${cls} 是项目作用域（G9）：用户表只收 画像，晋升来的 规则 走 --promote`);
    else errors.push(`class 要是 画像，收到「${cls || '（空）'}」`);
  }
  if (!topic) errors.push('topic 为空：一条记忆得有个可指的名字');
  else if (tok(topic) > MEMORY_TOPIC_MAX) errors.push(`topic ${tok(topic)}t > ${MEMORY_TOPIC_MAX}t：它不是句子，是个把手`);
  if (!text) errors.push('text 为空：蒸馏出来的那一句话才是记忆本体');
  else if (tok(text) > MEMORY_TEXT_MAX) errors.push(`text ${tok(text)}t > ${MEMORY_TEXT_MAX}t：一句话记不完就拆成两条`);
  if (!evidenceIn.length) errors.push('evidence 为空：没有证据的记忆不收');
  if (evidenceIn.length > MEMORY_EVIDENCE_MAX) errors.push(`evidence ${evidenceIn.length} 条 > ${MEMORY_EVIDENCE_MAX}`);
  if (!ctx.members.length) errors.push('store 里没有已建账会话：用户表证据无处可回源');

  // G5 前半段：修订沿用旧 id，类别门槛用合并后的证据
  const want = input?.revises == null || input.revises === '' ? null : String(input.revises).trim().toUpperCase();
  let target = null;
  if (want) {
    target = existing.find((e) => String(e.id).toUpperCase() === want) ?? null;
    if (!target) errors.push(`revises: 没有条目 ${want}`);
    else if (target.class !== cls) { errors.push(`revises: ${want} 是「${target.class}」，不能改写成「${cls}」`); target = null; }
  }

  // G1/G2：锚点与逐字引文；每条必须带 project
  const evidence = [];
  evidenceIn.forEach((e, i) => {
    const r = checkEvidence(e, i, ctx, errors, { requireProject: true });
    if (r) evidence.push(r);
  });
  const usable = evidence.length === evidenceIn.length;

  // G3 反截段：蒸馏必须是新句子
  const nv = norm(text);
  if (usable && nv.length >= SUMMARY_MIN_QUOTE_OVERLAP) {
    const cut = evidence.find((e) => e.kind === 'say' && norm(e.quote).includes(nv));
    if (cut) errors.push(`text 是 kind=say 引文的连续截段（「${cut.quote.slice(0, 40)}…」）：蒸馏必须是新句子`);
  }

  // G4 画像：≥2 个不同会话，每个至少 1 条 say（工具回执已在 checkEvidence 挡掉）
  if (usable && cls === '画像') {
    const saySid = new Set(evidence.filter((e) => e.kind === 'say').map((e) => e.sid));
    if (saySid.size < 2) {
      errors.push(`画像: 证据要跨 ≥2 个不同会话（现在 ${saySid.size} 个：${[...saySid].join(' ') || '无 say'}）——一次会话里的偏好是印象，不是画像`);
    }
  }

  // G5 后半段：不带 revises 却与同类条目重合，就是重复
  if (!errors.length && !want) duplicateGate(cls, text, existing, errors);

  return {
    ok: !errors.length,
    errors,
    row: { class: cls, topic, text, dimension, scenes, evidence, revises: target ? target.id : null },
  };
}

/** 从用户表删一条（合并重复画像时用）：只动用户表，按 id 精确匹配；项目表没有删入口。 */
export function forgetUserEntry(root, id) {
  const want = String(id ?? '').trim().toUpperCase();
  if (!want) return { ok: false, errors: ['memory --forget 要一个条目 id（如 U20）'] };
  const table = readUserMemories(root);
  const idx = table.entries.findIndex((e) => String(e.id).toUpperCase() === want);
  if (idx < 0) return { ok: false, errors: [`用户表里没有 ${want}`] };
  const [row] = table.entries.splice(idx, 1);
  writeUserMemories(root, table.entries);
  return { ok: true, removed: row, entries: table.entries };
}

const nextUserId = (entries) => {
  const used = new Set(entries.map((e) => e.id));
  let n = 1;
  while (used.has(`U${String(n).padStart(2, '0')}`)) n++;
  return `U${String(n).padStart(2, '0')}`;
};

/** 先按证据里出现的会话找出所属项目，只重建这些项目——用户表跨项目，不能只重建一个。
 *  同一把尺：源在就读源，源没了跳过并在回执里说。 */
function rebuildForUserEntries(root, entries) {
  const prefixes = new Set(entries
    .flatMap((e) => (Array.isArray(e?.evidence) ? e.evidence : []))
    .map((e) => String(e?.sid ?? '').trim())
    .filter(Boolean));
  const built = { rebuilt: [], skipped: [] };
  if (!prefixes.size) return built;
  for (const project of projectsOf(root, { withSteps: false }).projects) {
    const hit = project.members.some((m) => [...prefixes].some((s) => m.id === s || m.id.startsWith(s)));
    if (!hit) continue;
    const r = rebuildProject(root, project);
    built.rebuilt.push(...r.rebuilt);
    built.skipped.push(...r.skipped);
  }
  return built;
}

/** 落一批用户记忆（画像）。任一错误 → 一条都不写（G6）。 */
export function putUserMemories(root, entries, { rebuild = true, now = new Date().toISOString() } = {}) {
  if (!Array.isArray(entries) || !entries.length) return { ok: false, errors: ['记忆是空的：要一个条目数组'], written: 0 };
  const built = rebuild ? rebuildForUserEntries(root, entries) : { rebuilt: [], skipped: [] };
  const ctx = userContext(root);
  const table = readUserMemories(root);
  const working = table.entries.map((e) => JSON.parse(JSON.stringify(e)));
  const added = [];
  const revised = [];
  const errors = [];

  entries.forEach((input, idx) => {
    const r = validateUserEntry(input, ctx, { existing: working });
    if (!r.ok) {
      const who = input?.topic ? `（${input.topic}）` : '';
      errors.push(...r.errors.map((x) => `第 ${idx + 1} 条${who}: ${x}`));
      return;
    }
    if (r.row.revises) {
      const t = working.find((e) => e.id === r.row.revises);
      t.text = r.row.text;
      t.evidence = mergeEvidence(t.evidence, r.row.evidence);
      if (r.row.dimension) t.dimension = r.row.dimension;
      if (r.row.scenes?.length) t.scenes = r.row.scenes;
      t.at = now;
      t.basis = 'model';
      revised.push(t.id);
      return;
    }
    const row = {
      id: nextUserId(working), class: r.row.class, topic: r.row.topic, text: r.row.text, dimension: r.row.dimension,
      scenes: r.row.scenes, evidence: r.row.evidence, revises: null, promoted_from: null, basis: 'model', at: now,
    };
    working.push(row);
    added.push(row.id);
  });

  if (errors.length) return { ok: false, errors, built, written: 0 };
  writeUserMemories(root, working);
  return { ok: true, errors: [], entries: working, added, revised, built, dir: userMemoryDir(root) };
}

const sameText = (a, b) => Math.max(overlapShare(a, b), overlapShare(b, a));

/** G8：把一个项目里的规则晋升到用户表。等价＝其他项目里也各有一条规则、文本重合
 *  ≥ REVISION_SHARE。所有来源证据合并成副本，各来源条目回填 promoted_to=global。
 *  失败不写任何文件。 */
export function promoteEntry(root, project, entryId, { now = new Date().toISOString() } = {}) {
  const id = String(entryId ?? '').trim().toUpperCase();
  if (!id) return { ok: false, errors: ['--promote 要一个项目条目号（M03）'] };
  const built = rebuildProject(root, project);
  const pctx = memoryContext(root, project);
  const ptable = readProjectMemories(root, project.key);
  const entry = ptable.entries.find((e) => String(e.id).toUpperCase() === id);
  if (!entry) return { ok: false, errors: [`${project.name} 没有条目 ${id}`], built };
  if (entry.class !== '规则') return { ok: false, errors: [`${id} 是「${entry.class}」：G8 只许把 规则 晋升为用户层`], built };
  const why = freshnessOf(pctx, entry);
  if (why.length) return { ok: false, errors: [`${id} 已失效（${why.join('；')}）：先修订或重建，再晋升`], built };

  const sources = [{ project: project.key, name: project.name, id: entry.id }];
  const evidence = (entry.evidence ?? []).map((e) => ({ ...e, project: project.key }));
  for (const other of projectsOf(root, { withSteps: false }).projects) {
    if (other.key === project.key) continue;
    const octx = memoryContext(root, other);
    const { live } = applyFreshness(octx, readProjectMemories(root, other.key).entries);
    const same = live
      .filter((e) => e.class === '规则' && sameText(e.text, entry.text) >= REVISION_SHARE)
      .sort((a, b) => b.text.length - a.text.length);
    if (!same.length) continue;
    const best = same[0];
    sources.push({ project: other.key, name: other.name, id: best.id });
    for (const e of best.evidence ?? []) evidence.push({ ...e, project: other.key });
  }
  if (sources.length < 2) {
    return {
      ok: false,
      errors: [`${id} 只在 ${sources.length} 个项目出现（${project.name}）：不算通用；G8 要 ≥2 个不同项目各有一条等价规则（文本重合 ≥ ${Math.round(REVISION_SHARE * 100)}%）`],
      built,
    };
  }

  const utable = readUserMemories(root);
  const working = utable.entries.map((e) => JSON.parse(JSON.stringify(e)));
  let targetU = working.find((u) => u.class === '规则'
    && (u.sources ?? []).some((s) => s.project === project.key && s.id === entry.id))
    ?? working.find((u) => u.class === '规则' && sameText(u.text, entry.text) >= REVISION_SHARE)
    ?? null;
  const action = targetU ? 'refreshed' : 'added';
  if (!targetU) {
    targetU = {
      id: nextUserId(working), class: '规则', topic: entry.topic, text: entry.text,
      dimension: entry.dimension ?? null, scenes: entry.scenes ?? [],
      evidence: mergeEvidence([], evidence), revises: null,
      promoted_from: { project: project.key, id: entry.id }, sources: sources.slice(),
      basis: 'model', at: now,
    };
    working.push(targetU);
  } else {
    targetU.text = entry.text;
    targetU.topic = entry.topic;
    if (entry.dimension) targetU.dimension = entry.dimension;
    if (entry.scenes?.length) {
      targetU.scenes = [...new Set([...(targetU.scenes ?? []), ...entry.scenes])]
        .filter((x) => MEMORY_SCENES.includes(x));
    }
    targetU.evidence = mergeEvidence(targetU.evidence, evidence);
    targetU.sources = [...(targetU.sources ?? []), ...sources]
      .filter((s, i, all) => all.findIndex((x) => x.project === s.project && x.id === s.id) === i);
    targetU.at = now;
    targetU.basis = 'model';
  }

  // 先写用户表，再回填各来源项目：回填的每个 M 都只改 promoted_to，其它字段不动
  writeUserMemories(root, working);
  const touched = new Set();
  for (const s of sources) {
    if (touched.has(s.project)) continue;
    touched.add(s.project);
    const table = readProjectMemories(root, s.project);
    const rows = table.entries.map((e) => (e.id === s.id ? { ...e, promoted_to: 'global' } : e));
    writeProjectMemories(root, s.project, rows);
  }
  return { ok: true, errors: [], uid: targetU.id, action, sources, evidence: targetU.evidence.length, built };
}

/** 撤销一次晋升：删用户表副本，来源条目 promoted_to 回 null。
 *  只认 规则 副本——画像不是晋升来的，删它不该混进这个命令。 */
export function unpromoteEntry(root, uid, { now = new Date().toISOString() } = {}) {
  const id = String(uid ?? '').trim().toUpperCase();
  if (!id) return { ok: false, errors: ['--unpromote 要一个用户表条目号（U01）'] };
  const utable = readUserMemories(root);
  const u = utable.entries.find((e) => String(e.id).toUpperCase() === id);
  if (!u) return { ok: false, errors: [`用户表里没有 ${id}`] };
  if (u.class !== '规则') return { ok: false, errors: [`${u.id} 是「${u.class}」：只有晋升来的 规则 副本能撤销；画像用 --put 修订`] };
  const remain = utable.entries.filter((e) => e !== u).map((e) => JSON.parse(JSON.stringify(e)));
  const cleared = [];
  for (const project of projectsOf(root, { withSteps: false }).projects) {
    const table = readProjectMemories(root, project.key);
    let changed = false;
    const rows = table.entries.map((e) => {
      if (e.promoted_to !== 'global') return e;
      const bySource = (u.sources ?? []).some((s) => s.project === project.key && s.id === e.id);
      const byText = e.class === u.class && sameText(e.text, u.text) >= REVISION_SHARE;
      if (!bySource && !byText) return e;
      changed = true;
      cleared.push({ project: project.key, name: project.name, id: e.id });
      return { ...e, promoted_to: null };
    });
    if (changed) writeProjectMemories(root, project.key, rows);
  }
  writeUserMemories(root, remain);
  return { ok: true, errors: [], uid: u.id, cleared, at: now };
}

// ── 读取（G7 读时新鲜度） ──────────────────────────────────────────────

/** 账本一变，旧记忆不能再挂在新内容上：段没了、锚点变了、claim 不再 verified，
 *  都判失效。默认输出剔除并计数，--all 才把失效条目连同原因显示出来。 */
export function freshnessOf(ctx, entry) {
  const why = [];
  for (const e of entry.evidence ?? []) {
    if (e.rid) continue;
    const m = memberOf(ctx, e.sid, e.project ?? '');
    if (!m) { why.push(`会话 ${e.sid} 不在${e.project ? `项目 ${e.project} ` : '这个项目'}的账本里了`); continue; }
    const seg = m.segById.get(String(e.seg ?? '').toUpperCase());
    if (!seg) { why.push(`${m.sid8}:${e.seg} 这一段不存在了`); continue; }
    if (String(e.hash) !== String(seg.contentHash ?? '').slice(0, 12)) { why.push(`${m.sid8}:${seg.id} 锚点变了`); continue; }
    if (e.kind === 'claim') {
      const c = m.claims[seg.id];
      if (!c || c.basis !== 'verified') why.push(`${m.sid8}:${seg.id} 的已证增量不在了`);
      else if (normWs(c.text) !== normWs(e.quote)) why.push(`${m.sid8}:${seg.id} 的增量文本改了`);
    }
  }
  return why;
}

export function applyFreshness(ctx, entries) {
  const live = [];
  const stale = [];
  for (const e of entries) {
    const why = freshnessOf(ctx, e);
    if (why.length) stale.push({ ...e, stale: why });
    else live.push(e);
  }
  return { live, stale };
}

// ── 读取渲染（PRD-memory §七） ──────────────────────────────────────────

const dayOf = (iso) => (iso ? String(iso).slice(0, 10) : '—');
const evidenceLabel = (e) => `${e.sid}:${e.rid ?? e.seg}`;
const pendingOf = (ctx) => [...ctx.requestIndex.values()].filter((r) => !r.done).length;

/** 第 2 段「现在到哪」：全部从账本复算，一条记忆都没有时也照样能答。 */
function nowOf(ctx) {
  const m = ctx.members[0];
  if (!m) return null;
  try {
    const v = readView(m.dir);
    const last = [...v.steps].reverse().find((s) => s.step != null) ?? null;
    const covered = v.phases.length ? v.phases[v.phases.length - 1].to : 0;
    return {
      sid8: m.sid8,
      segments: (m.ledger.segments ?? []).length,
      blocks: v.steps.length,
      mainSteps: v.mainSteps,
      step: last?.step ?? null,
      block: last?.i ?? null,
      title: last?.sum?.title ?? last?.gist ?? last?.mark ?? '',
      phaseWritten: v.phases.length,
      phaseTo: covered,
      tail: covered > 0 && covered < v.mainSteps ? `尾段 ${covered + 1}–${v.mainSteps} 未写` : '',
    };
  } catch { return null; }
}

function moveCounts(ctx) {
  let verified = 0;
  let open = 0;
  let rule = 0;
  for (const m of ctx.members) {
    for (const c of Object.values(m.claims)) {
      if (c?.basis !== 'verified') continue;
      verified++;
      const mv = movesOf(c);
      if (mv.includes('open')) open++;
      if (mv.includes('rule')) rule++;
    }
  }
  return { verified, open, rule, pending: pendingOf(ctx) };
}

const entryLine = (e) => {
  const ev = [...new Set((e.evidence ?? []).map(evidenceLabel))].join(', ');
  return `- [${e.id}] ${e.text}（写于 ${dayOf(e.at)}；证据 ${ev || '—'}）`;
};
const staleLine = (e) => `- [失效] [${e.id}] ${e.text} —— ${e.stale.join('；')}`;
const userName = (ctx, key) => ctx.projects.find((p) => p.key === key)?.name ?? key ?? '?';
/** 用户表条目：证据天生跨项目，每条都写全 `<项目>:<sid>:Sxx>`（PRD §七 第 5 段）。 */
const userEvidenceLabel = (ctx, e) => {
  if (e.rid) return `${userName(ctx, e.project)}:${e.sid}:${e.rid}`;
  return `${userName(ctx, e.project)}:${e.sid}:${e.seg}`;
};
const userEntryLine = (ctx, e) => {
  const ev = [...new Set((e.evidence ?? []).map((x) => userEvidenceLabel(ctx, x)))].join(' · ');
  return `- [${e.id}] ${e.text}（写于 ${dayOf(e.at)}；来源 ${ev || '—'}）`;
};

/** 一条记忆都没写时，`memory` 仍要如实回答「这个项目到哪了」——第二段全部工具复算。 */
export function memoryRead(root, project, { all = false, withUser = true, maxPerClass = 0 } = {}) {
  const ctx = memoryContext(root, project);
  const table = readProjectMemories(root, project.key);
  const { live, stale } = applyFreshness(ctx, table.entries);
  const uctx = userContext(root);
  const utable = readUserMemories(root);
  const ufresh = applyFreshness(uctx, utable.entries);
  const uRules = ufresh.live.filter((e) => e.class === '规则');
  const uImages = ufresh.live.filter((e) => e.class === '画像');
  const counts = moveCounts(ctx);
  const now = nowOf(ctx);
  const L = [`# 项目 ${project.name} · ${project.key} · ${project.counts.sessions} 个会话 · ${dayOf(project.firstAt)} → ${dayOf(project.lastAt)}`];
  L.push('## 现在到哪（工具复算）');
  if (!now) {
    L.push('- 最新会话的账本视图读不了：先 convledger index 重建');
  } else {
    const last = now.step != null ? `第${now.step}步 块${now.block}${now.title ? `《${now.title}》` : ''}` : '（没有主线步）';
    L.push(`- 最新会话 ${now.sid8} · ${num(now.segments)} 段 / ${now.blocks} 块 / ${now.mainSteps} 步 · 最后 ${last}`);
    L.push(`- ${now.phaseWritten ? `阶段 ${now.phaseWritten} 段覆盖第 1–${now.phaseTo} 步${now.tail ? `（${now.tail}）` : ''}` : `还没有阶段说明（第 1–${now.mainSteps} 步只有块层）`}`);
    L.push(`- 待办请求 ${counts.pending} · 已证 ${counts.verified} · open ${counts.open} · rule ${counts.rule}`);
  }
  const renderClass = (title, cls, max = 0, extra = []) => {
    L.push(`## ${title}`);
    let list = live.filter((e) => e.class === cls);
    const total = list.length + extra.length;
    const cap = max || maxPerClass;
    if (cap) list = list.slice(-cap).reverse();
    const st = stale.filter((e) => e.class === cls);
    if (!list.length && !extra.length) {
      L.push(`- 本类 0 条（素材里 0 个来源）——不编${st.length ? `；另有 ${st.length} 条已失效` : ''}`);
      if (!all) return;
    }
    for (const e of list) L.push(entryLine(e));
    for (const e of extra) L.push(userEntryLine(uctx, e));
    if (cap && total > cap) L.push(`- （共 ${total} 条，这里列最近 ${cap} 条；memory --all 看全部）`);
    if (all) for (const e of st) L.push(staleLine(e));
    else if (st.length) L.push(`- （另有 ${st.length} 条已失效：账本变了；--all 看原因）`);
  };
  renderClass('方案进度', '进度', 5);
  renderClass('踩坑经验', '经验');
  renderClass('通用规则', '规则', 0, uRules);
  renderClass('未完成探索', '探索');
  if (withUser) {
    L.push('## 用户画像 / 工作方式');
    const uStale = ufresh.stale.filter((e) => e.class === '画像');
    if (!uImages.length) {
      L.push(`- 本类 0 条（用户表里 ${uImages.length} 条）——不编${uStale.length ? `；另有 ${uStale.length} 条已失效` : ''}`);
    } else {
      for (const e of uImages) L.push(userEntryLine(uctx, e));
    }
    if (all) for (const e of uStale) L.push(staleLine(e));
    else if (uStale.length) L.push(`- （另有 ${uStale.length} 条已失效：账本变了；--all 看原因）`);
    L.push('查法：memory --digest · body Sxx --session <sid8> · projects');
  } else {
    // 导出到项目里的 PROGRESS 文件不带画像：画像是跨项目的，单独一份。
    L.push('用户画像（跨项目）见同目录 USER-PROFILE.md。');
  }
  const entries = Object.fromEntries(MEMORY_CLASSES.map((c) => [c, live.filter((e) => e.class === c)]));
  return {
    ctx, table, live, stale, counts, now, entries,
    user: { table: utable, live: ufresh.live, stale: ufresh.stale },
    text: L.join('\n') + '\n',
  };
}

/** 用户画像那一份（跨项目）：写进项目根的 USER-PROFILE.md，别的 agent 接手先读它。
 *  只读用户表；画像 0 条就如实写 0 条，不拿项目记忆冒充画像。 */
export function userPortraitText(root) {
  const ctx = userContext(root);
  const table = readUserMemories(root);
  const f = applyFreshness(ctx, table.entries);
  const images = f.live.filter((e) => e.class === '画像');
  const rules = f.live.filter((e) => e.class === '规则');
  const L = [];
  L.push(`## 画像（${images.length} 条）`);
  if (!images.length) L.push('- 本类 0 条（用户表里 0 条）——不编；画像要走 memory --put --scope user，证据跨 ≥2 个会话');
  else for (const e of images) L.push(userEntryLine(ctx, e));
  L.push(`## 晋升来的通用规则（${rules.length} 条）`);
  if (!rules.length) L.push('- 本类 0 条——规则先写在项目表里，两个项目各有一条等价文本再 memory --promote');
  else for (const e of rules) L.push(userEntryLine(ctx, e));
  return { text: L.join('\n') + '\n', counts: { images: images.length, rules: rules.length, stale: f.stale.length } };
}

/** 块原话只取真人说的：视图的 opener 在工具起头的段里会是 `Bash …`/`Read …`，
 *  与 say 证据同一把筛子（TOOLISH/NOSAY），素材里不许出现工具回执。 */
const sayOfSeg = (v, id) => {
  const s = v.nodes.find((n) => n.id === id)?.say ?? '';
  return s && !TOOLISH.test(s) && !NOSAY.test(s) ? s : '';
};

/** label 只在用户作用域给：`<项目>:<sid8>`。给了就把每行的段号写成 `<项目>:<sid8>:Sxx`，
 *  项目作用域保持原样（会话本身已由项目头限定）。 */
function sessionDigest(m, label = '') {
  const ref = label || m.sid8;
  let v;
  try { v = readView(m.dir); } catch { v = null; }
  const segs = (m.ledger.segments ?? []).length;
  if (!v) return { sid8: m.sid8, text: `## 会话 ${ref} · ${dayOf(m.ledger.builtAt)} · ${segs} 段 · （账本视图读不了：先 convledger index 重建）` };
  const L = [];
  const last = [...v.steps].reverse().find((s) => s.step != null) ?? null;
  const title = last?.sum?.title ?? last?.gist ?? last?.mark ?? '';
  const covered = v.phases.length ? v.phases[v.phases.length - 1].to : 0;
  L.push(`## 会话 ${ref} · ${dayOf(m.ledger.builtAt)} · ${segs} 段 / ${v.steps.length} 块 / ${v.mainSteps} 步 · 最后 ${last?.step != null ? `第${last.step}步 块${last.i}${title ? `《${title}》` : ''}` : '（没有主线步）'} · ${covered ? `阶段 ${v.phases.length} 段覆盖到第 ${covered} 步` : '尚无阶段说明'}`);
  if (v.phases.length) {
    L.push('### 阶段');
    for (const p of v.phases.slice(0, 12)) L.push(`阶段${p.n} 第${p.from}–${p.to}步 · ${p.short} · ${p.doing}`);
    if (v.phases.length > 12) L.push(`（另 ${v.phases.length - 12} 段省略，用 brief --phase 查）`);
  }
  if (v.steps.length) {
    L.push('### 块原话（视图层截断 ≤160 字；引用超出要对 body 回源）');
    const head = v.steps.length > 60 ? v.steps.slice(0, 30) : v.steps;
    const tail = v.steps.length > 60 ? v.steps.slice(-30) : [];
    const emit = (s) => {
      const say = s.segIds.map((id) => sayOfSeg(v, id)).find(Boolean) ?? '';
      const where = label ? `${label}:${s.segIds[0]}` : (s.span ?? s.segIds[0]);
      if (say) L.push(`块${s.i} 步${s.step ?? '插'} ${where} · ${say}`);
    };
    for (const s of head) emit(s);
    if (tail.length) {
      L.push(`（中间 ${v.steps.length - 60} 块省略，用 steps 查）`);
      for (const s of tail) emit(s);
    }
  }
  const claims = Object.entries(m.claims).filter(([, c]) => c?.basis === 'verified');
  if (claims.length) {
    L.push('### 已证增量');
    for (const [seg, c] of claims.slice(0, 40)) {
      L.push(`${label || m.sid8}:${seg} ${movesOf(c).join('/') || '—'}${c.topic ? ` ${c.topic}` : ''} — ${c.text}`);
    }
    if (claims.length > 40) L.push(`（另有 ${claims.length - 40} 条省略，用 rules / prove 查）`);
  }
  const reqs = readRequests(m.dir).rows.filter((r) => !r.done);
  if (reqs.length) {
    L.push('### 待办请求');
    for (const r of reqs) L.push(`${r.id} ${String(r.text ?? '').slice(0, 60)}`);
  }
  return { sid8: m.sid8, text: L.join('\n') };
}

/**
 * `memory --digest`：一次性命令，但也不能无限。超预算从最旧的会话整段丢，
 * 并在头上写明丢了哪些——不静默截断、不截半行。
 */
export function digestMaterials(root, project, { all = false, max = MEMORY_DIGEST_TOKENS } = {}) {
  const ctx = memoryContext(root, project);
  const want = all ? ctx.members : ctx.members.slice(0, 8);
  const omitted = ctx.members.length - want.length;
  const head = [
    `# 记忆素材 · 项目 ${project.name} · ${project.key} · ${project.counts.sessions} 个会话 · ${dayOf(project.firstAt)} → ${dayOf(project.lastAt)}`,
    all ? '（--all：全部会话）' : `（默认最近 8 个会话${omitted > 0 ? `；略过 ${omitted} 个较旧的，用 --all 取全量` : ''}）`,
    `（预算 ${max} tok；素材只来自派生层，不读正文——引文超出 160 字时用 body Sxx --session <sid8> 回源取）`,
  ];
  let used = tok(head.join('\n'));
  const kept = [];
  const dropped = [];
  let overflow = false;
  for (const m of want) {
    if (overflow) { dropped.push(m.sid8); continue; }
    const d = sessionDigest(m);
    const t = tok(d.text);
    if (used + t > max) { overflow = true; dropped.push(m.sid8); continue; }
    used += t;
    kept.push(d);
  }
  if (dropped.length) head.push(`（预算不够：已整段丢掉最旧 ${dropped.length} 个会话 ${dropped.join(' ')}——要全量用 --max N 或 --all）`);
  const tail = [
    '## 类别口径（G4：一条不过整批不写）',
    '进度: ≥1 条证据落在有主线步号的块；text 里的数字/文件名必须在证据所属块与阶段的事实里逐字出现',
    '经验: ≥1 条 claim，move ∈ ruleout/decision/insight',
    '规则: ≥1 条 claim，move = rule',
    '维度: 每条尽量带 dimension（目标/边界/规则/偏好/背景/验收/分工/反馈/性格）；class 说是什么，dimension 说回答用户哪一类约束',
    `场景: 可选 scenes（${MEMORY_SCENES.join('/')}）；按适用的工作场景多选，不适用留空`,
    '探索: ≥1 条 claim，move = open，或一条仍 pending 的请求',
    '## 输出形状（memory --put -）',
    '{"entries":[{"class":"规则","topic":"把手","text":"一句话","dimension":"边界","scenes":["ui","design"],"evidence":[{"sid":"<sid8>","seg":"S35","hash":"<contentHash 前12位>","kind":"claim|say","quote":"逐字"}],"revises":null}]}',
    '证据也可以是一条仍 pending 的请求：{"sid":"<sid8>","rid":"R03"}（不存引文）。',
    'hash 取 ledger.json 的 segments[].contentHash 前 12 位。写入口会先重建再核锚点。',
    '素材里没有的，写不出来。',
  ];
  return {
    text: [...head, ...kept.map((d) => d.text), ...tail].join('\n') + '\n',
    sessions: kept.length,
    dropped,
    tokens: used + tok(tail.join('\n')),
    omitted,
  };
}

/**
 * `memory --digest --class 画像`：跨全部项目取最近 8 个会话，每行带 `<项目>:<sid8>:Sxx`。
 * 画像不能只在一个项目里取材——「反复出现」要在不同项目之间也看得见。
 * 与项目素材同一套预算纪律：超了整段丢最旧，并写明丢了谁。
 */
export function digestUserMaterials(root, { max = MEMORY_DIGEST_TOKENS } = {}) {
  const projects = projectsOf(root, { withSteps: false }).projects;
  const ctx = buildContext(root, projects);
  const rows = ctx.members.map((m) => {
    const p = ctx.projectOf.get(m.id);
    const row = p.members.find((x) => x.id === m.id);
    return { m, p, lastAt: row?.lastAt ?? m.ledger.builtAt ?? null };
  });
  rows.sort((a, b) => String(b.lastAt ?? '').localeCompare(String(a.lastAt ?? '')) || String(a.m.id).localeCompare(String(b.m.id)));
  const want = rows.slice(0, 8);
  const omitted = rows.length - want.length;
  const head = [
    `# 记忆素材 · 用户画像（跨项目） · ${projects.length} 个项目 · ${rows.length} 个会话 · 取最近 ${want.length} 个`,
    `（项目：${projects.slice(0, 12).map((p) => `${p.name}（${p.key}）`).join(' · ')}${projects.length > 12 ? ` · 另 ${projects.length - 12} 个` : ''}）`,
    `（画像素材固定跨项目取最近 8 个会话；行内 <项目>:<sid8>:Sxx 就是证据的 project 与 sid；预算 ${max} tok，超了整段丢最旧）`,
  ];
  let used = tok(head.join('\n'));
  const kept = [];
  const dropped = [];
  let overflow = false;
  for (const { m, p } of want) {
    if (overflow) { dropped.push(`${p.name}:${m.sid8}`); continue; }
    const d = sessionDigest(m, `${p.name}:${m.sid8}`);
    const t = tok(d.text);
    if (used + t > max) { overflow = true; dropped.push(`${p.name}:${m.sid8}`); continue; }
    used += t;
    kept.push(d);
  }
  if (dropped.length) head.push(`（预算不够：已整段丢掉最旧 ${dropped.length} 个会话 ${dropped.join(' ')}——要更多用 --max N）`);
  if (omitted > 0) head.push(`（另有 ${omitted} 个更旧的会话不在画像素材里：固定取最近 8 个）`);
  const tail = [
    '## 类别口径（G4：一条不过整批不写）',
    '画像: ≥2 个不同会话，每个至少 1 条 kind=say；引文必须是真人原话（工具回执与压缩摘要不算）',
    '画像范围: 收两类——工作要求/偏好，以及可复用的沟通、决策与性格特征（如直接、要实证、要完整）；只写有跨会话原话支撑的倾向，不做心理诊断、不贴贬义标签',
    '维度: 每条尽量带 dimension（目标/边界/规则/偏好/背景/验收/分工/反馈/性格）；缺哪个维度就补哪个，没有证据的维度如实留空',
    `场景: 可选 scenes（${MEMORY_SCENES.join('/')}）；按适用的工作场景多选，不适用留空`,
    '规则: 只能 memory --promote 从 ≥2 个项目的等价规则合成，不能直接写用户表（G8）',
    '## 输出形状（memory --put --scope user -）',
    '{"entries":[{"class":"画像","topic":"把手","text":"一句话","dimension":"偏好","scenes":["ui","design"],"evidence":[{"project":"<项目键|名字>","sid":"<sid8>","seg":"S07","hash":"<contentHash 前12位>","kind":"say","quote":"逐字"}],"revises":null}]}',
    '证据每条都要 project：画像天生跨项目。hash 取 ledger.json 的 segments[].contentHash 前 12 位；写入口先重建再核锚点。',
    '素材里没有的，写不出来。',
  ];
  return {
    text: [...head, ...kept.map((d) => d.text), ...tail].join('\n') + '\n',
    sessions: kept.length,
    dropped,
    tokens: used + tok(tail.join('\n')),
    omitted,
  };
}

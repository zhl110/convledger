// 阶段层（PRD-phases）：模型把主线步划成连续区间，写「在做什么 / 进度 / 效果 /
// 对照 PRD·plan / progress 文件」五格散文；工具只做三件事——算边界与锚点、
// 逐条核编造、把阶段事实（段/已证/产物/留问/规则）从账本复算出来。
//
// 与 summaries.mjs 的分工：块综述回答"这一块"，阶段说明回答"这一程"。
// 两者都是 basis:'model'，永不写 verified；阶段表同样是外挂表，重建账本不覆盖。
import fs from 'node:fs';
import path from 'node:path';
import { sha, wlen } from './lib.mjs';
import {
  PHASE_SHORT_W, PHASE_DOING_MAX, PHASE_STATE_MAX, PHASE_EFFECT_MAX, PHASE_PLAN_MAX, PHASE_TRACK_MAX,
  SUMMARY_MIN_QUOTE_OVERLAP,
} from './cost.mjs';
import { resolveRef } from './docs.mjs';

const FILE = 'phases.json';
export const SCHEMA = 'convledger-phases/1';

/** Read the phase table. A corrupt file is an error, not an empty table:
 *  the next write would silently drop every phase before it. */
export function readPhases(dir) {
  const f = path.join(dir, FILE);
  const empty = { schema: SCHEMA, phases: [], askSplitFrom: null };
  if (!fs.existsSync(f)) return empty;
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { throw new Error(`${f} 读不了（${String(e.message).split('\n')[0]}）— 修它，否则下一批阶段会把它覆盖掉`); }
  return {
    schema: parsed.schema ?? SCHEMA,
    phases: Array.isArray(parsed.phases) ? parsed.phases : [],
    askSplitFrom: Number.isFinite(parsed.askSplitFrom) ? parsed.askSplitFrom : null,
  };
}

/** 水位线：块从第几步起按真人提问切（PRD-blocks-live）。只增不减，由 phases --put 冻结旧值。 */
export const maxPhaseTo = (table) => (table?.phases ?? []).reduce((m, p) => Math.max(m, Number(p.to) || 0), 0);

export function writePhases(dir, table) {
  const body = { schema: SCHEMA, phases: table.phases };
  if (Number.isFinite(table.askSplitFrom)) body.askSplitFrom = table.askSplitFrom;
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify(body, null, 1) + '\n');
}

/** Which blocks belong to [from..to]: main blocks by step, interlude blocks by the
 *  nearest main step they sit between. A block can belong to exactly one phase. */
export function memberBlocks(from, to, steps) {
  return steps.filter((s) => {
    if (s.step != null) return s.step >= from && s.step <= to;
    const at = s.afterStep ?? s.beforeStep;
    return at != null && at >= from && at <= to;
  });
}

export function phaseSegs(from, to, steps) {
  const out = [];
  for (const b of memberBlocks(from, to, steps)) for (const id of b.segIds) out.push(id);
  return out;
}

/** Identity = the exact step range + every covered segment's anchor hash. A rebuild
 *  that appends to the tail changes only the last block, so earlier phases stay
 *  fresh; a split/merge anywhere drops exactly the phases it touched. */
export function phaseHash(from, to, steps, nodes) {
  const idx = {};
  nodes.forEach((n, i) => { idx[n.id] = i; });
  const parts = [`${from}:${to}`];
  for (const id of phaseSegs(from, to, steps)) parts.push(`${id}:${nodes[idx[id]]?.hash ?? ''}`);
  return sha(parts.join('|'));
}

/** Rule moves are facts, not prose: the writer never types this cell. */
export function phaseRules(blocks, nodes) {
  const idx = {};
  nodes.forEach((n, i) => { idx[n.id] = i; });
  const out = [];
  for (const b of blocks) {
    for (const id of b.segIds) {
      const n = nodes[idx[id]];
      if (!n || n.basis !== 'verified' || !n.claim) continue;
      if (!String(n.moves || '').split(/\s+/).includes('rule')) continue;
      out.push({ id, text: n.claim });
    }
  }
  return out;
}

/** Everything the page shows for one fresh phase, except the model prose. */
export function phaseFacts(from, to, steps, nodes) {
  const blocks = memberBlocks(from, to, steps);
  const segs = [];
  let verified = 0, wrote = 0, open = 0, errs = 0, level = 9, side = 0, decisions = 0, ruledOut = 0;
  for (const b of blocks) {
    verified += b.verified || 0;
    wrote += b.wrote || 0;
    open += b.open || 0;
    errs += b.errs || 0;
    if (typeof b.level === 'number') level = Math.min(level, b.level);
    if (b.step == null) side++;
    decisions += b.decisions || 0;
    ruledOut += b.ruledOut || 0;
    for (const id of b.segIds) segs.push(id);
  }
  const first = segs[0] || '', last = segs[segs.length - 1] || '';
  return {
    from, to, blockIds: blocks.map((b) => b.i),
    fromBlock: blocks[0]?.i ?? null, toBlock: blocks[blocks.length - 1]?.i ?? null,
    blocks: blocks.length, side, segs, span: first ? (first === last ? first : `${first}–${last}`) : `${from}（只有压缩事件）`,
    verified, wrote, open, errs, decisions, ruledOut,
    level: level === 9 ? 0 : level,
    rules: phaseRules(blocks, nodes),
  };
}

/** Apply the stored table to the current ledger: keep only phases whose anchor
 *  still matches, renumber 1..K by order, and attach facts. Renumbering at read
 *  means a dropped middle phase leaves no confusing hole in the numbering. */
export function applyPhases(table, steps, nodes, mainSteps) {
  const fresh = [];
  let dropped = 0;
  for (const e of table.phases || []) {
    const from = Number(e?.from), to = Number(e?.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > mainSteps) { dropped++; continue; }
    if (e.hash !== phaseHash(from, to, steps, nodes)) { dropped++; continue; }
    fresh.push({ ...phaseFacts(from, to, steps, nodes), hash: e.hash, short: e.short, doing: e.doing,
      state: e.state, effect: e.effect, plan: e.plan, track: e.track, refs: e.refs || [],
      basis: 'model', at: e.at });
  }
  fresh.sort((a, b) => a.from - b.from);
  fresh.forEach((p, i) => { p.n = i + 1; });
  return { phases: fresh, dropped };
}

/* ---------- material ---------- */

export function stepMaterial(s, nodes) {
  const head = s.step != null
    ? `步${s.step} 块${s.i} ${s.span} 段${s.segs}${s.verified ? ` 证${s.verified}` : ''}${s.wrote ? ` 写${s.wrote}` : ''}${s.open ? ` 留问${s.open}` : ''}${s.side ? ` 夹${s.side}插曲` : ''}${s.rules?.length ? ` 规则${s.rules.length}` : ''}`
    : `插曲 块${s.i} 夹${s.afterStep ?? '?'}↔${s.beforeStep ?? '?'} ${s.span} 段${s.segs}${s.verified ? ` 证${s.verified}` : ''}${s.wrote ? ` 写${s.wrote}` : ''}`;
  const out = [head];
  if (s.say) out.push(`  你：${s.say.slice(0, 60)}`);
  const done = s.sum ? s.sum.done : s.solved;
  if (done) out.push(`  成：${String(done).slice(0, 60)}`);
  if (s.files?.length) out.push(`  产：${s.files.slice(0, 4).join(' ')}`);
  return out.join('\n');
}

/** Material for one proposed range: its blocks, counts, and the resolved citations. */
export function phaseMaterial(from, to, steps, nodes, totals, refs) {
  const blocks = memberBlocks(from, to, steps);
  const f = phaseFacts(from, to, steps, nodes);
  const out = [
    `阶段 第${from}–${to}步（${to - from + 1} 步）· 全会话 ${totals.mainSteps} 步 / ${totals.blocks} 块 / ${totals.nodes} 段`,
    `计数：块${f.blocks}${f.side ? `（含插曲 ${f.side}）` : ''} 段${f.segs.length} 证${f.verified} 写${f.wrote} 留问${f.open} 报错${f.errs} 规则${f.rules.length}`,
    ...blocks.map((b) => stepMaterial(b, nodes)),
  ];
  if (refs?.length) out.push('引用：' + refs.map((r) => `${r.f} › ${r.h}`).join('；'));
  return out.join('\n');
}

/** One-shot material for writing the whole table: every step (so the writer can
 *  choose boundaries), the caps, the output shape, and the citation vocabulary. */
export function allMaterial(v, docs) {
  const totals = { mainSteps: v.mainSteps, blocks: v.steps.length, nodes: v.nodes.length };
  const have = (v.phases || []).length;
  const lines = [
    `# 阶段素材 · ${v.mainSteps} 步 / ${v.steps.length} 块 / ${v.nodes.length} 段 · 已有 ${have} 段${have ? `（到第 ${v.phases[v.phases.length - 1].to} 步）` : ''}`,
    `# 边界由你定，工具硬核：首尾相接、覆盖第 1–${v.mainSteps} 步、除末段外每段 ≥2 步`,
    `# 六格：short ≤${PHASE_SHORT_W}格 · doing ≤${PHASE_DOING_MAX}字 · state ≤${PHASE_STATE_MAX} · effect ≤${PHASE_EFFECT_MAX} · plan ≤${PHASE_PLAN_MAX} · track ≤${PHASE_TRACK_MAX}`,
    '# 整格不得是块内原话的连续截段；文件名、数字必须在这份素材里出现',
    '# refs 只许引用下面文档清单的 D 编号；plan/track 没有可引用的章节就整格写 —（不是空着）',
    '# 输出：{"phases":[{"from":1,"to":7,"short":"…","doing":"…","state":"…","effect":"…","plan":"…","track":"…","refs":["D1"]}]}',
    '',
    ...v.steps.map((s) => stepMaterial(s, v.nodes)),
    '',
    '# 文档清单（引用词汇表；只引用编号，写入口解析成文件+标题）',
    docList(docs),
  ];
  return lines.join('\n') + '\n';
}

function docList(docs) {
  const list = docs?.list || [];
  if (!list.length) return '（工作区里没有可引用的 .md 标题：plan/track 只能写 —）';
  return list.map((x) => `${x.id} ${x.f} › ${x.h}`).join('\n');
}

/* ---------- gates ---------- */

export const norm = (s) => String(s ?? '')
  .replace(/[\s，。；：、！？,.;:!?…—–\-"'“”‘’「」『』（）()《》<>·]/g, '');
const TOKEN = /[A-Za-z][A-Za-z0-9._+\/-]*|\d+(?:\.\d+)?/g;

export function quotesIn(from, to, steps, nodes) {
  const idx = {};
  nodes.forEach((n, i) => { idx[n.id] = i; });
  const out = [];
  for (const b of memberBlocks(from, to, steps)) {
    for (let j = b.i0; j <= b.i1; j++) {
      const n = nodes[j];
      if (!n) continue;
      for (const q of [n.say, n.claim, n.line]) {
        if (q && String(q).length >= SUMMARY_MIN_QUOTE_OVERLAP) out.push(norm(q));
      }
    }
  }
  return out;
}

/** 拉丁 token 与数字必须在素材里出现过。`what` 只影响报错措辞（阶段/章共用这一条）。 */
export function grounded(field, name, material, errors, what = '阶段') {
  const mat = material.toLowerCase();
  for (const token of new Set(String(field).match(TOKEN) || [])) {
    if (token.length < 2 && !/^\d+$/.test(token)) continue;
    if (!mat.includes(token.toLowerCase())) errors.push(`${name} 里的「${token}」在${what}素材里找不到——${what}说明不许编没见过的名字/数字`);
  }
}

/** Validate one phase entry against the current ledger. The tool owns segs/hash;
 *  the writer owns bounds + prose. `refs` are D ids from this run's doc list. */
export function validatePhase(entry, ctx) {
  const errors = [];
  const from = Number(entry?.from), to = Number(entry?.to);
  const mainSteps = ctx.totals.mainSteps;
  if (!Number.isInteger(from) || !Number.isInteger(to)) errors.push(`from/to 要是整数步号，收到 ${entry?.from ?? '（空）'}/${entry?.to ?? '（空）'}`);
  else if (from < 1 || to < from || to > mainSteps) errors.push(`区间 ${from}–${to} 不合法（当前主线第 1–${mainSteps} 步）`);

  const F = {
    short: String(entry?.short ?? '').trim(),
    doing: String(entry?.doing ?? '').trim(),
    state: String(entry?.state ?? '').trim(),
    effect: String(entry?.effect ?? '').trim(),
    plan: String(entry?.plan ?? '').trim(),
    track: String(entry?.track ?? '').trim(),
  };
  if (wlen(F.short) > PHASE_SHORT_W) errors.push(`short 占 ${wlen(F.short).toFixed(1)} 格 > ${PHASE_SHORT_W}`);
  if (F.doing.length > PHASE_DOING_MAX) errors.push(`doing ${F.doing.length} 字 > ${PHASE_DOING_MAX}`);
  if (F.state.length > PHASE_STATE_MAX) errors.push(`state ${F.state.length} 字 > ${PHASE_STATE_MAX}`);
  if (F.effect.length > PHASE_EFFECT_MAX) errors.push(`effect ${F.effect.length} 字 > ${PHASE_EFFECT_MAX}`);
  if (F.plan.length > PHASE_PLAN_MAX) errors.push(`plan ${F.plan.length} 字 > ${PHASE_PLAN_MAX}`);
  if (F.track.length > PHASE_TRACK_MAX) errors.push(`track ${F.track.length} 字 > ${PHASE_TRACK_MAX}`);
  for (const [k, v] of Object.entries(F)) if (!v) errors.push(`${k} 为空：六格都得答一句`);

  const refIds = Array.isArray(entry?.refs) ? entry.refs.map(String) : [];
  const refs = [];
  for (const id of refIds) {
    const hit = resolveRef(ctx.docs, id);
    if (!hit) errors.push(`refs 里的「${id}」不在这次的文档清单里——引用只能取 D 编号`);
    else refs.push({ f: hit.f, h: hit.h });
  }
  if (!refs.length && (F.plan !== '—' || F.track !== '—'))
    errors.push('plan/track 没有引用任何文档章节：要么至少给一个 refs，要么整格写 —（明说这一格没有源）');

  const material = Number.isInteger(from) && Number.isInteger(to) && from >= 1 && to >= from && to <= mainSteps
    ? phaseMaterial(from, to, ctx.steps, ctx.nodes, ctx.totals, refs)
    : '';
  if (material) {
    const quotes = quotesIn(from, to, ctx.steps, ctx.nodes);
    for (const [k, v] of Object.entries(F)) {
      const nv = norm(v);
      if (nv.length < SUMMARY_MIN_QUOTE_OVERLAP) continue;
      if (quotes.some((q) => q.includes(nv))) errors.push(`${k} 是原话截段，不是阶段说明：「${v}」`);
      grounded(v, k, material, errors);
    }
  }
  return {
    ok: !errors.length,
    errors,
    row: {
      from, to,
      segs: Number.isInteger(from) && Number.isInteger(to) ? phaseSegs(from, to, ctx.steps) : [],
      hash: Number.isInteger(from) && Number.isInteger(to) ? phaseHash(from, to, ctx.steps, ctx.nodes) : '',
      ...F, refs, basis: 'model', at: new Date().toISOString(),
    },
  };
}

/** Whole-table gates: order, coverage, minimum span, and each entry's own gates. */
export function validatePhases(entries, ctx) {
  const errors = [];
  if (!Array.isArray(entries) || !entries.length) return { ok: false, errors: ['阶段表是空的'], rows: [] };
  const sorted = entries.map((e) => ({ e, from: Number(e?.from), to: Number(e?.to) }))
    .sort((a, b) => (a.from - b.from) || (a.to - b.to));
  const M = ctx.totals.mainSteps;
  if (sorted[0].from !== 1) errors.push(`第一段从第 ${sorted[0].from} 步开始——必须从第 1 步开始`);
  for (let k = 1; k < sorted.length; k++) {
    const p = sorted[k - 1], c = sorted[k];
    if (c.from <= p.to) errors.push(`阶段 ${c.from}–${c.to} 与 ${p.from}–${p.to} 重叠或重复`);
    else if (c.from !== p.to + 1) errors.push(`第 ${p.to + 1}–${c.from - 1} 步没有被任何阶段覆盖`);
  }
  const last = sorted[sorted.length - 1];
  // 尾段是允许的：阶段只覆盖已经收口的主线步，最后一段不必追到当前末步。
  // 当前末步还在长，强行要求覆盖到 M 会让每次写阶段都被最后一块的 hash 拖过期。
  if (last.to > M) errors.push(`最后一段到第 ${last.to} 步，超过主线 ${M} 步`);
  sorted.forEach((x, k) => {
    if (k < sorted.length - 1 && x.to - x.from + 1 < 2) errors.push(`阶段 ${x.from}–${x.to} 只有 1 步——除最后一段外每段至少 2 步`);
  });
  const rows = [];
  for (const x of sorted) {
    const r = validatePhase(x.e, ctx);
    if (!r.ok) errors.push(...r.errors.map((m) => `阶段 ${x.from}–${x.to}: ${m}`));
    else rows.push(r.row);
  }
  return { ok: !errors.length, errors, rows };
}

// 章层（PRD-chapters）：把连续几十步（必须落在阶段边界上）汇成"接手人需要的一页"——
// 目的、走到哪、核心规则、主要任务、碰壁、注意事项、架构现状、怎么接手。
// 与 phases.mjs 的分工：阶段答"这一程做了什么"，章答"下一个人该知道什么"。
// 工具不调模型，只做三件事：算边界与锚点、逐条核编造、把素材汇出来。
import fs from 'node:fs';
import path from 'node:path';
import { wlen, tok } from './lib.mjs';
import {
  CHAP_SHORT_W, CHAP_GOAL_MAX, CHAP_WHERE_MAX, CHAP_RULES_MAX, CHAP_TASKS_MAX, CHAP_WALLS_MAX,
  CHAP_CAUTION_MAX, CHAP_ARCH_MAX, CHAP_HANDOFF_MAX, CHAP_MIN_PHASES, CHAP_DIGEST_TOKENS,
  SUMMARY_MIN_QUOTE_OVERLAP,
} from './cost.mjs';
import { resolveRef } from './docs.mjs';
import { phaseHash, phaseSegs, phaseFacts, stepMaterial, norm, quotesIn, grounded } from './phases.mjs';

const FILE = 'chapters.json';
export const SCHEMA = 'convledger-chapters/1';

const CELLS = [
  ['short', CHAP_SHORT_W], ['goal', CHAP_GOAL_MAX], ['where', CHAP_WHERE_MAX], ['rules', CHAP_RULES_MAX],
  ['tasks', CHAP_TASKS_MAX], ['walls', CHAP_WALLS_MAX], ['cautions', CHAP_CAUTION_MAX],
  ['arch', CHAP_ARCH_MAX], ['handoff', CHAP_HANDOFF_MAX],
];
const LABEL = { short: '章名', goal: '目的', where: '走到哪', rules: '规则与原则', tasks: '主要任务', walls: '碰壁', cautions: '注意事项', arch: '架构现状', handoff: '接手指引' };

/** 读章表。文件读不了是错误，不是空表——否则下一批会把已有章整片抹掉。 */
export function readChapters(dir) {
  const f = path.join(dir, FILE);
  if (!fs.existsSync(f)) return { schema: SCHEMA, chapters: [] };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { throw new Error(`${f} 读不了（${String(e.message).split('\n')[0]}）— 修它，否则下一批章会把它覆盖掉`); }
  return { schema: parsed.schema ?? SCHEMA, chapters: Array.isArray(parsed.chapters) ? parsed.chapters : [] };
}

export function writeChapters(dir, table) {
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify({ schema: SCHEMA, chapters: table.chapters }, null, 1) + '\n');
}

/** 边界必须与阶段边界重合：from＝某阶段的 from，to＝某阶段的 to，中间的阶段首尾相接、
    一段不缺（缺一段说明那一程已经因 hash 失效，章就不该再声称覆盖它）。 */
export function alignError(from, to, phases) {
  const list = (phases || []).filter((p) => p.from >= from && p.to <= to)
    .sort((a, b) => a.from - b.from);
  if (!list.length) return `区间 ${from}–${to} 里一个阶段都没有——章必须盖在已写的阶段之上`;
  if (list[0].from !== from) return `章从第 ${from} 步开始，但这里的阶段从第 ${list[0].from} 步开始——章边界必须落在阶段边界上`;
  const last = list[list.length - 1];
  if (last.to !== to) return `章到第 ${to} 步结束，但这里的阶段只到第 ${last.to} 步——章边界必须落在阶段边界上`;
  for (let i = 1; i < list.length; i++) {
    if (list[i].from !== list[i - 1].to + 1) return `章内第 ${list[i - 1].to + 1}–${list[i].from - 1} 步没有阶段（阶段失效了，章也不能留着）`;
  }
  if (list.length < CHAP_MIN_PHASES) return `这一章只盖 ${list.length} 个阶段，少于 ${CHAP_MIN_PHASES} 个——太碎就退回阶段层，别加一层`;
  return null;
}

/** 章的事实全部从阶段层复算：区间内的块、段、计数与阶段号。写的人不填这些。
    已证规则改名 ruleMoves——`rules` 这一格是模型写的散文，两个不能挤在同一个键上。 */
export function chapterFacts(from, to, steps, nodes, phases) {
  const { rules, ...f } = phaseFacts(from, to, steps, nodes);
  const inside = (phases || []).filter((p) => p.from >= from && p.to <= to).sort((a, b) => a.from - b.from);
  return {
    ...f, ruleMoves: rules, phaseNs: inside.map((p) => p.n), phaseCount: inside.length,
    phaseSpan: inside.length ? `阶段 ${inside[0].n}–${inside[inside.length - 1].n}` : '未划阶段',
  };
}

/** 一章的素材：既是写的人要读的东西，也是反编造判据里"见过才算"的那份文本。 */
export function chapterMaterial(from, to, ctx, refs) {
  const { steps, nodes, phases, totals, requests } = ctx;
  const f = chapterFacts(from, to, steps, nodes, phases);
  const inRange = (phases || []).filter((p) => p.from >= from && p.to <= to).sort((a, b) => a.from - b.from);
  const out = [
    `章 第${from}–${to}步（${to - from + 1} 步）· 块 ${f.fromBlock}–${f.toBlock} · ${f.phaseSpan}（${f.phaseCount} 段）`,
    `全会话 ${totals.mainSteps} 步 / ${totals.blocks} 块 / ${totals.nodes} 段`,
    `计数：块${f.blocks}${f.side ? `（含插曲 ${f.side}）` : ''} 段${f.segs.length} 证${f.verified} 写${f.wrote} 留问${f.open} 报错${f.errs} 规则${f.ruleMoves.length}`,
    '',
    '=== 阶段（这一章里的每一程）===',
  ];
  for (const p of inRange) {
    out.push(`阶段 ${p.n} 第${p.from}–${p.to}步 ${p.short}`);
    if (p.doing) out.push(`  做了：${p.doing}`);
    if (p.state) out.push(`  进度：${p.state}`);
    if (p.effect) out.push(`  成了：${p.effect}`);
  }
  if (f.ruleMoves.length) {
    out.push('', '=== 已证规则（过六条判据的 rule 增量）===');
    for (const r of f.ruleMoves) out.push(`规则 ${r.id}：${r.text}`);
  }
  // 真人请求：按段号对上，或按"第几步写的"落在区间里（两种来源都算这一章的口径）
  const req = (requests || []).filter((r) => (r.from && f.segs.includes(String(r.from).toUpperCase()))
    || (Number.isFinite(r.part) && r.part >= from && r.part <= to));
  if (req.length) {
    out.push('', '=== 真人请求 ===');
    for (const r of req) out.push(`请求 ${r.id}：${r.text}`);
  }
  out.push('', '=== 步表 ===');
  for (const b of f.blockIds.map((i) => steps.find((s) => s.i === i)).filter(Boolean)) out.push(stepMaterial(b, nodes));
  if (refs?.length) out.push('', '引用：' + refs.map((r) => `${r.f} › ${r.h}`).join('；'));
  return out.join('\n');
}

/** --digest：一章的素材 + 上限 + 输出形状 + 引用词汇表，预算内超了就砍步表并明说。 */
export function chapterDigest(from, to, ctx, docs, title) {
  const head = [
    `# ${title}`,
    `# 边界硬判据：from/to 必须与阶段边界重合、首尾相接、每章 ≥${CHAP_MIN_PHASES} 个阶段`,
    `# 九格：${CELLS.map(([k, m]) => `${k}(${LABEL[k]}) ≤${m}${k === 'short' ? '格' : '字'}`).join(' · ')}`,
    '# 整格不得是区间内原话的连续截段；文件名、数字必须在这份素材里出现',
    '# refs 只许引用下面文档清单的 D 编号；某格确实没有源就整格写 —（不是空着）',
    `# 输出：{"append":true,"chapters":[{"from":${from},"to":${to},"short":"…","goal":"…","where":"…","rules":"…","tasks":"…","walls":"…","cautions":"…","arch":"…","handoff":"…","refs":["D1"]}]}`,
    '',
  ];
  const docList = (docs?.list || []).map((x) => `${x.id} ${x.f} › ${x.h}`).join('\n') || '（没有可引用的 .md 标题：refs 留空）';
  let body = chapterMaterial(from, to, ctx, []);
  let note = '';
  const over = () => tok(head.join('\n') + '\n' + body + '\n' + note + '\n# 文档清单（引用词汇表；只引用编号）\n' + docList) > CHAP_DIGEST_TOKENS;
  if (over()) {
    const lines = body.split('\n');
    while (lines.length > 6 && over()) { lines.pop(); body = lines.join('\n'); }
    note = `# 注意：素材超过 ${CHAP_DIGEST_TOKENS} tok 预算，步表已截到 ${lines.length} 行——这个区间太大，建议拆成两章再写。\n`;
  }
  return head.join('\n') + '\n' + body + '\n' + note + '\n# 文档清单（引用词汇表；只引用编号）\n' + docList + '\n';
}

export const CHAPTER_CELLS = CELLS;
export const CHAPTER_LABEL = LABEL;
const to0 = (phases) => (phases || []).reduce((m, p) => Math.max(m, p.to), 0);

/** 校验一条章：区间、九格长度、反截段、反编造、引用。工具拥有 segs/hash。 */
export function validateChapter(entry, ctx) {
  const errors = [];
  const from = Number(entry?.from), to = Number(entry?.to);
  if (!Number.isInteger(from) || !Number.isInteger(to)) errors.push(`from/to 要是整数步号，收到 ${entry?.from ?? '（空）'}/${entry?.to ?? '（空）'}`);
  else if (from < 1 || to < from || to > ctx.totals.mainSteps) errors.push(`区间 ${from}–${to} 不合法（当前主线第 1–${ctx.totals.mainSteps} 步）`);
  if (Number.isInteger(from) && Number.isInteger(to)) {
    const e = alignError(from, to, ctx.phases);
    if (e) errors.push(e);
  }
  const F = {};
  for (const [k] of CELLS) F[k] = String(entry?.[k] ?? '').trim();
  for (const [k, max] of CELLS) {
    if (!F[k]) errors.push(`${k}（${LABEL[k]}）为空：九格都得答一句，确实没有源就整格写 —`);
    const v = k === 'short' ? wlen(F[k]) : F[k].length;
    // 口径与阶段层同文：short 量的是卡面占宽（格，可半格），其余格数字数。
    if (v > max) errors.push(k === 'short' ? `${k} 占 ${v.toFixed(1)} 格 > ${max}` : `${k} ${v} 字 > ${max}`);
  }
  const refIds = Array.isArray(entry?.refs) ? entry.refs.map(String) : [];
  const refs = [];
  for (const id of refIds) {
    const hit = resolveRef(ctx.docs, id);
    if (!hit) errors.push(`refs 里的「${id}」不在这次的文档清单里——引用只能取 D 编号`);
    else refs.push({ f: hit.f, h: hit.h });
  }
  const aligned = Number.isInteger(from) && Number.isInteger(to) && !alignError(from, to, ctx.phases);
  if (aligned) {
    const material = chapterMaterial(from, to, ctx, refs);
    const quotes = quotesIn(from, to, ctx.steps, ctx.nodes);
    for (const [k, v] of Object.entries(F)) {
      if (!v || v === '—') continue;
      const nv = norm(v);
      if (nv.length >= SUMMARY_MIN_QUOTE_OVERLAP && quotes.some((q) => q.includes(nv))) {
        errors.push(`${k} 是原话截段，不是章说明：「${v}」`);
      }
      grounded(v, k, material, errors, '章');
    }
  }
  return {
    ok: !errors.length, errors,
    row: aligned ? {
      from, to,
      segs: phaseSegs(from, to, ctx.steps),
      hash: phaseHash(from, to, ctx.steps, ctx.nodes),
      ...F, refs, basis: 'model', at: new Date().toISOString(),
    } : null,
  };
}

/** 整表闸门：从第 1 步起首尾相接、不重叠、不越到没阶段的地方，再逐条过九格。 */
export function validateChapters(entries, ctx) {
  const errors = [];
  if (!Array.isArray(entries) || !entries.length) return { ok: false, errors: ['章表是空的'], rows: [] };
  const sorted = entries.map((e) => ({ e, from: Number(e?.from), to: Number(e?.to) }))
    .sort((a, b) => (a.from - b.from) || (a.to - b.to));
  const maxPhaseTo = to0(ctx.phases);
  if (sorted[0].from !== 1) errors.push(`第一章从第 ${sorted[0].from} 步开始——必须从第 1 步开始`);
  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i - 1], c = sorted[i];
    if (c.from <= p.to) errors.push(`章 ${c.from}–${c.to} 与 ${p.from}–${p.to} 重叠或重复`);
    else if (c.from !== p.to + 1) errors.push(`第 ${p.to + 1}–${c.from - 1} 步没有被任何章覆盖`);
  }
  const last = sorted[sorted.length - 1];
  // 尾章允许留白：当前程还在长，逼着写就会因末块 hash 变化立刻失效。
  if (last.to > maxPhaseTo) errors.push(`最后一章到第 ${last.to} 步，超过已写阶段的第 ${maxPhaseTo} 步`);
  const rows = [];
  for (const x of sorted) {
    const r = validateChapter(x.e, ctx);
    if (!r.ok) errors.push(...r.errors.map((m) => `章 ${x.from}–${x.to}: ${m}`));
    else rows.push(r.row);
  }
  return { ok: !errors.length, errors, rows };
}

/** 把存表贴到当前账本：只留锚点新鲜且边界仍与阶段重合的章，按顺序重编号 1..K。 */
export function applyChapters(table, steps, nodes, mainSteps, phases) {
  const fresh = [];
  const dropped = [];
  for (const e of table.chapters || []) {
    const from = Number(e?.from), to = Number(e?.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > mainSteps) { dropped.push({ from, to, why: '区间不合法' }); continue; }
    if (e.hash !== phaseHash(from, to, steps, nodes)) { dropped.push({ from, to, why: '锚点 hash 变了（区间内有段被改写）' }); continue; }
    const why = alignError(from, to, phases);
    if (why) { dropped.push({ from, to, why }); continue; }
    fresh.push({ ...chapterFacts(from, to, steps, nodes, phases), hash: e.hash, basis: 'model', at: e.at,
      short: e.short, goal: e.goal, where: e.where, rules: e.rules, tasks: e.tasks, walls: e.walls,
      cautions: e.cautions, arch: e.arch, handoff: e.handoff, refs: e.refs || [] });
  }
  fresh.sort((a, b) => a.from - b.from);
  fresh.forEach((c, i) => { c.n = i + 1; });
  return { chapters: fresh, dropped: dropped.length, dropReasons: dropped };
}

/** 建议的章区间：把还没进章的阶段按块数攒到 target 块左右切一刀。只当候选，不代做判断。 */
export function suggestRanges(phases, steps, coveredTo = 0, target = 60) {
  const out = [];
  let from = null, acc = null;
  for (const p of (phases || []).filter((x) => x.to > coveredTo).sort((a, b) => a.from - b.from)) {
    if (from === null) { from = p.from; acc = 0; }
    acc += p.blocks;
    if (acc >= target) { out.push({ from, to: p.to, blocks: acc }); from = null; acc = 0; }
  }
  if (from !== null) out.push({ from, to: to0(phases), blocks: acc });
  return out.filter((r) => r.to >= r.from);
}

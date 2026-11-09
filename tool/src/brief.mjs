// brief：给 agent 的一次性入口。三层检索的第一层。
// 一级＝阶段摘要（模型写、工具验过锚点的连续步区间），二级＝块表，三级＝body 逐字回源。
// 这里只做"原样取用 + 子句边界截断"：不调用模型、不写文件、不生成任何新句子。
import { clip } from './view.mjs';
import { tok } from './lib.mjs';

const LINE_W = 110;           // doing/effect 每行显示宽上限
const PHASE_LINE_W = 96;      // 阶段头（短名）的显示宽上限

const stepCell = (s) => (s.step != null ? `步${s.step}` : `插${s.afterStep ?? '?'}↔${s.beforeStep ?? '?'}`);
const atCell = (at) => String(at ?? '').slice(0, 16).replace('T', ' ');
/** 块的"题"：模型综述题名 → 块内第一句真人原话 → 远景那 7 格小字 → 如实无题名。
 *  mark 是给远景小格子用的（CLAIM_MARK_W=7），直接搬到一行的位置只剩「我说错了，不是」这种半句；
 *  mark 的 '—' 是「没有题」的占位，不是名字，别当成题名念出来。 */
const blockTitle = (s) => (s.sum?.title ? clip(s.sum.title, 40, true) : '')
  || clip(s.say, 40, true) || (s.mark && s.mark !== '—' ? clip(s.mark, 40, true) : '') || '（无题名）';

function headLine(v, pending) {
  const ph = v.phases || [];
  const ch = v.chapters || [];
  const covered = ph.length ? Math.max(...ph.map((p) => p.to)) : 0;
  const dropped = v.meta?.phases?.dropped || 0;
  const phasePart = ph.length
    ? `阶段 ${ph.length} 段${dropped ? `（丢弃 ${dropped}）` : ''}覆盖第 1–${covered} 步`
    : `阶段 0 段${dropped ? `（丢弃 ${dropped}）` : ''}`;
  const chPart = ch.length
    ? ` · 章 ${ch.length} 段${(v.meta?.chapters?.dropped || 0) ? `（丢弃 ${v.meta.chapters.dropped}）` : ''}覆盖第 1–${Math.max(...ch.map((c) => c.to))} 步`
    : '';
  return `账本 ${String(v.meta?.session || '').slice(0, 8)} · ${v.meta?.segs ?? '?'} 段 / ${v.steps.length} 块 / ${v.mainSteps} 步 · ${phasePart}${chPart} · 待办请求 ${pending} 条`;
}

function currentLine(v) {
  const last = [...v.steps].reverse().find((s) => s.step != null);
  if (!last) return '当前：还没有主线步';
  const title = `《${blockTitle(last)}》`;
  const done = last.sum?.done ? ` · 成了：${clip(last.sum.done, 60, true)}` : '';
  return `当前：第 ${last.step} 步 · 块 ${last.i} · ${title}${done}`;
}

const requestLines = (requests) => requests.filter((x) => !x.done).slice(0, 5)
  .map((r) => `请求 ${r.id} · ${String(r.text).slice(0, 60)}${r.text.length > 60 ? '…' : ''}（地图里写的；处理完 requests --done ${r.id}）`);

/** 章模式（PRD-chapters §七）：每章一行，只展开最后一章——那才是接手人要读的一页。
    目的不是"少写点"，是把 30 多段阶段摘要压到注入预算里还留得下最近一程的细节。 */
function chapterBriefText(v, requests, ch, pending) {
  const out = [headLine(v, pending), currentLine(v)];
  for (const c of ch) {
    out.push(`章 ${c.n} · 第 ${c.from}–${c.to} 步 · 块 ${c.fromBlock}–${c.toBlock} · ${c.phaseSpan} · ${clip(c.short, PHASE_LINE_W, true)}`);
    if (c.goal) out.push(`  目的：${clip(c.goal, LINE_W, true)}`);
  }
  const last = ch[ch.length - 1];
  out.push(`第 ${last.n} 章展开：`);
  for (const [k, label] of [['where', '走到哪'], ['rules', '规则与原则'], ['tasks', '主要任务'],
    ['walls', '碰壁'], ['cautions', '注意事项'], ['arch', '架构现状'], ['handoff', '接手指引']]) {
    if (last[k]) out.push(`  ${label}：${clip(last[k], LINE_W, true)}`);
  }
  for (const p of (v.phases || []).filter((x) => x.from >= last.from && x.to <= last.to)) {
    out.push(`  阶段 ${p.n} · 第 ${p.from}–${p.to} 步 · ${clip(p.short, PHASE_LINE_W, true)}${p.effect ? ` · ${clip(p.effect, LINE_W, true)}` : ''}`);
  }
  const chTo = last.to;
  const phTo = (v.phases || []).reduce((m, p) => Math.max(m, p.to), 0);
  if (chTo < phTo) out.push(`未成章：第 ${chTo + 1}–${phTo} 步有阶段说明但还没写进章（chapters --digest → chapters --put）。`);
  if (phTo < v.mainSteps) out.push(`尾段：第 ${phTo + 1}–${v.mainSteps} 步还没有阶段说明（尾段还在长，或还没写）——这些步只有块层与原文可查。`);
  out.push(...requestLines(requests));
  out.push('查法：handoff（接手一页）· brief --chapter n（九格）· brief --phase n（六格＋块表）· steps（全块）· body Sxx（逐字原文）');
  return out.join('\n') + '\n';
}

/** 一次调用能装下的"我在哪、前面每段干了什么、下一跳查哪"。 */
export function briefText(v, requests = []) {
  const pending = requests.filter((r) => !r.done).length;
  const ch = v.chapters || [];
  if (ch.length) return chapterBriefText(v, requests, ch, pending);
  const out = [headLine(v, pending), currentLine(v)];
  const ph = v.phases || [];
  if (!ph.length) {
    out.push('阶段：还没有阶段说明（取材：digest --phases → 写：phases --put；没有就如实空着，不编）。');
  }
  for (const p of ph) {
    out.push(`阶段 ${p.n} · 第 ${p.from}–${p.to} 步 · 块 ${p.fromBlock}–${p.toBlock} · ${p.span} · ${clip(p.short, PHASE_LINE_W, true)}`);
    if (p.doing) out.push(`  做了：${clip(p.doing, LINE_W, true)}`);
    if (p.effect) out.push(`  成了：${clip(p.effect, LINE_W, true)}`);
  }
  const covered = ph.length ? Math.max(...ph.map((p) => p.to)) : 0;
  if (covered < v.mainSteps) {
    out.push(`尾段：第 ${covered + 1}–${v.mainSteps} 步还没有阶段说明（尾段还在长，或还没写）——这些步只有块层与原文可查。`);
  }
  out.push(...requestLines(requests));
  out.push('查法：brief --phase n（六格＋块表）· steps（全块）· find <词>（原文检索）· body Sxx（逐字原文）· requests --pending');
  return out.join('\n') + '\n';
}

const NINE = [['goal', '一开始的目的'], ['where', '走到哪'], ['rules', '核心规则与原则'], ['tasks', '主要任务'],
  ['walls', '碰过的壁'], ['cautions', '接下来要注意'], ['arch', '架构现状'], ['handoff', '怎么接手']];

/** 二级：某一章的九格逐字 + 该章的阶段一览 + 回读入口。 */
export function chapterDetailText(v, n) {
  const c = (v.chapters || []).find((x) => x.n === n);
  if (!c) {
    return { error: `没有章 ${n}：账本里只有 1–${(v.chapters || []).length} 章（没写过就先 chapters --digest 取材、chapters --put 落盘）` };
  }
  const out = [
    `章 ${c.n} · 第 ${c.from}–${c.to} 步 · 块 ${c.fromBlock}–${c.toBlock} · ${c.phaseSpan} · ${c.short}`,
    `basis=model（归纳，不过六条判据）${c.at ? ` · 写于 ${atCell(c.at)}` : ''}`,
  ];
  for (const [k, label] of NINE) out.push(`${label}：${c[k] || '—'}`);
  out.push(`计数：块${c.blocks}${c.side ? `（含插曲 ${c.side}）` : ''} 段${c.segs.length} 证${c.verified} 写${c.wrote} 留问${c.open} 报错${c.errs} 规则${(c.ruleMoves || []).length}`);
  out.push('阶段一览：');
  for (const p of (v.phases || []).filter((x) => x.from >= c.from && x.to <= c.to)) {
    out.push(`  阶段 ${p.n} · 第 ${p.from}–${p.to} 步 · ${p.short}`);
  }
  const refs = (c.refs || []).map((r) => `${r.f} › ${r.h}`);
  out.push(`引用：${refs.length ? refs.join('；') : '无'}`);
  const first = (v.steps.find((x) => x.i === c.fromBlock) || {}).segIds?.[0] || c.span.split('–')[0];
  out.push(`查原文：convledger body ${first} · 细看某一程：convledger brief --phase ${c.phaseNs?.[0] ?? ''}`);
  return { text: out.join('\n') + '\n', chapter: c };
}

/** 给接手人的一页：可以直接粘进新会话。默认最后一个已写章；all 给全部（有预算提示）。 */
export function handoffText(v, which) {
  const ch = v.chapters || [];
  if (!ch.length) {
    return { error: '还没有写过章：这一页要的是"几十步一程"的接手说明。取材 chapters --digest，落盘 chapters --put；没写过就如实没有。' };
  }
  if (which === 'all') {
    const out = [`# 接手页 · 全 ${ch.length} 章（会话 ${String(v.meta?.session || '').slice(0, 8)} · ${v.meta?.segs ?? '?'} 段 / ${v.steps.length} 块 / ${v.mainSteps} 步）`];
    for (const c of ch) out.push(chapterDetailText(v, c.n).text.trimEnd(), '');
    const text = out.join('\n') + '\n';
    return { text, tokens: Math.round(tok(text)), chapters: ch.length };
  }
  const n = Number(which ?? ch[ch.length - 1].n);
  const r = chapterDetailText(v, n);
  if (r.error) return r;
  return { text: r.text, tokens: Math.round(tok(r.text)), chapter: r.chapter };
}

/** 第二级：某个阶段的六格逐字 + 块表，供再往下挑块/段。 */
export function phaseDetailText(v, n) {
  const p = (v.phases || []).find((x) => x.n === n);
  if (!p) {
    return { error: `没有阶段 ${n}：账本里只有 1–${(v.phases || []).length} 阶段（没写过就先 digest --phases 取材、phases --put 落盘）` };
  }
  const rules = (p.rules || []).map((r) => r.text);
  const refs = (p.refs || []).map((r) => `${r.f} › ${r.h}`);
  const out = [
    `阶段 ${p.n} · 第 ${p.from}–${p.to} 步 · 块 ${p.fromBlock}–${p.toBlock} · ${p.span} · ${p.short}`,
    `basis=model（归纳，不过六条判据）${p.at ? ` · 写于 ${atCell(p.at)}` : ''}`,
    `做了：${p.doing}`,
    `进度：${p.state}`,
    `成了：${p.effect}`,
    `对照：${p.plan}`,
    `进度文件：${p.track}`,
    `规则：${rules.length ? rules.join('；') : '本阶段没有过判据的规则'}`,
    `引用：${refs.length ? refs.join('；') : '无'}`,
    '块表：',
  ];
  for (const s of v.steps.filter((x) => (p.blockIds || []).includes(x.i))) {
    out.push(`  ${String(s.i).padStart(3)} ${stepCell(s).padStart(6)} ${String(s.span || '').padEnd(12)} 支${s.tasks}${s.verified ? ` 证${s.verified}` : ''} 「${blockTitle(s)}」`);
  }
  const first = (v.steps.find((x) => x.i === p.fromBlock) || {}).segIds?.[0] || p.span.split('–')[0];
  out.push(`查原文：convledger body ${first}（逐字回源；按词找别处：convledger find <词>）`);
  return out.join('\n') + '\n';
}

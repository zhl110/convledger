// L4 semantic layer: what a segment ADDED to the thread. The tool never calls a
// model, so the authorship lives outside it — an agent reads `prove` material and
// writes a claim, and this module's whole job is to decide whether that claim is
// provable from the segment's own bytes. Anti-invention
// rules (src/lib/ladder.ts:83): the topic must appear verbatim inside the
// takeaway, and the takeaway must say what this step adds, not what the earlier
// plaques already said.
import fs from 'node:fs';
import { readJsonl, blocksOf, resultText, stripInjected, tok } from './lib.mjs';
import { normalizeRecords } from './project.mjs';
import { CLAIM_SENTENCE_CAP, CLAIM_RESULT_CITABLE_CAP, CLAIM_THREAD_TAKEAWAYS, CLAIM_TOPIC_MAX, CLAIM_TAKEAWAY_MAX, REVISION_SHARE } from './cost.mjs';

/** The cognitive moves. Five are standard; `rule` is the sixth added here
 *  (tool/PRD-parts.md §五 ①) because "有哪些规则要遵守" had no source: a rule the
 *  session actually stated is an increment like any other, so it cites the same
 *  numbered sentence and passes the same six checks — no separate, weaker gate. */
export const MOVES = ['insight', 'ruleout', 'decision', 'pivot', 'open', 'rule'];

// The runner's log is append-only and large, so cache the parse against mtime:
// a new mtime means new bytes, and the ranges we read are already-written lines.
// The key carries the runner because the cache holds the NORMALIZED view, which
// differs per runner for the same path (a log copied between roots, or a test
// fixture read once as itself and once through another adapter).
const RAW = new Map();
function records(sourceFile, runner) {
  const key = `${runner ?? ''}|${sourceFile}`;
  const mtime = fs.statSync(sourceFile).mtimeMs;
  const hit = RAW.get(key);
  if (hit && hit.mtime === mtime) return hit.records;
  const recs = normalizeRecords(runner, readJsonl(sourceFile));
  RAW.set(key, { mtime, records: recs });
  return recs;
}

/** tool_use id -> its result text and the record that carries it: a result usually
 *  lands on the line AFTER its call, which can be outside the segment's range, so
 *  the pair is collected across the whole file. */
function resultsOf(ledger) {
  const map = new Map();
  for (const r of records(ledger.sourceFile, ledger.runner)) {
    for (const b of blocksOf(r)) if (b?.type === 'tool_result') map.set(b.tool_use_id, { text: resultText(b), line: r.__line });
  }
  return map;
}

/**
 * The only ground a claim may cite: this segment's own words, numbered from 1.
 * One line = one citable sentence, because a markdown reply makes one point per
 * line and line granularity is what makes the revision overlap mean something.
 * The caps cut the citable list, not the numbering, so `prove` and `validate`
 * always agree on which indices exist.
 *
 * Prose and tool results are charged to SEPARATE budgets, and the result budget is
 * spent by value rather than by arrival order. One shared budget let a 30K-char
 * report dump push the segment's own conclusions out of the pool — the fat read
 * segments had nothing left to cite. A result line is citable only when it carries
 * an address (`file.ext:46`), because that is the code-level fact a card has to
 * point at; lines carrying an address this segment is already recorded for
 * (`seg.codeRefs`) are admitted first, so the citable pool holds the segment's
 * routing surface instead of the head of whichever dump came first.
 */
const ADDRESS_RE = /[\w.\-\/\\]{2,60}?\.[A-Za-z][A-Za-z0-9]{1,5}(?::\d{1,5})?/;
const RESULT_LINE_SHOW = 200;

export function sentencesOf(ledger, seg, cap = CLAIM_SENTENCE_CAP) {
  const results = resultsOf(ledger);
  const refs = (seg.codeRefs ?? []).map((r) => String(r).split(':')[0].toLowerCase()).filter((r) => r.length > 3);
  const prose = [];
  const resultLines = [];
  let seq = 0;
  const collect = (who, line, rawText, extra = {}) => {
    for (const t of String(rawText ?? '').split('\n')) {
      const full = t.trim();
      if (!full) continue;
      const text = full.length > RESULT_LINE_SHOW && extra.clip ? `${full.slice(0, RESULT_LINE_SHOW)}…` : full;
      const item = { seq: seq++, who, line, text, ...extra };
      (who === 'result' ? resultLines : prose).push(item);
    }
  };
  for (const r of records(ledger.sourceFile, ledger.runner)) {
    if (r.__line < seg.lineFrom) continue;
    if (r.__line > seg.lineTo) break;
    if (r.type !== 'user' && r.type !== 'assistant' && r.type !== 'system') continue;
    const who = r.type === 'assistant' ? 'assistant'
      : r.type === 'system' ? 'system'
      : r.isCompactSummary ? 'compact'
      : r.humanInput ? 'user' : 'tool-ack';
    for (const b of blocksOf(r)) {
      if (b?.type === 'text') {
        // strip the runner's injected context from what the human typed; a compact
        // summary is itself the content, so it stays whole
        collect(who, r.__line, who === 'user' ? stripInjected(b.text ?? '') : String(b.text ?? ''), r.isCompactSummary ? { compact: true } : {});
      } else if (b?.type === 'tool_use') {
        const res = results.get(b.id);
        // only a receipt that landed inside the range is under this segment's anchor
        if (!res || res.line > seg.lineTo) continue;
        for (const t of String(res.text).split('\n')) {
          const full = t.trim();
          if (full && ADDRESS_RE.test(full)) collect('result', r.__line, full, { call: b.name, clip: true, ...(res.line !== r.__line ? { rline: res.line } : {}) });
        }
      }
    }
  }
  let dropped = 0;
  const admit = (list, limit) => {
    const keep = [];
    let used = 0;
    for (const x of list) {
      if (used + x.text.length > limit) { dropped++; continue; }
      used += x.text.length;
      limit -= x.text.length;
      keep.push(x);
    }
    return { keep, used };
  };
  const { keep: proseKeep, used: chars } = admit(prose, cap);
  // one result budget, spent twice: the segment's own recorded addresses first,
  // whatever is left on the rest in document order
  const isHot = (x) => refs.some((r) => x.text.toLowerCase().includes(r));
  const hot = admit(resultLines.filter(isHot), CLAIM_RESULT_CITABLE_CAP);
  const cold = admit(resultLines.filter((x) => !isHot(x)), CLAIM_RESULT_CITABLE_CAP - hot.used);
  const resultKeep = [...hot.keep, ...cold.keep];
  const resultChars = resultKeep.reduce((a, x) => a + x.text.length, 0);
  const sentences = [...proseKeep, ...resultKeep]
    .sort((a, b) => a.seq - b.seq)
    .map(({ seq: _q, ...s }, n) => ({ i: n + 1, ...s }));
  return { sentences, dropped, chars, resultChars };
}

/**
 * Everything the segment actually contains, for the "is this fact invented"
 * lookup: prose plus tool arguments plus the results those calls got. Thinking is
 * deliberately NOT ground — it is private reasoning, so a token found only there
 * cannot be shown to anyone.
 */
export function groundText(ledger, seg) {
  const results = resultsOf(ledger);
  const parts = [];
  for (const r of records(ledger.sourceFile, ledger.runner)) {
    if (r.__line < seg.lineFrom) continue;
    if (r.__line > seg.lineTo) break;
    if (r.type !== 'user' && r.type !== 'assistant' && r.type !== 'system') continue;
    for (const b of blocksOf(r)) {
      if (b?.type === 'text') parts.push(String(b.text ?? ''));
      else if (b?.type === 'tool_use') {
        parts.push(JSON.stringify(b.input ?? {}));
        const res = results.get(b.id);
        if (res) parts.push(res.text);
      } else if (b?.type === 'tool_result') parts.push(resultText(b));
    }
  }
  return parts.join('\n');
}

/** Numbers, versions, paths, quoted identifiers, snake/camel names, segment ids.
 *  These are the parts of a takeaway that can be checked for existence, which is
 *  why the ladder makes the author cite them. */
const FACT_PATTERNS = [
  /\d[\w.%-]{0,9}/g, // 6.3% / 12000 / 457MB / 0.4
  /`([^`\n]{1,40})`/g, // `deriveClaim`
  /[\w.\-\/\\]{2,60}?\.[A-Za-z][A-Za-z0-9]{1,5}\b/g, // src/cards.mjs / PRD-claims.md
  /\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/g, // camelCase
  /\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/g, // snake_case
  /\bS\d{2,}\b/g, // S07
];

export function factTokens(text) {
  const out = new Set();
  const str = String(text ?? '');
  for (const re of FACT_PATTERNS) {
    for (const m of str.matchAll(re)) {
      const t = (m[1] ?? m[0]).trim();
      if (t.length > 1) out.add(t);
    }
  }
  return [...out];
}

export const norm = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();
/** A fact is "in the segment" if the bytes are there verbatim, allowing only for
 *  thousands separators, which writers move around and facts do not. */
export function containsVerbatim(haystack, needle) {
  if (haystack.includes(needle)) return true;
  const h = haystack.replace(/,/g, '');
  return h.includes(needle.replace(/,/g, ''));
}

/** Overlap between two claims, in the spirit of a shared-sentence
 *  share: latin/digit runs plus CJK bigrams (no segmenter, deterministic). */
export function shape(s) {
  const set = new Set();
  const str = String(s ?? '');
  for (const m of str.matchAll(/[A-Za-z0-9_.%-]{2,}/g)) set.add(m[0].toLowerCase());
  const cjk = str.match(/[㐀-鿿぀-ヿ]/g) ?? [];
  for (let i = 0; i < cjk.length - 1; i++) set.add(cjk[i] + cjk[i + 1]);
  return set;
}
export function overlapShare(a, b) {
  const sa = shape(a);
  const sb = shape(b);
  if (!sa.size || !sb.size) return 0;
  let shared = 0;
  for (const x of sb) if (sa.has(x)) shared++;
  return shared / sb.size;
}

/** Everything one validation needs, built once so `prove` and `claim` agree. */
export function materials(ledger, seg, prevClaim) {
  const { sentences, dropped, chars, resultChars } = sentencesOf(ledger, seg);
  return { seg, sentences, dropped, chars, resultChars, ground: groundText(ledger, seg), prev: prevClaim ?? null };
}

/**
 * The six checks, in order, each with the message the author sees. Passing these
 * is the ONLY way a claim's basis becomes 'verified' — self-declaration is not a
 * proof, which is the difference between this and the M1 rule placeholder.
 */
export function validateClaim(claim, m) {
  const errors = [];
  const c = claim ?? {};
  const move = String(c.move ?? '').toLowerCase();
  const topic = String(c.topic ?? '').trim();
  const takeaway = String(c.takeaway ?? '').trim();
  const evidence = Array.isArray(c.evidence) ? c.evidence : [];

  if (!MOVES.includes(move)) errors.push(`move 不是六类之一(${MOVES.join('/')}): ${c.move ?? '（空）'}`);
  if (!topic) errors.push('topic 为空：增量必须有个可指的名字');
  if (!takeaway) errors.push('takeaway 为空：要说这一步加了什么');
  if (topic && takeaway && !norm(takeaway).includes(norm(topic))) {
    errors.push(`topic「${topic}」没有逐字出现在 takeaway 里`);
  }
  if (tok(topic) > CLAIM_TOPIC_MAX) errors.push(`topic ${tok(topic)}t 超上限 ${CLAIM_TOPIC_MAX}t：不是个能路由的把手`);
  if (tok(takeaway) > CLAIM_TAKEAWAY_MAX) errors.push(`takeaway ${tok(takeaway)}t 超上限 ${CLAIM_TAKEAWAY_MAX}t：卡上会被截，等于没写`);

  const byI = new Map(m.sentences.map((s) => [s.i, s]));
  const bad = evidence.filter((i) => !byI.has(Number(i)));
  if (!evidence.length) errors.push('evidence 为空：没有引用就不算有据');
  if (bad.length) errors.push(`evidence 编号解不到本段句子(1-${m.sentences.length}${m.dropped ? `，另有 ${m.dropped} 行超出引用预算未编号` : ''}): ${bad.join(',')}`);
  const facts = factTokens(takeaway);
  if (evidence.length && facts.length) {
    const cited = evidence.map((i) => byI.get(Number(i))).filter(Boolean).map((s) => s.text).join('\n');
    if (!facts.some((f) => containsVerbatim(norm(cited), norm(f)))) {
      errors.push('evidence 引用的句子里没有一个含 takeaway 的事实 token：引的和说的不是一回事');
    }
  }
  const invented = facts.filter((f) => !containsVerbatim(m.ground, f));
  if (invented.length) errors.push(`编造嫌疑: ${invented.slice(0, 6).join(' / ')} — 本段原文里逐字找不到`);

  const revision = m.prev?.takeaway ? overlapShare(m.prev.takeaway, takeaway) >= REVISION_SHARE : false;
  return { ok: !errors.length, errors, revision, facts, move, topic, takeaway, evidence: evidence.map(Number) };
}

/** The judgement, printed — not a prompt. The rule here is that the shape of the
 *  ask belongs to the caller, so the tool only ever hands over the criteria and
 *  the ground the criteria are checked against. */
export const CLAIM_RULES = [
  `move ∈ ${MOVES.join(' / ')}`,
  `topic 逐字出现在 takeaway 里，且 ≤${CLAIM_TOPIC_MAX}t（它是个把手，不是句子）`,
  `takeaway ≤${CLAIM_TAKEAWAY_MAX}t — 卡上 增量 行只有这么宽，超了等于没写`,
  'evidence 引用下面编号过的句子，至少一句含 takeaway 里的数字/路径/标识符',
  'takeaway 的每个数字、路径、标识符都必须在本段原文里逐字出现（正文、工具参数、工具结果都算），否则按编造拒',
  `与上一段增量重合 ≥${REVISION_SHARE * 100}% 自动标 revision：那是重述，不是新增`,
];

/** What the previous plaque said, so the author can avoid restating it. */
function threadOf(ledger, seg, claims) {
  const idx = ledger.segments.findIndex((x) => x.id === seg.id);
  const out = [];
  for (let i = Math.max(0, idx - CLAIM_THREAD_TAKEAWAYS); i < idx; i++) {
    const p = ledger.segments[i];
    const c = claims[p.id];
    if (c?.text) out.push({ id: p.id, moves: c.moves, basis: c.basis ?? 'reconstructed', takeaway: c.text, ...(c.topic ? { topic: c.topic } : {}) });
  }
  return out;
}

/** The structure this segment is known for, as a hint about what the increment
 *  is likely to be about — never as a substitute for the prose. */
function structureOf(seg) {
  const tools = Object.entries(seg.tools ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}×${v}`);
  const base = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() ?? p;
  return {
    kind: seg.kind,
    toolCalls: seg.toolCalls,
    ...(tools.length ? { tools } : {}),
    ...((seg.filesWritten ?? []).length ? { wrote: seg.filesWritten.map(base).slice(0, 4) } : {}),
    ...((seg.artifacts ?? []).length ? { artifacts: seg.artifacts.map(base).slice(0, 4) } : {}),
    ...(seg.errors?.length ? { errors: seg.errors.slice(0, 2) } : {}),
    ...((seg.branches ?? []).length ? { branches: seg.branches.map((b) => b.description).slice(0, 4) } : {}),
    ...((seg.codeRefs ?? []).length ? { codeRefs: seg.codeRefs.slice(0, 3) } : {}),
  };
}

/** One author's worth of material: the ground, the thread, the structure, the rules. */
export function proveInput(ledger, seg, claims = {}) {
  const prev = [...threadOf(ledger, seg, claims)].pop();
  const m = materials(ledger, seg, prev);
  return {
    segment: seg.id, anchor: seg.anchor,
    turn: seg.turnFrom === seg.turnTo ? `${seg.turnFrom}` : `${seg.turnFrom}-${seg.turnTo}`,
    kind: seg.kind,
    ...(m.dropped ? { dropped: m.dropped } : {}),
    citableChars: m.chars,
    resultChars: m.resultChars,
    rules: CLAIM_RULES,
    thread: threadOf(ledger, seg, claims),
    structure: structureOf(seg),
    sentences: m.sentences,
    how: `convledger claim ${seg.id} --move <${MOVES.join('|')}> --topic <≤${CLAIM_TOPIC_MAX}t 的把手> --takeaway <≤${CLAIM_TAKEAWAY_MAX}t> --evidence 3,7,12`,
  };
}

export function renderProve(p) {
  const L = [`# 写增量 · ${p.segment} ${p.anchor} | ${p.kind} | turn ${p.turn} | ${p.structure.toolCalls ?? 0} 次工具调用`];
  L.push('判据（全过才落 verified，工具自己不会放水）:');
  CLAIM_RULES.forEach((r, i) => L.push(` ${i + 1}. ${r}`));
  if (p.thread.length) {
    L.push('上游牌子（重述它们就是 revision，不是增量）:');
    for (const t of p.thread) L.push(` · ${t.id} [${t.moves}/${t.basis}]${t.topic ? ` 「${t.topic}」` : ''} ${t.takeaway}`);
  }
  const st = p.structure;
  L.push(`结构事实: kind=${st.kind}${st.tools ? ` 动作 ${st.tools.join(' ')}` : ''}${st.wrote ? ` 改过 ${st.wrote.join('、')}` : ''}${st.artifacts && !st.wrote ? ` 产物 ${st.artifacts.join('、')}` : ''}${st.branches ? ` 分支 ${st.branches.length} 个` : ''}${st.errors ? ` 报错 ${st.errors.length} 条` : ''}${st.codeRefs ? ` 提到 ${st.codeRefs.join(' ')}` : ''}`);
  L.push(`可引用句子（${p.sentences.length} 行，正文 ${p.citableChars} 字符 / 回执地址行 ${p.resultChars ?? 0} 字符${p.dropped ? `，另有 ${p.dropped} 行超出预算没编号` : ''}）:`);
  for (const s of p.sentences) L.push(`${s.i}\t[${s.who}${s.call ? `:${s.call}` : ''} L${s.line}${s.rline ? `（回执 L${s.rline}）` : ''}] ${s.text}`);
  L.push(p.how);
  return L.join('\n') + '\n';
}

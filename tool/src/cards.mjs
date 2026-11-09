// L3 route cards. One file per segment; the anchor IS the address, so getting
// back to the body costs one lookup, not a search. Experiment 1 measured that
// 62% of correct answers needed the body — so the card's job is routing
// (what happened here, what it concluded, where to look), not storage.
import { tok, cleanAsk } from './lib.mjs';
import { CARD_TOKEN_CAP } from './cost.mjs';

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
/** A card is a budget of TOKENS, not of characters: CJK costs ~4x what Latin text
 *  does per glyph, so an 80-char Chinese opener silently doubles a card's price.
 *  The cut is found by measuring the prefix with the same estimator the invariants
 *  use — a per-char heuristic under-cuts mixed text, which is how a claim that
 *  passed the 30-token cap still arrived on the card clipped. */
const fit = (s, tokens) => {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (tok(str) <= tokens) return str;
  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tok(str.slice(0, mid)) <= tokens) lo = mid; else hi = mid - 1;
  }
  return str.slice(0, lo);
};

/** Deterministic stand-in for the M2 model layer: what the segment produced,
 *  read off the log itself. Marked reconstructed so nobody mistakes it for a
 *  judged epistemic increment. */
export function deriveClaim(s) {
  const last = s.turns.filter((t) => t.assistantText.trim()).pop();
  // the closing line is often a hand-off ("要我继续吗？"); the informative one is
  // usually the longest of the last few, so pick by mass, not by position.
  const tail = last
    ? last.assistantText.split('\n').filter((l) => l.trim()).slice(-4)
      .map((l) => l.replace(/[*`>#]|^\s*[-|]\s*/g, ' ').replace(/\s+/g, ' ').trim())
      .sort((a, b) => b.length - a.length)[0] ?? ''
    : '';
  const moves = s.interrupt ? 'pivot'
    : s.errors.length ? 'ruleout'
    : s.artifacts.length ? 'decision'
    : s.branches.length ? 'insight'
    : s.kind.startsWith('side-episode') ? 'open'
    : tail ? 'insight' : 'open';
  return {
    text: tail ? clip(tail, 110) : (s.head ? `（无回复文本）开场：${clip(s.head, 80)}` : '（本段无文本产出）'),
    moves,
    basis: tail ? 'reconstructed' : 'unknown',
    completeness: s.artifacts.length || tail.length > 60 ? 'full' : 'partial',
  };
}

/** last two path components — enough to be routable, short enough to stay a route.
 *  The entry itself is capped too: four 130-char hash filenames cost 4x what their
 *  routing value is worth, and counting items is not a price bound. */
const ENTRY_MAX = 40;
const short = (p) => {
  const s = String(p ?? '').split('/').slice(-2).join('/');
  return s.length > ENTRY_MAX ? `${s.slice(0, 28)}…${s.slice(-8)}` : s;
};
/** keep the line citation attached while shortening the path in front of it */
const shortRef = (r) => { const i = r.indexOf(':'); return i < 0 ? short(r) : `${short(r.slice(0, i))}${r.slice(i)}`; };
/** assets carry no facts; listing them spends the card's budget on noise */
const ROUTEABLE_OUT = /\.(png|jpe?g|gif|webp|svg|ico|bmp|mp4|webm|mp3|wav|zip|7z|pdf|lock)$/i;
const routeable = (files, n) => [...new Set(files.filter((p) => !ROUTEABLE_OUT.test(p)))].slice(0, n);

/** A card is a route, so it has a hard price tag. When a segment is too rich to
 *  fit, the least routable lines go first — addresses and conclusions stay. */
const DROP_ORDER = ['动作', '开场', '用户', '受阻', '支源(对应上序号)', '子代理', '改过', '产物', '看过'];

export function renderCard(s, claim, sessionId) {
  const tools = Object.entries(s.tools).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}x${v}`).join(' ');
  const rows = [];
  const push = (tag, text) => { if (text) rows.push({ tag, text }); };
  const L = [];
  L.push(`# ${s.id} ${s.anchor} | ${s.kind} | turn ${s.turnFrom}${s.turnFrom === s.turnTo ? '' : `-${s.turnTo}`} | ${s.toolCalls} 次工具调用 | dlg ${s.tokens.dialogue}t 往返 ${s.tokens.toolRoundTrip}t`);
  L.push(`时间 ${String(s.tsFrom).slice(11, 16)}→${String(s.tsTo).slice(11, 16)}${s.starts.length ? ` | 起因 ${s.starts.join(',')}` : ''}`);
  push('开场', s.head && `开场: ${fit(s.head, 22)}`);
  push('动作', Object.keys(s.tools).length && `动作: ${fit(tools, 25)}${s.envProbe ? ' | 含环境探测命令' : ''}`);
  push('产物', s.artifacts.length && `产物: ${routeable(s.artifacts, 4).map((p) => short(p.split('/').pop())).join(', ')}`);
  push('改过', routeable(s.filesWritten.filter((p) => !s.artifacts.includes(p)), 4).length && `改过: ${routeable(s.filesWritten.filter((p) => !s.artifacts.includes(p)), 4).map(short).join(', ')}`);
  if (routeable([...s.filesRead, ...(s.filesSeen ?? [])], 6).length) push('看过', `看过: ${routeable([...s.filesRead, ...(s.filesSeen ?? [])], 6).map(short).join(', ')}`);
  // the addresses this segment itself wrote down: with these on the card, a later
  // reader goes straight to the body instead of keyword-searching the whole log
  if (s.codeRefs?.length) push('提到', `提到: ${s.codeRefs.slice(0, 3).map(shortRef).join(', ')}`);
  push('增量', `增量(${claim.moves}/${claim.basis}): ${fit(claim.text, 30)}`);
  push('受阻', s.errors.length && `受阻: ${fit(s.errors[0], 25)}`);
  if (s.branches.length) {
    // Ordinals, not repeated names: the branch list is the semantic index of a
    // fan-out and 支源 is its address — paying for the name twice is what blows a card.
    const ORD = '①②③④⑤⑥⑦⑧⑨⑩';
    const br = s.branches.slice(0, 8);
    push('子代理', `子代理: ${br.map((b, i) => `${ORD[i]}${fit(b.description, 12)}`).join(' ')}`);
    const shown = new Set(routeable([...s.artifacts, ...s.filesRead, ...(s.filesSeen ?? [])], 12).map((p) => p.split('/').pop()));
    const used = new Set();
    const src = [];
    let room = 190;
    br.forEach((b, i) => {
      // siblings of one fan-out usually read the same files: list each file once,
      // and stop at an entry boundary rather than mid-path
      const f = routeable(b.files ?? [], 12).filter((p) => !shown.has(p.split('/').pop()) && !used.has(p)).slice(0, 2);
      f.forEach((p) => used.add(p));
      if (!f.length) return;
      const entry = `${ORD[i]}${f.map(short).join(', ')}`;
      if (entry.length + 3 > room) return;
      src.push(entry); room -= entry.length + 3;
    });
    push('支源(对应上序号)', src.length && `支源(对应上序号): ${src.join(' | ')}`);
  }
  if (s.humans.length > 1) push('用户', `用户: ${s.humans.slice(1, 2).map((t) => fit(cleanAsk(t.humanText), 16)).join(' || ')}`);
  push('回补', `回补: convledger body ${s.id} --session ${sessionId}   (锚点 ${s.anchor}, hash ${s.contentHash})`);

  // enforce the price tag: drop the lowest-value lines, say which were dropped
  const dropped = [];
  let body = [...rows];
  const render = () => [body.map((r) => r.text).join('\n'), dropped.length ? `（因卡预算省略: ${dropped.join('、')}，全量在 body）` : null].filter(Boolean).join('\n');
  for (let guard = 0; guard < DROP_ORDER.length; guard++) {
    const text = render();
    if (tok(`${L.join('\n')}\n${text}`) <= CARD_TOKEN_CAP) break;
    const worst = DROP_ORDER.find((tag) => body.some((r) => r.tag === tag));
    if (!worst) break;
    dropped.push(worst);
    body = body.filter((r) => r.tag !== worst);
  }
  return [...L, render()].join('\n') + '\n';
}

export const cardTokens = (card) => tok(card);

/** The routing table: every card header + one-line hook, in one call. */
export function renderIndex(segments, claims, sessionId) {
  const L = [`# 会话账本 ${sessionId}`, `共 ${segments.length} 段 · 每段一张路由卡 → \`card Sxx\`；正文 → \`body Sxx\`（锚点即路径，不用搜）`, ''];
  L.push('| 段 | 锚点 | 定性 | 回合 | 工具 | 一句话 | 卡 |');
  for (const s of segments) {
    const c = claims[s.id];
    // a proved increment routes better than the opener did: "what this step added"
    // is the answer to "which segment holds the fact I need"
    const tools = Object.entries(s.tools).map(([k, v]) => `${k}x${v}`).join(' ');
    const hook = c?.basis === 'verified' ? fit(c.text, 16) : (s.head ? fit(s.head, 16) : fit(tools, 16));
    L.push(`| ${s.id} | ${s.anchor} | ${s.kind} | ${s.turnFrom}${s.turnFrom === s.turnTo ? '' : `-${s.turnTo}`} | ${s.toolCalls} | ${hook} | body ${s.id} |`);
  }
  return L.join('\n') + '\n';
}

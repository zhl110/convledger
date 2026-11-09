// L2 rule layer: cut the turn stream into segments and label them, with every
// decision carried as a printed rule id. Zero model calls — the semantic layer
// (which segment hangs under which) is M2 and plugs in via claims.json.
import { tok, codeRefsIn, cleanAsk, ARTIFACT_TOOLS, LOOK_TOOLS, toolOpOf } from './lib.mjs';

export const RULES = [
  { id: 'open-on-human', text: 'a segment opens at a human-input turn or at a compact-summary turn' },
  { id: 'split-fanout', text: 'a turn with >=3 tool calls of the same name opens its own segment (parallel fan-out)' },
  { id: 'split-bigread', text: 'a turn whose tool results exceed 20000 bytes opens its own segment (one deep investigation)' },
  { id: 'split-interrupt', text: 'a turn whose text contains "[Request interrupted" opens its own segment and marks a pivot' },
  { id: 'branch-attach', text: 'a segment whose turns host subagent branches is labelled fan-out and keeps its host as parent' },
  { id: 'kind-artifact', text: 'segment produces an artifact (Write/Edit/present_visualization/ImageGen) => mainline' },
  { id: 'kind-look', text: 'segment is only Read/Grep/Glob/search/probe with no artifact => side-episode (临时查询)' },
  { id: 'kind-setup', text: 'segment is Bash installing or probing the environment => side-episode (中途装工具)' },
  { id: 'kind-report', text: 'segment ends in an assistant reply >=3000 chars => mainline (conclusion)' },
  { id: 'session-open', text: 'the first segment of a session is the opening brief => mainline, whatever it did' },
  { id: 'env-probe-signals', text: 'environment-probe signal words (node -v / where X / npm view / --version / which X) => setup-episode candidate, no model needed' },
];

export const ENV_PROBE_RE = /\b(node|npm|pnpm|python|pip|git) -v\b|--version|\bwhere \w+\b|\bwhich \w+\b|npm view|dist-tags|plugins-cache|\.dsh|凭据/;

const isInterrupt = (t) => /Request interrupted/i.test(t.humanText || '') || t.toolCalls.some((c) => /tool use was rejected|rejected the tool/i.test(c.resultHead));

export function segment(turns, branches = []) {
  const hosts = new Map();
  for (const b of branches) if (b.parentTurn) hosts.set(b.parentTurn, [...(hosts.get(b.parentTurn) ?? []), b]);

  // ---- pass 1: cut ----
  const segs = [];
  let cur = null;
  for (const t of turns) {
    if (t.sidechain) continue; // child transcripts are branches, not mainline turns
    const sameName = {};
    for (const c of t.toolCalls) sameName[c.name] = (sameName[c.name] ?? 0) + 1;
    const fanout = Object.entries(sameName).filter(([, n]) => n >= 3).map(([n, k]) => `${k}x${n}`);
    const bigread = t.toolResultBytes > 20000;
    const interrupt = isInterrupt(t);
    const opens = t.kind === 'human' || t.kind === 'compact-summary';
    const why = [];
    if (opens) why.push('open-on-human');
    if (fanout.length) why.push('split-fanout:' + fanout.join('/'));
    if (bigread) why.push('split-bigread');
    if (interrupt) why.push('split-interrupt');
    if (!cur || why.length) {
      cur = { id: 'S' + String(segs.length + 1).padStart(2, '0'), turns: [], starts: why, interrupt };
      segs.push(cur);
    }
    cur.turns.push(t);
  }

  // ---- pass 2: anchors, cost, label ----
  for (const [i, s] of segs.entries()) {
    const first = s.turns[0];
    const last = s.turns[s.turns.length - 1];
    s.lineFrom = first.line; s.lineTo = last.line;
    s.turnFrom = first.n; s.turnTo = last.n;
    s.uuidFrom = first.uuid; s.uuidTo = last.uuid;
    s.tsFrom = first.ts; s.tsTo = last.ts;
    s.isCompactSummary = s.turns.some((t) => t.kind === 'compact-summary');
    s.humans = s.turns.filter((t) => t.kind === 'human');
    // the label is the first human turn that says something ONCE injected context
    // blocks are stripped — a turn that was only <ide_opened_file> is not an ask
    s.head = (s.humans.map((t) => cleanAsk(t.humanText)).find((x) => x.length > 2) ?? '').slice(0, 160);
    const names = {};
    for (const t of s.turns) for (const c of t.toolCalls) names[c.name] = (names[c.name] ?? 0) + 1;
    s.tools = names;
    s.toolCalls = Object.values(names).reduce((a, b) => a + b, 0);
    s.artifacts = [...new Set(s.turns.flatMap((t) => t.toolCalls).filter((c) => ARTIFACT_TOOLS.has(c.name)).flatMap((c) => c.paths))];
    // file inventory: which files this segment looked at, which it changed. This is
    // what makes a code-level fact routable without putting the fact in the card.
    const allCalls = s.turns.flatMap((t) => t.toolCalls);
    s.filesRead = [...new Set(allCalls.filter((c) => ['read', 'search', 'fetch'].includes(c.op)).flatMap((c) => c.paths))];
    s.filesWritten = [...new Set(allCalls.filter((c) => ['write', 'edit'].includes(c.op)).flatMap((c) => c.paths))];
    // named by a result rather than asked for by an arg — how a grep/wc actually finds a file
    const touched = new Set([...s.filesRead, ...s.filesWritten, ...allCalls.flatMap((c) => c.paths)]);
    s.filesSeen = [...new Set(allCalls.flatMap((c) => c.resultFiles ?? []))].filter((p) => !touched.has(p));
    // file:line citations the conversation itself wrote down (in replies, in tool
    // results, in the user's own words). Ranked by how often they repeat: the ones
    // a segment kept coming back to are the ones worth a card's space.
    const refTally = new Map();
    const bumpRef = (r) => refTally.set(r, (refTally.get(r) ?? 0) + 1);
    for (const t of s.turns) {
      for (const r of codeRefsIn(t.humanText, 6)) bumpRef(r);
      for (const r of codeRefsIn(t.assistantText, 6)) bumpRef(r);
      for (const c of t.toolCalls) for (const r of c.resultRefs ?? []) bumpRef(r);
    }
    s.codeRefs = [...refTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([r]) => r);
    s.errors = s.turns.flatMap((t) => t.toolCalls).filter((c) => c.isError).map((c) => `${c.name}: ${c.resultHead.slice(0, 90)}`);
    s.envProbe = s.turns.flatMap((t) => t.toolCalls).some((c) => ENV_PROBE_RE.test(c.arg));
    s.branches = s.turns.flatMap((t) => hosts.get(t.n) ?? []).map((b) => ({
      description: b.description, link: b.link, agentFile: b.agentFile ?? null,
      files: (b.files ?? []).slice(0, 12), toolCalls: b.toolCalls ?? 0,
    }));
    // files the fan-out children opened — the address for code-level facts that
    // the mainline only quotes, never reads itself
    s.branchFiles = [...new Set(s.branches.flatMap((b) => b.files))];
    s.chars = {
      human: s.turns.reduce((a, t) => a + t.humanText.length, 0),
      assistant: s.turns.reduce((a, t) => a + t.assistantText.length, 0),
      thinking: s.turns.reduce((a, t) => a + t.thinkingChars, 0),
      toolArgs: s.turns.reduce((a, t) => a + t.toolCalls.reduce((x, c) => x + (c.argChars ?? 0), 0), 0),
      toolResults: s.turns.reduce((a, t) => a + t.toolResultBytes, 0),
    };
    s.tokens = { dialogue: tok(s.turns.map((t) => t.humanText + '\n' + t.assistantText).join('\n')), toolRoundTrip: Math.round((s.chars.toolArgs + s.chars.toolResults) / 4) };
    if (!s.head) {
      const calls = s.turns.flatMap((t) => t.toolCalls).map((c) => `${c.name} ${c.arg}`).filter((x) => x.length > 12);
      s.head = calls.length ? calls.reduce((a, b) => (b.length > a.length ? b : a), '') : (s.turns.map((t) => t.assistantText).join(' ').replace(/\s+/g, ' ').slice(0, 120));
    }
    s.kind = label(s, i === 0);
    s.anchor = `L${s.lineFrom}-${s.lineTo}`;
  }

  // ---- parent inference: continuation of what, by line order ----
  for (let i = 1; i < segs.length; i++) {
    const s = segs[i];
    s.attachUnder = s.kind === 'side-episode (临时查询)' || s.kind === 'side-episode (中途装工具)' ? segs[i - 1].id : null;
    s.parentSegment = s.starts.includes('open-on-human') ? null : segs[i - 1].id;
  }
  return segs;
}

function label(s, isFirst = false) {
  if (s.isCompactSummary) return 'boundary';
  if (isFirst) return 'mainline (开场所求)';
  if (s.interrupt) return 'pivot/interrupted';
  if (s.branches.length) return 'fan-out (subagents)';
  const names = Object.keys(s.tools);
  if (names.some((n) => ARTIFACT_TOOLS.has(n))) return 'mainline';
  if (s.envProbe && names.every((n) => toolOpOf(n) === 'run' || LOOK_TOOLS.has(n))) return 'side-episode (中途装工具)';
  if (names.length && names.every((n) => LOOK_TOOLS.has(n) || toolOpOf(n) === 'run')) return 'side-episode (临时查询)';
  if (s.turns.some((t) => t.assistantText.length >= 3000)) return 'mainline (结论)';
  return 'continuation';
}

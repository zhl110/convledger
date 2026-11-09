// Task branches and the topic layer. Design, evidence and acceptance: tool/PRD-topics.md.
//
// Branches are pure structure — no model, no new prose. A branch is the run of segments
// opened by a human ask or a pivot; a compaction never opens one (that is what made the
// map read as a restart, see #37).
//
// Topics are an EXTERNAL label table keyed by (session, turn): labels annotate
// segments and never rewrite the chain, so one segment can carry several and a
// re-scan stays idempotent.
import fs from 'node:fs';
import path from 'node:path';
import { norm } from './claims.mjs';
import { TOPIC_NAME_MAX, MAX_TOPICS_PER_SEGMENT, MIN_SEGMENTS_PER_TOPIC } from './cost.mjs';
import { tok } from './lib.mjs';

// The four levels are an evidence ladder, not a score: each one names the structural
// fact that earned it. The ladder gates `verified` on a result appearing inside the
// same exchange rather than on the model's self-report.
export const BRANCH_STATES = [
  { level: 0, id: 'speculative', label: '未证', earnedBy: '无已证增量、无落地物' },
  { level: 1, id: 'leaning', label: '已想清', earnedBy: '段内有 basis:verified 的增量' },
  { level: 2, id: 'definite', label: '已落地', earnedBy: '段内写过文件（filesWritten）' },
  { level: 3, id: 'verified', label: '已复核', earnedBy: '写出的文件被后续任务回读' },
];

const baseName = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() ?? '';

/** `open` is one of the claim moves (src/claims.mjs MOVES): an increment that leaves a
 *  question standing. It is the only structural trace of "遗留" the ledger has.
 *  A stored claim carries ONE move (`moves: r.move`, cli.mjs) — a string, not an array —
 *  so every reader must normalise through here; view.mjs once wrote `Array.isArray ? : []`
 *  and silently lost the seals. */
export const movesOf = (c) => (Array.isArray(c?.moves) ? c.moves : String(c?.moves ?? '').split(/[,\s]+/)).filter(Boolean);

/** Whether a branch has finished is NOT knowable; what IS knowable is reported:
 *  live = it holds the newest segment, blocked/asking = its tail errored / left a
 *  question, handed-off = a later ask exists and the tail left neither. */
function closedOf(r, segs, claims) {
  const tail = r.items[r.items.length - 1];
  if (tail.i === segs.length - 1) return 'live';
  if ((tail.seg.errors ?? []).length) return 'blocked';
  if (movesOf(claims[tail.seg.id]).includes('open')) return 'asking';
  return 'handed-off';
}

export const CLOSED_LABELS = { live: '进行中', blocked: '末段受阻', asking: '末段留问', 'handed-off': '已交棒' };

/** The one rule for where a branch starts. view.mjs and the map both call this. */
export function opensBranch(seg, i) {
  return i === 0 || (!seg.isCompactSummary && (seg.starts.includes('open-on-human') || seg.kind.startsWith('pivot')));
}

/** Did a LATER TASK come back to a file this branch wrote? Exact path, or the same
 *  file name inside a `path:line` codeRef — never a fuzzy match.
 *
 *  The scan starts past this branch's last segment on purpose. Measured on the live
 *  session (76 segs / 41 branches): letting the same branch count put 21/41 at 已复核,
 *  because 35 of those hits were the very next segment — that is the edit-verify loop
 *  proving the file compiles, not proving the work was reviewed. Requiring a reader from
 *  a later branch holds 19/41, and those 19 are artifacts that outlived their own task.
 *  Tighter than before, so it is a criterion change on evidence, not a loosened threshold. */
function readBackLater(segs, wroteBy, after) {
  for (const [file, writerIdx] of wroteBy) {
    for (let j = Math.max(writerIdx + 1, after); j < segs.length; j++) {
      const later = segs[j];
      if ((later.filesRead ?? []).includes(file)) return { file, at: later.id };
      const name = baseName(file);
      if ((later.codeRefs ?? []).some((r) => baseName(String(r).split(':')[0]) === name)) return { file, at: later.id };
    }
  }
  return null;
}

export function deriveBranches(ledger, claims = {}) {
  const segs = ledger.segments;
  const runs = [];
  segs.forEach((s, i) => {
    if (opensBranch(s, i) || !runs.length) runs.push({ head: s.id, items: [], first: i });
    runs[runs.length - 1].items.push({ seg: s, i });
  });

  const branches = runs.map((r, n) => {
    const ids = r.items.map((x) => x.seg.id);
    const verified = ids.filter((id) => claims[id]?.basis === 'verified');
    const open = ids.filter((id) => movesOf(claims[id]).includes('open'));
    const errs = r.items.filter((x) => (x.seg.errors ?? []).length);
    const wroteBy = new Map(); // file -> earliest segment index that wrote it
    for (const { seg, i } of r.items) for (const f of seg.filesWritten ?? []) if (!wroteBy.has(f)) wroteBy.set(f, i);
    const back = readBackLater(segs, wroteBy, r.items[r.items.length - 1].i + 1);
    const level = wroteBy.size && back ? 3 : wroteBy.size ? 2 : verified.length ? 1 : 0;
    return {
      id: `B${String(n + 1).padStart(2, '0')}`,
      head: r.head,
      tail: r.items[r.items.length - 1].seg.id,
      segments: ids,
      turnFrom: r.items[0].seg.turnFrom,
      turnTo: r.items[r.items.length - 1].seg.turnTo,
      calls: r.items.reduce((a, x) => a + x.seg.toolCalls, 0),
      rt: r.items.reduce((a, x) => a + (x.seg.tokens?.toolRoundTrip ?? 0), 0),
      verified,
      open,
      errs: errs.map((x) => x.seg.id),
      wrote: [...wroteBy.keys()],
      readBack: back,
      blocked: errs.length > 0,
      closed: closedOf(r, segs, claims),
      state: BRANCH_STATES[level].id,
      stateLabel: BRANCH_STATES[level].label,
      level,
    };
  });

  const byState = Object.fromEntries(BRANCH_STATES.map((s) => [s.id, branches.filter((b) => b.state === s.id).length]));
  const of = {};
  for (const b of branches) for (const id of b.segments) of[id] = b.id;
  return { branches, branchOf: of, byState, count: branches.length };
}

export function readTopics(dir) {
  const f = path.join(dir, 'topics.json');
  if (!fs.existsSync(f)) return { schema: 'convledger-topics/1', topics: [], labels: {} };
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

export function writeTopics(dir, t) {
  fs.writeFileSync(path.join(dir, 'topics.json'), JSON.stringify({ ...t, built: new Date().toISOString() }, null, 1) + '\n');
}

/** Assign topic `tname` to segment `segId`. Refuses anything the segment's own bytes
 *  cannot support: the label must appear verbatim in a verified increment for that
 *  segment (same discipline as validateClaim's topic rule, src/claims.mjs:221). */
export function validateLabel({ segId, tname, ledger, claims, topics }) {
  const errors = [];
  const seg = ledger.segments.find((s) => s.id === segId);
  if (!seg) return { ok: false, errors: [`没有段 ${segId}`] };
  const entry = claims[segId];
  if (!entry || entry.basis !== 'verified') {
    errors.push(`${segId} 的增量不是 verified（当前 ${entry?.basis ?? '无'}）：没证过的认识不能当分支依据`);
  }
  const name = String(tname ?? '').trim();
  if (!name) errors.push('话题名为空');
  else {
    if (tok(name) > TOPIC_NAME_MAX) errors.push(`话题名 ${tok(name)}t 超上限 ${TOPIC_NAME_MAX}t：它是路由把手，不是一句话`);
    if (entry?.basis === 'verified' && !norm(entry.text).includes(norm(name))) {
      errors.push(`话题「${name}」没有逐字出现在 ${segId} 的已证增量里：${String(entry.text).slice(0, 60)}`);
    }
  }
  const held = (topics.labels[segId] ?? []);
  if (held.length >= MAX_TOPICS_PER_SEGMENT) errors.push(`${segId} 已挂 ${held.length} 个话题，到上限 ${MAX_TOPICS_PER_SEGMENT}：一段最多属于这么几支`);
  const t = topics.topics.find((x) => x.name === name);
  const covered = t ? Object.values(topics.labels).filter((l) => l.includes(t.id)).length + (held.includes(t.id) ? 0 : 1) : 1;
  return { ok: !errors.length, errors, topicId: t?.id ?? null, provisional: covered < MIN_SEGMENTS_PER_TOPIC, covered };
}

/** Topics published as branches: only those that actually cover enough segments. */
export function publishedTopics(topics) {
  const out = [];
  for (const t of topics.topics) {
    const segments = Object.entries(topics.labels).filter(([, l]) => l.includes(t.id)).map(([id]) => id).sort();
    if (segments.length >= MIN_SEGMENTS_PER_TOPIC) out.push({ ...t, segments });
  }
  return out;
}

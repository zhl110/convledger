// Build one session's ledger: project -> segment (rules) -> facts -> claims ->
// route cards. Deterministic and idempotent; a model-authored claims.json (the
// M2 layer) survives a rebuild and is only invalidated by an anchor hash change.
import fs from 'node:fs';
import path from 'node:path';
import { project } from './project.mjs';
import { segment, RULES } from './segment.mjs';
import { buildFacts } from './facts.mjs';
import { deriveClaim, renderCard, renderIndex } from './cards.mjs';
import { sha, readJsonl, tok } from './lib.mjs';

export const RULE_AUTHOR = 'rule-layer(M1)';

export function build(mainFile, opts = {}) {
  const p = project(mainFile);
  const sessionId = path.basename(mainFile, '.jsonl');
  const segs = segment(p.turns, p.branches);

  const lines = fs.readFileSync(mainFile, 'utf8').split('\n');
  for (const s of segs) {
    s.contentHash = sha(lines.slice(s.lineFrom - 1, s.lineTo).join('\n'));
  }

  const facts = buildFacts(p, segs);

  const claims = {};  for (const s of segs) {
    const d = deriveClaim(s);
    claims[s.id] = { ...d, author: RULE_AUTHOR, segmentHash: s.contentHash };
  }
  const claimsOverlay = mergeClaimsLayer(opts.storeRoot, sessionId, claims);

  const cards = {};
  for (const s of segs) cards[s.id] = renderCard(s, claims[s.id], sessionId);
  const indexMd = renderIndex(segs, claims, sessionId);

  const ledger = {
    sessionId,
    runner: p.runner,
    sourceFile: p.mainFile,
    sidecarDir: p.sidecarDir,
    sourceBytes: facts.session.bytes,
    sourceRecords: p.records,
    builtAt: new Date().toISOString(),
    cwd: facts.session.cwd,
    boundaries: p.boundaries,
    branches: p.branches,
    rules: RULES,
    segments: segs.map(({ turns, ...rest }) => ({ ...rest, turns: undefined, humans: undefined, hostTurns: turns.length })),
  };

  return {
    sessionId,
    ledger,
    facts,
    claims,
    cards,
    indexMd,
    claimsOverlay,
    // the map surface needs the turn text the ledger deliberately does not store
    projection: p,
    cardTokens: Object.values(cards).reduce((a, c) => a + tok(c), 0),
    indexTokens: tok(indexMd),
  };
}

/** A model-authored claims layer (M2) survives rebuilds; it is dropped for any
 *  segment whose anchor no longer resolves to the same bytes. */
function mergeClaimsLayer(storeRoot, sessionId, claims) {
  const applied = { overlay: 0, dropped: 0 };
  if (!storeRoot) return applied;
  const file = path.join(storeRoot, sessionId, 'claims.json').replace(/\\/g, '/');
  if (!fs.existsSync(file)) return applied;
  const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [id, c] of Object.entries(prev)) {
    if (c?.author === RULE_AUTHOR || !claims[id]) continue;
    if (c.segmentHash !== claims[id].segmentHash) { applied.dropped++; continue; }
    claims[id] = { ...c, keptAt: new Date().toISOString() };
    applied.overlay++;
  }
  return applied;
}

export { readJsonl };

// Build one session's ledger: project -> segment (rules) -> facts -> claims ->
// route cards. Deterministic and idempotent; a model-authored claims.json (the
// M2 layer) survives a rebuild and is only invalidated by an anchor hash change.
import fs from 'node:fs';
import path from 'node:path';
import { project, normalizeRecords } from './project.mjs';
import { segment, RULES } from './segment.mjs';
import { buildFacts } from './facts.mjs';
import { deriveClaim, renderCard, renderIndex } from './cards.mjs';
import { sha, readJsonl, tok } from './lib.mjs';

export const RULE_AUTHOR = 'rule-layer(M1)';

export function build(mainFile, opts = {}) {
  // opts.slice 由 src/window.mjs 递进来：只解析一片，段 id 用全文件绝对行号保持逐片追加稳定。
  // 不给 slice 就是原来的整段全量路径（显式 index / 重建旧账本）。
  const slice = opts.slice ?? null;
  const p = project(mainFile, slice ? {
    records: normalizeRecords(slice.runner, slice.metaRecords),
    turnRecords: normalizeRecords(slice.runner, slice.records),
    adapterId: slice.runner,
    lineText: slice.lineText,
    lineOffset: slice.lineOffset,
    windowInfo: slice.info,
    skipBranches: true,
  } : {});
  const sessionId = path.basename(mainFile, '.jsonl');
  const segs = segment(p.turns, p.branches);

  const lines = p.lineText ?? fs.readFileSync(mainFile, 'utf8').split('\n');
  const lineOffset = p.lineOffset ?? 0;
  for (const s of segs) {
    if (slice) s.id = 'S' + String(s.lineFrom).padStart(6, '0');
    s.contentHash = sha(lines.slice(s.lineFrom - 1 - lineOffset, s.lineTo - lineOffset).join('\n'));
  }

  const facts = buildFacts(p, segs, slice ? { rawRecords: p.factsRaw } : {});
  if (slice) {
    // facts 的逐记录统计只覆盖这一片；源规模要报全文件，别让看板显示成 256KB。
    facts.session.bytes = slice.info.totalBytes;
    facts.session.lines = slice.info.endLine;
    facts.session.records = slice.info.endLine;
  }

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
    sourceRecords: slice ? slice.info.endLine : p.records,
    ...(slice ? { window: { mode: 'slice', ...slice.info } } : {}),
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

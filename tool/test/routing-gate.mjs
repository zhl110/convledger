#!/usr/bin/env node
// Routing gate — no model, no agent. For each probe it answers mechanically:
//   * can the answer be found in the ROUTE layer (index + cards)?            -> 0 backfills
//   * can it be found in FACTS (the derived structural ledger)?               -> 0 backfills
//   * otherwise which segments actually hold it, and do those segments' cards
//     point there?                                                            -> predicted backfill cost
// This is what decides whether the <=6-read acceptance is reachable before we
// spend agent runs finding out.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLedger, renderBody } from '../src/store.mjs';
import { BODY_BUDGET_TOKENS } from '../src/cost.mjs';
import { tok } from '../src/lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE = process.env.CL_STORE ?? path.join(HERE, '..', 'out', 'store').replace(/\\/g, '/');
const data = JSON.parse(fs.readFileSync(path.join(HERE, 'probes.json'), 'utf8'));
const { ledger } = loadLedger(STORE, data.session);
const factsRaw = fs.readFileSync(path.join(STORE, data.session, 'facts.json'), 'utf8');
const routeText = fs.readFileSync(path.join(STORE, data.session, 'index.md'), 'utf8')
  + ledger.segments.map((s) => fs.readFileSync(path.join(STORE, data.session, 'segments', `${s.id}.md`), 'utf8')).join('\n');

const bodies = new Map();
const bodyOf = (s) => {
  // Unbounded here: this is a mechanical "who actually holds the fact" scan, not
  // a context-fed read. Cost of the fed read is estimated separately below.
  if (!bodies.has(s.id)) bodies.set(s.id, renderBody(ledger, [s], { max: 0 }).text.toLowerCase());
  return bodies.get(s.id);
};
const has = (text, alts) => alts.some((a) => text.includes(a.toLowerCase()));
// Only a discriminative alternative proves a hit: '350' or 'replay' appear everywhere.
const strong = (p) => p.a.filter((x) => x.length >= 8 || x.includes(':') || x.includes('/'));

const rows = data.probes.map((p) => {
  const alts = strong(p).length ? strong(p) : p.a;
  const weak = strong(p).length === 0;
  const inRoute = has(routeText.toLowerCase(), alts);
  const inFacts = has(factsRaw.toLowerCase(), alts);
  const holders = ledger.segments.filter((s) => has(bodyOf(s), alts)).map((s) => s.id);
  // a fact repeated in ten segments is not routed by "who holds it" but by "who
  // established it first" — the earliest holder is the one the card should point at.
  const first = holders[0] ?? null;
  // The card is not supposed to carry the ANSWER (that is what keeps it small); it
  // has to carry the ADDRESS the answer is about. Compare on the file/identifier.
  const subjects = [...new Set(alts.map((a) => a.replace(/[:：].*$/, '').trim())
    .map((x) => (x.includes('/') ? x.split('/').slice(-2).join('/') : x))
    .filter((x) => x.length >= 6))];
  const cardText = first ? fs.readFileSync(path.join(STORE, data.session, 'segments', `${first}.md`), 'utf8').toLowerCase() : '';
  const cardHasSubject = subjects.length ? subjects.some((su) => cardText.includes(su.toLowerCase())) : null;
  return {
    id: p.id, type: p.type,
    answeredBy: inFacts ? 'facts' : inRoute ? 'route' : holders.length ? 'body' : 'NOTHING',
    firstHolder: first, holders: holders.length, ambiguous: holders.length > 3,
    subjects: subjects.join('|') || '-', cardHasSubject, weakAnswer: weak,
  };
});

const need = rows.filter((r) => r.answeredBy === 'body');
const distinct = [...new Set(need.map((r) => r.firstHolder).filter(Boolean))];
const unroutable = need.filter((r) => r.cardHasSubject === false);
// Predicted real cost: the distinct holders arrive as ONE batched `body` read,
// but that read is budgeted, so a fat cluster still costs ceil(tokens/budget).
const clusterTok = distinct.reduce((a, id) => a + tok(bodies.get(id) ?? ''), 0);
const predictReads = distinct.length ? Math.max(1, Math.ceil(clusterTok / BODY_BUDGET_TOKENS)) : 0;
const perSegReads = distinct.reduce((a, id) => a + Math.max(1, Math.ceil(tok(bodies.get(id) ?? '') / BODY_BUDGET_TOKENS)), 0);

console.table(rows);
console.log(`
探针 ${rows.length} · 路由层/facts 直接答上 ${rows.length - need.length} · 需要回补 ${need.length}
回补目标（各题的最早建立段，去重）: ${distinct.join(', ') || '无'} → 一次批量取回 ${distinct.length} 段
预算 ${BODY_BUDGET_TOKENS} tok 下这簇正文 ${clusterTok} tok → 预测回补次数 ${predictReads}（一次批量）/ ${perSegReads}（逐段），验收线 ≤6
卡片没指到最早建立段的题: ${unroutable.map((r) => `${r.id}→${r.firstHolder ?? '无'}`).join(' ') || '无'}
答案串太短的题（命中不构成证据）: ${rows.filter((r) => r.weakAnswer).map((r) => r.id).join(' ') || '无'}`);

if (need.some((r) => !r.firstHolder)) console.log('⚠ 有探针在任何段正文里都找不到答案 —— 题面或切分有问题，先查再评测。');
fs.writeFileSync(path.join(HERE, 'routing-gate.json'), JSON.stringify({
  rows,
  summary: {
    probes: rows.length, answeredWithoutBody: rows.length - need.length, needBody: need.length,
    firstHolders: distinct, unroutable: unroutable.map((r) => r.id),
    clusterTokens: clusterTok, budgetTokens: BODY_BUDGET_TOKENS,
    predictedBackfills: { batched: predictReads, perSegment: perSegReads, acceptance: 6 },
    ambiguous: rows.filter((r) => r.ambiguous).map((r) => r.id),
  },
}, null, 1));

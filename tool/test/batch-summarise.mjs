#!/usr/bin/env node
// Robustness check for the adapters: index every visible session and report, in one
// paragraph, how many survived, which runners were seen, and the route-layer cost.
import fs from 'node:fs';
const file = process.argv[2] ?? 'test/batch-index.json';
const raw = fs.readFileSync(file, 'utf8');
const rows = JSON.parse(raw.slice(raw.indexOf('[')));
const ok = rows.filter((r) => !r.error);
const bad = rows.filter((r) => r.error);
const sum = (k) => ok.reduce((a, r) => a + r[k], 0);
const mb = sum('mb');
const t = (arr) => { const s = [...arr].sort((a, b) => a - b); return { min: s[0], med: s[s.length >> 1], max: s[s.length - 1] }; };
const out = {
  sessions: rows.length,
  indexed: ok.length,
  failed: bad.length,
  runners: ok.reduce((a, r) => ({ ...a, [r.runner]: (a[r.runner] ?? 0) + 1 }), {}),
  sourceMB: +mb.toFixed(2),
  storeMB: +(sum('routeTok') * 3 / 1048576).toFixed(2),
  segs: t(ok.map((r) => r.segs)),
  turns: t(ok.map((r) => r.turns)),
  calls: t(ok.map((r) => r.calls)),
  branchesTotal: sum('branches'),
  boundariesTotal: sum('boundaries'),
  fanoutsTotal: sum('fanouts'),
  routeTokTotal: sum('routeTok'),
  routeTokPerSession: Math.round(sum('routeTok') / (ok.length || 1)),
  ms: t(ok.map((r) => r.ms)),
  msTotal: sum('ms'),
  errors: bad.map((r) => `${r.id}: ${r.error}`),
};
console.log(JSON.stringify(out, null, 1));

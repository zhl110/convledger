#!/usr/bin/env node
// Score D1/D2 answer sheets against the probe key — same rule as experiment 1:
// a probe counts as a hit if ANY alternative string appears in the answer text.
// `宽松` is that raw string match; `严格` additionally requires the sheet not to
// have written UNKNOWN for the value the question asked for (a file:line citation
// alone must not pass a question whose subject is the version number).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const key = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'probes.json'), 'utf8'));

// "src/lib/ladder.ts` 第 46 行" and "ladder.ts 第 46-48 行" are the same citation
// as "ladder.ts:46"; without this the matcher punishes Chinese word order.
const norm = (t) => t
  .replace(/[`＊*]/g, '')
  .replace(/([\w.\-/]+\.[a-zA-Z]{1,6})\s*第\s*(\d{1,5})(?:\s*[–-]\s*\d{1,5})?\s*(?:行|行区间|行附近)?/g, '$1:$2')
  .replace(/,/g, '');

const sheets = ['D1', 'D2'].map((id) => {
  const file = path.join(HERE, `${id}.txt`);
  const text = norm(fs.readFileSync(file, 'utf8'));
  const rows = key.probes.map((p) => {
    const block = (text.match(new RegExp(`${p.id}[^P]*`, 's')) ?? [''])[0];
    // match INSIDE that probe's own answer block only — a keyword anywhere in the
    // sheet is not evidence this question was answered
    const loose = p.a.some((a) => block.includes(a));
    const saidUnknown = /UNKNOWN/.test(block);
    return { id: p.id, type: p.type, loose, strict: loose && !(saidUnknown && p.type === 'text'), saidUnknown };
  });
  return { id, rows, strict: rows.filter((r) => r.strict).length, loose: rows.filter((r) => r.loose).length };
});

console.log('id    type       D1宽松 D1严格 D2宽松 D2严格');
for (let i = 0; i < key.probes.length; i++) {
  const a = sheets[0].rows[i], b = sheets[1].rows[i];
  console.log(`${a.id}  ${a.type.padEnd(10)}   ${a.loose ? '✓' : '·'}     ${a.strict ? '✓' : '·'}     ${b.loose ? '✓' : '·'}     ${b.strict ? '✓' : '·'}${a.loose !== a.strict ? '  ← D1 只给了坐标，值仍 UNKNOWN' : ''}${b.loose !== b.strict ? '  ← D2 同' : ''}`);
}
console.log(`\n总计: D1 宽松 ${sheets[0].loose}/15 严格 ${sheets[0].strict}/15 | D2 宽松 ${sheets[1].loose}/15 严格 ${sheets[1].strict}/15`);
fs.writeFileSync(path.join(HERE, 'score.json'), JSON.stringify(sheets, null, 1));

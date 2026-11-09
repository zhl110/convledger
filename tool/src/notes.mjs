// The human layer: notes a person adds from the map, and requests they leave for
// the agent. Both are EXTERNAL tables in the store directory (precedent: topics.json),
// never part of the ledger: a note has no evidence, so it can never become a claim,
// never passes or fails the six gates, and is never promoted to basis:'verified'.
// index rebuilds rewrite only the files STORE_FILES lists, so these survive.
//
//   notes.json     { schema, notes: [{ id, kind, seg, after?, title, body, author, basis, at }] }
//   requests.jsonl one JSON per line: { id, at, part, from, text, done, doneAt? }
//
// Why a file and not the chat: the map is a localhost page; it cannot post into the
// host's chat input. Channel A (tool/PRD-parts.md §六) is "write it down here, then
// the human says one sentence in the host" — so the write has to outlive the page.
import fs from 'node:fs';
import path from 'node:path';
import { NOTE_TITLE_MAX, NOTE_BODY_MAX, REQUEST_TEXT_MAX } from './cost.mjs';

const NOTES = 'notes.json';
const REQUESTS = 'requests.jsonl';
const SEG_RE = /^S\d{2,}$/;

/** Read the notes table. A corrupt file is an error, not an empty table: the next
 *  append would silently drop whatever the person wrote before it. */
export function readNotes(dir) {
  const f = path.join(dir, NOTES);
  if (!fs.existsSync(f)) return { schema: 'convledger-notes/1', notes: [] };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { throw new Error(`${f} 读不了（${String(e.message).split('\n')[0]}）— 修它，否则下一条人会把它覆盖掉`); }
  return { schema: parsed.schema ?? 'convledger-notes/1', notes: Array.isArray(parsed.notes) ? parsed.notes : [] };
}

/** Validate one note against what the map can honestly anchor. `segs` is the set of
 *  segment ids in this ledger; when given, an anchor outside it is refused. */
export function validateNote(input, segs) {
  const errors = [];
  const kind = String(input?.kind ?? '').trim();
  const seg = String(input?.seg ?? '').trim().toUpperCase();
  const after = input?.after ? String(input.after).trim().toUpperCase() : '';
  const title = String(input?.title ?? '').trim();
  const body = String(input?.body ?? '').trim();

  if (kind !== 'branch' && kind !== 'node') errors.push(`kind 要是 branch 或 node，收到「${input?.kind ?? '（空）'}」`);
  if (!SEG_RE.test(seg)) errors.push(`seg 要是段号（S07），收到「${input?.seg ?? '（空）'}」`);
  else if (segs && !segs.has(seg)) errors.push(`没有段 ${seg}：人写的东西也必须挂在这张图上的一处`);
  if (after && !SEG_RE.test(after)) errors.push(`after 要是段号，收到「${input?.after}」`);
  else if (after && segs && !segs.has(after)) errors.push(`没有段 ${after}`);
  if (!title) errors.push('title 为空：加一条就得有一句话说得清它是什么');
  if (title.length > NOTE_TITLE_MAX) errors.push(`title ${title.length} 字超上限 ${NOTE_TITLE_MAX}：卡面放不下`);
  if (body.length > NOTE_BODY_MAX) errors.push(`body ${body.length} 字超上限 ${NOTE_BODY_MAX}`);
  return { ok: !errors.length, errors, note: { kind, seg, ...(after ? { after } : {}), title, body } };
}

/** Append one human note. Returns { ok, errors, note?, id? }. Never touches claims. */
export function appendNote(dir, input, segs) {
  const v = validateNote(input, segs);
  if (!v.ok) return v;
  const table = readNotes(dir);
  const n = table.notes.length + 1;
  let id = `N${String(n).padStart(2, '0')}`;
  // ids are stable handles in the map; after a manual edit they must not collide
  const used = new Set(table.notes.map((x) => x.id));
  while (used.has(id)) id = `N${String(++n).padStart(2, '0')}`;
  const note = { id, ...v.note, author: 'human', basis: 'human-note', at: new Date().toISOString() };
  table.notes.push(note);
  fs.writeFileSync(path.join(dir, NOTES), JSON.stringify({ ...table, schema: 'convledger-notes/1' }, null, 1) + '\n');
  return { ok: true, errors: [], note };
}

/** Read the request queue. A half-written trailing line is skipped and counted,
 *  not thrown over: the page has to keep loading after a crash mid-append. */
export function readRequests(dir) {
  const f = path.join(dir, REQUESTS);
  if (!fs.existsSync(f)) return { rows: [], bad: 0 };
  const rows = [];
  let bad = 0;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t)); } catch { bad++; }
  }
  return { rows, bad };
}

export function validateRequest(input) {
  const errors = [];
  const text = String(input?.text ?? '').trim();
  const from = input?.from ? String(input.from).trim().toUpperCase() : '';
  const part = input?.part == null || input?.part === '' ? null : Number(input.part);
  if (!text) errors.push('text 为空：续做框里得有一句话');
  if (text.length > REQUEST_TEXT_MAX) errors.push(`text ${text.length} 字超上限 ${REQUEST_TEXT_MAX}`);
  if (from && !SEG_RE.test(from)) errors.push(`from 要是段号，收到「${input?.from}」`);
  if (part !== null && (!Number.isInteger(part) || part < 1)) errors.push(`part 要是正整数（第几步），收到「${input?.part}」`);
  return { ok: !errors.length, errors, request: { part, from, text } };
}

export function appendRequest(dir, input) {
  const v = validateRequest(input);
  if (!v.ok) return v;
  const { rows } = readRequests(dir);
  const id = `R${String(rows.length + 1).padStart(2, '0')}`;
  const row = { id, at: new Date().toISOString(), ...v.request, done: false };
  fs.appendFileSync(path.join(dir, REQUESTS), JSON.stringify(row) + '\n');
  return { ok: true, errors: [], request: row };
}

/** Mark one request done. Rewrites the file because JSONL has no in-place edit;
 *  the table is single-digit rows, so this stays a one-page operation. */
export function closeRequest(dir, id) {
  const { rows } = readRequests(dir);
  const hit = rows.find((r) => r.id === String(id).toUpperCase());
  if (!hit) return { ok: false, errors: [`没有请求 ${id}`], rows };
  hit.done = true;
  hit.doneAt = new Date().toISOString();
  fs.writeFileSync(path.join(dir, REQUESTS), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { ok: true, errors: [], row: hit, rows };
}

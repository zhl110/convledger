// 块综述层：模型逐块写「你说什么 / 我回什么 / 做成什么」，工具只做校验与呈现。
// 与 claims 的分工：claims 是逐字可核的认识增量；综述是归纳，永远 basis:'model'，
// 永不参与六条判据、永不写成 verified。它落在 store 目录的外挂表 summaries.json，
// 重建只重写 STORE_FILES 列的文件，所以这份表能活过 index。
//
// 四道闸门（写入口强制，一条不过整批不写）：
//   ① 非空 + 字数/宽度上限（卡面与右栏放得下）
//   ② 反截段：整格若是块内原话的连续子串（≥8 字），拒收——不许把用户的话剪一段当总结
//   ③ 接地：ASCII 记号与数字必须在该块素材里逐字出现（编不出没见过的文件名/命令/段号）
//   ④ 锚点：segs 必须等于该块段列表，hash 对不上就整条失效（与 claims 的 segmentHash 同纪律）
import fs from 'node:fs';
import path from 'node:path';
import { sha, wlen } from './lib.mjs';
import {
  SUMMARY_SHORT_W, SUMMARY_TITLE_MAX, SUMMARY_SAID_MAX, SUMMARY_ANSWERED_MAX,
  SUMMARY_DONE_MAX, SUMMARY_NEED_MAX, SUMMARY_LESSON_MAX, SUMMARY_TASK_TITLE_MAX, SUMMARY_MIN_QUOTE_OVERLAP,
} from './cost.mjs';

const FILE = 'summaries.json';

/** Read the model summary table. A corrupt file is an error, not an empty table:
 *  the next write would silently drop every summary before it. */
export function readSummaries(dir) {
  const f = path.join(dir, FILE);
  const empty = { schema: 'convledger-summaries/1', blocks: {}, tasks: {} };
  if (!fs.existsSync(f)) return empty;
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { throw new Error(`${f} 读不了（${String(e.message).split('\n')[0]}）— 修它，否则下一批综述会把它覆盖掉`); }
  return {
    schema: parsed.schema ?? 'convledger-summaries/1',
    blocks: parsed.blocks && typeof parsed.blocks === 'object' ? parsed.blocks : {},
    tasks: parsed.tasks && typeof parsed.tasks === 'object' ? parsed.tasks : {},
  };
}

export function writeSummaries(dir, table) {
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify({ schema: 'convledger-summaries/1', ...table }, null, 1) + '\n');
}

/** The block's identity: segment ids + each segment's anchor hash. A summary is only
 *  valid for the exact bytes it was written from; a rebuild that merges or splits
 *  the block changes this string and the old summary is dropped. */
export function blockHash(block, nodes) {
  const parts = [];
  for (let j = block.i0; j <= block.i1; j++) parts.push(`${nodes[j]?.id ?? ''}:${nodes[j]?.hash ?? ''}`);
  return sha(parts.join('|'));
}

/** Everything a summary may draw on. If a fact is not in here, the writer made it up. */
export function blockMaterial(block, nodes, tasks, totals) {
  const out = [];
  out.push(`块${block.i}${block.step != null ? ` 步${block.step}` : ''} ${block.span || ''} 段=${block.segIds.join(' ')}`);
  if (totals) out.push(`总步${totals.mainSteps} 总块${totals.blocks} 总段${totals.nodes}`);
  for (let j = block.i0; j <= block.i1; j++) {
    const n = nodes[j];
    if (!n) continue;
    if (n.say) out.push(`你（${n.id}）：${n.say}`);
    if (n.claim) out.push(`我（${n.id}·${n.basis}）：${n.claim}`);
    if (n.line && n.line !== n.claim) out.push(`题（${n.id}）：${n.line}`);
    if (n.files?.length) out.push(`产物（${n.id}）：${n.files.join(' ')}`);
    if (n.tools) out.push(`动作（${n.id}）：${n.tools}`);
  }
  const t = tasks.find((x) => x.id === block.dominant);
  if (t) out.push(`任务：${t.id} ${t.title} 头=${t.head}`);
  out.push(`支=${(block.branchIds || []).join(' ')} 夹=${block.afterStep ?? ''}↔${block.beforeStep ?? ''} 句=${block.h0 ?? ''}-${block.h1 ?? ''}`);
  return out.join('\n');
}

export function taskMaterial(task, blocks, nodes) {
  const out = [`任务 ${task.id} 起于 ${task.head} 标题=${task.title}`];
  for (const b of blocks) {
    if (!(b.branchIds || []).includes(task.id)) continue;
    out.push(blockMaterial(b, nodes, [], null));
  }
  const head = nodes.find((n) => n.id === task.head);
  if (head) out.push(`你（${head.id}）：${head.say || ''}\n我（${head.id}·${head.basis}）：${head.claim || ''}`);
  return out.join('\n');
}

const norm = (s) => String(s ?? '')
  .replace(/[\s，。；：、！？,.;:!?…—–\-"'“”‘’「」『』（）()《》<>·]/g, '');
const TOKEN = /[A-Za-z][A-Za-z0-9._+\/-]*|\d+(?:\.\d+)?/g;

/** Quotes a field must not simply copy. Whole-field containment is the test, so a
 *  summary may reuse a short phrase; it may not *be* a cut of the original sentence. */
function quotesIn(block, nodes) {
  const out = [];
  for (let j = block.i0; j <= block.i1; j++) {
    const n = nodes[j];
    if (!n) continue;
    for (const q of [n.say, n.claim, n.line]) if (q && String(q).length >= SUMMARY_MIN_QUOTE_OVERLAP) out.push(norm(q));
  }
  return out;
}

function grounded(field, name, material, errors) {
  const mat = material.toLowerCase();
  for (const token of new Set(String(field).match(TOKEN) || [])) {
    if (token.length < 2 && !/^\d+$/.test(token)) continue;
    if (!mat.includes(token.toLowerCase())) errors.push(`${name} 里的「${token}」在块素材里找不到——综述不许编没见过的名字/数字`);
  }
}

/** Validate one block summary. `block.segIds` is the authoritative range. */
export function validateSummary(entry, block, nodes, tasks, totals) {
  const errors = [];
  const short = String(entry?.short ?? '').trim();
  const title = String(entry?.title ?? '').trim();
  const said = String(entry?.said ?? '').trim();
  const answered = String(entry?.answered ?? '').trim();
  const done = String(entry?.done ?? '').trim();
  const need = String(entry?.need ?? '').trim();
  const lesson = String(entry?.lesson ?? '').trim();
  const segs = Array.isArray(entry?.segs) ? entry.segs.map(String) : [];

  if (wlen(short) > SUMMARY_SHORT_W) errors.push(`short 占 ${wlen(short).toFixed(1)} 格 > ${SUMMARY_SHORT_W}（远景那格放不下）`);
  if (title.length > SUMMARY_TITLE_MAX) errors.push(`title ${title.length} 字 > ${SUMMARY_TITLE_MAX}（中景两行放不下）`);
  if (said.length > SUMMARY_SAID_MAX) errors.push(`said ${said.length} 字 > ${SUMMARY_SAID_MAX}`);
  if (answered.length > SUMMARY_ANSWERED_MAX) errors.push(`answered ${answered.length} 字 > ${SUMMARY_ANSWERED_MAX}`);
  if (done.length > SUMMARY_DONE_MAX) errors.push(`done ${done.length} 字 > ${SUMMARY_DONE_MAX}`);
  if (need.length > SUMMARY_NEED_MAX) errors.push(`need ${need.length} 字 > ${SUMMARY_NEED_MAX}`);
  if (lesson.length > SUMMARY_LESSON_MAX) errors.push(`lesson ${lesson.length} 字 > ${SUMMARY_LESSON_MAX}`);
  for (const [k, v] of [['short', short], ['title', title], ['said', said], ['answered', answered], ['done', done]])
    if (!v) errors.push(`${k} 为空：五格都得答一句`);

  if (segs.join(',') !== block.segIds.join(','))
    errors.push(`segs 要逐项等于这一块的段列表（${block.segIds.join(' ')}），收到 ${segs.join(' ') || '（空）'}`);

  const material = blockMaterial(block, nodes, tasks, totals);
  const quotes = quotesIn(block, nodes);
  for (const [k, v] of [['title', title], ['said', said], ['answered', answered], ['done', done], ['need', need], ['lesson', lesson]]) {
    if (!v) continue;
    const nv = norm(v);
    if (nv.length < SUMMARY_MIN_QUOTE_OVERLAP) { grounded(v, k, material, errors); continue; }
    if (quotes.some((q) => q.includes(nv))) errors.push(`${k} 是原话截段，不是综述：「${v}」`);
    grounded(v, k, material, errors);
  }
  const hash = blockHash(block, nodes);
  if (entry?.hash && entry.hash !== hash)
    errors.push(`hash 对不上：这一块的段锚点已经变了，旧综述必须重写（期望 ${hash}）`);
  return {
    ok: !errors.length,
    errors,
    row: { segs: block.segIds.slice(), hash, short, title, said, answered, done, need: need || null, lesson: lesson || null, basis: 'model', at: new Date().toISOString() },
  };
}

export function validateTaskTitle(entry, task, blocks, nodes) {
  const errors = [];
  const title = String(entry?.title ?? '').trim();
  if (!title) errors.push('title 为空：任务行总得有一个名字');
  if (title.length > SUMMARY_TASK_TITLE_MAX) errors.push(`title ${title.length} 字 > ${SUMMARY_TASK_TITLE_MAX}`);
  const material = taskMaterial(task, blocks, nodes);
  const quotes = [];
  const head = nodes.find((n) => n.id === task.head);
  for (const q of [head?.say, head?.claim]) if (q && norm(q).length >= SUMMARY_MIN_QUOTE_OVERLAP) quotes.push(norm(q));
  const nv = norm(title);
  if (nv.length >= SUMMARY_MIN_QUOTE_OVERLAP && quotes.some((q) => q.includes(nv))) errors.push(`title 是支头原话截段，不是题名：「${title}」`);
  grounded(title, 'title', material, errors);
  return { ok: !errors.length, errors, row: { head: task.head, title, basis: 'model', at: new Date().toISOString() } };
}

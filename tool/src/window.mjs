// 长历史按片建账（RULES §13）。
//
// 用户口径：刚接进一段历史很长的对话，不要一次把整段建完；只建正在对话的上下文，
// 更早的记录先只读展示，补账每一轮往前加一小片，追平即止。
//
// 实现：一次只解析 [fromByte,toByte) 这一片（默认 256KB），段 id 用「全文件绝对行号」
// 保证逐片追加时已有段不改名、M2 claims 不失效；每片生成后按行区间替换式合并进同一本账。
// 片外记录永不解析、不生成段/卡/索引；要看它们走 rawRecords() 只读文本。
//
// 源文件只读、不到处落中间产物；合并只在 store 内写账本。
import fs from 'node:fs';
import path from 'node:path';
import { detectAdapter, normalizeRecords } from './project.mjs';
import { build } from './build.mjs';
import { writeStore, storeDir } from './store.mjs';
import { renderIndex } from './cards.mjs';

/** 单次建账的解析上限。调小＝每轮更轻但轮数更多，调大反之；与源总大小无关。 */
export const SLICE_BYTES = 256 * 1024;
const HEAD_BYTES = 32 * 1024;   // 文件头：runner 识别、cwd / model / gitBranch
const HEAD_RECORDS = 24;
const READ_CHUNK = 1 << 20;

function countLinesBefore(file, upto) {
  if (upto <= 0) return 0;
  const buf = Buffer.allocUnsafe(READ_CHUNK);
  const fd = fs.openSync(file, 'r');
  let off = 0, n = 0;
  try {
    while (off < upto) {
      const got = fs.readSync(fd, buf, 0, Math.min(READ_CHUNK, upto - off), off);
      if (!got) break;
      for (let i = 0; i < got; i++) if (buf[i] === 10) n++;
      off += got;
    }
  } finally { fs.closeSync(fd); }
  return n;
}

function readBytes(file, from, to) {
  const size = fs.statSync(file).size;
  const a = Math.max(0, Math.min(size, from));
  const b = Math.max(a, Math.min(size, to));
  const buf = Buffer.allocUnsafe(b - a);
  if (b > a) {
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, b - a, a); } finally { fs.closeSync(fd); }
  }
  return buf.toString('utf8');
}

function parseLines(text, baseLine) {
  const lines = text.split('\n');
  const records = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const abs = baseLine + i + 1;
    try { records.push({ __line: abs, __bytes: Buffer.byteLength(line), ...JSON.parse(line) }); }
    catch { records.push({ __line: abs, __bytes: Buffer.byteLength(line), type: 'unparseable' }); }
  }
  return { lines, records };
}

/** 只读一片：两端对齐到行边界，__line 保持全文件绝对行号（锚点稳定）。 */
export function readSlice(file, { fromByte = 0, toByte = null } = {}) {
  const size = fs.statSync(file).size;
  let a = Math.max(0, Math.min(size, fromByte));
  const b = toByte == null ? size : Math.max(a, Math.min(size, toByte));
  let text = readBytes(file, a, b);
  if (a > 0) {
    const nl = text.indexOf('\n');
    a += nl >= 0 ? nl + 1 : text.length;
    text = nl >= 0 ? text.slice(nl + 1) : '';
  }
  if (b < size) {
    const nl = text.lastIndexOf('\n');
    if (nl >= 0) text = text.slice(0, nl + 1);
  }
  const lineOffset = countLinesBefore(file, a);
  const { lines, records } = parseLines(text, lineOffset);
  const head = parseLines(readBytes(file, 0, Math.min(HEAD_BYTES, size)), 0).records.slice(0, HEAD_RECORDS);
  return {
    records,
    metaRecords: [...head, ...records],
    lineText: lines,
    lineOffset,
    info: {
      fromByte: a, toByte: b, totalBytes: size,
      startLine: lineOffset + 1, endLine: lineOffset + lines.length,
    },
  };
}

/** 决定这一轮处理哪一片。grow＝往前补一片；否则重算尾部当前片（接住新写的记录）。 */
export function planSlice(sourceFile, ledger, { grow = false, full = false } = {}) {
  const size = fs.statSync(sourceFile).size;
  if (full || size <= SLICE_BYTES) return { action: 'full', slice: null, size, cursor: null };
  const w = ledger?.window;
  if (!w) {
    // 已经建过账、且不是按片建的（含本机 2800 多本存量账本）：维持原来的全量重建，
    // 零回归。按片只管「刚接入、还没有账本」的长历史——正是用户定的那个场景。
    if (ledger?.segments?.length) return { action: 'full', slice: null, size, cursor: null };
    const from = Math.max(0, size - SLICE_BYTES);
    return {
      action: 'first', slice: { fromByte: from, toByte: size }, size,
      cursor: { coveredFromByte: from, complete: false },
    };
  }
  const covered = Math.max(0, Number(w.coveredFromByte) || 0);
  if (grow) {
    if (w.complete || covered <= 0) return { action: 'done', slice: null, size, cursor: { ...w, complete: true } };
    const from = Math.max(0, covered - SLICE_BYTES);
    return {
      action: 'grow', slice: { fromByte: from, toByte: covered }, size,
      cursor: { ...w, coveredFromByte: from, complete: from === 0 },
    };
  }
  // 尾部滑动片：每轮固定 256KB，源再长也不放大单次成本；旧片已落的段不会被删。
  const from = Math.max(0, size - SLICE_BYTES);
  return {
    action: 'tail', slice: { fromByte: from, toByte: size }, size,
    cursor: { ...w, complete: !!w.complete || covered === 0 },
  };
}

/** 合并一片进已有账本：按行区间替换（含跨边界的段，避免重复），M2 claims 与旧 facts 保留。 */
function writeMerged(dir, built, old, info, cursor) {
  fs.mkdirSync(path.join(dir, 'segments'), { recursive: true });
  const keep = (old?.ledger?.segments ?? []).filter((s) => s.lineTo < info.startLine || s.lineFrom > info.endLine);
  const segs = [...keep, ...built.ledger.segments].sort((a, b) => a.lineFrom - b.lineFrom);
  const claims = { ...(old?.claims ?? {}), ...built.claims };
  const facts = old?.facts ?? built.facts;
  facts.session = { ...facts.session, bytes: info.totalBytes, lines: info.endLine, records: info.endLine };
  facts.window = { mode: 'slice', segmentsBuilt: segs.length, note: '统计基于已建片段；源总大小见 session.bytes' };

  const ledger = {
    ...(old?.ledger ?? {}),
    ...built.ledger,
    segments: segs,
    boundaries: old?.ledger?.boundaries ?? built.ledger.boundaries,
    branches: old?.ledger?.branches ?? built.ledger.branches,
    sourceBytes: info.totalBytes,
    sourceRecords: info.endLine,
    window: {
      mode: 'slice',
      ...cursor,
      sliceBytes: SLICE_BYTES,
      lastSlice: { fromByte: info.fromByte, toByte: info.toByte, startLine: info.startLine, endLine: info.endLine },
      updatedAt: new Date().toISOString(),
    },
  };
  fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify(ledger, null, 1));
  fs.writeFileSync(path.join(dir, 'facts.json'), JSON.stringify(facts, null, 1));
  fs.writeFileSync(path.join(dir, 'claims.json'), JSON.stringify(claims, null, 1));
  fs.writeFileSync(path.join(dir, 'index.md'), renderIndex(segs, claims, built.sessionId));
  for (const [id, card] of Object.entries(built.cards)) fs.writeFileSync(path.join(dir, 'segments', `${id}.md`), card);
  return { dir, segs: segs.length };
}

function readOld(dir) {
  try {
    return {
      ledger: JSON.parse(fs.readFileSync(path.join(dir, 'ledger.json'), 'utf8')),
      claims: JSON.parse(fs.readFileSync(path.join(dir, 'claims.json'), 'utf8')),
      facts: JSON.parse(fs.readFileSync(path.join(dir, 'facts.json'), 'utf8')),
    };
  } catch { return null; }
}

/**
 * 自动化路径统一入口：首次只建尾部一片；grow=true 每轮往前补一片；否则重算尾部片。
 * full=true 或源小于一片时走原来的全量 build（人工显式要求 / 小会话）。
 */
export function indexWindowed(mainFile, { storeRoot, grow = false, full = false } = {}) {
  const sessionId = path.basename(mainFile, '.jsonl');
  const dir = storeDir(storeRoot, sessionId);
  const old = readOld(dir);
  const plan = planSlice(mainFile, old?.ledger, { grow, full });
  if (plan.action === 'full') {
    const built = build(mainFile, { storeRoot });
    writeStore(storeRoot, built);
    return { built, action: 'full', window: null, segs: built.ledger.segments.length };
  }
  if (plan.action === 'done') {
    return { built: null, action: 'done', window: plan.cursor, segs: old?.ledger?.segments?.length ?? 0 };
  }
  const s = readSlice(mainFile, plan.slice);
  const runner = detectAdapter(s.metaRecords.slice(0, 40))?.id ?? old?.ledger?.runner ?? 'unknown';
  const built = build(mainFile, {
    storeRoot,
    slice: { ...s, runner, info: { ...s.info, ...plan.cursor, action: plan.action } },
  });
  const merged = writeMerged(dir, built, old, s.info, plan.cursor);
  return { built, action: plan.action, window: plan.cursor, segs: merged.segs, parsedBytes: s.info.toByte - s.info.fromByte };
}

/** 只读展示还没建账的更早记录：按行给文本，不解析成 turns、不生成段/卡/索引。 */
export function rawRecords(sourceFile, ledger, { fromByte = null, maxBytes = 64 * 1024, maxLines = 40 } = {}) {
  const size = fs.statSync(sourceFile).size;
  const covered = Math.max(0, Number(ledger?.window?.coveredFromByte ?? size) || 0);
  const from = Math.max(0, Math.min(size, fromByte == null ? Math.max(0, covered - maxBytes) : fromByte));
  const s = readSlice(sourceFile, { fromByte: from, toByte: Math.min(size, from + maxBytes) });
  return {
    lines: s.lineText.slice(0, maxLines).map((text, i) => ({ line: s.lineOffset + i + 1, text: text.slice(0, 400) })),
    fromByte: s.info.fromByte, toByte: s.info.toByte, totalBytes: size,
    coveredFromByte: covered, complete: !!ledger?.window?.complete, note: '只读原始记录，未建账',
  };
}

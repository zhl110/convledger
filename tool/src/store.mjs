// Derived-first storage: the ledger holds structure, anchors and route cards —
// never the body. Bodies are re-read from the runner's own append-only JSONL.
// `source.jsonl` is the one exception: a verbatim archive kept only for sessions a
// canvas has served, so the conversation stays readable after the runner prunes its
// log. It is a mirror, never an input to the ledger — the source is still the truth
// while it exists.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJsonl, blocksOf, clip, WRITE_TOOLS, sha, tok } from './lib.mjs';
import { normalizeRecords } from './project.mjs';
import { CALL_LIMIT, ARTIFACT_CALL_LIMIT, RESULT_LIMIT, BODY_BUDGET_TOKENS } from './cost.mjs';

export const STORE_FILES = ['ledger.json', 'facts.json', 'claims.json', 'index.md', 'segments/', 'trace.jsonl', 'source.jsonl（归档，只画布服务过的会话有）'];

const ARCHIVE = 'source.jsonl';
const archPath = (dir) => path.join(dir, ARCHIVE).replace(/\\/g, '/');

export function archiveState(dir) {
  const file = archPath(dir);
  if (!fs.existsSync(file)) return { exists: false, bytes: 0, syncedAt: null };
  const st = fs.statSync(file);
  return { exists: true, bytes: st.size, syncedAt: st.mtime.toISOString().slice(0, 16).replace('T', ' ') };
}

/** 末尾 64 字节对得上才认 archive 是源的前缀——源被重写、截断、换了一份时全量重拷，
 *  宁可多拷一次，也不把两份日志拼成一份。 */
function sameTail(arch, src, at) {
  const n = Math.min(64, at);
  const read = (f) => { const fd = fs.openSync(f, 'r'); try { const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, at - n); return b; } finally { fs.closeSync(fd); } };
  return read(arch).equals(read(src));
}

/** 只追加到最后一个换行：半行冻进归档，`readJsonl` 就会多一条 unparseable。 */
function lastNewlineEnd(file, size) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    let pos = size;
    while (pos > 0) {
      const len = Math.min(buf.length, pos);
      pos -= len;
      fs.readSync(fd, buf, 0, len, pos);
      const i = buf.lastIndexOf(0x0a, len - 1);
      if (i >= 0) return pos + i + 1;
    }
    return 0;
  } finally { fs.closeSync(fd); }
}

/**
 * 把源日志同步进账本目录，返回归档状态。画布服务一段会话期间每次都调；增量时只拷尾部。
 * 源不在了就只报状态，不删归档（删了才是真丢）。
 */
export function syncArchive(dir, sourceFile) {
  const arch = archPath(dir);
  if (!sourceFile || !fs.existsSync(sourceFile)) return archiveState(dir);
  const srcSize = fs.statSync(sourceFile).size;
  let have = fs.existsSync(arch) ? fs.statSync(arch).size : 0;
  if (have > srcSize || (have > 0 && !sameTail(arch, sourceFile, have))) have = 0;
  const end = lastNewlineEnd(sourceFile, srcSize);
  if (end > have) {
    fs.mkdirSync(dir, { recursive: true });
    const fd = fs.openSync(sourceFile, 'r');
    try {
      const buf = Buffer.alloc(4 * 1024 * 1024);
      let pos = have;
      while (pos < end) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, end - pos), pos);
        if (!n) break;
        fs.appendFileSync(arch, buf.subarray(0, n));
        pos += n;
      }
    } finally { fs.closeSync(fd); }
  }
  return archiveState(dir);
}

/** 回源读哪一份：源在就读源（那才是唯一真相）；源被清了才读归档，并带上 archived 让调用方如实声明。 */
export function effectiveSource(ledger) {
  const src = String(ledger.sourceFile ?? '').replace(/\\/g, '/');
  const arch = String(ledger.archiveFile ?? '').replace(/\\/g, '/');
  if (src && fs.existsSync(src)) return { file: src, archived: false };
  if (arch && fs.existsSync(arch)) return { file: arch, archived: true, archivedAt: archiveState(path.dirname(arch)).syncedAt };
  return { file: src || arch || null, archived: false, missing: true };
}

export function storeDir(root, sessionId) { return path.join(root, sessionId).replace(/\\/g, '/'); }

export function writeStore(root, built) {
  const dir = storeDir(root, built.sessionId);
  fs.mkdirSync(path.join(dir, 'segments'), { recursive: true });
  // 归档路径由存储层说了算，建账参数里给的不算——否则 --store 一换，ledger 会指向别处
  built.ledger.archiveFile = archPath(dir);
  fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify(built.ledger, null, 1));
  fs.writeFileSync(path.join(dir, 'facts.json'), JSON.stringify(built.facts, null, 1));
  fs.writeFileSync(path.join(dir, 'claims.json'), JSON.stringify(built.claims, null, 1));
  fs.writeFileSync(path.join(dir, 'index.md'), built.indexMd);
  for (const [id, card] of Object.entries(built.cards)) fs.writeFileSync(path.join(dir, 'segments', `${id}.md`), card);
  return dir;
}

export function loadLedger(root, sessionId) {
  const dir = storeDir(root, sessionId);
  const file = path.join(dir, 'ledger.json');
  if (!fs.existsSync(file)) throw new Error(`not indexed: ${sessionId} — run \`convledger index <file.jsonl>\` first`);
  return { dir, ledger: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

const idRe = /^S\d{2,}$/;

/** Resolve `S04,S05` / `S04-S07` / `all` specs against the ledger. */
export function resolveSegments(ledger, spec) {
  if (!spec || spec === 'all') return ledger.segments;
  const wanted = new Set();
  for (const part of String(spec).split(/[,\s]+/).filter(Boolean)) {
    const range = part.match(/^(S\d{2,})-(S\d{2,})$/i);
    if (range) {
      const a = ledger.segments.findIndex((s) => s.id === range[1].toUpperCase());
      const b = ledger.segments.findIndex((s) => s.id === range[2].toUpperCase());
      if (a < 0 || b < 0) throw new Error(`unknown segment in ${part}`);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) wanted.add(ledger.segments[i].id);
      continue;
    }
    if (!idRe.test(part.toUpperCase())) throw new Error(`bad segment spec: ${part} (use Sxx, Sxx-Syy, ids, or all)`);
    wanted.add(part.toUpperCase());
  }
  const out = ledger.segments.filter((s) => wanted.has(s.id));
  if (!out.length) throw new Error(`no such segment(s): ${spec}`);
  // 点名要三段、只给回两段时必须说清少了哪段：静默丢内容是这类工具最贵的一种错
  // （以前 card S01,S999 只印 S01 的卡，读者以为那两段就是这样）。
  const missing = [...wanted].filter((id) => !out.some((s) => s.id === id));
  if (missing.length) throw new Error(`no such segment(s): ${missing.join(', ')}（${spec} 里其余 ${out.length} 段能解引用；本账共 ${ledger.segments.length} 段，看 convledger show）`);
  return out;
}

/** Anchor = source line range. Verify the range still holds the bytes it held
 *  when the ledger was built; a deleted or rewritten log must say so loudly
 *  instead of quietly returning the wrong thing. 源不在了就对归档做同样的校验，
 *  返回值带 archived，调用方必须把它说出来。 */
export function checkAnchor(ledger, seg, source) {
  const ef = source ?? effectiveSource(ledger);
  if (!ef.file || !fs.existsSync(ef.file)) return { ok: false, missing: true, now: null, recorded: seg.contentHash, bytes: 0, archived: false };
  const lines = fs.readFileSync(ef.file, 'utf8').split('\n');
  const slice = lines.slice(seg.lineFrom - 1, seg.lineTo).join('\n');
  const now = sha(slice);
  return { ok: now === seg.contentHash, now, recorded: seg.contentHash, bytes: Buffer.byteLength(slice), archived: !!ef.archived };
}

/**
 * Render a segment's body straight from the runner's JSONL, applying the
 * truncation matrix in ./cost.mjs. --text = dialogue only, --full = no clipping.
 *
 * Bounded by default: a back-fill that blows the context it was meant to save
 * is self-defeating, so rendering stops at `max` tokens and tells the caller
 * which source line to resume from (`after`). `max: 0` lifts the bound.
 */
export function renderBody(ledger, segs, opts = {}) {
  const ef = effectiveSource(ledger);
  if (!ef.file || !fs.existsSync(ef.file)) throw new Error(`源日志与归档都读不到：${ledger.sourceFile}（画布服务过这段会话才有归档）`);
  const raw = normalizeRecords(ledger.runner, readJsonl(ef.file));
  const byLine = new Map(raw.map((r) => [r.__line, r]));
  // pair tool_use -> tool_result across the whole file: results often land outside the range
  const results = new Map();
  for (const r of raw) for (const b of blocksOf(r)) if (b?.type === 'tool_result') {
    const s = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? b.output ?? '');
    results.set(b.tool_use_id, s);
  }
  const clipMode = opts.full ? 'full' : opts.text ? 'text' : 'matrix';
  const budget = opts.max === 0 ? Infinity : (opts.max ?? BODY_BUDGET_TOKENS);
  const after = opts.after ?? 0;
  const out = [];
  const warnings = [];
  if (ef.archived) warnings.push(`⚠ 源日志已不在（${ledger.sourceFile}），以下正文读自账本归档 ${ef.archivedAt ? `（同步于 ${ef.archivedAt}）` : ''}——归档是源的最后一次逐字镜像，不是新的真相。`);
  let used = 0;
  let stopped = null;
  const emit = (s) => { out.push(s); used += tok(s); };
  for (const seg of segs) {
    const a = checkAnchor(ledger, seg, ef);
    if (!a.ok) warnings.push(`⚠ 锚点已断 ${seg.id} ${seg.anchor}：${a.missing ? '源与归档都读不到' : `${ef.archived ? '归档' : '源文件'}这段内容变了`}（recorded ${a.recorded} → now ${a.now}）。回答需标注来源已失效。`);
    emit(`\n===== ${seg.id} ${seg.anchor} | ${seg.kind} | turn ${seg.turnFrom}${seg.turnFrom === seg.turnTo ? '' : `-${seg.turnTo}`} | ${seg.toolCalls} 次工具调用 =====`);
    for (let line = Math.max(seg.lineFrom, after + 1); line <= seg.lineTo; line++) {
      if (used >= budget) { stopped = { segment: seg.id, line }; break; }
      const r = byLine.get(line);
      if (!r || (r.type !== 'user' && r.type !== 'assistant' && r.type !== 'system')) continue;
      const blocks = blocksOf(r);
      const who = r.type === 'user'
        ? (r.isCompactSummary ? 'COMPACT-SUMMARY(用户位)' : r.humanInput ? '用户' : blocks.some((b) => b?.type === 'tool_result') ? '工具回执→' : '注入→')
        : r.type;
      const texts = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
      const think = blocks.filter((b) => b?.type === 'thinking').map((b) => b.thinking ?? b.text ?? '').join('');
      const head = `--- L${line} ${who} ${String(r.timestamp ?? '').slice(11, 19)}`;
      if (r.type === 'system') { emit(`${head} ${r.subtype ?? ''} ${JSON.stringify(r.compactMetadata ?? {})}${texts.trim() ? `\n${texts}` : ''}`); continue; }
      if (texts.trim()) emit(`${head}\n${texts}`);
      if (think && clipMode !== 'text') emit(`${head} [thinking ${think.length} chars]`);
      for (const b of blocks) {
        if (b?.type === 'tool_use') {
          if (clipMode === 'text') continue;
          const inp = b.input ?? {};
          const body = typeof inp.command === 'string' ? inp.command : JSON.stringify(inp, null, 0);
          const limit = WRITE_TOOLS.has(b.name) ? ARTIFACT_CALL_LIMIT : CALL_LIMIT;
          const c = clipMode === 'full' ? { text: body, truncated: false } : clip(body, limit);
          emit(`${head} [call ${b.name}] ${c.text}`);
          const res = results.get(b.id);
          if (res && clipMode !== 'full') emit(`${head} [result ${b.name} ${Buffer.byteLength(res)}B] ${clip(res, RESULT_LIMIT).text}`);
          else if (res) emit(`${head} [result ${b.name} ${Buffer.byteLength(res)}B] ${res}`);
        } else if (b?.type === 'tool_result' && clipMode !== 'text' && !blocks.some((x) => x?.type === 'tool_use')) {
          const s = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
          emit(`${head} [result 独立 ${Buffer.byteLength(s)}B] ${clipMode === 'full' ? s : clip(s, RESULT_LIMIT).text}`);
        }
      }
    }
    if (stopped) break;
  }
  if (stopped) emit(`\n…[已到预算 ${budget} tok，停在 ${stopped.segment} L${stopped.line}] 续读：convledger body ${stopped.segment} --after ${stopped.line - 1}${opts.full ? ' --full' : ''}`);
  const text = [...warnings, ...out].join('\n');
  return { text, warnings, bytes: Buffer.byteLength(text), tokens: tok(text), segments: segs.map((s) => s.id), stopped, budget };
}

/** Find where a string occurs, by segment + source line, without ever copying the body.
 *  This is the fallback route (anchors first); a hit list is a POINTER, so it is capped
 *  and summarised — an uncapped context dump costs more than the read it was avoiding. */
export function searchLedger(ledger, needle, opts = {}) {
  const max = opts.max ?? 12;
  const ef = effectiveSource(ledger);
  if (!ef.file || !fs.existsSync(ef.file)) throw new Error(`源日志与归档都读不到：${ledger.sourceFile}`);
  const raw = normalizeRecords(ledger.runner, readJsonl(ef.file));
  const hits = [];
  const bySegment = {};
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  for (const r of raw) {
    if (!['user', 'assistant', 'system'].includes(r.type)) continue; // attachment/envelope records carry no prose
    const s = JSON.stringify(r.message ?? r);
    if (!re.test(s)) continue;
    const seg = ledger.segments.find((x) => r.__line >= x.lineFrom && r.__line <= x.lineTo);
    const m = String(s).match(re);
    const i = m ? String(s).indexOf(m[0]) : 0;
    const key = seg?.id ?? 'unsegmented';
    bySegment[key] = (bySegment[key] ?? 0) + 1;
    hits.push({ line: r.__line, segment: seg?.id ?? null, type: r.type, at: m ? s.slice(Math.max(0, i - 50), i + 90) : '' });
    if (hits.length >= max) break;
  }
  return { bySegment, scannedRecords: raw.length, hits, archived: !!ef.archived };
}

export function trace(root, sessionId, op, args, cost) {
  const dir = storeDir(root, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'trace.jsonl'), JSON.stringify({ ts: new Date().toISOString(), op, ...args, ...cost }) + '\n');
}

export function readTrace(root, sessionId) {
  const file = path.join(storeDir(root, sessionId), 'trace.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ---- 冻结区间：增量取证的唯一入口（PRD §6.4 / L1.2）----
// 只按原始字节记录 [fromByte,toByte)，到最后一个完整换行为止；前缀与区间各留完整
// SHA-256（lib 的 sha() 是 12 位短哈希，不能拿来冒充完整哈希）。行号、UUID 只作
// 导航，检查点身份是字节与哈希。
const fullSha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const newlineCount = (buf) => { let n = 0; for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++; return n; };
const lastNewlineIn = (buf) => buf.lastIndexOf(0x0a) + 1; // 没有换行时是 0

/**
 * 冻结源日志的一段：完整换行边界、完整哈希、前缀指纹、逐行可解析性。
 * `ok:false` 表示这段不能消费（区间内有完整但解析失败的行 / 来源不可核），
 * 调用方必须把它当阻塞材料报告，不能当空数据跳过，也不能自行把 toByte 往后挪。
 */
export function freezeSource(ledger, { fromByte = 0, toByte, source } = {}) {
  const ef = source ?? effectiveSource(ledger);
  if (!ef.file || !fs.existsSync(ef.file)) return { ok: false, code: 'source-missing', missing: true, archived: !!ef.archived, file: ef.file ?? null };
  if (!Number.isInteger(fromByte) || fromByte < 0) return { ok: false, code: 'bad-from', error: `fromByte 非法：${fromByte}` };

  const buf = fs.readFileSync(ef.file);
  const size = buf.length;
  if (fromByte > size) return { ok: false, code: 'truncated', file: ef.file, sizeAtFreeze: size, fromByte, error: `源只有 ${size} 字节，已消费位置 ${fromByte} 之后被截断` };
  if (fromByte > 0 && buf[fromByte - 1] !== 0x0a) return { ok: false, code: 'misaligned', file: ef.file, error: `${fromByte} 不在行首（前一个字节不是换行）` };

  const lastEnd = Math.max(fromByte, lastNewlineIn(buf));
  if (toByte != null) {
    if (!Number.isInteger(toByte) || toByte < fromByte || toByte > lastEnd) return { ok: false, code: 'bad-to', file: ef.file, error: `toByte 非法：${toByte}（区间 ${fromByte}..${lastEnd}）` };
    if (toByte !== lastEnd && buf[toByte - 1] !== 0x0a) return { ok: false, code: 'misaligned-to', file: ef.file, error: `${toByte} 不在行尾` };
  }
  const end = toByte == null ? lastEnd : toByte;
  const slice = buf.subarray(fromByte, end);
  const prefix = buf.subarray(0, fromByte);
  const fromLine = 1 + newlineCount(prefix);

  const records = [];
  const badLines = [];
  let at = fromByte;
  let line = fromLine;
  while (at < end) {
    const nl = buf.indexOf(0x0a, at);
    const lineEnd = nl < 0 || nl >= end ? end : nl;
    const text = buf.subarray(at, lineEnd).toString('utf8');
    if (text.trim()) {
      const rec = { line, fromByte: at, toByte: lineEnd, bytes: lineEnd - at };
      try {
        const parsed = JSON.parse(text);
        rec.ok = true;
        rec.type = parsed?.type ?? null;
        rec.uuid = parsed?.uuid ?? parsed?.id ?? null;
      } catch (e) {
        rec.ok = false;
        rec.error = String(e?.message ?? e);
        badLines.push(rec);
      }
      records.push(rec);
    }
    at = lineEnd + 1;
    line++;
  }

  return {
    ok: badLines.length === 0,
    file: ef.file,
    sourceMode: ef.archived ? 'archived' : 'source',
    archivedAt: ef.archivedAt ?? null,
    fromByte, toByte: end, fromLine, toLine: fromLine + records.length - 1,
    prefixBytes: fromByte, prefixSha256: fullSha(prefix),
    sizeAtFreeze: size,
    batchSha256: fullSha(slice), batchBytes: end - fromByte,
    generation: `${fullSha(prefix).slice(0, 16)}@${size}`,
    records, badLines,
    halfLine: { fromByte: end, bytes: size - end },
    error: badLines.length
      ? `区间内有 ${badLines.length} 行完整但解析失败（首行 L${badLines[0].line}）——这是阻塞材料，不能当空数据跳过`
      : null,
  };
}

/**
 * 拿上一次冻结的检查点核对当前来源：前缀被改写、区间内容变了、被截断都必须拒绝；
 * 区间之后只追加是正常的，留给下一批。来源换成归档时如实标 archived。
 */
export function verifyFrozen(prev, { ledger, source } = {}) {
  if (!prev?.file) return { ok: false, code: 'no-checkpoint' };
  // 检查点在状态文件里叫 analyzedThrough；模块内统一成 fromByte/toByte。
  const from = prev.fromByte ?? 0;
  const to = prev.toByte ?? prev.analyzedThrough;
  const now = freezeSource(ledger ?? { sourceFile: prev.file }, { fromByte: from, source });
  if (now.code === 'source-missing') return { ok: false, code: 'source-missing', file: now.file };
  if (!now.file) return { ok: false, code: now.code ?? 'unreadable' };
  if (now.code === 'truncated') return { ok: false, code: 'truncated', sizeAtFreeze: now.sizeAtFreeze, expectedToByte: to };
  if (now.prefixSha256 !== prev.prefixSha256) return { ok: false, code: 'prefix-rewritten', recorded: prev.prefixSha256, now: now.prefixSha256 };
  if (now.sourceMode !== (prev.sourceMode ?? 'source')) return { ok: false, code: 'source-switched', recorded: prev.sourceMode ?? 'source', now: now.sourceMode };

  const buf = fs.readFileSync(now.file);
  const middle = fullSha(buf.subarray(from, Math.min(to, buf.length)));
  if (middle !== prev.batchSha256) return { ok: false, code: 'range-rewritten', recorded: prev.batchSha256, now: middle };
  return { ok: true, appendedBytes: buf.length - to, consumedTo: to, file: now.file, sourceMode: now.sourceMode };
}

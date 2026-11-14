// 增量编排的机械部分：工具调用与回执的跨批次关联、未决调用的持久化。
// 这里不调用模型、不做语义判断——只回答「哪次调用还没有结果」「结果是不是重复」
// 「这条回执找不到调用」。语义归并留给当前 agent（PRD §6.1）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { blocksOf, tok, toolOpOf } from './lib.mjs';
import { freezeSource, verifyFrozen } from './store.mjs';
import { normalizeRecords } from './project.mjs';
import { NEW_MATERIAL_TOKENS } from './cost.mjs';

/** 一批规范化记录里的调用与回执。配对按 tool_use_id，不按位置：结果常常落在
 *  别的回合甚至别的批次里，位置配对会把晚到的结果错挂给后一次调用。 */
export function associateTools(records) {
  const calls = [];
  const results = [];
  for (const r of records) {
    for (const b of blocksOf(r)) {
      if (b?.type === 'tool_use') calls.push({ id: b.id, name: b.name, line: r.__line, uuid: r.uuid ?? null });
      else if (b?.type === 'tool_result') results.push({ id: b.tool_use_id, line: r.__line, uuid: r.uuid ?? null, isError: !!b.is_error });
    }
  }

  const firstResult = new Map();
  const pairs = [];
  const duplicates = [];
  const orphans = [];
  for (const res of results) {
    if (firstResult.has(res.id)) { duplicates.push({ ...res, firstLine: firstResult.get(res.id).line }); continue; }
    firstResult.set(res.id, res);
    const call = calls.find((c) => c.id === res.id);
    if (call) pairs.push({ ...res, callLine: call.line, name: call.name });
    else orphans.push(res);
  }
  return {
    calls, results, pairs, duplicates, orphans,
    pending: calls.filter((c) => !firstResult.has(c.id)),
  };
}

/**
 * 把一批关联结果并进持久状态。返回解析出的（可能属于更早批次的）调用结果。
 * 未决调用只按 id 记一份；回执按 id@line 去重；找不到调用的回执保留待关联，
 * 不丢——它可能就是晚到的子任务报告。
 */
export function mergePending(prev, batch, { sessionId } = {}) {
  const state = {
    sessionId: sessionId ?? prev?.sessionId ?? null,
    calls: [...(prev?.calls ?? [])],
    results: [...(prev?.results ?? [])],
    orphans: [...(prev?.orphans ?? [])],
  };
  const openCalls = new Map(state.calls.map((c) => [c.id, c]));
  const seenResults = new Set(state.results.map((r) => `${r.id}@${r.line}`));
  const answered = new Set(state.results.map((r) => r.id));
  const resolved = [];

  for (const c of batch.calls) if (!openCalls.has(c.id)) openCalls.set(c.id, c);
  for (const r of batch.results) {
    const key = `${r.id}@${r.line}`;
    if (seenResults.has(key) || answered.has(r.id)) continue;   // 同一调用的重复回执不记第二遍
    const hit = openCalls.get(r.id);
    if (hit) { openCalls.delete(r.id); resolved.push({ id: r.id, name: hit.name, callLine: hit.line, resultLine: r.line, isError: !!r.isError }); }
    else state.orphans.push({ id: r.id, line: r.line, isError: !!r.isError });
    state.results.push({ id: r.id, line: r.line, isError: !!r.isError });
    seenResults.add(key);
    answered.add(r.id);
  }
  state.calls = [...openCalls.values()];
  return { state, resolved };
}

// shortcut: 未决调用先落在会话账本目录；L2 的项目状态文件落地后收进去，
// 同一会话同一时刻只允许一个写者，所以这里只做原子替换、不做锁。
export const pendingFile = (root, sessionId) => path.join(root, sessionId, 'pending-calls.json').replace(/\\/g, '/');

export function readPending(root, sessionId) {
  const file = pendingFile(root, sessionId);
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { sessionId, calls: j.calls ?? [], results: j.results ?? [], orphans: j.orphans ?? [] };
  } catch {
    return { sessionId, calls: [], results: [], orphans: [] };
  }
}

export function writePending(root, sessionId, state) {
  const file = pendingFile(root, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...state, sessionId, updatedAt: new Date().toISOString() }, null, 1));
  fs.renameSync(tmp, file);
  return file;
}

/** 工具自己的维护调用：那是流水线回执，不是项目进展。只认命令形状，
 *  不按「消息里出现 convledger」整条丢——同一回复里的真实决定必须留下。 */
const MAINT_SUB = /\bconvledger\.mjs\b[\s\S]{0,160}?\b(sync|progress|export|memory|claim|summarise|phases|index|archive)\b/i;
export const isMaintenanceCall = (call) => /^(Bash|run|Shell|PowerShell|exec_command)$/i.test(String(call?.name ?? ''))
  && MAINT_SUB.test(String(call?.arg ?? call?.command ?? ''));

// ---- 批次身份与 prepare 的机械部分（L2.3）----
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** batchId 由项目、会话、冻结区间、原文哈希与基准版本决定：同样素材重来得到同一个 id，
 *  原文一变就换 id，模型不能自报已消费位置。 */
export function makeBatchId({ project, sessionId, frozen, baseRevision }) {
  return sha256([project, sessionId, frozen.fromByte, frozen.toByte, frozen.batchSha256, baseRevision].join('|')).slice(0, 24);
}

/** 冻结区间里的调用/回执配对（put 成功后用来维护未决调用）。 */
export function associateBatch(ledger, frozen) {
  const text = fs.readFileSync(frozen.file).subarray(frozen.fromByte, frozen.toByte).toString('utf8');
  const raw = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { raw.push(JSON.parse(line)); } catch { /* freezeSource 已排除坏行 */ }
  }
  return associateTools(normalizeRecords(ledger.runner, raw));
}

/** 把冻结区间变成给模型看的材料：只收真人原话、assistant 结论和写/改类调用摘要。
 *  工具回执、读/搜/运行类调用、系统提醒、attachment 和控制记录不进素材；它们不是记忆，只会把工作单元撑大。
 *  预算按完整记录切：放不下的记录不装、也不越过它推进游标（coveredToByte 指到上一条为止）。 */
export function materialUnits(frozen, { runner, budget = NEW_MATERIAL_TOKENS } = {}) {
  const text = fs.readFileSync(frozen.file).subarray(frozen.fromByte, frozen.toByte).toString('utf8');
  const raw = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { raw.push(JSON.parse(line)); } catch { /* freezeSource 已判定区间内没有坏行 */ }
  }
  const norm = normalizeRecords(runner, raw);
  const units = [];
  let used = 0;
  let coveredToByte = frozen.fromByte;
  let omittedFrom = null;
  let oversized = false;

  for (let i = 0; i < norm.length; i++) {
    const r = norm[i];
    const blocks = blocksOf(r);
    const prose = blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n').trim();
    const calls = blocks.filter((b) => b?.type === 'tool_use' && ['write', 'edit'].includes(toolOpOf(b.name)))
      .map((b) => `[call ${b.name}] ${String(b.input?.command ?? JSON.stringify(b.input ?? {})).slice(0, 160)}`);
    // 工具回执不是记忆；读/搜/跑也不是。只保留写/改类调用作为状态变化线索。
    const body = [prose, ...calls].filter(Boolean).join('\n');
    const cost = body ? tok(body) : 0;
    const fits = used + cost <= budget;
    if (!fits && units.length) { omittedFrom = frozen.records[i]?.line ?? null; break; }
    if (!fits && !units.length) oversized = true;   // 单条就超预算：仍然装它，否则永远推不动
    used += cost;
    if (body) units.push({ line: frozen.records[i]?.line ?? r.__line ?? null, type: r.type, text: body, tokens: cost, oversized });
    coveredToByte = frozen.records[i] ? frozen.records[i].toByte + 1 : coveredToByte;
  }
  return { units, used, budget, coveredToByte, omittedFrom, oversized };
}

/** prepare 只冻结素材、算出批次身份；不写状态、不推进游标。 */
export function prepareBatch({ ledger, projectKey, sessionId, fromByte = 0, baseRevision = 0, budget = NEW_MATERIAL_TOKENS, checkpoint = null }) {
  if (checkpoint) {
    const v = verifyFrozen({ file: checkpoint.file ?? ledger.sourceFile, ...checkpoint }, { ledger });
    if (!v.ok) {
      const err = new Error(`上次检查点与当前源对不上（${v.code}）——重新核对，不要跳过`);
      err.code = 'checkpoint-mismatch';
      err.detail = v;
      throw err;
    }
  }
  const full = freezeSource(ledger, { fromByte });
  if (!full.file) {
    const err = new Error(full.code === 'source-missing' ? '源日志与归档都读不到，无法冻结素材' : `冻结失败：${full.code}`);
    err.code = full.code ?? 'freeze-failed';
    throw err;
  }
  if (!full.ok) {
    const err = new Error(full.error);
    err.code = 'blocked-material';
    err.badLines = full.badLines;
    throw err;
  }
  const first = materialUnits(full, { runner: ledger.runner, budget });
  const frozen = first.coveredToByte < full.toByte
    ? freezeSource(ledger, { fromByte, toByte: first.coveredToByte })
    : full;
  if (!frozen.file || (!frozen.ok && frozen.code)) {
    const err = new Error(`按预算切批后冻结失败：${frozen.code ?? 'unknown'}`);
    err.code = frozen.code ?? 'freeze-failed';
    throw err;
  }
  const material = frozen.toByte === full.toByte ? first : { ...first, coveredToByte: frozen.toByte };
  return {
    projectKey, sessionId, baseRevision, frozen,
    material: { units: material.units, used: material.used, budget: material.budget, omittedFrom: material.omittedFrom, oversized: material.oversized },
    batchId: makeBatchId({ project: projectKey, sessionId, frozen, baseRevision }),
  };
}

/** put 前再核一次：区间之后只追加是正常的；前缀/区间改写、截断、换源都拒绝。 */
export function verifyPrepared(prepared, { ledger } = {}) {
  const v = verifyFrozen(prepared.frozen, { ledger });
  if (!v.ok) return v;
  return { ok: true, batchId: prepared.batchId, consumedTo: prepared.frozen.toByte, appendedBytes: v.appendedBytes, sourceMode: v.sourceMode };
}

/** 行号 → 行首字节偏移。只给受控的「从这一行开始」入口用；读一次源文件。 */
export function byteOffsetOfLine(file, lineNo) {
  const buf = fs.readFileSync(file);
  if (!Number.isInteger(lineNo) || lineNo < 1) return null;
  let at = 0;
  for (let n = 1; n < lineNo; n++) {
    const nl = buf.indexOf(0x0a, at);
    if (nl < 0) return null;   // 没这么多行
    at = nl + 1;
  }
  return at;
}

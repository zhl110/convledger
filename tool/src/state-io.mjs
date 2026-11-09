// 项目状态的落盘原语：路径、原子替换、本机锁、带 batchId 的幂等提交。
// 只做机械工作，不做语义判断；一次提交里任务、事件、游标、回执一起换掉。
// 不承诺跨文件事务：记忆发布是第二个事务，由调用方各自报告成功。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createState, validateState, projectView, SCHEMA } from './progress.mjs';
import { projectKey } from './current.mjs';

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** 项目状态与账本同级：store 的上一级 /projects/<键>/progress-state.json（--store 隔离时一起隔离）。 */
export const stateDir = (root, projectKey) => path.resolve(root, '..', 'projects', projectKey);
export const stateFile = (root, projectKey) => path.join(stateDir(root, projectKey), 'progress-state.json');

const conflict = (msg, code = 'conflict') => Object.assign(new Error(msg), { code });

export function readState(root, projectKey) {
  const file = stateFile(root, projectKey);
  if (!fs.existsSync(file)) return { state: createState(projectKey), existed: false, file };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
    throw Object.assign(new Error(`${file} 不是合法 JSON——拒绝当成空状态覆盖`), { code: 'bad-state' });
  }
  if (parsed?.schema !== SCHEMA) throw Object.assign(new Error(`${file} 是未知 schema（${parsed?.schema}），拒绝按空表重写`), { code: 'unknown-schema' });
  return { state: parsed, existed: true, file };
}

/** 同目录临时文件 → fsync → rename。崩在半路只会留下 .tmp，不会留下半截状态。 */
export function writeState(root, projectKey, state) {
  const dir = stateDir(root, projectKey);
  fs.mkdirSync(dir, { recursive: true });
  const file = stateFile(root, projectKey);
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, JSON.stringify(state, null, 1)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  return file;
}

/** 本机锁：只认原子创建。占用时返回 busy 与持有者，不按超时删别人的锁。 */
export function acquireLock(dir, { waitMs = 2000, pollMs = 20 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'progress.lock');
  const deadline = Date.now() + waitMs;
  const sleep = (ms) => { const end = Date.now() + ms; while (Date.now() < end); };
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString() })); } finally { fs.closeSync(fd); }
      return { file, release() { try { fs.unlinkSync(file); } catch { /* 已被别人清掉 */ } } };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() >= deadline) {
        let holder = null;
        try { holder = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 锁文件坏 = 持有者不明 */ }
        throw Object.assign(new Error(`项目写锁被占用${holder ? `（pid ${holder.pid} @ ${holder.host}，${holder.at}）` : '，持有者不明'}；不自动删除别人的锁`), { code: 'busy', holder });
      }
      sleep(pollMs);
    }
  }
}

/**
 * 一次提交：锁内读 → 校验基准版本 → 应用 → 状态与批次回执一起原子替换。
 * 同 batchId 同载荷重放返回原回执（不重复加任务/事件）；同 id 不同载荷是冲突。
 * `beforeWrite` 只给故障注入用：它抛错就什么都不写，游标与任务一起回到提交前。
 */
export function commitBatch(root, projectKey, { batchId, requestSha, baseRevision, apply, beforeWrite, now = new Date().toISOString() }) {
  if (!batchId) throw conflict('缺 batchId', 'bad-batch');
  const dir = stateDir(root, projectKey);
  const lock = acquireLock(dir);
  try {
    const { state } = readState(root, projectKey);
    const prev = (state.batches ?? []).find((b) => b.batchId === batchId);
    if (prev) {
      if (prev.requestSha !== requestSha) throw conflict(`batch ${batchId} 已用别的载荷提交过（记录 ${prev.requestSha.slice(0, 8)}，本次 ${String(requestSha).slice(0, 8)}）`);
      return { replayed: true, state, receipt: prev.receipt };
    }
    if (!Number.isInteger(baseRevision) || baseRevision !== state.revision) {
      throw conflict(`基准版本 ${baseRevision} 已过期（当前 ${state.revision}）——重新取材，不要覆盖`);
    }
    const { state: next, receipt } = apply(structuredClone(state));
    if (beforeWrite) beforeWrite(next);
    next.batches = [...(next.batches ?? []), { batchId, requestSha, resultSha: sha256(JSON.stringify(receipt)), at: now, receipt }];
    const check = validateState(next);
    if (!check.ok) {
      const err = new Error(`提交后状态不合法：${check.errors.slice(0, 5).join(' | ')}`);
      err.code = 'invalid-state';
      err.errors = check.errors;
      throw err;
    }
    writeState(root, projectKey, next);
    return { replayed: false, state: next, receipt };
  } finally {
    lock.release();
  }
}

// ---- prepare 的短期批次元数据：put 用同一份冻结范围，不重算、不信任模型自报的位置 ----
export const preparedDir = (root, projectKey) => path.join(stateDir(root, projectKey), 'prepared');
export const preparedFile = (root, projectKey, batchId) => path.join(preparedDir(root, projectKey), `${batchId}.json`);

export function writePrepared(root, projectKey, prepared) {
  const file = preparedFile(root, projectKey, prepared.batchId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(prepared, null, 1) + '\n');
  return file;
}

export function readPrepared(root, projectKey, batchId) {
  const file = preparedFile(root, projectKey, batchId);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function dropPrepared(root, projectKey, batchId) {
  try { fs.rmSync(preparedFile(root, projectKey, batchId), { force: true }); } catch { /* 已删 */ }
}

/** 账本外的簿记更新（outbox 回填、候选生命周期）：同一把锁、同样原子写，
 *  但不推进任务 revision——它不是新的任务事实。 */
export function updateState(root, projectKey, fn) {
  const dir = stateDir(root, projectKey);
  const lock = acquireLock(dir);
  try {
    const { state } = readState(root, projectKey);
    const next = fn(structuredClone(state)) ?? state;
    writeState(root, projectKey, next);
    return next;
  } finally {
    lock.release();
  }
}

/** brief 里的一行项目指针：预算内只给任务版本、计数、最近欠项与命令。
 *  没有任务状态的项目返回 null——brief 不替空项目编进度。 */
export function projectBriefLine(root, cwd) {
  try {
    const key = projectKey(cwd);
    if (!fs.existsSync(stateFile(root, key))) return null;
    const state = readState(root, key).state;
    const v = projectView(state);
    if (!v.tasks.length) return null;
    const c = v.counts.project;
    const pending = v.tasks
      .filter((t) => t.status === 'active' || t.status === 'blocked' || t.status === 'awaiting-verification')
      .slice(0, 3)
      .map((t) => `${t.id} ${t.short}${t.nextAction ? `：${t.nextAction}` : ''}`);
    return `项目任务（r${state.revision}）：完成 ${c.done}/${c.inScope} · 进行中 ${c.active} · 待验证 ${c.awaiting} · 欠项：${pending.join('；') || '—'}（convledger progress --project ${key}）`;
  } catch { return null; }
}

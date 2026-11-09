// 当前会话解析：`map` 要服务的是「跑这条命令的那段会话」，不是 store 里的随便一段。
// 宿主不导出会话 id（实测 Qoder 的进程环境里没有），所以按可核实的信号排优先级：
//   --session > CONVLEDGER_SESSION > 同 cwd 且源文件最新 > 最新写入的那段。
// cwd 只读文件头 64KB：两个族都实测在前 64KB 内（Qoder 的 workspace-directories、
// WorkBuddy 的逐条 cwd），为了判一个会话去读 86MB 的整份日志不划算。
import fs from 'node:fs';
import path from 'node:path';
import { listSessions } from './project.mjs';
import { sha } from './lib.mjs';

const HEAD_BYTES = 64 * 1024;

export const normCwd = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** 项目键只由归组用的路径决定：账本重建、目录搬家都不该换键。
 *  定义跟在 normCwd 旁边，是为了让「身份」和「归组」共用同一把尺。 */
export const projectKey = (p) => `p-${sha(normCwd(p))}`;

/** 文件头的 cwd：Qoder 记在 workspace-directories 数组里，其余 runner 逐条带。 */
export function cwdFromHead(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
      if (!line) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }   // 头 64KB 可能切在行中间
      if (r.type === 'workspace-directories' && Array.isArray(r.directories) && r.directories[0]) return r.directories[0];
      if (typeof r.cwd === 'string' && r.cwd) return r.cwd;
    }
  } catch { /* 读不了就当没有 cwd，交给下一档 */ } finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}

const indexedIds = (root) => new Set(fs.existsSync(root)
  ? fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'ledger.json')))
  : []);

function ledgerCwd(root, id) {
  try { return JSON.parse(fs.readFileSync(path.join(root, id, 'ledger.json'), 'utf8')).cwd ?? null; } catch { return null; }
}

const ageMin = (iso) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));

/**
 * @returns {{sessionId,file,runner,cwd,reason,ageMin,indexed,sourceMissing?}|{error}}
 * reason: preferred（--session/env）· cwd（同工作目录里最新的源）· newest（没有 cwd 对得上的，取最新写入）
 * sessions 只为自测留的注入口：默认就是这台机器上的真实会话表。
 */
export function resolveCurrent({ root, cwd = process.cwd(), preferred = process.env.CONVLEDGER_SESSION, sessions } = {}) {
  const all = sessions ?? listSessions();   // mtime 倒序
  const indexed = indexedIds(root);
  const row = (s, reason, extra = {}) => ({
    sessionId: s.sessionId, file: s.file, runner: s.runner,
    // 有些宿主的会话表里没有 cwd（Qoder 就是）：不补这一串，带 --session 反而比不带更瞎
    // ——调用方拿不到 cwd 就认不出项目，只能退回「store 里有 40 个项目」。
    cwd: s.cwd ?? (s.file ? cwdFromHead(s.file) : null) ?? ledgerCwd(root, s.sessionId) ?? null,
    reason, ageMin: ageMin(s.mtime), indexed: indexed.has(s.sessionId), ...extra,
  });

  if (preferred) {
    const p = String(preferred).toLowerCase();
    const hit = all.find((s) => s.sessionId.toLowerCase().startsWith(p));
    if (hit) return row(hit, 'preferred');
    // 源文件已被运行器清掉、但账本还在：仍认这个 id，让画布用最后一次构建 + 归档
    const keep = [...indexed].find((id) => id.toLowerCase().startsWith(p));
    if (keep) return { sessionId: keep, file: null, runner: null, cwd: ledgerCwd(root, keep), reason: 'preferred', ageMin: null, indexed: true, sourceMissing: true };
    return { error: `没有以 ${preferred} 开头的会话（${all.length} 段源、${indexed.size} 本账都查了）` };
  }

  const want = normCwd(cwd);
  if (want) {
    for (const s of all) {
      const c = indexed.has(s.sessionId) ? (ledgerCwd(root, s.sessionId) ?? cwdFromHead(s.file)) : cwdFromHead(s.file);
      if (normCwd(c) === want) return row(s, 'cwd', { cwd: c });
    }
  }
  if (all.length) return row(all[0], 'newest', { cwd: cwdFromHead(all[0].file) });
  return { error: '一份会话源都没找到（已知根目录下没有 .jsonl）' };
}

/**
 * 自动写入口只走这里：会话必须显式给出（完整或唯一前缀），项目由 cwd 决定且必须对得上。
 * 旧的 resolveCurrent 保留给只读画布——「同 cwd 最新写入的那段」不能决定往哪里写。
 * @returns {{ok:true,sessionId,runner,file,cwd,projectKey,sourceMode,archivedAt,indexed}
 *          |{ok:false,code,error,candidates?}}
 */
export function resolveWriteTarget({ root, cwd, session, sessions } = {}) {
  const spec = String(session ?? '').trim().toLowerCase();
  if (!spec) return { ok: false, code: 'no-session', error: '自动写入口必须显式给会话 id（完整或唯一前缀）' };
  if (spec.length < 8) return { ok: false, code: 'short-prefix', error: `会话前缀至少 8 位：「${session}」` };

  const all = sessions ?? listSessions();
  const indexed = [...indexedIds(root)];
  const ids = [...new Set([...all.map((s) => s.sessionId), ...indexed])];
  const exact = ids.filter((id) => id.toLowerCase() === spec);
  const hits = exact.length ? exact : ids.filter((id) => id.toLowerCase().startsWith(spec));
  if (!hits.length) return { ok: false, code: 'no-such-session', error: `没有以 ${session} 开头的会话（源 ${all.length} 段 / 账本 ${indexed.length} 本）` };
  if (hits.length > 1) return { ok: false, code: 'ambiguous-session', candidates: hits, error: `前缀 ${session} 命中 ${hits.length} 段会话，写入口不取第一个：${hits.join(', ')}` };

  const id = hits[0];
  const row = all.find((s) => s.sessionId === id) ?? null;
  const rowCwd = row?.cwd ?? (row?.file ? cwdFromHead(row.file) : null) ?? ledgerCwd(root, id);
  if (!rowCwd) return { ok: false, code: 'no-cwd', error: `会话 ${id} 没有可确认的 cwd，无法归到项目` };
  if (!cwd) return { ok: false, code: 'no-cwd-given', error: '写入口必须给出 cwd（项目由它决定）' };
  if (normCwd(rowCwd) !== normCwd(cwd)) return { ok: false, code: 'project-mismatch', error: `会话属于 ${rowCwd}，不是 ${cwd}` };

  const key = projectKey(cwd);
  if (!row) {
    // 源不在了、账本还在：证书来自归档或账本记录，不能冒充实时来源
    let src = null;
    try { src = JSON.parse(fs.readFileSync(path.join(root, id, 'ledger.json'), 'utf8')).sourceFile ?? null; } catch { /* 读不到 */ }
    const alive = !!src && fs.existsSync(src);
    return { ok: true, sessionId: id, runner: null, file: alive ? src : null, cwd: rowCwd, projectKey: key, sourceMode: alive ? 'source' : 'archived', archivedAt: null, indexed: true };
  }
  return { ok: true, sessionId: id, runner: row.runner, file: row.file, cwd: rowCwd, projectKey: key, sourceMode: 'source', archivedAt: null, indexed: indexed.includes(id) };
}

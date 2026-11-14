// 内部会话登记表：记录「本工具派的后台工作会话」的 id。
// 目的两条：① 收尾复用同一段工作会话（send_message 续派），不再每次新开，封顶 1 段；
//          ② 这些会话本身也是被收录的对话，要从会话库/画像统计里隐藏，别越攒越多又反过来自我催。
// 存 store 根下 internal-sessions.json（派生数据，可重建；不入库）。工具零模型，只做机械读写。
import fs from 'node:fs';
import path from 'node:path';

const FILE = (store) => path.join(store, 'internal-sessions.json');
const read = (store) => {
  try {
    const d = JSON.parse(fs.readFileSync(FILE(store), 'utf8'));
    return { worker: d.worker ?? null, workers: d.workers ?? {}, sids: d.sids ?? {} };
  } catch { return { worker: null, workers: {}, sids: {} }; }
};
const write = (store, data) => {
  try { fs.mkdirSync(store, { recursive: true }); fs.writeFileSync(FILE(store), JSON.stringify(data, null, 1)); return true; }
  catch { return false; }
};

export function readInternal(store) { return read(store); }
export function isInternal(store, sid) { if (!sid) return false; return !!read(store).sids?.[sid]; }
// 宿主各有一个 worker（Qoder 是聊天会话，OpenCode 是它自己的会话）：同一段不能被另一家复用。
export function getWorker(store, host = 'default') {
  const d = read(store);
  return host === 'default' ? (d.workers?.default ?? d.worker ?? null) : (d.workers?.[host] ?? null);
}
export function addInternal(store, sid) {
  if (!sid) return null;
  const d = read(store);
  d.sids = d.sids ?? {};
  if (!d.sids[sid]) d.sids[sid] = { at: new Date().toISOString() };
  write(store, d);
  return d;
}
export function setWorker(store, sid, host = 'default') {
  if (!sid) return null;
  const d = addInternal(store, sid);
  if (!d) return null;
  d.workers = d.workers ?? {};
  d.workers[host] = sid;
  if (host === 'default') d.worker = sid;
  write(store, d);
  return d;
}
export function clearWorker(store, host = 'default') {
  const d = read(store);
  if (host === 'default') { d.worker = null; if (d.workers) d.workers.default = null; }
  else if (d.workers) d.workers[host] = null;
  write(store, d);
  return d;
}

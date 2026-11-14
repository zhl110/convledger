// 后台刷新 worker（PRD-refresh.md）。重算都在这条线程上跑，主线程只服务缓存。
// 收 job：view＝(可选 build+writeStore)+readView；status＝statusSnapshot+libraryOf。
// 算完整份 post 回主线程，由主线程原子换缓存——主线程从不 readView 一个半写的 store。
import { parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { syncArchive } from './store.mjs';
import { indexWindowed } from './window.mjs';
import { readView } from './view.mjs';
import { statusSnapshot } from './status.mjs';
import { libraryOf } from './library.mjs';
import { listSessions } from './project.mjs';
import { coreSig, humanSig } from './refresh.mjs';
import { usageReport } from './usage.mjs';
import { projectsOf } from './projects.mjs';
import { projectView } from './progress.mjs';
import { projectLive } from './project-live.mjs';
import { readState } from './state-io.mjs';
import { projectExperience, projectProfile } from './insights.mjs';
import { memoryDue } from './profile-auto.mjs';

async function viewJob({ root, dir, rebuild }) {
  if (rebuild) {
    const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'ledger.json'), 'utf8'));
    if (ledger.runner === 'opencode') {
      // 懒 import：非 opencode 会话不必把 node:sqlite 拉进 worker
      try { const { syncOpencodeSession } = await import('./opencode.mjs'); syncOpencodeSession(ledger.sessionId); } catch { /* 投影失败不挡重建 */ }
    }
    const sourceFile = ledger.sourceFile;
    if (sourceFile && fs.existsSync(sourceFile)) {
      syncArchive(dir, sourceFile);
      indexWindowed(sourceFile, { storeRoot: root });
    }
  }
  const payload = readView(dir);
  return { payload, core: coreSig(dir), human: humanSig(dir) };
}

// 自动建账 sweep（PRD-load §2.2）：廉价 stat 枚举源 → 滤未建账 → active 模式只留 live →
// 每轮封顶 cap、串行 build。整段在 worker 上跑，主线程永远空闲。off 一个不建，all 建全部。
function sweepJob({ root, mode, liveMin, cap }) {
  if (mode === 'off') return { built: [] };
  const have = new Set(fs.existsSync(root)
    ? fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'ledger.json')))
    : []);
  const now = Date.now();
  let fresh = listSessions().filter((s) => s.bytes > 20000 && !have.has(s.sessionId));
  if (mode === 'active') fresh = fresh.filter((s) => (now - (Date.parse(s.mtime) || 0)) <= liveMin * 60000);
  const built = [];
  // listSessions 已按 mtime 倒序：最新的先建。封顶 cap（默认 1）＋主线程 15s 节流＝有界。
  for (const s of fresh.slice(0, Math.max(1, cap || 1))) {
    try { indexWindowed(s.file, { storeRoot: root }); built.push(s.sessionId); } catch { /* 一段建不起来不拖垮别的 */ }
  }
  return { built };
}

// 打开未建账会话（PRD-load §2.4 / RULES §13）：长历史只建尾部一片，建完落盘＋归档，
// 下一轮 poll 出真视图；更早的记录由 Stop 每轮补一片，首次打开绝不整段全建。
function buildJob({ root, dir, sourceFile }) {
  if (!sourceFile || !fs.existsSync(sourceFile)) return { dir, built: false };
  indexWindowed(sourceFile, { storeRoot: root });
  try { syncArchive(dir, sourceFile); } catch { /* 归档失败不挡建账 */ }
  return { dir, built: true };
}

// 项目清单：名字来自 projectsOf（全库），行数据只读 progress-state.json。
// 原来这段在 map 主线程同步跑，单次 11.7 秒，5 秒轮询直接把 hub 卡死。
function projectsJob({ root }) {
  const dir = path.resolve(root, '..', 'projects');
  let all = [];
  try { all = projectsOf(root, { withSteps: false }).projects; } catch { /* 名字取不到就用键 */ }
  const names = new Map(all.map((p) => [p.key, p.name]));
  // 空状态页要列项目成员，也一并随缓存回来，省得主线程再扫一次全库。
  const membersByKey = Object.fromEntries(all.map((p) => [p.key, p.members ?? []]));
  const rootKeys = all.filter((p) => p.root).map((p) => p.key);
  const rows = [];
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { /* 还没有 projects 目录 */ }
  for (const key of entries) {
    if (!/^p-[0-9a-f]{12}$/.test(key) || !fs.existsSync(path.join(dir, key, 'progress-state.json'))) continue;
    try {
      const state = readState(root, key).state;
      const v = projectView(state);
      rows.push({ key, name: names.get(key) ?? key, revision: state.revision, tasks: v.tasks.length, counts: v.counts.project });
    } catch { /* 坏状态不列 */ }
  }
  rows.sort((a, b) => b.revision - a.revision || a.name.localeCompare(b.name));
  return { projects: rows, membersByKey, rootKeys };
}

// 项目页的四条全库重活合成一趟：live / 经验 / 画像 / 记忆欠项。
function projectJob({ root, key }) {
  let state = null;
  try { state = readState(root, key).state; } catch { /* 没有状态文件时按空状态渲染 */ }
  const live = projectLive(root, key, state);
  let experience = { groups: [], total: 0, sessions: 0 };
  let profile = { project: {}, user: {} };
  let memory = null;
  try { experience = projectExperience(root, key); } catch { /* 空表 */ }
  try { profile = projectProfile(root, key); } catch { /* 空表 */ }
  try { memory = memoryDue(root, key); } catch { /* 没同步过就不提醒 */ }
  return { live, insights: { experience, profile, memory } };
}

parentPort.on('message', async (job) => {
  const { id, kind } = job;
  try {
    if (kind === 'view') {
      const r = await viewJob(job);
      parentPort.postMessage({ id, ok: true, ...r });
    } else if (kind === 'status') {
      // running 由主线程算好传进来（tasklist 的 spawnSync 在 worker 里会死锁）；收到就跳过探测。
      const status = statusSnapshot(job.root, { running: job.running });
      const sessions = libraryOf(job.root, { current: null });
      parentPort.postMessage({ id, ok: true, status, sessions });
    } else if (kind === 'usage') {
      parentPort.postMessage({ id, ok: true, payload: usageReport(job.root, { force: !!job.force }) });
    } else if (kind === 'projects') {
      parentPort.postMessage({ id, ok: true, ...projectsJob(job) });
    } else if (kind === 'project') {
      parentPort.postMessage({ id, ok: true, ...projectJob(job) });
    } else if (kind === 'sweep') {
      parentPort.postMessage({ id, ok: true, ...sweepJob(job) });
    } else if (kind === 'build') {
      parentPort.postMessage({ id, ok: true, ...buildJob(job) });
    } else {
      parentPort.postMessage({ id, ok: false, error: `未知刷新任务：${kind}` });
    }
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: String(e?.message ?? e).split('\n')[0] });
  }
});
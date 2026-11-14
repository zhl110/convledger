// 宿主残留实例清理。
//
// 背景（2026-11-13）：Electron 宿主崩溃后主进程可能退不掉——渲染进程 OOM 被杀，主进程记录了
// 「干净退出」却卡在收尾，于是留下「没有窗口、却占着几个 G」的进程树；重启器 meanwhile 又拉起
// 一整套新实例，两套并存，机器越来越卡。
//
// 判定只认硬证据，把误杀风险压到最低：
//   1. 同一可执行文件下的多棵进程树，才算候选；
//   2. 子树里还有 renderer 的，永远是「有窗口」，绝不碰；
//   3. 只清「子树里没有 renderer 且启动超过 minAgeSec」的——刚启动的给时间让它长窗口。
// 唯一没法自动化的是「用户真的开了两个窗口」——Electron 的单实例锁保证了它不会发生。
import { spawnSync } from 'node:child_process';

export const HOST_EXES = ['WorkBuddy.exe'];
export const STRAY_MIN_AGE_SEC = 90;

/** 把平铺的进程表按父子关系拼成树。纯函数，可单测。 */
export function buildTrees(procs) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const kids = new Map();
  for (const p of procs) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p);
  }
  // 父进程不在本表里（explorer / 启动器 / 已退出）的，就是这棵树的根。
  const roots = procs.filter((p) => !byPid.has(p.ppid));
  return roots.map((root) => {
    const all = [];
    const stack = [root];
    const seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur.pid)) continue; // 进程表偶尔有环，防死循环
      seen.add(cur.pid);
      all.push(cur);
      for (const k of kids.get(cur.pid) ?? []) stack.push(k);
    }
    return {
      root,
      all,
      pids: all.map((p) => p.pid),
      hasWindow: all.some((p) => p.type === 'renderer'),
      startedAt: root.start || 0,
      mem: all.reduce((s, p) => s + (p.mem || 0), 0),
    };
  });
}

/** 从树里挑出该清的：没有窗口、且已经过了「可能还在长窗口」的宽限期。纯函数，可单测。 */
export function pickStray(trees, { now = Math.floor(Date.now() / 1000), minAgeSec = STRAY_MIN_AGE_SEC } = {}) {
  return trees.filter((t) => !t.hasWindow && (now - t.startedAt) >= minAgeSec);
}

/** 保留的那棵：有窗口的里面最新的那棵。没有窗口的树全都不算「在用」。 */
export function pickKeep(trees) {
  return trees
    .filter((t) => t.hasWindow)
    .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
}

/** 读 Windows 进程表。type 从 --type=renderer 这类命令行参数里取。 */
function readWindowsProcs(exe) {
  const ps = [
    "$ErrorActionPreference='SilentlyContinue'",
    `Get-CimInstance Win32_Process -Filter "Name='${exe}'" | ForEach-Object {`,
    "  $t = if ($_.CommandLine -match '--type=(\\w+)') { $matches[1] } else { 'main' }",
    '  $s = 0',
    '  if ($_.CreationDate) { try { $s = [int64]([DateTimeOffset]$_.CreationDate).ToUnixTimeSeconds() } catch { $s = 0 } }',
    '  [PSCustomObject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; type = $t; start = $s; mem = [int64]$_.WorkingSetSize }',
    '} | ConvertTo-Json -Compress',
  ].join('\n');
  const enc = Buffer.from(ps, 'utf16le').toString('base64');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], {
    encoding: 'utf8', windowsHide: true, timeout: 20000,
  });
  if (r.status !== 0 && !r.stdout) return [];
  const raw = String(r.stdout || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/** 杀整棵进程树。先杀子再杀根，避免父进程退出时把子进程挂成孤儿。 */
function killTreeWindows(tree) {
  const killed = [];
  const failed = [];
  const order = [...tree.all].sort((a, b) => {
    // 叶子优先：ppid 指向的那一方后杀
    if (a.pid === tree.root.pid) return 1;
    if (b.pid === tree.root.pid) return -1;
    return 0;
  });
  for (const p of order) {
    const r = spawnSync('taskkill', ['/PID', String(p.pid), '/F'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (r.status === 0) killed.push(p.pid);
    else failed.push(p.pid);
  }
  return { killed, failed };
}

/**
 * 体检 + 可选清理。
 * @param {{exes?: string[], purge?: boolean, minAgeSec?: number, platform?: string, reader?: Function}} opts
 */
export function doctor({ exes = HOST_EXES, purge = false, minAgeSec = STRAY_MIN_AGE_SEC, platform = process.platform, reader } = {}) {
  if (platform !== 'win32') {
    return { ok: false, reason: `暂只支持 Windows（当前 ${platform}）；macOS/Linux 上请手动检查残留进程`, hosts: [] };
  }
  const read = reader ?? readWindowsProcs;
  const hosts = [];
  for (const exe of exes) {
    const procs = read(exe);
    if (!procs.length) { hosts.push({ exe, found: 0, trees: [], stray: [], keep: null, killed: [], failed: [] }); continue; }
    const trees = buildTrees(procs);
    const keep = pickKeep(trees);
    const stray = pickStray(trees, { minAgeSec });
    let killed = [];
    let failed = [];
    if (purge && stray.length) {
      for (const t of stray) {
        const r = killTreeWindows(t);
        killed.push(...r.killed);
        failed.push(...r.failed);
      }
    }
    hosts.push({ exe, found: procs.length, trees, stray, keep, killed, failed });
  }
  return { ok: true, hosts };
}

/** 给人看的摘要：一套实例一行。 */
export function describeHost(h) {
  if (!h.found) return { exe: h.exe, lines: [`· ${h.exe}：没在跑`], strayMem: 0 };
  const lines = [];
  let strayMem = 0;
  const fmt = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)}G` : `${Math.round(mb)}M`);
  for (const t of h.trees) {
    const tag = t === h.keep ? '保留·有窗口'
      : h.stray.includes(t) ? '残留·无窗口'
        : '未判定';
    if (h.stray.includes(t)) strayMem += t.mem;
    const when = t.startedAt ? new Date(t.startedAt * 1000).toLocaleTimeString('zh-CN', { hour12: false }) : '未知';
    lines.push(`  ${tag.padEnd(9)} ${String(t.all.length).padStart(2)} 个进程 · ${fmt(t.mem / 1024 / 1024)} · 起于 ${when} · 根 pid ${t.root.pid}`);
  }
  return { exe: h.exe, lines, strayMem };
}

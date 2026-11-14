#!/usr/bin/env node
// 代码更新后把本机工具同步到最新状态：各宿主 Skill 副本、常驻 hub、版本水位。
// 只动 tool/out 下的派生状态与已装副本；不搬账本、不删目录。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { probeHub } from './map.mjs';
import { ensureHub } from './setup.mjs';
import { main as installSkills, renderSkill, skillTargets } from '../skill/install.mjs';

export const TOOL = path.dirname(path.dirname(fileURLToPath(import.meta.url))).replace(/\\/g, '/');
const REPO = path.dirname(TOOL);
// 只扫源码面。out/ 每 20s 就在写，一旦算进来，工作台永远判成落后。
const SRC_DIRS = ['src', 'web', 'hooks', 'bin', 'app', 'skill/convledger'];
const CLOCK_SLACK_MS = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const deployFile = (tool = TOOL) => path.join(tool, 'out', 'state', 'deploy.json');
export const hubFile = (tool = TOOL) => path.join(tool, 'out', 'hub.json');
/** 本机暂停标记：存在时宿主事件与自动升级都只停旧 hub、不再新起常驻服务。
 *  删掉 tool/out/HUB-PAUSED 即恢复（或显式跑 convledger map）。 */
export const pauseFile = (tool = TOOL) => path.join(tool, 'out', 'HUB-PAUSED');
export function hubPaused(tool = TOOL) {
  try { return fs.existsSync(pauseFile(tool)); } catch { return false; }
}
/** 恢复：删掉暂停标记。明确要启动时（双击图标 / convledger map / setup --hub）调用。 */
export function clearPaused(tool = TOOL) {
  try { fs.rmSync(pauseFile(tool), { force: true }); return true; } catch { return false; }
}

export function gitHead(repo = REPO) {
  try {
    const r = spawnSync('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 3000 });
    return r.status === 0 ? (String(r.stdout || '').trim() || null) : null;
  } catch { return null; }
}

/** 源码面最近一次改动时间；hub 启动早于它，跑的就是旧代码。 */
export function sourceStamp(tool = TOOL) {
  let max = 0;
  const walk = (dir, depth = 0) => {
    if (depth > 3) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name === 'out' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile()) { try { max = Math.max(max, fs.statSync(p).mtimeMs); } catch { /* 读不到就不算 */ } }
    }
  };
  for (const d of SRC_DIRS) walk(path.join(tool, d));
  return max;
}

export function readDeploy(tool = TOOL) {
  try { return JSON.parse(fs.readFileSync(deployFile(tool), 'utf8')); } catch { return null; }
}
export function writeDeploy(tool = TOOL, row = {}) {
  const f = deployFile(tool);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ ...row, at: new Date().toISOString() }, null, 1) + '\n');
}

/** 与 install.mjs --check 同一把尺：正本渲染后逐家比内容。 */
export function skillsState(tool = TOOL) {
  try {
    const raw = fs.readFileSync(path.join(tool, 'skill', 'convledger', 'SKILL.md'), 'utf8');
    const want = renderSkill(raw, path.dirname(tool));
    const stale = [];
    for (const { client, dir } of skillTargets()) {
      let have = null;
      try { have = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'); } catch { /* 没装 */ }
      if (have !== want) stale.push(client);
    }
    return { ok: stale.length === 0, stale };
  } catch (e) { return { ok: false, stale: [], error: String(e?.message ?? e) }; }
}

export function hubStartedAt(tool = TOOL) {
  try { return Date.parse(JSON.parse(fs.readFileSync(hubFile(tool), 'utf8')).startedAt) || 0; } catch { return 0; }
}

/** /health 偶尔会超时，但进程其实还占着端口。重启前连 hub.json 里记的 pid 一起停，
 *  否则 ensureHub 会「复用」那个旧 hub，还把它的 pid 当成新起的报出来。 */
export function recordedHubPid(tool = TOOL, port = 8765) {
  try {
    const info = JSON.parse(fs.readFileSync(hubFile(tool), 'utf8'));
    const recordedPort = Number.isInteger(info.port) ? info.port : 8765;
    if (recordedPort !== port) return null;   // 别的端口的 hub 不关这次的事（自测用 59999 隔离真 8765）
    if (Number.isInteger(info.pid) && info.pid > 0) {
      try { process.kill(info.pid, 0); return info.pid; } catch { /* 已经退出 */ }
    }
  } catch { /* 没有 pid 记录 */ }
  return null;
}

/** 纯函数，便于自测：版本水位与 hub 时间任一落后都要提示。 */
export function noticeFor({ head, deployedHead, hubStart, stamp }) {
  const versionStale = !!head && deployedHead !== head;
  const hubStale = hubStart > 0 && hubStart < stamp - CLOCK_SLACK_MS;
  return versionStale || hubStale;
}

/** hook 用：不联网，只读文件；落后时给一行可行动提示，否则空串。 */
export function upgradeNotice(tool = TOOL) {
  try {
    if (!noticeFor({ head: gitHead(), deployedHead: readDeploy(tool)?.head ?? null, hubStart: hubStartedAt(tool), stamp: sourceStamp(tool) })) return '';
    return `[convledger · 工具版本] 代码已更新，工作台或已装副本还在旧版 → 先跑 node ${TOOL}/src/cli.mjs upgrade`;
  } catch { return ''; }
}

export async function checkUpgrade(tool = TOOL, { port = 8765, store = path.join(tool, 'out', 'store') } = {}) {
  const head = gitHead(path.dirname(tool));
  const deployed = readDeploy(tool);
  const stamp = sourceStamp(tool);
  const paused = hubPaused(tool);
  const hub = await probeHub(port, { tries: 2, timeout: 1500 });
  const recordedPid = hub ? null : recordedHubPid(tool, port);
  const skills = skillsState(tool);
  const hubOk = !!hub && Date.parse(hub.startedAt) >= stamp - CLOCK_SLACK_MS;
  const items = [
    { name: 'skills', ok: skills.ok, detail: skills.ok ? '五家副本与正本一致' : `未同步：${skills.stale.join(' / ') || skills.error || '?'}` },
    { name: 'hub', ok: paused ? !hub : hubOk,
      detail: paused ? (hub ? `已暂停但仍有 hub 在跑（pid ${hub.pid}）` : '已暂停常驻 hub（out/HUB-PAUSED）')
        : hub ? `pid ${hub.pid} · 启动 ${hub.startedAt}${hubOk ? '' : '（早于源码改动）'}`
        : recordedPid ? `pid ${recordedPid} 还在，但 ${port} 的 /health 没探到` : `端口 ${port} 没有 hub` },
    { name: 'deploy', ok: !!deployed && !!head && deployed.head === head, detail: deployed ? `水位 ${deployed.head}${head && deployed.head !== head ? ` ≠ 代码 ${head}` : ''}` : '从未登记' },
  ];
  return { ok: items.every((i) => i.ok), head, stamp, hub, recordedPid, items };
}

/** 把副本、hub、水位一次拉齐。幂等：已经是最新的就只回报，不重启。 */
export async function runUpgrade(tool = TOOL, { port = 8765, store = path.join(tool, 'out', 'store'), rebuildSec = 20, checkOnly = false } = {}) {
  const before = await checkUpgrade(tool, { port, store });
  if (checkOnly) return { ...before, actions: [] };
  const actions = [];

  if (!before.items.find((i) => i.name === 'skills').ok) {
    const rc = installSkills([]);
    actions.push(rc === 0 ? '同步五家 Skill 副本' : '同步 Skill 副本失败');
  }

  if (!before.items.find((i) => i.name === 'hub').ok) {
    // HTTP 探不到也别放过 hub.json 里那个还活着的 pid：不停它，ensureHub 会把旧进程
    // 当「复用」，旧模块继续跑，升级看着成功其实没换。
    const pids = [...new Set([before.hub?.pid, before.recordedPid, recordedHubPid(tool, port)]
      .filter((p) => Number.isInteger(p) && p > 0))];
    for (const pid of pids) { try { process.kill(pid); } catch { /* 已经退出 */ } }
    for (let i = 0; i < 30; i++) {
      await sleep(200);
      if (!(await probeHub(port, { tries: 1, timeout: 500 }))) break;
    }
    if (pids.length) actions.push(`停掉旧 hub（pid ${pids.join('/')}）`);
    if (hubPaused(tool)) {
      // 暂停是用户显式状态：只把残留的旧服务停干净，绝不自作主张再拉起来。
      actions.push('本机已暂停常驻 hub（out/HUB-PAUSED），只停旧服务、不新起');
    } else {
      const r = await ensureHub(store, port, rebuildSec);
      if (!r || r.skipped) actions.push('起 hub 被跳过（测试隔离）');
      else {
        let up = null;
        for (let i = 0; i < 40; i++) {
          await sleep(250);
          up = await probeHub(port, { tries: 1, timeout: 800 });
          if (up && Date.parse(up.startedAt) >= before.stamp - CLOCK_SLACK_MS) break;
        }
        const fresh = !!up && Date.parse(up.startedAt) >= before.stamp - CLOCK_SLACK_MS;
        actions.push(fresh ? `起新 hub（pid ${up.pid} · 端口 ${port}）`
          : up ? `端口上仍是旧 hub（pid ${up.pid} · 启动 ${up.startedAt}）` : '起 hub 超时');
      }
    }
  }

  const after = await checkUpgrade(tool, { port, store });
  if (after.head && after.items.filter((i) => i.name !== 'deploy').every((i) => i.ok)) {
    writeDeploy(tool, { head: after.head, hubStartedAt: after.hub?.startedAt ?? null });
    actions.push(`登记版本水位 ${after.head}`);
  }
  return { ...(await checkUpgrade(tool, { port, store })), actions, wasOk: before.ok };
}

export function upgradeLines(r) {
  const lines = [`工具版本 ${r.head ?? '(非 git 检出)'} · 源码改动 ${new Date(r.stamp).toLocaleString('zh-CN')}`];
  for (const i of r.items) lines.push(`${i.ok ? '✓' : '✗'} ${i.name}：${i.detail}`);
  if (r.actions?.length) lines.push(`动作：${r.actions.join(' → ')}`);
  // 有动作时结论说的是「这次做完了没」，不是「本来就是最新」——两者别混成一句。
  lines.push(r.actions?.length
    ? (r.ok ? '→ 本次已同步到位' : '→ 同步后仍有不同步项')
    : (r.ok ? '→ 已是最新' : '→ 仍有不同步项'));
  return lines.join('\n');
}

// 连接的分层视图与双向开关。
//
// 连接从来不是「一个开关」：hooks（四家 settings.json / hooks.json ＋ OpenCode 插件）、Skill（五家目录）、
// hub 常驻服务、桌面入口，各挂各的，挂上就散落在各家用户级配置里。以前只给了「连接」，
// 断开要自己去翻脚本、还容易伤到单源真值（Junction 穿透）。这里把四层收成一条命令、一份状态。
//
// 断开＝让宿主不再调用我们，不删账本、不删历史、不动别人的配置键。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { portState, removeShortcuts } from './setup.mjs';
import { skillTargets, linkOnPath } from '../skill/install.mjs';

const fwd = (p) => String(p || '').replace(/\\/g, '/');
const OUR_HOOK = /ledger-brief\.mjs|codex-hook|convledger-(brief|closeout|rebuild)/i;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 一家宿主配置里我们自己注册了几条 handler。读不到文件时 exists=false，不冒充「零条＝没挂」。 */
function hookCount(file) {
  if (!fs.existsSync(file)) return { exists: false, file: fwd(file), count: 0, events: [] };
  const j = readJson(file);
  if (!j) return { exists: true, file: fwd(file), count: 0, events: [], error: 'JSON 读不动' };
  const events = [];
  let count = 0;
  for (const [ev, groups] of Object.entries(j.hooks || {})) {
    for (const g of groups || []) {
      for (const h of (g && g.hooks) || []) {
        if (OUR_HOOK.test(JSON.stringify(h))) { count++; events.push(ev); }
      }
    }
  }
  return { exists: true, file: fwd(file), count, events: [...new Set(events)] };
}

/** OpenCode 走插件文件：在跑的是 convledger.js，被手动停掉的是 convledger.js.disabled。 */
function pluginState(dir) {
  const active = path.join(dir, 'convledger.js');
  const parked = `${active}.disabled`;
  if (fs.existsSync(active)) return { installed: true, parked: false, file: fwd(active) };
  if (fs.existsSync(parked)) return { installed: false, parked: true, file: fwd(parked) };
  return { installed: false, parked: false, file: fwd(active) };
}

/** Skill 挂载：目录可能是符号链接 / Junction（多个宿主共用一份真本），链接在＝已挂，链接断＝已断。
 *  还有第三种形状：目录本身普通，但**父级**是链接（例 ~/.codex/skills → 自己的技能总仓）——
 *  那是宿主自己的单源布局，不是我们挂的，断开时不该也不能替人拆。 */
function skillState(home, env) {
  return skillTargets({ home, env }).map(({ client, dir }) => {
    let st = null;
    try { st = fs.lstatSync(dir); } catch { /* 没装 */ }
    const via = linkOnPath(path.dirname(dir));
    if (!st) {
      return { client, mounted: false, link: null, shared: !!via, sharedVia: via ? `${fwd(via.path)} → ${fwd(via.target)}` : null, dir: fwd(dir), note: '未挂载' };
    }
    if (st.isSymbolicLink()) {
      let target = '';
      let live = false;
      try { target = fwd(fs.realpathSync(dir)); live = fs.existsSync(path.join(dir, 'SKILL.md')); } catch { target = '(目标已不存在)'; }
      return { client, mounted: live, link: target, shared: false, sharedVia: null, dir: fwd(dir), note: live ? `链接 → ${target}` : `悬空链接 → ${target}` };
    }
    const has = fs.existsSync(path.join(dir, 'SKILL.md'));
    return {
      client, mounted: has, link: null,
      shared: !!via, sharedVia: via ? `${fwd(via.path)} → ${fwd(via.target)}` : null,
      dir: fwd(dir),
      note: has ? (via ? `共享目录（${fwd(via.path)} 是链接）` : '实体目录') : '空目录',
    };
  });
}

function shortcutState(home, env) {
  const cands = [
    path.join(home, 'Desktop', 'convledger 地图.lnk'),
    path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'convledger 地图.lnk'),
  ];
  return cands.map((p) => ({ file: fwd(p), exists: fs.existsSync(p) }));
}

function ledgerCount(root) {
  try {
    const dirs = fs.readdirSync(root);
    let n = 0;
    for (const d of dirs) if (fs.existsSync(path.join(root, d, 'ledger.json'))) n++;
    return { sessions: n, dir: fwd(root) };
  } catch { return { sessions: 0, dir: fwd(root) }; }
}

function stateFile(root) {
  return path.join(root, '..', 'connection-state.json');
}

export function readState(root) {
  return readJson(stateFile(root)) || {};
}

function writeState(root, patch) {
  const next = { ...readState(root), ...patch };
  try { fs.writeFileSync(stateFile(root), JSON.stringify(next, null, 2) + '\n', 'utf8'); } catch { /* 状态写不下不影响断开本身 */ }
  return next;
}

/** 一次看清四层＋账本：哪层还挂着、挂了几家、挂在哪。 */
export async function connectionState({ root, home = os.homedir(), env = process.env, port = 8765 } = {}) {
  const repo = path.resolve(root, '..', '..', '..');
  const conf = {
    qoder: env.QODER_CONFIG_DIR || path.join(home, '.qoder'),
    'claude-code': env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'),
    workbuddy: env.WORKBUDDY_CONFIG_DIR || path.join(home, '.workbuddy'),
    codex: env.CODEX_HOME || path.join(home, '.codex'),
    opencode: env.OPENCODE_CONFIG_DIR || path.join(home, '.config', 'opencode'),
  };
  const hooks = [
    { id: 'qoder', label: 'Qoder', ...hookCount(path.join(conf.qoder, 'settings.json')) },
    { id: 'claude-code', label: 'Claude Code', ...hookCount(path.join(conf['claude-code'], 'settings.json')) },
    { id: 'workbuddy', label: 'WorkBuddy', ...hookCount(path.join(conf.workbuddy, 'settings.json')) },
    { id: 'codex', label: 'Codex（用户级）', ...hookCount(path.join(conf.codex, 'hooks.json')) },
    { id: 'codex-project', label: 'Codex（项目级）', ...hookCount(path.join(repo, '.codex', 'hooks.json')) },
    { id: 'opencode', label: 'OpenCode', ...pluginState(path.join(conf.opencode, 'plugins')) },
  ];
  const skills = skillState(home, env);
  const hubPort = await portState(port);
  return {
    hooks,
    skills,
    hub: { port, state: hubPort.state, running: hubPort.state === 'hub', detail: hubPort.detail || null },
    shortcuts: shortcutState(home, env),
    ledger: ledgerCount(root),
    last: readState(root),
    repo: fwd(repo),
  };
}

/** 断开的判定：hooks 一条不剩、Skill 一家不挂。hub 与快捷方式不影响「宿主会不会调用我们」。
 *  共享目录（宿主自己那层链接）单独算：那种残留是用户自己的单源布局，工具不替他拆，
 *  但必须说出来——否则「已断开」就成了半句真话。 */
export function isOff(state) {
  return state.hooks.every((h) => (h.id === 'opencode' ? !h.installed : h.count === 0))
    && state.skills.every((s) => !s.mounted);
}

/** hooks 全断、只剩宿主自己的共享目录时，算「实质断开」。 */
export function onlySharedLeft(state) {
  return state.hooks.every((h) => (h.id === 'opencode' ? !h.installed : h.count === 0))
    && state.skills.every((s) => !s.mounted || s.shared);
}

function runNode(repo, script, args) {
  const r = spawnSync(process.execPath, [path.join(repo, script), ...args], { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  const lines = String(r.stdout || r.stderr || '').trim().split('\n').filter(Boolean);
  return { ok: r.status === 0, code: r.status, out: lines };
}

/** 全断：hooks ＋ Skill 撤掉，hub 停掉。快捷方式默认留着（点了还能开看板，不产生调用）。 */
export async function turnOff({ root, home = os.homedir(), env = process.env, keepShortcut = true, keepHub = false, stopHub = null } = {}) {
  const repo = path.resolve(root, '..', '..', '..');
  const steps = [];
  const before = await connectionState({ root, home, env });
  if (isOff(before)) {
    steps.push({ layer: '整体', ok: true, out: ['已经是断开状态（hooks 0 条 · Skill 0 家），没有重复动作'] });
  } else {
    const hk = runNode(repo, 'tool/hooks/install.mjs', ['--remove', '--client', 'all']);
    steps.push({ layer: 'hooks', ok: hk.ok, out: hk.out });
    const sk = runNode(repo, 'tool/skill/install.mjs', ['--remove', '--client', 'all']);
    steps.push({ layer: 'Skill', ok: sk.ok, out: sk.out });
    const gh = runNode(repo, 'tool/hooks/git-post-merge.mjs', ['--remove']);
    steps.push({ layer: 'git', ok: gh.ok, out: gh.out });
  }
  if (!keepHub) {
    // 本来就没跑就别 spawn 一个 `map --stop` 去找一个不存在的 pid——那会报 ESRCH，读起来像失败。
    if (before.hub.state === 'free') {
      steps.push({ layer: 'hub', ok: true, out: [`未运行（${before.hub.port} 空闲，没有要停的进程）`] });
    } else if (before.hub.state === 'busy') {
      steps.push({ layer: 'hub', ok: true, out: [`${before.hub.port} 被别的程序占着，不是这个 hub，没有动它`] });
    } else if (typeof stopHub === 'function') {
      const stopped = await stopHub();
      steps.push({ layer: 'hub', ok: true, out: [stopped || 'hub 已停'] });
    } else {
      const hk = runNode(repo, 'tool/bin/convledger.mjs', ['map', '--stop']);
      steps.push({ layer: 'hub', ok: hk.ok, out: hk.out });
    }
  }
  if (keepShortcut) {
    steps.push({ layer: '桌面入口', ok: true, out: ['保留（点了还能开看板，不产生宿主调用）；要连入口一起撤用 off --all'] });
  } else {
    const sc = removeShortcuts();
    steps.push({ layer: '桌面入口', ok: !!sc.ok, out: [sc.paths && sc.paths.length ? `删掉 ${sc.paths.join(' · ')}` : (sc.reason || '没有装过')] });
  }
  const after = await connectionState({ root, home, env });
  // 记下哪些宿主原本是「链接到一份真本」的挂载。连接是单源真值（一个 SKILL.md 供几家共用）时，
  // 断开只解链接、接回也要还原成链接——否则接回来会变成各自一份实体副本，日后各写各的。
  const linkPlan = before.skills.filter((s) => s.link).map((s) => ({ client: s.client, dir: s.dir, target: s.link }));
  writeState(root, {
    lastOff: { at: new Date().toISOString(), hooks: after.hooks.reduce((a, h) => a + (h.count || 0), 0), skills: after.skills.filter((s) => s.mounted).length },
    linkPlan,
  });
  return { action: 'off', ok: isOff(after), steps, before, after };
}

/** 接回时还原单源真值：把实体目录换回指向真本的链接（Windows 用 junction，其余用目录符号链接）。 */
function restoreLinks(plan) {
  const done = [];
  for (const it of plan || []) {
    try {
      const st = fs.lstatSync(it.dir);
      if (st.isSymbolicLink()) { done.push(`· ${it.client} 已是链接，不动`); continue; }
      if (!fs.existsSync(it.target)) { done.push(`· ${it.client} 真本不在了（${it.target}），保留实体目录`); continue; }
      fs.rmSync(it.dir, { recursive: true, force: true });
    } catch { /* 目录不存在正好直接建链接 */ }
    try {
      fs.mkdirSync(path.dirname(it.dir), { recursive: true });
      fs.symlinkSync(it.target, it.dir, process.platform === 'win32' ? 'junction' : 'dir');
      done.push(`✓ ${it.client} 恢复单源链接 → ${it.target}`);
    } catch (e) {
      done.push(`✗ ${it.client} 链接没建成（${e.code || e.message}）：现在是一份实体副本`);
    }
  }
  return done;
}

/** 全接：hooks 与 Skill 按检测到的宿主装回去。hub 不自动起（要看板再开，避免常驻）。 */
export function turnOn({ root, home = os.homedir(), env = process.env } = {}) {
  const repo = path.resolve(root, '..', '..', '..');
  const steps = [
    { layer: 'hooks', ...runNode(repo, 'tool/hooks/install.mjs', ['--client', 'all']) },
    { layer: 'Skill', ...runNode(repo, 'tool/skill/install.mjs', ['--client', 'all']) },
    // 拉完代码自动同步：git hook 不随仓库分发，接上工具时在本机装一次，另一台同理。
    { layer: 'git', ...runNode(repo, 'tool/hooks/git-post-merge.mjs', ['--install']) },
  ];
  const plan = readState(root).linkPlan || [];
  if (plan.length) steps.push({ layer: '单源链接', ok: true, out: restoreLinks(plan) });
  writeState(root, { lastOn: { at: new Date().toISOString() } });
  return { action: 'on', ok: steps.every((s) => s.ok), steps };
}

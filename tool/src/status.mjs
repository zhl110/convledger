// 状态看板：本机各 agent 的接入状态、钩子/Skill 是否到位、账本与记忆的总量、最近一次宿主事件。
// 只读、只做机械统计；写操作（装 hooks / 装 Skill / 连接）由页面显式点按钮触发。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { hostRows } from './setup.mjs';
import { libraryOf } from './library.mjs';
import { skillTargets } from '../skill/install.mjs';
import { readUserMemories, projectMemoryDir } from './memories.mjs';

const SCRIPT_MARK = 'ledger-brief.mjs';
const DIMS = ['目标', '边界', '规则', '偏好', '背景', '验收', '分工', '反馈', '性格'];
let CACHE = { at: 0, key: '', data: null };

/** 从进程名/命令行里认宿主：纯函数，便于自测。
 *  每个宿主给 { any, interactive }：OpenCode 关掉界面后会留 `serve --service`，
 *  那种只算「后台服务在跑」，不算界面在线。 */
export function matchHostProcesses(lines = []) {
  const low = lines.map((l) => String(l || '').toLowerCase());
  const serviceOnly = (l) => /serve\s+--service/.test(l) || /[\\/-]-service\b/.test(l);
  const exe = (n) => new RegExp(`(^|[\\\\/ "'=])${n}(\\.exe)?([\\s"'/]|$)`);
  const host = (test) => {
    const hits = low.filter(test);
    return { any: hits.length > 0, interactive: hits.some((l) => !serviceOnly(l)) };
  };
  return {
    qoder: host((l) => /qoder\.exe/.test(l) || exe('qoder').test(l)),
    'claude-code': host((l) => /@anthropic-ai[\\/]claude-code/.test(l) || /claude-code/.test(l) || /claude\.exe/.test(l) || exe('claude').test(l)),
    workbuddy: host((l) => /workbuddy\.exe/.test(l) || exe('workbuddy').test(l)),
    opencode: host((l) => /opencode\.exe/.test(l) || exe('opencode').test(l)),
    codex: host((l) => /codex\.exe/.test(l) || exe('codex').test(l)),
  };
}

let RUN = { at: 0, map: null };
const RUN_TTL = 30000;

/** Windows 进程行：tasklist 只有名字；OpenCode 在跑时再取它的命令行，好认出 serve --service。 */
function winProcessLines() {
  const r = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (r.status !== 0) return null;
  const lines = String(r.stdout || '').split(/\r?\n/).filter(Boolean);
  const name = (l) => (String(l).match(/^"([^"]+)"/) || [])[1] || '';
  const oc = lines.filter((l) => /^opencode\.exe$/i.test(name(l)));
  if (!oc.length) return lines;
  let cmds = [];
  try {
    const p = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='opencode.exe'\" | ForEach-Object { $_.CommandLine }"],
    { encoding: 'utf8', timeout: 5000, windowsHide: true });
    cmds = String(p.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch { /* 取不到命令行就按名字算在线 */ }
  // 有命令行就只留命令行行（能分出 service）；取不到再退回名字。
  return [
    ...lines.filter((l) => !/^opencode\.exe$/i.test(name(l))),
    ...(cmds.length ? cmds : oc),
  ];
}

/** 本机正在跑的宿主进程。win 走 tasklist（+ OpenCode 命令行）；其他平台用 ps。 */
export function detectRunningHosts(now = Date.now()) {
  if (RUN.map && now - RUN.at < RUN_TTL) return RUN.map;
  let lines = null;
  try {
    if (process.platform === 'win32') lines = winProcessLines();
    else {
      const r = spawnSync('ps', ['-ax', '-o', 'command='], { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0) lines = String(r.stdout || '').split('\n').filter(Boolean);
    }
  } catch { lines = null; }
  RUN = { at: now, map: lines ? matchHostProcesses(lines) : null };
  return RUN.map;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function ourHandlers(obj) {
  const out = {};
  for (const [ev, defs] of Object.entries(obj?.hooks || {})) {
    let n = 0;
    for (const d of defs || []) {
      for (const h of d.hooks || []) {
        if ([h.command, h.commandWindows, (h.args || []).join(' ')].some((c) => String(c || '').replace(/\\/g, '/').includes(SCRIPT_MARK))) n++;
      }
    }
    if (n) out[ev] = n;
  }
  return out;
}

function fileState(file) {
  const obj = readJson(file);
  if (!obj) return { installed: false, events: [], file };
  const ev = ourHandlers(obj);
  return { installed: Object.keys(ev).length > 0, events: Object.keys(ev), file };
}

function pluginState(dir) {
  const file = path.join(dir, 'plugins', 'convledger.js');
  const ok = fs.existsSync(file);
  return { installed: ok, events: ok ? ['compacting', 'idle'] : [], file: file.replace(/\\/g, '/') };
}

function lastEventsByRunner(root, sessions, limit = 600) {
  const bySid = new Map(sessions.map((s) => [s.sid8, s.runner]));
  const file = path.join(root, '..', 'hook-probe.jsonl');
  let lines = [];
  try {
    const raw = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    lines = raw.slice(-limit);
  } catch { return { perRunner: {}, recent: [] }; }
  const perRunner = {};
  const recent = [];
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const runner = bySid.get(String(o.session || '').slice(0, 8));
    const item = { ts: o.ts, event: o.event, action: o.action, sid8: String(o.session || '').slice(0, 8), runner: runner || null };
    recent.push(item);
    if (runner) perRunner[runner] = item;
  }
  return { perRunner, recent: recent.slice(-8).reverse() };
}

function scanTotals(root) {
  const store = root;
  let lessons = 0, chapters = 0;
  const list = [];
  let dirs = [];
  try { dirs = fs.readdirSync(store); } catch { return { lessons, chapters, lessonsList: list }; }
  for (const d of dirs) {
    const dir = path.join(store, d);
    const file = path.join(dir, 'summaries.json');
    const sums = readJson(file);
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { /* 没综述表 */ }
    for (const [i, b] of Object.entries(sums?.blocks || {})) {
      if (!b?.lesson || !String(b.lesson).trim()) continue;
      lessons++;
      const at = Date.parse(b.at) || mtime;
      list.push({ session: d.slice(0, 8), block: Number(i) || i, title: b.title || '', lesson: String(b.lesson), need: b.need || '', at });
    }
    const ch = readJson(path.join(dir, 'chapters.json'));
    if (Array.isArray(ch?.chapters)) chapters += ch.chapters.length;
  }
  list.sort((a, b) => (b.at - a.at) || (Number(b.block) - Number(a.block)));
  return { lessons, chapters, lessonsList: list.slice(0, 8) };
}

function memoryCounts(root) {
  let project = 0;
  const list = [];
  try {
    for (const d of fs.readdirSync(path.join(root, '..', 'projects'))) {
      const m = readJson(path.join(root, '..', 'projects', d, 'memories.json'));
      for (const e of m?.entries || []) {
        project++;
        list.push({ scope: '项目', cls: e.class || '', dim: e.dimension || '', text: String(e.text || ''), at: e.at || '' });
      }
    }
  } catch { /* 没有项目记忆 */ }
  let user = 0;
  try {
    const u = readUserMemories(root).entries || [];
    user = u.length;
    for (const e of u) list.push({ scope: '用户', cls: e.class || '', dim: e.dimension || '', text: String(e.text || ''), at: e.at || '' });
  } catch { /* 用户表读不到 */ }
  list.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { project, user, list: list.slice(0, 8) };
}

export function statusSnapshot(root, { home = os.homedir(), env = process.env, now = Date.now(), force = false, running = undefined } = {}) {
  const key = `${root}|${now - (now % 8000)}`;
  if (!force && CACHE.data && Date.now() - CACHE.at < 8000) return CACHE.data;
  const lib = libraryOf(root, { now });
  const sessions = (lib.groups || []).flatMap((g) => g.sessions || []);
  const rows = hostRows({ sessions, home, env });
  const probe = lastEventsByRunner(root, sessions);
  const repo = path.resolve(root, '..', '..', '..').replace(/\\/g, '/');
  // 在线＝进程在跑（qoder/workbuddy/opencode/codex 能按进程名认）；node 跑的 CLI（claude code / codex npm 版）
  // 认不出来时用「最近有写入」兜底并在界面上标明依据。30 秒缓存，别每次轮询都扫进程。
  const runningMap = running === undefined ? detectRunningHosts(now) : running;
  const lastByRunner = {};
  const builtByRunner = {};
  for (const s of sessions) {
    const rid = s.runner || 'unknown';
    if (s.built) builtByRunner[rid] = (builtByRunner[rid] || 0) + 1;
    const t = Date.parse(s.lastWriteAt || 0) || 0;
    if (t > (lastByRunner[rid] || 0)) lastByRunner[rid] = t;
  }
  const inUse = (rid) => {
    const t = lastByRunner[rid] || 0;
    return !!t && now - t < 120000;
  };
  const skillDirs = new Map(skillTargets({ home, env }).map((t) => [t.client, t.dir]));
  const conf = (id, fallback) => {
    if (id === 'claude-code') return env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
    if (id === 'workbuddy') return env.WORKBUDDY_CONFIG_DIR || path.join(home, '.workbuddy');
    if (id === 'opencode') return env.OPENCODE_CONFIG_DIR || path.join(home, '.config', 'opencode');
    if (id === 'codex') return env.CODEX_HOME || path.join(home, '.codex');
    return env.QODER_CONFIG_DIR || path.join(home, '.qoder');
  };
  const hosts = rows.map((r) => {
    let hooks;
    if (r.id === 'opencode') hooks = pluginState(conf(r.id));
    else if (r.id === 'codex') {
      const project = fileState(path.join(repo, '.codex', 'hooks.json'));
      const user = fileState(path.join(conf(r.id), 'hooks.json'));
      hooks = project.installed ? project : user;
    } else hooks = fileState(path.join(conf(r.id), 'settings.json'));
    const sk = skillDirs.get(r.id);
    const st = runningMap ? runningMap[r.id] : null;
    const active = inUse(r.id);
    const activityProves = active && (r.id === 'claude-code' || r.id === 'codex');
    const online = st ? !!st.interactive : (activityProves ? true : null);
    const service = !!(st && st.any && !st.interactive);
    return {
      id: r.id,
      label: r.label,
      sourceFound: !!r.sourceFound,
      hostFound: !!r.hostFound,
      sessions: r.sessions || 0,
      built: builtByRunner[r.id] || 0,
      cached: r.cached || 0,
      online,
      // 进程名认不出（node 跑的 claude/codex）但刚有写入：按活动判在线，并在卡片上写「按活动」。
      onlineBy: online ? (st && st.interactive ? 'process' : 'activity') : (service ? 'service' : (st ? 'none' : 'unknown')),
      service,
      inUse: active,
      lastWriteAt: lastByRunner[r.id] ? new Date(lastByRunner[r.id]).toISOString() : null,
      skill: { installed: !!(sk && fs.existsSync(path.join(sk, 'SKILL.md'))), dir: sk ? sk.replace(/\\/g, '/') : null },
      hooks,
      last: probe.perRunner[r.id] || null,
    };
  });
  const totals = { sessions: sessions.length, segments: 0, blocks: 0, sums: 0, phases: 0, titles: 0, verified: 0, live: 0 };
  for (const s of sessions) {
    totals.segments += s.segments || 0;
    totals.live += s.live ? 1 : 0;
    const o = s.organize;
    if (o) {
      totals.blocks += o.blocks || 0;
      totals.sums += o.sums || 0;
      totals.phases += o.phases || 0;
      totals.titles += o.titles || 0;
      totals.verified += o.verified || 0;
    }
  }
  const extra = scanTotals(root);
  const memory = memoryCounts(root);
  const data = {
    at: new Date(now).toISOString(),
    hosts,
    totals: { ...totals, chapters: extra.chapters, lessons: extra.lessons, memory },
    lessons: extra.lessonsList || [],
    memories: memory.list || [],
    dims: DIMS,
    recent: probe.recent,
    repo,
  };
  CACHE = { at: Date.now(), key, data };
  return data;
}

/** 一键装/修/断：hooks、Skill、连接或断开。返回每一步的回执。 */
export function runIntegration(client, action, { root }) {
  const repo = path.resolve(root, '..', '..', '..');
  const steps = [];
  const run = (script, args) => {
    const r = spawnSync(process.execPath, [path.join(repo, script), ...args], { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    steps.push({ script, code: r.status ?? 1, out: String(r.stdout || r.stderr || '').trim().split('\n').slice(-3).join('\n') });
    return r.status === 0;
  };
  if (action === 'hooks' || action === 'connect') run('tool/hooks/install.mjs', ['--client', client]);
  if (action === 'skill' || action === 'connect') run('tool/skill/install.mjs', ['--client', client]);
  // 断开与连接对称：同一层、同一入口，只是方向相反；账本与历史不碰。
  if (action === 'disconnect') {
    run('tool/hooks/install.mjs', ['--client', client, '--remove']);
    run('tool/skill/install.mjs', ['--client', client, '--remove']);
  }
  return { ok: steps.every((s) => s.code === 0), client, action, steps };
}

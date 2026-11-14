#!/usr/bin/env node
// 注册/卸载 convledger 的会话事件 hook。配置只能写用户级 settings.json（本机
// QODER_CONFIG_DIR 就指向 ~/.qoder，没有独立的项目级文件），所以挂上之后对**所有项目的会话**生效。
// 只动我们自己的条目，其余键与他人 hook 原样保留。
//
//   node hooks/install.mjs                     # 默认装 Qoder（旧行为不变）
//   node hooks/install.mjs --client claude-code # 装 Claude Code（~/.claude/settings.json）
//   node hooks/install.mjs --client workbuddy  # 装 WorkBuddy
//   node hooks/install.mjs --client codex      # 装 Codex（~/.codex/hooks.json，beta）
//   node hooks/install.mjs --client all        # 五家都装（没检测到的宿主会跳过）
//   … --remove / --probe
//
// handler 形状按宿主分：Qoder 吃 {command:<exe>, args:[…]}；Claude Code / WorkBuddy 只吃
// {command:"<shell 串>"}；Codex 的 hooks.json 用 {type:'command', command, commandWindows, timeout}；
// OpenCode 走插件文件。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const TOOL_ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1').replace(/\\/g, '/')));
const SCRIPT = `${TOOL_ROOT}/hooks/ledger-brief.mjs`;
const PREFIX = 'convledger-';

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const valueOf = (n) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : null; };
const REMOVE = has('--remove');
const PROBE = has('--probe');
const clientArg = valueOf('--client') ?? 'qoder';

const legal = ['qoder', 'claude-code', 'workbuddy', 'codex', 'opencode', 'all'];
if (!legal.includes(clientArg)) {
  console.log(`✗ --client 只认 ${legal.join(' | ')}，拿到的是「${clientArg}」`);
  process.exit(1);
}

const home = os.homedir();
const quote = (s) => (/[\s"']/.test(s) ? `"${s}"` : s);

const CLIENTS = {
  qoder: {
    label: 'Qoder',
    file: () => `${(process.env.QODER_CONFIG_DIR || path.join(home, '.qoder')).replace(/\\/g, '/')}/settings.json`,
    handler: (name, timeout) => ({
      type: 'command', command: process.execPath, args: [SCRIPT, '--origin', 'host'],
      name: `${PREFIX}${name}`, timeout, statusMessage: `convledger ${name}`,
    }),
  },
  'claude-code': {
    label: 'Claude Code',
    file: () => `${(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')).replace(/\\/g, '/')}/settings.json`,
    handler: (name, timeout) => ({
      type: 'command',
      command: `${quote(process.execPath)} ${quote(SCRIPT)} --origin host`,
      timeout,
    }),
  },
  workbuddy: {
    label: 'WorkBuddy',
    file: () => `${(process.env.WORKBUDDY_CONFIG_DIR || path.join(home, '.workbuddy')).replace(/\\/g, '/')}/settings.json`,
    handler: (name, timeout) => ({
      type: 'command',
      command: `${quote(process.execPath)} ${quote(SCRIPT)} --origin host`,
      timeout,
    }),
  },
};

// 认领自己的条目：Qoder 侧靠 name 前缀，WorkBuddy 侧没有 name 字段（那是它的方言外的键），
// 靠命令行里出现本仓脚本路径。两种都认得，卸载才不会漏或误伤别人的 hook。
const MINE = (h) => String(h?.name || '').startsWith(PREFIX)
  || [h?.command, h?.commandWindows, (h?.args || []).join(' ')].some((c) => {
    const s = String(c || '').replace(/\\/g, '/').toLowerCase();
    return s.includes(SCRIPT.toLowerCase()) || s.includes('codex-hook.cmd');
  });

/** 摘掉我们自己的条目；空掉的 handler 数组和事件键一并清，别人的不动。 */
function strip(hooks) {
  let n = 0;
  for (const [ev, defs] of Object.entries(hooks || {})) {
    const kept = [];
    for (const def of defs || []) {
      const mine = (def.hooks || []).filter(MINE);
      n += mine.length;
      const rest = (def.hooks || []).filter((h) => !MINE(h));
      if (rest.length) kept.push({ ...def, hooks: rest });
    }
    if (kept.length) hooks[ev] = kept; else delete hooks[ev];
  }
  return n;
}

const def = (client, ev, name, timeout, extra) => ({ [ev]: [{ ...(extra || {}), hooks: [CLIENTS[client].handler(name, timeout)] }] });

function installOne(client) {
  const c = CLIENTS[client];
  const FILE = c.file();
  const DIR = path.posix.dirname(FILE);
  let obj = {}, existed = false, raw = '';
  if (fs.existsSync(FILE)) {
    raw = fs.readFileSync(FILE, 'utf8');
    existed = true;
    try { obj = JSON.parse(raw || '{}'); }
    catch (e) { console.log(`✗ ${FILE} 不是合法 JSON：${e.message}　（不写，先让你手工修）`); return false; }
  }
  // 判据是"宿主的配置目录在不在"，不是"settings.json 在不在"：
  // 新装的宿主本来就没有 settings.json，按文件判会把第一次注册直接跳过（实跑踩过）。
  if (!fs.existsSync(DIR)) {
    console.log(`· ${c.label}：没有 ${DIR}（这台机器没检测到这个宿主），跳过`);
    return true;
  }
  if (!existed && REMOVE) {
    console.log(`· ${c.label}：没有 ${FILE}，无需卸载`);
    return true;
  }
  obj.hooks = obj.hooks || {};
  const removed = strip(obj.hooks);

  if (REMOVE) {
    if (!Object.keys(obj.hooks).length) delete obj.hooks;
    fs.writeFileSync(FILE, JSON.stringify(obj, null, 2) + '\n');
    console.log(`✓ ${c.label}：已摘掉 ${removed} 条 convledger hook（${FILE}）；其余配置键原样`);
    return true;
  }

  // 追加而不是挤掉：同一个事件下别人也可能挂了 hook（测试夹具、其他工具），
  // 我们只摘自己的条目，再加自己的；直接 Object.assign 会把整个数组换掉。
  const addDef = (d) => { for (const [ev, arr] of Object.entries(d)) obj.hooks[ev] = [...(obj.hooks[ev] ?? []), ...arr]; };
  // WorkBuddy 的 handler 组要带 matcher，否则它重启/重装后认不出这组条目会丢。
  const addEv = (ev, name, timeout) => addDef(def(client, ev, name, timeout, client === 'workbuddy' ? { matcher: '' } : undefined));
  addEv('SessionStart', 'brief-start', 45);
  addEv('PreCompact', 'rebuild', 60);
  addEv('PostCompact', 'brief', 45);
  // 收尾检查：只对有任务模型的项目、且本轮有新人类消息时提示一次（handler 自己判定）
  addEv('Stop', 'closeout', 30);
  if (PROBE) addDef(def(client, 'PostToolUse', 'probe', 15, { matcher: 'Bash' }));

  if (existed) fs.writeFileSync(`${FILE}.bak-convledger`, raw);   // 覆盖式备份：只保最近一次改动前原文
  fs.writeFileSync(FILE, JSON.stringify(obj, null, 2) + '\n');

  const back = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const events = Object.keys(back.hooks || {}).filter((e) => (back.hooks[e] || []).some((d) => (d.hooks || []).some(MINE)));
  console.log(`✓ ${c.label}：写回 ${FILE}`);
  console.log(`  convledger hook 挂在：${events.join(' / ') || '（无）'}${PROBE ? '（含一次性探活 PostToolUse）' : ''}`);
  console.log(`  摘掉旧条目 ${removed} 条 · 备份 ${FILE}.bak-convledger（原有 ${raw.length} 字节）· 其他顶层键 ${Object.keys(back).join(', ') || '（无）'}`);
  return true;
}

/* OpenCode 不走 settings.json：V2（2.x）只认 ~/.config/opencode/plugins/ 下的
   Plugin.define({ id, setup }) 形状（旧的命名导出返回 hook 对象在 2.x 里不会被激活）。
   插件只做转发：compaction → brief、session.execution.succeeded → closeout → 后台会话；判据都在 hooks/opencode.mjs。 */
function opencodeDir() {
  const base = process.env.OPENCODE_CONFIG_DIR || path.join(home, '.config', 'opencode');
  return `${base.replace(/\\/g, '/')}/plugins`;
}
function installOpencode() {
  const dir = opencodeDir();
  const file = `${dir}/convledger.js`;
  const legacy = `${path.posix.dirname(dir)}/plugin/convledger.js`;
  if (REMOVE) {
    let n = 0;
    for (const f of [file, legacy]) {
      if (fs.existsSync(f)) { fs.rmSync(f); console.log(`✓ OpenCode：已删 ${f}`); n++; }
    }
    if (!n) console.log('· OpenCode：没有已安装的插件，无需卸载');
    return true;
  }
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), 'opencode-plugin.js');
  const body = fs.readFileSync(src, 'utf8')
    .replaceAll('__CONVLEDGER_CLI__', `${TOOL_ROOT.replace(/\\/g, '/')}/hooks/opencode.mjs`)
    .replaceAll('__CONVLEDGER_MAIN__', `${TOOL_ROOT.replace(/\\/g, '/')}/bin/convledger.mjs`)
    .replaceAll('__CONVLEDGER_LOG__', `${TOOL_ROOT.replace(/\\/g, '/')}/out/hook-probe.jsonl`);
  fs.writeFileSync(file, body);
  if (fs.existsSync(legacy)) { fs.rmSync(legacy); console.log(`· OpenCode：删掉旧的 V1 插件 ${legacy}（2.x 不会激活它）`); }
  console.log(`✓ OpenCode：已安装 ${file}（${body.length} 字节）`);
  console.log('  事件：session.hook("compaction") → brief · session.execution.succeeded → closeout → 后台会话（取不到账本就不注）\n  改完插件要重启 OpenCode：常驻 service 不会热加载用户目录里的插件文件');
  return true;
}

/* Codex 不走 settings.json：用户级 hooks 放在 ~/.codex/hooks.json（CODEX_HOME 可改），
   形状是 { hooks: { SessionStart: [{ hooks: [{ type:'command', command, commandWindows, timeout }] }] } }。
   事件名、输入字段与输出字段（hookSpecificOutput.additionalContext）和另外三家同源，handler 直接复用。
   ⚠ Codex 的 hooks 还是 beta：装完可能要在它自己的界面里确认信任；本机没有 Codex CLI 样本，未做投递实测。 */
function codexDir() {
  return (process.env.CODEX_HOME || path.join(home, '.codex')).replace(/\\/g, '/');
}
function installCodex() {
  const dir = codexDir();
  // Codex 读项目级 .codex/hooks.json；在仓库根里跑安装器时优先写项目级，用户级只作旧版兜底。
  const inRepo = fs.existsSync(path.join(process.cwd(), 'tool', 'bin', 'convledger.mjs'));
  const projectRoot = inRepo ? process.cwd() : null;
  const file = projectRoot ? path.join(projectRoot, '.codex', 'hooks.json') : `${dir}/hooks.json`;
  if (!fs.existsSync(dir)) { console.log(`· Codex：没有 ${dir}（这台机器没检测到 Codex），跳过`); return true; }
  if (projectRoot) fs.mkdirSync(path.dirname(file), { recursive: true });
  let obj = {}, existed = false, raw = '';
  if (fs.existsSync(file)) {
    raw = fs.readFileSync(file, 'utf8');
    existed = true;
    try { obj = JSON.parse(raw || '{}'); }
    catch (e) { console.log(`✗ ${file} 不是合法 JSON：${e.message}　（不写，先让你手工修）`); return false; }
  }
  obj.hooks = obj.hooks || {};
  let removed = 0;
  for (const [ev, defs] of Object.entries(obj.hooks)) {
    const kept = [];
    for (const d of defs || []) {
      const mine = (d.hooks || []).filter(MINE);
      removed += mine.length;
      const rest = (d.hooks || []).filter((h) => !MINE(h));
      if (rest.length) kept.push({ ...d, hooks: rest });
    }
    if (kept.length) obj.hooks[ev] = kept; else delete obj.hooks[ev];
  }
  if (REMOVE) {
    if (!existed) { console.log('· Codex：没有 hooks.json，无需卸载'); return true; }
    if (!Object.keys(obj.hooks).length) delete obj.hooks;
    fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
    console.log(`✓ Codex：已摘掉 ${removed} 条 convledger hook（${file}）；其余键原样`);
    return true;
  }
  // Windows 上直接写两段带引号的命令会被 Codex 的启动器拆坏；写成 .cmd 再引用它。
  let cmd = `${quote(process.execPath)} ${quote(SCRIPT)} --origin host`;
  if (projectRoot && process.platform === 'win32') {
    const wrap = path.join(projectRoot, 'tool', 'hooks', 'codex-hook.cmd');
    fs.mkdirSync(path.dirname(wrap), { recursive: true });
    fs.writeFileSync(wrap, `@echo off\r\n"${process.execPath}" "${SCRIPT}" --origin host\r\nexit /b %ERRORLEVEL%\r\n`);
    cmd = quote(wrap);
  }
  const add = (ev, timeout) => {
    obj.hooks[ev] = [...(obj.hooks[ev] ?? []), { hooks: [{ type: 'command', command: cmd, commandWindows: cmd, timeout }] }];
  };
  // Codex 公开可用的只有 SessionStart / Stop 两类；PreCompact/PostCompact 写了也不会触发。
  add('SessionStart', 45); add('Stop', 30);
  if (existed) fs.writeFileSync(`${file}.bak-convledger`, raw);
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
  console.log(`✓ Codex：写回 ${file}`);
  console.log(`  hook 挂在：SessionStart / Stop · 备份 ${file}.bak-convledger`);
  console.log('  注意：Codex hooks 仍属 beta，需要在 Codex 配置里开 features.codex_hooks=true，并确认信任；本机没有 Codex 会话，投递未实测');
  return true;
}

const targets = clientArg === 'all' ? ['qoder', 'claude-code', 'workbuddy', 'codex', 'opencode'] : [clientArg];
let ok = true;
for (const t of targets) ok = (t === 'opencode' ? installOpencode() : t === 'codex' ? installCodex() : installOne(t)) && ok;
console.log(`  node=${process.execPath}\n  script=${SCRIPT}`);
process.exit(ok ? 0 : 1);

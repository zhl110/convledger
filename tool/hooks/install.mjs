#!/usr/bin/env node
// 注册/卸载 convledger 的会话事件 hook。配置只能写用户级 settings.json（本机
// QODER_CONFIG_DIR 就指向 ~/.qoder，没有独立的项目级文件），所以挂上之后对**所有项目的会话**生效。
// 只动我们自己的条目，其余键与他人 hook 原样保留。
//
//   node hooks/install.mjs                     # 默认装 Qoder（旧行为不变）
//   node hooks/install.mjs --client workbuddy  # 装 WorkBuddy
//   node hooks/install.mjs --client all        # 两个都装
//   … --remove / --probe
//
// 两个宿主的 handler 形状不同：Qoder 吃 {command:<exe>, args:[…]}，WorkBuddy 只吃
// {command:"<shell 串>"}（没有 args 字段，塞了会被拒或静默不跑）——所以形状由 client 决定。
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

const legal = ['qoder', 'workbuddy', 'opencode', 'all'];
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
  || String(h?.command || '').replace(/\\/g, '/').toLowerCase().includes(SCRIPT.toLowerCase());

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
  addDef(def(client, 'SessionStart', 'brief-start', 45));
  addDef(def(client, 'PreCompact', 'rebuild', 60));
  addDef(def(client, 'PostCompact', 'brief', 45));
  // 收尾检查：只对有任务模型的项目、且本轮有新人类消息时提示一次（handler 自己判定）
  addDef(def(client, 'Stop', 'closeout', 30));
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

/* OpenCode 不走 settings.json：它认的是 ~/.config/opencode/plugins/*.js。
   插件只做转发（compacting → brief、session.idle → closeout），判据都在 hooks/opencode.mjs。 */
function opencodeDir() {
  const base = process.env.OPENCODE_CONFIG_DIR || path.join(home, '.config', 'opencode');
  return `${base.replace(/\\/g, '/')}/plugins`;
}
function installOpencode() {
  const dir = opencodeDir();
  const file = `${dir}/convledger.js`;
  if (REMOVE) {
    if (fs.existsSync(file)) { fs.rmSync(file); console.log(`✓ OpenCode：已删 ${file}`); }
    else console.log(`· OpenCode：没有 ${file}，无需卸载`);
    return true;
  }
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), 'opencode-plugin.js');
  fs.copyFileSync(src, file);
  const t = fs.readFileSync(file, 'utf8');
  console.log(`✓ OpenCode：已安装 ${file}（${t.length} 字节）`);
  console.log('  事件：experimental.session.compacting → brief · session.idle → closeout（取不到账本就不注）');
  return true;
}

const targets = clientArg === 'all' ? ['qoder', 'workbuddy', 'opencode'] : [clientArg];
let ok = true;
for (const t of targets) ok = (t === 'opencode' ? installOpencode() : installOne(t)) && ok;
console.log(`  node=${process.execPath}\n  script=${SCRIPT}`);
process.exit(ok ? 0 : 1);

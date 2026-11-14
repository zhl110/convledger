// 新设备适配：体检、找宿主、装 Skill/hooks、冒烟建账、快捷方式、hub。
// 只做本机能自动判断的事；装 Node、克隆私有仓、授权都不在这里假装能做。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { listSessions } from './project.mjs';
import { opencodeDb } from './opencode.mjs';
import { indexWindowed } from './window.mjs';
import { storeDir } from './store.mjs';
import { probeHub, hubFile } from './map.mjs';

const require = createRequire(import.meta.url);
const TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BIN = path.join(TOOL, 'bin', 'convledger.mjs');
export const HOME = os.homedir().replace(/\\/g, '/');
const fwd = (p) => String(p).replace(/\\/g, '/');

export function nodeFacts() {
  const major = Number(process.versions.node.split('.')[0]);
  let sqlite = false;
  try { require('node:sqlite'); sqlite = true; } catch { /* <22.5 */ }
  return { version: process.versions.node, major, sqlite };
}

const HOSTS = [
  { id: 'qoder', label: 'Qoder', source: (h) => `${h}/.qoder/projects`, conf: (h, env) => env.QODER_CONFIG_DIR || `${h}/.qoder`, skill: true, hooks: true },
  { id: 'claude-code', label: 'Claude Code', source: (h) => `${h}/.claude/projects`, conf: (h, env) => env.CLAUDE_CONFIG_DIR || `${h}/.claude`, skill: true, hooks: true },
  { id: 'workbuddy', label: 'WorkBuddy', source: (h) => `${h}/.workbuddy/projects`, conf: (h, env) => env.WORKBUDDY_CONFIG_DIR || `${h}/.workbuddy`, skill: true, hooks: true },
  { id: 'opencode', label: 'OpenCode', source: (h, env) => fwd(opencodeDb(env)), conf: (h, env) => env.OPENCODE_CONFIG_DIR || `${h}/.config/opencode`, skill: true, hooks: true, sqlite: true },
  // Codex 已有会话源（rollout），但还没接成账本来源；先让它出现在体检与状态页里。
  { id: 'codex', label: 'Codex', source: (h, env) => `${env.CODEX_HOME || `${h}/.codex`}/sessions`, conf: (h, env) => env.CODEX_HOME || `${h}/.codex`, skill: true, hooks: true },
];

/** 宿主的源与配置目录都按 HOME/env 推出来；sessions 只为计数（可注入测试）。
 *  计数只认"这台机器上真有源"的那些：OpenCode 的账本源自仓库内的投影缓存，源库不在这台
 *  机器上时那些行仍会被列出来，把它们算成"61 段 · 未检测到宿主"就自相矛盾，还会真去建账。 */
export function hostRows({ sessions = [], home = HOME, env = process.env, sqlite = nodeFacts().sqlite } = {}) {
  const by = sessions.reduce((a, s) => ({ ...a, [s.runner]: (a[s.runner] ?? 0) + 1 }), {});
  return HOSTS.map((h) => {
    const source = fwd(h.source(home, env));
    const conf = h.conf ? fwd(h.conf(home, env)) : null;
    const hostFound = conf ? fs.existsSync(conf) : fs.existsSync(source);
    const found = fs.existsSync(source);
    const n = found ? by[h.id] ?? 0 : 0;
    return {
      id: h.id, label: h.label, source, conf,
      sessions: n,
      cached: found ? 0 : by[h.id] ?? 0,
      sourceFound: found,
      hostFound,
      canSkill: !!h.skill && !!conf && hostFound,
      canHook: !!h.hooks && hostFound && (!h.sqlite || sqlite),
      sqliteOnly: !!h.sqlite,
    };
  });
}

export async function portState(port = 8765) {
  const hub = await probeHub(port, { tries: 3, timeout: 1500 });
  if (hub) return { state: 'hub', port: hub.port ?? port };
  const busy = await new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { try { s.destroy(); } catch { /* 已关 */ } resolve(v); };
    s.setTimeout(600);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
  if (!busy) return { state: 'free', port };
  // 连得上不等于被抢：hub 正在重建那 240 本账时 /health 会慢，三次 1.5 秒就判给"别的程序"
  // 是误报（隔离走查真撞到过一次）。再耐心探一轮，仍不认才报 busy。
  const again = await probeHub(port, { tries: 4, timeout: 3000 });
  return again ? { state: 'hub', port: again.port ?? port } : { state: 'busy', port };
}

export function storeWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, '.setup-probe');
    fs.writeFileSync(f, 'ok');
    fs.rmSync(f, { force: true });
    return true;
  } catch { return false; }
}

export function runNode(script, args, { cwd = TOOL } = {}) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, out: String(r.stdout ?? '').trim(), err: String(r.stderr ?? '').trim() };
}

export function smoke(root, sessions, runner) {
  const newest = sessions.filter((s) => s.runner === runner)
    .sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)))[0];
  if (!newest) return null;
  if (fs.existsSync(path.join(storeDir(root, newest.sessionId), 'ledger.json'))) {
    return { id: newest.sessionId, built: false };
  }
  const r = indexWindowed(newest.file, { storeRoot: root });
  return { id: newest.sessionId, built: true, segments: r.segs };
}

/** 装完就要能用：按源文件的写入时间倒序建最近 N 个会话的账（跳过已建的与太小的会话）。
 *  以前 setup 只给每个来源冒烟一个，新用户打开会话库看到满屏「未建账」，像没装好。
 *  runners 是"这台机器上真有源"的宿主白名单：OpenCode 的会话来自仓库内的投影缓存，
 *  源库不在时把它们也建成账，报告就成了"没检测到宿主 · 却建了 61 个会话"的自相矛盾。 */
export function buildRecent(root, sessions, n, runners = null) {
  const list = sessions.filter((s) => s.bytes > 20000)
    .filter((s) => !runners || runners.has(s.runner));
  const skipped = runners ? sessions.filter((s) => s.bytes > 20000 && !runners.has(s.runner)).length : 0;
  list.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
  const res = { total: list.length, built: 0, existed: 0, remaining: 0, skippedNoSource: skipped, failed: [], newest: [] };
  for (const s of list.slice(0, Math.max(0, n))) {
    if (fs.existsSync(path.join(storeDir(root, s.sessionId), 'ledger.json'))) { res.existed++; continue; }
    try {
      const r = indexWindowed(s.file, { storeRoot: root });
      res.built++;
      res.newest.push(`${s.runner} ${s.sessionId.slice(0, 8)}（${r.segs} 段）`);
    } catch (e) {
      res.failed.push(`${s.runner} ${s.sessionId.slice(0, 8)}：${String(e?.message ?? e).split('\n')[0]}`);
    }
  }
  res.remaining = Math.max(0, res.total - res.built - res.existed - res.failed.length);
  return res;
}

/** Windows 快捷方式：桌面 + 开始菜单，目标都是 wscript + open-map.vbs（会先确保 hub 在跑）。
 *  两段 PowerShell 正文单独导出，方便静态断言：
 *  - 失败要成人话。PowerShell 出错时 stderr 是 CLIXML，直接打印第一个错误行等于甩一串 XML 给用户
 *    （实跑见过 `✗ 快捷方式：#< CLIXML`），所以错误在脚本里 catch 住，用 ERR:/MISS: 前缀走 stdout。
 *  - 花括号必须成对。少一个 `}` 时 PowerShell 连解析都过不去（MissingEndCurlyBrace），catch 形同
 *    不存在，用户只看到退出码 1——两处都错过一次，所以 try 的闭括号固定拼在末尾。 */
export function shortcutPs(root) {
  const q = (s) => String(s).replace(/'/g, "''");
  const body = [
    "$n='convledger '+[char]0x5730+[char]0x56FE+'.lnk'",
    "$pairs=@(@('桌面',[Environment]::GetFolderPath('Desktop')),@('开始菜单',[Environment]::GetFolderPath('Programs')))",
    "foreach($x in $pairs){ $d=$x[1]; if(-not $d -or -not [System.IO.Directory]::Exists($d)){Write-Output ('MISS:'+$x[0]);continue}",
    "$p=Join-Path $d $n;$s=(New-Object -ComObject WScript.Shell).CreateShortcut($p);$s.TargetPath='wscript.exe';"
      + `$s.Arguments='"${q(path.join(root, 'tool', 'open-app.vbs'))}"';`
      + `$s.WorkingDirectory='${q(root)}';`
      + "$s.Description='Open the convledger app window';"
      + `$s.IconLocation='${q(path.join(root, 'tool', 'web', 'convledger.ico'))},0';`
      + '$s.Save();Write-Output $p}',
  ].join('; ');
  return "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ErrorActionPreference='Stop';"
    + ` try{ ${body} } catch{Write-Output ('ERR:'+($_.Exception.Message -replace '\\s+',' '))}`;
}

/** 撤快捷方式的 PowerShell 正文：只删自己写的那两个文件名，别人的桌面不动。 */
export function removePs() {
  const body = "foreach($d in @([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('Programs')))"
    + "{ if(-not $d){continue}; $p=Join-Path $d $n; if(Test-Path -LiteralPath $p){ Remove-Item -LiteralPath $p -Force; Write-Output $p } }";
  return "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;"
    + "$n='convledger '+[char]0x5730+[char]0x56FE+'.lnk';"
    + ` try{ ${body} } catch{ Write-Output ('ERR:'+($_.Exception.Message -replace '\\s+',' ')) }`;
}

export function writeShortcuts(root) {
  if (process.platform !== 'win32') return { ok: false, paths: [], reason: '非 Windows，跳过' };
  const ps = shortcutPs(root);
  const enc = Buffer.from(ps, 'utf16le').toString('base64');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { encoding: 'utf8', windowsHide: true });
  if (r.error) return { ok: false, paths: [], reason: `PowerShell 起不来（${r.error.code ?? r.error.message}）` };
  const lines = String(r.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const paths = lines.filter((s) => !/^(ERR|MISS):/.test(s));
  const err = lines.find((s) => s.startsWith('ERR:'));
  const miss = lines.filter((s) => s.startsWith('MISS:')).map((s) => s.slice(5));
  if (err) return { ok: false, paths, reason: err.slice(4).trim() || 'PowerShell 报了错但没有内容' };
  if (r.status !== 0) return { ok: false, paths, reason: `PowerShell 没跑完（退出码 ${r.status}）——${String(r.stderr ?? '').replace(/\s+/g, ' ').slice(0, 120) || '没有错误输出'}` };
  if (!paths.length) return { ok: false, paths, reason: miss.length ? `这台机器上没有这两个目录：${miss.join('、')}` : 'PowerShell 没报错，但一处快捷方式也没写出来' };
  return { ok: true, paths, reason: '', note: miss.length ? `没有的目录跳过：${miss.join('、')}` : '' };
}

export function removeShortcuts() {
  if (process.platform !== 'win32') return { ok: false, paths: [], reason: '非 Windows，跳过' };
  const ps = removePs();
  const enc = Buffer.from(ps, 'utf16le').toString('base64');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { encoding: 'utf8', windowsHide: true });
  if (r.error) return { ok: false, paths: [], reason: `PowerShell 起不来（${r.error.code ?? r.error.message}）` };
  const lines = String(r.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const err = lines.find((s) => s.startsWith('ERR:'));
  if (err) return { ok: false, paths: [], reason: err.slice(4).trim() };
  // 解析不过去的 PowerShell 只会把错误写成 CLIXML，stdout 一片空白——
  // 不查退出码就会报成"没有发现快捷方式"，把 bug 说成没事（实跑就这么漏过一次）
  if (r.status !== 0) return { ok: false, paths: [], reason: `PowerShell 没跑完（退出码 ${r.status}）——${String(r.stderr ?? '').replace(/\s+/g, ' ').slice(0, 120) || '没有错误输出'}` };
  const paths = lines.filter((s) => !/^(ERR|MISS):/.test(s));
  return { ok: true, paths, reason: paths.length ? '' : '没有发现快捷方式（可能已删或没建过）' };
}

/** Linux 桌面入口：~/.local/share/applications/convledger.desktop。
 *  Exec 直接起 hub 再开系统浏览器；只写自己这一个文件名，卸载只删它。
 *  macOS 不用 .desktop（也没有真机验过），文档给 open-map.sh。 */
export function writeDesktopEntry(root) {
  if (process.platform !== 'linux') return { ok: false, paths: [], reason: '只做 Linux，跳过' };
  const dir = path.join(os.homedir(), '.local', 'share', 'applications');
  const file = path.join(dir, 'convledger.desktop');
  const q = (s2) => `"${String(s2).replace(/"/g, '\\"')}"`;
  const body = [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=convledger 地图',
    'Comment=打开本机会话账本（本地服务 127.0.0.1:8765）',
    `Exec=${q(process.execPath)} ${q(path.join(root, 'tool', 'bin', 'convledger.mjs'))} map --open`,
    `Path=${root}`,
    `Icon=${path.join(root, 'tool', 'web', 'icon.svg')}`,
    'Terminal=false',
    'Categories=Development;',
    '',
  ].join('\n');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, body);
    fs.chmodSync(file, 0o755);
    return { ok: true, paths: [file], reason: '' };
  } catch (e) {
    return { ok: false, paths: [], reason: `写不了桌面入口：${String(e?.message ?? e).split('\n')[0]}` };
  }
}

export function removeDesktopEntry() {
  if (process.platform !== 'linux') return { ok: false, paths: [], reason: '只做 Linux，跳过' };
  const file = path.join(os.homedir(), '.local', 'share', 'applications', 'convledger.desktop');
  if (!fs.existsSync(file)) return { ok: true, paths: [], reason: '没有发现桌面入口（可能已删或没建过）' };
  try { fs.unlinkSync(file); return { ok: true, paths: [file], reason: '' }; }
  catch (e) { return { ok: false, paths: [], reason: `删不掉：${String(e?.message ?? e).split('\n')[0]}` }; }
}

/** 把文本放进系统剪贴板（Windows 用 clip，读写都是同一个 ASCII 地址）。 */
export function copyText(text) {
  const [cmd, args] = process.platform === 'win32'
    ? ['clip.exe', []]
    : process.platform === 'darwin' ? ['pbcopy', []] : ['xclip', ['-selection', 'clipboard']];
  const r = spawnSync(cmd, args, { input: String(text), encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, reason: r.status === 0 ? '' : `${cmd} 不可用（${r.error?.code ?? r.status}）` };
}

export function openUrl(url) {
  const [cmd, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); }
  catch { /* 打不开浏览器不影响地址已给出 */ }
}

/** Chromium 内核的浏览器：应用窗口（--app）靠它，找不到就退回默认浏览器。 */
export function appBrowser({ env = process.env, platform = process.platform } = {}) {
  if (env.CONVLEDGER_BROWSER && fs.existsSync(env.CONVLEDGER_BROWSER)) return env.CONVLEDGER_BROWSER;
  const win = [
    `${env['ProgramFiles(x86)'] || 'C:/Program Files (x86)'}/Microsoft/Edge/Application/msedge.exe`,
    `${env.ProgramFiles || 'C:/Program Files'}/Microsoft/Edge/Application/msedge.exe`,
    `${env.LOCALAPPDATA || ''}/Microsoft/Edge/Application/msedge.exe`,
    `${env.ProgramFiles || 'C:/Program Files'}/Google/Chrome/Application/chrome.exe`,
    `${env['ProgramFiles(x86)'] || 'C:/Program Files (x86)'}/Google/Chrome/Application/chrome.exe`,
    `${env.LOCALAPPDATA || ''}/Google/Chrome/Application/chrome.exe`,
  ];
  if (platform === 'win32') return win.find((p) => p && fs.existsSync(p.replace(/\\/g, '/'))) ?? null;
  if (platform === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].find((p) => fs.existsSync(p)) ?? null;
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge']
    .find((p) => fs.existsSync(p)) ?? null;
}

/** 应用窗专用 profile：既隔离普通浏览器，也让「第二次点图标」找得到自己那扇窗。 */
export function appProfileDir() {
  return path.join(TOOL, 'out', 'app-profile').replace(/\\/g, '/');
}

/** Windows：把已有应用窗提到最前。返回 pid；没有就返回 null。 */
export function focusAppWindow(profile = appProfileDir(), { platform = process.platform } = {}) {
  if (platform !== 'win32') return null;
  const ps = "$ErrorActionPreference='Stop';"
    + "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class CW{[DllImport(\"user32.dll\")]public static extern bool SetForegroundWindow(IntPtr h);[DllImport(\"user32.dll\")]public static extern bool ShowWindow(IntPtr h,int n);}';"
    + "$h=[IntPtr]::Zero;$wd=0;"
    // 只认应用窗专用 profile。普通 Edge/Chrome 里打开的 convledger 页面也会带
    // 「convledger」标题，按标题兜底会把浏览器主窗误当应用窗，反而挡住真正开窗。
    + "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -match 'app-profile' } | ForEach-Object { if($h -eq [IntPtr]::Zero){ $pr=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if($pr -and $pr.MainWindowHandle -ne 0){$h=$pr.MainWindowHandle;$wd=$pr.Id} } };"
    + "if($h -ne [IntPtr]::Zero){[CW]::ShowWindow($h,9)|Out-Null;[CW]::SetForegroundWindow($h)|Out-Null;Write-Output ('FOCUSED '+$wd)} else {Write-Output 'NONE'}";
  const enc = Buffer.from(ps, 'utf16le').toString('base64');
  // 窗口刚起来时主窗口句柄可能还是 0：重试几次再判定「没有」。
  for (let i = 0; i < 3; i++) {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { encoding: 'utf8', windowsHide: true });
    const m = String(r.stdout ?? '').match(/FOCUSED\s+(\d+)/);
    if (m) return Number(m[1]);
    if (i < 2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  return null;
}

/** 应用窗专用的浏览器进程还在不在（窗口可能还没长出来）。 */
export function profileAlive(opts = {}) {
  if ((opts.platform ?? process.platform) !== 'win32') return true;
  const ps = "$p=Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -match 'app-profile' } | Select-Object -First 1; if($p){'YES'}else{'NO'}";
  const enc = Buffer.from(ps, 'utf16le').toString('base64');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { encoding: 'utf8', windowsHide: true });
  return /YES/.test(String(r.stdout ?? ''));
}

/** 同一时刻只让一个入口决定开窗；后来的入口只等聚焦，不补开第二扇。
 *  用 `wx` 原子创建，竞态下只有一个 convledger app 能拿到锁。 */
function acquireAppLock(lock) {
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(lock, 'wx');
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() })); } finally { fs.closeSync(fd); }
      return () => { try { fs.unlinkSync(lock); } catch { /* 已被别的入口清掉 */ } };
    } catch (e) {
      if (e.code !== 'EEXIST') return null;
      let info = null;
      try { info = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch { /* 旧锁没有正文 */ }
      let age = 0;
      if (info?.at) age = Date.now() - Number(info.at);
      else { try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { age = 0; } }
      let alive = true;
      if (info?.pid) { try { process.kill(Number(info.pid), 0); } catch { alive = false; } }
      if (age > 30000 || !alive) { try { fs.unlinkSync(lock); } catch { /* 下一轮再试 */ } continue; }
      return null;
    }
  }
  return null;
}

function waitForAppWindow(profile, opts, tries = 24) {
  for (let i = 0; i < tries; i++) {
    const pid = focusAppWindow(profile, opts);
    if (pid) return pid;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  return null;
}

/** Windows 通知区域托盘助手：关掉主窗后图标仍留着，左键打开、右键重启/退出。
 *  它不承载页面，也不替代浏览器进程；单实例由 tray.ps1 里的命名互斥量保证。 */
function ensureTray({ env = process.env, platform = process.platform } = {}) {
  if (platform !== 'win32') return;
  if (String(env.CONVLEDGER_NO_TRAY || '') === '1') return;
  const script = path.join(TOOL, 'tray.ps1');
  const vbs = path.join(TOOL, 'tray-launch.vbs');
  if (!fs.existsSync(script)) return;
  try {
    // wscript 是 GUI 子系统、没有控制台：由它 Run 一个隐藏的 PowerShell，托盘不会闪黑框，
    // 也能活过 convledger app 启动器（直接 spawn 会被一起收掉，cmd start 又会闪窗）。
    if (fs.existsSync(vbs)) {
      spawn('wscript.exe', [vbs, script, path.dirname(TOOL), process.execPath],
        { detached: true, stdio: 'ignore', windowsHide: true, env }).unref();
      return;
    }
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass', '-File', script, '-Root', path.dirname(TOOL), '-Node', process.execPath],
    { detached: true, stdio: 'ignore', windowsHide: true, env }).unref();
  } catch { /* 托盘起不来不影响应用窗 */ }
}

/** 专属应用窗口：没有地址栏和标签页；已有就聚焦，不重复开。打不开就退回普通浏览器。
 *  桌面 APP 用浏览器 --app 窗口（AgentHub 同款）；--disable-extensions 保持窗口纯净。 */
export function openAppWindow(url, opts = {}) {
  const exe = appBrowser(opts);
  if (!exe) { openUrl(url); return { app: false, browser: null, focused: false }; }
  const profile = appProfileDir();
  const mark = path.join(TOOL, 'out', 'app-launch.json');
  const lock = path.join(TOOL, 'out', 'app-launch.lock');
  const win = (opts.platform ?? process.platform) === 'win32';
  ensureTray(opts);
  try { fs.mkdirSync(path.dirname(lock), { recursive: true }); } catch { /* 目录建不了就让锁自己失败 */ }
  const release = acquireAppLock(lock);
  if (!release) {
    // 另一个入口正在开窗：只等它把窗口长出来并聚焦，绝不再 spawn 第二个浏览器进程。
    let pid = focusAppWindow(profile, opts);
    if (!pid && win) pid = waitForAppWindow(profile, opts, 24);
    return { app: true, browser: exe, focused: !!pid, pending: !pid, pid: pid ?? undefined };
  }
  try {
    let pid = focusAppWindow(profile, opts);
    if (pid) return { app: true, browser: exe, focused: true, pid };
    // 刚点过、首扇窗还没长出句柄：先等它，别在同一个 profile 里再开一扇。
    let last = 0;
    try { last = Number(JSON.parse(fs.readFileSync(mark, 'utf8')).at) || 0; } catch { /* 第一次点 */ }
    const first = !last;
    if (last && Date.now() - last < 20000 && profileAlive(opts)) {
      // 冷启动的新 profile 可能十几秒才长出窗口句柄：这期间只等，不再开第二扇。
      if (win) pid = waitForAppWindow(profile, opts, 24);
      if (pid) return { app: true, browser: exe, focused: true, pid };
    }
    // 只有第一次给初始大小；之后让 profile 记住用户拖过的窗口尺寸/位置，自适应恢复。
    // --disable-extensions：应用窗不加载浏览器插件（2026-11-14 用户要求，窗口保持纯净）。
    // --no-first-run / --no-default-browser-check：专用 profile 第一次启动时，Edge 会往桌面
    // 塞一个「Microsoft Edge」快捷方式（--source-shortcut-location=desktop）；在真机复现过。
    // 这两个旗标让浏览器不跑首次启动向导，因此不再生成那个快捷方式。
    const args = [`--app=${url}`, `--user-data-dir=${profile}`, '--disable-extensions',
      '--no-first-run', '--no-default-browser-check'];
    if (first) args.push('--window-size=1280,860');
    spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    try { fs.writeFileSync(mark, JSON.stringify({ at: Date.now() })); } catch { /* 标记写不了就只靠聚焦 */ }
    // 锁保持到窗口真的长出来；这期间第二个入口只会等待，不会各开一扇。
    if (win) pid = waitForAppWindow(profile, opts, 30);
    return { app: true, browser: exe, focused: !!pid, pid: pid ?? undefined, spawned: true };
  } catch {
    openUrl(url);
    return { app: false, browser: exe, focused: false };
  } finally {
    release();
  }
}

/** hub 不在就 detached 起一个，返回端口；起不来返回 null。 */
export async function ensureHub(root, port = 8765, rebuildSec = 20) {
  // 测试/CI 环境绝不派生常驻 hub：一旦某个用例忘了隔离端口，就会留下一个抢真 8765、指向测试库的
  // 孤儿进程（曾导致 App 看板显示空数据）。设了该环境变量就只报告「跳过」，不 spawn。
  if (process.env.CONVLEDGER_NO_RESIDENT_HUB === '1') return { port, reused: false, skipped: true };
  const up = await probeHub(port, { tries: 3, timeout: 1500 });
  if (up) return { port: up.port ?? port, reused: true };
  const child = spawn(process.execPath, [BIN, 'map', '--serve', '--port', String(port), '--rebuild', String(rebuildSec), '--store', root],
    { detached: true, stdio: 'ignore', windowsHide: true, cwd: TOOL });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const h = await probeHub(port, { tries: 1, timeout: 800 });
    if (h) return { port: h.port ?? port, reused: false };
  }
  return null;
}

/** 端口是否空闲：连不上＝空闲（有监听/有 hub 都算占用）。600ms 足够本机判断。 */
export async function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { try { s.destroy(); } catch { /* 已关 */ } resolve(v); };
    s.setTimeout(600);
    s.once('connect', () => done(false));   // 连得上＝有人占
    s.once('timeout', () => done(true));
    s.once('error', () => done(true));       // 连不上＝空闲
  });
}

/** 从 start 起找一个空闲端口（跳过被占/被 hub 占的），找不到返回 null。上限 65535。 */
export async function findOpenPort(start, tries = 30) {
  const end = Math.min(start + tries, 65536);
  for (let p = start; p < end; p++) {
    if (await isPortFree(p)) return p;
  }
  return null;
}

/** pid 文件里记录的那个 hub 还活着吗？活着就返回它的实际端口（哪怕是之前顺延到的临时端口）。 */
async function existingHub(root) {
  try {
    const info = JSON.parse(fs.readFileSync(hubFile(root), 'utf8'));
    if (!info?.pid) return null;
    try { process.kill(info.pid, 0); } catch { return null; }   // 进程不在了
    const up = await probeHub(info.port, { tries: 1, timeout: 800 });
    return up ? { port: up.port ?? info.port, reused: true } : null;
  } catch { return null; }
}

/**
 * 首选端口起 hub；**首选被别的程序占用时顺延到下一个空位**（临时运行办法）。
 * 依次：已有本工具 hub（任意端口）优先复用 → 首选空闲就用首选 → 首选被占就顺延 → 都失败返回 null。
 * 返回里带 fallback/busyAt，调用方据此把「临时换了端口」讲清楚。
 */
/** hub 门禁 token（out/hub-token 专用钥匙文件；兼容旧版 out/hub.json；启动方读出来拼进 URL，?k=<token>）。
 *  浏览器 Web 入口已下线（2026-11-14 用户要求）：没有 token 的访问一律 403。 */
export function readHubToken(tool = TOOL) {
  for (const f of [path.join(tool, 'out', 'hub-token'), path.join(tool, 'out', 'hub.json')]) {
    try {
      const raw = fs.readFileSync(f, 'utf8').trim();
      const t = raw.startsWith('{') ? JSON.parse(raw).token : raw;
      if (typeof t === 'string' && /^[0-9a-f]{48}$/.test(t)) return t;
    } catch { /* 换下一个来源 */ }
  }
  return null;
}

export async function ensureHubAuto(root, preferred = 8765, rebuildSec = 20) {
  // 全局暂停（out/HUB-PAUSED 存在）：不自动起常驻 hub（省内存）。要起就显式双击图标 /
  // convledger map / setup --hub——那几条会先删标记恢复，再进来。
  if (fs.existsSync(path.join(TOOL, 'out', 'HUB-PAUSED'))) return { skipped: true, paused: true, port: preferred };
  const ex = await existingHub(root);
  if (ex) return { ...ex, fallback: ex.port !== preferred, token: readHubToken() };
  const st = await portState(preferred);
  if (st.state === 'hub') return { port: st.port, reused: true, fallback: false, token: readHubToken() };
  // 冷启动：token 必须在 hub 起来「之后」读——hub.json 是新进程写的，起之前读到的是上一任的
  // 旧钥匙（2026-11-14 事故：拼着旧 token 开窗，门禁 403，启动页无限转圈）。
  if (st.state === 'free') {
    const hub = await ensureHub(root, preferred, rebuildSec);
    return hub ? { ...hub, token: readHubToken() } : null;
  }
  const alt = await findOpenPort(preferred + 1);
  if (!alt) return null;
  const hub = await ensureHub(root, alt, rebuildSec);
  return hub ? { ...hub, fallback: true, busyAt: preferred, token: readHubToken() } : null;
}

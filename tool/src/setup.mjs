// 新设备适配：体检、找宿主、装 Skill/hooks、冒烟建账、快捷方式、hub。
// 只做本机能自动判断的事；装 Node、克隆仓库、授权都不在这里假装能做。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { listSessions } from './project.mjs';
import { opencodeDb } from './opencode.mjs';
import { build } from './build.mjs';
import { storeDir, writeStore } from './store.mjs';
import { probeHub } from './map.mjs';

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
  { id: 'claude-code', label: 'Claude Code', source: (h) => `${h}/.claude/projects`, conf: null, skill: false, hooks: false },
  { id: 'workbuddy', label: 'WorkBuddy', source: (h) => `${h}/.workbuddy/projects`, conf: (h, env) => env.WORKBUDDY_CONFIG_DIR || `${h}/.workbuddy`, skill: true, hooks: true },
  { id: 'opencode', label: 'OpenCode', source: (h, env) => fwd(opencodeDb(env)), conf: (h, env) => env.OPENCODE_CONFIG_DIR || `${h}/.config/opencode`, skill: false, hooks: true, sqlite: true },
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
  const b = build(newest.file, { storeRoot: root });
  writeStore(root, b);
  return { id: newest.sessionId, built: true, segments: b.ledger.segments.length };
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
      const b = build(s.file, { storeRoot: root });
      writeStore(root, b);
      res.built++;
      res.newest.push(`${s.runner} ${s.sessionId.slice(0, 8)}（${b.ledger.segments.length} 段）`);
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
      + `$s.Arguments='"${q(path.join(root, 'tool', 'open-map.vbs'))}"';`
      + `$s.WorkingDirectory='${q(root)}';`
      + "$s.Description='Open the convledger conversation map in the browser';"
      + `$s.IconLocation='${q(path.join(root, 'tool', 'web', 'icon.ico'))},0';`
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

/** hub 不在就 detached 起一个，返回端口；起不来返回 null。 */
export async function ensureHub(root, port = 8765) {
  const up = await probeHub(port, { tries: 3, timeout: 1500 });
  if (up) return { port: up.port ?? port, reused: true };
  const child = spawn(process.execPath, [BIN, 'map', '--serve', '--port', String(port), '--rebuild', '20', '--store', root],
    { detached: true, stdio: 'ignore', windowsHide: true, cwd: TOOL });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const h = await probeHub(port, { tries: 1, timeout: 800 });
    if (h) return { port: h.port ?? port, reused: false };
  }
  return null;
}

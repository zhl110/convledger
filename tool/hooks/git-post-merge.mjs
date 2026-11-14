#!/usr/bin/env node
// git post-merge 的目标脚本：代码拉到本机之后，立刻把工具同步到最新。
// 逻辑放在仓库里受版本控制；.git/hooks/post-merge 只留一个转发壳，改逻辑不用重装每台机器。
//   node tool/hooks/git-post-merge.mjs --install  把转发壳写进本机 .git/hooks（幂等，别人已有的 hook 追加而不覆盖）
//   node tool/hooks/git-post-merge.mjs --check    只读报告装没装
//   node tool/hooks/git-post-merge.mjs --remove   摘掉自己那部分
//   无参数                                     由 git 在 merge/pull 完成后调用，跑一次 upgrade
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(import.meta.url).replace(/\\/g, '/');
export const TOOL = path.dirname(path.dirname(HERE)).replace(/\\/g, '/');
const REPO = path.dirname(TOOL);
const CLI = `${TOOL}/src/cli.mjs`;
const MARK = 'convledger-git-post-merge';
/** 只有整份由我们创建的壳带这个标记；追加到别人 hook 里的那两行不带，卸载时才分得清。 */
const OWN = `${MARK}-own`;

/** 用 git 自己算 hooks 目录：worktree / core.hooksPath 都认，别硬拼 .git/hooks。 */
export function hooksDir(repo = REPO) {
  const r = spawnSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 3000 });
  if (r.status !== 0) return path.join(repo, '.git', 'hooks');
  const got = String(r.stdout || '').trim();
  return path.isAbsolute(got) ? got.replace(/\\/g, '/') : path.resolve(repo, got).replace(/\\/g, '/');
}

export const hookFile = (repo = REPO) => path.join(hooksDir(repo), 'post-merge').replace(/\\/g, '/');

// 不写死 node 绝对路径：git 可能由 Agent、GUI 或终端拉起，PATH 里的 node 才通用；
// 找不到时退回安装这台机器时的解释器路径，至少本机能跑。
const nodeProbe = () => `CL_NODE="$(command -v node 2>/dev/null || printf '%s' "${process.execPath.replace(/\\/g, '/')}")" # ${MARK}`;
const callLine = (exec) => `${exec ? 'exec ' : ''}"$CL_NODE" "${HERE}" "$@"`;

/** 整份壳：文件不存在时写它。带 exec 让 git 等升级跑完再返回。 */
const ownShell = () => `#!/bin/sh\n# ${OWN} · 拉完代码自动同步本机工具（由 convledger on 安装）\n${nodeProbe()}\n${callLine(true)}\n`;
/** 别人已有 post-merge 时只追加调用，不动原文一行（不能 exec，会截断别人的逻辑）。 */
const appended = () => `\n# ${MARK} · 拉完代码自动同步本机工具\n${nodeProbe()}\n${callLine(false)}\n`;

export function hookState(repo = REPO) {
  const file = hookFile(repo);
  if (!fs.existsSync(file)) return { installed: false, file, mode: 'missing' };
  const body = fs.readFileSync(file, 'utf8');
  if (!body.includes(MARK)) return { installed: false, file, mode: 'foreign' };
  return { installed: true, file, mode: body.includes(OWN) ? 'owned' : 'appended' };
}

export function installGitHook(repo = REPO) {
  const dir = hooksDir(repo);
  fs.mkdirSync(dir, { recursive: true });
  const file = hookFile(repo);
  if (fs.existsSync(file)) {
    const body = fs.readFileSync(file, 'utf8');
    if (body.includes(MARK)) return { ok: true, action: 'already', file };
    fs.writeFileSync(`${file}.bak-convledger`, body);   // 覆盖式备份：只保最近一次改动前原文
    fs.appendFileSync(file, appended());
    try { fs.chmodSync(file, 0o755); } catch { /* Windows 上可执行位可能不可改 */ }
    return { ok: true, action: 'appended', file };
  }
  fs.writeFileSync(file, ownShell());
  try { fs.chmodSync(file, 0o755); } catch { /* 同上 */ }
  return { ok: true, action: 'created', file };
}

export function removeGitHook(repo = REPO) {
  const file = hookFile(repo);
  if (!fs.existsSync(file)) return { ok: true, action: 'already', file };
  const body = fs.readFileSync(file, 'utf8');
  if (!body.includes(MARK)) return { ok: true, action: 'foreign-untouched', file };
  if (body.includes(OWN)) { fs.rmSync(file, { force: true }); return { ok: true, action: 'removed', file }; }
  const kept = body.split('\n').filter((l) => !l.includes(MARK) && !l.includes(HERE)).join('\n');
  fs.writeFileSync(file, kept.replace(/\n{3,}/g, '\n\n'));
  return { ok: true, action: 'trimmed', file };
}

/** git 调到这里：pull/merge 已经落地，HEAD 是新的。同步执行，避免 detached 子进程被命令会话清理。 */
export function runPostMerge(tool = TOOL) {
  const r = spawnSync(process.execPath, [CLI, 'upgrade'], {
    cwd: tool, stdio: 'inherit', windowsHide: true, timeout: 180000,
  });
  return { ok: r.status === 0, status: r.status, error: r.error?.message ?? null };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).replace(/\\/g, '/') === HERE;
if (isMain) {
  const arg = process.argv[2];
  if (arg === '--install') {
    const r = installGitHook();
    console.log(`✓ git post-merge ${r.action}：${r.file}`);
  } else if (arg === '--check') {
    const s = hookState();
    console.log(`${s.installed ? '✓' : '✗'} git post-merge：${s.mode} · ${s.file}`);
    process.exitCode = s.installed ? 0 : 1;
  } else if (arg === '--remove') {
    const r = removeGitHook();
    console.log(`✓ git post-merge ${r.action}：${r.file}`);
  } else {
    const r = runPostMerge();
    if (!r.ok) console.error(`[convledger] 拉完自动升级没跑成（status ${r.status}${r.error ? ` · ${r.error}` : ''}），可手动跑 convledger upgrade`);
  }
}

#!/usr/bin/env node
// 把仓库里的 Skill 正本同步到各宿主的用户级 skills 目录。--check 只比对，不写。
// 正本入口写成 {{TOOL_ROOT}}：安装时按仓库实际位置渲染，换机器/搬仓都不用改正本。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_TOKEN = '{{TOOL_ROOT}}';
const src = path.join(here, 'convledger', 'SKILL.md');

export function renderSkill(text, root) {
  return String(text).split(ROOT_TOKEN).join(String(root).replace(/\\/g, '/'));
}

/** 这条路径上（含自身）最近的一层链接／Junction。单源真值布局常把整层目录挂给多家宿主，
 *  于是「宿主目录」看上去是普通目录，实际就是别人的真本——删除/写回都会穿透到真本。 */
export function linkOnPath(p) {
  let cur = path.resolve(p);
  const stop = path.parse(cur).root;
  while (cur && cur !== stop) {
    try { return { path: cur, target: fs.readlinkSync(cur) }; } catch { /* 这层不是链接 */ }
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return null;
}

export function skillTargets({ home = os.homedir(), env = process.env, clients = null } = {}) {  const all = [
    { client: 'qoder', dir: path.join(env.QODER_CONFIG_DIR || path.join(home, '.qoder'), 'skills', 'convledger') },
    { client: 'claude-code', dir: path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'skills', 'convledger') },
    { client: 'workbuddy', dir: path.join(env.WORKBUDDY_CONFIG_DIR || path.join(home, '.workbuddy'), 'skills', 'convledger') },
    { client: 'opencode', dir: path.join(env.OPENCODE_CONFIG_DIR || path.join(home, '.config', 'opencode'), 'skills', 'convledger') },
    // Codex 也认用户级 skills（~/.codex/skills/.system 就是它自己装的那批）；但它还不是账本来源。
    { client: 'codex', dir: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'skills', 'convledger') },
  ];
  if (!clients || clients === 'all') return all;
  const want = String(clients).split(',').map((s) => s.trim()).filter(Boolean);
  return all.filter((x) => want.includes(x.client));
}

export function main(argv = process.argv.slice(2)) {
  const check = argv.includes('--check');
  const ci = argv.indexOf('--client');
  const client = ci >= 0 ? argv[ci + 1] : 'all';
  // 卸载不需要正本：只按目录撤自己写过的那份，目录里还有别人的文件就留着。
  //
  // 两种链接形状都要认，认错的代价是删掉别人的真本（真机踩过两次）：
  //   1) 目录自己是链接／Junction —— 只解除链接，不许顺着它删里面的文件；
  //   2) 目录的**父级**是链接（例：~/.codex/skills -> ~/agent-hub/skills）——
  //      此时 dir 看上去是普通目录，其实是共享真本本身，删它等于删光所有宿主的正本。
  //      这种挂载单家卸载无从下手，只能如实拒绝，让人自己去动那一层链接。
  if (argv.includes('--remove')) {
    let skipped = 0;
    for (const { client: c, dir } of skillTargets({ clients: client })) {
      let self = null;
      try { self = fs.lstatSync(dir); } catch { /* 不存在 */ }
      let isSelfLink = false;
      try { fs.readlinkSync(dir); isSelfLink = true; } catch { /* 不是链接 */ }

      if (isSelfLink) {
        let target = '';
        try { target = fs.realpathSync(dir); } catch { target = '(目标已不存在)'; }
        try {
          fs.rmdirSync(dir);
          console.log(`✓ ${c} 已断开：解除链接 ${dir}（真本 ${target} 原样保留）`);
        } catch (e) {
          console.log(`✗ ${c} 链接解不开：${dir}（${e.code || e.message}）`);
          skipped++;
        }
        continue;
      }

      if (!self) { console.log(`· ${c} 没装过（${dir} 不存在）`); continue; }

      const via = linkOnPath(path.dirname(dir));
      if (via) {
        console.log(`· ${c} 不动：${via.path} 是链接（→ ${via.target}），这家的技能就是共享真本本身——删它等于删所有宿主的正本。要断这一家，去解除 ${via.path} 这层链接。`);
        skipped++;
        continue;
      }

      const dest = path.join(dir, 'SKILL.md');
      if (!fs.existsSync(dest)) { console.log(`· ${c} 没装过（${dest} 不存在）`); continue; }
      fs.rmSync(dest, { force: true });
      for (const d of [dir, path.dirname(dir)]) { try { fs.rmdirSync(d); } catch { /* 非空就留着 */ } }
      console.log(`✓ ${c} 已卸载：删掉 ${dest}`);
    }
    return skipped ? 0 : 0;   // 拒绝穿透不是安装器的失败，是这次卸载的边界；回执已写清
  }
  if (!fs.existsSync(src)) {
    console.error(`✗ 找不到正本 ${src}`);
    return 1;
  }
  const raw = fs.readFileSync(src, 'utf8');
  if (!raw.includes(ROOT_TOKEN)) {
    console.error(`✗ 正本里没有 ${ROOT_TOKEN} 占位——入口路径会写死到这台机器`);
    return 1;
  }
  const repoRoot = path.resolve(here, '..', '..');
  const want = renderSkill(raw, repoRoot);
  const bin = path.join(repoRoot, 'tool', 'bin', 'convledger.mjs').replace(/\\/g, '/');
  if (!want.includes(bin)) {
    console.error(`✗ 渲染后没有出现真实入口 ${bin}`);
    return 1;
  }
  const targets = skillTargets({ clients: client });
  if (!targets.length) {
    console.error(`✗ --client ${client} 没有对应的宿主（qoder / claude-code / workbuddy / opencode / codex / all）`);
    return 1;
  }
  if (check) {
    let bad = 0;
    for (const { client: c, dir } of targets) {
      const dest = path.join(dir, 'SKILL.md');
      const have = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
      if (have === want) console.log(`✓ ${c} 已同步：${dest}`);
      else { console.error(`✗ ${c} 未同步：${have === null ? '目标不存在' : '内容不一致'} → ${dest}`); bad++; }
    }
    if (bad) console.error('  跑 node tool/skill/install.mjs 同步');
    return bad ? 1 : 0;
  }
  for (const { client: c, dir } of targets) {
    const shared = linkOnPath(path.dirname(dir));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), want);
    // 写进共享真本时要说清楚：「已安装」在单源布局里等于「真本被更新，所有挂载它的宿主一起变」
    console.log(shared
      ? `✓ ${c} 已安装（写入共享真本 ${shared.target}）：${path.join(dir, 'SKILL.md')}`
      : `✓ ${c} 已安装：${path.join(dir, 'SKILL.md')}`);
  }
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = main();
}

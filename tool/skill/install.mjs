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

export function skillTargets({ home = os.homedir(), env = process.env, clients = null } = {}) {
  const all = [
    { client: 'qoder', dir: path.join(env.QODER_CONFIG_DIR || path.join(home, '.qoder'), 'skills', 'convledger') },
    { client: 'workbuddy', dir: path.join(env.WORKBUDDY_CONFIG_DIR || path.join(home, '.workbuddy'), 'skills', 'convledger') },
  ];
  if (!clients || clients === 'all') return all;
  const want = String(clients).split(',').map((s) => s.trim()).filter(Boolean);
  return all.filter((x) => want.includes(x.client));
}

export function main(argv = process.argv.slice(2)) {
  const check = argv.includes('--check');
  const ci = argv.indexOf('--client');
  const client = ci >= 0 ? argv[ci + 1] : 'all';
  // 卸载不需要正本：只按目录撤自己写过的那份，目录里还有别人的文件就留着
  if (argv.includes('--remove')) {
    for (const { client: c, dir } of skillTargets({ clients: client })) {
      const dest = path.join(dir, 'SKILL.md');
      if (!fs.existsSync(dest)) { console.log(`· ${c} 没装过（${dest} 不存在）`); continue; }
      fs.rmSync(dest, { force: true });
      for (const d of [dir, path.dirname(dir)]) { try { fs.rmdirSync(d); } catch { /* 非空就留着 */ } }
      console.log(`✓ ${c} 已卸载：删掉 ${dest}`);
    }
    return 0;
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
    console.error(`✗ --client ${client} 没有对应的宿主（qoder / workbuddy / all）`);
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
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), want);
    console.log(`✓ ${c} 已安装：${path.join(dir, 'SKILL.md')}`);
  }
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = main();
}

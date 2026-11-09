// 提交前密钥扫描：优先用 gitleaks（本机 D:/tools/gitleaks/gitleaks.exe 或 PATH / GITLEAKS_BIN），
// 扫两遍——git 历史与暂存区；被 .gitignore 挡住的派生目录（tool/out 等）永远不会被提交，
// 也不去扫（目录扫描会把 2.4GB 的账本归档一起读，几千条 key 字段全是误报）。没有 gitleaks 就如实说没有，不假装扫过。
// 用法：node tool/scan-secrets.mjs [--staged]
//   --staged  只扫暂存区（gitleaks protect --staged 的等价用法），适合提交前
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');

function findGitleaks() {
  if (process.env.GITLEAKS_BIN && fs.existsSync(process.env.GITLEAKS_BIN)) return process.env.GITLEAKS_BIN;
  const local = process.platform === 'win32' ? 'D:/tools/gitleaks/gitleaks.exe' : '/usr/local/bin/gitleaks';
  if (fs.existsSync(local)) return local;
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const where = spawnSync(finder, ['gitleaks'], { encoding: 'utf8', shell: false });
  if (where.status === 0) return String(where.stdout).split(/\r?\n/).map((x) => x.trim()).find(Boolean) ?? null;
  return null;
}

const bin = findGitleaks();
if (!bin) {
  console.error(process.platform === 'win32'
    ? '没有 gitleaks。装一个：gh release download v8.30.1 --repo gitleaks/gitleaks --pattern "gitleaks_8.30.1_windows_x64.zip"，解到 D:/tools/gitleaks/；或设 GITLEAKS_BIN。'
    : '没有 gitleaks。装一个：从 https://github.com/gitleaks/gitleaks/releases 下对应平台包，放到 PATH（或设 GITLEAKS_BIN）。');
  process.exit(2);
}

const staged = process.argv.includes('--staged');
const runs = staged
  ? [['protect', '--staged', '--redact', '-v', '--max-target-megabytes', '2']]
  : [['git', '--redact', '-v', '--max-target-megabytes', '2'], ['protect', '--staged', '--redact', '-v', '--max-target-megabytes', '2']];

let bad = 0;
for (const args of runs) {
  const r = spawnSync(bin, args, { cwd: ROOT, encoding: 'utf8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (out) console.log(out);
  if (r.status && r.status !== 0) bad = r.status;
}
console.log(bad ? '✗ 发现疑似密钥：按上面的文件与行号处理；已泄露的先去平台重置，再谈历史清理。' : '✓ 没有发现（gitleaks：历史与暂存区；文档示例已列入 .gitleaksignore）');
process.exit(bad ? 1 : 0);
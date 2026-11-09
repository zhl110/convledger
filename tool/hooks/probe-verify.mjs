#!/usr/bin/env node
// L0.3 探针的无副作用校验命令：只追加一行证据，证明 hook 之后确实发生了一次真实工具调用。
import fs from 'node:fs';
import path from 'node:path';

const TOOL = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1').replace(/\\/g, '/')));
const DIR = `${TOOL}/out/probe`;
fs.mkdirSync(DIR, { recursive: true });
fs.appendFileSync(`${DIR}/verify.log`, `${new Date().toISOString()} pid=${process.pid} argv=${process.argv.slice(2).join(' ')}\n`);
console.log('PROBE VERIFY OK');

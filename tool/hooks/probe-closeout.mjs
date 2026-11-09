#!/usr/bin/env node
// L0.3 临时探针：Stop hook 能不能让当前 agent 继续、并在没有用户新消息时真的调一次工具。
// 只在 out/probe/enabled 存在时阻断，且每个会话最多阻断一次——会自己循环的探针比没有探针更糟。
// 证据只写文件；stdout 只留 JSON，宿主按协议解析。
import fs from 'node:fs';
import path from 'node:path';

const TOOL = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1').replace(/\\/g, '/')));
const DIR = `${TOOL}/out/probe`;
fs.mkdirSync(DIR, { recursive: true });

let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch { raw = ''; }
let payload = {};
try { payload = JSON.parse(raw || '{}'); } catch { payload = { unparseable: raw.slice(0, 800) }; }

const sid = String(payload.session_id ?? payload.sessionId ?? 'unknown');
fs.appendFileSync(`${DIR}/stop.log`, JSON.stringify({
  at: new Date().toISOString(),
  sid,
  keys: Object.keys(payload),
  payload,
}) + '\n');

const marker = `${DIR}/blocked-${sid.replace(/[^\w.-]/g, '_')}`;
if (!fs.existsSync(`${DIR}/enabled`) || fs.existsSync(marker)) {
  process.stdout.write('{}\n');
  process.exit(0);
}
fs.writeFileSync(marker, new Date().toISOString());

const verify = `${TOOL}/hooks/probe-verify.mjs`;
process.stdout.write(JSON.stringify({
  decision: 'block',
  reason: `convledger L0.3 收尾探针：请立即执行命令 node "${verify}"（无副作用，只往 out/probe/verify.log 追加一行），然后只回复 PROBE DONE。不要做别的事，不要问我问题。`,
}) + '\n');

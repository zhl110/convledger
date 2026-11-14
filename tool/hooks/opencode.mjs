#!/usr/bin/env node
// OpenCode 的 hook 入口：OpenCode 用插件（~/.config/opencode/plugins/*.js，V2 形状）而不是 settings.json，
// 所以逻辑放在这个 CLI 里、插件只做转发：
//   ctx.session.hook('compaction') → brief（压缩后第一跳）
//   session.idle 事件 → closeout（判定有无新素材；有就派一个后台会话去写账）
// 与 Qoder 的 ledger-brief.mjs 同一套判据：工具只读；拿不到账本就一个字都不注。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexWindowed } from '../src/window.mjs';
import { writeStore, freezeSource, loadLedger } from '../src/store.mjs';
import { readState, projectBriefLine } from '../src/state-io.mjs';
import { projectKey } from '../src/current.mjs';
import { readView } from '../src/view.mjs';
import { briefText, briefScenes, briefContext } from '../src/brief.mjs';
import { collabBrief } from '../src/memories.mjs';
import { readRequests } from '../src/notes.mjs';
import { outstandingFor } from '../src/outstanding.mjs';
import { isInternal } from '../src/internal.mjs';
import { syncOpencodeSession, OPENCODE_ROOT } from '../src/opencode.mjs';
import { materialUnits } from '../src/sync.mjs';

const TOOL_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STORE = (process.env.CONVLEDGER_HOOK_STORE || path.join(TOOL_ROOT, 'out/store')).replace(/\\/g, '/');
const OPENCODE_OUT = (process.env.CONVLEDGER_OPENCODE_OUT || OPENCODE_ROOT).replace(/\\/g, '/');
const CLI = `${TOOL_ROOT.replace(/\\/g, '/')}/bin/convledger.mjs`;

const log = (row) => {
  try {
    const file = (process.env.CONVLEDGER_HOOK_LOG || path.join(TOOL_ROOT, 'out/hook-probe.jsonl'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), origin: 'opencode', ...row }) + '\n');
  } catch { /* 留痕失败不拖垮会话 */ }
};

/** session 前缀 → 全 id（只看已投影的目录；没有就当场同步一次）。 */
function resolveId(prefix) {
  const p = String(prefix || '').toLowerCase();
  const dirs = fs.existsSync(OPENCODE_OUT) ? fs.readdirSync(OPENCODE_OUT).filter((d) => d.startsWith('ses_')) : [];
  const hit = dirs.find((d) => d.toLowerCase().startsWith(p));
  if (hit) return hit;
  // 目录还没投影（新会话）：先全量同步一次再找
  try { syncOpencodeSession(String(prefix)); } catch { /* 由下面统一报 */ }
  const again = fs.existsSync(OPENCODE_OUT) ? fs.readdirSync(OPENCODE_OUT).filter((d) => d.startsWith('ses_')) : [];
  return again.find((d) => d.toLowerCase().startsWith(p)) ?? null;
}

function sourceFileFor(sid) {
  try { syncOpencodeSession(sid); } catch { /* 源打不开时交给 freeze/load 报 */ }
  const file = path.join(OPENCODE_OUT, sid, `${sid}.jsonl`);
  return fs.existsSync(file) ? file.replace(/\\/g, '/') : null;
}

function ensureLedger(sid, file) {
  const dir = path.join(STORE, sid);
  if (fs.existsSync(path.join(dir, 'ledger.json'))) return dir;
  indexWindowed(file, { storeRoot: STORE });
  return dir;
}

/** 压缩后第一跳：brief + 项目任务行；去重按事件+会话（同 Qoder 的三键分层）。 */
export function briefForOpencode({ sid: prefix } = {}) {
  const sid = resolveId(prefix);
  if (!sid) return { skip: 'no-session' };
  const file = sourceFileFor(sid);
  if (!file) return { skip: 'no-projection' };
  let dir;
  try { dir = ensureLedger(sid, file); } catch (e) { return { skip: `build-failed:${String(e?.message ?? e).split('\n')[0]}` }; }
  const v = readView(dir);
  if (!v?.meta) return { skip: 'empty-view' };
  const requestRows = readRequests(dir).rows;
  const collab = (() => {
    try { return collabBrief(STORE, projectKey(v.meta.cwd), { scenes: briefScenes(v, requestRows), context: briefContext(v, requestRows) }); }
    catch { return []; }
  })();
  const base = briefText(v, requestRows, collab);
  const pl = projectBriefLine(STORE, v.meta.cwd);
  const text = pl ? `${base}\n${pl}` : base;
  const mark = path.join(dir, 'hook.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(mark, 'utf8')); } catch { /* 首次 */ }
  const hash = `opencode:brief:${sid}:${v.meta.builtAt}`;
  if (state.briefHash === hash) return { skip: 'same-brief' };
  state.briefHash = hash;
  fs.writeFileSync(mark, JSON.stringify(state, null, 1));
  log({ event: 'opencode.brief', session: sid, action: 'inject', chars: text.length });
  return { text, sid };
}

/** 收尾检查：只核对「有没有未分析素材 + 本轮有真人消息」，不写综述、不替 agent 下结论。
 *  返回的 text 是给**后台会话**的指令（带 [convledger-internal] 哨兵），由插件开新会话发送。 */
export function closeoutForOpencode({ sid: prefix } = {}) {
  const sid = resolveId(prefix);
  if (!sid) return { skip: 'no-session' };
  // 后台会话自我排除：登记表命中、或投影第一屏就带哨兵的，一律不派，避免无限增殖。
  if (isInternal(STORE, sid)) return { skip: 'internal-session' };
  const file = sourceFileFor(sid);
  if (!file) return { skip: 'no-projection' };
  try {
    const head = fs.readFileSync(file).subarray(0, 8192).toString('utf8');
    if (head.includes('convledger-internal')) return { skip: 'internal-session' };
  } catch { /* 读不到头部就按正常会话继续，下面的 freeze 会兜错 */ }
  let ledger;
  try {
    // 收尾时账本可能还没建（新会话/子代理会话）：先建再读，否则永远 no-ledger。
    ensureLedger(sid, file);
    ledger = loadLedger(STORE, sid).ledger;
  } catch (e) { return { skip: `build-failed:${String(e?.message ?? e).split('\n')[0]}` }; }
  if (!ledger.cwd) return { skip: 'no-cwd' };
  const key = projectKey(ledger.cwd);
  let state;
  try { state = readState(STORE, key).state; } catch { return { skip: 'state-unreadable' }; }
  const from = state.checkpoints?.[sid]?.analyzedThrough ?? 0;
  const frozen = freezeSource({ sourceFile: file, runner: ledger.runner }, { fromByte: from });
  if (!frozen.file || frozen.toByte <= from) return { skip: 'no-new-material' };
  const raw = fs.readFileSync(file).subarray(frozen.fromByte, frozen.toByte).toString('utf8');
  let human = null, humanTurns = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); if (o.type === 'user' && o.humanInput) { human = o.uuid ?? 'unnamed'; humanTurns++; } } catch { /* 坏行交给 prepare */ }
  }
  if (!human) return { skip: 'no-human-message' };
  const markFile = path.join(STORE, sid, 'closeout-prompt.json');
  let mark = null;
  try { mark = JSON.parse(fs.readFileSync(markFile, 'utf8')); } catch { mark = null; }
  if (mark && mark.human === human && mark.byte >= frozen.toByte) return { skip: 'already-prompted' };
  const remaining = (frozen.records ?? []).length;
  let unitCount = 0;
  try { unitCount = materialUnits(frozen, { runner: ledger.runner, budget: Number.MAX_SAFE_INTEGER }).units.length; } catch { /* 统计失败不挡派发 */ }
  let extra = '';
  try {
    const o = outstandingFor({ storeRoot: STORE, sessionId: sid, cwd: ledger.cwd });
    if (o.items.length) extra = `\n链路欠项：${o.items.slice(0, 4).join('；')}${o.items.length > 4 ? '…' : ''}。能补就补；补不动就在回执里如实留。`;
  } catch { /* 自检失败不影响收尾提示 */ }
  const build = !state.tasks?.length
    ? `项目还没有任务表，先用 localKey 建首批任务再更新。`
    : '';
  const text = `[convledger-internal] 这是 convledger 的后台收尾会话，不要向用户复述聊天。`
    + `本会话（${sid.slice(0, 8)}）自上次收尾后有 ${humanTurns} 条真人消息、过滤后 ${unitCount} 个有效素材单元（原始 ${remaining} 行；工具回执、读/搜/运行类调用与控制/附件记录已排除）。`
    + `按顺序做：1) node "${CLI}" sync --prepare --project ${key} --session ${sid.slice(0, 8)}；`
    + `2) 按素材写 {batchId, baseRevision, taskChanges[], events[], candidates[], dispositions[]}，再 node "${CLI}" sync --put -；`
    + `${build}没有项目变化就逐条标 no-change，不要编造进度。`
    + extra;
  fs.writeFileSync(markFile, JSON.stringify({ at: new Date().toISOString(), byte: frozen.toByte, human }, null, 1));
  log({ event: 'opencode.closeout', session: sid, action: 'dispatch', remaining });
  return { text, sid, remaining };
}

function main() {
  const args = process.argv.slice(2);
  const mode = args[0];
  const i = args.indexOf('--session');
  const sid = i > -1 ? args[i + 1] : null;
  if (!mode || !sid) {
    process.stderr.write('用法: node hooks/opencode.mjs brief|closeout --session <ses_…>\n');
    process.exit(1);
  }
  const out = mode === 'brief' ? briefForOpencode({ sid }) : closeoutForOpencode({ sid });
  if (out.skip) { log({ action: 'skip', reason: out.skip, mode, session: sid }); return; }
  process.stdout.write(out.text + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();

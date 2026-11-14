#!/usr/bin/env node
// convledger 的 hook handler：把「压缩后第一跳」从拉取改成推送。
// 配置挂在用户级 settings.json，所以它管**所有项目的会话**：每段会话按自己的 transcript 建账、
// 注入自己的 brief，不按 cwd 划界。一个脚本管所有会话事件，按 hook_event_name 分派；契约见 tool/PRD-hook.md。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { normalizeRecords, sourceRoots } from '../src/project.mjs';
import { indexWindowed } from '../src/window.mjs';
import { freezeSource } from '../src/store.mjs';
import { readState, projectBriefLine } from '../src/state-io.mjs';
import { projectKey } from '../src/current.mjs';
import { readView } from '../src/view.mjs';
import { briefText, briefScenes, briefContext } from '../src/brief.mjs';
import { readRequests } from '../src/notes.mjs';
import { outstandingFor } from '../src/outstanding.mjs';
import { LIVE_MIN } from '../src/library.mjs';
import { resolvePrefs } from '../src/prefs.mjs';
import { readLlm, llmOn } from '../src/llm.mjs';
import { tryLock, unlock } from '../src/closeout-auto.mjs';
import { pickSummaryBatch } from '../src/summary-batch.mjs';
import { profileDue, markProfilePrompt } from '../src/profile-auto.mjs';
import { isInternal } from '../src/internal.mjs';
import { collabBrief } from '../src/memories.mjs';
import { loadCaps, dispatchFor } from '../src/host-caps.mjs';
import { upgradeNotice } from '../src/upgrade.mjs';
import { blocksOf, tok, toolOpOf } from '../src/lib.mjs';
import { materialUnits } from '../src/sync.mjs';

const TOOL_ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1').replace(/\\/g, '/')));
const STORE = (process.env.CONVLEDGER_HOOK_STORE || path.join(TOOL_ROOT, 'out/store')).replace(/\\/g, '/');
const LOG = (process.env.CONVLEDGER_HOOK_LOG || path.join(TOOL_ROOT, 'out/hook-probe.jsonl')).replace(/\\/g, '/');
const PROBE_MARK = path.join(TOOL_ROOT, 'out/hooks/PROBE').replace(/\\/g, '/');
const INJECT_MAX = 2000;   // 注入预算：brief 自身保证 ≤1,800，这里再兜一层硬顶
const EVENTS = new Set(['SessionStart', 'PreCompact', 'PostCompact', 'PostToolUse', 'Stop']);
// 溯源：只有 install.mjs 注册的那行命令行带 --origin host。手工喂同一份 stdin 是 manual，
// 宿主真发过的事件才配写进「实测通」——判定行不许被离线自跑满足。
const ORIGIN = (() => {
  const i = process.argv.indexOf('--origin');
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : 'manual';
})();

// stdout 是给宿主解析的 JSON，任何诊断只能走 stderr。
const note = (msg) => process.stderr.write(`[convledger-hook] ${msg}\n`);
function log(row) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), origin: ORIGIN, ...row }) + '\n');
  } catch { /* 留痕失败不能拖垮会话事件 */ }
}

const readStdin = () => new Promise((res) => {
  let buf = '';
  process.stdin.on('data', (d) => { buf += d; });
  process.stdin.on('end', () => res(buf));
  process.stdin.on('error', () => res(''));
});

const contentHash = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `${s.length}:${h}`;
};

/** 留痕与匹配都用同一种 cwd 形状：Windows 反斜杠、大小写、尾斜杠。 */
const lower = (p) => String(p || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();

/** 会话根只认 ADAPTERS 那一份清单（Qoder / Claude Code / WorkBuddy + OpenCode、Codex 投影），
 *  不再自己列两个：真机上 Claude Code 的 transcript_path 曾被判「根目录外」→ no-source，
 *  Stop 只能跳过、SessionStart 只能借别人的账本。老 Qoder 的 chat-sessions/ 额外留着。 */
function scanRoots() {
  const roots = sourceRoots();
  const qoderRoot = roots.find((r) => r.endsWith('/.qoder/projects'));
  const legacy = qoderRoot ? [qoderRoot.replace(/\/projects$/, '/chat-sessions')] : [];
  return [...new Set([...roots, ...legacy])];
}

/** payload 的 transcript_path 是最可靠的定位（宿主自己说的它把这段写在哪），
 *  但只有它确实指向一个已知根目录下的 jsonl 才信——否则一个坏字段就能让我们去读任意路径。 */
function fromTranscript(p) {
  if (!p) return null;
  const f = String(p).replace(/\\/g, '/');
  if (!f.endsWith('.jsonl')) return null;
  const root = scanRoots().find((r) => lower(f).startsWith(lower(r) + '/'));
  return root && fs.existsSync(f) ? f : null;
}

function findSource(sid, transcriptPath) {
  const direct = fromTranscript(transcriptPath);
  if (direct) return direct;
  for (const dir of scanRoots()) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const e of entries) {
      const f = `${dir}/${e}/${sid}.jsonl`;
      if (fs.existsSync(f)) return f;
      try {
        if (fs.readdirSync(`${dir}/${e}`).includes(`${sid}.jsonl`)) return f;
      } catch { /* 不是目录 */ }
    }
  }
  return null;
}

/** 本项目（同 cwd）里最活跃的那段会话的账本。
 *  只用于"这段会话自己还没有 transcript/账本"的借读兜底；那是**别人**的账本，
 *  所以返回里带着 owner，注入首行必须写明不是你当前会话。
 *  没有 cwd 就没有「本项目」可言，宁可闭嘴也不借错账。 */
function latestLedgerFor(cwdPath) {
  if (!cwdPath) return null;
  let names = [];
  try { names = fs.readdirSync(STORE); } catch { return null; }
  let best = null;
  for (const name of names) {
    let led;
    try { led = JSON.parse(fs.readFileSync(`${STORE}/${name}/ledger.json`, 'utf8')); } catch { continue; }
    if (lower(led.cwd) !== cwdPath) continue;
    let at = 0;
    try { at = fs.statSync(led.sourceFile).mtimeMs; } catch { at = Date.parse(led.builtAt) || 0; }
    if (!best || at > best.at) best = { dir: `${STORE}/${name}`, owner: led.sessionId, at };
  }
  return best;
}

/** 账本落盘那一刻之后源又长了 → 重建。PreCompact 无条件重建。
 *  建账一律走 window.mjs：刚接入的长历史只建尾部一片，更早的按轮补（RULES §13）。 */
function ensureFresh(sid, force, transcriptPath, { grow = false } = {}) {
  const dir = `${STORE}/${sid}`;
  const ledgerFile = `${dir}/ledger.json`;
  const src = findSource(sid, transcriptPath);
  if (!src) return { ok: fs.existsSync(ledgerFile), dir, rebuilt: false, why: '找不到源 jsonl' };
  const stale = force || !fs.existsSync(ledgerFile) || fs.statSync(src).mtimeMs > fs.statSync(ledgerFile).mtimeMs;
  if (!stale) return { ok: true, dir, rebuilt: false };
  const r = indexWindowed(src, { storeRoot: STORE, grow });
  return { ok: fs.existsSync(ledgerFile), dir, rebuilt: true, segs: r.segs, action: r.action };
}

function briefFor(sid, event, cwdPath, freshContext, transcriptPath) {
  let st = ensureFresh(sid, false, transcriptPath);
  let owner = sid, foreign = false;
  if (!st.ok) {
    // 新会话在这个项目里还没有自己的账本：退回本项目最活跃那段会话的账本，而不是闭嘴。
    const alt = latestLedgerFor(cwdPath);
    if (!alt) return { skip: `账本不可用（${st.why || st.dir}；本项目也没有任何会话建过账本）` };
    st = { ok: true, dir: alt.dir, rebuilt: false };
    owner = alt.owner; foreign = true;
  }
  const v = readView(st.dir);
  if (!v?.meta) return { skip: '视图为空' };
  // 协作画像：记忆表里跟「和这个人干活」直接相关的几条，随 brief 一起注进去。
  // 只读两个 JSON 文件；读不动就当没有，绝不让它拖垮注入。
  const requestRows = readRequests(st.dir).rows;
  const collab = (() => {
    try { return collabBrief(STORE, projectKey(v.meta.cwd), { scenes: briefScenes(v, requestRows), context: briefContext(v, requestRows) }); }
    catch { return []; }
  })();
  // 项目层指针：同一预算内只给版本、计数与最近欠项；没有任务状态的项目不加。
  // 先把它的预算留出来，否则 brief 把 1800 用满、项目行被 hook 硬顶从尾部裁掉。
  const pl = projectBriefLine(STORE, v.meta.cwd);
  // 代码拉新了但常驻 hub 还跑着旧版时，第一跳就提醒先升级（纯文件判断，不联网）。
  // 同样要从 brief 预算里留位置：它是本轮最该先执行的一条，不能被压掉。
  const up = upgradeNotice(TOOL_ROOT);
  const reserve = (pl ? tok(pl) + 2 : 0) + (up ? tok(up) + 2 : 0);
  const base = briefText(v, requestRows, collab, { reserve });
  const text = [up, base, pl].filter(Boolean).join('\n');
  const stateFile = `${st.dir}/hook.json`;
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* 首次 */ }
  // 去重按「来源 + 事件 + 这段会话」三键分层，两个事故各教会一条：
  // ① 09:43 宿主真发 PostCompact，被我 09:27 手工自跑写的同一个 lastHash 挡成"同文去重"
  //    ——所以 manual 绝不能消音 host；
  // ② 10:07 压缩时宿主连发 PostCompact 与 SessionStart(source=compact)，SessionStart 因
  //    "与上次注入同文"被挡——而这两个事件哪个的 additionalContext 真进上下文并不确定，
  //    于是自己把唯一可能生效的那一次静音了。事件必须各占一个去重槽。
  // ③ 10-28 00:20:54 fork 手动压缩：PostCompact 注了但宿主不投递它，SessionStart 又被
  //    压缩前那次会话启动的 lastHash 判成"同文"——旧上下文连同那次注入已经被压缩掉了，
  //    同文去重跨上下文生效，等于把压缩后唯一活路掐死。压缩边界必须放行。
  const key = `${ORIGIN} ${event} ${sid}`;
  const prev = state.byKey?.[key] || {};
  const hash = contentHash(text);
  // 状态只写这一种形状：旧版按来源分层的 byOrigin 不再被读，也不再原样带下去（留着就是第二个真相）
  const write = (patch) => fs.writeFileSync(stateFile, JSON.stringify({
    at: new Date().toISOString(), byKey: { ...state.byKey, [key]: { ...prev, ...patch } },
  }, null, 1));
  if (!freshContext && prev.lastHash === hash) {
    write({ lastHash: hash, skipped: (prev.skipped || 0) + 1 });
    return { skip: '与上次注入同文，去重' };
  }
  let body = text, truncated = false;
  if (tok(body) > INJECT_MAX) {
    const lines = body.split('\n');
    while (lines.length > 2 && tok(lines.join('\n')) > INJECT_MAX - 120) lines.pop();
    lines.push('（注入预算用完，已截断；全量：convledger steps / brief --phase n）');
    body = lines.join('\n');
    truncated = true;
  }
  const at = new Date().toISOString();
  // skipped 是"抑制了多少次重复注入"的审计量，重写状态时不能把它抹掉
  write({ lastHash: hash, injectedAt: at, count: (prev.count || 0) + 1, skipped: prev.skipped || 0, truncated });
  return { body, tokens: tok(body), truncated, dir: st.dir, at, owner, foreign };
}

function emit(event, text) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
}

/** 这个会话来自哪家宿主：决定「派活」那句话怎么写。
 *  写死一家的工具名，别家读到就是空指令——WorkBuddy 上那条 create_chat_session 就属于这种，
 *  agent 只能退而开同步子代理，把当前对话占住。 */
let CAPS_CACHE = null;
const caps = () => { if (!CAPS_CACHE) CAPS_CACHE = loadCaps(STORE).caps; return CAPS_CACHE; };

function runnerOf(sid) {
  try { return JSON.parse(fs.readFileSync(path.join(STORE, sid, 'ledger.json'), 'utf8')).runner || null; } catch { return null; }
}

/** 收尾检查：只核对「有没有未分析的素材」并给一条命令，不写综述、不替 agent 下结论。
 *  每个用户回合最多提示一次（按冻结字节 + 最后一条人类消息记在账本目录的标记文件里），
 *  agent 自己续写的那一轮没有新的人类消息，不会再触发。 */
function closeoutFor(sid, transcriptPath, cwd) {
  const src = findSource(sid, transcriptPath) ?? findSource(sid, null, cwd);
  if (!src) return { skip: 'no-source' };
  // 自我排除（防无限派生）：本工具派的后台工作会话（登记表 + 源头哨兵两道）一律不收尾，否则无限派生。
  if (isInternal(STORE, sid)) return { skip: 'internal-session' };
  // 自我排除（防无限派生）：convledger 自己派的「后台收尾会话」prompt 头里带哨兵 convledger-internal。
  // 这类会话本身也是被收录的对话，若再触发收尾就会「总结工具总结它的总结器」无限生下去。见到哨兵一律不收尾。
  try {
    const fd = fs.openSync(src, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    fs.closeSync(fd);
    if (buf.subarray(0, n).toString('utf8').includes('convledger-internal')) return { skip: 'internal-session' };
  } catch { /* 读不了源头就按普通会话处理 */ }
  let ledger = null;
  try { ledger = JSON.parse(fs.readFileSync(path.join(STORE, sid, 'ledger.json'), 'utf8')); } catch { return { skip: 'no-ledger' }; }
  if (!ledger.cwd) return { skip: 'no-cwd' };
  // 收尾档位独立于综述档位：用户把某家设成 compact 时这里才在 Stop 跳过；
  // 每轮/每 5 轮放行，every5 数的是真人回合，不是缺综述的块。
  const prefs = resolvePrefs(STORE, { runner: ledger.runner, sessionId: sid });
  if (prefs.closeoutCadence === 'compact') return { skip: 'closeout-cadence-compact' };
  const key = projectKey(ledger.cwd);
  let state;
  try { state = readState(STORE, key).state; } catch { return { skip: 'state-unreadable' }; }
  // 还没有任务表不是「不做收尾」：首次收尾要把任务表从素材里建起来，
  // 否则项目页永远空着——以前这里直接 skip('no-tasks')，正是那个死循环。
  const bootstrap = !state.tasks?.length;
  const cp = state.checkpoints?.[sid] ?? null;
  const from = cp?.analyzedThrough ?? 0;
  const frozen = freezeSource({ sourceFile: src, runner: ledger.runner }, { fromByte: from });
  if (!frozen.file || frozen.toByte <= from) return { skip: 'no-new-material' };
  const raw = fs.readFileSync(src).subarray(frozen.fromByte, frozen.toByte).toString('utf8');
  let human = null;
  let humanTurns = 0, toolCalls = 0, materialCalls = 0, toolResults = 0, controlRecords = 0;
  try {
    const recs = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { recs.push(JSON.parse(line)); } catch { /* 坏行交给 prepare 报告 */ }
    }
    // 人类消息按规范化后的形状认：各宿主原始行不同（WorkBuddy 是 message/role，
    // Qoder 才是 type=user + humanInput），只看后者的形状会把别的宿主全判成「本轮没人说话」。
    for (const r of normalizeRecords(ledger.runner, recs)) {
      const bs = blocksOf(r);
      for (const b of bs) {
        if (b?.type !== 'tool_use') continue;
        toolCalls++;
        if (['write', 'edit'].includes(toolOpOf(b.name))) materialCalls++;
      }
      toolResults += bs.filter((b) => b?.type === 'tool_result').length;
      if (!['user', 'assistant'].includes(r.type)) controlRecords++;
      if (r.type === 'user' && (r.humanInput || r.origin?.kind === 'human')) {
        human = r.uuid ?? 'unnamed';
        humanTurns++;
      }
    }
  } catch { /* 规范化失败就当作本轮没有人说话，下一轮再试 */ }
  if (!human) return { skip: 'no-new-human-turn' };
  if (prefs.closeoutCadence === 'every5' && humanTurns < 5) return { skip: `closeout-every5-wait(${humanTurns}/5)` };
  const markFile = path.join(STORE, sid, 'closeout-prompt.json');
  let mark = null;
  try { mark = JSON.parse(fs.readFileSync(markFile, 'utf8')); } catch { mark = null; }
  // 派发后一段时间内保持安静：后台会话在跑，材料会随本轮答复继续增长——不能每轮都发一次信号（否则又变成每轮占对话）。
  if (mark && mark.at && (Date.now() - Date.parse(mark.at)) < 10 * 60 * 1000) return { skip: 'recently-dispatched' };
  if (mark && mark.human === human && mark.byte >= frozen.toByte) return { skip: 'already-prompted' };
  const remaining = (frozen.records ?? []).length;
  let unitCount = 0;
  try {
    unitCount = materialUnits(frozen, { runner: ledger.runner, budget: Number.MAX_SAFE_INTEGER }).units.length;
  } catch { /* 统计失败不挡收尾；仍用原始行数如实说明 */ }
  const otherCalls = Math.max(0, toolCalls - materialCalls);
  const contextLine = `本会话自上次收尾后有 ${humanTurns} 条真人消息、${materialCalls} 次写/改动作（进素材）、${otherCalls} 次读/搜/运行类调用（不进素材）、${toolResults} 条工具回执（不进补账素材）、${controlRecords} 条控制/附件记录（不进补账素材）；过滤后 ${unitCount} 个有效素材单元（原始 ${remaining} 行，字节 ${frozen.fromByte}..${frozen.toByte}）。`;
  // 2026-11-14 用户口径：接了模型后端就全面接管——收尾/补账/阶段/记忆/画像都不再派 Agent。
  // 这里只留一个“交给后台模型”的意图；真正起循环由 Stop 末尾的 maybeAutoSpawn 统一做（带锁与 10 分钟静默）。
  try {
    const lc = readLlm(STORE);
    if (lc.configured && lc.enabled !== false) {
      fs.writeFileSync(markFile, JSON.stringify({ at: new Date().toISOString(), byte: frozen.toByte, human, auto: true }, null, 1));
      return { skip: 'llm-backend', remaining, units: unitCount };
    }
  } catch { /* 配置读不了按没接处理，走 Agent 老路 */ }
  let extra = '';
  if (bootstrap) {
    extra = '\n后台会话里建首批任务：taskChanges 用 localKey 新建，里程碑与验收按素材写，不要补不存在的进度。';
  } else {
    try {
      const o = outstandingFor({ storeRoot: STORE, sessionId: sid, cwd: ledger.cwd });
      if (o.items.length) extra = `\n链路欠项：${o.items.slice(0, 6).join('；')}${o.items.length > 6 ? '…' : ''}（在后台会话里补；补不动如实留，不要编）。`;
    } catch { /* 自检失败不影响收尾提示 */ }
  }
  // 派发信号：只把活交给「后台工作会话」一段并复用，不每次新开；当前对话只花一句话派发，不在这里逐批磨。
  const dispatch = dispatchFor(ledger.runner, caps());
  const manual = `无法另起会话就手动兜底：convledger sync --prepare --project ${key} --session ${sid.slice(0, 8)}，逐条处置后再 --put。`;
  const text = bootstrap
    ? `[convledger · 后台收尾] 这个项目还没有任务表：${contextLine}`
      + dispatch + `后台会话里先 convledger sync --prepare --project ${key} --session ${sid.slice(0, 8)} 再 sync --put。`
      + manual + extra
    : `[convledger · 后台收尾] ${contextLine}`
      + dispatch + '后台会话里逐批 sync --prepare→--put（缺综述 digest/summarise，画像按需 memory），全部过闸门、不编，没有变化就逐条标 no-change。'
      + manual + extra;
  fs.writeFileSync(markFile, JSON.stringify({ at: new Date().toISOString(), byte: frozen.toByte, human }, null, 1));
  return { reason: text, remaining, units: unitCount };
}

/** 补账：已收口却缺综述的块，按画布上选的档位决定这一轮拦不拦。
 *  档位是机器级设置（out/prefs.json），写进提示、不写进账本；综述仍由 agent 写、工具验。
 *  同一批块只问一次（summarise-prompt.json 记块号）：agent 不补或补不动时不循环催。 */
function summariseFor(sid, transcriptPath, cwdIn) {
  // 优先级（2026-11-13 用户口径）：接了模型后端 → 后台 closeout --auto 静默补，当前 Agent 不动手；
  // 没接 → 沿用老路，由当前 Agent 按 hook 的提示补。
  // 补账总闸（2026-11-13 用户口径）：开关关 = LLM 与当前 Agent 都不再补综述，欠项留着不派
  //（画布回落原话截断，原文永远在）；开关开 + 接了 key = 后台模型补；开关开 + 没接 = Agent 老路。
  try {
    const lc = readLlm(STORE);
    if (lc.enabled === false) return { skip: 'auto-off' };
    if (lc.configured) return { skip: 'llm-backend' };
  } catch { /* 配置读不了按没接处理，走 Agent 老路 */ }
  let ledger = null;
  try { ledger = JSON.parse(fs.readFileSync(path.join(STORE, sid, 'ledger.json'), 'utf8')); } catch { return { skip: 'no-ledger' }; }
  const prefs = resolvePrefs(STORE, { runner: ledger.runner, sessionId: sid });
  if (prefs.summaryCadence === 'compact') return { skip: 'cadence-compact' };
  let o;
  try { o = outstandingFor({ storeRoot: STORE, sessionId: sid, cwd: ledger.cwd ?? cwdIn ?? null }); }
  catch { return { skip: 'outstanding-failed' }; }
  const missing = o.missingBlocks ?? [];
  if (!missing.length) return { skip: 'no-summary-debt' };
  if (prefs.summaryCadence === 'every5' && missing.length < 5) return { skip: `every5-wait(${missing.length}/5)` };
  const markFile = path.join(STORE, sid, 'summarise-prompt.json');
  let mark = null;
  try { mark = JSON.parse(fs.readFileSync(markFile, 'utf8')); } catch { mark = null; }
  const asked = new Set(mark?.blocks ?? []);
  if (mark && mark.cadence === prefs.summaryCadence && missing.every((i) => asked.has(i))) return { skip: 'already-asked' };
  const batch = pickSummaryBatch(missing, o.blocks ?? missing.length);
  const rest = missing.length - batch.length;
  const text = `[convledger · 后台补账] 本会话共 ${missing.length} 块缺综述，**本轮只补最近的 ${batch.length} 块**（块 ${batch.join('、')}）${rest > 0 ? `，更早的 ${rest} 块下轮再往前补` : ''}。`
    + dispatchFor(ledger.runner, caps())
    // 分小批：一次全补会卡很久（63 块素材约 40KB、生成要几分钟，观感像死机）。只拿这几块素材，
    // 写完即止，下一轮再往前推——每轮都动一点，不让人干等。
    + ` 交给它的是：convledger digest --block ${batch.join(',')}（只拿这 ${batch.length} 块的素材）、按五格写成 {"blocks":[…`
    + `}，再 summarise --put - --session ${sid.slice(0, 8)} 一次落盘（合并式，只写这几块）；标题用动作概括，不截用户原话。**不要一次把所有缺块都补上**。`;
  try { fs.writeFileSync(markFile, JSON.stringify({ at: new Date().toISOString(), cadence: prefs.summaryCadence, blocks: batch }, null, 1)); }
  catch { /* 标记写不了就每轮问一次，好过不说 */ }
  return { reason: text, missing, batch };
}

/** 当前会话还活跃吗：源 mtime 距今 ≤ LIVE_MIN。idle 的旧对话不催补账（PRD-load §2.5）——
 *  打开旧会话不等于要把它欠的综述全补上，等它真的又在写了再说。 */
function currentIsLive(sid, transcriptPath) {
  const src = findSource(sid, transcriptPath);
  if (!src) return false;
  try { return Date.now() - fs.statSync(src).mtimeMs <= LIVE_MIN * 60000; }
  catch { return false; }
}

// 2026-11-14 用户定调：hub 不再由 hook 补起/保活（后台常驻下线，只留桌面应用窗）。
// hub 自带门禁与人走灯灭：双击图标（convledger app）按需起，应用窗关了 10 分钟后自己退。

/** 真后台：拿锁后 detached 起 closeout --auto，不占任何前台。
 *  返回 false＝已有循环在跑或起不来；调用方不该因此退回 Agent。 */
function spawnAuto(sid) {
  let lock = null;
  try { lock = tryLock(STORE, sid); } catch { return false; }
  if (!lock) return false;
  try {
    spawn(process.execPath, [path.join(TOOL_ROOT, 'bin', 'convledger.mjs'),
      'closeout', '--auto', '--session', sid, '--store', STORE], {
      detached: true, stdio: 'ignore', windowsHide: true, cwd: TOOL_ROOT,
    }).unref();
    return true;
  } catch {
    try { unlock(STORE, sid); } catch { /* 已没了 */ }
    return false;
  }
}

/** Stop 末尾的统一出口：已接模型 + 还有欠项 → 起后台循环；10 分钟内不重复起。
 *  这样做的好处：收尾没新材料但综述/阶段/记忆/画像还欠着时，也能被接走。 */
function maybeAutoSpawn(sid, cwd) {
  let lc;
  try { lc = readLlm(STORE); } catch { return false; }
  if (!lc.configured || lc.enabled === false) return false;
  let o;
  try { o = outstandingFor({ storeRoot: STORE, sessionId: sid, cwd }); } catch { return false; }
  if (!(o.items ?? []).length) return false;
  const markFile = path.join(STORE, sid, 'closeout-prompt.json');
  try {
    const mark = JSON.parse(fs.readFileSync(markFile, 'utf8'));
    if (mark.at && (Date.now() - Date.parse(mark.at)) < 10 * 60 * 1000) return false;
  } catch { /* 没有标记 */ }
  if (!spawnAuto(sid)) return false;
  try { fs.writeFileSync(markFile, JSON.stringify({ at: new Date().toISOString(), auto: true }, null, 1)); } catch { /* 标记写不了不挡循环 */ }
  return true;
}

async function main() {
  const raw = await readStdin();
  let input;
  try { input = JSON.parse(raw); } catch (e) { log({ event: null, action: 'bad-stdin', reason: String(e.message) }); return note('stdin 不是 JSON，静默退出'); }
  const event = input.hook_event_name;
  const sid = input.session_id;
  // 取证用：宿主每个事件到底给哪些字段（只记键名与标识，不记正文）。out/ 不入库。
  // 按 event+origin 分文件——否则一次夹具运行就会把宿主真发过的载荷覆盖掉（实测丢过一次证据）。
  try {
    const dir = `${TOOL_ROOT}/out/hook-inputs`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/${event || 'unknown'}-${ORIGIN}.json`, JSON.stringify({
      seenAt: new Date().toISOString(), origin: ORIGIN, keys: Object.keys(input).sort(), session_id: sid, cwd: input.cwd,
      extra: Object.fromEntries(Object.entries(input).filter(([k]) => !['hook_event_name', 'session_id', 'cwd'].includes(k))
        .map(([k, v]) => [k, typeof v === 'string' ? `<string ${v.length}>` : Array.isArray(v) ? `<array ${v.length}>` : typeof v])),
    }, null, 1));
  } catch { /* 取证失败不影响主路 */ }
  // 压缩事件把"这次压缩是真的"的两个数写进 append-only 留痕：触发方式与摘要字数。
  // 手工喂的 stdin 没有 compact_summary，这一眼就能分开。
  const compactEvidence = event === 'PostCompact' || event === 'PreCompact'
    ? { trigger: input.trigger ?? null, summaryChars: typeof input.compact_summary === 'string' ? input.compact_summary.length : null }
    : {};
  const cwd = lower(input.cwd);
  if (!EVENTS.has(event)) return;                       // 没注册的事件不该到这里，来了也不动
  if (!sid) return log({ event, action: 'no-session-id' });
  // hub 的生命周期不再归 hook 管（2026-11-14 去常驻）：要看板就双击图标，hub 无人用会自己退。

  if (event === 'PostToolUse') {                        // 探活钩子：标记文件在才说话，用一次即撤
    if (!fs.existsSync(PROBE_MARK)) return log({ event, action: 'probe-off' });
    const stamp = fs.readFileSync(PROBE_MARK, 'utf8').trim();
    fs.unlinkSync(PROBE_MARK);
    log({ event, session: sid, action: 'probe-inject', reason: stamp });
    return emit(event, `[convledger-hook 探活 ${stamp}] 这条来自 settings.json 的 PostToolUse hook，用来判定配置是否即时生效。`);
  }

  if (event === 'Stop') {
    // 自己刚阻断过的那一轮不再阻断：没有新的人类消息就不会有新的收尾
    if (input.stop_hook_active) return log({ event, session: sid, action: 'skip', reason: 'stop-hook-active' });
    // 长历史按轮补：只对本工具按片建过的账本生效（window.mode === 'slice'），
    // 这一轮只往前建一片（256KB 上限），追平即止。存量全量账本、还没建账的会话都不碰——
    // 后者要走下面的 late-build 首次建账，别抢在它前面把账本写掉。
    try {
      let led = null;
      try { led = JSON.parse(fs.readFileSync(`${STORE}/${sid}/ledger.json`, 'utf8')); } catch { /* 还没建账 */ }
      const src = led?.window?.mode === 'slice' ? findSource(sid, input.transcript_path) : null;
      if (src) {
        const w = indexWindowed(src, { storeRoot: STORE, grow: true });
        if (w.action === 'grow' || w.action === 'first') {
          log({ event, session: sid, action: 'catchup-slice', segs: w.segs, parsedBytes: w.parsedBytes ?? 0, coveredFromByte: w.window?.coveredFromByte ?? 0 });
        }
      }
    } catch { /* 补片失败不拖垮收尾 */ }
    let reason = null, action = null, meta = {};
    let out;
    try { out = closeoutFor(sid, input.transcript_path, cwd); }
    catch (e) { out = { skip: `error:${String(e && e.message).split('\n')[0]}` }; }
    // 开场时源还没写完（真机 Claude Code 的 SessionStart 只看得到 meta 行，build 认不出
    // runner），账户就没建起来；收尾时源已完整，补建一次再判，别让这一段会话白过。
    if (out.skip === 'no-ledger') {
      try {
        const st = ensureFresh(sid, false, input.transcript_path);
        if (st.ok) {
          log({ event, session: sid, action: 'late-build', segs: st.segs ?? 0 });
          out = closeoutFor(sid, input.transcript_path, cwd);
        }
      } catch { /* 补建失败就保持原判，不拖垮收尾 */ }
    }
    // 自己的后台会话：整条收尾/补账/画像都不做，直接安静退出（否则会无限派生下一段会话）。
    if (out.skip === 'internal-session') return log({ event, session: sid, action: 'skip', reason: 'internal-session' });
    if (!out.skip) {
      reason = out.reason; action = 'closeout-prompt'; meta = { remaining: out.remaining, units: out.units };
    } else if (!currentIsLive(sid, input.transcript_path)) {
      // 活跃集门控：当前会话 idle（源超过 LIVE_MIN 没写）就跳过补账催办——旧对话打开再说。
      meta = { reason: `${out.skip} / idle-session` };
    } else {
      // 没有项目收尾可做时，才轮到补账提示：一节只拦一次，免得两个提示抢同一轮。
      let sum;
      try { sum = summariseFor(sid, input.transcript_path, cwd); }
      catch (e) { sum = { skip: `error:${String(e && e.message).split('\n')[0]}` }; }
      if (!sum.skip) { reason = sum.reason; action = 'summarise-prompt'; meta = { blocks: (sum.missing ?? []).length }; }
      else meta = { reason: `${out.skip} / ${sum.skip}` };
    }
    // 画像：有新会话且画像落后时，把更新任务交给当前 agent；同一批只催一次。
    // 顺序契约（PRD-load §2.5）：当前正在运行的会话先收尾/综述、后画像——画像追加在
    // reason 之后，不抢收尾/补账那一节；画像是跨会话（后台）证据的聚合，天然排在当前会话之后。
    // 跟收尾/补账同一条阻断里带出去，不再多抢一轮；关掉档位就完全不提。
    try {
      // 画像也走同一档位：压缩时的宿主（WorkBuddy）Stop 不派画像，改到压缩边界随简报提，
      // 免得「总结机制不占了、画像那条子代理还在占前台」。
      const rp = resolvePrefs(STORE, { runner: runnerOf(sid), sessionId: sid });
      if (rp.profileCadence !== 'off' && rp.closeoutCadence !== 'compact') {
        const pd = profileDue(STORE);
        if (pd.due) {
          // 2026-11-14 用户口径：接了模型后端就全面接管，画像也不派 Agent——交给后台循环。
          let llmConfigured = false;
          try { const lc = readLlm(STORE); llmConfigured = !!(lc.configured && lc.enabled !== false); } catch { /* 按没接 */ }
          if (!llmConfigured) {
            const line = `[convledger · 后台画像] 用户画像该更新了：有 ${pd.newer} 段会话晚于上次画像。`
              + dispatchFor(runnerOf(sid), caps())
              + ' 交给它的是：memory --digest --class 画像 取材，按 G4 写 JSON（≥2 个不同会话、真人原话、每条带 project/hash；维度按 目标/边界/规则/偏好/背景/验收/分工/反馈/性格 覆盖，没证据如实留空，不做心理诊断），再 memory --put - --scope user 落盘；没有合格证据就如实不写。';
            reason = reason ? `${reason}\n\n${line}` : line;
            action = action ?? 'profile-prompt';
          }
          markProfilePrompt(STORE, pd.fingerprint);
        }
      }
    } catch { /* 画像检查失败不影响收尾 */ }
    // 已接模型：把剩余欠项（综述/收尾/阶段/记忆/画像）交给后台循环，当前对话不再逐项派 Agent。
    try { maybeAutoSpawn(sid, cwd); } catch { /* 起不来就保持安静，别把异常甩给宿主 */ }
    if (!reason) return log({ event, session: sid, action: 'skip', ...meta });
    process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
    return log({ event, session: sid, action, ...meta });
  }

  if (event === 'PreCompact') {
    const t0 = Date.now();
    try {
      const st = ensureFresh(sid, true, input.transcript_path);
      log({ event, action: st.rebuilt ? 'rebuild' : 'already-fresh', segs: st.segs, ms: Date.now() - t0, reason: st.why, ...compactEvidence });
    } catch (e) { log({ event, action: 'rebuild-failed', reason: String(e.message), ...compactEvidence }); }
    return;                                             // 压缩前注入会被这次压缩吃掉，所以只重建
  }

  const t0 = Date.now();
  // 压缩边界（PostCompact，或压缩触发的 SessionStart）意味着上下文已被换掉，去重不能跨上下文
  const freshContext = event === 'PostCompact' || (event === 'SessionStart' && input.source === 'compact');
  const evInfo = {
    ...(event === 'SessionStart' ? { source: input.source ?? null } : compactEvidence),
    freshContext,
  };
  let out;
  try { out = briefFor(sid, event, cwd, freshContext, input.transcript_path); } catch (e) { out = { skip: '异常：' + String(e && e.message) }; }
  if (out.skip) { log({ event, session: sid, action: 'skip', reason: out.skip, ms: Date.now() - t0, ...evInfo }); return; }
  // 借来的账本必须写明是借的：新上下文读到「当前：第 46 步」会以为那是它自己。
  const lead = out.foreign
    ? `本项目上一段会话 ${String(out.owner).slice(0, 8)} 的账本（不是你当前会话——你这条还没有账本）`
    : `${event === 'PostCompact' ? '压缩后自动续上' : '会话启动自动续上'}`;
  let text = `[convledger · 工具派生，不是模型记忆] ${lead}：\n${out.body}`
    + `（注入于 ${out.at.slice(0, 19).replace('T', ' ')}；账本新鲜度只担保那一刻，正文一律 body 回源）\n`;
  // 压缩时档：Stop 不拦，只在压缩边界随简报把「该补的档」列出来——但综述也只推最近几块，别一次全补。
  // 接了模型后端则更进一步：块综述直接交给后台 closeout --auto 静默补，Agent 只管剩下的非综述欠项。
  if (freshContext && !out.foreign) {
    try {
      const rp = resolvePrefs(STORE, { runner: runnerOf(sid), sessionId: sid });
      // 收尾档位也是独立的一档：压缩时不在 Stop 拦，但要在压缩边界把这条收尾任务交出去。
      // 已接模型 → 交给后台循环（不派 Agent）；没接 → 老路交给后台工作会话。
      if (rp.closeoutCadence === 'compact' && cwd) {
        const key = projectKey(cwd);
        let llmConfigured = false;
        try { const lc = readLlm(STORE); llmConfigured = !!(lc.configured && lc.enabled !== false); } catch { /* 按没接 */ }
        if (llmConfigured) {
          const started = spawnAuto(sid);
          text += started
            ? `收尾档位「压缩时」——已交给后台模型静默收尾（closeout --auto 已起，结果写 tool/out/store/closeout-result-*.json）——**当前对话不要补收尾**。\n`
            : `收尾档位「压缩时」——后台收尾循环已在跑（锁未过期），等它补完即可，当前对话不要插手。\n`;
        } else {
          text += `收尾档位「压缩时」——本会话的新记录还没并入项目任务：把 convledger sync --prepare --project ${key} --session ${sid.slice(0, 8)} → --put 交给后台工作会话。\n`;
        }
      }
      if (rp.summaryCadence === 'compact') {
        const o = outstandingFor({ storeRoot: STORE, sessionId: sid, cwd: cwd ?? null });
        const items = o.items ?? [];
        const missing = o.missingBlocks ?? [];
        const lc = readLlm(STORE);
        const autoOn = !!(lc.configured && lc.enabled !== false);
        const autoOff = lc.enabled === false;
        // 总闸关了（autoOff）：综述欠项一行列都不出——LLM 与当前 Agent 都不再补，欠项留着。
        if (items.length && !autoOff) {
          text += `补账档位「压缩时」——本会话该补 ${items.length} 项：\n`;
          if (autoOn) {
            const lock = tryLock(STORE, sid);
            if (lock) {
              spawn(process.execPath, [path.join(TOOL_ROOT, 'bin', 'convledger.mjs'),
                'closeout', '--auto', '--session', sid, '--store', STORE], {
                detached: true, stdio: 'ignore', windowsHide: true,
                cwd: TOOL_ROOT,
              }).unref();
              text += `· 块综述缺 ${missing.length} 块：已交给后台模型静默补（convledger closeout --auto 已起，结果写 tool/out/store/closeout-result-*.json）——**当前对话不要补综述**。\n`;
            } else {
              text += `· 块综述缺 ${missing.length} 块：后台补账循环已在跑（锁未过期），等它补完即可，当前对话不要插手。\n`;
            }
          } else if (missing.length) {
            const batch = pickSummaryBatch(missing, o.blocks ?? missing.length);
            const rest = missing.length - batch.length;
            text += `· 块综述：**本轮只补最近 ${batch.length} 块**（块 ${batch.join('、')}）——convledger digest --block ${batch.join(',')} → 五格写成 {"blocks":[…]} → summarise --put - --session ${sid.slice(0, 8)}；`
              + `${rest > 0 ? `更早的 ${rest} 块下轮再往前补，别一次全补。` : ''}\n`;
          }
          for (const it of items) if (!/^块综述缺/.test(it)) text += `· ${it}\n`;
          text += `按项补、过闸门、不编；补不动就如实留，别硬编。\n`;
        }
      }
    } catch { /* 自检失败不影响注入 */ }
  }
  emit(event, text);
  log({ event, session: sid, ledger: String(out.owner).slice(0, 8), foreign: !!out.foreign,
    action: 'inject', tokens: tok(text), truncated: out.truncated, ms: Date.now() - t0, ...evInfo });
}

main().catch((e) => { note(String(e && e.message)); log({ event: 'crash', action: 'fail-open', reason: String(e && e.stack).split('\n')[0] }); });

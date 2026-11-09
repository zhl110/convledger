#!/usr/bin/env node
// convledger 的 hook handler：把「压缩后第一跳」从拉取改成推送。
// 配置挂在用户级 settings.json，所以它管**所有项目的会话**：每段会话按自己的 transcript 建账、
// 注入自己的 brief，不按 cwd 划界。一个脚本管所有会话事件，按 hook_event_name 分派；契约见 tool/PRD-hook.md。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { build } from '../src/build.mjs';
import { writeStore, freezeSource } from '../src/store.mjs';
import { readState, projectBriefLine } from '../src/state-io.mjs';
import { projectKey } from '../src/current.mjs';
import { readView } from '../src/view.mjs';
import { briefText } from '../src/brief.mjs';
import { readRequests } from '../src/notes.mjs';
import { outstandingFor } from '../src/outstanding.mjs';
import { readPrefs } from '../src/prefs.mjs';
import { tok } from '../src/lib.mjs';

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

/** 各 runner 把会话原文放在哪：Qoder 在 ~/.qoder/projects，WorkBuddy 在 ~/.workbuddy/projects。
 *  扫目录而不是猜 slug 规则；根目录尽量跟着环境变量走，夹具才关得住。 */
function scanRoots() {
  const home = os.homedir();
  const qoder = (process.env.QODER_CONFIG_DIR || path.join(home, '.qoder')).replace(/\\/g, '/');
  const wb = (process.env.WORKBUDDY_CONFIG_DIR || path.join(home, '.workbuddy')).replace(/\\/g, '/');
  return [`${qoder}/projects`, `${qoder}/chat-sessions`, `${wb}/projects`];
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

/** 账本落盘那一刻之后源又长了 → 重建。PreCompact 无条件重建。 */
function ensureFresh(sid, force, transcriptPath) {
  const dir = `${STORE}/${sid}`;
  const ledgerFile = `${dir}/ledger.json`;
  const src = findSource(sid, transcriptPath);
  if (!src) return { ok: fs.existsSync(ledgerFile), dir, rebuilt: false, why: '找不到源 jsonl' };
  const stale = force || !fs.existsSync(ledgerFile) || fs.statSync(src).mtimeMs > fs.statSync(ledgerFile).mtimeMs;
  if (!stale) return { ok: true, dir, rebuilt: false };
  const built = build(src, { storeRoot: STORE });
  const written = writeStore(STORE, built);
  return { ok: fs.existsSync(`${written}/ledger.json`), dir: written, rebuilt: true, segs: built.ledger.segments.length };
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
  const base = briefText(v, readRequests(st.dir).rows);
  // 项目层指针：同一预算内只给版本、计数与最近欠项；没有任务状态的项目不加
  const pl = projectBriefLine(STORE, v.meta.cwd);
  const text = pl ? `${base}\n${pl}` : base;
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

/** 收尾检查：只核对「有没有未分析的素材」并给一条命令，不写综述、不替 agent 下结论。
 *  每个用户回合最多提示一次（按冻结字节 + 最后一条人类消息记在账本目录的标记文件里），
 *  agent 自己续写的那一轮没有新的人类消息，不会再触发。 */
function closeoutFor(sid, transcriptPath, cwd) {
  const src = findSource(sid, transcriptPath) ?? findSource(sid, null, cwd);
  if (!src) return { skip: 'no-source' };
  let ledger = null;
  try { ledger = JSON.parse(fs.readFileSync(path.join(STORE, sid, 'ledger.json'), 'utf8')); } catch { return { skip: 'no-ledger' }; }
  if (!ledger.cwd) return { skip: 'no-cwd' };
  const key = projectKey(ledger.cwd);
  let state;
  try { state = readState(STORE, key).state; } catch { return { skip: 'state-unreadable' }; }
  if (!state.tasks?.length) return { skip: 'no-tasks' };
  const cp = state.checkpoints?.[sid] ?? null;
  const from = cp?.analyzedThrough ?? 0;
  const frozen = freezeSource({ sourceFile: src, runner: ledger.runner }, { fromByte: from });
  if (!frozen.file || frozen.toByte <= from) return { skip: 'no-new-material' };
  const raw = fs.readFileSync(src).subarray(frozen.fromByte, frozen.toByte).toString('utf8');
  let human = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); if (o.type === 'user' && (o.humanInput || o.origin?.kind === 'human')) human = o.uuid ?? 'unnamed'; } catch { /* 坏行交给 prepare 报告 */ }
  }
  if (!human) return { skip: 'no-new-human-turn' };
  const markFile = path.join(STORE, sid, 'closeout-prompt.json');
  let mark = null;
  try { mark = JSON.parse(fs.readFileSync(markFile, 'utf8')); } catch { mark = null; }
  if (mark && mark.human === human && mark.byte >= frozen.toByte) return { skip: 'already-prompted' };
  const remaining = (frozen.records ?? []).length;
  let extra = '';
  try {
    const o = outstandingFor({ storeRoot: STORE, sessionId: sid, cwd: ledger.cwd });
    if (o.items.length) extra = `\n链路欠项：${o.items.slice(0, 4).join('；')}${o.items.length > 4 ? '…' : ''}。能补就补；补不动就在回执里如实留，不要编。`;
  } catch { /* 自检失败不影响收尾提示 */ }
  const text = `[convledger · 收尾检查] 本会话有 ${remaining} 条新记录（字节 ${frozen.fromByte}..${frozen.toByte}）还没分析。`
    + `请运行 convledger sync --prepare --project ${key} --session ${sid.slice(0, 8)}，按素材更新任务（结果/欠项/验收）与候选，`
    + `再 sync --put 提交；没有项目变化就逐条标 no-change。不要复述聊天，不要编造进度。`
    + extra;
  fs.writeFileSync(markFile, JSON.stringify({ at: new Date().toISOString(), byte: frozen.toByte, human }, null, 1));
  return { reason: text, remaining };
}

/** 补账：已收口却缺综述的块，按画布上选的档位决定这一轮拦不拦。
 *  档位是机器级设置（out/prefs.json），写进提示、不写进账本；综述仍由 agent 写、工具验。
 *  同一批块只问一次（summarise-prompt.json 记块号）：agent 不补或补不动时不循环催。 */
function summariseFor(sid, transcriptPath, cwdIn) {
  const prefs = readPrefs(STORE);
  if (prefs.summaryCadence === 'compact') return { skip: 'cadence-compact' };
  let ledger = null;
  try { ledger = JSON.parse(fs.readFileSync(path.join(STORE, sid, 'ledger.json'), 'utf8')); } catch { return { skip: 'no-ledger' }; }
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
  const list = missing.slice(0, 6);
  const more = missing.length > list.length ? `…共 ${missing.length} 块` : '';
  const text = `[convledger · 补账] 本会话有 ${missing.length} 块已收口但缺综述（块 ${list.join('、')}${more}）。`
    + '请先 convledger digest --block N 取材，按五格写成 JSON，再 convledger summarise --put - --session ' + sid.slice(0, 8)
    + ' 落盘；标题用动作概括，不截用户原话。写完再结束本轮。';
  try { fs.writeFileSync(markFile, JSON.stringify({ at: new Date().toISOString(), cadence: prefs.summaryCadence, blocks: missing }, null, 1)); }
  catch { /* 标记写不了就每轮问一次，好过不说 */ }
  return { reason: text, missing };
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
    let out;
    try { out = closeoutFor(sid, input.transcript_path, cwd); }
    catch (e) { out = { skip: `error:${String(e && e.message).split('\n')[0]}` }; }
    if (!out.skip) {
      process.stdout.write(JSON.stringify({ decision: 'block', reason: out.reason }) + '\n');
      return log({ event, session: sid, action: 'closeout-prompt', remaining: out.remaining });
    }
    // 没有项目收尾可做时，才轮到补账提示：一节只拦一次，免得两个提示抢同一轮。
    let sum;
    try { sum = summariseFor(sid, input.transcript_path, cwd); }
    catch (e) { sum = { skip: `error:${String(e && e.message).split('\n')[0]}` }; }
    if (sum.skip) return log({ event, session: sid, action: 'skip', reason: `${out.skip} / ${sum.skip}` });
    process.stdout.write(JSON.stringify({ decision: 'block', reason: sum.reason }) + '\n');
    return log({ event, session: sid, action: 'summarise-prompt', blocks: (sum.missing ?? []).length });
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
  // 压缩时档：Stop 不拦，只在压缩边界随简报提一次补账（借用账本就不查，别把别人的欠项说成你的）。
  if (freshContext && !out.foreign) {
    try {
      if (readPrefs(STORE).summaryCadence === 'compact') {
        const o = outstandingFor({ storeRoot: STORE, sessionId: sid, cwd: cwd ?? null });
        const mb = o.missingBlocks ?? [];
        if (mb.length) {
          text += `补账档位「压缩时」：本会话还有 ${mb.length} 块已收口缺综述（块 ${mb.slice(0, 6).join('、')}${mb.length > 6 ? '…' : ''}），请先补。\n`;
        }
      }
    } catch { /* 自检失败不影响注入 */ }
  }
  emit(event, text);
  log({ event, session: sid, ledger: String(out.owner).slice(0, 8), foreign: !!out.foreign,
    action: 'inject', tokens: tok(text), truncated: out.truncated, ms: Date.now() - t0, ...evInfo });
}

main().catch((e) => { note(String(e && e.message)); log({ event: 'crash', action: 'fail-open', reason: String(e && e.stack).split('\n')[0] }); });

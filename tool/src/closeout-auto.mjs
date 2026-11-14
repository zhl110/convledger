// 后台补账循环：接了模型后端之后，由工具自己调 LLM 把账本欠项补完——
// 不借宿主的 Agent，不占任何前台。
//
// 优先级（2026-11-14 用户口径修订）：
//   接了 API key  → 全面接管：块综述、收尾 sync（任务/事件/候选/处置）、阶段、项目记忆、用户画像
//                   都由 closeout --auto 静默补，hook 不再派 Agent；
//   没接          → 一切照旧，由当前 Agent 按 hook 的提示补。
//
// 纪律不变：LLM 只当「素材 → JSON」的转换器，落盘仍走各自的 --put 全量闸门——
// 换了便宜模型也不许垃圾进账本。每类欠项每轮只推进一小批，追平即写结果文件。
// 模型明确“没有合格证据”时输出空数组：不调用 --put、不编条目，记 skipped。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { outstandingFor } from './outstanding.mjs';
import { pickSummaryBatch } from './summary-batch.mjs';
import { readLlm, llmOn, chat, LlmError } from './llm.mjs';
import { loadLedger, storeDir } from './store.mjs';
import { projectKey } from './current.mjs';
import { memoryDue } from './profile-auto.mjs';
import { readPhases, maxPhaseTo } from './phases.mjs';

// 工具根从模块位置推导——不管 --store 指到哪，CLI 本体永远在 tool/bin 下。
const TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SUMMARY_SYSTEM = [
  '你是会话账本的综述写手。输入是若干「块」的素材：每块含用户原话、助手要点、动作计数与锚点信息。',
  '对每一块写五格综述，只输出严格的 JSON，不许输出 JSON 以外的任何字：',
  '{"blocks":[{"i":<块号>,"segs":["该块的段 id，逐项照抄素材里「段=」后面的列表"],',
  '"short":"≤7 格的动作概括","title":"≤22 字标题","said":"≤60 字：用户要求了什么",',
  '"answered":"≤80 字：答复/结论要点","done":"≤48 字：实际做成什么",',
  '"need":"≤80 字：我理解的用户要求（可选）","lesson":"≤96 字：可复用经验（可选，没有就省略）"}]}',
  '规则：事实必须全部来自素材，编不出来就写短；不许复读用户原话当 title；每块的 i 与 segs 照抄素材。',
].join('\n');

const SYNC_SYSTEM = [
  '你是项目任务账本的收尾写手。输入是 convledger sync --prepare 的 JSON（batchId、baseRevision、已有任务 tasks、待回执调用 pendingCalls、素材单元 units）。',
  '只输出严格 JSON，不许输出 JSON 以外的任何字：',
  '{"batchId":"照抄输入","baseRevision":<照抄输入>,"milestoneChanges":[],"taskChanges":[],"events":[],"candidates":[],"dispositions":[]}',
  '规则：',
  '- 每个 unit 必须恰有一条 disposition：{"line":<照抄 unit.line>,"state":"bound|no-change|pending","note":"≤40 字"}；没有新要求就 no-change，读不懂或缺上下文就 pending。',
  '- 新建任务用 localKey（本批唯一，如 t1）；更新已有任务必须 {"id":"PTxx","patch":{...}}，不许拿 localKey 更新。',
  '- 任务上限：short ≤12 格；title ≤28 字；result/nextAction ≤60 字；status 只能取 unknown/planned/active/blocked/awaiting-verification/done/cancelled。',
  '- acceptance 写成可复点的判据数组：每项 {"id":"A1","condition":"可重跑的命令/文件/读数","kind":"test|artifact|human","result":"pending"}；标 done 必须有全部必做验收为 pass 且有证据。',
  '- 只有素材里出现完成证据才可写 done；不许把“开始做了”写成 done，不许补不存在的进度、文件名、数字。',
  '- 新建里程碑 {"localKey":"m1","short":"≤12 字","title":"…","goal":"…"}；任务可用 milestoneId 指向 localKey。',
  '- 事件 {"taskId":"PTxx 或 localKey","type":"started|progressed|verified|blocked|reopened|cancelled|split|merged|corrected","note":"≤60 字"}。',
  '- 候选 {"class":"进度|经验|规则|探索","topic":"…","text":"…","evidence":[...]}；没有就不给。',
].join('\n');

const PHASES_SYSTEM = [
  '你是会话账本的阶段说明写手。输入是 convledger digest --phases 的素材（步表、计数、文档清单、写法口径）。',
  '只输出严格 JSON：{"phases":[{"from":1,"to":7,"short":"…","doing":"…","state":"…","effect":"…","plan":"…","track":"…","refs":[{"f":"文件","h":"标题"}]}]}',
  '规则：',
  '- 边界按主线步划：从第 1 步起（或按素材给的未覆盖起点）、首尾相接、除最后一段外每段 ≥2 步、最后一段不超过素材的主线步数。',
  '- 六格全填，事实必须来自素材；ASCII 记号、数字、文件名必须在素材里逐字出现，编不出的换写成素材里有的词。',
  '- 不许复述用户原话当阶段说明；plan/track 没有文档引用就整格写 “—”。',
  '- 素材不足以说明这一段就不写这一段，宁可少写。',
].join('\n');

const MEMORY_SYSTEM = [
  '你是项目记忆写手。输入是 convledger memory --digest 的素材，末尾带「输出形状（memory --put -）」与 G4 类别门槛。',
  '只输出严格 JSON：{"entries":[...]}，每条严格按素材给出的字段形状。',
  '规则：',
  '- 证据必须逐字来自素材，sid/seg/hash 照抄；素材里没有的条目一个字也不写。',
  '- 没有一条够门槛就输出 {"entries":[]}——工具会记“没有合格证据”，绝不调用写入口。',
  '- 不做心理诊断、不贴贬义标签；不确定就留空。',
].join('\n');

const PROFILE_SYSTEM = [
  '你是用户画像写手。输入是 convledger memory --digest --class 画像 的跨项目素材，末尾带「输出形状（memory --put --scope user -）」与 G4 画像门槛。',
  '只输出严格 JSON：{"entries":[...]}，每条严格按素材给出的字段形状。',
  '规则：',
  '- 画像证据 ≥2 个不同会话、每个至少 1 条 kind=say 的真人原话；每条都要 project/hash。',
  '- 维度按 目标/边界/规则/偏好/背景/验收/分工/反馈/性格 覆盖；没有证据的维度如实留空。',
  '- 不做心理诊断、不贴贬义标签；没有合格证据就输出 {"entries":[]}，工具不会写。',
].join('\n');

const TITLE_SYSTEM = [
  '你是会话账本的任务题名写手。输入是缺题名的主支素材（每行一条支：id、头块、覆盖块、回合、头原话与头回复）。',
  '只输出严格 JSON：{"tasks":[{"id":"Bxx","title":"≤18 字"}]}',
  '规则：题名要概括这条支干成了什么，不是复读头一句；只写素材里出现的 id；素材不够就整条不给。',
].join('\n');

function strip(fence) {
  const m = String(fence).match(/```(?:json)?\s*([\s\S]*?)```/);
  return (m ? m[1] : String(fence)).trim();
}

function bin() { return path.join(TOOL, 'bin', 'convledger.mjs'); }

function runCli(args, { input } = {}) {
  const r = spawnSync(process.execPath, [bin(), ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 32 * 1024 * 1024,
    ...(input !== undefined ? { input } : {}),
  });
  // spawn 本身可能失败（ENOENT / EACCES）：status 是 null，stderr 也是空——必须把 r.error 带出来，
  // 不然调用方只看到「失败了」三个字，没法排障。
  return { code: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.error ?? r.stderr ?? '') };
}

function tryParse(text) {
  try { return { ok: true, payload: JSON.parse(strip(text)) }; }
  catch { return { ok: false }; }
}

/** 一次素材 → JSON；不是合法 JSON 时把原文退回去让它自纠一次。 */
async function askJson(cfg, system, user, maxTokens = 4096) {
  let text;
  try { text = (await chat(cfg, { system, user, maxTokens, temperature: 0.1 })).text; }
  catch (e) { return { ok: false, error: `模型调用失败：${String(e?.message ?? e).slice(0, 200)}` }; }
  const first = tryParse(text);
  if (first.ok) return first;
  try {
    const fix = (await chat(cfg, {
      system,
      user: `${user}\n\n你上一轮的输出不是合法 JSON（原文：${strip(text).slice(0, 800)}）。只重新输出合法 JSON，不要任何解释。`,
      maxTokens, temperature: 0,
    })).text;
    const second = tryParse(fix);
    return second.ok ? second : { ok: false, error: '模型两次都没给出合法 JSON' };
  } catch (e) {
    return { ok: false, error: `模型调用失败：${String(e?.message ?? e).slice(0, 200)}` };
  }
}

/** 交给既有 --put 闸门；被挡下就把校验错误带回模型修一次。 */
async function commitWithRetry(cfg, { system, material, args, payload, normalize = (x) => x, maxTokens = 4096 }) {
  let p = normalize(payload);
  let put = runCli(args, { input: JSON.stringify(p) });
  if (put.code === 0) return { ok: true, payload: p };
  const errs = (put.stdout + '\n' + put.stderr).slice(0, 1200);
  const fix = await askJson(cfg, system,
    `${material}\n\n你上一轮的提交没过闸门，工具说：${errs}\n按同样形状重新只输出修正后的合法 JSON。`, maxTokens);
  if (!fix.ok) return { ok: false, error: `闸门没过且修正失败：${errs.slice(0, 300)}` };
  p = normalize(fix.payload);
  put = runCli(args, { input: JSON.stringify(p) });
  if (put.code === 0) return { ok: true, payload: p, retried: true };
  return { ok: false, error: `闸门两次没过：${(put.stdout + ' ' + put.stderr).slice(0, 300)}` };
}

/** 锁：防两份后台循环同时写一本账。10 分钟过期（进程崩了也不会永久卡死）。 */
const LOCK_MS = 10 * 60 * 1000;
function lockFile(root, sessionId) {
  return path.join(root, `closeout-${String(sessionId).slice(0, 8)}.lock`);
}
export function tryLock(root, sessionId) {
  const p = lockFile(root, sessionId);
  try {
    const st = fs.statSync(p);
    if (Date.now() - st.mtimeMs < LOCK_MS) return null; // 别人在跑
  } catch { /* 没有锁 */ }
  fs.writeFileSync(p, String(Date.now()));
  return p;
}
export function unlock(root, sessionId) {
  try { fs.unlinkSync(lockFile(root, sessionId)); } catch { /* 已没了 */ }
}
function touchLock(root, sessionId) {
  try { fs.utimesSync(lockFile(root, sessionId), new Date(), new Date()); } catch { /* 没拿锁或已过期 */ }
}

// ── 五段欠项：每段只做一小批；落盘全走各命令自己的闸门 ─────────────────────

async function stageSummaries(root, sid, cwd, cfg, say) {
  const o = outstandingFor({ storeRoot: root, sessionId: sid, cwd });
  const missing = (o.missingBlocks ?? []).filter((i) => !o.liveBlocks?.includes(i));
  // 支线题名与块综述共用 summarise --put；只有主支题名才算欠项（与 digest 同一把尺）。
  if (!missing.length) {
    const titles = o.missingTitles ?? 0;
    if (!titles) return { done: true };
    say(`题名：缺 ${titles} 条主支题名`);
    const dg = runCli(['digest', '--tasks', '--session', sid, '--store', root]);
    if (dg.code !== 0 || !dg.stdout.trim()) {
      return { ok: false, error: `题名素材取不到：${(dg.stderr || dg.stdout).slice(0, 160)}` };
    }
    const ask = await askJson(cfg, TITLE_SYSTEM, dg.stdout);
    if (!ask.ok) return { ok: false, error: `题名${ask.error}` };
    const rows = Array.isArray(ask.payload?.tasks) ? ask.payload.tasks : [];
    if (!rows.length) return { skipped: '题名素材不足，模型没有给出可写的题名' };
    const r = await commitWithRetry(cfg, {
      system: TITLE_SYSTEM, material: dg.stdout,
      args: ['summarise', '--put', '-', '--session', sid, '--store', root],
      payload: { tasks: rows },
    });
    if (!r.ok) return { ok: false, error: `题名${r.error}` };
    say(`题名：落盘 ${rows.length} 条`);
    return { ok: true, n: rows.length };
  }
  const batch = pickSummaryBatch(missing, o.blocks ?? 0);
  say(`综述：缺 ${missing.length} 块，本轮补 ${batch.length} 块（${batch.join(',')}）`);
  const dg = runCli(['digest', '--session', sid, '--block', batch.join(','), '--store', root]);
  if (dg.code !== 0 || !dg.stdout.trim()) {
    return { ok: false, error: `digest 取材失败（块 ${batch.join(',')}）：${(dg.stderr || dg.stdout).slice(0, 160)}` };
  }
  const ask = await askJson(cfg, SUMMARY_SYSTEM, dg.stdout);
  if (!ask.ok) return { ok: false, error: ask.error };
  const r = await commitWithRetry(cfg, {
    system: SUMMARY_SYSTEM, material: dg.stdout,
    args: ['summarise', '--put', '-', '--session', sid, '--store', root],
    payload: ask.payload,
  });
  if (!r.ok) return { ok: false, error: `综述${r.error}` };
  say(`综述：落盘 ${batch.length} 块`);
  return { ok: true, n: batch.length };
}

async function stageSync(root, sid, key, cfg, say) {
  const prep = runCli(['sync', '--prepare', '--project', key, '--session', sid, '--store', root]);
  if (prep.code !== 0) {
    const msg = (prep.stdout + ' ' + prep.stderr).trim();
    // 没有新字节是正常空状态，不是失败。
    if (/没有新素材|no-new-material|源日志与归档都读不到/.test(msg)) return { done: true };
    return { ok: false, error: `sync --prepare 失败：${msg.slice(0, 200)}` };
  }
  let doc;
  try { doc = JSON.parse(prep.stdout); } catch { return { ok: false, error: 'sync --prepare 回执不是 JSON' }; }
  const units = Array.isArray(doc.units) ? doc.units : [];
  if (!units.length) return { done: true };
  say(`收尾：${units.length} 个素材单元`);
  const ask = await askJson(cfg, SYNC_SYSTEM, prep.stdout);
  if (!ask.ok) return { ok: false, error: `收尾${ask.error}` };
  const normalize = (x) => ({
    ...(x && typeof x === 'object' && !Array.isArray(x) ? x : {}),
    batchId: doc.batchId, baseRevision: doc.baseRevision,
  });
  const r = await commitWithRetry(cfg, {
    system: SYNC_SYSTEM, material: prep.stdout,
    args: ['sync', '--put', '-', '--project', key, '--session', sid, '--store', root],
    payload: ask.payload, normalize,
  });
  if (!r.ok) return { ok: false, error: `收尾${r.error}` };
  say(`收尾：已提交 ${units.length} 个单元的处置`);
  return { ok: true, n: units.length };
}

async function stagePhases(root, sid, cfg, say) {
  const o = outstandingFor({ storeRoot: root, sessionId: sid });
  if (!o.items.some((x) => /阶段/.test(x))) return { done: true };
  const dg = runCli(['digest', '--phases', '--session', sid, '--store', root]);
  if (dg.code !== 0 || !dg.stdout.trim()) {
    return { ok: false, error: `阶段素材取不到：${(dg.stderr || dg.stdout).slice(0, 160)}` };
  }
  const dir = storeDir(root, sid);
  const covered = maxPhaseTo(readPhases(dir));
  const material = covered > 0
    ? `${dg.stdout}\n\n（本会话已覆盖到第 ${covered} 步；请只写第 ${covered + 1} 步之后的尾段阶段，工具会以 append 模式接上。）`
    : dg.stdout;
  const ask = await askJson(cfg, PHASES_SYSTEM, material);
  if (!ask.ok) return { ok: false, error: `阶段${ask.error}` };
  const phases = Array.isArray(ask.payload?.phases) ? ask.payload.phases : [];
  if (!phases.length) return { skipped: '阶段素材不足，模型没有给出可写的阶段' };
  say(`阶段：写 ${phases.length} 段（已覆盖到第 ${covered} 步）`);
  const body = covered > 0 ? { append: true, phases } : { phases };
  const r = await commitWithRetry(cfg, {
    system: PHASES_SYSTEM, material,
    args: ['phases', '--put', '-', '--session', sid, '--store', root],
    payload: body,
  });
  if (!r.ok) return { ok: false, error: `阶段${r.error}` };
  say(`阶段：已落盘 ${phases.length} 段`);
  return { ok: true, n: phases.length };
}

async function stageMemory(root, key, cfg, say) {
  const due = memoryDue(root, key);
  if (!due.project?.due) return { done: true };
  const dg = runCli(['memory', '--digest', '--project', key, '--store', root]);
  if (dg.code !== 0 || !dg.stdout.trim()) {
    return { ok: false, error: `记忆素材取不到：${(dg.stderr || dg.stdout).slice(0, 160)}` };
  }
  const ask = await askJson(cfg, MEMORY_SYSTEM, dg.stdout);
  if (!ask.ok) return { ok: false, error: `记忆${ask.error}` };
  const entries = Array.isArray(ask.payload?.entries) ? ask.payload.entries : [];
  if (!entries.length) return { skipped: '项目记忆没有合格证据，如实不写' };
  say(`记忆：写 ${entries.length} 条`);
  const r = await commitWithRetry(cfg, {
    system: MEMORY_SYSTEM, material: dg.stdout,
    args: ['memory', '--put', '-', '--project', key, '--store', root],
    payload: { entries },
  });
  if (!r.ok) return { ok: false, error: `记忆${r.error}` };
  say(`记忆：已落盘 ${entries.length} 条`);
  return { ok: true, n: entries.length };
}

async function stageProfile(root, key, cfg, say) {
  const due = memoryDue(root, key);
  if (!due.user?.due) return { done: true };
  const dg = runCli(['memory', '--digest', '--class', '画像', '--store', root]);
  if (dg.code !== 0 || !dg.stdout.trim()) {
    return { ok: false, error: `画像素材取不到：${(dg.stderr || dg.stdout).slice(0, 160)}` };
  }
  const ask = await askJson(cfg, PROFILE_SYSTEM, dg.stdout);
  if (!ask.ok) return { ok: false, error: `画像${ask.error}` };
  const entries = Array.isArray(ask.payload?.entries) ? ask.payload.entries : [];
  if (!entries.length) return { skipped: '画像没有合格证据，如实不写' };
  say(`画像：写 ${entries.length} 条`);
  const r = await commitWithRetry(cfg, {
    system: PROFILE_SYSTEM, material: dg.stdout,
    args: ['memory', '--put', '-', '--scope', 'user', '--store', root],
    payload: { entries },
  });
  if (!r.ok) return { ok: false, error: `画像${r.error}` };
  say(`画像：已落盘 ${entries.length} 条`);
  return { ok: true, n: entries.length };
}

/**
 * 跑补账循环：五段欠项各自追平、达到轮数上限或出不可恢复的错误。
 * 每段失败只封锁该段（下轮不再重试），其余段继续——不因为阶段写不出来就饿死画像。
 * @returns {{rounds:number, written:number, failures:string[], done:boolean, stages:object, skipped:string[]}}
 */
export async function runAuto(root, { sessionId, max = 30, cwd = null, say = () => {} } = {}) {
  const cfg = readLlm(root);
  if (!cfg.configured) {
    throw new LlmError('还没接模型：先 convledger llm --key <你的 key>（或页面「设置」里填）');
  }
  const { ledger } = loadLedger(root, sessionId);
  const key = projectKey(cwd || ledger.cwd || process.cwd());
  const out = { rounds: 0, written: 0, failures: [], done: false, stages: { summaries: 0, sync: 0, phases: 0, memory: 0, profile: 0 }, skipped: [] };
  const blocked = new Set();
  const take = async (name, fn) => {
    if (blocked.has(name)) return false;
    let r;
    try { r = await fn(); }
    catch (e) { r = { ok: false, error: `${name} 异常：${String(e?.message ?? e).slice(0, 200)}` }; }
    if (r?.done) { blocked.add(name); return false; }
    if (r?.skipped) { blocked.add(name); out.skipped.push(r.skipped); say(`· ${r.skipped}`); return false; }
    if (r?.ok) { out.stages[name] += r.n ?? 0; return true; }
    blocked.add(name);
    out.failures.push(`${name}：${r?.error ?? '未知失败'}`);
    say(`✗ ${name}：${r?.error ?? '未知失败'}`);
    return false;
  };
  for (let round = 0; round < max; round++) {
    // 每轮开头看一眼总开关：页面把它关了就立刻收手，别让「关了还在偷偷补」发生。
    if (!llmOn(root)) { out.stopped = '开关已关（或 key 已断开），后台补账停止'; break; }
    touchLock(root, sessionId);
    const before = out.stages.summaries + out.stages.sync + out.stages.phases + out.stages.memory + out.stages.profile;
    await take('summaries', () => stageSummaries(root, sessionId, ledger.cwd ?? cwd, cfg, say));
    await take('sync', () => stageSync(root, sessionId, key, cfg, say));
    await take('phases', () => stagePhases(root, sessionId, cfg, say));
    await take('memory', () => stageMemory(root, key, cfg, say));
    await take('profile', () => stageProfile(root, key, cfg, say));
    const after = out.stages.summaries + out.stages.sync + out.stages.phases + out.stages.memory + out.stages.profile;
    if (after > before) { out.rounds++; out.written += after - before; }
    else { out.done = blocked.size >= 5 && !out.failures.length; break; }
    if (blocked.size >= 5) { out.done = !out.failures.length; break; }
  }
  // 写结果文件：页面/CLI 能查到这次后台跑成什么样
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, `closeout-result-${String(sessionId).slice(0, 8)}.json`),
      JSON.stringify({ at: new Date().toISOString(), ...out }, null, 1));
  } catch { /* 结果写不了不影响补账本身 */ }
  return out;
}

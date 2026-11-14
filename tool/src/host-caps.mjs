// 宿主的「派活能力」表：记忆里那些活（收尾、补账、画像）要交给一个后台去做，
// 但「怎么开一个后台」每家都不一样，而且会随宿主升级变。
//
// 所以这里只有数据，没有 if 分支：代码读表 → 按 channel 选模板 → 出文案。
// 新增一家宿主是加一行配置，不是改代码；升级宿主改 out/host-caps.json 覆盖，也不用动代码。
//
// 通道只有五档，语义由工具定，宿主只能填自己是哪档：
//   plugin          由插件／钩子层自己开会话派活（agent 完全不用管，最可靠）
//   session         独立后台会话（agent 用宿主的工具开，不占当前上下文）
//   subagent-async  异步子代理，派完就走（占进程不占上下文，次好）
//   subagent-sync   同步子代理（会堵住主线——默认不给，除非表里显式写）
//   none            什么都不做（诚实；欠项留到下一轮，agent 直接结束本轮也是正确结果）
//
// 【状态单一源】status / gaps 是「这家现在验到哪一步」的机器可读答案。
// HOSTS.md 一页表与每家节状态行、SKILL 实证边界、README 都跟它对齐（selftest 钉住）。
// CHANGELOG / NOTES / 旧 PRD 里的「未实测」是当时的结论，历史留痕不改，不许当现状转述。
//
// 【防再犯 · 2026-11-13】派活工具名不能凭印象写：WorkBuddy 曾照抄 Qoder 的
// create_chat_session、Claude Code 曾写 Task，两次都是「模型根本没有这个按钮」的空指令，
// 不报错、不崩溃，只表现成主线被占或活没派出去。所以本表每个可用档都带 evidence（出处），
// 证伪过的入口进 BAD_TOOLS，dispatchFor 命中时直接改成「不派」而不是再发一次空指令。
// 复盘与铁律见 tool/HOSTS.md「派活入口必须先核实」一节。
import fs from 'node:fs';
import path from 'node:path';

export const CHANNELS = ['plugin', 'session', 'subagent-async', 'subagent-sync', 'none'];
export const CHANNEL_LABEL = {
  plugin: '插件自动派（agent 完全不用管）',
  session: '独立后台会话',
  'subagent-async': '异步子代理',
  'subagent-sync': '同步子代理（会堵主线）',
  none: '不派（诚实留欠）',
};

/** 状态只有三档，与 HOSTS.md 的口径一致。gaps 写「还差哪一段没单独取证」，不许含糊成「完全完美」。 */
export const STATUS = { verified: '已验证', partial: '部分验证', untested: '未实测' };

/** 默认表：只写「真机验证过」或「按形状推断并注明未实测」，不许写「已适配」。
 *  evidence = 这个 tool / open / 参数在该宿主当前版本里真实存在的出处（SDK 类型、宿主文档、真机流）。
 *  缺 evidence 的可用档会在 caps 与 selftest 里报警告；新增宿主别跳过这一格。 */
export const DEFAULT_CAPS = {
  qoder: {
    channel: 'session',
    open: 'create_chat_session',
    continue: 'send_message_to_chat_session',
    inspect: 'read_chat_session',
    reuse: 'convledger internal',
    evidence: 'Qoder 桌面端工具面 create_chat_session / send_message_to_chat_session / read_chat_session；真机多轮派发留痕在 tool/out/hook-probe.jsonl',
    status: 'verified',
    gaps: [],
    verified: '真机（派过并留痕）',
  },
  workbuddy: {
    channel: 'subagent-async',
    tool: 'Agent',
    asyncParam: 'run_in_background: true',
    evidence: 'WorkBuddy 的 Agent 工具支持 run_in_background:true；真机 2026-11-12 后台子代理在回合结束后存活 154 秒并写出文件（HOSTS.md）',
    status: 'verified',
    gaps: ['brief 注入未单独取证'],
    verified: '真机实测 2026-11-12：回合结束后存活 154 秒并写出文件，未随回合回收',
  },
  'claude-code': {
    // 2.1.x 里派子代理的工具叫 Agent，不是 Task：这个版本的 Task 是
    // TaskCreate/TaskGet/TaskUpdate/TaskList/TaskStop 一组任务表工具，写 Task 会让模型找不到可用的派活入口。
    // sdk-tools.d.ts 的 AgentInput 有 run_in_background，注释写明「Agents run in the background by default」。
    channel: 'subagent-async',
    tool: 'Agent',
    asyncParam: 'run_in_background: true',
    evidence: '@anthropic-ai/claude-code/sdk-tools.d.ts（CLI 2.1.296）: AgentInput.run_in_background?: boolean；真机 stream-json 里 Agent 返回「Async agent launched successfully」',
    status: 'verified',
    gaps: ['PreCompact / PostCompact 压缩事件未单独取证（短会话没触发压缩，实际任务中再验）'],
    verified: '真机跑通 2026-11-13（CLI 2.1.296）：Agent + run_in_background:true 返回「Async agent launched successfully」，主线 11s 回复 dispatched、后台子代理 22s 后写出探针文件（存活且不堵主线）；SessionStart 注入 408 tok、Stop 的 decision:block 反馈进上下文、late-build 建出 runner=claude-code 账本。边界：headless 用 --allowedTools 时要放行 Bash/PowerShell，子代理才跑得了 convledger（被拒时如实 no-change）；--bg 独立会话需 workspace trust，故不走',
  },
  opencode: {
    channel: 'plugin',
    via: 'hooks/opencode-plugin.js',
    api: 'ctx.session.create → switchModel/switchAgent → prompt',
    evidence: '@opencode/plugin 2.x 的 Plugin.define({id, setup(ctx)})；真机 session.execution.succeeded → ctx.session.create 后台会话 257 条消息、末条 outcome:succeeded（HOSTS.md）',
    status: 'verified',
    gaps: ['重复派活闸门的新插件要重启 OpenCode 常驻 service 才加载'],
    verified: '真机跑通 2026-11-13：插件 ready / compaction 注入 / dispatch-bg 派活全有留痕；后台 worker 会话 257 条消息、末条 outcome succeeded，欠项 1446→25。同轮曾成对重复派（service 与 TUI 各加载一份插件），已改落盘分桶闸门；新插件装好后需重启 OpenCode 才加载',
  },
  codex: {
    channel: 'none',
    evidence: 'hooks 仍是 beta，本机没有真机投递留痕；按「不派」处理，不猜工具名',
    status: 'untested',
    gaps: ['hooks 仍是 beta，投递都没真机验过'],
    verified: '未实测（hooks 仍是 beta，投递都没验过）',
  },
};

/** 已证伪的派活入口：host + tool 精确匹配。命中就不发指令，改为诚实留欠。
 *  加一条之前先在 HOSTS.md 写清「哪个版本、真实入口是什么、真机证据」。 */
export const BAD_TOOLS = [
  {
    host: 'claude-code', tool: 'Task',
    reason: 'Claude Code 2.1.x 的 Task 是 TaskCreate/TaskGet/TaskUpdate/TaskList/TaskStop 一组任务表工具，不是派子代理的入口；真入口是 Agent（sdk-tools.d.ts: AgentInput.run_in_background）',
  },
];

const FALLBACK = { channel: 'none', status: 'untested', verified: '表里没有这家：按「不派」处理，不猜它的工具名' };

/** 覆盖文件放在账本根的上一级（`out/host-caps.json`），与 out/ 其它派生数据同级。
 *  只做浅合并：改哪家写哪家，没写的继续用默认表。 */
export function capsFile(root) {
  return path.resolve(root, '..', 'host-caps.json').replace(/\\/g, '/');
}

export function loadCaps(root) {
  const caps = { ...DEFAULT_CAPS };
  let overlays = {};
  let file = null;
  try {
    file = capsFile(root);
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      // 允许 {hosts:{...}} 或直接 {qoder:{...}}
      const body = raw && typeof raw === 'object' && raw.hosts && typeof raw.hosts === 'object' ? raw.hosts : raw;
      for (const [k, v] of Object.entries(body || {})) {
        if (!v || typeof v !== 'object') continue;
        if (v.channel && !CHANNELS.includes(v.channel)) continue;   // 未知通道不认，回落默认
        overlays[k] = v;
      }
    }
  } catch { /* 覆盖文件坏了就用默认表，不因为配置错就停摆 */ }
  for (const [k, v] of Object.entries(overlays)) caps[k] = { ...(caps[k] || {}), ...v, overridden: true };
  return { caps, file: overlays && Object.keys(overlays).length ? file : null };
}

export function capOf(caps, runner) {
  return caps[String(runner || '').toLowerCase()] || FALLBACK;
}

/** 命中已证伪入口时返回原因；dispatchFor 据此改走「不派」，不再把空指令发给模型。 */
export function capBlockReason(caps, runner) {
  const host = String(runner || '').toLowerCase();
  const c = capOf(caps, host);
  const bad = BAD_TOOLS.find((b) => b.host === host && b.tool === c.tool);
  return bad ? bad.reason : null;
}

/** 全表体检：可用档必须有出处与真机结论，异步档必须有后台参数，证伪入口一律拦下。
 *  level: 'block' 会改派活行为；'warn' 只提示。给 caps 命令、页面与 selftest 共用。 */
export function capsWarnings(caps) {
  const warnings = [];
  for (const [host, c] of Object.entries(caps || {})) {
    if (!c || typeof c !== 'object') continue;
    const ch = c.channel || 'none';
    const bad = BAD_TOOLS.find((b) => b.host === host && b.tool === c.tool);
    if (bad) warnings.push({ host, level: 'block', text: `派活工具 ${bad.tool} 已证伪：${bad.reason}` });
    if (!STATUS[c.status]) warnings.push({ host, level: 'warn', text: 'status 只能是 verified / partial / untested，三档之外不许自造' });
    if (c.status === 'verified' && !/真机/.test(c.verified || '')) warnings.push({ host, level: 'warn', text: '标已验证却没有真机结论' });
    if (c.status === 'untested' && /真机跑通|真机实测/.test(c.verified || '')) warnings.push({ host, level: 'warn', text: '标未实测却写着真机跑通，状态自相矛盾' });
    if (ch === 'none' || ch === 'plugin') continue;
    if (!c.evidence) warnings.push({ host, level: 'warn', text: '缺 evidence：工具名/参数没有出处，宿主一改名就会变成空指令' });
    if (!/真机/.test(c.verified || '')) warnings.push({ host, level: 'warn', text: '没有真机证据就开了可用通道；按 HOSTS 口径应回落到 none' });
    if (!c.tool && !c.open) warnings.push({ host, level: 'warn', text: '没有 tool / open：派活文案会让模型自己猜工具名' });
    if (ch === 'subagent-async' && !c.asyncParam) warnings.push({ host, level: 'warn', text: '异步档没写 asyncParam：可能退化成同步子代理堵住主线' });
  }
  return warnings;
}

/** 「把活派出去」那句话。模板按通道定，宿主差异只体现在表里的字段上。 */
export function dispatchFor(runner, caps) {
  const blocked = capBlockReason(caps, runner);
  if (blocked) {
    return `**直接结束本轮，什么都不做**——这家登记的派活入口不可用（${blocked}）；`
      + '别在本对话里换写法重试，先跑 convledger caps 核实工具名并真机跑一轮，欠项留到下一轮再提。';
  }
  const c = capOf(caps, runner);
  if (c.channel === 'plugin') {
    // 这一档 agent 什么都别做：插件在 execution.succeeded 时就自己开了后台会话。
    // 再让 agent 派一次，只会多开一段重复的会话。
    return '**这一家由插件自己派活，你不必做任何事**——收尾与补账已由宿主插件开后台会话处理。不要在本对话里处理欠项，也不要另开子代理。';
  }
  if (c.channel === 'session') {
    const reuse = c.reuse ? `先跑 \`${c.reuse}\` 看 worker id：有就 ${c.inspect || '确认'}可用、用 ${c.continue} 续派；` : '';
    return `在当前对话里只做一件事：把活派给**后台工作会话**，别每次新开。${reuse}`
      + `没有就 ${c.open} 新建一段（prompt 以 [convledger-internal] 开头），再 \`${c.reuse || 'convledger internal'} --set <新id>\` 记住它，以后一直复用这一段。`
      + '派完立即结束本轮，不要在当前对话里逐批处理。';
  }
  if (c.channel === 'subagent-async') {
    const param = c.asyncParam ? `（\`${c.asyncParam}\`）` : '（先确认这个工具支持后台运行，不支持就别开）';
    return `用 ${c.tool} 工具开一个**后台**子代理${param}，prompt 头带 [convledger-internal] 并把下面这些命令与判据写全给它；`
      + '**派出去就结束本轮，不要等它、不要读它的返回、不要在这里替它做**——它半路倒了或权限被拒，欠项下一轮还会再提，别在主线重试。';
  }
  if (c.channel === 'subagent-sync') {
    // 显式配成同步通道的，通常是「没有别的手段、且这活很短」。文案要把代价写出来。
    return `只能用同步子代理（${c.tool || '子代理'}）：**它会占住本轮**，所以要确认这批活很短再开；`
      + '超过几分钟的批次直接跳过，把欠项留到下一轮，别把主线拖死。';
  }
  return '**直接结束本轮，什么都不做**——这个宿主没有可靠的后台派活方式，欠项留着下一轮再提，不要在本对话里硬做。';
}

/** 给 CLI / 页面看的一张表：每家走哪条通道、依据是什么、验到哪一步、有没有该拦下的错名。 */
export function capsTable(root) {
  const { caps, file } = loadCaps(root);
  const warnings = capsWarnings(caps);
  const rows = Object.keys(caps).map((host) => ({
    host, channel: caps[host].channel, label: CHANNEL_LABEL[caps[host].channel] || caps[host].channel,
    tool: caps[host].tool || caps[host].open || null,
    status: caps[host].status || 'untested', statusLabel: STATUS[caps[host].status] || '未实测',
    gaps: caps[host].gaps || [],
    evidence: caps[host].evidence || null,
    verified: caps[host].verified || '未标注', overridden: !!caps[host].overridden,
    blocked: capBlockReason(caps, host),
  }));
  const grouped = {};
  for (const r of rows) (grouped[r.statusLabel] ||= []).push(r.host);
  const statusSummary = Object.entries(grouped).map(([k, v]) => `${k}：${v.join(' / ')}`).join('；');
  return { rows, file, channels: CHANNELS, warnings, statusSummary };
}

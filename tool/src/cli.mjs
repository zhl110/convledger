#!/usr/bin/env node
// convledger — a structural ledger over agent conversation logs.
// Derived-first: it stores segments, anchors, facts and route cards; bodies are
// always re-read from the runner's own append-only JSONL.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { build, RULE_AUTHOR } from './build.mjs';
import { listSessions } from './project.mjs';
import { libraryOf, RUNNER_LABEL } from './library.mjs';
import { writeStore, loadLedger, resolveSegments, renderBody, searchLedger, storeDir, trace, readTrace, checkAnchor, archiveState, syncArchive, effectiveSource } from './store.mjs';
import { proveInput, renderProve, materials, validateClaim, norm } from './claims.mjs';
import { readTopics, writeTopics, validateLabel, publishedTopics, BRANCH_STATES } from './topics.mjs';
import { readView, clip } from './view.mjs';
import { briefText, phaseDetailText, chapterDetailText, handoffText } from './brief.mjs';
import { readNotes, readRequests, closeRequest } from './notes.mjs';
import { blockHash, blockMaterial, readSummaries, taskMaterial, validateSummary, validateTaskTitle, writeSummaries } from './summaries.mjs';
import { allMaterial, readPhases, validatePhase, validatePhases, writePhases, applyPhases, maxPhaseTo } from './phases.mjs';
import { readChapters, writeChapters, validateChapter, validateChapters, applyChapters, chapterDigest, suggestRanges } from './chapters.mjs';
import { scanDocs } from './docs.mjs';
import { serveMap, probeHub, hubFile } from './map.mjs';
import { hostRows, nodeFacts, portState, storeWritable, runNode, smoke, buildRecent, writeShortcuts, removeShortcuts, writeDesktopEntry, removeDesktopEntry, copyText, openUrl, ensureHub } from './setup.mjs';
import { outstandingFor } from './outstanding.mjs';
import { lessonsOf } from './lessons.mjs';
import { resolveCurrent, resolveWriteTarget } from './current.mjs';
import { projectsOf } from './projects.mjs';
import { projectView, applyBatch, STATUS_LABEL, transitionCandidate } from './progress.mjs';
import { readState, commitBatch, sha256, readPrepared, writePrepared, dropPrepared, updateState, projectBriefLine } from './state-io.mjs';
import { prepareBatch, verifyPrepared, associateBatch, mergePending, readPending, writePending, byteOffsetOfLine } from './sync.mjs';
import { MEMORY_CLASSES, memoryRead, digestMaterials, digestUserMaterials, resolveProject, putProjectMemories, putUserMemories, promoteEntry, unpromoteEntry, userContext, memoryContext, applyFreshness, publishCandidates } from './memories.mjs';
import { writeProjectExports, globalIndexFile, checkExports, lastRunFile, prunePreview, exportPaths, snapshotNames, KEEP_SNAPSHOTS } from './export.mjs';
import { tok, num, kb } from './lib.mjs';
import { BODY_BUDGET_TOKENS, MIN_SEGMENTS_PER_TOPIC, SUMMARY_SHORT_W, SUMMARY_TITLE_MAX, SUMMARY_SAID_MAX, SUMMARY_ANSWERED_MAX, SUMMARY_DONE_MAX, SUMMARY_NEED_MAX, SUMMARY_LESSON_MAX, PHASE_SHORT_W, PHASE_DOING_MAX, PHASE_STATE_MAX, PHASE_EFFECT_MAX, PHASE_PLAN_MAX, PHASE_TRACK_MAX, CHAP_MIN_PHASES, MEMORY_DIGEST_TOKENS } from './cost.mjs';

const TOOL_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1').replace(/\/$/, '');
// derived data lives under out/ so it never reads like source
const DEFAULT_STORE = (TOOL_ROOT + '/out/store').replace(/\\/g, '/');

// Piping into `head`/`wc` closes stdout early; the write then throws EPIPE and
// the process dies with a stack trace instead of just ending.
process.stdout.on('error', (e) => { if (e.code !== 'EPIPE') throw e; });

// 无值旗标：给了就是 true，绝不去吞后面那个 token。
const BOOL_FLAGS = new Set(['full', 'text', 'reset', 'json', 'all', 'missing', 'tasks', 'pending', 'phases', 'digest', 'help', 'open', 'serve', 'stop', 'force', 'list', 'check', 'prepare', 'status', 'retry', 'no-hooks', 'no-shortcut', 'no-open', 'copy', 'uninstall']);

function parseArgs(argv) {
  // 命令不一定是 argv[0]：`convledger --help`、`convledger --store DIR steps` 开头是旗标。
  // 旧写法直接取 argv[0] 当命令名，于是 '--help' 永远进不了用法行那条短路，
  // `--store DIR <cmd>` 更糟——它悄悄拿默认 store 跑，报的还是「store 里有 47 个会话」。
  const flags = {};
  const pos = [];
  let cmd = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (BOOL_FLAGS.has(key)) { flags[key] = true; continue; }
      flags[key] = argv[i + 1]; i++;
      continue;
    }
    if (cmd === null) { cmd = a; continue; }
    pos.push(a);
  }
  return { cmd, pos, flags };
}

const usage = () => `convledger — 会话结构账本（派生优先：只存账本与锚点，正文回源读）

  convledger index <session.jsonl|session-dir> [--store DIR]   建账本（幂等，可增量重建）
  convledger index --all [--project P] [--limit N]              批量索引全部可见会话（只出统计）
  convledger sessions [--all|--json]                           已建账 / 还没建账的会话：一行一本，带「整理过没有」；--all 全量，--json 含源路径
  convledger projects [--json] [--all]                          项目层：同一 cwd 的会话归一组（默认列全部项目；--all 附未归组与每个项目的会话 id）
  convledger memory [--project <键|名字>] [--json] [--all]       记忆六段：现在到哪（工具复算）＋ 进度/经验/规则/探索（项目）＋ 画像（用户表，跨项目带来源；失效默认剔除，--all 显示原因）
  convledger memory --digest [--class 进度|画像|经验|规则|探索] [--all] [--max N]
                                                             写记忆的素材：阶段/块原话/已证增量/待办请求（默认最近 8 会话，${MEMORY_DIGEST_TOKENS} tok 硬顶，超了整段丢最旧；--class 画像 跨全部项目取材）
  convledger memory --put <file|-> [--scope project|user]      写记忆（G0–G9 全过才落盘；先按当前源重建再核锚点；user 只写画像）
  convledger memory --promote M03 | --unpromote U01            晋升：≥2 个项目里的等价规则合成用户表副本（G8）/ 撤销并回填 promoted_to
  convledger show                                              路由表：所有段的一行索引（1 次调用）
  convledger card S07[,S08]                                    路由卡全文
  convledger body S07[,S08-S11|all] [--text|--full] [--max N] [--after LINE]
                                                             按锚点回源读正文（截断矩阵 + 默认 ${BODY_BUDGET_TOKENS} tok 预算；--max 0 不限，满预算给续读行号）
  convledger prove S07[,S08] [--json]                          写增量的材料：编号句子 + 上游牌子 + 结构事实 + 判据（模型照它写）
  convledger claim S07 --move pivot --topic 把手 --takeaway 一句 --evidence 3,7
  convledger claim --json -                                    批量从 stdin 收 [{segment,move,topic,takeaway,evidence}]；全过才落盘，basis=verified
  convledger branches [--state 已复核] [--json]                 任务支表：每条支的头、段数、四级完成度、落地物、有无被后续任务回读
  convledger steps [--json]                                     块表（＝星图上的块）：第几步、主线还是插曲、句范围、这块解决了什么、回读命令
  convledger brief [--phase N|--chapter N]                    恢复第一跳：写过章就出章模式（每章一行＋目的，只展开最后一章），没章出阶段摘要；--chapter 给该章九格，--phase 给该阶段六格与块表
  convledger hooks                                              推送通路体检：settings.json 挂没挂、宿主实际发过哪些事件、最近一次注入多少 tok
                                                             注册/卸载：node tool/hooks/install.mjs [--probe|--remove]
  convledger digest [--block N] [--tasks] [--phases]             写综述/阶段说明的素材：逐块原话/回复/产物，或全量步表+文档标题清单
  convledger summarise --put <file|->                          写入模型综述（五格/任务题名）；四道闸门全过才落盘并重建
  convledger summarise --missing                               还缺综述的块与主线任务
  convledger phases [--json]                                    阶段表：模型划的连续步区间、六格说明、引用的文档章节
  convledger phases --put <file|->                              写阶段表（边界/覆盖/锚点/引用全过才落盘并重建；--docs-root 覆盖扫描根）
  convledger chapters [--json]                                   章表：连续几十步的「接手一页」（章边界必须落在阶段边界上）
  convledger chapters --digest [--chapter N]                     写一章的素材：该区间阶段六格＋已证规则＋真人请求＋步表＋文档清单（预算 6000 tok）
  convledger chapters --put <file|->                             写章表（{"chapters":[...]} 整表；{"append":true,...} 只接尾章）；九格与边界全过才落盘
  convledger handoff [N|all]                                     给接手人的一页（纯文本，可直接粘进新会话）；默认最后一个已写章
  convledger topics                                             话题表（外挂标签）：已成支的话题、暂挂的、覆盖到哪些段
  convledger label S04 T1 | convledger label S04 --name 把手     给段挂话题：话题名必须逐字出现在该段的已证增量里，否则拒挂不落盘
  convledger rules [--part N] [--json]                          已证 rule 增量汇成清单（可粘进项目链路；新上下文读它就知道要注意什么）
  convledger notes [--json]                                     人写的标注（author=human、basis=human-note，永不参与六条判据）
  convledger requests [--pending] [--json] [--done R01]         地图底部续做框落下的请求；--done 把一条标完成
  convledger lines 113-218                                     直接读源文件行区间
  convledger facts [a.b.c] [--all]                              结构账本摘要（--all 全量；点路径取子块，如 facts boundaries）
  convledger find <文本> [--session ID]                        关键词定位到段与行（能用锚点就别说用它）
  convledger anchors                                           校验所有锚点是否仍可解引用（源没了就对归档校验，行里标 archived）
  convledger archive                                           把源日志逐字归档进账本（map 服务期间每 20s 自动同步；源丢了它还在）
  convledger trace [--reset]                                   本会话的数据访问审计（回补次数）
  convledger map [--port N] [--rebuild SEC] [--open]            确保 hub 在跑，给出本会话画布地址 /s/<id>/（--open 用系统浏览器打开）
  convledger map --stop                                        停掉这个 hub（固定 8765；所有会话共用它）
  convledger url [--copy]                                      确保 hub 在跑，打印会话库地址（--copy 复制到剪贴板）
  convledger outstanding [--json]                              链路自检：还缺哪些综述/题名/阶段/候选/请求
  convledger lessons [--limit N] [--json]                      可复用经验：已写 lesson 的块（新→旧）
  convledger setup [--check] [--build N] [--all] [--no-hooks] [--no-shortcut] [--no-open] [--uninstall]
                                                              新设备一键适配：找宿主、装 Skill/hooks、建最近 20 段账、建快捷方式、起 hub；--uninstall 只撤自己写的东西
  convledger export [--project] [--all] [--list] [--force]     把项目进度/用户画像写进 <项目>/convledger-export/（内容变了才存快照，留 30 份）
  convledger progress --project <键|名字> [--task PT001] [--json]   项目任务进度（只读；未整理时如实说「没有」）
  convledger sync --prepare --project <键> --session <ID>      冻结增量素材与批次身份（不写状态、不推进游标）
  convledger sync --put <文件|-> --project <键> --session <ID>  校验并提交任务/事件/候选（分层回执）
  convledger sync --status --project <键> [--json]             各会话分析位置、待整理、待证候选、最近批次
  convledger sync --retry --project <键>                       重试 outbox 里待发布的记忆（只做机械步骤，不越过闸门）
  convledger sync --dismiss C001 --project <键> [--why 原因]   把失败候选标成 dismissed，相关 outbox 收口

  通用：--session <ID前缀>  --store <DIR>`;

const BACKFILL = new Set(['body', 'lines', 'find', 'prove']);

/**
 * The default `facts` view. The full ledger blob is ~3K tokens and most of it is
 * per-boundary mass accounting — a reader asking "how many calls before the first
 * compaction" should pay 600, not 3,000. `facts --all` still gives everything.
 */
function summarizeFacts(f) {
  return {
    session: { runner: f.session?.runner, source: f.session?.file, segments: f.segments?.total },
    turns: { total: f.turns.total, human: f.turns.human, compactSummaries: f.turns['compact-summary'], zeroContentRate: f.turns.zeroContentRate },
    toolCalls: { total: f.toolCalls.total, byOp: f.toolCalls.byOp, errors: f.toolCalls.errors?.slice(0, 3) },
    boundaries: f.boundaries.map((b) => ({
      line: b.line, trigger: b.trigger, preTokens: b.preTokens, postTokens: b.postTokens,
      messagesSummarized: b.messagesSummarized, durationMs: b.durationMs, region: b.region,
      turnsBefore: b.turnsBefore, toolCallsBefore: b.toolCallsBefore, toolCallsInRegion: b.toolCallsInRegion,
    })),
    fanouts: f.fanouts.map((x) => ({ turn: x.turn, segment: x.segment, calls: x.calls })),
    branches: { total: f.branches.total, hosts: Object.fromEntries(Object.entries(f.branches.hosts).map(([k, v]) => [k, v])) },
    segments: { byKind: f.segments.byKind, toolCallsBySegment: f.segments.toolCallsBySegment, dialogueTokens: f.segments.dialogueTokens, toolTokens: f.segments.toolTokens },
    artifacts: f.artifacts?.slice(0, 10),
    取更多: 'facts --all（全量）· facts boundaries（含上下文构成与配平）· facts wholeFile · facts toolCalls.topNames',
  };
}

function main() {
  const { cmd, pos, flags } = parseArgs(process.argv.slice(2));
  const root = (flags.store ?? DEFAULT_STORE).replace(/\\/g, '/');
  fs.mkdirSync(root, { recursive: true });

  const out = (s) => process.stdout.write(typeof s === 'string' ? s : JSON.stringify(s, null, flags.json ? 1 : 0) + '\n');
  // A caller that can't read the exit code can't tell a hint from a result.
  const fail = (msg) => { out(msg); process.exit(1); };

  if (!cmd || cmd === 'help' || flags.help) return out(usage());

  // 打错命令名时，最不该发生的事是拿到一句跟命令名无关的「store 里有 237 个会话」。
  // 命令表从用法行现取，不另立一份清单——用法行说什么命令有，这里就认什么。
  const known = new Set((usage().match(/convledger ([a-z][a-z-]*)/g) || []).map((s) => s.slice(11)));
  if (!known.has(cmd)) {
    const near = [...known].filter((c) => c.slice(0, 3) === cmd.slice(0, 3) || c.startsWith(cmd)).slice(0, 4);
    return die(1, `未知命令 ${cmd}${near.length ? `（想跑的是：${near.join(' / ')}）` : ''}\n全部用法：convledger help\n`, out);
  }

  if (cmd === 'index') {
    if (flags.all) return indexAll(root, flags, out);
    if (!pos[0]) return fail('需要 session.jsonl 或 session 目录');
    let file = pos[0].replace(/\\/g, '/');
    if (!file.endsWith('.jsonl')) {
      const id = path.basename(file);
      file = path.join(file, id + '.jsonl');
      if (!fs.existsSync(file)) file = path.join(path.dirname(pos[0]), path.basename(pos[0]) + '.jsonl');
    }
    // 给错了文件时要说清"试过哪条路"，别只报一个拼出来的 .jsonl 名字（指着一份 README 建账的人看见的是"找不到 README.md.jsonl"）
    if (!fs.existsSync(file)) return fail(`找不到会话源：${pos[0]}（试过 ${file}；给 <会话>.jsonl，或给装着同名 .jsonl 的会话目录）`);
    const built = build(file, { storeRoot: root });
    const dir = writeStore(root, built);
    const ops = built.ledger.segments.length;
    out(`已建账本 ${built.sessionId}  (runner=${built.ledger.runner}) → ${dir}`);
    out(`  ${ops} 段 · 路由层 ${built.indexTokens + built.cardTokens} tok（index ${built.indexTokens} + 卡 ${built.cardTokens}）`);
    out(`  回合 ${built.facts.turns.total}（其中人类 ${built.facts.turns.human}、零内容 ${built.facts.turns.zeroContent}=${(built.facts.turns.zeroContentRate * 100).toFixed(0)}%）· 工具调用 ${built.facts.toolCalls.total} · 子代理 ${built.facts.branches.total} · 压缩边界 ${built.facts.boundaries.length}`);
    if (built.claimsOverlay.overlay || built.claimsOverlay.dropped) out(`  claims 叠加：保留模型层 ${built.claimsOverlay.overlay} 条，锚点失效丢弃 ${built.claimsOverlay.dropped} 条`);
    // a runner that records compaction without token counts (WorkBuddy) must not read as "省 0%"
    for (const b of built.facts.boundaries) out(b.preTokens == null
      ? `  边界 L${b.line}: ${b.trigger}（该 runner 不记 token 数与耗时，只有事件与摘要）`
      : `  边界 L${b.line}: ${num(b.preTokens)}→${num(b.postTokens)} tok（省 ${(b.compactionRatio * 100).toFixed(0)}%），摘要取代 ${b.messagesSummarized} 条，${(b.durationMs / 1000).toFixed(0)}s`);
    return;
  }

  if (cmd === 'sessions') {
    // 一台机器上可能有两百多本账：默认档只给「挑哪一本」要的那几行，
    // 全量走 --all（纯文本逐行），结构化走 --json（含源路径）。中文键的 JSON 两头不靠，去掉。
    const lib = libraryOf(root);
    const rows = lib.groups.flatMap((g) => g.sessions);
    const avail = listSessions().filter((s) => s.bytes > 20000);
    const have = new Set(rows.map((r) => r.id));
    const fresh = avail.filter((s) => !have.has(s.sessionId));
    if (flags.json) {
      return out({
        counts: lib.counts,
        indexed: rows.map((r) => ({
          id: r.id, runner: r.runner, segments: r.segments, sourceBytes: r.sourceBytes, sourceFile: r.sourceFile,
          builtAt: r.builtAt, live: r.live, idleMin: r.idleMin, organize: r.organize,
        })),
        indexable: avail.map((s) => ({ id: s.sessionId, runner: s.runner, project: s.project, mb: +(s.bytes / 1048576).toFixed(2), mtime: s.mtime, file: s.file, indexed: have.has(s.sessionId) })),
      });
    }
    const orgCell = (r) => {
      const o = r.organize;
      if (!o) return '整理层读不出';
      if (o.level === 'none') return `未整理·${o.blocks} 块`;
      return `${o.level === 'full' ? '已整理' : `欠 ${o.gaps} 项`}·综述 ${o.sums}/${o.blocks}`
        + (o.phases ? `·阶段 ${o.phases}` : '') + (o.titlesOf ? `·题名 ${o.titles}/${o.titlesOf}` : '');
    };
    const line = (r) => `${r.sid8} ${(RUNNER_LABEL[r.runner] || r.runner || '未知').padEnd(12)}`
      + `${String(r.segments).padStart(4)} 段`
      + ` ${(r.sourceBytes / 1048576).toFixed(1).padStart(7)}MB ${r.live ? '在写 ' : '    '}${stamp(r.lastWriteAt).padEnd(12)} ${orgCell(r)}`;
    const fat = (arr, n) => [...arr].sort((a, b) => b.sourceBytes - a.sourceBytes).slice(0, n).map(line);
    const totalMb = (rows.reduce((a, r) => a + r.sourceBytes, 0) / 1048576).toFixed(1);
    const rowsOut = [
      `账本 ${lib.counts.sessions} 本（${lib.groups.map((g) => `${g.label} ${g.count}`).join('、')}）`
      + ` · 源共 ${totalMb}MB · 在写 ${lib.counts.live} · 整理过 ${lib.counts.organized}`
      + (lib.counts.skipped ? ` · ${lib.counts.skipped} 本读不了` : ''),
      flags.all ? `全部 ${rows.length} 本（一行一本；源路径：sessions --json）：`
        : '最肥 8 本（挑目标用；全量：sessions --all · 结构化含源路径：sessions --json）：',
      ...fat(rows, flags.all ? rows.length : 8),
      `还没建账 ${fresh.length} 本（源 >20KB${fresh.length ? '，最肥 5 本）：' : '）：'}`,
      ...fat(fresh.map((s) => ({
        sid8: String(s.sessionId).slice(0, 8), runner: s.runner, segments: 0, sourceBytes: s.bytes,
        live: false, lastWriteAt: s.mtime, organize: null,
      })), 5),
      fresh.length ? '建账：convledger index --all（只建肥的）· 单会话细节：facts --session <前缀>' : '',
    ].filter(Boolean);
    out(rowsOut.join('\n') + '\n');
    return;
  }

  // 项目层是跨会话问题的入口：这段会话属于哪个项目、项目里还有哪些会话、最近走到第几步。
  // 归组规则只有一条——cwd 整串相等；不带 cwd 的账只计数，不塞给任何项目。
  if (cmd === 'projects') {
    const r = projectsOf(root);
    if (flags.json) return out(r);
    const head = `项目 ${r.counts.projects} · 会话 ${r.counts.sessions} / ${r.counts.ledgers} 本账（未归组 ${r.counts.ungrouped}）· live ${r.counts.live} · 段 ${num(r.counts.segments)}`;
    const lines = [head];
    for (const p of r.projects) {
      const live = p.counts.live ? `（live ${p.counts.live}）` : '';
      const step = p.latest.step ? ` · 步${p.latest.step.step}${p.latest.step.mark ? `·${p.latest.step.mark}` : ''}` : '';
      const req = p.counts.requestsPending ? ` · 待办 ${p.counts.requestsPending}` : '';
      lines.push(`${p.key} · ${p.name} · ${p.counts.sessions} 会话${live} · ${num(p.counts.segments)} 段 · 最近 ${stamp(p.lastAt)}${step}${req}`);
      if (flags.all) for (const m of p.members) {
        lines.push(`   ${m.id} ${m.runner} ${m.segments}段 ${stamp(m.lastAt)}${m.live ? ' live' : ''}${m.requestsPending ? ` 待办${m.requestsPending}` : ''}`);
      }
    }
    if (flags.all && r.ungrouped.length) {
      lines.push(`未归组 ${r.ungrouped.length} 本（账本里没有 cwd，不塞进任何项目）：`);
      for (const m of r.ungrouped) lines.push(`   ${m.id} ${m.runner} ${m.segments}段 ${stamp(m.lastAt)}`);
    }
    lines.push(flags.all
      ? '（项目＝cwd 整串相等；--json 全量）'
      : '（--all 附未归组与每个项目的会话 id；--json 全量；项目＝cwd 整串相等）');
    return out(lines.join('\n') + '\n');
  }

  // 项目任务：当前进度由 PT/PM 状态派生；没有整理过就如实说没有，不生成假进度。
  if (cmd === 'progress') {
    let project;
    try { project = pickProjectFor(root, flags); } catch (e) { return fail(String(e.message)); }
    let state;
    try { state = readState(root, project.key).state; } catch (e) { return fail(String(e.message)); }
    const view = projectView(state);

    if (flags.task) {
      const t = view.tasks.find((x) => x.id === flags.task);
      if (!t) return fail(`没有任务 ${flags.task}（convledger progress --project ${project.key} 看清单）`);
      const lines = [
        `${t.id} ${t.short} · ${STATUS_LABEL[t.status]}${t.statusReason ? `（${t.statusReason}）` : ''}`,
        `  目标：${t.title}`,
        `  结果：${t.result ?? '（无）'}`,
        `  欠项：${t.remaining ?? '（无）'}`,
        `  下一步：${t.nextAction ?? '（无）'}`,
        `  验收：${t.acceptance.length ? t.acceptance.map((a) => `${a.id} ${a.result}${a.stale ? '(失效)' : ''} ${a.condition}`).join(' · ') : '（无）'}`,
      ];
      for (const e of view.events.filter((x) => x.taskId === t.id)) lines.push(`  事件 ${e.id} ${e.type} ${e.at}${e.note ? ` · ${e.note}` : ''}`);
      for (const s of t.sourceSessions) lines.push(`  原文：convledger body --session ${String(s).slice(0, 8)}`);
      return out(lines.join('\n') + '\n');
    }

    if (flags.json) return out(view);
    const c = view.counts;
    const lines = [];
    if (!state.tasks.length) {
      lines.push(`项目 ${project.name}（${project.key}）尚未整理为项目任务`);
      lines.push('  会话证据仍在：convledger projects --all · convledger sessions');
      return out(lines.join('\n') + '\n');
    }
    lines.push(`项目 ${project.name}（${project.key}）· 版本 r${state.revision}`);
    lines.push(`  已完成 ${c.project.done} / 纳入范围 ${c.project.inScope} · 进行中 ${c.project.active} · 受阻 ${c.project.blocked} · 待验证 ${c.project.awaiting} · 未知 ${c.project.unknown} · 未开始 ${c.project.planned} · 取消 ${c.project.cancelled}`);
    if (c.unorganized) lines.push(`  待整理材料 ${c.unorganized} 条 · 待证候选 ${c.candidatesPending} 条`);
    for (const m of c.milestones) lines.push(`  ${m.id} ${(view.milestones.find((x) => x.id === m.id) ?? {}).short ?? ''} · 完成 ${m.done}/${m.inScope}`);
    for (const t of view.tasks) {
      const tail = t.status === 'done' ? (t.result ?? '') : t.status === 'blocked' ? `受阻：${t.blocker}` : (t.remaining ?? t.nextAction ?? t.result ?? '');
      lines.push(`  ${t.id} [${STATUS_LABEL[t.status]}] ${t.short}${tail ? ` · ${tail}` : ''}`);
    }
    return out(lines.join('\n') + '\n');
  }

  // 增量闭环的机械段：prepare 冻结素材，put 校验并提交，status 只读。
  // 语义判断在跑命令的 agent 那边；这里不放宽任何证据与版本检查。
  if (cmd === 'sync') {
    let project;
    try { project = pickProjectFor(root, flags); } catch (e) { return die(4, String(e.message), out); }
    if (!project.root) return die(4, `项目 ${project.name} 没有 cwd（未归组），写入口拒绝`, out);
    if (flags.prepare) return syncPrepare(root, project, flags, out);
    if (flags.put) return syncPut(root, project, flags, out);
    if (flags.dismiss) return syncDismiss(root, project, flags, out);
    if (flags.retry) return syncRetry(root, project, flags, out);
    if (flags.status) return syncStatus(root, project, flags, out);
    return fail('sync 需要 --prepare / --put <文件|-> / --retry / --status');
  }

  // 记忆：跨会话的第二层。读取与素材零模型；写只发生在 --put/--promote/--unpromote，
  // 先重建再核锚点，一条不过整批不写（与 claims / summaries / phases 同一纪律）。
  // 项目表收 进度/经验/规则/探索；用户表收 画像（模型写）与晋升来的 规则（G8/G9）。
  // 记忆层写到项目里：<项目>/convledger-export/。源头仍是记忆表，这里只是派生 + 归档。
  if (cmd === 'export') {
    const pickProject = () => pickProjectFor(root, flags);
    if (flags.list) {
      const file = globalIndexFile(root);
      if (!fs.existsSync(file)) return out('还没有任何导出：先 convledger export（或 --all）\n');
      out(fs.readFileSync(file, 'utf8'));
      try {
        const last = JSON.parse(fs.readFileSync(lastRunFile(root), 'utf8'));
        out(`最近一次导出：${last.project?.name ?? '—'}（${last.project?.key ?? '—'}）· ${String(last.at).slice(0, 19).replace('T', ' ')} · ${last.ok ? `写了 ${last.kinds.join(' + ')}` : `没写（${last.skipped?.[0] ?? '原因未记'}）`}\n`);
      } catch { /* 还没有留痕 */ }
      return;
    }
    if (flags['dry-run']) {
      const targets = flags.all ? projectsOf(root, { withSteps: false }).projects.filter((p) => p.root || p.cwd) : [pickProject()];
      for (const p of targets) {
        const dir = exportPaths(p.root || p.cwd).archive;
        const would = prunePreview(dir);
        out('dry-run · ' + p.name + '：合计保留 ' + KEEP_SNAPSHOTS + ' 份，现存 ' + snapshotNames(dir).length + ' 份，将删除 ' + would.length + ' 个' + (would.length ? '：' + would.join(', ') : '（无）') + '\n');
      }
      return;
    }
    if (flags.check) {
      const targets = [];
      if (flags.all) targets.push(...projectsOf(root, { withSteps: false }).projects.filter((p) => p.root || p.cwd));
      else {
        try { targets.push(pickProject()); } catch (e) { return fail(String(e?.message ?? e)); }
      }
      let bad = 0;
      for (const p of targets) {
        const r = checkExports(root, p);
        out(`# ${p.name}（${p.key}）${r.error ? ` · ${r.error}` : ''}\n`);
        for (const x of r.items) {
          const tag = x.status === 'fresh' ? '✓ 新鲜' : x.status === 'stale' ? '✗ 过期' : x.status === 'missing' ? '✗ 缺失' : '? 不是本工具生成的';
          out(`  ${tag} ${path.basename(x.file)}${x.status === 'fresh' ? '' : `（现在 fp=${x.fp}${x.prevFp ? `，文件 fp=${x.prevFp}` : ''}；跑 convledger export）`}\n`);
        }
        if (!r.ok) bad++;
      }
      if (bad) process.exitCode = 1;
      return;
    }
    if (flags.all) {
      const all = projectsOf(root, { withSteps: false }).projects.filter((p) => p.root || p.cwd);
      let done = 0; let wrote = 0; const skipped = [];
      for (const p of all) {
        const r = writeProjectExports(root, p, { force: !!flags.force, prune: true });
        if (r.files.length) { done++; wrote += r.files.length; } else skipped.push(...r.skipped);
      }
      out(`✓ ${done}/${all.length} 个项目已刷新（写 ${wrote} 份）${skipped.length ? ` · 其余跳过 ${skipped.length} 条（首个：${skipped[0]}）` : ''}\n`);
      return;
    }
    let project;
    try { project = pickProject(); } catch (e) { return fail(String(e?.message ?? e)); }
    const r = writeProjectExports(root, project, { force: !!flags.force, prune: true });
    if (flags.json) return out({ ok: r.ok, project: { key: project.key, name: project.name, cwd: project.cwd }, dir: r.dir, files: r.files, skipped: r.skipped, pruned: r.pruned });
    for (const f of r.files) out(f.kind === 'notes'
      ? `✓ ${path.basename(f.path)} → ${f.path}（${f.bytes} 字节）\n`
      : `✓ ${path.basename(f.path)} → ${f.path}（${f.bytes} 字节 · 快照 archive/${path.basename(f.archive)}）\n`);
    for (const s of r.skipped) out(`- ${s}\n`);
    if (!r.files.length) out('（内容没变，没有写文件）\n');
    const hard = r.skipped.filter((s) => /不覆盖|写不了|目录不在/.test(s));
    if (hard.length && !r.files.length) process.exitCode = 1;
    return;
  }

  if (cmd === 'memory') {
    const pickProject = () => pickProjectFor(root, flags);
    const writeIntents = ['put', 'promote', 'unpromote', 'export'].filter((k) => k in flags);
    if (writeIntents.length > 1) return fail(`一次只做一件事：${writeIntents.map((k) => `--${k}`).join(' / ')} 不能同时给`);

    if ('export' in flags) {
      return fail('memory --export 已取消（不做笔记软件导出）：导出改成项目里的 convledger-export/，用 convledger export 或 convledger export --all');
    }

    // 记忆写入成功后刷新项目里的导出；失败只打一行，绝不让记忆写入失败。
    const refreshExports = (project) => {
      try {
        const r = writeProjectExports(root, project);
        if (r.files.length) out(`  导出已刷新（${path.basename(r.dir)}/）：${r.files.map((f) => path.basename(f.path)).join(' + ')}${r.pruned.length ? ` · 删旧快照 ${r.pruned.length}` : ''}\n`);
        else if (r.skipped.length) out(`  （导出未刷新：${r.skipped[0]}）\n`);
      } catch (e) {
        out(`  （导出未刷新：${String(e?.message ?? e).split('\n')[0]}）\n`);
      }
    };
    const tryProject = () => { try { return pickProject(); } catch { return null; } };

    if (flags.promote) {
      const project = pickProject();
      const r = promoteEntry(root, project, flags.promote);
      if (!r.ok) {
        for (const e of r.errors) out(`✗ ${e}\n`);
        process.exitCode = 1;
        return out('未晋升：没有写任何文件\n');
      }
      out(`✓ 已晋升 ${r.uid}（${r.action === 'added' ? '新建' : '刷新'}）· 来源 ${r.sources.length} 个项目：${r.sources.map((s) => `${s.name}:${s.id}`).join(' · ')}\n`);
      out(`  证据合并后 ${r.evidence} 条 · 各来源条目 promoted_to=global · 重建 ${r.built.rebuilt.length} 本账本${r.built.skipped.length ? `，源不在跳过 ${r.built.skipped.length} 本` : ''} · basis=model（不是 verified）\n`);
      refreshExports(project);
      return;
    }

    if (flags.unpromote) {
      const r = unpromoteEntry(root, flags.unpromote);
      if (!r.ok) {
        for (const e of r.errors) out(`✗ ${e}\n`);
        process.exitCode = 1;
        return out('未撤销：没有写任何文件\n');
      }
      out(`✓ 已撤销 ${r.uid} · promoted_to 回 null：${r.cleared.map((x) => `${x.name}:${x.id}`).join(' ') || '—'}\n`);
      const p = tryProject();
      if (p) refreshExports(p);
      return;
    }

    if ('put' in flags) {
      const scope = String(flags.scope ?? 'project').trim() || 'project';
      if (scope !== 'project' && scope !== 'user') return fail('--scope 要是 project 或 user');
      if (!flags.put) return fail('用法: memory --put <file|->（{"entries":[…]}}）；--scope user 只写画像');
      let raw;
      if (flags.put === '-') {
        try { raw = fs.readFileSync(0, 'utf8'); } catch { return fail('memory --put - 要从管道收 JSON'); }
      } else {
        if (!fs.existsSync(flags.put)) return fail(`找不到 ${flags.put}`);
        raw = fs.readFileSync(flags.put, 'utf8');
      }
      let payload;
      try { payload = JSON.parse(raw); } catch (e) { return fail(`记忆 JSON 解析不了：${String(e.message).split('\n')[0]}`); }
      const entries = Array.isArray(payload) ? payload : Array.isArray(payload?.entries) ? payload.entries : [];
      if (!entries.length) return fail('记忆是空的：要 {"entries":[{class,topic,text,evidence}]}');
      const project = scope === 'project' ? pickProject() : null;
      const r = scope === 'user' ? putUserMemories(root, entries) : putProjectMemories(root, project, entries);
      if (!r.ok) {
        for (const e of r.errors) out(`✗ ${e}\n`);
        process.exitCode = 1;
        return out(`未落盘：${entries.length} 条没过闸门（过了的也没写）\n`);
      }
      const fresh = applyFreshness(scope === 'user' ? userContext(root) : memoryContext(root, project), r.entries);
      out(`✓ ${scope === 'user' ? '用户' : '项目'}记忆已落盘 → ${r.dir}\n`);
      out(`  新增 ${r.added.join(' ') || '—'} · 修订 ${r.revised.join(' ') || '—'} · 重建 ${r.built.rebuilt.length} 本账本${r.built.skipped.length ? `，源不在跳过 ${r.built.skipped.length} 本（按归档账本校验）` : ''}\n`);
      out(`  ${r.entries.length} 条里重建后仍新鲜 ${fresh.live.length}${fresh.stale.length ? `，失效 ${fresh.stale.length}（${fresh.stale.map((e) => e.id).join(' ')}）` : ''} · basis=model（不是 verified）\n`);
      const p = scope === 'user' ? tryProject() : project;
      if (p) refreshExports(p);
      return;
    }

    if (flags.digest) {
      const cls = String(flags.class ?? '').trim();
      const max = flags.max != null ? +flags.max : MEMORY_DIGEST_TOKENS;
      if (!Number.isFinite(max) || max < 500) return fail('--max 要 ≥500 tok');
      if (cls === '画像') {
        if (flags.all) return fail('--all 只对项目素材有效；画像素材固定取最近 8 个会话');
        return out(digestUserMaterials(root, { max }).text);
      }
      if (cls && !MEMORY_CLASSES.includes(cls)) return fail(`--class 要是 进度/画像/经验/规则/探索，收到「${cls}」`);
      const project = pickProject();
      return out(digestMaterials(root, project, { all: !!flags.all, max }).text);
    }

    const project = pickProject();
    const r = memoryRead(root, project, { all: !!flags.all });
    if (flags.json) {
      return out({
        schema: 'convledger-memory/1',
        project: { key: project.key, name: project.name, root: project.root, sessions: project.counts.sessions, firstAt: project.firstAt, lastAt: project.lastAt },
        now: r.now, counts: r.counts, entries: r.entries, stale: r.stale,
        user: { entries: r.user.live, stale: r.user.stale },
      });
    }
    return out(r.text);
  }

  if (cmd === 'anchors') {
    const { ledger } = loadSession(root, flags, out);
    // 源被运行器清掉后，锚点对归档校验：没断，但「校的是归档」这件事必须写在行里
    const ef = effectiveSource(ledger);
    const rows = ledger.segments.map((s) => {
      const a = checkAnchor(ledger, s, ef);
      return { id: s.id, anchor: s.anchor, ok: a.ok, hash: a.recorded, nowBytes: a.bytes, ...(a.archived ? { archived: true } : {}), ...(a.missing ? { missing: true } : {}) };
    });
    trace(root, ledger.sessionId, 'anchors', ef.archived ? { source: 'archive' } : {}, {});
    return out(rows);
  }

  if (cmd === 'archive') {
    const { ledger, dir } = loadSession(root, flags, out);
    const before = archiveState(dir);
    const st = syncArchive(dir, ledger.sourceFile);
    trace(root, ledger.sessionId, 'archive', {}, { tokens: 0 });
    return out({
      session: ledger.sessionId, 归档: st.exists ? st.bytes : 0,
      新增: st.exists ? st.bytes - before.bytes : 0,
      同步于: st.syncedAt, 源: ledger.sourceFile,
      ...(st.bytes ? {} : { 说明: '源日志读不到，也没有既有归档——这段会话没有可归档的正文' }),
    });
  }

  if (cmd === 'trace') {
    const { ledger } = loadSession(root, flags, out);
    if (flags.reset) { fs.rmSync(path.join(storeDir(root, ledger.sessionId), 'trace.jsonl'), { force: true }); return out(`审计已清空：${ledger.sessionId}`); }
    const ops = readTrace(root, ledger.sessionId);
    const byOp = ops.reduce((a, o) => { a[o.op] = (a[o.op] ?? 0) + 1; return a; }, {});
    const backfill = ops.filter((o) => BACKFILL.has(o.op));
    const route = ops.filter((o) => !BACKFILL.has(o.op));
    const detail = ops.map((o) => `${o.ts.slice(11, 19)} ${o.op} ${o.spec ?? o.query ?? ''} → ${o.tokens ?? 0}t${o.warnings ? ' ⚠锚点断' : ''}`);
    out({
      session: ledger.sessionId, ops: ops.length,
      byOp,
      回补次数: backfill.filter((o) => o.op !== 'find').length,
      定位搜索次数: backfill.filter((o) => o.op === 'find').length,
      路由层调用: route.length,
      读回tokens: backfill.reduce((a, o) => a + (o.tokens ?? 0), 0),
      // 一条 trace 曾经把 400+ 行明细整份吐出来（≈8K tok）：审计是来看结论的，不是来看流水账的。
      明细: flags.all || detail.length <= 20
        ? detail
        : [`（明细共 ${detail.length} 条，只列最近 20 条；全量：convledger trace --all）`, ...detail.slice(-20)],
    });
    return;
  }

  // Bad flags are the more specific error than "which session?", so check them
  // before touching the store.
  if (cmd === 'map') {
    const port0 = flags.port === undefined ? 8765 : +flags.port;
    const rebuildSec = flags.rebuild === undefined ? 20 : +flags.rebuild;
    if (!Number.isInteger(port0) || port0 < 1024 || port0 > 65535) return fail(`--port 要是一个 1024-65535 的整数，收到 ${flags.port}`);
    if (!Number.isFinite(rebuildSec) || rebuildSec < 0) return fail(`--rebuild 要是一个不小于 0 的秒数（0 = 只服务不重建），收到 ${flags.rebuild}`);
    const openBrowser = (url) => {
      const [c, a] = process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      try { spawn(c, a, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); }
      catch { /* 开不了浏览器不影响把地址打印出来 */ }
    };

    // --stop：只认 pid 文件；没有就说没有，不假装停过。
    if (flags.stop) {
      const f = hubFile(root);
      let info = null;
      try { info = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* 没有 pid 文件 */ }
      if (!info?.pid) return fail(`没有在跑的 hub（${f} 不存在或读不了）`);
      try { process.kill(info.pid); } catch (e) { return fail(`pid ${info.pid} 停不了：${e.code ?? e.message}（可能已经退出）`); }
      out(`✓ 已停 hub（pid ${info.pid} · 端口 ${info.port}）`);
      return;
    }

    // --serve：前台跑 hub（内部入口，也可用作开机自启）。
    if (flags.serve) {
      serveMap({ root, port: port0, rebuildSec, pidFile: hubFile(root) })
        .then((h) => out(h.reused
          ? `hub 已经在 ${h.port} 上跑着（pid 记在 ${hubFile(root)}） · 没有另起第二个`
          : `hub 起来了 → http://127.0.0.1:${h.port}/ · pid ${process.pid} · 所有会话共用这一个地址 · Ctrl-C 停`))
        .catch((e) => fail(`起 hub 失败：${String(e?.message ?? e).split('\n')[0]}`));
      return;
    }

    // 默认：ensure hub，再把「本会话那一张」的地址给出去。
    const cur = resolveCurrent({ root, cwd: process.cwd(), preferred: flags.session });
    if (cur.error) return fail(cur.error);
    const dir = storeDir(root, cur.sessionId);
    if (!fs.existsSync(path.join(dir, 'ledger.json'))) {
      if (!cur.file) return fail(`会话 ${cur.sessionId.slice(0, 8)} 源文件和账本都没有，成不了图`);
      try { writeStore(root, build(cur.file, { storeRoot: root })); }
      catch (e) { return fail(`建账失败：${String(e?.message ?? e).split('\n')[0]}`); }
    }
    const ensureHub = async () => {
      const h = await probeHub(port0);
      if (h) return { port: h.port ?? port0, reused: true };
      const args = [process.argv[1], 'map', '--serve', '--port', String(port0), '--rebuild', String(rebuildSec)];
      if (flags.store) args.push('--store', root);
      // detached + unref：hub 不随调用它的 agent/终端退出。生命周期是 map --stop / 重启机器。
      const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd: TOOL_ROOT });
      child.unref();
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const hh = await probeHub(port0, { tries: 1, timeout: 800 });
        if (hh) return { port: hh.port ?? port0, reused: false };
      }
      throw new Error(`hub 没能在 ${port0} 上起来：端口可能被别的程序占着（先腾出来，或换 --port）`);
    };
    ensureHub().then(({ port, reused }) => {
      const url = `http://127.0.0.1:${port}/s/${cur.sessionId}/`;
      let led = {};
      try { led = JSON.parse(fs.readFileSync(path.join(dir, 'ledger.json'), 'utf8')); } catch { /* 横幅少几格 */ }
      const arc = archiveState(dir);
      const started = when(led.builtAt);
      out(`${reused ? 'hub 复用' : 'hub 新起'} → ${url}`
        + ` · 会话 ${cur.sessionId.slice(0, 8)} · ${led.runner ?? cur.runner ?? '?'} · ${led.cwd ?? cur.cwd ?? '—'}`
        + `${started ? ` · 账本 ${started}` : ''} · ${(led.segments ?? []).length} 段 · 归档 ${kb(arc?.bytes ?? 0)}`
        + ` · 所有会话共用这一个 hub（/ 是会话库，左栏也能换） · 页面每 4s 重读${rebuildSec > 0 ? `，账本每 ${rebuildSec}s 按需重建` : '，账本不重建（--rebuild 0）'}`
        + ` · Agent 内请用宿主浏览器面板打开（别加 --open，它只开系统浏览器）`);
      if (flags.open) openBrowser(url);
    }).catch((e) => fail(`起 hub 失败：${String(e?.message ?? e).split('\n')[0]}`));
    return;
  }

  if (cmd === 'url') {
    const port0 = flags.port === undefined ? 8765 : +flags.port;
    ensureHub(root, port0).then((hub) => {
      if (!hub) return fail(`hub 没能在 ${port0} 上起来`);
      const u = `http://127.0.0.1:${hub.port}/`;
      out(`${u}\n`);
      if (flags.copy) {
        const c = copyText(`${u}\n`);
        out(c.ok ? '✓ 已复制到剪贴板（会话库地址）\n' : `! 没复制成：${c.reason}\n`);
      }
    }).catch((e) => fail(`取地址失败：${String(e?.message ?? e).split('\n')[0]}`));
    return;
  }

  if (cmd === 'outstanding') {
    const cur = resolveCurrent({ root, cwd: process.cwd(), preferred: flags.session });
    if (cur.error) return fail(cur.error);
    const dir = storeDir(root, cur.sessionId);
    if (!fs.existsSync(path.join(dir, 'ledger.json'))) return fail(`会话 ${cur.sessionId.slice(0, 8)} 还没建账：convledger index <源>`);
    let o;
    try { o = outstandingFor({ storeRoot: root, sessionId: cur.sessionId, cwd: cur.cwd }); }
    catch (e) { return fail(`自检读不了账本：${String(e?.message ?? e).split('\n')[0]}`); }
    if (flags.json) return out(o);
    const liveNote = o.liveTail && o.liveBlocks?.length
      ? `当前步：第 ${o.liveTail.from} 步 · 块 ${o.liveBlocks.join(',')} 待收口；收口后再补综述/阶段\n`
      : '';
    if (o.ok) {
      out(`没有发现欠项（${o.blocks} 块 · 会话 ${cur.sessionId.slice(0, 8)}）\n`);
      if (liveNote) out(liveNote);
      return;
    }
    out(`链路欠项（会话 ${cur.sessionId.slice(0, 8)} · 项目 ${o.project ?? '—'}）：\n`);
    for (const x of o.items) out(`  - ${x}\n`);
    if (liveNote) out(liveNote);
    out('补法：综述 digest --block N → summarise --put；题名 summarise --put；阶段 digest --phases → phases --put；章 chapters --digest → chapters --put；候选 memory；请求 requests --pending\n');
    return;
  }

  if (cmd === 'lessons') {
    const cur = resolveCurrent({ root, cwd: process.cwd(), preferred: flags.session });
    if (cur.error) return fail(cur.error);
    const dir = storeDir(root, cur.sessionId);
    if (!fs.existsSync(path.join(dir, 'ledger.json'))) return fail(`会话 ${cur.sessionId.slice(0, 8)} 还没建账：convledger index <源>`);
    const asked = Number(flags.limit ?? 20);
    const limit = Number.isFinite(asked) && asked > 0 ? asked : 20;
    let r;
    try { r = lessonsOf(dir, { limit }); }
    catch (e) { return fail(`经验读不了账本：${String(e?.message ?? e).split('\n')[0]}`); }
    if (flags.json) return out(r);
    if (!r.rows.length) return out(`还没有写过 lesson（${cur.sessionId.slice(0, 8)}）：收尾写块综述时补 lesson 格\n`);
    out(`可复用经验（本会话 ${r.total} 条，显示 ${r.rows.length} 条 · ${cur.sessionId.slice(0, 8)}）：\n`);
    for (const x of r.rows) {
      out(`  第 ${x.step ?? '—'} 步 · 块 ${x.block}${x.title ? ' · ' + x.title : ''}\n`);
      out(`    经验：${x.lesson}\n`);
      if (x.need) out(`    当时的要求：${x.need}\n`);
      out(`    回读：convledger body ${x.from ?? ''} --session ${cur.sessionId.slice(0, 8)}\n`);
    }
    return;
  }

  if (cmd === 'setup') {
    runSetup(root, flags, out).catch((e) => {
      out(`✗ setup 失败：${String(e?.message ?? e).split('\n')[0]}`);
      process.exit(1);
    });
    return;
  }

  if (cmd === 'hooks') {
    // 推送通路是可查的，不靠印象：注册状态 + 宿主实际发过哪些事件，一次看全。
    // 两个宿主各有一份用户级 settings.json，注册状态必须分别看：Qoder 的条目靠 name 前缀认，
    // WorkBuddy 的 handler 没有 name 字段（它只吃 {type, command, timeout}），靠命令行里的本仓脚本路径认。
    const confDirs = [
      ['qoder', (process.env.QODER_CONFIG_DIR || path.join(os.homedir(), '.qoder')).replace(/\\/g, '/')],
      ['workbuddy', (process.env.WORKBUDDY_CONFIG_DIR || path.join(os.homedir(), '.workbuddy')).replace(/\\/g, '/')],
    ];
    const registered = [];
    const settingsErrs = [];
    const ours = (h) => String(h?.name || '').startsWith('convledger-')
      || /ledger-brief\.mjs/.test(String(h?.command || '').replace(/\\/g, '/'));
    for (const [host, dir] of confDirs) {
      const file = `${dir}/settings.json`;
      try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const [ev, defs] of Object.entries(j.hooks || {})) {
          for (const d of defs || []) for (const h of d.hooks || []) {
            if (ours(h)) registered.push(`${host} ${ev}${d.matcher ? `(${d.matcher})` : ''} → ${h.name || 'ledger-brief'}`);
          }
        }
      } catch (e) { settingsErrs.push(`${file} 读不到：${e.code || e.message}`); }
    }
    const logFile = (process.env.CONVLEDGER_HOOK_LOG || `${TOOL_ROOT}/out/hook-probe.jsonl`).replace(/\\/g, '/');
    const rows = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      : [];
    const seen = {};
    for (const r of rows) seen[r.event] = (seen[r.event] || 0) + 1;
    const origins = {};
    for (const r of rows) origins[String(r.origin || 'legacy')] = (origins[String(r.origin || 'legacy')] || 0) + 1;
    // 「实测通」只认宿主按 settings.json 那行命令行跑出来的留痕；手工喂 stdin（origin=manual）
    // 和打标前的历史行（legacy）一律不算证据——否则自跑几次就能把没验的东西写成验过。
    // 但"那次压缩真发生过"不由我说了算：拿留痕时刻去源日志里找同一时刻的 compact_boundary，
    // 对得上就是宿主发的（trigger 是宿主写进源日志的，manual/auto 一眼分明）。
    const compactMarks = new Map();
    const marksFor = (sid) => {
      if (!sid) return [];
      if (compactMarks.has(sid)) return compactMarks.get(sid);
      let marks = [];
      try {
        const src = readView(path.join(root, sid))?.meta?.sourceFile;
        for (const l of fs.readFileSync(src, 'utf8').split('\n').filter(Boolean)) {
          if (!l.includes('compact_boundary')) continue;
          const j = JSON.parse(l);
          if (j.type === 'system' && j.subtype === 'compact_boundary') marks.push({ at: Date.parse(j.timestamp), trigger: j.compactMetadata?.trigger ?? null });
        }
      } catch { /* 源不可读＝这条留痕无法佐证，判定自然退回"还没取证" */ }
      compactMarks.set(sid, marks);
      return marks;
    };
    const corroborated = (r) => r.event !== 'PostCompact' || marksFor(r.session).some((m) => Math.abs(m.at - Date.parse(r.ts)) <= 120000);
    const post = rows.filter((r) => r.event === 'PostCompact');
    const postReal = post.filter(corroborated);
    const trig = {};
    for (const r of postReal) for (const m of marksFor(r.session)) if (Math.abs(m.at - Date.parse(r.ts)) <= 120000) trig[m.trigger || '未知'] = (trig[m.trigger || '未知'] || 0) + 1;
    const hostRowsOf = (ev) => rows.filter((r) => r.origin === 'host' && r.event === ev);
    const inj = rows.filter((r) => r.action === 'inject');
    const hostPost = hostRowsOf('PostCompact').filter((r) => r.action === 'inject');
    const hostStart = hostRowsOf('SessionStart');
    const selfRun = rows.filter((r) => r.origin !== 'host').length;   // 手工喂 stdin 或打标前的历史行
    const hostRows = rows.length - selfRun;   // 宿主真按注册命令行跑过的次数（args 透传成立的凭据）
    const hostStartInj = hostStart.filter((r) => r.action === 'inject');
    const verdict = hostPost.length
      ? `压缩后事件已实测发出、我们也注入过 ${hostPost.length} 次（最近 ${hostPost[hostPost.length - 1].ts.slice(0, 19).replace('T', ' ')} ${hostPost[hostPost.length - 1].tokens} tok）——但"注进去的文本到了新上下文"这一跳在 PostCompact 上没观测到，压缩后的投递实际走同刻的 SessionStart（见「投递」行）`
      : postReal.length
        ? postReal.some((r) => r.action === 'inject')
          ? `压缩后事件已实测（源日志同刻有 compact_boundary，trigger ${Object.entries(trig).map(([k, v]) => `${k}=${v}`).join(' ')}），注入过 ${postReal.filter((r) => r.action === 'inject').length} 次——那是打来源标记之前的历史行，按 legacy 计，不作当前判据`
          : `压缩后事件已实测发出但没注进去：${postReal.length} 行 PostCompact 与源日志的 compact_boundary 同刻（±120s，trigger ${Object.entries(trig).map(([k, v]) => `${k}=${v}`).join(' ')}），全部被去重挡掉（原因见 reason 字段）——通路通，推送那一步还没成`
        : hostStart.length
          ? `压缩后推送还没取证：宿主已真发过 SessionStart ${hostStart.length} 次（通路活着），但 PostCompact 一次都没观测到——要等下一次真压缩`
          : `压缩后推送还没取证（宿主发的 PostCompact 注入 0 次；留痕 ${rows.length} 行里 ${selfRun} 行是手工喂 stdin 或打标前的历史，不算宿主触发）`
            + (hostRows ? `　宿主已按注册命令行跑过 ${hostRows} 次＝args 透传成立，origin=host 是可信凭据` : '');
    out([
      `注册：${registered.length ? registered.join(' · ') : `没挂（${settingsErrs.join('；') || 'settings.json 里没有 convledger- hook'}）`}`,
      `留痕：${logFile} 共 ${rows.length} 行；事件分布 ${Object.entries(seen).map(([k, v]) => `${k || 'null'}=${v}`).join(' ') || '（空）'}；来源 ${Object.entries(origins).map(([k, v]) => `${k}=${v}`).join(' ') || '（空）'}`,
      `压缩对照：源日志里与该次事件同刻（±120s）的 compact_boundary ${postReal.length} 次（PostCompact 留痕共 ${post.length} 行）${Object.keys(trig).length ? `；trigger ${Object.entries(trig).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''}`,
      `注入：${inj.length ? `${inj.length} 次（${Object.entries(inj.reduce((a, r) => { const k = String(r.origin || 'legacy'); a[k] = (a[k] || 0) + 1; return a; }, {})).map(([k, v]) => `${k}=${v}`).join(' ')}），最近 ${inj[inj.length - 1].ts.slice(0, 19).replace('T', ' ')} ${inj[inj.length - 1].tokens} tok / ${inj[inj.length - 1].ms}ms` : '还没有一次真注入被留痕（PostCompact 未被观测＝宿主没发这个事件，或压缩还没发生）'}`,
      // 「脚本返回了 additionalContext」和「模型看见了这段话」是两件事，判定不许用前者冒充后者。
      // 后者要第三方证据：2026-10-27 10:15 一个全新会话把注入的 brief 逐字复述了出来（会话 demo0004）；
      // 而 10:07:59 那次压缩后的新上下文里没有 PostCompact 注入的文本——同刻的 SessionStart 才是投递那一跳。
      `投递：${hostStartInj.length
        ? `SessionStart 真发并注入 ${hostStartInj.length} 次（其中 ${hostStartInj.filter((r) => r.foreign).length} 次是给新会话借读上一段账本）；2026-10-27 10:15 独立会话逐字复述过注入文本＝这一跳通；PostCompact 的注入在压缩后新上下文里没观测到`
        : '未取证：宿主真发并注入过的 SessionStart 有 0 次——"注进去的文本到了模型上下文"这一跳还没有凭据'}`,
      `判定：${verdict}`,
    ].join('\n') + '\n');
    return;
  }

  const { ledger, dir } = loadSession(root, flags, out);
  const sid = ledger.sessionId;

  if (cmd === 'brief') {
    const v = readView(dir);
    if (flags.chapter != null) {
      const n = Number(flags.chapter);
      if (!Number.isInteger(n) || n < 1) return fail('用法: brief --chapter <1..K>（章号见 brief 头部；没写过章先 chapters --digest）');
      const r = chapterDetailText(v, n);
      if (r.error) return fail(r.error);
      trace(root, sid, 'brief', { chapter: n }, { tokens: tok(r.text), chapters: v.chapters.length });
      return out(r.text);
    }
    if (flags.phase != null) {
      const n = Number(flags.phase);
      if (!Number.isInteger(n) || n < 1) return fail('用法: brief --phase <1..K>（阶段号见 brief 头部）');
      const text = phaseDetailText(v, n);
      if (text.error) return fail(text.error);
      trace(root, sid, 'brief', { phase: n }, { tokens: tok(text), phases: v.phases.length });
      return out(text);
    }
    const { rows } = readRequests(dir);
    const base = briefText(v, rows);
    const pl = projectBriefLine(root, v.meta?.cwd);
    const text = pl ? `${base}
${pl}` : base;
    trace(root, sid, 'brief', {}, { tokens: tok(text), phases: v.phases.length });
    return out(text);
  }

  if (cmd === 'show') {
    trace(root, sid, 'show', {}, { tokens: tok(fs.readFileSync(path.join(dir, 'index.md'), 'utf8')) });
    return out(fs.readFileSync(path.join(dir, 'index.md'), 'utf8'));
  }

  if (cmd === 'card') {
    const segs = resolveSegments(ledger, pos[0]);
    const text = segs.map((s) => fs.readFileSync(path.join(dir, 'segments', `${s.id}.md`), 'utf8')).join('\n');
    trace(root, sid, 'card', { spec: pos[0] }, { tokens: tok(text) });
    return out(text);
  }

  if (cmd === 'body') {
    const segs = resolveSegments(ledger, pos[0]);
    const max = flags.max ? +flags.max : BODY_BUDGET_TOKENS;
    const after = flags.after ? +flags.after : 0;
    const r = renderBody(ledger, segs, { text: flags.text, full: flags.full, max, after });
    trace(root, sid, 'body', { spec: pos[0], mode: flags.full ? 'full' : flags.text ? 'text' : 'matrix', max, after }, { tokens: r.tokens, bytes: r.bytes, segments: r.segments, warnings: r.warnings.length, stopped: r.stopped ? `${r.stopped.segment}@L${r.stopped.line}` : null });
    return out(r.text + (r.warnings.length ? `\n${r.warnings.join('\n')}` : ''));
  }

  // Proving an increment means handing over the segment's own prose, so it is a
  // back-fill and is audited as one; the per-segment sentence cap is the budget.
  if (cmd === 'prove') {
    const claims = readClaims(dir);
    const segs = resolveSegments(ledger, pos[0]);
    if (flags.json) {
      const parts = segs.map((s) => proveInput(ledger, s, claims));
      trace(root, sid, 'prove', { spec: pos[0], mode: 'json' }, { tokens: tok(JSON.stringify(parts)), segments: segs.map((s) => s.id) });
      return out(parts);
    }
    let used = 0;
    const shown = [];
    let stoppedAt = -1;
    for (let i = 0; i < segs.length; i++) {
      const text = renderProve(proveInput(ledger, segs[i], claims));
      // the same discipline as body: stop at a segment boundary and say where
      if (shown.length && used + tok(text) > BODY_BUDGET_TOKENS) { stoppedAt = i; break; }
      used += tok(text);
      shown.push(text);
    }
    const text = shown.join('') + (stoppedAt >= 0
      ? `\n…[到预算 ${BODY_BUDGET_TOKENS} tok 停了：已给 ${stoppedAt}/${segs.length} 段，剩下的：convledger prove ${segs.slice(stoppedAt).map((s) => s.id).join(',')}]\n`
      : '');
    trace(root, sid, 'prove', { spec: pos[0] }, { tokens: tok(text), segments: shown.length });
    return out(text);
  }

  if (cmd === 'claim') {
    const items = readClaimInput(pos, flags, fail, out);
    const claims = readClaims(dir);
    const verified = {};
    const rows = [];
    for (const it of items) {
      const segList = it.segment ? resolveSegments(ledger, String(it.segment)) : [];
      if (segList.length !== 1) { rows.push({ segment: it.segment ?? '（缺）', ok: false, errors: [`segment 要正好指到一段，收到 ${it.segment ?? '（空）'}`] }); continue; }
      const seg = segList[0];
      const mine = claims[seg.id];
      const prevEntry = mine && mine.author !== RULE_AUTHOR ? mine : claims[prevSegmentId(ledger, seg.id)];
      const m = materials(ledger, seg, prevEntry ? { takeaway: prevEntry.text } : null);
      const r = validateClaim(it, m);
      rows.push({ segment: seg.id, ok: r.ok, ...(r.revision ? { revision: true } : {}), errors: r.errors, ...(r.ok ? { takeaway: r.takeaway } : {}) });
      if (r.ok) {
        verified[seg.id] = { text: r.takeaway, moves: r.move, topic: r.topic, evidence: r.evidence, basis: 'verified', ...(r.revision ? { revision: true } : {}), author: it.author ?? flags.author ?? 'model-layer', segmentHash: checkAnchor(ledger, seg).now };
      }
    }
    const bad = rows.filter((x) => !x.ok);
    if (bad.length) {
      // All-or-nothing: a half-written claims layer would make the cards claim a
      // semantic coverage the session does not have.
      for (const x of bad) out(`✗ ${x.segment}: ${x.errors.join(' · ')}`);
      out(`未落盘：${bad.length}/${rows.length} 条没过判据（过了的也没写）`);
      process.exitCode = 1;
      return;
    }
    const merged = { ...claims, ...verified };
    fs.writeFileSync(path.join(dir, 'claims.json'), JSON.stringify(merged, null, 1));
    const built = build(ledger.sourceFile, { storeRoot: root });
    const newDir = writeStore(root, built);
    const kept = Object.keys(verified).filter((id) => built.claims[id]?.basis === 'verified').length;
    out(`✓ ${kept} 条增量已证并落盘 → ${newDir}`);
    out(`  claims 叠加 ${built.claimsOverlay.overlay} 条（锚点失效丢弃 ${built.claimsOverlay.dropped}）· 卡上 增量 行现在是 basis=verified`);
    return;
  }

  // Task branches: pure structure off the ledger, so it prices like a route read
  // and never re-reads a body. The four levels are evidence gates, not a score —
  // a percentage would be a self-report wearing numbers.
  if (cmd === 'branches') {
    const v = readView(dir);
    const all = v.tasks;
    const want = flags.state ? all.filter((b) => b.stateLabel === flags.state || b.state === flags.state) : all;
    if (!flags.state && !flags.json) {
      const covered = all.reduce((a, b) => a + b.segs, 0);
      const dist = BRANCH_STATES.map((s) => `${s.label}${v.meta.taskStates[s.id] ?? 0}`).join(' ');
      const head = `支 ${all.length} · ${dist} · 覆盖 ${covered}/${v.meta.segs} 段${v.meta.topicBranches ? ` · 话题支 ${v.meta.topicBranches}` : ''}`;
      const rows = want.map((b) => `${b.id} ${b.stateLabel.padEnd(3)} ${b.head} 段${String(b.segs).padStart(2)} 已证${b.verified} 写${b.wrote}${b.readBack ? ` ←${b.readBack.at}回读${b.readBack.file}` : ''}${b.blocked ? ' ⚠受阻' : ''} ${b.span} | ${b.title.slice(0, 44)}`);
      const text = [head, ...rows, want.length > 24 ? '（按级筛：branches --state 已落地｜明细：branches --json）' : ''].filter(Boolean).join('\n') + '\n';
      trace(root, sid, 'branches', { state: flags.state ?? null }, { tokens: tok(text), branches: want.length });
      return out(text);
    }
    const text = JSON.stringify(want, null, flags.json ? 1 : 0) + '\n';
    trace(root, sid, 'branches', { state: flags.state ?? null, mode: 'json' }, { tokens: tok(text), branches: want.length });
    return out(want);
  }

  // 块层是 Agent 恢复记忆的第一跳：一次读到"第几步、主线还是插曲、这块解决了什么、
  // 去哪回读正文"，正文一个字都不拖。定价按"每块一行"断言速率，不断言绝对总额
  // ——绝对总额会随会话变长自己把自己测红（这条雷在本项目炸过一次）。
  if (cmd === 'steps') {
    const v = readView(dir);
    if (flags.json) {
      const text = JSON.stringify(v.steps, null, 1) + '\n';
      trace(root, sid, 'steps', { mode: 'json' }, { tokens: tok(text), steps: v.steps.length });
      return out(v.steps);
    }
    const side = v.links.filter((l) => l.host).length;
    const head = `块 ${v.steps.length} · 主线步 ${v.mainSteps} · 插曲支 ${side} 条 · 已证增量 ${v.meta.verified}/${v.meta.segs} 段（其余块只有结构，没有过判据的话可说）`;
    // 两块各印一句：「要干什么」＝块内第一句真人原话的前缀，「解决了什么」＝已证增量或产物。
    // 截断一律走 clip（子句边界），不用 .slice——硬切会在半句上断，那条 16 字钩子就是这么来的。
    // 没有步号的块不是"缺编号"：印出它夹在哪两步之间（afterStep↔beforeStep），
    // 判据在 src/view.mjs 里是数出来的，这里只原样取用。
    const stepCell = (s) => (s.step ? `步${s.step}` : `插${s.afterStep ?? '?'}↔${s.beforeStep ?? '?'}`);
    const roleCell = (s) => s.role + (s.bridge ? `·${s.bridge.b}` : '')
      + (s.step === null && s.afterStep != null && s.beforeStep != null ? `·夹在步${s.afterStep}↔${s.beforeStep}之间` : '');
    // 没有综述时 mark（远景标题）与 gist（中景标题）取自同一句提问：并排印就是
    // 「也就是说｜也就是说」这种结巴。谁长留谁，别让人一行读两遍。
    const titleCell = (s) => (!s.mark || (s.gist && s.gist.startsWith(s.mark)))
      ? (s.gist || s.mark || '（这块内一句人话都没有）')
      : `${s.mark}｜${s.gist || '（这块内一句人话都没有）'}`;
    const rows = v.steps.map((s) => `${String(s.i).padStart(3)} ${stepCell(s).padStart(4)} ${roleCell(s).padEnd(6)} ${(s.span || s.from).padEnd(11)} ${(s.sent || s.carrySent).padEnd(10)}`
      + `支${s.tasks}${s.inside ? `（夹${s.inside}插曲）` : ''}${s.verified ? ` 证${s.verified}` : ''}${s.decisions ? ` 决${s.decisions}` : ''}${s.ruledOut ? ` 排${s.ruledOut}` : ''} 写${s.wrote}${s.errs ? ` ⚠${s.errs}` : ''}${s.open ? ` 留问${s.open}` : ''}`
      + `${s.fork.length ? ` ⤷岔出→块${s.fork.map((f) => f.at).join(',')}` : ''}${s.back.length ? ` ↩汇回←块${s.back.map((b) => b.at).join(',')}` : ''}`
      + ` | ${titleCell(s)}`
      + ` ⇒ ${clip(s.sum ? s.sum.done : s.solved, 40) || '（只有结构）'} | ${s.read}`);
    const text = [head, ...rows, '（每块一行；块里哪段过判据：convledger show；段正文：convledger body Sxx）'].join('\n') + '\n';
    trace(root, sid, 'steps', {}, { tokens: tok(text), steps: v.steps.length });
    return out(text);
  }

  // 综述素材出口。综述是模型对"你说什么 / 我回什么 / 做成什么"的归纳，只能从这块的
  // 原话、回复、产物里取材；写入口会逐字核（接地闸门）。默认只给还缺综述的块，
  // 写完一批再跑，输出自然收窄；--block N 单块，--all 全量。
  if (cmd === 'digest') {
    const v = readView(dir);
    // 阶段素材是一次写全表的：必须给全量步表，模型才能决定在哪切开。
    if (flags.phases) {
      const docs = scanDocs(flags['docs-root'] || v.meta.cwd || process.cwd());
      const text = allMaterial(v, docs);
      trace(root, sid, 'digest', { phases: true }, { tokens: tok(text), steps: v.steps.length, docs: docs.list.length });
      return out(text);
    }
    const sums = readSummaries(dir);
    const totals = { mainSteps: v.mainSteps, blocks: v.steps.length, nodes: v.nodes.length };
    if (flags.tasks) {
      const one = flags.id ? v.tasks.filter((t) => t.id.toUpperCase() === String(flags.id).toUpperCase()) : null;
      if (one) {
        if (!one.length) return fail(`没有任务 ${flags.id}；现有：${v.tasks.slice(0, 8).map((t) => t.id).join(' ')}…`);
        const text = taskMaterial(one[0], v.steps, v.nodes) + '\n';
        trace(root, sid, 'digest', { tasks: true, id: one[0].id }, { tokens: tok(text), tasks: 1 });
        return out(text);
      }
      // 题名只在块右栏显示，而右栏只显示"某块的主支"——只给这些支写题名，
      // 不给只活在一句话里的小支编标题（`summarise --missing` 同一条口径）。
      const dom = dominantTaskIds(v.steps);
      const miss = v.tasks.filter((t) => dom.has(t.id) && !taskTitleIsLive(sums, t));
      const rows = miss.map((t) => {
        const head = v.nodes.find((n) => n.id === t.head);
        const mine = v.steps.filter((b) => (b.branchIds || []).includes(t.id)).map((b) => b.i);
        return `${t.id} 头=${t.head} 块=${mine.join(',') || '—'} 回合=${t.t0 ?? '?'}-${t.t1 ?? '?'} 状态=${t.stateLabel}`
          + `\n  头原话：${clip(head?.say || '（没有原话）', 90)}`
          + (head?.claim ? `\n  头回复：${clip(head.claim, 90)}` : '');
      });
      const text = [`# 任务题名素材 · 缺 ${miss.length}/${dom.size} 条主支题名（题名要概括这条支干成了什么，不是复读头一句；单条全量：digest --tasks --id B77）`,
        ...rows].join('\n') + '\n';
      trace(root, sid, 'digest', { tasks: true }, { tokens: tok(text), tasks: miss.length });
      return out(text);
    }
    const want = flags.block
      ? v.steps.filter((s) => String(s.i) === String(flags.block))
      : flags.all ? v.steps : v.steps.filter((s) => !summaryIsLive(sums, s, v.nodes));
    if (flags.block && !want.length) return fail(`没有块 ${flags.block}（1–${v.steps.length}）`);
    const missTasks = v.tasks.filter((t) => dominantTaskIds(v.steps).has(t.id) && !taskTitleIsLive(sums, t)).length;
    if (!want.length) {
      const text = `✓ ${v.steps.length} 块都有综述（hash 都对得上）· 任务题名还缺 ${missTasks} 条（digest --tasks）\n`;
      trace(root, sid, 'digest', {}, { tokens: tok(text), blocks: 0 });
      return out(text);
    }
    const parts = want.map((s) => `=== 块 ${s.i} ===\n${blockMaterial(s, v.nodes, v.tasks, totals)}`);
    const text = [
      `# 综述素材 · ${want.length}/${v.steps.length} 块${flags.all || flags.block ? '' : '（只列还缺的；--all 全量）'} · 任务题名缺 ${missTasks} 条`,
      `# 五格（必填）：short ≤${SUMMARY_SHORT_W}格 · title ≤${SUMMARY_TITLE_MAX}字 · said ≤${SUMMARY_SAID_MAX}字 · answered ≤${SUMMARY_ANSWERED_MAX}字 · done ≤${SUMMARY_DONE_MAX}字；另两格（选填）need ≤${SUMMARY_NEED_MAX}字 · lesson ≤${SUMMARY_LESSON_MAX}字；整格不得是原话截段`,
      ...parts,
    ].join('\n\n') + '\n';
    trace(root, sid, 'digest', { block: flags.block ?? null }, { tokens: tok(text), blocks: want.length });
    return out(text);
  }

  // 综述写入口：五格 + 任务题名，四道闸门全过才落盘，全有或全无——半套综述会让页面
  // 一半块说模型话、一半块还是原话截断，读者分不清哪句是归纳、哪句是复读。
  if (cmd === 'summarise') {
    let v = readView(dir);
    let sums = readSummaries(dir);
    let totals = { mainSteps: v.mainSteps, blocks: v.steps.length, nodes: v.nodes.length };
    if (flags.missing) {
      const missBlocks = v.steps.filter((s) => !summaryIsLive(sums, s, v.nodes));
      const dom = dominantTaskIds(v.steps);
      const missTasks = v.tasks.filter((t) => dom.has(t.id) && !taskTitleIsLive(sums, t));
      const rows = [
        ...missBlocks.map((s) => `块${s.i} ${s.step != null ? `步${s.step}` : `插${s.afterStep ?? '?'}↔${s.beforeStep ?? '?'}`} ${s.span} 段=${s.segIds.join(' ')}`),
        ...missTasks.map((t) => `任务${t.id} 头=${t.head} 状态=${t.stateLabel}`),
      ];
      const text = [`缺块综述 ${missBlocks.length}/${v.steps.length} · 缺任务题名 ${missTasks.length}/${dom.size}${rows.length ? '' : ' — 都齐了'}`,
        ...rows].join('\n') + '\n';
      trace(root, sid, 'summarise', { missing: true }, { tokens: tok(text), blocks: missBlocks.length, tasks: missTasks.length });
      return out(text);
    }
    if (!flags.put) { out(usage()); return fail('用法: summarise --put <file|->（{"blocks":[{i,segs,short,title,said,answered,done}],"tasks":[{id,title}]}）  |  summarise --missing'); }
    // 先按当前源重建，再拿重建后的账本算锚点：这张表要落进的就是那个账本。
    // 活会话每几秒长一段，用重建前的视图算 hash，落盘那一刻已经过期（尾块必踩）。
    writeStore(root, build(ledger.sourceFile, { storeRoot: root }));
    v = readView(dir); sums = readSummaries(dir);
    totals = { mainSteps: v.mainSteps, blocks: v.steps.length, nodes: v.nodes.length };
    let raw;
    if (flags.put === '-') {
      try { raw = fs.readFileSync(0, 'utf8'); } catch { return fail('summarise --put - 要从管道收 JSON'); }
    } else {
      if (!fs.existsSync(flags.put)) return fail(`找不到 ${flags.put}`);
      raw = fs.readFileSync(flags.put, 'utf8');
    }
    let payload;
    try { payload = JSON.parse(raw); } catch (e) { return fail(`综述 JSON 解析不了：${String(e.message).split('\n')[0]}`); }
    const bl = Array.isArray(payload?.blocks) ? payload.blocks : payload?.blocks ? Object.entries(payload.blocks).map(([i, x]) => ({ i, ...x })) : [];
    const tk = Array.isArray(payload?.tasks) ? payload.tasks : payload?.tasks ? Object.entries(payload.tasks).map(([id, x]) => ({ id, ...x })) : [];
    if (!bl.length && !tk.length) return fail('综述是空的：要 {"blocks":[{i,segs,short,title,said,answered,done}],"tasks":[{id,title}]}');
    const errors = [];
    const nextBlocks = { ...sums.blocks };
    const nextTasks = { ...sums.tasks };
    for (const e of bl) {
      const s = v.steps.find((x) => x.i === Number(e?.i));
      if (!s) { errors.push(`块 ${e?.i ?? '（缺 i）'}：不存在（1–${v.steps.length}）`); continue; }
      const r = validateSummary(e, s, v.nodes, v.tasks, totals);
      if (!r.ok) { errors.push(...r.errors.map((x) => `块${s.i}: ${x}`)); continue; }
      nextBlocks[String(s.i)] = r.row;
    }
    for (const e of tk) {
      const t = v.tasks.find((x) => x.id === String(e?.id ?? '').toUpperCase());
      if (!t) { errors.push(`任务 ${e?.id ?? '（缺 id）'}：不存在`); continue; }
      const r = validateTaskTitle(e, t, v.steps, v.nodes);
      if (!r.ok) { errors.push(...r.errors.map((x) => `任务${t.id}: ${x}`)); continue; }
      nextTasks[t.id] = r.row;
    }
    if (errors.length) {
      for (const e of errors) out(`✗ ${e}`);
      out(`未落盘：${bl.length + tk.length} 条里 ${new Set(errors.map((e) => e.split(':')[0])).size} 条没过闸门（过了的也没写）`);
      process.exitCode = 1;
      return;
    }
    writeSummaries(dir, { blocks: nextBlocks, tasks: nextTasks });
    out(`✓ 综述已落盘 → ${dir}（块 ${Object.keys(nextBlocks).length}/${v.steps.length} · 主支题名 ${v.tasks.filter((t) => dominantTaskIds(v.steps).has(t.id) && nextTasks[t.id]).length}/${dominantTaskIds(v.steps).size}）`);
    out(`  综述 basis=model，不过六条判据；块内容一变（hash 不符）旧综述自动失效，回落成原话`);
    return;
  }

  // 阶段表：模型把主线步划成连续区间（「第 1–7 步」这样的括号），工具核覆盖、锚点与引用。
  // 与块综述同一套纪律：外挂表、basis=model、过闸才落盘、锚点一变换条失效。
  if (cmd === 'phases') {
    if (flags.put) {
      let raw;
      if (flags.put === '-') {
        try { raw = fs.readFileSync(0, 'utf8'); } catch { return fail('phases --put - 要从管道收 JSON'); }
      } else {
        if (!fs.existsSync(flags.put)) return fail(`找不到 ${flags.put}`);
        raw = fs.readFileSync(flags.put, 'utf8');
      }
      let payload;
      try { payload = JSON.parse(raw); } catch (e) { return fail(`阶段 JSON 解析不了：${String(e.message).split('\n')[0]}`); }
      const entries = Array.isArray(payload?.phases) ? payload.phases : [];
      // 提问切块的水位线：写新阶段前先读旧表，冻结「上次的最大阶段末步」。
      // 表还是空的就不冻结——否则 0 会立刻让整段会话按提问切开，把刚写的阶段撑过期。
      const prevTable = readPhases(dir);
      const prevMax = maxPhaseTo(prevTable);
      const askSplitFrom = Number.isFinite(prevTable.askSplitFrom) ? prevTable.askSplitFrom
        : prevMax > 0 ? prevMax : 0;
      // 先按当前源重建，再拿重建后的账本算锚点：这张表要落进的就是那个账本。
      // 活会话每几秒长一段，用重建前的视图算 hash，落盘那一刻已经过期（尾段必踩）。
      writeStore(root, build(ledger.sourceFile, { storeRoot: root }));
      const v = readView(dir);
      const docs = scanDocs(flags['docs-root'] || v.meta.cwd || process.cwd());
      const totals = { mainSteps: v.mainSteps, blocks: v.steps.length, nodes: v.nodes.length };
      // append：只写尾段新增的连续区间，旧阶段原样保留（它们的 refs 已经解析过，不再二次校验）。
      if (payload?.append === true) {
        if (!entries.length) return fail('append 模式没有新阶段');
        // 以「重建后仍新鲜」的旧阶段为基准：尾部那段 hash 失效的直接丢，归入本次追加。
        const freshPrev = applyPhases(prevTable, v.steps, v.nodes, v.mainSteps).phases.map((p) => ({
          from: p.from, to: p.to, segs: p.segs, hash: p.hash, short: p.short, doing: p.doing,
          state: p.state, effect: p.effect, plan: p.plan, track: p.track, refs: p.refs, basis: p.basis, at: p.at,
        }));
        let at = (freshPrev.reduce((m, p) => Math.max(m, p.to), 0)) + 1;
        const fresh = [];
        const errs = [];
        for (const e of entries) {
          const from = Number(e?.from), to = Number(e?.to);
          if (from !== at) errs.push(`追加阶段要从第 ${at} 步接上，收到 ${e?.from}–${e?.to}`);
          const r = validatePhase(e, { steps: v.steps, nodes: v.nodes, totals, docs });
          if (!r.ok) errs.push(...r.errors.map((m) => `阶段 ${e?.from}–${e?.to}: ${m}`));
          else { fresh.push(r.row); at = to + 1; }
        }
        if (errs.length) {
          for (const e of errs) out(`✗ ${e}`);
          out(`未落盘：追加 ${entries.length} 段里 ${errs.length} 条没过闸门`);
          process.exitCode = 1;
          return;
        }
        const rows = [...freshPrev, ...fresh];
        writePhases(dir, { phases: rows, askSplitFrom });
        const live = applyPhases({ phases: rows }, v.steps, v.nodes, v.mainSteps);
        const covered = Math.max(...rows.map((x) => x.to));
        const appendFrom = fresh.length ? fresh[0].from : covered;
        out(`✓ 阶段表已追加 → ${dir}（新增 ${fresh.length} 段，覆盖第 ${appendFrom}–${covered} 步${covered < totals.mainSteps ? `；尾段 ${covered + 1}–${totals.mainSteps} 步留白` : ''}；重建后仍新鲜 ${live.phases.length} 段）`);
        return;
      }
      const r = validatePhases(entries, { steps: v.steps, nodes: v.nodes, totals, docs });
      if (!r.ok) {
        for (const e of r.errors) out(`✗ ${e}`);
        out(`未落盘：${entries.length} 段里 ${r.errors.length} 条没过闸门（过了的也没写）`);
        process.exitCode = 1;
        return;
      }
      writePhases(dir, { phases: r.rows, askSplitFrom });
      const live = applyPhases({ phases: r.rows }, v.steps, v.nodes, v.mainSteps);
      const covered = r.rows.length ? Math.max(...r.rows.map((x) => x.to)) : 0;
      out(`✓ 阶段表已落盘 → ${dir}（${r.rows.length} 段，覆盖第 1–${covered} 步${covered < totals.mainSteps ? `；尾段 ${covered + 1}–${totals.mainSteps} 步留白` : ''}；重建后仍新鲜 ${live.phases.length} 段）`);
      out(`  每段带 segs+hash：块层一变（hash 不符）旧阶段自动失效，回落成「还没有模型说明」`);
      return;
    }
    const v = readView(dir);
    const st = v.meta.phases || { written: 0, dropped: 0 };
    if (flags.json) {
      const text = JSON.stringify(v.phases, null, 1) + '\n';
      trace(root, sid, 'phases', { json: true }, { tokens: tok(text), phases: v.phases.length });
      return out(text);
    }
    const rows = v.phases.map((p) => `  ${String(p.n).padStart(2)} 步${p.from}–${p.to}`.padEnd(14)
      + `块${p.fromBlock}–${p.toBlock}`.padEnd(9)
      + `${p.span}`.padEnd(12)
      + `段${p.segs.length}${p.verified ? ` 证${p.verified}` : ''} 写${p.wrote}${p.open ? ` 留问${p.open}` : ''} 规则${p.rules.length}`
      + ` | ${p.short}｜${p.doing}`
      + ` ⇒ ${clip(p.effect, 30)}`
      + ` | ${p.refs.map((x) => `${x.f} › ${x.h}`).join('；') || '—'}`);
    const tail = v.phases.length ? v.phases[v.phases.length - 1].to : 0;
    const head = `阶段表 · ${v.phases.length} 段 / ${v.mainSteps} 步 / ${v.steps.length} 块 · 新鲜 ${st.written} / 丢弃 ${st.dropped}`
      + ' · phases.json（basis=model，不过六条判据）';
    const note = !v.phases.length
      ? '还没有阶段说明：convledger digest --phases 取材 → convledger phases --put 写入'
      : tail < v.mainSteps
        ? `覆盖到第 ${tail} 步；第 ${tail + 1}–${v.mainSteps} 步还没有阶段说明（尾段还在长，重新取材再写）`
        : '覆盖全部主线步；块层一变，旧阶段自动失效';
    const text = [head, ...rows, note].join('\n') + '\n';
    trace(root, sid, 'phases', {}, { tokens: tok(text), phases: v.phases.length });
    return out(text);
  }

  // 章层（PRD-chapters）：连续几十步的「接手一页」。写的是模型（读模型），工具只核边界、
  // 锚点、反截段与反编造——和 phases 一模一样，只是答的问题不同：阶段说"做了什么"，章说"下一个人该知道什么"。
  if (cmd === 'chapters') {
    const chapCtx = (v, docs) => ({
      steps: v.steps, nodes: v.nodes, phases: v.phases, docs,
      totals: { mainSteps: v.mainSteps, blocks: v.steps.length, nodes: v.nodes.length },
      requests: readRequests(dir).rows,
    });
    if (flags.put) {
      let raw;
      if (flags.put === '-') {
        try { raw = fs.readFileSync(0, 'utf8'); } catch { return fail('chapters --put - 要从管道收 JSON'); }
      } else {
        if (!fs.existsSync(flags.put)) return fail(`找不到 ${flags.put}`);
        raw = fs.readFileSync(flags.put, 'utf8');
      }
      let payload;
      try { payload = JSON.parse(raw); } catch (e) { return fail(`章 JSON 解析不了：${String(e.message).split('\n')[0]}`); }
      const entries = Array.isArray(payload) ? payload : (Array.isArray(payload?.chapters) ? payload.chapters : []);
      if (!entries.length) return fail('章表是空的：{"chapters":[{"from":1,"to":40,"short":"…","goal":"…","where":"…","rules":"…","tasks":"…","walls":"…","cautions":"…","arch":"…","handoff":"…"}]}');
      // 先按当前源重建，再拿重建后的账本算锚点：活会话每几秒长一段，用旧视图算的 hash 落盘即过期。
      writeStore(root, build(ledger.sourceFile, { storeRoot: root }));
      const v = readView(dir);
      const docs = scanDocs(flags['docs-root'] || v.meta.cwd || process.cwd());
      const ctx = chapCtx(v, docs);
      let rows;
      if (payload?.append === true) {
        const freshPrev = applyChapters(readChapters(dir), v.steps, v.nodes, v.mainSteps, v.phases).chapters;
        let at = freshPrev.reduce((m, c) => Math.max(m, c.to), 0) + 1;
        const fresh = [], errs = [];
        for (const e of entries) {
          const from = Number(e?.from), to = Number(e?.to);
          if (from !== at) errs.push(`追加章要从第 ${at} 步接上，收到 ${from}–${to}`);
          const r = validateChapter(e, ctx);
          if (!r.ok) errs.push(...r.errors.map((m) => `章 ${from}–${to}: ${m}`));
          else { fresh.push(r.row); at = to + 1; }
        }
        if (errs.length) {
          for (const e of errs) out(`✗ ${e}`);
          out(`未落盘：追加 ${entries.length} 章里 ${errs.length} 条没过闸门`);
          process.exitCode = 1;
          return;
        }
        rows = [...freshPrev, ...fresh];
      } else {
        const res = validateChapters(entries, ctx);
        if (!res.ok) {
          for (const e of res.errors) out(`✗ ${e}`);
          out(`未落盘：${entries.length} 章里 ${res.errors.length} 条没过闸门（过了的也没写）`);
          process.exitCode = 1;
          return;
        }
        rows = res.rows;
      }
      writeChapters(dir, { chapters: rows });
      const live = applyChapters({ chapters: rows }, v.steps, v.nodes, v.mainSteps, v.phases);
      const covered = rows.length ? Math.max(...rows.map((x) => x.to)) : 0;
      const phTo = v.phases.reduce((m, p) => Math.max(m, p.to), 0);
      out(`✓ 章表已落盘 → ${dir}（${rows.length} 章，覆盖第 1–${covered} 步；重建后仍新鲜 ${live.chapters.length} 章${live.dropped ? `，丢弃 ${live.dropped}` : ''}）`);
      out(`  ${covered < phTo ? `第 ${covered + 1}–${phTo} 步已有阶段说明但还没成章：chapters --digest 取下一章素材` : `阶段全部成章（到第 ${phTo} 步）`}`
        + `${phTo < v.mainSteps ? `；第 ${phTo + 1}–${v.mainSteps} 步连阶段都还没写（当前步还在长，留白）` : ''}`);
      out('  章 basis=model，不过六条判据；区间内任一段改写就整章失效——不把旧章的话对新内容说。');
      trace(root, sid, 'chapters', { put: true }, { tokens: 0, chapters: rows.length });
      return;
    }
    if (flags.digest) {
      const v = readView(dir);
      const docs = scanDocs(flags['docs-root'] || v.meta.cwd || process.cwd());
      const ctx = chapCtx(v, docs);
      if (!v.phases.length) return fail('还没有阶段说明：章必须盖在阶段之上，先 digest --phases 取材、phases --put 落盘');
      let from, to, title;
      if (flags.chapter != null) {
        const c = v.chapters.find((x) => x.n === Number(flags.chapter));
        if (!c) return fail(`没有第 ${flags.chapter} 章：已写 ${v.chapters.length} 章（要重写整表就不带 append 再 --put）`);
        from = c.from; to = c.to;
        title = `章素材 · 第 ${c.n} 章（第 ${from}–${to} 步 · 块 ${c.fromBlock}–${c.toBlock} · ${c.phaseSpan}）— 重写`;
      } else {
        const coveredTo = v.chapters.reduce((m, c) => Math.max(m, c.to), 0);
        const sug = suggestRanges(v.phases, v.steps, coveredTo);
        if (!sug.length) return out(`第 1–${coveredTo} 步都在章里了；剩下的阶段不足一章（每章至少 ${CHAP_MIN_PHASES} 段）。`);
        from = sug[0].from; to = sug[0].to;
        title = `章素材 · 候选区间 第 ${from}–${to} 步（约 ${sug[0].blocks} 块，还没写过章）`;
      }
      const text = chapterDigest(from, to, ctx, docs, title);
      trace(root, sid, 'chapters', { digest: true }, { tokens: tok(text), from, to });
      return out(text);
    }
    const v = readView(dir);
    const st = v.meta.chapters || { written: 0, dropped: 0, dropReasons: [] };
    if (flags.json) {
      const text = JSON.stringify(v.chapters, null, 1) + '\n';
      trace(root, sid, 'chapters', { json: true }, { tokens: tok(text), chapters: v.chapters.length });
      return out(text);
    }
    const rows = v.chapters.map((c) => `  ${String(c.n).padStart(2)} 步${c.from}–${c.to}`.padEnd(14)
      + `块${c.fromBlock}–${c.toBlock}`.padEnd(9)
      + `${c.phaseSpan}(${c.phaseCount})`.padEnd(14)
      + `段${c.segs.length}${c.verified ? ` 证${c.verified}` : ''} 写${c.wrote} 报错${c.errs}`
      + ` | ${c.short}｜${c.goal}`);
    const covered = v.chapters.length ? Math.max(...v.chapters.map((c) => c.to)) : 0;
    const phTo = v.phases.reduce((m, p) => Math.max(m, p.to), 0);
    const head = `章表 · ${v.chapters.length} 章 / ${v.phases.length} 阶段 / ${v.mainSteps} 步 · 新鲜 ${st.written} / 丢弃 ${st.dropped}`
      + (st.dropReasons?.length ? `（${st.dropReasons.map((r) => `${r.from}–${r.to}：${r.why}`).join('；')}）` : '')
      + ' · chapters.json（basis=model，不过六条判据）';
    const note = !v.chapters.length
      ? `还没有章：chapters --digest 取材 → chapters --put 落盘（每章 ≥${CHAP_MIN_PHASES} 个阶段，边界落在阶段边界上）`
      : covered < phTo
        ? `覆盖到第 ${covered} 步；第 ${covered + 1}–${phTo} 步的阶段还没成章（chapters --digest）`
        : `阶段全部成章（到第 ${phTo} 步）；接手一页：convledger handoff`;
    const text = [head, ...rows, note].join('\n') + '\n';
    trace(root, sid, 'chapters', {}, { tokens: tok(text), chapters: v.chapters.length });
    return out(text);
  }

  if (cmd === 'handoff') {
    const v = readView(dir);
    const which = pos[0] ?? null;
    const r = handoffText(v, which);
    if (r.error) return fail(r.error);
    trace(root, sid, 'handoff', { which: String(which ?? '') }, { tokens: r.tokens, chapters: r.chapters || 1 });
    return out(r.text);
  }

  // 「有哪些规则要遵守」的出口：只汇过了六条判据、move=rule 的增量，原文逐字，
  // 不加工成祈使句。--part 收窄到一块；同一份清单也是新上下文冷启动时的入口（待批 #38）。
  if (cmd === 'rules') {
    const v = readView(dir);
    const partOf = {};
    for (const s of v.steps) for (let i = s.i0; i <= s.i1; i++) partOf[v.nodes[i]?.id] = s;
    const all = v.nodes
      .filter((n) => n.basis === 'verified' && String(n.moves || '').split(/\s+/).includes('rule'))
      .map((n) => ({ id: n.id, anchor: n.anchor, part: partOf[n.id]?.i ?? null, step: partOf[n.id]?.step ?? null, text: n.claim }));
    if (flags.part && !/^\d+$/.test(String(flags.part))) return fail(`--part 要是块号（1、2、…），收到 ${flags.part}`);
    const want = flags.part ? all.filter((r) => String(r.part) === String(flags.part)) : all;
    if (flags.json) {
      const text = JSON.stringify(want, null, 1) + '\n';
      trace(root, sid, 'rules', { part: flags.part ?? null, mode: 'json' }, { tokens: tok(text), rules: want.length });
      return out(want);
    }
    const scope = flags.part ? `块 ${flags.part}` : '本会话';
    const lines = [`# 规则清单 · ${scope} · ${want.length} 条（每条都是某段已过六条判据的增量，move=rule；原文逐字）`];
    if (!want.length) {
      if (flags.part) {
        lines.push('这块没有一条过了判据的 rule 增量 —— 不编。要加源：convledger prove Sxx → claim --move rule …');
      } else {
        lines.push('还没有 rule 增量。给某段写一条：convledger prove S07 → convledger claim S07 --move rule --topic … --takeaway … --evidence …');
        lines.push('写进规则要先过和别的增量一样的六条判据——规则格不是自报栏。');
      }
    }
    let last = null;
    for (const r of want) {
      if (r.part !== last) {
        last = r.part;
        lines.push(`## ${r.step == null ? `块 ${r.part}（插曲）` : `第 ${r.step} 步 · 块 ${r.part}`}`);
      }
      lines.push(`- ${r.text}（${r.id} ${r.anchor} 已证）`);
    }
    const text = lines.join('\n') + '\n';
    trace(root, sid, 'rules', { part: flags.part ?? null }, { tokens: tok(text), rules: want.length });
    return out(text);
  }

  if (cmd === 'topics') {
    const v = readView(dir);
    const topics = readTopics(dir);
    const pub = publishedTopics(topics);
    const held = Object.entries(topics.labels ?? {}).filter(([, l]) => (l ?? []).length);
    const orphan = (topics.topics ?? []).filter((t) => !pub.some((p) => p.id === t.id) && held.some(([, l]) => l.includes(t.id)));
    const segs = v.meta.segs;
    const text = [
      `话题 ${pub.length} 成支 · ${orphan.length} 暂挂（覆盖 <${MIN_SEGMENTS_PER_TOPIC} 段）· 标签 ${held.length}/${segs} 段 · 已证增量 ${v.meta.verified}/${segs} 段是上限`,
      ...pub.map((t) => `${t.id} ${t.name} · 段${t.segments.length} ${t.segments.join(',')}`),
      ...orphan.map((t) => `~ ${t.id} ${t.name} · 只在 ${Object.entries(topics.labels).filter(([, l]) => l.includes(t.id)).map(([id]) => id).join(',')}`),
      held.length ? '' : '（还没挂过：convledger prove Sxx 看材料 → claim 证一条 → label Sxx --name "把手"）',
    ].filter(Boolean).join('\n') + '\n';
    trace(root, sid, 'topics', {}, { tokens: tok(text), topics: pub.length });
    return out(text);
  }

  // A topic label is an outside claim about a segment, so it goes through the same
  // gate as a claim: verbatim in the segment's own verified increment, or refused.
  // It writes topics.json only — never index.md or a card (PRD-topics A4).
  if (cmd === 'label') {
    if (!pos[0] || (!pos[1] && !flags.name)) return fail('用法: label S04 T1  |  label S04 --name "把手"');
    const segList = resolveSegments(ledger, pos[0]);
    if (segList.length !== 1) return fail(`要正好指到一段，收到 ${pos[0]}`);
    const seg = segList[0];
    const topics = readTopics(dir);
    topics.topics ??= [];
    topics.labels ??= {};
    let tname = flags.name;
    let topic = pos[1] ? topics.topics.find((t) => t.id.toLowerCase() === String(pos[1]).toLowerCase()) : null;
    if (topic && tname && norm(topic.name) !== norm(tname)) return fail(`话题 ${topic.id} 的名字是「${topic.name}」，和 --name「${tname}」对不上`);
    if (!topic && tname) topic = topics.topics.find((t) => norm(t.name) === norm(tname)) ?? null;
    if (!topic) {
      if (!tname) return fail(topics.topics.length ? `没有话题 ${pos[1]}；现有：${topics.topics.map((t) => `${t.id}=${t.name}`).join(' ')}` : '还没有话题表：给 --name "把手" 建一个');
      topic = { id: `T${topics.topics.length + 1}`, name: String(tname).trim() };
      topics.topics.push(topic);
    }
    const r = validateLabel({ segId: seg.id, tname: topic.name, ledger, claims: readClaims(dir), topics });
    if (!r.ok) {
      for (const e of r.errors) out(`✗ ${seg.id} ↔「${topic.name}」: ${e}`);
      out(`未落盘：话题表没动（topics.json 未写）`);
      process.exitCode = 1;
      return;
    }
    const held = topics.labels[seg.id] ?? (topics.labels[seg.id] = []);
    if (held.includes(topic.id)) return out(`已挂过：${seg.id} ↔「${topic.name}」(${topic.id})`);
    held.push(topic.id);
    writeTopics(dir, topics);
    out(`✓ ${seg.id} ↔「${topic.name}」(${topic.id}) 覆盖 ${r.covered} 段${r.provisional ? ` · 暂挂：不到 ${MIN_SEGMENTS_PER_TOPIC} 段不成支` : ' · 成支'}`);
    out(`  只写 topics.json；index.md 与路由卡未动（话题层不进路由层）`);
    return;
  }

  // 人写的那一层：列出来，标清它没有证据。这两张表不进 claims、不进 index，
  // 也不参与任何判据——页面上的"人写的·未证"就是从这里来的。
  if (cmd === 'notes') {
    const table = readNotes(dir);
    if (flags.json) {
      const text = JSON.stringify(table.notes, null, 1) + '\n';
      trace(root, sid, 'notes', { mode: 'json' }, { tokens: tok(text), notes: table.notes.length });
      return out(table.notes);
    }
    const lines = [`人写的 ${table.notes.length} 条（author=human · basis=human-note · 不参与六条判据，永不升格 verified）`];
    for (const n of table.notes) {
      lines.push(`${n.id} ${n.kind === 'branch' ? '⑑ 分支' : '＋ 节点'} ${n.seg}${n.after ? ` → ${n.after}` : ''} | ${n.title}${n.body ? ` — ${n.body}` : ''}`);
    }
    if (!table.notes.length) lines.push('（还没有：在地图上点开一块 → 底排「＋加节点」/「⑑ 创建分支」，或 POST /note）');
    const text = lines.join('\n') + '\n';
    trace(root, sid, 'notes', {}, { tokens: tok(text), notes: table.notes.length });
    return out(text);
  }

  if (cmd === 'requests') {
    if (flags.done) {
      const r = closeRequest(dir, flags.done);
      if (!r.ok) return fail(r.errors.join(' · '));
      return out(`✓ ${r.row.id} 已标完成 · ${new Date(r.row.doneAt).toISOString().slice(11, 19)} · 还有 ${r.rows.filter((x) => !x.done).length} 条待做`);
    }
    const { rows, bad } = readRequests(dir);
    const want = flags.pending ? rows.filter((r) => !r.done) : rows;
    if (flags.json) {
      const text = JSON.stringify(want, null, 1) + '\n';
      trace(root, sid, 'requests', { pending: !!flags.pending, mode: 'json' }, { tokens: tok(text), requests: want.length });
      return out(want);
    }
    const lines = [`续做请求 ${rows.length} 条（待做 ${rows.filter((r) => !r.done).length}）${bad ? ` · ⚠ ${bad} 行解析不了已跳过` : ''}`];
    for (const r of want) {
      lines.push(`${r.id} ${r.done ? '✓已做' : '待做'} · ${r.part == null ? '无块号' : `第 ${r.part} 步`}${r.from ? ` · 起 ${r.from}` : ''} · ${r.text}（${String(r.at).slice(5, 16).replace('T', ' ')}）`);
    }
    if (!rows.length) lines.push('（还没有：地图底部输入框写下的一句话会落到 requests.jsonl）');
    const text = lines.join('\n') + '\n';
    trace(root, sid, 'requests', { pending: !!flags.pending }, { tokens: tok(text), requests: want.length });
    return out(text);
  }

  if (cmd === 'lines') {
    const m = String(pos[0] ?? '').match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return out('用法: lines 113-218');
    const lines = fs.readFileSync(ledger.sourceFile, 'utf8').split('\n');
    const from = +m[1]; const to = m[2] ? +m[2] : from;
    const text = lines.slice(from - 1, to).join('\n');
    trace(root, sid, 'lines', { spec: `${from}-${to}` }, { tokens: tok(text), bytes: Buffer.byteLength(text) });
    return out(text);
  }

  if (cmd === 'facts') {
    const facts = JSON.parse(fs.readFileSync(path.join(dir, 'facts.json'), 'utf8'));
    const value = pos[0] ? pos[0].split('.').reduce((a, k) => (a == null ? a : a[k]), facts) : flags.all ? facts : summarizeFacts(facts);
    if (value === undefined) return out(`facts 里没有 ${pos[0]}（试试 facts / facts boundaries / facts segments.toolCallsBySegment）`);
    trace(root, sid, 'facts', { spec: pos[0] ?? (flags.all ? 'all' : 'summary') }, { tokens: tok(JSON.stringify(value)) });
    return out(value);
  }

  if (cmd === 'find') {
    if (!pos[0]) return out('用法: find <文本>');
    const found = searchLedger(ledger, pos.join(' '));
    trace(root, sid, 'find', { query: pos.join(' ') }, { tokens: tok(JSON.stringify(found)), hits: found.hits.length });
    return out(found);
  }

  out(`未知命令 ${cmd}\n\n${usage()}`);
}

/** 本机时区的「月-日 时:分」；认不出来就空着（横幅少一格，不印假时间）。 */
const when = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** 项目行用的时刻：没有就印破折号——「没记时间」和「一分钟前」不能长得一样。 */
const stamp = (iso) => when(iso) || '—';

function loadSession(root, flags, out) {
  const ids = fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'ledger.json')));
  if (!ids.length) { out('store 里还没有账本：先 convledger index <session.jsonl>'); process.exit(1); }
  let id = flags.session ? ids.find((x) => x.startsWith(flags.session)) : ids.length === 1 ? ids[0] : null;
  // 只读命令以前比 map/lessons 笨：同一台机器上，`outstanding` 认得出「我在哪段会话」，
  // `steps` 却只会甩一句「加 --session」。现在共用同一套解析（env → 同 cwd 最新 → 全机最新），
  // 只认这个 store 里已有的账本；认路依据不是「同 cwd」时往 stderr 说一句，别悄悄选错。
  if (!id && !flags.session) {
    const cur = resolveCurrent({ root, cwd: process.cwd() });
    if (!cur.error && ids.includes(cur.sessionId)) {
      id = cur.sessionId;
      // 认出来的会话写在 stderr（不污染 stdout 的正文与 JSON），一句说清凭什么认的。
      process.stderr.write(cur.reason === 'newest'
        ? `（按最新写入认到会话 ${id.slice(0, 8)}；不是这段就加 --session <前缀>）\n`
        : `（会话 ${id.slice(0, 8)} · 同工作目录里最新的一段）\n`);
    }
  }
  // A store full of past experiments is the normal state, so the "which session?" reply has to
  // be a routing answer, not a dump: 47 full ids costs a reader ~1.5K tokens to learn one flag.
  const pick = (n) => n.slice(0, 6).map((x) => x.slice(0, 8)).join(' ');
  if (!id) {
    const recent = ids.sort((a, b) => mtime(path.join(root, b, 'ledger.json')) - mtime(path.join(root, a, 'ledger.json')));
    const hint = `${flags.session ? `没有以 ${flags.session} 开头的已索引会话` : `store 里有 ${ids.length} 个会话，加 --session <前缀>`}；最近 6 个：${pick(recent)}（全量：convledger sessions）`;
    out(hint);
    process.exit(1);
  }
  const { ledger, dir } = loadLedger(root, id);
  return { ledger, dir };
}

const mtime = (p) => fs.statSync(p).mtimeMs;

/** 一条综述还算不算数：段集合＋锚点 hash 都得对得上（与 view.mjs 的消费规则同一套）。 */
const summaryIsLive = (sums, s, nodes) => {
  const e = sums.blocks[String(s.i)];
  return e && e.hash === blockHash(s, nodes) ? e : null;
};
const taskTitleIsLive = (sums, t) => {
  const e = sums.tasks[t.id];
  return e && e.head === t.head ? e : null;
};
/** 任务题名的范围：只给当过某块主支的任务起名（右栏那一行只显示这些）。 */
const dominantTaskIds = (steps) => new Set(steps.map((s) => s.dominant).filter(Boolean));

/** The claims layer, read for merge. A corrupt file must not silently become an
 *  empty one: `claim` writes the merge result back. */
function readClaims(dir) {
  const file = path.join(dir, 'claims.json');
  if (!fs.existsSync(file)) return {};
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw new Error(`${file} 读不了（${String(e.message).split('\n')[0]}）— 先修它，否则写增量会覆盖掉已有模型层`); }
  return typeof parsed === 'object' && parsed ? parsed : {};
}

const prevSegmentId = (ledger, id) => {
  const i = ledger.segments.findIndex((s) => s.id === id);
  return i > 0 ? ledger.segments[i - 1].id : null;
};

/** Flags for one claim, or a JSON array on stdin for a batch. */
function readClaimInput(pos, flags, fail, out) {
  if (flags.json && pos.includes('-')) {
    let raw;
    try { raw = fs.readFileSync(0, 'utf8'); }
    catch { return fail('claim --json - 要从管道收材料：echo \'[{...}]\' | convledger claim --json -'); }
    let arr;
    try { arr = JSON.parse(raw); }
    catch { return fail('stdin 里的 JSON 解析不了：要 [{segment,move,topic,takeaway,evidence}]'); }
    if (!Array.isArray(arr)) arr = [arr];
    if (!arr.length) return fail('stdin 是空数组：没有要写的增量');
    if (arr.length > 200) return fail(`一次写 ${arr.length} 条太多了（上限 200）`);
    return arr;
  }
  if (!pos[0] || pos[0] === '-') { out(usage()); return fail('用法: claim S07 --move pivot --topic 把手 --takeaway 一句 --evidence 3,7  |  claim --json -'); }
  if (!flags.takeaway) return fail('claim 缺 --takeaway（这一步往线程里加了什么）；批量用 claim --json -');
  return [{
    segment: pos[0], move: flags.move, topic: flags.topic, takeaway: flags.takeaway, author: flags.author,
    evidence: String(flags.evidence ?? '').split(/[,\s]+/).filter(Boolean).map(Number),
  }];
}

function indexAll(root, flags, out) {
  let list = listSessions();
  if (flags.project) list = list.filter((s) => s.project.includes(flags.project));
  list = list.filter((s) => s.bytes > 20000);
  // listSessions 已按 mtime 倒序，所以 limit 截的是"最近 N 段"——报告必须说清还剩多少，
  // 否则首跑的人以为全量建完了（实测就是这么被误读的）
  const limit = +(flags.limit ?? 20);
  const rows = [];
  for (const s of list.slice(0, limit)) {
    try {
      const t0 = Date.now();
      // 必须带 storeRoot：否则模型层 claims 叠加不上，落盘会把已证增量冲成规则层
      const built = build(s.file, { storeRoot: root });
      const dir = writeStore(root, built);
      const fanouts = built.facts.fanouts.length;
      rows.push({ id: s.sessionId.slice(0, 8), runner: built.ledger.runner, mb: +(s.bytes / 1048576).toFixed(2), segs: built.ledger.segments.length, turns: built.facts.turns.total, human: built.facts.turns.human, calls: built.facts.toolCalls.total, branches: built.facts.branches.total, boundaries: built.facts.boundaries.length, fanouts, routeTok: built.indexTokens + built.cardTokens, ms: Date.now() - t0, dir });
    } catch (e) {
      rows.push({ id: s.sessionId.slice(0, 8), error: String(e.message ?? e).slice(0, 160) });
    }
  }
  out(`索引 ${rows.length} 个会话（共 ${list.length} 段可选${list.length > rows.length ? `，还剩 ${list.length - rows.length} 段没建——加大 --limit 或去掉截断` : '，已全部覆盖'}) → ${root}`);
  out(rows);
}

/** 退出码：0 完成 · 1 输入/证据 · 2 冲突或忙 · 4 身份不可核（PRD §9.2）。 */
async function runSetup(root, flags, emit) {
  const out = (s = '') => emit(typeof s === 'string' ? s.replace(/\n$/, '') + '\n' : s);
  const t0 = Date.now();
  const facts = nodeFacts();
  const repo = path.resolve(TOOL_ROOT, '..');
  out(`convledger setup · ${when(new Date().toISOString())} · Node v${facts.version} · ${process.platform} ${process.arch}\n`);
  out(`仓库 ${repo.replace(/\\/g, '/')}`);
  // 卸载只撤自己写的东西：Skill、hooks 条目、快捷方式。账本与导出是派生数据，打印路径交给人决定。
  if (flags.uninstall) {
    out('');
    out('卸载：只撤自己写过的条目，别人的配置键与账本都不碰。');
    const marks = (s) => String(s).split(/\r?\n/).map((l) => l.replace(/^[✓·✗!]\s*/, '').trim()).filter(Boolean);
    const sk = runNode(path.join(TOOL_ROOT, 'skill', 'install.mjs'), ['--remove'], { cwd: repo });
    out(sk.ok ? `✓ Skill：${marks(sk.out).join(' · ') || '没有装过'}` : `✗ Skill：${(sk.err || sk.out).split('\n')[0]}`);
    const hk = runNode(path.join(TOOL_ROOT, 'hooks', 'install.mjs'), ['--remove', '--client', 'all'], { cwd: repo });
    out(hk.ok ? `✓ hooks：${marks(hk.out || hk.err).join(' · ') || '没有注册过'}` : `✗ hooks：${(hk.err || hk.out).split('\n').filter(Boolean).slice(0, 3).join(' ')}`);
    if (flags['no-shortcut']) out('· 启动入口：跳过（--no-shortcut；没建过就不用撤）');
    else if (process.platform === 'linux') {
      const de = removeDesktopEntry();
      out(`${de.ok ? '✓' : '✗'} 桌面入口：${de.paths.length ? `删掉 ${de.paths.join(' · ')}` : de.reason}`);
    } else if (process.platform === 'darwin') {
      out('· 启动入口：macOS 没有装过桌面入口，跳过');
    } else {
      const sc = removeShortcuts();
      out(sc.ok ? `${sc.paths.length ? '✓' : '·'} 快捷方式：${sc.paths.length ? `删掉 ${sc.paths.join(' · ')}` : sc.reason}` : `✗ 快捷方式：${sc.reason}`);
    }
    out('');
    out(`账本目录留着：${root.replace(/\\/g, '/')}（全是派生数据，想清掉就删这个目录）`);
    out('hub 若还在跑：convledger map --stop');
    return;
  }
  if (facts.major < 20) return die(1, `✗ Node 需要 ≥20，当前 v${facts.version}`, out);
  out(`✓ Node ≥20${facts.sqlite ? ' · node:sqlite 可用（OpenCode 能接）' : ' · 没有 node:sqlite（需 ≥22.5，OpenCode 先跳过）'}`);
  if (!storeWritable(root)) return die(1, `✗ 账本目录不可写：${root}`, out);
  out(`✓ 账本目录可写：${root}`);
  const port = await portState(8765);
  if (port.state === 'busy') return die(1, '✗ 8765 上有人应答，但不认本工具的 /health——这个端口被别的程序占着。整套工具的地址按「固定 8765」设计（桌面快捷方式与 `url --copy` 都写死它），所以不自动换端口：请把占用 8765 的程序腾开，再重跑 setup。', out);
  out(port.state === 'hub' ? '✓ hub 已在 8765 上跑着' : '✓ 8765 空闲');

  const sessions = listSessions();
  const rows = hostRows({ sessions, sqlite: facts.sqlite });
  out('');
  for (const r of rows) {
    // 计数的名词统一用"会话"：账本里的"段"是压缩区间，一格会话有几段是另一回事
    const src = r.sessions ? `源 ${r.sessions} 个会话` : (r.sourceFound ? '源里 0 个会话' : '未找到源');
    const host = r.hostFound ? '宿主已装' : '未检测到宿主';
    const skip = r.sqliteOnly && !facts.sqlite ? ' · Node <22.5，跳过' : '';
    // 投影缓存在仓库里，宿主与源库都不在这台机器上时那些会话仍会被列出——照实说，不拿它冒充"这台机器有 61 个"
    const cache = r.cached ? ` · 另有投影缓存 ${r.cached} 个会话（这台机器上没有源，不建账）` : '';
    out(`${r.sessions ? '✓' : '·'} ${r.label.padEnd(11)} ${src} · ${host}${skip}${cache}`);
  }
  if (!sessions.length) out('! 没有找到任何会话源：先让任一宿主写一段会话，再重跑 setup');

  const planSkill = rows.filter((r) => r.canSkill);
  const planHook = flags['no-hooks'] ? [] : rows.filter((r) => r.canHook);
  // 只给"这台机器上真有源"的宿主建账：投影缓存不是源，拿它建账会让报告说"未检测到宿主"却建了几十段
  const runners = new Set(rows.filter((r) => r.sourceFound).map((r) => r.id));
  const buildable = sessions.filter((s) => s.bytes > 20000 && runners.has(s.runner));
  let buildN = flags.all ? Infinity : 20;
  if (!flags.all && flags.build !== undefined) {
    const v = Number(flags.build);
    if (!Number.isInteger(v) || v < 0) return die(1, `✗ --build 要一个非负整数（收到 "${flags.build}"）；0 = 每个来源只冒烟一段`, out);
    buildN = v;
  }
  if (flags.check) {
    out('');
    out(`计划：Skill ${planSkill.map((r) => r.label).join('、') || '无'} · hooks ${planHook.map((r) => r.label).join('、') || '无'}`);
    const plan = buildN === Infinity ? `全量（本机可建 ${buildable.length} 个）`
      : buildN === 0 ? `每个来源冒烟一个（--build 0）`
      : `最近 ${buildN} 个（本机可建 ${buildable.length} 个）`;
    const launchLabel = process.platform === 'linux' ? '桌面入口' : process.platform === 'darwin' ? '启动入口（未实测）' : '快捷方式';
    out(`      建账 ${plan} · ${launchLabel} ${flags['no-shortcut'] ? '跳过' : '建/更新'} · hub ${flags['no-open'] ? '只起不打开' : '起并打开会话库'}`);
    out('（--check：没有写宿主配置、没有建账、没有起 hub；OpenCode 投影缓存可能已刷新）');
    return;
  }

  out('');
  for (const r of planSkill) {
    const x = runNode(path.join(TOOL_ROOT, 'skill', 'install.mjs'), ['--client', r.id], { cwd: repo });
    out(x.ok ? `✓ Skill 已装：${r.label}` : `✗ Skill 未装：${r.label}——${(x.err || x.out).split('\n')[0]}`);
  }
  for (const r of planHook) {
    const x = runNode(path.join(TOOL_ROOT, 'hooks', 'install.mjs'), ['--client', r.id], { cwd: repo });
    out(x.ok ? `✓ hooks 已注册：${r.label}` : `✗ hooks 未注册：${r.label}——${(x.err || x.out).split('\n')[0]}`);
  }
  const inStore = () => (fs.existsSync(root) ? fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'ledger.json'))).length : 0);
  let buildNote = '';
  if (buildN === 0) {
    // 只想验管线通不通：每个有源的宿主建一个，别的一概不碰
    for (const r of rows.filter((x) => x.sessions)) {
      try {
        const s = smoke(root, sessions, r.id);
        if (s) out(`✓ 冒烟建账：${r.label} ${s.id.slice(0, 8)}${s.built ? `（${s.segments} 段）` : '（已有账本）'}`);
      } catch (e) {
        out(`✗ 冒烟失败：${r.label}——${String(e?.message ?? e).split('\n')[0]}`);
      }
    }
    buildNote = '只按每个来源冒烟一个（--build 0），其余会话没建账';
  } else {
    const b = buildRecent(root, sessions, buildN, runners);
    const scope = Number.isFinite(buildN) ? `最近 ${buildN} 个` : `全部 ${b.total} 个`;
    out(`✓ 建账（按写入时间取${scope}）：新建 ${b.built} · 已有账本 ${b.existed}${b.failed.length ? ` · 失败 ${b.failed.length}` : ''}${b.skippedNoSource ? ` · 投影缓存无源，跳过 ${b.skippedNoSource} 个` : ''}`);
    for (const f of b.failed.slice(0, 5)) out(`✗ ${f}`);
    if (b.newest.length) out(`  新建的：${b.newest.slice(0, 6).join(' · ')}${b.newest.length > 6 ? ` 等 ${b.newest.length} 个` : ''}`);
    buildNote = b.remaining
      ? `还有 ${b.remaining} 个会话没建账（这次只建了${Number.isFinite(buildN) ? `最近 ${buildN} 个` : '一部分'}）`
      : `本机可建的 ${b.total} 个会话全部有账`;
  }

  if (flags['no-shortcut']) out('· 启动入口：跳过（--no-shortcut）');
  else if (process.platform === 'linux') {
    const de = writeDesktopEntry(repo);
    if (de.ok) out(`✓ 桌面入口：${de.paths.join(' · ')}`);
    else out(`✗ 桌面入口：${de.reason}——不影响页面使用，可直接打开上面的地址或跑 convledger url --copy`);
  } else if (process.platform === 'darwin') {
    out('· 启动入口：macOS 未实测，用 `bash open-map.sh` 或 `convledger url --copy`');
  } else {
    const sc = writeShortcuts(repo);
    if (sc.ok) out(`✓ 快捷方式：${sc.paths.join(' · ')}${sc.note ? `（${sc.note}）` : ''}`);
    else if (sc.reason.includes('跳过')) out(`· 快捷方式：${sc.reason}`);
    else out(`✗ 快捷方式：${sc.reason}——不影响页面使用：地址在浏览器里直接打开就行，回头可跑 convledger url --copy`);
  }

  const hub = port.state === 'hub'
    ? { port: port.port, reused: true }
    : await ensureHub(root, 8765);
  if (!hub) return die(1, '✗ hub 没能在 8765 上起来', out);
  const url = `http://127.0.0.1:${hub.port}/`;
  out(`✓ hub ${hub.reused ? '复用' : '新起'} → ${url}（会话库）`);
  if (!flags['no-open']) openUrl(url);
  else out('（--no-open：由你在宿主的浏览器面板里打开这个地址）');
  out('');
  out(`就绪：${rows.filter((r) => r.sessions).map((r) => `${r.label} ${r.sessions} 个`).join(' · ') || '无来源'} · 账本 ${inStore()} 个会话 · 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // 首跑的人看完报告要知道四件事：在哪看、看到的是什么、还缺什么、页面关了怎么回来
  const todo = [];
  if (!sessions.length) todo.push('本机还没有会话源：先让任一宿主聊出一段，再重跑 setup');
  if (buildNote) todo.push(buildNote);
  const skipped = rows.filter((r) => r.sqliteOnly && !facts.sqlite);
  if (skipped.length) todo.push(`${skipped.map((r) => r.label).join('、')}没接：Node 需 ≥22.5（当前 v${facts.version}），换版本后重跑 setup`);
  if (flags['no-hooks']) todo.push('没挂 hooks：压缩后不会自动注入账本，重跑 setup（去掉 --no-hooks）');
  else if (!planHook.length) todo.push('没检测到宿主配置目录：压缩后不会自动注入账本');
  if (flags['no-shortcut']) todo.push('没建快捷方式：重跑 setup（去掉 --no-shortcut）');
  out('下一步：');
  out(`  1. 打开 ${url} —— 会话库列出本机所有已建账的会话`);
  out('  2. 点一行进画布：中景看每一程做了什么，点块看「我的要求 / 经验」；右下角「落后 N 秒」的 N 归 0 才表示画到了最新');
  out(`  3. ${todo.length ? todo.join('；') : '来源都接上了，账也建全了'}（块综述与阶段说明要由模型在会话里补：convledger outstanding）`);
  out('  4. 页面关了怎么回来：双击桌面或开始菜单的「convledger 地图」，或跑 convledger url --copy');
}

function die(code, msg, out) { out(msg); process.exit(code); }

/**
 * 项目从哪来：--project > 当前会话的 cwd > 本机只有一个项目。
 * 以前 export/memory 走这条，progress/sync 只认 --project——同一个工具两套规矩，
 * 人在自己仓库里跑 progress 会被顶一句「store 里有 40 个项目」。
 */
function pickProjectFor(root, flags) {
  if (flags.project) return resolveProject(root, flags.project);
  try {
    const cur = resolveCurrent({ root, cwd: process.cwd(), preferred: flags.session });
    if (cur?.cwd) return resolveProject(root, '', { cwd: cur.cwd });
  } catch { /* 落回「只有一个项目」那条 */ }
  return resolveProject(root, '');
}

function syncPrepare(root, project, flags, out) {
  const id = resolveWriteTarget({ root, cwd: project.root, session: flags.session });
  if (!id.ok) return die(4, `✗ ${id.error}`, out);
  const ledgerFile = path.join(storeDir(root, id.sessionId), 'ledger.json');
  if (!fs.existsSync(ledgerFile)) return die(1, `✗ 会话 ${id.sessionId.slice(0, 8)} 还没建账：convledger index <源>`, out);
  const ledger = loadLedger(root, id.sessionId).ledger;
  const state = readState(root, project.key).state;
  const cp = state.checkpoints?.[id.sessionId] ?? null;
  let fromByte = cp?.analyzedThrough ?? 0;
  let fromLineNote = null;
  if (flags['from-line']) {
    const line = Number(flags['from-line']);
    const off = byteOffsetOfLine(ledger.sourceFile, line);
    if (off == null) return die(1, `✗ 源里没有第 ${flags['from-line']} 行`, out);
    fromByte = off;
    fromLineNote = `从 L${line} 开始：之前的记录不在本批覆盖范围内，进度图不会替它们下结论`;
  }
  let prep;
  try {
    prep = prepareBatch({ ledger, projectKey: project.key, sessionId: id.sessionId, fromByte, baseRevision: state.revision, checkpoint: cp });
  } catch (e) {
    return die(e.code === 'blocked-material' || e.code === 'checkpoint-mismatch' ? 2 : 1, `✗ ${e.message}`, out);
  }
  writePrepared(root, project.key, {
    batchId: prep.batchId, baseRevision: prep.baseRevision, sessionId: id.sessionId,
    project: project.key, frozen: prep.frozen, at: new Date().toISOString(),
  });
  const pending = readPending(root, id.sessionId);
  const view = projectView(state);
  process.stdout.write(JSON.stringify({
    batchId: prep.batchId, baseRevision: prep.baseRevision,
    project: project.key, session: id.sessionId, sourceMode: prep.frozen.sourceMode,
    range: { fromByte: prep.frozen.fromByte, toByte: prep.frozen.toByte, fromLine: prep.frozen.fromLine, toLine: prep.frozen.toLine, batchSha256: prep.frozen.batchSha256, generation: prep.frozen.generation },
    budget: prep.material.budget, used: prep.material.used, oversized: prep.material.oversized, omittedFrom: prep.material.omittedFrom,
    tasks: view.tasks.map((t) => ({ id: t.id, short: t.short, status: t.status, remaining: t.remaining })),
    pendingCalls: pending.calls, orphanResults: pending.orphans,
    units: prep.material.units,
    note: fromLineNote,
    submit: ['batchId', 'baseRevision', 'milestoneChanges', 'taskChanges', 'events', 'candidates', 'dispositions'],
    next: `convledger sync --put - --project ${project.key} --session ${id.sessionId}`,
  }, null, 1) + '\n');
}

function syncPut(root, project, flags, out) {
  const id = resolveWriteTarget({ root, cwd: project.root, session: flags.session });
  if (!id.ok) return die(4, `✗ ${id.error}`, out);
  const ledgerFile = path.join(storeDir(root, id.sessionId), 'ledger.json');
  if (!fs.existsSync(ledgerFile)) return die(1, `✗ 会话 ${id.sessionId.slice(0, 8)} 还没建账`, out);
  let payload;
  try {
    const raw = flags.put === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(flags.put, 'utf8');
    payload = JSON.parse(raw);
  } catch (e) { return die(1, `✗ 提交内容读不了或不是 JSON：${String(e.message).split('\n')[0]}`, out); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return die(1, '✗ 提交内容必须是对象', out);
  if (!payload.batchId) return die(1, '✗ 提交缺 batchId（先 --prepare）', out);

  const state = readState(root, project.key).state;
  // 重放要在版本检查之前认出来：成功批次的原文与回执已定，不该因为后面又提交了一版而报冲突
  const prevBatch = (state.batches ?? []).find((b) => b.batchId === payload.batchId);
  if (prevBatch) {
    if (prevBatch.requestSha !== sha256(JSON.stringify(payload))) return die(2, `✗ 批次 ${String(payload.batchId).slice(0, 8)} 已用别的载荷提交过——同批不能改写`, out);
    const rep = prevBatch.receipt;
    out(`✓ 同批重放（未重复写入） · 版本 r${rep.projectRevision} · 新任务 ${rep.newTasks.length} · 更新 ${rep.updatedTasks.length} · 事件 ${rep.eventCount}`);
    out(`  下一步：convledger progress --project ${project.key}`);
    return;
  }
  const ledger = loadLedger(root, id.sessionId).ledger;
  const prep = readPrepared(root, project.key, payload.batchId);
  if (!prep) return die(2, '✗ 这个批次不存在或已经提交过——重新 --prepare', out);
  if (prep.sessionId !== id.sessionId) return die(2, '✗ 批次属于另一段会话——重新 --prepare', out);
  const frozenOk = verifyPrepared({ batchId: prep.batchId, frozen: prep.frozen }, { ledger });
  if (!frozenOk.ok) return die(2, `✗ 素材已变（${frozenOk.code ?? 'unknown'}）——重新 --prepare，别拿旧批次提交`, out);
  if (payload.baseRevision !== prep.baseRevision) return die(2, `✗ 基准版本 ${payload.baseRevision} 与 prepare 时（${prep.baseRevision}）不一致`, out);
  if (payload.baseRevision !== state.revision) return die(2, `✗ 基准版本 ${payload.baseRevision} 已过期（当前 ${state.revision}）——重新取材`, out);

  const requestSha = sha256(JSON.stringify(payload));
  let result;
  try {
    result = commitBatch(root, project.key, {
      batchId: payload.batchId, requestSha, baseRevision: payload.baseRevision,
      apply: (s) => {
        const r = applyBatch(s, payload, { actor: flags.actor ?? null });
        r.state.checkpoints = r.state.checkpoints ?? {};
        r.state.checkpoints[id.sessionId] = {
          file: prep.frozen.file,
          fromByte: prep.frozen.fromByte, toByte: prep.frozen.toByte, analyzedThrough: prep.frozen.toByte,
          prefixSha256: prep.frozen.prefixSha256, batchSha256: prep.frozen.batchSha256,
          sourceMode: prep.frozen.sourceMode, at: new Date().toISOString(),
        };
        if (r.receipt.candidateIds?.length) {
          r.state.outbox = [...(r.state.outbox ?? []), {
            op: 'publish-memory', operationId: `pub-${payload.batchId}`,
            candidateIds: r.receipt.candidateIds, status: 'pending', at: new Date().toISOString(),
          }];
        }
        return { state: r.state, receipt: { ...r.receipt, session: id.sessionId, range: { from: prep.frozen.fromByte, to: prep.frozen.toByte } } };
      },
    });
  } catch (e) {
    return die(e.code === 'busy' || e.code === 'conflict' ? 2 : 1, `✗ ${e.message}`, out);
  }
  dropPrepared(root, project.key, payload.batchId);

  const rep = result.receipt;
  out(`✓ ${result.replayed ? '同批重放（未重复写入）' : '已提交'} · 版本 r${rep.projectRevision} · 新任务 ${rep.newTasks.length} · 更新 ${rep.updatedTasks.length} · 事件 ${rep.eventCount} · 覆盖字节 ${rep.range.from}..${rep.range.to}`);
  const v2 = projectView(result.state);
  out(`  任务：完成 ${v2.counts.project.done}/${v2.counts.project.inScope} · 待验证 ${v2.counts.project.awaiting} · 受阻 ${v2.counts.project.blocked} · 未知 ${v2.counts.project.unknown} · 待整理 ${v2.counts.unorganized}`);
  const pub = publishOutbox(root, project, out);
  // 导出是派生品：任务提交成功后刷新一次，让项目里的 PROGRESS 与刚提交的版本同版
  let expNote = '未刷新';
  try {
    const exp = writeProjectExports(root, project);
    expNote = exp.files.length
      ? `已刷新 ${exp.files.map((f) => path.basename(f.path)).join(' + ')}`
      : (exp.skipped[0] ? `未变（${exp.skipped[0]}）` : '未变');
  } catch (e) {
    expNote = `刷新失败（${String(e?.message ?? e).split('\n')[0]}）`;
  }
  out(`  记忆发布：${pub.attempted ? `尝试 ${pub.attempted} 项，成功 ${pub.ok}，失败 ${pub.failed}` : '无待发布'} · 导出：${expNote}`);
  // 任务已提交、发布或导出没完成：3 号退出码，调用方才知道该 retry
  if (pub.failed) process.exitCode = 3;
  out(`  下一步：convledger progress --project ${project.key}`);
  try {
    const merged = mergePending(readPending(root, id.sessionId), associateBatch(ledger, prep.frozen), { sessionId: id.sessionId });
    writePending(root, id.sessionId, merged.state);
  } catch (e) {
    out(`  （未决调用未更新：${String(e.message).split('\n')[0]}）`);
  }
}

/** 发布 outbox 里待办的记忆：先查 operationId（重放），过闸门，写成功后才回填。 */
function publishOutbox(root, project, out) {
  const state = readState(root, project.key).state;
  const pending = (state.outbox ?? []).filter((o) => o.status === 'pending');
  if (!pending.length) return { attempted: 0, ok: 0, failed: 0 };
  let ok = 0;
  let failed = 0;
  for (const item of pending) {
    const all = (state.candidates ?? []).filter((c) => (item.candidateIds ?? []).includes(c.id));
    const candidates = all.filter((c) => (c.state ?? 'candidate') === 'candidate');
    if (!candidates.length) {
      updateState(root, project.key, (st) => {
        const it = (st.outbox ?? []).find((o) => o.operationId === item.operationId);
        if (it) { it.status = 'done'; it.at = new Date().toISOString(); it.resolved = 'all-disposed'; }
        return st;
      });
      ok++;
      continue;
    }
    let r;
    try { r = publishCandidates(root, project, candidates, { operationId: item.operationId }); }
    catch (e) { failed++; out(`  ⚠ 记忆发布未完成（${item.operationId}）：${String(e.message).split('\n')[0]}`); continue; }
    if (!r.ok) { failed++; out(`  ⚠ 记忆发布被闸门挡下（${item.operationId}）：${r.errors.slice(0, 3).join('；')}`); continue; }
    updateState(root, project.key, (s) => {
      const it = (s.outbox ?? []).find((o) => o.operationId === item.operationId);
      if (it) {
        it.status = 'done';
        it.at = new Date().toISOString();
        it.memoryIds = [...(r.added ?? []), ...(r.revised ?? [])];
        it.replayed = !!r.replayed;
      }
      for (const c of s.candidates ?? []) {
        if ((item.candidateIds ?? []).includes(c.id) && c.state === 'candidate') { c.state = 'published'; c.stateAt = new Date().toISOString(); }
      }
      return s;
    });
    ok++;
  }
  return { attempted: pending.length, ok, failed };
}

/** 失败候选的出路：标 dismissed，相关 outbox 在没有其他待发布候选时收口。 */
function syncDismiss(root, project, flags, out) {
  const id = String(flags.dismiss ?? '').trim().toUpperCase();
  if (!/^C\d{3,}$/.test(id)) return die(1, `✗ 候选编号不合法：${flags.dismiss}`, out);
  const state = readState(root, project.key).state;
  const c = (state.candidates ?? []).find((x) => x.id === id);
  if (!c) return die(1, `✗ 没有候选 ${id}`, out);
  const from = c.state ?? 'candidate';
  if (!['candidate', 'eligible', 'disputed'].includes(from)) return die(1, `✗ ${id} 当前是 ${from}，不能 dismiss`, out);
  updateState(root, project.key, (st) => {
    transitionCandidate(st, id, 'dismissed', { reason: flags.why ?? '人工处置' });
    for (const it of st.outbox ?? []) {
      if (it.status !== 'pending' || !(it.candidateIds ?? []).includes(id)) continue;
      const live = (st.candidates ?? []).filter((x) => (it.candidateIds ?? []).includes(x.id) && (x.state ?? 'candidate') === 'candidate');
      if (!live.length) { it.status = 'done'; it.at = new Date().toISOString(); it.resolved = 'dismissed'; }
    }
    return st;
  });
  out(`✓ ${id} 已标 dismissed${flags.why ? `（${flags.why}）` : ''}；没有其他待发布候选的条目一并收口\n`);
}

function syncRetry(root, project, flags, out) {
  const r = publishOutbox(root, project, out);
  out(`重试完成：待发布 ${r.attempted} · 成功 ${r.ok} · 失败 ${r.failed}\n`);
  if (r.failed) process.exitCode = 3;
}

function syncStatus(root, project, flags, out) {
  const state = readState(root, project.key).state;
  const view = projectView(state);
  const sessions = Object.entries(state.checkpoints ?? {}).map(([sid, cp]) => {
    const p = readPending(root, sid);
    return { session: sid, analyzedThrough: cp.analyzedThrough, at: cp.at, sourceMode: cp.sourceMode, pendingCalls: p.calls.length, orphanResults: p.orphans.length };
  });
  const data = {
    project: project.key, revision: state.revision, counts: view.counts, sessions,
    candidates: (state.candidates ?? []).reduce((a, c) => ({ ...a, [c.state ?? 'candidate']: (a[c.state ?? 'candidate'] ?? 0) + 1 }), {}),
    outbox: (state.outbox ?? []).filter((o) => o.status === 'pending').map((o) => ({ operationId: o.operationId, candidates: (o.candidateIds ?? []).length, at: o.at })),
    batches: (state.batches ?? []).slice(-3).map((b) => ({ batchId: b.batchId, at: b.at, revision: b.receipt?.projectRevision })),
  };
  if (flags.json) return out(data);
  const lines = [`项目 ${project.key} · 版本 r${state.revision} · 完成 ${view.counts.project.done}/${view.counts.project.inScope} · 待整理 ${view.counts.unorganized} · 待证候选 ${view.counts.candidatesPending}`];
  for (const s of sessions) lines.push(`  会话 ${s.session.slice(0, 8)} · 分析到字节 ${s.analyzedThrough}${s.sourceMode === 'archived' ? '（读自归档）' : ''} · 未决调用 ${s.pendingCalls} · 孤立回执 ${s.orphanResults} · ${String(s.at).slice(0, 19)}`);
  const cand = Object.entries(data.candidates).map(([k, v]) => `${k} ${v}`).join(' · ') || '无';
  lines.push(`  候选：${cand}`);
  for (const o of data.outbox) lines.push(`  待发布：${o.operationId}（${o.candidates} 条候选）· ${String(o.at).slice(0, 19)}`);
  for (const b of data.batches) lines.push(`  批次 ${b.batchId.slice(0, 8)} @ ${String(b.at).slice(0, 19)} → r${b.revision}`);
  if (!sessions.length) lines.push('  还没有任何检查点：convledger sync --prepare --project <键> --session <ID>');
  return out(lines.join('\n') + '\n');
}

// The CLI is the system boundary, so it translates throws into one readable line:
// a bad argument must not cost a reader a Node stack trace. Deep modules keep throwing.
try {
  main();
} catch (e) {
  if (process.env.CONVLEDGER_DEBUG) console.error(e.stack);
  else console.error(String(e?.message ?? e).split('\n')[0]);
  process.exit(1);
}

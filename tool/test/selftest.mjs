#!/usr/bin/env node
// Invariants that must hold for ANY session, plus the numbers the calibration
// session is known to contain. Run: node test/selftest.mjs [other-session.jsonl]
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, RULE_AUTHOR } from '../src/build.mjs';
import { buildTrees, pickStray, pickKeep } from '../src/host-doctor.mjs';
import { readLlm, writeLlm, clearLlm, maskKey, pickModel, bridgeDataDir, describeNetError, saveKeyEntry, listSavedKeys, useSavedKey, removeSavedKey, ensureActiveSaved } from '../src/llm.mjs';
import { indexWindowed, rawRecords, SLICE_BYTES } from '../src/window.mjs';
import { resolveSegments, checkAnchor, anchorChecker, renderBody, writeStore, searchLedger, syncArchive, effectiveSource, archiveState, loadLedger, freezeSource, verifyFrozen } from '../src/store.mjs';
import { readView, wlen, TOOLISH, NOSAY, stepsOf } from '../src/view.mjs';
import { serveMap } from '../src/map.mjs';
import { libraryOf, findSession, LIVE_MIN } from '../src/library.mjs';
import { resolveCurrent, cwdFromHead, normCwd, resolveWriteTarget } from '../src/current.mjs';
import { associateTools, mergePending, readPending, writePending, isMaintenanceCall, prepareBatch, verifyPrepared, materialUnits } from '../src/sync.mjs';
import { createState, validateState, validateTask, effectiveStatus, counts, dependencyCycle, applyBatch, projectView, transitionCandidate } from '../src/progress.mjs';
import { commitBatch, readState, stateFile, writeState } from '../src/state-io.mjs';
import { ADAPTERS, detectAdapter, sourceRoots } from '../src/project.mjs';
import { CARD_TOKEN_CAP, INDEX_FIXED_TOK, INDEX_TOKENS_PER_SEGMENT, ROUTE_SHARE_CAP, CLAIM_SENTENCE_CAP, CLAIM_RESULT_CITABLE_CAP, CLAIM_TOPIC_MAX, CLAIM_TAKEAWAY_MAX, CLAIM_MARK_W, BLOCK_GIST_W, TOPIC_NAME_MAX, MAX_TOPICS_PER_SEGMENT, MIN_SEGMENTS_PER_TOPIC, NOTE_TITLE_MAX, NOTE_BODY_MAX, REQUEST_TEXT_MAX, SUMMARY_SHORT_W, SUMMARY_TITLE_MAX, SUMMARY_NEED_MAX, SUMMARY_LESSON_MAX, MEMORY_DIGEST_TOKENS, MEMORY_DIGEST_FIXED, MEMORY_DIGEST_PER_SESSION, MEMORY_READ_FIXED, MEMORY_READ_PER_ENTRY } from '../src/cost.mjs';
import { validateSummary, validateTaskTitle, readSummaries, writeSummaries, blockHash } from '../src/summaries.mjs';
import { lessonsOf } from '../src/lessons.mjs';
import { profileDue, markProfilePrompt } from '../src/profile-auto.mjs';
import { runAuto } from '../src/closeout-auto.mjs';
import { noticeFor, sourceStamp, readDeploy, writeDeploy, deployFile, upgradeLines, recordedHubPid } from '../src/upgrade.mjs';
import { installGitHook, removeGitHook, hookState, hookFile } from '../hooks/git-post-merge.mjs';
import { sentencesOf, materials, validateClaim, factTokens, MOVES } from '../src/claims.mjs';
import { appendNote, appendRequest, readNotes, readRequests, closeRequest, validateNote } from '../src/notes.mjs';
import { deriveBranches, validateLabel, readTopics, writeTopics, publishedTopics, BRANCH_STATES } from '../src/topics.mjs';
import { readPhases, writePhases, validatePhases, phaseHash, phaseSegs, applyPhases } from '../src/phases.mjs';
import { readChapters, writeChapters, validateChapters } from '../src/chapters.mjs';
import { scanDocs, resolveRef } from '../src/docs.mjs';
import { briefText, briefScenes, phaseDetailText, chapterDetailText, handoffText } from '../src/brief.mjs';
import { tok, readJsonl, sha } from '../src/lib.mjs';
import { renderCard } from '../src/cards.mjs';
import { projectsOf, projectKey } from '../src/projects.mjs';
import { projectLive } from '../src/project-live.mjs';
import { exportPaths, exportRoot, legacyExportPaths, migrateLegacyExports, writeProjectExports, globalIndexFile, checkExports } from '../src/export.mjs';
import { validateMemoryEntry, putProjectMemories, readProjectMemories, projectMemoryDir, memoryContext, applyFreshness, memoryRead, digestMaterials, validateUserEntry, putUserMemories, readUserMemories, userMemoryDir, promoteEntry, unpromoteEntry, userContext, digestUserMaterials, publishCandidates, forgetUserEntry } from '../src/memories.mjs';
import { renderSkill } from '../skill/install.mjs';
import { hostRows, shortcutPs, removePs, buildRecent, isPortFree, findOpenPort } from '../src/setup.mjs';
import { outstandingFor } from '../src/outstanding.mjs';
import { matchHostProcesses } from '../src/status.mjs';
import { connectionState, isOff } from '../src/connection.mjs';
import { readPrefs, resolvePrefs, HOST_DEFAULTS, AUTO_BUILD_MODES } from '../src/prefs.mjs';
import { pickSummaryBatch } from '../src/summary-batch.mjs';
import { collabBrief, MEMORIES_SCHEMA } from '../src/memories.mjs';
import { memoryDue } from '../src/profile-auto.mjs';
import { CHANNELS, STATUS, DEFAULT_CAPS, BAD_TOOLS, dispatchFor, loadCaps, capsWarnings, capBlockReason, capsTable } from '../src/host-caps.mjs';
import { MEMORY_PROJECT_SESSION_DUE } from '../src/cost.mjs';
import { hostTitleFor } from '../src/host-titles.mjs';
import { addInternal, readInternal, setWorker, getWorker } from '../src/internal.mjs';
import { syncCodexProjections } from '../src/codex.mjs';
import { usageReport } from '../src/usage.mjs';

// 测试环境不派生常驻 hub：曾有一个 setup 首跑用例在真端口 8765 起 hub、指向测试库，泄漏后 App 看板
// 显示空数据。设这个环境变量后 ensureHub 只报「跳过」、不 spawn，结构性杜绝再次发生。
process.env.CONVLEDGER_NO_RESIDENT_HUB = '1';
// 测试绝不扫真机 Codex：把源指到不存在的目录、投影指到临时目录（否则真 rollout 会漏进测试清单）。
process.env.CONVLEDGER_CODEX_SRC = `${os.tmpdir()}/convledger-nocodex-${process.pid}`;
process.env.CONVLEDGER_CODEX_OUT = `${os.tmpdir()}/convledger-codexout-${process.pid}`;

/** 校准夹具：优先 --session 参数，其次 CONVLEDGER_SELFTEST_SESSION，再找本机 Windows 的老路径，
 *  最后在 ~/.qoder/projects 里挑最新一段。换机器/换系统时不用改源码，只给路径。 */
export const CALIBRATION = (() => {
  const env = process.env.CONVLEDGER_SELFTEST_SESSION;
  if (env && fs.existsSync(env)) return env.replace(/\\/g, '/');
  const win = '~/.qoder/projects/D--convledger/demo0001-838b-4697-95fc-9756c7ce93eb.jsonl';
  if (fs.existsSync(win)) return win;
  const root = path.join(os.homedir(), '.qoder', 'projects');
  try {
    const found = [];
    for (const d of fs.readdirSync(root)) {
      const dir = path.join(root, d);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl')) found.push(path.join(dir, f));
    }
    found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (found.length) return found[0].replace(/\\/g, '/');
  } catch { /* 没装 Qoder 就落到下面那条断言 */ }
  return win;
})();
const FILE = process.argv[2] ? process.argv[2].replace(/\\/g, '/') : CALIBRATION;
const isCalibration = FILE === CALIBRATION;
assert.ok(fs.existsSync(FILE), `session not found: ${FILE}\n换机器时给一个本机会话：node test/selftest.mjs <session.jsonl>，或设 CONVLEDGER_SELFTEST_SESSION。`);

const built = build(FILE);
const { ledger, facts, segments } = { ...built, segments: built.ledger.segments };

// 实跑 CLI 的测试都 spawn `src/cli.mjs`，工作目录得是 tool/。
const tools = new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1').replace(/\\/g, '/').replace(/\/$/, '');

// 每次运行一个自己的测试根：夹具、store、导出全落在 out/test-runs/<run-id>/，
// 不写真实 out/store、真实 convledger-export，也不和另一个并行运行共用目录。
// 子进程一律给 64MB 缓冲：Node 默认 1MB，而 sessions --all / projects --json 在几千本账的
// 机器上轻松超 1MB，spawnSync 会以 ENOBUFS 失败、或把 stdout 截成半个 JSON（真机踩过）。
const BIG_BUF = 64 * 1024 * 1024;
const RUN = `${tools}/out/test-runs/${process.pid}-${Date.now().toString(36)}`;
const fixture = (name) => {
  const dir = `${RUN}/${name}`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/** 合成一段够长的会话当夹具：**不绑本机任何真实对话**。
 *  以前「块综述层/阶段层/章层」直接拿默认机器上的那段会话做样本，断言写死了它的特征
 *  （某块有 ≥16 字中文原话、主线 ≥60 步）。换台机器/换段会话就整片变红，红得没有信息量。
 *  这里每个 ask 产生一步（真人提问 + 工具调用 + 回复），原话是 17 个汉字，够反截段闸门用。 */
/** 合成会话的行生成器：与 qoderFixtureLines 同形，但提问是一句**连续 20 多个汉字**的话，
 *  这样「原话截段」这类闸门永远有真材料可试，不看机器上那段会话恰好写了什么。 */
function synthLines(sid, asks, cwd = 'D:/synth-proj') {
  const rec = (n, o) => ({ uuid: `s-${n}`, timestamp: new Date(Date.parse('2026-11-05T02:00:00Z') + n * 45000).toISOString(), cwd, sessionId: sid, ...o });
  const rows = [rec(0, { type: 'workspace-directories', directories: [cwd] }), rec(1, { type: 'runtime-config', model: 'dfmodel' })];
  let n = 2;
  for (let i = 0; i < asks; i++) {
    const text = `第${i + 1}件：请把这一段的说明写清楚并且顺手补一条能跑起来的测试用例`;
    rows.push(rec(n++, { type: 'user', userType: 'external', origin: { kind: 'human' }, promptId: `q${i}`, humanInput: { text, mode: 'prompt' }, message: { role: 'user', content: [{ type: 'text', text }] } }));
    rows.push(rec(n++, { type: 'assistant', model: 'dfmodel', message: { role: 'assistant', content: [{ type: 'tool_use', id: `d${i}`, name: 'Edit', input: { file_path: `${cwd}/src/part${i}.mjs`, new_string: 'y'.repeat(700) } }] } }));
    rows.push(rec(n++, { type: 'user', origin: { kind: 'tool-result' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `d${i}`, content: `已写入 ${cwd}/src/part${i}.mjs`, is_error: false }] } }));
    rows.push(rec(n++, { type: 'assistant', model: 'dfmodel', message: { role: 'assistant', content: [{ type: 'text', text: `第 ${i + 1} 件做完：说明与测试都补上了。` }] } }));
  }
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

function synthStore({ asks = 80, cwd = 'D:/synth-proj', sid = 'synth00000000001' } = {}) {
  const base = fixture(`synth-${sid}`);
  const file = `${base}/${sid}.jsonl`;
  fs.writeFileSync(file, synthLines(sid, asks, cwd), 'utf8');
  const b = build(file, { storeRoot: base });
  return { built: b, ledger: b.ledger, segments: b.ledger.segments, file, base, sid };
}

/** 只读源文件头若干字节、取完整行（丢掉可能被截断的末行）：夹具源不必把整份 272MB 拉进来。 */
const headLines = (file, bytes) => {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(bytes);
    const n = fs.readSync(fd, b, 0, bytes, 0);
    const lines = b.toString('utf8', 0, n).split('\n').filter(Boolean);
    return lines.slice(0, -1);
  } finally { fs.closeSync(fd); }
};

test('projection recognises the runner and keeps provenance', () => {
  assert.ok([...ADAPTERS.map((a) => a.id), 'unknown'].includes(ledger.runner), `runner=${ledger.runner}`);
  assert.ok(facts.turns.total > 0 && facts.turns.human > 0);
  assert.ok(facts.turns.zeroContentRate < 0.6, 'too many empty turns — the filter is wrong');
});

test('segments tile the turn line without gaps or overlaps', () => {
  let prev = 0;
  for (const s of segments) {
    assert.ok(s.turnFrom > prev, `${s.id} overlaps or reuses turns (${s.turnFrom} <= ${prev})`);
    assert.ok(s.turnTo >= s.turnFrom, `${s.id} inverted`);
    assert.equal(s.turnTo - s.turnFrom + 1, s.hostTurns, `${s.id} span/turn count mismatch`);
    prev = s.turnTo;
  }
  assert.equal(prev, facts.turns.total, 'last segment must reach the final turn');
});

test('every anchor still resolves to the bytes it was built from', () => {
  // 批量校验：源只读一次；逐段 checkAnchor 会把 230MB 读上 700 遍
  const verify = anchorChecker(ledger);
  for (const s of segments) assert.ok(verify(s).ok, `anchor broken for ${s.id}`);
});

test('route layer stays a routing layer', () => {
  // The index is O(segments) and the calibration session keeps growing while its
  // own ledger is being measured, so the bound is a rate, never a snapshot total.
  const cap = INDEX_FIXED_TOK + INDEX_TOKENS_PER_SEGMENT * segments.length;
  assert.ok(built.indexTokens <= cap, `index costs ${built.indexTokens}t for ${segments.length} 段 — cap ${cap}t (${INDEX_FIXED_TOK} fixed + ${INDEX_TOKENS_PER_SEGMENT}/段)`);
  for (const [id, card] of Object.entries(built.cards)) {
    assert.ok(tok(card) <= CARD_TOKEN_CAP, `${id} card costs ${tok(card)} tokens — cards route, they do not store`);
    assert.match(card, new RegExp(`body ${id}`), `${id} card has no anchor command`);
    assert.ok(!card.includes('\n\n\n'));
  }
  const last = [...facts.boundaries].pop();
  if (last?.preTokens) {
    // The denominator is the session the route layer replaces, not one compaction
    // window. The two prices are fixed (40t/segment here, CARD_TOKEN_CAP per card),
    // so against a fixed ~167k window the index alone must pass 5% at ~200 segments —
    // the growth-rate invariant above and a per-window share cannot both hold.
    const share = (built.indexTokens + built.cardTokens) / facts.wholeFile.contentTokens;
    assert.ok(share <= ROUTE_SHARE_CAP, `route layer is ${(share * 100).toFixed(1)}% of the session it replaces — above the ${ROUTE_SHARE_CAP * 100}% budget`);
  }
});

test('a card stays a route even when the names it cites are long', () => {
  // Fixed sample for the S272 red: four 130-char hash filenames under 看过 pushed a
  // real card to 304t. The cap is a price, so the entry needs a width — counting
  // items alone is not a budget.
  const long = (c) => `result-index/${c.repeat(60)}-${c.repeat(47)}.js`;
  const seg = {
    id: 'S99', anchor: 'L1-9', kind: 'mainline', turnFrom: 1, turnTo: 9, toolCalls: 36,
    tokens: { dialogue: 686, toolRoundTrip: 20311 }, tsFrom: '2026-01-01T01:58:00.000Z', tsTo: '2026-01-01T02:01:00.000Z',
    starts: ['open-on-human'], head: '读了几个结果文件后改页面', tools: { Read: 12, Grep: 4 }, envProbe: false,
    artifacts: [long('a')], filesWritten: [], codeRefs: [], errors: [], branches: [], humans: [],
    filesRead: [long('b'), long('c'), long('d'), long('e'), long('f'), long('0')], filesSeen: [],
    contentHash: 'abcdef123456',
  };
  const card = renderCard(seg, { moves: 'insight', basis: 'reconstructed', text: '这一段的落点' }, 'testsession');
  assert.ok(tok(card) <= CARD_TOKEN_CAP, `a card citing long hash names costs ${tok(card)}t — the entry needs a width, not just a count`);
  assert.match(card, /body S99/, 'the price cut must not take the anchor with it');
});

test('citable sentences are the segment\'s own prose, stably numbered', () => {
  const source = fs.readFileSync(ledger.sourceFile, 'utf8').split('\n');
  const escaped = new Map(); // line -> the record re-serialised, so a cite must be findable in it
  let compactSeen = 0;
  for (const s of segments) {
    const { sentences, dropped, chars, resultChars } = sentencesOf(ledger, s);
    assert.deepEqual(sentencesOf(ledger, s).sentences, sentences, `${s.id} citable prose is not deterministic`);
    for (const [k, x] of sentences.entries()) {
      assert.equal(x.i, k + 1, `${s.id} numbering has a gap at ${x.i}`);
      assert.ok(x.line >= s.lineFrom && x.line <= s.lineTo, `${s.id} #${x.i} cites line ${x.line} outside ${s.anchor}`);
      if (!escaped.has(x.rline ?? x.line)) escaped.set(x.rline ?? x.line, JSON.stringify(JSON.parse(source[(x.rline ?? x.line) - 1])));
      // a human ask has the runner's injected blocks cut out of it, so only the
      // unstripped speakers can be checked against the raw bytes
      if (x.who !== 'user') assert.ok(escaped.get(x.rline ?? x.line).includes(JSON.stringify(x.text.replace(/…$/, '')).slice(1, -1)), `${s.id} #${x.i} is not in the source line it cites`);
      else assert.ok(x.text.length > 0, `${s.id} #${x.i} is an empty sentence`);
      if (x.who === 'result') {
        assert.ok(x.call, `${s.id} #${x.i} cites a result without saying which call produced it`);
        assert.ok(x.line <= s.lineTo && (x.rline ?? x.line) <= s.lineTo, `${s.id} #${x.i} cites a receipt outside the anchor ${s.anchor}`);
      }
      compactSeen += x.who === 'compact' ? 1 : 0;
    }
    assert.ok(chars <= CLAIM_SENTENCE_CAP, `${s.id} citable prose is ${chars} chars — over the ${CLAIM_SENTENCE_CAP} budget`);
    assert.ok(resultChars <= CLAIM_RESULT_CITABLE_CAP, `${s.id} citable result lines are ${resultChars} chars — over the ${CLAIM_RESULT_CITABLE_CAP} budget`);
    // prose and result dumps are charged separately, precisely so that a segment
    // which read 30K chars of report still gets its own conclusions cited
    if (s.toolCalls > 10 && (s.turns ?? []).some((t) => t.assistantText?.trim())) {
      assert.ok(sentences.some((x) => x.who === 'assistant'), `${s.id} 有正文结论却没进可引用池——回执把预算吃光了`);
    }
    if (!dropped && sentences.length) assert.ok(chars <= CLAIM_SENTENCE_CAP, `${s.id} dropped nothing but overflowed the budget`);
  }
  if (facts.boundaries.length) assert.ok(compactSeen > 0, 'a compact summary is citable prose — the numbering must survive the boundary');
  // the code-level facts a card has to route by enter through tool results, so
  // those lines must be citable too (clipped, address-bearing ones only)
  const resultCitables = segments.reduce((a, s) => a + sentencesOf(ledger, s).sentences.filter((x) => x.who === 'result').length, 0);
  if (facts.toolCalls.total > 50) assert.ok(resultCitables > 0, '工具回执里的地址行必须可引用——代码级事实就是这么进来的');
});

test('a verified claim is one copied out of the segment, and the three ways of faking it are refused', () => {
  // Author a claim from the ground itself: a real sentence of a real segment, with
  // one of its own fact tokens as the handle. If THAT does not pass, the checks are
  // unsatisfiable; then break it three ways and require each specific error to fire.
  let built = null;
  for (const s of segments) {
    const m = materials(ledger, s);
    for (const x of m.sentences) {
      if (x.who !== 'assistant' || tok(x.text) > CLAIM_TAKEAWAY_MAX) continue;
      const topic = factTokens(x.text).find((f) => f.length <= 8 && tok(f) <= CLAIM_TOPIC_MAX - 2);
      if (topic) { built = { s, m, x, topic }; break; }
    }
    if (built) break;
  }
  assert.ok(built, 'no segment has citable assistant prose carrying a fact — the claim layer would have nothing to prove');
  const { s, m, x, topic } = built;
  const claim = { move: 'insight', topic, takeaway: x.text, evidence: [x.i] };
  const good = validateClaim(claim, m);
  assert.ok(good.ok, `${s.id} a claim copied from its own sentence must pass: ${good.errors.join(' | ')}`);
  assert.equal(good.revision, false, `${s.id} first claim of a segment is not a revision`);
  assert.ok(validateClaim(claim, { ...m, prev: { takeaway: x.text } }).revision, 'restating the previous claim must be marked revision, not counted as new');
  for (const [label, bad, re] of [
    ['unresolvable evidence', { ...claim, evidence: [m.sentences.length + 400] }, /解不到本段句子/],
    ['invented file', { ...claim, takeaway: `见 no_such_file_xyz.mjs 里的 42.71%` }, /编造嫌疑/],
    ['handle off the claim', { ...claim, topic: '一个 takeaway 里没有的把手' }, /没有逐字出现/],
    ['no citation at all', { ...claim, evidence: [] }, /没有引用就不算有据/],
    ['move off the enum', { ...claim, move: 'conclusion' }, /move 不是六类之一/],
  ]) {
    const r = validateClaim(bad, m);
    assert.ok(!r.ok, `${s.id} ${label} passed the checks`);
    assert.ok(r.errors.some((e) => re.test(e)), `${s.id} ${label} refused for the wrong reason: ${r.errors.join(' | ')}`);
  }
});

test('a verified claim on disk is still provable, and the surfaces say so', () => {
  // The store may hold a model-authored layer; this is the gate that keeps it honest:
  // basis=verified is not a stamp anyone can claim, it has to re-derive right now.
  const root = new URL('../out/store', import.meta.url).pathname.replace(/^\/(\w:)/, '$1').replace(/\\/g, '/');
  const dir = `${root}/${ledger.sessionId}`;
  const file = `${dir}/claims.json`;
  if (!fs.existsSync(file)) return; // this session is not indexed here — nothing to re-prove
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  const verified = Object.entries(stored).filter(([, c]) => c?.basis === 'verified');
  for (const [id, c] of verified) {
    const seg = segments.find((s) => s.id === id);
    assert.ok(seg, `${id} 的已证增量指向一个已经不在账本里的段`);
    assert.notEqual(c.author, RULE_AUTHOR, `${id} 标了 verified 但作者是规则层——basis 只能由判据给`);
    assert.equal(c.segmentHash, checkAnchor(ledger, seg).now, `${id} 锚点变了却还留着 verified：重建必须丢弃它`);
    const r = validateClaim({ move: c.moves, topic: c.topic, takeaway: c.text, evidence: c.evidence }, materials(ledger, seg, null));
    assert.ok(r.ok, `${id} 的已证增量现在证不出来: ${r.errors.join(' | ')}`);
    const card = fs.readFileSync(`${dir}/segments/${id}.md`, 'utf8');
    assert.match(card, new RegExp(`增量\\(${c.moves}/verified\\)`), `${id} 的卡没把 basis 翻成 verified`);
    assert.ok(card.includes(c.text.slice(0, 40)), `${id} 的卡上找不到这条已证增量`);
  }
  // 这里只核「标了 verified 的都必须当场重证得出来」。至于这段会话该不该有已证增量，
  // 是校准会话自己的事——写成硬断言后，换段会话就整片变红，红得没有信息量。
});

test('body retrieval applies the truncation matrix, not silent clipping', () => {
  const big = segments.filter((s) => s.toolCalls > 0).sort((a, b) => b.chars.toolResults - a.chars.toolResults)[0];
  const r = renderBody(ledger, [big]);
  assert.ok(r.text.length > 1000, 'body came back empty');
  if (big.chars.toolResults > 50000) assert.ok(r.text.includes('[truncated,'), 'a fat segment should show explicit truncation markers');
  const plain = renderBody(ledger, [big], { full: true, max: 0 });
  assert.ok(plain.tokens >= r.tokens, '--full with no budget must not lose text');
});

test('body budget stops loudly and the resume line picks up where it stopped', () => {
  const big = segments.filter((s) => s.toolCalls > 0).sort((a, b) => b.chars.toolResults - a.chars.toolResults)[0];
  const bounded = renderBody(ledger, [big]);
  const whole = renderBody(ledger, [big], { max: 0 });
  if (!bounded.stopped) return; // a thin segment legitimately fits the budget
  assert.match(bounded.text, /续读：convledger body/, 'hitting the budget must print how to continue');
  const lines = (t) => [...t.matchAll(/^--- L(\d+) /gm)].map((m) => +m[1]);
  const tail = renderBody(ledger, [big], { after: bounded.stopped.line - 1, max: 0 });
  const missing = lines(whole.text).filter((n) => !lines(bounded.text).includes(n) && !lines(tail.text).includes(n));
  assert.deepEqual(missing, [], `budget + resume must cover every line the unbounded read shows (${missing.length} lost)`);
});

test('segment specs resolve the way the CLI advertises', () => {
  assert.equal(resolveSegments(ledger, 'S01').length, 1);
  assert.equal(resolveSegments(ledger, 'S01,S03').length, 2);
  const three = resolveSegments(ledger, `${segments[0].id}-${segments[Math.min(2, segments.length - 1)].id}`);
  assert.equal(three.length, Math.min(3, segments.length));
  assert.equal(resolveSegments(ledger, 'all').length, segments.length);
  assert.throws(() => resolveSegments(ledger, 'X99'));
});

test('sessions costs like picking a target, not like dumping the store', () => {
  const cli = new URL('../bin/convledger.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1').replace(/\\/g, '/');
  const run = (args) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = run(['sessions']);
  assert.ok(tok(out) <= 800, `sessions costs ${tok(out)} tokens — the full ledger list belongs behind --all`);
  // 默认档是一本文一行的人读文本：中文键的 JSON 两头不靠（页面读不出，人读得累）。
  assert.match(out, /^账本 \d+ 本（/, '第一行要给总数与分组');
  assert.match(out, /整理过 \d+/, '总数里要看得见整理过几本');
  assert.match(out, /最肥 8 本/, '默认只给挑目标要的那几行');
  assert.ok(out.split('\n').length <= 20, `默认档印了 ${out.split('\n').length} 行，超出挑目标一档`);
  assert.match(run(['sessions', '--all']), /^全部 \d+ 本/m, '--all 要逐本列全');
  const j = JSON.parse(run(['sessions', '--json']));
  assert.ok(j.counts.sessions > 0 && j.indexed[0].sourceFile, '--json 才给源路径与整理层');
  // 真实 store 里最新一条可能是刚建、还没建账的会话（organize=null 是设计如此），所以要挑一条**已建账**的来核 organize
  const built = j.indexed.find((e) => e.organize);
  assert.ok(built && built.organize, '--json 要给已建账条目带 organize 字段');
});

test('会话库看得出哪段整理过：色标判据与 outstanding 同一条尺', () => {
  const base = fixture('liborg');
  const root = `${base}/store`;
  fs.mkdirSync(root, { recursive: true });
  const dir = writeStore(root, built);
  const id = path.basename(dir);
  const row = () => libraryOf(root).groups.flatMap((g) => g.sessions).find((x) => x.id === id);
  const writeSum = (hash) => fs.writeFileSync(`${dir}/summaries.json`, JSON.stringify({
    blocks: { 1: { hash, short: '写一句', title: '一句有效综述', said: '一句要求', answered: '一句回复', done: '一句产物' } },
  }));
  assert.equal(row().organize.level, 'none', '只有结构账的一本不能算整理过');
  assert.equal(libraryOf(root).counts.organized, 0, '一本都没写时总数要是 0');
  const v = readView(dir);
  writeSum(blockHash(v.steps[0], v.nodes));
  const after = row();
  assert.equal(after.organize.sums, 1, '补一条有效综述要立刻看得见，不能停在缓存里');
  assert.equal(libraryOf(root).counts.organized, 1, '整理过的本数要跟着变');
  assert.equal(libraryOf(root).groups[0].organized, 1, '分组头也要能给出这组整理过几本');
  assert.equal(after.organize.level, 'part', '其余块还欠着就只能是部分整理');
  // hash 对不上＝旧综述挂在新内容上：按红线要回落，不能再亮「整理过」。
  writeSum('deadbeef');
  assert.equal(row().organize.sumsDropped, 1, '失效的条数要如实记着');
  assert.equal(row().organize.sums, 0);
  assert.equal(row().organize.level, 'none', '失效的综述不算整理过');
  assert.equal(libraryOf(root).counts.organized, 0);
  fs.rmSync(base, { recursive: true, force: true });
});

test('a bad argument costs one line and a non-zero exit, not a stack trace', () => {
  const cli = new URL('../bin/convledger.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1').replace(/\\/g, '/');
  const run = (args) => {
    try { return { code: 0, out: execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: 'pipe' }) }; }
    catch (e) { return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }; }
  };
  for (const args of [['card', 'X99', '--session', 'demo0001'], ['show', '--session', 'nope'], ['index'], ['index', 'no-such-file.jsonl']]) {
    const r = run(args);
    const lines = r.out.trim().split('\n');
    assert.equal(r.code, 1, `${args.join(' ')} exited ${r.code} — a caller cannot tell a hint from a result`);
    assert.ok(lines.length <= 2 && !/at .*\.mjs:/.test(r.out), `${args.join(' ')} dumped ${lines.length} lines incl. a stack`);
    assert.ok(tok(r.out) <= 120, `${args.join(' ')} costs ${tok(r.out)} tokens to say "wrong input"`);
  }
});

test('facts carry the numbers no summariser can remember', () => {
  assert.equal(facts.toolCalls.total, segments.reduce((a, s) => a + s.toolCalls, 0), 'per-segment counts must sum to the session total');
  assert.equal(facts.segments.toolCallsSumCheck, facts.toolCalls.total);
  for (const b of facts.boundaries) {
    assert.ok(typeof b.preTokens === 'number' && b.preTokens > 0);
    assert.ok(b.compactionRatio > 0 && b.compactionRatio < 1);
    const m = b.massTokensInRegion;
    const s = b.shareOfRunnerReportedContext;
    assert.ok(s.dialogue < 0.15, `dialogue share ${(s.dialogue * 100).toFixed(1)}% — dialogue is not the cost centre`);
    // what the truncation matrix aims at must outweigh what a human said in every
    // region; an aggregate check alone would hide a region where it misses entirely
    assert.ok(m.toolRoundTrip > m.dialogue, `L${b.line} tool round-trip ${m.toolRoundTrip}t <= dialogue ${m.dialogue}t — the truncation matrix would be aiming at the wrong mass`);
    const r = b.reconciles;
    // host-injected attachment records repeat within a region; summed they can exceed
    // the runner's own preTokens, so the content basis must not add them (bug found
    // when 57/76 boundaries reported measured > preTokens)
    assert.equal(r.measuredContentBasis, b.carriedFromPreviousBoundary + m.dialogue + m.toolRoundTrip + m.thinking, `L${b.line} measured content basis adds attachment records — the log keeps copies the runner did not carry`);
    assert.ok(r.measuredContentBasis <= r.preTokens, `content basis over-counts at L${b.line}: ${r.measuredContentBasis} > ${r.preTokens}`);
    assert.ok(r.rawRecordBasis >= r.preTokens, `raw record basis under-counts at L${b.line}: ${r.rawRecordBasis} < ${r.preTokens}`);
    assert.ok(b.attachmentRecords.tokens >= 0 && !('attachments' in b.shareOfRunnerReportedContext), 'attachment records are reported beside the basis, never as a share of it');
  }
  const sum = (f) => facts.boundaries.reduce((a, b) => a + f(b), 0);
  const rt = sum((b) => b.massTokensInRegion.toolRoundTrip);
  const dlg = sum((b) => b.massTokensInRegion.dialogue);
  const think = sum((b) => b.massTokensInRegion.thinking);
  assert.ok(rt > think && rt > dlg * 10, `tool round-trip ${rt}t must dominate thinking ${think}t and dialogue ${dlg}t across the session — otherwise the truncation matrix aims at the wrong mass`);
  assert.ok(facts.fanouts.every((f) => f.calls.every((c) => c.count >= 3)));
});

test('the map surface publishes structure, not bodies, and only to this machine', async () => {
  const root = fixture('map');
  const dir = writeStore(root, built);
  // notes/requests are external tables that survive a rebuild; a test run must start
  // from zero or ids drift by one every time (N01 → N02 …). This directory is a
  // generated fixture under out/, never a store a person wrote into.
  for (const f of ['notes.json', 'requests.jsonl']) fs.rmSync(`${dir}/${f}`, { force: true });
  const v = readView(dir);
  assert.equal(v.meta.segs, segments.length);
  assert.equal(v.meta.routeTok, built.indexTokens + built.cardTokens, 'the gauge on the page must read the number the route-layer invariant audits');
  assert.equal(v.meta.openedByHuman, segments.filter((s) => s.starts.includes('open-on-human') && !s.isCompactSummary).length, 'a compaction is not the human speaking');
  assert.ok(v.meta.openedByHuman <= facts.turns.human, 'the map claims more human starts than the session has human turns');
  // A compaction happens in the middle of an ask: it must not open a group, or the
  // route reads as "a new map restarted" every time the runner compressed.
  const openers = new Set(segments.filter((s, i) => i === 0 || (!s.isCompactSummary && (s.starts.includes('open-on-human') || s.kind.startsWith('pivot')))).map((s) => s.id));
  assert.equal(v.meta.groups, openers.size, 'groups are opened by a human ask or a pivot only — a compaction is neither');
  const firstOfGroup = {};
  for (const n of v.nodes) if (firstOfGroup[n.group] === undefined) firstOfGroup[n.group] = n;
  for (const [gi, n] of Object.entries(firstOfGroup)) assert.notEqual(n.kind, 'boundary', `group ${gi} opens at a compaction — the chain is cut there`);
  const json = JSON.stringify(v);
  assert.ok(!/tool_use_id|"turns":\s*\[\s*\{/.test(json), 'the map payload must carry anchors, not turn bodies');
  for (const n of v.nodes) {
    assert.match(n.anchor, /^L\d+-\d+$/, `${n.id} lost the anchor the body is re-read from`);
    assert.ok(n.card <= CARD_TOKEN_CAP, `${n.id} card is ${n.card}t`);
    for (const [k, val] of Object.entries(n)) {
      if (typeof val === 'string') assert.ok(val.length <= 210, `${n.id}.${k} holds ${val.length} chars — the map points at bodies, it does not copy them`);
      if (Array.isArray(val)) for (const s of val) assert.ok(String(s).length <= 210, `${n.id}.${k} holds a ${String(s).length}-char string`);
    }
  }
  const h = await serveMap({ root, port: 8791, rebuildSec: 0 });
  const S = `/s/${ledger.sessionId}`;
  const call = (method, path, { body, headers = {}, host } = {}) => new Promise((res, rej) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({
      host: '127.0.0.1', port: 8791, path, method, setHost: !host,
      headers: { ...(data === null ? {} : { 'content-length': Buffer.byteLength(data) }), ...headers, ...(host ? { host } : {}) },
    }, (x) => {
      let b = ''; x.on('data', (d) => { b += d; }); x.on('end', () => res({ status: x.statusCode, body: b, headers: x.headers }));
    });
    r.on('error', rej); if (data !== null) r.write(data); r.end();
  });
  const get = (path, host) => call('GET', path, { host, headers: { 'x-hub-key': h.token } });
  const post = (path, body, headers = {}) => call('POST', path, { body, headers: { 'x-hub-key': h.token, 'content-type': 'application/json', ...headers } });
  try {
    // 门禁：没 token 一律 403（浏览器 Web 入口下线，2026-11-14）；带 token 从 query / cookie 进都放行
    assert.equal((await call('GET', '/app')).status, 403, '无 token 的裸请求要被门禁挡住');
    const keyed = await call('GET', `/app?k=${h.token}`);
    assert.equal(keyed.status, 200, '带 token 从 query 进要放行');
    assert.ok(String(keyed.headers['set-cookie'] || '').includes('hubk='), '首次带 k 要种 cookie，之后同源请求自动带');
    assert.equal((await call('GET', '/app.js', { headers: { cookie: `hubk=${h.token}` } })).status, 200, 'cookie 里的 token 也认');
    assert.equal((await call('GET', '/app.js', { headers: { 'x-hub-key': h.token } })).status, 200, '头里的 token 也认');
    assert.equal((await call('GET', '/app?k=deadbeef')).status, 403, '错的 token 一样挡');
    // 根地址是会话库（hub），画布在 /s/<id>/ 下。
    const hubPage = await get('/');
    assert.equal(hubPage.status, 200);
    assert.match(hubPage.body, /会话库/, '根地址必须是会话库页（一个 hub 服务所有会话）');
    assert.ok(!/innerHTML/.test(hubPage.body), 'log text must reach the page through textContent, never markup');
    for (const m of hubPage.body.matchAll(/(?:href|src)="(\/[^"]*)"/g)) {
      const p = m[1].split('?')[0];
      assert.notEqual((await get(p)).status, 404, `hub.html refers to ${p} but the server does not serve it`);
    }
    assert.ok(!/innerHTML/.test((await get('/hub.js')).body), 'hub 也不用 innerHTML');
    const alias = await get('/atlas');
    assert.equal(alias.status, 302, '/atlas 旧别名要跳到最近写入的会话画布');
    assert.equal(alias.headers.location, `${S}/`);
    const page = await get(`${S}/`);
    assert.equal(page.status, 200);
    assert.match(page.body, /会话流程图/, '会话画布必须还是那张流程图');
    assert.match(page.body, /atlas\.css\?v=/, '画布样式要带文件版本，刷新一次必拿新文件');
    assert.ok(!/innerHTML/.test(page.body), 'log text must reach the page through textContent, never markup');
    for (const m of page.body.matchAll(/(?:href|src)="(\/[^"]*)"/g)) {
      const p = m[1].split('?')[0];
      assert.notEqual((await get(p)).status, 404, `atlas.html refers to ${p} but the server does not serve it`);
    }
    assert.ok(!/innerHTML/.test((await get('/atlas.js')).body), 'log text must reach the atlas through textContent, never markup');
    assert.match((await get('/atlas.js')).body, /\/p\/' \+ pk \+ '\/\?from=/, '画布跳项目页时要带回来路（from=画布地址）');
    assert.equal((await get('/icon.svg')).status, 200, '图标要由 hub 直接提供（favicon 与页头共用）');
    assert.equal((await get('/icon-small.svg')).status, 200, '小尺寸图标要单独一份');
    for (const r of ['qoder', 'claude-code', 'workbuddy', 'opencode', 'codex']) {
      const ic = await get(`/agent-icons/${r}.png`);
      assert.equal(ic.status, 200, `左栏的 agent 图标要由 hub 提供：${r}`);
      assert.match(ic.headers['content-type'], /^image\/png/, 'agent 图标必须按二进制图片发');
    }
    assert.match((await get('/atlas.js')).body, /agent-icons\/qoder\.png/, '画布左栏用 agent 图标，不再只靠色块');
    assert.match((await get('/hub.js')).body, /agent-icons\/qoder\.png/, '会话库左栏同样用 agent 图标');
    assert.match((await get('/atlas.js')).body, /缺图标/, '没有图标的 runner 要回落到色块并标明缺图');
    assert.match((await get('/hub.js')).body, /缺图标/, '没有图标的 runner 要回落到色块并标明缺图');
    assert.match((await get('/atlas.js')).body, /工作区 · /, '画布左栏每条会话下面要写工作区');
    assert.match((await get('/hub.js')).body, /工作区 · /, '会话库每条会话下面要写工作区');
    const launcher = fs.readFileSync(new URL('../open-map.vbs', import.meta.url), 'utf8');
    assert.match(launcher, /bin\\convledger\.mjs/, '双击入口要指向真实 CLI');
    assert.match(launcher, /map --open/, '双击入口要走 map --open（hub 活着复用、死了顺手起）');
    assert.match(launcher, /CurrentDirectory = root/, '双击入口要把 cwd 放在仓库根，否则当前会话解析不到这个项目');
    // 应用窗口：快捷方式指向 open-app.vbs，走 convledger app（--app 窗口）；浏览器入口已下线（token 门禁）
    const appLauncher = fs.readFileSync(new URL('../open-app.vbs', import.meta.url), 'utf8');
    assert.match(appLauncher, /bin\\convledger\.mjs/, '应用入口要指向真实 CLI');
    assert.match(appLauncher, / app /, '应用入口要走 convledger app');
    assert.match(appLauncher, /CurrentDirectory = root/, '应用入口也要把 cwd 放在仓库根');
    const man = await get('/manifest.webmanifest');
    assert.equal(man.status, 200, 'PWA manifest 要由 hub 提供');
    assert.equal(JSON.parse(man.body).display, 'standalone', 'manifest 要声明独立窗口');
    assert.equal(JSON.parse(man.body).start_url, '/app', '装成应用后先落在本机看板');
    for (const p of ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-192-v2.png', '/icons/icon-512-v2.png']) {
      const r = await get(p);
      assert.equal(r.status, 200, `${p} 要能取到`);
      assert.match(r.headers['content-type'], /^image\/png/, `${p} 要按图片发`);
    }
    const icon512 = fs.readFileSync(new URL('../web/icons/icon-512-v2.png', import.meta.url));
    assert.equal(icon512[25], 6, '页面图标要带透明通道：白底已经抠掉');
    const deskIco = fs.readFileSync(new URL('../web/convledger.ico', import.meta.url));
    assert.ok(deskIco.length > 20000, '桌面图标要是多尺寸 ICO，不是单张缩略图');
    assert.match((await get('/')).body, /rel="manifest"/, '会话库要挂 manifest，浏览器才能「安装为应用」');
    assert.match(fs.readFileSync(new URL('../web/atlas.html', import.meta.url), 'utf8'), /rel="manifest"/, '画布也要挂 manifest');
    const arch = await get('/architecture');
    assert.equal(arch.status, 200, '架构图必须由 hub 提供，不能只躺在仓库里');
    assert.match(arch.body, /架构与工作路线图/, '架构图标题要对得上');
    assert.match(arch.body, /id="tabFlow"/, '架构页要有默认的「运行链路」视图');
    assert.match(arch.body, /id="flow"/, '运行链路要有独立的总览面板');
    assert.match(arch.body, /data-node="qoder"/, '运行链路的主干卡片要能点进模块明细');
    assert.match(arch.body, /setMode\('flow'\)/, '首次进入先看运行链路，不是直接掉进八层模块图');
    assert.match(arch.body, /body\.embed header\{display:flex/, 'App 内嵌时也要保留三个视图 tab，不能整条页头藏掉');
    assert.match(arch.body, /id="r3d"/, '运行时路线要有三维画布容器');
    assert.match(arch.body, /three\.module\.min\.js/, '运行时路线要用本地 Three.js');
    assert.match(arch.body, /WebGLRenderer/, '运行时路线要真的建 WebGL 场景');
    assert.match(arch.body, /makeRuntime3d/, '运行时路线要有独立的三维构图入口');
    assert.doesNotMatch(arch.body, /id="roadmap"/, '不再往架构页塞项目任务快照');
    assert.doesNotMatch(arch.body, /architecture\.json/, '运行时路线不再拉项目任务接口');
    const three = await get('/vendor/three.module.min.js');
    assert.equal(three.status, 200, 'Three.js 要由本机 hub 提供，不能靠 CDN');
    assert.match(three.headers['content-type'], /javascript/, 'Three.js 要按脚本发');
    assert.ok(three.body.length > 500000, 'Three.js 完整模块不能是占位文件');
    assert.match((await get('/')).body, /href="\/architecture"/, '架构页入口在会话库顶栏');
    // 应用看板：App 窗口落在 /app，旧 /status 只做跳转；数据与写操作仍走同一套接口
    const appPage = await get('/app');
    assert.equal(appPage.status, 200, '应用看板要由 hub 提供');
    assert.match(appPage.body, /本机看板/, '应用看板要有自己的标题');
    assert.match(appPage.body, /本机 agent/, '应用看板要讲 agent');
    assert.match(appPage.body, /data-view="sessions"/, '应用看板的会话要留在 App 壳里');
    assert.match(appPage.body, /data-view="arch"/, '应用看板的架构要留在 App 壳里');
    assert.match(appPage.body, /id="view-canvas"/, '画布也要留在 App 壳里');
    assert.match(appPage.body, /data-view="canvas"/, '地图是左栏独立入口，回会话靠左栏而不是画布内按钮');
    assert.match(appPage.body, /data-view="work"/, '工作台是左栏独立入口');
    assert.match(appPage.body, /id="view-work"/, '工作台视图要留在 App 壳里');
    assert.match(appPage.body, /data-view="usage"/, '用量是 App 壳里的独立入口');
    assert.match(appPage.body, /id="view-usage"/, '用量视图要留在 App 壳里');
    assert.match(appPage.body, /id="usagesources"/, '用量要按 agent 汇总');
    assert.match(appPage.body, /id="usageinjections"/, '用量要逐条列注入');
    assert.match(appPage.body, /app\.js\?v=/, '应用脚本要带版本，改完刷新一次就拿到新文件');
    assert.ok(!/href="\/"/.test(appPage.body), '应用看板不再跳网页会话库');
    const appJs = (await get('/app.js')).body;
    assert.match(appJs, /一键连接/, '应用看板要给一键连接');
    assert.match(appJs, /function showView/, '应用看板要在壳内切视图');
    assert.match(appJs, /function openCanvas/, '点会话要在 App 壳内开画布');
    assert.match(appJs, /rows\.slice\(0, 4\)/, '每个 agent 默认只展开 4 个会话');
    assert.match(appJs, /data-more/, '每个 agent 要有展开/收起入口');
    assert.match(appJs, /\/\?embed=1/, '画布与工作台内嵌时要带 embed，去掉第二层 chrome');
    assert.match(appJs, /function loadProjects/, '工作台的项目清单要从 /projects.json 现读');
    assert.match(appJs, /function loadUsage/, '用量视图要懒加载，不拖慢首屏');
    assert.match(appJs, /\/usage\.json/, '用量数据要走 /usage.json');
    assert.match(appJs, /无用量/, '宿主没上报 token 时要写状态，不能写 0');
    assert.match(appPage.body, /data-src="\/architecture\?embed=1"/, '架构视图用内嵌方式留在 App 壳里');
    assert.match((await get('/architecture?embed=1')).body, /classList\.add\('embed'\)/, '架构页要能隐藏自己的页头，避免双栏');
    for (const m of appPage.body.matchAll(/(?:href|src)="(\/[^"]*)"/g)) {
      const p = m[1].split('?')[0];
      if (p === '/app') continue;
      assert.notEqual((await get(p)).status, 404, `app.html refers to ${p} but the server does not serve it`);
    }
    const oldStatus = await get('/status');
    assert.equal(oldStatus.status, 302, '旧状态页要跳到应用看板');
    assert.equal(oldStatus.headers.location, '/app');
    const st = JSON.parse((await get('/status.json')).body);
    assert.ok(Array.isArray(st.hosts) && st.hosts.length >= 5, '状态要列出五家 agent');
    assert.ok(st.totals && Number.isInteger(st.totals.sessions), '状态要带账本总量');
    assert.equal(typeof st.refreshing, 'boolean', 'status.json 要带 refreshing，App 壳才知道要不要转圈');
    assert.equal((await post('/status/action', { client: 'qoder', action: 'hooks' }, { origin: 'http://evil.example' })).status, 403, '外站来源不许装 hooks');
    assert.equal((await post('/status/action', { client: 'nope', action: 'hooks' }, { origin: 'http://127.0.0.1:8791' })).status, 400, '未知 agent 要拒绝');
    assert.match((await get('/')).body, /href="\/app"/, '应用看板入口在会话库顶栏');
    assert.match((await get('/')).body, /href="\/app\?view=usage"/, '用量入口也在会话库顶栏');
    const usageAlias = await get('/usage');
    assert.equal(usageAlias.status, 302, '旧地址 /usage 只做跳转，不维护第二份页面');
    assert.equal(usageAlias.headers.location, '/app?view=usage');
    const usageMapSrc = fs.readFileSync(new URL('../src/map.mjs', import.meta.url), 'utf8');
    assert.match(usageMapSrc, /refresh\.getUsage\(root/, '用量统计要走后台缓存，不在请求路径同步扫几百 MB');
    assert.equal((await get('/app.css')).status, 200, '应用看板样式要能取到');
    assert.equal((await get('/app.js')).status, 200, '应用看板脚本要能取到');
    assert.ok(!/innerHTML/.test((await get('/app.js')).body), '应用看板也不用 innerHTML');
    assert.match((await get('/app.css')).body, /@media \(max-width: 820px\)/, '应用看板要能跟着窗口变窄重排');
    assert.ok(!page.body.includes('/architecture'), '会话画布不挂工具架构页——两者不是一个部分');
    assert.equal((await get('/index.html')).status, 404, '旧的按部分两级页必须已经撤掉');
    assert.equal((await get('/atlas/../index.html')).status, 404, 'the atlas URL must not escape the allowlist');
    assert.equal((await get('/', 'evil.example.com')).status, 403, 'another host must not be able to read this session');
    assert.equal((await get(`${S}/data.json`, '127.0.0.1:9999')).status, 403);
    assert.equal((await get('/../../etc/passwd')).status, 404, 'only the allowlisted paths are served');

    // ---- B3：正文按锚点现读；不进 data.json、不缓存 ----
    const seg0 = segments[0].id;
    const bodyRes = await get(`${S}/body?seg=${seg0}`);
    assert.equal(bodyRes.status, 200, '/body must serve the segment body');
    assert.equal(bodyRes.headers['cache-control'], 'no-store', 'a body read must never be cached');
    assert.ok(bodyRes.body.length > 1000, 'body came back too short');
    assert.equal((await get(`${S}/body`)).status, 400, 'without ?seg the route must refuse, not guess');
    assert.equal((await get(`${S}/body?seg=S9999`)).status, 404);
    assert.equal((await post(`${S}/body?seg=${seg0}`, {})).status, 405, '/body is read-only');
    const longLine = bodyRes.body.split('\n').filter((l) => l.length > 80 && !l.includes('"')).sort((a, b) => b.length - a.length)[0];
    if (longLine) assert.ok(!(await get(`${S}/data.json`)).body.includes(longLine.slice(0, 60)), 'the body must not leak into the route payload');
    const rootData = await get('/data.json');
    assert.equal(rootData.status, 404, '根下不再服务单段会话的数据');
    assert.match(rootData.body, /\/s\//, '旧地址 404 时要指出画布在 /s/<id>/ 下');

    const dv = JSON.parse((await get(`${S}/data.json`)).body);
    assert.equal(typeof dv.meta.lagSec, 'number', 'data.json 必须给出落后秒数，页面才能说清它离源多远');
    assert.ok(dv.meta.lagSec >= 0, '落后秒数不能是负的');
    assert.ok(dv.meta.sourceMtime, '落后秒数要有源的最后写入时刻作依据');
    assert.match(String(dv.meta.projectKey), /^p-[0-9a-f]{12}$/, '会话没给出项目键——画布上的「项目页」入口就无从链起');
    assert.equal(typeof dv.meta.refreshing, 'boolean', 'data.json 要带 refreshing，前台才知道要不要转圈');

    // ---- 写入口：同源 + JSON + Host 三道闸，锚点必须在账本里 ----
    const segW = segments[Math.floor(segments.length / 2)].id;
    assert.equal((await get(`${S}/note`)).status, 405, 'notes are written, never read from the page');
    assert.equal((await post(`${S}/note`, { kind: 'node', seg: segW, title: 'x' }, { origin: 'http://evil.example.com' })).status, 403, 'another origin must not write');
    assert.equal((await post(`${S}/note`, 'kind=node', { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await post(`${S}/note`, '{oops', { 'content-type': 'application/json' })).status, 400);
    assert.equal((await post(`${S}/note`, { kind: 'node', seg: 'S9999', title: 'x' })).status, 400, 'a note must hang on a segment this ledger has');
    const noteRes = await post(`${S}/note`, { kind: 'node', seg: segW, title: '地图上写的一条', body: '人写的补充' }, { origin: 'http://127.0.0.1:8791' });
    assert.equal(noteRes.status, 200, noteRes.body);
    const nj = JSON.parse(noteRes.body);
    assert.equal(nj.ok, true);
    assert.match(nj.note.id, /^N\d{2}$/);
    assert.equal(nj.note.author, 'human');
    assert.equal(nj.note.basis, 'human-note', 'a human note is never verified, by construction');
    const viewAfterNote = JSON.parse((await get(`${S}/data.json`)).body);
    assert.equal(viewAfterNote.meta.humanNotes, 1);
    assert.ok(viewAfterNote.notes.some((n) => n.id === nj.note.id && n.seg === segW));
    assert.ok(!JSON.stringify(viewAfterNote.nodes).includes('人写的补充'), 'notes stay out of the segment nodes');
    assert.equal(readNotes(dir).notes.length, 1);

    assert.equal((await get(`${S}/request`)).status, 405);
    assert.equal((await post(`${S}/request`, { text: '' })).status, 400);
    assert.equal((await post(`${S}/request`, { text: 'x', part: 0 })).status, 400);
    const reqRes = await post(`${S}/request`, { part: 1, from: segW, text: '按地图里提的做' }, { origin: 'http://127.0.0.1:8791' });
    assert.equal(reqRes.status, 200, reqRes.body);
    const rj = JSON.parse(reqRes.body);
    assert.match(rj.request.id, /^R\d{2}$/);
    assert.equal(rj.request.done, false);
    assert.equal(JSON.parse((await get(`${S}/data.json`)).body).meta.requestsPending, 1);
    closeRequest(dir, rj.request.id);
    assert.equal(JSON.parse((await get(`${S}/data.json`)).body).meta.requestsPending, 0, 'closing the request must move the pending count');
  } finally { h.stop(); }
});

test('后台刷新：请求路径不内联 build，视图先回缓存、重算交 worker（PRD-refresh）', async () => {
  // 静态契约：data.json/status.json/sessions.json 都走 refresh 管理器；旧的同步重建已删。
  const mapSrc = fs.readFileSync(new URL('../src/map.mjs', import.meta.url), 'utf8');
  assert.match(mapSrc, /createRefresh\(\)/, 'hub 要持有一份刷新管理器');
  assert.match(mapSrc, /refresh\.getView\(root, st, rebuildSec\)/, 'data.json 要走缓存视图，不内联重建');
  assert.match(mapSrc, /refresh\.getStatus\(root/, 'status.json 要走后台快照');
  assert.match(mapSrc, /searchParams\.get\('force'\)/, '手动刷新要能绕过快照缓存');
  assert.match(mapSrc, /refresh\.getSessions\(root/, 'sessions.json 要走后台快照');
  assert.match(mapSrc, /refresh\.stop\(\)/, 'hub 停时要收掉 worker');
  assert.ok(!/ensureFresh|rebuildOnce/.test(mapSrc), '旧的同步重建（占住事件循环）必须已经删掉');
  const workerFile = new URL('../src/refresh-worker.mjs', import.meta.url);
  assert.ok(fs.existsSync(workerFile), '后台重算要有独立的 worker 入口');
  const workerSrc = fs.readFileSync(workerFile, 'utf8');
  assert.match(workerSrc, /parentPort\.on\('message'/, 'worker 要收主线程派来的任务');
  assert.match(workerSrc, /import \{ indexWindowed \}/, '建账（全量或按片）要在 worker 里跑，不在主线程');
  assert.doesNotMatch(mapSrc, /import \{[^}]*\b(projectsOf|projectLive|projectExperience|projectProfile|memoryDue|statusSnapshot|libraryOf|usageReport)\b/,
    '主线程不许再 import 全库重活（2026-11-13 卡死根因）');
  const refreshSrc = fs.readFileSync(new URL('../src/refresh.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(refreshSrc, /import \{[^}]*\b(statusSnapshot|libraryOf|usageReport)\b/,
    '刷新管理器不许留「worker 起不来就内联算一遍」的兜底');

  // 行为契约：冷开即画、缓存命中零重算、人写层内联补、模型层变化先回旧的再后台换。
  const { createRefresh } = await import('../src/refresh.mjs');
  const root = fixture('refresh');
  const dir = writeStore(root, built);
  for (const f of ['notes.json', 'requests.jsonl']) fs.rmSync(`${dir}/${f}`, { force: true });
  const mgr = createRefresh();
  const st = { dir, lastError: null };
  try {
    const a = mgr.getView(root, st, 0);
    assert.equal(a.refreshing, false, '冷开（rebuild 0）不该标 refreshing');
    assert.ok(a.payload.nodes.length > 0, '冷开就要给出完整结构——store 里本来就有');
    const b = mgr.getView(root, st, 0);
    assert.equal(b.payload, a.payload, '缓存命中要回同一份 payload，不重算');
    // 绕过 hub 直接写请求（closeRequest/appendRequest 那条路）：内联补，当场新鲜，不派 worker
    appendRequest(dir, { text: '后台刷新测试的一条请求' });
    const c = mgr.getView(root, st, 0);
    assert.equal(c.refreshing, false, '人写层变化不该派后台 worker');
    assert.equal(c.payload.meta.requestsPending, 1, '绕过 hub 写请求也要当场看得见');
    // 模型层变化：先回上一次真实构建 + refreshing=true，后台 worker 重算后原子换缓存
    const ledgerFile = `${dir}/ledger.json`;
    const led = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    const oldBuiltAt = led.builtAt;
    led.builtAt = new Date(Date.parse(oldBuiltAt) + 60000).toISOString();
    fs.writeFileSync(ledgerFile, JSON.stringify(led));
    const d = mgr.getView(root, st, 0);
    assert.equal(d.refreshing, true, '模型层一变就要标 refreshing，交后台重算');
    assert.equal(d.payload.meta.builtAt, oldBuiltAt, '后台没算完前先回上一次真实构建，前台不阻塞');
    let e = d;
    for (let i = 0; i < 150 && e.refreshing; i++) { await new Promise((r) => setTimeout(r, 20)); e = mgr.getView(root, st, 0); }
    assert.equal(e.refreshing, false, '后台重算要在有限时间内完成');
    assert.equal(e.payload.meta.builtAt, led.builtAt, '算完后缓存要原子换成新构建');
  } finally { mgr.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('懒建账契约：廉价画像不调 libraryOf、打开即建占位、未建账标灰、画布认 building（PRD-load）', async () => {
  // 静态：画像扫描廉价化（criterion 5）——只读已建账 ledger 头＋stat，不跑 outstandingFor、不扫宿主目录。
  const profSrc = fs.readFileSync(new URL('../src/profile-auto.mjs', import.meta.url), 'utf8');
  // 判据是「不 import/调用」，注释里解释为什么不调它不算违规——只查真的 import 与调用。
  assert.ok(!/import\s+[^;]*\blibraryOf\b/.test(profSrc) && !/\blibraryOf\s*\(/.test(profSrc), 'profileDue 不许 import/调用 libraryOf（那会逐会话 outstandingFor）');
  assert.ok(!/listSessions|sourceIndex/.test(profSrc), 'profileDue 不扫宿主源目录，只读已建账 ledger');
  assert.match(profSrc, /ledger\.json/, '廉价画像扫描读每个已建账 ledger.json');
  assert.match(profSrc, /source\.jsonl/, 'lastWriteAt 回落归档，与 library.statusOf 同一条链');

  // 静态：Stop 顺序契约＋活跃集门控（criterion 6）——收尾/补账组装在画像之前。
  const hookSrc = fs.readFileSync(new URL('../hooks/ledger-brief.mjs', import.meta.url), 'utf8');
  const iClose = hookSrc.indexOf('closeoutFor(sid, input.transcript_path');
  const iSum = hookSrc.indexOf('summariseFor(sid, input.transcript_path');
  const iProf = hookSrc.indexOf('profileDue(STORE)');
  assert.ok(iClose > -1 && iSum > -1 && iProf > -1, 'Stop 组装要含收尾/补账/画像三段');
  assert.ok(iClose < iProf && iSum < iProf, '当前会话先收尾/补账、后画像（顺序契约）');
  assert.match(hookSrc, /function currentIsLive/, 'Stop 补账要有活跃集门控');
  assert.match(hookSrc, /idle-session/, 'idle 当前会话跳过补账催办');

  // 静态：未建账廉价条目＋默认 store 守卫（criterion 3）。
  const libSrc = fs.readFileSync(new URL('../src/library.mjs', import.meta.url), 'utf8');
  assert.match(libSrc, /built: false/, '未建账条目标 built:false');
  assert.match(libSrc, /organize: null/, '未建账条目不算整理度');
  assert.match(libSrc, /isDefaultStore\(root\)/, '只有默认 store 才扫宿主列未建账（夹具关得住真机）');

  // 静态：画布处理 building 占位（criterion 7）。
  const atlasSrc = fs.readFileSync(new URL('../web/atlas.js', import.meta.url), 'utf8');
  assert.match(atlasSrc, /v\.meta\.building/, '画布要认 building 占位，不 adopt 空图');
  assert.match(atlasSrc, /正在建账/, 'building 时显示正在建账骨架');

  // 行为：打开未建账会话＝后台建账＋占位，建完出真视图（criterion 4）。
  const { createRefresh } = await import('../src/refresh.mjs');
  const root = fixture('load-open');
  const srcDir = `${root}/host`;
  fs.mkdirSync(srcDir, { recursive: true });
  const sid = 'opensession0001';
  const src = `${srcDir}/${sid}.jsonl`;
  fs.writeFileSync(src, headLines(FILE, 262144).join('\n') + '\n');
  const dir = `${root}/${sid}`;
  const mgr = createRefresh();
  const st = { dir, id: sid, sourceFile: src, lastError: null };
  try {
    const a = mgr.getView(root, st, 0);
    assert.equal(a.payload.meta.building, true, '冷开无 ledger 要回 building 占位');
    assert.equal(a.refreshing, true, '占位标 refreshing，前台转圈不阻塞');
    assert.deepEqual(a.payload.steps, [], '占位是空结构，前台不崩');
    assert.ok(!fs.existsSync(`${dir}/ledger.json`), '主线程绝不内联 build');
    let v = a;
    for (let i = 0; i < 250 && v.payload.meta.building; i++) { await new Promise((r) => setTimeout(r, 20)); v = mgr.getView(root, st, 0); }
    assert.ok(fs.existsSync(`${dir}/ledger.json`), 'worker 要把账建出来落盘');
    assert.ok(!v.payload.meta.building, '建完不再标 building');
    assert.ok(v.payload.nodes.length > 0, '建完出真视图');
  } finally { mgr.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('自动建账 sweep 三档：active 只建 live、off 一个不建、all 建全部，封顶 cap（PRD-load §2.2）', () => {
  const base = fixture('load-sweep');
  const home = `${base}/home`;
  const projDir = `${home}/.qoder/projects/fixture`;
  fs.mkdirSync(projDir, { recursive: true });
  // opencode 适配器的根是 TOOL/out/opencode（不随 HOME 走）：用 CONVLEDGER_OPENCODE_OUT
  // 指到空夹具目录，否则真机几十段投影会漏进 sweep 候选。
  const ocEmpty = `${base}/oc-empty`;
  fs.mkdirSync(ocEmpty, { recursive: true });
  const body = headLines(FILE, 262144).join('\n') + '\n';
  assert.ok(Buffer.byteLength(body) > 20000, '夹具源要 >20KB 才进 sweep 候选');
  const liveSid = 'livesession0001', idleSid = 'idlesession0001';
  fs.writeFileSync(`${projDir}/${liveSid}.jsonl`, body);
  fs.writeFileSync(`${projDir}/${idleSid}.jsonl`, body);
  const old = new Date(Date.now() - 40 * 60000);
  fs.utimesSync(`${projDir}/${idleSid}.jsonl`, old, old);

  // sweepJob 用 listSessions()（宿主根现在惰性读 *_CONFIG_DIR）：子进程把 HOME/USERPROFILE
  // 与三个 *_CONFIG_DIR 全部指到夹具家、CONVLEDGER_OPENCODE_OUT 指到空目录。父进程可能带着
  // 宿主注入的 WORKBUDDY_CONFIG_DIR=<真机目录>，不显式覆盖就会把真机几百段对话漏进候选。
  const refreshUrl = pathToFileURL(`${tools}/src/refresh.mjs`).href;
  const script = `${base}/sweep-probe.mjs`;
  fs.writeFileSync(script, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    `import { createRefresh } from '${refreshUrl}';`,
    "const [storeRoot, mode, cap] = process.argv.slice(2);",
    "const mgr = createRefresh();",
    "mgr.sweep(storeRoot, { mode, liveMin: 15, cap: Number(cap) });",
    "await mgr.getStatus(storeRoot);",   // worker 串行：status 排在 sweep 后，resolve 即 sweep 已完成
    "const built = fs.existsSync(storeRoot) ? fs.readdirSync(storeRoot).filter((d) => fs.existsSync(path.join(storeRoot, d, 'ledger.json'))) : [];",
    "mgr.stop();",
    "process.stdout.write(JSON.stringify({ built }));",
  ].join('\n') + '\n');
  const run = (mode, cap) => {
    const storeRoot = `${base}/store-${mode}`;
    fs.mkdirSync(storeRoot, { recursive: true });
    const r = spawnSync(process.execPath, [script, storeRoot, mode, String(cap)], {
      cwd: tools, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, HOME: home, USERPROFILE: home, CONVLEDGER_OPENCODE_OUT: ocEmpty,
        QODER_CONFIG_DIR: `${home}/.qoder`, CLAUDE_CONFIG_DIR: `${home}/.claude`,
        WORKBUDDY_CONFIG_DIR: `${home}/.workbuddy` },
    });
    assert.equal(r.status, 0, `sweep ${mode} 子进程退出 ${r.status}：${r.stderr}`);
    return JSON.parse(r.stdout).built.sort();
  };
  try {
    assert.deepEqual(run('off', 10), [], 'off 模式一个都不建');
    assert.deepEqual(run('active', 1), [liveSid], 'active 只建 live 那段，idle 旧对话不建');
    assert.deepEqual(run('all', 10), [idleSid, liveSid].sort(), 'all 模式建全部未建账（旧行为）');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('Stop 活跃集门控：idle 旧会话不催补账，live 会话才进补账（PRD-load §2.5）', () => {
  const base = fixture('load-idle');
  const SID = 'idlesession0001';
  const src = `${base}/projects/fixture/${SID}.jsonl`;
  fs.mkdirSync(`${base}/projects/fixture`, { recursive: true });
  // 用合成源，不切真实会话：那段 Qoder 会话开头 8KB 里带 convledger-internal 哨兵，
  // hook 会把它当成「本工具自己派的后台会话」直接静默退出，永远走不到 idle 门控。
  fs.writeFileSync(src, synthLines(SID, 8, 'D:/fixture/idle'), 'utf8');
  const store = `${base}/store`;
  fs.mkdirSync(`${store}/${SID}`, { recursive: true });
  // 没有 cwd → closeoutFor 跳过（no-cwd），正好落到补账门控那一段；segments 空 → 无综述欠项。
  fs.writeFileSync(`${store}/${SID}/ledger.json`, JSON.stringify({ sessionId: SID, runner: 'qoder', sourceFile: src, segments: [] }));
  const env = { ...process.env, QODER_CONFIG_DIR: base, WORKBUDDY_CONFIG_DIR: `${base}/nowb`, CONVLEDGER_HOOK_STORE: store, CONVLEDGER_HOOK_LOG: `${base}/log.jsonl` };
  const hook = () => spawnSync(process.execPath, ['hooks/ledger-brief.mjs'], {
    cwd: tools, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env,
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: SID, transcript_path: src, cwd: 'D:/fixture/idle', stop_hook_active: false }),
  });
  const lastReason = () => {
    const rows = fs.readFileSync(`${base}/log.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    return rows[rows.length - 1].reason ?? '';
  };
  try {
    const old = new Date(Date.now() - 40 * 60000);
    fs.utimesSync(src, old, old);
    const idle = hook();
    assert.equal(idle.status, 0, idle.stderr);
    assert.equal(idle.stdout, '', 'idle 旧会话不该催补账');
    assert.match(lastReason(), /idle-session/, 'idle 当前会话要标明跳过补账');

    const now = new Date();
    fs.utimesSync(src, now, now);
    const live = hook();
    assert.equal(live.status, 0, live.stderr);
    assert.ok(!/idle-session/.test(lastReason()), 'live 会话不该被 idle 门控挡下');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('hub：一个端口服务所有会话，/health 只报 hub，同端口不重复起', async () => {
  // 单独一条：上面那条走的是正文/闸门，它红在成本上时不该把 hub 语义一起埋掉。
  const root = fixture('map-port');
  fs.rmSync(root, { recursive: true, force: true });
  writeStore(root, built);
  const otherRoot = fixture('map-other');
  fs.rmSync(otherRoot, { recursive: true, force: true });
  fs.mkdirSync(`${otherRoot}`, { recursive: true });
  // 第二段会话放进同一个 store：hub 的多会话＝同一端口下两个路径，不是两个端口。
  fs.mkdirSync(`${root}/other-session-0001`, { recursive: true });
  fs.writeFileSync(`${root}/other-session-0001/ledger.json`, JSON.stringify({ sessionId: 'other-session-0001', sourceFile: `${otherRoot}/gone.jsonl`, cwd: 'D:/elsewhere', segments: [] }));

  let hubKey = null;
  const get = (port, path, extra = {}) => new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path, headers: { ...(hubKey ? { 'x-hub-key': hubKey } : {}), ...extra } }, (x) => {
      let b = ''; x.on('data', (d) => { b += d; }); x.on('end', () => res({ status: x.statusCode, body: b, headers: x.headers }));
    }).on('error', rej);
  });

  const h = await serveMap({ root, port: 8792, rebuildSec: 0 });
  hubKey = h.token;
  try {
    const health = JSON.parse((await get(8792, '/health')).body);
    // 少一个字段，复用判定就会认错人——这些是 hub 协议的接口，不是展示文案
    assert.equal(health.ok, true);
    assert.equal(health.hub, true, 'hub 的 /health 必须自报家门');
    assert.equal(health.port, 8792);
    assert.equal(health.pid, process.pid);
    assert.equal(health.session, undefined, '/health 不报会话——会话由路径决定');

    // 门禁钥匙要单独落盘：hub.json 退出时会删，token 跟着没就会每次重启换钥匙、老窗口转圈。
    const tokenFile = path.join(path.dirname(root), 'hub-token');
    assert.equal(fs.readFileSync(tokenFile, 'utf8').trim(), h.token, 'token 必须写进 out/hub-token');
    // 老窗口带着上一任 cookie 再访问 ?k=新钥匙：必须覆盖 cookie，否则 /app.js 继续 403。
    const stale = await get(8792, `/app?k=${h.token}`, { cookie: `hubk=${'0'.repeat(48)}` });
    assert.match(String(stale.headers['set-cookie'] || ''), new RegExp(`hubk=${h.token}`),
      '带 ?k= 的响应要刷新旧 cookie');
    // setup 侧也要优先读专用钥匙文件
    assert.match(fs.readFileSync(new URL('../src/setup.mjs', import.meta.url), 'utf8'), /'out', 'hub-token'/,
      'readHubToken 先读 out/hub-token');
    // app.js 被门禁挡住时，启动页不能永远一个样子
    assert.match(fs.readFileSync(new URL('../web/app.html', import.meta.url), 'utf8'), /连接超时/, '启动页要有时限提示');

    const self = JSON.parse((await get(8792, `/s/${ledger.sessionId}/health`)).body);
    assert.equal(self.session, ledger.sessionId, '/s/<id>/health 必须报出这段会话的 id');
    assert.equal(self.runner, ledger.runner);
    assert.equal(self.cwd, ledger.cwd);
    assert.equal(self.segments, segments.length);
    assert.equal(self.archive.exists, true, '画布启动即归档，/s/<id>/health 要能看见');
    assert.ok(self.archive.bytes > 0);

    const other = JSON.parse((await get(8792, '/s/other-session-0001/health')).body);
    assert.equal(other.session, 'other-session-0001', '同一端口要能同时服务第二段会话');

    // 项目任务入口：/p/<键>/ 只读页 + /projects.json 清单（与会话用同一套 Host 限制）
    const pkey = projectKey(built.ledger.cwd);
    const pst = createState(pkey);
    pst.milestones.push({ id: 'PM001', short: '夹具', title: '夹具', goal: '', scopeBasis: { kind: 'approved-plan' } });
    pst.tasks.push({
      id: 'PT001', revision: 1, milestoneId: 'PM001', dependsOn: [], scopeBasis: { kind: 'user-request', ref: 'R' },
      short: '夹具任务', title: '夹具任务', goal: '', status: 'active', result: null, remaining: '欠一项',
      blocker: null, nextAction: null, acceptance: [], evidence: [], actor: 'test', sourceSessions: ['s'],
      occurredAt: null, recordedAt: '2026-10-29T00:00:00.000Z',
    });
    writeState(root, pkey, pst);
    const plist = JSON.parse((await get(8792, '/projects.json')).body);
    assert.ok(plist.projects.some((p) => p.key === pkey), '/projects.json 没列出有任务状态的项目');
    assert.ok(Array.isArray(plist.rootKeys) && plist.rootKeys.includes(pkey), '/projects.json 要把根项目键带给架构路线图');
    assert.ok(plist.membersByKey && pkey in plist.membersByKey, '/projects.json 要保留每个项目的会话成员表');
    const ppage = await get(8792, `/p/${pkey}/`);
    assert.equal(ppage.status, 200);
    assert.match(ppage.body, /夹具任务/, '项目页要带出任务');
    assert.match(ppage.body, /data-lv="overview"/, '项目页要带四档切换');
    assert.match(ppage.body, /返回会话/, '项目页要留一条回会话画布的路');
    assert.match(ppage.body, /back-session/, '回会话的链接要有稳定的类名（样式与测试都靠它）');
    assert.match(ppage.body, /setInterval\(function/, '项目页要定时轮询自己，不然新任务永远看不见');
    assert.match(ppage.body, /\/data\.json/, '轮询读的是 /p/<键>/data.json');
    assert.match(ppage.body, /会话实时/, '项目页要有一块「会话实时」，不能只列已收尾的任务');
    assert.match(ppage.body, /每 5 秒/, '实时卡要标明刷新节奏');
    assert.match(ppage.body, /收尾后更新/, '任务模型要标明只在收尾同步后更新');
    assert.match(ppage.body, /livebox/, '会话实时要有稳定的容器，轮询才能原地重画');
    assert.match(ppage.body, /liveSig/, '轮询要比较会话实时位，步数变了也得重画');
    assert.match(ppage.body, /id="insights"/, '项目页要有经验与画像的位置');
    assert.match(ppage.body, /经验 · 按阶段/, '经验块要按阶段收拢');
    assert.match(ppage.body, /用户画像 · 做事方式/, '画像块要标明它是什么');
    assert.match(ppage.body, /维度覆盖/, '画像卡要显示目标/边界/验收等维度覆盖');
    const pdata = JSON.parse((await get(8792, `/p/${pkey}/data.json`)).body);
    assert.ok('live' in pdata, '项目页 data.json 必须带会话实时，而不只是任务模型');
    assert.ok('insights' in pdata, 'data.json 必须带经验与画像，5 秒轮询才能刷新');
    assert.ok(pdata.insights && Array.isArray(pdata.insights.experience.groups), '经验要有分组结构');
    assert.ok(pdata.insights.profile && pdata.insights.profile.project && pdata.insights.profile.user, '画像要带两张表的条目');
    assert.ok(pdata.live.ok && pdata.live.members >= 1, '有会话的项目要带出成员');
    assert.equal((await get(8792, `/p/${pkey}/data.json`)).status, 200);
    assert.equal((await get(8792, '/p/p-000000000000/')).status, 404);
    const noSessionKey = 'p-000000000001';
    writeState(root, noSessionKey, createState(noSessionKey));
    const noSessionData = JSON.parse((await get(8792, `/p/${noSessionKey}/data.json`)).body);
    assert.equal(noSessionData.live.ok, false, '没有对应会话的项目如实为空，不编步号');
    // 有会话、但还没跑过收尾的项目：给一个可读的空状态页，而不是纯文本 404
    const emptyKey = projectKey('D:/elsewhere');
    const ep = await get(8792, `/p/${emptyKey}/?from=${encodeURIComponent(`/s/${ledger.sessionId}/`)}`);
    assert.equal(ep.status, 200, '有会话但没任务状态的项目必须返回可读页面，不是裸 404');
    assert.match(ep.body, /还没有任务状态/, '空状态页要说清为什么空');
    assert.match(ep.body, /sync --prepare/, '空状态页要给生成任务状态的命令');
    assert.match(ep.body, /back-session/, '空状态页也要有回会话的入口');
    assert.match(ep.body, /打开会话库/, '空状态页要能回会话库');
    assert.match(ep.body, /\/s\/other-session-0001\//, '空状态页要能点进项目里的会话');
    assert.equal((await get(8792, '/p/p-000000000000/')).headers['content-type'].includes('text/html'), true, '未知项目也要给带导航的 HTML');

    const again = await serveMap({ root, port: 8792, rebuildSec: 0 });
    assert.equal(again.reused, true, 'hub 已在同一端口上跑着却不复用——那会让一次会话开出第二个服务');
    again.stop();

    // 端口被别的程序占着：不许悄悄换端口，地址稳定优先
    const plain = http.createServer((q, s2) => { s2.writeHead(200, { 'content-type': 'application/json' }); s2.end('{"ok":true}'); });
    await new Promise((r) => plain.listen(8793, '127.0.0.1', r));
    await assert.rejects(
      () => serveMap({ root, port: 8793, rebuildSec: 0 }),
      /不是本工具的 hub/,
      '端口被非 hub 服务占着时换端口或静默失败都会让地址失去意义',
    );
    await new Promise((r) => plain.close(r));
  } finally { h.stop(); }
});

// 项目页的「会话实时」：任务模型要收尾才更新，这一步不能等 sync；但只读账本，不编任务。
test('项目页的会话实时：报最近一步与未收尾字节，不碰任务状态', () => {
  const base = fixture('project-live');
  const root = `${base}/store`;
  writeStore(root, built);
  const key = projectKey(built.ledger.cwd);
  const state = createState(key);
  const live = projectLive(root, key, state);
  assert.equal(live.ok, true, '有对应会话账本时项目实时必须成立');
  assert.equal(live.session.id, built.ledger.sessionId);
  assert.ok(live.step && live.step.n > 0, '最近主线步必须从账本现读');
  assert.equal(live.pendingBytes, live.sourceBytes, '没有 checkpoint 时必须把整段源算作未收尾，不能假装已同步');
  state.checkpoints = { [built.ledger.sessionId]: { analyzedThrough: live.sourceBytes } };
  const done = projectLive(root, key, state);
  assert.equal(done.pendingBytes, 0, '已分析到源尾时应收敛为 0');
  assert.equal(done.session.id, live.session.id, '实时块只读会话，不因为 checkpoint 变化就换会话');
  fs.rmSync(base, { recursive: true, force: true });
});

test('当前会话解析：同 cwd 优先、--session 最高、源没了仍认账本', () => {
  const base = fixture('current');
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(`${base}/src`, { recursive: true });
  const store = `${base}/store`;
  const sidA = 'aaaa1111-0000-0000-0000-000000000000';
  const sidB = 'bbbb2222-0000-0000-0000-000000000000';
  const sidC = 'cccc3333-0000-0000-0000-000000000000';
  const mkLedger = (id, cwd) => {
    fs.mkdirSync(`${store}/${id}`, { recursive: true });
    fs.writeFileSync(`${store}/${id}/ledger.json`, JSON.stringify({ sessionId: id, cwd, segments: [], sourceFile: `${base}/src/${id}.jsonl` }));
  };
  mkLedger(sidA, 'D:/work/a');
  mkLedger(sidB, 'D:/work/b');
  mkLedger(sidC, 'D:/work/c');            // 只有账本，源已经被运行器清掉
  const srcOf = (id, cwd) => {
    const f = `${base}/src/${id}.jsonl`;
    fs.writeFileSync(f, JSON.stringify({ type: 'workspace-directories', directories: [cwd] }) + '\n');
    return f;
  };
  // listSessions 的形状：mtime 倒序。B 比 A 新——同 cwd 的 A 仍然该赢。
  const rows = [
    { sessionId: sidB, file: srcOf(sidB, 'D:/work/b'), runner: 'qoder', mtime: '2026-10-02T00:00:00.000Z' },
    { sessionId: sidA, file: srcOf(sidA, 'D:/work/a'), runner: 'qoder', mtime: '2026-10-01T00:00:00.000Z' },
  ];
  const r1 = resolveCurrent({ root: store, cwd: 'd:\\WORK\\a\\', sessions: rows });
  assert.equal(r1.sessionId, sidA, '同工作目录的会话没被选中（大小写、反斜杠、尾斜杠都要归一）');
  assert.equal(r1.reason, 'cwd');
  const r2 = resolveCurrent({ root: store, cwd: 'D:/work/a', preferred: 'bbbb', sessions: rows });
  assert.equal(r2.sessionId, sidB, '--session 必须压过 cwd');
  assert.equal(r2.reason, 'preferred');
  const r3 = resolveCurrent({ root: store, cwd: 'D:/nowhere', sessions: rows });
  assert.equal(r3.sessionId, sidB, '没有同 cwd 的会话时该退到最新写入的那段');
  assert.equal(r3.reason, 'newest');
  const r4 = resolveCurrent({ root: store, cwd: 'D:/work/a', preferred: 'cccc', sessions: rows });
  assert.equal(r4.sessionId, sidC, '源没了但账本还在的会话也要认——画布靠最后一次构建＋归档继续服务');
  assert.equal(r4.sourceMissing, true);
  assert.equal(r4.file, null);
  assert.match(resolveCurrent({ root: store, cwd: 'D:/work/a', preferred: 'nope', sessions: rows }).error, /没有以 nope 开头/);
  // 文件头就是 cwd 的 runner（不建账也能判）；只有大日志才走这条快路径
  const headFile = `${base}/src/head-only.jsonl`;
  fs.writeFileSync(headFile, JSON.stringify({ type: 'message', cwd: 'D:/work/wb' }) + '\n');
  assert.equal(cwdFromHead(headFile), 'D:/work/wb');
});

test('归档：画布服务过的会话即使源被清掉，正文与锚点仍可回源（并声明读自归档）', () => {
  const base = fixture('archive');
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(`${base}/src`, { recursive: true });
  const file = `${base}/src/arch-fixture-0001.jsonl`;
  const user = (n, t) => ({ timestamp: `2026-01-01T00:0${n}:00.000Z`, type: 'user', humanInput: true, message: { role: 'user', content: [{ type: 'text', text: t }] } });
  const asst = (n, t) => ({ timestamp: `2026-01-01T00:0${n}:30.000Z`, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });
  const lines = [
    JSON.stringify({ type: 'workspace-directories', directories: ['D:/fixture/arch'] }),
    JSON.stringify(user(1, '归档夹具：第一句')),
    JSON.stringify(asst(1, '第一句的回话')),
    JSON.stringify(user(2, '归档夹具：第二句')),
    JSON.stringify(asst(2, '第二句的回话')),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const b = build(file, { storeRoot: `${base}/store` });
  const dir = writeStore(`${base}/store`, b);
  const L = loadLedger(`${base}/store`, b.sessionId).ledger;
  assert.ok(L.archiveFile, '建账时没记下归档路径——源被清掉后就没法回落了');

  const a1 = syncArchive(dir, file);
  assert.equal(a1.bytes, fs.statSync(file).size, '首次归档必须逐字等于源');
  fs.appendFileSync(file, JSON.stringify(user(3, '归档夹具：第三句')) + '\n');
  const a2 = syncArchive(dir, file);
  assert.equal(a2.bytes, fs.statSync(file).size, '增量归档没跟上源');
  // 半行冻在最后一个换行：冻进去 readJsonl 就多一条 unparseable
  fs.appendFileSync(file, '{"type":"user","humanInput":true,"message":{"role":"user","content":[{"type":"text","text":"半行');
  const a3 = syncArchive(dir, file);
  assert.equal(a3.bytes, a2.bytes, '半行被写进了归档');
  assert.ok(fs.readFileSync(`${dir}/source.jsonl`, 'utf8').startsWith(lines[0]), '归档头部被改写——它只能是源的逐字镜像');

  fs.rmSync(file);                       // 运行器把源日志清了
  const ef = effectiveSource(L);
  assert.equal(ef.archived, true, '源没了却没回落到归档');
  assert.ok(String(ef.file).endsWith('/source.jsonl'));
  const c1 = checkAnchor(L, L.segments[0]);
  assert.equal(c1.ok, true, '归档里的字节和建账时不一致');
  assert.equal(c1.archived, true, '校验的是归档，结果里必须标出来');
  const body = renderBody(L, resolveSegments(L, 'all'), {}).text;
  assert.match(body, /读自账本归档/, '正文没说清楚读的是归档');
  assert.match(body, /第一句/);
  assert.equal(searchLedger(L, '第一句').archived, true);
  assert.equal(archiveState(dir).exists, true, '源没了，归档也不许跟着消失');
});

test('a branch earns its level and a topic name must be a word the segment itself said', () => {
  const root = fixture('branch');
  const dir = writeStore(root, built);
  const claims = JSON.parse(fs.readFileSync(`${dir}/claims.json`, 'utf8'));
  const tree = deriveBranches(ledger, claims);

  // branches are a partition of the chain, and none of them opens at a compaction
  const members = tree.branches.flatMap((b) => b.segments);
  assert.equal(new Set(members).size, segments.length, '有段落在了所有支之外');
  assert.equal(members.length, segments.length, '有段同时挂在两条支上');
  for (const b of tree.branches) {
    assert.notEqual(segments.find((s) => s.id === b.head).kind, 'boundary', `${b.id} 的头是一次压缩`);
    assert.equal(b.level, BRANCH_STATES.findIndex((s) => s.id === b.state), `${b.id} 的级别和状态名不是一对`);
  }

  // The ladder has to be un-climbable by assertion: write a file nobody ever reads
  // again and the branch stops at 已落地, however confident the segment sounds.
  const clean = tree.branches.find((b) => !b.wrote.length);
  if (clean) {
    const forged = structuredClone(ledger);
    forged.segments.find((s) => s.id === clean.head).filesWritten = ['D:/selftest/zz-never-read-me-8f2a1c.md'];
    const after = deriveBranches(forged, claims).branches.find((b) => b.head === clean.head);
    assert.equal(after.level, 2, `伪造的落地物把它抬到了 ${after.state}：已复核没在守门`);
  }
  const think = tree.branches.find((b) => b.verified.length && !b.wrote.length);
  if (think) assert.equal(think.level, 1, `${think.id} 只有已证增量却报 ${think.stateLabel}`);

  const route = (p) => fs.readFileSync(`${dir}/${p}`, 'utf8');
  const before = { index: route('index.md'), cards: segments.map((s) => route(`segments/${s.id}.md`)) };
  const proved = Object.keys(claims).find((id) => claims[id]?.basis === 'verified');
  if (!proved) return; // nothing proved in this session, so the label gates have no material
  const name = claims[proved].topic;
  const unproved = segments.find((s) => claims[s.id]?.basis !== 'verified').id;
  const gate = (segId, tname, t) => validateLabel({ segId, tname, ledger, claims, topics: t ?? { schema: 'convledger-topics/1', topics: [{ id: 'T1', name }], labels: {} } });
  assert.ok(name, `${proved} 已证却没有可复用的把手`);
  assert.ok(gate(proved, name).ok, '已证增量里的原词挂不上话题');
  assert.ok(!gate(proved, '量子检索从没提过的事').ok, '编出来的话题名挂上了');
  assert.ok(!gate(unproved, name).ok, '没证过的段挂上了话题');
  assert.ok(!gate(proved, '一个'.repeat(TOPIC_NAME_MAX * 4)).ok, '超长的话题名挂上了');
  const full = { schema: 'convledger-topics/1', topics: ['T1', 'T2', 'T3', 'T4'].map((id) => ({ id, name })), labels: { [proved]: ['T1', 'T2', 'T3'] } };
  assert.ok(!gate(proved, name, full).ok, `一段挂过了 ${MAX_TOPICS_PER_SEGMENT} 个话题的上限`);
  const single = { schema: 'convledger-topics/1', topics: [{ id: 'T1', name }], labels: { [proved]: ['T1'] } };
  assert.ok(gate(proved, name, single).provisional, '单段就成支了');
  assert.equal(publishedTopics(single).length, 0, `覆盖 <${MIN_SEGMENTS_PER_TOPIC} 段的话题被发布了`);
  assert.equal(publishedTopics({ ...single, labels: { ...single.labels, [unproved]: ['T1'] } }).length, 1, '两段共用的话题没成支');

  // Writing the table must leave the route layer byte-identical: topics annotate,
  // they never enter the index or a card.
  writeTopics(dir, { schema: 'convledger-topics/1', topics: [{ id: 'T1', name }], labels: { [proved]: ['T1'] } });
  assert.equal(route('index.md'), before.index, '话题层动了 index.md');
  assert.deepEqual(segments.map((s) => route(`segments/${s.id}.md`)), before.cards, '话题层动了路由卡');

  const v = readView(dir);
  assert.equal(v.tasks.length, tree.count, '地图上的支数和对账的支数不是一份');
  assert.equal(v.meta.topicBranches, 0, '单段话题上了地图');
  assert.equal(v.nodes.find((n) => n.id === proved).task, tree.branchOf[proved], '节点没带上它所在的支');
  for (const t of v.tasks) {
    assert.ok(String(t.title).length <= 210 && String(t.outs).length <= 210, `${t.id} 的支头条在抄正文`);
    assert.ok(t.criterion, `${t.id} 的状态没带判据`);
  }
});

test('the frame skeleton forks and rejoins, and every note and brief quotes only fields', () => {
  const root = fixture('tree');
  const dir = writeStore(root, built);
  const v = readView(dir);
  const chain = v.nodes.map((n) => n.id);
  const at = (id) => chain.indexOf(id);
  const taskOf = {};
  for (const t of v.tasks) taskOf[t.id] = t;

  // C1 — one frame row per branch, stacked in time order, and an 插曲支 hangs under a
  // segment that comes BEFORE its own head (that is what keeps the host chain acyclic).
  assert.equal(v.frames.length, v.tasks.length, 'frame 的行数和支的条数不是一份');
  assert.equal(new Set(v.frames.map((f) => f.id)).size, v.tasks.length, '有条支在骨架里出现两次');
  for (let i = 0; i < v.frames.length; i++) {
    const f = v.frames[i];
    assert.ok(taskOf[f.id], `${f.id} 的 frame 指回不了一条支`);
    assert.equal(f.head, taskOf[f.id].head, `${f.id} 的 frame 头段和对账不一样`);
    assert.ok(at(f.head) >= 0, `${f.id} 的支头不在段序列里`);
    if (i) assert.ok(at(f.head) > at(v.frames[i - 1].head), `${f.id} 的 frame 竖排不是时间顺序`);
    if (!f.host) continue;
    assert.ok(at(f.host) >= 0, `${f.id} 挂在 ${f.host} 上，但那是个不存在的段`);
    assert.ok(at(f.host) < at(f.head), `${f.id} 的宿主段 ${f.host} 排在它自己支头后面`);
    assert.notEqual(v.nodes[at(f.host)].task, f.id, `${f.id} 挂在自己支里的段上`);
    let hops = 0, cur = f.id;
    const seen = {};
    for (;;) {
      const host = v.frames.find((x) => x.id === cur)?.host;
      if (!host) break;
      cur = v.nodes[at(host)].task;
      if (seen[cur]) break;
      seen[cur] = 1;
      hops++;
    }
    assert.equal(f.depth, hops, `${f.id} 的缩进层数不是沿宿主走上去的步数`);
  }

  // C2 — every segment sits in exactly one frame, and the frame holds what the ledger says.
  for (const t of v.tasks) {
    assert.equal(v.nodes.filter((n) => n.task === t.id).length, t.segs, `${t.id} frame 里的段数和账上不一样`);
  }
  assert.ok(v.nodes.every((n) => n.task && taskOf[n.task]), '有段不归任何支，骨架会把它藏起来');

  // B2 — every word inside a bracket names a field. This is a grammar check, not a
  // vibe check: anything the ledger cannot recompute has to be refused here.
  const MOVE = ['insight', 'ruleout', 'decision', 'pivot', 'open'];
  const STATE = ['未证', '已想清', '已落地', '已复核'];
  const allowed = (p) =>
    /^段\d+$/.test(p) || /^已证\d+$/.test(p) || /^写\d+$/.test(p) || /^留问\d*$/.test(p) ||
    /^⚠\d+$/.test(p) || ['已证', '站位', '未证'].includes(p) || MOVE.includes(p) || p === '无人回读' ||
    /^回读@S\d{2,}$/.test(p) || STATE.some((s) => p === s || p.startsWith(`${s}·`));
  const audit = (label, note) => {
    assert.match(note, /^〔.*〕$/, `${label} 的说明不是一副中括号`);
    for (const p of note.slice(1, -1).split(' ').filter(Boolean)) {
      assert.ok(allowed(p), `${label} 的说明里有对不回算字段的词：「${p}」`);
    }
    // 「有没有全部完成」在结构上不可知，所以括号里不许出现合成的结论
    assert.ok(!/完成|成功|搞定|不错|失败/.test(note), `${label}: ${note}`);
  };
  for (const t of v.tasks) {
    audit(t.id, t.note);
    assert.ok(t.note.includes(`段${t.segs}`), `${t.id} 括号里的段数不是它的段数`);
    assert.ok(t.note.includes(`已证${t.verified}`), `${t.id} 括号里的已证数不是判据给的那几条`);
    assert.ok(t.note.includes(t.wrote ? `写${t.wrote}` : '写0'), `${t.id} 括号里的写N不是 filesWritten 数`);
    // 留问可以上两位数（这条曾经只写 \d?，B75 到 10 条时被误判成"不回算的词"）
    assert.equal(t.note.slice(1, -1).split(' ').find((p) => p.startsWith('留问')), t.open ? `留问${t.open}` : undefined, `${t.id} 括号里的留问数不是 claim 里 open 的条数`);
    assert.ok(t.note.includes(`${t.stateLabel}·${t.closedLabel}`), `${t.id} 没把完成度和收尾状态一起说`);
  }
  for (const n of v.nodes) {
    audit(n.id, n.note);
    assert.ok(n.note.includes(n.wrote ? `写${n.wrote}` : '写0'), `${n.id} 的写N不是它自己的 filesWritten 数`);
    assert.ok(!n.errs || n.note.includes(`⚠${n.errs}`), `${n.id} 有报错却没标`);
    assert.equal(n.note.includes('留问'), (n.moves || '').split(' ').includes('open'), `${n.id} 的留问不是 claim 里的 open`);
  }

  // D2 — a fork that came back. A side episode ENDS its host branch (the run rule), so the
  // mainline resumes as a NEW depth-0 branch: `rejoin` is the first spine head after it.
  // Empty means the session is still inside the detour — 未汇回 is a fact, not a gap.
  for (let i = 0; i < v.frames.length; i++) {
    const f = v.frames[i];
    if (!f.host) assert.equal(f.rejoin, '', `${f.id} 不是插曲，却有汇回点`);
    if (!f.rejoin) continue;
    const mem = v.nodes.filter((n) => n.task === f.id);
    assert.ok(at(f.rejoin) > at(mem[mem.length - 1].id), `${f.id} 的汇回点 ${f.rejoin} 排在支内最后一段之前`);
    assert.equal(f.rejoin, v.frames.slice(i + 1).find((x) => !x.host)?.head, `${f.id} 汇回到的不是之后第一个主干支头`);
  }
  assert.ok(v.frames.some((f) => f.host), '测试样本里没有插曲支，D2 是空跑——换一个有 ⤷ 的会话');

  // D1 — the brief is a readout, not a write-up: every count has to equal an independent
  // recount over the same view, and every quoted sentence has to be verbatim 已证原文.
  const b = v.brief;
  const c = Object.fromEntries(b.counts.map((x) => [x.k, x.v]));
  const proved = v.nodes.filter((n) => n.basis === 'verified' && n.claim);
  const withMove = (mv) => proved.filter((n) => ` ${n.moves} `.includes(` ${mv} `)).length;
  assert.equal(c['段'], String(v.nodes.length), '简报的段数不是段数');
  assert.equal(c['支'], String(v.tasks.length), '简报的支数不是支数');
  assert.equal(c['插曲'], String(v.frames.filter((f) => f.host).length), '简报的插曲数不是有宿主的 frame 数');
  assert.equal(c['转向'], String(v.nodes.filter((n) => n.kind.startsWith('pivot')).length), '简报的转向数不是结构上 pivot 的段数');
  assert.equal(c['已证'], String(proved.length), '简报的已证数不是过了判据的段数');
  assert.equal(c['决策'], String(withMove('decision')), '简报的决策数不是已证里带 decision 的条数');
  assert.equal(c['排除'], String(withMove('ruleout')), '简报的排除数不是已证里带 ruleout 的条数');
  assert.equal(c['留问'], String(v.nodes.filter((n) => n.open).length), '简报的留问数不是带 open 的段数');
  assert.equal(c['报错'], String(v.nodes.filter((n) => n.errs).length), '简报的报错数不是有报错的段数');
  assert.equal(c['压缩'], String(v.meta.boundaries), '简报的压缩数不是边界数');
  assert.equal(b.open.length, +c['留问'], '简报正文里的留问段号和计数行不是一个数');
  assert.equal(b.spine, v.tasks[0].title, '简报的大标题不是主干支的支头标题，是自己造的句子');
  assert.equal(b.now.id, v.tasks[v.tasks.length - 1].id, '简报的"进行到哪"不是最后一条支');
  const said = (x) => proved.some((n) => n.claim === x.text && n.id === x.at);
  const nodeOf = (id) => v.nodes.find((n) => n.id === id);
  for (const x of b.cautions) assert.ok(said(x), `简报引了一句账上没有的决策：${x.text}`);
  for (const t of v.tasks) {
    for (const x of [...t.brief.facts, ...t.brief.rules]) {
      assert.ok(v.nodes.some((n) => n.task === t.id && n.basis === 'verified' && n.claim === x.text),
        `${t.id} 的简报引的不是本支某段的已证原文：${x.text}`);
    }
    assert.ok(!t.brief.open.length || t.brief.open.every((id) => nodeOf(id).open), `${t.id} 简报里的留问段不都带 open`);
    assert.ok(!t.brief.errs.length || t.brief.errs.every((id) => nodeOf(id).errs), `${t.id} 简报里的报错段没有报错`);
  }
});

test('块层：星图和 convledger steps 读同一份块表，每块都能被认出、被回读', () => {
  const root = fixture('steps');
  const cli = new URL('../bin/convledger.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1').replace(/\\/g, '/');
  const dir = writeStore(root, built);
  const v = readView(dir);
  const steps = v.steps;

  // ① 块＝一段连续的压缩区间：铺满段序列，不重不漏，块内不再出现新的边界起点
  assert.ok(steps.length > 1, `只有 ${steps.length} 块——这份样本没被压缩切开，块层测不出东西`);
  assert.equal(steps[0].i0, 0);
  assert.equal(steps[steps.length - 1].i1, v.nodes.length - 1, '最后一块没铺到段序列末尾');
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    assert.equal(s.i, i + 1, `第 ${i} 个块的号是 ${s.i}——号是按顺序发的，不对就是有人在中间漏了一块`);
    assert.equal(s.nodes, s.i1 - s.i0 + 1, `块 ${s.i} 的节点数和 [${s.i0},${s.i1}] 对不上`);
    assert.equal(s.segs, v.nodes.slice(s.i0, s.i1 + 1).filter((n) => !n.compact).length, `块 ${s.i} 的段数不是块内非边界节点数`);
    if (i) {
      assert.equal(s.i0, steps[i - 1].i1 + 1, `块 ${s.i} 和上一块之间有洞或重叠`);
      assert.ok(s.t0 >= steps[i - 1].t0, `块 ${s.i} 的起始回合比上一块早`);
    }
    for (let j = Math.max(s.i0 + 1, 0); j <= s.i1; j++) {
      if (v.nodes[j].compact) assert.ok(v.nodes[j - 1].compact, `块 ${s.i} 里 ${v.nodes[j].id} 是一次压缩，块本该在这里断开`);
    }
  }

  // ② 每块都有一句人能读的话：角色、段范围、句坐标、回读命令，一格不许静默为空
  //    （静默的 0 和空串是这个项目已经付过一次学费的地方：页面向后读不到就当没有）
  const ROLE = ['主线', '主线·夹插曲', '插曲', '压缩点'];
  for (const s of steps) {
    assert.ok(ROLE.includes(s.role), `块 ${s.i} 的角色「${s.role}」不在四种角色里`);
    assert.equal(s.role === '压缩点', s.segs === 0, `块 ${s.i} 角色和段数打架`);
    assert.equal(s.role === '插曲', s.segs > 0 && s.main === 0, `块 ${s.i} 的「插曲」不是按有没有主线段判的`);
    assert.equal(s.step !== null, s.main > 0, `块 ${s.i} 有主线段却没步号，或没有主线段却占了步号`);
    assert.match(s.read, /^convledger body S\d+$/, `块 ${s.i} 的回读命令不成形：${s.read}`);
    assert.ok(s.span, `块 ${s.i} 没有段范围`);
    assert.ok(s.sent || s.carrySent, `块 ${s.i} 既没有句范围也没有"接第几句"，它在时间轴上是隐身的`);
    if (s.sent) assert.match(s.sent, /^第 \d+(–\d+)? 句$/, `块 ${s.i} 的句范围不成形：${s.sent}`);
    if (s.carrySent) assert.match(s.carrySent, /^接第 \d+ 句$/, `块 ${s.i} 的接续句不成形：${s.carrySent}`);
    assert.ok(s.solved, `块 ${s.i} 的"解决了什么"是空的`);
    // 没有已证增量的块只许三种说法：如实说写出/涉及几件（made）、如实标出这是回复摘录
    //（回：…，来自这一段的第一句回复），或如实说没有；有增量时不许退回去复读 made
    //（那等于用产物冒充认识）。
    const NO_SOLVED = '没有回复，也没有产物';
    if (s.lines.length) assert.notEqual(s.solved, s.made, `块 ${s.i} 用产物冒充了认识增量`);
    else assert.ok(s.solved === s.made || s.solved === NO_SOLVED || s.solved.startsWith('回：'),
      `块 ${s.i} 没有已证增量，却用了第四种说法：${s.solved}`);
    assert.ok(s.level >= 0 && s.level <= 3, `块 ${s.i} 的完成度 ${s.level} 越界`);
  }
  assert.equal(steps.filter((s) => s.step !== null).length, v.mainSteps, '主线步数和带步号的块数不是一份');
  steps.filter((s) => s.step !== null).forEach((s, i) => assert.equal(s.step, i + 1, `步号不连续：第 ${i + 1} 个主线块标的是 ${s.step}`));

  // ③ 块级完成度＝块内各支完成度的最小值（从 tasks 独立重算，不抄 stepsOf 的过程）
  const taskOf = {}; for (const t of v.tasks) taskOf[t.id] = t;
  for (const s of steps) {
    for (const b of s.branchIds) assert.ok(taskOf[b], `块 ${s.i} 挂了一条不存在的支 ${b}`);
    if (!s.branchIds.length) continue;
    assert.equal(s.level, Math.min(...s.branchIds.map((b) => taskOf[b].level)), `块 ${s.i} 的完成度不是它那些支里最差的那个`);
  }

  // ④ 连线：每条 frame 归一块；有宿主的必须指得到宿主块（指不到＝岔出线静默消失），
  //    同块叫"块内插曲"、异块叫"岔出"，两者之和必须等于插曲支数；自环一条都不许有
  assert.equal(v.links.length, v.frames.length, '连线表和 frame 表不是一份');
  const nodeIdx = {}; v.nodes.forEach((n, i) => { nodeIdx[n.id] = i; });
  for (const l of v.links) {
    assert.ok(l.at >= 1 && l.at <= steps.length, `${l.b} 的头 ${l.head} 归不到任何块`);
    assert.ok(steps[l.at - 1].segIds.includes(l.head) || steps[l.at - 1].compactAt === l.head, `${l.b} 的头 ${l.head} 不在它被归进去的块 ${l.at} 里`);
    if (!l.host) { assert.equal(l.hostAt, null, `${l.b} 没有宿主却报了宿主块`); continue; }
    assert.ok(l.hostAt >= 1 && l.hostAt <= steps.length,
      `${l.b} 的宿主段 ${l.host}（第 ${nodeIdx[l.host]} 个节点）指不到宿主块——页面上那条岔出线会静默消失`);
  }
  const side = v.links.filter((l) => l.host);
  const ins = steps.reduce((a, s) => a + s.inside, 0);
  const fk = steps.reduce((a, s) => a + s.fork.length, 0);
  assert.equal(ins + fk, side.length, `块内插曲 ${ins} + 跨块岔出 ${fk} ≠ 插曲支 ${side.length} 条`);
  const bk = v.links.filter((l) => l.rejoinAt !== null && l.rejoinAt !== l.at).length;
  assert.equal(steps.reduce((a, s) => a + s.back.length, 0), bk, '汇回线的条数和连线表对不上');
  for (const s of steps) {
    for (const f of s.fork) assert.notEqual(f.at, s.i, `块 ${s.i} 给自己画了一条岔出线`);
    for (const b of s.back) assert.notEqual(b.at, s.i, `块 ${s.i} 给自己画了一条汇回线`);
    if (s.fork.length) assert.ok(steps[s.fork[0].at - 1], `块 ${s.i} 岔向不存在的块 ${s.fork[0].at}`);
  }

  // ⑤ 页面之外那份入口：CLI 的 --json 必须就是同一份 steps，行文本必须数得出同一批块
  const j = JSON.parse(execFileSync(process.execPath, [cli, 'steps', '--json', '--store', root, '--session', ledger.sessionId], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  assert.equal(j.length, steps.length, `CLI 打了 ${j.length} 块，页面拿到的 payload 有 ${steps.length} 块`);
  assert.deepEqual(j.map((s) => s.step), steps.map((s) => s.step), 'CLI 和星图对"第几步"的答案不一样——步号只能有一份');
  assert.deepEqual(j.map((s) => s.read), steps.map((s) => s.read), 'CLI 和星图给的回读命令不一样');
  const text = execFileSync(process.execPath, [cli, 'steps', '--store', root, '--session', ledger.sessionId], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const rows = text.trim().split('\n');
  assert.equal(rows.length, steps.length + 2, `steps 打了 ${rows.length} 行，块有 ${steps.length} 块（首行是总数、末行是提示）`);
  // 成本按"每块多少 token"断言：绝对数会随会话变长自然增长，那不是回归
  const perBlock = Math.round(tok(text) / steps.length);
  assert.ok(perBlock <= 90, `steps 每块 ${perBlock} tok——一块一行不该读到上千字，Agent 第一跳要先扫得完`);
  for (const s of steps) assert.ok(rows.some((r) => r.includes(s.read)), `块 ${s.i} 的回读命令没出现在 CLI 输出里`);

  // ⑤b 插曲块的身份只能从块序列数出来：夹在前一个步块与后一个步块之间。
  //    支号要指得到 links 里同一宿主、同一汇回点的那一条——页面上的岔出/汇回线才有来源。
  let interlude = 0;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.step !== null) {
      assert.equal(s.afterStep, null, `第 ${s.step} 步是主线块，却报了夹在别的步之间`);
      assert.equal(s.beforeStep, null, `第 ${s.step} 步是主线块，却报了汇回到别的步`);
      assert.equal(s.bridge, null, `第 ${s.step} 步是主线块，却挂了插曲桥`);
      continue;
    }
    interlude++;
    let a = null, b = null;
    for (let j = i - 1; j >= 0; j--) if (steps[j].step !== null) { a = steps[j].step; break; }
    for (let j = i + 1; j < steps.length; j++) if (steps[j].step !== null) { b = steps[j].step; break; }
    assert.equal(s.afterStep, a, `插曲块 ${s.i} 报的宿主步 ${s.afterStep} ≠ 前一个主线步 ${a}`);
    assert.equal(s.beforeStep, b, `插曲块 ${s.i} 报的汇回步 ${s.beforeStep} ≠ 后一个主线步 ${b}`);
    assert.ok(s.mark, `插曲块 ${s.i} 的题是空的——图上又会出现"没有编号也不知道是什么"的块`);
    if (s.bridge && a !== null && b !== null) {
      const l = v.links.find((x) => x.b === s.bridge.b && x.hostAt === steps.find((q) => q.step === a).i
        && x.rejoinAt === steps.find((q) => q.step === b).i);
      assert.ok(l, `插曲块 ${s.i} 的桥支 ${s.bridge.b} 在 links 里找不到宿主块 ${a}→汇回块 ${b} 的同一条`);
      assert.equal(l.hostAt, steps.find((q) => q.step === s.bridge.hostStep).i, `插曲块 ${s.i} 的桥宿主步和 links 对不上`);
      assert.equal(l.rejoinAt, steps.find((q) => q.step === s.bridge.rejoinStep).i, `插曲块 ${s.i} 的桥汇回步和 links 对不上`);
    }
  }
  if (interlude) {
    assert.ok(rows.some((r) => /插\d+↔\d+/.test(r)), 'CLI 的 steps 没把插曲块标成「插a↔b」——Agent 第一跳又会看到没编号的块');
    assert.ok(rows.some((r) => /夹在步\d+↔\d+之间/.test(r)), 'CLI 的插曲行没写「夹在步a↔b之间」——PRD §7.3 要求第一跳看到和人看卡面同一句话');
  }

  // ⑥ 中景那行标题：有模型综述就用综述的题；没有综述就由产物/结构派生，**不许拿用户原话剪一段**
  //    当标题（2026-10-30 用户口径）。mark（远景那格）仍是从块内第一句人话里截的。
  const ECHO = /^(Bash|Read|Write|Edit|Grep|Glob|TaskCreate|TaskUpdate|MultiEdit|NotebookEdit|SearchWorkspace|SearchKnowledge|present_visualization|mcp_call|convledger)\b/;
  let fromSay = 0;
  for (const s of steps) {
    assert.ok(s.mark, `块 ${s.i} 的"这块的题"是空的——远景卡上会一个字都不剩`);
    assert.ok(wlen(s.mark) <= CLAIM_MARK_W, `块 ${s.i} 的题占 ${wlen(s.mark).toFixed(1)} 格 > ${CLAIM_MARK_W} 格——远景一行放不下，只能缩字号`);
    assert.ok(wlen(s.gist) <= BLOCK_GIST_W, `块 ${s.i} 的摘要占 ${wlen(s.gist).toFixed(1)} 格 > ${BLOCK_GIST_W}——中景那行会被裁掉`);
    assert.ok(!ECHO.test(s.mark), `块 ${s.i} 的题是一条工具回执：「${s.mark}」——Qoder 把工具结果也写成 user 记录，这就是那道过滤要挡的东西`);
    assert.ok(!ECHO.test(s.gist), `块 ${s.i} 的摘要是一条工具回执：「${s.gist}」`);
    // 独立复算"块内第一句人话在哪"：mark 仍必须是那句原话的连续片段
    const first = v.nodes.slice(s.i0, s.i1 + 1)
      .find((n) => !n.compact && n.say && !TOOLISH.test(n.say) && !NOSAY.test(n.say));
    if (first) {
      fromSay++;
      assert.ok(first.say.includes(s.mark), `块 ${s.i} 的题「${s.mark}」在那句原话里找不到——它不是截出来的`);
    } else {
      assert.ok(!s.outs?.length || s.mark !== '—', `块 ${s.i} 有产物却写「—」`);
    }
    if (s.sum) {
      assert.equal(s.gist, s.sum.title, `块 ${s.i} 有模型综述，标题却不是综述的题`);
      assert.equal(s.gistFrom, '', `块 ${s.i} 用了模型综述，却还报原话出处 ${s.gistFrom}`);
      assert.equal(s.gistDerived, false, `块 ${s.i} 用了模型综述，却被标成派生标题`);
    } else {
      assert.ok(s.gist, `块 ${s.i} 没有综述也没有派生标题`);
      assert.equal(s.gistFrom, '', `块 ${s.i} 没有模型综述，却报原话出处 ${s.gistFrom}`);
      assert.equal(s.gistDerived, true, `块 ${s.i} 没有模型综述，标题必须标成派生`);
      // 没有综述时：标题直接显示原文截断（真人原话），画布层再标「待补综述」——
      // 2026-11-13 用户口径，推翻 2026-11-09 的「绝不用原话当标题」。
      if (first && first.say) {
        const lead = String(s.gist).replace(/…$/, '');
        assert.ok(first.say.includes(lead) || first.say.slice(0, 10) === lead.slice(0, 10),
          `块 ${s.i} 的标题应是原话截断：「${s.gist}」`);
      }
    }
  }
  assert.ok(fromSay > 0, `${steps.length} 块里一句能读的真人原话都没有——远景题名层就是空转`);

  // ⑦ 画布契约：四档都在、JS 与 CSS 的盒高/字号是同一份预算、清单整条撤净、点击＝钻进近景
  const web = (f) => fs.readFileSync(
    new URL(`../web/${f}`, import.meta.url).pathname.replace(/^\/(\w:)/, '$1').replace(/\\/g, '/'), 'utf8');
  const html = web('atlas.html'), js = web('atlas.js'), css = web('atlas.css');
  // 顶栏两行网格：视图与操作各自成组，身份独占第二行
  assert.match(html, /class="nav"/, '顶栏的视图切换要独立成组');
  assert.match(html, /class="acts"/, '顶栏的画布操作要独立成组');
  assert.match(css, /grid-template-areas/, '顶栏要用网格排布，不能靠换行碰运气');
  assert.match(html, /classList\.add\('embed'\)/, '画布要能按 embed=1 隐藏第二层 chrome');
  assert.match(css, /body\.embed #lib/, '嵌入 App 时画布左栏会话清单要让位，整屏只有一套导航');
  assert.match(css, /body\.embed header/, '嵌入时顶栏要收成一条功能控件，不再重复品牌与视图 tab');
  assert.match(js, /freshTitle/, '同步状态要留完整时间在悬停提示里');
  assert.match(js, /orgfull|orgpart/, '画布左栏要标出这段整理过没有');
  assert.match(css, /\.librow\.current\s*\{\s*background:\s*transparent/, '当前会话不能单独铺一块底，行样式要和其它会话一致');
  assert.match(css, /\.librow\s*\{[^}]*width:\s*100%/, '会话行必须显式满宽，链接元素不能收缩成内容宽度');
  assert.match(css, /header \.live::before/, '顶栏同步点必须限定在 header，不能漏到会话行');
  assert.ok(!/\.librow\.live/.test(css), '会话行的 live 类不能和顶栏 .live 撞名');
  // 后台重算时前台转小圈、不冻结（PRD-refresh）：同步点变转圈，文字写明正在更新
  assert.match(js, /function liveSync/, '画布同步状态要按 refreshing 切换转圈');
  assert.match(js, /正在更新最新信息/, '后台重算时画布要写明正在更新最新信息');
  assert.match(css, /header \.live\.refreshing::before/, '同步点要能在重算时变成转圈');
  assert.match(css, /@keyframes livespin/, '转圈动画要有 keyframes');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*header \.live\.refreshing::before \{ animation: none/, '减少动态时转圈要停');
  assert.match(js, /' is-live'/, '会话行要用独立的 is-live 类');
  assert.match(js, /convledger\.groups\.order/, 'agent 分组顺序要持久化到本机');
  assert.match(js, /dragstart/, '分组标题要能拖动');
  assert.match(js, /dragover/, '分组要能接收拖放');
  assert.match(css, /\.libgh \.grip/, '分组标题要有拖动手柄');
  assert.match(web('hub.js'), /convledger\.groups\.order/, '会话库也要用同一份分组顺序');
  assert.match(web('hub.js'), /x\.organize/, '会话库每一行要写这段整理过没有');
  assert.match(web('hub.js'), /整理过 ' \+ \(v\.counts\.organized/, '顶栏总数要给整理过的本数');
  assert.match(web('hub.js'), /只看未整理/, '要能只挑没整理过的段');
  assert.match(web('hub.css'), /\.org\.full/, '整理过的色标要有自己的颜色');
  assert.match(web('hub.html'), /id="orgf"/, '筛法入口要在页面上，不只藏在脚本里');
  assert.match(web('hub.css'), /\.gh \.grip/, '会话库的分组标题也要有拖动手柄');
  assert.match(js, /qfmodel: 'Qwen3\.8-Flash'/, '模型代号 qfmodel 要翻成可读名称');
  assert.match(js, /dfmodel: 'DeepSeek-Flash'/, '模型代号 dfmodel 要翻成可读名称');
  // 没写综述的块：标题显示原文截断（真人原话），但仍要标「待补综述」——用户口径：描述还是得有
  assert.match(js, /gistIsAsk: !!s\.gistIsAsk/, '画布要把"标题取自你的要求"带进每块');
  assert.match(js, /待补综述/, '没综述的块仍要标「待补综述」');
  assert.ok(!/讨论过，没有落产物/.test(fs.readFileSync(`${tools}/src/view.mjs`, 'utf8')), '别再拿「讨论过，没有落产物」当统一标题');
  assert.ok(!/待补综述/.test(fs.readFileSync(`${tools}/src/view.mjs`, 'utf8')), '标题不用「待补综述」占位——用原话截断（标注在画布层）');
  assert.match(fs.readFileSync(`${tools}/src/view.mjs`, 'utf8'), /\(s\.say && String\(s\.say\)\.trim\(\)\)/, '没综述时标题用真人原话截断');
  assert.match(js, /pending: !!s\.pending/, '画布要拿到待补综述标记');
  assert.match(js, /' pending'/, '待补的块要带可辨识的类');
  assert.match(css, /\.p\.pending::before/, '待补综述要有可见的角标');
  assert.match(js, /p\.gist \|\| p\.mark/, '远景先给标题，不拿用户原话的截段当卡面');
  assert.ok(!/你的要求 · 还没有块综述/.test(js), '没有综述时不许把用户原话当标题');
  // 档位开关不再放在地图里；统一挪到看板设置页，按 Agent 分行控制收尾与补账
  assert.doesNotMatch(html, /id="(cadence|closeoutCadence|profileCadence|autoBuild)"/, '地图顶栏不再放档位开关');
  const appHtml = web('app.html');
  const appJs = web('app.js');
  assert.match(appHtml, /id="agents"/, '节奏开关要放进本机 Agent 卡片区');
  assert.match(appHtml, /id="prefProfile"/, '画像档位要留在看板');
  assert.match(appHtml, /id="prefAutoBuild"/, '建账档位要留在看板');
  assert.match(appJs, /acadence/, '每个 Agent 卡片里要有节奏开关');
  assert.match(appJs, /closeoutCadence/, '卡片要能写收尾档位');
  assert.match(appJs, /summaryCadence/, '卡片要能写补账档位');
  assert.match(appJs, /setHostPref/, 'Agent 级开关要写到 hosts.<runner>');
  assert.doesNotMatch(appHtml, /Agent 节奏/, '模型配置页不再放节奏设置');
  assert.match(fs.readFileSync(new URL('../src/map.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1').replace(/\\/g, '/'), 'utf8'),
    /url === '\/prefs'/, 'hub 要能写档位');
  assert.match(fs.readFileSync(new URL('../hooks/ledger-brief.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1').replace(/\\/g, '/'), 'utf8'),
    /summariseFor\(/, 'Stop hook 要按档位触发补综述');
  // 品牌图标：盒子和文字同一条中线，大小跟着字走；不能靠 baseline 微调悬在半空
  assert.match(css, /\.brandline \{[^}]*align-items: center/, '品牌图标要和英文名同一条中线');
  assert.match(css, /\.brandmark \{[^}]*width: 24px/, '品牌图标不能小到看不清');
  assert.match(web('hub.css'), /\.brand \{[^}]*align-items: center/, '会话库的品牌图标也要对齐');
  // 大会话首屏：数据没到之前要画骨架，不能留一片点阵让用户等
  assert.match(html, /id="bootskel"/, '大账本首屏要有载入占位');
  assert.match(js, /getElementById\('bootskel'\)/, '数据到了要撤掉载入占位');
  assert.match(js, /\/health'\)\.then/, '占位要先用 health 报段数，不等 data.json');
  assert.match(html, /class="libskel"/, '会话清单加载中要有骨架行');
  assert.match(fs.readFileSync(new URL('../hooks/ledger-brief.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1').replace(/\\/g, '/'), 'utf8'),
    /profileDue\(/, 'Stop hook 要按画像档位触发补画像');
  assert.match(js, /未划阶段/, '整段没有阶段时不能把第 1 步叫尾段');
  // 首屏必须落在读得出字的一档：以前第一次打开就是 fit() 的 12% 全图，满屏编号没有内容
  assert.match(js, /function openLatest/, '首屏要有一个落在可读档的镜头');
  assert.match(js, /if \(!applyHashZoom\(\)\) openLatest\(\)/, '没带 #z= 时首屏要停在最新一块的中景');
  // 操作提示不许永久挡在图上：看过一次就该收起并记住
  assert.match(js, /atlas-hint-off/, '提示条的收起状态要记在本机');
  assert.match(web('architecture.html'), /overflow-wrap:anywhere/, '架构图卡里的长串（index/body/…）要能断行，不许顶穿卡片');
  {
    const pp = fs.readFileSync(`${tools}/src/project-page.mjs`, 'utf8');
    assert.match(pp, /只画声明了依赖的/, '依赖图只画少数任务时要说清其余没声明依赖，别让读者以为图丢了内容');
    assert.match(pp, /\.\.\.\(c\.cancelled \? \[\['已取消', c\.cancelled\]\] : \[\]\)/, '计数行要认「已取消」，否则与图上的已取消节点对不上数');
    assert.match(pp, /classList\.add\('embed'\)/, '工作台要能按 embed=1 隐藏自己的页头');
    assert.match(pp, /body\.embed \.bar \.zoom\{margin-left:0\}/, '嵌入时工作台只留缩放控件，品牌/返回/会话库让位给 App 外壳');
  }
  assert.match(js, /function modelLabel/, '顶栏渲染前要走模型名称映射');
  assert.match(js, /mtag/, '当前模型要有「当前」徽标');
  assert.match(js, /m\.model/, '顶栏要区分当前模型与历史模型');
  assert.match(css, /\.who \.mname\.cur/, '当前模型要用不同颜色');
  // 会话库按 agent 分组可折叠：展开状态要在 localStorage 里记住，且必须先给「最近几条」
  assert.match(js, /convledger\.lib\.open/, '画布左栏要记住哪组是展开的');
  assert.match(js, /agdot/, '每个 agent 的名字前要有自己的色标');
  assert.match(js, /展开全部/, '折叠时要给展开入口');
  assert.match(js, /var LIB_SHOW = 3;/, '侧栏每组合默认只列三段，别一上来就铺五行');
  // 小字号可读性：中文优先雅黑 UI，说明行不小于 12px（11px 在暗色卡上发虚）
  assert.match(css, /--ui:[\s\S]*?Microsoft YaHei UI[\s\S]*?Noto Sans SC/, '中文字体要优先雅黑 UI，别先落 Noto');
  assert.match(css, /\.pnone \{[^}]*font-size: 12px/, '卡片说明行不能小于 12px');
  // 放大发虚的根因：世界层常驻 will-change 会按 1× 栅格化再放大
  assert.ok(!/#world\s*\{[^}]*will-change: transform/.test(css), '世界层不能常驻 will-change，否则放大后字发虚');
  assert.match(js, /willChange = 'auto'/, '停手后要收回图层，让浏览器按当前倍率重画');
  assert.match(web('hub.css'), /"Microsoft YaHei UI"/, '会话库也要用同一套中文字体');
  assert.match(web('hub.js'), /convledger\.hub\.open/, '根会话库同样要记住展开状态');
  // 中景不聚合：阶段信息只在顶部括号，块保持一小块一小块
  assert.match(css, /\/\* 中景不做阶段聚合/, '中景阶段聚合没有停掉');
  assert.match(css, /\.pgroup\s*\{\s*display:\s*none/, '阶段卡必须默认隐藏');
  assert.ok(!/#world\[data-tier="mid"\]\s*\.p\.grouped/.test(css), '中景不能把块藏起来');
  assert.ok(!/byRow\.forEach/.test(js), '中景不应该再按行生成阶段卡');
  for (const t of ['glyph', 'far', 'mid', 'near']) {
    const box = js.match(new RegExp(`\\b${t}: (\\d+)`));
    const varv = css.match(new RegExp(`--ch-${t}: (\\d+)px`));
    assert.ok(box && varv, `CH_T.${t} 或 --ch-${t} 找不到——四档少一档就是静默掉档`);
    assert.equal(Number(box[1]), Number(varv[1]),
      `JS 的 CH_T.${t}=${box[1]} 和 CSS 的 --ch-${t}=${varv[1]}px 不是一对：换档时行距会压在这一行上`);
    // 近景是默认档：盒高写在基础 .p 规则上，其余三档各由自己的 data-tier 规则覆盖
    if (t === 'near') assert.match(css, /\.p\s*\{[^}]*height: var\(--ch-near\)/, '默认档（近景）的盒高不在基础 .p 规则上');
    else assert.match(css, new RegExp(`#world\\[data-tier="${t}"\\] \\.p`), `${t} 档没有盒高规则`);
  }
  // 远景那一行的字号×格数必须放得进卡内宽：裁字是静默的信息损失，和字号对不上是同一个病
  const cw = Number(css.match(/--cw: (\d+)px/)[1]);
  const padH = Number(css.match(/\.pin\s*\{[^}]*padding:\s*([\d.]+)px\s+([\d.]+)px/)[2]);
  const fsz = Number(css.match(/\.fwhat\s*\{[^}]*font-size:\s*(\d+)px/)[1]);
  const inner = cw - 2 - 2 * padH;   // border-box：减去 1px 边框和左右内边距
  // 远景现在给的是标题（gist），两行；预算按两行算，不再拿原话截段
  const flines = Number(css.match(/\.fwhat\s*\{[^}]*-webkit-line-clamp:\s*(\d+)/)[1]);
  const fperLine = Math.floor(inner / fsz);
  assert.ok(fperLine * flines >= BLOCK_GIST_W,
    `远景 ${flines} 行只放得下 ${fperLine * flines} 格，比标题预算 ${BLOCK_GIST_W} 窄——最后一个字会被裁掉`);
  for (const s of steps) assert.ok(wlen(s.gist) <= fperLine * flines, `块 ${s.i} 的题「${s.gist}」在远景放不下`);
  // 中景那一行同理：预算就是那两行放得下的字数，超出的字会被 line-clamp 静默裁掉
  const mfsz = Number(css.match(/\.mtitle\s*\{[^}]*font-size:\s*(\d+)px/)[1]);
  const mlines = Number(css.match(/\.mtitle\s*\{[^}]*-webkit-line-clamp:\s*(\d+)/)[1]);
  const perLine = Math.floor(inner / mfsz);
  assert.ok(perLine * mlines - BLOCK_GIST_W >= mlines,
    `BLOCK_GIST_W=${BLOCK_GIST_W} 贴着中景 ${mlines} 行的 ${perLine * mlines} 格上限——中文标点禁则会顶掉行首一个字，实测会多出第 3 行被静默裁掉`);
  for (const s of steps) assert.ok(wlen(s.gist) <= perLine * mlines, `块 ${s.i} 的摘要「${s.gist}」在中景那两行放不下`);
  assert.ok(!/id="list"/.test(html) && !/renderList|listPin|\$\('list'\)/.test(js),
    '左下角那块"每块干什么"的清单没撤干净（按钮和渲染链要一起删）');
  assert.ok(!/\.frole|\.flink|\.ft\s*\{/.test(css), '远景旧符号的样式成了死代码：卡面上已经不再用它们说话');
  assert.match(js, /function dive\(p\) \{[\s\S]{0,220}setTier\('near'\)/,
    '点击没有把镜头推到近景——"点了不显示详情"就是这个');
  // 行的位置与盒高都随档变：先量旧档几何再换档，「现在」/搜索定位会偏出半张卡（实测 y=-104）
  assert.match(js, /function centerOn\(p, z\) \{[\s\S]{0,200}setTier\(tierFor\(z2\)\)[\s\S]{0,200}p\.hy/,
    'centerOn 没先把目标档落地就量坐标——跨档居中会偏');
  assert.ok(/S\.before = \{ x: S\.tgt\.x, y: S\.tgt\.y, z: S\.tgt\.z, tier: S\.tier \}/.test(js)
    && /if \(!silent && S\.before\)/.test(js), '钻进前没记镜头或关闭时不还原：Esc 会把人丢在别处');
  assert.ok(/'fwhat', p\.gist \|\| p\.mark/.test(js) && /'msrc'/.test(js),
    '远景卡上没有"这块的题"，或中景摘要没带出处段号——回读链就断了');

  // ⑦b 流程图契约：连线只有三种走法（主线/岔出/汇回），全部正交折线＋箭头；
  //    连线层必须在卡层之上，否则线被卡压住，读者只能看到列间空带里的几截白点。
  assert.match(js, /function edgeStep\(a, b, cls\)/, '主线连线函数不见了——流程图会退化成散卡');
  assert.match(js, /function edgeFork\(host, first\)/, '岔出连线函数不见了——插曲块没有入口');
  assert.match(js, /function edgeBack\(last, target\)/, '汇回连线函数不见了——插曲块没有出口');
  assert.match(js, /edgeStep\(run\[i - 1\], run\[i\], 'fork'\)/, '同一趟插曲内部的顺序没有连线，一串插曲块会变成互不相干的孤卡');
  assert.match(js, /path\.setAttribute\('marker-end'/, '连线没有箭头——"连上了"在画面上就没有证据');
  assert.match(js, /markerUnits: 'strokeWidth'/, '箭头没按线宽缩放，缩到远景箭头会大到压住卡');
  assert.match(js, /dataset\.edge = cls/, '连线没写 edge 类型，探针无法分类核验');
  assert.match(css, /#wires \{[\s\S]{0,180}z-index: 6/, '连线层不在卡层之上（#wires 需要 z-index: 6）');
  // ⑦b-1 流式连线（2026-11-02 用户要「箭头线条做成流式的，动态的」）：动画只挂在线身
  //   （path[data-edge]，箭头 marker 一起挂＝每帧重画两百多个箭头），推进量与虚线周期共用
  //   同一个 --cyc，且 --cyc 按 1/z 由 applyCam 写——缩放时缺口和推进距离才会不错拍。
  assert.match(css, /@keyframes wireflow \{ to \{ stroke-dashoffset: calc\(var\(--cyc, 12\) \* -1px\); \} \}/,
    '连线没有流式关键帧，或推进量不是整整一个周期（循环处会跳一下）');
  assert.match(css, /#wires path\[data-edge\] \{ animation: wireflow/,
    '流式动画没按 data-edge 收窄——箭头和岔点圆也会被挂上');
  assert.match(css, /#wires \.spine \{[^}]*stroke-dasharray: var\(--dash-sp/,
    '主线没有流式缺口（还是纯实线，动起来看不出方向）');
  assert.match(js, /setProperty\('--dash-sp', \(10 \/ z\)/, '主线的流式缺口没按 1/z 写：缩放到远景会糊成实线');
  assert.match(js, /setProperty\('--cyc', \(12 \/ z\)/, '流式周期没按 1/z 写：缩放时缺口和推进量会错拍');
  assert.match(css, /prefers-reduced-motion[\s\S]{0,260}#wires path\[data-edge\] \{ animation: none; \}/,
    '「减少动态」偏好下连线没整层停住：两百多条线一起按 .001s 循环＝全屏闪烁');
  assert.match(css, /\.p \{[\s\S]{0,420}z-index: 2/, '卡片没有明确 z-index，连线层序会随 DOM 顺序漂');
  assert.ok(!/classList\.(add|toggle)\('open'\)|#stage\.open|\.p\.open/.test(js + css),
    '旧的"点开＝对话框"还留着：那正是卡片被抬高、邻居变暗、插曲块不知道跑哪去的来源');
  assert.ok(!/tether|ghost|dragging/.test(js + css + html), '拖块/牵引线/残影的旧代码没撤干净');
  assert.ok(!/id="tidy"/.test(html), '「整理」按钮还在：流程图没有可拖走的块，这个按钮是死 UI');
  assert.match(js, /p\.step == null \? '插' : p\.step/, '远景的插曲牌没有「插」字，读者还是不知道那是块什么');
  assert.match(js, /function betweenText\(p\) \{[\s\S]{0,340}夹在第 /, '插曲块的详情里没写它夹在哪两步之间');
  assert.match(js, /function betweenShort\(p\) \{[\s\S]{0,220}夹 /, '插曲卡的短标签没写它夹在哪两步之间');
  assert.match(js, /p\.step == null\) \{[\s\S]{0,420}?factRow\('夹在哪', btw\)/,
    '右栏详情没把「夹在第 a 步与第 b 步之间」印出来——点开插曲块还是不知道它是什么');

  // ⑦b-2 阶段层（第十七轮）：带高与字号常量必须和 CSS 是同一份预算；括号画在连线层里、
  //    标签在 #bands 上层；点标签打开六格详情，页脚说清"这是模型说明，不是已证结论"。
  assert.match(html, /<div id="bands"><\/div>/, '缺 #bands 层——阶段标签没地方放');
  assert.match(css, /#bands \{[\s\S]{0,120}z-index:\s*7/, '#bands 不在连线层之上：标签会被线穿过');
  assert.match(css, /#wires \.band \{[\s\S]{0,120}fill: none/, '阶段括号没在 #wires 里画（或不是描边路径）');
  assert.match(js, /var BAND_H = 56, CHAP_H = 56, PH_H = BAND_H \+ CHAP_H;/,
    'PRD-atlas 十一定的两条带高（阶段 56＋章 56）不见了：章带坐在阶段带之上，行顶预留要一起算');
  for (const t of ['glyph', 'far', 'mid', 'near']) {
    const n = Number(js.match(new RegExp(`\\bPH_T = \\{[^}]*\\b${t}: (\\d+)`))[1]);
    const v = Number(css.match(new RegExp(`--pf-${t}: (\\d+)px`))[1]);
    assert.equal(n, v, `PH_T.${t}=${n} 和 --pf-${t}:${v}px 不是一对：换档时标签字号会跳`);
  }
  assert.match(js, /chip\.dataset\.n = b\.n;/, '标签没带阶段号，探针和点击都认不出它属于哪一段');
  assert.match(js, /path\.dataset\.band = b\.n;/, '括号路径没带阶段号');
  assert.match(js, /function bandTail\(b\)[\s\S]{0,220}（续）/, '跨行的阶段没标「（续）」——读者会以为第二行是新的一段');
  assert.match(js, /function showPhase\(ph\)[\s\S]{0,160}renderInspector\(\)/, '点标签没有打开阶段详情');
  const phaseInsp = js.slice(js.indexOf('function inspectPhase(ph)'), js.indexOf('function inspectPart(p)'));
  for (const k of ['进行的是什么', '完成进度', '完成效果', '对照 PRD·plan', 'progress 文件', '规则'])
    assert.ok(phaseInsp.includes(`factRow('${k}'`), `阶段详情缺「${k}」这一格`);
  assert.match(phaseInsp, /模型说明（归纳，不过六条判据） · 写于 /, '阶段详情页脚没标清那是模型说明');
  assert.match(phaseInsp, /这一阶段没有可引用的文档章节（不编）/, 'plan 写 — 时没当面说「没有可引用的章节」');
  assert.match(phaseInsp, /本阶段没有过判据的规则/, '没有规则时没当面说没有，读者会以为工具漏了');
  // refs 是这一阶段共用的一份出处：贴两处会读成"两组引用"（探针实测 3 条变 6 条）
  assert.equal((phaseInsp.match(/phaseRefChips\(ph\.refs\)/g) || []).length, 1,
    '引用清单在计划格与进度格里各贴了一遍：同一份 refs 只该出现一次');
  assert.match(phaseInsp, /var chipHost = ph\.plan === '—' \? trackCell : planCell/,
    'plan 写 — 时引用没有落到 progress 那一格，读者就看不到出处了');
  assert.match(js, /S\.phases = v\.phases \|\| \[\]/, 'adopt 没把阶段带进页面');
  assert.match(html, /阶段括号/, '图例没有「阶段括号」一条');

  // ⑦b-3 章带（第十九轮）：章牌与阶段牌共用 #bands 层但钩子分家（.chl / data-chap），
  //    牌顶由同一对带高常量推出来；点章牌出九格，九格只有一份字段名，接手页走 hub 的 /handoff。
  assert.match(css, /#legend \.wl\.chapband/, '图例里的章括号没有自己的线样，读者会把它读成阶段括号');
  assert.match(css, /#wires \.band\.chapband/, '章括号没有比阶段括号粗一档：两条带叠在一起就分不出层级');
  assert.match(css, /\.chl \{[\s\S]{0,60}border-width:\s*2px/, '章牌没有自己的边框粗细');
  assert.match(js, /el\('div', chap \? 'phl chl' : 'phl'\)/, '章牌没带 chl 类：探针和选中态都分不开两条带');
  assert.match(js, /chip\.style\.top = \(S\.rowY\[b\.row\] - \(chap \? PH_H : BAND_H\) \+ 6\)/,
    '章牌顶不是从带高常量推出来的：改了带高就会有一条带错位');
  assert.match(js, /var y = chap \? S\.rowY\[b\.row\] - BAND_H - 12 : S\.rowY\[b\.row\] - 12;/,
    '章括号线没有坐在自己那条带的下沿（应与阶段括号差一个 BAND_H）');
  assert.match(js, /path\.dataset\.chap = b\.n;/, '章括号没带章号，选中态点不亮它');
  assert.match(js, /if \(chap\) path\.dataset\.chap = b\.n; else path\.dataset\.band = b\.n;/,
    '章括号与阶段括号共用了 data-band：选中态与跨块连线会互相冒领');
  assert.match(js, /'#wires path\[data-band\]\.on, #wires path\[data-chap\]\.on'/,
    '清除选中态时没把章括号一起清掉，换档后留着一条假的高亮');
  assert.ok(!/querySelectorAll\('#bands \.phl'\)/.test(js),
    '还有代码整取 .phl：章牌也是 .phl，阶段逻辑会把章牌当阶段牌点亮');
  assert.match(js, /S\.chapters = v\.chapters \|\| \[\]/, 'adopt 没把章带进页面');
  assert.match(js, /function showChapter\(ch\)[\s\S]{0,160}renderInspector\(\)/, '点章牌没有打开接手那一页');
  {
    // CHAP_CELLS 在 inspectChapter 上面几行：切片要从字段表起，否则九格的名字全在窗外
    const chapInsp = js.slice(js.indexOf('var CHAP_CELLS'), js.indexOf('function copyHandoff('));
    for (const k of ['范围', '计数', '一开始的目的', '走到哪', '核心规则与原则', '主要任务', '碰过的壁',
      '接下来要注意', '架构现状', '怎么接手'])
      assert.ok(chapInsp.includes(k), `章的接手页缺「${k}」这一格`);
    assert.match(chapInsp, /factRow\(x\[1\], val/, '九格不是按字段表印出来的：改了 CHAP_CELLS 页面不会跟着变');
    assert.match(chapInsp, /模型说明（归纳，不过六条判据） · 写于 /, '章详情页脚没标清那是模型说明');
    assert.match(chapInsp, /这一格没有源（不编）/, '九格空着时没当面说没有源，读者会以为工具漏写');
    assert.match(chapInsp, /这一章里的每一程/, '章页没有把里面的阶段列出来，读者跳不回六格');
    assert.match(chapInsp, /定位到第 '/, '章页没有「定位到第 N 步」的入口');
    assert.match(js, /fetch\(BASE \+ '\/handoff\?chapter=' \+ n/,
      '「复制 handoff」没走 hub 的 /handoff：页面自己拼九格就会和 convledger handoff 漂开');
    assert.match(js, /剪贴板不可用/, '剪贴板被拒时要当面说，不能装作复制成功');
    // 九格的字段名只许有一份：画布与 CLI 的 handoff 读起来必须是同一套
    const jsCells = (js.match(/var CHAP_CELLS = \[[\s\S]*?\];/) || [''])[0];
    const briefSrc = fs.readFileSync(`${tools}/src/brief.mjs`, 'utf8');
    const cliCells = (briefSrc.match(/const NINE = \[[\s\S]*?\];/) || [''])[0];
    const lab = (s) => (s.match(/'[^']*'/g) || []).map((x) => x.slice(1, -1)).filter((x) => /[一-鿿]/.test(x));
    assert.ok(jsCells && cliCells, 'CHAP_CELLS 或 brief 的 NINE 找不到了：九格契约没人守着');
    assert.deepEqual(lab(cliCells), lab(jsCells), '画布九格与 convledger handoff 的格名漂了：同一章在两处读成两套字段');
  }
  {
    const mapSrc = fs.readFileSync(`${tools}/src/map.mjs`, 'utf8');
    assert.match(mapSrc, /rest === '\/handoff'/, 'hub 没有 /handoff 路由，画布的「复制 handoff」拿不到文本');
    assert.match(mapSrc, /handoffText\(readView\(st\.dir\)/, '/handoff 没有复用 src/brief.mjs 那一份渲染器');
  }

  // ⑦b-4 章笔记（第二十轮，用户那句「现在还是长这样啊」）：这一大块的总结要不用点击也读得出——
  //    按屏幕像素排（世界像素的字在 12% 那一档只剩 4px），跟着镜头落进的那一章换，
  //    点开还是九格那一份文本。卡坐在左上角、压在第一行章牌上，所以它自己不吃点击。
  assert.match(html, /<div id="chapnote" hidden/, '画布上没有章笔记：章的总结还藏在一次点击后面');
  assert.match(css, /#chapnote \{[\s\S]{0,500}pointer-events:\s*none/, '章笔记整张卡在吃点击：它压住的那行章牌就点不动了');
  assert.match(css, /#chapnote \.cgo \{[\s\S]{0,200}pointer-events:\s*auto/, '「打开九格」没把点击收回来：卡不吃点击＝这页没有入口');
  {
    const px = /#chapnote \{[\s\S]{0,500}?font-size:\s*([\d.]+)px/.exec(css);
    assert.ok(px, '章笔记没有屏幕像素字号：这一轮修的就是"画了但读不到"');
    assert.ok(parseFloat(px[1]) >= 11, `章笔记字号 ${px[1]}px 太小，「适应」那一档照样读不出`);
  }
  assert.match(js, /function chapInView\(\)[\s\S]{0,400}viewW\(\)/,
    '章笔记的落点没和 centerOn 共用同一个视口口径：「定位到第 N 步」会被算成隔壁那一章');
  assert.match(js, /function chapInView\(\)[\s\S]{0,700}if \(p\.chapter == null\) return;/,
    '章笔记不是按"视口正中那一张块"选章的：读者看的是块，括号只是它的容器');
  assert.match(js, /syncChapNote\(\);/, 'applyCam 没同步章笔记：镜头换了章，卡还停在旧的那一章');
  assert.match(js, /if \(S\.chapFocus !== c\.n\) \{ S\.chapFocus = c\.n; buildChapNote\(c\); markSel\(\); \}/,
    '换章没有重印笔记：文字会停在第一次落定的那一章');
  assert.match(js, /function buildChapNote\(c\)[\s\S]{0,120}if \(!cnGo\) \{/,
    '笔记每次换章都重建 DOM：按下鼠标那一刻按钮被抽掉，点击就丢了（表现为"点了没反应"）');
  assert.match(js, /chapnote\.hidden = true; S\.chapFocus = null/, '没有章时笔记要整张收起：留一张空卡比没有更像出错');
  assert.match(js, /if \(!S\.chapters\.length \|\| !hits\.hidden\)/, '搜索清单出现时章笔记没让位：两张卡叠在同一个左上角');
  assert.match(js, /toggle\('focus', S\.chapFocus != null && \+x\.dataset\.chap === S\.chapFocus\)/,
    '章牌没跟着笔记亮起来：读者不知道这张卡讲的是哪一章');
  assert.equal((js.match(/closest\('[^']*#chapnote[^']*'\)/g) || []).length, 2,
    '章笔记没同时从"拖动"和"双击适应"的排除表里出来：浮层上的按钮会被 stage 抢走指针，click 落到 stage 上');
  assert.ok(js.includes("closest('.p, #bands, #insp, #minimap, #chapnote, #hits')"),
    '命中清单里的按钮没从双击适应的排除表里出来：双击一行结果会顺手把镜头拉远');

  // ⑦c 块右栏回答五件事 + 查看原文（2026-10-27 第十七轮用户口径）：主线任务是什么、这块在任务的哪个阶段、
  //    你说的 / 我回的 / 做成什么。有模型综述就整行用综述并当面标「模型综述 · 依据 Sxx」，
  //    没有就回落成原话/回复/产物并明说「这块还没有模型综述」——两条路都不许含糊。
  //    段/句/回合/规模/计数行一律不进面板，文件名也不上屏；正文按锚点现读，面板里不留副本。
  const inspAt = js.indexOf('function inspectPart(p)');
  const blockInsp = js.slice(inspAt, js.indexOf('function renderInspector()', inspAt));
  const inspHelpers = js.slice(js.indexOf('var FILE_KINDS'), inspAt);
  assert.match(blockInsp, /factRow\('任务', who\)/, '右栏没写这块属于哪条任务');
  assert.match(blockInsp, /'插曲任务 · ' : '主线任务 · '/, '右栏没区分主线任务和插曲任务');
  assert.match(blockInsp, /taskName\(t\)/, '右栏没给出任务题名');
  assert.match(blockInsp, /'第 ' \+ p\.step \+ ' 步 \/ 共 ' \+ \(S\.v\.mainSteps \|\| 0\) \+ ' 步'[\s\S]{0,400}?factRow\('阶段', stageCell\)/,
    '主线块没写它在整个进度里的第几步');
  assert.match(blockInsp, /' · 这条任务的第 ' \+ st\.k \+ ' 块 \/ 共 ' \+ st\.m \+ ' 块（第 ' /, '右栏没写这是任务的第几块、跨第几步');
  assert.match(blockInsp, /p\.step == null\) \{[\s\S]{0,420}?factRow\('夹在哪', btw\)/, '插曲块没写夹在哪两步之间');
  assert.match(blockInsp, /factRow\('我的要求'/, '右栏没写「我的要求」——用户要的是你理解的诉求');
  assert.match(blockInsp, /factRow\('经验'/, '右栏没写「经验」');
  assert.ok(!/factRow\('你说的'/.test(blockInsp), '右栏还在重复「你说的」——原文在下面，别再搬一遍');
  assert.ok(!/factRow\('我回的'/.test(blockInsp), '右栏还在重复「我回的」——原文在下面，别再搬一遍');
  assert.match(blockInsp, /factRow\('做成什么'/, '右栏没写「做成什么」');
  assert.ok(!/factRow\('(为什么做|本次完成|实现了什么)'/.test(blockInsp),
    '第十五轮的三行（为什么做/本次完成/实现了什么）没被综述三行取代——同一件事不该换三种说法');
  assert.match(blockInsp, /if \(p\.sum\) \{[\s\S]{0,520}p\.sum\.need[\s\S]{0,240}p\.sum\.lesson[\s\S]{0,240}p\.sum\.done/,
    '有综述时右栏没把 need/lesson/done 放进「我的要求/经验/做成什么」');
  assert.match(blockInsp, /p\.sum\.need \|\| p\.sum\.said/, '旧综述没有 need 时没回落到「你说」摘要');
  assert.match(blockInsp, /这一步在做/, '任务行没说明这一块的主线任务在做什么');
  assert.match(js, /未划入阶段（尾段/, '尾段块没标清它还没划入阶段');
  assert.match(blockInsp, /模型综述（归纳，不过六条判据） · 依据 '/, '右栏没标清那是模型综述及其依据段');
  assert.ok(!/这块还没有模型综述/.test(blockInsp), '没综述的块不再写「还没有模型综述」——改标「待补综述」+ 原文截断');
  assert.match(blockInsp, /待补综述 · 以上「我的要求」是原文截断/, '没综述时右栏要标「待补综述」并说明是原文截断');
  assert.match(blockInsp, /askRaw \? \(askRaw\.length > 140/, '没综述时右栏用真人原话截断，不空着');
  assert.match(js, /sum: s\.sum \|\| null, sumFrom: s\.sumFrom \|\| ''/, 'partsOf 没把综述带进页面，右栏只会永远回落成原话');
  assert.match(js, /'msrc', '模型综述 · 依据 ' \+ p\.sumFrom/, '中景卡没把出处标成「模型综述 · 依据 Sxx」');
  assert.match(js, /p\.sum \? p\.sum\.done : p\.solved/, '中景卡底还在用规则层的 solved，而不是综述的 done');
  assert.match(blockInsp, /'改了' \+ cnJoin\(kindList\(files\)\)/, '回落路径没按文件类别说人话');
  assert.ok(!/\bp\.made\b|\bp\.outs\b/.test(blockInsp), '「做成什么」又把产物文件清单堆回面板了');
  assert.match(inspHelpers, /var FILE_KINDS = \['页面脚本', '样式', '测试'/, '回落路径的文件分类表不在（文件名会直接上屏）');

  assert.ok(!/factRow\('(句|段|回合|规模|计数行|已证|压缩|完成度)'/.test(blockInsp),
    '块右栏又把句/段/回合/规模这些账单行堆回来了——面板是摘要，不是账本');
  assert.ok(!/segRows|p\.segIds\.forEach/.test(blockInsp), '块右栏还挂着段清单：用户要的是一段摘要，不是逐段列表');
  assert.match(blockInsp, /dataset\.label = '查看原文'/, '右栏的正文入口不叫「查看原文」');
  assert.match(js, /function bodyBlock\(id, host, btn\) \{[\s\S]{0,400}btn\.textContent = pre\.hidden \? label : '收起原文'/,
    '正文按钮收起后没回到调用方给的叫法（块上是「查看原文」）');
});

// 真实外项目会话咬出来的：块内一句话都没有、又没有模型综述时，mark 曾算出字符串
// "undefined"（nameCell 把 n=undefined 原样返回，下一支 String(n) 把它当成了文件名），
// brief 首行于是印出《undefined》。题名只认「真有个名字」，没有就如实空着。
test('块名兜底：块里没有可当题的话时，mark 落成占位符而不是字符串 undefined', () => {
  const nodes = [{ id: 'S01', t0: 1, t1: 2, compact: false, task: 'B01', say: '', files: [], wrote: 0 }];
  const { steps } = stepsOf(nodes, [], [{ id: 'B01', title: '' }], [{ id: 'B01', head: 'S01', host: '', depth: 0, rejoin: '' }]);
  assert.equal(steps.length, 1, '单段夹具没建成一块');
  assert.equal(steps[0].mark, '—', `块内无话可题时应落成占位符，实际 ${JSON.stringify(steps[0].mark)}`);
  const text = briefText({ meta: { session: 'fixture', segs: 1 }, steps, phases: [], mainSteps: 1 }, []);
  assert.doesNotMatch(text, /undefined/, '简报把 undefined 当成块名印出来了');
  assert.match(text.split('\n')[1], /《（无题名）》/, '没有题名时应如实写「无题名」，不许拿占位符冒名');
});

// 链路自检：缺什么就列什么，不替模型写内容。
test('链路自检：缺综述、题名、尾段阶段都列出来', () => {
  const base = fixture('outstanding');
  const dir = writeStore(`${base}/store`, built);
  const o = outstandingFor({ storeRoot: `${base}/store`, sessionId: ledger.sessionId, cwd: ledger.cwd });
  const v = readView(dir);
  assert.equal(o.missingBlocks.length, v.steps.filter((s) => !s.sum).length, '缺综述的块数不对');
  assert.ok(o.items.some((x) => /块综述缺/.test(x)), '缺综述没列出来');
  assert.ok(o.items.some((x) => /支线题名缺/.test(x)), '缺任务题名没列出来');
  if (v.tail) {
    assert.ok(o.items.some((x) => /尾段第/.test(x)), '尾段没阶段说明没列出来');
    assert.equal(o.draftRanges[0][0], v.tail.from, '尾段草稿区间没从尾段起点开始');
    assert.equal(o.draftRanges[o.draftRanges.length - 1][1], v.tail.to, '尾段草稿区间没盖到尾段末步');
    if (o.draftRanges.length > 1) assert.ok(o.draftRanges.every(([a, b]) => b - a + 1 >= 2), '尾段草稿留了单步段');
  }
  fs.rmSync(base, { recursive: true, force: true });
});

// 块综述层（第十七轮）：用户要的是「理解原话后归纳」，不是把原话剪一段贴回来。
// 四道闸门都必须能独立挡人：原话截段、编没见过的名字、超字数、旧锚点。
test('块综述层：模型归纳走四道闸门，原话截段与旧锚点都被挡在外面', () => {
  const root = fixture('summaries');
  const synth = synthStore();                    // 自带夹具：不依赖本机那段会话恰好写了什么
  const dir = writeStore(root, synth.built);
  const tableFile = `${dir}/summaries.json`;
  fs.rmSync(tableFile, { force: true });          // 上一次跑留下的表会让"没有综述就回落"的断言失真
  const v = readView(dir);
  const blocks = v.steps, tasks = v.tasks;
  const totals = { mainSteps: v.mainSteps, blocks: blocks.length, nodes: v.nodes.length };

  // 挑一块带整句真人原话的：反截段要拿真正的原话去试，不能拿自己编的句子
  const b = blocks.find((s) => /[\u4e00-\u9fa5]{16}/.test(s.say || ''));
  assert.ok(b, '没有一块带 ≥16 字中文原话——反截段闸门没法测');
  const quote = (b.say.match(/[\u4e00-\u9fa5]{16,}/) || [])[0];
  assert.ok(quote, `块 ${b.i} 的原话里挑不出一段 16 字中文：${b.say}`);
  const before = { gist: b.gist, mark: b.mark };

  const good = {
    segs: b.segIds.slice(),
    short: '综述层',
    title: '给每块写模型综述，不再剪原话',
    said: '你要的是理解原话之后归纳，而不是把原话剪一段贴回来当总结',
    answered: '新增综述外挂表与四道闸门，页面改成直接讲这块做了什么',
    done: '综述层落地，原话截段被机械拦下',
    need: '用户要的是理解原话后的归纳，不是把原话剪一段贴回来',
    lesson: '综述只做归纳；原话留在原文里，截段会被闸门挡下',
  };
  const ok = validateSummary(good, b, v.nodes, tasks, totals);
  assert.ok(ok.ok, `一份正经综述被闸门挡了：${ok.errors.join('；')}`);
  assert.equal(ok.row.basis, 'model', '综述被写成了非 model 的基别——它会混进六条判据');
  assert.equal(ok.row.hash, blockHash(b, v.nodes), '落盘行的 hash 不是这一块的段锚点');
  assert.equal(ok.row.need, good.need, 'need 没被带进落盘行');
  assert.equal(ok.row.lesson, good.lesson, 'lesson 没被带进落盘行');
  assert.ok(validateSummary({ ...good, need: '字'.repeat(SUMMARY_NEED_MAX + 1) }, b, v.nodes, tasks, totals)
    .errors.some((e) => /need/.test(e)), `need 超过 ${SUMMARY_NEED_MAX} 字没被挡`);
  assert.ok(validateSummary({ ...good, lesson: '字'.repeat(SUMMARY_LESSON_MAX + 1) }, b, v.nodes, tasks, totals)
    .errors.some((e) => /lesson/.test(e)), `lesson 超过 ${SUMMARY_LESSON_MAX} 字没被挡`);

  // ② 反截段：整格就是把原话剪下来的一段（≥8 字）→ 拒收
  const cut = validateSummary({ ...good, said: quote.slice(0, 16) }, b, v.nodes, tasks, totals);
  assert.ok(!cut.ok && cut.errors.some((e) => /原话截段/.test(e)),
    `把原话剪 16 字当「你说的」居然过闸：「${quote.slice(0, 16)}」`);
  // ③ 接地：编一个块素材里没出现过的文件名 → 拒收
  const madeUp = validateSummary({ ...good, answered: '顺手加了 summarize-extra.mjs 这个文件' }, b, v.nodes, tasks, totals);
  assert.ok(!madeUp.ok && madeUp.errors.some((e) => /找不到/.test(e)), '编出来的文件名居然过闸——综述可以编造产物');
  // ① 字数上限：中景两行放不下的标题、远景一格放不下的 short
  assert.ok(validateSummary({ ...good, title: '字'.repeat(SUMMARY_TITLE_MAX + 1) }, b, v.nodes, tasks, totals)
    .errors.some((e) => /title/.test(e)), `title 超过 ${SUMMARY_TITLE_MAX} 字没被挡`);
  assert.ok(validateSummary({ ...good, short: '一二三四五六七八' }, b, v.nodes, tasks, totals)
    .errors.some((e) => /short/.test(e)), `short 超过 ${SUMMARY_SHORT_W} 格没被挡`);
  assert.ok(validateSummary({ ...good, answered: '' }, b, v.nodes, tasks, totals)
    .errors.some((e) => /answered 为空/.test(e)), '空着「我回的」也能过闸');
  // ④ 锚点：段列表变了 / 段锚点 hash 变了 → 拒收（旧综述不许贴到新块上）
  assert.ok(validateSummary({ ...good, segs: b.segIds.slice(1) }, b, v.nodes, tasks, totals)
    .errors.some((e) => /segs/.test(e)), '段列表对不上也能过闸');
  assert.ok(validateSummary({ ...good, hash: '0000000000000000' }, b, v.nodes, tasks, totals)
    .errors.some((e) => /hash 对不上/.test(e)), '旧锚点的综述没被挡——它会被贴到已经变了的块上');

  // 任务题名同一组闸门：不能抄支头原话，不能编，不能超 18 字
  const t = tasks.find((x) => x.id === b.dominant);
  assert.ok(t, `块 ${b.i} 的主支 ${b.dominant} 不在任务表里`);
  const tOk = validateTaskTitle({ title: '把块右栏写成人话' }, t, blocks, v.nodes);
  assert.ok(tOk.ok, `一份正经任务题名被挡了：${tOk.errors.join('；')}`);
  const headSay = (v.nodes.find((n) => n.id === t.head) || {}).say || '';
  const headQuote = (headSay.match(/[\u4e00-\u9fa5]{12,}/) || [])[0];
  if (headQuote) {
    assert.ok(!validateTaskTitle({ title: headQuote.slice(0, 12) }, t, blocks, v.nodes).ok,
      `任务题名抄支头原话前 12 字居然过闸：「${headQuote.slice(0, 12)}」`);
  }
  assert.ok(!validateTaskTitle({ title: '把块右栏补上 missing-widget.mjs' }, t, blocks, v.nodes).ok,
    '任务题名里编的文件名过闸了');

  // 消费侧：表里的综述必须原样进 payload（gist/mark/sum），别的块不许借用
  writeSummaries(dir, { blocks: { [String(b.i)]: ok.row }, tasks: { [t.id]: tOk.row } });
  const v2 = readView(dir);
  const b2 = v2.steps.find((s) => s.i === b.i);
  assert.equal(b2.gist, good.title, '中景标题没换成模型综述的 title');
  assert.equal(b2.mark, good.short, '远景的题没换成模型综述的 short');
  assert.ok(b2.sum && b2.sum.said === good.said && b2.sum.answered === good.answered && b2.sum.done === good.done,
    'payload 没把综述三格带给页面——右栏只会回落成原话');
  assert.equal(b2.sum.need, good.need, 'payload 没把「我的要求」带给页面');
  assert.equal(b2.sum.lesson, good.lesson, 'payload 没把「经验」带给页面');
  assert.equal(b2.sumFrom, b2.span || b2.segIds[0] || b2.from, '综述的出处段号不对');
  assert.equal(v2.meta.summaries.blocks, 1);
  assert.equal(v2.tasks.find((x) => x.id === t.id).sumTitle, tOk.row.title, '任务题名没进 payload');
  assert.equal(v2.meta.summaries.tasks, 1);
  assert.equal(v2.meta.summaries.dropped, 0);
  for (const s of v2.steps) if (s.i !== b.i) assert.ok(!s.sum, `块 ${s.i} 没有综述却拿到了综述`);
  const les = lessonsOf(dir);
  assert.equal(les.total, 1, '写了 lesson 的块应当出现在可复用经验里');
  assert.equal(les.rows[0].block, b.i);
  assert.equal(les.rows[0].lesson, good.lesson, '经验出口没带出 lesson 原文');
  assert.equal(les.rows[0].need, good.need, '经验出口没带出当时的要求');
  assert.equal(les.rows[0].from, b.segIds[0], '经验出口要能指回原文锚点');

  // 旧锚点失效：改坏那一块的 hash 后重建视图，综述必须被丢掉并回落（不许把旧结论说成新的）
  writeSummaries(dir, { blocks: { [String(b.i)]: { ...ok.row, hash: 'deadbeef' } }, tasks: {} });
  assert.equal(lessonsOf(dir).total, 0, '锚点失效的 lesson 不许留在可复用经验里');
  const v3 = readView(dir);
  const b3 = v3.steps.find((s) => s.i === b.i);
  assert.ok(!b3.sum, '段锚点变了综述还活着');
  assert.equal(b3.gist, before.gist, '综述被丢后没有回落到原来的原话摘要');
  assert.equal(b3.mark, before.mark);
  assert.equal(v3.meta.summaries.dropped, 1, '丢了几条综述要能数出来，否则页面上是静默少字');

  // 表坏了要炸，不许当成空表：下一批写入会把之前所有综述静默覆盖掉
  fs.writeFileSync(tableFile, '{ 这不是 json');
  assert.throws(() => readSummaries(dir), /读不了/, '坏掉的 summaries.json 被当成空表读了——下一次写会清空所有综述');
  fs.rmSync(tableFile, { force: true });
});

// 阶段层（第十七轮）：模型划连续区间、写六格；工具算覆盖面与锚点、逐格反编造。
// 阶段永远 basis:'model'，不进路由层、不过六条判据；表是外挂表，读取时按顺序重排 n。
// 实时区（PRD-blocks-live）：没有阶段表时一条真人提问一块（不再只在压缩点切开、
// 把十几句人话吞成两三块）；第一次写阶段表冻结 askSplitFrom=0，写完块不重切、阶段
// 锚点仍新鲜；没写说明的步如实进「尾段」，整段都没阶段时叫「未划阶段」。
test('没有阶段表时按真人提问切块；写下第一份阶段后块不重切、尾段如实留白', () => {
  const root = fixture('live-split');
  const dir = writeStore(root, built);
  const before = readView(dir);
  assert.equal(before.tail.whole, true, '整段一段阶段都没有时，tail 要标 whole（页面写「未划阶段」）');
  const K = Math.min(44, Math.max(4, Math.floor(before.mainSteps / 3)));
  const idx = {};
  before.nodes.forEach((n, i) => { idx[n.id] = i; });
  const asksIn = (v, s) => v.asks.filter((a) => a.who === '你'
    && !/^\[convledger/.test(String(v.nodes[idx[a.id]]?.say || ''))
    && idx[a.id] >= s.i0 && idx[a.id] <= s.i1).length;
  for (const s of before.steps) assert.ok(asksIn(before, s) <= 1, `没有阶段表时块 ${s.i} 里装了两条以上提问：没有按提问切`);
  assert.ok(before.steps.reduce((n, s) => n + asksIn(before, s), 0) >= 2, '这份夹具里没数到提问，测不出切块');

  const phases = [{ from: 1, to: K, short: '归档区', doing: '先把归档区划出来', state: '归档区已划', effect: '之后按提问切',
    plan: '—', track: '—', refs: [], hash: phaseHash(1, K, before.steps, before.nodes), basis: 'model' }];
  // 第一次写表的冻结值是 0（cli.mjs 同一条规则）：块本来就按提问切，写完不能退回压缩切。
  fs.writeFileSync(path.join(dir, 'phases.json'),
    JSON.stringify({ schema: 'convledger-phases/1', phases, askSplitFrom: 0 }, null, 1));
  const after = readView(dir);
  assert.deepEqual(after.steps.map((s) => [s.i0, s.i1]), before.steps.map((s) => [s.i0, s.i1]),
    '写完第一份阶段后块被重切了（阶段与综述的锚点会当场失效）');
  assert.equal(after.mainSteps, before.mainSteps, '写完阶段后步数变了');
  assert.equal(after.phases.length, 1, '写阶段本身不该让它自己过期');
  assert.deepEqual(after.tail, { from: K + 1, to: after.mainSteps, written: false, whole: false }, '尾段没有如实标出');
});
test('阶段层：模型划边界，工具核覆盖/锚点/反截段，旧锚点整条丢弃', () => {
  const base = fixture('phases');
  const docsRoot = `${base}/docs`;
  const synth = synthStore();
  const dir = writeStore(`${base}/store`, synth.built);
  const tableFile = `${dir}/phases.json`;
  fs.rmSync(tableFile, { force: true });
  fs.rmSync(docsRoot, { recursive: true, force: true });
  fs.mkdirSync(docsRoot, { recursive: true });
  fs.writeFileSync(`${docsRoot}/plan.md`, '# 计划\n\n## 阶段一：骨架\n\n正文\n', 'utf8');
  const docs = scanDocs(docsRoot);
  const hit = docs.list.find((x) => /plan\.md$/.test(x.f) && /阶段一/.test(x.h));
  assert.ok(hit, `文档扫描没找到自己写的标题：${docs.list.slice(0, 3).map((x) => x.f + '›' + x.h).join('；')}`);
  assert.equal(resolveRef(docs, hit.id).h, hit.h, `D 编号 ${hit.id} 解析不回原标题`);
  assert.equal(resolveRef(docs, 'D999'), null, '假 D 编号居然解析成功');

  const v = readView(dir);
  const M = v.mainSteps;
  assert.ok(M >= 3, `主线只有 ${M} 步，阶段表没法测`);
  const ctx = { steps: v.steps, nodes: v.nodes, totals: { mainSteps: M, blocks: v.steps.length, nodes: v.nodes.length }, docs };
  const head = {
    from: 1, to: M - 1, short: '起手', doing: '先把账本骨架和命令行出口立起来，后面所有判断都挂在这套账上',
    state: '主线走到第 ' + (M - 1) + ' 步，骨架已经能出每一段的账', effect: '后半程都在这套结构上继续加层',
    plan: '按计划文档推进第一阶段', track: '进度文档记到这一段', refs: [hit.id],
  };
  const tail = { from: M, to: M, short: '收尾', doing: '最后一步把路径闭合，说清下一步从哪起', state: '正好走到末步',
    effect: '这一段结束时路线图能自己讲清', plan: '—', track: '—', refs: [] };
  const okAll = validatePhases([head, tail], ctx);
  assert.ok(okAll.ok, `一份合法阶段表被挡了：${okAll.errors.join('；')}`);
  assert.equal(okAll.rows.length, 2);
  // 尾段允许留白：只写到已收口的一步，末步还在长也不该被强行要求覆盖
  assert.ok(validatePhases([{ ...head, to: M - 1 }], ctx).ok, '允许的阶段表在末步留白时被挡了');
  assert.ok(!('n' in okAll.rows[0]), 'n 不该由写入口落盘——读取时按顺序重排，删掉中间一段也不留空号');
  assert.equal(okAll.rows[0].hash, phaseHash(1, M - 1, v.steps, v.nodes), 'hash 不是这一段全部段锚点的拼接');
  assert.deepEqual(okAll.rows[0].segs, phaseSegs(1, M - 1, v.steps), 'segs 不是按链序算出来的段列表');
  assert.deepEqual(okAll.rows[0].refs, [{ f: hit.f, h: hit.h }], 'D 编号没在写入口解析成文件+标题');
  assert.equal(okAll.rows[0].basis, 'model', '阶段被写成了非 model 的基别——它会在页面上冒充已证结论');

  const fails = (entries, re, label) => {
    const r = validatePhases(entries, ctx);
    assert.ok(!r.ok && r.errors.some((e) => re.test(e)), `${label}：居然过闸 / 错误不对——${r.errors.join(' | ')}`);
  };
  fails([{ ...head, to: M - 2 }, tail], /没有被任何阶段覆盖/, '少了一步');
  fails([{ ...head, to: M - 1 }, { ...tail, from: M - 1 }], /重叠/, '两段重叠');
  fails([{ ...head, to: 0 }], /不合法/, '区间倒了过来');
  fails([{ ...head, from: 2 }], /必须从第 1 步开始/, '开头留空');
  fails([{ ...head, to: M + 1 }, tail], /不合法/, '尾部越界');
  fails([{ ...head, to: 1 }, { ...tail, from: 2, to: M }], /至少 2 步/, '非末段只有 1 步');

  const qb = v.steps.find((s) => s.step != null && s.step < M && /[\u4e00-\u9fa5]{16}/.test(s.say || ''));
  assert.ok(qb, '第一段里没有 ≥16 字中文原话——反截段闸门没法测');
  const q = (qb.say.match(/[\u4e00-\u9fa5]{16,}/) || [])[0].slice(0, 16);
  fails([{ ...head, doing: q }, tail], /原话截段/, '六格是原话的连续截段');
  fails([{ ...head, doing: '顺手加了 xyz-widget.mjs' }, tail], /找不到/, '编了没见过的文件名');
  fails([{ ...head, refs: ['D999'] }, tail], /不在这次的文档清单/, '引用了一个不存在的 D 编号');
  fails([{ ...head, refs: [] }, tail], /没有引用任何文档章节/, 'plan/track 有正文却没有引用');
  fails([{ ...head, doing: '' }, tail], /doing 为空/, '六格有一格空着');
  fails([{ ...head, short: '一二三四五六七八九十一' }, tail], /short/, 'short 超宽');

  // 写盘 → 读取：n 按顺序重排、块拿到 phase 号、规则由账本复算（不是模型填的）
  writePhases(dir, { askSplitFrom: 0, phases: okAll.rows });
  const v2 = readView(dir);
  assert.equal(v2.phases.length, 2);
  assert.equal(v2.meta.phases.written, 2);
  assert.equal(v2.meta.phases.dropped, 0);
  assert.deepEqual(v2.phases.map((p) => p.n), [1, 2]);
  assert.equal(v2.phases[0].blocks, v2.steps.filter((s) => s.phase === 1).length, '块没拿到 phase 号');
  assert.ok(v2.steps.filter((s) => s.phase === 2 && s.step != null).every((s) => s.step === M), '第二段把别的块也标成了自己');
  assert.ok(v2.phases[0].rules.every((r) => (v2.nodes.find((n) => n.id === r.id) || {}).basis === 'verified'),
    '规则格里混进了没过判据的段');

  // 旧锚点：改坏 hash → 整条丢弃、剩余重排（不留空号），块回落成没有阶段
  writePhases(dir, { askSplitFrom: 0, phases: [{ ...okAll.rows[0], hash: 'deadbeef' }, okAll.rows[1]] });
  const v3 = readView(dir);
  assert.equal(v3.phases.length, 1, '锚点对不上的阶段还活着——旧说明会被贴到新块上');
  assert.equal(v3.meta.phases.dropped, 1);
  assert.equal(v3.phases[0].n, 1);
  assert.equal(v3.phases[0].from, M, '剩下的那一段没有重排成第 1 号');
  assert.ok(v3.steps.filter((s) => s.step != null && s.step < M).every((s) => !s.phase), '被丢掉的阶段仍挂在块上');

  // 尾部还在长：to 越界 → 丢弃，不拿旧说明挂新内容
  writePhases(dir, { askSplitFrom: 0, phases: [{ ...okAll.rows[0], to: M + 1 }] });
  assert.equal(readView(dir).meta.phases.dropped, 1, '越界的阶段没被丢');

  // 坏表要炸，不许当空表：下一批写入会把之前所有阶段静默覆盖
  fs.writeFileSync(tableFile, '{ 这不是 json');
  assert.throws(() => readPhases(dir), /读不了/, '坏掉的 phases.json 被当成空表读了');
  fs.rmSync(tableFile, { force: true });
});

// 两级入口（brief）：第一级照抄阶段表的摘要，第二级给六格与块表。
// 这不是又一次"生成总结"——它一个字都不许改，尾段没写就必须说没写。
test('brief：阶段摘要照抄、尾段如实空着、预算封顶、六格逐字', () => {

  const base = fixture('brief');
  const dir = writeStore(`${base}/store`, built);
  fs.rmSync(`${dir}/phases.json`, { force: true });
  const v = readView(dir);
  const M = v.mainSteps;
  assert.ok(M >= 4, `主线只有 ${M} 步，尾段与块表没法测`);
  const sid = ledger.sessionId.slice(0, 8);
  const cli = (args) => spawnSync(process.execPath, ['src/cli.mjs', ...args, '--store', `${base}/store`, '--session', sid], { cwd: tools, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

  const doing = '先把账本骨架和命令行出口立起来，后面所有判断都挂在这套账上';
  const state = '骨架已经能出每一段的账';
  const effect = '后半程都在这套结构上继续加层';
  const plan = '按计划文档推进第一阶段';
  const track = '进度文档记到这一段';
  const rows = [{ from: 1, to: M - 2, short: '起手', doing, state, effect, plan, track, refs: [],
    hash: phaseHash(1, M - 2, v.steps, v.nodes), basis: 'model' }];
  writePhases(dir, { askSplitFrom: 0, phases: rows });
  const v1 = readView(dir);
  assert.equal(v1.phases.length, 1, '刚写的阶段没活下来，brief 没有东西可照抄');

  const text = briefText(v1, []);
  const head = text.split('\n')[0];
  assert.match(head, new RegExp(`${segments.length} 段 / ${v1.steps.length} 块 / ${M} 步`), `brief 头行的计数不是复算出来的：${head}`);
  assert.match(head, /阶段 1 段/, 'brief 头行没数阶段');
  assert.match(text, new RegExp(`阶段 1 · 第 1–${M - 2} 步`), 'brief 漏了阶段 1 的区间');
  assert.ok(text.includes('起手'), 'brief 漏了阶段短名');
  assert.ok(text.includes(doing) && text.includes(effect), 'brief 的阶段行不是阶段表的原文');
  assert.match(text, new RegExp(`尾段：第 ${M - 1}–${M} 步`), '没覆盖的尾步没有如实写出来');
  assert.equal((text.match(/^阶段 \d+ · /gm) || []).length, v1.phases.length, 'brief 里的阶段数 ≠ 新鲜阶段数');
  assert.ok(v1.phases.every((p) => p.to <= M - 2), '未覆盖的尾步被算进了某个阶段');
  assert.ok(tok(text) <= 1800, `brief 花了 ${tok(text)} token，超了 1800 的预算`);

  // 补满：尾段声明必须消失——覆盖满了还喊尾段，等于把两段合成一段的假话
  writePhases(dir, { askSplitFrom: 0, phases: [...rows, { from: M - 1, to: M, short: '收尾', doing: '最后两步把路径闭合，说清下一步从哪起',
    state: '正好走到末步', effect: '这一段结束时路线图能自己讲清', plan: '—', track: '—', refs: [],
    hash: phaseHash(M - 1, M, v.steps, v.nodes), basis: 'model' }] });
  const v2 = readView(dir);
  assert.equal(v2.phases.length, 2, '补满的阶段表没全活下来');
  const text2 = briefText(v2, []);
  assert.ok(!/尾段：/.test(text2), '覆盖满了还在喊尾段');
  assert.match(text2, new RegExp(`阶段 2 · 第 ${M - 1}–${M} 步`));

  // 第二级：六格逐字，一个都不许改写
  const detail = phaseDetailText(v2, 1);
  assert.equal(typeof detail, 'string', `brief --phase 1 出错了：${detail.error}`);
  for (const [k, val] of [['做了', doing], ['进度', state], ['成了', effect], ['对照', plan], ['进度文件', track]]) {
    assert.ok(detail.includes(`${k}：${val}`), `brief --phase 的第 ${k} 格不是逐字原文`);
  }
  assert.ok(detail.includes(`块 ${v2.phases[0].fromBlock}–${v2.phases[0].toBlock}`), '第二级没给块区间');

  // 走 CLI：与模块同文；越界/零号阶段必须非零退出
  const r = cli(['brief', '--phase', '1']);
  assert.equal(r.status, 0, `brief --phase 1 退出码 ${r.status}：${r.stdout}${r.stderr}`);
  assert.equal(r.stdout, detail, 'CLI 的 brief --phase 与模块输出不一致');
  for (const n of ['99', '0']) {
    const bad = cli(['brief', '--phase', n]);
    assert.notEqual(bad.status, 0, `--phase ${n} 居然退出 0`);
  }
  assert.match(cli(['brief', '--phase', '99']).stdout, /没有阶段 99/);

  // 空表：如实说没有阶段，不编一个
  fs.rmSync(`${dir}/phases.json`, { force: true });
  const v3 = readView(dir);
  const text3 = briefText(v3, []);
  assert.match(text3, /还没有阶段说明/, '没有阶段表时 brief 没有如实说没有');
  assert.match(text3, new RegExp(`尾段：第 1–${M} 步`), '没有阶段表时不该说任何步被覆盖');
  assert.ok(!/^阶段 \d+ · /m.test(text3), '空表时 brief 编出了阶段');
});

// 章层（PRD-chapters）：575 段这种会话，brief 全量已经超注入预算（实测 2,824 tok vs 硬顶 2,000，
// 压缩后拿到的是被砍掉前段阶段的截断版）。章层把"几十步一程"压成一行 + 只展开最后一章，
// 这一条同时钉住三件事：边界必须落在阶段边界上、九格过同一套反编造闸门、注入真的变小了。
test('章层：边界跟着阶段走、九格过闸门、brief 换成章模式且真的更短', () => {
  const base = fixture('chapters');
  const synth = synthStore();
  const dir = writeStore(`${base}/store`, synth.built);
  const docsRoot = `${base}/docs`;
  fs.rmSync(`${dir}/chapters.json`, { force: true });
  fs.rmSync(docsRoot, { recursive: true, force: true });
  fs.mkdirSync(docsRoot, { recursive: true });
  fs.writeFileSync(`${docsRoot}/plan.md`, '# 计划\n\n## 章一：骨架\n\n正文\n', 'utf8');
  const docs = scanDocs(docsRoot);
  const hit = docs.list.find((x) => /plan\.md$/.test(x.f) && /章一/.test(x.h));
  assert.ok(hit, `文档扫描没找到自己写的标题：${docs.list.slice(0, 3).map((x) => x.f + '›' + x.h).join('；')}`);

  const v = readView(dir);
  const M = v.mainSteps;
  assert.ok(M >= 60, `主线只有 ${M} 步，切不出十二段阶段（章要盖住多段才比阶段层省）`);
  const pctx = { steps: v.steps, nodes: v.nodes, totals: { mainSteps: M, blocks: v.steps.length, nodes: v.nodes.length }, docs };
  // 十二段等分阶段：章层的全部意义是「多程并成一章」，四段阶段试不出成本差。
  const cut = (i) => Math.floor(M * i / 12);
  const ph = (from, to) => ({ from, to, short: '起手', doing: '先把账本骨架和命令行出口立起来，后面所有判断都挂在这套账上',
    state: '骨架已经能出每一段的账', effect: '后半程都在这套结构上继续加层',
    plan: '按计划文档推进第一阶段', track: '进度文档记到这一段', refs: [hit.id] });
  const prow = validatePhases(Array.from({ length: 12 }, (_, i) => ph(cut(i) + 1, cut(i + 1))), pctx);
  assert.ok(prow.ok, `夹具的阶段表没过闸门：${prow.errors.join('；')}`);
  writePhases(dir, { askSplitFrom: 0, phases: prow.rows });
  const v2 = readView(dir);
  assert.equal(v2.phases.length, 12, '十二段阶段没全活下来，章没法对齐');

  const cctx = { steps: v2.steps, nodes: v2.nodes, phases: v2.phases, docs, requests: [],
    totals: { mainSteps: M, blocks: v2.steps.length, nodes: v2.nodes.length } };
  const chap = { from: 1, to: cut(9), short: '起手到骨架',
    goal: '先把对话变成能复算的结构账本，再让页面与命令行读同一份',
    where: '骨架、命令行出口与本机页面都立住了，后面每一程都挂在这套账上',
    rules: '派生优先：正文不搬进账本，回源读；没有就如实说没有',
    tasks: '建账、切块、锚点回读、画布首版、增量入口',
    walls: '取材太贵与自测跟着长大会拖慢复跑，都靠精确到字符串的修订解决',
    cautions: '提交只走显式清单；推送要等另一句；闸门不许为覆盖率放宽',
    arch: '段块步阶段四层，外挂表带锚点，一个服务所有会话',
    handoff: '先读简报，再看块表，要原文按段回读', refs: [hit.id] };
  const one = validateChapters([chap], cctx);
  assert.ok(one.ok, `一份合法章表被挡了：${one.errors.join('；')}`);
  assert.equal(one.rows[0].hash, phaseHash(1, cut(9), v2.steps, v2.nodes), '章的 hash 不是这一程全部段锚点的拼接');
  assert.equal(one.rows[0].basis, 'model', '章被写成了非 model 的基别——它会在页面上冒充已证结论');

  const bad = (patch, re, label) => {
    const r = validateChapters([Object.assign({}, chap, patch)], cctx);
    assert.ok(!r.ok && r.errors.some((e) => re.test(e)), `${label}：居然过闸 / 错误不对——${r.errors.join(' | ')}`);
  };
  bad({ to: cut(9) - 1 }, /章边界必须落在阶段边界上/, '边界切进了一程中间');
  bad({ from: 2 }, /必须与阶段边界重合|必须从第 1 步开始/, '章开头不从第 1 步');
  bad({ to: cut(2) }, /少于 3 个/, '只盖两段还叫一章');
  bad({ handoff: 'xyz-widget.mjs' }, /在章素材里找不到/, '编了没见过的名字');
  bad({ arch: '' }, /arch（架构现状）为空|arch 为空/, '九格有一格空着');
  bad({ goal: '一'.repeat(70) }, /goal \d+ 字 > 60/, '目的超上限');
  const qb = v2.steps.find((s) => s.step != null && s.step <= cut(9) && /[\u4e00-\u9fa5]{16}/.test(s.say || ''));
  const q = (qb.say.match(/[\u4e00-\u9fa5]{16,}/) || [])[0].slice(0, 16);
  bad({ tasks: q }, /原话截段/, '某格是原话的连续截段');
  // 整表判据：漏一程、两章重叠、章停在一程中间
  assert.ok(!validateChapters([chap, Object.assign({}, chap, { from: cut(9) + 2, to: M })], cctx).ok, '章之间漏了一程却没被挡');
  assert.ok(!validateChapters([chap, Object.assign({}, chap, { from: cut(9), to: M })], cctx).ok, '两章重叠却没被挡');
  const noTail = validateChapters([chap, { ...chap, from: cut(9) + 1, to: cut(9) + 2 }], cctx);
  assert.ok(!noTail.ok && noTail.errors.some((e) => /一个阶段都没有|章边界必须落在阶段边界上|少于 3 个/.test(e)), `章停在一程中间、没盖满整段阶段却没被挡：${noTail.errors.join(' | ')}`);

  // 两章：第一章程头六程，第二章程尾三程——brief 只展开最后一章，这才是省的地方
  const two = validateChapters([{ ...chap, to: cut(6) }, { ...chap, from: cut(6) + 1, to: cut(9) }], cctx);
  assert.ok(two.ok, `两章表被挡了：${two.errors.join('；')}`);
  writeChapters(dir, { chapters: two.rows });
  const v3 = readView(dir);
  assert.equal(v3.chapters.length, 2, '章没落进视图');
  assert.equal(v3.meta.chapters.written, 2);
  assert.equal(v3.meta.chapters.dropped, 0);
  assert.ok(v3.steps.filter((s) => s.chapter === 1).length >= 3, '章里的块没拿到 chapter 号');
  assert.deepEqual(v3.chapters[0].phaseNs, [1, 2, 3, 4, 5, 6], '章没数清自己盖了哪几段阶段');
  assert.deepEqual(v3.chapters[1].phaseNs, [7, 8, 9], '第二章的阶段号没接着数');

  // 接手一页：九格逐字 + 基别限定，且默认给最后一个已写章
  const page = handoffText(v3, null);
  assert.ok(!page.error, `handoff 出错：${page.error}`);
  for (const [k, val] of [['一开始的目的', chap.goal], ['走到哪', chap.where], ['核心规则与原则', chap.rules],
    ['主要任务', chap.tasks], ['碰过的壁', chap.walls], ['接下来要注意', chap.cautions],
    ['架构现状', chap.arch], ['怎么接手', chap.handoff]]) {
    assert.ok(page.text.includes(`${k}：${val}`), `接手页的「${k}」不是逐字原文`);
  }
  assert.match(page.text, /basis=model（归纳，不过六条判据）/, '接手页没标出这是模型归纳');
  assert.match(page.text, new RegExp(`阶段 7 · 第 ${cut(6) + 1}–`), '接手页没列这一章的阶段，或默认没给最后一章');
  assert.ok(handoffText(v3, 9).error, '不存在的章号居然给出了接手页');
  assert.match(chapterDetailText(v3, 1).text, /怎么接手/, 'brief --chapter 走的不是同一份渲染');

  // 注入：章模式必须比阶段模式短，且不超预算；这是这一层存在的全部理由
  const phaseMode = briefText(v2, []);
  const chapterMode = briefText(v3, []);
  assert.match(chapterMode, new RegExp(`章 1 · 第 1–${cut(6)} 步`), 'brief 没把章摆在最前面');
  assert.match(chapterMode, /第 2 章展开：/, '最后一章没展开');
  assert.ok(!/^  做了：/m.test(chapterMode), '章模式还在逐段复读阶段的「做了」');
  assert.ok(tok(chapterMode) < tok(phaseMode), `章模式没比阶段模式短：${tok(chapterMode)} vs ${tok(phaseMode)}`);
  assert.ok(tok(chapterMode) <= 1800, `章模式 brief 花了 ${tok(chapterMode)} tok，超了 1800 的预算`);
  assert.match(chapterMode, new RegExp(`未成章：第 ${cut(9) + 1}–${M} 步`), '还剩三程没成章却没如实说');

  // 锚点失效：区间内任一段改写 → 整章掉出去，brief 退回阶段模式（不拿旧章话对新内容说）
  const rows = two.rows.map((r) => ({ ...r, hash: 'deadbeef' }));
  writeChapters(dir, { chapters: rows });
  const v4 = readView(dir);
  assert.equal(v4.chapters.length, 0, 'hash 坏了章还留在视图里——旧章话会挂到新内容上');
  assert.equal(v4.meta.chapters.dropped, 2);
  assert.match(briefText(v4, []), /^  做了：/m, '章失效后 brief 没退回阶段模式');

  // CLI：与模块同文；空表/越界都要如实退出
  const sid = synth.ledger.sessionId.slice(0, 8);
  const cli = (args, input) => spawnSync(process.execPath, ['src/cli.mjs', ...args, '--store', `${base}/store`, '--session', sid],
    { cwd: tools, encoding: 'utf8', input });
  writeChapters(dir, { chapters: two.rows });
  const list = cli(['chapters']);
  assert.equal(list.status, 0, `chapters 退出 ${list.status}：${list.stdout}${list.stderr}`);
  assert.match(list.stdout, /章表 · 2 章 \/ 12 阶段/, '章表列表没给章数与阶段数');
  const dig = cli(['chapters', '--digest']);
  assert.equal(dig.status, 0, `chapters --digest 退出 ${dig.status}：${dig.stdout}${dig.stderr}`);
  assert.match(dig.stdout, /候选区间 第 \d+–\d+ 步/, '没写过的那一章没给出候选区间');
  assert.match(dig.stdout, /九格：/, '素材没把九格上限说清');
  const ho = cli(['handoff']);
  assert.equal(ho.status, 0, `handoff 退出 ${ho.status}`);
  assert.equal(ho.stdout, page.text, 'CLI 的 handoff 与模块输出不一致');
  assert.notEqual(cli(['handoff', '9']).status, 0, '不存在的章号在 CLI 里居然退出 0');
  const bc = cli(['brief', '--chapter', '1']);
  assert.equal(bc.status, 0, `brief --chapter 1 退出 ${bc.status}`);
  assert.match(bc.stdout, /怎么接手：/, 'brief --chapter 没给接手指引');
  fs.rmSync(base, { recursive: true, force: true });
});

// 落盘用的账本必须就是这张表要进去的那个账本：活会话每几秒长一段，先校验后重建会把
// 刚写的锚点当场作废（第十八轮写尾段阶段就是这么踩中的——落盘回执说 10 段，brief 只认 9 段）。
const storeDirOf = (root) => {
  const hit = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  assert.equal(hit.length, 1, `${root} 里应该有且只有一个账本，实际 ${hit.length} 个`);
  return `${root}/${hit[0].name}`;
};

test('brief 章太多：先保尾部与协作，再从最旧省章，总预算不超', () => {
  const mk = (n, i) => ({ n, from: i * 8 + 1, to: (i + 1) * 8, fromBlock: i + 2, toBlock: i + 3, phaseSpan: `阶段 ${i + 1}`, short: `第${n}章`, goal: `第${n}章的目的` });
  const ch = Array.from({ length: 60 }, (_, i) => mk(i + 1, i));
  Object.assign(ch[59], { where: '最近一程做了什么', rules: '规则一', tasks: '任务一', walls: '碰壁一', cautions: '注意事项一', arch: '架构一', handoff: '接手一' });
  const v = { meta: { session: 'fixture', segs: 320, cwd: 'D:/proj' }, steps: [], phases: [], mainSteps: 320, chapters: ch };
  const text = briefText(v, [], [{ tag: '规则', text: '协作偏好一' }], { reserve: 500 });
  assert.ok(tok(text) <= 1800, `brief 超预算：${tok(text)}`);
  for (const k of ['走到哪：最近一程做了什么', '协作（这个人在这类事上要的，来自记忆）', '查法：', '第 60 章展开：', '前面 ']) {
    assert.ok(text.includes(k), `尾部/省章提示缺 ${k}`);
  }
  assert.ok(!text.includes('章 1 · 第 1–8 步'), '预算不够时还硬塞最旧的章');
});

test('外挂表落盘前先按当前源重建：会话在 --put 之间长大了也不许当场过期', () => {

  const base = fixture('grow');
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(base, { recursive: true });
  const slice = `${base}/slice.jsonl`;
  // 只取真会话的前 300 行做一次性副本：源日志永远只读，追加只发生在我们自己的副本上
  const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).slice(0, 300);
  fs.writeFileSync(slice, lines.join('\n') + '\n');
  const at = (root) => readView(writeStore(root, build(slice)));
  const v0 = at(`${base}/store`);                       // T0：账本停在旧源上（等价于 index 过一次）
  const tailHash = v0.nodes[v0.nodes.length - 1].hash;
  fs.appendFileSync(slice, JSON.stringify({ type: 'user', uuid: 'grow-1', timestamp: '2099-01-01T00:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: ' appended turn for the growth regression' }] } }) + '\n');
  const v1 = at(`${base}/scratch`);                     // T1：同一条会话又长了一段
  assert.notEqual(v1.nodes[v1.nodes.length - 1].hash, tailHash, '追加一条回合没有改变尾部锚点——这份夹具测不到生长');

  const table = `${base}/phases.json`;
  fs.writeFileSync(table, JSON.stringify({ phases: [{ from: 1, to: v1.mainSteps, short: '起手',
    doing: '先把骨架立起来，后面所有判断都挂在这套账上', state: '骨架已经能出账', effect: '后半程都在这套结构上加层',
    plan: '—', track: '—', refs: [] }] }, null, 1));
  const r = spawnSync(process.execPath, ['src/cli.mjs', 'phases', '--put', table, '--store', `${base}/store`],
    { cwd: tools, encoding: 'utf8' });
  assert.equal(r.status, 0, `phases --put 在长大的会话上退出 ${r.status}：${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /仍新鲜 1 段/, `落盘回执没有核对重建后的新鲜度：${r.stdout}`);
  const after = readView(storeDirOf(`${base}/store`));
  assert.equal(after.meta.phases.dropped, 0, '刚写的阶段在落盘那一刻就过期了——校验用的账本不是表要进去的那个账本');
  assert.equal(after.phases.length, 1);
  assert.equal(after.nodes[after.nodes.length - 1].hash, v1.nodes[v1.nodes.length - 1].hash,
    '--put 之后账本没有按当前源重建，尾部锚点还是旧的');
  fs.rmSync(base, { recursive: true, force: true });
});

// 下面三项钉的是「某一段特定历史会话（六个子代理在第 17 轮扇出、第一次压缩落在第几轮）」
// 的手工核对表。那段会话还在长、内容会变，拿活的当基准就会时红时绿。
// 要恢复只有一条路：把那段 jsonl 冻结成夹具并让 CALIBRATION 指向它。
// 在冻结之前如实跳过，不假红也不假装通过。
const CAL_SKIP = { skip: '需要冻结的校准会话快照：把那段 jsonl 存成夹具并让 CALIBRATION 指向它（详见下方注释）' };
test('calibration session: the six research subagents fired as one fan-out at turn 17', CAL_SKIP, () => {
    const f = facts.fanouts.find((x) => x.turn === 17);
    assert.ok(f, 'turn 17 fan-out missing');
    const agent = f.calls.find((c) => c.name === 'Agent');
    assert.equal(agent.count, 6, `expected 6 parallel Agent calls, got ${agent?.count}`);
    assert.equal(facts.branches.hosts['17']?.length, 6, 'the six branches must hang back on turn 17');
  });
test('calibration session: the first compaction is the one the experiments measured', CAL_SKIP, () => {
    const b = facts.boundaries[0];
    assert.equal(b.preTokens, 170947);
    assert.equal(b.messagesSummarized, 239);
    assert.equal(b.line, 389);
  });
test('calibration session: turn/tool totals and the mass table match the hand-counted answer key', CAL_SKIP, () => {
    assert.equal(facts.boundaries[0].toolCallsBefore, 71, 'pre-boundary tool calls (P16 ground truth)');
    assert.ok(facts.turns.total >= 109);
    const b = facts.boundaries[0];
    const s = b.shareOfRunnerReportedContext;
    assert.equal(s.dialogue, 0.025, 'experiment 1 measured dialogue at 2.5% of pre-compaction context');
    // experiment 1 headlined 51.1% tool round-trips; that number came from a mixed
    // bytes basis. On the rendered-content basis the same region is ~40%, and on the
    // raw-record basis ~85% — the runner's own preTokens sits between them.
    assert.ok(s.toolRoundTrip > 0.35 && s.toolRoundTrip < 0.45, `tool round-trips ${(s.toolRoundTrip * 100).toFixed(1)}% outside the content-basis band`);
    assert.ok(s.thinking > 0.07 && s.thinking < 0.13);
    assert.ok(b.attachmentRecords.share > 0.10 && b.attachmentRecords.share < 0.20);
    // experiment 1 read 34% unattributed on a basis that still added attachment
    // records. They now sit beside the basis (they repeat, so summing them can pass
    // preTokens), which moves the same fact to 34% + their share — not a new number.
    assert.ok(Math.abs(s.unattributed - (0.34 + b.attachmentRecords.share)) < 0.05, 'unattributed drifted from experiment 1 (prompt 34% + attachment records)');
  });

test('rule is the sixth move: the same six gates, the same refusals', () => {
  // The rule cell must not be a self-report box. Pick a short sentence the segment
  // really said, prove it as insight (the known-good path), then prove the identical
  // text as a rule: both must pass. Then break it the five ways the claim gate already
  // names and require the same errors.
  let fit = null;
  for (const s of segments) {
    const m = materials(ledger, s);
    for (const x of m.sentences) {
      if (x.who !== 'assistant' || tok(x.text) > CLAIM_TAKEAWAY_MAX || x.text.length > 200) continue;
      const topic = factTokens(x.text).find((f) => f.length <= 8 && tok(f) <= CLAIM_TOPIC_MAX - 2);
      if (topic) { fit = { s, m, x, topic }; break; }
    }
    if (fit) break;
  }
  assert.ok(fit, 'no short citable sentence carrying a fact — the rule gate has nothing to prove');
  assert.ok(MOVES.includes('rule'), `rule must be one of the moves, got ${MOVES.join(',')}`);
  const { s, m, x, topic } = fit;
  const insight = validateClaim({ move: 'insight', topic, takeaway: x.text, evidence: [x.i] }, m);
  const rule = validateClaim({ move: 'rule', topic, takeaway: x.text, evidence: [x.i] }, m);
  assert.ok(insight.ok, `the known-good insight path broke: ${insight.errors.join(' | ')}`);
  assert.ok(rule.ok, `a rule copied from the segment must pass exactly like an insight: ${rule.errors.join(' | ')}`);
  assert.equal(rule.revision, false);
  for (const [label, bad, re] of [
    ['unresolvable evidence', { ...rule, evidence: [m.sentences.length + 400] }, /解不到本段句子/],
    ['invented file', { ...rule, takeaway: `见 no_such_file_xyz.mjs 里的 42.71%` }, /编造嫌疑/],
    ['handle off the rule', { ...rule, topic: '一个 takeaway 里没有的把手' }, /没有逐字出现/],
    ['no citation', { ...rule, evidence: [] }, /没有引用就不算有据/],
    ['move off the enum', { ...rule, move: 'rules' }, /move 不是六类之一/],
  ]) {
    const r = validateClaim(bad, m);
    assert.ok(!r.ok, `${label} passed the rule gate`);
    assert.ok(r.errors.some((e) => re.test(e)), `${label} refused for the wrong reason: ${r.errors.join(' | ')}`);
  }
  // 落盘面：块上的规则格与 convledger rules 读的是同一条已证增量（不是第二份表）。
  const root = fixture('rule');
  const dir = writeStore(root, built);
  const cf = `${dir}/claims.json`;
  const stored = JSON.parse(fs.readFileSync(cf, 'utf8'));
  stored[s.id] = { basis: 'verified', author: 'selftest', moves: 'rule', text: x.text, topic, evidence: [x.i], segmentHash: checkAnchor(ledger, s).now };
  fs.writeFileSync(cf, JSON.stringify(stored, null, 1));
  const v = readView(dir);
  const at = v.nodes.findIndex((n) => n.id === s.id);
  const step = v.steps.find((q) => q.i0 <= at && at <= q.i1);
  assert.ok(step, `${s.id} sits in no block`);
  const got = step.rules.find((r) => r.id === s.id);
  assert.ok(got, 'a verified rule must land in its block\'s rule cell');
  assert.equal(got.text, x.text);

  const sid = ledger.sessionId.slice(0, 8);
  const json = JSON.parse(execFileSync(process.execPath, ['src/cli.mjs', 'rules', '--store', root, '--session', sid, '--json'], { cwd: tools, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  assert.ok(json.some((r) => r.id === s.id && r.text === x.text && r.part === step.i), 'convledger rules --json must list the same rule');
  const scoped = execFileSync(process.execPath, ['src/cli.mjs', 'rules', '--store', root, '--session', sid, '--part', String(step.i)], { cwd: tools, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.match(scoped, new RegExp(`块 ${step.i} · 1 条`), '--part must scope the list to that block');
  assert.ok(scoped.includes(x.text), 'the scoped list must quote the rule verbatim');
  const none = execFileSync(process.execPath, ['src/cli.mjs', 'rules', '--store', root, '--session', sid, '--part', String(step.i + 1)], { cwd: tools, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.match(none, /这块没有一条过了判据的 rule 增量 —— 不编/, 'an empty block must say so, not borrow a rule from elsewhere');
});

test('a human note and a request are external tables: never verified, and a rebuild keeps them', () => {
  const root = fixture('human');
  const dir = writeStore(root, built);
  for (const f of ['notes.json', 'requests.jsonl']) fs.rmSync(`${dir}/${f}`, { force: true });
  const segs = new Set(segments.map((s) => s.id));
  const seg = segments[Math.floor(segments.length / 3)].id;

  assert.ok(!validateNote({ kind: 'claim', seg, title: 'x' }, segs).ok, 'a note is not a claim: kind is node or branch');
  assert.ok(!validateNote({ kind: 'node', seg: 'S9999', title: 'x' }, segs).ok, 'an anchor outside the ledger must be refused');
  assert.ok(!validateNote({ kind: 'node', seg, title: '   ' }, segs).ok, 'an untitled note is not a note');
  assert.ok(!validateNote({ kind: 'node', seg, title: '字'.repeat(NOTE_TITLE_MAX + 1) }, segs).ok, 'a card-wide title must be refused');
  assert.ok(!validateNote({ kind: 'node', seg, title: 'x', body: '字'.repeat(NOTE_BODY_MAX + 1) }, segs).ok, 'an over-long body must be refused');
  assert.ok(validateNote({ kind: 'branch', seg, after: seg, title: '一条新支' }, segs).ok);

  const a = appendNote(dir, { kind: 'node', seg, title: '人写的标题', body: '补充一句' }, segs);
  const b = appendNote(dir, { kind: 'branch', seg, after: seg, title: '一条新支' }, segs);
  assert.equal(a.note.id, 'N01');
  assert.equal(b.note.id, 'N02');
  for (const n of [a.note, b.note]) {
    assert.equal(n.author, 'human');
    assert.equal(n.basis, 'human-note');
  }
  // 重建（writeStore）只重写 STORE_FILES；notes.json 不在其中，必须原样活着
  writeStore(root, built);
  assert.equal(readNotes(dir).notes.length, 2, 'a rebuild must not drop the human layer');
  const v = readView(dir);
  assert.equal(v.meta.humanNotes, 2);
  assert.ok(v.notes.every((n) => n.basis === 'human-note' && n.author === 'human'));
  const claimsNow = JSON.parse(fs.readFileSync(`${dir}/claims.json`, 'utf8'));
  assert.ok(!Object.values(claimsNow).some((c) => c.basis === 'human-note' || c.author === 'human'), 'a note must never enter the claims table');

  assert.ok(!appendRequest(dir, { text: '' }).ok);
  assert.ok(!appendRequest(dir, { text: 'x', part: 0 }).ok);
  assert.ok(!appendRequest(dir, { text: '字'.repeat(REQUEST_TEXT_MAX + 1) }).ok);
  const r1 = appendRequest(dir, { part: 1, from: seg, text: '按地图里提的做' });
  const r2 = appendRequest(dir, { from: seg, text: '先停在这里' });
  assert.equal(r1.request.id, 'R01');
  assert.equal(r2.request.id, 'R02');
  assert.equal(r1.request.done, false);
  assert.equal(readRequests(dir).rows.length, 2);
  assert.equal(readView(dir).meta.requestsPending, 2);
  const closed = closeRequest(dir, 'R01');
  assert.equal(closed.row.done, true);
  assert.equal(readRequests(dir).rows.find((r) => r.id === 'R01').done, true);
  assert.equal(readRequests(dir).rows.find((r) => r.id === 'R02').done, false);
  assert.equal(readView(dir).meta.requestsPending, 1, 'only the open request counts as pending');
  assert.ok(!closeRequest(dir, 'R99').ok);
});

// Skill 只是说明书：只准点名命令，不准复制输出格式；点名的命令必须真在 CLI 里。
// 改名/删命令时这条先红，比等到某个会话里照着旧说明书敲错命令便宜。
test('skill 正本：只写命令名，且每个命令都真实存在', () => {
  const md = fs.readFileSync(new URL('../skill/convledger/SKILL.md', import.meta.url), 'utf8');
  assert.ok(md.includes('{{TOOL_ROOT}}'), 'SKILL.md 的入口要用 {{TOOL_ROOT}} 占位，换机器才能安装');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const rendered = renderSkill(md, repoRoot);
  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(fm, 'SKILL.md 必须以 YAML frontmatter 开头');
  const name = (fm[1].match(/^name:\s*(.+)$/m) || [])[1]?.trim();
  assert.equal(name, 'convledger', 'name 必须与目录名一致');
  const desc = (fm[1].match(/^description:\s*(.+)$/m) || [])[1]?.trim();
  assert.ok(desc && desc.length <= 1024, 'description 必须是单行且 ≤1024 字符');
  const body = md.slice(fm[0].length);
  assert.ok(body.split('\n').length < 500, 'SKILL.md 正文必须 <500 行');
  assert.ok(!/TODO:/.test(md), 'SKILL.md 里不该留 TODO');

  const cli = fs.readFileSync(new URL('../src/cli.mjs', import.meta.url), 'utf8');
  const known = new Set([...cli.matchAll(/cmd === '([a-z-]+)'/g)].map((x) => x[1]));
  const used = new Set([...body.matchAll(/\bconvledger[ \t]+([a-z][a-z-]*)/g)].map((x) => x[1]));
  assert.ok(used.size >= 6, `SKILL.md 该点名几条真命令，实际只提到 ${used.size} 条`);
  for (const c of used) assert.ok(known.has(c), `SKILL.md 引用了不存在的命令 convledger ${c}——命令改名了就来改说明书`);
  // 反方向也要核：命令实现了、help 里有，说明书的「命令总表」却漏了——读技能的新上下文就永远不知道有它
  for (const c of known) {
    assert.ok(new RegExp(`(convledger ${c}(?![a-z-]))|(\`${c}(?![a-z-]))`).test(body), `SKILL.md 没有点名已实现的命令 convledger ${c}`);
  }

  // Skill 落到四家：Qoder / Claude Code / WorkBuddy / OpenCode（Codex 没有 Skill 落点）
  {
    const inst = fs.readFileSync(new URL('../skill/install.mjs', import.meta.url), 'utf8');
    for (const c of ['qoder', 'claude-code', 'workbuddy', 'opencode']) {
      assert.ok(new RegExp(`client: '${c}'`).test(inst), `Skill 安装表里少了 ${c}`);
    }
  }
  // 各宿主各装一份：装了的必须与渲染后的正本逐字一致（没装的机器不勉强）；
  // 公开仓不假定开发机已装用户级 Skill，这一比对只在私有的开发机自测里做。
});

// 新设备适配：只对真装了的宿主动手；Node 不够就别假装能接 OpenCode。
test('setup 检测：宿主不存在不写配置，缺 node:sqlite 不接 OpenCode', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'convledger-setup-'));
  const qoderConf = path.join(home, 'qoder-conf');
  fs.mkdirSync(qoderConf, { recursive: true });
  // Qoder 的源目录要真在：计数只认"这台机器上有源"，没源就归到投影缓存那一栏
  fs.mkdirSync(path.join(home, '.qoder', 'projects'), { recursive: true });
  const rows = hostRows({
    sessions: [{ runner: 'qoder' }, { runner: 'qoder' }, { runner: 'claude-code' }],
    home: home.replace(/\\/g, '/'),
    env: {
      QODER_CONFIG_DIR: qoderConf.replace(/\\/g, '/'),
      WORKBUDDY_CONFIG_DIR: path.join(home, 'missing-workbuddy').replace(/\\/g, '/'),
      OPENCODE_CONFIG_DIR: path.join(home, 'missing-opencode').replace(/\\/g, '/'),
      CONVLEDGER_OPENCODE_DB: path.join(home, 'missing.db').replace(/\\/g, '/'),
    },
    sqlite: false,
  });
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.qoder.sessions, 2, '同一 runner 的源要计数');
  assert.ok(by.qoder.canSkill && by.qoder.canHook, 'Qoder 配置在，就该装 Skill 与 hooks');
  assert.equal(by['claude-code'].canSkill, false, 'Claude Code 没有 Skill 落点');
  assert.equal(by['claude-code'].canHook, false, 'Claude Code 不接 hooks');
  assert.equal(by['claude-code'].sessions, 0, '源目录不在就不计数');
  assert.equal(by['claude-code'].cached, 1, '没源但列得出会话的，算投影缓存，另栏说清');
  assert.equal(by.workbuddy.canSkill, false, 'WorkBuddy 配置不存在就不写');
  assert.equal(by.opencode.canHook, false, '没有 node:sqlite 时 OpenCode 不装插件');
  fs.rmSync(home, { recursive: true, force: true });
});

// 在线/使用中与「已连接」是两件事：进程认得出、仓库自己的 node 脚本别误报。
test('宿主在线判定：进程名/命令行认得出，仓库自身脚本不误报', () => {
  const win = ['"Qoder.exe","111","Console","1","100 K"', '"opencode.exe","222","Console","1","100 K"', '"node.exe","333","Console","1","100 K"'];
  const m = matchHostProcesses(win);
  assert.equal(m.qoder.any, true);
  assert.equal(m.qoder.interactive, true);
  assert.equal(m.opencode.interactive, true);
  assert.equal(m['claude-code'].any, false);
  assert.equal(m.workbuddy.any, false);
  const ps = ['node /usr/local/bin/claude-code', 'codex --help', 'node /repo/convledger/tool/hooks/opencode.mjs brief'];
  const p = matchHostProcesses(ps);
  assert.equal(p['claude-code'].interactive, true);
  assert.equal(p.codex.interactive, true);
  assert.equal(p.opencode.any, false, '仓库自己的 opencode.mjs hook 不是宿主进程');
  const svc = matchHostProcesses(['D:/npm-global/@opencode/cli/bin/opencode.exe serve --service']);
  assert.equal(svc.opencode.any, true, '后台服务进程要认得出');
  assert.equal(svc.opencode.interactive, false, '只剩后台服务不算界面在线');
});

test('OpenCode 标题读新表 session_v2（2.2.6 迁表后旧表停更）', async () => {
  const base = fixture('oc-title-v2');
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { t.skip('这台机器没有 node:sqlite'); return; }
  const dbFile = `${base}/oc.db`;
  const db = new DatabaseSync(dbFile);
  db.exec('create table session (id text primary key, title text); create table session_v2 (id text primary key, title text);');
  db.prepare('insert into session values (?,?)').run('ses_new', '旧表标题');
  db.prepare('insert into session_v2 values (?,?)').run('ses_new', '新表标题');
  db.close();
  const old = process.env.CONVLEDGER_OPENCODE_DB;
  process.env.CONVLEDGER_OPENCODE_DB = dbFile;
  try { assert.equal(hostTitleFor('ses_new', { runner: 'opencode' }), '新表标题'); }
  finally { if (old === undefined) delete process.env.CONVLEDGER_OPENCODE_DB; else process.env.CONVLEDGER_OPENCODE_DB = old; }
  fs.rmSync(base, { recursive: true, force: true });
});

test('App 看板：会话数用「个」、未建账不写 0 段、手动刷新绕过缓存', () => {
  const js = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.ok(!/\d\s*段会话/.test(js), '会话数别写成「N 段会话」（段是分段，不是会话数）');
  assert.match(js, /未建账/, '未建账会话不能显示成 0 段');
  assert.match(js, /force=1/, '手动刷新要绕过 8 秒缓存');
  assert.match(js, /online === true/, '卡片要显示在线/使用中');
  assert.match(js, /后台服务/, '只剩 serve --service 时要与在线区分');
  const css = fs.readFileSync(new URL('../web/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.alive/, '在线状态要有样式');
});

// 快捷方式那两段 PowerShell 曾经少写一个闭括号：解析不过去 → catch 形同不存在 → 用户只看到
// 退出码 1（或一串 CLIXML）。真跑会动到这台机器的桌面（Desktop 在别的机器上可能被重定向），
// 所以这里只做静态断言：括号成对、try 后不接空语句、错误走 stdout。
test('快捷方式的 PowerShell 正文：括号成对，失败要说人话', () => {
  for (const [name, ps] of [['建', shortcutPs('D:/x/y')], ['撤', removePs()]]) {
    const opens = (ps.match(/\{/g) || []).length;
    const closes = (ps.match(/\}/g) || []).length;
    assert.equal(opens, closes, `${name}快捷方式的 PowerShell 花括号不成对（开 ${opens} / 闭 ${closes}）——PowerShell 会解析失败，catch 也救不回来`);
    assert.ok(!/try\{\s*;/.test(ps), `${name}快捷方式在 try{ 后面直接跟了分号，PowerShell 解析不了`);
    assert.ok(ps.includes('ERR:'), `${name}快捷方式没把错误写到 stdout：真出错时用户只会看到 CLIXML`);
  }
  assert.ok(shortcutPs('D:/x/y').includes('MISS:'), '建快捷方式要能报告"这台机器没有这个目录"');
  assert.ok(shortcutPs('D:/x/y').replace(/\\/g, '/').includes('D:/x/y/tool/open-app.vbs'), '快捷方式指向本仓的 open-app.vbs（应用窗口）');
  assert.ok(shortcutPs('D:/x/y').replace(/\\/g, '/').includes('D:/x/y/tool/web/convledger.ico'), '快捷方式用抠掉白底后的多尺寸图标');
  const cli = fs.readFileSync(new URL('../src/cli.mjs', import.meta.url), 'utf8');
  assert.match(cli, /cmd === 'app'/, 'CLI 要提供 app 命令');
  assert.match(cli, /openAppWindow\(/, 'app 命令要用应用窗口打开');
  // 单实例：应用窗用专用 profile，并且开窗前先找已有窗口聚焦
  const setupSrc = fs.readFileSync(new URL('../src/setup.mjs', import.meta.url), 'utf8');
  assert.match(setupSrc, /--user-data-dir=/, '应用窗要用独立 profile');
  assert.match(setupSrc, /--no-first-run/, '应用窗要关掉浏览器首次启动向导，否则 Edge 会往桌面塞 Microsoft Edge 快捷方式');
  assert.match(setupSrc, /--no-default-browser-check/, '应用窗不要再弹默认浏览器检查');
  assert.match(setupSrc, /focusAppWindow/, '第二次启动要先聚焦已有窗口');
  assert.match(setupSrc, /SetForegroundWindow/, '聚焦要走系统窗口 API');
  assert.match(setupSrc, /app-launch\.lock/, '应用窗要有原子启动锁');
  assert.match(setupSrc, /openSync\(lock, 'wx'\)/, '启动锁必须用 wx 原子创建，竞态只能放行一个入口');
  assert.match(cli, /r\.pending/, '并发启动时 CLI 要说明「正在打开、不再开第二扇」');
  const tray = fs.readFileSync(new URL('../tray.ps1', import.meta.url), 'utf8');
  assert.match(tray, /System\.Windows\.Forms\.NotifyIcon/, '关窗后要缩成系统托盘小图标');
  assert.match(tray, /ContextMenuStrip/, '托盘图标右键要有菜单');
  assert.match(tray, /add_MouseClick/, '左键点托盘图标要能打开');
  assert.match(tray, /restartLabel/, '托盘右键要有重启');
  assert.match(tray, /CloseMainWindow/, '重启要先关旧应用窗');
  assert.match(tray, /ApplicationContext/, '托盘消息循环不能因没有窗体而退出');
  assert.doesNotMatch(tray, /PictureBox|CaptureThumb/, '不要再放桌面浮动预览卡');
  assert.match(setupSrc, /ensureTray/, '应用窗启动时要带起托盘助手');
  assert.doesNotMatch(setupSrc, /MainWindowTitle -match 'convledger'/, '不能用标题兜底认应用窗，普通浏览器页也会带 convledger 标题');
  assert.match(cli, /await fetch\(u/, 'app 命令要先预取看板，再把窗口拉起来');
  const appHtmlSrc = fs.readFileSync(new URL('../web/app.html', import.meta.url), 'utf8');
  const appJsSrc = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.match(appHtmlSrc, /id="boot"/, '看板首帧要有深色启动层，不能白屏');
  assert.match(appJsSrc, /getElementById\('boot'\)/, '数据到达后要撤掉启动层');
  // 后台重算快照时 App 壳转小圈、前台不冻结（PRD-refresh）
  assert.match(appHtmlSrc, /id="updating"/, 'App 壳要有后台更新转圈入口');
  assert.match(appJsSrc, /getElementById\('updating'\)/, 'App 壳要按 refreshing 切换转圈');
  assert.match(appJsSrc, /st\.refreshing \|\| \(sess && sess\.refreshing\)/, 'status 或 sessions 任一在重算都要转圈');
  const appCssSrc = fs.readFileSync(new URL('../web/app.css', import.meta.url), 'utf8');
  assert.match(appCssSrc, /\.updating\[hidden\] \{ display: none/, '转圈隐藏时要真的不占位（author display 会盖掉 hidden）');
  assert.match(appCssSrc, /@keyframes uspin/, 'App 转圈动画要有 keyframes');
});

// 一份"够真"的 Qoder 会话日志：真人回合带 humanInput，工具用 tool_use/tool_result 块，
// 形状照本机真实文件抄（workspace-directories / runtime-config 在最前）。
function qoderFixtureLines(sid, asks, cwd = 'D:/firstrun-proj') {
  const rec = (n, o) => ({ uuid: `u-${n}`, timestamp: new Date(Date.parse('2026-11-03T01:00:00Z') + n * 60000).toISOString(), cwd, sessionId: sid, ...o });
  const rows = [rec(0, { type: 'workspace-directories', directories: [cwd] }), rec(1, { type: 'runtime-config', model: 'dfmodel' })];
  let n = 2;
  for (let i = 0; i < asks; i++) {
    const text = `第 ${i + 1} 个真人请求：把这一段的说明写清楚，并补一条测试。`;
    rows.push(rec(n++, { type: 'user', userType: 'external', origin: { kind: 'human' }, promptId: `p${i}`, humanInput: { text, mode: 'prompt' }, message: { role: 'user', content: [{ type: 'text', text }] } }));
    rows.push(rec(n++, { type: 'assistant', model: 'dfmodel', message: { role: 'assistant', content: [{ type: 'tool_use', id: `c${i}`, name: 'Edit', input: { file_path: `${cwd}/src/mod${i}.mjs`, new_string: 'x'.repeat(600) } }] } }));
    rows.push(rec(n++, { type: 'user', origin: { kind: 'tool-result' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `c${i}`, content: `已写入 ${cwd}/src/mod${i}.mjs`, is_error: false }] } }));
    rows.push(rec(n++, { type: 'assistant', model: 'dfmodel', message: { role: 'assistant', content: [{ type: 'text', text: `第 ${i + 1} 项做完：说明与测试都补上了。` }] } }));
  }
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

// 首跑要"装完就能用"：默认按写入时间建最近 N 个会话，而不是每个来源只冒烟一个。
// 判定只看结果，不碰真机日志：几个假会话文件 + 一个没有源的 runner。
test('buildRecent：按 mtime 取最近 N 个，无源的 runner 一个都不建', () => {
  const base = fixture('build-recent');
  const mk = (id, day, bytes, runner = 'qoder') => {
    const file = `${base}/${id}.jsonl`;
    fs.writeFileSync(file, qoderFixtureLines(id, 4));
    return { runner, sessionId: id, file: file.replace(/\\/g, '/'), bytes, mtime: `2026-11-0${day}T00:00:00Z` };
  };
  const sessions = [mk('aaaabbbb', 3, 30000), mk('ccccdddd', 1, 30000), mk('eeeeffff', 2, 30000), mk('gggghhhh', 4, 30000), mk('no-source!', 5, 30000, 'opencode'), mk('too-small', 5, 1000)];
  const one = buildRecent(`${base}/store`, sessions, 2, new Set(['qoder']));
  assert.equal(one.total, 4, '太小的与不在 runner 白名单里的都不进候选（6 个里只剩 4）');
  assert.equal(one.built, 2, 'n=2 就只建两个');
  assert.equal(one.skippedNoSource, 1, '无源 runner 的会话数要如实报出来');
  assert.equal(one.remaining, 2, '还剩多少必须写在回执里，不然新用户以为全建完了');
  assert.deepEqual(fs.readdirSync(`${base}/store`).sort(), ['aaaabbbb', 'gggghhhh'], '建的是 mtime 最新的那两个');
  const again = buildRecent(`${base}/store`, sessions, 99, new Set(['qoder']));
  assert.deepEqual([again.built, again.existed, again.remaining], [2, 2, 0], '再跑一次：已建的不重复建，剩下的补齐');
  const none = buildRecent(`${base}/store2`, sessions, 99, new Set(['nope']));
  assert.deepEqual([none.total, none.built], [0, 0], 'runner 白名单为空就不该建任何账');
});

// 新用户第一次装：隔离 HOME + 一段真形状的 Qoder 日志，跑一次 setup 就该有账本、有 Skill、
// 有四个事件、有下一步；再跑不重复建；卸载只撤自己写的。快捷方式用 --no-shortcut 避开真桌面
// （那台机器的桌面可能被 OneDrive 重定向，自测不许碰）。
test('新用户首跑：setup 一次就能用，卸载撤得干净', () => {
  const base = fixture('setup-first-run');
  const home = `${base}/home`;
  const qoder = `${home}/.qoder`;
  const sid = 'ffff1111-2222-3333-4444-555566667777';
  const ASKS = 12;
  fs.mkdirSync(`${qoder}/projects/D--firstrun-proj`, { recursive: true });
  fs.writeFileSync(`${qoder}/projects/D--firstrun-proj/${sid}.jsonl`, qoderFixtureLines(sid, ASKS));

  const store = `${base}/store`;
  const env = {
    ...process.env, USERPROFILE: home, HOME: home,
    QODER_CONFIG_DIR: qoder,
    WORKBUDDY_CONFIG_DIR: `${home}/no-workbuddy`,
    OPENCODE_CONFIG_DIR: `${home}/no-opencode`,
    CONVLEDGER_OPENCODE_DB: `${home}/no.db`,
  };
  const run = (args) => spawnSync(process.execPath, ['src/cli.mjs', ...args], { cwd: tools, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });
  const install = run(['setup', '--no-hub', '--no-open', '--no-shortcut', '--store', store]);
  const text = String(install.stdout);
  if (/hub 新起/.test(text)) run(['map', '--stop', '--store', store]); // 首跑真起了 hub 就收掉，不给机器留进程
  assert.equal(install.status, 0, `setup 首跑该 exit 0，实际 ${install.status}：${text.split('\n').slice(-6).join(' / ')}`);
  assert.ok(!text.includes('CLIXML'), '报告里不许出现 PowerShell 的 CLIXML');
  assert.match(text, /✓ Skill 已装：Qoder/, '宿主在装，Skill 就该进去');
  assert.match(text, /✓ hooks 已注册：Qoder/, '宿主在装，hooks 就该挂上');
  assert.match(text, /(启动入口|快捷方式)：跳过/, '--no-shortcut 要照实说跳过，不是报错');
  assert.ok(!/hub 新起/.test(text), '测试环境绝不 spawn 常驻 hub——否则会抢真端口 8765、App 显示空数据');
  assert.match(text, /hub：跳过/, '--no-hub 要照实报告跳过');

  // 默认不起常驻 hub：不带 --hub 就不该 spawn（装完不占后台内存），报告要写明怎么起
  const noHub = run(['setup', '--no-open', '--no-shortcut', '--store', `${base}/store2`]);
  assert.match(String(noHub.stdout), /hub：未启动/, '默认 setup 不该起 hub（要双击图标或 --hub）');
  assert.ok(!/hub 新起/.test(String(noHub.stdout)), '默认 setup 不许 spawn 常驻 hub');

  // 只建真有源的：store 里就只有夹具那一个会话——仓库里的投影缓存不许冒充"这台机器有源"
  assert.deepEqual(fs.readdirSync(store), [sid], '无源 runner 的投影缓存被建成了账');
  const led = JSON.parse(fs.readFileSync(`${store}/${sid}/ledger.json`, 'utf8'));
  assert.equal(led.runner, 'qoder');
  assert.ok(led.segments.length >= 3, `首跑建出来的账本该有内容，实际 ${led.segments.length} 段`);
  const facts = JSON.parse(fs.readFileSync(`${store}/${sid}/facts.json`, 'utf8'));
  assert.equal(facts.turns.human, ASKS, '真人回合要数得出来');

  // 宿主本来没有 settings.json：第一次注册要凭空建出这个文件，四个事件都在
  const settings = JSON.parse(fs.readFileSync(`${qoder}/settings.json`, 'utf8'));
  assert.deepEqual(Object.keys(settings.hooks).sort(), ['PostCompact', 'PreCompact', 'SessionStart', 'Stop'], '压缩边界与收尾四个事件都要挂上');
  const skillFile = `${qoder}/skills/convledger/SKILL.md`;
  const repoRoot = path.resolve(tools, '..').replace(/\\/g, '/');
  assert.equal(fs.readFileSync(skillFile, 'utf8'), renderSkill(fs.readFileSync(new URL('../skill/convledger/SKILL.md', import.meta.url), 'utf8'), repoRoot), '装出去的 Skill 要渲染成真实仓库路径');

  for (const line of ['1. 双击桌面「convledger 地图」打开会话库', '2. 点一行进画布', '3. ', '4. 页面关了怎么回来']) {
    assert.ok(text.includes(line), `就绪报告少了下一步的一条：${line}`);
  }
  const again = run(['setup', '--no-hub', '--no-open', '--no-shortcut', '--store', store]);
  assert.ok(/当前这段已有账本/.test(again.stdout) && !/新建 1/.test(again.stdout), '第二次跑该认出这本已有账，不重复建');

  const un = run(['setup', '--uninstall', '--no-hub', '--no-shortcut', '--store', store]);
  assert.equal(un.status, 0, `卸载该 exit 0：${String(un.stdout).split('\n').slice(-4).join(' / ')}`);
  assert.ok(!fs.existsSync(skillFile), '卸载要撤掉自己写的 Skill');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(`${qoder}/settings.json`, 'utf8')).hooks || {}), [], '卸载要把四个事件都摘掉');
  assert.ok(fs.existsSync(`${store}/${sid}/ledger.json`), '账本是派生数据，卸载不许动它');
});

// 用法行是唯一不需要会话的命令：'--help' 落在 argv[0] 曾被当成命令名，多会话 store 下
// 只会得到「加 --session」的提示——正好把读用法的人挡在门外。
test('帮助免参数：--help 不被当成命令名，也不要求 --session', () => {
  const base = fixture('help');
  fs.rmSync(base, { recursive: true, force: true });
  for (const id of ['aaaaaaaa', 'bbbbbbbb']) {
    fs.mkdirSync(`${base}/store/${id}`, { recursive: true });
    fs.writeFileSync(`${base}/store/${id}/ledger.json`, '{}');
  }
  const run = (args) => spawnSync(process.execPath, ['src/cli.mjs', ...args, '--store', `${base}/store`], { cwd: tools, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  for (const args of [['--help'], ['help'], []]) {
    const r = run(args);
    assert.equal(r.status, 0, `convledger ${args.join(' ') || '(裸)'} 该 exit 0，实际 ${r.status}：${String(r.stdout).split('\n')[0]}`);
    assert.match(r.stdout, /^convledger — 会话结构账本/, '打出来的必须是用法行本体');
    assert.ok(r.stdout.includes('convledger brief'), '用法里要列得出 brief');
  }
  // 反过来：真要读账本时，那道路由提示不能被顺手放宽
  const need = run(['steps']);
  assert.equal(need.status, 1, '两个会话却不给 --session，必须非零退出');
  assert.match(need.stdout, /store 里有 2 个会话，加 --session/);
  // 旗标写在命令前面也得算数：旧 parser 把 '--store' 当成命令名，会悄悄用默认 store
  const first = spawnSync(process.execPath, ['src/cli.mjs', '--store', `${base}/store`, 'steps'], { cwd: tools, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.match(first.stdout, /store 里有 2 个会话/, '--store 写在 steps 前面时被忽略了（报的是默认 store 的会话数）');
  fs.rmSync(base, { recursive: true, force: true });
});

test('首轮走查修的五条：命令打错要说打错、trace 不整份倒流水、带 --session 也认得出项目、块表不结巴', async () => {
  const base = fixture('walkaudit');
  fs.rmSync(base, { recursive: true, force: true });
  for (const id of ['aaaaaaaa', 'bbbbbbbb']) {
    fs.mkdirSync(`${base}/store/${id}`, { recursive: true });
    fs.writeFileSync(`${base}/store/${id}/ledger.json`, JSON.stringify({ sessionId: id }));
  }
  const run = (args, opt = {}) => spawnSync(process.execPath, ['src/cli.mjs', ...args, '--store', `${base}/store`], { cwd: tools, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opt });

  // ① 打错命令名：以前 store 满会话时先撞上「store 里有 237 个会话」，命令名的错根本没被说
  const typo = run(['step']);
  assert.equal(typo.status, 1);
  assert.match(typo.stdout, /^未知命令 step/, '打错命令要先说命令打错了');
  assert.match(typo.stdout, /steps/, '要顺手给出相近的命令');
  assert.ok(!/store 里有/.test(typo.stdout), '未知命令不该报会话数——那是另一件事');

  // ② 审计明细：428 条整份吐出来≈8K tok，默认只给最近 20 条 + 一行取全量的路
  const rows = Array.from({ length: 30 }, (_, i) => JSON.stringify({
    ts: `2026-11-02T00:${String(i % 60).padStart(2, '0')}:00.000Z`, op: 'body', spec: `S${i + 1}`, tokens: 100 + i,
  }));
  fs.writeFileSync(`${base}/store/aaaaaaaa/trace.jsonl`, rows.join('\n') + '\n');
  const tr = JSON.parse(run(['trace', '--session', 'aaaaaaaa']).stdout);
  assert.equal(tr['明细'].length, 21, '默认只列最近 20 条，另加一行说明');
  assert.match(tr['明细'][0], /trace --all/, '说明里要写清怎么拿全量');
  assert.equal(JSON.parse(run(['trace', '--session', 'aaaaaaaa', '--all']).stdout)['明细'].length, 30, '--all 要给全量');

  // ③ 带 --session 时也要交得出 cwd：preferred 分支不补 cwd，越明确反而越认不出项目
  const sid = FILE.split('/').pop().replace(/\.jsonl$/, '');
  const { resolveCurrent } = await import('../src/current.mjs');
  const cur = resolveCurrent({ root: `${tools}/out/store`, cwd: process.cwd(), preferred: sid });
  assert.ok(!cur.error, `真实会话 ${sid.slice(0, 8)} 该认得出来：${cur && cur.error}`);
  assert.ok(cur.cwd, 'resolveCurrent 带 preferred 也要给出 cwd，否则 export/progress 认不出项目');

  // ④ 站在自己仓库里跑 progress，不该被顶一句「store 里有 40 个项目」
  const inRepo = spawnSync(process.execPath, [`${tools}/src/cli.mjs`, 'progress'], { cwd: tools.replace(/\/tool$/, ''), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(inRepo.status, 0, `不带 --project 的 progress 该按 cwd 认项目：${String(inRepo.stdout).split('\n')[0]}`);
  assert.match(inRepo.stdout, /项目 .+（p-[0-9a-f]{12}）/, '回执要写明认到了哪个项目');

  // ⑤ 块表不许把同一句话印两遍：没有综述时远景标题是中景标题的前缀，并排就是结巴
  const st = spawnSync(process.execPath, [`${tools}/src/cli.mjs`, 'steps', '--session', sid], { cwd: tools, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(st.status, 0, `steps 该出块表：${String(st.stdout).split('\n')[0]}`);
  const stutter = String(st.stdout).split('\n').filter((l) => {
    const cell = String(l.split(' | ')[1] ?? '').split(' ⇒')[0];
    const bar = cell.indexOf('｜');
    if (bar < 0) return false;
    const a = cell.slice(0, bar); const b = cell.slice(bar + 1);
    return !a || !b || b.startsWith(a);
  });
  assert.deepEqual(stutter, [], '块表里出现了「也就是说｜也就是说」这种重复标题');
  fs.rmSync(base, { recursive: true, force: true });
});

test('压缩边界推送：hook 服务所有项目的会话、注入形状合法、同文去重、内容一变就再注', () => {
  const base = fixture('hook');
  fs.rmSync(base, { recursive: true, force: true });
  const SID = 'hookfixture0000000';
  const src = `${base}/projects/fixture/${SID}.jsonl`;
  fs.mkdirSync(`${base}/projects/fixture`, { recursive: true });
  const repo = tools.replace(/\/tool$/, '');
  // 源日志永远只读：夹具是我们自己拷的一次性副本。
  // cwd 要落成这台机器上的路径：借读兜底按 cwd 整串相等找「本项目」，
  // 原样留着 Windows 的 D:/... 在 Linux 上永远匹配不到。
  const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).slice(0, 240).map((line) => {
    const o = JSON.parse(line);
    if (typeof o.cwd === 'string') o.cwd = repo;
    if (Array.isArray(o.directories)) o.directories = o.directories.map(() => repo);
    return JSON.stringify(o);
  });
  fs.writeFileSync(src, lines.join('\n') + '\n');
  // WORKBUDDY_CONFIG_DIR 也关进夹具：体检命令会同时读两个宿主的 settings.json，
  // 不隔离就会把本机真实注册读进断言（而这台机器上它确实已经注册了）
  const env = { ...process.env, QODER_CONFIG_DIR: base, WORKBUDDY_CONFIG_DIR: `${base}/nowb`, CONVLEDGER_HOOK_STORE: `${base}/store`,
    CONVLEDGER_HOOK_LOG: `${base}/log.jsonl` };
  const here = { cwd: repo, session_id: SID };
  const hook = (obj, extra, args = [], moreEnv = {}) => spawnSync(process.execPath, ['hooks/ledger-brief.mjs', ...args],
    { cwd: tools, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...env, ...moreEnv }, input: typeof obj === 'string' ? obj : JSON.stringify({ ...here, ...obj, ...extra }) });
  const log = () => (fs.existsSync(`${base}/log.jsonl`) ? fs.readFileSync(`${base}/log.jsonl`, 'utf8') : '');
  const rows = () => log().trim().split('\n').map((l) => JSON.parse(l));

  // fail-open：坏 stdin、本项目一份账本都没有——一律 exit 0 且一个字都不注
  for (const [label, r] of [
    ['非法 stdin', hook('not json')],
    ['本项目一份账本都没有', hook({ hook_event_name: 'PostCompact', session_id: 'ghostsession0000' },
      {}, [], { CONVLEDGER_HOOK_STORE: `${base}/noshop` })],
  ]) {
    assert.equal(r.status, 0, `${label}：hook 不许非零退出（会把诊断泼进宿主）：${r.stderr}`);
    assert.equal(r.stdout, '', `${label}：必须不注入任何文本，绝不能编一句「我记得」`);
  }
  assert.match(log(), /bad-stdin/, '坏 stdin 那条没有留痕');

  // 配置挂在用户级，钩子管的是所有项目的会话：cwd 不在本仓也照样按它自己的 transcript 建账、
  // 注入自己的 brief——不按 cwd 划界，也就没有「外项目一律闭嘴」这条路。
  const OTHER = 'otherproj00000001';
  fs.mkdirSync(`${base}/projects/otherproj`, { recursive: true });
  fs.writeFileSync(`${base}/projects/otherproj/${OTHER}.jsonl`,
    fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).slice(0, 240).join('\n') + '\n');
  const otherStore = `${base}/store-other`;
  const away = hook({ hook_event_name: 'SessionStart', session_id: OTHER, cwd: 'D:/somewhere/else' },
    {}, [], { CONVLEDGER_HOOK_STORE: otherStore });
  assert.equal(away.status, 0, `外项目会话退出 ${away.status}：${away.stderr}`);
  const ctxAway = JSON.parse(away.stdout).hookSpecificOutput.additionalContext;
  assert.ok(ctxAway.startsWith('[convledger · 工具派生，不是模型记忆] 会话启动自动续上'),
    '外项目会话没拿到自己的 brief——按 cwd 划界的闸门又回来了');
  assert.doesNotMatch(ctxAway, /不是你当前会话/, '外项目会话有自己那份账本，不该被当成借读');
  assert.equal(JSON.parse(fs.readFileSync(`${otherStore}/${OTHER}/ledger.json`, 'utf8')).sessionId, OTHER,
    '外项目会话的账本不是按它自己的 transcript 建的');
  const awayRow = rows().filter((r) => r.session === OTHER).pop();
  assert.equal(awayRow.action, 'inject');
  assert.equal(awayRow.foreign, false, '外项目会话的注入被标成了借读');

  // 首次注入：形状必须是宿主收得下的，正文必须逐字来自 brief
  const first = hook({ hook_event_name: 'PostCompact' });
  assert.equal(first.status, 0, `首次注入退出 ${first.status}：${first.stderr}`);
  const j = JSON.parse(first.stdout);
  assert.equal(j.hookSpecificOutput.hookEventName, 'PostCompact', 'hookEventName 缺或对不上，宿主直接拒收');
  const ctx = j.hookSpecificOutput.additionalContext;
  assert.ok(ctx.startsWith('[convledger · 工具派生，不是模型记忆]'), '注入文本没标来源，会被读成模型自己的记忆');
  assert.match(ctx, /查法：brief --phase n/, '注入里没有下一跳');
  assert.match(ctx, /注入于 .*账本新鲜度只担保那一刻/, '注入里没有新鲜度边界');
  assert.ok(tok(ctx) <= 2000, `注入 ${tok(ctx)} tok 超预算`);
  assert.ok(ctx.includes(SID.slice(0, 8)) || /账本 /.test(ctx), '注入里没有账本头行');

  // 同一次压缩宿主会连发 PostCompact 与 SessionStart(source=compact)（10:07:59 实测两个都来），
  // 而这两个事件里哪个的 additionalContext 真进上下文并不确定——所以事件各占一个去重槽，
  // 不许前一个把后一个挡掉（那就是 10:07:59.904 那次 skip 把唯一可能生效的注入静音）。
  const also = hook({ hook_event_name: 'SessionStart' });
  assert.notEqual(also.stdout, '', 'SessionStart 被 PostCompact 的同文去重挡了——新会话/压缩后的第二跳一个字都拿不到');

  // 同一事件同文重放必须被去重（同一段会话反复 resume 不该每次白吃 1k token）
  // 注意用的是非压缩边界的 SessionStart：PostCompact 每次都发生在新上下文里，不吃这条去重。
  const again = hook({ hook_event_name: 'SessionStart' });
  assert.equal(again.stdout, '', '同一份 brief 在同一事件上注入了第二次，白吃 1k token');
  assert.match(log(), /与上次注入同文，去重/);

  // 压缩边界＝新上下文：SessionStart(source=compact) 即使与压缩前那次启动的 brief 同文也要重注。
  // 10-28 00:20:54 fork 实测：同文去重让宿主只能把压缩前的旧 SessionStart 输出贴进新上下文，
  // 模型回读的「注入于」是压缩前时刻——投递没死，但拿到的是一份旧账。
  const replay = hook({ hook_event_name: 'SessionStart', source: 'compact' });
  assert.notEqual(replay.stdout, '', 'SessionStart(source=compact) 被压缩前的同文去重挡了——压缩后只能吃旧缓存');
  const rowCompact = rows().filter((r) => r.source === 'compact').pop();
  assert.equal(rowCompact.freshContext, true, '留痕没标 freshContext：事后分不清这次放行是不是压缩边界');

  // 内容一变就得再来一次：去重不能变成消音开关
  appendRequest(`${base}/store/${SID}`, { text: '把压缩边界推送的验收数字补进 RESULT' });
  const third = hook({ hook_event_name: 'PostCompact' });
  assert.notEqual(third.stdout, '', '待办请求到了却没再注入——去重把推送闷死了');
  const ctx3 = JSON.parse(third.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx3, /请求 R01 · 把压缩边界推送的验收数字补进 RESULT/, '再注入的内容里没有那条待办');
  const st = JSON.parse(fs.readFileSync(`${base}/store/${SID}/hook.json`, 'utf8'));
  const keyPost = `manual PostCompact ${SID}`;
  assert.equal(st.byKey[keyPost].count, 2, `compaction 事件应注入两次（首次＋内容变化），实际 ${JSON.stringify(st.byKey)}`);
  assert.equal(st.byKey[`manual SessionStart ${SID}`].count, 2, 'SessionStart 应自己占一个去重槽（首次＋压缩边界放行）');
  assert.ok(st.byKey[`manual SessionStart ${SID}`].skipped >= 1, '同文去重那次没有留痕');

  // 新会话在这个项目里还没有账本：不许闭嘴，要递上"上一段会话"的账本——但必须写明不是你的
  const borrowed = hook({ hook_event_name: 'SessionStart', session_id: 'brandnew00000000' });
  assert.notEqual(borrowed.stdout, '', '全新会话拿不到任何推送——它最需要的那句「之前做到哪了」没人告诉它');
  const ctxNew = JSON.parse(borrowed.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctxNew, /本项目上一段会话/, '借来的账本没标明是借的，新上下文会把别人的第 N 步当成自己的');
  assert.match(ctxNew, /不是你当前会话/, '借来的账本没写明归属边界');
  assert.doesNotMatch(ctxNew.slice(0, 120), /压缩后自动续上/, '新会话被说成是压缩续跑——事件与说法要能对得上');
  const newRow = rows().filter((r) => r.session === 'brandnew00000000').pop();
  assert.equal(newRow.foreign, true, '留痕没标 foreign：借账本这件事事后查不出来');
  assert.equal(newRow.ledger, SID.slice(0, 8), '留痕没写实际读的是哪份账本');

  // PreCompact：只按当前源重建，不注入（注进去会被这次压缩吃掉）
  fs.appendFileSync(src, JSON.stringify({ type: 'user', uuid: 'hx-grow', timestamp: '2099-01-01T00:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: ' appended turn before compaction' }] } }) + '\n');
  const pre = hook({ hook_event_name: 'PreCompact' });
  assert.equal(pre.stdout, '', 'PreCompact 不该注入——马上要被这次压缩摘要掉');
  const grown = readView(`${base}/store/${SID}`);
  const fresh = readView(writeStore(`${base}/scratch`, build(src)));
  assert.equal(grown.nodes[grown.nodes.length - 1].hash, fresh.nodes[fresh.nodes.length - 1].hash,
    'PreCompact 没有按当前源重建：压缩那一刻账本还是旧的');

  // 旁路封死：hook 只能读表，不许现写模型文字
  const code = fs.readFileSync(new URL('../hooks/ledger-brief.mjs', import.meta.url), 'utf8');
  for (const banned of ['writePhases', 'writeSummaries', 'validatePhases', 'validateClaim', 'fetch(', 'https://']) {
    assert.ok(!code.includes(banned), `hook 里出现了 ${banned}：推送层一旦会写表或调模型，就绕过了闸门`);
  }

  // 溯源：上面这些留痕全是我们手工喂 stdin 跑出来的，每一行都得写明 origin
  for (const l of log().trim().split('\n')) {
    const row = JSON.parse(l);
    assert.equal(row.origin, 'manual', `留痕行没标来源（或把自己标成了宿主）：${l}`);
  }
  // 注册脚本的命令行就是来源的唯一凭据：宿主只会按 settings.json 里那行跑
  const inst = spawnSync(process.execPath, ['hooks/install.mjs'], { cwd: tools, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });
  assert.equal(inst.status, 0, `install.mjs 退出 ${inst.status}：${inst.stdout}${inst.stderr}`);
  const reg = JSON.parse(fs.readFileSync(`${base}/settings.json`, 'utf8'));
  assert.deepEqual((reg.hooks.PostCompact[0].hooks[0].args || []).slice(1), ['--origin', 'host'],
    '注册的命令行没带溯源标记——手工跑的行就能冒充宿主触发');

  // 体检命令免 --session：多会话 store 下也要能单独回答「通路活着吗」
  const diag = spawnSync(process.execPath, ['src/cli.mjs', 'hooks', '--store', `${base}/store`], { cwd: tools, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });
  assert.equal(diag.status, 0, `convledger hooks 退出 ${diag.status}：${diag.stdout}${diag.stderr}`);
  for (const line of ['注册：', '留痕：', '压缩对照：', '注入：', '投递：', '判定：']) assert.ok(diag.stdout.includes(line), `体检输出缺行「${line}」：${diag.stdout}`);
  assert.match(diag.stdout, /PostCompact → convledger-brief/, `体检没把注册的挂上状态打出来：${diag.stdout}`);
  // 这一条是本测试的诚实底线：自跑几次不算实测，判定必须仍写「还没取证」
  assert.match(diag.stdout, /判定：压缩后推送还没取证/);
  assert.match(diag.stdout, /投递：未取证/, '一次真发注入都没有时，投递那行不能预先断言"通了"');
  assert.doesNotMatch(diag.stdout, /已实测通/, '手工喂 stdin 的留痕把判定写成了「实测通」——没验的不能写成验过');

  // 来源之间不许互相消音：manual 侧有去重状态时，host 那一次必须照样注入
  // （实测踩过：09:27 一次自跑写了 lastHash，09:43 宿主真发 PostCompact 被同一个 hash 挡掉）
  const asHost = hook({ hook_event_name: 'PostCompact', trigger: 'auto', compact_summary: 'x'.repeat(500) }, {}, ['--origin', 'host']);
  assert.notEqual(asHost.stdout, '', 'manual 的去重状态闷死了宿主的真推送——新上下文一个字都拿不到');
  const st2 = JSON.parse(fs.readFileSync(`${base}/store/${SID}/hook.json`, 'utf8'));
  assert.equal(st2.byKey[`host PostCompact ${SID}`].count, 1, `host 侧应自己记一次注入：${JSON.stringify(st2.byKey)}`);
  assert.ok(fs.existsSync(`${tools}/out/hook-inputs/PostCompact-host.json`),
    '载荷取证没按来源分文件：夹具跑一次就会把宿主真发过的载荷覆盖掉');
  const hostRow = log().trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.origin === 'host').pop();
  assert.equal(hostRow.trigger, 'auto', '压缩事件的留痕没记 trigger——"这次压缩是自动的"就没了凭据');
  assert.equal(hostRow.summaryChars, 500, '留痕没记摘要字数');
  // 真有一条宿主发的注入，判定要从「还没取证」翻到「事件已实测、注入已留痕」——
  // 但「注进去的文本到了模型上下文」是另一件事，只有 PostCompact 留痕时投递那行必须仍写未取证。
  const diag2 = spawnSync(process.execPath, ['src/cli.mjs', 'hooks', '--store', `${base}/store`], { cwd: tools, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });
  assert.match(diag2.stdout, /判定：压缩后事件已实测发出、我们也注入过 1 次/, `宿主留痕到位后判定没翻过来：${diag2.stdout}`);
  assert.match(diag2.stdout, /投递：未取证/, '只有 PostCompact 的注入留痕就把投递写成通了——脚本返回不等于模型看见');
  assert.match(diag2.stdout, /注入：\d+ 次（manual=\d+ host=1）/, `注入行没分来源：${diag2.stdout}`);
  fs.rmSync(base, { recursive: true, force: true });
});

test('第三个 runner：WorkBuddy 的记录形状靠一份规范化视图接进来（夹具，不碰真机日志）', () => {
  const base = fixture('wb');
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(base, { recursive: true });
  const SID = 'wb-fixture-0001';
  const file = `${base}/${SID}.jsonl`;
  const cwd = 'D:/fixture/proj';
  // 形状照 PRD-workbuddy §一抄：正文在顶层 content、工具是独立记录、时间戳毫秒、
  // 人话包在 <user_query> 里、压缩是 user 记录里的 <cb_summary>。
  const rec = (n, o) => ({ id: `${SID}-${n}`, timestamp: 1760000000000 + n * 1000, cwd, ...o });
  const text = (t) => [{ type: 'input_text', text: t }];
  const out = (t) => [{ type: 'output_text', text: t }];
  const lines = [
    rec(0, { type: 'session-meta', sessionId: SID, meta: {} }),
    rec(1, { type: 'message', role: 'user', content: text(`<system-reminder data-role="user-context">\n<craft_mode>\nSOUL-SECRET ${'x'.repeat(300)}\n</craft_mode>\n</system-reminder>\n<user_query>把夹具变成账本</user_query>`) }),
    rec(2, { type: 'message', role: 'assistant', status: 'complete', providerData: { model: 'fixture-model' }, content: out('先读一个文件看看。') }),
    rec(3, { type: 'reasoning', rawContent: [{ type: 'thinking', text: '内部推理不该进正文' }], status: 'complete', providerData: { model: 'fixture-model' } }),
    rec(4, { type: 'function_call', name: 'Read', callId: 'call-1', arguments: '{"file_path":"src/alpha.mjs"}', providerData: { model: 'fixture-model' } }),
    rec(5, { type: 'function_call_result', name: 'Read', callId: 'call-1', status: 'completed', output: { type: 'text', text: 'export const ALPHA = 1;\n// src/alpha.mjs:7' } }),
    rec(6, { type: 'function_call', name: 'Grep', callId: 'call-2', arguments: '{"pattern":"ALPHA","path":"src"}' }),
    rec(7, { type: 'function_call_result', name: 'Grep', callId: 'call-2', status: 'incomplete', output: { type: 'text', text: 'Error: 权限不足' } }),
    // 注入记录：没有人话信封，不算 human、不开新段
    rec(8, { type: 'message', role: 'user', content: text('<system-reminder data-role="error-recovery">工具挂了，自动重试</system-reminder>') }),
    rec(9, { type: 'message', role: 'user', content: text('<user_query>结果怎么样了</user_query>') }),
    // 155/5888 条助手记录装的是 runner 自己的状态行（无 model、skipRun）——不是模型正文
    rec(10, { type: 'message', role: 'assistant', status: 'incomplete', providerData: { skipRun: true, error: { message: 'Interrupted by user' } }, content: out('Interrupted by user') }),
    rec(11, { type: 'message', role: 'user', content: text('<cb_summary>\nSummary of the conversation so far:\n<previous_user_message><user_query>把夹具变成账本</user_query></previous_user_message>\n</cb_summary>') }),
    rec(12, { type: 'message', role: 'user', content: text('<user_query>压缩后继续</user_query>') }),
    rec(13, { type: 'message', role: 'assistant', status: 'complete', providerData: { model: 'fixture-model' }, content: out('收到，接着做。') }),
    rec(14, { type: 'ai-title', title: '夹具' }),
    rec(15, { type: 'file-history-snapshot', messageId: `${SID}-2`, isSnapshotUpdate: false, snapshot: {} }),
  ];
  fs.writeFileSync(file, lines.map((r) => JSON.stringify(r)).join('\n') + '\n');

  // 三个适配器判别互斥：workbuddy 认领，另外两个不许抢
  const sample = readJsonl(file);
  assert.equal(detectAdapter(sample)?.id, 'workbuddy', `夹具没被 workbuddy 认领：${detectAdapter(sample)?.id}`);
  for (const a of ADAPTERS.filter((x) => x.id !== 'workbuddy')) {
    assert.ok(!a.detect(sample.slice(0, 40)), `${a.id} 把 workbuddy 夹具认成了自己的`);
  }

  const b = build(file, { storeRoot: `${base}/store` });
  const L = b.ledger;
  assert.equal(L.runner, 'workbuddy');
  // 规范化是一一映射：行号就是锚点，映射不许挪行
  assert.equal(L.sourceRecords, lines.length, '规范化后记录数与源行数不等——映射挪了行，锚点就全歪了');

  // 人话只认 <user_query>：u1 / u3 / 压缩后那句 = 3；注入 1 条不算；cb_summary 单算
  assert.equal(b.facts.turns.human, 3, `人话计数错了：${JSON.stringify(b.facts.turns)}`);
  assert.equal(b.facts.turns['compact-summary'], 1, `压缩回合没单算一档：${JSON.stringify(b.facts.turns)}`);
  assert.equal(b.facts.turns.total, 7, `回合数错了（5 条 user 记录 + 2 条工具回执）：${b.facts.turns.total}`);
  assert.equal(L.segments.filter((s) => s.kind === 'boundary').length, 1, 'cb_summary 没开 boundary 段');
  assert.equal(b.facts.boundaries.length, 1, '压缩事件没进 facts');
  assert.equal(b.facts.boundaries[0].trigger, 'compact');
  assert.equal(b.facts.boundaries[0].preTokens, null, 'WorkBuddy 不记 token 数，边界必须留 null——不许猜个 0 顶上去');
  assert.equal(b.facts.boundaries[0].compactionRatio, null);

  // 工具按 callId 配对；status=incomplete 的真实回执记成错误
  assert.equal(b.facts.toolCalls.total, 2, `工具调用没数全：${b.facts.toolCalls.total}`);
  assert.equal(b.facts.toolCalls.errors.length, 1, 'status=incomplete 的回执没记成错误');
  assert.equal(b.facts.toolCalls.errors[0].name, 'Grep', `错误挂错了工具：${JSON.stringify(b.facts.toolCalls.errors[0])}`);
  assert.match(b.facts.toolCalls.errors[0].head, /权限不足/, '错误回执的正文没带上');

  // runner 状态行不许变成助手正文，也不许当块名
  assert.ok(!L.segments.some((s) => /Interrupted by user/.test(s.head ?? '')), 'runner 的状态行进了块名');
  assert.ok(!Object.values(b.cards).some((c) => /Interrupted by user/.test(c)), 'runner 的状态行进了路由卡');

  // 正文回源：人话逐字、注入信封不进、回执可读
  writeStore(`${base}/store`, b);
  const S01 = resolveSegments(L, 'S01');
  const body = renderBody(L, S01, {}).text;
  assert.match(body, /把夹具变成账本/, '正文里读不到人话原句');
  assert.ok(!body.includes('SOUL-SECRET'), '注入信封被当正文渲染出来了');
  assert.ok(body.includes('export const ALPHA'), '工具回执没进正文');
  const hit = searchLedger(L, '夹具变成账本');
  assert.ok(hit.hits.length >= 1, 'find 找不到人话原句');
  // 断句素材也走同一份视图：规范化漏一处，这里就是空数组
  const sent = sentencesOf(L, L.segments[0]).sentences;
  assert.ok(sent.some((s) => s.who === 'user' && s.text.includes('把夹具变成账本')), 'prove 的句子池里没有用户原话');
  assert.ok(sent.some((s) => s.who === 'result' && s.text.includes('src/alpha.mjs')), 'prove 的句子池里没有带回执地址的行');

  // 锚点、元数据
  for (const s of L.segments) assert.ok(checkAnchor(L, s).ok, `${s.id} 锚点对不上`);
  assert.equal(b.facts.session.cwd, cwd, 'cwd 没取到');
  assert.deepEqual(b.facts.session.models, ['fixture-model'], `models 没取到：${JSON.stringify(b.facts.session.models)}`);
  assert.ok(!b.facts.session.models.length || b.facts.session.models.includes(b.facts.session.model), '当前模型必须来自模型列表');

  // 最小视图能出：页面/页面 API 只吃这份 payload
  const v = readView(`${base}/store/${SID}`);
  assert.equal(v.meta.runner, 'workbuddy');
  assert.ok(v.steps.length >= 2, `压缩点没把账本切成两块：${v.steps.length}`);
  fs.rmSync(base, { recursive: true, force: true });
});

test('第四个 runner：OpenCode 的 SQLite 先投影成 append-only JSONL，再走同一条管线', async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { t.skip('这台机器的 Node 没有 node:sqlite（≥22.5 才有）'); return; }
  const { syncOpencodeProjections, resetOpencodeMemo } = await import('../src/opencode.mjs');
  const base = fixture('opencode');
  const dbFile = `${base}/opencode.db`;
  const db = new DatabaseSync(dbFile);
  db.exec(`
    create table session (id text primary key, slug text, title text, directory text, model text, agent text, time_created integer, time_updated integer);
    create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text);
    create table part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);
  `);
  const SID = 'ses_test0001';
  const ins = (sql, ...args) => db.prepare(sql).run(...args);
  ins('insert into session values (?,?,?,?,?,?,?,?)', SID, 'calm-test', '测试会话', 'D:/work/demo', '{"id":"m1"}', 'build', 1000, 4000);
  ins('insert into message values (?,?,?,?,?)', 'msg_1', SID, 1000, 1000, JSON.stringify({ role: 'user' }));
  ins('insert into message values (?,?,?,?,?)', 'msg_2', SID, 2000, 3000, JSON.stringify({ role: 'assistant', modelID: 'm1' }));
  ins('insert into message values (?,?,?,?,?)', 'msg_3', SID, 3500, 3500, JSON.stringify({ role: 'user' }));
  ins('insert into part values (?,?,?,?,?,?)', 'prt_1', 'msg_1', SID, 1000, 1000, JSON.stringify({ type: 'text', text: '把窗口开大一点' }));
  ins('insert into part values (?,?,?,?,?,?)', 'prt_2', 'msg_2', SID, 2100, 2100, JSON.stringify({ type: 'text', text: '先看命令行参数' }));
  ins('insert into part values (?,?,?,?,?,?)', 'prt_3', 'msg_2', SID, 2200, 2400, JSON.stringify({ type: 'tool', tool: 'bash', callID: 'call_abc', state: { status: 'completed', input: { command: 'node --version' }, output: 'v24.18.0' } }));
  ins('insert into part values (?,?,?,?,?,?)', 'prt_4', 'msg_2', SID, 2500, 2500, JSON.stringify({ type: 'compaction' }));
  ins('insert into part values (?,?,?,?,?,?)', 'prt_5', 'msg_3', SID, 3500, 3500, JSON.stringify({ type: 'text', text: '继续' }));
  db.close();

  resetOpencodeMemo();
  const out = `${base}/proj`;
  const r1 = syncOpencodeProjections({ dbFile, outDir: out, force: true });
  assert.equal(r1.ok, true, `投影失败：${r1.error}`);
  const file = `${out}/${SID}/${SID}.jsonl`;
  assert.ok(fs.existsSync(file), '没写出投影文件');
  const text1 = fs.readFileSync(file, 'utf8');
  const lines = text1.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].opencode, true, '投影第一行必须带 runner 身份');
  assert.equal(lines[0].cwd, 'D:/work/demo');
  assert.ok(lines.some((l) => l.type === 'assistant' && l.message.content.some((b) => b.type === 'tool_use' && b.id === 'call_abc')), '工具调用没投影出来');
  assert.ok(lines.some((l) => l.type === 'user' && l.message.content.some((b) => b.type === 'tool_result' && b.tool_use_id === 'call_abc')), '工具结果没合成回投影');
  assert.ok(lines.some((l) => l.isCompactSummary), '压缩 part 没成为边界');

  // 不变量：认得出第四种 runner，工具调用与回执按 callID 配上，压缩点切块
  const adapter = detectAdapter(lines.slice(0, 5));
  assert.equal(adapter?.id, 'opencode', `detect 认成了 ${adapter?.id}`);
  fs.mkdirSync(`${base}/store`, { recursive: true });
  const built1 = build(file);
  const dir1 = writeStore(`${base}/store`, built1);
  assert.equal(built1.ledger.runner, 'opencode');
  const v1 = readView(dir1);
  assert.ok(v1.steps.length >= 2, `压缩点没把账本切开：${v1.steps.length}`);
  const toolNode = v1.nodes.find((n) => n.tools && JSON.stringify(n.tools).includes('bash'));
  assert.ok(toolNode, '看不到 bash 调用');
  assert.ok(v1.meta.calls >= 1, '工具调用计数为 0');

  // 追加式增长：新消息进 DB 后重新投影，前缀字节必须一字不差
  const db2 = new DatabaseSync(dbFile);
  db2.prepare('insert into message values (?,?,?,?,?)').run('msg_4', SID, 5000, 5000, JSON.stringify({ role: 'user' }));
  db2.prepare('insert into part values (?,?,?,?,?,?)').run('prt_6', 'msg_4', SID, 5000, 5000, JSON.stringify({ type: 'text', text: '再来一步' }));
  db2.prepare('update session set time_updated=? where id=?').run(5000, SID);
  db2.close();
  resetOpencodeMemo();
  const r2 = syncOpencodeProjections({ dbFile, outDir: out, force: true });
  assert.equal(r2.ok, true, `二次投影失败：${r2.error}`);
  const text2 = fs.readFileSync(file, 'utf8');
  assert.ok(text2.startsWith(text1), '追加投影改了旧行——锚点会整段错位');
  assert.ok(text2.length > text1.length, '新消息没进投影');

  // hub 用的单会话入口：变了写一次，没变一次 IO 都不做
  const { syncOpencodeSession } = await import('../src/opencode.mjs');
  const r3 = syncOpencodeSession(SID, { dbFile, outDir: out });
  assert.equal(r3.ok, true, r3.error);
  assert.equal(r3.written, 1, '首次单会话同步应当写一次');
  const r4 = syncOpencodeSession(SID, { dbFile, outDir: out });
  assert.equal(r4.written, 0, '源没变却重写了投影');

  // OpenCode 的 hook 入口：brief 能出字；没有任务表也要派收尾（首次建表）并带哨兵；内部会话跳过
  process.env.CONVLEDGER_HOOK_STORE = `${base}/store`;
  process.env.CONVLEDGER_OPENCODE_OUT = out;
  process.env.CONVLEDGER_HOOK_LOG = `${base}/hook-log.jsonl`;
  const hooks = await import(`../hooks/opencode.mjs?t=${Date.now()}`);
  const brief = hooks.briefForOpencode({ sid: SID });
  assert.ok(!brief.skip && /账本/.test(brief.text), `brief 没出字：${brief.skip || brief.text}`);
  const close = hooks.closeoutForOpencode({ sid: SID });
  assert.ok(!close.skip, `有新素材与真人消息就该派收尾：${close.skip || '没派'}`);
  assert.match(close.text, /^\[convledger-internal\]/, '派给后台会话的指令必须带哨兵，防自我增殖');
  assert.match(close.text, /localKey/, '项目还没有任务表时要提示先建首批任务');
  assert.match(close.text, /有效素材单元/, 'OpenCode 收尾也要报过滤后的素材单元');
  assert.doesNotMatch(close.text, /条新记录/, 'OpenCode 也不能把原始行数叫成新记录');
  assert.equal(hooks.closeoutForOpencode({ sid: SID }).skip, 'already-prompted', '同一人回合只能派一次');
  const { addInternal } = await import('../src/internal.mjs');
  addInternal(`${base}/store`, SID);
  assert.equal(hooks.closeoutForOpencode({ sid: SID }).skip, 'internal-session', '后台会话本身不能再被派收尾');
  delete process.env.CONVLEDGER_HOOK_STORE;
  delete process.env.CONVLEDGER_OPENCODE_OUT;
  delete process.env.CONVLEDGER_HOOK_LOG;
  fs.rmSync(base, { recursive: true, force: true });
});

// OpenCode 2.x 只认 V2 插件形状：旧命名导出 + experimental.session.compacting 不会被激活（真机探过）。
test('OpenCode 插件按 V2 形状：Plugin.define + session.hook("compaction") + event.subscribe', () => {
  const plugin = fs.readFileSync(new URL('../hooks/opencode-plugin.js', import.meta.url), 'utf8');
  assert.match(plugin, /import \{ Plugin \} from '@opencode\/plugin'/, 'V2 插件要从 @opencode/plugin 拿 Plugin');
  assert.match(plugin, /Plugin\.define\(/, 'V2 插件必须 default export Plugin.define(...)');
  assert.match(plugin, /ctx\.session\.hook\('compaction'/, '压缩边界要挂 session.hook("compaction")');
  assert.match(plugin, /ctx\.event\.subscribe\(/, '一轮结束要订阅事件流');
  assert.match(plugin, /session\.execution\.succeeded/, '服务端的一轮结束信号是 session.execution.succeeded（session.idle 只在 TUI 层）');
  assert.ok(!/types: \['session\.idle'\]/.test(plugin), 'session.idle 到不了服务端插件，别拿它挂收尾');
  assert.match(plugin, /'internal', '--add'/, '后台会话要登记进内部表');
  assert.match(plugin, /__CONVLEDGER_MAIN__/, '登记内部会话要走主 CLI，不能走 hook 入口');
  assert.match(plugin, /switchModel/, '新建会话没有模型会 step.failed，要从源会话抄模型');
  assert.match(plugin, /workers\.opencode/, '后台工作会话每家一段，OpenCode 不能抢 Qoder 的');
  assert.ok(!/'experimental\.session\.compacting'\s*:/.test(plugin), '旧 hook 名在 2.x 里已不存在，不能再当键注册');
  assert.ok(!/output\.context\.push/.test(plugin), '旧插件的 output.context 形状在 2.x 里拿不到');
  const hook = fs.readFileSync(new URL('../hooks/opencode.mjs', import.meta.url), 'utf8');
  assert.ok(!hook.includes("skip: 'no-tasks'"), '收尾不再用 no-tasks 跳过——没有任务表要先建首批');
  assert.match(hook, /internal-session/, '收尾要能跳过后台会话');
  const inst = fs.readFileSync(new URL('../hooks/install.mjs', import.meta.url), 'utf8');
  assert.match(inst, /__CONVLEDGER_CLI__/, '安装时要渲染插件里的 CLI 绝对路径');
  assert.match(inst, /plugin\/convledger\.js/, '安装时要清掉旧的 V1 单数目录插件');
});

// 宿主档案是单一事实来源：接了谁就必须有谁那页；状态只许三种口径，别写“已适配”。
test('hook 认第三个 runner：transcript_path 只在已知根目录下才算数，注册形状按宿主方言', () => {
  const base = fixture('wb-hook');
  fs.rmSync(base, { recursive: true, force: true });
  const SID = 'wb-hook-0001';
  const real = `${base}/projects/real/${SID}.jsonl`;
  const decoy = `${base}/projects/aaa/${SID}.jsonl`;
  const outside = `${base}/evil.jsonl`;
  const ts = (n) => 1760000000000 + n * 1000;
  const msg = (n, role, t) => JSON.stringify({ id: `${n}`, timestamp: ts(n), cwd: 'D:/fixture/proj', type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: t }] });
  for (const [file, ask, answer] of [
    [real, '<user_query>真的那一份：第三个 runner 建账</user_query>', '真的那一份：已经建好了'],
    [decoy, '<user_query>DECOY 另一段会话说的话</user_query>', 'DECOY 回答'],
    [outside, '<user_query>EVIL 根目录外的文件</user_query>', 'EVIL 回答'],
  ]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [JSON.stringify({ type: 'session-meta', timestamp: ts(1) }), msg(2, 'user', ask), msg(3, 'assistant', answer)].join('\n') + '\n');
  }
  const repo = tools.replace(/\/tool$/, '');
  const env = { ...process.env, WORKBUDDY_CONFIG_DIR: base, QODER_CONFIG_DIR: `${base}/noqoder`,
    CONVLEDGER_HOOK_STORE: `${base}/store`, CONVLEDGER_HOOK_LOG: `${base}/log.jsonl` };
  const hook = (input, moreEnv = {}) => spawnSync(process.execPath, ['hooks/ledger-brief.mjs'], {
    cwd: tools, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...env, ...moreEnv },
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: SID, cwd: repo, ...input }),
  });

  // transcript_path 优先：同 sid 的诱饵在 aaa/ 下（readdir 会更先撞见），注进去的必须是 real 那份
  const a = hook({ transcript_path: real });
  assert.equal(a.status, 0, `hook 退出 ${a.status}：${a.stderr}`);
  const ctxA = JSON.parse(a.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctxA, /真的那一份/, 'transcript_path 没被优先采用——注进来的是扫目录先撞见的那份');
  assert.doesNotMatch(ctxA, /DECOY/, '诱饵会话混进了注入');
  const led = JSON.parse(fs.readFileSync(`${base}/store/${SID}/ledger.json`, 'utf8'));
  assert.equal(led.runner, 'workbuddy', `hook 建的账本 runner 不对：${led.runner}`);

  // 不再给 WorkBuddy 写死「压缩时」：默认跟机器级走，Stop 应该拦。
  const stopDefault = hook({ hook_event_name: 'Stop', transcript_path: real, stop_hook_active: false });
  assert.equal(stopDefault.status, 0, `WorkBuddy Stop 退出 ${stopDefault.status}：${stopDefault.stderr}`);
  const sdd = JSON.parse(stopDefault.stdout);
  assert.equal(sdd.decision, 'block', 'WorkBuddy 不再有内置压缩时，默认应跟机器级走');
  assert.match(sdd.reason, /还没有任务表/, '首次收尾要提示建表');

  // 用户自己把 WorkBuddy 的收尾设成「压缩时」，Stop 才安静；这是设置页按 Agent 写入的同一形状。
  fs.writeFileSync(`${env.CONVLEDGER_HOOK_STORE}/prefs.json`,
    JSON.stringify({ schema: 'convledger-prefs/1', hosts: { workbuddy: { summaryCadence: 'each', closeoutCadence: 'compact' } } }, null, 1));
  const stopCompact = hook({ hook_event_name: 'Stop', transcript_path: real, stop_hook_active: false });
  assert.equal(stopCompact.status, 0, `WorkBuddy Stop 退出 ${stopCompact.status}：${stopCompact.stderr}`);
  assert.equal(String(stopCompact.stdout).trim(), '', '显式设成压缩时后，Stop 不该再派收尾');

  // 再改回每轮：认得出人类消息、首次要建表。
  fs.writeFileSync(`${env.CONVLEDGER_HOOK_STORE}/prefs.json`,
    JSON.stringify({ schema: 'convledger-prefs/1', hosts: { workbuddy: { summaryCadence: 'each', closeoutCadence: 'each' } } }, null, 1));
  fs.rmSync(`${env.CONVLEDGER_HOOK_STORE}/${SID}/closeout-prompt.json`, { force: true });
  const stop = hook({ hook_event_name: 'Stop', transcript_path: real, stop_hook_active: false });
  assert.equal(stop.status, 0, `WorkBuddy Stop 退出 ${stop.status}：${stop.stderr}`);
  const sd = JSON.parse(stop.stdout);
  assert.equal(sd.decision, 'block', 'WorkBuddy 的收尾提示被误判成没人说话');
  assert.match(sd.reason, /还没有任务表/, 'WorkBuddy 侧首次收尾也要提示建表');

  // 没有 transcript_path 时扫 WorkBuddy 的根目录（Qoder 那边的根是空的）
  const b = hook({}, { CONVLEDGER_HOOK_STORE: `${base}/store2` });
  assert.equal(b.status, 0, `扫描兜底退出 ${b.status}：${b.stderr}`);
  assert.match(JSON.parse(b.stdout).hookSpecificOutput.additionalContext, /DECOY/, '没去扫 ~/.workbuddy/projects，第三个 runner 的源找不到');

  // 根目录外的路径不认：一句宿主的坏字段不能让我们去读任意文件
  const c = hook({ transcript_path: outside }, { CONVLEDGER_HOOK_STORE: `${base}/store3` });
  assert.equal(c.status, 0);
  const ctxC = JSON.parse(c.stdout).hookSpecificOutput.additionalContext;
  assert.doesNotMatch(ctxC, /EVIL/, '根目录外的 transcript_path 被当成了源');
  assert.match(ctxC, /DECOY/, '拒绝野路径之后没回落到扫描');

  // 注册形状：WorkBuddy 只吃 shell 串（没有 args 字段），别人的 hook 一个键都不许动
  fs.writeFileSync(`${base}/settings.json`, JSON.stringify({
    claw: { keep: true },
    hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: "bash '/c/x/hook.sh'" }] }] },
  }, null, 2));
  const runInstall = (args) => spawnSync(process.execPath, ['hooks/install.mjs', ...args], { cwd: tools, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });
  const inst = runInstall(['--client', 'workbuddy']);
  assert.equal(inst.status, 0, `装 WorkBuddy hook 失败：${inst.stdout}${inst.stderr}`);
  const reg = JSON.parse(fs.readFileSync(`${base}/settings.json`, 'utf8'));
  const h = reg.hooks.SessionStart[0].hooks[0];
  assert.equal(reg.hooks.SessionStart[0].matcher, '', 'WorkBuddy 的条目不写 matcher，重装/重启后会被它丢掉');
  assert.equal(h.type, 'command');
  assert.equal(h.args, undefined, 'WorkBuddy 侧不许带 args——它的 handler 形状里没有这个字段');
  assert.equal(typeof h.command, 'string');
  assert.ok(h.command.includes('ledger-brief.mjs'), `shell 串里没有本仓脚本：${h.command}`);
  assert.match(h.command, /--origin host/, '注册的命令行没带溯源标记');
  // 路径里有空格（Windows 的 Program Files）必须加引号，否则 cmd 会拆开；
  // POSIX 上的 /usr/bin/node 没有空格，不加引号是正确形态，不拿 Windows 的串去要求它。
  const needsQuote = /[\s"']/.test(process.execPath);
  assert.ok(needsQuote ? /^".*"\s/.test(h.command) : h.command.startsWith(process.execPath + ' '),
    `node 路径处理不对（${needsQuote ? '含空格，必须加引号' : '无空格，不该硬加引号'}）：${h.command}`);
  assert.deepEqual(reg.claw, { keep: true }, '别的顶层键被改了');
  assert.equal(reg.hooks.Stop[0].hooks[0].command, "bash '/c/x/hook.sh'", '别人的 hook 被删了或改了');

  const rm = runInstall(['--client', 'workbuddy', '--remove']);
  assert.equal(rm.status, 0, `卸载失败：${rm.stdout}${rm.stderr}`);
  const after = JSON.parse(fs.readFileSync(`${base}/settings.json`, 'utf8'));
  assert.deepEqual(Object.keys(after.hooks), ['Stop'], `卸载没摘干净（或误删了别人的）：${Object.keys(after.hooks)}`);
  assert.equal(after.hooks.Stop[0].hooks[0].command, "bash '/c/x/hook.sh'");
  assert.deepEqual(after.claw, { keep: true });
  fs.rmSync(base, { recursive: true, force: true });
});

test('Claude Code 与 Codex 的 hook 注册：文件位置、事件形状、别人的条目与卸载', () => {
  const base = fixture('hooks-more');
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(`${base}/claude`, { recursive: true });
  fs.mkdirSync(`${base}/codex`, { recursive: true });
  const env = { ...process.env, CLAUDE_CONFIG_DIR: `${base}/claude`, CODEX_HOME: `${base}/codex` };
  // 别人的条目先放着：注册只许追加，卸载只许摘自己的
  fs.writeFileSync(`${base}/claude/settings.json`, JSON.stringify({
    other: 1,
    hooks: { Stop: [{ hooks: [{ type: 'command', command: "bash '/c/x/hook.sh'" }] }] },
  }, null, 2));
  fs.writeFileSync(`${base}/codex/hooks.json`, JSON.stringify({
    description: 'mine',
    hooks: { Stop: [{ matcher: 'x', hooks: [{ type: 'command', command: 'echo keep' }] }] },
  }, null, 2));
  const run = (args) => spawnSync(process.execPath, ['hooks/install.mjs', ...args], { cwd: tools, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });

  // setup 的宿主表要认 Claude Code 的 hooks，否则一键安装不会装它
  const crow = hostRows({ home: `${base}/home`, env: { ...env, QODER_CONFIG_DIR: `${base}/noq`, WORKBUDDY_CONFIG_DIR: `${base}/nowb`, OPENCODE_CONFIG_DIR: `${base}/nooc` }, sqlite: true, sessions: [] })
    .find((r) => r.id === 'claude-code');
  assert.equal(crow.canHook, true, 'setup 不认 Claude Code 的 hook：一键安装不会装它');

  const a = run(['--client', 'claude-code']);
  assert.equal(a.status, 0, `装 Claude Code hook 失败：${a.stdout}${a.stderr}`);
  const cl = JSON.parse(fs.readFileSync(`${base}/claude/settings.json`, 'utf8'));
  for (const ev of ['SessionStart', 'PreCompact', 'PostCompact', 'Stop']) {
    const hs = (cl.hooks[ev] || []).flatMap((d) => d.hooks || []);
    assert.ok(hs.some((h) => h.type === 'command' && /ledger-brief\.mjs/.test(h.command) && /--origin host/.test(h.command)),
      `Claude Code 的 ${ev} 没注册成 shell 串`);
  }
  assert.equal(cl.other, 1, 'Claude Code 里别的顶层键被改了');
  assert.equal(cl.hooks.Stop[0].hooks[0].command, "bash '/c/x/hook.sh'", 'Claude Code 里别人的 hook 被动了');

  const c = run(['--client', 'codex']);
  assert.equal(c.status, 0, `装 Codex hook 失败：${c.stdout}${c.stderr}`);
  const cx = JSON.parse(fs.readFileSync(`${base}/codex/hooks.json`, 'utf8'));
  // Codex 只公开 SessionStart / Stop；写 PreCompact/PostCompact 不会触发，还会让人误以为压缩边界有注入
  for (const ev of ['SessionStart', 'Stop']) {
    const mine = (cx.hooks[ev] || []).flatMap((d) => d.hooks || [])
      .filter((h) => h.type === 'command' && /ledger-brief\.mjs/.test(h.command) && /ledger-brief\.mjs/.test(h.commandWindows));
    assert.equal(mine.length, 1, `Codex 的 ${ev} 没装或装重`);
  }
  assert.ok(!cx.hooks.PreCompact && !cx.hooks.PostCompact, 'Codex 没有压缩事件，别注册');
  assert.equal(cx.description, 'mine', 'Codex 文件里别的顶层键被改了');
  assert.ok((cx.hooks.Stop || []).some((d) => (d.hooks || []).some((h) => h.command === 'echo keep')), 'Codex 里别人的 hook 被动了');

  const ra = run(['--client', 'claude-code', '--remove']);
  assert.equal(ra.status, 0, ra.stderr);
  const cl2 = JSON.parse(fs.readFileSync(`${base}/claude/settings.json`, 'utf8'));
  assert.deepEqual(Object.keys(cl2.hooks), ['Stop'], `Claude Code 卸载没摘干净：${Object.keys(cl2.hooks)}`);
  assert.equal(cl2.hooks.Stop[0].hooks[0].command, "bash '/c/x/hook.sh'");
  const rc = run(['--client', 'codex', '--remove']);
  assert.equal(rc.status, 0, rc.stderr);
  const cx2 = JSON.parse(fs.readFileSync(`${base}/codex/hooks.json`, 'utf8'));
  assert.deepEqual(Object.keys(cx2.hooks), ['Stop'], `Codex 卸载没摘干净：${Object.keys(cx2.hooks)}`);
  assert.ok((cx2.hooks.Stop || []).some((d) => (d.hooks || []).some((h) => h.command === 'echo keep')));
  fs.rmSync(base, { recursive: true, force: true });
});

test('会话库只列已建账的会话：按 runner 分组，绿点看源日志 mtime，标题四级回落', () => {
  const base = fixture('lib');
  fs.rmSync(base, { recursive: true, force: true });
  const root = `${base}/store`, src = `${base}/src`;
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(src, { recursive: true });
  const now = Date.now();
  const writeLedger = (id, extra) => {
    fs.mkdirSync(`${root}/${id}`, { recursive: true });
    fs.writeFileSync(`${root}/${id}/ledger.json`, JSON.stringify({
      sessionId: id, runner: 'qoder', cwd: 'D:/demo/omega', sourceFile: null,
      sourceBytes: 100, builtAt: new Date(now).toISOString(), segments: [{ id: 'S01' }], ...extra,
    }));
  };
  // A：qoder，源刚写过（绿点），标题取模型任务题名
  const A = 'aaaaaaaa-0000-0000-0000-00000000000a';
  fs.writeFileSync(`${src}/a.jsonl`, '{"a":1}\n');
  writeLedger(A, { sourceFile: `${src}/a.jsonl` });
  fs.writeFileSync(`${root}/${A}/summaries.json`, JSON.stringify({ tasks: { B01: { title: '最小夹具任务' } } }));
  // B：claude-code，源 40 分钟没动（灰点），没有综述 → 标题回落到 index.md 的一句话
  const B = 'bbbbbbbb-0000-0000-0000-00000000000b';
  fs.writeFileSync(`${src}/b.jsonl`, '{"b":1}\n');
  const old = new Date(now - 40 * 60000);
  fs.utimesSync(`${src}/b.jsonl`, old, old);
  writeLedger(B, { runner: 'claude-code', sourceFile: `${src}/b.jsonl`, cwd: 'D:/demo/beta' });
  fs.writeFileSync(`${root}/${B}/index.md`, '| 段 | 锚点 | 定性 | 回合 | 工具 | 一句话 | 卡 |\n|---|---|---|---|---|---|---|\n| S01 | L1-2 | main | 1 | 1 | 索引里的一句话 | c |\n');
  // C：workbuddy，源被清了、归档还在（灰点，但 idleMin 要能说出来）
  const C = 'cccccccc-0000-0000-0000-00000000000c';
  writeLedger(C, { runner: 'workbuddy', sourceFile: `${src}/gone.jsonl` });
  fs.writeFileSync(`${root}/${C}/source.jsonl`, '{"c":1}\n');
  const five = new Date(now - 5 * 60000);
  fs.utimesSync(`${root}/${C}/source.jsonl`, five, five);
  // D：坏账本（JSON 都读不出来）→ 只记 skipped，不把整份清单拖垮
  fs.mkdirSync(`${root}/broken`);
  fs.writeFileSync(`${root}/broken/ledger.json`, '{oops');
  // E：没建账的目录——用户说的是「已经导入的」，它不该出现在清单里
  fs.mkdirSync(`${root}/not-indexed-yet`);

  const lib = libraryOf(root, { current: A, now });
  assert.equal(lib.counts.sessions, 3);
  assert.equal(lib.counts.live, 1);
  assert.equal(lib.counts.skipped, 1, '坏账本必须单独计数，不能混进会话数');
  assert.deepEqual(lib.groups.map((g) => g.runner), ['qoder', 'claude-code', 'workbuddy']);
  assert.deepEqual(lib.groups.map((g) => g.label), ['Qoder', 'Claude Code', 'WorkBuddy']);
  const [qa, cb, wb] = lib.groups.map((g) => g.sessions[0]);
  assert.equal(qa.id, A);
  assert.equal(qa.live, true);
  assert.equal(qa.current, true);
  assert.equal(qa.title, '最小夹具任务');
  assert.equal(qa.titleFrom, 'tasks');
  assert.equal(qa.workspace, 'omega', '每条会话要能给出工作区目录名');
  assert.equal(cb.live, false, `源 ${40} 分钟没动还亮绿点`);
  assert.ok(cb.idleMin >= 39 && cb.idleMin <= 41, `idleMin=${cb.idleMin}`);
  assert.equal(cb.title, '索引里的一句话');
  assert.equal(cb.titleFrom, 'index');
  assert.equal(wb.sourceMissing, true);
  assert.equal(wb.live, false, '源都没了不能算在写');
  assert.ok(wb.idleMin >= 4 && wb.idleMin <= 6, `源丢了要回落归档时间，idleMin=${wb.idleMin}`);
  assert.equal(wb.title, 'demo/omega');
  assert.equal(wb.titleFrom, 'cwd');
  assert.equal(lib.liveMin, LIVE_MIN);
  assert.equal(findSession(root, 'aaaaaaaa'), A, '--session 的前缀语义必须和账本一致');
  assert.equal(findSession(root, 'cccccccc-0000-0000-0000-00000000000c'), C, '全等优先');
  assert.equal(findSession(root, 'zzzz'), null);
  assert.equal(findSession(root, ''), null, '空前缀不能匹配到任意一段');
  fs.rmSync(base, { recursive: true, force: true });
});

// 桌面端左侧的会话名是宿主给的，账本里没有；会话库要跟它一致，读不到才用派生标题。
test('会话库标题优先读桌面端标题，读不到才回落账本', async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { t.skip('这台机器的 Node 没有 node:sqlite（≥22.5 才有）'); return; }
  const base = fixture('host-title');
  const root = `${base}/store`;
  const A = 'dddddddd-0000-0000-0000-00000000000a';
  const B = 'dddddddd-0000-0000-0000-00000000000b';
  const writeLedger = (id) => {
    fs.mkdirSync(`${root}/${id}`, { recursive: true });
    fs.writeFileSync(`${root}/${id}/ledger.json`, JSON.stringify({
      sessionId: id, runner: 'qoder', cwd: 'D:/demo/omega', sourceFile: null,
      sourceBytes: 100, builtAt: new Date().toISOString(), segments: [{ id: 'S01' }],
    }));
    fs.writeFileSync(`${root}/${id}/summaries.json`, JSON.stringify({ tasks: { B01: { title: '账本派生标题' } } }));
  };
  writeLedger(A);
  writeLedger(B);
  const dbFile = `${base}/main.sqlite`;
  const db = new DatabaseSync(dbFile);
  db.exec('create table chat_sessions (session_id text primary key, title text)');
  db.prepare('insert into chat_sessions (session_id, title) values (?, ?)').run(A, '桌面端标题');
  db.close();
  const W = 'dddddddd-0000-0000-0000-00000000000c';
  const writeWb = (id, sourceFile) => {
    fs.mkdirSync(`${root}/${id}`, { recursive: true });
    fs.writeFileSync(`${root}/${id}/ledger.json`, JSON.stringify({
      sessionId: id, runner: 'workbuddy', cwd: 'D:/demo/omega', sourceFile,
      sourceBytes: 100, builtAt: new Date().toISOString(), segments: [{ id: 'S01' }],
    }));
    fs.writeFileSync(`${root}/${id}/summaries.json`, JSON.stringify({ tasks: { B01: { title: '账本派生标题' } } }));
  };
  const wbSource = `${base}/workbuddy.jsonl`;
  fs.writeFileSync(wbSource, JSON.stringify({ type: 'ai-title', aiTitle: 'WorkBuddy 源日志标题', sessionId: W }) + '\n');
  writeWb(W, wbSource);
  const W2 = 'dddddddd-0000-0000-0000-00000000000e';
  const wbSource2 = `${base}/workbuddy2.jsonl`;
  fs.writeFileSync(wbSource2, JSON.stringify({ type: 'user', text: '第一条消息' }) + '\n');
  writeWb(W2, wbSource2);
  const W3 = 'dddddddd-0000-0000-0000-00000000000f';
  writeWb(W3, wbSource2);
  const O = 'dddddddd-0000-0000-0000-00000000000d';
  fs.mkdirSync(`${root}/${O}`, { recursive: true });
  fs.writeFileSync(`${root}/${O}/ledger.json`, JSON.stringify({
    sessionId: O, runner: 'opencode', cwd: 'D:/demo/omega', sourceFile: null,
    sourceBytes: 100, builtAt: new Date().toISOString(), segments: [{ id: 'S01' }],
  }));
  fs.writeFileSync(`${root}/${O}/summaries.json`, JSON.stringify({ tasks: { B01: { title: '账本派生标题' } } }));
  const ocDb = `${base}/opencode.db`;
  const odb = new DatabaseSync(ocDb);
  odb.exec('create table session (id text primary key, title text)');
  odb.prepare('insert into session (id, title) values (?, ?)').run(O, 'OpenCode 官方标题');
  odb.close();
  const wbDb = `${base}/workbuddy.db`;
  const wdb = new DatabaseSync(wbDb);
  wdb.exec('create table sessions (id text primary key, title text, custom_title text)');
  const putWb = wdb.prepare('insert into sessions (id, title, custom_title) values (?, ?, ?)');
  putWb.run(W, 'WorkBuddy 主库标题', null);
  putWb.run(W2, '整段提示词标题', null);
  putWb.run(W3, '自动标题', '我改过的名字');
  wdb.close();
  process.env.CONVLEDGER_QODER_DB = dbFile;
  process.env.CONVLEDGER_OPENCODE_DB = ocDb;
  process.env.CONVLEDGER_WORKBUDDY_DB = wbDb;
  try {
    const mapSrc = fs.readFileSync(new URL('../src/map.mjs', import.meta.url), 'utf8');
    assert.match(mapSrc, /sweepNewSessions/, 'hub 要能自己发现还没建账的新会话');
    assert.match(mapSrc, /refresh\.sweep\(/, '主线程只派 sweep 给后台 worker，不在主线程建账');
    assert.doesNotMatch(mapSrc, /listSessions\(\)/, '主线程不再扫源建账——那是多 agent＋长对话卡死机器的病根');
    const workerSrc = fs.readFileSync(new URL('../src/refresh-worker.mjs', import.meta.url), 'utf8');
    assert.match(workerSrc, /listSessions\(\)/, '自动建账的候选只能来自源扫描，不是乱猜目录');
    assert.match(workerSrc, /function sweepJob/, 'sweep 在 worker 上跑，主线程永远空闲');

    const lib = libraryOf(root, { now: Date.now() });
    const byId = Object.fromEntries(lib.groups.flatMap((g) => g.sessions).map((s) => [s.id, s]));
    assert.equal(byId[A].title, '桌面端标题', '有宿主标题时必须跟工作区左侧一致');
    assert.equal(byId[A].titleFrom, 'host');
    assert.equal(byId[B].title, '账本派生标题', '宿主没有这段会话时应回落账本');
    assert.equal(byId[B].titleFrom, 'tasks');
    assert.equal(byId[W].title, 'WorkBuddy 主库标题', 'WorkBuddy 要以主库标题为准，跟桌面端左侧一致');
    assert.equal(byId[W].titleFrom, 'host');
    assert.equal(byId[W2].title, '整段提示词标题', '源日志没有 ai-title 时也要从主库拿到标题');
    assert.equal(byId[W3].title, '我改过的名字', '用户改过名时 custom_title 优先');
    assert.equal(byId[O].title, 'OpenCode 官方标题', 'OpenCode 要优先用 session.title');
    assert.equal(byId[O].titleFrom, 'host');
  } finally {
    delete process.env.CONVLEDGER_QODER_DB;
    delete process.env.CONVLEDGER_OPENCODE_DB;
    delete process.env.CONVLEDGER_WORKBUDDY_DB;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('/sessions.json 是只读清单；/open 与前缀地址都只跳规范地址，不起子进程', async () => {
  const base = fixture('open');
  fs.rmSync(base, { recursive: true, force: true });
  const root = `${base}/store`;
  fs.mkdirSync(root, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(`${base}/main.jsonl`, '{"m":1}\n{"m":2}\n');
  fs.writeFileSync(`${base}/other.jsonl`, '{"o":1}\n');
  const A = '11111111-1111-1111-1111-111111111111';
  const B = '22222222-2222-2222-2222-222222222222';
  for (const [id, runner, cwd, file] of [[A, 'qoder', 'D:/demo/main', `${base}/main.jsonl`], [B, 'workbuddy', 'D:/demo/other', `${base}/other.jsonl`]]) {
    fs.mkdirSync(`${root}/${id}`, { recursive: true });
    fs.writeFileSync(`${root}/${id}/ledger.json`, JSON.stringify({
      sessionId: id, runner, cwd, sourceFile: file, sourceBytes: 8, builtAt: now, segments: [{ id: 'S01' }, { id: 'S02' }],
    }));
  }
  fs.mkdirSync(`${root}/broken`);
  fs.writeFileSync(`${root}/broken/ledger.json`, '{oops');

  const req = (port, path, method = 'GET') => new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port, path, method, headers: h ? { 'x-hub-key': h.token } : undefined }, (x) => {
      let b = ''; x.on('data', (d) => { b += d; }); x.on('end', () => res({ status: x.statusCode, body: b, headers: x.headers }));
    });
    r.on('error', rej); r.end();
  });
  const h = await serveMap({ root, port: 8794, rebuildSec: 0 });
  try {
    const list = JSON.parse((await req(8794, '/sessions.json')).body);
    assert.equal(list.current, null, '根下的清单不属于任何会话');
    assert.equal(list.counts.sessions, 2);
    assert.equal(list.counts.skipped, 1);
    assert.ok(list.groups.some((g) => g.runner === 'qoder' && g.sessions.some((s) => s.id === A)));
    assert.ok(list.groups.some((g) => g.runner === 'workbuddy' && g.sessions.some((s) => s.id === B)));
    assert.equal((await req(8794, '/sessions.json', 'POST')).status, 405, '清单是只读的');
    const selfList = JSON.parse((await req(8794, `/s/${A}/sessions.json`)).body);
    assert.equal(selfList.current, A, '画布里的清单要认出「本页」');

    const self = await req(8794, `/open?session=${A}`);
    assert.equal(self.status, 302);
    assert.equal(self.headers.location, `/s/${A}/`);
    assert.equal((await req(8794, '/open?session=zzzz')).status, 404);
    assert.equal((await req(8794, '/open', 'POST')).status, 405);

    const other = await req(8794, '/open?session=22222222');
    assert.equal(other.status, 302, other.body);
    assert.equal(other.headers.location, `/s/${B}/`, '前缀也只跳地址，不另起端口');

    // 前缀与缺尾斜杠都跳到规范地址：页面里的相对路径才站得住
    const pref = await req(8794, '/s/11111111');
    assert.equal(pref.status, 302);
    assert.equal(pref.headers.location, `/s/${A}/`);
    const noSlash = await req(8794, `/s/${A}`);
    assert.equal(noSlash.status, 302);
    assert.equal(noSlash.headers.location, `/s/${A}/`);
    assert.equal((await req(8794, '/s/zzzz')).status, 404);

    // hub 不再按会话起子进程：8795 上必须没人应答
    let refused = false;
    try { await req(8795, '/health'); } catch { refused = true; }
    assert.equal(refused, true, 'hub 模式下不该再出现按会话开的子画布端口');
  } finally { h.stop(); }
  fs.rmSync(base, { recursive: true, force: true });
});

// 项目层：归组只认 cwd 整串相等。大小写和尾斜杠是同一段路径的不同拼写（normCwd 合并），
// 但父子目录是两个项目——前缀推断会把 D:/work 下所有子项目吞成一个「大项目」。
test('项目层：cwd 整串相等才同组，无 cwd 只进未归组，键跨运行稳定', () => {
  const base = fixture('projects');
  fs.rmSync(base, { recursive: true, force: true });
  const root = `${base}/store`;
  const mk = (id, cwd) => {
    fs.mkdirSync(`${root}/${id}`, { recursive: true });
    fs.writeFileSync(`${root}/${id}/ledger.json`, JSON.stringify({
      sessionId: id, runner: 'qoder', cwd,
      builtAt: '2026-10-01T00:00:00.000Z',
      segments: [{ id: 'S01', tsFrom: '2026-09-30T10:00:00.000Z', tsTo: '2026-09-30T11:00:00.000Z' }],
    }));
  };
  mk('projcase00000001', 'D:\\x');
  mk('projcase00000002', 'd:/x/');
  mk('projcase00000003', 'D:\\x\\sub');
  mk('projcase00000004', null);

  const at = Date.parse('2026-10-02T00:00:00.000Z');
  const a = projectsOf(root, { now: at, withSteps: false });
  assert.equal(a.counts.ledgers, 4);
  assert.equal(a.counts.projects, 2, 'D:/x 与 d:/x/ 该合成一个项目，D:/x/sub 是另一个');
  assert.equal(a.counts.sessions, 3);
  assert.equal(a.counts.ungrouped, 1, '没有 cwd 的账只能进未归组');
  assert.equal(a.ungrouped[0].id, 'projcase00000004');
  assert.equal(a.counts.sessions + a.counts.ungrouped, a.counts.ledgers, '每本账必须恰好落一处');

  const top = a.projects.find((p) => normCwd(p.root) === 'd:/x');
  assert.ok(top, 'D:/x 那一组不见了');
  assert.equal(top.counts.sessions, 2);
  assert.equal(top.key, projectKey('d:/x'));
  assert.equal(projectKey('D:/X/'), projectKey('d:/x'), '键只由 normCwd 决定：大小写/尾斜杠不该换键');
  assert.equal(projectKey('d:/x'), `p-${sha('d:/x')}`, '键的形状是 p- + sha12(normCwd)');
  const sub = a.projects.find((p) => normCwd(p.root) === 'd:/x/sub');
  assert.ok(sub && sub.counts.sessions === 1, '单会话项目也要列出来');
  assert.notEqual(sub.key, top.key, '子目录不是父项目的成员');
  assert.equal(top.name, 'x');

  const seen = [...a.projects.flatMap((p) => p.members.map((m) => m.id)), ...a.ungrouped.map((m) => m.id)];
  assert.equal(new Set(seen).size, 4, '同一本账出现在了多个项目里');

  const b = projectsOf(root, { now: at, withSteps: false });
  assert.deepEqual(b.projects.map((p) => p.key), a.projects.map((p) => p.key), '项目键跨两次运行必须稳定');
  fs.rmSync(base, { recursive: true, force: true });
});

// 计数口径只有一套：有 ledger.json 的目录数 = 各项目会话合计 + 未归组。
// 不拿 library 的 skipped 口径另算一遍，否则两处各算一套，总有一个是假的。
test('项目层与 store 对齐：会话合计＋未归组＝账本目录数，归组结果可逐本对回', () => {
  const root = `${tools}/out/store`;
  const dirs = fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'ledger.json')));
  const r = spawnSync(process.execPath, ['src/cli.mjs', 'projects', '--json', '--store', root], { cwd: tools, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.schema, 'convledger-projects/1');
  assert.equal(j.counts.ledgers, dirs.length);
  assert.equal(j.counts.sessions + j.counts.ungrouped, dirs.length, '项目会话合计 + 未归组 必须等于账本总数');
  const ids = [...j.projects.flatMap((p) => p.members.map((m) => m.id)), ...j.ungrouped.map((m) => m.id)];
  assert.equal(new Set(ids).size, ids.length, '有账本被归进了两个项目');
  assert.deepEqual([...ids].sort(), [...dirs].sort(), '归组结果与原目录对不上');
  for (const p of j.projects) {
    assert.equal(p.counts.sessions, p.members.length);
    assert.equal(p.key, projectKey(normCwd(p.root)), '键必须由 normCwd(root) 算出');
    assert.equal(p.counts.segments, p.members.reduce((a, m) => a + m.segments, 0));
  }
  const groupedLive = libraryOf(root).groups.flatMap((g) => g.sessions)
    .filter((s) => s.live && normCwd(s.cwd)).length;
  assert.equal(j.counts.live, groupedLive, 'live 数必须和会话库同一把尺（LIVE_MIN）');

  const t = spawnSync(process.execPath, ['src/cli.mjs', 'projects', '--store', root], { cwd: tools, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /^项目 \d+ · 会话 \d+ \/ \d+ 本账（未归组 \d+）/);
  assert.equal(t.stdout.split('\n').filter((l) => /^p-[0-9a-f]{12} · /.test(l)).length, j.counts.projects, '默认输出必须列出每个项目');
});

// 记忆层夹具：校准会话前 480 行 → 5 段（S01/S05 有真人原话，S02–S04 只有工具段）。
// 为什么是 480 不是 240：那段会话被更新过，前 240 行实测只切出 3 段（S01–S03），
// 夹具里写死的 S05 就不存在了。切多少行不是重点，「够 5 段」才是——下面的断言会守住它。
// claims 直接写表再重建——与 claim 命令走同一条叠加规则（author≠rule-layer 且 segmentHash 相同）。
function memoryFixture() {
  const base = fixture('memory');
  fs.rmSync(base, { recursive: true, force: true });
  const src = `${base}/src/memsession0000000a.jsonl`;
  fs.mkdirSync(`${base}/src`, { recursive: true });
  // cwd 必须改到夹具目录：写成真项目根的话，`memory --put` 的自动导出会写进用户的仓库。
  const proj = `${base}/proj`;
  fs.mkdirSync(proj, { recursive: true });
  const lines = fs.readFileSync(CALIBRATION, 'utf8').split('\n').slice(0, 480);
  const retarget = lines.map((line) => {
    if (!line.trim()) return line;
    const o = JSON.parse(line);
    if (typeof o.cwd === 'string') o.cwd = proj;
    if (Array.isArray(o.directories)) o.directories = o.directories.map(() => proj);
    return JSON.stringify(o);
  }).join('\n') + '\n';
  fs.writeFileSync(src, retarget);
  const root = `${base}/store`;
  writeStore(root, build(src, { storeRoot: root }));
  const dir = `${root}/memsession0000000a`;
  const ledger = JSON.parse(fs.readFileSync(`${dir}/ledger.json`, 'utf8'));
  assert.ok(ledger.segments.length >= 5, `夹具源只切出 ${ledger.segments.length} 段，S05 不存在——把 slice 行数调大`);
  const hash = {};
  for (const s of ledger.segments) hash[s.id] = s.contentHash;
  fs.writeFileSync(`${dir}/claims.json`, JSON.stringify({
    S01: { text: '夹具规则一：先测再改', moves: 'rule', topic: '夹具规则', evidence: [1], basis: 'verified', author: 'model-layer', segmentHash: hash.S01 },
    S05: { text: '夹具经验一：先接成熟件再自研', moves: 'decision', topic: '夹具经验', evidence: [1], basis: 'verified', author: 'model-layer', segmentHash: hash.S05 },
  }, null, 1));
  const project = projectsOf(root, { withSteps: false }).projects[0];
  const short = Object.fromEntries(Object.entries(hash).map(([k, v]) => [k, v.slice(0, 12)]));
  // 有没有一句中文真人原话，由内容决定：CALIBRATION 那段源可能整份都是英文与工具回执，
  // 这时依赖「say 类证据」的用例没有材料，应该跳过并说明，而不是崩在 segHash 里。
  const say = (() => {
    for (const n of readView(dir).nodes) {
      const m = typeof n.say === 'string' ? n.say.match(/[\u4e00-\u9fa5]{8,}/) : null;
      if (m) return { seg: n.id, quote: m[0], hash: short[n.id] };
    }
    return null;
  })();
  return { base, src, root, project, sid8: 'memsessi', hash: short, say, segments: ledger.segments.length };
}

/** 用户层夹具：同一份前 240 行建两本账，只换 cwd 与文件名 → 两个项目。
 *  两本都写同一条 rule claim（S01）与同一条 decision claim（S05）：晋升门要跨项目等价。
 *  逐行 JSON 重写而不是字符串替换——cwd 在 file 里是转义过的，字符串替换容易空转。 */
function userMemoryFixture() {
  const base = fixture('user-memory');
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(`${base}/src`, { recursive: true });
  const lines = fs.readFileSync(CALIBRATION, 'utf8').split('\n').slice(0, 480);
  const retarget = (cwd) => lines.map((line) => {
    if (!line.trim()) return line;
    const o = JSON.parse(line);
    if (typeof o.cwd === 'string') o.cwd = cwd;
    if (Array.isArray(o.directories)) o.directories = o.directories.map(() => cwd);
    return JSON.stringify(o);
  }).join('\n') + '\n';
  const root = `${base}/store`;
  const hash = {};
  let say = null;
  for (const [name, cwd] of [['mema00000001', 'D:/proj/memfixture-a'], ['memb00000001', 'D:/proj/memfixture-b']]) {
    const src = `${base}/src/${name}.jsonl`;
    fs.writeFileSync(src, retarget(cwd));
    writeStore(root, build(src, { storeRoot: root }));
    const dir = `${root}/${name}`;
    const ledger = JSON.parse(fs.readFileSync(`${dir}/ledger.json`, 'utf8'));
    assert.ok(ledger.segments.length >= 5, `夹具源只切出 ${ledger.segments.length} 段，S05 不存在——把 slice 行数调大`);
    // 哪一段里有人话、那句话长什么样，都由**解析后的视图**给出，不由段号也不由原始行给出：
    // 证据校验比对的正是视图里的人话，拿原始 JSON 的 humanInput.text 会对不上（真踩过）。
    const sayHit = (() => {
      for (const n of readView(dir).nodes) {
        const m = typeof n.say === 'string' ? n.say.match(/[\u4e00-\u9fa5]{8,}/) : null;
        if (m) return { seg: n.id, quote: m[0], hash: String((ledger.segments.find((s) => s.id === n.id) || {}).contentHash || '').slice(0, 12) };
      }
      return null;
    })();
    say = sayHit;   // 可能是 null：源整份没有人话时，依赖 say 证据的用例自己跳过
    hash[name] = Object.fromEntries(ledger.segments.map((s) => [s.id, String(s.contentHash).slice(0, 12)]));
    const segHash = (id) => {
      const seg = ledger.segments.find((s) => s.id === id);
      assert.ok(seg, `${name} 没有段 ${id}——夹具假设过期了，先看上面段数断言`);
      return seg.contentHash;
    };
    fs.writeFileSync(`${dir}/claims.json`, JSON.stringify({
      S01: { text: '夹具规则一：先测再改', moves: 'rule', topic: '夹具规则', evidence: [1], basis: 'verified', author: 'model-layer', segmentHash: segHash('S01') },
      S05: { text: '夹具经验一：先接成熟件再自研', moves: 'decision', topic: '夹具经验', evidence: [1], basis: 'verified', author: 'model-layer', segmentHash: segHash('S05') },
    }, null, 1));
  }
  const projects = projectsOf(root, { withSteps: false }).projects;
  const pA = projects.find((p) => p.members.some((m) => m.id === 'mema00000001'));
  const pB = projects.find((p) => p.members.some((m) => m.id === 'memb00000001'));
  assert.ok(pA && pB && pA.key !== pB.key, '两本账必须落成两个项目');
  return { base, root, pA, pB, hash, say };
}

test('项目记忆：闸门逐条拒（锚点/逐字/工具回执/截段/类别/画像/重复），整批失败不落盘', (t) => {
  const f = memoryFixture();
  if (!f.say) { t.skip('CALIBRATION 那段源整份没有中文真人原话（全是英文与工具回执），say 类证据造不出来'); return; }
  const ctx = memoryContext(f.root, f.project);
  assert.equal(ctx.members.length, 1);

  // 一条记忆都没有时，第二段「现在到哪」照样答得出来（全部工具复算）
  const zero = memoryRead(f.root, f.project);
  assert.match(zero.text, /## 现在到哪（工具复算）/);
  assert.match(zero.text, new RegExp(`最新会话 memsessi · ${f.segments} 段`));
  assert.match(zero.text, /本类 0 条/);
  assert.match(zero.text, /用户表里 0 条/);

  const ev = {
    rule: { sid: f.sid8, seg: 'S01', hash: f.hash.S01, kind: 'claim', quote: '夹具规则一：先测再改' },
    say: { sid: f.sid8, seg: f.say.seg, hash: f.hash[f.say.seg], kind: 'say', quote: f.say.quote },
    decision: { sid: f.sid8, seg: 'S05', hash: f.hash.S05, kind: 'claim', quote: '夹具经验一：先接成熟件再自研' },
  };
  const good = { class: '规则', topic: '夹具规则', text: '夹具规则：先写测试再改代码', evidence: [ev.rule, ev.say] };
  const ok0 = validateMemoryEntry(good, ctx);
  assert.equal(ok0.ok, true, ok0.errors.join('；'));

  const reject = (patch, re, why) => {
    const r = validateMemoryEntry({ ...good, ...patch }, ctx);
    assert.equal(r.ok, false, `该拒没拒：${why}`);
    assert.match(r.errors.join('\n'), re, why);
  };
  reject({ evidence: [{ ...ev.rule, hash: '000000000000' }] }, /锚点对不上/, '假锚点');
  reject({ evidence: [{ ...ev.rule, quote: '夹具规则一：先测后改' }] }, /引文不是逐字原文/, '非逐字 claim');
  reject({ evidence: [{ sid: f.sid8, seg: 'S03', hash: f.hash.S03, kind: 'say', quote: 'Bash cd' }] }, /没有真人原话/, '工具回执当 say');
  reject({ evidence: [{ ...ev.say, quote: '这不是这一段里的原话' }] }, /不是这一段里真人的连续原话/, '编的 say');
  reject({ text: ev.say.quote }, /连续截段/, '截段当蒸馏');
  reject({ evidence: [ev.decision] }, /move 要是 rule/, '无 rule 的规则');
  reject({ class: '画像' }, /用户作用域/, '画像进项目表');
  reject({ text: '夹具进度：已经走到第 99 步', evidence: [ev.say], class: '进度' }, /不编进度/, '进度报出账本里没有的步号');

  // 探索类可以拿一条仍 pending 的请求当证据（不存引文）
  const open = appendRequest(ctx.members[0].dir, { text: '夹具待办：接入效果还没有结论' });
  assert.equal(open.ok, true, open.errors?.join('；'));
  const explore = { class: '探索', topic: '夹具探索', text: '夹具探索：接入效果还没有结论', evidence: [{ sid: f.sid8, rid: 'R01' }] };
  // 请求表在 memoryContext 里是快照：追加后要重新取上下文
  const ex = validateMemoryEntry(explore, memoryContext(f.root, f.project));
  assert.equal(ex.ok, true, ex.errors.join('；'));

  const p1 = putProjectMemories(f.root, f.project, [good, explore], { rebuild: false });
  assert.equal(p1.ok, true, p1.errors.join('；'));
  assert.deepEqual(p1.added, ['M01', 'M02']);
  const file = path.join(projectMemoryDir(f.root, f.project.key), 'memories.json');
  const twoBytes = fs.readFileSync(file, 'utf8');

  // 同一件事不带 revises = 重复，整批拒；文件一个字节都不许动（G6）
  const dup = putProjectMemories(f.root, f.project, [{ ...good, topic: '夹具规则（重复）' }], { rebuild: false });
  assert.equal(dup.ok, false);
  assert.match(dup.errors.join('\n'), /要带 revises/);
  assert.equal(fs.readFileSync(file, 'utf8'), twoBytes, '被拒的批次改了表');

  const rev = putProjectMemories(f.root, f.project, [{ ...good, text: '夹具规则：先写测试再改代码，再提交', revises: 'M01' }], { rebuild: false });
  assert.equal(rev.ok, true, rev.errors.join('；'));
  assert.deepEqual(rev.revised, ['M01']);
  assert.equal(rev.entries.length, 2, '修订不新增条目');
  assert.match(rev.entries[0].text, /再提交/);

  const before = fs.readFileSync(file, 'utf8');
  const mixed = putProjectMemories(f.root, f.project, [
    { class: '经验', topic: '夹具经验', text: '夹具经验：成熟件优先接入', evidence: [ev.decision] },
    { class: '规则', topic: '坏锚点', text: '夹具坏规则', evidence: [{ ...ev.rule, hash: 'ffffffffffff' }] },
  ], { rebuild: false });
  assert.equal(mixed.ok, false);
  assert.equal(mixed.written, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'G6：一条不过整批不写');

  // 默认写入口先按源重建再核锚点：重建不许把模型写的 claims 丢掉，否则这条过不了 G4
  const rebuilt = putProjectMemories(f.root, f.project, [
    { class: '经验', topic: '夹具经验', text: '夹具经验：成熟件优先接入', evidence: [ev.decision] },
  ]);
  assert.equal(rebuilt.ok, true, rebuilt.errors.join('；'));
  assert.equal(rebuilt.built.rebuilt.length, 1);
  assert.equal(readProjectMemories(f.root, f.project.key).entries.length, 3);

  const cli = (args, input) => spawnSync(process.execPath, ['src/cli.mjs', ...args, '--store', f.root, '--project', f.project.key], { cwd: tools, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, input });
  const put = (entries) => cli(['memory', '--put', '-'], JSON.stringify({ entries }));
  const c1 = put([{ class: '进度', topic: '夹具进度', text: '夹具进度：首段已建账并留下原话', evidence: [ev.say] }]);
  assert.equal(c1.status, 0, c1.stdout + c1.stderr);
  assert.match(c1.stdout, /✓ 项目记忆已落盘/);
  assert.match(c1.stdout, /basis=model（不是 verified）/);
  const cliBytes = fs.readFileSync(file, 'utf8');
  const c2 = put([{ class: '进度', topic: '夹具进度二', text: '夹具进度：首段已建账并留下原话', evidence: [ev.say] }]);
  assert.equal(c2.status, 1);
  assert.match(c2.stdout + c2.stderr, /要带 revises[\s\S]*未落盘/);
  assert.equal(fs.readFileSync(file, 'utf8'), cliBytes, 'CLI 被拒也不许改表');
  const c3 = cli(['memory', '--put', '-', '--scope', 'user'], '{}');
  assert.equal(c3.status, 1);
  assert.match(c3.stdout + c3.stderr, /记忆是空的/);
  const c4 = cli(['memory', '--digest', '--class', '画像']);
  assert.equal(c4.status, 0, c4.stdout + c4.stderr);
  assert.match(c4.stdout, /用户画像（跨项目）/);
});

test('项目记忆新鲜度：改一段只有那条失效，读取默认隐藏、--all 给原因', () => {
  const f = memoryFixture();
  const ctx = memoryContext(f.root, f.project);
  appendRequest(ctx.members[0].dir, { text: '夹具待办：接入效果还没有结论' });
  const w = putProjectMemories(f.root, f.project, [
    { class: '规则', topic: '夹具规则', text: '夹具规则：先写测试再改代码', evidence: [{ sid: f.sid8, seg: 'S01', hash: f.hash.S01, kind: 'claim', quote: '夹具规则一：先测再改' }] },
    { class: '经验', topic: '夹具经验', text: '夹具经验：成熟件优先接入', evidence: [{ sid: f.sid8, seg: 'S05', hash: f.hash.S05, kind: 'claim', quote: '夹具经验一：先接成熟件再自研' }] },
    { class: '探索', topic: '夹具探索', text: '夹具探索：接入效果还没有结论', evidence: [{ sid: f.sid8, rid: 'R01' }] },
  ], { rebuild: false });
  assert.equal(w.ok, true, w.errors.join('；'));

  // 必须改 S05 行范围内已有的一行；追加一行不进任何段，hash 不会变
  const lines = fs.readFileSync(f.src, 'utf8').split('\n');
  const seg5 = ctx.members[0].ledger.segments.find((s) => s.id === 'S05');
  const at = seg5.lineTo - 1;
  const row = JSON.parse(lines[at]);
  row.message.content[0].content += '\n（夹具改动）';
  lines[at] = JSON.stringify(row);
  fs.writeFileSync(f.src, lines.join('\n'));
  writeStore(f.root, build(f.src, { storeRoot: f.root }));

  const ctx2 = memoryContext(f.root, JSON.parse(JSON.stringify(f.project)));
  const fresh = applyFreshness(ctx2, readProjectMemories(f.root, f.project.key).entries);
  assert.deepEqual(fresh.live.map((e) => e.id), ['M01', 'M03'], 'S01 与 rid 条目不该失效');
  assert.deepEqual(fresh.stale.map((e) => e.id), ['M02'], 'S05 条目必须失效');
  assert.match(fresh.stale[0].stale.join('；'), /锚点变了/);

  const def = memoryRead(f.root, f.project);
  assert.match(def.text, /另有 1 条已失效/);
  assert.equal(def.text.includes('[失效] [M02]'), false, '默认输出不许把失效条目当活的显示');
  const all = memoryRead(f.root, f.project, { all: true });
  assert.match(all.text, /\[失效\] \[M02\][^\n]*锚点变了/);
});

test('记忆素材：只走派生层、按会话整段取舍、单会话成本有上限，记忆表不入库', () => {
  const root = `${tools}/out/store`;
  const sid = path.basename(FILE, '.jsonl');
  const project = projectsOf(root, { withSteps: false }).projects.find((p) => p.members.some((m) => m.id === sid));
  assert.ok(project, `校准会话 ${sid} 不在 store 的任何项目里——先 convledger index`);

  const d = digestMaterials(root, project, { all: true });
  assert.ok(d.sessions >= 1);
  assert.ok(d.tokens <= MEMORY_DIGEST_TOKENS, `素材 ${d.tokens}t 超硬顶 ${MEMORY_DIGEST_TOKENS}`);
  assert.ok(d.tokens <= MEMORY_DIGEST_FIXED + MEMORY_DIGEST_PER_SESSION * d.sessions,
    `素材 ${d.tokens}t 超速率（固定 ${MEMORY_DIGEST_FIXED} + ${MEMORY_DIGEST_PER_SESSION}/会话）`);

  const segIds = new Map(project.members.map((m) => {
    const l = JSON.parse(fs.readFileSync(path.join(m.dir, 'ledger.json'), 'utf8'));
    return [m.sid8, new Set((l.segments ?? []).map((s) => s.id))];
  }));
  for (const m of d.text.matchAll(/\b([0-9a-f]{8}):(S\d{2,})\b/g)) {
    assert.ok(segIds.has(m[1]), `素材引用了项目外的会话 ${m[1]}`);
    assert.ok(segIds.get(m[1]).has(m[2]), `素材引用了不存在的段 ${m[1]}:${m[2]}`);
  }
  for (const line of d.text.split('\n')) {
    assert.ok(line.length <= 240, `素材单行 ${line.length} 字：${line.slice(0, 40)}…`);
    const say = line.match(/^块\d+ 步\S+ \S+ · (.*)$/);
    if (say) assert.ok(!TOOLISH.test(say[1]) && !NOSAY.test(say[1]), `素材混进工具回执：${line.slice(0, 60)}`);
  }
  for (const bad of ['"tool_result"', '"function_call"', '"uuid":', 'tool_use_id']) {
    assert.equal(d.text.includes(bad), false, `素材里混进原始 JSONL 结构：${bad}`);
  }

  const tight = digestMaterials(root, project, { all: true, max: 700 });
  assert.ok(tight.dropped.length >= 1, '预算 700 还没丢任何会话');
  assert.match(tight.text, /已整段丢掉最旧 \d+ 个会话/);

  const r = memoryRead(root, project);
  assert.match(r.text, /## 现在到哪（工具复算）/);
  const entryCount = r.table.entries.length + r.user.table.entries.length;
  assert.ok(tok(r.text) <= MEMORY_READ_FIXED + MEMORY_READ_PER_ENTRY * entryCount,
    `读取 ${tok(r.text)}t 超速率（固定 ${MEMORY_READ_FIXED} + ${MEMORY_READ_PER_ENTRY}/条）`);

  // 读路径零模型：这两个模块里不许出现网络调用
  for (const f of ['src/memories.mjs', 'src/projects.mjs']) {
    const code = fs.readFileSync(`${tools}/${f}`, 'utf8');
    assert.equal(/fetch\(|https?:\/\//.test(code), false, `${f} 里出现了网络调用`);
  }
  // 记忆表里是会话逐字引文：必须被 .gitignore 挡住
  for (const p of [`out/projects/${project.key}/memories.json`, 'out/user/memories.json']) {
    const g = spawnSync('git', ['check-ignore', '-q', p], { cwd: tools });
    assert.equal(g.status, 0, `${p} 没被 .gitignore 挡住——记忆表永不入库`);
  }
});

test('画像自动触发：≥2 段新会话才催，同一批只催一次，新一批再催', () => {
  const base = fixture('profile-auto');
  fs.rmSync(base, { recursive: true, force: true });
  const root = `${base}/store`;
  fs.mkdirSync(root, { recursive: true });
  const mk = (id, iso) => {
    const dir = `${root}/${id}`;
    fs.mkdirSync(dir, { recursive: true });
    const src = `${dir}/src.jsonl`;
    fs.writeFileSync(src, `${JSON.stringify({ type: 'user', cwd: 'D:/fixture/prof', message: { content: 'hi' } })}\n`);
    fs.writeFileSync(`${dir}/ledger.json`, JSON.stringify({
      sessionId: id, runner: 'qoder', cwd: 'D:/fixture/prof', sourceFile: src,
      sourceBytes: 10, builtAt: new Date().toISOString(), segments: [],
    }));
    const t = new Date(iso);
    fs.utimesSync(src, t, t);
  };
  mk('prof-sess-a', '2026-11-01T00:00:00Z');
  mk('prof-sess-b', '2026-11-02T00:00:00Z');
  let d = profileDue(root, { now: Date.parse('2026-11-03T00:00:00Z') });
  assert.equal(d.due, true, `两段会话且画像为空，应触发（${d.reason}）`);
  assert.equal(d.newer, 2);
  markProfilePrompt(root, d.fingerprint);
  d = profileDue(root, { now: Date.parse('2026-11-03T00:00:00Z') });
  assert.equal(d.due, false);
  assert.equal(d.reason, 'already-asked', '同一批不要每轮催');
  // 活跃会话继续写（mtime 变了）不等于新一批：指纹按会话集合，不能反复催
  const bSrc = `${root}/prof-sess-b/src.jsonl`;
  const t2 = new Date('2026-11-02T12:00:00Z');
  fs.utimesSync(bSrc, t2, t2);
  d = profileDue(root, { now: Date.parse('2026-11-03T00:00:00Z') });
  assert.equal(d.due, false, '同一批会话又长了，不能重复催');
  mk('prof-sess-c', '2026-11-04T00:00:00Z');
  d = profileDue(root, { now: Date.parse('2026-11-05T00:00:00Z') });
  assert.equal(d.due, true, '新一批会话到了要再催');
  assert.equal(d.newer, 3);
  // 自我排除：本工具派的后台会话（源头带 convledger-internal 哨兵）不算「新会话」——否则分析器自我催到无限
  markProfilePrompt(root, profileDue(root, { now: Date.parse('2026-11-05T00:00:00Z') }).fingerprint);
  const bgDir = `${root}/prof-sess-bg`;
  fs.mkdirSync(bgDir, { recursive: true });
  const bgSrc = `${bgDir}/src.jsonl`;
  fs.writeFileSync(bgSrc, `${JSON.stringify({ note: 'convledger-internal' })}\n`);
  fs.writeFileSync(`${bgDir}/ledger.json`, JSON.stringify({ sessionId: 'prof-sess-bg', runner: 'qoder', cwd: 'D:/fixture/prof', sourceFile: bgSrc, builtAt: new Date().toISOString(), segments: [] }));
  const bt = new Date('2026-11-06T00:00:00Z'); fs.utimesSync(bgSrc, bt, bt);
  d = profileDue(root, { now: Date.parse('2026-11-07T00:00:00Z') });
  assert.equal(d.due, false, '哨兵后台会话不该算「新会话」（防无限自我催）');
  fs.rmSync(base, { recursive: true, force: true });
});

test('用户画像：G9 作用域与跨会话门槛，--put --scope user 全有或全无，读取带来源', (t) => {
  const f = userMemoryFixture();
  if (!f.say) { t.skip('CALIBRATION 那段源整份没有中文真人原话（全是英文与工具回执），say 类证据造不出来'); return; }
  const ctx = userContext(f.root);
  assert.equal(ctx.projects.length, 2);
  assert.equal(ctx.members.length, 2);

  // 段号与原话都由夹具按内容给出：写死「S01 + 某句话」会随会话更新失效。
  const quote = f.say.quote;
  const evA = { project: f.pA.key, sid: 'mema0000', seg: f.say.seg, hash: f.hash.mema00000001[f.say.seg], kind: 'say', quote };
  const evB = { project: f.pB.name, sid: 'memb0000', seg: f.say.seg, hash: f.hash.memb00000001[f.say.seg], kind: 'say', quote };
  const good = { class: '画像', topic: '先看全量', text: '画像：动手前先要一张全量清单再判断', evidence: [evA, evB] };
  const ok0 = validateUserEntry(good, ctx);
  assert.equal(ok0.ok, true, ok0.errors.join('；'));
  const withDim = validateUserEntry({ ...good, dimension: '性格' }, ctx);
  assert.equal(withDim.ok, true, withDim.errors.join('；'));
  assert.equal(withDim.row.dimension, '性格', '画像要能带维度（性格/目标/边界/验收…）');
  const badDim = validateUserEntry({ ...good, dimension: '随便' }, ctx);
  assert.equal(badDim.ok, false, '维度不在枚举里要拒');
  assert.match(badDim.errors.join('\n'), /dimension/, '拒的理由要说 dimension');

  const withScenes = validateUserEntry({ ...good, dimension: '性格', scenes: ['ui', 'design'] }, ctx);
  assert.equal(withScenes.ok, true, withScenes.errors.join('；'));
  assert.deepEqual(withScenes.row.scenes, ['ui', 'design'], '画像要能带多轴场景标签');
  const badScene = validateUserEntry({ ...good, scenes: ['poster'] }, ctx);
  assert.equal(badScene.ok, false, '场景不在枚举里要拒');
  assert.match(badScene.errors.join('\n'), /scenes/, '拒的理由要说 scenes');
  const blankScenes = validateUserEntry({ ...good, scenes: [] }, ctx);
  assert.equal(blankScenes.ok, true);
  assert.deepEqual(blankScenes.row.scenes, [], 'scenes 可为空，不硬套');

  const reject = (patch, re, why) => {
    const r = validateUserEntry({ ...good, ...patch }, ctx);
    assert.equal(r.ok, false, `该拒没拒：${why}`);
    assert.match(r.errors.join('\n'), re, why);
  };
  reject({ evidence: [evA] }, /≥2 个不同会话/, '单会话画像');
  reject({ evidence: [{ ...evA, quote: 'Bash cd' }] }, /不是这一段里真人的连续原话/, '工具回执当画像');
  reject({ evidence: [{ ...evA, project: '' }] }, /要带 project/, '缺 project');
  reject({ class: '进度' }, /项目作用域/, '进度进用户表');
  reject({ class: '经验' }, /项目作用域/, '经验进用户表');
  reject({ class: '规则' }, /--promote/, '规则直写用户表');
  reject({ text: quote }, /连续截段/, '截段当蒸馏');
  reject({ evidence: [{ ...evA, quote: '这不是原话' }] }, /不是这一段里真人的连续原话/, '编的 say');

  const p1 = putUserMemories(f.root, [good], { rebuild: false });
  assert.equal(p1.ok, true, p1.errors.join('；'));
  assert.deepEqual(p1.added, ['U01']);
  const ufile = path.join(userMemoryDir(f.root), 'memories.json');
  const uBytes = fs.readFileSync(ufile, 'utf8');

  // G6：一条不过整批不写，文件一个字节都不动
  const mixed = putUserMemories(f.root, [
    { class: '画像', topic: '测试先行', text: '画像：改完先自测再汇报结果', evidence: [evA, evB] },
    { class: '进度', topic: '坏的', text: '进度：不该进用户表', evidence: [evA] },
  ], { rebuild: false });
  assert.equal(mixed.ok, false);
  assert.equal(mixed.written, 0);
  assert.equal(fs.readFileSync(ufile, 'utf8'), uBytes, 'G6：被拒的批次改了用户表');

  // 同一件事不带 revises = 重复；带 revises 修订同一个 U
  const dup = putUserMemories(f.root, [{ ...good, topic: '先看全量（重复）' }], { rebuild: false });
  assert.equal(dup.ok, false);
  assert.match(dup.errors.join('\n'), /要带 revises/);
  assert.equal(fs.readFileSync(ufile, 'utf8'), uBytes, '重复被拒却动了表');
  const rev = putUserMemories(f.root, [{ ...good, text: '画像：动手前先要全量清单，再判断', revises: 'U01' }], { rebuild: false });
  assert.equal(rev.ok, true, rev.errors.join('；'));
  assert.deepEqual(rev.revised, ['U01']);
  assert.equal(rev.entries.length, 1, '修订不新增条目');

  // 读取第 5 段从用户表来，带 来源 <项目>:<sid>:<seg>
  const read = memoryRead(f.root, f.pA);
  assert.match(read.text, /## 用户画像 \/ 工作方式/);
  assert.match(read.text, new RegExp(`\\[U01\\][^\\n]*来源 memfixture-a:mema0000:${f.say.seg} · memfixture-b:memb0000:${f.say.seg}`));
  assert.ok(tok(read.text) <= MEMORY_READ_FIXED + MEMORY_READ_PER_ENTRY * (read.table.entries.length + read.user.table.entries.length),
    `读取 ${tok(read.text)}t 超速率（固定 ${MEMORY_READ_FIXED} + ${MEMORY_READ_PER_ENTRY}/条）`);

  // 两个项目各写一条等价规则，再晋升
  const ruleEvA = { sid: 'mema0000', seg: 'S01', hash: f.hash.mema00000001.S01, kind: 'claim', quote: '夹具规则一：先测再改' };
  const ruleEvB = { sid: 'memb0000', seg: 'S01', hash: f.hash.memb00000001.S01, kind: 'claim', quote: '夹具规则一：先测再改' };
  const rule = { class: '规则', topic: '夹具规则', text: '夹具规则：先写测试再改代码', dimension: '验收', scenes: ['test', 'code'] };
  for (const [p, ev] of [[f.pA, ruleEvA], [f.pB, ruleEvB]]) {
    const w = putProjectMemories(f.root, p, [{ ...rule, evidence: [ev] }], { rebuild: false });
    assert.equal(w.ok, true, w.errors.join('；'));
  }
  const pr = promoteEntry(f.root, f.pA, 'M01');
  assert.equal(pr.ok, true, pr.errors.join('；'));
  assert.equal(pr.uid, 'U02');
  assert.equal(pr.action, 'added');
  assert.equal(pr.sources.length, 2);
  assert.deepEqual(pr.sources.map((s) => s.name).sort(), ['memfixture-a', 'memfixture-b']);
  const promoted = readUserMemories(f.root).entries.find((e) => e.id === 'U02');
  assert.equal(promoted.dimension, '验收', '晋升副本要带维度');
  assert.deepEqual(promoted.scenes, ['test', 'code'], '晋升副本要带场景标签');
  const u2 = readUserMemories(f.root).entries.find((e) => e.id === 'U02');
  assert.equal(u2.class, '规则');
  assert.equal(u2.evidence.length, 2, '晋升要合并两个项目的证据');
  assert.ok(u2.evidence.every((e) => e.project), '用户表每条证据都要带 project');
  assert.deepEqual(u2.promoted_from, { project: f.pA.key, id: 'M01' });
  assert.equal(readProjectMemories(f.root, f.pA.key).entries[0].promoted_to, 'global');
  assert.equal(readProjectMemories(f.root, f.pB.key).entries[0].promoted_to, 'global');

  // 同一来源的另一个项目再晋升 → 刷新同一个 U，证据去重
  const pr2 = promoteEntry(f.root, f.pB, 'M01');
  assert.equal(pr2.ok, true, pr2.errors.join('；'));
  assert.equal(pr2.uid, 'U02');
  assert.equal(pr2.action, 'refreshed');
  assert.equal(pr2.evidence, 2);

  // 撤销：删副本，来源 promoted_to 回 null
  const un = unpromoteEntry(f.root, 'U02');
  assert.equal(un.ok, true, un.errors.join('；'));
  assert.equal(un.cleared.length, 2);
  assert.equal(readUserMemories(f.root).entries.some((e) => e.id === 'U02'), false);
  assert.equal(readProjectMemories(f.root, f.pA.key).entries[0].promoted_to, null);
  assert.equal(readProjectMemories(f.root, f.pB.key).entries[0].promoted_to, null);

  // CLI：晋升 / 撤销 / 写画像 / 素材 / 导出待点头
  const cli = (args, input) => spawnSync(process.execPath, ['src/cli.mjs', ...args, '--store', f.root], { cwd: tools, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, input });
  const cp = cli(['memory', '--promote', 'M01', '--project', f.pA.key]);
  assert.equal(cp.status, 0, cp.stdout + cp.stderr);
  assert.match(cp.stdout, /✓ 已晋升 U02（新建）· 来源 2 个项目/);
  const cu = cli(['memory', '--unpromote', 'U02']);
  assert.equal(cu.status, 0, cu.stdout + cu.stderr);
  assert.match(cu.stdout, /promoted_to 回 null：memfixture-a:M01 memfixture-b:M01|promoted_to 回 null：memfixture-b:M01 memfixture-a:M01/);
  const cv = cli(['memory', '--put', '-', '--scope', 'user'], JSON.stringify({ entries: [
    { class: '画像', topic: '测试先行', text: '画像：改完先自测再汇报结果', evidence: [evA, evB] },
  ] }));
  assert.equal(cv.status, 0, cv.stdout + cv.stderr);
  assert.match(cv.stdout, /✓ 用户记忆已落盘/);
  assert.match(cv.stdout, /basis=model（不是 verified）/);
  const cd = cli(['memory', '--digest', '--class', '画像']);
  assert.equal(cd.status, 0, cd.stdout + cd.stderr);
  assert.match(cd.stdout, /用户画像（跨项目）/);
  assert.match(cd.stdout, /memfixture-a:mema0000:S\d{2}/);
  assert.match(cd.stdout, /memfixture-b:memb0000:S\d{2}/);
  const lastUser = readUserMemories(f.root).entries.at(-1);
  const cf = cli(['memory', '--forget', lastUser.id]);
  assert.equal(cf.status, 0, cf.stdout + cf.stderr);
  assert.match(cf.stdout, /已从用户表删除/);
  assert.equal(readUserMemories(f.root).entries.some((e) => e.id === lastUser.id), false, '--forget 要真删');
  const cf2 = cli(['memory', '--forget', 'U99']);
  assert.equal(cf2.status, 1, '删不存在的条目要报错');
  const cx = cli(['memory', '--export', 'note-app']);
  assert.equal(cx.status, 1);
  assert.match(cx.stdout + cx.stderr, /已取消.*convledger export/);

  // 单项目晋升必拒，且不写任何文件
  const single = memoryFixture();
  const sw = putProjectMemories(single.root, single.project, [{
    class: '规则', topic: '夹具规则', text: '夹具规则：先写测试再改代码',
    evidence: [{ sid: single.sid8, seg: 'S01', hash: single.hash.S01, kind: 'claim', quote: '夹具规则一：先测再改' }],
  }], { rebuild: false });
  assert.equal(sw.ok, true, sw.errors.join('；'));
  const sp = promoteEntry(single.root, single.project, 'M01');
  assert.equal(sp.ok, false);
  assert.match(sp.errors.join('\n'), /只在 1 个项目出现/);
  assert.equal(readUserMemories(single.root).entries.length, 0, '被拒的晋升不许写用户表');

  // 画像素材：跨项目取会话、每行带 <项目>:<sid8>:Sxx、有速率上限
  const d = digestUserMaterials(f.root);
  assert.equal(d.sessions, 2);
  assert.match(d.text, /取最近 2 个/);
  assert.ok(d.tokens <= MEMORY_DIGEST_FIXED + MEMORY_DIGEST_PER_SESSION * d.sessions,
    `画像素材 ${d.tokens}t 超速率（固定 ${MEMORY_DIGEST_FIXED} + ${MEMORY_DIGEST_PER_SESSION}/会话）`);

  // 用户表同样不入库
  const g = spawnSync('git', ['check-ignore', '-q', 'out/user/memories.json'], { cwd: tools });
  assert.equal(g.status, 0, 'out/user/memories.json 没被 .gitignore 挡住');
});

test('导出：项目里两份带元信息的文件，内容变了才存快照、合计留 30 份、不覆盖手写文件', async () => {
  const base = fixture('export');
  fs.rmSync(base, { recursive: true, force: true });
  const root = `${base}/store`;
  const proj = `${base}/proj`;
  fs.mkdirSync(proj, { recursive: true });
  const sid = 'eeee5555-0000-0000-0000-000000000000';
  fs.mkdirSync(`${root}/${sid}`, { recursive: true });
  const ledgerFile = `${root}/${sid}/ledger.json`;
  const writeLedger = (n) => fs.writeFileSync(ledgerFile, JSON.stringify({
    sessionId: sid, runner: 'qoder', cwd: proj, builtAt: '2026-10-28T07:00:00.000Z',
    segments: Array.from({ length: n }, (_, i) => ({ id: `S${String(i + 1).padStart(2, '0')}` })),
  }));
  writeLedger(2);
  const p = projectsOf(root, { withSteps: false }).projects[0];
  assert.ok(p && p.root === proj, '夹具项目没归组到 proj');
  const paths = exportPaths(root, p);
  assert.ok(paths.dir.replace(/\\/g, '/').startsWith(exportRoot(root).replace(/\\/g, '/')), '导出要收在工具目录 out/exports/projects 下');

  const r1 = writeProjectExports(root, p);
  assert.equal(r1.files.filter((f) => f.kind === 'progress' || f.kind === 'profile').length, 2, '进度与画像两份文件都要写');
  assert.ok(fs.existsSync(paths.progress) && fs.existsSync(paths.profile) && fs.existsSync(paths.index));
  assert.ok(fs.existsSync(`${paths.dir}/sessions/${sid.slice(0, 8)}-notes.md`), '导出要带单会话笔记');
  const proj1 = fs.readFileSync(paths.progress, 'utf8');
  assert.match(proj1.split('\n')[0], /^<!-- convledger-export v2 kind=progress project=p-/, '首行要是可解析的元信息');
  for (const token of ['## 元信息', '**项目**', '**工作目录**', '**生成时间**', '**生成会话**', '**内容指纹**']) {
    assert.ok(proj1.includes(token), `PROGRESS.md 缺 ${token}`);
  }
  assert.ok(proj1.includes('## 自上一份快照以来'), 'PROGRESS 要有「自上一份快照以来」');
  assert.ok(proj1.includes('## 经验（按阶段）'), 'PROGRESS 要有经验一节');
  assert.ok(proj1.includes('块综述还没写 lesson'), '没有经验时如实写 0 条，不编');
  assert.match(proj1, /第一份快照/, '第一次导出要明说没有可比较的上一份');
  assert.match(proj1, /生成时间.*UTC[+-]\d{2}:\d{2}/, '时间要带时区');
  assert.match(fs.readFileSync(paths.profile, 'utf8'), /## 画像（0 条）/, '画像 0 条要如实写 0 条');
  assert.match(fs.readFileSync(paths.index, 'utf8'), /archive\/\d{4}-\d{2}-\d{2}_\d{6}_progress_/, 'INDEX 要列现存快照');
  assert.ok(fs.existsSync(globalIndexFile(root)), '跨项目总索引没写');
  assert.ok(fs.readFileSync(globalIndexFile(root), 'utf8').includes(p.name), '总索引里没有这个项目');
  assert.ok(!fs.existsSync(`${proj}/convledger-export`), '不许再往项目工作目录里建 convledger-export');

  // 内容没变：不重写、不新增快照
  const archives = () => fs.readdirSync(paths.archive).filter((n) => n.includes('_progress_')).length;
  const n1 = archives();
  const r2 = writeProjectExports(root, p);
  assert.equal(r2.files.length, 0, '内容没变却写了文件');
  assert.equal(archives(), n1, '内容没变却多了快照');
  assert.ok(r2.skipped.some((x) => x.includes('内容没变')), '没变要说没变，不许装成写过');

  // 内容变了：新快照 + INDEX 多一行
  writeLedger(3);
  const r3 = writeProjectExports(root, projectsOf(root, { withSteps: false }).projects[0]);
  assert.ok(r3.files.some((f) => f.kind === 'progress'), '内容变了要重写进度');
  assert.match(fs.readFileSync(paths.progress, 'utf8'), /主线步：/, '第二份起增量要写步数');
  assert.equal(archives(), n1 + 1, '内容变了没存新快照');
  assert.equal(fs.readFileSync(paths.index, 'utf8').split('\n').filter((l) => l.startsWith('| 2026')).length, archives() + 1, 'INDEX 行数要等于进度快照数＋画像快照');

  // 合计 30：塞 35 份更旧的进度快照；自动刷新（不带 prune）不删，显式导出才剪
  const allSnaps = () => fs.readdirSync(paths.archive).filter((n) => /_(progress|profile)_/.test(n)).length;
  fs.writeFileSync(`${paths.archive}/2020-01-01_手工笔记.md`, '我自己写的\n');
  for (let i = 1; i <= 35; i++) {
    fs.writeFileSync(`${paths.archive}/2020-01-01_00${String(i).padStart(4, '0')}_progress_qoder_${sid.slice(0, 8)}_s1.md`, '<!-- convledger-export v2 kind=progress fp=old -->\n');
  }
  writeLedger(4);
  const r4a = writeProjectExports(root, projectsOf(root, { withSteps: false }).projects[0]);
  assert.equal(r4a.pruned.length, 0, '自动刷新不该删旧档');
  assert.ok(r4a.skipped.some((x) => x.includes('未删')), '超限要如实说没删');
  const r4 = writeProjectExports(root, projectsOf(root, { withSteps: false }).projects[0], { prune: true });
  assert.ok(r4.pruned.length > 0, '显式导出时超过合计 30 份没有剪');
  assert.equal(allSnaps(), 30, `合计只该留 30 份，现在 ${allSnaps()}`);
  assert.ok(fs.existsSync(`${paths.archive}/2020-01-01_手工笔记.md`), '名字像快照的手写文件不许删');

  // 手写的同名文件不覆盖；--force 才覆盖（新位置）
  const other = `${base}/proj2`;
  fs.mkdirSync(other, { recursive: true });
  const sid2 = 'ffff6666-0000-0000-0000-000000000000';
  fs.mkdirSync(`${root}/${sid2}`, { recursive: true });
  fs.writeFileSync(`${root}/${sid2}/ledger.json`, JSON.stringify({ sessionId: sid2, runner: 'qoder', cwd: other, builtAt: '2026-10-28T07:00:00.000Z', segments: [{ id: 'S01' }] }));
  const p2 = projectsOf(root, { withSteps: false }).projects.find((x) => x.root === other);
  const p2paths = exportPaths(root, p2);
  fs.mkdirSync(p2paths.dir, { recursive: true });
  fs.writeFileSync(p2paths.progress, '# 我自己写的\n');
  const r5 = writeProjectExports(root, p2);
  assert.ok(r5.skipped.some((x) => x.includes('不覆盖')), '手写的 PROGRESS.md 被覆盖了');
  assert.equal(fs.readFileSync(p2paths.progress, 'utf8'), '# 我自己写的\n');
  const r6 = writeProjectExports(root, p2, { force: true });
  assert.ok(r6.files.length >= 1, '--force 应该覆盖');

  // 旧位置：check 如实标「旧位置」；导出自动复制过来但不删；--migrate-legacy 才搬走
  const legacyProj = `${base}/proj3`;
  fs.mkdirSync(legacyProj, { recursive: true });
  const sid3 = 'aaaa7777-0000-0000-0000-000000000000';
  fs.mkdirSync(`${root}/${sid3}`, { recursive: true });
  fs.writeFileSync(`${root}/${sid3}/ledger.json`, JSON.stringify({ sessionId: sid3, runner: 'qoder', cwd: legacyProj, builtAt: '2026-10-28T07:00:00.000Z', segments: [{ id: 'S01' }] }));
  const p3 = projectsOf(root, { withSteps: false }).projects.find((x) => x.root === legacyProj);
  const legacy3 = legacyExportPaths(legacyProj);
  fs.mkdirSync(`${legacy3.dir}/archive`, { recursive: true });
  fs.writeFileSync(`${legacy3.dir}/archive/2020-01-01_000000_progress_qoder_x_s1_old.md`, '旧的\n');
  const c3 = checkExports(root, p3);
  assert.ok(c3.items.some((x) => x.status === 'legacy'), '旧位置有导出时要如实标 legacy');
  const r7 = writeProjectExports(root, p3);
  assert.ok(r7.migrated >= 1, '旧位置的文件要先复制到工具目录');
  assert.ok(fs.existsSync(`${exportPaths(root, p3).archive}/2020-01-01_000000_progress_qoder_x_s1_old.md`), '旧快照没复制过来');
  assert.ok(fs.existsSync(legacy3.dir), '自动复制不删旧目录');
  const m3 = migrateLegacyExports(root, p3);
  assert.equal(m3.ok, true, m3.reason);
  assert.ok(!fs.existsSync(legacy3.dir), '--migrate-legacy 之后旧目录要搬走');
  assert.ok(fs.existsSync(`${exportPaths(root, p3).archive}/2020-01-01_000000_progress_qoder_x_s1_old.md`), '搬走后文件要在新位置');

  // CLI：export 落盘 + --list 打印总索引
  const cli = new URL('../bin/convledger.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1').replace(/\\/g, '/');
  const run = (...a) => spawnSync(process.execPath, [cli, ...a, '--store', root], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: tools });
  const ok = run('export', '--project', p.key);
  assert.equal(ok.status, 0, ok.stderr || ok.stdout);
  const list = run('export', '--list');
  assert.equal(list.status, 0, list.stderr);
  assert.ok(list.stdout.includes(p.name), '--list 要打印跨项目总索引');
  assert.match(list.stdout, /最近一次导出/, '--list 要带最近一次导出的结果');

  // 自检：新鲜 exit 0；内容变了 exit 1 并说清算哪份；再导一次回到新鲜
  assert.equal(run('export', '--check', '--project', p.key).status, 0, '刚导完应该是新鲜的');

  // 手改正文、首行指纹不动：不能判新鲜；再导一次要把正文修回来
  fs.appendFileSync(paths.progress, '\n- 手写补的一行\n');
  const tampered = run('export', '--check', '--project', p.key);
  assert.equal(tampered.status, 1, '手改正文后 check 还判新鲜——只信首行 fp 的老问题回来了');
  assert.match(tampered.stdout, /过期 PROGRESS\.md/);
  const repaired = run('export', '--project', p.key);
  assert.equal(repaired.status, 0, repaired.stderr || repaired.stdout);
  assert.ok(!fs.readFileSync(paths.progress, 'utf8').includes('手写补的一行'), '正文被改过的文件应该重写');
  assert.equal(run('export', '--check', '--project', p.key).status, 0, '重写后应回到新鲜');
  writeLedger(9);
  const stale = run('export', '--check', '--project', p.key);
  assert.equal(stale.status, 1, '内容变了 --check 要说过期');
  assert.match(stale.stdout, /过期 PROGRESS\.md/);
  assert.equal(run('export', '--project', p.key).status, 0);
  assert.equal(run('export', '--check', '--project', p.key).status, 0, '导出后 check 要回到新鲜');

  fs.rmSync(base, { recursive: true, force: true });
});

test('用量：同一回复只算一次，没上报不记 0，注入与回读分开，缓存只补增量', () => {
  const base = fixture('usage');
  const home = `${base}/home`;
  const qdir = `${home}/.qoder/projects/proj`;
  const cdir = `${home}/.claude/projects/proj`;
  const wdir = `${home}/.workbuddy/projects/proj`;
  const xdir = `${home}/.codex/sessions/2026/11/13`;
  for (const d of [qdir, cdir, wdir, xdir, `${base}/store/sess1`]) fs.mkdirSync(d, { recursive: true });

  // Qoder：token 全 0，只有 credits；同一 request_id 出现两次只算一次。
  const qline = (request, credits, ratio) => JSON.stringify({
    type: 'assistant', message: { id: `m-${request}`, model: 'qfmodel' },
    usage: { request_id: request, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, credits, context_usage_ratio: ratio },
  }) + '\n';
  fs.writeFileSync(`${qdir}/q1.jsonl`, qline('r1', 1.5, 0.5) + qline('r1', 1.5, 0.5) + qline('r2', 2, 0.9));

  // Claude：同一 message.id 的两条记录带同一份 usage，只能计一次。
  const cline = (id, input, output, cache) => JSON.stringify({ type: 'assistant', message: { id, model: 'deepseek-flash', usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cache, cache_creation_input_tokens: 0 } } }) + '\n';
  const cfile = `${cdir}/c1.jsonl`;
  fs.writeFileSync(cfile, cline('c1', 100, 10, 50) + cline('c1', 100, 10, 50) + cline('c2', 200, 20, 0));

  // WorkBuddy：prompt_tokens 含缓存；未缓存输入用 prompt_cache_miss_tokens。
  const wline = (id, prompt, hit, miss, out, think) => JSON.stringify({
    type: 'function_call', id,
    providerData: { messageId: id, requestModelName: 'Hy3', rawUsage: { prompt_tokens: prompt, completion_tokens: out, prompt_cache_hit_tokens: hit, prompt_cache_miss_tokens: miss, prompt_cache_write_tokens: 0, completion_tokens_details: { reasoning_tokens: think } } },
  }) + '\n';
  fs.writeFileSync(`${wdir}/w1.jsonl`, wline('w1', 100, 40, 60, 5, 2) + wline('w1', 100, 40, 60, 5, 2) + wline('w2', 50, 0, 50, 7, 0));

  // Codex：本机这版没有 token_count——要写未上报，不能写 0。
  fs.writeFileSync(`${xdir}/rollout-2026-11-13T00-00-00-codex1.jsonl`,
    JSON.stringify({ type: 'session_meta', payload: { id: 'codex1', cwd: 'D:/codex-proj' } }) + '\n'
    + JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } }) + '\n');

  // 注入探针：只认 action=inject 且 tokens>0；别的动作与 0 token 不计数。
  fs.writeFileSync(`${base}/hook-probe.jsonl`, [
    { ts: '2026-11-13T00:00:01.000Z', action: 'inject', event: 'SessionStart', session: 'q1', tokens: 1000, truncated: true, source: 'compact' },
    { ts: '2026-11-13T00:00:02.000Z', action: 'inject', event: 'PostCompact', session: 'q1', tokens: 2000, truncated: false, source: 'compact' },
    { ts: '2026-11-13T00:00:03.000Z', action: 'dedupe', event: 'SessionStart', session: 'q1', tokens: 999 },
    { ts: '2026-11-13T00:00:04.000Z', action: 'inject', event: 'Stop', session: 'q1', tokens: 0 },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');

  // 回读 trace：按操作汇总。
  fs.writeFileSync(`${base}/store/sess1/trace.jsonl`, [
    { ts: '2026-11-13T00:00:01.000Z', op: 'steps', tokens: 500 },
    { ts: '2026-11-13T00:00:02.000Z', op: 'body', tokens: 300 },
    { ts: '2026-11-13T00:00:03.000Z', op: 'notes', tokens: 0 },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');

  const saved = { home: process.env.CONVLEDGER_USAGE_HOME, db: process.env.CONVLEDGER_OPENCODE_DB, codex: process.env.CONVLEDGER_CODEX_SRC };
  process.env.CONVLEDGER_USAGE_HOME = home;
  process.env.CONVLEDGER_OPENCODE_DB = `${base}/missing-opencode.db`;
  process.env.CONVLEDGER_CODEX_SRC = `${home}/.codex/sessions`;
  try {
    const store = `${base}/store`;
    const r = usageReport(store);
    const src = Object.fromEntries(r.sources.map((s) => [s.id, s]));

    assert.equal(src.qoder.tokens, null, 'Qoder 的 token 全 0 时必须写未上报，不能写 0 token');
    assert.match(src.qoder.reason, /token 字段全为 0/, '未上报要给出为什么');
    assert.equal(src.qoder.credits, 3.5, '同一 request_id 的 credits 被重复加了');
    assert.equal(src.qoder.events, 2, '同一 request_id 出现两次只该算一次请求');
    assert.equal(src.qoder.contextPeak, 0.9);

    assert.equal(src['claude-code'].tokens.input, 300, '同一 message.id 的 usage 被重复加了');
    assert.equal(src['claude-code'].tokens.cacheRead, 50);
    assert.equal(src['claude-code'].tokens.output, 30);
    assert.equal(src['claude-code'].total, 330, '真实用量不含缓存命中');
    assert.equal(src['claude-code'].all, 380, '含缓存的全部量单列为 all');
    assert.equal(src['claude-code'].events, 2);

    assert.equal(src.workbuddy.tokens.input, 110, '未缓存输入要用 miss，不是 prompt 全量');
    assert.equal(src.workbuddy.tokens.cacheRead, 40);
    assert.equal(src.workbuddy.tokens.output, 12);
    assert.equal(src.workbuddy.tokens.reasoning, 2, '推理 token 单列，不重复加进 total');
    assert.equal(src.workbuddy.total, 122, '真实 = 未缓存输入 + 输出（缓存命中不计）');
    assert.equal(src.workbuddy.all, 162, '含缓存的全量只作参考');

    assert.equal(src.codex.tokens, null, '没有 token_count 的 Codex 必须写未上报');
    assert.match(src.codex.reason, /token_count/);
    assert.equal(src.opencode.tokens, null, '读不到的库要写原因，不能写 0');
    assert.match(src.opencode.reason, /没有 OpenCode 库/);

    assert.equal(r.totals.total, 452, '真实总量只加有上报的两家（Claude 330 + WorkBuddy 122），缓存命中不计');
    assert.equal(r.totals.all, 542, '含缓存的全量只作参考');
    assert.equal(r.totals.cacheRead, 90, '缓存命中单列，不进入真实合计');
    assert.equal(r.totals.reportingSources, 2, '上报来源数要如实');
    assert.equal(r.totals.missingSources, 3, '未上报来源也要数出来');
    assert.equal(r.totals.credits, 3.5);

    assert.equal(r.injections.count, 2, '只有 action=inject 且 tokens>0 才算注入');
    assert.equal(r.injections.tokens, 3000);
    assert.equal(r.injections.max, 2000);
    assert.equal(r.injections.truncated, 1);
    assert.equal(r.injections.bySession[0].session, 'q1', '注入要能按会话聚合');
    assert.equal(r.injections.recent.length, 2, '每条注入都要留在明细里');

    assert.equal(r.readback.count, 2, '0 token 的回读不该计数');
    assert.equal(r.readback.tokens, 800);
    assert.deepEqual(r.readback.byOp.map((x) => x.op), ['steps', 'body'], '回读按 token 从大到小');

    assert.ok(fs.existsSync(`${base}/usage-cache.json`), '用量缓存要落在 store 旁边，下次只补增量');
    const before = r.scanned.hostFiles;
    fs.appendFileSync(cfile, cline('c3', 50, 5, 0));
    const r2 = usageReport(store);
    const src2 = Object.fromEntries(r2.sources.map((s) => [s.id, s]));
    assert.equal(r2.scanned.hostFiles, before, '文件数没变');
    assert.equal(src2['claude-code'].tokens.input, 350, '追加一行后只补增量，结果要和全量扫描一致');
    assert.equal(src2['claude-code'].tokens.output, 35);
    assert.equal(r2.totals.total, 507, '增量后真实总量要跟着长（Claude 385 + WorkBuddy 122）');
    assert.equal(r2.totals.all, 597, '含缓存的全量也跟着长');
    const r3 = usageReport(store, { force: true });
    const src3 = Object.fromEntries(r3.sources.map((s) => [s.id, s]));
    assert.equal(src3['claude-code'].tokens.input, 350, '--refresh 全量重扫也要得到同一结果');

    // CLI：跨会话只读，不要求 --session。
    const cli = new URL('../bin/convledger.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1').replace(/\\/g, '/');
    const env = { ...process.env };
    const jsonRun = spawnSync(process.execPath, [cli, 'usage', '--json', '--store', store], { encoding: 'utf8', env });
    assert.equal(jsonRun.status, 0, jsonRun.stderr || jsonRun.stdout);
    const parsed = JSON.parse(jsonRun.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.sources.length, 5);
    assert.equal(parsed.totals.total, 507);
    assert.equal(parsed.totals.all, 597);
    const textRun = spawnSync(process.execPath, [cli, 'usage', '--store', store], { encoding: 'utf8', env });
    assert.equal(textRun.status, 0, textRun.stderr);
    assert.match(textRun.stdout, /Qoder：.*未上报/, '文本回执也要写明未上报');
    assert.match(textRun.stdout, /真实 507/, '文本回执只报真实用量');
    assert.match(textRun.stdout, /缓存命中 90（不计）/, '缓存命中单列并注明不计');
    assert.match(textRun.stdout, /credits 3\.5/);
    const helpRun = spawnSync(process.execPath, [cli, 'help'], { encoding: 'utf8', env });
    assert.match(helpRun.stdout, /convledger usage/, '帮助里要有 usage');
  } finally {
    for (const [k, v] of [['CONVLEDGER_USAGE_HOME', saved.home], ['CONVLEDGER_OPENCODE_DB', saved.db], ['CONVLEDGER_CODEX_SRC', saved.codex]]) {
      if (v == null) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('工具归因：后台整段、回填后首个调用、工具回合分开，普通对话不计', () => {
  const base = fixture('usage-attrib');
  const home = `${base}/home`;
  const wdir = `${home}/.workbuddy/projects/proj`;
  const qdir = `${home}/.qoder/projects/proj`;
  for (const d of [wdir, qdir, `${base}/store`]) fs.mkdirSync(d, { recursive: true });
  const at = (s) => Date.UTC(2026, 10, 13, 0, 0, s);

  const human = (text, s) => JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text }], timestamp: at(s) }) + '\n';
  const call = (id, miss, out, s, name, args) => JSON.stringify({
    type: 'function_call', name, arguments: args, timestamp: at(s),
    providerData: {
      messageId: id, requestModelName: 'Hy3',
      rawUsage: { prompt_tokens: miss, completion_tokens: out, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: miss, prompt_cache_write_tokens: 0, completion_tokens_details: { reasoning_tokens: 0 } },
    },
  }) + '\n';
  // 同一真人回合：先调 convledger，再另一次普通工具调用——两次模型调用都算工具回合。
  fs.writeFileSync(`${wdir}/w-tool.jsonl`,
    human('请补账', 0) + call('m1', 100, 10, 1, 'Bash', '{"command":"node D:/x/tool/bin/convledger.mjs sync --prepare"}')
    + call('m2', 50, 5, 2, 'Read', '{"file_path":"D:/x/PROGRESS.md"}')
    + human('普通聊天', 10) + call('m3', 80, 8, 11, 'Read', '{"file_path":"D:/x/readme.md"}'));
  // 后台收尾会话：整段都算工具用量，哪怕这次调用没有 convledger 字样。
  fs.writeFileSync(`${wdir}/w-bg.jsonl`, human('后台收尾', 0) + call('b1', 30, 3, 1, 'Read', '{"file_path":"D:/x/PROGRESS.md"}'));
  fs.writeFileSync(`${base}/store/internal-sessions.json`, JSON.stringify({ sids: { 'w-bg': { at: '2026-11-13T00:00:00.000Z' } } }));
  // Qoder 只有 credits：同一工具回合内的两次请求都要算进工具相关 credits。
  const qline = (id, credits, s, tool) => JSON.stringify({
    type: 'assistant', timestamp: new Date(at(s)).toISOString(),
    message: {
      id, model: 'dfmodel',
      content: tool ? [{ type: 'tool_use', name: 'Bash', input: { command: 'node D:/x/tool/bin/convledger.mjs progress' } }] : [{ type: 'text', text: 'ok' }],
    },
    usage: { request_id: id, input_tokens: 0, output_tokens: 0, credits, context_usage_ratio: 0.2 },
  }) + '\n';
  const qhuman = JSON.stringify({ type: 'user', timestamp: new Date(at(0)).toISOString(), humanInput: { text: '补账', mode: 'prompt' }, message: { content: [{ type: 'text', text: '补账' }] } }) + '\n';
  fs.writeFileSync(`${qdir}/q-tool.jsonl`, qhuman + qline('r1', 2, 1, true) + qline('r2', 1, 2, false) + qhuman + qline('r3', 0.5, 11, false));
  // 回填探针：0.5 秒后第一个模型调用是 m1，回填实际用量就是 m1 的真实用量。
  fs.writeFileSync(`${base}/hook-probe.jsonl`, JSON.stringify({ ts: new Date(at(0) + 500).toISOString(), action: 'inject', event: 'SessionStart', session: 'w-tool', tokens: 100 }) + '\n');

  const saved = { home: process.env.CONVLEDGER_USAGE_HOME, db: process.env.CONVLEDGER_OPENCODE_DB, codex: process.env.CONVLEDGER_CODEX_SRC };
  process.env.CONVLEDGER_USAGE_HOME = home;
  process.env.CONVLEDGER_OPENCODE_DB = `${base}/missing-opencode.db`;
  process.env.CONVLEDGER_CODEX_SRC = `${home}/.codex/sessions`;
  try {
    const r = usageReport(`${base}/store`);
    const tool = r.totals.tool;
    assert.equal(tool.injection.real, 110, '回填实际用量是注入后第一个模型调用（m1）');
    assert.equal(tool.injection.events, 1);
    assert.equal(tool.injection.unmatched, 0);
    assert.equal(tool.background.real, 33, '后台会话整段都算工具用量');
    assert.deepEqual([tool.background.sessions, tool.background.calls], [1, 1]);
    assert.equal(tool.turns.real, 55, '同一回合里工具调用之后的模型调用也算工具回合；m1 已归回填，不再重复');
    assert.equal(tool.turns.turnCount, 2, 'WorkBuddy 与 Qoder 各一个工具回合');
    assert.equal(tool.ordinary.real, 88, '没用本工具的普通对话不计数');
    assert.equal(tool.totalReal, 198, '工具相关 = 后台 33 + 回填 110 + 工具回合 55');
    assert.equal(tool.background.credits, 0);
    assert.ok(Math.abs(tool.turns.credits - 3) < 1e-9, `Qoder 工具回合 credits 应为 3，实际 ${tool.turns.credits}`);
    assert.ok(Math.abs(tool.ordinary.credits - 0.5) < 1e-9, '普通对话的 credits 不进工具相关');
    assert.ok(Math.abs(tool.totalCredits - 3) < 1e-9);

    const w = r.sources.find((s) => s.id === 'workbuddy');
    assert.deepEqual([w.toolReal, w.backgroundReal, w.injectionReal, w.turnReal, w.ordinaryReal], [198, 33, 110, 55, 88]);
    const q = r.sources.find((s) => s.id === 'qoder');
    assert.ok(Math.abs(q.toolCredits - 3) < 1e-9, 'Qoder 工具相关 credits 只算工具回合');

    const wt = r.sessions.find((s) => s.id === 'w-tool');
    assert.deepEqual([wt.toolReal, wt.toolTurns, wt.toolCalls], [165, 1, 1], '会话级工具用量 = 回填 + 工具回合');
    assert.equal(r.sessions.find((s) => s.id === 'w-bg').toolReal, 33);

    const cli = new URL('../bin/convledger.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1').replace(/\\/g, '/');
    const text = spawnSync(process.execPath, [cli, 'usage', '--store', `${base}/store`], { encoding: 'utf8', env: { ...process.env } });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /工具相关真实 198 tok · 后台 33 · 回填 110 · 工具回合 55 · 普通对话 88（不计）/);
  } finally {
    for (const [k, v] of [['CONVLEDGER_USAGE_HOME', saved.home], ['CONVLEDGER_OPENCODE_DB', saved.db], ['CONVLEDGER_CODEX_SRC', saved.codex]]) {
      if (v == null) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('写身份：歧义、错项目、没有 cwd 都是拒绝，不是猜（L1.1 / A05 A08）', () => {
  const base = fixture('identity');
  const A = '12345678-aaaa-0000-0000-000000000000';
  const B = '12345678-bbbb-0000-0000-000000000000';
  const C = 'cccc9999-0000-0000-0000-000000000000';
  const sessions = [
    { sessionId: A, runner: 'qoder', file: '', cwd: 'D:/work/a', mtime: '2026-10-02T00:00:00.000Z' },
    { sessionId: B, runner: 'qoder', file: '', cwd: 'D:/work/a', mtime: '2026-10-01T00:00:00.000Z' },
    { sessionId: C, runner: 'qoder', file: '', cwd: 'D:/work/c', mtime: '2026-09-30T00:00:00.000Z' },
  ];
  const r1 = resolveWriteTarget({ root: base, cwd: 'D:/work/a', session: '12345678', sessions });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'ambiguous-session', '同前缀两段会话必须拒绝，不能取第一个');
  assert.equal(r1.candidates.length, 2);

  const r2 = resolveWriteTarget({ root: base, cwd: 'D:/work/a', session: A, sessions });
  assert.equal(r2.ok, true, r2.error);
  assert.equal(r2.sessionId, A, '完整 id 即使与前缀重复也要精确命中');
  assert.equal(r2.projectKey, projectKey('D:/work/a'));
  assert.equal(r2.sourceMode, 'source');

  assert.equal(resolveWriteTarget({ root: base, cwd: 'D:/work/a', sessions }).code, 'no-session');
  assert.equal(resolveWriteTarget({ root: base, cwd: 'D:/work/a', session: '1234', sessions }).code, 'short-prefix');
  const wrong = resolveWriteTarget({ root: base, cwd: 'D:/work/a', session: C, sessions });
  assert.equal(wrong.code, 'project-mismatch', '会话属于 D:/work/c，不能写进 D:/work/a 的项目');
  assert.equal(resolveWriteTarget({ root: base, cwd: 'D:/work/a', session: 'ffff0000', sessions }).code, 'no-such-session');

  // 源被运行器清掉、账本还在：允许写，但必须声明读自归档
  fs.mkdirSync(`${base}/${C}`, { recursive: true });
  fs.writeFileSync(`${base}/${C}/ledger.json`, JSON.stringify({ sessionId: C, cwd: 'D:/work/c', segments: [] }));
  const kept = resolveWriteTarget({ root: base, cwd: 'D:/work/c', session: 'cccc9999', sessions: sessions.filter((s) => s.sessionId !== C) });
  assert.equal(kept.ok, true, kept.error);
  assert.equal(kept.sourceMode, 'archived', '源没了仍认账本，但来源要标 archived');
  assert.equal(kept.indexed, true);
  fs.rmSync(base, { recursive: true, force: true });
});

test('冻结区间：完整换行与完整哈希，改写/截断/坏行都拒绝（L1.2 / A09 A20）', () => {
  const base = fixture('freeze');
  const file = `${base}/sess.jsonl`;
  const l1 = JSON.stringify({ type: 'user', uuid: 'u1', message: { content: [{ type: 'text', text: '第一句中文，跨缓冲区也不许切在字符中间' }] } });
  const l2 = JSON.stringify({ type: 'assistant', uuid: 'u2', message: { content: [{ type: 'text', text: '第二句' }] } }) + '\r';
  const l3 = JSON.stringify({ type: 'user', uuid: 'u3', message: { content: [{ type: 'text', text: '第三句' }] } });
  fs.writeFileSync(file, `${l1}\n${l2}\n${l3}\n`);
  const ledger = { sourceFile: file, runner: 'qoder' };

  const f1 = freezeSource(ledger);
  assert.equal(f1.ok, true, f1.error);
  assert.equal(f1.toByte, fs.statSync(file).size, '冻结到最后一个完整换行');
  assert.equal(f1.records.length, 3);
  assert.equal(f1.batchSha256.length, 64, '快照证据要用完整 SHA-256，不能拿 12 位短哈希冒充');
  assert.equal(f1.prefixSha256.length, 64);
  assert.equal(f1.records[1].type, 'assistant', 'CRLF 行照样可解析');
  assert.equal(f1.records[2].uuid, 'u3');
  assert.equal(f1.halfLine.bytes, 0);

  // 追加一条完整行 + 一条半行：只消费完整的那条
  const l4 = JSON.stringify({ type: 'assistant', uuid: 'u4', message: { content: [{ type: 'text', text: '第四句' }] } });
  fs.appendFileSync(file, `${l4}\n{"type":"user","uuid":"u5","message":{"content":[{"type":"te`);
  const f2 = freezeSource(ledger, { fromByte: f1.toByte });
  assert.equal(f2.ok, true, f2.error);
  assert.equal(f2.records.length, 1, '半行不能被消费');
  assert.ok(f2.halfLine.bytes > 0);
  assert.equal(f2.fromLine, 4, '续批的行号接着上一批');

  const v1 = verifyFrozen(f1, { ledger });
  assert.equal(v1.ok, true, v1.code);
  assert.ok(v1.appendedBytes > 0, '追加是正常增长，不算改写');

  // 区间内改写：同一偏移换一个字节
  const buf = fs.readFileSync(file);
  const at = f1.records[0].fromByte + 10;
  const swapped = Buffer.from(buf);
  swapped[at] = swapped[at] === 0x61 ? 0x62 : 0x61;
  fs.writeFileSync(file, swapped);
  assert.equal(verifyFrozen(f1, { ledger }).code, 'range-rewritten', '冻结区间被改写必须拒绝');
  assert.equal(freezeSource(ledger, { fromByte: f1.toByte + 3 }).code, 'misaligned', '不在行首的位置不能当检查点');

  // 前缀改写：上一批之前的内容变了
  fs.writeFileSync(file, `${l1}\n${l2}\n${l3}\n${l4}\n`);
  const f3 = freezeSource(ledger, { fromByte: Buffer.byteLength(`${l1}\n${l2}\n`) });
  const prefixSwapped = fs.readFileSync(file, 'utf8').replace('第一句中文', '第一句英文');
  fs.writeFileSync(file, prefixSwapped);
  assert.equal(verifyFrozen(f3, { ledger }).code, 'prefix-rewritten', '已消费前缀被改写必须拒绝');

  // 截断：源比检查点还短
  fs.writeFileSync(file, `${l1}\n`);
  assert.equal(verifyFrozen(f3, { ledger }).code, 'truncated');

  // 完整但解析失败的行：阻塞材料，不当空数据跳过
  fs.writeFileSync(file, `${l1}\n{这不是 json}\n`);
  const bad = freezeSource(ledger);
  assert.equal(bad.ok, false);
  assert.equal(bad.badLines.length, 1);
  assert.equal(bad.badLines[0].line, 2);
  assert.match(bad.error, /阻塞材料/);

  const gone = freezeSource({ sourceFile: `${base}/nope.jsonl`, runner: 'qoder' });
  assert.equal(gone.code, 'source-missing');
  fs.rmSync(base, { recursive: true, force: true });
});

test('晚到的工具回执补进原调用，重复与孤立回执都不丢（L1.3 / A10 A18）', () => {
  const rec = (line, blocks, uuid) => ({ __line: line, uuid, message: { content: blocks } });
  const batch1 = associateTools([
    rec(1, [{ type: 'tool_use', id: 'c1', name: 'Bash', input: {} }], 'u1'),
    rec(2, [{ type: 'tool_use', id: 'c2', name: 'Read', input: {} }], 'u2'),
  ]);
  assert.equal(batch1.pending.length, 2);

  const state1 = mergePending(null, batch1, { sessionId: 's1' }).state;
  assert.equal(state1.calls.length, 2);

  // 第二批：c1 的结果晚到；另有一条重复回执和一条找不到调用的回执
  const batch2 = associateTools([
    rec(9, [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }], 'u3'),
    rec(10, [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok again' }], 'u4'),
    rec(11, [{ type: 'tool_result', tool_use_id: 'c9', content: '来自子任务' }], 'u5'),
  ]);
  assert.equal(batch2.orphans.length, 2, '本批内 c1 的重复回执记重复、c9 找不到调用——两条孤立');
  assert.equal(batch2.duplicates.length, 1, '同一调用的第二条回执是重复，不是新证据');
  const merged = mergePending(state1, batch2, { sessionId: 's1' });
  assert.deepEqual(merged.resolved.map((r) => r.id), ['c1'], '晚到的回执要补进原调用');
  assert.equal(merged.state.calls.length, 1, 'c2 仍未决');
  assert.equal(merged.state.calls[0].id, 'c2');
  assert.equal(merged.state.orphans.length, 1, '找不到调用的回执保留待关联，重复的两条不重复记');
  assert.equal(merged.state.results.filter((r) => r.id === 'c1').length, 1, '同一调用的回执只记一次');

  const root = fixture('pending');
  writePending(root, 's1', merged.state);
  const back = readPending(root, 's1');
  assert.deepEqual(back.calls.map((c) => c.id), ['c2']);
  fs.writeFileSync(`${root}/s1/pending-calls.json`, '{oops');
  assert.deepEqual(readPending(root, 's1').calls, [], '坏文件当空表读，但不能覆盖它');

  assert.equal(isMaintenanceCall({ name: 'Bash', arg: 'echo convledger sync' }), false, '提到名字不算维护回执');
  assert.equal(isMaintenanceCall({ name: 'Bash', arg: 'node D:/tool/bin/convledger.mjs sync --prepare' }), true, '维护调用按命令形状认');
  assert.equal(isMaintenanceCall({ name: 'Write', arg: 'convledger.mjs sync' }), false, '不是命令调用就不算维护回执');
  fs.rmSync(root, { recursive: true, force: true });
});

test('项目任务：done 必须被验收撑住，范围/取消/建议分开算（L2.1 / A01–A05 A23）', () => {
  const st = createState('p-test');
  st.milestones.push({ id: 'PM001', short: '骨架', title: '骨架', goal: '把结构立起来', scopeBasis: { kind: 'approved-plan' } });
  const task = (id, extra) => ({
    id, revision: 1, milestoneId: 'PM001', dependsOn: [], scopeBasis: { kind: 'user-request', ref: 'R1' },
    short: `任务${id.slice(-1)}`, title: `任务${id.slice(-1)}`, goal: 'g', status: 'planned',
    result: null, remaining: null, blocker: null, nextAction: null, acceptance: [], evidence: [], actor: 'a', sourceSessions: ['s1'],
    occurredAt: null, recordedAt: '2026-10-28T00:00:00.000Z', ...extra,
  });
  st.tasks.push(task('PT001', {
    status: 'done', result: '骨架已建',
    acceptance: [{ id: 'A1', condition: '自测通过', required: true, kind: 'test', result: 'pass', verifier: 'selftest', targetVersion: 'v1', evidence: [{ ref: 'selftest', version: 'v1' }] }],
  }));
  const ok = validateState(st);
  assert.equal(ok.ok, true, ok.errors.join(' | '));
  assert.equal(effectiveStatus(st.tasks[0]).status, 'done');
  assert.equal(counts(st).project.done, 1);

  // 验收证据失效：保留历史，但当前不再是 done，也退出完成计数
  st.tasks[0].acceptance[0].stale = true;
  assert.equal(effectiveStatus(st.tasks[0]).status, 'unknown');
  assert.match(effectiveStatus(st.tasks[0]).reason, /acceptance-stale/);
  assert.equal(counts(st).project.done, 0, '证据失效的完成不能继续算完成');
  assert.equal(counts(st).project.inScope, 1, '它仍在范围内，只是不算完成');
  st.tasks[0].acceptance[0].stale = false;

  // 标完成但没有验收 / 有验收但没证据：当场拒绝
  assert.ok(validateTask(task('PT009', { status: 'done', acceptance: [] }), { milestones: st.milestones }).some((e) => /没有任何必做验收/.test(e)));
  assert.ok(validateTask(task('PT009', { status: 'done', acceptance: [{ id: 'A1', condition: 'x', kind: 'test', result: 'pass', evidence: [] }] }), { milestones: st.milestones }).some((e) => /通过却没有证据/.test(e)));
  assert.ok(validateTask(task('PT009', { status: 'done', acceptance: [{ id: 'A1', condition: 'x', kind: 'test', result: 'waived', evidence: [] }] }), { milestones: st.milestones }).some((e) => /豁免必须指向用户原话/.test(e)));

  // 范围：模型建议不进分母；取消不计完成；受阻要写阻塞条件；同名任务允许
  st.tasks.push(task('PT002', { short: '同名任务', status: 'active', scopeBasis: { kind: 'model-suggestion', ref: null } }));
  st.tasks.push(task('PT003', { short: '同名任务', status: 'active' }));
  st.tasks.push(task('PT004', { status: 'cancelled', cancelledBy: '用户取消' }));
  const c = counts(st);
  assert.equal(c.project.inScope, 2, '模型建议与取消都不在分母里');
  assert.equal(c.scopeUnknown, 1);
  // 建议任务做完也不许进分子：以前 done 落进 else-if，一条建议任务能顶出「完成 49 / 纳入范围 48」
  const sug = st.tasks.find((x) => x.id === 'PT002');
  sug.status = 'done'; sug.result = '建议任务做完了';
  sug.acceptance = [{ id: 'A1', condition: '自测通过', required: true, kind: 'test', result: 'pass', verifier: 'selftest', targetVersion: 'v1', evidence: [{ ref: 'selftest', version: 'v1' }] }];
  assert.equal(counts(st).project.done, 1, '范围外的建议任务不能进完成数（这 1 条是范围内的 PT001）');
  assert.equal(counts(st).project.inScope, 2, '它做完也不该进分母');
  assert.ok(validateTask(task('PT009', { status: 'blocked' }), { milestones: st.milestones }).some((e) => /没写阻塞条件/.test(e)));

  // 依赖：自环与环都拒绝
  st.tasks.push(task('PT005', { dependsOn: ['PT006'], status: 'planned' }));
  st.tasks.push(task('PT006', { dependsOn: ['PT005'], status: 'planned' }));
  assert.deepEqual([...new Set(dependencyCycle(st.tasks))].sort(), ['PT005', 'PT006'], '环上的每个任务都要被点名');
  assert.ok(validateState(st).errors.some((e) => /依赖成环/.test(e)));
  st.tasks = st.tasks.filter((t) => !['PT005', 'PT006'].includes(t.id));

  const v = projectView(st);
  assert.equal(v.tasks.length, 4);
  assert.equal(v.tasks.find((t) => t.id === 'PT001').status, 'done');
});

test('批次提交：同批重放不重复，异文/过期基准拒绝，崩在写盘前不落盘（L2.2–2.3 / A06 A11 A12）', () => {
  const root = fixture('state');
  const key = 'p-x';
  const apply = (s) => applyBatch(s, { taskChanges: [{ localKey: 't1', short: '任务一', status: 'planned', scopeBasis: { kind: 'user-request', ref: 'R1' } }] });

  const c1 = commitBatch(root, key, { batchId: 'b1', requestSha: 'r1', baseRevision: 0, apply });
  assert.equal(c1.replayed, false);
  assert.equal(c1.receipt.projectRevision, 1);
  assert.deepEqual(c1.receipt.newTasks, ['PT001']);

  const again = commitBatch(root, key, { batchId: 'b1', requestSha: 'r1', baseRevision: 0, apply });
  assert.equal(again.replayed, true, '同批同载荷重放要返回原回执');
  assert.equal(again.state.revision, 1);
  assert.equal(again.state.tasks.length, 1, '重放不能重复建任务');

  assert.throws(() => commitBatch(root, key, { batchId: 'b1', requestSha: 'r2', baseRevision: 0, apply }), (e) => e.code === 'conflict', '同批不同载荷必须冲突');
  assert.throws(() => commitBatch(root, key, { batchId: 'b2', requestSha: 'r2', baseRevision: 0, apply }), (e) => e.code === 'conflict', '基准版本过期必须冲突');

  // 崩溃注入：beforeWrite 抛错 → 状态与批次一起回到提交前
  assert.throws(() => commitBatch(root, key, { batchId: 'b3', requestSha: 'r3', baseRevision: 1, apply, beforeWrite: () => { throw new Error('boom'); } }));
  const after = readState(root, key).state;
  assert.equal(after.revision, 1, '崩在写盘前，revision 不能前进');
  assert.equal(after.tasks.length, 1);
  assert.equal(after.batches.length, 1, '失败批次不留回执');
  assert.equal(after.checkpoints?.s3, undefined);

  const retry = commitBatch(root, key, { batchId: 'b3', requestSha: 'r3', baseRevision: 1, apply });
  assert.equal(retry.replayed, false);
  assert.equal(retry.state.revision, 2);

  // 未知 schema / 坏 JSON：拒绝，不按空表重写
  fs.writeFileSync(stateFile(root, key), JSON.stringify({ schema: 99 }));
  assert.throws(() => readState(root, key), (e) => e.code === 'unknown-schema');
  fs.writeFileSync(stateFile(root, key), '{oops');
  assert.throws(() => readState(root, key), (e) => e.code === 'bad-state');
  fs.rmSync(root, { recursive: true, force: true });
});

test('两个进程同基准提交：一个成功、一个冲突，没有丢失更新（L2.2 / A06）', async () => {
  const base = fixture('race');
  const script = `${base}/worker.mjs`;
  fs.writeFileSync(script, `import { commitBatch } from ${JSON.stringify(pathToFileURL(`${tools}/src/state-io.mjs`).href)};
import { applyBatch } from ${JSON.stringify(pathToFileURL(`${tools}/src/progress.mjs`).href)};
const [root, key, id, base] = process.argv.slice(2);
try {
  const r = commitBatch(root, key, { batchId: id, requestSha: id, baseRevision: Number(base), apply: (s) => applyBatch(s, { taskChanges: [{ localKey: id, short: '并发任务', status: 'planned', scopeBasis: { kind: 'user-request', ref: 'R' } }] }) });
  console.log(JSON.stringify({ ok: true, revision: r.state.revision, replayed: r.replayed }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, code: e.code ?? 'error', error: String(e.message) }));
  process.exitCode = 2;
}
`);
  const run = (id) => new Promise((resolve) => {
    const p = spawn(process.execPath, [script, `${base}/store`, 'p-race', id, '0'], { cwd: tools });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
  const [r1, r2] = await Promise.all([run('w1'), run('w2')]);
  const rows = [r1, r2].map((r) => JSON.parse(r.out.trim().split('\n').pop()));
  const winners = rows.filter((x) => x.ok);
  const losers = rows.filter((x) => !x.ok);
  assert.equal(winners.length, 1, `应该只有一方成功：${JSON.stringify(rows)}`);
  assert.equal(winners[0].revision, 1);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].code, 'conflict', '另一方必须是版本冲突，不能静默覆盖');
  const final = readState(`${base}/store`, 'p-race').state;
  assert.equal(final.revision, 1);
  assert.equal(final.tasks.length, 1, '两个进程都写成功就会丢一个任务');
  fs.rmSync(base, { recursive: true, force: true });
});

test('prepare 不推进游标：追加放行、改写拒绝，批次身份由素材决定（L2.3 / A09 A12）', () => {
  const base = fixture('prepare');
  const file = `${base}/sess.jsonl`;
  const line = (n) => JSON.stringify({ type: 'user', uuid: `u${n}`, message: { content: [{ type: 'text', text: `第${n}句` }] } });
  fs.writeFileSync(file, `${line(1)}\n${line(2)}\n`);
  const ledger = { sourceFile: file, runner: 'qoder' };
  const p1 = prepareBatch({ ledger, projectKey: 'p-p', sessionId: 's1', baseRevision: 0 });
  assert.equal(p1.frozen.records.length, 2);
  assert.equal(p1.batchId.length, 24);
  assert.equal(fs.existsSync(stateFile(`${base}/store`, 'p-p')), false, 'prepare 不能写状态文件');

  const p2 = prepareBatch({ ledger, projectKey: 'p-p', sessionId: 's1', baseRevision: 0 });
  assert.equal(p2.batchId, p1.batchId, '同样素材重来要得到同一个批次身份');

  fs.appendFileSync(file, `${line(3)}\n`);
  const ok = verifyPrepared(p1, { ledger });
  assert.equal(ok.ok, true, ok.code);
  assert.ok(ok.appendedBytes > 0);
  assert.equal(ok.consumedTo, p1.frozen.toByte, '批次覆盖的仍是冻结时那段');

  const buf = fs.readFileSync(file);
  buf[p1.frozen.records[0].fromByte + 5] ^= 0x01;
  fs.writeFileSync(file, buf);
  assert.equal(verifyPrepared(p1, { ledger }).code, 'range-rewritten');
  fs.rmSync(base, { recursive: true, force: true });
});

test('补账素材剔除工具回执与系统控制记录', () => {
  const s = synthStore({ asks: 2, sid: 'synth-material-01' });
  const frozen = freezeSource(s.ledger, { fromByte: 0 });
  const m = materialUnits(frozen, { runner: s.ledger.runner, budget: Number.MAX_SAFE_INTEGER });
  assert.ok(m.units.length > 0, '过滤后仍要有真人原话/结论/调用摘要');
  assert.ok(m.units.some((u) => /\[call Edit\]/.test(u.text)), '调用摘要要保留，作为状态变化线索');
  assert.ok(m.units.some((u) => /第1件/.test(u.text)), '真人原话要保留');
  assert.ok(!m.units.some((u) => /\[result\]|已写入/.test(u.text)), '工具回执不能进补账素材');
  assert.ok(!m.units.some((u) => /workspace-directories|runtime-config/.test(u.text)), '控制记录不能进补账素材');
  assert.ok(m.units.length < frozen.records.length, '过滤后单元数必须少于原始行数');
  fs.rmSync(s.base, { recursive: true, force: true });
});

test('记忆表 v2 与发布：v1 备份、未知 schema 拒读、同 operationId 重放不重复（L4 / A13 A15 A17）', (t) => {
  const f = memoryFixture();
  if (!f.say) { t.skip('CALIBRATION 那段源整份没有中文真人原话（全是英文与工具回执），say 类证据造不出来'); return; }
  const file = `${projectMemoryDir(f.root, f.project.key)}/memories.json`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema: 'convledger-memories/1', scope: 'project', project: f.project.key, entries: [{ id: 'M01', class: '规则', topic: '旧', text: '旧的', evidence: [] }] }));

  const upgraded = readProjectMemories(f.root, f.project.key);
  assert.equal(upgraded.schema, 'convledger-memories/2');
  assert.equal(upgraded.entries[0].id, 'M01', '升级不能丢条目 ID');
  assert.ok(fs.existsSync(`${file}.v1.bak`), '升级前必须留逐字备份');
  assert.equal(JSON.parse(fs.readFileSync(`${file}.v1.bak`, 'utf8')).schema, 'convledger-memories/1');

  fs.writeFileSync(file, JSON.stringify({ schema: 'someone-else/9', entries: [] }));
  assert.throws(() => readProjectMemories(f.root, f.project.key), (e) => e.code === 'unknown-schema', '未知 schema 不能当空表读');
  fs.rmSync(file);

  const evr = { sid: f.sid8, seg: 'S01', hash: f.hash.S01, kind: 'claim', quote: '夹具规则一：先测再改' };
  const evs = { sid: f.sid8, seg: f.say.seg, hash: f.hash[f.say.seg], kind: 'say', quote: f.say.quote };
  const cand = { class: '规则', topic: '夹具规则', text: '夹具规则：先写测试再改代码', evidence: [evr, evs] };

  const p1 = publishCandidates(f.root, f.project, [cand], { operationId: 'pub-b1' });
  assert.equal(p1.ok, true, p1.errors.join('；'));
  assert.deepEqual(p1.added, ['M01']);
  const doc1 = readProjectMemories(f.root, f.project.key);
  assert.equal(doc1.revision, 1);
  assert.equal(doc1.appliedOperations.length, 1);
  assert.equal(doc1.history.length, 1);

  const p2 = publishCandidates(f.root, f.project, [cand], { operationId: 'pub-b1' });
  assert.equal(p2.replayed, true, '同 operationId 要回原结果');
  const doc2 = readProjectMemories(f.root, f.project.key);
  assert.equal(doc2.entries.length, 1, '重放不能写第二遍');
  assert.equal(doc2.revision, 1, '重放不能推进版本');

  const p3 = publishCandidates(f.root, f.project, [{ ...cand, text: '改过的文字' }], { operationId: 'pub-b1' });
  assert.equal(p3.ok, false);
  assert.match(p3.errors.join(), /另一批内容/);

  const before = readProjectMemories(f.root, f.project.key);
  const bad = publishCandidates(f.root, f.project, [{ class: '规则', topic: '没证据的规则', text: '没有 rule 证据的规则', evidence: [evs] }], { operationId: 'pub-b2' });
  assert.equal(bad.ok, false, '缺 rule claim 的规则不该过闸门');
  const after = readProjectMemories(f.root, f.project.key);
  assert.equal(after.revision, before.revision, '闸门不过不能推进记忆版本');
  assert.equal(after.entries.length, before.entries.length);

  const st = createState('p-x');
  st.candidates.push({ id: 'C001', state: 'candidate', class: '规则' });
  assert.throws(() => transitionCandidate(st, 'C001', 'published'), /不能从 candidate 变成 published/, '候选不能直接喊成已发布');
  assert.equal(transitionCandidate(st, 'C001', 'eligible').state, 'eligible');
  assert.throws(() => transitionCandidate(st, 'C999', 'eligible'), /没有候选/);
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('收尾检查：有未分析素材且本轮有人类消息才提示，同一轮不重复（L5 / A18）', () => {
  const base = fixture('closeout');
  const SID = 'hookstop00000001';
  const src = `${base}/projects/fixture/${SID}.jsonl`;
  fs.mkdirSync(`${base}/projects/fixture`, { recursive: true });
  fs.writeFileSync(src, fs.readFileSync(synthStore({ asks: 20, sid: 'synthclose00001' }).file, 'utf8'));
  const cwd = cwdFromHead(src);
  assert.ok(cwd, '夹具源里该有 cwd');
  const store = `${base}/store`;
  fs.mkdirSync(`${store}/${SID}`, { recursive: true });
  fs.writeFileSync(`${store}/${SID}/ledger.json`, JSON.stringify({ sessionId: SID, runner: 'qoder', cwd, sourceFile: src }));

  const key = projectKey(cwd);
  const st = createState(key);
  st.milestones.push({ id: 'PM001', short: '验收芯', title: '验收芯', goal: '', scopeBasis: { kind: 'approved-plan' } });
  st.tasks.push({
    id: 'PT001', revision: 1, milestoneId: 'PM001', dependsOn: [], scopeBasis: { kind: 'user-request', ref: 'R' },
    short: '夹具任务', title: '夹具任务', goal: '', status: 'active', result: null, remaining: null, blocker: null,
    nextAction: null, acceptance: [], evidence: [], actor: null, sourceSessions: [SID],
    occurredAt: null, recordedAt: '2026-10-29T00:00:00.000Z',
  });
  writeState(store, key, st);

  const env = { ...process.env, QODER_CONFIG_DIR: base, WORKBUDDY_CONFIG_DIR: `${base}/nowb`, CONVLEDGER_HOOK_STORE: store, CONVLEDGER_HOOK_LOG: `${base}/log.jsonl` };
  const hook = (extra = {}) => spawnSync(process.execPath, ['hooks/ledger-brief.mjs'], {
    cwd: tools, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env,
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: SID, transcript_path: src, cwd, stop_hook_active: false, ...extra }),
  });

  const first = hook();
  assert.equal(first.status, 0, first.stderr);
  const decision = JSON.parse(first.stdout);
  assert.equal(decision.decision, 'block', '有未分析素材时应当让当前 agent 继续收尾');
  assert.match(decision.reason, /sync --prepare --project p-/);
  assert.match(decision.reason, new RegExp(SID.slice(0, 8)));
  assert.ok(!/已提交|已完成|修复了/.test(decision.reason), '提示里不能替 agent 写结论');
  assert.match(decision.reason, /后台|另起/, '收尾信号要指向后台会话，不在当前对话里逐批磨');
  assert.match(decision.reason, /真人消息/, '收尾提示要报人话数，而不是只报原始行数');
  assert.match(decision.reason, /有效素材单元/, '收尾提示要报过滤后的素材单元');
  assert.match(decision.reason, /工具回执（不进补账素材）/, '工具回执必须明确排除在补账素材之外');
  assert.doesNotMatch(decision.reason, /条新记录/, '不能继续把原始 JSONL 行数叫成新记录');

  const second = hook();
  assert.equal(second.stdout, '', '同一轮（同一批素材、同一人类消息）不能再提示一次');

  // 同一份收尾提示，只把账本 runner 换成 Claude Code：派活文案必须跟着能力表换成
  // 这家的 Agent 工具，不能把 Qoder 的会话命令或过时的 Task 写给模型（真机 2026-11-13 踩过）。
  const ledgerFile = `${store}/${SID}/ledger.json`;
  fs.writeFileSync(ledgerFile, JSON.stringify({ sessionId: SID, runner: 'claude-code', cwd, sourceFile: src }));
  fs.rmSync(`${store}/${SID}/closeout-prompt.json`, { force: true });
  const cc = hook();
  assert.equal(cc.status, 0, cc.stderr);
  const ccd = JSON.parse(cc.stdout);
  assert.equal(ccd.decision, 'block');
  assert.match(ccd.reason, /用 Agent 工具/);
  assert.match(ccd.reason, /run_in_background: true/);
  assert.doesNotMatch(ccd.reason, /create_chat_session|用 Task 工具/);
  fs.writeFileSync(ledgerFile, JSON.stringify({ sessionId: SID, runner: 'qoder', cwd, sourceFile: src }));
  fs.rmSync(`${store}/${SID}/closeout-prompt.json`, { force: true });

  const active = hook({ stop_hook_active: true });
  assert.equal(active.stdout, '', 'stop_hook_active=true 必须放行，防循环');

  // 还没有任务表：不是不提示，而是提示「从素材建首批任务」——否则项目页永远是空的
  fs.rmSync(`${base}/projects/${key}/progress-state.json`, { force: true });
  fs.rmSync(`${store}/${SID}/closeout-prompt.json`, { force: true });
  const boot = hook();
  assert.equal(boot.status, 0, boot.stderr);
  const bd = JSON.parse(boot.stdout);
  assert.equal(bd.decision, 'block', '没有任务表的项目也要提示建表，不能静默跳过');
  assert.match(bd.reason, /还没有任务表/, '提示要说清这是首次建表');
  assert.match(bd.reason, /localKey/, '提示要说明首批任务用 localKey 新建');
  const boot2 = hook();
  assert.equal(boot2.stdout, '', '同一轮不能重复提示建表');
  fs.rmSync(base, { recursive: true, force: true });
});

test('收尾与补账各认各的档位：every5 收尾数真人回合，hosts 可逐 Agent 覆盖', () => {
  const base = fixture('cadence-split');
  const store = `${base}/store`;
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(`${store}/prefs.json`, JSON.stringify({
    schema: 'convledger-prefs/1',
    summaryCadence: 'every5',
    closeoutCadence: 'each',
    hosts: { workbuddy: { summaryCadence: 'compact', closeoutCadence: 'compact' } },
  }, null, 1));
  const qoder = resolvePrefs(store, { runner: 'qoder' });
  assert.equal(qoder.summaryCadence, 'every5', '综述档位要独立读取');
  assert.equal(qoder.closeoutCadence, 'each', '收尾档位不能被综述档位替代');
  const wb = resolvePrefs(store, { runner: 'workbuddy' });
  assert.equal(wb.summaryCadence, 'compact', 'Agent 级综述覆盖要生效');
  assert.equal(wb.closeoutCadence, 'compact', 'Agent 级收尾覆盖要生效');
  assert.deepEqual(HOST_DEFAULTS, {}, '不再给 WorkBuddy 写死内置压缩时；默认跟机器级');
  fs.rmSync(base, { recursive: true, force: true });
});

test('收尾 every5：3 个真人回合先等，6 个才放行（与缺块补账分开）', () => {
  const run = (asks, sid) => {
    const s = synthStore({ asks, sid: `synth${sid.slice(-8)}` });
    const src = `${s.base}/projects/fixture/${sid}.jsonl`;
    fs.mkdirSync(`${s.base}/projects/fixture`, { recursive: true });
    fs.writeFileSync(src, fs.readFileSync(s.file, 'utf8'));
    const cwd = cwdFromHead(src);
    const store = `${s.base}/store`;
    fs.mkdirSync(`${store}/${sid}`, { recursive: true });
    fs.writeFileSync(`${store}/${sid}/ledger.json`, JSON.stringify({ sessionId: sid, runner: 'qoder', cwd, sourceFile: src }));
    fs.writeFileSync(`${store}/prefs.json`, JSON.stringify({
      schema: 'convledger-prefs/1', summaryCadence: 'every5', closeoutCadence: 'every5',
    }, null, 1));
    const logFile = `${s.base}/log.jsonl`;
    const r = spawnSync(process.execPath, ['hooks/ledger-brief.mjs'], {
      cwd: tools, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, QODER_CONFIG_DIR: s.base, WORKBUDDY_CONFIG_DIR: `${s.base}/nowb`,
        CONVLEDGER_HOOK_STORE: store, CONVLEDGER_HOOK_LOG: logFile },
      input: JSON.stringify({ hook_event_name: 'Stop', session_id: sid, transcript_path: src, cwd, stop_hook_active: false }),
    });
    const logs = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    fs.rmSync(s.base, { recursive: true, force: true });
    return { out: String(r.stdout || '').trim(), logs };
  };
  const three = run(3, 'hookcad00000003');
  assert.equal(three.out, '', '3 个真人回合还不够 5 轮，收尾不该拦');
  assert.match(three.logs, /closeout-every5-wait\(3\/5\)/, '收尾要按真人回合报等待，而不是缺块数');
  const six = run(6, 'hookcad00000006');
  assert.ok(six.out, '6 个真人回合应当放行收尾');
  assert.equal(JSON.parse(six.out).decision, 'block', '攒够 5 个真人回合后应派收尾');
});

test('自我排除：convledger 自己的后台会话（源头带哨兵）不触发收尾，防无限派生', () => {
  const base = fixture('internal');
  const SID = 'internalbg000001';
  const src = `${base}/projects/fixture/${SID}.jsonl`;
  fs.mkdirSync(`${base}/projects/fixture`, { recursive: true });
  // 前 8KB 带哨兵即可命中（检查是字节级）；后面接真实记录，保证是段像样的会话
  fs.writeFileSync(src, '{"note":"convledger-internal"}\n' + fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).slice(0, 80).join('\n') + '\n');
  const store = `${base}/store`;
  fs.mkdirSync(`${store}/${SID}`, { recursive: true });
  fs.writeFileSync(`${store}/${SID}/ledger.json`, JSON.stringify({ sessionId: SID, runner: 'qoder', cwd: 'D:/fixture/internal', sourceFile: src }));
  const env = { ...process.env, QODER_CONFIG_DIR: base, WORKBUDDY_CONFIG_DIR: `${base}/nowb`, CONVLEDGER_HOOK_STORE: store, CONVLEDGER_HOOK_LOG: `${base}/log.jsonl` };
  const r = spawnSync(process.execPath, ['hooks/ledger-brief.mjs'], {
    cwd: tools, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env,
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: SID, transcript_path: src, cwd: 'D:/fixture/internal', stop_hook_active: false }),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', '源头带 convledger-internal 哨兵的会话不该触发收尾（否则无限派生）');
  fs.rmSync(base, { recursive: true, force: true });
});

test('端口被占兜底：isPortFree 判得准、findOpenPort 跳过被监听端口顺延到空位', async () => {
  let srv = null, occupied = null;
  for (let p = 18800; p < 18840 && !srv; p++) {
    const s = net.createServer(() => {});
    try { await new Promise((res, rej) => { s.once('error', rej); s.listen(p, '127.0.0.1', res); }); srv = s; occupied = p; }
    catch { try { s.close(); } catch { /* 换下一个 */ } }
  }
  assert.ok(srv, '找不到可用的测试监听端口');
  try {
    assert.equal(await isPortFree(occupied), false, '被监听的端口不能算空闲');
    const alt = await findOpenPort(occupied);
    assert.ok(Number.isInteger(alt) && alt > occupied, `8765 被占时应顺延到更大的空位，实际 ${alt}`);
    assert.equal(await isPortFree(alt), true, '顺延到的端口应空闲');
  } finally {
    await new Promise((res) => srv.close(res));
  }
});

test('内部会话登记后从会话库与画像统计隐藏（后台工作会话复用，防越开越多）', () => {
  const base = fixture('internal-reg'); fs.rmSync(base, { recursive: true, force: true });
  const root = `${base}/store`; fs.mkdirSync(root, { recursive: true });
  const mk = (id, iso, sentinel) => {
    const dir = `${root}/${id}`; fs.mkdirSync(dir, { recursive: true });
    const sf = `${dir}/src.jsonl`;
    fs.writeFileSync(sf, sentinel ? '{"note":"convledger-internal"}\n' : '{"type":"user","cwd":"D:/f","message":{"content":"hi"}}\n');
    fs.writeFileSync(`${dir}/ledger.json`, JSON.stringify({ sessionId: id, runner: 'qoder', cwd: 'D:/f', sourceFile: sf, builtAt: new Date().toISOString(), segments: [] }));
    const t = new Date(iso); fs.utimesSync(sf, t, t);
  };
  mk('real-a', '2026-11-01T00:00:00Z', false);
  mk('real-b', '2026-11-02T00:00:00Z', false);
  mk('bgworker', '2026-11-03T00:00:00Z', true);
  addInternal(root, 'bgworker');
  assert.ok(readInternal(root).sids.bgworker, '内部会话应写进登记表');
  // worker 按宿主分开：Qoder 的工人不能被 OpenCode 拿去续派
  setWorker(root, 'bgworker', 'opencode');
  assert.equal(getWorker(root, 'opencode'), 'bgworker', 'OpenCode 的工人要记在 opencode 名下');
  assert.equal(getWorker(root), null, '设 OpenCode 工人不能覆盖默认（Qoder）工人');
  setWorker(root, 'bgworker');
  assert.equal(getWorker(root), 'bgworker', '默认工人照常可设');
  assert.equal(getWorker(root, 'opencode'), 'bgworker', '两个宿主互不干扰');
  const ids = libraryOf(root).groups.flatMap((g) => g.sessions.map((s) => s.id));
  assert.ok(!ids.includes('bgworker'), '内部会话不应出现在会话库');
  assert.ok(ids.includes('real-a') && ids.includes('real-b'), '真实会话照常列出');
  const d = profileDue(root);
  assert.equal(d.due, true, '两段真实新会话仍触发画像');
  assert.equal(d.newer, 2, '内部会话不计入画像「新会话」');
  fs.rmSync(base, { recursive: true, force: true });
});

test('第五个来源 Codex：rollout（信封格式+嵌套）投影→识别→建账', () => {
  const base = fixture('codex-src'); fs.rmSync(base, { recursive: true, force: true });
  const day = `${base}/sessions/2026/11/11`; fs.mkdirSync(day, { recursive: true });
  const sid = 'codex-0001';
  const R = (type, payload, ts) => JSON.stringify({ type, payload, timestamp: ts });
  const lines = [
    R('session_meta', { session_id: sid, id: sid, cwd: 'D:/codex-proj' }, '2026-11-11T01:00:00Z'),
    R('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are Codex.' }] }, '2026-11-11T01:00:01Z'),
    R('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>D:/codex-proj</cwd>\n</environment_context>' }] }, '2026-11-11T01:00:02Z'),
    R('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '请把这段说明写清楚一点' }] }, '2026-11-11T01:00:03Z'),
    R('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好的，我先列出要点。' }] }, '2026-11-11T01:00:04Z'),
    R('response_item', { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"command":"ls"}' }, '2026-11-11T01:00:05Z'),
    R('response_item', { type: 'function_call_output', call_id: 'call_1', output: 'a.txt\nb.txt' }, '2026-11-11T01:00:06Z'),
  ];
  fs.writeFileSync(`${day}/rollout-x-${sid}.jsonl`, lines.join('\n') + '\n');

  const outDir = `${base}/out`;
  const r = syncCodexProjections({ srcDir: `${base}/sessions`, outDir, force: true });
  assert.ok(r.ok, `投影失败：${r.error}`);
  assert.equal(r.written, 1, '应投影出 1 段会话');
  const proj = `${outDir}/${sid}/${sid}.jsonl`;
  assert.ok(fs.existsSync(proj), '投影文件应生成（out/codex/<sid>/<sid>.jsonl）');

  const built = build(proj);
  assert.equal(built.ledger.runner, 'codex', '应识别为 codex 来源');
  assert.ok(built.facts.turns.human >= 1, '真请求要算 1 个人类回合（environment_context 不算）');
  assert.ok(built.facts.toolCalls.total >= 1, 'function_call 要算成 1 次工具调用');

  // 未变不重写（mtime+size 去重）
  const again = syncCodexProjections({ srcDir: `${base}/sessions`, outDir, force: false });
  assert.equal(again.written, 0, '同一段没变不该重投影');
  fs.rmSync(base, { recursive: true, force: true });
});

test('断开 Skill：Junction 只解链接，共用的真本原样保留（真机踩过的那条）', () => {
  const base = fixture('unlink-safe');
  const real = path.join(base, 'real');
  fs.mkdirSync(real, { recursive: true });
  const body = '真本内容：卸载动作不许删到这里';
  fs.writeFileSync(path.join(real, 'SKILL.md'), body);
  const wb = path.join(base, 'home', '.workbuddy');
  fs.mkdirSync(path.join(wb, 'skills'), { recursive: true });
  const link = path.join(wb, 'skills', 'convledger');
  fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.ok(fs.existsSync(path.join(link, 'SKILL.md')), '前提：链接能读到真本');

  const r = spawnSync(process.execPath, [`${tools}/skill/install.mjs`, '--client', 'workbuddy', '--remove'], {
    cwd: tools, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, WORKBUDDY_CONFIG_DIR: wb },
  });
  assert.equal(r.status, 0, `卸载应成功：${r.stderr || r.stdout}`);
  assert.ok(!fs.existsSync(link), '链接本身应被解除');
  assert.ok(fs.existsSync(path.join(real, 'SKILL.md')), '真本必须还在——顺着链接删进去就是事故');
  assert.equal(fs.readFileSync(path.join(real, 'SKILL.md'), 'utf8'), body, '真本内容一个字节都不该变');
});

test('断开 Skill：父级是共享目录链接时拒绝穿透（单源技能总仓那种布局）', () => {
  const base = fixture('shared-parent');
  const pool = path.join(base, 'pool', 'skills');
  fs.mkdirSync(path.join(pool, 'convledger'), { recursive: true });
  fs.writeFileSync(path.join(pool, 'convledger', 'SKILL.md'), '共享真本，不许删');
  const codex = path.join(base, 'home', '.codex');
  fs.mkdirSync(codex, { recursive: true });
  const skills = path.join(codex, 'skills');
  fs.symlinkSync(pool, skills, process.platform === 'win32' ? 'junction' : 'dir');
  // 这就是陷阱：子目录本身看着是普通目录，只有往上找才看得见那层链接
  assert.equal(fs.lstatSync(path.join(skills, 'convledger')).isSymbolicLink(), false, '前提：convledger 本身不是链接');

  const r = spawnSync(process.execPath, [`${tools}/skill/install.mjs`, '--client', 'codex', '--remove'], {
    cwd: tools, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CODEX_HOME: codex },
  });
  assert.equal(r.status, 0, `接入器应正常退出：${r.stderr || r.stdout}`);
  assert.match(String(r.stdout || ''), /不动|共享/, '回执要说明为什么不动');
  assert.ok(fs.existsSync(path.join(pool, 'convledger', 'SKILL.md')), '共享真本必须原样保留');
  assert.equal(fs.readFileSync(path.join(pool, 'convledger', 'SKILL.md'), 'utf8'), '共享真本，不许删');
});

test('连接状态分层：hooks 与 Skill 分开算，isOff 只认这两层', async () => {
  const base = fixture('conn-state');
  const root = path.join(base, 'store');
  fs.mkdirSync(root, { recursive: true });
  const home = path.join(base, 'home');
  const wb = path.join(home, '.workbuddy');
  fs.mkdirSync(path.join(wb, 'skills', 'convledger'), { recursive: true });
  fs.writeFileSync(path.join(wb, 'skills', 'convledger', 'SKILL.md'), '# x');
  fs.writeFileSync(path.join(wb, 'settings.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node .../ledger-brief.mjs --origin host' }] }] },
  }));

  const on = await connectionState({ root, home, env: { WORKBUDDY_CONFIG_DIR: wb }, port: 59997 });
  assert.equal(on.hooks.find((h) => h.id === 'workbuddy').count, 1, '钩子条目应计到 1 条');
  assert.equal(on.skills.find((x) => x.client === 'workbuddy').mounted, true, 'Skill 目录在＝已挂');
  assert.equal(isOff(on), false, '两层都挂时不能算断开');

  // 只拆一层：Skill 已挂、钩子 0 条 → 仍是连接态（宿主还会按 Skill 调用）
  fs.writeFileSync(path.join(wb, 'settings.json'), JSON.stringify({ hooks: {} }));
  const half = await connectionState({ root, home, env: { WORKBUDDY_CONFIG_DIR: wb }, port: 59997 });
  assert.equal(half.hooks.find((h) => h.id === 'workbuddy').count, 0, '钩子应归零');
  assert.equal(isOff(half), false, '只断一层不算断开——这正是以前看不出来的半挂状态');

  fs.rmSync(path.join(wb, 'skills', 'convledger'), { recursive: true, force: true });
  const off = await connectionState({ root, home, env: { WORKBUDDY_CONFIG_DIR: wb }, port: 59997 });
  assert.equal(isOff(off), true, '两层都空才算断开');
});

test('块名不吃 hook 注入文本：压缩提示不能冒充「这一块里第一句人话」', () => {
  assert.ok(NOSAY.test('[convledger · 收尾检查] 这个项目还没有任务表'), '注入文本要过这把筛子');
  assert.ok(NOSAY.test('[convledger · 后台补账] 本会话有 3 块已收口但缺综述'), '补账提示同样');
  assert.ok(!NOSAY.test('把这个按钮改大一点'), '正常的人话不能被误伤');

  const nodes = [
    { id: 'S01', say: '[convledger · 收尾检查] 这个项目还没有任务表', task: 't1', t0: 1, t1: 2, files: [], branches: [] },
    { id: 'S02', say: '把这个按钮改大一点', task: 't1', t0: 3, t1: 4, files: [], branches: [] },
  ];
  const asks = [{ id: 'S01', who: '你', count: 1 }, { id: 'S02', who: '你', count: 1 }];
  const { steps } = stepsOf(nodes, asks, [], []);
  assert.equal(steps.length, 1, '两段同一块');
  assert.equal(steps[0].say, '把这个按钮改大一点', '块名要跳过注入文本，取真正的人话——否则压缩后注入回新上下文的就是一句工具自己的提示');
});

test('新接入默认不建历史：后台档位是「关」，setup 只建当前这一段', () => {
  const fresh = readPrefs(fixture('prefs-default'));
  assert.equal(fresh.autoBuild, 'off', '默认档位必须是关——新机器接入不许在后台把历史全建一遍');
  assert.equal(AUTO_BUILD_MODES[0], 'off', '档位列表第一项是关，界面下拉的默认落点才对');

  const r = spawnSync(process.execPath, [`${tools}/bin/convledger.mjs`, 'setup', '--check'], {
    cwd: tools, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, CONVLEDGER_NO_RESIDENT_HUB: '1' },
  });
  const text = String(r.stdout || '') + String(r.stderr || '');
  assert.match(text, /只建当前这一段（默认，历史不建）/, '计划里要写明只建当前一段');
  assert.ok(!/最近 20/.test(text), '不该再出现「最近 20 段账」');

  // 按 Agent 选装：--client qoder 只计划 Qoder，别家标「不装」，不许一键全装
  const rq = spawnSync(process.execPath, [`${tools}/bin/convledger.mjs`, 'setup', '--check', '--client', 'qoder'], {
    cwd: tools, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, CONVLEDGER_NO_RESIDENT_HUB: '1' },
  });
  const tq = String(rq.stdout || '') + String(rq.stderr || '');
  assert.match(tq, /只装：Qoder/, '--client qoder 要只装 Qoder');
  assert.match(tq, /计划：Skill Qoder · hooks Qoder/, '--client qoder 的安装计划只能有 Qoder');
  assert.ok(!/计划：Skill .*Claude Code/.test(tq), '--client qoder 不许把别家也列进安装计划');
  // 未知 Agent 要报错退出，不能悄悄装全部
  const rb = spawnSync(process.execPath, [`${tools}/bin/convledger.mjs`, 'setup', '--check', '--client', 'bogus'], {
    cwd: tools, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, CONVLEDGER_NO_RESIDENT_HUB: '1' },
  });
  assert.equal(rb.status, 1, '未知 Agent 要非零退出');
  assert.match(String(rb.stdout || '') + String(rb.stderr || ''), /未知 Agent/, '要明说未知 Agent');
});


test('补账分小批：只补最近的几块、逐轮往前，不许一次全补', () => {
  const src = fs.readFileSync(new URL('../hooks/ledger-brief.mjs', import.meta.url), 'utf8');
  assert.match(src, /pickSummaryBatch\(/, '要用分批函数，别一次全补');
  assert.match(src, /本轮只补最近的 \$\{batch\.length\} 块/, '提示要写明本轮只补最近几块');
  assert.match(src, /digest --block \$\{batch\.join\(','\)\}/, '取材要按本轮批次给 --block，不是全拿');
  assert.ok(!/一次拿全部缺块|不带 \*\*--block\*\*/.test(src), '旧的「一次全补」文案必须清掉');
  assert.match(src, /summarise --put - --session/, '落盘仍是 summarise --put -（合并式，只写本轮几块）');
  // 分批规则：每轮最多 4 块；进入往日积压每轮 1 块；欠账少也不一次全补
  const r = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  assert.deepEqual(pickSummaryBatch(r(1, 63), 63), [60, 61, 62, 63], '全缺 1..63：本轮只补最近 4 块');
  assert.deepEqual(pickSummaryBatch(r(1, 59), 63), [59], '已进入往日积压：每轮只往前补 1 块');
  assert.deepEqual(pickSummaryBatch(r(1, 8), 8), [5, 6, 7, 8], '欠账 8 块也只补最近 4 块，不一次全补');
  assert.deepEqual(pickSummaryBatch(r(1, 3), 3), [1, 2, 3], '欠账 ≤4 块时本轮补完，但上限仍是 4');
});

test('协作画像随 brief 注入：按维度去重，只挑「怎么配合他」那几类', () => {
  const base = fixture('collab-brief');
  const root = path.join(base, 'store');
  fs.mkdirSync(root, { recursive: true });
  const userDir = path.join(base, 'user');
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, 'memories.json'), JSON.stringify({
    schema: MEMORIES_SCHEMA, scope: 'user', revision: 1, appliedOperations: [], history: [],
    entries: [
      { id: 'U01', class: '画像', topic: 'a', text: '验收看真跑通，只有外形能点不算做完。', dimension: '验收' },
      { id: 'U02', class: '画像', topic: 'b', text: '附件与导出不许落在库根。', dimension: '边界' },
      { id: 'U03', class: '画像', topic: 'c', text: '第二条验收类不该顶掉别的维度。', dimension: '验收' },
    ],
  }));

  const c = collabBrief(root, 'p-test');
  assert.equal(c.length, 2, '默认取两条，不能把整张表塞进注入');
  assert.deepEqual(c.map((x) => x.tag), ['验收', '边界'], '按维度优先级排，且同一维度只取一条');

  const text = briefText({ mainSteps: 1, steps: [], tasks: [], phases: [], chapters: [], nodes: [] }, [], c);
  assert.ok(text.includes('协作（这个人在这类事上要的'), 'brief 里要有这一段的抬头');
  assert.ok(text.includes('附件与导出不许落在库根'), '条目正文要进来');
  const empty = briefText({ mainSteps: 1, steps: [], tasks: [], phases: [], chapters: [], nodes: [] }, [], []);
  assert.ok(!empty.includes('协作（这个人'), '没有画像时不许冒出空段');
  fs.rmSync(base, { recursive: true, force: true });
});

test('协作画像按当前任务选相关条目，验收/边界/反馈不丢', () => {
  const base = fixture('collab-task');
  const root = path.join(base, 'store');
  fs.mkdirSync(root, { recursive: true });
  const userDir = path.join(base, 'user');
  fs.mkdirSync(userDir, { recursive: true });
  const userEntries = [
    { id: 'U01', class: '画像', dimension: '验收', text: '提交前要跑全量测试。', at: '2026-11-01' },
    { id: 'U02', class: '画像', dimension: '边界', text: '只改点名的文件。', at: '2026-11-01' },
    { id: 'U03', class: '画像', dimension: '反馈', text: '先给结论再给细节。', at: '2026-11-01' },
    { id: 'U04', class: '画像', dimension: '偏好', text: '画布要能拖拽缩放。', scenes: ['ui'], at: '2026-11-01' },
    { id: 'U05', class: '画像', dimension: '背景', text: '做过电路设计。', at: '2026-11-01' },
    { id: 'U06', class: '画像', dimension: '目标', text: '文档要写清迁移步骤。', scenes: ['docs'], at: '2026-11-01' },
    { id: 'U07', class: '画像', dimension: '偏好', text: '海报只用本地字体。', scenes: ['graphic'], at: '2026-11-01' },
    { id: 'U08', class: '画像', dimension: '规则', text: '海报先出黑白稿再上色。', scenes: ['graphic'], at: '2026-11-01' },
  ];
  fs.writeFileSync(path.join(userDir, 'memories.json'), JSON.stringify({
    schema: MEMORIES_SCHEMA, scope: 'user', revision: 1, appliedOperations: [], history: [], entries: userEntries,
  }));
  const projDir = path.join(base, 'projects', 'p-task');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'memories.json'), JSON.stringify({
    schema: MEMORIES_SCHEMA, scope: 'project', project: 'p-task', revision: 1, appliedOperations: [], history: [],
    entries: [{ id: 'M01', class: '规则', dimension: '目标', text: '这个项目先做导出。', at: '2026-11-01' }],
  }));

  const a = collabBrief(root, 'p-task', { scenes: ['ui'] });
  const at = a.map((x) => x.tag);
  for (const core of ['验收', '边界', '反馈']) assert.ok(at.includes(core), `核心维度 ${core} 不能丢`);
  assert.ok(a.some((x) => /画布要能拖拽缩放/.test(x.text)), 'UI 场景要选到带 ui 标签的画像');
  assert.ok(!a.some((x) => /电路设计/.test(x.text)), '不相关背景不该占注入名额');
  assert.ok(!a.some((x) => /迁移步骤/.test(x.text)), '带 docs 标签的条目不在 UI 场景里凑数');
  assert.ok(!a.some((x) => /本地字体/.test(x.text)), '带 graphic 标签的条目不能靠维度兜底混进 UI 场景');
  assert.ok(a.some((x) => /这个项目先做导出/.test(x.text)), '项目规则不按用户场景过滤');

  const b = collabBrief(root, 'p-task', { scenes: ['docs'] });
  assert.ok(b.some((x) => /迁移步骤/.test(x.text)), '文档场景要换到带 docs 标签的画像');
  assert.ok(!b.some((x) => /画布要能拖拽缩放/.test(x.text)), 'UI 条目不继续占文档场景');

  const g = collabBrief(root, 'p-task', { scenes: ['graphic'] });
  assert.ok(g.some((x) => /本地字体/.test(x.text)), '平面场景要选到带 graphic 标签的画像');
  assert.ok(g.some((x) => /黑白稿/.test(x.text)), '同一场景可以命中多条不同维度的画像');
  assert.ok(!g.some((x) => /画布要能拖拽缩放/.test(x.text)), '显式标签优先于维度兜底');

  const hybrid = collabBrief(root, 'p-task', { scenes: ['ui'], context: '迁移步骤' });
  assert.ok(hybrid.some((x) => /迁移步骤/.test(x.text)), '关键词命中可以越过场景标签补进来');
  const hybrid2 = collabBrief(root, 'p-task', { scenes: ['ui'], context: '海报先出黑白稿' });
  assert.ok(hybrid2.some((x) => /黑白稿/.test(x.text)), '关键词命中也能把别的场景条目拉进来');

  const scenes = briefScenes({
    steps: [{ step: 3, dominant: 'PT1', sum: { title: '画布拖拽' } }],
    phases: [{ from: 1, to: 3, short: '界面', doing: '调画布' }],
    tasks: [{ id: 'PT1', title: '画布交互' }],
  }, [{ id: 'R1', text: '还要能缩放', done: false }]);
  assert.ok(scenes.includes('ui'), 'briefScenes 要认出画布/界面场景');
  const poster = briefScenes({ steps: [{ step: 1, sum: { title: '做展览海报设计' } }], phases: [], tasks: [] }, []);
  assert.ok(poster.includes('design') && poster.includes('graphic'), '海报设计要识别成设计/平面场景');
  const testPlan = briefScenes({ steps: [{ step: 1, sum: { title: '做测试计划' } }], phases: [], tasks: [] }, []);
  assert.ok(testPlan.includes('plan') && testPlan.includes('test'), '测试计划要同时识别计划与测试');
  const toolHabit = briefScenes({ steps: [{ step: 1, sum: { title: '使用工具的习惯' } }], phases: [], tasks: [] }, []);
  assert.ok(toolHabit.includes('tooling') || toolHabit.includes('tool-choice'), '工具使用要识别工具/习惯场景');
  fs.rmSync(base, { recursive: true, force: true });
});

test('记忆归纳按增量触发：攒够经验块或会话才到期，判据不看日历', () => {
  const base = fixture('memory-due');
  const root = path.join(base, 'store');
  const projKey = 'p-000000000001';
  const projDir = path.join(base, 'projects', projKey);
  fs.mkdirSync(projDir, { recursive: true });
  const sid = 'aaaaaaaa-0000-0000-0000-000000000001';
  const dir = path.join(root, sid);
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(base, 's.jsonl');
  fs.writeFileSync(src, '{"x":1}\n');
  fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify({ sessionId: sid, sourceFile: src, builtAt: new Date().toISOString() }));

  const writeSums = (n) => {
    const blocks = {};
    for (let i = 1; i <= n; i++) blocks[String(i)] = { segs: ['S01'], hash: 'h' + i, lesson: '经验 ' + i, at: new Date().toISOString() };
    fs.writeFileSync(path.join(dir, 'summaries.json'), JSON.stringify({ blocks }));
  };
  fs.writeFileSync(path.join(projDir, 'progress-state.json'), JSON.stringify({ checkpoints: { [sid]: {} } }));

  // 记忆表为空 + 只有 3 条经验 → 不够（阈值 8）
  writeSums(3);
  let d = memoryDue(root, projKey);
  assert.equal(d.project.due, false, '3 条经验不够触发归纳');
  assert.equal(d.project.lessons, 3, '计数要如实');

  // 攒到 8 条 → 到期
  writeSums(8);
  d = memoryDue(root, projKey);
  assert.equal(d.project.due, true, '8 条带经验的块该触发项目记忆归纳');
  assert.equal(d.project.lessons, 8);

  // 刚归纳过（表里有更晚的条目）→ 增量归零
  fs.writeFileSync(path.join(projDir, 'memories.json'), JSON.stringify({
    schema: MEMORIES_SCHEMA, scope: 'project', revision: 1, appliedOperations: [], history: [],
    entries: [{ id: 'P01', class: '经验', topic: 'x', text: '刚归纳过的一条。', at: new Date(Date.now() + 1000).toISOString() }],
  }));
  d = memoryDue(root, projKey);
  assert.equal(d.project.lessons, 0, '归纳时间之后才算新增');
  assert.equal(d.project.due, false, '刚归纳完不该立刻又催');

  // 会话数够也算到期（阈值 3 个新会话）
  assert.ok(MEMORY_PROJECT_SESSION_DUE === 3, '会话阈值是启动值 3');
  fs.rmSync(base, { recursive: true, force: true });
});

test('宿主派活走能力表：五档各出各的文案，覆盖文件改一家不动代码', () => {
  const caps = { ...DEFAULT_CAPS };
  const sess = dispatchFor('qoder', caps);
  assert.ok(sess.includes('后台工作会话') && sess.includes('create_chat_session'), '独立会话通道要给出开新会话的办法');
  assert.ok(!sess.includes('子代理'), '独立会话通道不该提子代理');

  const asyncTxt = dispatchFor('workbuddy', caps);
  assert.ok(asyncTxt.includes('run_in_background: true'), '异步子代理通道要带异步参数');
  assert.ok(asyncTxt.includes('不要等它'), '异步通道必须写「派完就走」');

  assert.ok(dispatchFor('codex', caps).includes('什么都不做'), '不派通道要明确允许「不做」');
  assert.ok(dispatchFor('some-new-host', caps).includes('什么都不做'), '表里没有的宿主按不派处理，不猜它的工具名');
  assert.ok(dispatchFor('x', { x: { channel: 'subagent-sync', tool: 'Task' } }).includes('占住本轮'), '同步通道要把代价写出来');

  // 插件自动派：agent 什么都不该做（再派一次只会多开一段重复会话）
  const plug = dispatchFor('opencode', caps);
  assert.ok(plug.includes('插件自己派活') && plug.includes('不必做任何事'), '插件通道要明确 agent 不用做');
  assert.ok(!plug.includes('run_in_background'), '插件通道不该给 agent 异步子代理的参数指令（文案里「不要另开子代理」是否定式，允许）');

  const base = fixture('host-caps');
  const root = path.join(base, 'store');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(base, 'host-caps.json'), JSON.stringify({
    hosts: { 'claude-code': { channel: 'none', verified: '本机实测：不等待会丢结果' } },
  }));
  const loaded = loadCaps(root);
  assert.equal(loaded.caps['claude-code'].channel, 'none', '覆盖文件要能改通道');
  assert.equal(loaded.caps['claude-code'].overridden, true, '要标记这行来自覆盖');
  assert.equal(loaded.caps.qoder.channel, 'session', '没写的继续用默认表');
  assert.ok(dispatchFor('claude-code', loaded.caps).includes('什么都不做'), '覆盖后文案跟着变');
  fs.rmSync(base, { recursive: true, force: true });
});

test('upgrade：版本水位与常驻进程任一落后都要提示，一致时闭嘴', () => {
  assert.equal(noticeFor({ head: 'abc', deployedHead: 'abc', hubStart: 9000, stamp: 8000 }), false, '水位一致且 hub 新于源码：不提示');
  assert.equal(noticeFor({ head: 'abc', deployedHead: 'old', hubStart: 9000, stamp: 8000 }), true, '拉了新代码没登记：要提示');
  assert.equal(noticeFor({ head: 'abc', deployedHead: null, hubStart: 9000, stamp: 8000 }), true, '从没登记过：要提示');
  assert.equal(noticeFor({ head: 'abc', deployedHead: 'abc', hubStart: 1000, stamp: 8000 }), true, '水位一致但 hub 早于源码：要提示');
  assert.equal(noticeFor({ head: null, deployedHead: 'abc', hubStart: 9000, stamp: 8000 }), false, '非 git 检出且进程不落后：不误报');
});

test('upgrade：水位可读写，源码时间只认源码面不认 out 派生', () => {
  const tool = fixture('upgrade');
  fs.mkdirSync(path.join(tool, 'src'), { recursive: true });
  const src = path.join(tool, 'src', 'a.mjs');
  fs.writeFileSync(src, 'export const a = 1;\n');
  const first = sourceStamp(tool);
  assert.ok(first > 0, '源码文件要能算出时间');

  writeDeploy(tool, { head: 'abc1234', hubStartedAt: '2026-11-13T00:00:00.000Z' });
  assert.equal(readDeploy(tool).head, 'abc1234', '水位写进去要能原样读回');
  assert.equal(readDeploy(tool).hubStartedAt, '2026-11-13T00:00:00.000Z');

  // out/ 是每 20s 就在写的派生目录；把它推到未来也不能让工作台永远判成落后。
  const noisy = path.join(tool, 'out', 'noisy.txt');
  fs.writeFileSync(noisy, 'x');
  const future = new Date(Date.now() + 86400000);
  fs.utimesSync(noisy, future, future);
  assert.equal(sourceStamp(tool), first, 'out 下的新文件不得影响源码时间');
  assert.equal(deployFile(tool), path.join(tool, 'out', 'state', 'deploy.json'));
  fs.rmSync(tool, { recursive: true, force: true });
});

test('upgrade：命令在帮助里，--check --json 报告三项且只读', () => {
  const help = fs.readFileSync(new URL('../src/cli.mjs', import.meta.url), 'utf8');
  assert.match(help, /convledger upgrade \[--check\]/, '帮助里要有 upgrade，命令表才认得它');
  // 用一个没人监听的端口：hub 必然判落后，且绝不碰真 8765。
  const statePath = path.join(tools, 'out', 'state', 'deploy.json');
  const beforeState = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : null;
  // 本机暂停标记会把「hub 没在跑」当作预期状态、从而不报不同步；这条用例要验的是
  // 「有不同步项就返回非零」，所以跑检查时临时移开标记，跑完原样恢复（不影响真状态）。
  const pause = path.join(tools, 'out', 'HUB-PAUSED');
  const savedPause = fs.existsSync(pause) ? fs.readFileSync(pause) : null;
  if (savedPause) fs.rmSync(pause);
  let r;
  try {
    r = spawnSync(process.execPath, ['src/cli.mjs', 'upgrade', '--check', '--json', '--port', '59999'],
      { cwd: tools, encoding: 'utf8', maxBuffer: BIG_BUF });
  } finally {
    if (savedPause) fs.writeFileSync(pause, savedPause);
  }
  assert.equal(r.status, 1, '有不同步项时 --check 要返回非零，脚本才能判断');
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.items.map((i) => i.name), ['skills', 'hub', 'deploy'], '三项分别是副本／常驻进程／水位');
  assert.equal(j.ok, false);
  assert.match(j.items.find((i) => i.name === 'hub').detail, /端口 59999/, '不用真端口也要如实说没在跑');
  assert.deepEqual(j.actions, [], '--check 不能有任何动作');
  const afterState = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : null;
  assert.equal(afterState, beforeState, '只读检查不改水位文件');
});

test('去常驻：宿主 hook 不再补起工作台，hub 自带门禁与人走灯灭（2026-11-14 口径）', () => {
  const src = fs.readFileSync(new URL('../hooks/ledger-brief.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /ensureHubFromHost/, 'hook 不再拉起/保活 hub——后台常驻下线');
  assert.doesNotMatch(src, /'--serve'/, 'hook 不再 spawn hub 进程');
  const map = fs.readFileSync(new URL('../src/map.mjs', import.meta.url), 'utf8');
  assert.match(map, /人走灯灭/, 'hub 要自带空闲退出，不留常驻后台');
  assert.match(map, /timingSafeEqual/, '门禁校验要恒时比较，别用 === 比密钥');
  assert.match(map, /只对桌面应用窗口开放/, '无 token 请求要 403，浏览器 Web 入口下线');
  assert.match(map, /token: hubToken/, 'serveMap 要把 token 交回给启动方');
  const setup = fs.readFileSync(new URL('../src/setup.mjs', import.meta.url), 'utf8');
  assert.match(setup, /export function readHubToken\(/, '启动方要有读 token 的入口');
  assert.match(setup, /Open the convledger app window/, '快捷方式描述别再承诺浏览器入口');
});

test('拉完代码自动升级：post-merge 安装幂等、不覆盖别人的 hook、卸载只摘自己', () => {
  const repo = fixture('git-hook');
  fs.mkdirSync(repo, { recursive: true });
  // 必须是独立仓库：hooksDir 走 git rev-parse，夹具在仓库内会把壳写进真 .git/hooks。
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo, encoding: 'utf8' }).status, 0, '临时夹具要 git init 成功');
  const file = hookFile(repo);
  assert.ok(path.resolve(file).startsWith(path.resolve(repo)), 'hooks 路径只能落在临时夹具里');

  assert.equal(installGitHook(repo).action, 'created');
  assert.equal(hookState(repo).mode, 'owned');
  const body = fs.readFileSync(file, 'utf8');
  assert.match(body, /^#!\/bin\/sh/);
  assert.match(body, /convledger-git-post-merge-own/);
  assert.match(body, /exec "\$CL_NODE"/, '整份壳用 exec，git 才会等升级跑完');
  assert.equal(installGitHook(repo).action, 'already');
  assert.equal(fs.readFileSync(file, 'utf8'), body, '重复安装不改一个字');

  assert.equal(removeGitHook(repo).action, 'removed');
  assert.ok(!fs.existsSync(file), '整份自己创建的壳要删掉，不留半截 shebang');

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\necho other-agent\n');
  assert.equal(installGitHook(repo).action, 'appended');
  const merged = fs.readFileSync(file, 'utf8');
  assert.match(merged, /echo other-agent/, '别人原有的 hook 原样保留');
  assert.ok(!merged.includes('exec "$CL_NODE"'), '追加模式不能 exec，会截断别人的逻辑');
  assert.equal(hookState(repo).mode, 'appended');
  assert.equal(removeGitHook(repo).action, 'trimmed');
  const rest = fs.readFileSync(file, 'utf8');
  assert.match(rest, /echo other-agent/);
  assert.ok(!rest.includes('convledger-git-post-merge'), '自己的标记与调用行都摘干净');
  assert.equal(removeGitHook(repo).action, 'foreign-untouched');

  const src = fs.readFileSync(new URL('../hooks/git-post-merge.mjs', import.meta.url), 'utf8');
  assert.match(src, /\[CLI, 'upgrade'\]/, '拉完要真跑 upgrade，不是只写标记');
  assert.match(src, /stdio: 'inherit'/, '同步执行，避免 detached 子进程被命令会话清理');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('拉完代码自动升级：on/off 带上 git 层', () => {
  const conn = fs.readFileSync(new URL('../src/connection.mjs', import.meta.url), 'utf8');
  assert.match(conn, /git-post-merge\.mjs', \['--install'\]/, '接入工具时装上 pull 后触发器');
  assert.match(conn, /git-post-merge\.mjs', \['--remove'\]/, '断开时一并摘掉，语义对称');
});

test('upgrade：/health 探不到时仍按 hub.json 的 pid 停旧进程，不把旧 hub 报成新起的', () => {
  const tool = fixture('upgrade-hubpid');
  fs.mkdirSync(path.join(tool, 'out'), { recursive: true });
  const file = path.join(tool, 'out', 'hub.json');
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, port: 8765, startedAt: new Date(0).toISOString() }));
  assert.equal(recordedHubPid(tool), process.pid, '还活着的记录 pid 要认出来');
  assert.equal(recordedHubPid(tool, 59999), null, '别的端口不许拿 8765 的 pid 来凑');
  fs.writeFileSync(file, JSON.stringify({ pid: 99999999, port: 8765, startedAt: new Date(0).toISOString() }));
  assert.equal(recordedHubPid(tool), null, '早就没了的 pid 不能拿去 kill');
  const src = fs.readFileSync(new URL('../src/upgrade.mjs', import.meta.url), 'utf8');
  assert.match(src, /recordedHubPid\(tool, port\)/, '重启前把同端口记录的 pid 一起收进停机名单');
  assert.match(src, /端口上仍是旧 hub/, '探测到旧 pid 不许报成「起新 hub」');
  fs.rmSync(tool, { recursive: true, force: true });
});

test('upgrade：有动作时结论说「本次已同步」，没动作才说「已是最新」', () => {
  const base = { head: 'abc1234', stamp: Date.now(), items: [] };
  assert.match(upgradeLines({ ...base, actions: ['同步五家 Skill 副本'], ok: true }), /本次已同步到位/);
  assert.match(upgradeLines({ ...base, actions: ['起 hub 超时'], ok: false }), /同步后仍有不同步项/);
  assert.match(upgradeLines({ ...base, actions: [], ok: true }), /已是最新/);
  assert.match(upgradeLines({ ...base, actions: [], ok: false }), /仍有不同步项/);
});

test('hook 的会话根与 ADAPTERS 同源：Claude Code 不再判 no-source，Stop 能补建账本', () => {
  // 真机 2026-11-13：claude -p 的 SessionStart 注了「借来的账本」、Stop 报 no-source。
  // 根因是 hook 自己只列了 Qoder/WorkBuddy 两个根，而 CLI 的 ADAPTERS 早就认 ~/.claude/projects。
  const roots = sourceRoots();
  for (const tail of ['/.claude/projects', '/.qoder/projects', '/.workbuddy/projects']) {
    assert.ok(roots.some((r) => r.endsWith(tail)), `sourceRoots 少了 ${tail}`);
  }
  assert.deepEqual(roots,
    [...new Set(ADAPTERS.flatMap((a) => a.roots))].map((r) => r.replace(/\\/g, '/')),
    'sourceRoots 必须与 ADAPTERS 完全一致（投影根可被环境变量改写，不许写死路径形状）');
  const hookSrc = fs.readFileSync(new URL('../hooks/ledger-brief.mjs', import.meta.url), 'utf8');
  assert.match(hookSrc, /function scanRoots\(\)[\s\S]{0,300}sourceRoots\(\)/, 'hook 必须复用 ADAPTERS 的清单，不许再手写一份');
  assert.match(hookSrc, /late-build/, '开场源太短没建账时，收尾要补建一次');

  const base = fixture('claude-hook');
  const SID = 'claude-hook-sid-0001';
  const src = `${base}/claude/projects/D--fixture-claude/${SID}.jsonl`;
  fs.mkdirSync(path.dirname(src), { recursive: true });
  const rec = (n, role, text) => JSON.stringify({
    type: role, ...(role === 'user' ? { userType: 'external', entrypoint: 'cli' } : {}),
    sessionId: SID, uuid: `u${n}`,
    timestamp: new Date(1760000000000 + n * 45000).toISOString(), cwd: 'D:/fixture/claude',
    message: { role, content: [{ type: 'text', text }] },
  });
  fs.writeFileSync(src, [rec(1, 'user', '请给这一段会话建一份账本并说明当前进度'),
    rec(2, 'assistant', '已经建好账本，当前进度写进第一段。')].join('\n') + '\n');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: `${base}/claude`,
    QODER_CONFIG_DIR: `${base}/noq`, WORKBUDDY_CONFIG_DIR: `${base}/nowb`,
    CONVLEDGER_HOOK_STORE: `${base}/store`, CONVLEDGER_HOOK_LOG: `${base}/log.jsonl`,
    CONVLEDGER_NO_RESIDENT_HUB: '1' };
  const stop = spawnSync(process.execPath, ['hooks/ledger-brief.mjs'], {
    cwd: tools, encoding: 'utf8', maxBuffer: BIG_BUF, env,
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: SID, cwd: 'D:/fixture/claude',
      transcript_path: src, stop_hook_active: false }),
  });
  assert.equal(stop.status, 0, `hook 退出 ${stop.status}：${stop.stderr}`);
  const log = fs.readFileSync(`${base}/log.jsonl`, 'utf8');
  assert.doesNotMatch(log, /no-source/, 'Claude Code 的 transcript_path 又被判成根目录外');
  assert.match(log, /late-build/, '收尾时没把开场没建成的账本补起来');
  assert.ok(fs.existsSync(`${base}/store/${SID}/ledger.json`), '补建后账本没落盘');
  const led = JSON.parse(fs.readFileSync(`${base}/store/${SID}/ledger.json`, 'utf8'));
  assert.equal(led.runner, 'claude-code', `runner 认错了：${led.runner}`);
});

test('OpenCode 插件跨实例派活去重：同一 10 分钟窗口只放行一次', () => {
  // 后台 service 与每个 TUI/CLI 各加载一份插件，进程内 Map 挡不住同一事件被派两次
  // （真机留痕成对出现）。插件被复制到用户目录、必须自包含，所以不能抽成公共模块，
  // 这里把函数体取出来单独跑，钉住「落盘分桶 + wx 原子建文件」这个跨进程契约。
  const src = fs.readFileSync(new URL('../hooks/opencode-plugin.js', import.meta.url), 'utf8');
  assert.match(src, /claimDispatch/, '要有跨实例闸门');
  assert.doesNotMatch(src, /lastDispatch/, '不许退回只在进程内生效的 Map 节流');
  assert.match(src, /action: 'throttled'/, '被挡下要留痕，别静默吞掉');
  const body = /function claimDispatch\(sid\)\s*\{[\s\S]*?\n\}/.exec(src)?.[0];
  assert.ok(body, '取不到 claimDispatch 的函数体');
  const dir = fixture('opencode-claim');
  const claim = new Function('fs', 'CLAIM_DIR', 'DISPATCH_GAP_MS', `${body}; return claimDispatch;`)(fs, dir, 600000);
  assert.equal(claim('ses_A'), true, '第一个实例应放行');
  assert.equal(claim('ses_A'), false, '同窗口第二次必须挡下（真机成对派活的根源）');
  assert.equal(claim('ses_B'), true, '别的会话不受影响');
});

test('Claude Code 派活能力表：Agent + run_in_background，不给空指令 Task', () => {
  // 真机 2026-11-13（CLI 2.1.296）：这家派子代理的入口叫 Agent，Task 是
  // TaskCreate/TaskGet/TaskUpdate/TaskList/TaskStop 一组任务表工具。写错名字，模型收到的
  // 就是一条做不到的指令（当轮实测靠模型自己纠正成 Agent 才派成）。
  const c = DEFAULT_CAPS['claude-code'];
  assert.equal(c.channel, 'subagent-async');
  assert.equal(c.tool, 'Agent', '工具名必须是 Agent，不许写回 Task');
  assert.match(c.asyncParam, /run_in_background:\s*true/, '必须显式给后台参数');
  assert.doesNotMatch(c.verified, /未实测/, '状态要如实写真机结论');
  const txt = dispatchFor('claude-code', DEFAULT_CAPS);
  assert.match(txt, /用 Agent 工具/);
  assert.match(txt, /run_in_background: true/);
  assert.doesNotMatch(txt, /用 Task 工具/, 'Task 在这个版本是任务表工具，不能出现在派活指令里');
  assert.doesNotMatch(txt, /先确认这个工具支持后台运行/, '参数已确认，别再让模型自己猜');
  // 本机装了 Claude Code 时，顺手把「代码里的工具名」与宿主 SDK 的形状对上；
  // 换机器没装就只跑上面的静态契约，不因此多算一个 skip。
  const candidates = [
    process.env.CLAUDE_CODE_SDK_TYPES,
    process.env.APPDATA ? `${process.env.APPDATA}/npm/node_modules/@anthropic-ai/claude-code/sdk-tools.d.ts` : null,
    `${os.homedir()}/.npm-global/lib/node_modules/@anthropic-ai/claude-code/sdk-tools.d.ts`,
  ].filter(Boolean).map((p) => String(p).replace(/\\/g, '/'));
  const sdk = candidates.find((p) => fs.existsSync(p));
  if (sdk) {
    const d = fs.readFileSync(sdk, 'utf8');
    assert.match(d, /export interface AgentInput/, '宿主把工具改名了，回来核能力表');
    assert.match(d, /run_in_background\?: boolean/, '后台参数没了，就别再让 agent 派异步子代理');
  }
});

test('Claude Code 派活文案不串台，权限被拒也不许主线重试', () => {
  const claude = dispatchFor('claude-code', DEFAULT_CAPS);
  assert.doesNotMatch(claude, /create_chat_session/, 'Qoder 的会话工具不该串到 Claude Code');
  assert.doesNotMatch(claude, /占住本轮/, '不能给出同步子代理的口径');
  assert.match(claude, /别在主线重试/, '后台被权限拦下时欠项留下一轮，别把主线拖住');
  assert.match(dispatchFor('workbuddy', DEFAULT_CAPS), /用 Agent 工具/, '改 Claude Code 不能顺手改掉 WorkBuddy');
  assert.match(dispatchFor('opencode', DEFAULT_CAPS), /插件自己派活/, '插件档仍由宿主自己派');
});

test('派活能力表全表契约：出处与真机证据齐全，证伪入口一律不派', () => {
  // 2026-11-13 复盘：WorkBuddy 抄 Qoder 的会话工具、Claude Code 凭印象写 Task，两次都是
  // 「模型根本没有这个按钮」的空指令。写进文档会忘，所以把纪律钉进代码、CLI 与测试。
  assert.deepEqual(capsWarnings(DEFAULT_CAPS), [], '默认表不许带警告：每个可用档都要有出处与真机结论');
  for (const [host, c] of Object.entries(DEFAULT_CAPS)) {
    assert.ok(CHANNELS.includes(c.channel), `${host} 的通道要在五档里`);
    if (c.channel === 'none' || c.channel === 'plugin') continue;
    assert.ok(c.evidence, `${host} 缺 evidence：工具名/参数没有出处，下次宿主改名就是空指令`);
    assert.match(c.verified, /真机/, `${host} 没真机证据不许开可用通道`);
    assert.ok(c.tool || c.open, `${host} 没写 tool/open，模型只能自己猜`);
    if (c.channel === 'subagent-async') assert.ok(c.asyncParam, `${host} 异步档要写死后台参数`);
  }
  assert.ok(BAD_TOOLS.some((b) => b.host === 'claude-code' && b.tool === 'Task'), 'Task 这个错名要留在证伪表里');

  const bad = { ...DEFAULT_CAPS, 'claude-code': { ...DEFAULT_CAPS['claude-code'], tool: 'Task' } };
  assert.ok(capsWarnings(bad).some((w) => w.level === 'block' && w.host === 'claude-code'), '证伪入口要报 block');
  assert.ok(capBlockReason(bad, 'claude-code'), '要能给出拦下原因');
  const txt = dispatchFor('claude-code', bad);
  assert.match(txt, /什么都不做/, '命中证伪入口时改为诚实留欠，不再发派活指令');
  assert.doesNotMatch(txt, /用 Task 工具/, '不许把做不到的指令发给模型');
  assert.equal(capBlockReason(bad, 'workbuddy'), null, '别家不受牵连');

  const fresh = { 'new-host': { channel: 'subagent-async', tool: 'Agent', verified: '按形状推断' } };
  const fw = capsWarnings(fresh);
  assert.ok(fw.some((w) => /evidence/.test(w.text)), '新宿主没出处要警告');
  assert.ok(fw.some((w) => /真机/.test(w.text)), '新宿主没真机证据要警告');
  assert.ok(fw.some((w) => /asyncParam/.test(w.text)), '异步档缺后台参数要警告');

  // 覆盖文件里把工具名改错，运行时同样拦下，并在 caps 的结构化输出里看得见。
  const base = fixture('caps-contract');
  const root = path.join(base, 'store');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(base, 'host-caps.json'), JSON.stringify({ hosts: { 'claude-code': { tool: 'Task' } } }));
  const t = capsTable(root);
  assert.ok(t.warnings.some((w) => w.level === 'block'), 'capsTable 要带出警告');
  assert.ok(t.rows.find((r) => r.host === 'claude-code').blocked, '表里要标出被拦下的那一行');
  assert.ok(t.rows.find((r) => r.host === 'qoder').evidence, '每家都要能在 CLI 查到出处');
  fs.rmSync(base, { recursive: true, force: true });
});

test('宿主状态单一源：能力表、Skill 与 CHANGELOG 口径一致', () => {
  const skill = fs.readFileSync(new URL('../skill/convledger/SKILL.md', import.meta.url), 'utf8');
  const changelog = fs.readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');

  // ① 能力表的状态必须合法、与 verified 不矛盾
  for (const [host, c] of Object.entries(DEFAULT_CAPS)) {
    assert.ok(STATUS[c.status], `${host} 的 status 要在三档里`);
    assert.deepEqual(capsWarnings({ [host]: c }), [], `${host} 状态自相矛盾或缺字段`);
  }
  assert.equal(DEFAULT_CAPS['claude-code'].status, 'verified', 'Claude Code 已真机跑通，不许回退成未实测');
  assert.equal(DEFAULT_CAPS.opencode.status, 'verified', 'OpenCode 已真机跑通，不许回退成未实测');
  assert.equal(DEFAULT_CAPS.codex.status, 'untested', 'Codex 没真机证据，不许写成已验证');

  // ② 活跃文档不许再出现旧结论；CHANGELOG 历史段豁免，但必须有读法声明
  const active = ['../../README.md', '../skill/convledger/SKILL.md'];
  const stale = /尚未在本机实测投递|后台派发路径待真机跑满一轮|派活链路待真机验证|(Claude Code|OpenCode)[^\n]{0,40}(未实测投递|不能用|尚未接入)/;
  for (const f of active) assert.doesNotMatch(fs.readFileSync(new URL(f, import.meta.url), 'utf8'), stale, `${f} 还留着过期的宿主状态口径`);
  assert.match(changelog, /历史条目[\s\S]{0,120}当时的结论/, 'CHANGELOG 头部要声明历史条目不是现状');
  assert.match(skill, /不是只有 Qoder 和 WorkBuddy 能用/, 'Skill 要明说四家都能用，别让 agent 照旧口径转述');

  // ③ 五家已装副本（本机有就查）关键句与正本一致
  const marker = '不是只有 Qoder 和 WorkBuddy 能用';
  const copies = [
    path.join(os.homedir(), '.qoder', 'skills', 'convledger', 'SKILL.md'),
    path.join(os.homedir(), '.claude', 'skills', 'convledger', 'SKILL.md'),
    path.join(os.homedir(), '.workbuddy', 'skills', 'convledger', 'SKILL.md'),
    path.join(os.homedir(), '.config', 'opencode', 'skills', 'convledger', 'SKILL.md'),
    path.join(os.homedir(), '.codex', 'skills', 'convledger', 'SKILL.md'),
  ];
  for (const p of copies) if (fs.existsSync(p)) assert.ok(fs.readFileSync(p, 'utf8').includes(marker), `${p} 副本没同步新状态口径`);

  // ④ CLI 的权威表带 status / gaps，且与能力表一致
  const base = fixture('caps-status');
  const root = path.join(base, 'store');
  fs.mkdirSync(root, { recursive: true });
  const t = capsTable(root);
  assert.match(t.statusSummary, /已验证：.*claude-code.*opencode/, '状态摘要要列出已验证的四家');
  for (const r of t.rows) {
    assert.equal(r.status, DEFAULT_CAPS[r.host].status, `${r.host} 的 caps 输出与能力表不一致`);
    assert.equal(r.statusLabel, STATUS[r.status]);
    assert.deepEqual(r.gaps, DEFAULT_CAPS[r.host].gaps);
  }
  fs.rmSync(base, { recursive: true, force: true });
});

test('常驻 hub 暂停标记：App 全局暂停按钮 / hub 端点 / 宿主事件与自动升级共用同一开关', async () => {
  const { hubPaused, pauseFile } = await import('../src/upgrade.mjs');
  const base = fixture('hub-paused');
  const tool = path.join(base, 'tool');
  fs.mkdirSync(path.join(tool, 'out'), { recursive: true });
  assert.equal(hubPaused(tool), false, '没有标记时不暂停');
  fs.writeFileSync(pauseFile(tool), 'pause\n');
  assert.equal(hubPaused(tool), true, '标记存在时暂停');
  const hook = fs.readFileSync(new URL('../hooks/ledger-brief.mjs', import.meta.url), 'utf8');
  const up = fs.readFileSync(new URL('../src/upgrade.mjs', import.meta.url), 'utf8');
  assert.match(up, /if \(hubPaused\(tool\)\)/, '自动升级起服务要判暂停标记');
  // App 里的「全局暂停」：hub 端点 + 顶栏按钮；ensureHubAuto 认标记；明确启动时清标记恢复
  const mapSrc = fs.readFileSync(new URL('../src/map.mjs', import.meta.url), 'utf8');
  assert.match(mapSrc, /url === '\/hub\/pause'/, 'hub 要有全局暂停端点');
  assert.match(mapSrc, /'HUB-PAUSED'/, '全局暂停要落标记文件');
  assert.match(fs.readFileSync(new URL('../web/app.html', import.meta.url), 'utf8'), /id="pause"/, 'App 顶栏要有全局暂停按钮');
  assert.match(fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8'), /\/hub\/pause/, '按钮要调暂停端点');
  assert.match(fs.readFileSync(new URL('../src/setup.mjs', import.meta.url), 'utf8'), /'HUB-PAUSED'/, 'ensureHubAuto 要认暂停标记、不自动起');
  assert.match(fs.readFileSync(new URL('../src/cli.mjs', import.meta.url), 'utf8'), /function resumeHub\(/, '双击图标/map 要清标记恢复');
  fs.rmSync(base, { recursive: true, force: true });
});

test('加载纪律：默认档位与 CLI 一致', () => {
  const prefs = fs.readFileSync(new URL('../src/prefs.mjs', import.meta.url), 'utf8');
  const cli = fs.readFileSync(new URL('../src/cli.mjs', import.meta.url), 'utf8');
  assert.match(prefs, /autoBuild:\s*'off'/, 'prefs 默认档位必须是 off');
  assert.match(cli, /buildN = flags\.all \? Infinity : 0/, 'CLI 默认只建当前这一段');
});

test('长历史按片建账：首次只建尾部一片、每轮补一片、存量全量账本零回归', () => {
  const base = fixture('window-slice');
  const SID = 'window-slice-0001';
  const src = `${base}/${SID}.jsonl`;
  const L = [JSON.stringify({ type: 'workspace-directories', directories: ['D:/fixture/window'], timestamp: new Date(1760000000000).toISOString() })];
  for (let i = 0; i < 600; i++) {
    const role = i % 2 ? 'assistant' : 'user';
    L.push(JSON.stringify({
      type: role, sessionId: SID, uuid: `u${i}`, timestamp: new Date(1760000000000 + i * 1000).toISOString(),
      cwd: 'D:/fixture/window', ...(role === 'user' ? { humanInput: '请把这一段会话的进度整理成账本' } : {}),
      message: { role, content: [{ type: 'text', text: '整理当前进度并说明下一步' + 'x'.repeat(1600) }] },
    }));
  }
  fs.writeFileSync(src, L.join('\n') + '\n', 'utf8');
  const size = fs.statSync(src).size;
  assert.ok(size > SLICE_BYTES * 2, '夹具要比两片还长，才验得出「只建一片」');

  const root = `${base}/store`;
  fs.mkdirSync(root, { recursive: true });
  const ledFile = `${root}/${SID}/ledger.json`;
  const first = indexWindowed(src, { storeRoot: root });
  assert.equal(first.action, 'first', '刚接入的长历史要先只建尾部一片');
  assert.ok(first.parsedBytes <= SLICE_BYTES + 4096, `单次解析不许超过一片：${first.parsedBytes}`);
  assert.ok(first.segs > 0, '当前上下文这一段要真的建出段');
  let led = JSON.parse(fs.readFileSync(ledFile, 'utf8'));
  assert.equal(led.window.mode, 'slice');
  assert.equal(led.sourceBytes, size, '源规模要报全文件，别显示成 256KB');
  assert.equal(led.sourceRecords, led.window.lastSlice.endLine);
  const ids1 = led.segments.map((s) => s.id);
  assert.ok(ids1.every((id) => /^S\d{6,}$/.test(id)), '段 id 要用全文件绝对行号，逐片追加才不改名');
  assert.ok(ids1.every((id, i) => i === 0 || +id.slice(1) > +ids1[i - 1].slice(1)), '段按时间正序');

  // 更早的记录只提供只读文本，不生成段/卡/索引。
  const raw = rawRecords(src, led);
  assert.ok(raw.lines.length > 0, '未建账部分要能按行只读展示');
  assert.equal(raw.complete, false);
  assert.equal(raw.totalBytes, size);

  const grow = indexWindowed(src, { storeRoot: root, grow: true });
  assert.equal(grow.action, 'grow');
  assert.ok(grow.parsedBytes <= SLICE_BYTES + 4096, '补一片也不能放大单次解析量');
  led = JSON.parse(fs.readFileSync(ledFile, 'utf8'));
  assert.ok(led.segments.length >= ids1.length, '补片后总段数不能变少');
  for (const id of ids1) assert.ok(led.segments.some((s) => s.id === id), `补片后旧段 ${id} 不能改名或丢掉`);
  assert.ok(led.window.coveredFromByte < first.window.coveredFromByte, '游标要往更早的记录走');

  const tail = indexWindowed(src, { storeRoot: root });
  assert.equal(tail.action, 'tail', '源又长了就重算尾部当前片');
  assert.ok(tail.parsedBytes <= SLICE_BYTES + 4096);
  assert.doesNotThrow(() => readView(`${root}/${SID}`), '逐片合并出的账本要能正常读视图');

  // 存量账本（没有 window 字段）一律维持原来的全量重建，零回归。
  const oldRoot = `${base}/store-full`;
  fs.mkdirSync(oldRoot, { recursive: true });
  writeStore(oldRoot, build(src, { storeRoot: oldRoot }));
  const again = indexWindowed(src, { storeRoot: oldRoot, grow: true });
  assert.equal(again.action, 'full', '已经全量建过的账本不许被悄悄改成按片模式');

  fs.rmSync(base, { recursive: true, force: true });
});

test('主线程零全库重活：worker 缓存 + 冷开空壳，/health 不碰磁盘', () => {
  const mapSrc = fs.readFileSync(new URL('../src/map.mjs', import.meta.url), 'utf8');
  const refreshSrc = fs.readFileSync(new URL('../src/refresh.mjs', import.meta.url), 'utf8');
  assert.match(mapSrc, /url === '\/health' && method === 'GET'/, '/health 要排在所有轮询与派活之前');
  assert.match(mapSrc, /refresh\.getProjects\(/, '项目清单走 worker 缓存');
  assert.match(mapSrc, /refresh\.getProjectDetail\(/, '项目页四条全库重活走 worker 缓存');
  assert.match(refreshSrc, /COLD_WAIT_MS/, '冷开只给后台一小段宽限，不许同步算完');
  assert.doesNotMatch(refreshSrc, /usageReport\(|statusSnapshot\(|libraryOf\(/, '刷新管理器不许留内联兜底');
  const hookSrc = fs.readFileSync(new URL('../hooks/ledger-brief.mjs', import.meta.url), 'utf8');
  assert.match(hookSrc, /led\?\.window\?\.mode === 'slice'/, 'Stop 每轮补片只对按片建的账本生效');
  assert.match(hookSrc, /catchup-slice/, '补片要留痕');
});

test('宿主残留实例：只清无窗口且超龄的，有窗口绝不碰', () => {
  // 一套有窗口的新实例 + 一套崩溃后留下的无窗口旧实例（2026-11-13 真实发生过：渲染进程 OOM
  // 被杀，主进程卡在收尾退不掉，留下 2.5G 没有窗口的进程树）
  const procs = [
    { pid: 1, ppid: 999, type: 'main', start: 1000, mem: 500 },
    { pid: 2, ppid: 1, type: 'renderer', start: 1001, mem: 700 },
    { pid: 10, ppid: 999, type: 'main', start: 100, mem: 1000 },
    { pid: 11, ppid: 10, type: 'gpu', start: 101, mem: 280 },
  ];
  const trees = buildTrees(procs);
  assert.equal(trees.length, 2, '两套实例要拆成两棵树');
  assert.equal(pickKeep(trees).root.pid, 1, '保留有 renderer 的那套');
  assert.deepEqual(pickStray(trees, { now: 5000 }).map((t) => t.root.pid), [10], '无窗口且超龄的才清');
  assert.deepEqual(pickStray(trees, { now: 150 }).map((t) => t.root.pid), [], '刚启动的给 90 秒宽限期');
  // 有窗口的树再老也不许清
  const withWindow = buildTrees([
    { pid: 1, ppid: 999, type: 'main', start: 10, mem: 100 },
    { pid: 2, ppid: 1, type: 'renderer', start: 11, mem: 100 },
    { pid: 10, ppid: 999, type: 'main', start: 20, mem: 100 },
  ]);
  assert.deepEqual(pickStray(withWindow, { now: 100000 }).map((t) => t.root.pid), [10], '有 renderer 的那棵再老也不清，无窗口的照清');
});

test('综述落盘不再每次都重建：历史块走快路径，锚点过期才重建', () => {
  const src = fs.readFileSync(new URL('../src/cli.mjs', import.meta.url), 'utf8');
  assert.match(src, /let applied = attempt\(\);/, '先拿现有账本乐观校验（读账本 15ms，重建 1562ms）');
  assert.match(src, /if \(applied\.errors\.length\)/, '只有校验落败才走重建重试');
  // 只看 summarise 这一段：别的命令（phases/memory）也各有一次重建，不能算进来。
  const from = src.indexOf("if (cmd === 'summarise')");
  const to = src.indexOf('// 阶段表', from);
  const seg = src.slice(from, to > from ? to : from + 6000);
  assert.equal((seg.match(/writeStore\(root, build\(/g) || []).length, 1,
    '重建只能出现在重试分支里；无条件重建会让每次落盘白花 1.5 秒');
  assert.ok(seg.indexOf('writeStore(root, build(') > seg.indexOf('if (applied.errors.length)'),
    '重建必须在「校验落败」之后，不能又挪回开头');
});

test('LLM 后端：只给一个 key 就能接——脱敏、挑模型、认路径、key 不进库', () => {
  // key 出现在任何回执里都必须是脱敏的
  assert.equal(maskKey('test-abcdefghijklmnop'), 'tes…mnop');
  assert.equal(maskKey('short'), 'sh…');
  assert.equal(maskKey(''), '（未设置）');
  // 补账不需要旗舰：优先便宜快的
  assert.equal(pickModel(['pro-max', 'flash-lite', 'mini-1']), 'flash-lite');
  assert.equal(pickModel(['gpt-4o', 'mini']), 'mini');
  assert.equal(pickModel(['only-one']), 'only-one');
  assert.equal(pickModel([]), null);
  // OW Bridge 的 api-key 落点按平台走
  assert.match(bridgeDataDir({ platform: 'win32', env: { APPDATA: 'C:/A' }, home: 'C:/H' }), /Buddy Bridge$/);
  assert.match(bridgeDataDir({ platform: 'darwin', env: {}, home: '/Users/x' }), /Library[\\/]Application Support[\\/]Buddy Bridge$/);
  assert.match(bridgeDataDir({ platform: 'linux', env: {}, home: '/home/x' }), /\.config[\\/]Buddy Bridge$/);
  // 配置读写：写进去、读回来、能清掉；文件落在 store 下
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-'));
  try {
    writeLlm(tmp, { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'test-abcdefghijklmnop', model: 'm', provider: 'custom', models: ['m', 'm2'] });
    const back = readLlm(tmp);
    assert.equal(back.configured, true, 'baseURL + apiKey 都在才算接上');
    assert.equal(back.model, 'm');
    assert.deepEqual(back.models, ['m', 'm2']);
    assert.ok(fs.existsSync(path.join(tmp, 'llm.json')), '配置要落成 llm.json');
    clearLlm(tmp);
    assert.equal(readLlm(tmp).configured, false, '--clear 之后要回到「没接」');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  // key 不进库：配置落在 tool/out 下，那里必须被 gitignore
  const gi = fs.readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8');
  assert.match(gi, /tool\/out\//, 'tool/out 必须被忽略，llm.json 里的 key 才不会进版本库');
  // 命令面：三条接入路径都得在 usage 里，否则用户找不到
  const cliSrc = fs.readFileSync(new URL('../src/cli.mjs', import.meta.url), 'utf8');
  assert.match(cliSrc, /convledger llm \[--key/, 'usage 要登记 llm');
  assert.match(cliSrc, /--bridge/, '要能直接读本机 OW Bridge 的 key');
  assert.match(cliSrc, /--base-url/, '要能接任意 OpenAI 兼容网关');
  assert.match(cliSrc, /detectBridge\(\)/, 'OW Bridge 要自动发现，不能让人手抄端点');
  // 网络错误要翻成人话，别把 "fetch failed" 甩给用户
  const refused = new TypeError('fetch failed');
  refused.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
  assert.match(describeNetError(refused, 5000), /端口没人听/);
  const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
  assert.match(describeNetError(aborted, 3000), /超时（3000ms）/);
  const dns = new TypeError('fetch failed');
  dns.cause = Object.assign(new Error('getaddrinfo ENOTFOUND nope'), { code: 'ENOTFOUND' });
  assert.match(describeNetError(dns, 5000), /域名解析不了/);
});

test('钥匙串：贴过的 key 记本机、认得出归属、一键换回、明文不再外露', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-ring-'));
  try {
    // 存两条：一条 OmniRoute（本机转接）、一条 DeepSeek；列表记住归属
    saveKeyEntry(tmp, { apiKey: 'test-omni000111222333444', baseURL: 'http://127.0.0.1:20128/v1', provider: 'omni-route', label: 'OmniRoute（本机转接）', model: 'dva/glm-5-3-flash-max', models: ['dva/glm-5-3-flash-max', 'auto/fast'] });
    saveKeyEntry(tmp, { apiKey: 'test-deep999888777666555', baseURL: 'https://api.deepseek.com/v1', provider: 'deepseek', label: 'DeepSeek', model: 'deepseek-chat', models: ['deepseek-chat'] });
    const ring = listSavedKeys(tmp);
    assert.equal(ring.length, 2, '两条都记下了');
    assert.ok(ring.every((k) => k.id && k.keyMasked && k.baseURL && k.label), '每条要带 id / 脱敏 key / 端点 / 归属');
    assert.ok(!JSON.stringify(ring).includes('test-omni000111222333444'), '列表绝不外露明文 key');
    assert.ok(!JSON.stringify(ring).includes('test-deep999888777666555'), '列表绝不外露明文 key');
    assert.ok(!('apiKey' in ring[0]), '回给页面的条目里连 apiKey 字段都不能有');
    // 重复贴同一条去重，只更新归属信息
    saveKeyEntry(tmp, { apiKey: 'test-omni000111222333444', baseURL: 'http://127.0.0.1:20128/v1', provider: 'omni-route', label: 'OmniRoute（本机转接）', model: 'auto/fast', models: ['auto/fast'] });
    assert.equal(listSavedKeys(tmp).length, 2, '同一条 key 重贴去重');
    assert.equal(listSavedKeys(tmp).find((k) => k.provider === 'omni-route').model, 'auto/fast', '重贴会更新模型选择');
    // 切换：切到 OmniRoute 那条，当前配置跟着走，lastUsedAt 记下
    const omniId = listSavedKeys(tmp).find((k) => k.provider === 'omni-route').id;
    const cur = useSavedKey(tmp, omniId);
    assert.equal(cur.baseURL, 'http://127.0.0.1:20128/v1');
    assert.equal(cur.provider, 'omni-route');
    assert.equal(cur.model, 'auto/fast');
    assert.deepEqual(cur.models, ['auto/fast'], '切换要带上记下的模型列表，不用重探');
    assert.equal(listSavedKeys(tmp).find((k) => k.id === omniId).inUse, true, '列表要标出使用中');
    // writeLlm 不丢钥匙串
    writeLlm(tmp, { baseURL: 'https://api.openai.com/v1', apiKey: 'test-open123123123123123', model: 'gpt-4o-mini', provider: 'openai', models: ['gpt-4o-mini'] });
    assert.equal(listSavedKeys(tmp).length, 2, '换端重接不丢贴过的 key');
    // 老配置自动收进串
    ensureActiveSaved(tmp);
    assert.equal(listSavedKeys(tmp).length, 3, '已接但没入串的 key 会被 ensureActiveSaved 收进来');
    assert.equal(listSavedKeys(tmp).find((k) => k.provider === 'openai').inUse, true, '新收的这条就是使用中');
    // 正在使用的不许删
    const openId = listSavedKeys(tmp).find((k) => k.provider === 'openai').id;
    assert.throws(() => removeSavedKey(tmp, openId), /正在使用/, '使用中的条目删除要被拒');
    // 断开：当前连接清掉，钥匙串原样留着
    clearLlm(tmp);
    const after = readLlm(tmp);
    assert.equal(after.configured, false, '断开之后回到「没接」');
    assert.equal(listSavedKeys(tmp).length, 3, '断开不丢钥匙串');
    // 删一条真的少一条
    assert.equal(removeSavedKey(tmp, omniId), true, '删掉不用的那条');
    assert.equal(listSavedKeys(tmp).length, 2, '删完少一条');
    // 切换到不存在的 id 要报人话
    assert.throws(() => useSavedKey(tmp, 'k-nonexistent'), /钥匙串里没有/, '切换不存在的 id 要报人话');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  // 接线：路由、页面、CLI 都得在
  const map = fs.readFileSync(new URL('../src/map.mjs', import.meta.url), 'utf8');
  assert.match(map, /url === '\/llm\/keys'/, '页面要能切换/删除已存 key');
  assert.match(map, /savedKeys: listSavedKeys\(root\)/, '配置视图要带钥匙串（listSavedKeys 自带脱敏）');
  assert.match(map, /ensureActiveSaved\(root\)/, '视图读取时把没入串的活跃 key 收进来');
  assert.match(map, /saveKeyEntry\(root, \{ apiKey: picked\.apiKey/, '页面接上的 key 要顺手入串');
  const html = fs.readFileSync(new URL('../web/app.html', import.meta.url), 'utf8');
  assert.match(html, /id="llmkeys"/, '设置页要有钥匙串列表');
  const js = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.match(js, /renderLlmKeys\(/, '设置页要渲染钥匙串');
  assert.match(js, /\/llm\/keys/, '切换/删除要打到 /llm/keys');
  const cli = fs.readFileSync(new URL('../src/cli.mjs', import.meta.url), 'utf8');
  assert.match(cli, /flags\.keys \|\| flags\.use \|\| flags\.forget/, 'CLI 要有 --keys/--use/--forget');
  assert.match(cli, /saveKeyEntry\(root, \{ apiKey: cfg\.apiKey/, 'CLI 接上的 key 也要入串');
});

test('设置页能直接填 key：三个后端端点 + 界面入口 + key 只回脱敏值', () => {
  const map = fs.readFileSync(new URL('../src/map.mjs', import.meta.url), 'utf8');
  assert.match(map, /url === '\/llm\.json'/, '页面要能读当前模型配置');
  assert.match(map, /url === '\/llm\/test'/, '页面要能试连通');
  assert.match(map, /keyMasked: c\.apiKey \? maskKey\(c\.apiKey\)/, '回给页面的 key 必须脱敏');
  assert.doesNotMatch(map, /json\(200, *\{+ *apiKey/, '绝不把原始 key 发给页面');
  // 写配置必须过同源闸，别让别的页面能把 key 换掉
  const saveBlock = map.slice(map.indexOf("url === '/llm'"), map.indexOf("url === '/llm/test'"));
  assert.match(saveBlock, /ORIGIN_OK\(req\.headers\.origin, port0\)/, '保存配置要校验同源');
  const html = fs.readFileSync(new URL('../web/app.html', import.meta.url), 'utf8');
  assert.match(html, /data-view="settings"/, '左栏要有设置入口');
  assert.match(html, /id="llmkey"[^>]*type="password"/, 'key 输入框必须是 password 类型');
  assert.match(html, /id="llmtest"/, '要有「测试连通」按钮');
  assert.match(html, /id="llmbridge"/, '要能一键读本机 OW Bridge');
  const js = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.match(js, /function loadLlm\(/, '设置页要加载当前配置');
  assert.match(js, /settings: '模型配置'/, 'VIEW_TITLE 要登记 settings（页面叫「模型配置」），否则路由回退到看板');
  assert.match(js, /if \(v === 'settings'\) \{ loadLlm\(\); \}/, '切到模型配置页要拉一次配置');
  assert.doesNotMatch(js, /innerHTML/, 'app.js 不许用 innerHTML（防 XSS）');
  // 模型配置页结构：已存的 Key 是独立板块（仿切换器），接入表单是另一块，不混在一个表单里
  assert.match(html, /已存的 Key/, '钥匙串要独立成板块，页面上能直接看到存了哪些 key');
  assert.match(html, /id="llmkeystate"/, '钥匙串板块要有状态行（几条 · 当前用哪条）');
  assert.match(html, /接入新的 Key/, '接入表单是独立板块');
  const keysPanel = html.slice(html.indexOf('id="llmkeys"'), html.indexOf('接入新的 Key'));
  assert.doesNotMatch(keysPanel, /id="llmkey"/, 'key 列表板块里不许混进接入表单');
  // 视图布局规则必须用 :not([hidden]) 限定：裸 #view-settings { display: grid } 的 ID 优先级
  // 会压过 .view[hidden] 的 display:none，模型配置内容因此在每个页面底部都渲染一遍（2026-11-14 事故）
  const css = fs.readFileSync(new URL('../web/app.css', import.meta.url), 'utf8');
  assert.match(css, /#view-settings:not\(\[hidden\]\)/, '设置板块布局要限定在未隐藏态');
  assert.doesNotMatch(css, /#view-\w+\s*\{[^}]*display:(?!none)[^}]*\}(?![^#]*:not\(\[hidden\]\))/, '别的视图也不许再有裸 display 规则顶掉 hidden');
  // 「已存的 Key」不能永远停在「正在读取」：loadLlm 不许因单个元素缺失整段早退（2026-11-14 事故）
  assert.match(html, /id="llmstate"/, '接入板块要带状态元素');
  assert.doesNotMatch(js, /if \(!EL\.llmstate\) return;/, 'loadLlm 不许因 llmstate 缺失早退——会把钥匙串状态一起饿死');
  assert.match(js, /if \(EL\.llmkeystate\) EL\.llmkeystate\.textContent = '读不到配置'/, '拉取失败时钥匙串状态行也要给人话');
  // 已存 Key 的状态行不能永远停在「正在读取」：进入视图要真的拉一次
  assert.match(js, /function loadLlm\(\)/, 'loadLlm 要存在并在切到该视图时调用');
});

test('资产署名：制作人与 GitHub 账号在各入口一致', () => {
  const root = new URL('../../', import.meta.url);
  const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');
  const app = read('tool/web/app.html');
  assert.match(app, /<meta name="author" content="再来一杯海星酒 \(zhl110\)">/, '网页要有 author meta');
  assert.match(app, /制作人 再来一杯海星酒/, '应用窗标题要带制作人');
  assert.match(read('tool/web/app.js'), /DOC_TITLE = 'convledger · 制作人 再来一杯海星酒'/,
    '窗口标题不跟视图名漂移');
  assert.match(read('tool/src/cli.mjs'), /制作人：再来一杯海星酒 · GitHub zhl110/, 'CLI 帮助要带署名');
  const readme = read('README.md');
  assert.match(readme, /再来一杯海星酒/);
  assert.match(readme, /github\.com\/zhl110/);
  const pkg = JSON.parse(read('tool/package.json'));
  assert.equal(pkg.author?.name, '再来一杯海星酒');
  assert.equal(pkg.author?.url, 'https://github.com/zhl110');
  assert.match(read('LICENSE.md'), /再来一杯海星酒\s*[（(]\s*zhl110/, '许可文件的版权人要写清网名与账号');
  for (const p of ['tool/web/hub.html', 'tool/web/atlas.html', 'tool/web/architecture.html']) {
    assert.match(read(p), /<meta name="author"/, `${p} 缺 author meta`);
  }
});

test('桌面壳：工作台空状态会重拉，托盘隐藏启动不闪黑框', () => {
  const js = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.match(js, /function mountWork/, '工作台挂载要抽成一个可重复调用的函数');
  assert.match(js, /30000/, '项目表要有缓存时限，不能永远停在首次的空列表');
  assert.match(js, /currentView === 'work'\) mountWork\(false\)/, '轮询时工作台要重拉项目表');
  const setup = fs.readFileSync(new URL('../src/setup.mjs', import.meta.url), 'utf8');
  assert.match(setup, /tray-launch\.vbs/, '托盘要走隐藏启动器');
  assert.match(setup, /wscript\.exe/, 'wscript 没有控制台，不会闪黑框');
  const vbs = fs.readFileSync(new URL('../tray-launch.vbs', import.meta.url), 'utf8');
  assert.match(vbs, /sh\.Run cmd, 0, False/, 'Run 的窗口样式 0＝隐藏');
  assert.doesNotMatch(vbs, /[^\x00-\x7F]/, 'VBS 只能 ASCII：中文注释会让 wscript 弹错误框');
});

test('后台接管：没接模型时明确拒绝，不假装补过', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'takeover-'));
  try {
    await assert.rejects(() => runAuto(tmp, { sessionId: 'nope' }), /还没接模型/,
      '没接 key 就不该起循环，更不许静默当作补完');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('补账优先级：接了模型走后台循环，没接才轮到 Agent，总闸关则全停', () => {
  // hook 侧：总闸三态——关＝谁都不补；开+接 key＝后台模型；开+没接＝Agent 老路
  const hook = fs.readFileSync(new URL('../hooks/ledger-brief.mjs', import.meta.url), 'utf8');
  assert.match(hook, /lc\.enabled === false\) return \{ skip: 'auto-off' \}/,
    '总闸关＝LLM 与当前 Agent 都不再补综述（欠项留着不派）');
  assert.match(hook, /lc\.configured\) return \{ skip: 'llm-backend' \}/,
    '总闸开且接了 key＝后台模型补，当前 Agent 退出');
  assert.match(hook, /closeout/, '压缩边界要能起后台补账循环');
  assert.match(hook, /tryLock\(STORE, sid\)/, '起循环前要拿锁防重入');
  assert.match(hook, /detached: true/, '后台循环要脱离 hook 进程跑，不占任何前台');
  assert.match(hook, /items\.length && !autoOff/, '总闸关时压缩边界连综述欠项都不列');
  // 循环本体：每轮看总闸；分批复用既有策略；落盘走既有闸门；子进程显式传 store
  const auto = fs.readFileSync(new URL('../src/closeout-auto.mjs', import.meta.url), 'utf8');
  assert.match(auto, /if \(!llmOn\(root\)\)/, '循环每轮开头看总闸，关了立刻收手');
  assert.match(auto, /pickSummaryBatch\(/, '循环要复用分批策略（尾 4 块 → 往前 1 块）');
  assert.match(auto, /'summarise', '--put'/, '落盘必须走 summarise --put 的全量闸门，便宜模型也不许绕');
  assert.match(auto, /'--store', root/, '子进程要显式传 --store，别写进默认账本');
  assert.match(auto, /LOCK_MS = 10 \* 60 \* 1000/, '锁要有过期时间，进程崩了不永久卡死');
  assert.match(auto, /r\.error \?\? r\.stderr/, 'spawn 失败要把 error 带出来，别只留三个字');
  assert.match(auto, /closeout-result-/, '跑完要写结果文件，人能查到成没成');
  // 2026-11-14 全面接管：收尾/阶段/记忆/画像也认 key，不再派 Agent
  assert.match(hook, /lc\.configured && lc\.enabled !== false\)[\s\S]{0,200}skip: 'llm-backend'/,
    '收尾也认已接 key：不再向当前 Agent 派后台会话');
  assert.match(hook, /function maybeAutoSpawn/, 'Stop 末尾统一看欠项起后台循环');
  assert.match(hook, /function spawnAuto/, '起循环要拿锁并 detached');
  assert.match(hook, /llmConfigured/, '画像也按是否接 key 分流');
  assert.match(hook, /后台模型静默收尾/, '压缩档也要走后台模型');
  // 循环本体五段：每段落盘都走既有 --put
  assert.match(auto, /'sync', '--put'/, '收尾任务也走 sync --put 闸门');
  assert.match(auto, /'phases', '--put'/, '阶段也走 phases --put 闸门');
  assert.match(auto, /'memory', '--put'/, '记忆也走 memory --put 闸门');
  assert.match(auto, /'--scope', 'user'/, '画像写用户表');
  assert.match(auto, /'--tasks'/, '任务题名也接管');
  assert.match(auto, /stageSummaries[\s\S]*stageSync[\s\S]*stagePhases[\s\S]*stageMemory[\s\S]*stageProfile/,
    '五段欠项都在同一份循环里');
  // 开关本身：setEnabled 只翻开关不动 key；命令与页面都要有
  assert.match(fs.readFileSync(new URL('../src/llm.mjs', import.meta.url), 'utf8'),
    /export function setEnabled\(root, on\)/, 'setEnabled 只翻开关');
  const cli = fs.readFileSync(new URL('../src/cli.mjs', import.meta.url), 'utf8');
  assert.match(cli, /cmd === 'closeout'/, 'closeout 命令要存在');
  assert.match(cli, /flags\.on \|\| flags\.off/, 'CLI 要有 --on/--off');
  const html = fs.readFileSync(new URL('../web/app.html', import.meta.url), 'utf8');
  assert.match(html, /id="llmauto"/, '设置页要有总闸开关');
});

console.log(`selftest on ${FILE}\n  runner=${ledger.runner} segments=${segments.length} turns=${facts.turns.total} calls=${facts.toolCalls.total} boundaries=${facts.boundaries.length} routeTokens=${built.indexTokens + built.cardTokens}`);

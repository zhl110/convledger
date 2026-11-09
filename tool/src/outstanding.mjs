// 链路自检：把「还欠什么」一次列出来，交给收尾提示或 agent 主动补。
// 只读账本与项目状态，不生成内容；模型写的综述/题名/阶段仍由 agent 补。
import { readView } from './view.mjs';
import { storeDir } from './store.mjs';
import { readState } from './state-io.mjs';
import { projectKey } from './projects.mjs';
import { readRequests } from './notes.mjs';
import { CHAP_MIN_PHASES } from './cost.mjs';

export function outstandingFor({ storeRoot, sessionId, cwd = null }) {
  const dir = storeDir(storeRoot, sessionId);
  const v = readView(dir);
  const key = cwd ? projectKey(cwd) : null;
  let state = { candidates: [] };
  if (key) { try { state = readState(storeRoot, key).state; } catch { /* 项目还没状态 */ } }
  const tail = v.tail ? { from: v.tail.from, to: v.tail.to } : null;
  const allMissing = v.steps.filter((s) => !s.sum).map((s) => s.i);
  // 只看当前一步的尾段＝这一步还没收口；它的综述/阶段写进去马上会失效，不算欠项。
  const liveTail = tail && tail.from >= v.mainSteps ? tail : null;
  const liveBlocks = liveTail
    ? allMissing.filter((i) => {
      const s = v.steps.find((x) => x.i === i);
      return s && (s.step == null ? (s.afterStep ?? 0) >= liveTail.from : s.step >= liveTail.from);
    })
    : [];
  const missingBlocks = allMissing.filter((i) => liveBlocks.indexOf(i) < 0);
  // 只有主支题名会进卡片；非主支不写题名不算欠项（与 digest --tasks 同一把尺）。
  const dominant = new Set(v.steps.map((s) => s.dominant).filter(Boolean));
  const missingTitles = v.tasks.filter((t) => dominant.has(t.id) && !t.sumTitle).length;
  const pendingCandidates = (state.candidates ?? []).filter((c) => (c.state ?? 'candidate') === 'candidate').length;
  let pendingRequests = 0;
  try { pendingRequests = readRequests(dir).rows.filter((r) => !r.done).length; } catch { /* 没有请求表 */ }
  const items = [];
  let draftRanges = [];
  if (missingBlocks.length) {
    items.push(`块综述缺 ${missingBlocks.length} 块（${missingBlocks.slice(0, 8).join(',')}${missingBlocks.length > 8 ? '…' : ''}）`);
  }
  if (missingTitles) items.push(`支线题名缺 ${missingTitles} 条`);
  if (tail && !liveTail) {
    // 只做边界草稿，不写说明：每 8 步一段，末段 <2 步就并回上一段。
    for (let s = tail.from; s <= tail.to; s += 8) draftRanges.push([s, Math.min(s + 7, tail.to)]);
    if (draftRanges.length > 1) {
      const a = draftRanges[draftRanges.length - 2], b = draftRanges[draftRanges.length - 1];
      if (b[1] - b[0] + 1 < 2) { a[1] = b[1]; draftRanges.pop(); }
    }
    items.push(`尾段第 ${tail.from}–${tail.to} 步没有阶段说明（候选区间：${draftRanges.map(([a, b]) => `${a}–${b}`).join('、')}）`);
  }
  if (pendingCandidates) items.push(`待证候选 ${pendingCandidates} 条`);
  if (pendingRequests) items.push(`待办请求 ${pendingRequests} 条`);
  // 章欠项：只有攒够一章（≥CHAP_MIN_PHASES 段没并进章）才是写得出来的欠项，
  // 差一两段的说「欠一章」等于让人去写一张会被闸门挡掉的表。
  const chTo = (v.chapters || []).reduce((m, c) => Math.max(m, c.to), 0);
  const uncharted = v.phases.filter((p) => p.from > chTo);
  if (uncharted.length >= CHAP_MIN_PHASES) {
    items.push(`已写的 ${uncharted.length} 段阶段还没并进章（第 ${chTo + 1}–${v.phases.reduce((m, p) => Math.max(m, p.to), 0)} 步）：chapters --digest → chapters --put`);
  }
  return {
    ok: !items.length, project: key, session: sessionId,
    blocks: v.steps.length, missingBlocks, missingTitles, tail, liveTail, liveBlocks, draftRanges,
    pendingCandidates, pendingRequests, unchartedPhases: uncharted.length, items,
    // 整理过多少＝还有效的模型条目，hash 对不上的不计（与画布回落同一把尺）。
    // 会话库与 sessions 都读这一份，不再各数各的。
    written: {
      sums: v.meta.summaries.blocks,
      sumsDropped: v.meta.summaries.dropped,
      titles: v.meta.summaries.tasks,
      titlesOf: v.tasks.filter((t) => dominant.has(t.id)).length,
      phases: v.meta.phases.written,
      phasesDropped: v.meta.phases.dropped,
      chapters: v.meta.chapters?.written ?? 0,
      chaptersDropped: v.meta.chapters?.dropped ?? 0,
      verified: v.meta.verified,
    },
  };
}

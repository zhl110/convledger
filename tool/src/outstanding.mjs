// 链路自检：把「还欠什么」一次列出来，交给收尾提示或 agent 主动补。
// 只读账本与项目状态，不生成内容；模型写的综述/题名/阶段仍由 agent 补。
import { readView } from './view.mjs';
import { storeDir } from './store.mjs';
import { readState } from './state-io.mjs';
import { projectKey } from './projects.mjs';
import { readRequests } from './notes.mjs';
import { CHAP_MIN_PHASES } from './cost.mjs';
import { draftPhaseRanges } from './brief.mjs';
import { memoryDue } from './profile-auto.mjs';

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
    // 边界草稿与 brief 里那行共用 draftPhaseRanges：两处各写一遍，切法迟早会漂。
    draftRanges = draftPhaseRanges(tail.from, tail.to);
    items.push(`尾段第 ${tail.from}–${tail.to} 步没有阶段说明（候选区间：${draftRanges.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join('、')}）`);
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
  // 记忆归纳（PRD-memory §十二）：看增量不看日历。这里只报「攒够了」，不催每轮——
  // 增量没涨就不出现，所以它天然不会变成噪音。
  let memDue = null;
  try {
    memDue = memoryDue(storeRoot, key);
    if (memDue.project.due) {
      items.push(`项目记忆该归纳了（自上次归纳新增 ${memDue.project.lessons} 条带经验的块、${memDue.project.sessions} 个会话）：memory --digest --project ${key} → memory --put -`);
    }
    if (memDue.user.due) {
      items.push(`用户画像该更新了（自上次新增 ${memDue.user.sessions} 个会话）：memory --digest --class 画像 → memory --put - --scope user`);
    }
  } catch { /* 判定失败不影响其它欠项 */ }
  return {
    ok: !items.length, project: key, session: sessionId,
    blocks: v.steps.length, missingBlocks, missingTitles, tail, liveTail, liveBlocks, draftRanges,
    pendingCandidates, pendingRequests, unchartedPhases: uncharted.length, memoryDue: memDue, items,
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

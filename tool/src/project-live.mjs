// 项目页的「会话实时」：任务模型要收尾才更新，账本却是每 20 秒重建的。
// 这里只读最近一段会话的账本与源文件位置，回答「现在做到第几步、哪一块、还有多少没收尾」，
// 全部是派生数，不替任务模型写结论。
import fs from 'node:fs';
import { projectsOf } from './projects.mjs';
import { readView } from './view.mjs';

export function projectLive(root, key, state, { now = Date.now() } = {}) {
  let project = null;
  try { project = projectsOf(root, { now, withSteps: false }).projects.find((p) => p.key === key) ?? null; }
  catch { project = null; }
  const members = project?.members ?? [];
  if (!members.length) return { ok: false, at: new Date(now).toISOString(), members: 0, liveCount: 0, session: null, step: null, pendingBytes: null };

  // 最新一段优先；有正在写的会话就先看它。
  const top = members.find((m) => m.live) ?? members[0];
  let step = null;
  try {
    const v = readView(top.dir);
    const last = [...v.steps].reverse().find((s) => s.step === v.mainSteps) ?? v.steps[v.steps.length - 1] ?? null;
    step = {
      n: v.mainSteps ?? null,
      block: last?.i ?? null,
      phase: last?.phase ?? null,
      title: last?.sum?.title ?? '',
    };
  } catch { /* 账本读不了就不编步号 */ }

  let sourceBytes = null;
  try { sourceBytes = fs.statSync(top.sourceFile).size; } catch { /* 源被清了，只剩归档 */ }
  const cp = state?.checkpoints?.[top.id];
  const analyzedThrough = Number(cp?.analyzedThrough ?? 0);
  const pendingBytes = sourceBytes == null ? null : Math.max(0, sourceBytes - analyzedThrough);

  return {
    ok: true,
    at: new Date(now).toISOString(),
    members: members.length,
    liveCount: members.filter((m) => m.live).length,
    session: {
      id: top.id, sid8: top.sid8, runner: top.runner, title: top.title, titleFrom: top.titleFrom,
      workspace: top.workspace, live: top.live, idleMin: top.idleMin, lastAt: top.lastAt,
      requestsPending: top.requestsPending,
    },
    step,
    sourceBytes,
    analyzedThrough,
    pendingBytes,
  };
}

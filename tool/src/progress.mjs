// 项目任务模型：里程碑（PM）、任务（PT）、事件（EV）与验收项。
// 只做领域判断：什么能叫 done、什么算纳入范围、依赖有没有环、计数怎么派。
// 文件读写、锁、revision 提交在 ./state-io.mjs；从源里取材在 ./sync.mjs。
// 旧会话账本的段/块/步一律不动——任务不是段落，段只是它的证据入口。
import { wlen } from './lib.mjs';

export const SCHEMA = 1;
export const STATUSES = ['unknown', 'planned', 'active', 'blocked', 'awaiting-verification', 'done', 'cancelled'];
export const STATUS_LABEL = {
  unknown: '待核实', planned: '未开始', active: '进行中', blocked: '受阻',
  'awaiting-verification': '待验证', done: '已完成', cancelled: '已取消',
};
export const SCOPE_KINDS = ['user-request', 'approved-plan', 'model-suggestion'];
export const ACCEPT_KINDS = ['test', 'artifact', 'human'];
export const ACCEPT_RESULTS = ['pending', 'pass', 'fail', 'waived'];
export const EVENT_TYPES = ['started', 'progressed', 'verified', 'blocked', 'reopened', 'cancelled', 'split', 'merged', 'corrected'];
export const TASK_LIMITS = { short: 12, title: 28, result: 60, nextAction: 60 };

export const createState = (project) => ({
  schema: SCHEMA,
  project,
  revision: 0,
  milestones: [],
  tasks: [],
  taskEvents: [],
  checkpoints: {},
  candidates: [],
  batches: [],
  outbox: [],
});

const PT = /^PT\d{3,}$/;
const PM = /^PM\d{3,}$/;
const EV = /^EV\d{3,}$/;

const nextId = (items, prefix) => `${prefix}${String(items.length + 1).padStart(3, '0')}`;
export const nextTaskId = (state) => nextId(state.tasks, 'PT');
export const nextMilestoneId = (state) => nextId(state.milestones, 'PM');
export const nextEventId = (state) => nextId(state.taskEvents, 'EV');

/** 依赖必须无环、无自环。环是状态表自己说出来的，不靠调用方自觉。 */
export function dependencyCycle(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const mark = new Map();
  const stack = [];
  const visit = (id) => {
    if (mark.get(id) === 2) return null;
    if (mark.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    mark.set(id, 1);
    stack.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) continue;
      const cyc = visit(dep);
      if (cyc) return cyc;
    }
    stack.pop();
    mark.set(id, 2);
    return null;
  };
  for (const t of tasks) {
    const cyc = visit(t.id);
    if (cyc) return cyc;
  }
  return null;
}

const acceptancePassed = (a) => (a.result === 'pass' && !!a.evidence?.length) || a.result === 'waived';
const requiredAcceptance = (t) => (t.acceptance ?? []).filter((a) => a.required !== false);

/**
 * 当前状态不是 stored status 的复制：
 * done 必须每一项必做验收都有结果和证据；验收一旦失效（stale）或缺失，就退回待核实，
 * 但任务事件里的「当时完成」保留——历史和当前状态是两回事。
 */
export function effectiveStatus(task) {
  if (task.status === 'done') {
    const req = requiredAcceptance(task);
    if (!req.length) return { status: 'unknown', reason: 'done-without-acceptance' };
    const bad = req.find((a) => !acceptancePassed(a) || a.stale);
    if (bad) return { status: 'unknown', reason: a_stale_reason(bad) };
  }
  return { status: task.status, reason: null };
}
const a_stale_reason = (a) => (a.stale ? `acceptance-stale:${a.id}` : `acceptance-open:${a.id}`);

/** 纳入范围：未取消、且不是模型单方面建议的任务。没范围就不算分母。 */
export const inScope = (t) => t.status !== 'cancelled' && t.scopeBasis?.kind !== 'model-suggestion';

/** 项目与每个里程碑的计数都从这一个函数派生，页面/导出/CLI 不许各算一套。 */
export function counts(state) {
  const empty = () => ({ inScope: 0, done: 0, active: 0, blocked: 0, awaiting: 0, unknown: 0, planned: 0, cancelled: 0 });
  const project = empty();
  const byMilestone = new Map((state.milestones ?? []).map((m) => [m.id, empty()]));
  for (const t of state.tasks ?? []) {
    const eff = effectiveStatus(t);
    const m = byMilestone.get(t.milestoneId);
    if (t.status === 'cancelled') {
      project.cancelled++;
      if (m) m.cancelled++;
      continue;
    }
    const bucket = eff.status === 'awaiting-verification' ? 'awaiting' : eff.status;
    if (inScope(t)) project.inScope++;
    // 范围外的（模型单方面建议的）任务不进分母，也不能进分子：以前 done 落在 inScope 分支的
    // else-if 里，一条建议任务做完就把计数顶成「完成 49 / 纳入范围 48」。
    if (bucket === 'done') { if (inScope(t)) project.done++; }
    else if (bucket in project && bucket !== 'inScope') project[bucket]++;
    if (m) {
      if (inScope(t)) m.inScope++;
      if (bucket === 'done') { if (inScope(t)) m.done++; }
      else if (bucket in m && bucket !== 'inScope') m[bucket]++;
    }
  }
  return {
    project,
    milestones: [...byMilestone.entries()].map(([id, c]) => ({ id, ...c })),
    unorganized: (state.unresolvedUnits ?? []).filter((u) => u.state !== 'disposed').length,
    candidatesPending: (state.candidates ?? []).filter((c) => c.state === 'candidate').length,
    scopeUnknown: (state.tasks ?? []).filter((t) => !t.scopeBasis || t.scopeBasis.kind === 'model-suggestion').length,
  };
}

/** 单条任务与验收项的字段校验。错误带字段名，回执能直接指出哪一条不对。 */
export function validateTask(t, { milestones = [] } = {}) {
  const errors = [];
  if (!PT.test(String(t?.id ?? ''))) errors.push(`id 不是 PT 编号：${t?.id}`);
  if (!STATUSES.includes(t?.status)) errors.push(`${t?.id} status 不在枚举里：${t?.status}`);
  if (!SCOPE_KINDS.includes(t?.scopeBasis?.kind)) errors.push(`${t?.id} scopeBasis.kind 不是 ${SCOPE_KINDS.join('/')}`);
  if (t?.milestoneId && !milestones.some((m) => m.id === t.milestoneId)) errors.push(`${t?.id} 指向不存在的里程碑 ${t.milestoneId}`);
  if (t?.dependsOn?.includes(t.id)) errors.push(`${t?.id} 依赖自己`);
  for (const [field, cap] of Object.entries(TASK_LIMITS)) {
    const v = t?.[field];
    if (typeof v === 'string' && field !== 'result' && field !== 'nextAction' && wlen(v) > cap) errors.push(`${t.id} ${field} 超过 ${cap} 格`);
    if (typeof v === 'string' && (field === 'result' || field === 'nextAction') && v.length > cap) errors.push(`${t.id} ${field} 超过 ${cap} 字`);
  }
  if (t?.status === 'blocked' && !String(t.blocker ?? '').trim()) errors.push(`${t.id} 标了受阻却没写阻塞条件`);
  if (t?.status === 'cancelled' && !t?.cancelledBy) errors.push(`${t.id} 取消必须写明依据（用户取消/范围变更）`);

  for (const a of t?.acceptance ?? []) {
    const tag = `${t.id}.${a?.id ?? '?'}`;
    if (!/^A\d+$/.test(String(a?.id ?? ''))) errors.push(`${tag} 验收项 id 不合法`);
    if (!String(a?.condition ?? '').trim()) errors.push(`${tag} 没有验收条件`);
    if (!ACCEPT_KINDS.includes(a?.kind)) errors.push(`${tag} kind 不是 ${ACCEPT_KINDS.join('/')}`);
    if (!ACCEPT_RESULTS.includes(a?.result)) errors.push(`${tag} result 不是 ${ACCEPT_RESULTS.join('/')}`);
    if (a?.result === 'pass' && !a?.evidence?.length) errors.push(`${tag} 通过却没有证据`);
    if (a?.result === 'waived' && !a?.waiver?.evidence) errors.push(`${tag} 豁免必须指向用户原话`);
    if (a?.result === 'pass' && a?.targetVersion && a?.evidence?.length
      && a.evidence.every((e) => e.version && e.version !== a.targetVersion)) {
      errors.push(`${tag} 证据版本与目标版本不一致（${a.targetVersion}）`);
    }
  }
  if (t?.status === 'done') {
    const req = requiredAcceptance(t);
    if (!req.length) errors.push(`${t.id} 标完成但没有任何必做验收`);
    const open = req.filter((a) => !acceptancePassed(a));
    if (open.length) errors.push(`${t.id} 标完成但验收未过：${open.map((a) => a.id).join(',')}`);
  }
  return errors;
}

export function validateState(state) {
  const errors = [];
  if (state?.schema !== SCHEMA) errors.push(`schema 不是 ${SCHEMA}：${state?.schema}`);
  const ids = new Set();
  for (const m of state?.milestones ?? []) {
    if (!PM.test(String(m?.id ?? ''))) errors.push(`里程碑 id 不合法：${m?.id}`);
    if (!String(m?.short ?? '').trim()) errors.push(`${m?.id} 没有短名`);
    if (ids.has(m?.id)) errors.push(`里程碑 id 重复：${m?.id}`);
    ids.add(m?.id);
  }
  const taskIds = new Set();
  for (const t of state?.tasks ?? []) {
    if (taskIds.has(t?.id)) errors.push(`任务 id 重复：${t?.id}`);
    taskIds.add(t?.id);
    errors.push(...validateTask(t, { milestones: state.milestones ?? [] }));
  }
  for (const t of state?.tasks ?? []) {
    for (const dep of t?.dependsOn ?? []) if (!taskIds.has(dep)) errors.push(`${t.id} 依赖不存在的任务 ${dep}`);
  }
  const cyc = dependencyCycle(state?.tasks ?? []);
  if (cyc) errors.push(`依赖成环：${cyc.join(' → ')}`);
  const evIds = new Set();
  for (const e of state?.taskEvents ?? []) {
    if (!EV.test(String(e?.id ?? ''))) errors.push(`事件 id 不合法：${e?.id}`);
    if (evIds.has(e?.id)) errors.push(`事件 id 重复：${e?.id}`);
    evIds.add(e?.id);
    if (!taskIds.has(e?.taskId)) errors.push(`${e?.id} 指向不存在的任务 ${e?.taskId}`);
    if (!EVENT_TYPES.includes(e?.type)) errors.push(`${e?.id} 事件类型不在枚举里：${e?.type}`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 把一个批次应用到状态副本上（纯函数）：分配 PT/EV、追加事件、记 revision。
 * 模型给的是局部键（name）、结果、验收与处置；最终 ID、revision、游标都由工具算。
 * 任何校验失败抛错，调用方不得落盘。
 */
export function applyBatch(state, batch, { actor = null, now = new Date().toISOString() } = {}) {
  const next = structuredClone(state);
  const localToId = new Map();
  const created = [];
  const updated = [];

  for (const m of batch.milestoneChanges ?? []) {
    if (m.id) {
      const hit = next.milestones.find((x) => x.id === m.id);
      if (!hit) throw new Error(`里程碑不存在：${m.id}`);
      Object.assign(hit, m.patch ?? {});
    } else {
      const id = nextMilestoneId(next);
      next.milestones.push({ id, short: m.short, title: m.title ?? '', goal: m.goal ?? '', scopeBasis: m.scopeBasis ?? { kind: 'model-suggestion' }, order: next.milestones.length + 1 });
      if (m.localKey) localToId.set(m.localKey, id);
    }
  }

  for (const t of batch.taskChanges ?? []) {
    if (t.localKey) {
      const id = nextTaskId(next);
      localToId.set(t.localKey, id);
      const task = {
        id, revision: 1,
        milestoneId: t.milestoneId ? (localToId.get(t.milestoneId) ?? t.milestoneId) : null,
        dependsOn: (t.dependsOn ?? []).map((d) => localToId.get(d) ?? d),
        scopeBasis: t.scopeBasis ?? { kind: 'model-suggestion', ref: null },
        short: t.short, title: t.title ?? t.short, goal: t.goal ?? '',
        status: t.status ?? 'unknown', result: t.result ?? null, remaining: t.remaining ?? null,
        blocker: t.blocker ?? null, nextAction: t.nextAction ?? null,
        acceptance: (t.acceptance ?? []).map((a, i) => ({ id: a.id ?? `A${i + 1}`, required: a.required !== false, ...a })),
        evidence: t.evidence ?? [], actor: t.actor ?? actor, sourceSessions: t.sourceSessions ?? [],
        occurredAt: t.occurredAt ?? null, recordedAt: now,
      };
      next.tasks.push(task);
      created.push(task.id);
    } else {
      const hit = next.tasks.find((x) => x.id === t.id);
      if (!hit) throw new Error(`任务不存在：${t.id}`);
      const patch = { ...(t.patch ?? {}) };
      if (patch.dependsOn) patch.dependsOn = patch.dependsOn.map((d) => localToId.get(d) ?? d);
      Object.assign(hit, patch, { revision: (hit.revision ?? 1) + 1, recordedAt: now });
      if (patch.actor === undefined) hit.actor = actor ?? hit.actor;
      updated.push(hit.id);
    }
  }

  for (const e of batch.events ?? []) {
    const taskId = localToId.get(e.taskId) ?? e.taskId;
    next.taskEvents.push({
      id: nextEventId(next), taskId, type: e.type,
      at: e.at ?? now, actor: e.actor ?? actor, note: e.note ?? '',
      evidence: e.evidence ?? [], version: e.version ?? null,
    });
  }

  const candidateIds = [];
  for (const c of batch.candidates ?? []) {
    const id = `C${String((next.candidates ?? []).length + 1).padStart(3, '0')}`;
    next.candidates.push({ id, state: 'candidate', ...c, createdAt: now });
    candidateIds.push(id);
  }
  for (const d of batch.dispositions ?? []) {
    next.unresolvedUnits = next.unresolvedUnits ?? [];
    next.unresolvedUnits.push({ ...d, state: d.state ?? 'disposed', at: now });
  }
  next.revision = state.revision + 1;
  next.updatedAt = now;

  const errors = validateState(next).errors;
  if (errors.length) { const err = new Error(`批次校验失败：${errors.slice(0, 5).join(' | ')}`); err.errors = errors; throw err; }
  return { state: next, receipt: { newTasks: created, updatedTasks: updated, eventCount: (batch.events ?? []).length, candidateIds, projectRevision: next.revision, idMap: Object.fromEntries(localToId) } };
}

// 候选生命周期：候选不是规则。与旧结论矛盾标 disputed；用户否定或证据不成立标 dismissed；
// published 只由发布器在 gate 全过之后写入，模型不能直接喊。
export const CANDIDATE_STATES = ['candidate', 'eligible', 'published', 'disputed', 'dismissed'];
const CANDIDATE_NEXT = {
  candidate: ['eligible', 'disputed', 'dismissed'],
  eligible: ['published', 'disputed', 'dismissed'],
  published: [],
  disputed: ['eligible', 'dismissed'],
  dismissed: [],
};

export function transitionCandidate(state, id, to, { reason = '', at = new Date().toISOString() } = {}) {
  const c = (state.candidates ?? []).find((x) => x.id === id);
  if (!c) throw new Error(`没有候选 ${id}`);
  const from = c.state ?? 'candidate';
  if (!CANDIDATE_STATES.includes(to)) throw new Error(`候选状态不合法：${to}`);
  if (!(CANDIDATE_NEXT[from] ?? []).includes(to)) throw new Error(`候选 ${id} 不能从 ${from} 变成 ${to}`);
  c.state = to;
  c.stateAt = at;
  c.stateReason = reason;
  return c;
}

/** 只读投影：页面/CLI/导出共用，字段够回答「做到哪、欠什么」，不搬正文。 */
export function projectView(state) {
  const c = counts(state);
  return {
    schema: state.schema, project: state.project, revision: state.revision,
    counts: c,
    milestones: (state.milestones ?? []).map((m) => ({
      id: m.id, short: m.short, title: m.title, goal: m.goal,
      ...(c.milestones.find((x) => x.id === m.id) ?? {}),
    })),
    tasks: (state.tasks ?? []).map((t) => ({
      id: t.id, revision: t.revision, milestoneId: t.milestoneId, short: t.short, title: t.title,
      status: effectiveStatus(t).status, storedStatus: t.status, statusReason: effectiveStatus(t).reason,
      result: t.result, remaining: t.remaining, blocker: t.blocker, nextAction: t.nextAction,
      acceptance: (t.acceptance ?? []).map((a) => ({ id: a.id, condition: a.condition, required: a.required !== false, kind: a.kind, result: a.result, stale: !!a.stale })),
      dependsOn: t.dependsOn ?? [], evidence: t.evidence ?? [], sourceSessions: t.sourceSessions ?? [],
    })),
    events: state.taskEvents ?? [],
  };
}

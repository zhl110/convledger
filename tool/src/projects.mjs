// 项目层：把同一个工作目录下的会话归成一个项目。
// 归组只认 normCwd 整串相等（与 current.mjs 的当前会话解析同一把尺），不做前缀/父子推断：
// D:/work 与 D:/work/sub 是两个项目。没有 cwd 的账只进「未归组」，不塞给任何项目。
// 零模型：每个数字都从账本现算，成员表每次重扫——账本删了不会在项目里留下残影。
import fs from 'node:fs';
import path from 'node:path';
import { normCwd, projectKey } from './current.mjs';
import { libraryOf, LIVE_MIN } from './library.mjs';
import { readRequests } from './notes.mjs';
import { readView } from './view.mjs';

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

export { projectKey };

/** 显示用的根路径：保留出现最多的那种拼写（D:\mycode 压过 d:\mycode），斜杠转正、去尾斜杠。 */
const displayRoot = (members) => {
  const count = new Map();
  for (const m of members) {
    const disp = String(m.cwd).replace(/\\/g, '/').replace(/\/+$/, '');
    if (disp) count.set(disp, (count.get(disp) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
};

export const projectName = (root) => String(root).split('/').filter(Boolean).pop() || '（未命名项目）';

/** 最近主线步：只读最近一段会话的块表（view 的派生，零模型）。读不了就留 null，不编步号。 */
function latestStepOf(dir) {
  try {
    const v = readView(dir);
    if (!v.mainSteps) return null;
    const block = [...v.steps].reverse().find((s) => s.step === v.mainSteps) ?? v.steps[v.steps.length - 1] ?? null;
    return { step: v.mainSteps, block: block?.i ?? null, mark: block?.mark ?? '' };
  } catch { return null; }
}

function sessionRow(dir, id, statusById) {
  const ledger = readJson(path.join(dir, 'ledger.json')) ?? {};
  const sid = String(ledger.sessionId ?? id);
  const segs = Array.isArray(ledger.segments) ? ledger.segments : [];
  const st = statusById.get(sid);
  const requests = readRequests(dir).rows;
  return {
    id: sid,
    sid8: sid.slice(0, 8),
    runner: ledger.runner ?? st?.runner ?? 'unknown',
    dir,
    cwd: typeof ledger.cwd === 'string' ? ledger.cwd : '',
    sourceFile: ledger.sourceFile ?? null,
    title: st?.title ?? '',
    titleFrom: st?.titleFrom ?? null,
    workspace: st?.workspace ?? '',
    segments: segs.length,
    firstAt: segs[0]?.tsFrom ?? ledger.builtAt ?? null,
    // 最近活动优先用源文件的最后写入时刻：建账之后源还在长，段末尾不是会话的尽头。
    lastAt: st?.lastWriteAt ?? segs[segs.length - 1]?.tsTo ?? ledger.builtAt ?? null,
    builtAt: ledger.builtAt ?? null,
    live: !!st?.live,
    idleMin: st?.idleMin ?? null,
    requestsPending: requests.filter((r) => !r.done).length,
    step: null,
  };
}

const byRecent = (a, b) => String(b.lastAt ?? '').localeCompare(String(a.lastAt ?? '')) || String(a.id).localeCompare(String(b.id));

/**
 * @param root store 根（含 <sessionId>/ledger.json 的目录）
 * @param withSteps=false 只做归组与计数（夹具/测试用；真机默认算最近主线步）
 * counts.sessions + counts.ungrouped 必须等于 counts.ledgers（每本账恰好落一处）。
 */
export function projectsOf(root, { now = Date.now(), liveMin = LIVE_MIN, withSteps = true } = {}) {
  const ids = fs.existsSync(root)
    ? fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'ledger.json')))
    : [];
  const lib = libraryOf(root, { now, liveMin });
  const statusById = new Map(lib.groups.flatMap((g) => g.sessions).map((s) => [s.id, s]));

  const grouped = new Map();
  const ungrouped = [];
  for (const id of ids) {
    const row = sessionRow(path.join(root, id), id, statusById);
    const norm = normCwd(row.cwd);
    if (!norm) { ungrouped.push(row); continue; }
    if (!grouped.has(norm)) grouped.set(norm, { norm, members: [] });
    grouped.get(norm).members.push(row);
  }

  const projects = [...grouped.values()].map(({ norm, members }) => {
    members.sort(byRecent);
    const latest = members[0];
    if (withSteps) latest.step = latestStepOf(latest.dir);
    const disp = displayRoot(members);
    return {
      key: projectKey(norm),
      root: disp,
      name: projectName(disp),
      counts: {
        sessions: members.length,
        live: members.filter((m) => m.live).length,
        segments: members.reduce((a, m) => a + m.segments, 0),
        requestsPending: members.reduce((a, m) => a + m.requestsPending, 0),
      },
      firstAt: members.map((m) => m.firstAt).filter(Boolean).sort()[0] ?? null,
      lastAt: members.map((m) => m.lastAt).filter(Boolean).sort().at(-1) ?? null,
      latest: { id: latest.id, sid8: latest.sid8, runner: latest.runner, lastAt: latest.lastAt, step: latest.step },
      members,
    };
  });
  projects.sort((a, b) => String(b.lastAt ?? '').localeCompare(String(a.lastAt ?? '')) || a.name.localeCompare(b.name));
  ungrouped.sort(byRecent);

  const sum = (arr) => arr.reduce((a, x) => a + x, 0);
  return {
    schema: 'convledger-projects/1',
    at: new Date(now).toISOString(),
    liveMin,
    counts: {
      projects: projects.length,
      sessions: sum(projects.map((p) => p.counts.sessions)),
      ungrouped: ungrouped.length,
      ledgers: ids.length,
      live: sum(projects.map((p) => p.counts.live)),
      segments: sum(projects.map((p) => p.counts.segments)) + sum(ungrouped.map((m) => m.segments)),
      ungroupedSegments: sum(ungrouped.map((m) => m.segments)),
    },
    projects,
    ungrouped,
  };
}

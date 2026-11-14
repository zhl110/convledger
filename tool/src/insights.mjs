// 项目级洞察：把散在各会话块综述里的经验按阶段收拢，把两张记忆表里的
// 经验/规则/画像摆到一处。只读派生数据，不写账本、不做模型判断。
// 项目页（/p/<键>/data.json）与导出 Markdown 共用这一份口径，页面与文件不许各算一套。
import fs from 'node:fs';
import path from 'node:path';
import { lessonsOf } from './lessons.mjs';
import { readPhases } from './phases.mjs';
import { readProjectMemories, readUserMemories } from './memories.mjs';
import { projectKey } from './projects.mjs';

function sessionsOf(storeRoot, key) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(storeRoot); } catch { return out; }
  for (const d of names) {
    const f = path.join(storeRoot, d, 'ledger.json');
    if (!fs.existsSync(f)) continue;
    try {
      const l = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!l.cwd || projectKey(String(l.cwd)) !== key) continue;
      out.push({ id: d, at: Date.parse(l.builtAt ?? '') || 0 });
    } catch { /* 坏账本跳过，别让一个目录拖垮整页 */ }
  }
  out.sort((a, b) => b.at - a.at);
  return out;
}

/** 块经验（summaries.lesson）按「会话 + 阶段」分组；只认锚点还新鲜的块（lessonsOf 内做）。
 *  maxSessions 限制读到最近几本账，maxLessons 限制总条数：项目页要 5 秒轮询，不能扫全机。 */
export function projectExperience(storeRoot, key, { maxSessions = 8, maxLessons = 60, maxGroups = 10 } = {}) {
  const sessions = sessionsOf(storeRoot, key);
  const picked = sessions.slice(0, maxSessions);
  const groups = new Map();
  let total = 0;
  for (const s of picked) {
    const dir = path.join(storeRoot, s.id);
    let phases = [];
    try { phases = readPhases(dir).phases ?? []; } catch { /* 没阶段表就归到「未划阶段」 */ }
    let rows;
    try { rows = lessonsOf(dir, { limit: 200 }); } catch { continue; }
    total += rows.total;
    for (const row of rows.rows) {
      // 块的 step 落在阶段的步区间里就算这一程；插曲块没有主线步编号，归「未划阶段」。
      const p = row.step == null ? null : phases.find((x) => x.from <= row.step && row.step <= x.to);
      const label = p ? `阶段 ${p.from}–${p.to}${p.short ? ` · ${p.short}` : ''}` : '未划阶段';
      const gk = `${s.id}|${label}`;
      if (!groups.has(gk)) {
        groups.set(gk, {
          sid: s.id, sid8: s.id.slice(0, 8),
          phase: p ? { from: p.from, to: p.to, short: p.short ?? '' } : null,
          label, items: []
        });
      }
      groups.get(gk).items.push({ step: row.step, block: row.block, title: row.title, lesson: row.lesson, need: row.need });
    }
  }
  // 新的阶段在前；总条数封顶，避免项目页把几十本账的经验一次铺开。
  const ordered = [...groups.values()].sort((a, b) => (b.phase?.to ?? -1) - (a.phase?.to ?? -1) || String(b.sid).localeCompare(String(a.sid)));
  const totalGroups = ordered.length;
  ordered.length = Math.min(ordered.length, maxGroups);
  let budget = maxLessons;
  const out = [];
  for (const g of ordered) {
    if (budget <= 0) break;
    g.items = g.items.slice(0, Math.min(8, budget));
    budget -= g.items.length;
    g.count = g.items.length;
    out.push(g);
  }
  return { sessions: picked.length, total, totalGroups, groups: out, sig: `${picked.length}:${total}:${out.length}:${budget}` };
}

const pickClass = (entries, cls) => (entries ?? [])
  .filter((e) => e?.class === cls)
  .map((e) => ({ id: e.id, text: e.text, at: e.at ?? null, topic: e.topic ?? null, dimension: e.dimension ?? null, evidence: Array.isArray(e.evidence) ? e.evidence : [] }));

/** 记忆表原样搬出来，不在这里判新鲜——失效判定在 memories 模块，页面只显示表里有的。
 *  空就返回空数组，页面写「0 条」并给出写入口，不编。 */
export function projectProfile(storeRoot, key) {
  let project = { 经验: [], 规则: [], 探索: [], 进度: [] };
  let user = { 画像: [], 规则: [] };
  try {
    const t = readProjectMemories(storeRoot, key);
    project = { 经验: pickClass(t.entries, '经验'), 规则: pickClass(t.entries, '规则'), 探索: pickClass(t.entries, '探索'), 进度: pickClass(t.entries, '进度') };
  } catch { /* 表读不了就按空表展示，写入口照写 */ }
  try {
    const u = readUserMemories(storeRoot);
    user = { 画像: pickClass(u.entries, '画像'), 规则: pickClass(u.entries, '规则') };
  } catch { /* 同上 */ }
  const n = Object.values(project).reduce((a, b) => a + b.length, 0) + user.画像.length + user.规则.length;
  return { project, user, sig: String(n) };
}

/** 单会话笔记：给「导出成 Markdown、以后回档」用。只写已有的事实，缺就写缺。 */
export function sessionNotesMarkdown(storeRoot, sid) {
  const dir = path.join(storeRoot, sid);
  let ledger = null;
  try { ledger = JSON.parse(fs.readFileSync(path.join(dir, 'ledger.json'), 'utf8')); } catch { return null; }
  const phases = (() => { try { return readPhases(dir).phases ?? []; } catch { return []; } })();
  const l = (() => { try { return lessonsOf(dir, { limit: 500 }); } catch { return { total: 0, rows: [] }; } })();
  const lines = [];
  lines.push(`# 会话笔记 · ${sid.slice(0, 8)}`);
  lines.push('');
  lines.push(`- 来源 \`${ledger.sourceFile ?? '—'}\`（${ledger.runner ?? '—'}）`);
  lines.push(`- 工作目录 \`${ledger.cwd ?? '—'}\``);
  lines.push(`- 账本：${ledger.segments?.length ?? 0} 段 · 构建于 ${String(ledger.builtAt ?? '').slice(0, 19).replace('T', ' ')}`);
  lines.push(`- 经验 ${l.total} 条 · 阶段 ${phases.length} 段（模型写、工具验；缺的如实留空）`);
  lines.push('');
  lines.push('## 阶段');
  if (!phases.length) lines.push('- 没有阶段说明');
  else for (const p of phases) lines.push(`- 第 ${p.from}–${p.to} 步 · ${p.short ?? ''}${p.doing ? ` — ${p.doing}` : ''}`);
  lines.push('');
  lines.push('## 经验');
  if (!l.total) lines.push('- 没有写 lesson 的块（摘要没写或已失效）');
  else for (const row of l.rows) {
    lines.push(`- 第 ${row.step ?? '—'} 步 · 块 ${row.block}${row.title ? ` · ${row.title}` : ''}`);
    lines.push(`  - 经验：${row.lesson}`);
    if (row.need) lines.push(`  - 当时的要求：${row.need}`);
    if (row.from) lines.push(`  - 回读：convledger body ${row.from} --session ${sid.slice(0, 8)}`);
  }
  lines.push('');
  lines.push('## 用户画像 / 工作方式');
  lines.push('- 见项目导出目录的 `USER-PROFILE.md`（用户表为空时那里会如实写 0 条）');
  return `${lines.join('\n')}\n`;
}

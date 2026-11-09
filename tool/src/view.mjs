// The single data path behind every visual surface: read a store directory and
// flatten it into the shape a map page or a canvas needs. Structure only — bodies
// never leave the source JSONL, so no renderer can accidentally become a mirror.
import fs from 'node:fs';
import path from 'node:path';
import { BLOCK_GIST_W, CLAIM_MARK_W, INDEX_FIXED_TOK, INDEX_TOKENS_PER_SEGMENT, ROUTE_SHARE_CAP } from './cost.mjs';
// One token estimator for the whole tool: the number on the gauge has to be the same
// number the selftest audits, or the panel flatters the ledger.
import { tok, wlen } from './lib.mjs';
import { BRANCH_STATES, CLOSED_LABELS, deriveBranches, movesOf, opensBranch, publishedTopics, readTopics } from './topics.mjs';
import { readNotes, readRequests } from './notes.mjs';
import { blockHash, readSummaries } from './summaries.mjs';
import { applyPhases, readPhases } from './phases.mjs';
import { applyChapters, readChapters } from './chapters.mjs';
import { projectKey } from './current.mjs';
import { archiveState } from './store.mjs';

export { tok, wlen };

/** 三个 runner 的时间戳形状不同（Qoder/Claude 是 ISO 串，WorkBuddy 是毫秒整数）：
 *  页面只吃 ISO，这里统一，认不出来就如实 null，不猜。 */
const isoOf = (t) => {
  if (t == null || t === '') return null;
  const v = typeof t === 'string' && /^\d{10,13}$/.test(t) ? Number(t) : t;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// A boundary record sits next to, not inside, the segment it produced, so match by
// containment first and fall back to the nearest one.
const boundaryOf = (boundaries, s) => {
  const hit = boundaries.find((b) => b.line >= s.lineFrom && b.line <= s.lineTo);
  if (hit) return hit;
  if (s.kind !== 'boundary') return null;
  return boundaries.slice().sort((a, b) => Math.abs(a.line - s.lineFrom) - Math.abs(b.line - s.lineFrom))[0] ?? null;
};

export const KIND_LABELS = [
  ['side-episode', '支线'], ['fan-out', '并行'], ['pivot', '打断转向'],
  ['continuation', '延续'], ['boundary', '压缩边界'], ['开场所求', '主线'],
];
export const kindLabel = (kind) => {
  for (const [frag, zh] of KIND_LABELS) if (kind.startsWith(frag) || kind.includes(frag)) return zh;
  return kind === 'mainline' ? '主线' : kind;
};

// A segment with no prose of its own used to be titled by its longest tool call, so
// a map of 48 segments read like a shell history. Name it instead by what it changed:
// the file it wrote routes the reader, the command line that wrote it does not.
export const TOOLISH = /^(Bash|Read|Write|Edit|MultiEdit|NotebookEdit|Grep|Glob|Agent|WebFetch|WebSearch|TodoWrite|TaskCreate|TaskUpdate|TaskStop|TaskList|SearchWorkspace|SearchKnowledge|ImageGen|ImageSearch|Skill|VideoGen|present_visualization|mcp_+(list|get|call)?|convledger)/;
export const NOSAY = /^（(无回复文本|本段无文本产出)/;

const fileNames = (list) => [...new Set((list ?? [])
  .map((p) => String(p).split(/[\\/]/).filter(Boolean).pop() ?? '')
  .filter((b) => /\.[\w]{1,6}$/.test(b)))];
const few = (arr) => arr.slice(0, 2).join('、') + (arr.length > 2 ? ` 等${arr.length}件` : '');

/** Deterministic 'what this segment did', built from its structure, never from a command line. */
export function deedOf(s) {
  const w = fileNames(s.filesWritten);
  if (w.length) return `改 ${few(w)}`;
  if ((s.branches ?? []).length) return `派 ${s.branches.length} 个子代理`;
  const r = [...fileNames(s.filesRead), ...fileNames(s.filesSeen)];
  if (r.length) return `查 ${few(r)}`;
  const top = Object.entries(s.tools ?? {}).sort((a, b) => b[1] - a[1])[0];
  if (top) return `${top[0].split('__').pop()} ×${top[1]}`;
  return '无正文的一回合';
}

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** 子句边界截断：只在标点处停，绝不切半句（截断靠换更短的一层，不靠硬切）。
 *  预算是显示宽度（见 wlen），中英混排才按占的格子算。返回值一定是原文的前缀（去掉收尾标点），
 *  所以自检能一句 `src.startsWith(clip)` 钉住——省略号是画布画的，不在这条串里。
 *  英文句号不当边界：那会把 atlas.js 这类文件名撕碎，代价比省下一个英文句大。 */
const CLAUSE = /[^，。？！；：、,!?:]+[，。？！；：、,!?:]?/g;
// 口语起手词。剪掉它们只为省出远景那 6 格的预算，剪完仍是原文里连续的一段（自检按 includes 钉）。
const FILLER = /^(嗯+|哦+|啊+|呃+|哎+|那+|好(的)?|行|然后|接着|就是|OK|ok)[，、,。.\s]*/;
function unfiller(s) {
  let out = String(s ?? ''), prev;
  do { prev = out; out = out.replace(FILLER, ''); } while (out && out !== prev);
  return out;
}
/** 子句边界截断：优先在标点处停；fill=true 时允许在一句中间补满（远景只有 6 格，
 *  宁可"你把这个文件夹"也不留一个光秃秃的"嗯"）。两种模式返回值都仍是原文里连续的一段。
 *  英文句号不当边界：那会把 atlas.js 这类文件名撕碎，代价比省下一个英文句大。 */
export function clip(text, budget, fill) {
  const src = oneLine(unfiller(text));
  if (!src) return '';
  const cps = [...src];
  if (wlen(src) <= budget) return src;
  let out = '';
  for (const part of src.match(CLAUSE) || [src]) {
    if (wlen(out + part) > budget) {
      // 补满模式：在这一句里继续按码点吃字，吃到预算为止
      if (fill) {
        for (const c of [...part]) {
          if (wlen(out + c) > budget) break;
          out += c;
        }
      }
      break;
    }
    out += part;
  }
  // 第一个子句就超预算：退到空格边界（英文句、路径），再不行按码点切——仍是前缀
  if (!out && !fill) return '';
  if (!out) {
    for (const w of src.split(' ')) {
      const next = out ? out + ' ' + w : w;
      if (wlen(next) > budget) break;
      out = next;
    }
    if (!out) out = cps.slice(0, Math.max(1, Math.floor(budget / 0.55))).join('');
  }
  return out.replace(/[，。？！；：、,!?:.\-]+$/, '');
}

/** @returns {{title:string, fromTool:boolean}} fromTool marks a tile that names a deed, not an utterance */
export function titleOf(candidates, deed) {
  const plain = candidates.map(oneLine).find((s) => s && !NOSAY.test(s) && !TOOLISH.test(s));
  if (plain) return { title: plain.slice(0, 90), fromTool: false };
  return { title: `⚙ ${deed}`, fromTool: true };
}

// The bracket note is assembled here, once, so the page and any CLI reading of the
// same view cannot disagree. Every word must name a field: 已证/站位/未证 = basis,
// the move words = claim.moves, 写N = filesWritten, ⚠N = errors, 留问 = an `open` move.
const basisWord = (b) => (b === 'verified' ? '已证' : b === 'reconstructed' ? '站位' : '未证');
const bracket = (parts) => `〔${parts.filter(Boolean).join(' ')}〕`;

export function segmentNote(n) {
  return bracket([
    basisWord(n.basis),
    n.moves || '',
    n.wrote ? `写${n.wrote}` : '写0',
    n.open ? '留问' : '',
    n.errs ? `⚠${n.errs}` : '',
  ]);
}

export function branchNote(t) {
  return bracket([
    `${t.stateLabel}·${t.closedLabel}`,
    `段${t.segs}`,
    `已证${t.verified}`,
    t.wrote ? `写${t.wrote}` : '写0',
    t.open ? `留问${t.open}` : '',
    t.errs ? `⚠${t.errs}` : '',
    // one token, no spaces: the note is a grammar the selftest can audit, and the file
    // that got re-read is on the row's tooltip (落地物) where there is room for it
    t.readBack ? `回读@${t.readBack.at}` : '无人回读',
  ]);
}

const num = (x) => (x || 0).toLocaleString('en-US');

/** The frame skeleton, assembled node-side: one row per task branch, telling the page
 *  which segment it hangs under and how deep that makes it. Pointers only — no text, so
 *  the map payload does not grow a second copy of every title.
 *
 *  A side-episode opens its own branch AND attaches to the segment it interrupted, so the
 *  whole FRAME hangs there; that is the difference between 主线 and 插曲. `attachUnder`
 *  always points at an earlier segment, so a host chain cannot cycle — the walk below
 *  still carries a seen-set, because a malformed log should not become an infinite loop. */
export function frameSkeleton(nodes, tasks, branches) {
  const byId = {};
  nodes.forEach((n) => { byId[n.id] = n; });
  const taskOf = {};
  for (const t of tasks) taskOf[t.id] = t;
  const branchOf = {};
  for (const br of branches) for (const id of br.segments) branchOf[id] = br.id;
  const hostOf = {};
  for (const br of branches) {
    const head = byId[br.head];
    hostOf[br.id] = head?.attach && branchOf[head.attach] && branchOf[head.attach] !== br.id ? head.attach : '';
  }
  const depth = (id) => {
    let d = 0, cur = id;
    const seen = {};
    for (;;) {
      const host = hostOf[cur];
      if (!host) break;
      cur = branchOf[host];
      if (!cur || seen[cur]) break;
      seen[cur] = 1;
      d++;
    }
    return d;
  };
  // An 插曲 that really ended shows up back on the spine: that second crossing is what
  // makes the fork readable (asset/prune-zh.gif: 主线卡与「无关插曲」卡汇回同一下游). Note a
  // side episode ENDS its host branch — the run rule means the mainline resumes as a NEW
  // branch — so "came back" is the next depth-0 frame's head, not a segment of the host.
  // Empty means it never came back: 未汇回 is a fact the frame prints, not a gap to hide.
  const rows = branches.filter((br) => taskOf[br.id]).map((br) => ({
    id: br.id, head: br.head, host: hostOf[br.id] || '', depth: depth(br.id), rejoin: '',
  }));
  let spine = '';
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].host) rows[i].rejoin = spine;
    else spine = rows[i].head;
  }
  return rows;
}

/* ---------- the brief ----------
   The user asked for "第一段干了什么、产生了哪些信息、有哪些要注意的问题和规则". The
   reference answers it with a headline plus a count line (asset/thought-map-four-zh.png:
   「五条路走了四条回来」 + 36 步思考 · 6 份材料 · 6 项决策 · 4 次转向 · 1 次排除) — every
   number there is countable, so the brief stays zero-model: sentences are copied verbatim
   out of a verified claim, never written here. */
const hasMove = (n, mv) => ` ${n.moves} `.includes(` ${mv} `);
const isRule = (n) => n.basis === 'verified' && (hasMove(n, 'decision') || hasMove(n, 'ruleout'));
const verbatim = (n) => ({ at: n.id, text: n.claim });

/** Per-branch brief: 产生的信息 = 支内已证增量，注意的规则 = 支内已证的 decision/ruleout. */
export function branchBrief(list) {
  const proved = list.filter((n) => n.basis === 'verified' && n.claim);
  return {
    facts: proved.filter((n) => !isRule(n)).slice(0, 3).map(verbatim),
    rules: proved.filter(isRule).slice(0, 2).map(verbatim),
    open: list.filter((n) => n.open).map((n) => n.id),
    errs: list.filter((n) => n.errs).map((n) => n.id),
  };
}

/** Session brief: one headline, one count line, where the work currently stands. */
export function sessionBrief(counts, tasks, nodes, frames) {
  const proved = nodes.filter((n) => n.basis === 'verified' && n.claim);
  const spine = tasks[0] ?? null;
  const now = tasks[tasks.length - 1] ?? null;
  const c = (k, v, tip) => ({ k, v: String(v), tip });
  return {
    spine: spine ? spine.title : '',
    spineId: spine ? spine.id : '',
    now: now ? { id: now.id, head: now.head, state: `${now.stateLabel}·${now.closedLabel}`, span: now.span, open: now.open } : null,
    counts: [
      c('段', counts.segs, '账本切出来的段数'),
      c('支', tasks.length, '一条支＝主链上一段连续工作，不并行'),
      c('插曲', frames.filter((f) => f.host).length, '分出去挂在别的段下面的支'),
      c('转向', nodes.filter((n) => n.kind.startsWith('pivot')).length, '结构上被打断转向的段'),
      c('已证', proved.length, '过了六条判据的认识增量'),
      c('决策', proved.filter((n) => hasMove(n, 'decision')).length, '已证增量里带 decision 的'),
      c('排除', proved.filter((n) => hasMove(n, 'ruleout')).length, '已证增量里带 ruleout 的'),
      c('留问', nodes.filter((n) => n.open).length, 'claim 里带 open 的段'),
      c('报错', nodes.filter((n) => n.errs).length, '段内有工具报错的段'),
      c('压缩', counts.boundaries, 'runner 自动压缩了几次'),
    ],
    cautions: proved.filter(isRule).slice(-2).map(verbatim),
    open: nodes.filter((n) => n.open).map((n) => n.id),
  };
}

/**
 * 步层：一块＝一个压缩区间，也就是"第几步"的最小单位。
 *
 * 为什么算在 src 而不是页面里：人看的星图和 Agent 读的 `steps` 必须是同一份数，
 * 两处各推一遍就会漂（这条项目里已经付过一次学费：`moves` 存字符串、页面按数组读，
 * 印章静默全 0）。派生只用下面这些已有字段，一次模型都不调；推不出"解决了什么"
 * 就把"推不出"写出来，不补形容词。
 */
export function stepsOf(nodes, asks, tasks, frames, { splitFrom = Infinity } = {}) {
  const idx = {};
  nodes.forEach((n, i) => { idx[n.id] = i; });
  // 真人句序号：asks 里混着转向与压缩，只数 who==='你'；count＝这句话管几段。
  // hook 注入的上下文（[convledger · …]）在宿主里也是 user 记录，但它不是人说的话——
  // 不排除的话，每条收尾提示都会在实时区里单独占一块。
  const rank = {};
  let k = 0;
  for (const a of asks || []) {
    if (a.who !== '你') continue;
    const at = idx[a.id];
    if (at === undefined) continue;
    if (/^\[convledger/.test(String(nodes[at]?.say || ''))) continue;
    k++;
    for (let j = 0; j < (a.count || 1); j++) {
      const n = nodes[at + j];
      if (!n || rank[n.id] !== undefined) break;
      rank[n.id] = k;
    }
  }
  const taskOf = {};
  for (const t of tasks) taskOf[t.id] = t;
  const frameOf = {};
  for (const f of frames) frameOf[f.id] = f;

  const steps = [];
  let prevCompact = false;
  let lastRank = null;
  // 水位线（PRD-blocks-live）：已完成的主线块数就是已发出的步数。越过 splitFrom 之后，
  // 每条真人提问起一块——压缩一稀也不会再把几十条提问吞进同一个块。
  let closedMain = 0;
  nodes.forEach((n, i) => {
    let p = steps[steps.length - 1];
    const byCompact = !p || (n.compact && !prevCompact);
    // 已发出的步数（含正在结束的这一块）必须已越过水位线，才允许在提问处切：
    // 否则会把归档区最后一块（水位线上的那一步）从中间劈开，阶段 hash 跟着失效。
    const stepsEmitted = closedMain + (p && p.main > 0 ? 1 : 0);
    const byAsk = !byCompact && rank[n.id] !== undefined && rank[n.id] !== lastRank && stepsEmitted > splitFrom;
    if (byCompact || byAsk) {
      if (p && p.main > 0) closedMain++;
      p = {
        i: steps.length + 1, step: null, role: '', from: n.id, to: n.id, i0: i, i1: i,
        nodes: 0, segs: 0, t0: n.t0 || 0, t1: n.t1 || 0, h0: null, h1: null, carry: lastRank,
        compacts: 0, branchIds: [], side: 0, main: 0, errs: 0, open: 0, verified: 0, wrote: 0,
        reply: '', replyFrom: '',
        inside: 0,
        fan: 0, level: 9, title: '', outs: [], files: [], lines: [], segIds: [], firstTask: '', lastTask: '',
        say: '', sayFrom: '', topic: '',
        // 计数行（PRD-parts §三）：每个数都能从块内已证增量独立复算，一个形容词都没有
        decisions: 0, ruledOut: 0, rules: [],
        tally: {},
      };
      steps.push(p);
    }
    p.to = n.id; p.i1 = i; p.nodes++; p.t1 = Math.max(p.t1, n.t1 || 0);
    if (n.compact) p.compacts++;
    else {
      p.segs++; p.segIds.push(n.id); if (!p.firstTask) p.firstTask = n.task; p.lastTask = n.task;
      // 块名取"这块里第一句人话"，不取支头标题：支头是整条支的题，两块同支就会撞成同一句。
      // 同一道 TOOLISH/NOSAY 过滤：Qoder 日志把工具回执也写成 user 记录，卡片「开场:」对
      // 连续干活的段会落回 "Bash cd …"／"mcp_call {…}"——那不是人话，拿它当摘要就是假摘要。
      if (!p.say && n.say && !TOOLISH.test(n.say) && !NOSAY.test(n.say)) { p.say = n.say; p.sayFrom = n.id; }
      // 没有已证增量时，卡片第二行要说「我回了什么」——取这段的第一句回复，标明是摘录。
      if (!p.reply && n.claim && !TOOLISH.test(n.claim) && !/^（无回复文本）|^\(no reply/i.test(n.claim)) { p.reply = n.claim; p.replyFrom = n.id; }
    }
    const r = rank[n.id];
    if (r !== undefined) { if (p.h0 === null) p.h0 = r; p.h1 = r; lastRank = r; }
    const f = frameOf[n.task];
    if (f && !p.branchIds.includes(f.id)) p.branchIds.push(f.id);
    if (f && f.host) p.side++; else if (!n.compact) p.main++;
    p.errs += n.errs || 0;
    p.open += n.open ? 1 : 0;
    p.wrote += n.wrote || 0;
    for (const f of n.files || []) if (p.files.length < 40 && !p.files.includes(f)) p.files.push(f);
    p.fan = Math.max(p.fan, (n.branches || []).length);
    if (n.basis === 'verified') {
      p.verified++;
      // moves 是空格分隔的字符串（movesOf 拼的），子串匹配会把 ruleout 当成 rule——
      // 规则格能按 'rule' 单独取出，靠的是先分词。
      const mv = String(n.moves || '').split(/\s+/);
      if (mv.includes('decision')) p.decisions++;
      if (mv.includes('ruleout')) p.ruledOut++;
      if (mv.includes('rule') && n.claim && p.rules.length < 3) p.rules.push({ id: n.id, text: n.claim });
      if (n.claim && p.lines.length < 3) p.lines.push({ id: n.id, text: n.claim });
      // topic 是模型写的路由把手（上限 CLAIM_TOPIC_MAX，且判据要求它逐字出现在 takeaway 里），
      // 块内一句人话都没有时，它是唯一已有的短名字来源。
      if (!p.topic && n.topic) p.topic = n.topic;
    }
    const t = taskOf[n.task];
    if (t) {
      p.level = Math.min(p.level, typeof t.level === 'number' ? t.level : 0);
      for (const o of String(t.outs || '').split('、')) if (o && !p.outs.includes(o)) p.outs.push(o);
    }
    // 哪条支在这块里占的段最多，这块就叫什么名字——可数的事实，不挑"最长的标题"
    if (!n.compact && n.task) p.tally[n.task] = (p.tally[n.task] || 0) + 1;
    prevCompact = !!n.compact;
  });

  const partOf = {};
  for (const s of steps) {
    // 压缩点也算进块里：宿主段本身可能就是那条边界记录，只按正文段建表会让
    // 一部分岔出连线静默指不到宿主块（links.hostAt 变 null）。
    for (let j = s.i0; j <= s.i1; j++) partOf[nodes[j].id] = s.i;
  }

  for (const s of steps) {
    s.level = s.level === 9 ? 0 : s.level;
    s.tasks = s.branchIds.length;
    s.role = s.segs === 0 ? '压缩点' : s.main === 0 ? '插曲' : s.side ? '主线·夹插曲' : '主线';
    let best = '', cnt = 0;
    for (const [b, c] of Object.entries(s.tally)) if (c > cnt) { best = b; cnt = c; }
    s.dominant = best;
    s.dominantSegs = cnt;
    s.title = taskOf[best]?.title ?? '';
    delete s.tally;
    s.outs = s.outs.slice(0, 3);
    // "写了几件"和"列了几件"是两个数（outs 截三）；WorkBuddy 这类日志只给后者，
    // 两个数对不上时别印"写出 0 件，含 brief.md"这种自相矛盾的句子。
    s.made = s.wrote > 0
      ? `写出 ${s.wrote} 件${s.outs.length ? `，含 ${s.outs.join('、')}` : ''}`
      : s.outs.length ? `涉及 ${s.outs.join('、')}` : '没有产物';
    // "这块解决了什么"：优先取一条和块名不同的已证增量，否则落到产物；
    // 再没有就写这段的第一句回复（标明"回："，是摘录不是判据）。
    const fresh = s.lines.find((l) => l.text !== s.title) ?? s.lines[0];
    s.solvedFrom = fresh ? fresh.id : s.outs.length ? 'outs' : '';
    s.solved = fresh ? fresh.text : s.outs.length || s.wrote ? s.made
      : s.reply ? `回：${clip(s.reply, 46, false) || clip(s.reply, 46, true)}`
        : '没有回复，也没有产物';
    s.read = `convledger body ${s.segIds[0] || s.from}`;
    // 摘要分三格，各自有源：mark＝远景那几个字；gist＝中景那行；solved＝这块解决了什么。
    // 文件名不能从中间截：放不下就退到去扩展名的主干，再放不下才截。
    const nameCell = (n) => {
      // 文件名正好和命令同名（"convledger-cleanup.mjs"）时别拿来当题：远景卡上读起来
      // 就是一条工具回执，跟真正的回执分不开。
      if (!n || TOOLISH.test(String(n))) return '';
      return (wlen(n) <= CLAIM_MARK_W ? n : '')
        || clip(String(n).replace(/\.[A-Za-z0-9]{1,6}$/, ''), CLAIM_MARK_W, true)
        || clip(n, CLAIM_MARK_W, true);
    };
    s.mark = clip(s.say, CLAIM_MARK_W, false) || clip(s.say, CLAIM_MARK_W, true)
      || clip(s.topic, CLAIM_MARK_W, true)
      || nameCell(s.outs[0])
      || (s.wrote ? `写 ${s.wrote} 件` : '') || (s.compacts ? '压缩' : '—');
    // 中景标题：有模型综述就用综述；没有就按这一块的动作派生（写了什么/有没有产物），
    // 绝不把用户原话剪一段当标题（2026-11-09 用户：每一块都该有总结，不是复读）。
    const derived = s.outs.length
      ? `写 ${s.outs[0]}${s.wrote > s.outs.length ? ` 等 ${s.wrote} 件` : ''}`
      : s.wrote ? `写 ${s.wrote} 件`
        : s.verified ? '只有已证增量，没有产物'
          : s.say ? '讨论过，没有落产物' : '（这块内没有真人提问）';
    s.gist = clip(derived, BLOCK_GIST_W, true);
    s.gistIsAsk = false;
    s.gistFrom = '';
    s.gistDerived = true;
    const first = s.segIds[0], lastSeg = s.segIds[s.segIds.length - 1];
    s.span = first ? (first === lastSeg ? first : `${first}–${lastSeg}`) : `${s.from}（只有压缩事件）`;
    s.sent = s.h0 === null ? '' : s.h0 === s.h1 ? `第 ${s.h0} 句` : `第 ${s.h0}–${s.h1} 句`;
    // 块内一句人话都没有时不编句范围，改写"接第 X 句"——X 是上一块末尾那句，可复算
    s.carrySent = s.h0 === null && s.carry ? `接第 ${s.carry} 句` : '';
    s.fork = [];
    s.back = [];
  }
  // 跨块的"接上块"不靠支号相等：插曲会终结它的宿主支，主线回来时是一条新支，
  // 按支号判连续会大面积误报成断开。块与块的先后由步号（脊线）说话，这里只数得实的：
  // 这块里新起了几个支头。
  const headAt = {};
  for (const f of frames) headAt[f.head] = true;
  for (const s of steps) {
    s.heads = s.segIds.filter((id) => headAt[id]).length;
    s.compactAt = s.segIds.length ? '' : s.from;
  }
  const links = [];
  for (const f of frames) {
    const at = partOf[f.head];
    if (at === undefined) continue;
    const hostAt = f.host ? partOf[f.host] : undefined;
    const rejoinAt = f.rejoin ? partOf[f.rejoin] : undefined;
    links.push({ b: f.id, head: f.head, at, host: f.host || '', hostAt: hostAt ?? null, rejoin: f.rejoin || '', rejoinAt: rejoinAt ?? null, depth: f.depth });
    // 只在真的跨块时记边：宿主就在这一块、或汇回也回到这一块，画出来是自环，
    // 说成"块4 岔出到块4"是噪音。块内部的插曲用 inside 计数表达。
    if (hostAt === at) steps[at - 1].inside++;
    else if (hostAt !== undefined && steps[hostAt - 1]) steps[hostAt - 1].fork.push({ b: f.id, at });
    if (rejoinAt !== undefined && rejoinAt !== at) steps[at - 1].back.push({ b: f.id, at: rejoinAt });
  }
  let n = 0;
  for (const s of steps) if (s.main) s.step = ++n;

  // 没步号的块不是"缺编号"，是夹在主线的两步之间（插曲段）。夹在哪两步是数得出来的：
  // 前面最近一个主线步、后面最近一个主线步。图上那块"插曲"卡就靠这两个数说清自己是谁。
  const stepAt = {};
  for (const s of steps) if (s.step !== null) stepAt[s.step] = s;
  steps.forEach((s, i) => {
    s.afterStep = null;
    s.beforeStep = null;
    s.bridge = null;
    if (s.step !== null) return;
    for (let j = i - 1; j >= 0; j--) if (steps[j].step !== null) { s.afterStep = steps[j].step; break; }
    for (let j = i + 1; j < steps.length; j++) if (steps[j].step !== null) { s.beforeStep = steps[j].step; break; }
    // 是哪条支把这两步之间"借走"了：该支的头在 afterStep 那块、汇回在 beforeStep 那块，
    // 且这块本身属于这条支。对不上就留 null——图上只说"夹在两步之间"，不编支号。
    const host = s.afterStep === null ? null : stepAt[s.afterStep];
    const back = s.beforeStep === null ? null : stepAt[s.beforeStep];
    if (host && back) {
      const l = links.find((x) => x.hostAt === host.i && x.rejoinAt === back.i && s.branchIds.includes(x.b));
      if (l) s.bridge = { b: l.b, hostStep: s.afterStep, rejoinStep: s.beforeStep };
    }
  });
  return { steps, links, mainSteps: n };
}

export function readView(storeDir) {
  const read = (f) => fs.readFileSync(path.join(storeDir, f), 'utf8');
  const ledger = JSON.parse(read('ledger.json'));
  const facts = JSON.parse(read('facts.json'));
  const claims = JSON.parse(read('claims.json'));
  const segs = ledger.segments;
  const cardText = (id) => fs.readFileSync(path.join(storeDir, 'segments', `${id}.md`), 'utf8');
  const cardOf = {};
  for (const s of segs) cardOf[s.id] = cardText(s.id);
  const opener = (s) => (cardOf[s.id].match(/^开场: (.*)$/m)?.[1] ?? '').trim();
  const oneline = {};
  for (const row of read('index.md').split('\n')) {
    const c = row.split('|').map((x) => x.trim());
    if (/^S\d{2,}$/.test(c[1])) oneline[c[1]] = c[6];
  }

  const hosts = Object.entries(facts.branches.hosts ?? {});
  // One rule for where a branch starts, owned by topics.mjs — the map and the ledger
  // must not each carry a copy of it and drift.
  const groups = [];
  segs.forEach((s, i) => {
    if (opensBranch(s, i)) groups.push({ ask: s, items: [] });
    groups[groups.length - 1].items.push(s);
  });
  const tree = deriveBranches(ledger, claims);
  const topics = readTopics(storeDir);
  // 人写的外挂层：notes 是标注，不是增量；requests 是续做请求。两者都只读进 payload，
  // 永不参与六条判据，也永不写成 basis:'verified'。
  const human = readNotes(storeDir);
  const queue = readRequests(storeDir);
  const topicNames = {};
  for (const t of publishedTopics(topics)) for (const id of t.segments) (topicNames[id] ??= []).push(t.name);

  const nodes = segs.map((s) => {
    const b = boundaryOf(facts.boundaries, s);
    const entry = claims[s.id] ?? {};
    const verified = entry.basis === 'verified';
    const claim = String(entry.text ?? '').replace(/\s+/g, ' ').trim();
    // a proved increment outranks the index hook and the opener: it is the one line
    // about this segment that has been checked against the segment's own bytes
    const t = titleOf(verified ? [claim, oneline[s.id], opener(s)] : [oneline[s.id], opener(s), claim], deedOf(s));
    return {
      id: s.id, anchor: s.anchor, kind: s.kind, label: kindLabel(s.kind),
      group: groups.findIndex((g) => g.items.some((x) => x.id === s.id)),
      // `task` is the branch this segment hangs under; `branches` further down stays
      // the sub-agent fan-out list — two meanings of "branch", so two distinct names.
      task: tree.branchOf[s.id] ?? '',
      taskState: tree.branches.find((b) => b.id === tree.branchOf[s.id])?.stateLabel ?? '',
      taskHead: tree.branches.some((b) => b.head === s.id),
      topics: topicNames[s.id] ?? [],
      t0: s.turnFrom, t1: s.turnTo, turns: s.turnTo - s.turnFrom + 1, calls: s.toolCalls,
      rt: s.tokens.toolRoundTrip, dlg: s.tokens.dialogue, card: tok(cardOf[s.id]),
      ts: String(s.tsFrom).slice(11, 16), tsEnd: String(s.tsTo).slice(11, 16),
      starts: s.starts.join(','), compact: !!s.isCompactSummary, attach: s.attachUnder ?? '', hash: String(s.contentHash).slice(0, 12),
      tools: Object.entries(s.tools).sort((a, x) => x[1] - a[1]).slice(0, 4).map(([k, v]) => `${k}×${v}`).join('  '),
      outs: [...new Set((s.artifacts ?? []).map((p) => String(p).split('/').pop()))].slice(0, 3).join('、'),
      // 产物全名只给块层分类用（面板说"改了页面、测试和文档"，不列文件名）。outs 仍是
      // 卡面那三个短名，两个出口各管各的，别让"列几个"和"写了几个"混成一个数。
      files: [...new Set((s.artifacts ?? []).map((p) => String(p).split(/[\\/]/).pop()))].slice(0, 16),
      line: t.title, fromTool: t.fromTool,
      // 真人原话全文（卡片「开场:」那一行，最长 160 字）。块摘要要用它，不能用
      // index.md 的一句话钩子——那个钩子硬截到 16 字，会在子句中间断掉。
      say: oneLine(opener(s)).slice(0, 160),
      claim: claim.slice(0, 200),
      topic: String(entry.topic ?? ''),
      // three states must never be confused on a surface: 已证 / 规则站位 / 无正文
      basis: verified ? 'verified' : entry.basis ?? 'unknown',
      moves: movesOf(entry).join(' '),
      wrote: (s.filesWritten ?? []).length,
      errs: (s.errors ?? []).length,
      open: movesOf(entry).includes('open'),
      ...(entry.topic ? { topic: String(entry.topic).slice(0, 40) } : {}),
      ...(entry.revision ? { revision: true } : {}),
      branches: hosts.filter(([t]) => +t >= s.turnFrom && +t <= s.turnTo).flatMap(([, names]) => names),
      pre: b ? b.preTokens : 0, post: b ? b.postTokens : 0,
    };
  });

  const asks = groups.map((g, n) => {
    const a = g.ask;
    const b = boundaryOf(facts.boundaries, a);
    const who = a.kind === 'boundary' ? '系统压缩' : a.starts.includes('open-on-human') ? '你' : '转向';
    const c = claims[a.id];
    const cand = c?.basis === 'verified' ? [c.text, oneline[a.id], opener(a)] : [oneline[a.id], opener(a), c?.text];
    const text = a.kind === 'boundary'
      ? (b?.preTokens == null
        ? '自动压缩：这个 runner 没记 token 数（边界仍在，摘要可回源）'
        : `自动压缩：压掉 ${b.preTokens.toLocaleString('en-US')}t，留 ${(b?.postTokens ?? 0).toLocaleString('en-US')}t`)
      : a.kind.startsWith('pivot') ? '这里被打断 / 转向' : titleOf([...cand, `（从 turn ${a.turnFrom} 继续）`], deedOf(a)).title;
    return { n, id: a.id, first: g.items[0].id, count: g.items.length, who, text: text.replace(/\s+/g, ' ').trim().slice(0, 90), ts: String(a.tsFrom).slice(11, 16) };
  });

  const indexTok = tok(read('index.md'));
  const routeTok = indexTok + nodes.reduce((a, s) => a + s.card, 0);
  const lastBoundary = facts.boundaries[facts.boundaries.length - 1] ?? { preTokens: 0 };
  const shareCap = Math.floor(lastBoundary.preTokens * ROUTE_SHARE_CAP);
  const rtTotal = nodes.reduce((a, s) => a + s.rt, 0);
  const fat = nodes.filter((s) => s.rt > 20000).sort((a, s) => s.rt - a.rt);
  const fatRt = fat.reduce((a, s) => a + s.rt, 0);

  // One per-branch readout, built here so `convledger branches` and the map lanes
  // cannot disagree about what a branch is or what state it reached.
  const bn = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() ?? '';
  const tasks = tree.branches.map((b) => ({
    id: b.id,
    head: b.head,
    title: nodes.find((x) => x.id === b.head)?.line ?? '',
    state: b.state, stateLabel: b.stateLabel, level: b.level,
    criterion: BRANCH_STATES[b.level].earnedBy, // the badge has to name the evidence behind it
    verified: b.verified.length, wrote: b.wrote.length,
    open: b.open.length, errs: b.errs.length, tail: b.tail,
    closed: b.closed, closedLabel: CLOSED_LABELS[b.closed],
    segs: b.segments.length, span: `${b.segments[0]}-${b.segments[b.segments.length - 1]}`,
    outs: b.wrote.map(bn).slice(0, 3).join('、'),
    readBack: b.readBack ? { at: b.readBack.at, file: bn(b.readBack.file) } : null,
    blocked: b.blocked,
    t0: b.turnFrom, t1: b.turnTo, calls: b.calls, rt: b.rt,
    topics: [...new Set(b.segments.flatMap((id) => topicNames[id] ?? []))],
  }));
  for (const n of nodes) {
    n.note = segmentNote(n);
    n.tip = `${n.label} · ${n.anchor} · turn ${n.t0}-${n.t1} · ${n.calls} 次调用 · ${num(n.rt)}t 工具往返 · 路由卡 ${n.card}t`
      + (n.errs ? ` · ⚠${n.errs} 处报错` : '') + (n.wrote ? ` · 写出 ${n.wrote} 件` : '');
  }
  for (const t of tasks) {
    t.note = branchNote(t);
    t.tip = `${t.id} 起于 ${t.head} · turn ${t.t0}-${t.t1} · ${t.calls} 次调用 · ${num(t.rt)}t 往返\n判据：${t.criterion}`
      + (t.outs ? `\n落地物：${t.outs}` : '') + (t.blocked ? '\n⚠ 支内有报错的段' : '');
  }
  const frames = frameSkeleton(nodes, tasks, tree.branches);
  const inTask = {};
  for (const n of nodes) (inTask[n.task] ??= []).push(n);
  for (const t of tasks) t.brief = branchBrief(inTask[t.id] ?? []);
  // one derivation for both surfaces: the star map draws these blocks, `convledger steps`
  // prints them, and both must agree on what "第几步" is.
  // 水位线先读出来：它决定 stepsOf 要不要在真人提问处起新块（PRD-blocks-live）。
  // 只认显式写下的 askSplitFrom：没有就不切——写阶段说明本身不许顺手改变切块结果。
  const phaseTable = readPhases(storeDir);
  // 没有阶段表时按提问切块：每句真人提问起一块，否则整段会话只在压缩点切开，
  // 十几句人话被吞成两三张卡（2026-10-31 用户口径）。已有阶段时仍只认写下的水位线。
  const hasPhases = (phaseTable.phases ?? []).length > 0;
  const splitFrom = Number.isFinite(phaseTable.askSplitFrom) ? phaseTable.askSplitFrom : hasPhases ? Infinity : 0;
  const stepLayer = stepsOf(nodes, asks, tasks, frames, { splitFrom });
  // 模型综述（summaries.json）：只认「段集合＋锚点 hash」都还对得上的那一条。块被合并、
  // 拆分或末尾又长了新段，旧综述就整条失效——宁可回落成原话，也不把旧总结挂在新内容上。
  const sums = readSummaries(storeDir);
  const sumStat = { blocks: 0, dropped: 0, tasks: 0 };
  for (const s of stepLayer.steps) {
    const e = sums.blocks[String(s.i)];
    if (!e) continue;
    if (e.hash !== blockHash(s, nodes)) { sumStat.dropped++; continue; }
    s.sum = { short: e.short, title: e.title, said: e.said, answered: e.answered, done: e.done, need: e.need ?? null, lesson: e.lesson ?? null, basis: 'model' };
    s.sumFrom = s.span || s.segIds[0] || s.from;
    s.gist = e.title;
    s.gistFrom = '';
    s.gistDerived = false;
    s.gistIsAsk = false;
    s.mark = e.short;
    sumStat.blocks++;
  }
  for (const t of tasks) {
    const e = sums.tasks[t.id];
    if (!e || e.head !== t.head) continue;
    t.sumTitle = e.title;
    sumStat.tasks++;
  }
  // 阶段层（phases.json）：模型划的连续步区间。只认锚点还新鲜的；尾部还在长时，
  // 最后一段自然失效并回落成「还没有模型说明」，不拿旧说明挂新内容。
  const applied = applyPhases(phaseTable, stepLayer.steps, nodes, stepLayer.mainSteps);
  for (const ph of applied.phases) {
    for (const b of ph.blockIds) {
      const s = stepLayer.steps[b - 1];
      if (s) s.phase = ph.n;
    }
  }
  // 尾段：还没写阶段说明的步。页面画虚线占位带，措辞固定「阶段说明待写」，不编说明。
  const lastPhaseTo = applied.phases.reduce((m, p) => Math.max(m, p.to), 0);
  const tail = stepLayer.mainSteps > lastPhaseTo
    // whole＝整段一段阶段都没有：那不是"尾段"，是"还没划阶段"。
    ? { from: lastPhaseTo + 1, to: stepLayer.mainSteps, written: false, whole: applied.phases.length === 0 } : null;
  // 章层（chapters.json，PRD-chapters）：连续几十步的「接手一页」，边界必须落在阶段边界上。
  // 只认锚点新鲜、且区间内一段阶段都不缺的章——里面任何一段改写就整章失效，
  // brief 退回阶段模式，而不是拿旧章话对新内容说话。
  const chapterLayer = applyChapters(readChapters(storeDir), stepLayer.steps, nodes, stepLayer.mainSteps, applied.phases);
  for (const c of chapterLayer.chapters) {
    for (const b of c.blockIds) { const s = stepLayer.steps[b - 1]; if (s) s.chapter = c.n; }
  }

  return {
    nodes, asks, tasks, frames,
    steps: stepLayer.steps, links: stepLayer.links, mainSteps: stepLayer.mainSteps,
    phases: applied.phases,
    chapters: chapterLayer.chapters,
    tail,
    notes: human.notes,
    brief: sessionBrief({ segs: segs.length, boundaries: facts.boundaries.length }, tasks, nodes, frames),
    meta: {
      session: ledger.sessionId, sourceFile: ledger.sourceFile, runner: ledger.runner,
      cwd: ledger.cwd || '',
      // 画布上「项目任务页」的入口：同一把项目键尺，和 /projects.json 用的一致。
      projectKey: ledger.cwd ? projectKey(ledger.cwd) : null,
      // 画布的身份标注：这段会话是谁、在哪、什么时候开的——不是装饰，是把「我在看哪段」钉死
      models: facts.session?.models ?? [],
      model: facts.session?.model ?? null,
      startedAt: isoOf(facts.session?.span?.[0]),
      endedAt: isoOf(facts.session?.span?.[1]),
      durationMin: facts.session?.durationMin ?? 0,
      gitBranch: facts.session?.gitBranch ?? null,
      archive: archiveState(storeDir),
      built: String(ledger.builtAt).slice(0, 16).replace('T', ' '),
      // 页面拿这个显示本地时间：built 是 UTC 的「YYYY-MM-DD HH:mm」，看起来像停住了。
      builtAt: String(ledger.builtAt),
      mb: (ledger.sourceBytes / 1048576).toFixed(2),
      turns: facts.turns.total, human: facts.turns.human, toolTurns: facts.turns['tool-result'],
      calls: facts.toolCalls.total, segs: segs.length, branches: facts.branches.total,
      // how much of the semantic layer is actually proved, next to how many segments exist
      verified: nodes.filter((s) => s.basis === 'verified').length,
      summaries: sumStat,
      phases: { written: applied.phases.length, dropped: applied.dropped },
      chapters: { written: chapterLayer.chapters.length, dropped: chapterLayer.dropped, dropReasons: chapterLayer.dropReasons },
      askSplitFrom: Number.isFinite(splitFrom) ? splitFrom : null,
      boundaries: facts.boundaries.length, groups: groups.length,
      // task branches (structure) and topic branches (labelled) are different claims
      // to make, so they are counted and shown apart
      taskBranches: tree.count, taskStates: tree.byState, topicBranches: publishedTopics(topics).length,
      taskLadder: BRANCH_STATES.map((s) => ({ id: s.id, label: s.label, earnedBy: s.earnedBy })),
      // the open-on-human rule also fires on a compact-summary turn (segment.mjs RULES),
      // so "how many nodes did the human start" has to subtract those or it lies.
      openedByHuman: nodes.filter((s) => s.starts.includes('open-on-human') && !s.compact).length,
      indexTok, indexCap: INDEX_FIXED_TOK + INDEX_TOKENS_PER_SEGMENT * segs.length,
      routeTok, shareCap, headroom: shareCap - routeTok,
      routePct: lastBoundary.preTokens ? (routeTok / lastBoundary.preTokens * 100).toFixed(1) : '0',
      fatIds: fat.map((s) => s.id).join(' + '), fatPct: rtTotal ? Math.round(fatRt / rtTotal * 100) : 0,
      rtTotal, maxRt: nodes.reduce((a, s) => Math.max(a, s.rt), 1),
      // 人写的两条不混进上面的 verified：它们是不需要证据的标注，数在一起会把
      // "有多少段被证过"说大
      humanNotes: human.notes.length,
      requestsPending: queue.rows.filter((r) => !r.done).length,
      ...(queue.bad ? { requestsBad: queue.bad } : {}),
    },
  };
}

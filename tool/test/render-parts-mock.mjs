#!/usr/bin/env node
/* 第八轮设计模型：把 96 段按压缩区聚成「部分」，出两级视图的静态 HTML。
   只读源日志与账本，不碰 src/ 也不碰 web/ —— 这是给审的模型，不是页面。
   run: node test/render-parts-mock.mjs [session.jsonl] */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../src/build.mjs';
import { readView } from '../src/view.mjs';
import { storeDir } from '../src/store.mjs';

const CALIBRATION = '~/.qoder/projects/D--mycode-conversation-graph-research/demo0001-838b-4697-95fc-9756c7ce93eb.jsonl';
const FILE = (process.argv[2] || CALIBRATION).replace(/\\/g, '/');
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..', 'out', 'store');

const built = build(FILE);
const sid = path.basename(FILE).replace(/\.jsonl$/, '');
const view = readView(storeDir(ROOT, sid));
const turns = built.projection.turns;

/* 句＝真人说的话（kind==='human'，不含压缩摘要、不含工具往返）。
   这是模型侧唯一能对上"第几句话"的口径：2129 回合里只有 48 句是人说的。 */
const rankOf = new Array(turns.length).fill(0);
let rank = 0;
turns.forEach((t, i) => {
  if (t.kind === 'human') rankOf[i] = ++rank;
});
const humanTotal = rank;

const segs = built.ledger.segments;
const nodeOf = {};
for (const n of view.nodes) nodeOf[n.id] = n;

for (const s of segs) {
  const win = rankOf.slice(s.turnFrom - 1, s.turnTo);
  const hit = win.filter((r) => r > 0);
  s.h0 = hit.length ? hit[0] : null;
  s.h1 = hit.length ? hit[hit.length - 1] : null;
}

/* 一个部分＝两次自动压缩之间的那一段工作。压缩事件本身就是"这一段到此为止"的天然句号。 */
const zones = [];
let cur = [];
for (const s of segs) {
  if (s.isCompactSummary && cur.length) { zones.push(cur); cur = []; continue; }
  cur.push(s);
}
if (cur.length) zones.push(cur);

const LADDER = ['未证', '已想清', '已落地', '已复核'];
const taskById = {};
for (const t of view.tasks) taskById[t.id] = t;

const parts = zones.map((list, i) => {
  const ids = list.map((s) => s.id);
  const taskIds = [...new Set(ids.map((id) => nodeOf[id]?.task).filter(Boolean))];
  const nodes = ids.map((id) => nodeOf[id]).filter(Boolean);
  const claims = nodes.filter((n) => n.basis === 'verified');
  const mv = (k) => claims.filter((n) => (n.moves || []).includes(k)).length;
  const level = Math.max(0, ...taskIds.map((t) => taskById[t]?.level ?? 0));
  const sides = taskIds.filter((t) => taskById[t]?.head && nodeOf[taskById[t].head]?.kind.startsWith('side-episode'));
  const last = taskIds[taskIds.length - 1];
  return {
    i: i + 1,
    segs: ids,
    segN: ids.length,
    h0: list.find((s) => s.h0)?.h0 ?? null,
    h1: [...list].reverse().find((s) => s.h1)?.h1 ?? null,
    t0: list[0].turnFrom,
    t1: list[list.length - 1].turnTo,
    tasks: taskIds,
    taskN: taskIds.length,
    sideN: sides.length,
    state: LADDER[level],
    level,
    decision: mv('decision'),
    ruleout: mv('ruleout'),
    open: nodes.filter((n) => n.open).length,
    errs: nodes.filter((n) => n.errs).length,
    compact: nodes.filter((n) => n.compact).length,
    lines: claims.slice(0, 3).map((n) => ({ id: n.id, text: n.claim, move: (n.moves || [])[0] || '' })),
    closed: last ? taskById[last].closedLabel : '',
    now: i === zones.length - 1,
  };
});

/* 第二级：一个部分内部＝现在的画布形状（一条支一行，卡从左往右） */
const detail = parts.map((p) => {
  const list = p.segs.map((id) => nodeOf[id]).filter(Boolean);
  const order = [];
  for (const n of list) if (!order.includes(n.task)) order.push(n.task);
  return {
    i: p.i,
    rows: order.map((tid) => ({
      id: tid,
      head: taskById[tid]?.title || '',
      state: taskById[tid]?.stateLabel || '',
      closed: taskById[tid]?.closedLabel || '',
      cards: list.filter((n) => n.task === tid).map((n) => {
        const s = segs.find((x) => x.id === n.id);
        return {
          id: n.id,
          kind: n.kind,
          t0: n.t0, t1: n.t1, turns: n.turns, calls: n.calls, rt: n.rt,
          h0: s?.h0 ?? null, h1: s?.h1 ?? null,
          line: n.basis === 'verified' ? n.claim : '',
          basis: n.basis,
          state: n.taskState,
          wrote: n.wrote, errs: n.errs, open: n.open,
          outs: n.outs || '',
        };
      }),
    })),
  };
});

const data = { sid, humanTotal, parts, detail, meta: view.meta };
const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>部分层设计模型</title>
<style>
:root{--bg:#101318;--pan:#171b22;--card:#1e232c;--line:#2b333f;--tx:#dfe5ee;--mid:#93a0b4;--dim:#68758a;
--ok:#3fbf7f;--warn:#e0a13a;--bad:#e0655f;--pivot:#c98be0;--blue:#5aa9e6}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:13px/1.5 "Segoe UI",system-ui,sans-serif}
header{position:sticky;top:0;background:#0c0f14;border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:14px;align-items:baseline;flex-wrap:wrap;z-index:5}
header b{font-size:15px}header span{color:var(--mid);font-size:12px}
.wrap{padding:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.part{background:var(--pan);border:1px solid var(--line);border-radius:10px;padding:11px 12px;cursor:pointer;position:relative}
.part:hover{border-color:var(--blue)}
.part.now{border-color:var(--ok)}
.part.side{border-left:3px solid var(--warn)}
.ph{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.pn{font-size:15px;font-weight:700}
.prng{color:var(--blue);font-size:11px;font-variant-numeric:tabular-nums}
.pseg{color:var(--dim);font-size:11px;font-variant-numeric:tabular-nums}
.st{font-size:10px;padding:1px 6px;border-radius:8px;border:1px solid var(--line);color:var(--mid)}
.st.l3{color:var(--ok);border-color:var(--ok)}.st.l2{color:var(--blue);border-color:var(--blue)}.st.l1{color:var(--warn);border-color:var(--warn)}
.pline{margin:7px 0 0;color:var(--tx);font-size:12px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.pnone{margin:7px 0 0;color:var(--dim);font-size:11px;font-style:italic}
.pcnt{margin-top:8px;color:var(--mid);font-size:11px;font-variant-numeric:tabular-nums}
.pcnt i{font-style:normal;color:var(--bad)}
.pcnt em{font-style:normal;color:var(--warn)}
.arrow{position:absolute;right:-11px;top:50%;color:var(--dim);font-size:12px}
.back{background:var(--card);border:1px solid var(--line);color:var(--tx);border-radius:7px;padding:5px 11px;cursor:pointer;font-size:12px}
.lv2{display:none}.lv2.on{display:block}.lv1.off{display:none}
.zone{margin:0 0 14px}
.zrow{display:flex;gap:10px;align-items:flex-start;padding:8px;border:1px dashed var(--line);border-radius:9px;margin-bottom:8px;overflow-x:auto}
.zh{min-width:150px;color:var(--mid);font-size:11px}
.zh b{display:block;color:var(--tx);font-size:12px;font-weight:600}
.cd{min-width:210px;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 9px;font-size:11px}
.cd.v{border-color:#2f6b4d}
.cd .cid{color:var(--dim);font-variant-numeric:tabular-nums}
.cd .ch{color:var(--tx);margin:3px 0;font-size:12px;min-height:17px}
.cd .cr{color:var(--mid);font-variant-numeric:tabular-nums}
.cd .cb{color:var(--dim);margin-top:4px;font-size:10px}
.box{margin-top:18px;border:1px solid var(--line);border-radius:10px;background:var(--pan);padding:10px 12px}
.box input{width:100%;background:#0d1015;border:1px solid var(--line);border-radius:7px;color:var(--tx);padding:8px 10px;font:12px inherit}
.note{color:var(--dim);font-size:11px;margin-top:6px}
h3{margin:16px 0 8px;font-size:13px;color:var(--mid);font-weight:600}
</style></head><body>
<header><b>部分层设计模型</b><span id="hs"></span></header>
<div class="wrap"><div class="lv1" id="lv1"></div><div class="lv2" id="lv2"></div></div>
<script>
var D=${JSON.stringify(data)};
document.getElementById('hs').textContent=D.meta.segs+' 段 / '+D.meta.groups+' 条任务支 / '+D.humanTotal+' 句真人话 / '+D.meta.turns+' 回合 → 聚成 '+D.parts.length+' 个部分（模型，非页面）';
function st(x){return '<span class="st l'+x.level+'">'+x.state+(x.closed&&x.closed!=='进行中'?'·'+x.closed:'')+'</span>'}
function cnt(p){return '第 '+p.segN+' 段 · '+p.taskN+' 支'+(p.sideN?'（含 '+p.sideN+' 插曲）':'')+' · 决策 '+p.decision+' · 排除 '+p.ruleout+' · <em>留问 '+p.open+'</em> · <i>报错 '+p.errs+'</i>'}
document.getElementById('lv1').innerHTML='<div class="grid">'+D.parts.map(function(p,i){
 return '<div class="part'+(p.now?' now':'')+'" data-i="'+i+'"><div class="ph"><span class="pn">第 '+p.i+' 部分</span>'
 +'<span class="prng">第 '+(p.h0??'?')+'–'+(p.h1??'?')+' 句</span>'+st(p)+'</div>'
 +'<div class="pseg">第 '+p.t0+'–'+p.t1+' 回合 · '+(p.t1-p.t0+1)+' 回合（含工具往返）</div>'
 +(p.lines.length?p.lines.map(function(l){return '<div class="pline">「'+l.text+'」<span class="pseg">'+l.id+'</span></div>'}).join('')
   :'<div class="pnone">这个部分还没有一条过了六条判据的认识增量——这里没有话可说，不编。</div>')
 +'<div class="pcnt">'+cnt(p)+'</div>'+(i<D.parts.length-1?'<span class="arrow">→</span>':'')+'</div>';
}).join('')+'</div>'
 +'<h3>口径</h3><div class="note">块＝两次自动压缩之间的一段工作（压缩事件本身就是"这段到此为止"的句号，账本里 19 个）。<b>第 X–Y 句</b>＝真人说的话；<b>第 N–M 回合</b>＝含工具往返的原始序号，锚点命令按它算。两者不同源，所以并排写。块上的每一句话都逐字来自某段 basis:verified 的增量；没有就明写没有。</div>';
function open(i){
 var p=D.parts[i],d=D.detail[i];
 document.getElementById('lv2').innerHTML='<button class="back" onclick="back()">← 回全景</button> '
 +'<b>第 '+p.i+' 部分</b> <span class="prng">第 '+(p.h0??'?')+'–'+(p.h1??'?')+' 句 · 第 '+p.t0+'–'+p.t1+' 回合 · '+p.segN+' 段 · '+p.taskN+' 支</span>'
 +d.rows.map(function(r){return '<div class="zone"><div class="zrow"><div class="zh"><b>'+r.id+' '+r.head+'</b>'+r.state+' · '+r.closed+'</div>'
  +r.cards.map(function(c){return '<div class="cd'+(c.basis==='verified'?' v':'')+'">'
   +'<div class="cid">'+c.id+' · 第 '+(c.h0??'?')+'–'+(c.h1??'?')+' 句 · 第 '+c.t0+'–'+c.t1+' 回合（'+c.turns+' 回合 / '+c.calls+' 次调用 / '+c.rt.toLocaleString('en-US')+'t）</div>'
   +'<div class="ch">'+(c.line||'<span style="color:var(--dim)">（无已证增量，不编）</span>')+'</div>'
   +'<div class="cr">'+c.state+' · 写 '+c.wrote+' · 报错 '+c.errs+' · 留问 '+(c.open?1:0)+'</div>'
   +'<div class="cb">'+(c.outs?'落地物：'+c.outs:'无落地物')+'</div></div>'}).join('')
  +'</div></div>'}).join('')
 +'<div class="box"><input placeholder="在这个部分里接着做：'+p.segs[0]+'…'+p.segs[p.segs.length-1]+'（第 '+(p.h0??'?')+'–'+(p.h1??'?')+' 句）——想改哪一处？">'
 +'<div class="note">这个框只是形状示意。页面发不出消息给当前会话：它能把内容 POST 回本机账本，但要"接着做"还需要一条通道（见 PRD §四的三个选项）。</div></div>';
 document.getElementById('lv1').classList.add('off');document.getElementById('lv2').classList.add('on');window.scrollTo(0,0);
}
function back(){document.getElementById('lv1').classList.remove('off');document.getElementById('lv2').classList.remove('on')}
document.querySelectorAll('.part').forEach(function(e){e.onclick=function(){open(+e.dataset.i)}});
</script></body></html>`;

const out = path.join(here, '..', 'out', 'mock-parts.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log('parts:', parts.length, '| human utterances:', humanTotal, '| segs:', segs.length);
console.log('segs per part:', parts.map((p) => p.segN).join(' '));
console.log('parts with a verified line:', parts.filter((p) => p.lines.length).length, '/', parts.length);
console.log('parts with no line at all:', parts.filter((p) => !p.lines.length).length);
console.log('written:', out);

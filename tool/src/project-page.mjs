// 项目工作台：连续缩放（滑杆 / Ctrl+滚轮）叠在四档表达层之上；依赖用 SVG 箭头画。
// 只读、无框架。数据只有一份：progress-state.json → projectView。
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 项目页的“空状态”：任务状态还没生成（或这个键在本机没有会话）。
 *  这里不返回纯文本 404——从画布点过来的人需要知道为什么空、下一步做什么、怎么回去。 */
export function projectEmptyHtml({ key = '', name = '', cwd = '', sessions = [], known = true, error = '', cli = '' } = {}) {
  const newest = sessions[0] ?? null;
  const tool = cli ? `node "${String(cli).replace(/\\/g, '/')}"` : 'convledger';
  const cmd = `${tool} sync --prepare --project ${key}${newest ? ` --session ${newest.sid8}` : ' --session <会话前8位>'}`;
  const rows = sessions.slice(0, 6).map((s) => `<li><a href="/s/${encodeURIComponent(s.id)}/">${esc(s.title || s.sid8 || s.id)}</a>`
    + `<span class="meta">${esc(s.runner || '')} · ${esc(String(s.sid8 || '').slice(0, 8))}${s.live ? ' · <b class="live">在写</b>' : ''}</span></li>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name || key)} · 还没有任务状态</title>
<style>
:root{--line:#e3e7ee;--muted:#5b6775;--accent:#1f5fa8;--bg:#f6f7f9}
body{margin:0;background:var(--bg);color:#1c2430;font:15px/1.6 "Segoe UI","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif}
a{color:var(--accent)}
.bar{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:12px;padding:10px 22px;background:#fff;border-bottom:1px solid var(--line);flex-wrap:wrap}
.brandmark{display:inline-block;width:20px;height:20px;background:currentColor;-webkit-mask:url('/icon-small.svg') center/contain no-repeat;mask:url('/icon-small.svg') center/contain no-repeat}
.bar a{color:var(--accent);text-decoration:none}.bar a:hover{text-decoration:underline}
.bar a.back-session{border:1px solid var(--line);border-radius:7px;padding:3px 10px;font-weight:600}
.bar b{font-size:16px}.rev{color:var(--muted);font-size:12px}
main{max-width:860px;margin:0 auto;padding:22px 22px 44px}
.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:20px 22px;margin-bottom:14px}
h1{font-size:20px;margin:0 0 6px}
.lead{color:#3a4552;margin:0 0 12px}
.kv{display:grid;grid-template-columns:88px 1fr;gap:4px 12px;color:#3a4552;font-size:14px;margin:10px 0 4px}
.kv dt{color:var(--muted)}.kv dd{margin:0;word-break:break-all}
ol{margin:10px 0 0;padding-left:20px}ol li{margin:4px 0}
pre{background:#f3f5f8;border:1px solid var(--line);border-radius:8px;padding:10px 12px;overflow:auto;font-size:13px;margin:8px 0}
button{border:1px solid var(--line);background:#fff;border-radius:7px;padding:3px 10px;cursor:pointer;font-size:13px;color:#3a4552}
button:hover{border-color:var(--accent);color:var(--accent)}
.acts{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
.acts a,.acts button{display:inline-block;border:1px solid var(--line);background:#fff;border-radius:8px;padding:6px 14px;text-decoration:none;font-weight:600;color:var(--accent)}
.acts a.primary{background:var(--accent);border-color:var(--accent);color:#fff}
ul.sess{margin:6px 0 0;padding-left:18px}ul.sess li{margin:4px 0}
.meta{color:var(--muted);font-size:12px;margin-left:8px}.live{color:#1f7a4d}
.err{color:#8a5a0e;background:#fdf3e3;border:1px solid #edd0a4;border-radius:8px;padding:8px 12px;font-size:13px}
body.embed .bar{display:none}
</style></head><body>
<script>if(new URLSearchParams(location.search).get('embed')==='1')document.body.classList.add('embed');</script>
<div class="bar"><span class="brandmark" aria-hidden="true"></span><b>项目工作台</b><span class="rev">${esc(key)}</span>
<a class="back-session" id="back" hidden>← 返回会话</a><a href="/" style="margin-left:auto">会话库</a></div>
<main>
<div class="card">
<h1>${known ? '这个项目还没有任务状态' : '没有这个项目'}</h1>
<p class="lead">${known
    ? '会话画布和账本已经有了，但项目任务表要跑一次收尾同步才会生成——它不是按会话自动建的。'
    : `项目按工作目录归组。这个键（${esc(key)}）在本机没有对应会话：换一个入口，或先打开会话库。`}</p>
${error ? `<p class="err">状态文件读不了：${esc(error)}</p>` : ''}
<dl class="kv">
  <dt>项目</dt><dd>${esc(name || key)}</dd>
  ${cwd ? `<dt>工作目录</dt><dd>${esc(cwd)}</dd>` : ''}
  <dt>会话</dt><dd>${sessions.length ? `${sessions.length} 段` : '没有'}</dd>
</dl>
${known ? `<ol>
<li>在对应会话里让 agent 跑下面这条（它会冻结素材并给出回执）：</li>
</ol>
<pre id="cmd">${esc(cmd)} <button id="copy" type="button">复制</button></pre>
<ol start="2">
<li>按素材更新任务（结果 / 欠项 / 验收）与处置，再 <code>sync --put</code>。</li>
<li>刷新本页，任务表与经验就会出现。</li>
</ol>` : ''}
${rows ? `<p style="margin:14px 0 0"><b>这个项目里的会话</b></p><ul class="sess">${rows}</ul>` : ''}
<div class="acts">
<a class="primary" id="back2" href="${newest ? `/s/${encodeURIComponent(newest.id)}/` : '/'}"${newest ? '' : ' hidden'}>← 返回会话</a>
<a href="/">打开会话库</a>
</div>
</div>
</main>
<script>
(function () {
  function safe(p) { return typeof p === 'string' && /^\\/s\\/[^\\/]+\\//.test(p) ? p : ''; }
  var from = safe(new URLSearchParams(location.search).get('from'));
  var back = document.getElementById('back'), back2 = document.getElementById('back2');
  if (from) {
    var cut = from.indexOf('#'), hash = cut >= 0 ? from.slice(cut) : '';
    var path = cut >= 0 ? from.slice(0, cut) : from;
    back.hidden = false; back.href = path + hash;
    back2.href = path + hash;
  }
  var btn = document.getElementById('copy');
  if (btn) btn.addEventListener('click', function () {
    var t = document.getElementById('cmd').textContent.replace('复制', '').trim();
    (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () {
      btn.textContent = '已复制'; setTimeout(function () { btn.textContent = '复制'; }, 1600);
    }, function () { btn.textContent = '手动选上面那条'; });
  });
})();
</script>
</body></html>`;
}

export function projectPageHtml(view, { name = '', key = '', at = new Date(), live = null, insights = null } = {}) {
  const data = JSON.stringify({ view: { ...view, insights }, name, key, at: at.toISOString(), live }).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name || key)} · 工作台</title>
<style>
:root{--line:#e3e7ee;--muted:#5b6775;--accent:#1f5fa8;--bg:#f6f7f9}
body{margin:0;background:var(--bg);color:#1c2430;font:15px/1.6 "Segoe UI","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif}
a{color:var(--accent)}
.bar{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:12px;padding:10px 22px;background:#fff;border-bottom:1px solid var(--line);flex-wrap:wrap}
.brandmark{display:inline-block;width:20px;height:20px;background:currentColor;-webkit-mask:url('/icon-small.svg') center/contain no-repeat;mask:url('/icon-small.svg') center/contain no-repeat}
.bar a{color:var(--accent);text-decoration:none}.bar a:hover{text-decoration:underline}
.bar a.back-session{border:1px solid var(--line);border-radius:7px;padding:3px 10px;font-weight:600}
.bar b{font-size:16px}.rev{color:var(--muted);font-size:12px}
.zoom{display:flex;align-items:center;gap:8px;margin-left:auto}
.zoom input[type=range]{width:150px}
.zoom button{padding:3px 10px;border:1px solid var(--line);background:#fff;border-radius:999px;cursor:pointer;font-size:13px;color:#3a4552}
.zoom button[aria-pressed="true"]{border-color:var(--accent);color:var(--accent);font-weight:600}
.zpct{color:var(--muted);font-size:12px;width:38px;text-align:right}
main{max-width:1080px;margin:0 auto;padding:18px 22px 44px}
.counts{display:flex;gap:16px;flex-wrap:wrap;background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin-bottom:14px}
.counts b{font-size:17px}.counts span{color:var(--muted)}
.graph{background:#fff;border:1px solid var(--line);border-radius:10px;padding:10px 14px 4px;margin-bottom:14px;overflow-x:auto}
.graph h2{font-size:13px;margin:0 0 4px;color:var(--muted);font-weight:600}
.graph .edge{stroke:#9aa6b5;fill:none;stroke-width:1.4}
.graph .edge.dim{opacity:.28}
.graph .node rect{fill:#f7f9fc;stroke:#cfd6df;border-radius:4px}
.graph .node.sel rect{stroke:var(--accent);stroke-width:2}
.graph .node text{font-size:11px;fill:#26303d;user-select:none}
.graph .node{cursor:pointer}
.graph .empty{color:var(--muted);font-size:12px;padding:4px 0 8px}
.ms{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 18px;margin-bottom:14px}
.ms h2{font-size:15px;margin:0}.mcount{color:var(--muted);margin:2px 0 10px;font-size:13px}
.task{border-top:1px solid #eef1f5;padding:8px 4px;cursor:pointer;border-radius:6px;transition:background .15s}
.task:first-of-type{border-top:0}.task:hover{background:#f8fafc}.task.sel{background:#eef4fc;box-shadow:inset 3px 0 0 var(--accent)}
.row{display:flex;align-items:baseline;gap:10px}.id{color:#8a94a3;font-size:12px;margin-left:auto}
.short{font-weight:600}.title{margin:4px 0 0;font-weight:600}
.f{margin:2px 0 0}.k{color:var(--muted)}.meta{margin:4px 0 0;color:#7a8494;font-size:12px}
.deps{color:#7a8494;font-size:12px}.deps a{text-decoration:none;border-bottom:1px dotted}
.pill{flex:none;font-size:12px;padding:1px 9px;border-radius:999px;border:1px solid #cfd6df;background:#f2f4f7;color:#3a4552}
.pill.done{border-radius:4px;border-color:#1f7a4d;background:#e8f5ee;color:#1f7a4d}
.pill.active{border-color:#1f5fa8;background:#e9f1fb;color:#1f5fa8;font-weight:600}
.pill.planned{border-style:dashed}.pill.awaiting-verification{border-color:#a06a12;background:#fdf3e3;color:#8a5a0e}
.pill.blocked{border-color:#a33;background:#fbeaea;color:#a33}.pill.cancelled{text-decoration:line-through;color:#7a8494}
ul.ev{margin:6px 0 0;padding-left:18px;color:#4a5563;font-size:13px}
.next{background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin-bottom:14px}
.next h2{font-size:14px;margin:0 0 6px}.next li{margin:2px 0}
.empty{color:var(--muted);padding:24px 4px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.graph .node:focus-visible rect{stroke:var(--accent);stroke-width:2.5}
.task:focus-visible{background:#eef4fc}
.hint{position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:1px solid var(--line);color:var(--muted);font-size:12px;padding:6px 22px}
.livebox{background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin-bottom:14px}
.livebox h2{font-size:14px;margin:0 0 6px;display:flex;align-items:center;gap:8px}
.livebox .lvdot{width:8px;height:8px;border-radius:50%;background:#9aa6b5;flex:none}
.livebox .lvdot.live{background:#1f7a4d;box-shadow:0 0 0 3px rgba(31,122,77,.14)}
.livebox .lvwhen{margin-left:auto;font-size:11px;color:var(--muted);font-weight:400}
.livebox .lvmain{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.livebox .lvtitle{font-weight:600;font-size:15px;text-decoration:none}
.livebox .lvstep{color:var(--muted);font-size:13px}
.livebox .lvblock{margin:4px 0 0;color:#3a4552;font-size:13.5px}
.livebox .lvfoot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:8px;color:var(--muted);font-size:12px}
.livebox .badge{border-radius:999px;padding:1px 9px;border:1px solid #cfd6df;background:#f2f4f7;color:#3a4552;font-size:12px}
.livebox .badge.warn{border-color:#c58a1a;background:#fdf3e3;color:#8a5a0e}
.livebox .badge.ok{border-color:#1f7a4d;background:#e8f5ee;color:#1f7a4d}
.livebox .lvlink{margin-left:auto;text-decoration:none;font-weight:600}
.insights{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:14px}
.icard{background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 16px;flex:1 1 320px;min-width:0}
.icard.wide{flex:2 1 480px}
.icard h2{font-size:14px;margin:0 0 2px}
.icard .isub{color:var(--muted);font-size:12px;margin:0 0 8px}
.igrp{border-top:1px solid #eef1f5;padding-top:7px;margin-top:7px}
.igrp:first-of-type{border-top:0;padding-top:0;margin-top:0}
.igh{font-size:12.5px;color:#3a4552;margin-bottom:3px;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.igh a{text-decoration:none;border-bottom:1px dotted}
.igh .icount{color:#8a94a3;font-size:11.5px}
.ilit{margin:2px 0;font-size:13px;color:#26303d}
.ilit .inum{color:#8a94a3;font-size:11.5px;margin-right:6px}
.ilit .ineed{color:#7a8494;font-size:12px;margin-left:6px}
.imem{margin:3px 0;font-size:13px;color:#26303d}
.imem .icl{font-size:11px;color:#7a8494;margin-right:6px}
.imem .isrc{display:block;margin-top:2px;font-size:10.5px;color:var(--muted);font-variant-numeric:tabular-nums}
.iempty{color:#8a94a3;font-size:13px;margin:4px 0}
body.embed .bar{padding:6px 14px;gap:8px}
body.embed .bar .brandmark,body.embed .bar #pname,body.embed .bar #prev,body.embed .bar a{display:none}
body.embed .bar .zoom{margin-left:0}
</style><link rel="icon" type="image/svg+xml" href="/icon-small.svg"></head><body>
<script>if(new URLSearchParams(location.search).get('embed')==='1')document.body.classList.add('embed');</script>
<div class="bar"><i class="brandmark" aria-hidden="true"></i><b id="pname"></b><span class="rev" id="prev"></span>
  <div class="zoom" role="group" aria-label="缩放">
    <button data-lv="overview" data-z="10">总览</button><button data-lv="far" data-z="35">远景</button><button data-lv="mid" data-z="60">中景</button><button data-lv="near" data-z="85">近景</button>
    <input id="zr" type="range" min="0" max="100" step="1" aria-label="连续缩放">
    <span class="zpct" id="zpct"></span>
  </div>
  <a href="/">会话库</a>
</div>
<section class="livebox" id="livebox"></section>
<section class="insights" id="insights"></section>
<div class="counts" id="counts"></div>
<section class="graph" id="graph" hidden><h2>依赖（箭头：前者 ← 后者「依赖」；点节点选中）<span id="gcap"></span></h2><svg id="gv" width="100%" height="10" role="img" aria-label="任务依赖图"></svg><p class="empty" id="gempty" hidden>没有声明依赖的任务</p></section>
<main id="stage"></main>
<footer class="hint">滑杆或 Ctrl/⌘+滚轮连续缩放 · 1–4 跳档 · 点任务选中 · Enter 展开到近景</footer>
<script id="data" type="application/json">${data}</script>
<script>
(function () {
  var D = JSON.parse(document.getElementById('data').textContent);
  var v = D.view;
  if (D.live) v.live = D.live;
  var LABEL = { done: '已完成', active: '进行中', planned: '未开始', blocked: '受阻', 'awaiting-verification': '待验证', unknown: '待核实', cancelled: '已取消' };
  var stage = document.getElementById('stage');
  var counts = document.getElementById('counts');
  var zr = document.getElementById('zr');
  var zpct = document.getElementById('zpct');
  var NS = 'http://www.w3.org/2000/svg';
  var parsed = (location.hash || '').replace(/^#/, '').split('&').reduce(function (a, kv) { var p = kv.split('='); if (p[0]) a[p[0]] = decodeURIComponent(p[1] || ''); return a; }, {});
  var selected = /^PT[0-9]{3,}$/.test(parsed.task || '') ? parsed.task : null;
  var zoom = parsed.zoom != null && parsed.zoom !== '' && !isNaN(+parsed.zoom) ? Math.max(0, Math.min(100, +parsed.zoom)) : 35;
  var level = parsed.lv || 'far';

  /* 从会话画布点「项目页」过来时带 ?from=/s/<id>/#…：给一条回程，
     回到刚才那段对话的画布（保留档位与选中），并让画布继续显示「← 返回项目」。 */
  (function () {
    var from = new URLSearchParams(location.search).get('from');
    if (!from) return;
    // 不用正则：这段 JS 住在模板字符串里，反斜杠会被模板先吃掉（实测导致整段脚本语法错误）。
    var cut = String(from).indexOf('#');
    var hash = cut >= 0 ? String(from).slice(cut) : '';
    var path = cut >= 0 ? String(from).slice(0, cut) : String(from);
    while (path.slice(-1) === '/') path = path.slice(0, -1);
    if (path.indexOf('/s/') !== 0) return;
    var sid = path.slice(3);
    if (sid.length < 8) return;
    for (var i = 0; i < sid.length; i++) {
      var c = sid.charAt(i).toLowerCase();
      if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || c === '-')) return;
    }
    var here = location.pathname + location.hash;
    var a = document.createElement('a');
    a.className = 'back-session';
    a.href = '/s/' + sid + '/?from=' + encodeURIComponent(here) + hash;
    a.textContent = '← 返回会话';
    a.title = '回到刚才那段对话的画布（保留档位与选中）';
    var bar = document.querySelector('.bar');
    var lib = bar && bar.querySelector('a[href="/"]');
    if (bar) bar.insertBefore(a, lib || null);
  })();

  function levelOf(z, prev) {
    // 滞回：在阈值附近不来回跳
    var h = 3;
    if (prev === 'overview') return z > 25 + h ? (z > 50 + h ? (z > 75 + h ? 'near' : 'mid') : 'far') : 'overview';
    if (prev === 'far') return z < 25 - h ? 'overview' : z > 50 + h ? (z > 75 + h ? 'near' : 'mid') : 'far';
    if (prev === 'mid') return z < 50 - h ? (z < 25 - h ? 'overview' : 'far') : z > 75 + h ? 'near' : 'mid';
    return z < 75 - h ? (z < 50 - h ? (z < 25 - h ? 'overview' : 'far') : 'mid') : 'near';
  }
  function hash() { location.hash = 'zoom=' + Math.round(zoom) + '&lv=' + level + (selected ? '&task=' + selected : ''); }
  function setZoom(z, persist) { zoom = Math.max(0, Math.min(100, z)); level = levelOf(zoom, level); if (persist !== false) hash(); render(); }
  var pendingFocus = null;
  function focusPending() { if (!pendingFocus) return; var n = document.getElementById(pendingFocus); pendingFocus = null; if (n) n.focus(); }
  function select(id) { selected = id; pendingFocus = id; hash(); render(); }
  function open(id) { selected = id; zoom = 85; level = 'near'; pendingFocus = id; hash(); render(); }

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; }
  function tail(t) { return t.status === 'done' ? (t.result || '') : t.status === 'blocked' ? ('受阻：' + (t.blocker || '未写原因')) : (t.remaining || t.nextAction || t.result || ''); }
  function pill(t) { return el('span', 'pill ' + t.status, LABEL[t.status] || t.status); }
  function byId(id) { return v.tasks.find(function (t) { return t.id === id; }); }
  function tasksOf(ms) { return v.tasks.filter(function (t) { return t.milestoneId === ms; }); }

  function shortBytes(n) {
    if (n == null) return '';
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }
  function ago(min) {
    if (min == null) return '时间未知';
    if (min < 1) return '刚刚';
    if (min < 60) return min + ' 分钟前';
    if (min < 1440) return Math.round(min / 60) + ' 小时前';
    return Math.round(min / 1440) + ' 天前';
  }
  var livebox = document.getElementById('livebox');

  /* 会话实时：账本每 20 秒重建，任务模型要收尾才更新；这一块回答「现在做到哪」，
     并明确写出还有多少字节没收尾，避免把「任务都完成了」误读成「已经没活了」。 */
  function renderLive() {
    var l = v.live;
    livebox.textContent = '';
    var h = el('h2');
    h.appendChild(el('i', 'lvdot' + (l && l.session && l.session.live ? ' live' : '')));
    h.appendChild(document.createTextNode('会话实时'));
    var now = new Date();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    h.appendChild(el('span', 'lvwhen', '每 5 秒 · 更新于 ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds())));
    livebox.appendChild(h);
    if (!l || !l.session) {
      livebox.appendChild(el('p', 'meta', '这个项目还没有可读的会话账本。'));
      return;
    }
    var s = l.session;
    var main = el('div', 'lvmain');
    var a = el('a', 'lvtitle', s.title || s.sid8 || '未命名会话');
    a.href = '/s/' + encodeURIComponent(s.id) + '/?from=' + encodeURIComponent(location.pathname + location.hash);
    a.title = '进入这段会话的画布';
    main.appendChild(a);
    if (l.step) main.appendChild(el('span', 'lvstep', '第 ' + (l.step.n == null ? '—' : l.step.n) + ' 步' + (l.step.block == null ? '' : ' · 块 ' + l.step.block)));
    livebox.appendChild(main);
    if (l.step) livebox.appendChild(el('p', 'lvblock', l.step.title ? '这一块：' + l.step.title : '这一块的题名还没写' + (l.step.block == null ? '' : '（块 ' + l.step.block + '）')));
    var foot = el('div', 'lvfoot');
    if (l.pendingBytes > 0) foot.appendChild(el('span', 'badge warn', '有未收尾素材 · ' + shortBytes(l.pendingBytes)));
    else if (l.pendingBytes === 0) foot.appendChild(el('span', 'badge ok', '素材已收尾'));
    else foot.appendChild(el('span', 'badge', '素材范围未知'));
    foot.appendChild(el('span', null, (s.live ? '正在写' : '没在写') + ' · 最后写入 ' + ago(s.idleMin)));
    if (l.members > 1) foot.appendChild(el('span', null, '本项目 ' + l.members + ' 段会话' + (l.liveCount ? ' · ' + l.liveCount + ' 段在写' : '')));
    var go = el('a', 'lvlink', '进入画布 →');
    go.href = '/s/' + encodeURIComponent(s.id) + '/?from=' + encodeURIComponent(location.pathname + location.hash);
    foot.appendChild(go);
    livebox.appendChild(foot);
    livebox.appendChild(el('p', 'meta', '这一段来自会话账本，不等任务收尾；下面的任务/验收只在 sync --put 后更新。'));
  }

  function depsLine(t) {
    if (!t.dependsOn || !t.dependsOn.length) return null;
    var p = el('p', 'deps', '依赖：');
    t.dependsOn.forEach(function (d, i) {
      if (i) p.appendChild(document.createTextNode('、'));
      var a = el('a', null, d); a.href = '#' + d;
      a.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); open(d); });
      p.appendChild(a);
    });
    return p;
  }

  function taskNode(t, mode) {
    var n = el('div', 'task' + (selected === t.id ? ' sel' : ''));
    n.id = t.id; n.tabIndex = 0;
    var row = el('div', 'row'); row.appendChild(pill(t)); row.appendChild(el('b', 'short', t.short)); row.appendChild(el('span', 'id', t.id));
    n.appendChild(row);
    if (mode === 'far') { var tl = tail(t); if (tl) n.appendChild(el('p', 'f', tl)); }
    if (mode === 'mid' || mode === 'near') {
      n.appendChild(el('p', 'title', t.title));
      [['结果', t.result], ['欠项', t.remaining], ['下一步', t.nextAction]].forEach(function (kv) {
        if (kv[1]) {
          var p = el('p', 'f'); p.appendChild(el('span', 'k', kv[0] + '：')); p.appendChild(document.createTextNode(kv[1])); n.appendChild(p);
        }
      });
      if (t.blocker) n.appendChild(el('p', 'f', '受阻：' + t.blocker));
      var acc = t.acceptance.length ? t.acceptance.map(function (a) { return a.id + ' ' + a.result + (a.stale ? '（失效）' : ''); }).join(' · ') : '无验收项';
      n.appendChild(el('p', 'meta', '验收 ' + acc + ' · 证据 ' + t.evidence.length + ' 条'));
    }
    if (mode === 'near') {
      if (t.acceptance.length) {
        var ul = el('ul', 'ev');
        t.acceptance.forEach(function (a) { ul.appendChild(el('li', null, a.id + ' · ' + a.condition + ' · ' + a.result + (a.required === false ? '（非必做）' : '') + (a.stale ? '（证据失效）' : ''))); });
        n.appendChild(ul);
      }
      var evs = (v.events || []).filter(function (e) { return e.taskId === t.id; });
      if (evs.length) {
        var u2 = el('ul', 'ev');
        evs.forEach(function (e) { u2.appendChild(el('li', null, e.type + ' · ' + String(e.at || '').slice(0, 19) + (e.note ? ' · ' + e.note : ''))); });
        n.appendChild(u2);
      }
      var ses = (t.sourceSessions || []);
      if (ses.length) {
        var p2 = el('p', 'meta', '来源会话 ');
        ses.forEach(function (s, i) {
          var a = el('a', null, String(s).slice(0, 8)); a.href = '/s/' + encodeURIComponent(s) + '/?from=' + encodeURIComponent('/p/' + D.key + '/#zoom=' + Math.round(zoom) + '&lv=' + level + (selected ? '&task=' + selected : ''));
          if (i) p2.appendChild(document.createTextNode('、'));
          p2.appendChild(a);
        });
        n.appendChild(p2);
      }
    }
    var dl = depsLine(t); if (dl) n.appendChild(dl);
    n.addEventListener('click', function () { select(t.id); });
    n.addEventListener('dblclick', function () { open(t.id); });
    n.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); open(t.id); } });
    return n;
  }

  /** 依赖图：只画有依赖关系的任务；层=最长前驱路径；边走正交折线并带箭头。 */
  /* 图上只有 4 个节点、任务却有 48 个：不写「其余没声明依赖」，读者会以为图丢了内容。 */
  function gcap(shown) {
    var el = document.getElementById('gcap');
    if (!el) return;
    el.textContent = !shown || shown >= v.tasks.length
      ? ''
      : '　只画声明了依赖的 ' + shown + ' / ' + v.tasks.length + ' 个任务，其余没有依赖关系';
  }

  function drawGraph() {
    var box = document.getElementById('graph');
    var svg = document.getElementById('gv');
    var empty = document.getElementById('gempty');
    var ids = {};
    v.tasks.forEach(function (t) { ids[t.id] = t; });
    var edges = [];
    v.tasks.forEach(function (t) { (t.dependsOn || []).forEach(function (d) { if (ids[d]) edges.push({ from: t.id, to: d }); }); });
    if (!edges.length) { box.hidden = false; svg.setAttribute('height', '10'); svg.textContent = ''; empty.hidden = false; gcap(0); return; }
    empty.hidden = true; box.hidden = false;
    var nodes = {};
    v.tasks.forEach(function (t) { if ((t.dependsOn || []).length) nodes[t.id] = 0; });
    edges.forEach(function (e) { nodes[e.to] = nodes[e.to] || 0; });
    gcap(Object.keys(nodes).length);
    var depth = {};
    function d(id, seen) {
      if (depth[id] != null) return depth[id];
      if (seen[id]) return 0;
      seen[id] = 1;
      var t = ids[id];
      var deps = (t && t.dependsOn || []).filter(function (x) { return ids[x]; });
      var best = 0;
      deps.forEach(function (x) { best = Math.max(best, d(x, seen) + 1); });
      depth[id] = best;
      return best;
    }
    Object.keys(nodes).forEach(function (id) { d(id, {}); });
    var layers = {};
    Object.keys(nodes).forEach(function (id) { (layers[depth[id]] = layers[depth[id]] || []).push(id); });
    var W = 132, H = 34, GX = 26, GY = 46, PAD = 8;
    var maxRow = 0;
    Object.keys(layers).forEach(function (k) { maxRow = Math.max(maxRow, layers[k].length); });
    var width = Math.max(320, maxRow * (W + GX) + PAD * 2);
    var rows = Object.keys(layers).length;
    var height = rows * (H + GY) + PAD * 2;
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('height', String(height));
    svg.textContent = '';
    var defs = document.createElementNS(NS, 'defs');
    var marker = document.createElementNS(NS, 'marker');
    marker.setAttribute('id', 'arrow'); marker.setAttribute('markerWidth', '8'); marker.setAttribute('markerHeight', '8');
    marker.setAttribute('refX', '7'); marker.setAttribute('refY', '4'); marker.setAttribute('orient', 'auto');
    var mp = document.createElementNS(NS, 'path');
    mp.setAttribute('d', 'M0,0 L8,4 L0,8 z'); mp.setAttribute('fill', '#9aa6b5');
    marker.appendChild(mp); defs.appendChild(marker); svg.appendChild(defs);
    var pos = {};
    Object.keys(layers).forEach(function (k) {
      layers[k].forEach(function (id, i) {
        pos[id] = { x: PAD + i * (W + GX), y: PAD + (+k) * (H + GY) };
      });
    });
    edges.forEach(function (e) {
      var a = pos[e.from], b = pos[e.to];
      if (!a || !b) return;
      if (a.y <= b.y) return; // 依赖在前一层；同层或反向的不画线（数据层已拒绝成环）
      var x1 = a.x + W / 2, y1 = a.y, x2 = b.x + W / 2, y2 = b.y + H;
      var mid = (y1 + y2) / 2;
      var p = document.createElementNS(NS, 'path');
      p.setAttribute('class', 'edge' + (selected && e.from !== selected && e.to !== selected ? ' dim' : ''));
      p.setAttribute('marker-end', 'url(#arrow)');
      p.setAttribute('d', 'M' + x1 + ',' + y1 + ' V' + mid + ' H' + x2 + ' V' + y2);
      svg.appendChild(p);
    });
    Object.keys(nodes).forEach(function (id) {
      var t = ids[id], q = pos[id];
      if (!q) return;
      var g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'node' + (selected === id ? ' sel' : ''));
      g.setAttribute('tabindex', '0');
      var r = document.createElementNS(NS, 'rect');
      r.setAttribute('x', q.x); r.setAttribute('y', q.y); r.setAttribute('width', W); r.setAttribute('height', H); r.setAttribute('rx', 5);
      var tx = document.createElementNS(NS, 'text');
      tx.setAttribute('x', q.x + 8); tx.setAttribute('y', q.y + 15);
      tx.textContent = id + ' ' + String(t.short || '').slice(0, 8);
      var tx2 = document.createElementNS(NS, 'text');
      tx2.setAttribute('x', q.x + 8); tx2.setAttribute('y', q.y + 28); tx2.setAttribute('fill', '#7a8494');
      tx2.textContent = LABEL[t.status] || t.status;
      g.appendChild(r); g.appendChild(tx); g.appendChild(tx2);
      g.addEventListener('click', function () { select(id); });
      g.addEventListener('dblclick', function () { open(id); });
      g.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); open(id); } });
      svg.appendChild(g);
    });
  }

  /* 经验与画像：随 data.json 每 5 秒回来。经验按「会话 + 阶段」分组，来自块综述的 lesson；
     画像来自两张记忆表。一条都没有时如实写 0 条与写入口，不编。 */
  function renderInsights() {
    var box = document.getElementById('insights');
    if (!box) return;
    box.textContent = '';
    var I = v.insights || {};
    var ex = I.experience || { groups: [], total: 0, sessions: 0 };
    var pf = I.profile || { project: {}, user: {} };

    var card = el('section', 'icard wide');
    card.appendChild(el('h2', null, '经验 · 按阶段'));
    card.appendChild(el('p', 'isub', '块综述里的 lesson，按会话与阶段收拢（共 ' + (ex.total || 0) + ' 条，读最近 ' + (ex.sessions || 0) + ' 本账）；点会话号回到那张画布'));
    if (!ex.groups || !ex.groups.length) {
      card.appendChild(el('p', 'iempty', '0 条 —— 综述还没写 lesson（agent 用 digest → summarise --put 一次批量补）'));
    } else {
      if (ex.totalGroups && ex.totalGroups > ex.groups.length) card.appendChild(el('p', 'iempty', '共 ' + ex.totalGroups + ' 组经验（' + ex.total + ' 条），这里列最近 ' + ex.groups.length + ' 组'));
      ex.groups.forEach(function (g) {
        var grp = el('div', 'igrp');
        var h = el('div', 'igh');
        var a = document.createElement('a');
        a.href = '/s/' + encodeURIComponent(g.sid) + '/';
        a.textContent = g.sid8;
        a.title = '回到这段会话的画布';
        h.appendChild(a);
        h.appendChild(document.createTextNode(g.label));
        h.appendChild(el('span', 'icount', g.items.length + ' 条'));
        grp.appendChild(h);
        (g.items || []).forEach(function (it) {
          var li = el('div', 'ilit');
          li.appendChild(el('span', 'inum', '第 ' + (it.step == null ? '—' : it.step) + ' 步 · 块 ' + it.block));
          li.appendChild(document.createTextNode(it.lesson));
          if (it.need) li.appendChild(el('span', 'ineed', '当时的要求：' + it.need));
          grp.appendChild(li);
        });
        card.appendChild(grp);
      });
    }
    box.appendChild(card);

    var pc = el('section', 'icard');
    pc.appendChild(el('h2', null, '用户画像 · 做事方式'));
    // 归纳时机：判据是「自上次归纳以来新增了多少」，不是日历。没攒够就不显示，
    // 所以这一行不会常驻成噪音；攒够了它才出现，替掉「什么时候该归纳」这个要人记的事。
    var md = I.memory || null;
    if (md && ((md.project && md.project.due) || (md.user && md.user.due))) {
      var tips = [];
      if (md.project && md.project.due) tips.push('项目记忆该归纳了：自上次新增 ' + md.project.lessons + ' 条经验、' + md.project.sessions + ' 个会话');
      if (md.user && md.user.due) tips.push('用户画像该更新了：自上次新增 ' + md.user.sessions + ' 个会话');
      var tip = el('p', 'isub', '⚠ ' + tips.join('；') + '（看增量不看日历；取材 memory --digest，过闸门才落盘）');
      tip.style.color = '#8a5a00';
      pc.appendChild(tip);
    }
    pc.appendChild(el('p', 'isub', '用户画像只有一份、所有项目共用（跨项目证据）；标「项目经验 / 项目规则」的才是本项目自己的。每条带来源，可回读'));
    var dims = ['目标', '边界', '规则', '偏好', '背景', '验收', '分工', '反馈', '性格'];
    var rows = [];
    if (!(pf.user && pf.user['画像'] && pf.user['画像'].length)) pc.appendChild(el('p', 'iempty', '用户画像 0 条 —— 还没写：memory --put --scope user（跨会话的证据，不自动编）'));
    (pf.user && pf.user['画像'] || []).forEach(function (e) { rows.push(['画像', e]); });
    (pf.user && pf.user['规则'] || []).forEach(function (e) { rows.push(['通用规则', e]); });
    (pf.project && pf.project['经验'] || []).forEach(function (e) { rows.push(['项目经验', e]); });
    (pf.project && pf.project['规则'] || []).forEach(function (e) { rows.push(['项目规则', e]); });
    if (rows.length) {
      var cover = dims.map(function (d) {
        var n = rows.filter(function (r) { return r[1].dimension === d; }).length;
        return d + (n ? ' ' + n : ' ·');
      }).join(' ');
      pc.appendChild(el('p', 'isub', '维度覆盖：' + cover + '（没写到的维度是证据还不够，不硬编）'));
    }
    if (!rows.length) {
      pc.appendChild(el('p', 'iempty', '0 条 —— 还没写。画像：memory --put --scope user；项目经验/规则：memory --put；都要跨会话证据，不自动编。'));
    } else {
      rows.slice(0, 30).forEach(function (r) {
        var d = el('div', 'imem');
        d.appendChild(el('span', 'icl', r[0] + (r[1].id ? ' ' + r[1].id : '') + (r[1].dimension ? ' · ' + r[1].dimension : '')));
        d.appendChild(document.createTextNode(r[1].text));
        if (r[1].evidence && r[1].evidence.length) {
          var src = r[1].evidence.map(function (ev) {
            return (ev.project || '').replace(/^p-/, '').slice(0, 6) + ':' + (ev.sid || '') + ':' + (ev.seg || '');
          });
          d.appendChild(el('span', 'isrc', '来源 ' + src.join(' · ')));
        }
        pc.appendChild(d);
      });
      if (rows.length > 30) pc.appendChild(el('p', 'iempty', '共 ' + rows.length + ' 条，这里列前 30 条'));
    }
    pc.appendChild(el('p', 'isub', '导出：convledger export（PROGRESS.md / USER-PROFILE.md / sessions/ 会话笔记）'));
    box.appendChild(pc);
  }

  function render() {
    renderLive();
    renderInsights();
    zr.value = String(Math.round(zoom)); zpct.textContent = Math.round(zoom) + '%';
    Array.prototype.forEach.call(document.querySelectorAll('.zoom button'), function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-lv') === level ? 'true' : 'false');
    });
    var c = v.counts.project;
    counts.textContent = '';
    [['已完成', c.done + ' / 纳入范围 ' + c.inScope], ['进行中', c.active], ['未开始', c.planned], ['待验证', c.awaiting], ['受阻', c.blocked], ['未知', c.unknown],
      // 图上明明有「已取消」的节点，计数行却不认——两边对不上数的时候，读者先怀疑图。
      ...(c.cancelled ? [['已取消', c.cancelled]] : []), ['待整理材料', v.counts.unorganized]].forEach(function (kv) {
      var s = el('span'); s.appendChild(document.createTextNode(kv[0] + ' ')); s.appendChild(el('b', null, kv[1])); counts.appendChild(s);
    });
    stage.textContent = '';
    if (!v.tasks.length) { stage.appendChild(el('p', 'empty', '这个项目还没有整理成任务。会话证据仍在会话库里。')); drawGraph(); return; }

    if (level === 'overview') {
      var byId = function (id) { return v.tasks.find(function (t) { return t.id === id; }) || {}; };
      var openT = v.tasks.filter(function (t) { return ['active', 'blocked', 'awaiting-verification', 'unknown'].indexOf(t.status) >= 0; });
      var act = openT.filter(function (t) { return t.nextAction; })[0];
      var msLabel = function (m) { var meta = v.milestones.find(function (x) { return x.id === m.id; }) || {}; return m.id + ' ' + (meta.short || '') + '（' + m.done + '/' + m.inScope + '）' + (meta.goal ? '：' + meta.goal : ''); };
      var curMs = v.counts.milestones.filter(function (m) { return m.active || m.blocked || m.awaiting; });
      // 主阶段＝下一行动所在的里程碑；其余并行里程碑另起一行，免得读者以为只有一个。
      var primary = act ? curMs.find(function (m) { return m.id === byId(act.id).milestoneId; }) : curMs[0];
      var others = curMs.filter(function (m) { return !primary || m.id !== primary.id; });
      var head = el('div', 'next');
      head.appendChild(el('h2', null, '当前阶段'));
      head.appendChild(el('p', 'meta', 'PM = 阶段目标（一组任务）；PT = 可验收的工作单元。下面先给阶段，再给下一行动。'));
      head.appendChild(el('p', 'f', primary ? '主阶段：阶段 ' + msLabel(primary) : '没有进行中的里程碑'));
      if (others.length) head.appendChild(el('p', 'f', '并行：' + others.map(function (m) { return '阶段 ' + msLabel(m); }).join('；')));
      if (act) {
        var p0 = el('p', 'f');
        p0.appendChild(el('span', 'k', '下一行动：'));
        p0.appendChild(document.createTextNode('任务 ' + act.id + ' ' + act.short + ' —— ' + act.nextAction));
        head.appendChild(p0);
      }
      stage.appendChild(head);

      var next = el('div', 'next'); next.appendChild(el('h2', null, '当前未决工作'));
      var ul = el('ul');
      if (!openT.length) ul.appendChild(el('li', null, '没有进行中/受阻/待验证的任务'));
      openT.forEach(function (t) {
        var li = el('li');
        li.appendChild(document.createTextNode('任务 ' + t.id + ' · ' + t.short + ' · ' + (LABEL[t.status] || t.status)));
        li.appendChild(el('div', 'k', '目标：' + t.title));
        if (t.remaining) li.appendChild(el('div', 'k', '还欠：' + t.remaining));
        if (t.nextAction) li.appendChild(el('div', 'k', '下一步：' + t.nextAction));
        ul.appendChild(li);
      });
      next.appendChild(ul); stage.appendChild(next);
      v.counts.milestones.forEach(function (m) {
        var meta = v.milestones.find(function (x) { return x.id === m.id; }) || {};
        var box = el('section', 'ms');
        box.appendChild(el('h2', null, '阶段 ' + m.id + ' ' + (meta.short || '')));
        if (meta.goal) box.appendChild(el('p', 'f', meta.goal));
        box.appendChild(el('p', 'mcount', '完成 ' + m.done + ' / 纳入范围 ' + m.inScope + (m.active ? ' · 进行中 ' + m.active : '') + (m.blocked ? ' · 受阻 ' + m.blocked : '') + (m.awaiting ? ' · 待验证 ' + m.awaiting : '')));
        stage.appendChild(box);
      });
      focusPending();
      drawGraph();
      return;
    }

    v.counts.milestones.forEach(function (m) {
      var meta = v.milestones.find(function (x) { return x.id === m.id; }) || {};
      var box = el('section', 'ms');
      box.appendChild(el('h2', null, m.id + ' ' + (meta.short || '')));
      box.appendChild(el('p', 'mcount', '完成 ' + m.done + ' / 纳入范围 ' + m.inScope));
      tasksOf(m.id).forEach(function (t) { box.appendChild(taskNode(t, level)); });
      stage.appendChild(box);
    });
    drawGraph();
    if (selected && level === 'near') { var hit = document.getElementById(selected); if (hit) hit.scrollIntoView({ block: 'center' }); }
    focusPending();
  }

  Array.prototype.forEach.call(document.querySelectorAll('.zoom button'), function (b) {
    b.addEventListener('click', function () { zoom = +b.getAttribute('data-z'); level = b.getAttribute('data-lv'); hash(); render(); });
  });
  zr.addEventListener('input', function () { setZoom(+zr.value); });
  document.addEventListener('wheel', function (e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    setZoom(zoom + (e.deltaY < 0 ? 4 : -4));
  }, { passive: false });
  document.addEventListener('keydown', function (e) {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    var map = { '1': [10, 'overview'], '2': [35, 'far'], '3': [60, 'mid'], '4': [85, 'near'] };
    if (map[e.key]) { zoom = map[e.key][0]; level = map[e.key][1]; hash(); render(); }
  });
  document.getElementById('pname').textContent = D.name || D.key;
  var prevEl = document.getElementById('prev');
  prevEl.textContent = '任务模型 r' + v.revision + ' · 收尾后更新';
  prevEl.title = '任务/验收只在 sync --put 后更新；上面的会话实时每 5 秒更新';
  render();

  /* 项目页不是快照：每 5 秒读一次 data.json；revision 或会话实时位变了才重画
     （档位与选中都保留）。任务模型要 sync 后才会变，但账本步数不用等收尾。 */
  function liveSig(x) {
    var l = x && x.live;
    var i = x && x.insights;
    var ins = i ? [i.experience && i.experience.sig, i.profile && i.profile.sig].join('/') : '';
    if (!l || !l.session) return ins;
    return [l.session.id, l.session.live ? 1 : 0, l.session.idleMin, l.step && l.step.n, l.step && l.step.block, l.pendingBytes, ins].join(':');
  }
  setInterval(function () {
    fetch('/p/' + encodeURIComponent(D.key) + '/data.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (next) {
        if (!next || (next.revision === v.revision && liveSig(next) === liveSig(v))) return;
        v = next; D.view = next;
        document.getElementById('prev').textContent = '任务模型 r' + v.revision + ' · 收尾后更新';
        render();
      })
      .catch(function () { /* 离线就等下一轮 */ });
  }, 5000);
})();
</script></body></html>`;
}

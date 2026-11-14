/* convledger atlas — 会话流程图
   一张只能平移缩放的流程图：主线第 1–N 步从左到右排、行末折返；插曲块单独一条道，
   落在宿主步那一行的正下方，从宿主岔出、在汇回步汇入。连线画在卡上层，只走行间与
   列间，端点钉在卡片边框上并带箭头；点一块＝推近并出右侧详情，卡本身不动、邻居不变暗。
   右侧 inspector 只放可由账本复算的事实，正文仍然靠 `convledger body Sxx` 回源读。
   所有来自日志的文字只走 textContent / createTextNode；SVG 里只写数字。 */
(function () {
  'use strict';

  /* hub 把每段会话放在 /s/<id>/ 下：data.json / body / note / request 都挂在这个前缀上；
     会话清单仍是根路径（同一个库）。旧单会话地址（前缀为空）也照常工作。 */
  var BASE = (location.pathname.match(/^\/s\/[^/]+/) || [''])[0];

  var CW = 300;
  /* 列距与行距：行距＝近景盒高＋GAP_Y（槽高固定，换档只让卡矮下去，不动行位）。
     插曲道就插在宿主行下面，所以 GAP_Y 同时是"岔出线拐弯"和"汇回线拐弯"的槽。 */
  var GAP_X = 46, GAP_Y = 46, PAD = 56, RGUT = 26;
  /* 四档＝四套描述，不是同一张卡放大缩小：盒子按档换高度，字按档变大、文字按档变短。
     这四个数必须和 atlas.css 的 --ch-* 一模一样：这里是行距的依据，那里是卡片的实际高度。
     字号走世界坐标（跟 scale 一起缩），可读性靠"换更短的一层"保证。 */
  var CH_T = { glyph: 96, far: 122, mid: 248, near: 268 };
  var ROW_H = CH_T.near + GAP_Y;
  /* 带高：主线行上方坐两条带——上面一条章带、下面一条阶段带，各是一张牌加一条括号。
     BAND_H=56 是阶段带沿用下来的实测值（印章档字号 32 ⇒ 牌高最坏约 38，再加括号与臂）；
     章带与它同构，所以同高。插曲道不占带。
     PH_T 是四档标签字号，必须和 atlas.css 的 --pf-* 逐字节相等（selftest 钉）。 */
  var BAND_H = 56, CHAP_H = 56, PH_H = BAND_H + CHAP_H;
  var PH_T = { glyph: 32, far: 26, mid: 24, near: 20 };
  /* 常驻 HUD 占掉的屏幕：上面一行状态、底下续做框＋图例＋小地图（最高的是 142px 的小地图）。
     "适应"把这块从可用视口里扣掉，块就不会长在面板底下。 */
  var HUD = { top: 44, left: 22, right: 22, bottom: 150 };
  var TIERS = ['glyph', 'far', 'mid', 'near'];
  /* [升档阈值, 降档阈值]：带滞回（沿用原型乙的回退思路）——否则在临界上一寸寸滚，
     卡面文字逐帧换层会抖成一片。 */
  var TH = { near: [0.80, 0.74], mid: [0.45, 0.42], far: [0.35, 0.32] };
  var MINZ = 0.12, MAXZ = 2.6;
  var LV = ['未证', '已想清', '已落地', '已复核'];
  var LVHEX = {
    dark: ['#7b8496', '#7aa7ff', '#4fd1b6', '#e7c46a'],
    light: ['#8d97a8', '#2f6feb', '#0f9e83', '#a9740c']
  };
  var BASIS = { verified: '已证', reconstructed: '站位', unknown: '未证' };

  function $(id) { return document.getElementById(id); }
  var stage = $('stage'), world = $('world'), cards = $('cards'), wires = $('wires'), bands = $('bands');
  var insp = $('insp'), inspbody = $('inspbody'), mm = $('mm'), mmvp = $('mmvp');
  var find = $('find'), findn = $('findn'), meters = $('meters'), rowhint = $('rowhint'), chapnote = $('chapnote'), hits = $('hits');
  var liveEl = $('live'), minimapEl = $('minimap'), whoEl = $('who');
  var libEl = $('lib'), libBtn = $('libbtn'), libFind = $('libfind'), libBody = $('libbody');
  var libN = $('libn'), libFoot = $('libfoot'), libSplit = $('libsplit');

  var S = {
    v: null, parts: [], idx: {}, tasks: {}, rank: {},
    phases: [], bands: [], chapters: [], chapFocus: null, mainRow: {},
    cam: { x: 0, y: 0, z: 1 }, tgt: { x: 0, y: 0, z: 1 },
    tier: 'near', sig: '', sel: null,
    q: '', hits: [], hitI: -1, mm: null, mmDirty: true, before: null,
    pan: null, glide: null, pending: null,
    cols: 7, plan: null, rowY: [], leftX: 0, rightX: 0, flowW: 0,
    /* 左栏：mode 只有 full / rail 两种——rail 是「拖到最窄」的吸附态，不是隐藏。
       宽度和模式都记在 localStorage，刷新后保持。 */
    lib: { v: null, q: '', drawn: '', mode: 'full', w: 264, drag: null, timer: 0 }
  };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function fmt(n) {
    n = n || 0;
    if (n >= 10000) return Math.round(n / 1000) + 'k';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }
  function viewW() { return stage.clientWidth - (insp.hidden ? 0 : 360); }
  function nodeById(id) { var i = S.idx[id]; return i === undefined ? null : S.v.nodes[i]; }
  function partBySeg(id) {
    var i = S.idx[id];
    if (i === undefined) return null;
    for (var k = 0; k < S.parts.length; k++) {
      if (i >= S.parts[k].i0 && i <= S.parts[k].i1) return S.parts[k];
    }
    return null;
  }
  /* 印章的词：move 是账本里的枚举（src/claims.mjs），页面上得说人话。
     rule 是第六类，单独成格——它和 ruleout（排除）只差四个字母，子串匹配会串。 */
  var MOVE_CN = { insight: '✦ 洞察', ruleout: '✕ 排除', decision: '⚖ 决策', pivot: '↩ 转向', open: '? 留问', rule: '§ 规则' };
  function moveText(m) {
    return String(m || '').split(/\s+/).filter(Boolean).map(function (x) { return MOVE_CN[x] || x; }).join(' · ');
  }
  function notesOf(p) {
    var seen = {}, out = [];
    for (var i = p.i0; i <= p.i1; i++) {
      var n = S.v.nodes[i];
      (S.v.notes || []).forEach(function (x) {
        if (seen[x.id]) return;
        if (x.seg === n.id || x.after === n.id) { seen[x.id] = 1; out.push(x); }
      });
    }
    return out;
  }
  function notesAt(id) {
    return (S.v.notes || []).filter(function (x) { return x.seg === id || x.after === id; });
  }

  /* ---------- data ---------- */
  /* 块＝账本算好的 `v.steps`（一块＝一个压缩区间）。页面不再自己推一遍：
     流程图上的"第几步"和 `convledger steps` 打印的必须是同一份数，两处各推一次就会漂
     （这个项目已经为这种漂付过一次学费）。这里只补画布要的渲染态（row/col/el）。 */
  function partsOf(v) {
    return (v.steps || []).map(function (s) {
      return {
        i: s.i, step: s.step, role: s.role, from: s.from, to: s.to, i0: s.i0, i1: s.i1,
        n: s.nodes, segs: s.segs, t0: s.t0, t1: s.t1, h0: s.h0, h1: s.h1, carry: s.carry,
        sent: s.sent, carrySent: s.carrySent, span: s.span, read: s.read,
        taskIds: s.branchIds, tasks: s.tasks, heads: s.heads,
        side: s.side, main: s.main, inside: s.inside, errs: s.errs, open: s.open,
        verified: s.verified, wrote: s.wrote, fan: s.fan, compacts: s.compacts,
        level: s.level, title: s.title, solved: s.solved, solvedFrom: s.solvedFrom,
        mark: s.mark, gist: s.gist, gistFrom: s.gistFrom, gistDerived: !!s.gistDerived,
        gistIsAsk: !!s.gistIsAsk,
        decisions: s.decisions || 0, ruledOut: s.ruledOut || 0, rules: s.rules || [],
        made: s.made, outs: s.outs, files: s.files || [], lines: s.lines, segIds: s.segIds,
        say: s.say, sayFrom: s.sayFrom,
        // 模型写的五格综述（basis=model，非已证）。没有就是没有：页面回落成原话截段并明说。
        sum: s.sum || null, sumFrom: s.sumFrom || '', pending: !!s.pending,
        fork: s.fork, back: s.back, dominant: s.dominant,
        afterStep: s.afterStep ?? null, beforeStep: s.beforeStep ?? null, bridge: s.bridge || null,
        phase: s.phase ?? null,
        chapter: s.chapter ?? null,
        row: 0, col: 0, el: null
      };
    });
  }

  function sigOf(v) {
    var last = v.nodes[v.nodes.length - 1] || {};
    // notes 必须进签名：改的是外挂表，账本的段数一格不变；不把条数算进来，
    // 写完一条人写的标注，页面要等下一次账本重建才看得见（甚至看不见）。
    // 阶段同理：行数不变但短名/六格改了，签名不动页面就会一直读旧的那份。
    var ph = (v.phases || []).map(function (p) {
      return [p.n, p.from + '-' + p.to, p.short, p.doing, p.state, p.effect, p.plan, p.track,
        (p.refs || []).length, (p.rules || []).length].join(':');
    }).join(',');
    // 章同理：九格改了块数与段数都不变，不进签名页面就一直读旧的那一份。
    var ch = (v.chapters || []).map(function (c) {
      return [c.n, c.from + '-' + c.to, c.short, c.goal, c.where, c.rules, c.tasks, c.walls,
        c.cautions, c.arch, c.handoff].join(':');
    }).join(',');
    return [v.meta.segs, v.nodes.length, v.meta.verified, v.meta.boundaries, last.id,
      (v.steps || []).length, v.brief && v.brief.now ? v.brief.now.id : '', (v.notes || []).length,
      v.meta.summaries ? v.meta.summaries.blocks + ',' + v.meta.summaries.tasks : '', ph, ch,
      v.tail ? v.tail.from + '-' + v.tail.to : ''].join('|');
  }

  /* ---------- layout ---------- */
  /* 流程图几何只有三件事：主线按 cols 列从左到右铺、行末折返；插曲段落在宿主步那一行
     的正下方（单独一条道，占一行）；所有行距固定 ROW_H，缩放与换档都不许重排。
     planFor(cols) 是唯一算位置的地方——chooseCols 也调它来试列数，两边不会各算一套。 */
  function planFor(cols) {
    var main = S.parts.filter(function (p) { return p.step != null; });
    var rowOfStep = {}, colOfStep = {};
    main.forEach(function (p, k) {
      rowOfStep[p.step] = Math.floor(k / cols);
      colOfStep[p.step] = k % cols;
    });
    var maxRow = main.length ? rowOfStep[main[main.length - 1].step] : 0;
    // 插曲段＝连续的无步号块。一段落在它宿主步那一行下面；整段放不下就再开一条道。
    var lanes = {};        // hostRow -> [ [block|null,...], ... ]
    var run = [];
    function flush() {
      if (!run.length) return;
      var host = run[0].afterStep;
      var hostRow = host != null && rowOfStep[host] != null ? rowOfStep[host] : 0;
      var col = host != null && colOfStep[host] != null ? colOfStep[host] : 0;
      var sub = 0;
      var rows = lanes[hostRow] || (lanes[hostRow] = []);
      run.forEach(function (p) {
        if (!rows[sub]) rows[sub] = [];
        var row = rows[sub];
        while (col >= cols || row[col]) {
          if (col < cols) { col++; continue; }
          sub++; col = 0;
          if (!rows[sub]) rows[sub] = [];
          row = rows[sub];
        }
        row[col] = p;
        col++;
      });
      run = [];
    }
    S.parts.forEach(function (p) {
      if (p.step == null) { run.push(p); return; }
      flush();
    });
    flush();

    var pos = {}, rowY = [], maxCol = 0;
    var y = PAD;
    for (var r = 0; r <= maxRow; r++) {
      // 主线行上方让出阶段带；插曲道不占（它的上一行就是宿主行）。
      y += PH_H;
      rowY.push(y);
      main.forEach(function (p) {
        if (rowOfStep[p.step] !== r) return;
        pos[p.from] = { row: rowY.length - 1, col: colOfStep[p.step] };
        maxCol = Math.max(maxCol, colOfStep[p.step]);
      });
      y += ROW_H;
      (lanes[r] || []).forEach(function (row) {
        rowY.push(y);
        row.forEach(function (p, c) {
          if (!p) return;
          pos[p.from] = { row: rowY.length - 1, col: c };
          maxCol = Math.max(maxCol, c);
        });
        y += ROW_H;
      });
    }
    // 兜底：宿主是最后一步时上面已经画到；万一有块排不进去（数据异常），塞到最后一行
    S.parts.forEach(function (p) {
      if (pos[p.from]) return;
      rowY.push(y);
      pos[p.from] = { row: rowY.length - 1, col: 0 };
      y += ROW_H;
    });
    var w = PAD * 2 + (maxCol + 1) * CW + maxCol * GAP_X;
    var h = rowY[rowY.length - 1] + CH_T.near + PAD;
    return { pos: pos, rowY: rowY, rowOfStep: rowOfStep, cols: cols, maxCol: maxCol, w: w, h: h };
  }

  /* 列数从 2 到 10 逐个试，取"适应"缩放比最大的那个：块多时多列能少一行，字就大一号。 */
  function chooseCols(n) {
    n = Math.max(1, n);
    var availW = Math.max(320, stage.clientWidth - HUD.left - HUD.right);
    var availH = Math.max(240, stage.clientHeight - HUD.top - HUD.bottom);
    var best = 2, bestZ = -1;
    for (var c = 2; c <= Math.min(10, Math.max(2, n)); c++) {
      var pl = planFor(c);
      var z = Math.min(availW / pl.w, availH / pl.h);
      if (z > bestZ + 1e-6) { bestZ = z; best = c; }
    }
    return best;
  }

  function layoutParts() {
    var pl = planFor(S.cols);
    S.plan = pl;
    S.rowY = pl.rowY;
    S.flowW = (pl.maxCol + 1) * CW + pl.maxCol * GAP_X;
    S.leftX = PAD - RGUT;
    S.rightX = PAD + S.flowW + RGUT;
    S.parts.forEach(function (p) {
      var at = pl.pos[p.from];
      p.row = at.row;
      p.col = at.col;
      p.hx = PAD + at.col * (CW + GAP_X);
      p.hy = S.rowY[at.row];
      if (p.el) {
        p.el.style.left = p.hx + 'px';
        p.el.style.top = p.hy + 'px';
      }
    });
    /* 哪些 rowY 是主线行：按卡片的实际行号算，不能用 rowOfStep 的序号——
       序号不含插曲道，插曲道会被错认成主线行、白白让出一条阶段带。 */
    S.mainRow = {};
    S.parts.forEach(function (p) { if (p.step != null) S.mainRow[p.row] = 1; });
    S.bands = bandSegs();
    buildBands();
  }
  function relayout() {
    if (!S.parts.length) return;
    layoutParts();
    drawWires();
    S.mmDirty = true;
    drawMM();
  }

  function hueOf(p) {
    var n = S.parts.length;
    var f = n > 1 ? (p.i - 1) / (n - 1) : 0;
    return 210 - 172 * clamp(f, 0, 1);
  }

  /* ---------- cards ---------- */
  function buildCards() {
    cards.textContent = '';
    S.groupEl = null;
    var last = S.parts[S.parts.length - 1];
    S.parts.forEach(function (p) {
      var card = el('div', 'p lv' + p.level + ' r' + roleCls(p) + (last && p === last ? ' now' : '') + (p.open ? ' todo' : '') + (p.errs ? ' warn' : '') + (p.pending ? ' pending' : ''));
      card.dataset.from = p.from;
      card.dataset.i = p.i;
      card.dataset.kind = p.step == null ? 'interlude' : 'main';
      card.dataset.step = p.step == null ? '' : p.step;
      card.dataset.after = p.afterStep == null ? '' : p.afterStep;
      card.dataset.before = p.beforeStep == null ? '' : p.beforeStep;
      card.style.left = p.hx + 'px';
      card.style.top = p.hy + 'px';

      var bar = el('i', 'ptime');
      var h = hueOf(p);
      bar.style.background = 'linear-gradient(90deg, hsl(' + h.toFixed(0) + ' 72% 62%), hsl(' + (h + 16).toFixed(0) + ' 78% 58%))';
      card.appendChild(bar);

      var pin = el('div', 'pin');
      pin.appendChild(buildFar(p));
      pin.appendChild(buildMid(p));
      pin.appendChild(buildNear(p));
      card.appendChild(pin);

      cards.appendChild(card);
      p.el = card;
      bindCard(p, card);
    });
    drawWires();
    S.mmDirty = true;
    drawMM();
    markSel();
  }

  /* ---------- 阶段卡（远景/中景聚合，PRD-blocks-live §2.3） ----------
     底层块一格不动：远景/中景把同一阶段的块盖成一张阶段卡，近景还原成原块。
     阶段卡只说账本能复算的数（步区间、块数、写出件数），不替模型写说明。 */
  function buildGroups() {
    // 中景不再把块聚合成阶段卡：阶段信息由上方括号牌承担，块保持原样。
    // 这里只清空旧的聚合层，不再添加 grouped 类。
    if (!S.groupEl) { S.groupEl = el('div', 'pgroups'); cards.appendChild(S.groupEl); }
    S.groupEl.textContent = '';
    S.groups = [];
    S.parts.forEach(function (p) { if (p.el) p.el.classList.remove('grouped'); });
  }

  /* 远景：只留"第几步 + 这块的题"。插曲块没有步号，牌子上写"插 · 夹 27↔28 步"——
     它是什么、夹在哪两步之间，不用点开就看得见（上一版只有一个破折号，读者只能问"这是什么"）。 */
  function buildFar(p) {
    var g = el('div', 'tf');
    var badge = el('div', 'fstep');
    badge.appendChild(el('b', '', p.step == null ? '插' : p.step));
    badge.appendChild(el('i', '', p.step == null ? (betweenShort(p) || '曲块') : '步'));
    g.appendChild(badge);
    // 远景先给标题（有综述就是综述，没有就是派生的状态），不拿用户原话的截段当卡面。
    g.appendChild(el('div', 'fwhat', p.gist || p.mark || (p.compacts ? '压缩' : '—')));
    return g;
  }

  /* 一段阶段都没写过时，从第 1 步起都是"还没划阶段"，不叫尾段——尾段是已有阶段之后的那截。 */
  function tailName() { return S.tail && S.tail.whole ? '未划阶段' : '尾段'; }

  /* 中景：第几步、属于哪一块、要干什么（真人原话）、解决了什么（已证增量或产物）。 */
  function buildMid(p) {
    var g = el('div', 'tm');
    var row = el('div', 'mrow');
    row.appendChild(el('span', 'mstep', p.step == null ? '插曲' : '第 ' + p.step + ' 步'));
    row.appendChild(el('span', 'mblk', '块 ' + p.i + ' · ' + p.span));
    row.appendChild(el('span', 'msent', p.sent || p.carrySent));
    g.appendChild(row);
    if (p.step == null) g.appendChild(el('div', 'mvia', betweenText(p)));
    var ask = el('div', 'mtitle', p.gist || (p.compacts ? '这里发生了一次自动压缩' : '（这块内一句人话都没有）'));
    g.appendChild(ask);
    // 出处单独占一行，不挤在标题行里：标题那两行是 22 格的满预算（见 cost.mjs 的 BLOCK_GIST_W），
    //  inline 进去就要从摘要里吃掉几个字——摘要少字比出处少一行贵。
    if (p.gistFrom) g.appendChild(el('div', 'msrc', '摘要取自 ' + p.gistFrom + ' 的真人原话'));
    else if (p.sum) g.appendChild(el('div', 'msrc', '模型综述 · 依据 ' + p.sumFrom));
    // 没写综述的块：标题显示原文截断，但「待补综述」这个标注要留着（用户口径：描述还是得有）。
    else if (p.pending) g.appendChild(el('div', 'msrc pend', '待补综述 · 标题显示原文截断，收尾时 agent 写完自动替换'));
    else if (p.gistDerived) g.appendChild(el('div', 'msrc', '无模型综述 · 标题按产物与结构生成'));
    g.appendChild(el('div', 'msolved', p.sum ? p.sum.done : p.solved));
    var meta = el('div', 'mmeta');
    if (p.phase != null) meta.appendChild(el('span', 'chip pphase', '阶段 ' + p.phase));
    else if (p.isTail) meta.appendChild(el('span', 'chip pphase isTail', tailName()));
    meta.appendChild(el('span', 'lvpill lv' + p.level, LV[p.level]));
    meta.appendChild(el('span', 'chip', p.segs + ' 段 · ' + p.tasks + ' 支'));
    meta.appendChild(el('span', 'chip ' + (p.verified ? 'vf' : 'vf0'), p.verified ? '已证 ' + p.verified : '无已证'));
    // 中景卡底只放 PRD §三 定的那三个数：等级 · 段数·支数 · 已证/无已证。
    // ⚠ / 留问 / 岔出汇回是近景全明细的东西——插曲块还多一行 between，六个 chip 换到
    // 第二行，卡底就多 22px 被 overflow:hidden 静默吃掉（S173 实测）。这些事实挂 title，
    // 悬停能看，近景那一档照样全印。
    var extra = [];
    if (p.errs) extra.push('⚠ ' + p.errs);
    if (p.open) extra.push('? ' + p.open);
    var rel = roleText(p);
    if (rel) extra.push(rel);
    if (extra.length) g.title = extra.join(' · ');
    g.appendChild(meta);
    return g;
  }
  /* 近景：原来的全明细（逐条已证增量、回合、锚点入口）都在这档。 */
  function buildNear(p) {
    var g = el('div', 'tn');
    var row = el('div', 'prow');
    row.appendChild(el('span', 'pnum', p.step == null ? '插曲' : '步 ' + pad2(p.i)));
    row.appendChild(el('span', 'pseg', p.span));
    row.appendChild(el('span', 'prng', p.step == null ? betweenShort(p) : (p.sent || p.carrySent)));
    row.appendChild(el('span', 'pturn', 't' + p.t0 + '–' + p.t1));
    if (p.compacts) row.appendChild(el('span', 'pcomp', '⟲' + p.compacts));
    g.appendChild(row);

    g.appendChild(el('div', 'ptitle', p.gist || p.mark || (p.compacts ? '这里发生了一次自动压缩' : '（这一块没有标题）')));
    g.appendChild(el('div', 'psolved', p.solved + (p.solvedFrom && p.solvedFrom !== 'outs' ? '（' + p.solvedFrom + ' 已证）' : '')));

    var meta = el('div', 'pmeta');
    if (p.phase != null) meta.appendChild(el('span', 'chip pphase', '阶段 ' + p.phase));
    else if (p.isTail) meta.appendChild(el('span', 'chip pphase isTail', tailName() + ' · 阶段说明待写'));
    var lvp = el('span', 'lvpill lv' + p.level, LV[p.level]);
    lvp.title = '这一块的完成度取块内最低的一条支：' + p.tasks + ' 支里最低的是「' + LV[p.level] + '」（规则：未证 < 已想清 < 已落地 < 已复核）';
    meta.appendChild(lvp);
    meta.appendChild(el('span', 'chip', p.segs + ' 段'));
    meta.appendChild(el('span', 'chip', p.tasks + ' 支' + (p.heads ? ' · 起 ' + p.heads + ' 头' : '')));
    meta.appendChild(el('span', 'chip ' + (p.verified ? 'vf' : 'vf0'), p.verified ? '已证 ' + p.verified + '/' + p.segs : '无已证'));
    if (p.pending) meta.appendChild(el('span', 'chip pend', '待补综述'));
    // 计数行里的决策/排除/规则：每个数都是块内已证增量按 move 数的，不是估的
    if (p.decisions) meta.appendChild(el('span', 'chip', '⚖ ' + p.decisions));
    if (p.ruledOut) meta.appendChild(el('span', 'chip', '✕ ' + p.ruledOut));
    if (p.rules.length) meta.appendChild(el('span', 'chip rule', '§ ' + p.rules.length));
    if (p.errs) meta.appendChild(el('span', 'chip bad', '⚠ ' + p.errs));
    if (p.open) meta.appendChild(el('span', 'chip q', '? ' + p.open));
    if (p.compacts) meta.appendChild(el('span', 'chip', '⟲ ' + p.compacts));
    var link = roleText(p);
    if (link) meta.appendChild(el('span', 'chip link', link));
    g.appendChild(meta);

    var claims = el('div', 'claims');
    if (p.lines.length) {
      p.lines.forEach(function (l) {
        var c = el('div', 'claim');
        c.appendChild(el('b', 'csid', l.id));
        c.appendChild(el('span', 'ctext', l.text));
        claims.appendChild(c);
      });
    } else {
      claims.appendChild(el('div', 'pnone', '这一块没有已证增量：上面标题与「回」行是原话摘录，不是判据结论；要结论，先补块综述。'));
    }
    g.appendChild(claims);

    // B1：卡底动作行。三个动作各自能落地：看摘要（右栏，四行 + 查看原文）、
    // 加人写的节点、建人写的分支。正文入口在右栏，卡上不再有摊开的对话框。
    var foot = el('div', 'pfoot');
    foot.appendChild(footBtn('摘要 ⤢', '推近这一块并在右栏看它做了什么', function (e) { e.stopPropagation(); dive(p); }));
    foot.appendChild(footBtn('＋节点', '在这一块后面加一个人写的节点（未证）', function (e) { e.stopPropagation(); openNoteDlg('node', p); }));
    foot.appendChild(footBtn('⑑分支', '从这一块创建一个分支（人写的，未证）', function (e) { e.stopPropagation(); openNoteDlg('branch', p); }));
    var info = el('button', 'pinfo', '详情 ⓘ');
    info.type = 'button';
    info.title = '在右侧看这一块的摘要（不推近镜头）';
    info.addEventListener('click', function (e) {
      e.stopPropagation();
      showPart(p);
    });
    foot.appendChild(info);
    g.appendChild(foot);
    return g;
  }
  function footBtn(label, title, onClick) {
    var b = el('button', 'pinfo fbtn', label);
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  function roleCls(p) {
    return p.segs === 0 ? 'comp' : p.main === 0 ? 'side' : p.side ? 'both' : 'main';
  }
  /* 插曲块没有步号，但它夹在哪两步之间是账本数出来的（stepsOf 的 afterStep/beforeStep）。
     这一行就是"那两个没编号的块是什么"的答案；支号能对上时再点名是哪条支借的道。 */
  function betweenText(p) {
    if (p.step != null) return '';
    var a = p.afterStep, b = p.beforeStep;
    if (a != null && b != null) return '夹在第 ' + a + ' 步与第 ' + b + ' 步之间' + (p.bridge ? ' · 支 ' + p.bridge.b : '');
    if (a != null) return '接在第 ' + a + ' 步之后';
    if (b != null) return '接在第 ' + b + ' 步之前';
    return '不占步号';
  }
  /* 卡面那一行只有几格：远景牌子与近景首行用短说法，中景用整句。 */
  function betweenShort(p) {
    if (p.step != null) return '';
    if (p.afterStep != null && p.beforeStep != null) return '夹 ' + p.afterStep + '↔' + p.beforeStep + ' 步';
    if (p.afterStep != null) return '接 ' + p.afterStep + ' 步后';
    if (p.beforeStep != null) return '接 ' + p.beforeStep + ' 步前';
    return '不占步号';
  }
  /* 块与块的关系只用账本里数得出的那条支说：岔出去（宿主块→插曲块）、汇回（插曲块→主干块）。
     本会话 11 段插曲的宿主段与岔出段都落在同一块里，所以跨块一条岔出线都没有——
     这不等于"这块和别的块没联系"，它的连接事实是"里面夹了 N 段插曲"，照数说出来。 */
  function roleText(p) {
    // 插曲块的身份由卡面上的 between 那一行说（远景牌子、中景 mvia、近景首行），
    // 这一格不再重复一句"插曲 · 夹在 27↔28 步"。
    if (p.step == null) return '';
    var bits = [];
    if (p.fork.length) bits.push('⤷ 岔出 ' + p.fork.length + ' 段到块 ' + uniq(p.fork.map(function (x) { return x.at; })).join(','));
    if (p.back.length) bits.push('↩ 汇回自块 ' + uniq(p.back.map(function (x) { return x.at; })).join(','));
    if (p.inside) bits.push('块内岔出 ' + p.inside + ' 段插曲');
    return bits.join(' · ');
  }
  function uniq(a) {
    var seen = {}, out = [];
    a.forEach(function (x) { if (!seen[x]) { seen[x] = 1; out.push(x); } });
    return out;
  }

  function bindCard(p, card) {
    card.addEventListener('click', function (e) {
      if (e.target.closest('button, a, input, textarea')) return;
      dive(p);
    });
  }

  /* ---------- 选中 / 推近 ---------- */
  function markOn(p) {
    S.parts.forEach(function (q) { if (q.el) q.el.classList.toggle('on', q === p); });
  }
  function markSel() {
    S.parts.forEach(function (q) { if (q.el) q.el.classList.remove('on'); });
    document.querySelectorAll('.seg.on').forEach(function (x) { x.classList.remove('on'); });
    document.querySelectorAll('.phl.on').forEach(function (x) { x.classList.remove('on'); });
    document.querySelectorAll('#wires path[data-band].on, #wires path[data-chap].on').forEach(function (x) { x.classList.remove('on'); });
    // 章笔记说的是哪一章，那章的牌就要有一圈环——不然一张卡飘在左上，读者不知道它指谁
    document.querySelectorAll('.chl').forEach(function (x) {
      x.classList.toggle('focus', S.chapFocus != null && +x.dataset.chap === S.chapFocus);
    });
    if (!S.sel) return;
    if (S.sel.kind === 'part') {
      var p = S.parts.filter(function (q) { return q.from === S.sel.from; })[0];
      if (p) markOn(p);
    } else if (S.sel.kind === 'seg') {
      var q = partBySeg(S.sel.id);
      if (q) markOn(q);
      var row = document.querySelector('.seg[data-id="' + S.sel.id + '"]');
      if (row) row.classList.add('on');
    } else if (S.sel.kind === 'phase') {
      var n = S.sel.n;
      // 章牌也带 .phl 与 data-n，按编号点亮时必须把它们排除，否则"选中阶段 1"会点亮章 1。
      document.querySelectorAll('.phl:not(.chl)').forEach(function (x) { x.classList.toggle('on', +x.dataset.n === n); });
      document.querySelectorAll('#wires path[data-band]').forEach(function (x) { x.classList.toggle('on', +x.dataset.band === n); });
    } else if (S.sel.kind === 'chapter') {
      var cn = S.sel.n;
      document.querySelectorAll('.chl').forEach(function (x) { x.classList.toggle('on', +x.dataset.chap === cn); });
      document.querySelectorAll('#wires path[data-chap]').forEach(function (x) { x.classList.toggle('on', +x.dataset.chap === cn); });
    }
  }

  /* 点击＝选中 + 推近 + 右栏详情。卡本身不移动、不变形、不压暗邻居——
     "点开之后那块不知道跑哪去了"就是卡片被抬成对话框造成的，这一版没有对话框。 */
  function dive(p) {
    S.sel = { kind: 'part', from: p.from };
    rememberCam();
    setTier('near');
    showPart(p);
    centerOn(p, Math.max(1.02, S.tgt.z));
    markSel();
  }

  // 推近之前记一次镜头；连着点别的块不覆盖，Esc 要回到最初那次的位置
  function rememberCam() {
    if (!S.before) S.before = { x: S.tgt.x, y: S.tgt.y, z: S.tgt.z, tier: S.tier };
  }

  /* ---------- camera ---------- */
  /* 盒高只看档：流程图上一张卡永远是 CW×CH_T[tier]，不随内容长高——
     卡一长高就会盖住下一行，连线也会脱开边框（上一版就是这么坏掉的）。 */
  function ch() {
    return CH_T[S.tier] || CH_T.near;
  }
  function tierFor(z) {
    var t = S.tier, i = TIERS.indexOf(t);
    for (var guard = 0; guard < 4 && i >= 0; guard++) {
      if (i > 0 && z < TH[t][1]) { i--; t = TIERS[i]; continue; }
      if (i < 3 && z >= TH[TIERS[i + 1]][0]) { i++; t = TIERS[i]; continue; }
      break;
    }
    return t;
  }
  function setTier(t) {
    if (S.tier === t) return;
    S.tier = t;
    world.dataset.tier = t;
    // 换档只换卡面描述与盒高，格位不动：缩放过程中块一挪，读者就会以为它们换了位置。
    // 连线的锚点跟着盒高走，所以重画线和小地图；阶段标签按档换字，重建一次。
    drawWires();
    buildBands();
    S.mmDirty = true;
    drawMM();
  }
  var HINT = {
    near: '近景：全部明细（逐条已证增量、每段一行）',
    mid: '中景：第几步 · 哪一块 · 要干什么 · 解决了什么',
    far: '远景：步号 + 这块的题（7 格，真人原话的头一句）',
    glyph: '印章档：只剩步号 + 完成度色带——再缩字号就追不上缩放，这是几何，不是排版'
  };
  function applyCam() {
    world.style.transform = 'translate3d(' + S.cam.x.toFixed(2) + 'px,' + S.cam.y.toFixed(2) + 'px,0) scale(' + S.cam.z.toFixed(5) + ')';
    // 动的时候临时提升图层保流畅；停手 260ms 收回，让浏览器按当前倍率重新栅格化——否则放大后字是放大过的位图，发虚。
    world.style.willChange = 'transform';
    clearTimeout(applyCam._wc);
    applyCam._wc = setTimeout(function () { world.style.willChange = 'auto'; }, 260);
    var z = S.cam.z;
    wires.style.setProperty('--sw', (1.3 / z).toFixed(3) + 'px');
    wires.style.setProperty('--dash', (5 / z).toFixed(2) + ' ' + (7 / z).toFixed(2));
    // 流式的缺口长度与「一个周期推多远」必须同源：两者都按 1/z 写，缩放时才不错拍。
    wires.style.setProperty('--dash-sp', (10 / z).toFixed(2) + ' ' + (2 / z).toFixed(2));
    wires.style.setProperty('--cyc', (12 / z).toFixed(3));
    wires.style.setProperty('--bs', (1.5 / z).toFixed(3) + 'px');
    var t = tierFor(z);
    if (t !== S.tier) { setTier(t); renderPanel(); }
    // 章笔记按屏幕像素排，位置跟着镜头换章——每帧只算二十来个矩形，不重建 DOM 就不重画
    syncChapNote();
    rowhint.textContent = (S.v ? S.v.meta.segs + ' 段 · ' + S.parts.length + ' 块 · ' + (S.v.mainSteps || 0) + ' 步 · '
      + (S.phases.length ? S.phases.length + ' 阶段 · ' : '')
      + (S.pendingN ? '待补综述 ' + S.pendingN + ' 块 · ' : '') : '') +
      '缩放 ' + Math.round(z * 100) + '% · ' + HINT[t];
    rowhint.title = S.pendingN
      ? '这 ' + S.pendingN + ' 块还没有模型综述，先显示原文截断；补账写好会自动换成综述。'
      : '';
    if (S.mm) updateMMVP();
  }

  function setCam(x, y, z, animate) {
    z = clamp(z, MINZ, MAXZ);
    if (!animate) {
      S.cam.x = S.tgt.x = x; S.cam.y = S.tgt.y = y; S.cam.z = S.tgt.z = z;
      applyCam();
      S.mmDirty = true;
      drawMM();
      return;
    }
    S.tgt.x = x; S.tgt.y = y; S.tgt.z = z;
  }

  function zoomAt(sx, sy, nz) {
    nz = clamp(nz, MINZ, MAXZ);
    var z0 = S.tgt.z;
    if (Math.abs(nz - z0) < 0.0005) return;
    var wx = (sx - S.tgt.x) / z0, wy = (sy - S.tgt.y) / z0;
    S.tgt.z = nz;
    S.tgt.x = sx - wx * nz;
    S.tgt.y = sy - wy * nz;
    S.glide = null;
  }

  /* 盒高按当前档算；fit 时可以指定"我准备落在哪一档"，因为换档会换行距——
     用近景的盒高去算全景缩放比，会把 z 压到远景那一档，字反而更小。 */
  function mmBounds() {
    if (!S.parts.length) return { x0: 0, y0: 0, x1: CW, y1: CH_T.near };
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    S.parts.forEach(function (p) {
      x0 = Math.min(x0, p.hx); y0 = Math.min(y0, p.hy);
      x1 = Math.max(x1, p.hx + CW); y1 = Math.max(y1, p.hy + ch());
    });
    // 首行阶段带的顶边在 PAD，比第一张卡的 hy 还高 PH_H——不把它算进来，
    // "适应"会把最上面的阶段标签裁掉。
    y0 = Math.min(y0, PAD);
    return { x0: x0 - PAD / 2, y0: y0 - PAD / 2, x1: x1 + PAD / 2, y1: y1 + PAD / 2 };
  }

  /* 适应＝退到"中景那一屏"：每块还能读出一行干什么。
     可用视口要扣掉常驻 HUD：底部 150px 里坐着续做框、图例和小地图，不扣掉它们，
     "适应"完最底下一排卡就长在面板底下（原来就是这样，读者会看成块被压住了）。 */
  function fit(animate) {
    if (!S.parts.length) return;
    S.before = null;
    setTier('mid');   // 适应落在中景：远景的盒高量出来的 z 会把字压到看不清
    var b = mmBounds(), w = Math.max(1, b.x1 - b.x0), h = Math.max(1, b.y1 - b.y0);
    var vw = viewW(), vh = stage.clientHeight;
    var aw = Math.max(160, vw - HUD.left - HUD.right), ah = Math.max(160, vh - HUD.top - HUD.bottom);
    var z = clamp(Math.min(aw / w, ah / h), MINZ, 1.15);
    var cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    setCam(HUD.left + aw / 2 - cx * z, HUD.top + ah / 2 - cy * z, z, animate !== false);
    // 适应的缩放正好落在中景滞回带的下沿：从远景升上来时 tierFor 会一路停在远景。
    // 程序性镜头停稳后把目标档钉一次；期间用户若又动了镜头（tgt 变了），就不再抢档。
    // 但账本长大以后 fit 的 z 会掉到 0.19 —— 这时钉中景只剩 4.5px 字，不如让印章档的
    // 步号顶上来；只有 z 撑得起中景字号（≥ 中景下沿）才钉。
    var pin = function () { setTier(S.tgt.z >= TH.mid[1] ? 'mid' : tierFor(S.tgt.z)); };
    if (animate === false) pin();
    else whenSettled(pin);
  }
  function whenSettled(fn) {
    var tx = S.tgt.x, ty = S.tgt.y, tz = S.tgt.z;
    (function chk() {
      if (Math.abs(S.tgt.z - tz) > 1e-6 || Math.abs(S.tgt.x - tx) > 0.5 || Math.abs(S.tgt.y - ty) > 0.5) return;
      if (Math.abs(S.cam.z - tz) > 0.0015 || Math.abs(S.cam.x - tx) > 0.5 || Math.abs(S.cam.y - ty) > 0.5) {
        requestAnimationFrame(chk);
        return;
      }
      fn();
    })();
  }

  /* 地址里带 #z=0.58 就落在指定缩放：分享「这一档」的视图，也给探针一个可复跑的入口。 */
  function applyHashZoom() {
    var m = String(location.hash || '').match(/(?:^#|&)z=([0-9.]+)/);
    if (!m) return false;
    var z = Number(m[1]);
    if (!Number.isFinite(z)) return false;
    z = clamp(z, MINZ, MAXZ);
    var cx = (viewW() / 2 - S.cam.x) / S.cam.z;
    var cy = (stage.clientHeight / 2 - S.cam.y) / S.cam.z;
    setCam(viewW() / 2 - cx * z, stage.clientHeight / 2 - cy * z, z, false);
    setTier(tierFor(z));
    applyCam();
    return true;
  }

  /* 首屏落在能读的一档。以前第一次打开就是 fit() 的 12% 全图：满屏编号，
     一个块也读不出内容——第一次用的人看见的是马赛克，不是这张图想说的话。
     账本越大 fit 的 z 越低，所以默认镜头改成「停在最新一块的中景」，
     要看全图有点顶栏的「适应」（或按 F）。 */
  var OPEN_Z = 0.6;
  function openLatest() {
    var p = S.parts[S.parts.length - 1];
    if (!p) return;
    centerOn(p, OPEN_Z);
    setCam(S.tgt.x, S.tgt.y, S.tgt.z, false);
  }

  /* 先把目标档落地再量坐标：盒高随档变（连线锚点按档算），拿旧档的盒子去居中，
     从印章档点「现在」会偏出半张卡——探针实测卡顶到了 y=-104。 */
  function centerOn(p, z) {
    var z2 = clamp(z == null ? S.cam.z : z, MINZ, MAXZ);
    setTier(tierFor(z2));
    var vw = viewW(), vh = stage.clientHeight;
    var cx = p.hx + CW / 2, cy = p.hy + ch() / 2;
    S.tgt.z = z2;
    S.tgt.x = vw / 2 - cx * z2;
    S.tgt.y = vh / 2 - cy * z2;
  }

  function goNow() {
    var p = S.parts[S.parts.length - 1];
    if (!p) return;
    rememberCam();
    centerOn(p, Math.max(1.05, S.cam.z));
    showPart(p);
    markSel();
    if (p.el) {
      p.el.animate(
        [{ boxShadow: '0 0 0 0 rgba(91,214,176,.65)' }, { boxShadow: '0 0 0 14px rgba(91,214,176,0)' }],
        { duration: 700, easing: 'ease-out' }
      );
    }
  }

  /* ---------- minimap ---------- */
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawMM() {
    if (!S.parts.length) return;
    var W = 184, H = 128, dpr = Math.min(2, window.devicePixelRatio || 1);
    if (mm.width !== W * dpr || mm.height !== H * dpr) {
      mm.width = W * dpr; mm.height = H * dpr;
    }
    var ctx = mm.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var b = mmBounds();
    var pad = 7;
    var s = Math.min((W - 2 * pad) / Math.max(1, b.x1 - b.x0), (H - 2 * pad) / Math.max(1, b.y1 - b.y0));
    var ox = (W - (b.x1 - b.x0) * s) / 2 - b.x0 * s;
    var oy = (H - (b.y1 - b.y0) * s) / 2 - b.y0 * s;
    S.mm = { s: s, ox: ox, oy: oy };
    var hex = LVHEX[document.body.dataset.theme === 'light' ? 'light' : 'dark'];
    S.parts.forEach(function (p) {
      var x = ox + p.hx * s, y = oy + p.hy * s;
      var w = Math.max(2, CW * s), h = Math.max(2, ch() * s);
      ctx.globalAlpha = 0.82;
      ctx.fillStyle = hex[p.level] || hex[0];
      roundRect(ctx, x, y, w, h, 1.5);
      ctx.fill();
      if (S.sel && S.sel.kind === 'part' && S.sel.from === p.from) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    });
    ctx.globalAlpha = 1;
    updateMMVP();
    S.mmDirty = false;
  }

  function updateMMVP() {
    if (!S.mm) return;
    var W = mm.clientWidth || 184, H = mm.clientHeight || 128;
    var wx = -S.cam.x / S.cam.z, wy = -S.cam.y / S.cam.z;
    var ww = stage.clientWidth / S.cam.z, wh = stage.clientHeight / S.cam.z;
    var x0 = clamp(S.mm.ox + wx * S.mm.s, 0, W);
    var y0 = clamp(S.mm.oy + wy * S.mm.s, 0, H);
    var x1 = clamp(S.mm.ox + (wx + ww) * S.mm.s, 0, W);
    var y1 = clamp(S.mm.oy + (wy + wh) * S.mm.s, 0, H);
    mmvp.style.left = x0 + 'px';
    mmvp.style.top = y0 + 'px';
    mmvp.style.width = Math.max(2, x1 - x0) + 'px';
    mmvp.style.height = Math.max(2, y1 - y0) + 'px';
  }

  var mmDrag = null;
  function mmCenter(e) {
    if (!S.mm) return;
    var r = mm.getBoundingClientRect();
    var wx = (e.clientX - r.left - S.mm.ox) / S.mm.s;
    var wy = (e.clientY - r.top - S.mm.oy) / S.mm.s;
    S.cam.x = S.tgt.x = viewW() / 2 - wx * S.cam.z;
    S.cam.y = S.tgt.y = stage.clientHeight / 2 - wy * S.cam.z;
    applyCam();
    S.mmDirty = true;
    drawMM();
  }
  minimapEl.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    mmDrag = e.pointerId;
    S.glide = null;
    try { minimapEl.setPointerCapture(e.pointerId); } catch (_) { /* synthetic */ }
    mmCenter(e);
  });
  minimapEl.addEventListener('pointermove', function (e) {
    if (mmDrag !== e.pointerId) return;
    mmCenter(e);
  });
  minimapEl.addEventListener('pointerup', function (e) {
    if (mmDrag === e.pointerId) mmDrag = null;
  });

  /* ---------- 阶段括号（phases.json） ----------
     阶段＝主线步的一段连续区间。括号只画在主线行上方，一格一条；跨行时下一行标「（续）」。
     括号用的列区间、块归属全部来自账本复算（v.phases 的 from/to/blockIds + 页面格位），
     页面不另推一份阶段边界。 */
  function phaseByN(n) {
    for (var i = 0; i < S.phases.length; i++) if (S.phases[i].n === n) return S.phases[i];
    return null;
  }
  function phaseColor(n) {
    if (n === 'T') return document.body.dataset.theme === 'light' ? '#8a93a6' : '#8b93a6';
    var K = Math.max(1, S.phases.length);
    var f = K > 1 ? (n - 1) / (K - 1) : 0;
    var light = document.body.dataset.theme === 'light' ? 44 : 64;
    return 'hsl(' + Math.round(188 + 150 * f) + ' 68% ' + light + '%)';
  }
  function chapByN(n) {
    for (var i = 0; i < S.chapters.length; i++) if (S.chapters[i].n === n) return S.chapters[i];
    return null;
  }
  /* 章的颜色不是第三套配色：取它第一段阶段同一个色相，再压暗一档——
     读起来是"一条粗括号把同色系的一组阶段包成一大块"。 */
  function chapColor(c) {
    var first = (c.phaseNs && c.phaseNs.length) ? c.phaseNs[0] : 1;
    var K = Math.max(1, S.phases.length);
    var f = K > 1 ? (first - 1) / (K - 1) : 0;
    var light = document.body.dataset.theme === 'light' ? 30 : 46;
    return 'hsl(' + Math.round(188 + 150 * f) + ' 62% ' + light + '%)';
  }
  /* 一条带在每一行占哪几列。步号连续 ⇒ 同行的列也连续（换行才断成两段）。
     章带与阶段带共用这一套：只有 kind、纵向偏移和牌面文字不同。 */
  function segsOf(pred, owner, n, kind, out) {
    var byRow = {};
    S.parts.forEach(function (p) {
      if (!pred(p)) return;
      (byRow[p.row] = byRow[p.row] || []).push(p);
    });
    Object.keys(byRow).map(Number).sort(function (a, b) { return a - b; }).forEach(function (r, k) {
      var list = byRow[r].slice().sort(function (a, b) { return a.col - b.col; });
      var c0 = list[0].col, c1 = list[list.length - 1].col;
      out.push({
        ph: owner, n: n, kind: kind, row: r, cont: k > 0,
        x0: PAD + c0 * (CW + GAP_X) - 8,
        x1: PAD + c1 * (CW + GAP_X) + CW + 8,
        el: null
      });
    });
  }
  function bandSegs() {
    var out = [];
    S.chapters.forEach(function (c) {
      segsOf(function (p) { return p.chapter === c.n && p.step != null; }, c, c.n, 'chap', out);
    });
    S.phases.forEach(function (ph) {
      segsOf(function (p) { return p.phase === ph.n && p.step != null; }, ph, ph.n, 'phase', out);
    });
    // 尾段＝还没写阶段说明的步：一条虚线占位带，措辞固定「阶段说明待写」，不编内容。
    if (S.tail) segsOf(function (p) { return p.isTail; }, { n: 'T', short: tailName(), from: S.tail.from, to: S.tail.to, tail: true, whole: !!S.tail.whole }, 'T', 'tail', out);
    return out;
  }
  function bandTail(b) {
    var ph = b.ph;
    var range = '第 ' + ph.from + (ph.to === ph.from ? '' : '–' + ph.to) + ' 步';
    if (ph.tail) {
      if (S.tier === 'glyph') return '';
      return b.cont ? '（续）' : '阶段说明待写';
    }
    if (S.tier === 'glyph') return '';
    if (S.tier === 'far') return ph.short || range;
    if (b.cont) return '（续）';
    return range + (ph.short ? ' · ' + ph.short : '');
  }
  /* 章牌的文字比阶段牌短一档：它是"这一大块叫什么"，细节在点开的那一页里。 */
  function bandTag(b) {
    if (b.kind !== 'chap') return bandTail(b);
    var c = b.ph;
    if (S.tier === 'glyph') return '';
    if (b.cont) return '（续）';
    var range = '第 ' + c.from + '–' + c.to + ' 步';
    if (S.tier === 'far') return c.short || range;
    return range + (c.short ? ' · ' + c.short : '');
  }
  /* 标签牌只用 textContent 写。放不下先退到短名，再退到「（续）」，最后只剩编号——
     宁可少说，不让 CSS 静默裁出半句话。 */
  function buildBands() {
    bands.textContent = '';
    S.bands.forEach(function (b) {
      var chap = b.kind === 'chap';
      var col = chap ? chapColor(b.ph) : phaseColor(b.n);
      var chip = el('div', chap ? 'phl chl' : 'phl');
      chip.dataset.n = b.n;
      if (chap) chip.dataset.chap = b.n;
      chip.style.left = ((b.x0 + b.x1) / 2) + 'px';
      // 章带坐在上半条，阶段带紧贴卡片：两条带各自的牌顶由同一个带高常量推出来。
      chip.style.top = (S.rowY[b.row] - (chap ? PH_H : BAND_H) + 6) + 'px';
      chip.style.maxWidth = Math.max(60, b.x1 - b.x0 - 10) + 'px';
      chip.style.color = col;
      chip.style.borderColor = col;
      chip.title = chap
        ? '章 ' + b.n + ' · 第 ' + b.ph.from + '–' + b.ph.to + ' 步 · 块 ' + b.ph.fromBlock + '–' + b.ph.toBlock
          + ' · ' + (b.ph.short || '') + '（点开看接手那一页：目的 / 走到哪 / 规则 / 任务 / 碰壁 / 注意 / 架构 / 怎么接手）'
        : b.ph.tail
          ? (b.ph.whole ? '未划阶段 · ' : '尾段 · ') + '第 ' + b.ph.from + '–' + b.ph.to + ' 步 · 阶段说明待写（点开看怎么补）'
          : '阶段 ' + b.n + ' · 第 ' + b.ph.from + '–' + b.ph.to + ' 步 · ' + (b.ph.short || '')
            + '（点开看这一阶段在做什么 / 进度 / 效果 / 对照文档 / 规则）';
      chip.appendChild(el('b', 'pfn', chap ? '章 ' + b.n : (b.ph.tail ? (b.ph.whole ? '未划阶段' : '尾段') : '阶段 ' + b.n)));
      if (b.ph.tail) chip.classList.add('tail');
      var tail = bandTag(b);
      var span = tail ? el('span', 'pft', tail) : null;
      if (span) chip.appendChild(span);
      bands.appendChild(chip);
      if (span && span.scrollWidth > span.clientWidth + 1) {
        span.textContent = b.cont ? '（续）' : (b.ph.short || '');
        if (span.scrollWidth > span.clientWidth + 1 || !span.textContent) {
          span.textContent = b.cont ? '（续）' : '';
          if (!span.textContent) chip.removeChild(span);
        }
      }
      chip.addEventListener('click', function (e) {
        e.stopPropagation();
        if (chap) showChapter(b.ph); else if (b.ph.tail) showTail(b.ph); else showPhase(b.ph);
      });
      b.el = chip;
    });
    markSel();
  }
  function drawBands() {
    S.bands.forEach(function (b) {
      var chap = b.kind === 'chap';
      // 括号横线落在自己那条带的下沿，两臂向上 7：章牌底正好压在自己的括号线上。
      var y = chap ? S.rowY[b.row] - BAND_H - 12 : S.rowY[b.row] - 12;
      var path = svgEl('path', {
        d: 'M' + b.x0 + ' ' + (y - 7) + 'L' + b.x0 + ' ' + y + 'L' + b.x1 + ' ' + y + 'L' + b.x1 + ' ' + (y - 7),
        class: 'band' + (chap ? ' chapband' : '') + (b.ph.tail ? ' tailband' : '')
      });
      path.style.stroke = chap ? chapColor(b.ph) : phaseColor(b.n);
      // 章括号只认 data-chap：data-band 是"选中某阶段时点亮跨块连线"的钩子，两件事不能撞一个属性。
      if (chap) path.dataset.chap = b.n; else path.dataset.band = b.n;
      if (chap && S.sel && S.sel.kind === 'chapter' && S.sel.n === b.n) path.classList.add('on');
      if (!chap && S.sel && S.sel.kind === 'phase' && S.sel.n === b.n) path.classList.add('on');
      if (S.sel && S.sel.kind === 'tail' && b.ph.tail) path.classList.add('on');
      wires.appendChild(path);
    });
  }
  function showChapter(ch) {
    S.sel = { kind: 'chapter', n: ch.n };
    insp.hidden = false;
    stage.classList.add('insp');
    renderInspector();
    updateMMVP();
    renderAsk();
    markSel();
  }
  /* 章笔记（PRD-atlas 十二）：这一大块的总结按屏幕像素排。世界像素的字在 12% 那一档只剩
     4 个屏幕像素——东西画了，人读不到。卡跟着"视口正中那一张块属于哪一章"走，
     点开还是九格那一份文本。 */
  function chapInView() {
    var z = S.cam.z;
    // 基准点与 centerOn 同源（含右栏让位），否则"定位到第 N 步"落定的块会被算成隔壁那一章
    var cx = (viewW() / 2 - S.cam.x) / z, cy = (stage.clientHeight / 2 - S.cam.y) / z;
    var best = null, bestD = Infinity;
    S.parts.forEach(function (p) {
      if (p.chapter == null) return;
      var d = Math.hypot(Math.max(p.hx - cx, 0, cx - (p.hx + CW)), Math.max(p.hy - cy, 0, cy - (p.hy + ch())));
      if (d < bestD) { bestD = d; best = p.chapter; }
    });
    return best == null ? null : chapByN(best);
  }
  /* 骨架只搭一次，换章只改字：镜头一动就重建 DOM 的话，正按下鼠标的那一枚按钮会被抽掉，
     点击落到已经不在的节点上——用户看到的是"点了没反应"。 */
  var cnDot = null, cnName = null, cnRange = null, cnLines = [], cnGo = null;
  function buildChapNote(c) {
    if (!cnGo) {
      var t = el('div', 'cnt');
      cnDot = el('i', 'cdot');
      cnName = el('span', 'cname');
      cnRange = el('span', 'crange');
      t.appendChild(cnDot); t.appendChild(cnName); t.appendChild(cnRange);
      chapnote.appendChild(t);
      ['目的', '走到哪', '接手'].forEach(function (k) {
        var row = el('div', 'cln');
        var b = el('b', '', k);
        var s = el('span', '');
        row.appendChild(b); row.appendChild(s);
        chapnote.appendChild(row);
        cnLines.push(s);
      });
      // 整张卡不吃点击（它压在第一行章牌上），唯一能点的是这一枚按钮
      cnGo = el('button', 'cgo');
      cnGo.type = 'button';
      cnGo.addEventListener('click', function () { var x = chapByN(S.chapFocus); if (x) showChapter(x); });
      chapnote.appendChild(cnGo);
    }
    cnDot.style.background = chapColor(c);
    cnName.textContent = '章 ' + c.n + ' · ' + (c.short || '（没有章名）');
    cnRange.textContent = '第 ' + c.from + '–' + c.to + ' 步';
    [c.goal, c.where, c.handoff].forEach(function (v, i) { cnLines[i].textContent = v || '—'; });
    cnGo.textContent = '打开九格 · ' + c.phaseSpan + '（' + c.phaseCount + ' 程）';
    chapnote.title = '章 ' + c.n + ' · 第 ' + c.from + '–' + c.to + ' 步 · 块 ' + c.fromBlock + '–' + c.toBlock
      + '：这张卡跟着你正在看的那一章走，点下面那行读完整一页';
  }
  function syncChapNote() {
    // 搜索清单占同一个左上角，临时物优先
    if (!S.chapters.length || !hits.hidden) { chapnote.hidden = true; S.chapFocus = null; return; }
    var c = chapInView() || chapByN(S.chapFocus) || S.chapters[S.chapters.length - 1];
    // 图里一块都不在视口里时保留上一枚焦点：卡忽然空掉比卡不在更像出错
    if (S.chapFocus !== c.n) { S.chapFocus = c.n; buildChapNote(c); markSel(); }
    chapnote.hidden = false;
  }
  function showPhase(ph) {
    S.sel = { kind: 'phase', n: ph.n };
    insp.hidden = false;
    stage.classList.add('insp');
    renderInspector();
    updateMMVP();
    renderAsk();
    markSel();
  }
  /* 尾段不是阶段：只报事实与补写命令，不拿空六格假装有说明。 */
  function showTail(ph) {
    S.sel = { kind: 'tail', n: 'T' };
    insp.hidden = false;
    stage.classList.add('insp');
    inspbody.textContent = '';
    var head = el('div', 'ihead');
    head.appendChild(el('b', 'iid', (S.tail && S.tail.whole) ? '未划阶段' : '尾段'));
    inspbody.appendChild(head);
    inspbody.appendChild(el('div', 'ititle', '第 ' + ph.from + (ph.to === ph.from ? '' : '–' + ph.to) + ' 步 · 阶段说明待写'));
    var blocks = S.parts.filter(function (p) { return p.isTail; });
    var segs = blocks.reduce(function (a, p) { return a + p.segs; }, 0);
    inspbody.appendChild(sec('这一段的账本事实'));
    inspbody.appendChild(factRow('范围', '第 ' + ph.from + '–' + ph.to + ' 步 · ' + blocks.length + ' 块 · ' + segs + ' 段'));
    inspbody.appendChild(factRow('说明', '还没有模型写的阶段说明。这里只照账本说话，不编。', true));
    inspbody.appendChild(factRow('补写', 'convledger digest --phases → convledger phases --put（写完就从' + ((S.tail && S.tail.whole) ? '未划阶段' : '尾段') + '变成正式阶段）', true));
    updateMMVP();
    renderAsk();
    markSel();
  }

  /* ---------- wires ---------- */
  /* 连线只走三种地方：列间空带（GAP_X）、行间空带（GAP_Y）和图的左右走廊。
     格位是死的（一行占 ROW_H、卡最高 CH_T.near），所以每条空带至少 46px 宽，线不会压到任何卡。
     端点一律钉在卡片边框上，箭头从外侧指向目标边框：这是"连线连上了"唯一能被看见的证据。
     主线＝灰实线；岔出＝橙虚线＋宿主端一个圆点；汇回＝绿虚线。 */
  var SVGNS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    var e = document.createElementNS(SVGNS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  var ARROW = { spine: 'ah-spine', fork: 'ah-fork', back: 'ah-back' };

  function wireDefs() {
    var defs = svgEl('defs', {});
    [['ah-spine', 'spine'], ['ah-fork', 'fork'], ['ah-back', 'back']].forEach(function (x) {
      var m = svgEl('marker', {
        id: x[0], viewBox: '0 0 10 10', refX: 9.5, refY: 5,
        markerWidth: 6.5, markerHeight: 6.5, orient: 'auto', markerUnits: 'strokeWidth'
      });
      m.appendChild(svgEl('path', { d: 'M0 1 L10 5 L0 9 z', class: 'head ' + x[1] }));
      defs.appendChild(m);
    });
    // 岔出线的起点圆点也走 marker：markerUnits 按线宽算，缩放到哪一档都是同一个屏幕尺寸
    var dot = svgEl('marker', {
      id: 'dot-fork', viewBox: '0 0 10 10', refX: 5, refY: 5,
      markerWidth: 5, markerHeight: 5, orient: 'auto', markerUnits: 'strokeWidth'
    });
    dot.appendChild(svgEl('circle', { cx: 5, cy: 5, r: 3, class: 'head fork' }));
    defs.appendChild(dot);
    wires.appendChild(defs);
  }

  function cxOf(p) { return p.hx + CW / 2; }
  function botOf(p) { return p.hy + ch(); }
  /* 这一行内容区的顶边：主线行上方先坐一条 PH_H 的阶段带，插曲道没有。 */
  function rowTop(row) { return S.mainRow[row] ? S.rowY[row] - PH_H : S.rowY[row]; }
  /* 进这一行的横向走线放在内容区顶边之上半个行距——主线行就是放在阶段带的上方，
     否则线会从阶段标签和括号中间穿过去。 */
  function approachY(row) { return rowTop(row) - GAP_Y / 2; }
  /* 本行槽底的空带：卡最长只到 CH_T.near，槽高至少 GAP_Y，所以 rowY+CH_T.near+23 一定在
     卡下方、下一个内容区上方。用固定盒高而不是 ROW_H——行距现在随阶段带变化。 */
  function bandBelow(row) { return S.rowY[row] + CH_T.near + GAP_Y / 2; }

  function wirePts(pts, cls, from, to, dot) {
    var d = '', prev = null;
    pts.forEach(function (pt) {
      var x = Math.round(pt[0] * 10) / 10, y = Math.round(pt[1] * 10) / 10;
      if (prev && Math.abs(prev[0] - x) < 0.6 && Math.abs(prev[1] - y) < 0.6) return;
      d += (prev ? 'L' : 'M') + x + ' ' + y;
      prev = [x, y];
    });
    if (!prev) return;
    var path = svgEl('path', { d: d, class: cls });
    path.setAttribute('marker-end', 'url(#' + ARROW[cls] + ')');
    if (dot) path.setAttribute('marker-start', 'url(#dot-fork)');
    path.dataset.edge = cls;
    path.dataset.from = from;
    path.dataset.to = to;
    wires.appendChild(path);
  }

  /* 主线第 N 步 → 第 N+1 步：同一行就直接横穿列间空带；行末折返就下到本行槽底、
     横到左走廊、再下到目标行上方，最后从目标卡顶边进。中间隔着插曲道时只许多绕一段左走廊。 */
  function edgeStep(a, b, cls) {
    cls = cls || 'spine';
    var mid = ch() / 2;
    if (a.row === b.row && b.col === a.col + 1) {
      wirePts([[a.hx + CW, a.hy + mid], [b.hx, b.hy + mid]], cls, a.from, b.from);
      return;
    }
    var y1 = bandBelow(a.row), y2 = approachY(b.row);
    var pts = [[cxOf(a), botOf(a)], [cxOf(a), y1]];
    if (b.row === a.row + 1) {
      pts.push([cxOf(b), y1], [cxOf(b), b.hy]);
    } else {
      pts.push([S.leftX, y1], [S.leftX, y2], [cxOf(b), y2], [cxOf(b), b.hy]);
    }
    wirePts(pts, cls, a.from, b.from);
  }

  /* 宿主步 → 插曲段第一块：下到槽底空带，横到目标列，再顶进它的顶边。 */
  function edgeFork(host, first) {
    var y = bandBelow(host.row);
    if (first.row === host.row + 1) {
      if (first.col === host.col) {
        wirePts([[cxOf(host), botOf(host)], [cxOf(first), first.hy]], 'fork', host.from, first.from, true);
      } else {
        wirePts([[cxOf(host), botOf(host)], [cxOf(host), y], [cxOf(first), y], [cxOf(first), first.hy]],
          'fork', host.from, first.from, true);
      }
      return;
    }
    // 插曲道不止一行：走左走廊下去，从第一块卡的左边框横着进（它一定在该道第 0 列）
    var cy = first.hy + ch() / 2;
    wirePts([[cxOf(host), botOf(host)], [cxOf(host), y], [S.leftX, y], [S.leftX, cy], [first.hx, cy]],
      'fork', host.from, first.from, true);
  }

  /* 插曲段最后一块 → 汇回步。目标在上方（同一宿主行的下一步）就从卡顶出去、
     在两道之间的空带里横到目标列，从下往上顶进它的底边；目标在下方就反过来从卡底出。
     插曲道更深时绕右走廊，别从别的插曲卡身上踩过去。 */
  function edgeBack(last, target) {
    var h = ch();
    if (target.row < last.row) {
      if (last.row === target.row + 1) {
        var y = approachY(last.row);
        wirePts([[cxOf(last), last.hy], [cxOf(last), y], [cxOf(target), y], [cxOf(target), target.hy + h]],
          'back', last.from, target.from);
        return;
      }
      var y1 = bandBelow(last.row), y2 = bandBelow(target.row);
      wirePts([[cxOf(last), botOf(last)], [cxOf(last), y1], [S.rightX, y1], [S.rightX, y2],
        [cxOf(target), y2], [cxOf(target), target.hy + h]], 'back', last.from, target.from);
      return;
    }
    if (target.row === last.row + 1) {
      var yb = bandBelow(last.row);
      wirePts([[cxOf(last), botOf(last)], [cxOf(last), yb], [cxOf(target), yb], [cxOf(target), target.hy]],
        'back', last.from, target.from);
      return;
    }
    var ya = bandBelow(last.row), yt = approachY(target.row);
    wirePts([[cxOf(last), botOf(last)], [cxOf(last), ya], [S.rightX, ya], [S.rightX, yt],
      [cxOf(target), yt], [cxOf(target), target.hy]], 'back', last.from, target.from);
  }

  function drawWires() {
    wires.textContent = '';
    wireDefs();
    // 阶段括号先画：连线后画，交叠处线在上，括号不会被一条竖线截断成两段。
    drawBands();
    var spine = S.parts.filter(function (p) { return p.step != null; });
    for (var i = 1; i < spine.length; i++) edgeStep(spine[i - 1], spine[i]);
    var byStep = {};
    spine.forEach(function (p) { byStep[p.step] = p; });
    // 连续的无步号块算一趟插曲：一趟只有两个接口——宿主岔出、汇回步汇入。
    // 这两个接口是账本数出来的（stepsOf 的 afterStep/beforeStep），不是页面猜的。
    var run = [];
    function flush() {
      if (!run.length) return;
      var host = run[0].afterStep == null ? null : byStep[run[0].afterStep];
      var last = run[run.length - 1];
      var back = last.beforeStep == null ? null : byStep[last.beforeStep];
      if (host) edgeFork(host, run[0]);
      // 同一趟插曲内部也按账本顺序连起来：否则一串插曲块在图上就是几张互不相干的孤卡。
      for (var i = 1; i < run.length; i++) edgeStep(run[i - 1], run[i], 'fork');
      if (back) edgeBack(last, back);
      run = [];
    }
    S.parts.forEach(function (p) {
      if (p.step == null) { run.push(p); return; }
      flush();
    });
    flush();
  }

  /* ---------- search ---------- */
  /* 搜索的词表＝这块能被复算的每一格：块号、第几步、角色、句范围、段号、
     支标题、已证增量、落地物、留问、报错。命中之后要能说"它在第几步、哪一块"，
     所以结果不是只有块，而是落到段。 */
  function hay(p) {
    var parts = [p.from, p.to, p.span, '块' + p.i, p.step == null ? '' : '第' + p.step + '步',
      p.role, p.sent, p.carrySent, p.mark, p.gist, p.title, p.solved, p.made, LV[p.level]];
    (p.outs || []).forEach(function (o) { parts.push(o); });
    p.lines.forEach(function (l) { parts.push(l.text, l.id); });
    (p.rules || []).forEach(function (r) { parts.push(r.text, r.id); });
    notesOf(p).forEach(function (x) { parts.push(x.id, x.title, x.body || ''); });
    p.taskIds.forEach(function (id) {
      var t = S.tasks[id];
      if (t) parts.push(id, t.title || '', t.stateLabel || '', (t.topics || []).join(' '));
    });
    // 阶段说明也进搜索：搜"建立账本"应该把这一程的每一块都列出来，而不是只命中标题里带这四个字的那块。
    if (p.phase) {
      var ph = phaseByN(p.phase);
      if (ph) parts.push('阶段' + ph.n, ph.short, ph.doing, ph.state, ph.effect, ph.plan, ph.track,
        (ph.refs || []).map(function (r) { return r.f + ' ' + r.h; }).join(' '),
        (ph.rules || []).map(function (r) { return r.text; }).join(' '));
    }
    for (var i = p.i0; i <= p.i1; i++) {
      var n = S.v.nodes[i];
      parts.push(n.id, n.line || '', n.claim || '', n.kind || '', (n.topics || []).join(' '),
        (n.branches || []).join(' '), String(n.moves || ''), n.note || '');
    }
    return parts.filter(Boolean).join(' ').toLowerCase();
  }
  function hayNode(n) {
    return [n.id, n.line, n.claim, n.note, n.kind, n.task, String(n.moves),
      (n.topics || []).join(' '), (n.branches || []).join(' ')].filter(Boolean).join(' ').toLowerCase();
  }

  function applySearch() {
    var q = S.q.trim().toLowerCase();
    S.hits = [];
    S.hitI = -1;
    S.parts.forEach(function (p) {
      var hit = !q || hay(p).indexOf(q) >= 0;
      if (q && hit) {
        var segs = [];
        for (var i = p.i0; i <= p.i1; i++) {
          var n = S.v.nodes[i];
          if (hayNode(n).indexOf(q) >= 0) segs.push(n.id);
        }
        S.hits.push({ p: p, segs: segs });
      }
      if (p.el) {
        p.el.classList.toggle('dim', !!q && !hit);
        p.el.classList.toggle('match', !!q && hit);
      }
    });
    findn.textContent = q ? S.hits.length + ' 块' : '';
    renderPanel();
  }

  /* 左下角那块板只在**打了搜索词**时出现（＝命中清单）。
     上一版它在远景自动铺开成"每块一行"的清单，用户明确不要：地图上要看的还是地图。
     远景的可读性改由卡面上的 mark 保证（四档换层），不再靠屏幕空间另挂一块表。 */
  function renderPanel() {
    renderHits(S.q.trim());
  }

  /* 命中清单：一行一个"哪一段 · 第几步哪一块 · 主线还是插曲 · 那一行原文"，
     点它＝钻进那块并选中这段——这就是"搜到＝找回那段记忆"的第一跳。 */
  function renderHits(q) {
    var box = $('hits');
    if (!box) return;
    box.textContent = '';
    if (!q) { box.hidden = true; return; }
    box.hidden = false;
    if (!S.hits.length) {
      box.appendChild(el('div', 'hnone', '没有一块的任何一个可复算字段含「' + S.q.trim() + '」。'));
      return;
    }
    var rows = 0, capped = 0;
    S.hits.forEach(function (h) {
      var list = h.segs.length ? h.segs.map(function (id) { return { p: h.p, seg: id }; }) : [{ p: h.p, seg: '' }];
      list.forEach(function (r) {
        if (rows >= 40) { capped++; return; }
        rows++;
        var p = r.p, n = r.seg ? nodeById(r.seg) : null;
        var row = el('div', 'hrow');
        row.appendChild(el('b', 'hsid', n ? n.id : p.span));
        var cell = el('div', 'hbox');
        var top = el('div', 'htop');
        top.appendChild(el('span', 'hst', p.step == null ? '插曲块 ' + p.i : '第 ' + p.step + ' 步 · 块 ' + p.i));
        top.appendChild(el('span', 'hrole', p.role + ' · ' + (p.sent || p.carrySent)));
        cell.appendChild(top);
        cell.appendChild(el('div', 'htxt', n ? (n.basis === 'verified' && n.claim ? n.claim : (n.line || n.note || n.kind)) : p.solved));
        row.appendChild(cell);
        row.addEventListener('click', function () {
          dive(p);
          if (r.seg) selectSeg(r.seg); else showPart(p);
        });
        box.appendChild(row);
      });
    });
    if (capped) box.appendChild(el('div', 'hnone', '还有 ' + capped + ' 条没列出：把词说长一点，或用 convledger find ' + S.q.trim()));
  }

  function cycleHit(dir) {
    if (!S.hits.length) return;
    S.hitI = (S.hitI + dir + S.hits.length) % S.hits.length;
    var h = S.hits[S.hitI];
    centerOn(h.p, Math.max(0.95, S.cam.z));
    if (h.segs.length) selectSeg(h.segs[0]);
  }

  /* ---------- inspector ---------- */
  function factRow(k, v, wide) {
    var r = el('div', 'ifact' + (wide ? ' wide' : ''));
    r.appendChild(el('span', 'ik', k));
    var vv = el('span', 'iv');
    if (v instanceof Node) vv.appendChild(v);
    else vv.textContent = v == null || v === '' ? '—' : String(v);
    r.appendChild(vv);
    return r;
  }
  function sec(title) { return el('div', 'isec', title); }

  function copyText(text, btn) {
    function done() {
      if (!btn) return;
      var old = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(function () { btn.textContent = old; }, 1200);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else fallback();
    function fallback() {
      var t = document.createElement('textarea');
      t.value = text;
      t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t);
      t.select();
      try { document.execCommand('copy'); done(); } catch (_) { /* nothing else to try */ }
      document.body.removeChild(t);
    }
  }

  function cmdRow(cmd) {
    var row = el('div', 'icmdrow');
    row.appendChild(el('code', 'icmd', cmd));
    var btn = el('button', 'ibtn', '复制');
    btn.type = 'button';
    btn.addEventListener('click', function () { copyText(cmd, btn); });
    row.appendChild(btn);
    return row;
  }

  function toast(text, bad) {
    var t = el('div', 'toast' + (bad ? ' bad' : ''), text);
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('out'); }, 2400);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 3000);
  }

  /* 写完一张外挂表之后立刻拉一次 payload；notes 的条数在 sigOf 里，所以
     重建卡片是必然的——不这么做，人写的标注要等下一次账本重建才出现。 */
  function refreshSoon() {
    fetch(BASE + '/data.json', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (v) {
        if (sigOf(v) === S.sig) { if (S.sel) renderInspector(); return; }
        if (S.pan) { S.pending = v; return; }
        adopt(v, false);
      })
      .catch(function () { /* 下一次 4s 轮询会补上 */ });
  }

  /* B3：正文按需读。点一次 → 服务端现读源 JSONL → 回来就显示；再点只是收起。
     这里不写任何缓存，也不把正文塞进 data.json：源日志仍是唯一副本。 */
  function bodyBlock(id, host, btn) {
    // 按钮文案由调用方用 data-label 定（块上是「查看原文」、段上是「展开正文」），
    // 展开态统一叫「收起原文」——这里写死一种叫法会让另一处说谎。
    var label = (btn && btn.dataset.label) || '展开正文';
    var pre = host.querySelector('pre');
    if (pre) {
      pre.hidden = !pre.hidden;
      var nb = host.querySelector('.bodynote');
      if (nb) nb.hidden = pre.hidden;
      if (btn) btn.textContent = pre.hidden ? label : '收起原文';
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = '读取中…'; }
    fetch(BASE + '/body?seg=' + encodeURIComponent(id) + '&max=4000', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (t) {
        var body = el('pre', 'ibody');
        body.textContent = t;
        host.appendChild(body);
        host.appendChild(el('div', 'bodynote', '按锚点现读源日志 · 不缓存、不进 data.json · ' + t.length + ' 字符'));
        if (btn) btn.textContent = '收起原文';
      })
      .catch(function (e) {
        host.appendChild(el('div', 'bodynote bad', '正文读不了：' + e.message));
        if (btn) btn.textContent = label;
      })
      .then(function () { if (btn) btn.disabled = false; });
  }

  /* B4/B5：人写的一条标注。落 notes.json，author 永远 human、basis 永远 human-note；
     不写 claims，不进 index，也不冒充已证。 */
  function openNoteDlg(kind, p, at) {
    var seg = at || (S.sel && S.sel.kind === 'seg' && partBySeg(S.sel.id) === p ? S.sel.id : p.to);
    var wrap = el('div', 'dlgwrap');
    var box = el('div', 'dlg');
    box.appendChild(el('h3', '', kind === 'branch' ? '⑑ 创建分支' : '＋ 加一个节点'));
    box.appendChild(el('div', 'dlgmeta', (kind === 'branch' ? '从 ' : '接在 ') + seg +
      (kind === 'branch' ? ' 起一条新支' : ' 之后') + ' · 人写的，标「未证」，永远不参与六条判据'));
    var ti = el('input', 'dlgt');
    ti.type = 'text';
    ti.maxLength = 40;
    ti.placeholder = '一句话标题（≤40 字）';
    box.appendChild(ti);
    var bo = el('textarea', 'dlgb');
    bo.maxLength = 600;
    bo.placeholder = '补充说明（可选，≤600 字）';
    box.appendChild(bo);
    var err = el('div', 'dlgerr');
    box.appendChild(err);
    var acts = el('div', 'dlgact');
    var cancel = el('button', 'ibtn', '取消');
    cancel.type = 'button';
    var save = el('button', 'ibtn primary', '写入 notes.json');
    save.type = 'button';
    acts.appendChild(cancel);
    acts.appendChild(save);
    box.appendChild(acts);
    wrap.appendChild(box);
    document.body.appendChild(wrap);
    ti.focus();

    function close() { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }
    function submit() {
      var title = ti.value.trim();
      if (!title) { err.textContent = '标题不能空：加一条就得有一句话说得清它是什么'; return; }
      save.disabled = true;
      fetch(BASE + '/note', {
        method: 'POST', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: kind, seg: seg, after: kind === 'node' ? seg : '', title: title, body: bo.value.trim() })
      })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (!res.ok || !res.j.ok) { err.textContent = (res.j.errors || ['写入失败']).join(' · '); save.disabled = false; return; }
          close();
          toast('✓ ' + res.j.note.id + ' 已写入 notes.json · 人写的·未证');
          refreshSoon();
        })
        .catch(function (e) { err.textContent = '写不进去：' + e.message; save.disabled = false; });
    }
    cancel.addEventListener('click', close);
    save.addEventListener('click', submit);
    wrap.addEventListener('pointerdown', function (e) { if (e.target === wrap) close(); });
    ti.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    bo.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });
  }

  function noteRows(notes) {
    var box = el('div', 'inotes');
    notes.forEach(function (x) {
      var row = el('div', 'inote');
      var top = el('div', 'pntop');
      top.appendChild(el('b', 'pnid', x.id));
      top.appendChild(el('span', 'pnkind', x.kind === 'branch' ? '⑑ 分支' : '＋ 节点'));
      top.appendChild(el('span', 'tag human', '人写的'));
      top.appendChild(el('span', 'tag', '未证'));
      top.appendChild(el('span', 'pnat', x.seg + (x.after ? ' → ' + x.after : '')));
      row.appendChild(top);
      row.appendChild(el('div', 'pntitle', x.title));
      if (x.body) row.appendChild(el('div', 'pnbody', x.body));
      box.appendChild(row);
    });
    return box;
  }

  function inspectSeg(n) {
    inspbody.textContent = '';
    var head = el('div', 'ihead');
    head.appendChild(el('b', 'iid', n.id));
    head.appendChild(el('span', 'ibasis ' + n.basis, BASIS[n.basis] || n.basis));
    inspbody.appendChild(head);
    if (n.kind || n.task) inspbody.appendChild(el('div', 'ikind', (n.kind || '') + (n.task ? ' · ' + n.task : '')));

    inspbody.appendChild(sec('段落事实'));
    inspbody.appendChild(factRow('回合', 't' + (n.t0 || 0) + '–' + (n.t1 || 0) + ' · ' + (n.turns || 0) + ' 回合'));
    inspbody.appendChild(factRow('调用', (n.calls || 0) + ' 次 · 往返 ' + (n.rt || 0).toLocaleString() + 't · 路由卡 ' + (n.card || 0) + 't'));
    inspbody.appendChild(factRow('锚点', n.anchor || '—'));
    if (n.tools) inspbody.appendChild(factRow('工具', n.tools));
    if (n.outs) inspbody.appendChild(factRow('落地物', n.outs));

    inspbody.appendChild(sec('认识增量'));
    if (n.basis === 'verified' && n.claim) {
      var c = el('div', 'iclaim');
      c.appendChild(el('b', '', n.id));
      c.appendChild(el('span', '', n.claim));
      inspbody.appendChild(c);
    } else {
      inspbody.appendChild(el('div', 'imuted', '这一段没有过六条判据的增量（basis=' + n.basis + '）—— 工具不替它编一句。'));
    }
    if (n.moves) inspbody.appendChild(factRow('moves', n.moves));
    if (n.note) inspbody.appendChild(factRow('说明', n.note));

    var here = partBySeg(n.id);
    inspbody.appendChild(sec('正文入口'));
    inspbody.appendChild(el('div', 'ihint', '正文不在这张图上：按锚点回源日志读。长期记忆靠这条披露式回读。'));
    if (here) inspbody.appendChild(factRow('它在哪', (here.step == null ? '插曲块 ' + here.i : '第 ' + here.step + ' 步 · 块 ' + here.i) + ' · ' + here.role + ' · ' + here.span));
    inspbody.appendChild(cmdRow('convledger body ' + n.id));
    if (here) inspbody.appendChild(cmdRow('convledger show'));
    var bodyHost = el('div', 'ibodyhost');
    var bb = el('button', 'ibtn', '展开正文（现读源日志）');
    bb.type = 'button';
    bb.title = '点一次向服务端要一次：不缓存、不进 data.json';
    bb.addEventListener('click', function () { bodyBlock(n.id, bodyHost, bb); });
    inspbody.appendChild(bb);
    inspbody.appendChild(bodyHost);

    inspbody.appendChild(sec('人写的（未证）'));
    var mine = notesAt(n.id);
    if (!mine.length) {
      inspbody.appendChild(el('div', 'imuted', '这一段没有人的标注。人写的节点/分支只写 notes.json，不参与六条判据。'));
    } else {
      inspbody.appendChild(noteRows(mine));
    }
    if (here) {
      var addHere = el('button', 'ibtn', '＋ 在这一段上加节点');
      addHere.type = 'button';
      addHere.addEventListener('click', function () { openNoteDlg('node', here, n.id); });
      inspbody.appendChild(addHere);
    }

    if (n.tip) {
      inspbody.appendChild(sec('账本原话'));
      inspbody.appendChild(el('div', 'itip', n.tip));
    }

    var acts = el('div', 'iacts');
    var p = partBySeg(n.id);
    if (p) {
      var b = el('button', 'ibtn primary', '在图上定位这一块');
      b.type = 'button';
      b.title = '把镜头移到它所在的那一格（不改变这一段的选中）';
      b.addEventListener('click', function () {
        centerOn(p, Math.max(0.95, S.cam.z));
        markSel();
      });
      acts.appendChild(b);
    }
    inspbody.appendChild(acts);
  }

  /* 点块之后右栏要回答五件事：这块属于哪条主线任务、在任务的哪个阶段、为什么做、
     这次动了哪几类东西、做成了什么效果。句/段/回合/规模/计数行这些数去 `convledger steps`
     查，不在这里堆——面板是摘要，不是账单。文件名也不上屏：人去点开一块是想知道
     "这步干成了啥"，不是看产物清单。
     想读原话点「查看原文」：按锚点回源读这一块的整段范围，面板里不留正文副本。 */

  /* 文件名归成身份类别，数还是能复算的（p.files 直接来自账本的产物清单）。 */
  var FILE_KINDS = ['页面脚本', '样式', '测试', '工具源码', '文档', '数据', '截图', '其他'];
  function fileKind(name) {
    var s = String(name).toLowerCase();
    if (/\.(png|jpe?g|webp|gif|svg)$/.test(s)) return '截图';
    if (/\.(md|txt)$/.test(s)) return '文档';
    if (/\.css$/.test(s)) return '样式';
    if (/^(selftest|atlas-probe|layout-check|shot-|render-|batch-|probe-|flow-)/.test(s)) return '测试';
    if (/\.(json|jsonl|csv)$/.test(s)) return '数据';
    if (/\.(js|mjs|cjs)$/.test(s)) return /^(atlas|app)\.js$/.test(s) ? '页面脚本' : '工具源码';
    return '其他';
  }
  function kindList(files) {
    var seen = {};
    (files || []).forEach(function (f) { seen[fileKind(f)] = 1; });
    return FILE_KINDS.filter(function (k) { return seen[k]; });
  }
  function cnJoin(list) {
    if (list.length <= 1) return list[0] || '';
    return list.slice(0, -1).join('、') + '和' + list[list.length - 1];
  }
  /* 引文按子句边界截：宁可短一点，也不在半句中间砍出一个"的"字。 */
  function clipQuote(s, max) {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    if (s.length <= max) return s;
    var cut = 0;
    for (var i = 0; i < max; i++) if ('，。；：、！？,.;:!?'.indexOf(s.charAt(i)) >= 0) cut = i + 1;
    return s.slice(0, cut > max * 0.4 ? cut : max) + '…';
  }
  function stripMd(s) {
    return String(s || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  }

  /* 这条任务在主线上占哪几块：块里出现过它就算。第几块/共几块、跨第几步都从 S.parts 数，
     不另存一份——和 `convledger steps` 的步号同源，两处各推一遍就会漂。 */
  function taskStage(p) {
    var t = p.dominant ? S.tasks[p.dominant] : null;
    if (!t || p.step == null) return null;
    var mine = S.parts.filter(function (q) { return q.step != null && q.taskIds.indexOf(t.id) >= 0; });
    if (!mine.length) return null;
    return { k: mine.indexOf(p) + 1, m: mine.length, lo: mine[0].step, hi: mine[mine.length - 1].step };
  }
  /* 任务名：优先模型写的题名（概括这条支干成了什么）；还没有题名的旧账本才退到
     支头原话——那是截段，标得出来源，不许冒充总结。 */
  function taskName(t) {
    // 只认模型写的任务题名。没有题名时不要拿支头原话顶上去——那是截断，不是名字。
    return t && t.sumTitle ? t.sumTitle : '';
  }
  /* 这一块"做成了什么"：先认已证增量（p.solved 已经挑过一条和块名不同的），没有就退到
     块内最后一句回复原话（规则层摘的第一句，basis=reconstructed），两样都没有就明说没有——
     这一段只有工具动作，效果得回原文自己看。 */
  function effectOf(p) {
    if (p.solvedFrom && p.solvedFrom !== 'outs') return { basis: 'verified', at: p.solvedFrom, text: clipQuote(stripMd(p.solved), 140) };
    for (var i = p.i1; i >= p.i0; i--) {
      var n = S.v.nodes[i];
      if (!n || !n.claim || n.basis === 'unknown') continue;
      var text = stripMd(n.claim);
      if (/^（无回复文本）/.test(text)) continue;
      return { basis: n.basis, at: n.id, text: clipQuote(text, 140) };
    }
    return null;
  }

  /* 块右栏里的阶段入口：从"这一块"跳到"这一程"。阶段没了（外挂表被改）就不长这个按钮。 */
  function phaseLink(n, p) {
    var ph = phaseByN(n);
    if (ph) {
      var b = el('button', 'ilink', '阶段 ' + ph.n + '「' + (ph.short || '') + '」');
      b.type = 'button';
      b.title = '第 ' + ph.from + '–' + ph.to + ' 步：点开看这一阶段的六格说明';
      b.addEventListener('click', function () { showPhase(ph); });
      return b;
    }
    if (p && p.isTail && S.tail) {
      var t = el('button', 'ilink', S.tail.whole
        ? '未划阶段（第 ' + S.tail.from + '–' + S.tail.to + ' 步）'
        : '未划入阶段（尾段 ' + S.tail.from + '–' + S.tail.to + ' 步）');
      t.type = 'button';
      t.title = '这一块在第 ' + S.tail.from + '–' + S.tail.to + ' 步的' + (S.tail.whole ? '未划阶段区间' : '尾段') + '里，还没有阶段说明；点开看事实与补写命令';
      t.addEventListener('click', function () { showTail({ n: 'T', from: S.tail.from, to: S.tail.to, tail: true }); });
      return t;
    }
    return null;
  }

  function inspectPhase(ph) {
    inspbody.textContent = '';
    var head = el('div', 'ihead');
    head.appendChild(el('b', 'iid', '阶段 ' + ph.n));
    head.appendChild(el('span', 'lvpill lv' + ph.level, LV[ph.level]));
    inspbody.appendChild(head);
    inspbody.appendChild(el('div', 'ititle', '第 ' + ph.from + (ph.to === ph.from ? '' : '–' + ph.to) + ' 步 · ' + (ph.short || '（没有短名）')));

    inspbody.appendChild(sec('这一阶段的事实（账本复算）'));
    inspbody.appendChild(factRow('范围', '第 ' + ph.from + '–' + ph.to + ' 步 · 块 ' + ph.fromBlock + '–' + ph.toBlock + ' · ' + ph.span));
    inspbody.appendChild(factRow('计数',
      ph.blocks + ' 块' + (ph.side ? '（含插曲 ' + ph.side + '）' : '') + ' · ' + ph.segs.length + ' 段 · 已证 ' + ph.verified + ' · 写出 ' + ph.wrote
      + (ph.open ? ' · 留问 ' + ph.open : '') + (ph.errs ? ' · 报错 ' + ph.errs : '')
      + (ph.decisions ? ' · 决策 ' + ph.decisions : '') + (ph.ruledOut ? ' · 排除 ' + ph.ruledOut : '')
      + ' · 规则 ' + ph.rules.length));

    inspbody.appendChild(sec('六格（模型写 · 归纳 · 不过六条判据）'));
    inspbody.appendChild(factRow('进行的是什么', ph.doing, true));
    inspbody.appendChild(factRow('完成进度', ph.state, true));
    inspbody.appendChild(factRow('完成效果', ph.effect, true));

    var planCell = document.createDocumentFragment();
    if (ph.plan === '—') planCell.appendChild(el('span', 'imuted', '这一阶段没有可引用的文档章节（不编）'));
    else planCell.appendChild(el('div', '', ph.plan));
    var trackCell = document.createDocumentFragment();
    if (ph.track === '—') trackCell.appendChild(el('span', 'imuted', '这一阶段没有可引用的进度文件章节（不编）'));
    else trackCell.appendChild(el('div', '', ph.track));
    /* 两格共用同一份 refs：各贴一遍会读成"两组出处"，只贴一处；plan 没有可引时落到 progress 那格。 */
    var chipHost = ph.plan === '—' ? trackCell : planCell;
    if (ph.refs.length) chipHost.appendChild(phaseRefChips(ph.refs));
    inspbody.appendChild(factRow('对照 PRD·plan', planCell, true));
    inspbody.appendChild(factRow('progress 文件', trackCell, true));

    var rules = el('div');
    if (!ph.rules.length) rules.appendChild(el('span', 'imuted', '本阶段没有过判据的规则'));
    else ph.rules.forEach(function (r) {
      var line = el('div', 'irule');
      line.appendChild(el('b', '', r.id));
      line.appendChild(document.createTextNode(r.text));
      rules.appendChild(line);
    });
    inspbody.appendChild(factRow('规则', rules, true));
    // 阶段经验：这一程各块综述里的 lesson 收在一处；没有就如实说 0 条。
    var lessons = S.parts.filter(function (p) { return p.phase === ph.n && p.sum && p.sum.lesson; });
    var exp = el('div');
    if (!lessons.length) exp.appendChild(el('span', 'imuted', '这一程还没有块写过 lesson（写综述时填 lesson 即可）'));
    else lessons.forEach(function (p) {
      var line = el('div', 'irule');
      line.appendChild(el('b', '', '块 ' + p.i));
      line.appendChild(document.createTextNode(p.sum.lesson + (p.sum.need ? '（当时的要求：' + p.sum.need + '）' : '')));
      exp.appendChild(line);
    });
    inspbody.appendChild(factRow('这一程的经验', exp, true));
    inspbody.appendChild(el('div', 'isrc', '模型说明（归纳，不过六条判据） · 写于 '
      + String(ph.at || '').slice(0, 16).replace('T', ' ') + '；核对面是图上的块'));

    inspbody.appendChild(sec('图上'));
    var acts = el('div', 'iacts');
    var go = el('button', 'ibtn primary', '定位到第 ' + ph.from + ' 步');
    go.type = 'button';
    go.addEventListener('click', function () {
      var p = S.parts.filter(function (q) { return q.step === ph.from; })[0];
      if (!p) return;
      rememberCam();
      setTier('near');
      showPart(p);
      centerOn(p, Math.max(1.02, S.tgt.z));
      markSel();
    });
    acts.appendChild(go);
    inspbody.appendChild(acts);
  }

  /* 章的接手页：九格逐字，顺序与 `convledger handoff` 一致。这一页的存在理由就是
     "读完这一段，不用回头看那 60 步"，所以不复述阶段六格，只列阶段号让人跳过去。 */
  var CHAP_CELLS = [['goal', '一开始的目的'], ['where', '走到哪'], ['rules', '核心规则与原则'],
    ['tasks', '主要任务'], ['walls', '碰过的壁'], ['cautions', '接下来要注意'],
    ['arch', '架构现状'], ['handoff', '怎么接手']];
  function inspectChapter(c) {
    inspbody.textContent = '';
    var head = el('div', 'ihead');
    head.appendChild(el('b', 'iid', '章 ' + c.n));
    head.appendChild(el('span', 'lvpill', c.phaseSpan + ' · ' + c.phaseCount + ' 程'));
    inspbody.appendChild(head);
    inspbody.appendChild(el('div', 'ititle', '第 ' + c.from + '–' + c.to + ' 步 · ' + (c.short || '（没有章名）')));

    inspbody.appendChild(sec('这一大块的事实（账本复算）'));
    inspbody.appendChild(factRow('范围', '第 ' + c.from + '–' + c.to + ' 步 · 块 ' + c.fromBlock + '–' + c.toBlock + ' · ' + c.span));
    inspbody.appendChild(factRow('计数',
      c.blocks + ' 块' + (c.side ? '（含插曲 ' + c.side + '）' : '') + ' · ' + c.segs.length + ' 段 · 已证 ' + c.verified
      + ' · 写出 ' + c.wrote + (c.open ? ' · 留问 ' + c.open : '') + (c.errs ? ' · 报错 ' + c.errs : '')
      + ' · 规则 ' + (c.ruleMoves || []).length));

    inspbody.appendChild(sec('接手那一页（模型写 · 归纳 · 不过六条判据）'));
    CHAP_CELLS.forEach(function (x) {
      var val = c[x[0]] || '—';
      inspbody.appendChild(factRow(x[1], val === '—' ? el('span', 'imuted', '这一格没有源（不编）') : val, true));
    });
    inspbody.appendChild(el('div', 'isrc', '模型说明（归纳，不过六条判据） · 写于 '
      + String(c.at || '').slice(0, 16).replace('T', ' ') + '；要更深就点下面的阶段牌，或按块回原文'));

    inspbody.appendChild(sec('这一章里的每一程'));
    var rows = el('div');
    S.phases.filter(function (p) { return p.from >= c.from && p.to <= c.to; }).forEach(function (p) {
      var b = el('button', 'ilink', '阶段 ' + p.n + '「' + (p.short || '') + '」· 第 ' + p.from + '–' + p.to + ' 步');
      b.type = 'button';
      b.title = '点开看这一程的六格说明';
      b.addEventListener('click', function () { showPhase(p); });
      rows.appendChild(b);
    });
    inspbody.appendChild(rows);

    inspbody.appendChild(sec('图上'));
    var acts = el('div', 'iacts');
    var go = el('button', 'ibtn primary', '定位到第 ' + c.from + ' 步');
    go.type = 'button';
    go.addEventListener('click', function () {
      var p = S.parts.filter(function (q) { return q.step === c.from; })[0];
      if (!p) return;
      rememberCam();
      setTier('near');
      showPart(p);
      centerOn(p, Math.max(1.02, S.tgt.z));
      markSel();
    });
    acts.appendChild(go);
    var cp = el('button', 'ibtn', '复制 handoff');
    cp.type = 'button';
    cp.title = '复制这一章的接手页（与 convledger handoff ' + c.n + ' 同一份文本），粘给新会话';
    cp.addEventListener('click', function () { copyHandoff(c.n, cp); });
    acts.appendChild(cp);
    inspbody.appendChild(acts);
  }
  /* 复制不了就如实说复制不了：剪贴板在非安全上下文或被拒时会失败，
     按钮换成"再点一次选中文字"比静默成功诚实。 */
  function copyHandoff(n, btn) {
    fetch(BASE + '/handoff?chapter=' + n, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (text) {
        var done = function () { btn.textContent = '已复制 ✓'; };
        var bail = function () { showHandoffText(text, btn); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, bail);
        } else bail();
      })
      .catch(function () { btn.textContent = '复制失败：拿不到接手页'; });
  }
  function showHandoffText(text, btn) {
    btn.textContent = '剪贴板不可用：已选中，请自己复制';
    var box = inspbody.querySelector('.chtext');
    if (!box) {
      box = el('pre', 'chtext', text);
      inspbody.appendChild(box);
    }
    var range = document.createRange();
    range.selectNodeContents(box);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function phaseRefChips(refs) {
    var box = el('div', 'rchips');
    refs.forEach(function (r) {
      var c = el('span', 'rchip', r.f.split('/').pop() + ' › ' + r.h);
      c.title = r.f + ' › ' + r.h + '（写入阶段时按文档清单解析；文档后改不回溯）';
      box.appendChild(c);
    });
    return box;
  }

  function inspectPart(p) {
    inspbody.textContent = '';
    var head = el('div', 'ihead');
    head.appendChild(el('b', 'iid', p.step == null ? ('块 ' + pad2(p.i) + '（插曲）') : ('第 ' + p.step + ' 步 · 块 ' + pad2(p.i))));
    head.appendChild(el('span', 'lvpill lv' + p.level, LV[p.level]));
    inspbody.appendChild(head);
    inspbody.appendChild(el('div', 'ititle', p.gist || p.mark || '（这一块没有原话）'));

    inspbody.appendChild(sec('这一块做了什么'));

    var t = p.dominant ? S.tasks[p.dominant] : null;
    var nq = taskName(t);
    var act = p.sum ? p.sum.title : (p.gist || p.mark || '');
    var who = el('span');
    who.appendChild(el('b', 'itask', (p.step == null ? '插曲任务 · ' : '主线任务 · ') + (t ? t.id : '—')));
    if (nq) who.appendChild(document.createTextNode(' 「' + nq + '」'));
    else if (t) who.appendChild(document.createTextNode('（任务未命名）'));
    if (act) who.appendChild(document.createTextNode(' · 这一步在做「' + act + '」'));
    inspbody.appendChild(factRow('任务', who));

    if (p.step == null) {
      // 阶段入口并进"夹在哪"这一格：五问仍是五行，不多长一行出来。
      var btw = el('span');
      btw.appendChild(document.createTextNode(betweenText(p)));
      var pv = phaseLink(p.phase, p);
      if (pv) {
        btw.appendChild(document.createTextNode(' · '));
        btw.appendChild(pv);
      }
      inspbody.appendChild(factRow('夹在哪', btw));
    } else {
      var st = taskStage(p);
      var stageCell = el('span');
      stageCell.appendChild(document.createTextNode('第 ' + p.step + ' 步 / 共 ' + (S.v.mainSteps || 0) + ' 步'
        + (st ? ' · 这条任务的第 ' + st.k + ' 块 / 共 ' + st.m + ' 块（第 ' + st.lo + (st.lo === st.hi ? '' : '–' + st.hi) + ' 步）' : '')));
      var pl = phaseLink(p.phase, p);
      if (pl) {
        stageCell.appendChild(document.createTextNode(' · '));
        stageCell.appendChild(pl);
      }
      inspbody.appendChild(factRow('阶段', stageCell));
    }

    // 后三行：我的要求 / 经验 / 做成什么。原话在上面一行与「原文」里，不在这里重复。
    if (p.sum) {
      inspbody.appendChild(factRow('我的要求', p.sum.need || p.sum.said || '（这条综述没写「要求」，按原文核对）'));
      inspbody.appendChild(factRow('经验', p.sum.lesson || '这块没有单列可复用的经验'));
      inspbody.appendChild(factRow('做成什么', p.sum.done));
      inspbody.appendChild(el('div', 'isrc', '模型综述（归纳，不过六条判据） · 依据 ' + (p.sumFrom || p.span) + '；「我的要求」旧综述回落到「你说」摘要，核对面是下面的原文'));
    } else {
      // 没写综述：正文给这一块的对话截断（用户真人原话），但明确标注「待补综述」，不空着。
      var askRaw = (p.say && String(p.say).trim()) ? String(p.say).trim() : '';
      inspbody.appendChild(factRow('我的要求', askRaw ? (askRaw.length > 140 ? askRaw.slice(0, 140) + '…' : askRaw) : '（这块里没有真人提问）'));
      inspbody.appendChild(factRow('经验', '（这块没有单列可复用的经验）'));
      var files = p.files || [];
      inspbody.appendChild(factRow('做成什么', files.length
        ? '改了' + cnJoin(kindList(files)) + '（共 ' + files.length + ' 个文件）'
        : p.wrote ? '写出 ' + p.wrote + ' 件产物' : '没有写出文件，只读了东西或跑了命令'));
      inspbody.appendChild(el('div', 'isrc', '待补综述 · 以上「我的要求」是原文截断；收尾时 agent 读完素材写综述，写完这里会换成综述'));
    }

    var spec = p.segIds.length > 1 ? (p.segIds[0] + '-' + p.segIds[p.segIds.length - 1]) : (p.segIds[0] || p.from);
    inspbody.appendChild(sec('原文'));
    var bodyHost = el('div', 'ibodyhost');
    var bb = el('button', 'ibtn primary', '查看原文');
    bb.type = 'button';
    bb.dataset.label = '查看原文';
    bb.title = '按锚点现读源日志（' + spec + '），不缓存、不进 data.json';
    bb.addEventListener('click', function () { bodyBlock(spec, bodyHost, bb); });
    inspbody.appendChild(bb);
    inspbody.appendChild(bodyHost);
  }

  function renderInspector() {
    if (!S.sel) return;
    if (S.sel.kind === 'seg') {
      var n = nodeById(S.sel.id);
      if (!n) { closeInsp(); return; }
      inspectSeg(n);
    } else if (S.sel.kind === 'part') {
      var p = S.parts.filter(function (q) { return q.from === S.sel.from; })[0];
      if (!p) { closeInsp(); return; }
      inspectPart(p);
    } else if (S.sel.kind === 'phase') {
      var ph = phaseByN(S.sel.n);
      if (!ph) { closeInsp(); return; }
      inspectPhase(ph);
    } else if (S.sel.kind === 'chapter') {
      var chh = chapByN(S.sel.n);
      if (!chh) { closeInsp(); return; }
      inspectChapter(chh);
    }
    markSel();
  }

  function showPart(p) {
    S.sel = { kind: 'part', from: p.from };
    insp.hidden = false;
    stage.classList.add('insp');
    renderInspector();
    updateMMVP();
    renderAsk();
  }

  function selectSeg(id) {
    if (!nodeById(id)) return;
    S.sel = { kind: 'seg', id: id };
    insp.hidden = false;
    stage.classList.add('insp');
    renderInspector();
    updateMMVP();
    renderAsk();
  }

  /* 推近之前记的镜头：Esc / 关闭右栏时还回去。这是"点开一块之后回得到原处"的唯一依据。 */
  function restoreCam() {
    if (!S.before) return;
    var b = S.before, tier = b.tier;
    S.before = null;
    setCam(b.x, b.y, b.z, true);
    // 档位也可能是程序钉上去的（fit 的「中景」）：只还坐标，钉过的档会在缩回去的路上丢。
    if (tier) whenSettled(function () { setTier(tier); });
  }

  /* silent＝程序性关闭（换选中、数据刷新重排）不动镜头；人按的 Esc 才还原。 */
  function closeInsp(silent) {
    insp.hidden = true;
    stage.classList.remove('insp');
    S.sel = null;
    document.querySelectorAll('.seg.on').forEach(function (x) { x.classList.remove('on'); });
    document.querySelectorAll('.phl.on').forEach(function (x) { x.classList.remove('on'); });
    document.querySelectorAll('#wires path[data-band].on, #wires path[data-chap].on').forEach(function (x) { x.classList.remove('on'); });
    S.parts.forEach(function (q) { if (q.el) q.el.classList.remove('on'); });
    if (!silent && S.before) restoreCam();
    updateMMVP();
  }

  $('inspx').addEventListener('click', closeInsp);

  /* ---------- pointer: pan / zoom ---------- */
  stage.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    // 浮层里各有自己的点击：一旦这里抓住指针，click 会被重定向到 stage，按钮就再也收不到事件
    if (e.target.closest('.p, #bands, #insp, #minimap, #legend, #hintbar, #askbar, #rowhint, #chapnote, #hits, header')) return;
    e.preventDefault();
    S.pan = { id: e.pointerId, x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, vx: 0, vy: 0, last: performance.now(), moved: false };
    S.glide = null;
    S.tgt.x = S.cam.x; S.tgt.y = S.cam.y; S.tgt.z = S.cam.z;
    try { stage.setPointerCapture(e.pointerId); } catch (_) { /* synthetic */ }
    stage.classList.add('grabbing');
  });
  stage.addEventListener('pointermove', function (e) {
    var p = S.pan;
    if (!p || e.pointerId !== p.id) return;
    var now = performance.now(), dt = Math.max(1, now - p.last);
    var dx = e.clientX - p.lx, dy = e.clientY - p.ly;
    if (Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y) > 3) p.moved = true;
    S.cam.x += dx; S.cam.y += dy;
    S.tgt.x = S.cam.x; S.tgt.y = S.cam.y;
    p.vx = 0.75 * p.vx + 0.25 * (dx / dt * 16);
    p.vy = 0.75 * p.vy + 0.25 * (dy / dt * 16);
    p.lx = e.clientX; p.ly = e.clientY; p.last = now;
    applyCam();
    S.mmDirty = true;
    drawMM();
  });
  function endPan(e) {
    var p = S.pan;
    if (!p || e.pointerId !== p.id) return;
    S.pan = null;
    stage.classList.remove('grabbing');
    if (p.moved && Math.hypot(p.vx, p.vy) > 0.9) S.glide = { x: p.vx, y: p.vy };
    else if (!p.moved) closeInsp();
    if (S.pending) { var v = S.pending; S.pending = null; adopt(v, false); }
  }
  stage.addEventListener('pointerup', endPan);
  stage.addEventListener('pointercancel', endPan);

  stage.addEventListener('wheel', function (e) {
    if (e.target.closest('#insp, #askbar')) return;
    e.preventDefault();
    var r = stage.getBoundingClientRect();
    var f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.04 : 0.0014));
    zoomAt(e.clientX - r.left, e.clientY - r.top, S.tgt.z * f);
  }, { passive: false });

  stage.addEventListener('dblclick', function (e) {
    if (e.target.closest('.p, #bands, #insp, #minimap, #chapnote, #hits')) return;
    fit(true);
  });

  /* ---------- header controls ---------- */
  $('fit').addEventListener('click', function () { fit(true); });
  $('now').addEventListener('click', goNow);

  /* ---------- 底部续做框（PRD-parts §六 通道 A） ----------
     页面发不出消息到宿主聊天，所以这里只做一件事：把一句话连同块号与起点写进
     requests.jsonl。人再在宿主里说一句「按地图里提的做」，agent 读 pending，
     从那一块接着做——不是从末步。 */
  var ask = $('ask'), askto = $('askto'), asknote = $('asknote'), asksend = $('asksend');
  function askPart() {
    if (S.sel && S.sel.kind === 'part') return S.parts.filter(function (q) { return q.from === S.sel.from; })[0] || null;
    if (S.sel && S.sel.kind === 'seg') return partBySeg(S.sel.id);
    // 选中一个阶段时，"接着做"从这一阶段第一块起——不是从末步，也不是从阶段中间。
    if (S.sel && S.sel.kind === 'phase') {
      var ph = phaseByN(S.sel.n);
      if (ph) return S.parts.filter(function (q) { return q.i === ph.fromBlock; })[0] || null;
    }
    return S.parts[S.parts.length - 1] || null;
  }
  function renderAsk() {
    var p = askPart();
    var pending = S.v && S.v.meta ? (S.v.meta.requestsPending || 0) : 0;
    askto.textContent = (p ? (p.step == null ? '插曲块 ' : '第 ' + p.step + ' 步 · 块 ') + p.i : '没有块')
      + (pending ? ' · 待做 ' + pending : '');
    askto.title = p ? ('这条请求带上块 ' + p.i + ' 与起点 ' + p.from + '；agent 读 requests 时从这一块接着做，不是从末步') : '';
    askto.classList.toggle('none', !p);
  }
  function sendAsk() {
    var text = ask.value.trim();
    if (!text) { asknote.textContent = '先写一句话'; asknote.className = 'bad'; return; }
    var p = askPart();
    asksend.disabled = true;
    fetch(BASE + '/request', {
      method: 'POST', cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ part: p ? p.step : null, from: p ? p.from : '', text: text })
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        asksend.disabled = false;
        if (!res.ok || !res.j.ok) {
          asknote.textContent = (res.j.errors || ['写入失败']).join(' · ');
          asknote.className = 'bad';
          return;
        }
        ask.value = '';
        asknote.className = 'ok';
        asknote.textContent = '✓ ' + res.j.request.id + ' 已写入 requests.jsonl · 在宿主里说：按地图里提的做';
        refreshSoon();
        setTimeout(function () { asknote.textContent = ''; }, 15000);
      })
      .catch(function (e) { asksend.disabled = false; asknote.textContent = '写不进去：' + e.message; asknote.className = 'bad'; });
  }
  asksend.addEventListener('click', sendAsk);
  ask.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); sendAsk(); }
  });

  function setTheme(t) {
    document.body.dataset.theme = t;
    try { localStorage.setItem('atlas-theme', t); } catch (_) { /* file:// or blocked */ }
    // 阶段括号与标签的颜色按主题算（浅色下要更深），换主题得重画一遍。
    if (S.parts.length) { drawWires(); buildBands(); }
    S.mmDirty = true;
    drawMM();
  }
  $('theme').addEventListener('click', function () {
    setTheme(document.body.dataset.theme === 'dark' ? 'light' : 'dark');
  });
  try {
    var savedTheme = localStorage.getItem('atlas-theme');
    if (savedTheme === 'light') document.body.dataset.theme = 'light';
  } catch (_) { /* ignore */ }

  find.addEventListener('input', function () { S.q = find.value; applySearch(); });
  find.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      cycleHit(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      find.value = ''; S.q = ''; applySearch(); find.blur();
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var k = e.key.toLowerCase();
    if (k === 'f' || k === '0') { e.preventDefault(); fit(true); }
    else if (k === 'n') { e.preventDefault(); goNow(); }
    else if (k === 'l') { e.preventDefault(); libToggle(); }
    else if (k === 'escape') {
      if (!insp.hidden) closeInsp();
      else if (S.before) restoreCam();
      else { find.value = ''; S.q = ''; applySearch(); }
    }
    else if (k === '+' || k === '=') { e.preventDefault(); zoomAt(viewW() / 2, stage.clientHeight / 2, S.tgt.z * 1.18); }
    else if (k === '-' || k === '_') { e.preventDefault(); zoomAt(viewW() / 2, stage.clientHeight / 2, S.tgt.z / 1.18); }
    else if (k === 'arrowleft') { e.preventDefault(); panBy(90, 0); }
    else if (k === 'arrowright') { e.preventDefault(); panBy(-90, 0); }
    else if (k === 'arrowup') { e.preventDefault(); panBy(0, 90); }
    else if (k === 'arrowdown') { e.preventDefault(); panBy(0, -90); }
  });

  function panBy(dx, dy) {
    S.tgt.x += dx; S.tgt.y += dy;
    S.glide = null;
  }

  /* ---------- loop ---------- */
  var lastT = performance.now();
  function frame(now) {
    var dt = Math.min(64, Math.max(1, now - lastT));
    lastT = now;
    var moving = false;

    if (S.glide && !S.pan) {
      var k = Math.pow(0.90, dt / 16);
      S.cam.x += S.glide.x * dt / 16;
      S.cam.y += S.glide.y * dt / 16;
      S.tgt.x = S.cam.x; S.tgt.y = S.cam.y;
      S.glide.x *= k; S.glide.y *= k;
      if (Math.hypot(S.glide.x, S.glide.y) < 0.06) S.glide = null;
      moving = true;
    }

    if (!S.pan) {
      var ease = 1 - Math.pow(0.72, dt / 16);
      var dx = S.tgt.x - S.cam.x, dy = S.tgt.y - S.cam.y, dz = S.tgt.z - S.cam.z;
      if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05 || Math.abs(dz) > 0.0004) {
        S.cam.x += dx * ease;
        S.cam.y += dy * ease;
        S.cam.z += dz * ease;
        moving = true;
      } else if (dx !== 0 || dy !== 0 || dz !== 0) {
        S.cam.x = S.tgt.x; S.cam.y = S.tgt.y; S.cam.z = S.tgt.z;
        moving = true;
      }
    }

    if (moving) {
      applyCam();
      if (S.mmDirty) drawMM();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /* ---------- data load / live ---------- */
  function renderMeters() {
    var v = S.v;
    if (!v) return;
    var c = {};
    (v.brief && v.brief.counts || []).forEach(function (x) { c[x.k] = x.v; });
    var bits = [
      ['段', v.meta.segs],
      // 没写过章时这一格不出现：0 不是"这一层还没写"，看着像"这会话没有大块"。
      (v.chapters || []).length ? ['章', v.chapters.length] : null,
      ['阶段', (v.phases || []).length],
      ['支', v.meta.taskBranches],
      ['插曲', c['插曲']],
      ['已证', c['已证'] || v.meta.verified],
      ['压缩', c['压缩'] || v.meta.boundaries]
    ].filter(Boolean);
    meters.textContent = '';
    bits.forEach(function (b) {
      var s = el('span', 'mt');
      s.appendChild(document.createTextNode(b[0]));
      s.appendChild(el('b', '', b[1] == null ? '—' : b[1]));
      meters.appendChild(s);
    });
  }

  function live(text, ok, tip, refreshing) {
    liveEl.textContent = text;
    liveEl.title = tip || text;
    liveEl.className = 'live ' + (ok ? 'ok' : 'bad') + (refreshing ? ' refreshing' : '');
  }

  /* 后台正在重算时，这行换成转圈＋「正在更新最新信息」；算完回到「已同步 · 落后 N 秒」。
     圈是 CSS 画的，不吃点击，前台交互一刻不停（PRD-refresh）。 */
  function liveSync(m) {
    var rf = !!(m && m.refreshing);
    live(rf ? '正在更新最新信息' : freshLine(m), true, freshTitle(m), rf);
  }

  /* 这段画布的身份：谁（runner）、哪个模型、在哪、哪段会话、什么时候、正文有没有归档。
     一张画布只服务一段会话，这几格就是把「哪段」钉在屏幕上，看错图之前先看错这里。 */
  var RUNNER_LABEL = { qoder: 'Qoder', workbuddy: 'WorkBuddy', 'claude-code': 'Claude Code', opencode: 'OpenCode' };
  // 宿主日志存的是内部代号；按 Qoder 自己的文案表翻成可读名称，未知代号原样保留。
  var MODEL_LABEL = {
    qfmodel: 'Qwen3.8-Flash', qmodel: 'Qwen3.7-Plus',
    dfmodel: 'DeepSeek-Flash', dmodel: 'DeepSeek-V4-Pro',
    smodel: 'Sonus', cmodel: 'Cantus',
    gfmodel: 'GLM-5.3-Flash', gmodel: 'GLM-5.3',
    kmodel: 'Kimi-K2.8-Preview', mmodel: 'MiniMax-M3.1-Flash'
  };
  function modelLabel(id) {
    var k = String(id ?? '');
    return MODEL_LABEL[k] || k;
  }
  function shortBytes(n) {
    n = n || 0;
    if (n >= 1048576) return (n / 1048576).toFixed(1) + 'MB';
    if (n >= 1024) return (n / 1024).toFixed(0) + 'KB';
    return n + 'B';
  }
  function clockOf(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function renderWho(v) {
    var m = (v && v.meta) || {};
    whoEl.textContent = '';
    whoEl.appendChild(el('span', 'run', RUNNER_LABEL[m.runner] || m.runner || '—'));
    if (m.models && m.models.length) {
      var ids = m.models.slice(0, 2);
      // 当前模型不在前两个时也要让它出现：它比历史模型更值得占一格。
      if (m.model && m.models.indexOf(m.model) >= 0 && ids.indexOf(m.model) < 0) ids = [m.model].concat(ids.slice(0, 1));
      var mbox = el('span', 'models');
      ids.forEach(function (id, i) {
        if (i) mbox.appendChild(document.createTextNode(' / '));
        var cur = !!m.model && id === m.model;
        var s = el('span', 'mname' + (cur ? ' cur' : ''), modelLabel(id));
        s.title = (cur ? '当前模型' : '本会话用过的模型') + '（代号 ' + id + '）';
        if (cur) s.appendChild(el('i', 'mtag', '当前'));
        mbox.appendChild(s);
      });
      whoEl.appendChild(mbox);
    }
    var cwd = String(m.cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
    var c = el('span', 'cwd', cwd ? cwd.split('/').slice(-2).join('/') : '—');
    c.title = cwd || '源日志没记工作目录';
    whoEl.appendChild(c);
    whoEl.appendChild(el('span', 'sep', '·'));
    whoEl.appendChild(el('span', '', String(m.session || '').slice(0, 8)));
    var t0 = clockOf(m.startedAt), t1 = clockOf(m.endedAt);
    // 同一天才省掉结束日期；跨天的会话把日期一起写出来——"10-23 08:38–10:34"
    // 会让人以为是同一天早上，实际可能隔了五天。
    var span = t0 ? (t1 && t1 !== t0 ? t0 + '–' + (t1.slice(0, 5) === t0.slice(0, 5) ? t1.slice(6) : t1) : t0) : '时间未记';
    var spanEl = el('span', '', span);
    spanEl.title = '首条消息 → 最近一条消息（含空闲；本机时区）';
    whoEl.appendChild(el('span', 'sep', '·'));
    whoEl.appendChild(spanEl);
    var a = m.archive || {};
    var arc = el('span', 'arc' + (a.bytes ? '' : ' none'), a.bytes ? '归档 ' + shortBytes(a.bytes) : '未归档');
    arc.title = a.bytes
      ? '源日志被运行器清掉后，正文仍从账本回源（同步于 ' + (a.syncedAt || '?') + '）'
      : '画布服务这段会话期间每 20 秒自动归档；也可以 convledger archive';
    whoEl.appendChild(arc);
  }

  function adopt(v, first) {
    S.v = v;
    var bs = document.getElementById('bootskel');
    if (bs) bs.remove();
    // 会话画布 → 项目工作台：项目键由服务端按 cwd 算（和 /projects.json 同一把尺），没有就不显示入口。
    var pl = document.getElementById('projpage');
    if (pl) {
      var pk = v.meta && v.meta.projectKey;
      if (pk) { pl.hidden = false; pl.href = '/p/' + pk + '/?from=' + encodeURIComponent(location.pathname + location.hash); }
      else pl.hidden = true;
    }
    S.idx = {};
    v.nodes.forEach(function (n, i) { S.idx[n.id] = i; });
    S.tasks = {};
    v.tasks.forEach(function (t) { S.tasks[t.id] = t; });
    S.phases = v.phases || [];
    S.chapters = v.chapters || [];
    // 章表一变（改写、失效回落），笔记要按新表重印一份，不能留着旧文字
    S.chapFocus = null;
    S.tail = v.tail || null;
    S.parts = partsOf(v);
    S.pendingN = S.parts.filter(function (q) { return q.pending; }).length;
    if (S.tail) S.parts.forEach(function (p) {
      p.isTail = p.step != null && p.step >= S.tail.from && p.step <= S.tail.to;
    });
    // 列数只在第一次上屏时定：活更新每 20 秒来一次，列数跟着块数变的话，已经看过的块
    // 每来一段就整张图重排一次。视口变了才重选（resize 那一条）。
    if (first) S.cols = chooseCols(S.parts.length);
    layoutParts();
    buildCards();
    buildGroups();
    renderMeters();
    renderWho(v);

    if (S.sel) {
      if (S.sel.kind === 'seg' && !S.idx[S.sel.id]) S.sel = null;
      if (S.sel.kind === 'part' && !S.parts.some(function (q) { return q.from === S.sel.from; })) S.sel = null;
      if (S.sel.kind === 'phase' && !S.phases.some(function (x) { return x.n === S.sel.n; })) S.sel = null;
      if (S.sel && S.sel.kind === 'chapter' && !S.chapters.some(function (x) { return x.n === S.sel.n; })) S.sel = null;
      if (S.sel) renderInspector(); else closeInsp(true);
    }
    applySearch();
    S.sig = sigOf(v);
    if (first) { fit(false); if (!applyHashZoom()) openLatest(); }
    applyCam();
    drawWires();
    S.mmDirty = true;
    drawMM();
    renderAsk();
    liveSync(v.meta);
  }

  /* 「已同步」这行只留最要紧的两段；完整构建时间放在悬停提示里，
     证明它离源有多远：N＝取数时源最后写入与账本构建之差。 */
  function freshLine(m) {
    if (typeof m.lagSec === 'number') return '已同步 · 落后 ' + m.lagSec + ' 秒';
    if ('lagSec' in m) return '已同步 · 源不可读';
    return '已同步';
  }
  function freshTitle(m) {
    return '已同步 · 账本构建 ' + localWhen(m.builtAt || m.built)
      + (typeof m.lagSec === 'number' ? ' · 落后 ' + m.lagSec + ' 秒' : ('lagSec' in m ? ' · 源不可读' : ''));
  }

  /* 账本时间戳是 ISO(UTC)；直接印出来会让人以为页面停在了几小时前。
     显示本地时间并带秒——「已同步」这一行本身要能证明它还在动。 */
  function localWhen(s) {
    var d = new Date(String(s || ''));
    if (isNaN(d.getTime())) return String(s || '');
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function poll() {
    fetch(BASE + '/data.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (v) {
        // 未建账会话：后台正在建账（PRD-load）。骨架先顶着，不 adopt 空图；建完自动换真视图。
        if (v.meta && v.meta.building) {
          var bs = document.getElementById('bootskel');
          if (bs) {
            var bl = bs.querySelector('.bslabel'), bh = bs.querySelector('.bshint');
            if (bl) bl.textContent = '正在建账 · 首次打开这段会话…';
            if (bh) bh.textContent = '后台正在为这段会话建账，建完自动换成画布，不用刷新';
          }
          live('正在建账…', true, '后台建账中，前台不阻塞', true);
          return;
        }
        liveSync(v.meta);
        var sig = sigOf(v);
        if (sig === S.sig) return;
        if (S.pan) { S.pending = v; return; }
        if (!S.v) adopt(v, true);
        else adopt(v, false);
      })
      .catch(function () {
        live('离线 · 4 秒后重试', false);
        var bs = document.getElementById('bootskel');
        if (bs && !S.v) {
          var l = bs.querySelector('.bslabel'), h = bs.querySelector('.bshint');
          if (l) l.textContent = '账本一时读不到，4 秒后重试…';
          if (h) h.hidden = true;
        }
      })
      .then(function () { setTimeout(poll, 4000); });
  }

  /* 视口变了才重选列数：这是唯一允许整张图重排的入口（缩放不重排）。
     左栏折叠/拖宽也走这里——stage.clientWidth 变了，列数必须跟着重算。 */
  var rzT = 0;
  function relayoutSoon() {
    clearTimeout(rzT);
    rzT = setTimeout(function () {
      if (!S.parts.length) return;
      S.cols = chooseCols(S.parts.length);
      relayout();
    }, 140);
  }
  window.addEventListener('resize', relayoutSoon);

  /* ---------- 左栏：已导入的会话 ---------- */
  var RAIL_W = 32, LIB_MIN = 150, LIB_MAX = 460, LIB_DEF = 264, RAIL_AT = 110;

  function libApply(save) {
    var rail = S.lib.mode === 'rail';
    var w = rail ? RAIL_W : S.lib.w;
    document.body.classList.toggle('lib-rail', rail);
    libEl.style.width = w + 'px';
    libSplit.style.left = (w - 4) + 'px';
    libBtn.setAttribute('aria-pressed', String(!rail));
    libBtn.title = rail ? '展开会话列表（L）' : '收回成一列状态灯（L）';
    if (save) {
      try {
        localStorage.setItem('atlas-lib-mode', S.lib.mode);
        localStorage.setItem('atlas-lib-w', String(S.lib.w));
      } catch (_) { /* 隐私模式 */ }
    }
    relayoutSoon();
  }

  function libToggle() {
    S.lib.mode = S.lib.mode === 'rail' ? 'full' : 'rail';
    libApply(true);
  }

  /* 拖右边缘：拖到最窄吸附成灯条（不是隐藏），往回拖再展开；双击回到默认宽度。 */
  libSplit.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    S.lib.drag = { x: e.clientX, w: S.lib.mode === 'full' ? S.lib.w : RAIL_W };
    document.body.classList.add('lib-drag');
    try { libSplit.setPointerCapture(e.pointerId); } catch (_) { /* 合成事件没有 pointerId */ }
  });
  libSplit.addEventListener('pointermove', function (e) {
    if (!S.lib.drag) return;
    var nw = Math.max(RAIL_W, Math.min(LIB_MAX, S.lib.drag.w + (e.clientX - S.lib.drag.x)));
    if (nw < RAIL_AT) S.lib.mode = 'rail';
    else { S.lib.mode = 'full'; S.lib.w = Math.max(LIB_MIN, nw); }
    libApply(false);
  });
  function libDragEnd() {
    if (!S.lib.drag) return;
    S.lib.drag = null;
    document.body.classList.remove('lib-drag');
    libApply(true);
  }
  libSplit.addEventListener('pointerup', libDragEnd);
  libSplit.addEventListener('pointercancel', libDragEnd);
  libSplit.addEventListener('dblclick', function () { S.lib.mode = 'full'; S.lib.w = LIB_DEF; libApply(true); });
  libBtn.addEventListener('click', libToggle);

  function agoText(min) {
    if (min == null) return '时间未知';
    if (min < 1) return '刚刚';
    if (min < 60) return min + ' 分钟前';
    if (min < 1440) return Math.round(min / 60) + ' 小时前';
    return Math.round(min / 1440) + ' 天前';
  }

  function libMatch(s, label, q) {
    if (!q) return true;
    return [s.title, s.cwd, s.sid8, s.runner, label].join(' ').toLowerCase().indexOf(q) >= 0;
  }

  function libRow(s, current) {
    var unbuilt = s.built === false;
    var a = el('a', 'librow' + (s.live ? ' is-live' : '') + (s.id === current ? ' current' : '') + (unbuilt ? ' unbuilt' : ''));
    a.href = '/s/' + encodeURIComponent(s.id) + '/';
    var status = s.sourceMissing
      ? '源日志已不在，正文读归档 · 最后同步 ' + agoText(s.idleMin)
      : (s.live ? '进行中' : '没在写') + ' · 最后写入 ' + agoText(s.idleMin);
    a.title = s.title + '\n' + status + '\n' + s.cwd + '\n' + s.sid8 + ' · 标题来自 ' + (s.titleFrom === 'host' ? '桌面端' : s.titleFrom === 'unbuilt' ? '未导入' : s.titleFrom);
    a.appendChild(el('i', 'dot'));
    var lt = el('div', 'lt');
    var tt = el('div', 'ltt');
    tt.appendChild(el('span', 't', s.title));
    if (s.id === current) tt.appendChild(el('span', 'chip', '本页'));
    if (unbuilt) tt.appendChild(el('span', 'chip orgnone', '未导入'));
    var o = s.organize;
    if (o && o.level !== 'none') {
      var oc = el('span', 'chip ' + (o.level === 'full' ? 'orgfull' : 'orgpart'), o.level === 'full' ? '已整理' : '欠 ' + o.gaps);
      oc.title = '模型层写过：块综述 ' + o.sums + '/' + o.blocks + ' · 任务题名 ' + o.titles + '/' + o.titlesOf
        + ' · 阶段 ' + o.phases + ' 段 · 已证增量 ' + o.verified + ' 条'
        + (o.sumsDropped ? ' · 另有 ' + o.sumsDropped + ' 条锚点已失效' : '')
        + '\n判据同 convledger outstanding';
      tt.appendChild(oc);
    }
    lt.appendChild(tt);
    lt.appendChild(el('div', 'lws', '工作区 · ' + (s.workspace || '无')));
    var meta = el('div', 'lmeta');
    meta.appendChild(document.createTextNode(s.sid8 + ' · ' + (unbuilt ? '未建账 · 打开才建' : s.segments + ' 段') + ' · '
      + (s.sourceMissing ? '源已丢 · ' : '') + agoText(s.idleMin)));
    lt.appendChild(meta);
    a.appendChild(lt);
    return a;
  }

  /* agent 分组顺序：拖标题（或 Alt+↑↓）调整，顺序存在本机，会话库与画布共用。 */
  var LIB_ORDER_KEY = 'convledger.groups.order';
  function libOrder() {
    try {
      var a = JSON.parse(localStorage.getItem(LIB_ORDER_KEY));
      return Array.isArray(a) ? a.filter(function (x) { return typeof x === 'string'; }) : [];
    } catch (_) { return []; }
  }
  function libOrdered(groups) {
    var ord = libOrder();
    return groups.slice().sort(function (a, b) {
      var ia = ord.indexOf(a.runner), ib = ord.indexOf(b.runner);
      if (ia < 0) ia = 1e9;
      if (ib < 0) ib = 1e9;
      return ia - ib;
    });
  }
  function libSaveOrder(runners) {
    try { localStorage.setItem(LIB_ORDER_KEY, JSON.stringify(runners)); } catch (_) { /* 隐私模式 */ }
  }
  function libMove(runner, delta) {
    var v = S.lib.v;
    if (!v) return;
    var all = libOrdered(v.groups || []).map(function (g) { return g.runner; });
    var i = all.indexOf(runner);
    if (i < 0) return;
    var j = i + delta;
    if (j < 0 || j >= all.length) return;
    all.splice(i, 1);
    all.splice(j, 0, runner);
    libSaveOrder(all);
    S.lib.drawn = '';
    renderLib();
  }
  var libDrag = null, libReordering = false;

  /* 签名只收「看得见的变化」：id / 绿灰 / 段数 / 标题 / 源丢失 / 5 分钟粒度的时间。 */
  function libSig(v, q) {
    return q + '|' + libOrder().join(',') + '|' + (v.groups || []).map(function (g) {
      return g.runner + ':' + g.sessions.map(function (s) {
        return [s.id, s.live ? 1 : 0, s.segments, s.title, Math.floor((s.idleMin == null ? 0 : s.idleMin) / 5), s.sourceMissing ? 1 : 0,
          s.organize ? s.organize.level : '', s.organize ? s.organize.sums : '', s.organize ? s.organize.gaps : ''].join(':');
      }).join(',');
    }).join('|') + '|' + v.current;
  }

  var LIB_SHOW = 3;
  var AGENT_ICON = {
    qoder: '/agent-icons/qoder.png',
    'claude-code': '/agent-icons/claude-code.png',
    workbuddy: '/agent-icons/workbuddy.png',
    opencode: '/agent-icons/opencode.png',
    codex: '/agent-icons/codex.png',
  };
  function agentMark(runner) {
    var src = AGENT_ICON[runner];
    if (src) {
      var img = el('img', 'agicon');
      img.src = src;
      img.alt = '';
      img.width = 18;
      img.height = 18;
      return img;
    }
    var dot = el('i', 'agdot ' + runner);
    dot.title = '缺图标：' + runner;
    return dot;
  }
  function libOpenSet() {
    try { var a = JSON.parse(localStorage.getItem('convledger.lib.open') || '[]'); return Array.isArray(a) ? a : []; }
    catch { return []; }
  }
  function libToggle(runner) {
    var set = libOpenSet();
    var i = set.indexOf(runner);
    if (i >= 0) set.splice(i, 1); else set.push(runner);
    try { localStorage.setItem('convledger.lib.open', JSON.stringify(set)); } catch { /* 无痕模式 */ }
    S.lib.drawn = '';
    renderLib();
  }

  function renderLib() {
    var v = S.lib.v;
    if (!v) return;
    var q = S.lib.q.trim().toLowerCase();
    var sig = libSig(v, q);
    if (sig === S.lib.drawn) return;
    S.lib.drawn = sig;
    libBody.removeAttribute('aria-busy');
    libBody.textContent = '';
    var open = q ? null : libOpenSet();
    var total = 0, shown = 0;
    var groups = libOrdered(v.groups || []);
    groups.forEach(function (g) { total += g.sessions.length; });
    groups.forEach(function (g) {
      var rows = g.sessions.filter(function (s) { return libMatch(s, g.label, q); });
      if (!rows.length && q) return;
      shown += rows.length;
      var expanded = !!q || !!(open && open.indexOf(g.runner) >= 0);
      var list = rows;
      if (!expanded) {
        list = rows.slice(0, LIB_SHOW);
        // 正在看的那段即使很久，也要留在第一屏
        var cur = rows.find(function (s) { return s.id === v.current; });
        if (cur && list.indexOf(cur) < 0) list = [cur].concat(list).slice(0, LIB_SHOW);
      }
      var box = el('div', 'libgroup');
      box.dataset.runner = g.runner;
      var gh = el('button', 'libgh');
      gh.type = 'button';
      gh.draggable = true;
      gh.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      gh.title = (expanded ? '收起这组' : '展开这组（默认只列最近 ' + LIB_SHOW + ' 段）') + ' · 拖动或用 Alt+↑↓ 调整顺序';
      gh.appendChild(el('span', 'grip'));
      gh.appendChild(agentMark(g.runner));
      gh.appendChild(el('b', null, g.label));
      gh.appendChild(el('span', 'n', q ? rows.length + '/' + g.count : String(g.count)));
      gh.appendChild(el('span', 'chev'));
      gh.addEventListener('click', function () { if (!libReordering) libToggle(g.runner); });
      gh.addEventListener('keydown', function (e) {
        if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
        e.preventDefault();
        libMove(g.runner, e.key === 'ArrowUp' ? -1 : 1);
      });
      gh.addEventListener('dragstart', function (e) {
        libDrag = g.runner;
        libReordering = true;
        try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', g.runner); } catch (_) { /* 旧宿主 */ }
        box.classList.add('reordering');
      });
      gh.addEventListener('dragend', function () {
        libDrag = null;
        box.classList.remove('reordering');
        setTimeout(function () { libReordering = false; }, 0);
      });
      box.addEventListener('dragover', function (e) {
        if (!libDrag || libDrag === g.runner) return;
        e.preventDefault();
        try { e.dataTransfer.dropEffect = 'move'; } catch (_) { /* 旧宿主 */ }
        box.classList.add('dragover');
      });
      box.addEventListener('dragleave', function () { box.classList.remove('dragover'); });
      box.addEventListener('drop', function (e) {
        e.preventDefault();
        box.classList.remove('dragover');
        var from = libDrag;
        libDrag = null;
        if (!from || from === g.runner) return;
        var all = libOrdered(v.groups || []).map(function (x) { return x.runner; });
        all = all.filter(function (r) { return r !== from; });
        var idx = all.indexOf(g.runner);
        var rect = box.getBoundingClientRect();
        if (e.clientY > rect.top + rect.height / 2) idx += 1;
        if (idx < 0) idx = all.length;
        all.splice(idx, 0, from);
        libSaveOrder(all);
        S.lib.drawn = '';
        renderLib();
      });
      box.appendChild(gh);
      list.forEach(function (s) { box.appendChild(libRow(s, v.current)); });
      if (!expanded && rows.length > list.length) {
        var more = el('button', 'libmore', '展开全部 ' + rows.length + ' 条');
        more.type = 'button';
        more.addEventListener('click', function () { libToggle(g.runner); });
        box.appendChild(more);
      } else if (expanded && rows.length > LIB_SHOW) {
        var less = el('button', 'libmore', '收起');
        less.type = 'button';
        less.addEventListener('click', function () { libToggle(g.runner); });
        box.appendChild(less);
      }
      libBody.appendChild(box);
    });
    if (!total) libBody.appendChild(el('div', 'libempty', '还没有账本：在会话里跑一次 convledger map'));
    else if (q && !shown) libBody.appendChild(el('div', 'libempty', '没有匹配的会话'));
    libN.textContent = q ? shown + '/' + total : String(total);
    libFoot.textContent = (v.counts && v.counts.skipped ? v.counts.skipped + ' 本账本读不了 · ' : '')
      + '绿点＝最后写入 ≤' + v.liveMin + ' 分钟 · 点分组名可展开/收起 · 拖右边缘可收成一列状态灯';
  }

  function libPull() {
    fetch(BASE + '/sessions.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (v) { S.lib.v = v; renderLib(); })
      .catch(function (e) {
        if (S.lib.v) return;
        libBody.textContent = '';
        libBody.appendChild(el('div', 'libempty', '会话清单读不到：' + e.message));
      })
      .then(function () { S.lib.timer = setTimeout(libPull, 15000); });
  }

  libFind.addEventListener('input', function () { S.lib.q = libFind.value; renderLib(); });
  libFind.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { libFind.value = ''; S.lib.q = ''; renderLib(); libFind.blur(); }
  });

  (function libInit() {
    var mode = null, w = NaN;
    try { mode = localStorage.getItem('atlas-lib-mode'); w = +(localStorage.getItem('atlas-lib-w') || ''); } catch (_) { /* 隐私模式 */ }
    S.lib.mode = mode === 'rail' || mode === 'full' ? mode : (innerWidth >= 1080 ? 'full' : 'rail');
    S.lib.w = Number.isFinite(w) && w >= LIB_MIN && w <= LIB_MAX ? w : LIB_DEF;
    libApply(false);
  })();
  libPull();

  /* 底部那条操作提示：第一次用有用，第二次起它就是挡在图上的标语。
     动过一次镜头或手动收起后不再占地方（状态记在本机）。 */
  (function hintOnce() {
    var bar = $('hintbar');
    if (!bar) return;
    var off = false;
    try { off = localStorage.getItem('atlas-hint-off') === '1'; } catch (_) { /* 隐私模式 */ }
    if (off) { bar.hidden = true; return; }
    var hide = function () {
      bar.hidden = true;
      try { localStorage.setItem('atlas-hint-off', '1'); } catch (_) { /* 隐私模式 */ }
    };
    addEventListener('wheel', hide, { once: true, passive: true });
    $('stage').addEventListener('pointerdown', function (e) { if (!e.target.closest('#hintbar')) hide(); }, { once: true });
    var x = document.createElement('button');
    x.type = 'button';
    x.textContent = '×';
    x.title = '收起这条提示（刷新后不再出现）';
    x.addEventListener('click', hide);
    bar.appendChild(x);
  })();

  // 首屏占位里先写一句能对上的数：只读 /health（两份 JSON），比 data.json 快得多。
  fetch(BASE + '/health').then(function (r) { return r.json(); }).then(function (h) {
    var l = document.querySelector('#bootskel .bslabel');
    if (!l || !h) return;
    if (h.building) l.textContent = '正在建账 · 首次打开这段会话…';
    else if (h.segments) l.textContent = '正在载入 · ' + h.segments + ' 段';
  }).catch(function () { /* 数拿不到就留原话 */ });
  poll();
})();

// 从项目工作台点「来源会话」进来时，带一条回去的路：只认本工具的 /p/<键>/ 地址，
// 返回时把项目工作台的档位与选中原样带回去（项目页自己从 hash 恢复）。
(function () {
  var from = new URLSearchParams(location.search).get('from');
  if (!from || !/^\/p\/p-[0-9a-f]{12}\/(#.*)?$/.test(from)) return;
  var nav = document.querySelector('header .nav');
  if (!nav) return;
  var a = document.createElement('a');
  a.href = from; a.textContent = '← 返回项目'; a.className = 'back-project';
  a.title = '回到刚才的项目工作台（保留档位与选中）';
  nav.insertBefore(a, nav.firstChild);
})();

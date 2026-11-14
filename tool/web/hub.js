// 会话库：只读 /sessions.json，点一行进 /s/<id>/ 的画布。
// 与 atlas 左栏同一份清单、同一套口径：只列已建账会话，live 只认源日志 mtime。
(function () {
  var list = document.getElementById('list');
  var foot = document.getElementById('foot');
  var q = document.getElementById('q');
  var counts = document.getElementById('counts');
  var orgBtn = document.getElementById('orgf');
  var footText = foot.textContent;
  var drawn = '';
  var last = null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function ago(min) {
    if (min == null) return '时间未知';
    if (min < 1) return '刚刚';
    if (min < 60) return min + ' 分钟前';
    if (min < 1440) return Math.round(min / 60) + ' 小时前';
    return Math.round(min / 1440) + ' 天前';
  }
  var SHOW = 5;
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
  function openSet() {
    try { var a = JSON.parse(localStorage.getItem('convledger.hub.open') || '[]'); return Array.isArray(a) ? a : []; }
    catch { return []; }
  }
  function toggle(runner) {
    var set = openSet();
    var i = set.indexOf(runner);
    if (i >= 0) set.splice(i, 1); else set.push(runner);
    try { localStorage.setItem('convledger.hub.open', JSON.stringify(set)); } catch { /* 无痕模式 */ }
    drawn = '';
    render();
  }

  function match(s, label, needle) {
    if (!needle) return true;
    return [s.title, s.cwd, s.sid8, s.runner, label].join(' ').toLowerCase().indexOf(needle) >= 0;
  }
  // 三档筛：全部 → 只看没整理过（要补的活）→ 只看整理过。判据同 outstanding：模型层写过一样且还有效。
  var ORG_FILTERS = ['all', 'none', 'done'];
  var ORG_LABEL = { all: '全部', none: '只看未整理', done: '只看整理过' };
  var orgFilter = ORG_FILTERS[0];
  function orgOf(s) { return s.organize ? s.organize.level : 'none'; }
  function passOrg(s) {
    if (orgFilter === 'none') return orgOf(s) === 'none';
    if (orgFilter === 'done') return orgOf(s) !== 'none';
    return true;
  }
  var GROUP_ORDER_KEY = 'convledger.groups.order';
  function groupOrder() {
    try {
      var a = JSON.parse(localStorage.getItem(GROUP_ORDER_KEY));
      return Array.isArray(a) ? a.filter(function (x) { return typeof x === 'string'; }) : [];
    } catch (_) { return []; }
  }
  function groupsOrdered(groups) {
    var ord = groupOrder();
    return groups.slice().sort(function (a, b) {
      var ia = ord.indexOf(a.runner), ib = ord.indexOf(b.runner);
      if (ia < 0) ia = 1e9;
      if (ib < 0) ib = 1e9;
      return ia - ib;
    });
  }
  function saveGroupOrder(runners) {
    try { localStorage.setItem(GROUP_ORDER_KEY, JSON.stringify(runners)); } catch (_) { /* 隐私模式 */ }
  }
  function moveGroup(runner, delta) {
    if (!last) return;
    var all = groupsOrdered(last.groups || []).map(function (g) { return g.runner; });
    var i = all.indexOf(runner);
    if (i < 0) return;
    var j = i + delta;
    if (j < 0 || j >= all.length) return;
    all.splice(i, 1);
    all.splice(j, 0, runner);
    saveGroupOrder(all);
    drawn = '';
    render();
  }
  var dragRunner = null, reordering = false;

  function sig(v, needle) {
    return needle + '|' + orgFilter + '|' + groupOrder().join(',') + '|' + (v.groups || []).map(function (g) {
      return g.runner + ':' + g.sessions.map(function (s) {
        var o = s.organize || {};
        return [s.id, s.live ? 1 : 0, s.segments, s.title, Math.floor((s.idleMin == null ? 0 : s.idleMin) / 5),
          s.sourceMissing ? 1 : 0, o.level, o.sums, o.blocks, o.gaps].join(':');
      }).join(',');
    }).join('|');
  }

  function render() {
    var v = last;
    if (!v) return;
    var needle = q.value.trim().toLowerCase();
    var s = sig(v, needle);
    if (s === drawn) return;
    drawn = s;
    list.textContent = '';
    var total = 0, shown = 0;
    var groups = groupsOrdered(v.groups || []);
    groups.forEach(function (g) { total += g.sessions.length; });
    groups.forEach(function (g) {
      var rows = g.sessions.filter(function (x) { return match(x, g.label, needle) && passOrg(x); });
      if (needle && !rows.length) return;
      shown += rows.length;
      var box = el('div', 'group');
      box.dataset.runner = g.runner;
      // 搜索或筛法生效时自动摊开：这时用户要的是那一类清单，折叠成 5 行反而找不到。
      var expanded = !!needle || orgFilter !== 'all' || openSet().indexOf(g.runner) >= 0;
      var shownRows = expanded ? rows : rows.slice(0, SHOW);
      var head = el('button', 'gh');
      head.type = 'button';
      head.draggable = true;
      head.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      head.title = (expanded ? '收起这组' : '展开这组（默认只列最近 ' + SHOW + ' 段）') + ' · 拖动或用 Alt+↑↓ 调整顺序';
      head.appendChild(el('span', 'grip'));
      head.appendChild(agentMark(g.runner));
      head.appendChild(el('b', null, g.label));
      head.appendChild(el('span', 'live', g.live ? g.live + ' 进行中' : ''));
      head.appendChild(el('span', null, rows.length === g.count
        ? g.count + ' 个会话'
        : '筛出 ' + rows.length + ' / 共 ' + g.count + ' 个会话'));
      head.appendChild(el('span', 'orgc', g.count === 1 ? ''
        : (g.organized ? '整理过 ' + g.organized + ' 段' : '这组一段都没整理')));
      head.appendChild(el('span', 'chev'));
      head.addEventListener('click', function () { if (!reordering) toggle(g.runner); });
      head.addEventListener('keydown', function (e) {
        if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
        e.preventDefault();
        moveGroup(g.runner, e.key === 'ArrowUp' ? -1 : 1);
      });
      head.addEventListener('dragstart', function (e) {
        dragRunner = g.runner;
        reordering = true;
        try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', g.runner); } catch (_) { /* 旧宿主 */ }
        box.classList.add('reordering');
      });
      head.addEventListener('dragend', function () {
        dragRunner = null;
        box.classList.remove('reordering');
        setTimeout(function () { reordering = false; }, 0);
      });
      box.addEventListener('dragover', function (e) {
        if (!dragRunner || dragRunner === g.runner) return;
        e.preventDefault();
        try { e.dataTransfer.dropEffect = 'move'; } catch (_) { /* 旧宿主 */ }
        box.classList.add('dragover');
      });
      box.addEventListener('dragleave', function () { box.classList.remove('dragover'); });
      box.addEventListener('drop', function (e) {
        e.preventDefault();
        box.classList.remove('dragover');
        var from = dragRunner;
        dragRunner = null;
        if (!from || from === g.runner) return;
        var all = groupsOrdered(v.groups || []).map(function (x) { return x.runner; });
        all = all.filter(function (r) { return r !== from; });
        var idx = all.indexOf(g.runner);
        var rect = box.getBoundingClientRect();
        if (e.clientY > rect.top + rect.height / 2) idx += 1;
        if (idx < 0) idx = all.length;
        all.splice(idx, 0, from);
        saveGroupOrder(all);
        drawn = '';
        render();
      });
      box.appendChild(head);
      shownRows.forEach(function (x) {
        var unbuilt = x.built === false;
        var a = el('a', 'row' + (x.live ? ' live' : '') + (unbuilt ? ' unbuilt' : ''));
        a.href = '/s/' + encodeURIComponent(x.id) + '/';
        a.title = x.title + '\n' + x.cwd + '\n' + x.sid8 + ' · 标题来自 ' + (x.titleFrom === 'host' ? '桌面端' : x.titleFrom === 'unbuilt' ? '未导入' : x.titleFrom);
        a.appendChild(el('i', 'dot'));
        var lt = el('div', 'lt');
        lt.appendChild(el('div', 'title', x.title));
        lt.appendChild(el('div', 'ws', '工作区 · ' + (x.workspace || '无')));
        lt.appendChild(el('div', 'meta',
          x.sid8 + ' · ' + (unbuilt ? '未建账 · 打开才建' : x.segments + ' 段') + ' · ' + (x.sourceMissing ? '源已丢 · 正文读归档' : '最后写入 ' + ago(x.idleMin))));
        var o = x.organize;
        var chip = el('span', 'org ' + (unbuilt ? 'unbuilt' : (o ? o.level : 'none')));
        if (unbuilt) chip.textContent = '未导入 · 打开才建账';
        else if (!o) chip.textContent = '整理层读不出';
        else if (o.level === 'none') chip.textContent = '未整理 · 只有结构账（' + o.blocks + ' 块）';
        else {
          chip.textContent = (o.level === 'full' ? '已整理' : '欠 ' + o.gaps + ' 项')
            + ' · 综述 ' + o.sums + '/' + o.blocks
            + (o.phases ? ' · 阶段 ' + o.phases : '')
            + (o.titlesOf ? ' · 题名 ' + o.titles + '/' + o.titlesOf : '');
        }
        chip.title = unbuilt ? '这段还没建账：左栏只给廉价元数据，打开它才在后台建账（不自动建旧对话）'
          : o ? ('模型层写过：块综述 ' + o.sums + ' 条有效'
          + (o.sumsDropped ? '（另有 ' + o.sumsDropped + ' 条锚点已失效）' : '')
          + '、任务题名 ' + o.titles + ' 条、阶段 ' + o.phases + ' 段、已证增量 ' + o.verified + ' 条'
          + (o.at ? ' · 最后一次写于 ' + o.at.slice(0, 16).replace('T', ' ') : '')
          + '\n判据与 convledger outstanding 同一条：hash 对不上的旧条目不算整理过') : '这一本的账读不出模型层';
        lt.appendChild(chip);
        a.appendChild(lt);
        a.appendChild(el('span', 'goto', unbuilt ? '打开并建账 →' : '进入画布 →'));
        box.appendChild(a);
      });
      if (!expanded && rows.length > shownRows.length) {
        var more = el('button', 'more', '展开全部 ' + rows.length + ' 个会话');
        more.type = 'button';
        more.addEventListener('click', function () { toggle(g.runner); });
        box.appendChild(more);
      } else if (expanded && rows.length > SHOW) {
        var less = el('button', 'more', '收起');
        less.type = 'button';
        less.addEventListener('click', function () { toggle(g.runner); });
        box.appendChild(less);
      }
      list.appendChild(box);
    });
    if (!total) list.appendChild(el('div', 'empty', '还没有账本：在会话里跑一次 convledger map'));
    else if (!shown) list.appendChild(el('div', 'empty', needle ? '没有匹配的会话' : '这个筛法下没有会话'));
    counts.textContent = (needle || orgFilter !== 'all' ? shown + ' / ' + total + ' 个会话' : total + ' 个会话')
      + (v.counts.live ? ' · ' + v.counts.live + ' 进行中' : '')
      + ' · 整理过 ' + (v.counts.organized || 0) + ' / ' + total
      + (v.counts.skipped ? ' · ' + v.counts.skipped + ' 本读不了' : '');
    foot.textContent = footText + (orgFilter !== 'all' ? ' · 当前筛法：' + ORG_LABEL[orgFilter] : '');
  }

  function pull() {
    fetch('/sessions.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (v) { last = v; render(); })
      .catch(function (e) {
        if (last) return;
        list.textContent = '';
        list.appendChild(el('div', 'empty', '会话清单读不到：' + e.message));
      })
      .then(function () { setTimeout(pull, 15000); });
  }

  // 有任务状态的项目：入口在会话库上方；没任务的会话照旧在下面按 runner 分组。
  function drawProjects() {
    fetch('/projects.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (v) {
        var box = document.getElementById('projects');
        if (!box) return;
        box.textContent = '';
        var rows = (v.projects || []);
        if (!rows.length) { box.hidden = true; return; }
        box.hidden = false;
        box.appendChild(el('div', 'ptitle', '项目任务'));
        rows.forEach(function (p) {
          var a = el('a', 'prow');
          a.href = '/p/' + encodeURIComponent(p.key) + '/';
          a.appendChild(el('b', null, p.name));
          var c = p.counts || {};
          a.appendChild(el('span', 'pmeta', '完成 ' + (c.done || 0) + '/' + (c.inScope || 0)
            + (c.active ? ' · 进行中 ' + c.active : '') + (c.awaiting ? ' · 待验证 ' + c.awaiting : '')
            + (c.blocked ? ' · 受阻 ' + c.blocked : '') + ' · r' + p.revision));
          box.appendChild(a);
        });
      })
      .catch(function () { /* 项目清单读不到不影响会话库 */ });
  }

  q.addEventListener('input', render);
  q.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { q.value = ''; render(); q.blur(); }
  });
  if (orgBtn) {
    orgBtn.textContent = ORG_LABEL[orgFilter];
    orgBtn.addEventListener('click', function () {
      orgFilter = ORG_FILTERS[(ORG_FILTERS.indexOf(orgFilter) + 1) % ORG_FILTERS.length];
      orgBtn.textContent = ORG_LABEL[orgFilter];
      if (orgFilter === 'all') delete orgBtn.dataset.on; else orgBtn.dataset.on = '1';
      orgBtn.title = '当前：' + ORG_LABEL[orgFilter] + ' · 点一下换下一个（未整理＝只有结构账，没有块综述/阶段/题名/已证增量）';
      render();
    });
  }
  pull();
  drawProjects();
  setInterval(drawProjects, 15000);
})();

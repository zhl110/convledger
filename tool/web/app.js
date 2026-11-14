(function () {
  var ICONS = {
    qoder: '/agent-icons/qoder.png',
    'claude-code': '/agent-icons/claude-code.png',
    workbuddy: '/agent-icons/workbuddy.png',
    opencode: '/agent-icons/opencode.png',
    codex: '/agent-icons/codex.png'
  };
  var EL = {
    totals: document.getElementById('totals'),
    agents: document.getElementById('agents'),
    sessions: document.getElementById('sessions'),
    lessons: document.getElementById('lessons'),
    mems: document.getElementById('mems'),
    events: document.getElementById('events'),
    sub: document.getElementById('sub'),
    live: document.getElementById('live'),
    updating: document.getElementById('updating'),
    toast: document.getElementById('toast'),
    hdot: document.getElementById('hdot'),
    hstate: document.getElementById('hstate'),
    views: document.querySelectorAll('.view'),
    nav: document.querySelectorAll('.rail nav a[data-view]'),
    viewtitle: document.getElementById('viewtitle'),
    sessiongroups: document.getElementById('sessiongroups'),
    sessionq: document.getElementById('sessionq'),
    sessioncount: document.getElementById('sessioncount'),
    archframe: document.getElementById('archframe'),
    canvasframe: document.getElementById('canvasframe'),
    workframe: document.getElementById('workframe'),
    workproj: document.getElementById('workproj'),
    railnow: document.getElementById('railnow'),
    railnowname: document.getElementById('railnowname'),
    railnowmeta: document.getElementById('railnowmeta'),
    covpct: document.getElementById('covpct'),
    covfill: document.getElementById('covfill'),
    covnote: document.getElementById('covnote'),
    covled: document.getElementById('covled'),
    usagetotals: document.getElementById('usagetotals'),
    usagescan: document.getElementById('usagescan'),
    usagesources: document.getElementById('usagesources'),
    usagesessions: document.getElementById('usagesessions'),
    usageq: document.getElementById('usageq'),
    usagecount: document.getElementById('usagecount'),
    usageinjections: document.getElementById('usageinjections'),
    usageinjmeta: document.getElementById('usageinjmeta'),
    usagereadback: document.getElementById('usagereadback'),
    usagerbmeta: document.getElementById('usagerbmeta'),
    llmstate: document.getElementById('llmstate'),
    llmauto: document.getElementById('llmauto'),
    llmkey: document.getElementById('llmkey'),
    llmbase: document.getElementById('llmbase'),
    llmmodel: document.getElementById('llmmodel'),
    llmmsg: document.getElementById('llmmsg'),
    llmmodels: document.getElementById('llmmodels'),
    llmkeys: document.getElementById('llmkeys'),
    llmkeystate: document.getElementById('llmkeystate'),
    llmsave: document.getElementById('llmsave'),
    llmbridge: document.getElementById('llmbridge'),
    llmtest: document.getElementById('llmtest'),
    llmclear: document.getElementById('llmclear'),
    prefProfile: document.getElementById('prefProfile'),
    prefAutoBuild: document.getElementById('prefAutoBuild')
  };
  var timer = null;
  var sidMap = {};
  var ALL = { groups: [], sessions: [], count: 0, list: [] };
  var BY_ID = {};
  var EXPANDED = {};
  var LAST = { st: null };
  var PREFS = null;
  var currentView = 'board';
  var currentSession = null;
  var currentProject = null;
  var PROJECTS = [];
  var projectsLoaded = false;
  var projectsAt = 0;
  var VIEW_TITLE = { board: '本机看板', sessions: '会话', canvas: '会话地图', work: '项目工作台', usage: '用量', arch: '架构与路线图', settings: '模型配置' };
  // 窗口标题是制作人署名，不跟视图名漂移；视图名在页面 h1 里照常显示。
  var DOC_TITLE = 'convledger · 制作人 再来一杯海星酒';

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  var CHEV = {
    right: 'M6 3.5 10.5 8 6 12.5',
    down: 'M3.5 6 8 10.5 12.5 6',
    up: 'M3.5 10 8 5.5 12.5 10'
  };
  function icon(name) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(ns, 'path');
    p.setAttribute('d', CHEV[name]);
    svg.appendChild(p);
    return svg;
  }
  function ago(iso) {
    var t = Date.parse(iso || '');
    if (!t) return '—';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return s + ' 秒前';
    if (s < 3600) return Math.round(s / 60) + ' 分钟前';
    if (s < 86400) return Math.round(s / 3600) + ' 小时前';
    return Math.round(s / 86400) + ' 天前';
  }
  function chip(text, tone, title) {
    var c = el('span', 'chip' + (tone ? ' ' + tone : ''), text);
    if (title) c.title = title;
    return c;
  }
  function stat(n, k, hot, title) {
    var c = el('div', 'ro' + (hot ? ' hot' : ''));
    c.appendChild(el('div', 'n', String(n)));
    var kk = el('div', 'k', k);
    if (title) kk.title = title;
    c.appendChild(kk);
    return c;
  }

  function renderCoverage(t) {
    t = t || {};
    var blocks = Number(t.blocks) || 0;
    var sums = Number(t.sums) || 0;
    var pct = blocks > 0 ? Math.round(sums / blocks * 100) : 0;
    if (EL.covpct) EL.covpct.textContent = pct + '%';
    if (EL.covfill) EL.covfill.style.width = pct + '%';
    if (EL.covnote) EL.covnote.textContent = sums + ' / ' + blocks + ' 块已写综述';
    if (EL.covled) EL.covled.className = 'led' + ((Number(t.live) || 0) > 0 ? '' : ' idle');
  }

  function renderTotals(t) {
    t = t || {};
    renderCoverage(t);
    var mem = t.memory || { project: 0, user: 0 };
    EL.totals.textContent = '';
    [
      [t.sessions, '会话'],
      [t.segments, '段'],
      [t.blocks, '块'],
      [t.sums, '块综述'],
      [t.phases, '阶段'],
      [t.chapters, '章'],
      [t.lessons, '经验'],
      [(mem.project || 0) + (mem.user || 0), '记忆'],
      [t.live, '实时会话', true]
    ].forEach(function (it) {
      EL.totals.appendChild(stat(it[0] == null ? '—' : it[0], it[1], it[2]));
    });
  }

  function hostState(h) {
    if (!h.hostFound) return { cls: 'off', text: '未安装' };
    var both = h.skill && h.skill.installed && h.hooks && h.hooks.installed;
    if (both && h.sessions > 0) return { cls: 'ok', text: '已连接' };
    if (both) return { cls: 'part', text: '待来源' };
    if ((h.skill && h.skill.installed) || (h.hooks && h.hooks.installed)) return { cls: 'part', text: '部分接入' };
    return { cls: 'off', text: '未连接' };
  }

  function renderAgents(hosts) {
    EL.agents.textContent = '';
    (hosts || []).forEach(function (h) {
      var st = hostState(h);
      var card = el('article', 'agent' + (h.hostFound ? '' : ' off'));

      var top = el('div', 'atop');
      var img = document.createElement('img');
      img.src = ICONS[h.id] || '/icon-small.svg';
      img.alt = '';
      img.onerror = function () { img.style.visibility = 'hidden'; };
      top.appendChild(img);
      var nameBox = el('div');
      nameBox.appendChild(el('div', 'aname', h.label));
      var src = h.sourceFound
        ? (h.sessions + ' 个会话' + (typeof h.built === 'number' && h.built < h.sessions ? ' · ' + h.built + ' 已建账' : ''))
        : (h.cached ? '投影缓存 ' + h.cached : '没有本机来源');
      nameBox.appendChild(el('div', 'asrc', src));
      top.appendChild(nameBox);
      top.appendChild(el('span', 'state ' + st.cls, st.text));
      card.appendChild(top);

      // 在线／使用中：与上面的「已连接」（装没装）分开说清。
      var alive = el('div', 'alive');
      var dot = el('span', 'adot');
      if (h.online === true) {
        alive.className += ' on';
        alive.appendChild(dot);
        alive.appendChild(el('span', '', '在线'));
        if (h.onlineBy === 'activity') alive.appendChild(el('em', '', '（按活动判定）'));
        if (h.inUse) alive.appendChild(el('b', '', ' · 使用中'));
        else alive.appendChild(el('em', '', ' · 空闲'));
      } else if (h.service) {
        alive.className += ' service';
        alive.appendChild(dot);
        alive.appendChild(el('span', '', '后台服务'));
        alive.appendChild(el('em', '', '（界面已退）'));
      } else if (h.online === false) {
        alive.appendChild(dot);
        alive.appendChild(el('span', '', '未运行'));
      } else {
        alive.appendChild(dot);
        alive.appendChild(el('span', '', '进程状态读不到'));
      }
      if (h.lastWriteAt) alive.appendChild(el('em', 'at', ' · 最近写入 ' + ago(h.lastWriteAt)));
      card.appendChild(alive);

      var chips = el('div', 'chips');
      chips.appendChild(chip(h.skill && h.skill.installed ? 'Skill 已装' : 'Skill 未装', h.skill && h.skill.installed ? 'on' : 'bad', h.skill && h.skill.dir));
      chips.appendChild(chip(h.hooks && h.hooks.installed ? '钩子已注册' : '钩子未注册', h.hooks && h.hooks.installed ? 'on' : 'bad', h.hooks && h.hooks.file));
      if (h.id === 'codex' && h.hooks && h.hooks.installed) chips.appendChild(chip('需项目级信任', 'warn', 'Codex 的钩子是项目级配置，需要信任或绕过信任检查'));
      if (h.id === 'codex' && h.sourceFound && !h.sessions) chips.appendChild(chip('来源未接入', 'warn', '钩子能注入，但这段宿主还没有账本来源适配器'));
      card.appendChild(chips);

      var prefs = PREFS || { closeoutCadence: 'each', summaryCadence: 'every5', hosts: {} };
      var hp = (prefs.hosts && prefs.hosts[h.id]) || {};
      var cad = el('div', 'acadence');
      cad.appendChild(el('span', 'alabel', '收尾'));
      cad.appendChild(makeCadenceSelect(h.id, 'closeoutCadence', CLOSEOUT_CN, hp.closeoutCadence, prefs.closeoutCadence));
      cad.appendChild(el('span', 'alabel', '补账'));
      cad.appendChild(makeCadenceSelect(h.id, 'summaryCadence', CADENCE_CN, hp.summaryCadence, prefs.summaryCadence));
      card.appendChild(cad);

      var ev = el('div', 'aevent');
      if (h.last) {
        ev.appendChild(el('span', '', h.last.event + ' · ' + (h.last.action || '')));
        ev.appendChild(el('em', '', ' ' + ago(h.last.ts)));
      } else {
        ev.appendChild(el('em', '', h.hostFound ? '还没有宿主事件' : '本机没有装这个宿主'));
      }
      card.appendChild(ev);

      var ops = el('div', 'aops');
      var mk = function (text, action, primary, cls) {
        var b = el('button', (primary ? 'primary' : '') + (cls ? ' ' + cls : ''), text);
        b.type = 'button';
        b.dataset.client = h.id;
        b.dataset.action = action;
        b.disabled = !h.hostFound;
        return b;
      };
      var connected = !!(h.skill && h.skill.installed) || !!(h.hooks && h.hooks.installed);
      ops.appendChild(mk('一键连接', 'connect', true));
      ops.appendChild(mk('修钩子', 'hooks', false));
      ops.appendChild(mk('装 Skill', 'skill', false));
      // 连接的反向：同一张卡上给出退出，不让「装上就拆不掉」成为设计。
      var off = mk('断开', 'disconnect', false, 'danger');
      if (!connected) { off.disabled = true; off.title = '这家还没连接，没有要断的'; }
      ops.appendChild(off);
      card.appendChild(ops);

      EL.agents.appendChild(card);
    });
  }

  function segText(s) { return s.built === false ? '未建账' : ((s.segments || 0) + ' 段'); }
  function levelInfo(s) {
    var lv = s.organize && s.organize.level;
    return {
      text: lv === 'organized' ? '已整理' : lv === 'part' ? '欠 ' + (s.organize.gaps || 0) + ' 项' : '未整理',
      cls: lv === 'organized' ? ' ok' : lv === 'part' ? ' part' : ''
    };
  }
  function sessionMatches(s, q) {
    if (!q) return true;
    return [s.title, s.workspace, s.cwd, s.sid8].some(function (v) {
      return String(v || '').toLowerCase().indexOf(q) >= 0;
    });
  }
  function renderGroups() {
    if (!EL.sessiongroups) return;
    var q = String(EL.sessionq && EL.sessionq.value || '').trim().toLowerCase();
    EL.sessiongroups.textContent = '';
    var shown = 0;
    (ALL.groups || []).forEach(function (g) {
      var rows = (g.sessions || []).filter(function (s) { return sessionMatches(s, q); });
      if (!rows.length) return;
      rows.sort(function (a, b) { return Date.parse(b.lastWriteAt || 0) - Date.parse(a.lastWriteAt || 0); });
      shown += rows.length;
      var sec = el('section', 'sgroup');
      var head = el('div', 'sghead');
      var img = document.createElement('img');
      img.src = ICONS[g.runner] || '/icon-small.svg';
      img.alt = '';
      img.onerror = function () { img.style.visibility = 'hidden'; };
      head.appendChild(img);
      head.appendChild(el('b', '', g.label || g.runner));
      var expanded = !!EXPANDED[g.runner];
      var limited = !q && !expanded && rows.length > 4;
      head.appendChild(el('span', '', limited ? ('显示 4 / ' + rows.length) : (rows.length + ' 个会话')));
      if (!q && rows.length > 4) {
        var more = el('button', 'more');
        more.type = 'button';
        more.dataset.more = g.runner;
        more.appendChild(document.createTextNode(expanded ? '收起' : ('展开全部 ' + rows.length + ' 条')));
        more.appendChild(icon(expanded ? 'up' : 'down'));
        head.appendChild(more);
      }
      sec.appendChild(head);
      var cards = el('div', 'sgcards');
      (limited ? rows.slice(0, 4) : rows).forEach(function (s) {
        var lv = levelInfo(s);
        var a = el('a', 'scard');
        a.href = '/s/' + s.id + '/';
        a.title = s.cwd || '';
        a.dataset.session = s.id;
        a.dataset.sessionTitle = s.title || s.workspace || s.sid8;
        var line = el('div', 'sline');
        line.appendChild(el('i', 'dot' + (s.live ? ' live' : '')));
        line.appendChild(el('span', 'stitle', s.title || s.workspace || s.sid8));
        line.appendChild(el('span', 'slv' + lv.cls, lv.text));
        var arrow = el('span', 'sarrow');
        arrow.appendChild(icon('right'));
        line.appendChild(arrow);
        a.appendChild(line);
        a.appendChild(el('div', 'smeta', (s.workspace || '—') + ' · ' + segText(s) + ' · ' + (s.live ? '正在写' : ago(s.lastWriteAt))));
        cards.appendChild(a);
      });
      sec.appendChild(cards);
      EL.sessiongroups.appendChild(sec);
    });
    if (EL.sessioncount) {
      EL.sessioncount.textContent = q ? ('匹配 ' + shown + ' 个会话') : (ALL.count + ' 个会话 · ' + (ALL.groups || []).length + ' 家 agent');
    }
    if (!shown) EL.sessiongroups.appendChild(el('p', 'sempty', q ? '没有匹配的会话。' : '还没有账本会话。'));
  }

  function renderSessions(data) {
    EL.sessions.textContent = '';
    var all = [];
    ALL.groups = (data && data.groups) || [];
    ALL.count = (data && data.counts && data.counts.sessions) || 0;
    ALL.groups.forEach(function (g) {
      (g.sessions || []).forEach(function (s) { all.push(s); BY_ID[s.id] = s; });
      (g.sessions || []).forEach(function (s) { sidMap[s.sid8] = s.id; });
    });
    if (!ALL.count) ALL.count = all.length;
    all.sort(function (a, b) { return Date.parse(b.lastWriteAt || 0) - Date.parse(a.lastWriteAt || 0); });
    ALL.list = all;
    var rows = all.slice(0, 6);
    if (!rows.length) { EL.sessions.appendChild(el('li', 'empty', '还没有账本会话。')); }
    rows.forEach(function (s) {
      var li = el('li');
      var row = el('div', 'srow');
      row.appendChild(el('i', 'dot' + (s.live ? ' live' : '')));
      var a = el('a', 't', s.title || s.workspace || s.sid8);
      a.href = '/s/' + s.id + '/';
      a.title = s.cwd || '';
      a.dataset.session = s.id;
      a.dataset.sessionTitle = s.title || s.workspace || s.sid8;
      row.appendChild(a);
      var lv = levelInfo(s);
      row.appendChild(el('span', 'lv' + lv.cls, lv.text));
      li.appendChild(row);
      li.appendChild(el('span', 'm', (s.workspace || '—') + ' · ' + segText(s) + ' · ' + (s.live ? '正在写' : ago(s.lastWriteAt))));
      EL.sessions.appendChild(li);
    });
    renderGroups();
  }

  function renderLessons(rows) {
    EL.lessons.textContent = '';
    if (!rows || !rows.length) { EL.lessons.appendChild(el('li', 'empty', '还没有可复用经验。')); return; }
    rows.slice(0, 6).forEach(function (r) {
      var li = el('li', 'lesson');
      li.appendChild(el('span', 't', (r.title ? r.title + '：' : '') + r.lesson));
      var meta = el('span', 'm', r.session + ' · 块 ' + r.block);
      if (sidMap[r.session]) {
        var a = el('a', '', r.session + ' · 块 ' + r.block);
        a.href = '/s/' + sidMap[r.session] + '/';
        a.dataset.session = sidMap[r.session];
        a.dataset.sessionTitle = r.session;
        meta.textContent = '';
        meta.appendChild(a);
      }
      li.appendChild(meta);
      EL.lessons.appendChild(li);
    });
  }

  function renderMemories(rows) {
    EL.mems.textContent = '';
    if (!rows || !rows.length) { EL.mems.appendChild(el('li', 'empty', '还没有记忆条目。')); return; }
    rows.slice(0, 6).forEach(function (r) {
      var li = el('li', 'mem');
      var meta = el('span', 'm', r.scope + (r.dim ? ' · ' + r.dim : (r.cls ? ' · ' + r.cls : '')));
      li.appendChild(el('span', 't', r.text));
      li.appendChild(meta);
      EL.mems.appendChild(li);
    });
  }

  function renderEvents(rows) {
    EL.events.textContent = '';
    if (!rows || !rows.length) { EL.events.appendChild(el('li', 'empty', '还没有钩子事件；装好后跑一轮宿主就会出现。')); return; }
    rows.forEach(function (e) {
      var li = el('li');
      li.appendChild(el('time', '', ago(e.ts)));
      li.appendChild(el('span', 'ev', e.event));
      li.appendChild(el('span', 'ac', e.action || ''));
      li.appendChild(el('span', 'who', (e.runner || '?') + ' · ' + (e.sid8 || '')));
      EL.events.appendChild(li);
    });
  }

  // ---- 用量视图（/app?view=usage）：宿主上报的 token/credits + 本工具自己的注入/回读 ----
  var usageData = null;
  var usageAt = 0;
  var usageLoading = false;
  var usageTimer = null;
  var UG = { expanded: {}, imore: false };
  var USAGE_SOURCES = ['qoder', 'claude-code', 'workbuddy', 'opencode', 'codex'];
  var EVENT_UNIT = { qoder: '次请求', 'claude-code': '次回复', workbuddy: '步', opencode: '条消息', codex: '' };

  function fmtTok(n) {
    if (n == null || !isFinite(n)) return '—';
    n = Number(n);
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
  }
  function fmtFull(n) {
    if (n == null || !isFinite(n)) return '—';
    return String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function fmtCredits(n) {
    if (!n) return '—';
    return n >= 100 ? fmtFull(n) : String(Math.round(Number(n) * 10) / 10);
  }
  function ustat(value, key, title, cls) {
    var c = el('div', 'ro' + (cls ? ' ' + cls : ''));
    var n = el('div', 'n', value);
    if (title) n.title = title;
    c.appendChild(n);
    var k = el('div', 'k', key);
    if (title) k.title = title;
    c.appendChild(k);
    return c;
  }
  function usageTokTitle(t) {
    if (!t) return '这个来源没有 token 数据';
    return '真实 = 未缓存输入 ' + fmtFull(t.input) + ' + 缓存写 ' + fmtFull(t.cacheWrite) + ' + 输出 ' + fmtFull(t.output)
      + '；缓存命中 ' + fmtFull(t.cacheRead) + '（不计）';
  }
  function usageLabel(s) {
    return s.title || s.sid8 || String(s.id || '').slice(0, 8) || s.project || s.workspace || '—';
  }

  function usageEmpty(text) {
    if (!EL.usagesources) return;
    EL.usagesources.textContent = '';
    EL.usagesessions.textContent = '';
    EL.usagesessions.appendChild(el('p', 'sempty', text));
    if (EL.usageinjections) EL.usageinjections.textContent = '';
    if (EL.usagereadback) EL.usagereadback.textContent = '';
  }

  function usageSkeleton() {
    if (!EL.usagetotals) return;
    EL.usagetotals.textContent = '';
    [['工具用量', 'primary'], ['后台', 'part'], ['回填', 'part'], ['工具回合', 'part'], ['其余对话', 'muted'], ['credits', 'credits']].forEach(function (x) {
      EL.usagetotals.appendChild(ustat('—', x[0], '', x[1]));
    });
    if (EL.usagescan) EL.usagescan.textContent = '统计中';
  }

  function renderUsage(d) {
    if (!EL.usagetotals) return;
    usageData = d;
    usageAt = Date.now();
    var t = d.totals || {};
    var tk = t.tokens || {};
    var tool = t.tool || {};
    var inj = d.injections || {};
    EL.usagetotals.textContent = '';
    EL.usagetotals.appendChild(ustat(fmtTok(tool.totalReal), '工具用量', '后台 + 回填 + 工具回合', 'primary'));
    EL.usagetotals.appendChild(ustat(fmtTok(tool.background && tool.background.real), '后台收尾', '后台工作会话整段；Qoder 后台只有 credits ' + fmtCredits(tool.background && tool.background.credits), 'part'));
    EL.usagetotals.appendChild(ustat(fmtTok(tool.injection && tool.injection.real), '回填上下文', '注入后第一个模型调用，同一调用只算一次', 'part'));
    EL.usagetotals.appendChild(ustat(fmtTok(tool.turns && tool.turns.real), '工具回合', '含 convledger 调用的真人回合', 'part'));
    EL.usagetotals.appendChild(ustat(fmtTok(tool.ordinary && tool.ordinary.real), '其余对话', '不计入工具用量', 'muted'));
    EL.usagetotals.appendChild(ustat(fmtCredits(tool.totalCredits), 'credits', 'Qoder：后台 + 回填 + 工具回合', 'credits'));

    var scan = d.scanned || {};
    if (EL.usagescan) EL.usagescan.textContent = (scan.hostFiles || 0) + ' 文件';
    renderUsageSources(d);
    renderUsageSessions(d);
    renderUsageInjection(d);
    renderUsageReadback(d);
  }

  function renderUsageSources(d) {
    if (!EL.usagesources) return;
    EL.usagesources.textContent = '';
    var head = el('thead');
    var hr = el('tr');
    ['agent', '会话', '工具', '后台', '回填', '回合', '宿主总量', 'credits', '状态'].forEach(function (h, i) {
      var th = el('th', 'c-' + ['agent', 'sessions', 'tool', 'bg', 'inj', 'turn', 'host', 'credits', 'status'][i], h);
      if (h !== 'agent') th.style.textAlign = h === '状态' ? 'left' : 'right';
      hr.appendChild(th);
    });
    head.appendChild(hr);
    EL.usagesources.appendChild(head);
    var body = el('tbody');
    (d.sources || []).forEach(function (s) {
      var tr = el('tr');
      var name = el('td', 'uname c-agent');
      var img = document.createElement('img');
      img.src = ICONS[s.id] || '/icon-small.svg';
      img.alt = '';
      img.onerror = function () { img.style.visibility = 'hidden'; };
      name.appendChild(img);
      name.appendChild(el('b', '', s.label));
      tr.appendChild(name);
      tr.appendChild(el('td', 'c-sessions', (s.sessions || 0) + ' 个'));
      var toolCell = el('td', 'utotal c-tool', s.toolReal ? fmtTok(s.toolReal) : '—');
      toolCell.title = fmtFull(s.toolReal) + ' token';
      tr.appendChild(toolCell);
      [['bg', s.backgroundReal], ['inj', s.injectionReal], ['turn', s.turnReal]].forEach(function (x) {
        tr.appendChild(el('td', 'ucache c-' + x[0], x[1] ? fmtTok(x[1]) : '—'));
      });
      var host = el('td', 'ucache c-host', s.tokens ? fmtTok(s.total) : '—');
      if (s.tokens) host.title = fmtFull(s.total) + ' token';
      tr.appendChild(host);
      tr.appendChild(el('td', 'upay c-credits', s.toolCredits ? fmtCredits(s.toolCredits) : '—'));
      var st = el('td', 'unote c-status');
      var label = s.id === 'opencode' ? '会话级' : (s.tokens ? 'token' : (s.toolCredits ? 'credits' : '无用量'));
      if (!s.tokens || s.id === 'opencode') {
        var chip = el('span', 'chip', label);
        chip.title = [s.reason, s.toolNote, s.contextPeak ? '上下文峰值 ' + Math.round(s.contextPeak * 100) + '%' : ''].filter(Boolean).join(' · ');
        st.appendChild(chip);
      }
      tr.appendChild(st);
      body.appendChild(tr);
    });
    EL.usagesources.appendChild(body);
  }

  function usageMatches(s, q) {
    if (!q) return true;
    return [s.title, s.project, s.workspace, s.id, s.sid8].some(function (v) {
      return String(v || '').toLowerCase().indexOf(q) >= 0;
    });
  }

  function renderUsageSessions(d) {
    if (!EL.usagesessions) return;
    var q = String(EL.usageq && EL.usageq.value || '').trim().toLowerCase();
    EL.usagesessions.textContent = '';
    var shown = 0;
    USAGE_SOURCES.forEach(function (id) {
      var all = (d.sessions || []).filter(function (s) { return s.source === id && (s.toolReal || s.toolCredits); });
      var rows = all.filter(function (s) { return usageMatches(s, q); });
      if (!rows.length) return;
      shown += rows.length;
      var src = (d.sources || []).filter(function (x) { return x.id === id; })[0] || {};
      var groupReal = all.reduce(function (a, s) { return a + (s.toolReal || 0); }, 0);
      var groupCredits = all.reduce(function (a, s) { return a + (s.toolCredits || 0); }, 0);
      var sec = el('section', 'ugroup');
      var head = el('div', 'sghead');
      var img = document.createElement('img');
      img.src = ICONS[id] || '/icon-small.svg';
      img.alt = '';
      img.onerror = function () { img.style.visibility = 'hidden'; };
      head.appendChild(img);
      head.appendChild(el('b', '', src.label || id));
      head.appendChild(el('span', '', rows.length + ' 个会话 · ' + (groupReal ? fmtTok(groupReal) : fmtCredits(groupCredits) + ' credits')));
      var expanded = !!UG.expanded[id];
      var limited = !q && !expanded && rows.length > 4;
      if (!q && rows.length > 4) {
        var more = el('button', 'more', expanded ? '收起' : '展开全部 ' + rows.length + ' 条');
        more.type = 'button';
        more.dataset.umore = id;
        more.appendChild(icon(expanded ? 'up' : 'down'));
        head.appendChild(more);
      }
      sec.appendChild(head);
      var list = el('div', 'urows');
      (limited ? rows.slice(0, 4) : rows).forEach(function (s) {
        var a = el('a', 'urow');
        a.href = '/s/' + s.id + '/';
        a.dataset.session = s.id;
        a.dataset.sessionTitle = usageLabel(s);
        a.title = s.workspace || '';
        var title = el('span', 'utitle', usageLabel(s));
        a.appendChild(title);
        a.appendChild(el('span', 'uproj', s.project || s.sid8 || '—'));
        var num = el('span', 'unum');
        if (s.toolReal) {
          num.textContent = fmtTok(s.toolReal);
          num.title = '工具相关真实 ' + fmtFull(s.toolReal) + ' token · 宿主真实 ' + fmtFull(s.total) + ' token';
        } else {
          num.textContent = fmtCredits(s.toolCredits) + ' credits';
          num.title = '工具相关 credits（Qoder 不报 token）';
        }
        a.appendChild(num);
        var meta = [];
        if (s.toolTurns) meta.push(fmtFull(s.toolTurns) + ' 回合');
        if (s.toolCalls) meta.push(fmtFull(s.toolCalls) + ' 次');
        if (s.total && s.toolReal) meta.push('总 ' + fmtTok(s.total));
        meta.push(s.lastWriteAt ? ago(s.lastWriteAt) : '—');
        a.appendChild(el('span', 'umeta', meta.join(' · ')));
        list.appendChild(a);
      });
      sec.appendChild(list);
      EL.usagesessions.appendChild(sec);
    });
    if (EL.usagecount) EL.usagecount.textContent = q ? ('匹配 ' + shown + ' 个') : (shown + ' 个会话');
    if (!shown) EL.usagesessions.appendChild(el('p', 'sempty', '没有数据'));
  }

  function renderUsageInjection(d) {
    if (!EL.usageinjections) return;
    var inj = d.injections || {};
    if (EL.usageinjmeta) {
      EL.usageinjmeta.textContent = inj.count
        ? (fmtFull(inj.count) + ' 次 · ' + fmtTok(inj.real) + (inj.unmatched ? ' · ' + inj.unmatched + ' 未匹配' : ''))
        : '没有数据';
    }
    EL.usageinjections.textContent = '';
    if (!inj.count) {
      EL.usageinjections.appendChild(el('li', 'empty', '没有数据'));
      return;
    }
    var rows = (inj.recent || []).slice(0, UG.imore ? (inj.recent || []).length : 12);
    rows.forEach(function (r) {
      var li = el('li', 'uinjrow');
      var time = el('time', '', ago(r.ts));
      time.title = r.ts || '';
      li.appendChild(time);
      li.appendChild(el('span', 'ev', r.event || '?'));
      if (r.session) {
        var a = el('a', 'uwho', usageLabel(r));
        a.href = '/s/' + r.session + '/';
        a.dataset.session = r.session;
        a.dataset.sessionTitle = usageLabel(r);
        li.appendChild(a);
      } else li.appendChild(el('span', 'uwho', '—'));
      var actual = el('b', 'utok');
      if (r.background) {
        actual.textContent = '后台';
        actual.title = '后台会话整段已计入后台';
      } else if (!r.matched) {
        actual.textContent = '未匹配';
        actual.title = '注入后没有找到模型调用';
      } else if (r.real) {
        actual.textContent = fmtTok(r.real);
        actual.title = fmtFull(r.real) + ' token';
      } else if (r.credits) {
        actual.textContent = fmtCredits(r.credits) + ' cr';
        actual.title = 'Qoder credits';
      } else {
        actual.textContent = '—';
        actual.title = '没有上报 token';
      }
      if (r.truncated || r.source) actual.title += ' · ' + [r.truncated ? '截断' : '', r.source || ''].filter(Boolean).join(' ');
      li.appendChild(actual);
      EL.usageinjections.appendChild(li);
    });
    if ((inj.recent || []).length > 12) {
      var li = el('li', 'umoreli');
      var b = el('button', 'more', UG.imore ? '收起' : '全部 ' + inj.recent.length + ' 条');
      b.type = 'button';
      b.dataset.imore = '1';
      li.appendChild(b);
      EL.usageinjections.appendChild(li);
    }
  }

  function renderUsageReadback(d) {
    if (!EL.usagereadback) return;
    var rb = d.readback || {};
    if (EL.usagerbmeta) EL.usagerbmeta.textContent = rb.count ? (fmtFull(rb.count) + ' 次 · ' + fmtTok(rb.tokens)) : '没有数据';
    EL.usagereadback.textContent = '';
    if (!rb.count) {
      EL.usagereadback.appendChild(el('p', 'sempty', '没有数据'));
      return;
    }
    var head = el('div', 'uhead usesshead');
    head.appendChild(el('span', '', '会话'));
    head.appendChild(el('span', 'r', '体积'));
    head.appendChild(el('span', 'r', '次数'));
    EL.usagereadback.appendChild(head);
    var list = el('div', 'ulist');
    (rb.bySession || []).slice(0, 12).forEach(function (s) {
      var row = el('a', 'urow compact');
      row.href = '/s/' + s.session + '/';
      row.dataset.session = s.session;
      row.dataset.sessionTitle = usageLabel(s);
      row.appendChild(el('span', 'utitle', usageLabel(s)));
      row.appendChild(el('span', 'unum', fmtTok(s.tokens)));
      row.appendChild(el('span', 'umeta', fmtFull(s.count) + ' 次'));
      list.appendChild(row);
    });
    EL.usagereadback.appendChild(list);
  }

  function loadUsage(force) {
    if (usageLoading) return;
    usageLoading = true;
    var first = !usageData;
    if (first) usageSkeleton();
    fetch('/usage.json' + (force ? '?force=1' : ''), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        if (!d.ok) throw new Error(d.error || '统计失败');
        renderUsage(d);
        clearTimeout(usageTimer);
        if (d.refreshing) usageTimer = setTimeout(function () { loadUsage(false); }, 2000);
      })
      .catch(function (e) {
        if (EL.usagescan) { EL.usagescan.textContent = '统计失败 · 刷新重试'; EL.usagescan.title = e.message; }
        if (first) usageEmpty('没有数据');
      })
      .then(function () { usageLoading = false; });
  }

  // ---- 设置：接模型后端 / 补账档位（key 只在页面里过一道，回执全是脱敏的） ----
  function say(node, text, tone) {
    if (!node) return;
    node.textContent = text || '';
    node.className = 'llmmsg' + (tone ? ' ' + tone : '');
    node.hidden = !text;
  }

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, d: d || {} }; },
        function () { return { ok: false, d: { errors: ['HTTP ' + r.status] } }; });
    });
  }

  function renderAutoToggle(cfg) {
    if (!EL.llmauto) return;
    var on = !!cfg.autoOn;
    EL.llmauto.textContent = '自动补账：' + (on ? '开' : '关');
    EL.llmauto.classList.toggle('on', on);
    EL.llmauto.title = on
      ? '后台自动补账正在生效。点一下关掉：回到由当前 Agent 补（老路径），key 保留'
      : '后台自动补账已关。点一下打开：接了模型就由后台静默补综述';
  }

  function renderLlmModels(list) {
    if (!EL.llmmodels) return;
    EL.llmmodels.textContent = '';
    if (!list || !list.length) return;
    EL.llmmodels.appendChild(el('li', 'lmhead', '可用模型 ' + list.length + ' 个（点名字可填进上面的模型格）'));
    list.slice(0, 30).forEach(function (m) {
      var li = el('li', '', m);
      li.title = '用这个模型';
      li.addEventListener('click', function () { if (EL.llmmodel) EL.llmmodel.value = m; });
      EL.llmmodels.appendChild(li);
    });
  }

  // 钥匙串（仿 CC Switch 的切换列表）：贴过的 key 一行一条、脱敏显示、认得出归属；
  // 整行点击就切过去，不用重贴。key 只在贴入那刻可见，之后只显脱敏值。
  function renderLlmKeys(list) {
    if (!EL.llmkeys) return;
    EL.llmkeys.textContent = '';
    if (EL.llmkeystate) {
      var active = (list || []).filter(function (k) { return k.inUse; })[0];
      EL.llmkeystate.textContent = !list || !list.length
        ? '还没有存过 key'
        : '已存 ' + list.length + ' 条 · 当前：' + (active ? (active.label || active.provider || '自定义端点') : '未接');
    }
    if (!list || !list.length) {
      EL.llmkeys.appendChild(el('li', 'keyempty', '还没有存过 key——在下面「接入新的 Key」贴一个，就记进这里了。'));
      return;
    }
    list.forEach(function (k) {
      var li = el('li', 'keyrow' + (k.inUse ? ' active' : ''));
      li.title = k.inUse ? '正在使用这条' : '点一下切到这条：' + k.baseURL;
      if (k.inUse) li.appendChild(el('span', 'kbadge', '使用中'));
      li.appendChild(el('span', 'who', k.label || k.provider || '自定义端点'));
      li.appendChild(el('span', 'mk', k.keyMasked));
      li.appendChild(el('span', 'mk dim', k.model || '（未选模型）'));
      li.appendChild(el('span', 'grow', ''));
      if (!k.inUse) li.addEventListener('click', function () { keyAction('use', k.id, k); });
      var del = el('button', 'kbtn ghost', '删');
      del.type = 'button';
      del.title = '从钥匙串删掉这条（正在使用的不许删）';
      del.addEventListener('click', function (ev) { ev.stopPropagation(); keyAction('remove', k.id, k); });
      li.appendChild(del);
      EL.llmkeys.appendChild(li);
    });
  }

  function keyAction(action, id, k) {
    if (action === 'remove' && !window.confirm('把 ' + (k.label || k.id) + '（' + k.keyMasked + '）从钥匙串里删掉？之后要用得重贴。')) return;
    postJson('/llm/keys', { action: action, id: id }).then(function (r) {
      if (!r.ok) return say(EL.llmmsg, (r.d.errors || ['没成功']).join('；'), 'err');
      loadLlm();
      if (action === 'use') say(EL.llmmsg, r.d.note || '已切换。', 'ok');
      else say(EL.llmmsg, '已从钥匙串删掉 ' + (k.keyMasked || id) + '。', 'ok');
    }).catch(function (e) { say(EL.llmmsg, '请求失败：' + e.message, 'err'); });
  }

  function loadLlm() {
    fetch('/llm.json', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        // 各处独立守卫：版面改版删掉某个元素时不能整段中断（2026-11-14 事故：
        // 早退让「已存的 Key」永远停在「正在读取…」）。
        if (EL.llmstate) {
          EL.llmstate.textContent = d.configured ? ('已接 · ' + (d.model || '未选模型')) : '还没接';
          if (d.configured) EL.llmstate.title = d.baseURL || '';
        }
        if (d.configured) {
          if (EL.llmbase) EL.llmbase.placeholder = d.baseURL || '';
          if (EL.llmmodel) EL.llmmodel.placeholder = d.model || '';
          say(EL.llmmsg, '端点 ' + d.baseURL + '\nkey ' + (d.keyMasked || '（未设置）')
            + ' · 来源 ' + (d.source === 'env' ? '环境变量' : '本机配置'), 'ok');
        } else {
          say(EL.llmmsg, '填一个 API key 就能接上；也可以点「读本机 OW Bridge」直接拿它的。', '');
        }
        renderLlmModels(d.models || []);
        renderLlmKeys(d.savedKeys || []);
        renderAutoToggle(d);
      })
      .catch(function () {
        if (EL.llmstate) EL.llmstate.textContent = '读不到配置';
        if (EL.llmkeystate) EL.llmkeystate.textContent = '读不到配置';
      });
  }

  function saveLlm(useBridge) {
    var key = EL.llmkey ? EL.llmkey.value.trim() : '';
    var body = useBridge ? { bridge: true } : {
      apiKey: key,
      baseURL: EL.llmbase ? EL.llmbase.value.trim() : '',
      model: EL.llmmodel ? EL.llmmodel.value.trim() : '',
    };
    if (!useBridge && !key) return say(EL.llmmsg, '先填一个 API key（已接上又只想换模型的，去 CLI 用 --model）', 'err');
    say(EL.llmmsg, useBridge ? '正在读本机 OW Bridge…' : '正在试哪个端点认这个 key…', 'busy');
    postJson('/llm', body).then(function (r) {
      if (!r.ok) {
        var lines = (r.d.errors || ['没接上']).slice();
        if (r.d.tried) lines = lines.concat(r.d.tried.map(function (t) { return '· ' + t.label + '：' + t.reason; }));
        return say(EL.llmmsg, lines.join('\n'), 'err');
      }
      if (EL.llmkey) EL.llmkey.value = '';
      loadLlm();
      say(EL.llmmsg, '已接上：' + r.d.config.model + '（' + r.d.config.baseURL + '）\n这条 key 已记进钥匙串，下次换回来不用重贴。', 'ok');
    }).catch(function (e) { say(EL.llmmsg, '请求失败：' + e.message, 'err'); });
  }

  function testLlmNow() {
    say(EL.llmmsg, '正在发一条最短请求…', 'busy');
    postJson('/llm/test', {}).then(function (r) {
      if (!r.ok) return say(EL.llmmsg, (r.d.errors || ['没通']).join('；'), 'err');
      say(EL.llmmsg, '通了（' + r.d.ms + 'ms）：' + (r.d.reply || '（空回复）')
        + (r.d.usage ? '\ntoken 输入 ' + r.d.usage.prompt_tokens + ' / 输出 ' + r.d.usage.completion_tokens : ''), 'ok');
    }).catch(function (e) { say(EL.llmmsg, '请求失败：' + e.message, 'err'); });
  }

  function clearLlmCfg() {
    postJson('/llm', { clear: true }).then(function () {
      if (EL.llmkey) EL.llmkey.value = '';
      loadLlm();
      say(EL.llmmsg, '已断开；贴过的 key 留在钥匙串里，点「用」随时换回来。', 'ok');
    });
  }

  var CADENCE_CN = { each: '每轮', every5: '缺 5 块', compact: '压缩时' };
  var CLOSEOUT_CN = { each: '每轮', every5: '每 5 轮', compact: '压缩时' };
  function makeCadenceSelect(runner, key, labels, current, fallback) {
    var s = document.createElement('select');
    s.className = 'apselect';
    var def = document.createElement('option');
    def.value = '';
    def.textContent = '默认（' + (labels[fallback] || fallback || '—') + '）';
    s.appendChild(def);
    ['each', 'every5', 'compact'].forEach(function (v) {
      var o = document.createElement('option');
      o.value = v;
      o.textContent = labels[v];
      s.appendChild(o);
    });
    s.value = current || '';
    s.addEventListener('change', function () { setHostPref(runner, key, s.value); });
    return s;
  }

  function setHostPref(runner, key, value) {
    var one = {};
    one[key] = value || null;
    var hosts = {};
    hosts[runner] = one;
    postJson('/prefs', { host: hosts }).then(function (r) {
      if (!r.ok) return say(EL.toast, '没改成：' + ((r.d.errors || []).join('；') || '未知原因'), 'err');
      loadPrefs();
      say(EL.toast, '已保存', 'ok');
    }).catch(function (e) { say(EL.toast, '请求失败：' + e.message, 'err'); });
  }

  function setGlobalPref(key, value, label) {
    var body = {};
    body[key] = value;
    postJson('/prefs', body).then(function (r) {
      if (!r.ok) return say(EL.toast, '没改成：' + ((r.d.errors || []).join('；') || '未知原因'), 'err');
      loadPrefs();
      say(EL.toast, '已保存', 'ok');
    }).catch(function (e) { say(EL.toast, '请求失败：' + e.message, 'err'); });
  }

  function loadPrefs() {
    fetch('/prefs.json', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        PREFS = d;
        if (EL.prefProfile) EL.prefProfile.value = d.profileCadence || 'auto';
        if (EL.prefAutoBuild) EL.prefAutoBuild.value = d.autoBuild || 'off';
        if (LAST.st) renderAgents(LAST.st.hosts);
      })
      .catch(function () { /* 读不到就留空，下一次刷新再读 */ });
  }

  function toggleAuto() {
    if (!EL.llmauto) return;
    var now = EL.llmauto.classList.contains('on');
    postJson('/llm', { enabled: !now }).then(function (r) {
      if (!r.ok) return say(EL.llmmsg, (r.d.errors || []).join('；'), 'err');
      loadLlm();
      say(EL.llmmsg, !now
        ? '后台自动补账已开——接了模型就由后台静默补综述，当前对话不再被要求补'
        : '补账总闸已关——后台模型和当前 Agent 都不再补综述（欠项留着，画布回落原话截断）；正在跑的循环本轮收手，key 保留', 'ok');
    }).catch(function (e) { say(EL.llmmsg, '请求失败：' + e.message, 'err'); });
  }

  function bindSettings() {
    if (EL.llmauto) EL.llmauto.addEventListener('click', toggleAuto);
    if (EL.llmsave) EL.llmsave.addEventListener('click', function () { saveLlm(false); });
    if (EL.llmbridge) EL.llmbridge.addEventListener('click', function () { saveLlm(true); });
    if (EL.llmtest) EL.llmtest.addEventListener('click', testLlmNow);
    if (EL.llmclear) EL.llmclear.addEventListener('click', clearLlmCfg);
    if (EL.prefProfile) EL.prefProfile.addEventListener('change', function () { setGlobalPref('profileCadence', EL.prefProfile.value); });
    if (EL.prefAutoBuild) EL.prefAutoBuild.addEventListener('change', function () { setGlobalPref('autoBuild', EL.prefAutoBuild.value); });
    if (EL.llmkey) EL.llmkey.addEventListener('keydown', function (e) { if (e.key === 'Enter') saveLlm(false); });
  }

  function render(st, sess) {
    var boot = document.getElementById('boot');
    if (boot) boot.parentNode.removeChild(boot);
    renderTotals(st.totals);
    renderAgents(st.hosts);
    renderSessions(sess);
    if (currentView === 'canvas' && !EL.canvasframe.getAttribute('src') && newestSession()) {
      currentSession = newestSession();
      EL.canvasframe.removeAttribute('srcdoc');
      EL.canvasframe.src = '/s/' + currentSession + '/?embed=1';
    }
    if (currentView === 'canvas' || currentView === 'work') {
      var name = currentView === 'canvas' ? canvasName() : workName();
      EL.viewtitle.textContent = name;
      document.title = DOC_TITLE;
    }
    updateRailNow();
    renderLessons(st.lessons);
    renderMemories(st.memories);
    renderEvents(st.recent);
    var live = (st.totals && st.totals.live) || 0;
    EL.live.textContent = '';
    EL.live.appendChild(el('b', '', live > 0 ? '实时 ' + live : '实时 0'));
    EL.live.appendChild(document.createTextNode(' · ' + new Date(st.at).toLocaleTimeString()));
    LAST.st = st;
    setMeta();
    EL.hdot.className = 'on';
    EL.hstate.textContent = '在线';
    // 后台正在重算快照就转小圈；前台照常可点（PRD-refresh）。
    if (EL.updating) EL.updating.hidden = !(st.refreshing || (sess && sess.refreshing));
  }

  function fail(err) {
    var bm = document.getElementById('bootmsg');
    if (bm) bm.textContent = '读不到本机账本：' + (err && err.message ? err.message : err);
    EL.sub.textContent = '读不到本机账本：' + (err && err.message ? err.message : err);
    EL.hdot.className = '';
    EL.hstate.textContent = '离线';
    if (EL.updating) EL.updating.hidden = true;
    if (EL.covpct) EL.covpct.textContent = '—';
    if (EL.covfill) EL.covfill.style.width = '0%';
    if (EL.covnote) EL.covnote.textContent = '服务不可达';
    if (EL.covled) EL.covled.className = 'led idle';
    EL.totals.textContent = '';
    EL.totals.appendChild(stat('—', '服务不可达'));
    EL.agents.textContent = '';
    var tip = el('article', 'agent');
    tip.appendChild(el('div', 'aname', '服务没有应答'));
    tip.appendChild(el('div', 'aevent', '检查 127.0.0.1:8765 是否在跑，或重新双击应用图标。'));
    EL.agents.appendChild(tip);
  }

  function viewFromUrl() {
    var p = new URLSearchParams(location.search);
    var v = p.get('view');
    if (v === 'canvas') currentSession = p.get('session') || currentSession;
    if (v === 'work') currentProject = p.get('project') || currentProject;
    return VIEW_TITLE[v] ? v : 'board';
  }

  function canvasName() {
    var s = currentSession && BY_ID[currentSession];
    return s ? (s.title || s.workspace || s.sid8) : '会话地图';
  }
  function workName() {
    var p = currentProject && PROJECTS.filter(function (x) { return x.key === currentProject; })[0];
    return p ? p.name : '项目工作台';
  }
  function newestSession() {
    return ALL.list && ALL.list.length ? ALL.list[0].id : null;
  }
  function updateRailNow() {
    if (!EL.railnow) return;
    var s = currentSession && BY_ID[currentSession];
    if (!s) { EL.railnow.hidden = true; return; }
    EL.railnow.hidden = false;
    EL.railnowname.textContent = s.title || s.workspace || s.sid8;
    EL.railnowmeta.textContent = (s.workspace || '—') + ' · ' + segText(s);
  }
  // 工作台只列「有任务状态」的项目（/projects.json 同一把尺）；没有就如实给空状态。
  // 30 秒内复用缓存：空状态不能永远空——任务可能刚被收尾同步写出来，到点要重拉。
  function loadProjects(force) {
    var fresh = projectsLoaded && !force && (Date.now() - projectsAt < 30000);
    if (fresh) return Promise.resolve(PROJECTS);
    return fetch('/projects.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : { projects: [] }; })
      .catch(function () { return { projects: [] }; })
      .then(function (d) {
        PROJECTS = (d && d.projects) || [];
        projectsLoaded = true;
        projectsAt = Date.now();
        populateWorkSelect();
        return PROJECTS;
      });
  }
  function populateWorkSelect() {
    if (!EL.workproj) return;
    EL.workproj.textContent = '';
    if (!PROJECTS.length) {
      var o0 = el('option', '', '还没有项目任务表');
      o0.value = '';
      EL.workproj.appendChild(o0);
      EL.workproj.disabled = true;
      return;
    }
    EL.workproj.disabled = false;
    PROJECTS.forEach(function (p) {
      var o = el('option', '', p.name + '（' + p.tasks + ' 任务）');
      o.value = p.key;
      EL.workproj.appendChild(o);
    });
    if (currentProject) EL.workproj.value = currentProject;
  }
  function defaultProject() {
    if (currentProject && PROJECTS.some(function (p) { return p.key === currentProject; })) return currentProject;
    return PROJECTS.length ? PROJECTS[0].key : null;
  }
  function emptyScreen(frame, title, body) {
    frame.removeAttribute('src');
    frame.srcdoc = "<!doctype html><meta charset='utf-8'><body style='margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#f2f5f9;color:#66788f;font:14px/1.7 system-ui,sans-serif'><div style='max-width:440px;text-align:center;padding:24px'><b style='display:block;color:#141b26;font-size:15px;margin-bottom:6px'>" + title + "</b>" + body + "</div></body>";
  }

  function setMeta() {
    // 各视图标题已自解释，不再常驻说明小字；看板保留一行状态数据（宿主数/段数/更新时间）。
    if (currentView === 'board') {
      EL.sub.textContent = LAST.st
        ? '五家宿主 · ' + (LAST.st.totals ? LAST.st.totals.sessions : 0) + ' 个会话 · 更新于 ' + new Date(LAST.st.at).toLocaleTimeString()
        : '正在读取本机账本…';
    } else {
      EL.sub.textContent = '';
    }
  }

  function mountWork(push) {
    return loadProjects().then(function () {
      if (currentView !== 'work') return;
      currentProject = defaultProject();
      if (EL.workproj) EL.workproj.value = currentProject || '';
      if (currentProject) {
        var wantp = '/p/' + encodeURIComponent(currentProject) + '/?embed=1';
        EL.workframe.removeAttribute('srcdoc');
        if (EL.workframe.getAttribute('src') !== wantp) EL.workframe.src = wantp;
      } else {
        emptyScreen(EL.workframe, '还没有项目任务表', '在会话里跑一次收尾同步（sync --prepare → sync --put）就会生成。');
      }
      var wn = workName();
      EL.viewtitle.textContent = wn;
      document.title = DOC_TITLE;
      if (push) history.replaceState({ view: 'work', session: currentSession, project: currentProject }, '', '/app?view=work&project=' + encodeURIComponent(currentProject || ''));
    });
  }

  function showView(v, push) {
    if (!VIEW_TITLE[v]) v = 'board';
    currentView = v;
    for (var i = 0; i < EL.views.length; i++) {
      EL.views[i].hidden = EL.views[i].id !== 'view-' + v;
    }
    for (var j = 0; j < EL.nav.length; j++) {
      EL.nav[j].classList.toggle('on', EL.nav[j].dataset.view === v);
    }
    var name = v === 'canvas' ? canvasName() : (v === 'work' ? workName() : VIEW_TITLE[v]);
    EL.viewtitle.textContent = name;
    document.title = DOC_TITLE;
    if (v === 'arch' && EL.archframe && !EL.archframe.getAttribute('src')) {
      EL.archframe.src = EL.archframe.dataset.src;
    }
    if (v === 'settings') { loadLlm(); }
    if (v === 'canvas') {
      if (!currentSession) currentSession = newestSession();
      if (currentSession) {
        var want = '/s/' + currentSession + '/?embed=1';
        EL.canvasframe.removeAttribute('srcdoc');
        if (EL.canvasframe.getAttribute('src') !== want) EL.canvasframe.src = want;
      } else {
        emptyScreen(EL.canvasframe, '还没有会话地图', '在「会话」里点一张卡，或等本机账本建好第一段会话。');
      }
      updateRailNow();
    }
    if (v === 'work') mountWork(push);
    if (v === 'sessions') renderGroups();
    if (v === 'usage') loadUsage(false);
    setMeta();
    if (push) {
      var url = v === 'board' ? '/app' : (v === 'canvas'
        ? '/app?view=canvas&session=' + encodeURIComponent(currentSession || '')
        : (v === 'work'
          ? '/app?view=work&project=' + encodeURIComponent(currentProject || '')
          : '/app?view=' + v));
      history.pushState({ view: v, session: currentSession, project: currentProject }, '', url);
    }
  }

  function openCanvas(id, title) {
    currentSession = id;
    if (title && BY_ID[id] && !BY_ID[id].title) BY_ID[id].title = title;
    showView('canvas', true);
  }

  function load(force) {
    clearTimeout(timer);
    if (document.hidden) { timer = setTimeout(load, 10000); return; }
    var q = force ? '?force=1' : '';
    Promise.all([
      fetch('/status.json' + q, { cache: 'no-store' }).then(function (r) {
        if (r.status === 403) throw new Error('看板钥匙不匹配（hub 重启过门禁）。关掉本窗口，从桌面图标重新打开一次就好');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }),
      fetch('/sessions.json' + q, { cache: 'no-store' }).then(function (r) {
        return r.ok ? r.json() : { groups: [] };
      }).catch(function () { return { groups: [] }; })
    ]).then(function (out) {
      render(out[0], out[1]);
      // 工作台的空状态不是终点：任务可能刚被收尾同步写出来。在 work 视图里每轮按 30 秒缓存重拉一次。
      if (currentView === 'work') mountWork(false);
      if (currentView === 'usage' && usageAt && Date.now() - usageAt > 30000) loadUsage(false);
    }).catch(fail).then(function () {
      timer = setTimeout(load, 5000);
    });
  }

  function toast(text, tone) {
    EL.toast.hidden = false;
    EL.toast.className = 'toast' + (tone ? ' ' + tone : '');
    EL.toast.textContent = text;
  }

  EL.agents.addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-action]');
    if (!b || b.disabled) return;
    var card = b.closest('.agent');
    var buttons = card ? card.querySelectorAll('button') : [b];
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = true;
    toast('正在' + b.textContent + '：' + b.dataset.client + ' …');
    fetch('/status/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client: b.dataset.client, action: b.dataset.action })
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (!res.ok) throw new Error(res.error || '操作失败');
      var out = (res.steps || []).map(function (s) { return s.out; }).filter(Boolean).join('\n');
      toast(b.textContent + '完成' + (out ? '\n' + out : ''), 'ok');
      load(true);
    }).catch(function (e) {
      toast('失败：' + e.message, 'bad');
      for (var j = 0; j < buttons.length; j++) buttons[j].disabled = false;
    });
  });

  document.getElementById('refresh').addEventListener('click', function () {
    var b = this;
    if (b.disabled) return;
    b.disabled = true;
    b.classList.add('loading');
    load(true);
    if (currentView === 'usage') loadUsage(true);
    setTimeout(function () { b.disabled = false; b.classList.remove('loading'); }, 1200);
  });

  // 全局暂停：停掉常驻 hub、释放后台内存；双击桌面图标或 convledger map 恢复。
  var pauseBtn = document.getElementById('pause');
  if (pauseBtn) pauseBtn.addEventListener('click', function () {
    var b = this;
    if (b.disabled) return;
    if (!confirm('全局暂停：停掉常驻服务、释放后台内存。\n之后双击桌面「convledger 地图」或跑 convledger map 恢复。')) return;
    b.disabled = true;
    toast('正在全局暂停…');
    function showPaused() {
      clearTimeout(timer);
      document.body.classList.add('paused');
      var o = document.createElement('div');
      o.className = 'pausedoverlay';
      var pb = document.createElement('div');
      pb.className = 'pb';
      var bt = document.createElement('b');
      bt.textContent = '已全局暂停';
      var p1 = document.createElement('p');
      p1.textContent = '常驻服务已停，后台不再占内存。';
      var p2 = document.createElement('p');
      p2.textContent = '恢复：双击桌面「convledger 地图」，或跑 convledger map。';
      pb.appendChild(bt); pb.appendChild(p1); pb.appendChild(p2);
      o.appendChild(pb);
      document.body.appendChild(o);
    }
    fetch('/hub/pause', { method: 'POST', headers: { 'content-type': 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(showPaused)
      .catch(showPaused); // hub 可能已退出，按暂停成功处理
  });
  if (EL.sessionq) EL.sessionq.addEventListener('input', renderGroups);
  if (EL.usageq) EL.usageq.addEventListener('input', function () { if (usageData) renderUsageSessions(usageData); });
  if (EL.workproj) EL.workproj.addEventListener('change', function () {
    currentProject = EL.workproj.value || null;
    showView('work', true);
  });
  document.addEventListener('click', function (e) {
    var um = e.target.closest('[data-umore]');
    if (um) {
      e.preventDefault();
      UG.expanded[um.dataset.umore] = !UG.expanded[um.dataset.umore];
      if (usageData) renderUsageSessions(usageData);
      return;
    }
    var im = e.target.closest('[data-imore]');
    if (im) {
      e.preventDefault();
      UG.imore = !UG.imore;
      if (usageData) renderUsageInjection(usageData);
      return;
    }
    var card = e.target.closest('[data-session]');
    if (card) {
      e.preventDefault();
      openCanvas(card.dataset.session, card.dataset.sessionTitle);
      return;
    }
    var more = e.target.closest('[data-more]');
    if (more) {
      e.preventDefault();
      EXPANDED[more.dataset.more] = !EXPANDED[more.dataset.more];
      renderGroups();
      return;
    }
    var a = e.target.closest('[data-view]');
    if (!a) return;
    e.preventDefault();
    showView(a.dataset.view, true);
  });
  window.addEventListener('popstate', function () { showView(viewFromUrl(), false); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'r' && !e.ctrlKey && !e.metaKey && !e.altKey && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) {
      load();
      if (currentView === 'usage') loadUsage(true);
    }
  });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
  bindSettings();
  loadPrefs();
  showView(viewFromUrl(), false);
  load();
})();

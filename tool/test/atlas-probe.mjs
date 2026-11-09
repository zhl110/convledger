#!/usr/bin/env node
// 流程图的可验证探针：用真的无头浏览器打开一张会话画布（/atlas 会 302 到最近写入的
// 那段会话，也可以直接给 /s/<id>/），按真实输入事件走一遍
// 「适应 → 缩到远景／印章档 → 点一块（卡不许动、邻居不许暗、右栏出详情）→ Esc 回原镜头」。
// 几何断言全部可复算：块两两不重叠、主线按步号从左到右折返、插曲道贴在宿主行下方、
// 每条连线两端钉在卡片边框上、路径采样点不落进任何卡、连线层在卡层之上。
// 只读：不改账本、不改 src/、不改 web/；截图落在 tool/out/（已被 .gitignore 挡住）。
// 用法：node tool/test/atlas-probe.mjs [http://127.0.0.1:8765/s/<会话>/]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const URL_ = process.argv[2] || 'http://127.0.0.1:8765/atlas';
const SHELL = 'D:/tools/playwright-browsers/chromium_headless_shell-1247/chrome-headless-shell-win64/chrome-headless-shell.exe';
const OUT = new URL('../out/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1').replace(/\\/g, '/');
const PORT = 9333;
const W = 1440, H = 900;

const chrome = spawn(SHELL, [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--hide-scrollbars', `--window-size=${W},${H}`, URL_,
], { stdio: 'ignore' });
process.on('exit', () => chrome.kill());

const list = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
let ws, id = 0;
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id;
  const on = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id !== mid) return;
    ws.removeEventListener('message', on);
    if (m.error) rej(new Error(`${method}: ${m.error.message}`)); else res(m.result);
  };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id: mid, method, params }));
});

// 起浏览器（第一次 /json/list 可能要等它写完文件）
for (let i = 0; i < 60; i++) {
  try { const l = await list(); const t = l.find((x) => x.type === 'page'); if (t) { ws = new WebSocket(t.webSocketDebuggerUrl); break; } } catch { /* 还没起来 */ }
  await sleep(250);
}
if (!ws) { chrome.kill(); throw new Error('headless chrome never came up'); }
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await send('Runtime.enable'); await send('Page.enable');

const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description || ''));
  return r.result.value;
};
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${OUT}/probe-${name}.png`, Buffer.from(data, 'base64'));
  return `${OUT}/probe-${name}.png`;
};
const wheel = async (deltaY, x = W / 2, y = H / 2) => send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
const clickAt = async (x, y) => {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
  }
};
const key = async (code, k, vk) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key: k, windowsVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: k, windowsVirtualKeyCode: vk });
};
// CSSOM 会把 transform 规范成 matrix(...)：读 DOMMatrix 的 a/e/f，别拿字符串正则去啃
const cam = () => ev(`(function(){var t=getComputedStyle(document.getElementById('world')).transform;return t==='none'?1:new DOMMatrix(t).a})()`);
async function settle(limit = 60) {
  let a = null;
  for (let i = 0; i < limit; i++) {
    const b = await cam();
    if (a !== null && Math.abs(b - a) < 1e-6) return b;
    a = b; await sleep(120);
  }
  return a;
}
// 档位只认 z，但账本长大后 fit 的 z 会掉到别的档——巡游必须按当前 z 决定滚轮方向，
// 不能假设"适应一定落在中景、往外滚就是远景"。
async function zoomNear(lo, hi, x = W / 2, y = H / 2) {
  for (let i = 0; i < 90; i++) {
    const z = await settle();
    if (z >= lo && z <= hi) return z;
    // deltaY 为正＝缩小（页面里 f=exp(-deltaY*0.0014)）
    await wheel(z < lo ? -40 : 40, x, y);
  }
  return settle();
}

const STATE = `(function(){
  var w=document.getElementById('world');
  var m=new DOMMatrix(getComputedStyle(w).transform);
  var c=document.querySelector('#cards .p');
  return {
    tier:w.dataset.tier, z:m.a, x:m.e, y:m.f,
    cards:document.querySelectorAll('#cards .p').length,
    insp:!document.getElementById('insp').hidden,
    inspClass:document.getElementById('stage').classList.contains('insp'),
    openUi:document.querySelectorAll('#cards .p.open, #stage.open, #cards .tether, #cards .ghost, #cards .p.dragging').length,
    markText:c ? (c.querySelector('.fwhat')||{}).textContent || '' : '',
    markPx:c ? +getComputedStyle(c.querySelector('.fwhat')||document.body).fontSize.replace('px','') : 0,
    markClip:c && c.querySelector('.fwhat') ? (function(){var f=c.querySelector('.fwhat');return {sw:f.scrollWidth, cw:f.clientWidth, over:f.scrollWidth-f.clientWidth}})() : null,
    rowhint:document.getElementById('rowhint').textContent
  }})()`;

const rows = [];
const snap = async (label) => {
  const s = await ev(STATE);
  s.label = label;
  s.markScreenPx = +(s.markPx * s.z).toFixed(1);
  rows.push(s);
  return s;
};

/* 流程图几何：块位（offset，世界坐标）＋连线（端点/采样/层序）＋插曲道贴宿主行。
   采样点在每条线段上取 25 个点，任何一点严格落进别的卡片内部都算失败。 */
const GEOM = `(function(){
  var cards=Array.from(document.querySelectorAll('#cards .p'));
  var rs=cards.map(function(c){
    return {id:c.dataset.from,i:+c.dataset.i,step:c.dataset.step===''?null:+c.dataset.step,kind:c.dataset.kind,
      after:c.dataset.after===''?null:+c.dataset.after,before:c.dataset.before===''?null:+c.dataset.before,
      x:c.offsetLeft,y:c.offsetTop,w:c.offsetWidth,h:c.offsetHeight,
      on:c.classList.contains('on'),opacity:+getComputedStyle(c).opacity,z:+getComputedStyle(c).zIndex||0,
      badge:(c.querySelector('.fstep')||{}).textContent||'',
      mvia:(c.querySelector('.mvia')||{}).textContent||'',
      prng:(c.querySelector('.prng')||{}).textContent||'',
      foot:Array.from(c.querySelectorAll('.pfoot button')).map(function(b){return b.textContent})};
  });
  function ix(a,b){return Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)>0.5&&Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y)>0.5}
  var overlap=[];
  for(var i=0;i<rs.length;i++)for(var j=i+1;j<rs.length;j++) if(ix(rs[i],rs[j])) overlap.push(rs[i].id+'/'+rs[j].id);
  var sorted=rs.slice().sort(function(a,b){return a.y-b.y||a.x-b.x});
  var main=sorted.filter(function(c){return c.step!=null}).map(function(c){return c.step});
  var order=[]; for(var k=1;k<main.length;k++) if(main[k]!==main[k-1]+1) order.push(main[k-1]+'>'+main[k]);
  var dyAll=[]; for(var i=0;i<rs.length;i++)for(var j=0;j<rs.length;j++){var d=rs[j].y-rs[i].y;if(d>0)dyAll.push(d)}
  var rowH=dyAll.length?Math.min.apply(null,dyAll):0;
  var stepOf={}; rs.forEach(function(c){if(c.step!=null)stepOf[c.step]=c});
  var colsX=Array.from(new Set(rs.map(function(c){return c.x}))).sort(function(a,b){return a-b});
  var colOf=function(x){return colsX.indexOf(x)};
  var lane=[];
  rs.filter(function(c){return c.kind==='interlude'}).forEach(function(c){
    var h=c.after!=null?stepOf[c.after]:null;
    if(!h){lane.push(c.id+':宿主步 '+c.after+' 不存在');return}
    var dy=c.y-h.y;
    // PRD 7.4.2：插曲卡正好落在宿主卡的下一行槽（行距固定；卡高随语义档变，不能钉像素差）
    if(dy!==rowH) lane.push(c.id+':槽 '+dy+'/'+rowH);
    // 同一宿主步的一串插曲是一条链：链头贴宿主列，后续块同一行向右续列（可以 3 块以上）。
    var same=rs.filter(function(q){return q.kind==='interlude'&&q.after===c.after}).sort(function(a,b){return a.y-b.y||a.x-b.x});
    var k=same.indexOf(c);
    if(k===0){ if(c.x!==h.x) lane.push(c.id+':列 '+c.x+'≠宿主 '+h.x); }
    else { var pv=same[k-1];
      if(c.y!==pv.y||colOf(c.x)<=colOf(pv.x)) lane.push(c.id+':链位 '+c.x+','+c.y+' ≤ '+pv.id+' '+pv.x+','+pv.y); }
    if(c.before!=null&&!stepOf[c.before]) lane.push(c.id+':汇回步 '+c.before+' 不存在');
  });
  var rects=rs.map(function(r){return {from:r.id,x:r.x,y:r.y,w:r.w,h:r.h}});
  function inside(x,y,skip){for(var i=0;i<rects.length;i++){var r=rects[i];if(r.from===skip)continue;
    if(x>r.x+1&&x<r.x+r.w-1&&y>r.y+1&&y<r.y+r.h-1)return r.from}return null}
  function onBorder(pt,id){var q=rects.filter(function(r){return r.from===id})[0];if(!q)return false;
    var e=1.6,x=pt[0],y=pt[1];
    var v=(Math.abs(x-q.x)<e||Math.abs(x-(q.x+q.w))<e)&&y>=q.y-e&&y<=q.y+q.h+e;
    var h=(Math.abs(y-q.y)<e||Math.abs(y-(q.y+q.h))<e)&&x>=q.x-e&&x<=q.x+q.w+e;
    return v||h}
  var wires=Array.from(document.querySelectorAll('#wires path[data-edge]')).map(function(p){
    var nums=(p.getAttribute('d').match(/-?\\d+(?:\\.\\d+)?/g)||[]).map(Number),pts=[];
    for(var k=0;k+1<nums.length;k+=2)pts.push([nums[k],nums[k+1]]);
    var hits=[],samples=0,bent=0;
    for(var s=0;s+1<pts.length;s++){
      var A=pts[s],B=pts[s+1];
      if(Math.abs(A[0]-B[0])>0.6&&Math.abs(A[1]-B[1])>0.6) bent++;
      for(var t=0;t<=24;t++){var x=A[0]+(B[0]-A[0])*t/24,y=A[1]+(B[1]-A[1])*t/24;samples++;
        var h=inside(x,y,p.dataset.from);if(h&&hits.indexOf(h)<0)hits.push(h)}
    }
    return {cls:p.dataset.edge,from:p.dataset.from,to:p.dataset.to,cls2:p.getAttribute('class'),n:pts.length,
      attachFrom:onBorder(pts[0],p.dataset.from),attachTo:onBorder(pts[pts.length-1],p.dataset.to),
      through:hits,samples:samples,bent:bent,first:pts[0],last:pts[pts.length-1]};
  });
  var ends={}; wires.forEach(function(w){ends[w.from]=(ends[w.from]||0)+1;ends[w.to]=(ends[w.to]||0)+1});
  var lonely=rs.filter(function(c){return c.kind==='interlude'&&!ends[c.id]}).map(function(c){return c.id});
  // PRD 7.4.3：主线 N-1 条、每趟插曲 1 进 1 出、趟内相邻两块 1 条；箭头数＝线数
  var byCls={}; wires.forEach(function(w){byCls[w.cls]=(byCls[w.cls]||0)+1});
  var interCount=rs.filter(function(c){return c.kind==='interlude'}).length;
  var runKeys={};
  // 还没汇回的尾巴插曲（before==null）画不出 back 线，别把它算进期望值
  rs.filter(function(c){return c.kind==='interlude'&&c.before!=null}).forEach(function(c){runKeys[c.after+'/'+c.before]=1});
  var audit={spine:byCls.spine||0,fork:byCls.fork||0,back:byCls.back||0,total:wires.length,
    arrows:document.querySelectorAll('#wires path[data-edge][marker-end]').length,
    expectSpine:rs.filter(function(c){return c.step!=null}).length-1,expectFork:interCount,expectBack:Object.keys(runKeys).length};
  // PRD 7.4.8：当前档的卡面盒不许有横向/纵向静默丢失（卡 overflow:hidden，装不下就是吃掉字）
  var tier=document.getElementById('world').dataset.tier;
  var boxSel={near:'.tn',mid:'.tm',far:'.tf',glyph:'.tf'}[tier];
  var boxOver=[];
  cards.forEach(function(c){
    var box=c.querySelector(boxSel);
    if(box&&box.scrollHeight-box.clientHeight>1) boxOver.push(c.dataset.from+':h'+(box.scrollHeight-box.clientHeight));
    var fw=c.querySelector('.fwhat');
    if(fw&&getComputedStyle(fw).display!=='none'&&fw.scrollWidth-fw.clientWidth>1) boxOver.push(c.dataset.from+':fwhat-w'+(fw.scrollWidth-fw.clientWidth));
  });
  var hud={};
  ['askbar','hintbar','legend','minimap'].forEach(function(k){
    var el=document.getElementById(k); if(!el) return;
    var cs=getComputedStyle(el);
    if(cs.display==='none'||cs.visibility==='hidden'||+cs.opacity===0) return;
    var r=el.getBoundingClientRect();
    var hit=cards.filter(function(c){
      var b=c.getBoundingClientRect();
      return Math.min(r.right,b.right)>Math.max(r.left,b.left)&&Math.min(r.bottom,b.bottom)>Math.max(r.top,b.top);
    }).map(function(c){return c.dataset.from});
    if(hit.length) hud[k]=hit;
  });
  var on=rs.filter(function(c){return c.on});
  var onRect=on[0]?cards.filter(function(c){return c.dataset.from===on[0].id})[0].getBoundingClientRect():null;
  var stage=document.getElementById('stage');
  // 阶段层：括号只数点位（形状另判），标签牌换回世界坐标，好和卡的世界矩形比有没有压住字。
  var stageR=stage.getBoundingClientRect();
  var wt=getComputedStyle(document.getElementById('world')).transform;
  var wm=wt==='none'?{a:1,e:0,f:0}:new DOMMatrix(wt);
  var toWorld=function(r){return {x:(r.left-stageR.left-wm.e)/wm.a,y:(r.top-stageR.top-wm.f)/wm.a,w:r.width/wm.a,h:r.height/wm.a}};
  var phls=Array.from(document.querySelectorAll('#bands .phl:not(.chl)')).map(function(x){
    var box=toWorld(x.getBoundingClientRect());
    var tail=x.querySelector('.pft');
    return {n:+x.dataset.n,text:x.textContent,title:x.title,tail:tail?tail.textContent:'',
      x:+box.x.toFixed(1),y:+box.y.toFixed(1),w:+box.w.toFixed(1),h:+box.h.toFixed(1)};
  });
  // 章带：牌与括号都单独数，判据是"章牌不压阶段牌、不压卡、括号不穿卡"。
  var chls=Array.from(document.querySelectorAll('#bands .chl')).map(function(x){
    var box=toWorld(x.getBoundingClientRect());
    return {n:+x.dataset.chap,text:x.textContent,title:x.title,
      x:+box.x.toFixed(1),y:+box.y.toFixed(1),w:+box.w.toFixed(1),h:+box.h.toFixed(1)};
  });
  var chapPaths=Array.from(document.querySelectorAll('#wires path[data-chap]')).map(function(p){
    return {n:+p.dataset.chap,cls:p.getAttribute('class'),pts:(p.getAttribute('d').match(/-?\\d+(?:\\.\\d+)?/g)||[]).map(Number)};
  });
  var bandPaths=Array.from(document.querySelectorAll('#wires path[data-band]')).map(function(p){
    return {n:+p.dataset.band,cls:p.getAttribute('class'),pts:(p.getAttribute('d').match(/-?\\d+(?:\\.\\d+)?/g)||[]).map(Number)};
  });
  return {tier:document.getElementById('world').dataset.tier,n:rs.length,overlap:overlap,order:order,
    rowH:rowH,lane:lane,lonely:lonely,hud:hud,boxOver:boxOver,
    cards:rs,
    wires:wires,wiresZ:+getComputedStyle(document.getElementById('wires')).zIndex||0,
    wireAudit:audit,
    phls:phls,chls:chls,bandPaths:bandPaths,chapPaths:chapPaths,
    maxCardZ:Math.max.apply(null,rs.map(function(c){return c.z})),
    onCount:on.length,
    onCenter:onRect?[Math.round(onRect.left+onRect.width/2),Math.round(onRect.top+onRect.height/2)]:null,
    stageCenter:[Math.round(stage.getBoundingClientRect().left+(stage.clientWidth-(document.getElementById('insp').hidden?0:360))/2),
                 Math.round(stage.getBoundingClientRect().top+stage.clientHeight/2)]};
})()`;
const geom = () => ev(GEOM);
const drift = (a, b) => {
  const m = new Map(a.cards.map((x) => [x.id, x]));
  const out = [];
  for (const x of b.cards) {
    const o = m.get(x.id);
    if (o && (Math.abs(o.x - x.x) > 0.5 || Math.abs(o.y - x.y) > 0.5)) out.push(`${x.id}:${o.x},${o.y}→${x.x},${x.y}`);
  }
  return out;
};
const wireFails = (g) => ({
  through: g.wires.filter((w) => w.through.length).map((w) => `${w.cls} ${w.from}→${w.to} 穿 ${w.through.join(',')}`),
  detached: g.wires.filter((w) => !w.attachFrom || !w.attachTo).map((w) => `${w.cls} ${w.from}→${w.to}`),
  bent: g.wires.filter((w) => w.bent).map((w) => `${w.cls} ${w.from}→${w.to}`),
  layer: g.wiresZ > g.maxCardZ ? [] : [`wires z=${g.wiresZ} ≤ card z=${g.maxCardZ}`],
});
const wireCountFails = (g) => {
  const a = g.wireAudit;
  const out = [];
  if (a.spine !== a.expectSpine) out.push(`主线 ${a.spine}≠${a.expectSpine}`);
  if (a.fork !== a.expectFork) out.push(`岔出 ${a.fork}≠${a.expectFork}`);
  if (a.back !== a.expectBack) out.push(`汇回 ${a.back}≠${a.expectBack}`);
  if (a.arrows !== a.total) out.push(`箭头 ${a.arrows}≠线 ${a.total}`);
  return out;
};

await sleep(1500);
// 页面每 4s 拉一次 /data.json、服务端每 20s 重建一次：撞上重建那一拍，首屏可能晚一拍才出卡。
// 就绪检查改成轮询（最多 20s），这不是放宽断言，是不拿冷启动的时序当作页面坏了。
let ready = false;
for (let i = 0; i < 40 && !ready; i++) {
  ready = await ev(`!!(document.querySelectorAll('#cards .p').length)`);
  if (!ready) await sleep(500);
}
if (!ready) throw new Error('页面没出卡：map serve 没起或 /atlas 路由变了');
await ev(`window.__errs=[];addEventListener('error',function(e){__errs.push(String(e.message))});addEventListener('unhandledrejection',function(e){__errs.push('rej:'+String(e.reason&&e.reason.message||e.reason))});true`);

/* 左栏（会话库）：分组、每条一个状态点、当前会话标本页、搜索可过滤、
   拖右边缘到最窄必须吸附成「一列状态灯」而不是消失，L 再展开。 */
let libReady = false;
for (let i = 0; i < 20 && !libReady; i++) {
  libReady = await ev(`document.querySelectorAll('#libbody .librow').length > 0`);
  if (!libReady) await sleep(500);
}
const lib1 = await ev(`(function(){
  var lib=document.getElementById('lib');
  var rows=Array.from(document.querySelectorAll('#libbody .librow'));
  var cur=rows.filter(function(a){return a.classList.contains('current')});
  var live=rows.filter(function(a){return a.classList.contains('live')})[0];
  var dot=live?live.querySelector('.dot'):null;
  return {
    exists:!!lib, w:Math.round(lib.getBoundingClientRect().width),
    groups:Array.from(document.querySelectorAll('#libbody .libgh b')).map(function(x){return x.textContent}),
    rows:rows.length, live:rows.filter(function(a){return a.classList.contains('live')}).length,
    dots:rows.filter(function(a){return a.querySelector('.dot')}).length,
    current:cur.length, currentHref:cur[0]?cur[0].getAttribute('href'):null,
    badHref:rows.filter(function(a){return !/^\\/s\\/[^/]+\\/$/.test(a.getAttribute('href')||'')}).length,
    anim:dot?getComputedStyle(dot).animationName:''
  };
})()`);
const libSearch = await ev(`(function(){
  var f=document.getElementById('libfind');
  f.value='zzzz-no-such'; f.dispatchEvent(new Event('input',{bubbles:true}));
  var none=document.querySelectorAll('#libbody .librow').length;
  var empty=/没有匹配/.test(document.getElementById('libbody').textContent);
  f.value=''; f.dispatchEvent(new Event('input',{bubbles:true}));
  return {none:none, empty:empty, back:document.querySelectorAll('#libbody .librow').length};
})()`);
const sp = await ev(`(function(){var r=document.getElementById('libsplit').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+160)}})()`);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sp.x, y: sp.y, button: 'left', clickCount: 1, buttons: 1 });
for (const dx of [-30, -80, -140, -220, -300]) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sp.x + dx, y: sp.y, button: 'left', buttons: 1 });
  await sleep(30);
}
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sp.x - 300, y: sp.y, button: 'left', clickCount: 1, buttons: 0 });
await sleep(500);
const railUi = await ev(`(function(){
  var lib=document.getElementById('lib'), rows=Array.from(document.querySelectorAll('#libbody .librow'));
  var head=document.querySelector('#lib .libhead');
  var live=rows.filter(function(a){return a.classList.contains('live')})[0];
  var dot=live?live.querySelector('.dot'):null;
  return {cls:document.body.classList.contains('lib-rail'), w:Math.round(lib.getBoundingClientRect().width),
    headHidden:!head||getComputedStyle(head).display==='none',
    dots:rows.filter(function(a){var d=a.querySelector('.dot');return d&&d.getBoundingClientRect().width>0}).length,
    texts:rows.every(function(a){var lt=a.querySelector('.lt');return !lt||getComputedStyle(lt).display==='none'}),
    anim:dot?getComputedStyle(dot).animationName:''};
})()`);
await shot('rail');
await key('KeyL', 'l', 76);
await sleep(500);
const libExpanded = await ev(`(function(){var lib=document.getElementById('lib');return {cls:document.body.classList.contains('lib-rail'),w:Math.round(lib.getBoundingClientRect().width),rows:document.querySelectorAll('#libbody .librow').length}})()`);
const libFails = [
  ['lib ready', libReady ? [] : ['10 秒内清单没出来']],
  ['lib exists', lib1.exists ? [] : ['没有 #lib']],
  ['lib groups', lib1.groups.length ? [] : ['没有分组头']],
  ['lib rows', lib1.rows >= 1 ? [] : ['一行都没有']],
  ['lib dots', lib1.dots === lib1.rows ? [] : [`${lib1.dots}/${lib1.rows}`]],
  ['lib current', lib1.current === 1 ? [] : [lib1.current]],
  ['lib current href', /^\/s\/[^/]+\/$/.test(lib1.currentHref || '') ? [] : [lib1.currentHref]],
  ['lib hrefs', lib1.badHref ? [lib1.badHref] : []],
  ['lib live breathe', (lib1.live === 0 || /breathe/.test(lib1.anim)) ? [] : [lib1.anim]],
  ['lib search', libSearch.none === 0 && libSearch.empty && libSearch.back === lib1.rows ? [] : [JSON.stringify(libSearch)]],
  ['lib rail', railUi.cls && railUi.w <= 40 && railUi.headHidden && railUi.dots === lib1.rows && railUi.texts
    ? [] : [JSON.stringify(railUi)]],
  ['lib rail breathe', (lib1.live === 0 || /breathe/.test(railUi.anim)) ? [] : [railUi.anim]],
  ['lib expand', !libExpanded.cls && libExpanded.w >= 150 && libExpanded.rows === lib1.rows ? [] : [JSON.stringify(libExpanded)]],
];

await ev(`document.getElementById('fit').click()`);
await settle();
const fit = await snap('fit（适应＝默认落的那一档）');
const gFit = await geom();
await shot('fit');

/* 流式连线（2026-11-02 用户要「箭头线条动起来」）：每条连线都挂同一个 wireflow、虚线不是 none、
   推进周期和被推的量同用一个 --cyc（乘回 z 必须还是 12 个屏幕像素，否则缩放时会和虚线错拍），
   并且 dashoffset 真的随帧往前走——只写了 animation-name 而不动画起来不算做到。 */
const flow = await ev(`(async function(){
  var W=document.getElementById('wires');
  var ps=Array.from(W.querySelectorAll('path[data-edge]'));
  var bad=[];
  ps.forEach(function(p){var cs=getComputedStyle(p);
    if(cs.animationName!=='wireflow'||cs.animationPlayState!=='running'||cs.strokeDasharray==='none')
      bad.push(p.dataset.edge+':'+cs.animationName+'/'+cs.animationPlayState+'/'+cs.strokeDasharray);});
  var z=new DOMMatrix(getComputedStyle(document.getElementById('world')).transform).a;
  var cyc=parseFloat(getComputedStyle(W).getPropertyValue('--cyc'));
  var offs=[];
  for(var i=0;i<10;i++){
    offs.push(parseFloat(getComputedStyle(ps[0]).strokeDashoffset)||0);
    await new Promise(function(r){requestAnimationFrame(function(){setTimeout(r,16)})});
  }
  var moved=offs.some(function(v,i){return i>0&&Math.abs(v-offs[i-1])>0.001});
  // 方向按逐帧投票：跨过一整个周期时首尾差会回正，端点相减不可信
  var dn=0,up=0;
  for(var j=1;j<offs.length;j++){ if(offs[j]<offs[j-1]) dn++; else if(offs[j]>offs[j-1]) up++; }
  return {n:ps.length,badN:bad.length,bad:bad.slice(0,3),cyc:+cyc.toFixed(2),z:+z.toFixed(3),
    screenCycle:+(cyc*z).toFixed(2),moved:moved,dir:dn>up?'forward':'not-forward',dn:dn,up:up,
    offs:offs.map(function(v){return +v.toFixed(2)})};
})()`);
const flowFails = (flow.badN ? [`${flow.badN}/${flow.n} 条线没挂上 wireflow：${flow.bad.join(' | ')}`] : [])
  .concat(flow.moved ? [] : ['dashoffset 没随帧变化：连线是静止的'])
  .concat(Math.abs(flow.screenCycle - 12) > 0.6 ? [`一个周期 ${flow.screenCycle}px 屏幕长度≠12：--cyc 没按 1/z 写`] : [])
  .concat(flow.dir === 'forward' ? [] : ['缺口往起点走（dashoffset 在增大），方向反了']);
await shot('flow');

// 字体口径（2026-10-27，用户把「正楷」更正为「苹果手机那套」）：全图统一 iOS 风格无衬线——
// 拉丁走系统 UI 字，中文走苹方 → Noto Sans SC → 雅黑；段号这类等宽元素也不许例外。
// 两层断言：① computed style 确认覆盖生效；② CDP platformFonts 看浏览器真正拿哪个字族画字
//（document.fonts.check 对系统字体不可靠：没装的苹方它也说 true，所以不用它判可用性）。
// 必须在中景量：platformFonts 只算节点自己的直排文字，且远景/印章档会把中景那几行 display:none 掉。
// 图上六十多块时 fit 会落到印章档（z≈0.19，中景行不显示），所以先走到中景再量。
await zoomNear(0.50, 0.62);
const fontProbe = await ev(`(function(){
  var pick=function(sel){var e=document.querySelector(sel); if(!e) return null; var cs=getComputedStyle(e); return {fam:cs.fontFamily,w:cs.fontWeight}};
  return {body:pick('body'), card:pick('#cards .p'), btn:pick('header > button'), seg:pick('.pseg')};
})()`);
await send('DOM.enable'); await send('CSS.enable');
const docRoot = await send('DOM.getDocument', { depth: 0 });
const platformFonts = async (sel) => {
  const { nodeId } = await send('DOM.querySelector', { nodeId: docRoot.root.nodeId, selector: sel });
  if (!nodeId) return null;
  const { fonts } = await send('CSS.getPlatformFontsForNode', { nodeId });
  return fonts;
};
const usedFonts = {};
for (const [k, sel] of Object.entries({ brand: '.brand b', step: '#cards .mstep', title: '#cards .mtitle', solved: '#cards .msolved' })) {
  const f = await platformFonts(sel);
  if (f && f.length) usedFonts[k] = f;
}
console.log(JSON.stringify({ fonts: {
  used: Object.fromEntries(Object.entries(usedFonts).map(([k, f]) => [k, f.map((x) => `${x.familyName}:${x.glyphCount}${x.isSyntheticBold ? '(合成加粗)' : ''}`)])),
} }, null, 1));

/* 阶段括号层（第十七轮）：括号条数＝每段在每行各一条；牌数与段数一致、文本只能是
   「阶段 N」「…+短名」「…+第 a–b 步 · 短名」「…（续）」这几种落点；牌不许压卡；
   点一张牌，右栏必须出六格（进行的是什么/完成进度/完成效果/对照 PRD·plan/progress 文件/规则），
   六格逐字等于 data.json 里那份外挂表；有引用就出引用 chip；页脚写明"模型说明"。 */
const phaseData = await ev(`fetch((function(){var p=location.pathname.split('/');return p[1]==='s'&&p[2]?'/s/'+p[2]:''})()+'/data.json').then(function(r){return r.json()}).then(function(d){
  return {list:(d.phases||[]).map(function(p){return {n:p.n,from:p.from,to:p.to,short:p.short,doing:p.doing,state:p.state,
    effect:p.effect,plan:p.plan,track:p.track,blockIds:p.blockIds||[],
    refs:(p.refs||[]).map(function(x){return {f:String(x.f).split('/').pop(),h:x.h}}),
    rules:(p.rules||[]).map(function(x){return {id:x.id,text:x.text}}),at:p.at}}),
  chaps:(d.chapters||[]).map(function(c){return {n:c.n,from:c.from,to:c.to,short:c.short,
    goal:c.goal,where:c.where,rules:c.rules,tasks:c.tasks,walls:c.walls,cautions:c.cautions,
    arch:c.arch,handoff:c.handoff,phaseNs:c.phaseNs||[],phaseCount:c.phaseCount,phaseSpan:c.phaseSpan,
    fromBlock:c.fromBlock,toBlock:c.toBlock,blocks:c.blocks,segs:(c.segs||[]).length,at:c.at,
    blockIds:c.blockIds||[]}}),
  tail:d.tail?{from:d.tail.from,to:d.tail.to,whole:!!d.tail.whole}:null};
})`);
/* 优先点一张"带规则"的阶段牌：规则格是这一层唯一由账本复算、不是模型写的格子，
   不点它就没有任何一条断言会走到那个分支。没有带规则的牌就退回编号最小的一张。
   minPx＝可点下限：牌在"适应"档可能被缩到 7px（图大了缩放比必然小），
   这时先按牌心放大到字可读的档再点——点牌考的是牌→六格这条路，不是"任何缩放都得 8px"。
   sel/prefer 参数化：章带和阶段带是同构的两条带，点章牌走的是另一条断言链（九格），
   选择器必须分开，否则章牌会冒充阶段牌被点走。
   最后一道是 elementFromPoint：牌在 HUD 下面看着在、实际点不到，真点一次才知道。 */
const pickChip = (minPx, sel, prefer) => ev(`(function(){
  var bad=['rowhint','legend','minimap','hintbar','hits','insp'].map(function(id){var e=document.getElementById(id);if(!e)return null;
    var cs=getComputedStyle(e); if(cs.display==='none'||cs.visibility==='hidden'||+cs.opacity===0||e.hidden)return null;
    var r=e.getBoundingClientRect(); return {l:r.left,t:r.top,r:r.right,b:r.bottom}}).filter(Boolean);
  var out=null;
  Array.from(document.querySelectorAll(${JSON.stringify(sel)})).forEach(function(c){
    var r=c.getBoundingClientRect();
    if(r.width<${minPx}||r.height<${minPx}) return;
    if(r.left<6||r.right>innerWidth-6||r.top<56||r.bottom>innerHeight-6) return;
    var hit=bad.some(function(b){return Math.min(r.right,b.r)>Math.max(r.left,b.l)&&Math.min(r.bottom,b.b)>Math.max(r.top,b.t)});
    if(hit) return;
    var cx=Math.round(r.left+r.width/2), cy=Math.round(r.top+r.height/2);
    var top=document.elementFromPoint(cx,cy);
    if(!top||!(top===c||c.contains(top))) return;
    var rank=[(${JSON.stringify(prefer || [])}).indexOf(+c.dataset.n)>=0?0:1,+c.dataset.n];
    if(!out||rank[0]<out.rank0||(rank[0]===out.rank0&&rank[1]<out.n))
      out={n:rank[1],rank0:rank[0],x:cx,y:cy,
        w:Math.round(r.width),h:Math.round(r.height)};
  });
  return out&&{n:out.n,x:out.x,y:out.y,w:out.w,h:out.h}})()`);
const PH_SEL = '#bands .phl:not(.chl)';
const CH_SEL = '#bands .chl';
const preferPhase = (phaseData.list || []).filter((p) => (p.rules || []).length && p.n).map((p) => p.n);
const pickPhase = (minPx) => pickChip(minPx, PH_SEL, preferPhase);
/* 章牌挑一张"多程"的（phaseCount 最大的那一章，并列取编号最小）：九格里「这一章里的每一程」
   只有在这种章上才会画出多条阶段链，点单程章等于没测那条路径。 */
const preferChap = (() => {
  const cs = phaseData.chaps || [];
  if (!cs.length) return [];
  const best = Math.max(...cs.map((c) => c.phaseCount || 0));
  return cs.filter((c) => (c.phaseCount || 0) === best).map((c) => c.n);
})();
const pickChapChip = (minPx) => pickChip(minPx, CH_SEL, preferChap);
let phaseHit = await pickPhase(8);
if (!phaseHit) {
  const cand = await pickPhase(2);
  if (cand) {
    for (let i = 0; i < 40; i++) {
      if ((await settle()) >= 0.45) break;
      await wheel(-40, cand.x, cand.y);
    }
    await settle();
    phaseHit = await pickPhase(8);
  }
}
let phaseDetail = null;
if (phaseHit) {
  await clickAt(phaseHit.x, phaseHit.y);
  await settle();
  phaseDetail = await ev(`(function(){
    var head=document.querySelector('#inspbody .iid');
    var title=document.querySelector('#inspbody .ititle');
    var src=document.querySelector('#inspbody .isrc');
    var rows=Array.from(document.querySelectorAll('#inspbody .ifact')).map(function(r){
      var ik=r.querySelector('.ik'), cell=r.querySelector('.iv');
      var plan=/对照 PRD|progress/.test(ik?ik.textContent:'');
      var first=cell&&cell.querySelector('div:not(.rchips)');
      return {k:ik?ik.textContent:'', v:plan?(first?first.textContent:(cell?cell.textContent:'')):(cell?cell.textContent:''),
        chips:Array.from(r.querySelectorAll('.rchip')).map(function(x){return x.textContent})};
    });
    return {head:head?head.textContent:'', title:title?title.textContent:'', src:src?src.textContent:'',
      rows:rows, btns:Array.from(document.querySelectorAll('#inspbody .ibtn')).map(function(x){return x.textContent})};
  })()`);
  await shot('phase');
  await key('Escape', 'Escape', 27);
  await settle();
}

/* 章带（第十九轮）：点一张章牌 → 右栏出九格，逐字等于 data.json 的 chapters，
   「这一章里的每一程」把章内的阶段牌列出来（点它换回六格），底部有「复制 handoff」。
   这一页的全部意义是"读完这一块，不用回头看那几十步"，所以九格一个字都不许是页面自己拼的。 */
let chapHit = await pickChapChip(8);
if (!chapHit) {
  const cand = await pickChapChip(2);
  if (cand) {
    for (let i = 0; i < 40; i++) {
      if ((await settle()) >= 0.45) break;
      await wheel(-40, cand.x, cand.y);
    }
    await settle();
    chapHit = await pickChapChip(8);
  }
}
let chapDetail = null;
if (chapHit) {
  await clickAt(chapHit.x, chapHit.y);
  await settle();
  chapDetail = await ev(`(function(){
    var q=function(s){var e=document.querySelector(s);return e?e.textContent:''};
    return {head:q('#inspbody .iid'), pill:q('#inspbody .ihead .lvpill'), title:q('#inspbody .ititle'), src:q('#inspbody .isrc'),
      rows:Array.from(document.querySelectorAll('#inspbody .ifact')).map(function(r){
        var ik=r.querySelector('.ik'), iv=r.querySelector('.iv');
        return {k:ik?ik.textContent:'', v:iv?iv.textContent:''};
      }),
      secs:Array.from(document.querySelectorAll('#inspbody .isec')).map(function(x){return x.textContent}),
      links:Array.from(document.querySelectorAll('#inspbody .ilink')).map(function(x){return x.textContent}),
      btns:Array.from(document.querySelectorAll('#inspbody .ibtn')).map(function(x){return x.textContent}),
      // 一章跨几行就点亮几条括号：判据是"点亮的都属这一章、条数＝这一章的行段数"，不是恒等于 1
      chapOn:[].slice.call(document.querySelectorAll('#wires path[data-chap].on')).map(function(p){return +p.dataset.chap}),
      bandOn:[].slice.call(document.querySelectorAll('#wires path[data-band].on')).map(function(p){return p.dataset.band}),
      chlOn:[].slice.call(document.querySelectorAll('#bands .chl.on')).map(function(c){return +c.dataset.chap}),
      phlOn:[].slice.call(document.querySelectorAll('#bands .phl:not(.chl).on')).map(function(c){return c.dataset.n})};
  })()`);
  await shot('chapter');
  await key('Escape', 'Escape', 27);
  await settle();
}
const phaseFails = (function () {
  const list = (phaseData && phaseData.list) || [];
  if (!list.length) return [['phase table', ['data.json 里没有 phases（阶段层没接上）']]];
  const fails = [];
  const byN = new Map();
  for (const p of list) {
    const rows = new Set();
    for (const i of p.blockIds) {
      const c = gFit.cards.find((x) => x.i === i);
      if (c && c.step != null) rows.add(c.y);
    }
    byN.set(p.n, { ...p, segs: rows.size });
  }
  const expectSegs = list.reduce((a, p) => a + byN.get(p.n).segs, 0);
  /* 尾段带（还没写阶段说明的那些步）也是 data-band 钩子上的路径，编号是 'T'：
     它和阶段括号共用一条选择器，所以分开数——否则账本一长过最后一段阶段，
     "band paths" 就凭空多出几条，看着像回归其实是数据。 */
  const tailPaths = gFit.bandPaths.filter((b) => !Number.isFinite(b.n));
  const phPaths = gFit.bandPaths.filter((b) => Number.isFinite(b.n));
  const lastTo = Math.max(...list.map((p) => p.to));
  const tailRows = phaseData.tail
    ? new Set(gFit.cards.filter((c) => c.step != null && c.step > lastTo).map((c) => c.y)).size : 0;
  if (phPaths.length !== expectSegs) fails.push(['band paths', `${phPaths.length}≠${expectSegs}`]);
  if (tailPaths.length !== tailRows) fails.push(['tail bands', `${tailPaths.length}≠${tailRows}`]);
  const segsPerPhase = {};
  for (const b of phPaths) segsPerPhase[b.n] = (segsPerPhase[b.n] || 0) + 1;
  for (const p of list) if (!segsPerPhase[p.n]) fails.push(['phase without band', String(p.n)]);
  const badShape = gFit.bandPaths.filter((b) => {
    const n = b.pts;
    return n.length !== 8 || n[0] !== n[2] || n[4] !== n[6]
      || Math.abs((n[1] - n[3]) + 7) > 0.6 || Math.abs(n[5] - n[3]) > 0.6
      || Math.abs((n[7] - n[5]) + 7) > 0.6 || !(n[6] > n[2]);
  }).map((b) => `${b.n}:${b.pts.join(',')}`);
  if (badShape.length) fails.push(['band shape', badShape]);
  if (gFit.phls.length !== gFit.bandPaths.length) fails.push(['chip count', `${gFit.phls.length}≠${gFit.bandPaths.length}`]);
  const badText = [];
  for (const c of gFit.phls) {
    if (c.n === null) {
      // 尾段牌：整段没阶段时写「未划阶段」，否则「尾段」；续行只说「（续）」，印章档只剩编号
      const head = phaseData.tail && phaseData.tail.whole ? '未划阶段' : '尾段';
      const allowed = [head, head + '阶段说明待写', head + '（续）'];
      if (!allowed.includes(c.text)) badText.push(`尾:${c.text}`);
      const t = phaseData.tail;
      if (t && c.title.indexOf('第 ' + t.from + '–' + t.to + ' 步') < 0) badText.push('尾 title 没有步区间');
      if (t && c.title.indexOf('阶段说明待写') < 0 && c.title.indexOf('未划阶段') < 0) badText.push('尾 title 没说实话');
      continue;
    }
    const p = byN.get(c.n);
    if (!p) { badText.push(`${c.n} 无对应阶段`); continue; }
    const full = '阶段 ' + p.n + '第 ' + p.from + (p.to === p.from ? '' : '–' + p.to) + ' 步' + (p.short ? ' · ' + p.short : '');
    const allowed = ['阶段 ' + p.n, full, '阶段 ' + p.n + (p.short || ''), '阶段 ' + p.n + '（续）'];
    if (!allowed.includes(c.text)) badText.push(`${c.n}:${c.text}`);
    if (p.short && c.title.indexOf(p.short) < 0) badText.push(`${c.n} title 没有短名`);
    if (c.title.indexOf('第 ' + p.from + '–' + p.to + ' 步') < 0) badText.push(`${c.n} title 没有步区间`);
  }
  if (badText.length) fails.push(['chip text', badText]);
  const chipOver = [];
  for (const c of gFit.phls) {
    for (const card of gFit.cards) {
      if (Math.min(c.x + c.w, card.x + card.w) - Math.max(c.x, card.x) > 0.5
        && Math.min(c.y + c.h, card.y + card.h) - Math.max(c.y, card.y) > 0.5) chipOver.push(`${c.n}/${card.id}`);
    }
  }
  if (chipOver.length) fails.push(['chip over card', chipOver]);
  if (!phaseHit) fails.push(['phase chip click', ['没有一张阶段标签可点（全被 HUD 挡住或不可见）']]);
  else if (!phaseDetail) fails.push(['phase inspector', ['点了标签但右栏没出内容']]);
  else {
    const p = byN.get(phaseHit.n);
    if (!p) fails.push(['phase inspector', ['点到的阶段不在 data.json 里']]);
    else {
      if (phaseDetail.head !== '阶段 ' + p.n) fails.push(['head', phaseDetail.head]);
      const title = '第 ' + p.from + (p.to === p.from ? '' : '–' + p.to) + ' 步 · ' + (p.short || '（没有短名）');
      if (phaseDetail.title !== title) fails.push(['title', phaseDetail.title]);
      const keys = phaseDetail.rows.map((r) => r.k).filter((k) => /^(进行的是什么|完成进度|完成效果|对照 PRD·plan|progress 文件|规则)$/.test(k));
      if (keys.join('|') !== '进行的是什么|完成进度|完成效果|对照 PRD·plan|progress 文件|规则') fails.push(['six rows', keys.join('|')]);
      const get = (k) => (phaseDetail.rows.find((r) => r.k === k) || {}).v;
      const getChips = (k) => (phaseDetail.rows.find((r) => r.k === k) || {}).chips || [];
      if (get('进行的是什么') !== p.doing) fails.push(['doing', get('进行的是什么')]);
      if (get('完成进度') !== p.state) fails.push(['state', get('完成进度')]);
      if (get('完成效果') !== p.effect) fails.push(['effect', get('完成效果')]);
      if (p.plan === '—') { if (!/没有可引用的文档章节/.test(get('对照 PRD·plan'))) fails.push(['plan', get('对照 PRD·plan')]); }
      else if (get('对照 PRD·plan') !== p.plan) fails.push(['plan', get('对照 PRD·plan')]);
      if (p.track === '—') { if (!/没有可引用的进度文件章节/.test(get('progress 文件'))) fails.push(['track', get('progress 文件')]); }
      else if (get('progress 文件') !== p.track) fails.push(['track', get('progress 文件')]);
      const chips = [...getChips('对照 PRD·plan'), ...getChips('progress 文件')];
      if (chips.length !== p.refs.length) fails.push(['refs', `${chips.length}≠${p.refs.length}`]);
      else if (p.refs.length && !p.refs.every((r) => chips.includes(r.f + ' › ' + r.h))) fails.push(['refs text', chips.join('|')]);
      if (!p.rules.length) {
        if (!/没有过判据的规则/.test(get('规则'))) fails.push(['rules', get('规则')]);
      } else if (!p.rules.every((r) => get('规则').includes(r.id) && get('规则').includes(r.text))) fails.push(['rules', get('规则')]);
      if (!/^模型说明（归纳，不过六条判据） · 写于 /.test(phaseDetail.src)) fails.push(['src', phaseDetail.src]);
      if (!phaseDetail.btns.some((b) => b === '定位到第 ' + p.from + ' 步')) fails.push(['btn', phaseDetail.btns.join('|')]);
    }
  }
  return fails;
})();

/* 章带判据（PRD-atlas 十一）：
   1) 没写章就什么都不许画；2) 括号条数＝每章在各行各一条；3) 章牌只许坐在阶段牌之上，
   不许压阶段牌、不许压卡；4) 点章牌出九格，九格逐字来自 data.json，选中态只亮章括号。 */
const CHAP_KEYS = ['一开始的目的', '走到哪', '核心规则与原则', '主要任务', '碰过的壁', '接下来要注意', '架构现状', '怎么接手'];
const chapFails = (function () {
  const list = (phaseData && phaseData.chaps) || [];
  if (!list.length) {
    const out = [];
    if (gFit.chls.length) out.push(['chl without chapters', gFit.chls.map((c) => c.n)]);
    if (gFit.chapPaths.length) out.push(['chapband without chapters', gFit.chapPaths.map((b) => b.n)]);
    return out;
  }
  const fails = [];
  const byN = new Map();
  for (const c of list) {
    const rows = new Set();
    for (const i of c.blockIds) {
      const k = gFit.cards.find((x) => x.i === i);
      if (k && k.step != null) rows.add(k.y);
    }
    byN.set(c.n, { ...c, segs: rows.size });
  }
  const expectSegs = list.reduce((a, c) => a + byN.get(c.n).segs, 0);
  if (gFit.chapPaths.length !== expectSegs) fails.push(['chap bands', `${gFit.chapPaths.length}≠${expectSegs}`]);
  const perChap = {};
  for (const b of gFit.chapPaths) perChap[b.n] = (perChap[b.n] || 0) + 1;
  for (const c of list) if (!perChap[c.n]) fails.push(['chap without band', String(c.n)]);
  // 带高是 PRD 钉死的几何：章牌顶＝rowY−106、章括号线＝rowY−68、阶段括号线＝rowY−12
  // （阶段带高 56 ⇒ 两条括号恒差 56）。用真实卡行反查偏移，改了常量就会红。
  const rowTops = [...new Set(gFit.cards.map((c) => c.y))].sort((a, b) => a - b);
  const snap = (v) => rowTops.reduce((best, r) => (Math.abs(r - v) < Math.abs(best - v) ? r : best), rowTops[0]);
  const badGeo = [];
  for (const c of gFit.chls) {
    const d = Math.abs(snap(c.y + 106) - (c.y + 106));
    if (d > 1.5) badGeo.push(`牌${c.n}顶偏离 ${d.toFixed(1)}px`);
  }
  for (const b of gFit.chapPaths) {
    const d = Math.abs(snap(b.pts[3] + 68) - (b.pts[3] + 68));
    if (d > 1.5) badGeo.push(`括号${b.n}线偏离 ${d.toFixed(1)}px`);
  }
  if (badGeo.length) fails.push(['chap band geometry', badGeo]);
  const badShape = gFit.chapPaths.filter((b) => {
    const n = b.pts;
    return n.length !== 8 || n[0] !== n[2] || n[4] !== n[6]
      || Math.abs((n[1] - n[3]) + 7) > 0.6 || Math.abs(n[5] - n[3]) > 0.6
      || Math.abs((n[7] - n[5]) + 7) > 0.6 || !(n[6] > n[2]);
  }).map((b) => `${b.n}:${b.pts.join(',')}`);
  if (badShape.length) fails.push(['chap band shape', badShape]);
  if (gFit.chls.length !== gFit.chapPaths.length) fails.push(['chap chip count', `${gFit.chls.length}≠${gFit.chapPaths.length}`]);
  const badText = [];
  for (const c of gFit.chls) {
    const p = byN.get(c.n);
    if (!p) { badText.push(`${c.n} 无对应章`); continue; }
    const full = '章 ' + p.n + '第 ' + p.from + '–' + p.to + ' 步' + (p.short ? ' · ' + p.short : '');
    const allowed = ['章 ' + p.n, full, '章 ' + p.n + (p.short || ''), '章 ' + p.n + '（续）'];
    if (!allowed.includes(c.text)) badText.push(`${c.n}:${c.text}`);
    if (p.short && c.title.indexOf(p.short) < 0) badText.push(`${c.n} title 没有章名`);
    if (c.title.indexOf('第 ' + p.from + '–' + p.to + ' 步') < 0) badText.push(`${c.n} title 没有步区间`);
    if (!/目的/.test(c.title)) badText.push(`${c.n} title 没有九格提示`);
    // 每张牌的悬停提示都写着这一章的事实区间：逐张核对，等于把五章的「范围」行都验一遍
    const want = '第 ' + p.from + '–' + p.to + ' 步 · 块 ' + p.fromBlock + '–' + p.toBlock;
    if (c.title.indexOf(want) < 0) badText.push(`${c.n} title 区间=${c.title.slice(0, 46)}`);
  }
  if (badText.length) fails.push(['chap chip text', badText]);
  const over = [];
  for (const c of gFit.chls) {
    for (const card of gFit.cards) {
      if (Math.min(c.x + c.w, card.x + card.w) - Math.max(c.x, card.x) > 0.5
        && Math.min(c.y + c.h, card.y + card.h) - Math.max(c.y, card.y) > 0.5) over.push(`${c.n}/${card.id}`);
    }
    // 章牌横跨整章，同行必然与阶段牌左右重叠：真正要判的是纵向不相交——章牌底不许压到阶段牌的字上
    const row = snap(c.y + 106);
    for (const pc of gFit.phls) {
      if (Math.abs(snap(pc.y + 50) - row) > 1) continue;
      if (pc.y < c.y + c.h - 0.5) over.push(`章${c.n}牌底 ${c.y}+${c.h} 压到阶段${pc.n}牌顶 ${pc.y}`);
    }
  }
  if (over.length) fails.push(['chap chip overlap', over]);
  if (!chapHit) fails.push(['chap chip click', ['没有一张章标签可点（全被 HUD 挡住或不可见）']]);
  else if (!chapDetail) fails.push(['chap inspector', ['点了章牌但右栏没出内容']]);
  else {
    const p = byN.get(chapHit.n);
    if (!p) fails.push(['chap inspector', ['点到的章不在 data.json 里']]);
    else {
      if (chapDetail.head !== '章 ' + p.n) fails.push(['chap head', chapDetail.head]);
      const title = '第 ' + p.from + '–' + p.to + ' 步 · ' + (p.short || '（没有章名）');
      if (chapDetail.title !== title) fails.push(['chap title', chapDetail.title]);
      if (chapDetail.pill !== p.phaseSpan + ' · ' + p.phaseCount + ' 程') fails.push(['chap pill', chapDetail.pill]);
      const keys = chapDetail.rows.map((r) => r.k).filter((k) => CHAP_KEYS.includes(k) || /^(范围|计数)$/.test(k));
      if (keys.join('|') !== ['范围', '计数'].concat(CHAP_KEYS).join('|')) fails.push(['chap nine rows', keys.join('|')]);
      const get = (k) => (chapDetail.rows.find((r) => r.k === k) || {}).v;
      const want = { 范围: '第 ' + p.from + '–' + p.to + ' 步 · 块 ' + p.fromBlock + '–' + p.toBlock, 计数: p.blocks + ' 块' };
      for (const k of ['范围', '计数']) if (get(k).indexOf(want[k]) !== 0) fails.push(['chap ' + k, get(k)]);
      for (const [cell, label] of [['goal', '一开始的目的'], ['where', '走到哪'], ['rules', '核心规则与原则'],
        ['tasks', '主要任务'], ['walls', '碰过的壁'], ['cautions', '接下来要注意'], ['arch', '架构现状'], ['handoff', '怎么接手']]) {
        const v = p[cell] || '—';
        const got = get(label);
        if (v === '—') { if (!/这一格没有源/.test(got)) fails.push(['chap ' + cell, got]); }
        else if (got !== v) fails.push(['chap ' + cell, got]);
      }
      if (!/^模型说明（归纳，不过六条判据） · 写于 /.test(chapDetail.src)) fails.push(['chap src', chapDetail.src]);
      const inside = (phaseData.list || []).filter((x) => x.from >= p.from && x.to <= p.to);
      if (chapDetail.links.length !== inside.length) fails.push(['chap phase links', `${chapDetail.links.length}≠${inside.length}`]);
      if (!chapDetail.btns.includes('定位到第 ' + p.from + ' 步')) fails.push(['chap btn', chapDetail.btns.join('|')]);
      if (!chapDetail.btns.includes('复制 handoff')) fails.push(['chap handoff btn', chapDetail.btns.join('|')]);
      if (chapDetail.chapOn.length !== p.segs || chapDetail.chapOn.some((x) => x !== p.n))
        fails.push(['chap band on', `${chapDetail.chapOn.length}条(${chapDetail.chapOn.join(',')}≠${p.segs}×${p.n})`]);
      if (chapDetail.chlOn.length !== p.segs || chapDetail.chlOn.some((x) => x !== p.n))
        fails.push(['chap chip on', `${chapDetail.chlOn.length}张(${chapDetail.chlOn.join(',')}≠${p.segs}×${p.n})`]);
      // 选章不许把阶段/尾段的选中态一起点亮：两条带共用 .phl 类，钩子分家才算干净
      if (chapDetail.bandOn.length || chapDetail.phlOn.length)
        fails.push(['chap select leak', `band=${chapDetail.bandOn.join(',')} chip=${chapDetail.phlOn.join(',')}`]);
    }
  }
  return fails;
})();

/* 牌高在世界坐标里随档位变大（近 20 / 中 24 / 远 26 / 印章 32 字号），带高 56 是拿最坏一档
   量出来的：每一档都重量一次"章牌不压卡、也不压它下面那张阶段牌"。 */
const bandClash = (g) => {
  const tops = [...new Set(g.cards.map((c) => c.y))];
  const near = (v) => tops.reduce((b, r) => (Math.abs(r - v) < Math.abs(b - v) ? r : b), tops[0]);
  const out = [];
  for (const c of g.chls) {
    for (const card of g.cards) {
      if (Math.min(c.x + c.w, card.x + card.w) - Math.max(c.x, card.x) > 0.5
        && Math.min(c.y + c.h, card.y + card.h) - Math.max(c.y, card.y) > 0.5) out.push(`章${c.n}/${card.id}`);
    }
    const row = near(c.y + 106);
    for (const pc of g.phls) {
      if (near(pc.y + 50) !== row) continue;
      if (pc.y < c.y + c.h - 0.5) out.push(`章${c.n}牌底压阶段${pc.n}牌顶`);
    }
  }
  return out;
};

/* 章笔记（PRD-atlas 十二）：字按屏幕像素排，所以 12% 的「适应」也读得出；
   它跟着视口中心那一章走，点一下就是九格那一份文本。判据全部量自页面，不靠眼睛。 */
const noteAt = () => ev(`(function(){
  var n=document.getElementById('chapnote'); if(!n) return {missing:true};
  var cs=getComputedStyle(n), r=n.getBoundingClientRect();
  var f=document.querySelector('#bands .chl.focus'), g=n.querySelector('.cgo'), gr=g&&g.getBoundingClientRect();
  var gt=gr&&document.elementFromPoint(Math.round(gr.left+gr.width/2),Math.round(gr.top+gr.height/2));
  return {hidden:n.hidden,font:parseFloat(cs.fontSize),w:Math.round(r.width),h:Math.round(r.height),
    pe:getComputedStyle(n).pointerEvents,
    title:(n.querySelector('.cname')||{}).textContent||'',range:(n.querySelector('.crange')||{}).textContent||'',
    lines:Array.from(n.querySelectorAll('.cln')).map(function(x){var s=x.querySelector('span');
      return {k:x.querySelector('b').textContent,v:s.textContent,clipV:s.scrollHeight>s.clientHeight+1,clipH:s.scrollWidth>s.clientWidth+1}}),
    go:g?g.textContent:'',goTag:g?g.tagName:'',goHit:!!(gt&&g&&(gt===g||g.contains(gt))),
    goBox:gr?{x:Math.round(gr.left+gr.width/2),y:Math.round(gr.top+gr.height/2)}:null,
    focusChap:f?+f.dataset.chap:null,focusN:document.querySelectorAll('#bands .chl.focus').length,
    // #stage 是 overflow:hidden，被脚本滚走时卡会跑出视口——留着这一格，定位这种"点不到"只要一行
    stageScroll:[document.getElementById('stage').scrollTop,document.getElementById('stage').scrollLeft],
    inView:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight};
})()`);
const clickByText = async (sel, txt) => {
  /* 九格面板要在自己那一列里滚到底才露出按钮。不能用 scrollIntoView：它会连 overflow:hidden 的
     #stage 一起滚走，左上角的章笔记就被推出视口（点不到，还以为是功能的毛病）。
     这里只滚"真正 overflow:auto 的那一层"，滚完再按 elementFromPoint 确认真的点得到。 */
  const at = await ev(`(function(){var e=Array.from(document.querySelectorAll(${JSON.stringify(sel)})).filter(function(x){return x.textContent===${JSON.stringify(txt)}})[0];
    if(!e)return null;
    for(var b=e.parentElement;b;b=b.parentElement){var oy=getComputedStyle(b).overflowY;
      if(oy==='auto'||oy==='scroll'){var q=e.getBoundingClientRect();if(q.bottom>innerHeight-20||q.top<60)b.scrollTop+=(q.bottom-(innerHeight-70));break;}}
    var r=e.getBoundingClientRect();
    var x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2);
    if(x<1||y<1||x>innerWidth-2||y>innerHeight-2)return {off:1,x:x,y:y};
    var t=document.elementFromPoint(x,y);
    if(!t||!(t===e||e.contains(t)))return {blocked:1,by:t?(t.id||t.tagName):'空'};
    return {x:x,y:y}})()`);
  if (!at || at.off || at.blocked) return false;
  await clickAt(at.x, at.y);
  await settle();
  return true;
};
/* 一张章牌能不能真的点到：牌心在屏外、缩到 8px 以下、被浮层挡住的都不算。
   章牌一章有好几张（一行一张），逐张试——"这一章够得着"只需要一张。 */
const chapChipHit = (n) => ev(`(function(){
  var cs=Array.from(document.querySelectorAll('#bands .chl[data-chap="'+${n}+'"]'));
  var off=0,small=0,block=0;
  for(var i=0;i<cs.length;i++){
    var e=cs[i],r=e.getBoundingClientRect();
    if(r.width<8||r.height<8){small++;continue;}
    var x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2);
    if(x<6||y<56||x>innerWidth-6||y>innerHeight-6){off++;continue;}
    var t=document.elementFromPoint(x,y);
    if(t&&(t===e||e.contains(t))) return {hit:true,x:x,y:y};
    block++;
  }
  return {hit:false,off:off,small:small,block:block,total:cs.length};})()`);
const clickChapChip = async (n) => {
  const at = await chapChipHit(n);
  if (!at || !at.hit) return { ok: false, why: at ? `没有一张可点（屏外${at.off}·太小${at.small}·被挡${at.block}·共${at.total}）` : '查不到' };
  await clickAt(at.x, at.y);
  await settle();
  return { ok: true };
};
/* 视口正中落到了哪一块：与页面同一套基准点算法（右栏开着要让出的那 360px 也算进去）。
   这里还能看见 data.json 的章区间——焦点算错时一眼分得出是几何不对还是章表映射不对。 */
const viewFocusRaw = () => ev(`(function(){
  var st=document.getElementById('stage'),wm=new DOMMatrix(getComputedStyle(document.getElementById('world')).transform);
  var insp=document.getElementById('insp');
  var cx=((st.clientWidth-(insp.hidden?0:360))/2-wm.e)/wm.a, cy=(st.clientHeight/2-wm.f)/wm.a;
  var rs=[];
  document.querySelectorAll('#cards .p').forEach(function(c){
    var step=c.dataset.step===''?null:+c.dataset.step;
    var d=Math.hypot(Math.max(c.offsetLeft-cx,0,cx-(c.offsetLeft+c.offsetWidth)),Math.max(c.offsetTop-cy,0,cy-(c.offsetTop+c.offsetHeight)));
    rs.push({d:Math.round(d),step:step,on:c.classList.contains('on')});
  });
  rs.sort(function(a,b){return a.d-b.d||(a.step||0)-(b.step||0)});
  return {z:+wm.a.toFixed(4),tier:document.getElementById('world').dataset.tier,cx:Math.round(cx),cy:Math.round(cy),near:rs.slice(0,5)};
})()`);
const chapOfStep = (s) => { for (const c of (phaseData.chaps || [])) if (s != null && s >= c.from && s <= c.to) return c.n; return null; };
const viewFocus = async (want) => {
  const r = await viewFocusRaw();
  r.near.forEach((x) => { x.chap = chapOfStep(x.step); });
  r.want = want;
  return r;
};
const noteFails = [];
let noteReach = '';
{
  const list = (phaseData.chaps || []).slice().sort((a, b) => a.n - b.n);
  if (!list.length) {
    const n0 = await noteAt();
    if (!n0.missing && !n0.hidden) noteFails.push(['note without chapters', JSON.stringify(n0)]);
  } else {
    // 前面那些块把镜头留在了中景：笔记的第一次判读要发生在用户按「适应」看到的那一屏
    await ev(`document.getElementById('fit').click()`);
    await settle();
    const n0 = await noteAt();
    if (n0.missing) noteFails.push(['note element', '页面上没有 #chapnote']);
    else {
      if (n0.hidden) noteFails.push(['note hidden at fit', JSON.stringify(n0)]);
      // 这一条是本轮的中心：世界像素的字在 12% 只剩 4px，笔记必须按屏幕像素读得出
      if (n0.font < 11) noteFails.push(['note font at fit', `${n0.font}px < 11px`]);
      if (!n0.inView || n0.w < 200 || n0.h < 40) noteFails.push(['note box', `${n0.w}x${n0.h} inView=${n0.inView}`]);
      const keys = n0.lines.map((x) => x.k);
      if (keys.join('|') !== '目的|走到哪|接手') noteFails.push(['note lines', keys.join('|')]);
      if (n0.lines.some((x) => x.clipV)) noteFails.push(['note clipped', JSON.stringify(n0.lines.filter((x) => x.clipV))]);
      if (!n0.lines.every((x) => x.v && x.v !== '—')) noteFails.push(['note empty cell', JSON.stringify(n0.lines)]);
      const m0 = /^章 (\d+) · (.+)$/.exec(n0.title);
      if (!m0) noteFails.push(['note title', n0.title]);
      else {
        const c = list.find((x) => x.n === +m0[1]);
        if (!c) noteFails.push(['note chapter unknown', n0.title]);
        else {
          if (n0.range !== '第 ' + c.from + '–' + c.to + ' 步') noteFails.push(['note range', n0.range]);
          if (m0[2] !== (c.short || '（没有章名）')) noteFails.push(['note short', m0[2]]);
          const want = { 目的: c.goal, 走到哪: c.where, 接手: c.handoff };
          for (const x of n0.lines) if (x.v !== (want[x.k] || '—')) noteFails.push(['note ' + x.k, x.v.slice(0, 40)]);
        }
      }
      if (n0.focusChap === null || (m0 && n0.focusChap !== +m0[1])) noteFails.push(['note focus mismatch', `${n0.focusChap} vs ${n0.title}`]);
      if (n0.focusN < 1) noteFails.push(['note focus chips', String(n0.focusN)]);
      // 卡坐在第一行章牌上：整张卡必须不吃点击，唯一能点的只有末尾那枚按钮
      if (n0.pe !== 'none') noteFails.push(['note eats canvas clicks', `pointer-events=${n0.pe}`]);
      if (n0.goTag !== 'BUTTON' || !n0.goHit) noteFails.push(['note button', `tag=${n0.goTag} hittable=${n0.goHit}`]);
      if (!/^打开九格 · /.test(n0.go)) noteFails.push(['note button text', n0.go]);
      /* 焦点跟着镜头换章：走真路径——点章牌开九格 → 点「定位到第 N 步」，镜头落到那一章，
         笔记必须跟着换成那一章。只验一次等于没验"会换"，所以取够得着的章里首末两张。
         585 段的图在「适应」那一档把章牌压成 3–5px，谁也点不到：这时按滚轮往中间推一档，
         点得到牌才谈得上跟镜头——放大本身不是这条断言要考的东西。 */
      const reachOf = async () => { const out = []; for (const c of list) if ((await chapChipHit(c.n)).hit) out.push(c); return out; };
      let reach = await reachOf();
      for (let i = 0; i < 18 && reach.length < 2; i++) { await wheel(-40); await settle(); reach = await reachOf(); }
      noteReach = reach.length + '/' + list.length + '@z' + (await cam()).toFixed(2);
      if (!reach.length) noteFails.push(['note: no reachable chapter chip', JSON.stringify(await Promise.all(list.map((c) => chapChipHit(c.n))))]);
      const picks = reach.length ? [reach[0], reach[reach.length - 1]].filter((c, i, a) => a.findIndex((x) => x.n === c.n) === i) : [];
      const seen = [];
      for (const c of picks) {
        const hit = await clickChapChip(c.n);
        if (!hit.ok) { noteFails.push(['note: chip ' + hit.why, String(c.n)]); continue; }
        if (!(await clickByText('#inspbody .ibtn', '定位到第 ' + c.from + ' 步'))) { noteFails.push(['note jump button', `章${c.n} 没有「定位到第 ${c.from} 步」`]); continue; }
        const nc = await noteAt();
        seen.push(nc.title);
        const diag = await viewFocus(c.n);
        const landed = diag.near.length ? diag.near[0].chap : null;
        // 先确认镜头真的落进了那一章：跳错了位置是「定位」的毛病，不该记在笔记头上
        if (landed !== c.n) noteFails.push(['note jump landed elsewhere', JSON.stringify(diag)]);
        else {
          if (nc.title !== '章 ' + c.n + ' · ' + (c.short || '（没有章名）')) noteFails.push(['note follow camera', `${nc.title}≠章${c.n} ${JSON.stringify(diag)}`]);
          if (nc.focusChap !== c.n) noteFails.push(['note focus after move', `${nc.focusChap}≠${c.n} ${JSON.stringify(diag)}`]);
        }
        if (nc.font < 11) noteFails.push(['note font after zoom', String(nc.font)]);
        await key('Escape', 'Escape', 27);
        await settle();
      }
      if (picks.length > 1 && new Set(seen).size < 2) noteFails.push(['note never changed', seen.join('|')]);
      /* 点笔记末尾那枚按钮＝打开那一章的九格（与章牌同一条路，不复制第二份文本）。
         先确认面板是关着的：Escape 只隐藏不清空，读到旧标题会假装点通了。 */
      await ev(`document.getElementById('fit').click()`);
      await settle();
      const nb = await noteAt();
      const before = await ev(`(function(){var i=document.getElementById('insp');return {open:!i.hidden,id:(document.querySelector('#inspbody .iid')||{}).textContent||''}})()`);
      if (before.open) noteFails.push(['note nine: panel already open', before.id]);
      if (!nb.goBox) noteFails.push(['note button box', '没有 .cgo']);
      else {
        await clickAt(nb.goBox.x, nb.goBox.y);
        await settle();
        const after = await ev(`(function(){var i=document.getElementById('insp');return {open:!i.hidden,id:(document.querySelector('#inspbody .iid')||{}).textContent||''}})()`);
        const wantHead = '章 ' + (+(/^章 (\d+)/.exec(nb.title) || [0, 0])[1]);
        if (!after.open) noteFails.push(['note click did nothing', wantHead + ' ' + JSON.stringify({ hidden: nb.hidden, pe: nb.pe, goTag: nb.goTag, goHit: nb.goHit, goBox: nb.goBox, ss: nb.stageScroll, before })]);
        else if (after.id !== wantHead) noteFails.push(['note click opens nine', `${after.id} vs ${nb.title}`]);
      }
      await key('Escape', 'Escape', 27);
      await settle();
      await ev(`document.getElementById('fit').click()`);
      await settle();
    }
  }
}

// 中景：摘要有没有被 line-clamp 裁掉、卡片盒有没有装不下（溢出＝静默丢字）
await zoomNear(0.50, 0.62);
const mid = await ev(`(function(){
  var t0=document.querySelector('.mtitle'), bad=[], boxBad=[];
  document.querySelectorAll('#cards .p').forEach(function(c){
    var t=c.querySelector('.mtitle');
    if (t && t.scrollHeight - t.clientHeight > 1) bad.push({from:c.dataset.from, over:t.scrollHeight-t.clientHeight, txt:t.textContent.slice(0,26)});
    var tm=c.querySelector('.tm');
    if (tm && tm.scrollHeight - tm.clientHeight > 1) boxBad.push({from:c.dataset.from, over:tm.scrollHeight-tm.clientHeight});
  });
  var z=new DOMMatrix(getComputedStyle(document.getElementById('world')).transform).a;
  return {fontPx:+getComputedStyle(t0).fontSize.replace('px',''), screenPx:+(getComputedStyle(t0).fontSize.replace('px','')*z).toFixed(1),
          firstCard:Array.from(document.querySelector('#cards .p').querySelectorAll('.mmeta > *')).map(function(x){var r=x.getBoundingClientRect();return x.className+'|'+x.textContent+'|'+Math.round(r.x)+','+Math.round(r.y)+','+Math.round(r.width)}),
          maxScroll:Math.max.apply(null,[].concat(Array.from(document.querySelectorAll('#cards .tm')).map(function(x){return x.scrollHeight}))),
          clipped:bad, overflow:boxBad}})()`);

// 中景一张卡的 2× 裁图：整屏截图看不清卡底那排计数，出问题时就要这张
const one = await ev(`(function(){var r=document.querySelector('#cards .p').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);
const crop = await send('Page.captureScreenshot', { format: 'png', clip: { ...one, scale: 2 } });
fs.writeFileSync(`${OUT}/probe-card.png`, Buffer.from(crop.data, 'base64'));

// 远景这一档只有 z∈(0.32,0.35] 那么窄（滞回带），一小步一停，settle 到收敛再判停
await zoomNear(0.36, 0.40);
const far = await snap('远景');
const gFar = await geom();
await shot('far');
const farMarkVisible = await ev(`getComputedStyle(document.querySelector('.p .fwhat')).display !== 'none'`);

await zoomNear(0.16, 0.20);
const glyph = await snap('印章档');
const gGlyph = await geom();
await shot('glyph');
const glyphMarkHidden = await ev(`getComputedStyle(document.querySelector('.p .fwhat')).display === 'none'`);
const glyphStripe = await ev(`getComputedStyle(document.querySelector('.p'),'::before').width`);

// 回到中景，点一块插曲：卡必须原地不动、不许变对话框、邻居不许变暗，详情进右栏
await ev(`document.getElementById('fit').click()`);
await settle();
const before = await snap('点之前');
const gBefore = await geom();
const hit = await ev(`(function(){
  var c=Array.from(document.querySelectorAll('#cards .p')).filter(function(x){return x.dataset.kind==='interlude'})[0];
  if(!c) return null;
  var r=c.getBoundingClientRect(); return {from:c.dataset.from,x:(r.left+r.width/2)|0,y:(r.top+r.height/2)|0};
})()`);
if (!hit) throw new Error('页面上没有插曲块，点不了');
const hitBefore = gBefore.cards.find((c) => c.id === hit.from);
await clickAt(hit.x, hit.y);
await settle();
const dived = await snap(`点插曲块 ${hit.from}`);
const gOpen = await geom();
await shot('dive');
const detail = await ev(`(function(){
  var c=document.querySelector('#cards .p.on');
  var t=document.querySelector('#inspbody .ititle');
  var h=document.querySelector('#inspbody .iid');
  var txt=document.getElementById('inspbody').textContent;
  return {onCard:c?c.dataset.from:null,
    head:h?h.textContent:'', inspTitle:t?t.textContent:'',
    rows:Array.from(document.querySelectorAll('#inspbody .ifact')).map(function(r){
      return {k:(r.querySelector('.ik')||{}).textContent||'', v:(r.querySelector('.iv')||{}).textContent||''}}),
    between:(txt.match(/夹在第 \\d+ 步与第 \\d+ 步之间/)||[''])[0],
    secs:Array.from(document.querySelectorAll('#inspbody .isec')).map(function(x){return x.textContent}),
    segRows:document.querySelectorAll('#inspbody .seg').length,
    bodyBtns:Array.from(document.querySelectorAll('#inspbody .ibtn')).map(function(x){return x.textContent}),
    screenW:c?+(c.getBoundingClientRect().width).toFixed(0):0, screenH:c?+(c.getBoundingClientRect().height).toFixed(0):0,
    worldH:c?c.offsetHeight:0, worldW:c?c.offsetWidth:0,
    otherOpacity:Array.from(document.querySelectorAll('#cards .p')).filter(function(x){return x!==c}).map(function(x){return +getComputedStyle(x).opacity}),
    openUi:document.querySelectorAll('#cards .p.open, #stage.open, #cards .tether, #cards .ghost').length}})()`);
const opener = gOpen.cards.find((c) => c.id === hit.from);

// 面板契约（第十七轮）：五问＝任务 / 夹在哪｜阶段 / 你说的 / 我回的 / 做成什么 + 一个「查看原文」。
// 有模型综述就整行用综述（必须与 data.json 里那条逐字一致），没有就回落成原话/回复/产物，
// 并在 .isrc 里当面说清是哪一种——两条路都接受，但不许含糊、不许拿原话截段冒充综述。
// 旧面板的账单行（段·句·回合·规模·已证·计数行·规则…）一格都不许回来，块里的段清单也已撤。
const summary = await ev(`(function(){
  var rows=Array.from(document.querySelectorAll('#inspbody .ifact')).map(function(r){return {k:(r.querySelector('.ik')||{}).textContent||'',v:(r.querySelector('.iv')||{}).textContent||''}});
  var btns=Array.from(document.querySelectorAll('#inspbody .ibtn')).map(function(x){return x.textContent});
  var src=document.querySelector('#inspbody .isrc');
  return {rows:rows.map(function(r){return r.k}), vals:rows.map(function(r){return r.v}), btns:btns, src:src?src.textContent:'',
    secs:Array.from(document.querySelectorAll('#inspbody .isec')).map(function(x){return x.textContent}),
    segRows:document.querySelectorAll('#inspbody .seg, #inspbody .segs').length,
    bad:rows.filter(function(r){return ['角色','句','段','回合','规模','已证','计数行','压缩','完成度'].indexOf(r.k)>=0}).map(function(r){return r.k})}})()`);
// 拿 data.json 里这块的综述与素材对账：综述三行必须逐字相等；三行去标点后不得是块内任何一句原话的连续子串（≥8 字）。
const panelSum = (from) => ev(`fetch((function(){var p=location.pathname.split('/');return p[1]==='s'&&p[2]?'/s/'+p[2]:''})()+'/data.json').then(function(r){return r.json()}).then(function(d){
  var s=(d.steps||[]).filter(function(x){return x.from===${JSON.stringify(from)}})[0];
  if(!s) return {i:-1,cut:[]};
  var norm=function(t){return String(t||'').replace(/[\\s\\p{P}]/gu,'')};
  var quotes=(d.nodes||[]).slice(s.i0,s.i1+1).map(function(n){
    return norm(n.say)+'\\u0000'+norm(n.claim)+'\\u0000'+norm(n.line)}).join('\\u0000');
  var cut=function(v){var q=norm(v);return q.length>=8&&quotes.indexOf(q)>=0};
  return {i:s.i, said:s.sum?s.sum.said:null, answered:s.sum?s.sum.answered:null, done:s.sum?s.sum.done:null,
    from:s.sum?(s.sumFrom||''):'', cut:s.sum?[cut(s.sum.said)&&'你说的',cut(s.sum.answered)&&'我回的',cut(s.sum.done)&&'做成什么'].filter(Boolean):[]};
})`);
const pSum = await panelSum(hit.from);
const summaryFails = [
  ['panel rows', summary.rows.length === 5 ? [] : [summary.rows.join('|')]],
  ['panel row order', summary.rows.join('|') === '任务|夹在哪|你说的|我回的|做成什么' ? [] : [summary.rows.join('|')]],
  ['panel task named', /^插曲任务 · B\d+ 「.+」$/.test(summary.vals[0] || '') ? [] : [summary.vals[0] || '(没写任务)']],
  ['panel said', summary.vals[2] && summary.vals[2] !== '—' ? [] : [summary.vals[2] || '(没写你说的)']],
  ['panel answered', summary.vals[3] && summary.vals[3] !== '—' ? [] : [summary.vals[3] || '(没写我回的)']],
  ['panel done', summary.vals[4] && summary.vals[4] !== '—' ? [] : [summary.vals[4] || '(没写做成什么)']],
  ['panel summary verbatim', pSum.said
    ? (summary.vals[2] === pSum.said && summary.vals[3] === pSum.answered && summary.vals[4] === pSum.done
      && summary.src === '模型综述（归纳，不过六条判据） · 依据 ' + pSum.from + '；核对面是下面的原文'
      ? [] : [JSON.stringify({rendered: summary.vals.slice(2), src: summary.src, data: pSum})])
    : (summary.src === '这块还没有模型综述（convledger digest --block ' + pSum.i + ' 取材）'
      ? [] : [summary.src || '(没有 .isrc)'])],
  ['panel not quote cut', pSum.cut],
  ['panel forbidden rows', summary.bad],
  ['panel sections', JSON.stringify(summary.secs) === JSON.stringify(['这一块做了什么', '原文']) ? [] : [summary.secs.join('|')]],
  ['panel seg list', summary.segRows ? [`${summary.segRows} 行`] : []],
  ['panel body btn', summary.btns.includes('查看原文') ? [] : [summary.btns.join('|')]],
];

// 点「查看原文」：按锚点现读整块范围；再点一次收起，按钮文案必须回到「查看原文」
const bodyClick = await ev(`(function(){
  var b=Array.from(document.querySelectorAll('#inspbody .ibtn')).filter(function(x){return x.textContent==='查看原文'})[0];
  if(!b) return null; b.click(); return b.textContent})()`);
if (bodyClick) for (let i = 0; i < 50; i++) {
  if (await ev(`!!document.querySelector('#inspbody pre.ibody')`)) break;
  await sleep(150);
}
const body = await ev(`(function(){
  var p=document.querySelector('#inspbody pre.ibody');
  var n=document.querySelector('#inspbody .bodynote');
  var b=Array.from(document.querySelectorAll('#inspbody .ibtn')).filter(function(x){return x.textContent==='收起原文'})[0];
  return p?{chars:p.textContent.length, note:n?n.textContent:'', label:b?b.textContent:'',
    head:p.textContent.slice(0,60).replace(/\\s+/g,' ')}:null})()`);
await shot('body');
const bodyCollapse = await ev(`(function(){
  var b=Array.from(document.querySelectorAll('#inspbody .ibtn')).filter(function(x){return x.textContent==='收起原文'})[0];
  if(!b) return null; b.click();
  var p=document.querySelector('#inspbody pre.ibody');
  return {label:b.textContent, hidden:p?p.hidden:null}})()`);
const bodyFails = [
  ['body btn click', bodyClick ? [] : ['右栏没有「查看原文」按钮']],
  ['body text', body && body.chars > 0 ? [] : [body ? '0 字符' : '没有 pre.ibody']],
  ['body label expanded', body && body.label === '收起原文' ? [] : [body ? body.label : '—']],
  ['body collapse', bodyCollapse && bodyCollapse.hidden === true && bodyCollapse.label === '查看原文'
    ? [] : [JSON.stringify(bodyCollapse)]],
];

// 右栏开着时 Esc 先关右栏并还原镜头；再点一次卡，测卡底「＋节点」弹层挡空标题
await key('Escape', 'Escape', 27);
await settle();
const off = await snap('Esc 之后');
const gOff = await geom();
await shot('restore');

const hit2 = await ev(`(function(){
  var c=Array.from(document.querySelectorAll('#cards .p')).filter(function(x){return x.dataset.kind==='main'})[0];
  var r=c.getBoundingClientRect(); return {from:c.dataset.from,x:(r.left+r.width/2)|0,y:(r.top+r.height/2)|0};
})()`);
await clickAt(hit2.x, hit2.y);
await settle();
// 主线卡走同一组不变量：卡原地不动、不摊开、邻居不暗、右栏出详情（PRD 7.4.6）
const gMain = await geom();
const mainDetail = await ev(`(function(){
  var c=document.querySelector('#cards .p.on');
  var h=document.querySelector('#inspbody .iid');
  var src=document.querySelector('#inspbody .isrc');
  return {onCard:c?c.dataset.from:null, head:h?h.textContent:'', tier:document.getElementById('world').dataset.tier, src:src?src.textContent:'',
    rows:Array.from(document.querySelectorAll('#inspbody .ifact')).map(function(r){
      return {k:(r.querySelector('.ik')||{}).textContent||'', v:(r.querySelector('.iv')||{}).textContent||''}}),
    openUi:document.querySelectorAll('#cards .p.open, #stage.open, #cards .tether, #cards .ghost').length,
    otherOpacity:Array.from(document.querySelectorAll('#cards .p')).filter(function(x){return x!==c}).map(function(x){return +getComputedStyle(x).opacity})}})()`);
const pMain = await panelSum(hit2.from);
const mainCard = gMain.cards.find((c) => c.id === hit2.from);
const mainBefore = gOff.cards.find((c) => c.id === hit2.from);
await shot('main');
const footTexts = await ev(`Array.from(document.querySelectorAll('#cards .p.on .pfoot button')).map(function(b){return b.textContent})`);
const dlg1 = await ev(`(function(){
  var b=Array.from(document.querySelectorAll('#cards .p.on .pfoot button')).filter(function(x){return x.textContent.indexOf('节点')>=0})[0];
  if(!b) return null; b.click();
  var w=document.querySelector('.dlgwrap'); if(!w) return null;
  var save=Array.from(w.querySelectorAll('.dlgact button')).filter(function(x){return x.textContent.indexOf('notes.json')>=0})[0];
  save.click();
  return {title:w.querySelector('h3').textContent, meta:w.querySelector('.dlgmeta').textContent,
          maxTitle:w.querySelector('.dlgt').maxLength, maxBody:w.querySelector('.dlgb').maxLength,
          err:w.querySelector('.dlgerr').textContent}})()`);
await shot('dlg');
await ev(`(function(){var w=document.querySelector('.dlgwrap');var c=w&&Array.from(w.querySelectorAll('.dlgact button')).filter(function(x){return x.textContent==='取消'})[0];if(c)c.click();return !document.querySelector('.dlgwrap')})()`);

// 底部续做框：空输入只提示、不发请求；框与详情栏不许叠在一起
const ask = await ev(`(function(){
  var b=document.getElementById('asksend'); b.click();
  var ab=document.getElementById('askbar').getBoundingClientRect();
  var ib=document.getElementById('insp').getBoundingClientRect();
  var vis=!document.getElementById('insp').hidden;
  return {note:document.getElementById('asknote').textContent,
          cls:document.getElementById('asknote').className,
          placeholder:document.getElementById('ask').placeholder,
          askOverlap:vis&&Math.round(ab.right)>Math.round(ib.left),
          askRect:[Math.round(ab.left),Math.round(ab.right),Math.round(ab.top)],
          inspRect:[Math.round(ib.left),Math.round(ib.top),Math.round(ib.width)]}})()`);

// 搜索：打一个词，命中清单要出来；清空后收回去
const search = await ev(`(function(){
  var f=document.getElementById('find');
  f.value='cost.mjs'; f.dispatchEvent(new Event('input',{bubbles:true}));
  var box=document.getElementById('hits');
  var n=box.querySelectorAll('.hrow').length;
  var txt=box.textContent.slice(0,160);
  var hidden=box.hidden;
  f.value=''; f.dispatchEvent(new Event('input',{bubbles:true}));
  return {hidden:hidden, n:n, txt:txt, hiddenAfter:box.hidden}})()`);

// 关右栏，检查 Esc 是否回到点之前的镜头
await key('Escape', 'Escape', 27);
await settle();
const done = await snap('收尾');

const errs = await ev(`window.__errs.slice(0,4)`);

const report = {
  url: URL_, viewport: `${W}x${H}`,
  blocks: fit.cards, listBtn: await ev(`!!document.getElementById('list')`),
  fit: { tier: fit.tier, z: +fit.z.toFixed(3) },
  mid: { screenPx: mid.screenPx, fontPx: mid.fontPx, chips: mid.firstCard, gistClipped: mid.clipped, boxOverflow: mid.overflow },
  far: { tier: far.tier, z: +far.z.toFixed(3), mark: farMarkVisible ? far.markText : '', markWorldPx: far.markPx, markScreenPx: far.markScreenPx, markClip: far.markClip },
  glyph: { tier: glyph.tier, z: +glyph.z.toFixed(3), markHidden: glyphMarkHidden, stripe: glyphStripe },
  click: { block: hit.from, kind: hitBefore.kind, tier: dived.tier, z: +dived.z.toFixed(3),
    zoomIn: +dived.z.toFixed(3) > +before.z.toFixed(3),
    moved: hitBefore && (Math.abs(hitBefore.x - opener.x) > 0.5 || Math.abs(hitBefore.y - opener.y) > 0.5),
    worldPos: [opener.x, opener.y], beforePos: [hitBefore.x, hitBefore.y],
    size: `${detail.worldW}x${detail.worldH}`, screen: `${detail.screenW}x${detail.screenH}`,
    onCard: detail.onCard, onCount: gOpen.onCount, otherOpacity: Array.from(new Set(detail.otherOpacity)),
    openUi: detail.openUi, center: gOpen.onCenter, stageCenter: gOpen.stageCenter,
    insp: { head: detail.head, title: detail.inspTitle.slice(0, 40), between: detail.between, secs: detail.secs,
      rows: detail.rows.map((r) => r.k + '=' + r.v.slice(0, 28)), segRows: detail.segRows } },
  panel: { rows: summary.rows, vals: summary.vals.map((v) => v.slice(0, 34)), src: summary.src, secs: summary.secs, btns: summary.btns, bodyCollapse },
  esc: { tier: off.tier, zRestored: Math.abs(off.z - before.z) < 0.01, inspHidden: !off.insp, onCount: gOff.onCount },
  mainClick: {
    block: hit2.from, tier: mainDetail.tier, head: mainDetail.head,
    moved: !!(mainBefore && (Math.abs(mainBefore.x - mainCard.x) > 0.5 || Math.abs(mainBefore.y - mainCard.y) > 0.5)),
    from: mainBefore ? [mainBefore.x, mainBefore.y] : null, to: [mainCard.x, mainCard.y],
    size: `${mainCard.w}x${mainCard.h}`, onCount: gMain.onCount,
    otherOpacity: Array.from(new Set(mainDetail.otherOpacity)), openUi: mainDetail.openUi,
    rows: mainDetail.rows.map((r) => r.k + '=' + r.v.slice(0, 24)), src: mainDetail.src,
  },
  interlude: {
    cards: gFit.cards.filter((c) => c.kind === 'interlude').map((c) => ({ id: c.id, after: c.after, before: c.before, badge: c.badge, mvia: c.mvia, prng: c.prng })),
    lane: gFit.lane, lonely: gFit.lonely,
  },
  partsUI: { footBtns: footTexts, ask },
  body, dlg: dlg1, search, errs,
  hint: dived.rowhint,
  layout: {
    fit: { tier: gFit.tier, blocks: gFit.n, overlap: gFit.overlap, order: gFit.order, hud: Object.keys(gFit.hud), rowH: gFit.rowH },
    far: { tier: gFar.tier, overlap: gFar.overlap, order: gFar.order },
    glyph: { tier: gGlyph.tier, overlap: gGlyph.overlap, order: gGlyph.order },
    near: { overlap: gOpen.overlap, order: gOpen.order },
    boxes: { fit: gFit.boxOver, far: gFar.boxOver, glyph: gGlyph.boxOver, near: gOpen.boxOver, main: gMain.boxOver },
    wireAudit: gFit.wireAudit,
    driftFar: drift(gFit, gFar), driftGlyph: drift(gFit, gGlyph), driftDive: drift(gBefore, gOpen), driftMain: drift(gOff, gMain),
  },
  wires: { fit: wireFails(gFit), far: wireFails(gFar), glyph: wireFails(gGlyph), near: wireFails(gOpen) },
  flow,
  phases: {
    n: ((phaseData && phaseData.list) || []).length,
    bands: gFit.bandPaths.length,
    chips: gFit.phls.map((c) => c.text).slice(0, 6),
    clicked: phaseHit ? phaseHit.n : null,
    panel: phaseDetail ? { head: phaseDetail.head, rows: phaseDetail.rows.map((r) => r.k), src: phaseDetail.src.slice(0, 40) } : null,
    fails: phaseFails,
  },
  chapters: {
    n: ((phaseData && phaseData.chaps) || []).length,
    bands: gFit.chapPaths.length,
    chips: gFit.chls.map((c) => c.text).slice(0, 6),
    clicked: chapHit ? chapHit.n : null,
    panel: chapDetail ? { head: chapDetail.head, pill: chapDetail.pill, rows: chapDetail.rows.map((r) => r.k), btns: chapDetail.btns } : null,
    fails: chapFails,
    noteReach: noteReach,
    noteFails: noteFails,
  },
};
console.log(JSON.stringify(report, null, 1));

const layoutFail = [
  ['fit overlap', gFit.overlap], ['far overlap', gFar.overlap], ['glyph overlap', gGlyph.overlap], ['near overlap', gOpen.overlap],
  ['fit order', gFit.order], ['far order', gFar.order], ['glyph order', gGlyph.order], ['near order', gOpen.order],
  ['fit hud', Object.keys(gFit.hud)],
  ['fit lane', gFit.lane], ['fit lonely interlude', gFit.lonely],
  ['box fit', gFit.boxOver], ['box far', gFar.boxOver], ['box glyph', gGlyph.boxOver], ['box near', gOpen.boxOver], ['box main', gMain.boxOver],
  ['chap clash far', bandClash(gFar)], ['chap clash glyph', bandClash(gGlyph)],
  ['chap clash near', bandClash(gOpen)], ['chap clash main', bandClash(gMain)],
  ['wire count fit', wireCountFails(gFit)], ['wire count far', wireCountFails(gFar)],
  ['wire count glyph', wireCountFails(gGlyph)], ['wire count near', wireCountFails(gMain)],
  ...phaseFails,
  ...chapFails,
  ...noteFails,
  ['drift far', drift(gFit, gFar)], ['drift glyph', drift(gFit, gGlyph)], ['drift dive', drift(gBefore, gOpen)],
  ['drift main', drift(gOff, gMain)],
  ['main click moved', report.mainClick.moved ? [`${report.mainClick.from}→${report.mainClick.to}`] : []],
  ['main click size', report.mainClick.size === '300x268' ? [] : [report.mainClick.size]],
  ['main click dim others', report.mainClick.otherOpacity.filter((o) => o !== 1)],
  ['main click openUi', report.mainClick.openUi ? [report.mainClick.openUi] : []],
  ['main click onCount', report.mainClick.onCount === 1 ? [] : [report.mainClick.onCount]],
  ['main click inspector', /^第 \d+ 步 · 块 \d+$/.test(report.mainClick.head) ? [] : [report.mainClick.head]],
  ['main panel summary', (function () {
    const k = mainDetail.rows.map((r) => r.k), v = mainDetail.rows.map((r) => r.v);
    const okRows = k.join('|') === '任务|阶段|你说的|我回的|做成什么'
      && /^主线任务 · B\d+ 「.+」$/.test(v[0])
      && /^第 \d+ 步 \/ 共 \d+ 步 · 这条任务的第 \d+ 块 \/ 共 \d+ 块（第 \d+(–\d+)? 步）( · 阶段 \d+「.+」)?$/.test(v[1])
      && v.slice(2).every((x) => x && x !== '—');
    const okSum = pMain.said
      ? v[2] === pMain.said && v[3] === pMain.answered && v[4] === pMain.done
        && mainDetail.src === '模型综述（归纳，不过六条判据） · 依据 ' + pMain.from + '；核对面是下面的原文'
      : mainDetail.src === '这块还没有模型综述（convledger digest --block ' + pMain.i + ' 取材）';
    return okRows && okSum ? [] : [JSON.stringify({ rows: mainDetail.rows, src: mainDetail.src })];
  })()],
  ['main panel not quote cut', pMain.cut],
  ['main click tier', report.mainClick.tier === 'near' ? [] : [report.mainClick.tier]],
  ...Object.entries(report.wires).map(([k, v]) => [`wire ${k}`, [].concat(v.through, v.detached, v.bent, v.layer)]),
  ['wire flow', flowFails],
  ['click moved card', report.click.moved ? [report.click.beforePos + '→' + report.click.worldPos] : []],
  ['click dimmed others', report.click.otherOpacity.filter((o) => o !== 1)],
  ['click openUi', report.click.openUi ? [report.click.openUi] : []],
  ['click onCount', report.click.onCount === 1 ? [] : [report.click.onCount]],
  ['click card size', report.click.size === '300x268' ? [] : [report.click.size]],
  ['esc not restored', off.tier !== before.tier || Math.abs(off.z - before.z) >= 0.01 ? [`${off.tier}/${off.z} vs ${before.tier}/${before.z}`] : []],
  ['esc insp', off.insp ? ['inspector still open'] : []],
  ['esc onCount', gOff.onCount ? [gOff.onCount] : []],
  ['interlude label', report.interlude.cards.filter((c) => !/插/.test(c.badge) || !/夹|接/.test(c.badge) || !/夹 |接 \d+ 步后/.test(c.prng)).map((c) => c.id)],
  ['interlude inspector between', detail.between === `夹在第 ${hitBefore.after} 步与第 ${hitBefore.before} 步之间` ? [] : [detail.between || '(右栏没写夹在哪两步之间)']],
  ...summaryFails, ...bodyFails, ...libFails,
  ['card foot labels', (footTexts.includes('摘要 ⤢') && footTexts.includes('详情 ⓘ') && !footTexts.some((t) => /段清单|事实/.test(t)))
    ? [] : [footTexts.join('|')]],
  ['mid gist clip', mid.clipped], ['mid box overflow', mid.overflow],
  ['far mark hidden', farMarkVisible ? [] : ['fwhat not visible in far']],
  ['glyph mark visible', glyphMarkHidden ? [] : ['fwhat still visible in glyph']],
  ['page errors', errs],
  ['font stack', ['body', 'card', 'btn', 'seg'].every((k) => fontProbe[k]
    && /^-apple-system/.test(fontProbe[k].fam) && /PingFang SC/.test(fontProbe[k].fam) && /Noto Sans SC/.test(fontProbe[k].fam)
    && !/monospace/i.test(fontProbe[k].fam))
    ? [] : [JSON.stringify(fontProbe)]],
  ['font used', (function () {
    const bad = [];
    if (!usedFonts.brand) bad.push('brand: 没测到平台字体');
    const cjk = ['step', 'title', 'solved'].filter((k) => usedFonts[k]);
    if (!cjk.length) bad.push('card: 没测到平台字体');
    for (const [k, fonts] of Object.entries(usedFonts)) {
      const top = [...fonts].sort((a, b) => b.glyphCount - a.glyphCount)[0];
      if (/KaiTi|楷体|SimSun|宋体/i.test(top.familyName)) bad.push(`${k}: 主字体 ${top.familyName}`);
      const fake = fonts.filter((f) => f.isSyntheticBold).map((f) => f.familyName);
      if (fake.length) bad.push(`${k}: 合成加粗 ${fake.join('/')}`);
    }
    for (const k of cjk) {
      const fams = usedFonts[k].map((f) => f.familyName);
      if (!fams.some((f) => /PingFang SC|Hiragino Sans GB|Noto Sans SC/.test(f))) bad.push(`${k}: 中文没落到苹方/Noto，实际 ${fams.join('/')}`);
    }
    return bad;
  })()],
].filter(([, v]) => v && v.length);
if (layoutFail.length) {
  console.error('LAYOUT FAIL', JSON.stringify(layoutFail));
  process.exitCode = 1;
}
ws.close(); chrome.kill();

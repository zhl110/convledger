// One-off render for the "left = conversation, right = map" test.
// Reads only already-persisted ledger/facts/claims/cards; writes the HTML fragment
// into the conversation's visualization directory. Not a product feature.
import fs from 'node:fs';

const ID = 'demo0001-838b-4697-95fc-9756c7ce93eb';
const DIR = `out/store/${ID}`;
const OUT = process.argv[2];

const ledger = JSON.parse(fs.readFileSync(`${DIR}/ledger.json`, 'utf8'));
const facts = JSON.parse(fs.readFileSync(`${DIR}/facts.json`, 'utf8'));
const claims = JSON.parse(fs.readFileSync(`${DIR}/claims.json`, 'utf8'));
const idxTok = (s) => {
  const cjk = (s.match(/[㐀-鿿぀-ヿ]/g) ?? []).length;
  return Math.round(cjk * 1.05 + (s.length - cjk) / 4);
};
const segs = ledger.segments;
const card = (id) => fs.readFileSync(`${DIR}/segments/${id}.md`, 'utf8');
const opener = (s) => (card(s.id).match(/^开场: (.*)$/m)?.[1] ?? '').trim();
const indexTok = idxTok(fs.readFileSync(`${DIR}/index.md`, 'utf8'));
const cardTok = segs.reduce((a, s) => a + idxTok(card(s.id)), 0);
const totalRt = segs.reduce((a, s) => a + s.tokens.toolRoundTrip, 0);
const lastBoundary = facts.boundaries.at(-1);
const shareCap = Math.floor(lastBoundary.preTokens * 0.05);
const maxRt = Math.max(...segs.map((s) => s.tokens.toolRoundTrip));
const hosts = Object.entries(facts.branches.hosts ?? {});
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (n) => n.toLocaleString('en-US');
const kindClass = (k) => (k.startsWith('side-episode') ? 'side' : k.startsWith('fan-out') ? 'fan' : k === 'boundary' ? 'bound' : k.startsWith('pivot') ? 'pivot' : k.includes('开场所求') ? 'open' : k === 'continuation' ? 'cont' : 'main');
const boundAt = (s) => facts.boundaries.find((b) => b.line >= s.lineFrom && b.line <= s.lineTo);
const preAt = (s) => boundAt(s)?.preTokens ?? 0;
const postAt = (s) => boundAt(s)?.postTokens ?? 0;

// left column: group the work segments under the human input that opened them
const groups = [];
for (const s of segs) {
  const opensNewAsk = s.starts.includes('open-on-human') || s.kind === 'boundary' || s.kind.startsWith('pivot') || !groups.length;
  if (opensNewAsk) groups.push({ ask: s, items: [] });
  groups.at(-1).items.push(s);
}
const leftRows = groups.map((g) => {
  const isHuman = g.ask.starts.includes('open-on-human') || g.ask.kind.includes('开场所求');
  const label = isHuman ? (opener(g.ask) || `（turn ${g.ask.turnFrom}）`) : g.ask.kind === 'boundary' ? `⟲ 自动压缩：压掉 ${num(preAt(g.ask))}t 留 ${num(postAt(g.ask))}t` : `⚠ 打断 / 转向`;
  return `<div class="grp"><div class="ask" data-id="${g.ask.id}"><span class="who">${isHuman ? '你' : g.ask.kind === 'boundary' ? '系统' : '转向'}</span> ${esc(label.slice(0, 90))}<span class="ts">${String(g.ask.tsFrom).slice(11, 16)}</span></div>` +
    g.items.map((s) => `<div class="lrow ${kindClass(s.kind)}" data-id="${s.id}"><b>${s.id}</b><span class="anch">${s.anchor}</span><span class="mt">${s.turnTo - s.turnFrom + 1}回合 · ${s.toolCalls}调用 · ${num(s.tokens.toolRoundTrip)}t</span></div>`).join('') +
    '</div>';
}).join('');

const rightRows = segs.map((s) => {
  const br = hosts.filter(([t]) => +t >= s.turnFrom && +t <= s.turnTo);
  const chips = br.map(([, names]) => `<span class="chip">⊸ ${esc(names.slice(0, 2).join('、'))}${names.length > 2 ? ` +${names.length - 2}` : ''}</span>`).join('');
  const w = Math.max(3, Math.round((Math.sqrt(s.tokens.toolRoundTrip) / Math.sqrt(maxRt)) * 260));
  const attach = s.attachUnder ? `<span class="att">⤷ ${s.attachUnder}</span>` : '';
  const claim = (claims[s.id]?.summary ?? claims[s.id]?.claim ?? '').replace(/\s+/g, ' ').slice(0, 52);
  return `<div class="nrow ${kindClass(s.kind)}" data-id="${s.id}" title="${esc(s.kind)} · ${s.starts.join(',')}">` +
    `<i class="dot"></i><span class="nid">${s.id}</span><span class="bar" style="width:${w}px"></span>` +
    `<span class="meta">${num(s.tokens.toolRoundTrip)}t</span>${attach}${chips}` +
    `<div class="hook">${esc(claim)}</div></div>`;
}).join('');

const fat = [...segs].sort((a, b) => b.tokens.toolRoundTrip - a.tokens.toolRoundTrip).slice(0, 2);
const html = `<div class="cg">
<style>
.cg{font:13px/1.45 ui-monospace,"Cascadia Mono",Consolas,monospace;color:#e8edf6;background:#12151c;padding:14px;border-radius:10px}
.cg h2{margin:0 0 4px;font-size:15px}
.cg .sub{color:#8b95a7;font-size:11px;margin-bottom:10px}
.cg .gauges{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}
.cg .g{flex:1 1 190px;background:#1b2029;border:1px solid #2a313d;border-radius:8px;padding:8px}
.cg .g b{display:block;font-size:12px;color:#c3cde0}
.cg .track{height:7px;background:#2a313d;border-radius:4px;margin:6px 0 3px;overflow:hidden}
.cg .fill{height:100%}
.cg .warn .fill{background:#f0a020}.cg .okk .fill{background:#3fa66a}
.cg .small{font-size:10px;color:#8b95a7}
.cg .cols{display:grid;grid-template-columns:1fr 1.15fr;gap:12px;align-items:start}
.cg .pane{background:#171b23;border:1px solid #262d38;border-radius:9px;padding:9px;max-height:560px;overflow:auto}
.cg .pane>h3{margin:0 0 8px;font-size:12px;color:#8b95a7;font-weight:400}
.cg .grp{margin-bottom:9px;border-left:2px solid #2a313d;padding-left:7px}
.cg .ask{color:#dfe7f5;font-size:12px;margin-bottom:3px;cursor:pointer}
.cg .ask:hover,.cg .nrow:hover,.cg .lrow:hover{background:#222937}
.cg .who{display:inline-block;min-width:26px;color:#5ea0ff;font-size:10px}
.cg .ts{float:right;color:#5b6577;font-size:10px}
.cg .lrow{display:flex;gap:7px;color:#9aa6ba;font-size:11px;padding:1px 4px;border-radius:4px;cursor:pointer}
.cg .lrow b{color:#c8d3e6;min-width:26px}
.cg .anch{color:#5b6577;min-width:58px}
.cg .active{background:#2d3a52 !important;box-shadow:inset 2px 0 0 #5ea0ff}
.cg .nrow{position:relative;padding:3px 4px 5px 4px;border-radius:5px;cursor:pointer;margin-bottom:2px}
.cg .nrow .dot{position:absolute;left:-6px;top:9px;width:8px;height:8px;border-radius:50%;background:#2f6df6}
.cg .nid{display:inline-block;min-width:28px;color:#c8d3e6;font-weight:600}
.cg .bar{display:inline-block;height:9px;border-radius:3px;background:#2f6df6;vertical-align:middle}
.cg .meta{color:#8b95a7;font-size:11px;margin-left:6px}
.cg .hook{color:#6f7b90;font-size:10px;padding-left:34px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cg .att,.cg .chip{font-size:10px;margin-left:6px;padding:0 4px;border-radius:3px}
.cg .att{color:#f0a020;background:#3a2b12}
.cg .chip{color:#c9a3f0;background:#2b1b3d}
.cg .side .dot{background:#f0a020}.cg .side .bar{background:#8a5a10}
.cg .fan .dot{background:#a04ce0}.cg .fan .bar{background:#5c2a86}
.cg .bound .dot{background:#6b7484}.cg .bound .bar{background:#3a4150}
.cg .pivot .dot{background:#e04444}.cg .pivot .bar{background:#8e2a2a}
.cg .cont .bar{background:#24406f}.cg .open .bar{background:#3fa66a}.cg .open .dot{background:#3fa66a}
.cg .foot{margin-top:10px;color:#8b95a7;font-size:11px;line-height:1.6}
.cg .foot b{color:#dfe7f5}
</style>
<h2>当前会话 · 左＝对话，右＝账本映射出的路线图</h2>
<div class="sub">源 ${esc(ledger.sourceBytes ? (ledger.sourceBytes / 1048576).toFixed(2) + 'MB' : '')} · 会话 ${esc(ID.slice(0, 8))} · ${ledger.segments.length} 段 · ${facts.turns.total} 回合（真人 ${facts.turns.human} 条 / 工具往返 ${facts.turns['tool-result']} 条）· ${facts.branches.total} 个子代理分支 · ${facts.boundaries.length} 次自动压缩 · 建账本 ${esc(String(ledger.builtAt).slice(0, 19).replace('T', ' '))}</div>
<div class="gauges">
  <div class="g ${indexTok + cardTok > shareCap ? 'warn' : 'okk'}"><b>路由层总成本 ${num(indexTok + cardTok)}t / 预算 ${num(shareCap)}t</b><div class="track"><div class="fill" style="width:${Math.min(100, ((indexTok + cardTok) / shareCap) * 100).toFixed(0)}%"></div></div><div class="small">占压缩前上下文 ${(((indexTok + cardTok) / lastBoundary.preTokens) * 100).toFixed(1)}%（上限 5%）· 余量只剩 ${num(shareCap - indexTok - cardTok)}t</div></div>
  <div class="g ${indexTok > 120 + 40 * segs.length ? 'warn' : 'okk'}"><b>index 清单 ${num(indexTok)}t / 速率上限 ${num(120 + 40 * segs.length)}t</b><div class="track"><div class="fill" style="width:${Math.min(100, (indexTok / (120 + 40 * segs.length)) * 100).toFixed(0)}%"></div></div><div class="small">${segs.length} 段 × 40t + 120t（实测 30.9t/段）</div></div>
  <div class="g warn"><b>最肥两段吃掉 ${(((fat[0].tokens.toolRoundTrip + fat[1].tokens.toolRoundTrip) / totalRt) * 100).toFixed(0)}% 的工具往返</b><div class="track"><div class="fill" style="width:${(((fat[0].tokens.toolRoundTrip + fat[1].tokens.toolRoundTrip) / totalRt) * 100).toFixed(0)}%"></div></div><div class="small">${fat.map((s) => `${s.id} ${(s.turnTo - s.turnFrom + 1)}回合/${num(s.tokens.toolRoundTrip)}t`).join(' · ')}／全段合计 ${num(totalRt)}t</div></div>
</div>
<div class="cols">
  <div class="pane"><h3>会话侧（人话只有 ${facts.turns.human} 条，其余是工具往返与自动压缩）</h3>${leftRows}</div>
  <div class="pane"><h3>地图侧（条长＝该段工具往返体积；橙＝支线，紫＝并行 fan-out，灰＝压缩边界，红＝打断转向）</h3>${rightRows}</div>
</div>
<div class="foot">点任意一行，左右同时高亮。<b>读法</b>：${segs.length} 个节点里只有 ${segs.filter((s) => s.starts.includes('open-on-human')).length} 个由你的一句话开启；${segs.filter((s) => s.kind.startsWith('side-episode')).length} 个支线挂在别的段上（橙 ⤷ 标出挂载目标），${segs.filter((s) => s.kind.startsWith('fan-out')).length} 个是并行子代理 fan-out。<b>这条地图是纯规则算出来的，零模型调用</b>；段的语义摘要还没有（M2 的活），所以右侧 hook 行仍是规则占位的原文尾巴。</div>
<script>
(function(){const m=document.querySelector('.cg');if(!m)return;
const set=(el,on)=>el&&el.classList.toggle('active',on);
m.querySelectorAll('[data-id]').forEach(el=>{el.addEventListener('click',()=>{
 const id=el.dataset.id;m.querySelectorAll('.active').forEach(a=>a.classList.remove('active'));
 m.querySelectorAll('[data-id="'+CSS.escape(id)+'"]').forEach(a=>{a.classList.add('active');if(a===el)return;
  a.scrollIntoView({block:'nearest',behavior:'smooth'});});});});})();
</script></div>`;

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(`${OUT}/convledger-live-map.html`, html);
console.log('wrote', `${OUT}/convledger-live-map.html`, `${(html.length / 1024).toFixed(1)}KB`, '| segs', segs.length, '| groups', groups.length);

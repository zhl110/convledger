// Renders the live session ledger into a .canvas.tsx artifact, so the Qoder Canvas
// host can show the route map in the panel beside the chat — the same position the
// reference plugins occupy inside their host UI. Re-run after `index` to refresh.
import fs from 'node:fs';
import { readView } from '../src/view.mjs';

const ID = 'demo0001-838b-4697-95fc-9756c7ce93eb';
const DIR = `out/store/${ID}`;
const OUT = process.argv[2];
if (!OUT) throw new Error('usage: node test/render-canvas.mjs <abs path to .canvas.tsx>');

// One data path for both surfaces: the Canvas artifact and the browser page take the
// same readView() output, so neither can drift into showing what the other hides.
const { nodes: SEGS, asks: ASKS, meta: META } = readView(DIR);
for (const s of SEGS) s.fat = s.rt > 20000;
// open the panel on the biggest segment: that is the one worth clicking first
const DEFAULT_SEL = SEGS.slice().sort((a, s) => s.rt - a.rt)[0].id;


const TSX = `import {
  Callout,
  Card,
  CardBody,
  CardHeader,
  Code,
  Divider,
  Grid,
  H1,
  H2,
  Pill,
  Row,
  SendToChatButton,
  Stack,
  Stat,
  Tag,
  Text,
  useCanvasState,
  useHostTheme,
} from 'qoder/canvas';

type SegNode = {
  id: string; anchor: string; kind: string; label: string; group: number; t0: number; t1: number;
  turns: number; calls: number; rt: number; dlg: number; card: number; ts: string; tsEnd: string;
  starts: string; compact: boolean; attach: string; hash: string; tools: string; outs: string;
  line: string; fromTool: boolean; claim: string; basis: string; topic?: string; revision?: boolean; branches: string[];
  pre: number; post: number; fat: boolean;
};
type Ask = { n: number; id: string; first: string; count: number; text: string; who: string; ts: string };
type Meta = {
  session: string; sourceFile: string; runner: string; built: string; mb: string;
  turns: number; human: number; toolTurns: number;
  calls: number; segs: number; branches: number; boundaries: number; groups: number; openedByHuman: number; verified: number;
  indexTok: number; indexCap: number; routeTok: number; shareCap: number; headroom: number;
  routePct: string; fatIds: string; fatPct: number; rtTotal: number; maxRt: number;
};

const META: Meta = ${JSON.stringify(META)};
const NODES: SegNode[] = ${JSON.stringify(SEGS)};
const ASKS: Ask[] = ${JSON.stringify(ASKS)};

const fmt = (n: number): string => n.toLocaleString('en-US');

export default function SessionRouteMap() {
  const { tokens } = useHostTheme();
  const [sel, setSel] = useCanvasState<string>('selectedNode', '${DEFAULT_SEL}');
  const cur: SegNode = NODES.reduce((acc, n) => (n.id === sel ? n : acc), NODES[0] as SegNode);
  const maxRt = NODES.reduce((a, n) => (n.rt > a ? n.rt : a), 1);

  const tint = (kind: string): string => {
    if (kind.indexOf('side-episode') === 0) return tokens.chart.goldenYellow;
    if (kind.indexOf('fan-out') === 0) return tokens.chart.purple;
    if (kind === 'boundary') return tokens.chart.muted;
    if (kind.indexOf('pivot') === 0) return tokens.chart.red;
    if (kind === 'continuation') return tokens.chart.lightBlue;
    if (kind.indexOf('开场所求') >= 0) return tokens.chart.green;
    return tokens.chart.blue;
  };
  const label = (kind: string): string => {
    if (kind.indexOf('side-episode') === 0) return '支线';
    if (kind.indexOf('fan-out') === 0) return '并行';
    if (kind === 'boundary') return '压缩边界';
    if (kind.indexOf('pivot') === 0) return '打断转向';
    if (kind === 'continuation') return '延续';
    return '主线';
  };
  const tone = (kind: string): 'info' | 'warning' | 'danger' | 'neutral' | 'success' => {
    if (kind.indexOf('side-episode') === 0) return 'warning';
    if (kind.indexOf('fan-out') === 0) return 'info';
    if (kind.indexOf('pivot') === 0) return 'danger';
    if (kind === 'boundary') return 'neutral';
    return 'success';
  };

  const mono = (size: number, color: string) => ({
    fontFamily: 'var(--qoder-monospace-font, ui-monospace, monospace)',
    fontSize: size,
    color,
    whiteSpace: 'nowrap',
  });

  return (
    <Stack gap={16} style={{ padding: 4 }}>
      <Stack gap={3}>
        <H1>会话路线图 · {META.segs} 段 / {META.groups} 组</H1>
        <Text tone="secondary" size="small">
          会话 {META.session.slice(0, 8)} · 源日志 {META.mb} MB · {fmt(META.turns)} 个回合（其中你亲手打的只有 {META.human} 条，
          {fmt(META.toolTurns)} 条是工具回执）· 规则层零模型调用，建账本于 {META.built}
        </Text>
      </Stack>

      <Grid columns={6} gap={10} minColumnWidth={96}>
        <Stat label="段" value={META.segs} description="规则切分" />
        <Stat label="工具调用" value={fmt(META.calls)} description="含 247 次命令" />
        <Stat label="并行分支" value={META.branches} tone="info" description="按 toolUseId 观测" />
        <Stat label="压缩边界" value={META.boundaries} tone="neutral" description="宿主自动压缩" />
        <Stat label="路由层" value={fmt(META.routeTok)} unit="t" tone={META.headroom < 0 ? 'danger' : 'warning'} description={'上限 ' + fmt(META.shareCap) + 't'} />
        <Stat label="模型调用" value="0" tone="success" description="结构层不花钱" />
      </Grid>

      <Callout tone={META.headroom < 0 ? 'danger' : 'warning'} title={'路由层 ' + fmt(META.routeTok) + 't / ' + fmt(META.shareCap) + 't 预算（占上下文 ' + META.routePct + '%）'}>
        <Stack gap={4}>
          <Text size="small">
            路由层 = {META.segs} 张路由卡 + index.md。{META.headroom < 0
              ? '已经超出 ' + fmt(-META.headroom) + 't —— 不变量 route layer stays a routing layer 现在是红的，这正是文档里预言的那颗「随会话自爆」的雷：分母固定在最后一次压缩前的快照，分子随段数线性涨。'
              : '只剩 ' + fmt(META.headroom) + 't 余量，再多几段就会超限。'}
            根治方案（index 按压缩区域分层，即 B）会改变 show 的输出形状，属产品决定，还没批。
          </Text>
          <Text size="small">
            同时 {META.fatIds} 两段吃掉了全部工具往返量的 {META.fatPct}%：39 个切分点里只有 {META.human} 个来自你的输入，
            其余靠 fan-out/大读/中断兜底，所以长段切不开。
          </Text>
        </Stack>
      </Callout>

      <Row gap={6} wrap>
        <Text size="small" tone="tertiary">条长 = 该段工具往返 token；颜色 = 定性：</Text>
        {['主线', '延续', '并行', '支线', '打断转向', '压缩边界'].map((k) => (
          <Tag key={k} size="sm" onClick={() => {
            const hit = NODES.filter((n) => label(n.kind) === k)[0];
            if (hit) setSel(hit.id);
          }}>{k}</Tag>
        ))}
      </Row>

      <Grid columns="188px minmax(0, 1fr)" gap={14} align="start">
        <Stack gap={5}>
          <Text size="small" weight="semibold" tone="tertiary">左边：你说了什么</Text>
          {ASKS.map((a) => (
            <Stack
              key={'ask' + a.n}
              gap={2}
              onClick={() => setSel(a.first)}
              style={{
                padding: '5px 8px',
                borderRadius: 6,
                cursor: 'pointer',
                borderLeft: '2px solid ' + (cur.group === a.n ? tokens.accent.primary : tokens.stroke.quaternary),
                background: cur.group === a.n ? tokens.bg.highlight : 'transparent',
              }}
            >
              <Row gap={6} align="center" justify="space-between">
                <Text size="small" weight="semibold" tone={a.who === '系统压缩' ? 'tertiary' : 'secondary'}>{a.who}</Text>
                <span style={mono(10, tokens.text.quaternary)}>{a.ts} · {a.count}段</span>
              </Row>
              <Text size="small" tone={cur.group === a.n ? 'primary' : 'tertiary'} truncate>{a.text}</Text>
            </Stack>
          ))}
        </Stack>

        <Stack gap={3}>
          <Text size="small" weight="semibold" tone="tertiary">右边：账本算出来的结构（点任意一个节点看细节）</Text>
          {NODES.map((n) => {
            const pct = Math.max(2, Math.round((n.rt / maxRt) * 100));
            const isCur = n.id === cur.id;
            if (n.kind === 'boundary') {
              return (
                <Stack key={n.id} gap={2} onClick={() => setSel(n.id)} style={{ padding: '6px 4px', cursor: 'pointer' }}>
                  <div style={{ borderTop: '1px dashed ' + tokens.stroke.secondary }} />
                  <Row gap={8} align="center">
                    <span style={mono(11, tokens.text.quaternary)}>— {n.id} —</span>
                    <Text size="small" tone="tertiary">
                      自动压缩：{fmt(n.pre)}t → {fmt(n.post)}t（省 {fmt(n.pre - n.post)}t）
                    </Text>
                  </Row>
                </Stack>
              );
            }
            return (
              <Stack
                key={n.id}
                gap={3}
                onClick={() => setSel(n.id)}
                style={{
                  padding: '4px 8px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  background: isCur ? tokens.bg.highlight : 'transparent',
                  border: '1px solid ' + (isCur ? tokens.stroke.quaternary : 'transparent'),
                }}
              >
                <Row gap={8} align="center">
                  <span style={mono(11, tokens.text.primary)}>{n.id}</span>
                  <div style={{ flex: 1, minWidth: 0, height: 9, borderRadius: 5, background: tokens.fill.tertiary, overflow: 'hidden' }}>
                    <div style={{ width: pct + '%', height: '100%', borderRadius: 5, background: tint(n.kind) }} />
                  </div>
                  <span style={{ ...mono(11, tokens.text.secondary), width: 54, textAlign: 'right' }}>{fmt(n.rt)}t</span>
                  <Pill size="sm" tone={tone(n.kind)}>{label(n.kind)}</Pill>
                  {n.branches.length > 0 && (
                    <span style={mono(11, tokens.chart.purple)}>{'⊸ ' + n.branches.length}</span>
                  )}
                  {n.fat && <span style={mono(11, tokens.status.warning)}>超大</span>}
                </Row>
                <Row gap={8} align="center">
                  <span style={mono(10, tokens.text.quaternary)}>{n.anchor + ' · turn ' + n.t0 + '-' + n.t1 + ' · ' + n.calls + 'call · ' + n.ts}</span>
                  <Text size="small" tone={isCur ? 'primary' : 'tertiary'} truncate style={{ flex: 1 }}>{n.line}</Text>
                </Row>
              </Stack>
            );
          })}
        </Stack>
      </Grid>

      <Divider />

      <Card>
        <CardHeader
          title={'选中：' + cur.id + ' · ' + label(cur.kind) + '（' + cur.kind + '）'}
          trailing={
            <SendToChatButton
              variant="secondary"
              text={'回补 ' + cur.id + ' 的正文：运行 convledger body ' + cur.id + ' --session ' + META.session + '，锚点 ' + cur.anchor + '，hash ' + cur.hash}
            >
              回补这一段正文
            </SendToChatButton>
          }
        />
        <CardBody>
          <Stack gap={10}>
            <Grid columns={4} gap={10} minColumnWidth={110}>
              <Stat size="sm" label="锚点" value={cur.anchor} description="回源 JSONL 的行区间" />
              <Stat size="sm" label="回合 / 工具调用" value={cur.turns + ' / ' + cur.calls} description={'turn ' + cur.t0 + '-' + cur.t1} />
              <Stat size="sm" label="工具往返" value={fmt(cur.rt)} unit="t" description={'正文 ' + fmt(cur.dlg) + 't'} />
              <Stat size="sm" label="路由卡" value={cur.card} unit="t" description="这一段在路由层的价格" />
            </Grid>
            <Stack gap={4}>
              <Text size="small" tone="tertiary">为什么开这一段（切分规则）</Text>
              <Row gap={6} wrap>
                {cur.starts.split(',').filter((x) => x.length > 0).map((r, i) => (
                  <Code key={r + i}>{r}</Code>
                ))}
              </Row>
            </Stack>
            <Grid columns={2} gap={12} minColumnWidth={220}>
              <Stack gap={2}>
                <Text size="small" tone="tertiary">这段用的工具</Text>
                <Text size="small">{cur.tools || '（无）'}</Text>
              </Stack>
              <Stack gap={2}>
                <Text size="small" tone="tertiary">产出/落盘</Text>
                <Text size="small">{cur.outs || '（无文件产物）'}</Text>
              </Stack>
            </Grid>
            {cur.branches.length > 0 && (
              <Stack gap={4}>
                <Text size="small" tone="tertiary">{'并行派出去的 ' + cur.branches.length + ' 个子代理（' + (cur.group >= 0 ? '组 ' + cur.group : '') + '）'}</Text>
                <Row gap={6} wrap>
                  {cur.branches.map((b, i) => (
                    <Tag key={b + i} size="sm" tone="info">{b}</Tag>
                  ))}
                </Row>
              </Stack>
            )}
            <Stack gap={2}>
              <Text size="small" tone="tertiary">{'认识增量 · basis=' + cur.basis + (cur.revision ? ' · 修订' : '') + '（过了六条判据才算已证，工具不会自己盖章）'}</Text>
              <Text size="small">{cur.claim || '（空）'}</Text>
            </Stack>
          </Stack>
        </CardBody>
      </Card>

      <H2>这张图说明了吗</H2>
      <Grid columns={3} gap={12} minColumnWidth={200}>
        <Callout tone="success" title="能出来">
          <Text size="small">
            {META.segs} 个节点、锚点 {META.segs}/{META.segs} 齐全、{META.branches} 条并行边由 toolUseId 观测得到，全程没调用一次模型。
          </Text>
        </Callout>
        <Callout tone="warning" title="增量的覆盖还薄">
          <Text size="small">
            {'过了判据的增量 ' + META.verified + '/' + META.segs + ' 段，其余仍是规则站位（basis=reconstructed）；把 ' + META.fatIds + ' 这种 200+ 回合的巨段切开、以及 index 按压缩区域分层，都还没做。'}
          </Text>
        </Callout>
        <Callout tone="info" title="刷新方式">
          <Text size="small">
            宿主没给插件订阅会话事件，所以面板不会自己动。要更新：重跑 convledger index，再跑 node test/render-canvas.mjs 覆写本文件。
          </Text>
        </Callout>
      </Grid>

      <Text tone="quaternary" size="small">
        数据来源：tool/src 规则层只读解析 {META.session}.jsonl → out/store/{META.session.slice(0, 8)}…/（ledger/facts/index.md/路由卡）。本文件由 tool/test/render-canvas.mjs 生成，请勿手改。
      </Text>
    </Stack>
  );
}
`;

fs.mkdirSync(OUT.slice(0, OUT.lastIndexOf('/')), { recursive: true });
fs.writeFileSync(OUT, TSX);
console.log(`wrote ${OUT} (${(TSX.length / 1024).toFixed(1)} KB, ${META.segs} nodes, ${META.groups} groups)`);

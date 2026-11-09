// 可复用经验：从块综述的 lesson 格里汇总，只认锚点仍然新鲜的块。
// 这是给「以后继续做」用的入口——同一条经验不该只躺在某一块的详情里。
import { readSummaries, blockHash } from './summaries.mjs';
import { readView } from './view.mjs';

export function lessonsOf(storeDir, { limit = 20 } = {}) {
  const v = readView(storeDir);
  const sums = readSummaries(storeDir);
  const rows = [];
  for (const [key, e] of Object.entries(sums.blocks ?? {})) {
    const lesson = String(e?.lesson ?? '').trim();
    if (!lesson) continue;
    const block = v.steps.find((s) => String(s.i) === String(key));
    if (!block) continue;
    // 块内容变了（hash 不符）旧综述就失效，那时的经验不该挂到新内容上。
    if (e.hash && e.hash !== blockHash(block, v.nodes)) continue;
    rows.push({
      block: block.i,
      step: block.step,
      phase: block.phase ?? null,
      title: String(e.title ?? block.sum?.title ?? ''),
      lesson,
      need: e.need ? String(e.need) : null,
      from: block.segIds?.[0] ?? null,
    });
  }
  rows.sort((a, b) => (b.step ?? -1) - (a.step ?? -1) || b.block - a.block);
  return { total: rows.length, rows: limit > 0 ? rows.slice(0, limit) : rows };
}

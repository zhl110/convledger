// 补账分批：一次别把缺的块全补出来，免得卡很久、像死机（用户口径）。
//   每轮最多补**最近 4 块**（贴着当前上下文）；进入往日积压后每轮只往前补 1 块。
//   欠账再少也不一次全补——不再有“≤8 块一次补完”的例外。
export const SUMMARY_BATCH_NEAR = 4; // 贴着当前上下文时，每轮最多补几块
export const SUMMARY_BATCH_OLD = 1;  // 已进入往日积压时，每轮只往前补一块

/**
 * 选出本轮要补的块号（升序）。
 * @param {number[]} missing 缺综述的块号（任意顺序）
 * @param {number} totalBlocks 本会话总块数（用来判断「最近那块还贴不贴着尾部」）
 */
export function pickSummaryBatch(missing, totalBlocks) {
  const sorted = [...(missing ?? [])].map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!sorted.length) return [];
  if (sorted.length <= SUMMARY_BATCH_NEAR) return sorted;
  const maxIdx = sorted[sorted.length - 1];
  const nearTail = (Number(totalBlocks) - maxIdx) < SUMMARY_BATCH_NEAR; // 最近那块还贴着尾部
  return sorted.slice(-(nearTail ? SUMMARY_BATCH_NEAR : SUMMARY_BATCH_OLD));
}

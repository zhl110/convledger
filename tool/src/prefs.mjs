// 补账档位：收口一块之后，什么时候让当前会话的 agent 把它的综述补上。
// 存在账本根（tool/out/prefs.json），不属于任何一段会话——换画布也还是这台机器的口径。
//   each     每轮：Stop 时只要有一块已收口缺综述就拦一次
//   every5   每 5 轮：缺的收口块攒到 5 块再拦
//   compact  压缩时：Stop 不拦，只在压缩边界（PostCompact 注入）提一次
// 工具只读这个档位并写进 hook 的提示；综述仍然由 agent 写、工具验，闸门不放宽。
import fs from 'node:fs';
import path from 'node:path';

export const SUMMARY_CADENCES = ['each', 'every5', 'compact'];
export const CADENCE_LABELS = { each: '每轮', every5: '每 5 轮', compact: '压缩时' };
const FILE = 'prefs.json';
const SCHEMA = 'convledger-prefs/1';
const DEFAULTS = Object.freeze({ schema: SCHEMA, summaryCadence: 'each', updatedAt: null });

export function readPrefs(storeRoot) {
  const f = path.join(storeRoot, FILE);
  if (!fs.existsSync(f)) return { ...DEFAULTS };
  try {
    const p = JSON.parse(fs.readFileSync(f, 'utf8'));
    const cadence = SUMMARY_CADENCES.includes(p?.summaryCadence) ? p.summaryCadence : DEFAULTS.summaryCadence;
    return { schema: SCHEMA, summaryCadence: cadence, updatedAt: p?.updatedAt ?? null };
  } catch {
    // 坏文件按默认口径读，但把 corrupt 带回去，写入口会覆盖成合法 JSON。
    return { ...DEFAULTS, corrupt: true };
  }
}

/** 只改调用方真的给了的键；未给就保留现值。返回新表，调用方负责展示。 */
export function writePrefs(storeRoot, patch) {
  const cur = readPrefs(storeRoot);
  const next = { schema: SCHEMA, summaryCadence: cur.summaryCadence, updatedAt: null };
  if (patch?.summaryCadence !== undefined) {
    const v = String(patch.summaryCadence);
    if (!SUMMARY_CADENCES.includes(v)) {
      throw new Error(`summaryCadence 要是 ${SUMMARY_CADENCES.join(' / ')}，收到「${v}」`);
    }
    next.summaryCadence = v;
  }
  next.updatedAt = new Date().toISOString();
  fs.mkdirSync(storeRoot, { recursive: true });
  const f = path.join(storeRoot, FILE);
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 1));
  fs.renameSync(tmp, f);
  return next;
}
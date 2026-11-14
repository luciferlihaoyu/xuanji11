/**
 * 批量入库的分层抽样验收清单（T3-03）。
 *
 * 背景：数据源同步动辄上千条，人工验收不可能全看，但**随机抽样不可复现**——
 * 两次抽样结果不同会让「验收过了」这四个字失去证据价值。
 * 本模块的抽样是**确定性**的：按来源分组 → 组内按 itemId 稳定排序 → 等间隔取
 * `n = max(1, ceil(len * ratio))` 条（`items[floor(i * step)]`）。
 * 同一输入永远得到同一清单，两人独立复核可对照。
 */

export interface SamplingItem {
  readonly itemId: number;
  readonly source: string;
  readonly status: string;
}

export interface SampledItem extends SamplingItem {}

/** 每组抽取数：至少 1（孤组不能被淹没），再按 ratio 放大 */
function perGroup(len: number, ratio: number): number {
  return Math.min(len, Math.max(1, Math.ceil(len * ratio)));
}

/**
 * 分层等间隔抽样。
 * @param items 本次 job 的全部条目（含 failed——验收同样要看失败样本）
 * @param ratio 抽样比例（默认 0.1；0 → 空清单；>=1 → 全采）
 */
export function buildAcceptanceSample(items: readonly SamplingItem[], ratio = 0.1): SampledItem[] {
  if (items.length === 0 || ratio <= 0) return [];
  if (ratio >= 1) return [...items];

  // 1) 按来源分组（source 缺失归 ""，不抛错——脏数据也要有处可抽）
  const groups = new Map<string, SamplingItem[]>();
  for (const item of items) {
    const key = item.source ?? "";
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }

  // 2) 组内 itemId 升序（稳定排序键——不依赖插入顺序），组间 source 名升序
  const out: SampledItem[] = [];
  for (const source of [...groups.keys()].sort()) {
    const sorted = [...groups.get(source)!].sort((a, b) => a.itemId - b.itemId);
    const n = perGroup(sorted.length, ratio);
    const step = sorted.length / n;
    for (let i = 0; i < n; i++) {
      out.push(sorted[Math.floor(i * step)]!);
    }
  }
  return out;
}

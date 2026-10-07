/**
 * 数据源页「批量测试连接 / 批量同步」的纯逻辑（2026-10-01）。
 *
 * 拆成纯函数是为了可测：页面层在本仓没有自动化测试（前端测试覆盖薄），
 * 勾选语义与"顺序执行 + 失败隔离 + 进度"这三件事在这里被钉住。
 */

/** 勾选集合的不可变切换：有则删、无则加。 */
export function toggleId(selected: ReadonlySet<number>, id: number): Set<number> {
  const next = new Set(selected);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

/** 全选 / 取消全选：当前已全选则清空，否则全选（空列表时保持空）。 */
export function toggleAllIds(selected: ReadonlySet<number>, allIds: readonly number[]): Set<number> {
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));
  return allSelected ? new Set<number>() : new Set(allIds);
}

/**
 * 顺序执行（**不并发**）：
 * - 数据源同步/测试连接都是重操作：串行能避免打爆本机、也避开上游限流；
 * - 单条失败只记名、不中断整批（失败隔离）—— 一个坏源不该拦住其余源；
 * - onProgress 每条结束后回调，用于"N/M"进度展示。
 */
export async function runSequential<T>(
  ids: readonly number[],
  run: (id: number) => Promise<T>,
  onProgress?: (done: number, total: number, id: number) => void,
): Promise<{ done: number; failed: number[] }> {
  const total = ids.length;
  const failed: number[] = [];
  let done = 0;

  for (const id of ids) {
    try {
      await run(id);
      done += 1;
    } catch {
      failed.push(id);
    }
    onProgress?.(done + failed.length, total, id);
  }

  return { done, failed };
}

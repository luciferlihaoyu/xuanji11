/* 说明：文件名用 .tsx 是因为 vitest.config.ts 的 include 只收 src/**\/*.test.tsx
   （本仓前端测试惯例，见 src/pages/KnowledgeBase.test.tsx）；本文件不含 JSX。 */
import { describe, expect, it, vi } from 'vitest';
import { runSequential, toggleAllIds, toggleId } from './batch';

describe('批量勾选与批量执行（数据源页批量连接/同步的纯逻辑）', () => {
  it('toggleId：点一下加入，再点一下移除，且不改原集合（React 状态友好）', () => {
    const empty = new Set<number>();
    const withOne = toggleId(empty, 7);
    expect([...withOne]).toEqual([7]);
    expect([...empty]).toEqual([]); // 原集合没被就地改

    const backToEmpty = toggleId(withOne, 7);
    expect([...backToEmpty]).toEqual([]);
  });

  it('toggleAllIds：未全选 → 全选；已全选 → 清空', () => {
    const all = [1, 2, 3];
    expect([...toggleAllIds(new Set([1]), all)].sort()).toEqual([1, 2, 3]);
    expect([...toggleAllIds(new Set([1, 2, 3]), all)]).toEqual([]);
    expect([...toggleAllIds(new Set(), [])]).toEqual([]); // 没有源时不炸
  });

  it('runSequential：严格顺序执行，全部成功时 done = 总数、failed 为空', async () => {
    const order: number[] = [];
    const result = await runSequential([3, 1, 2], async (id) => {
      order.push(id);
      return id;
    });
    expect(order).toEqual([3, 1, 2]); // 按给定顺序（不是并发乱序）
    expect(result).toEqual({ done: 3, failed: [] });
  });

  it('runSequential：单条失败不拖垮整批（失败隔离），并在 failed 里点名', async () => {
    const ran: number[] = [];
    const result = await runSequential([1, 2, 3], async (id) => {
      ran.push(id);
      if (id === 2) throw new Error('源 2 挂了');
    });
    expect(ran).toEqual([1, 2, 3]); // 2 失败后 3 照跑
    expect(result).toEqual({ done: 2, failed: [2] });
  });

  it('runSequential：逐条回调进度（done/total/id），total 恒定', async () => {
    const progress: Array<[number, number, number]> = [];
    await runSequential([5, 6], async () => undefined, (done, total, id) => progress.push([done, total, id]));
    expect(progress).toEqual([
      [1, 2, 5],
      [2, 2, 6],
    ]);
  });

  it('runSequential：空列表立即返回，不回调', async () => {
    const onProgress = vi.fn();
    const result = await runSequential([], async () => undefined, onProgress);
    expect(result).toEqual({ done: 0, failed: [] });
    expect(onProgress).not.toHaveBeenCalled();
  });
});

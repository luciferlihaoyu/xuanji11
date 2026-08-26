import { describe, it, expect, vi } from "vitest";
import {
  applyPositionUpdates,
  buildPositionUpdatePlans,
  type PositionUpdate,
} from "./knowledge-position-batch";

describe("buildPositionUpdatePlans", () => {
  it("每个输入产生一条等价计划且字段一致", () => {
    const input: PositionUpdate[] = [
      { id: 1, posX: 10, posY: 20 },
      { id: 2, posX: 30, posY: 40 },
    ];
    expect(buildPositionUpdatePlans(input)).toEqual(input);
  });

  it("空数组返回空计划", () => {
    expect(buildPositionUpdatePlans([])).toEqual([]);
  });
});

describe("applyPositionUpdates", () => {
  it("空入参短路返回 updated=0 不调用 executor", async () => {
    const exec = vi.fn();
    const result = await applyPositionUpdates([], exec);
    expect(result.updated).toBe(0);
    expect(exec).not.toHaveBeenCalled();
  });

  it("N 个入参并行触发 N 次 executor 调用", async () => {
    const updates: PositionUpdate[] = [
      { id: 1, posX: 1, posY: 1 },
      { id: 2, posX: 2, posY: 2 },
      { id: 3, posX: 3, posY: 3 },
    ];
    const executor = vi.fn(async (u: PositionUpdate) => u.id);
    const result = await applyPositionUpdates(updates, executor);
    expect(result.updated).toBe(3);
    expect(executor).toHaveBeenCalledTimes(3);
    // 验证传参映射正确
    expect(executor).toHaveBeenNthCalledWith(1, updates[0]);
    expect(executor).toHaveBeenNthCalledWith(2, updates[1]);
    expect(executor).toHaveBeenNthCalledWith(3, updates[2]);
  });

  it("executor 抛错时整体 reject（事务回滚契约由调用方保证）", async () => {
    const updates: PositionUpdate[] = [
      { id: 1, posX: 1, posY: 1 },
      { id: 2, posX: 2, posY: 2 },
    ];
    const executor = vi.fn(async (u: PositionUpdate) => {
      if (u.id === 2) throw new Error("boom");
      return u.id;
    });
    await expect(applyPositionUpdates(updates, executor)).rejects.toThrow("boom");
  });

  it("并发起飞：所有 executor 同时被启动（不在 await 串行）", async () => {
    // 三个 executor 各 sleep 50ms：串行 = 150ms，并行 ≈ 50ms
    const updates: PositionUpdate[] = [
      { id: 1, posX: 1, posY: 1 },
      { id: 2, posX: 2, posY: 2 },
      { id: 3, posX: 3, posY: 3 },
    ];
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const start = Date.now();
    await applyPositionUpdates(updates, async (u) => {
      await sleep(50);
      return u.id;
    });
    const elapsed = Date.now() - start;
    // 串行 150ms 起步，并行应 < 130ms
    expect(elapsed).toBeLessThan(130);
  });
});

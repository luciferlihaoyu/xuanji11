import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * P2 收尾接线（碧霄 2026-11-14）：pruneFtsOrphans 自 T1 就存在、有测试、有人引用——
 * 但引用全在注释里（「由 pruneFtsOrphans 对账兜底」），**没有任何执行路径真的调它**。
 * 兜底承诺落空 = 孤儿永远躺着。接线到 workflow #5「每日索引巡检」的 index-health 节点：
 * 先清扫孤儿，再做只读体检，清扫计数随报告落档（可审计每天扫掉多少）。
 */
vi.hoisted(() => {
  process.env.DATABASE_URL ||= "file::memory:";
  process.env.ADMIN_USERNAME ||= "test";
  process.env.ADMIN_PASSWORD ||= "test-password";
  process.env.JWT_SECRET ||= "fixed-test-jwt-secret-with-32-chars";
});

vi.mock("./index-health", () => ({
  checkIndexHealth: vi.fn(() => ({ healthy: false, issues: [{ kind: "chunks_without_fts", count: 3, detail: "x" }] })),
}));
vi.mock("./fts-search", () => ({
  pruneFtsOrphans: vi.fn(() => ({ orphans: 7, pruned: 7 })),
}));

import { executeNode } from "./workflow-runtime";
import { checkIndexHealth } from "./index-health";
import { pruneFtsOrphans } from "./fts-search";

beforeEach(() => vi.clearAllMocks());

describe("index-health 节点的 FTS 孤儿清扫接线", () => {
  it("先清扫后体检，计数进报告，体检结果原样透出", async () => {
    const r = await executeNode("index-health", {}, { input: {}, outputs: {} });

    expect(pruneFtsOrphans).toHaveBeenCalledTimes(1);
    expect(checkIndexHealth).toHaveBeenCalledTimes(1);
    expect(r.ftsOrphansPruned).toBe(7);
    expect(r.healthy).toBe(false);
    expect(r.issues).toHaveLength(1); // 体检结论不被清扫改写
  });
});

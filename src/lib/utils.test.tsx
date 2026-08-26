import { describe, it, expect } from "vitest";
import { computeStorageRatios } from "./utils";

describe("computeStorageRatios", () => {
  it("全部为空时返回 null（应隐藏饼图）", () => {
    expect(computeStorageRatios("", "", "")).toBeNull();
  });

  it("按字节数值计算占比", () => {
    const out = computeStorageRatios("300", "100", "100");
    expect(out).toEqual([
      { key: "documents", label: "文档", value: "300", pct: 60 },
      { key: "vectors", label: "向量", value: "100", pct: 20 },
      { key: "backups", label: "备份", value: "100", pct: 20 },
    ]);
  });

  it("解析 K/M/G 后缀并归一化", () => {
    const out = computeStorageRatios("1MB", "", "1KB");
    expect(out?.[0].pct).toBeCloseTo(99.9, 0);
    expect(out?.[2].pct).toBeGreaterThan(0);
  });

  it("单一段占满 100%", () => {
    const out = computeStorageRatios("512", "", "");
    expect(out?.[0].pct).toBe(100);
    expect(out?.[1].pct).toBe(0);
  });

  it("非数值垃圾输入安全处理为 0", () => {
    const out = computeStorageRatios("abc", "", "");
    // abc → 解析不出数字 → 全零 → null
    expect(out).toBeNull();
  });
});

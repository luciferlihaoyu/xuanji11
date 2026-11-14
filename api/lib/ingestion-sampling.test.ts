import { describe, expect, it } from "vitest";
import { buildAcceptanceSample, type SamplingItem } from "./ingestion-sampling";

const mk = (id: number, source: string): SamplingItem => ({ itemId: id, source, status: "completed" });

describe("buildAcceptanceSample（T3-03：批量导入的确定性人工验收清单）", () => {
  it("确定性：同一输入两次调用结果深等（防随机化——验收清单不许每次不一样）", () => {
    const items = [
      mk(1, "upload"), mk(2, "sync"), mk(3, "upload"), mk(4, "sync"),
      mk(5, "upload"), mk(6, "api"), mk(7, "sync"), mk(8, "upload"),
      mk(9, "api"), mk(10, "sync"), mk(11, "upload"), mk(12, "api"),
    ];
    const a = buildAcceptanceSample(items, 0.25);
    const b = buildAcceptanceSample(items, 0.25);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("分层：每个来源组至少 1 条（100:1 的小组不能被大组淹没）", () => {
    const items = [
      ...Array.from({ length: 100 }, (_, i) => mk(i + 1, "upload")),
      ...Array.from({ length: 60 }, (_, i) => mk(101 + i, "sync")),
      mk(161, "api"), // 孤组：只有 1 条也必须进清单
    ];
    const sample = buildAcceptanceSample(items, 0.1);
    const groups = new Set(sample.map((s) => s.source));
    expect(groups.has("api")).toBe(true);
    expect(sample.filter((s) => s.source === "api")).toHaveLength(1);
    expect(sample.filter((s) => s.source === "upload").length).toBeGreaterThanOrEqual(10);
  });

  it("等间隔取数按稳定排序（组内 itemId 升序），组间按来源名升序", () => {
    const items = [mk(30, "upload"), mk(10, "upload"), mk(20, "upload"), mk(40, "upload"), mk(5, "sync"), mk(9, "sync")];
    const sample = buildAcceptanceSample(items, 0.5);
    expect(sample.map((s) => s.itemId)).toEqual([5, 10, 30]); // 组间 sync<upload；upload 步长2 取 10/30
  });

  it("ratio=1 全采；ratio=0 返回空", () => {
    const items = [mk(1, "upload"), mk(2, "upload"), mk(3, "sync")];
    expect(buildAcceptanceSample(items, 1)).toHaveLength(3);
    expect(buildAcceptanceSample(items, 0)).toEqual([]);
  });

  it("默认 ratio=0.1：n = max(每组1, ceil(len*ratio))，不超组大小", () => {
    const items = Array.from({ length: 250 }, (_, i) => mk(i + 1, i % 2 ? "upload" : "sync"));
    const sample = buildAcceptanceSample(items);
    // 每组 125 → ceil(12.5)=13
    expect(sample).toHaveLength(26);
  });

  it("空输入 → 空清单（不报错）", () => {
    expect(buildAcceptanceSample([])).toEqual([]);
  });

  it("failed 条目也入池（验收要看失败样本，确认归因）", () => {
    const items = [{ itemId: 1, source: "upload", status: "failed" as const }, ...Array.from({ length: 19 }, (_, i) => mk(i + 2, "upload"))];
    const sample = buildAcceptanceSample(items, 0.5);
    expect(sample.some((s) => s.status === "failed")).toBe(true);
  });
});

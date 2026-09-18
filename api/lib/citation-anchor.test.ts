import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock 会被提升到文件顶部，故共享标记必须用 vi.hoisted 声明
const { kbDocumentVersionsTable } = vi.hoisted(() => ({
  kbDocumentVersionsTable: { __table: "kbDocumentVersions" },
}));
vi.mock("../queries/connection", () => ({ getDb: vi.fn() }));
vi.mock("@db/schema", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@db/schema");
  return { ...actual, kbDocumentVersions: kbDocumentVersionsTable };
});

import { buildAnchor, findHeadingBefore, resolveLatestVersions } from "./citation-anchor";
import { getDb } from "../queries/connection";
import { kbDocumentVersions } from "@db/schema";

/** 假 DB：模拟 drizzle 的 select().from().where() 链 */
function dbWith(rows: unknown[]) {
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(async () => (table === kbDocumentVersions ? rows : [])),
      })),
    })),
  };
}

describe("findHeadingBefore（块内最近标题）", () => {
  it("返回偏移量之前最近的 markdown 标题文本", () => {
    const text = "# 一级\n\n正文一\n\n## 二级标题\n\n正文二在这里";
    const offset = text.indexOf("正文二");
    expect(findHeadingBefore(text, offset)).toBe("二级标题");
  });

  it("偏移之前没有标题 → undefined", () => {
    const text = "只有正文，没有任何标题";
    expect(findHeadingBefore(text, 5)).toBeUndefined();
  });

  it("标题必须在偏移量之前（紧随其后的标题不算）", () => {
    const text = "正文\n# 后面的标题";
    expect(findHeadingBefore(text, 2)).toBeUndefined();
  });

  it("支持 # 到 ###### 各层级", () => {
    const text = "###### 深层标题\n内容";
    expect(findHeadingBefore(text, text.indexOf("内容"))).toBe("深层标题");
  });
});

describe("buildAnchor（引用定位锚点）", () => {
  it("查询词在块内可定位：给出 charStart/charEnd 与 chunkIndex", () => {
    const chunk = "前置说明。引用可定位是本次改造的核心目标。后置说明。";
    const a = buildAnchor(chunk, "引用可定位", 3);
    expect(a.chunkIndex).toBe(3);
    expect(a.charStart).toBe(chunk.indexOf("引用可定位"));
    expect(a.charEnd).toBe(chunk.indexOf("引用可定位") + "引用可定位".length);
  });

  it("语义命中（块内无字面查询词）：chunkIndex 仍给出，charStart/charEnd 为 undefined", () => {
    const a = buildAnchor("完全不含查询词的内容", "引用可定位", 7);
    expect(a.chunkIndex).toBe(7);
    expect(a.charStart).toBeUndefined();
    expect(a.charEnd).toBeUndefined();
  });

  it("命中位置之前有标题时带上 heading", () => {
    const chunk = "## 完善路径\n\nP0-2 检索测试台与评测集。";
    const a = buildAnchor(chunk, "评测集", 1);
    expect(a.heading).toBe("完善路径");
  });

  it("chunkIndex 未知（无块级证据）→ null，但锚点对象必须存在", () => {
    const a = buildAnchor("任意内容", "任意", null);
    expect(a).not.toBeUndefined();
    expect(a.chunkIndex).toBeNull();
  });

  it("空查询词不抛错，只给 chunkIndex", () => {
    const a = buildAnchor("内容", "", 2);
    expect(a.chunkIndex).toBe(2);
    expect(a.charStart).toBeUndefined();
  });
});

describe("resolveLatestVersions（最新版本判定）", () => {
  beforeEach(() => vi.mocked(getDb).mockReset());

  it("按 versionNumber 取最大，而非按行 id（天演变异 M2 抓到的盲区）", async () => {
    // 行 id 顺序与版本号顺序故意相反：105 行是 v1，100 行才是 v3
    vi.mocked(getDb).mockReturnValue(dbWith([
      { id: 100, documentId: 1922, versionNumber: 3 },
      { id: 105, documentId: 1922, versionNumber: 1 },
    ]) as never);
    const m = await resolveLatestVersions([1922]);
    expect(m.get(1922)).toEqual({ id: 100, versionNumber: 3 });
  });

  it("versionNumber 相同时取行 id 大者", async () => {
    vi.mocked(getDb).mockReturnValue(dbWith([
      { id: 7, documentId: 1922, versionNumber: 2 },
      { id: 9, documentId: 1922, versionNumber: 2 },
    ]) as never);
    expect((await resolveLatestVersions([1922])).get(1922)).toEqual({ id: 9, versionNumber: 2 });
  });

  it("多文档各取各的最新版本", async () => {
    vi.mocked(getDb).mockReturnValue(dbWith([
      { id: 1, documentId: 10, versionNumber: 1 },
      { id: 2, documentId: 10, versionNumber: 2 },
      { id: 3, documentId: 20, versionNumber: 5 },
    ]) as never);
    const m = await resolveLatestVersions([10, 20]);
    expect(m.get(10)).toEqual({ id: 2, versionNumber: 2 });
    expect(m.get(20)).toEqual({ id: 3, versionNumber: 5 });
  });

  it("脏行（字段非数字）被忽略，不污染结果", async () => {
    vi.mocked(getDb).mockReturnValue(dbWith([
      { id: "x", documentId: 10, versionNumber: 1 },
      { id: 5, documentId: undefined, versionNumber: 1 },
      { id: 6, documentId: 10, versionNumber: undefined },
    ]) as never);
    expect((await resolveLatestVersions([10])).size).toBe(0);
  });

  it("DB 异常 → 返回空 Map 且不抛错（问答不因溯源失败而失败）", async () => {
    vi.mocked(getDb).mockReturnValue({
      select: () => {
        throw new Error("db down");
      },
    } as never);
    await expect(resolveLatestVersions([10])).resolves.toEqual(new Map());
  });

  it("空入参 / 非有限值 → 空 Map，且不查库", async () => {
    vi.mocked(getDb).mockReturnValue(dbWith([]) as never);
    expect((await resolveLatestVersions([])).size).toBe(0);
    expect((await resolveLatestVersions([Number.NaN])).size).toBe(0);
    expect(vi.mocked(getDb)).not.toHaveBeenCalled();
  });
});

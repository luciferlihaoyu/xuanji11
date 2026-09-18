import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../queries/connection", () => ({ getDb: vi.fn() }));

import { getChunkContext, extractChunkHeading, highlightSpan } from "./chunk-context";
import { getDb } from "../queries/connection";

function dbWith(rows: Array<{ content: string; chunkIndex: number }>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => rows),
      })),
    })),
  };
}

describe("extractChunkHeading（块内标题）", () => {
  it("取块内首个 markdown 标题", () => {
    expect(extractChunkHeading("## 完善路径\n\nP0-2 检索测试台")).toBe("完善路径");
  });

  it("块内无标题 → undefined", () => {
    expect(extractChunkHeading("纯正文，没有标题")).toBeUndefined();
  });

  it("标题层级更深/更浅都能取", () => {
    expect(extractChunkHeading("前言\n### 三级标题\n内容")).toBe("三级标题");
  });
});

describe("highlightSpan（块内高亮区间）", () => {
  it("命中时返回区间", () => {
    const text = "前置。引用可定位是核心。后置。";
    expect(highlightSpan(text, "引用可定位")).toEqual({
      start: text.indexOf("引用可定位"),
      end: text.indexOf("引用可定位") + 5,
    });
  });

  it("大小写不敏感", () => {
    expect(highlightSpan("Needle in haystack", "needle")?.start).toBe(0);
  });

  it("未命中或空查询 → null", () => {
    expect(highlightSpan("无关内容", "引用可定位")).toBeNull();
    expect(highlightSpan("无关内容", "   ")).toBeNull();
  });
});

describe("getChunkContext（取命中块内容）", () => {
  beforeEach(() => vi.mocked(getDb).mockReset());

  it("返回指定块的内容、总块数与块内标题", async () => {
    vi.mocked(getDb).mockReturnValue(dbWith([
      { content: "第一块内容", chunkIndex: 0 },
      { content: "## 完善路径\n\n第二块：检索测试台与评测集", chunkIndex: 1 },
      { content: "第三块内容", chunkIndex: 2 },
    ]) as never);
    const ctx = await getChunkContext(1922, 1);
    expect(ctx).not.toBeNull();
    expect(ctx?.documentId).toBe(1922);
    expect(ctx?.chunkIndex).toBe(1);
    expect(ctx?.content).toContain("检索测试台");
    expect(ctx?.totalChunks).toBe(3);
    expect(ctx?.heading).toBe("完善路径");
  });

  it("块序号不存在 → null（不返回近似块，避免误导）", async () => {
    vi.mocked(getDb).mockReturnValue(dbWith([{ content: "只有一块", chunkIndex: 0 }]) as never);
    expect(await getChunkContext(1922, 9)).toBeNull();
  });

  it("文档无分块（未索引）→ null", async () => {
    vi.mocked(getDb).mockReturnValue(dbWith([]) as never);
    expect(await getChunkContext(1922, 0)).toBeNull();
  });

  it("DB 异常 → null（不抛错，UI 降级）", async () => {
    vi.mocked(getDb).mockReturnValue({
      select: () => {
        throw new Error("db down");
      },
    } as never);
    expect(await getChunkContext(1922, 0)).toBeNull();
  });

  it("非法入参 → null", async () => {
    expect(await getChunkContext(Number.NaN, 0)).toBeNull();
    expect(await getChunkContext(1922, -1)).toBeNull();
  });
});

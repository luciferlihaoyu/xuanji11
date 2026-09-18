import { describe, it, expect } from "vitest";
import { buildAnchor, findHeadingBefore } from "./citation-anchor";

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

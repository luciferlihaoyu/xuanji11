import { describe, expect, it } from "vitest";
import { buildSectionPath, findHeadingBefore } from "./section-path";

/**
 * T2-03：章节路径提取（切块时写 document_chunks.sectionPath 的唯一出处）。
 * findHeadingBefore 从 citation-anchor.ts 迁入（单一实现，禁止两套 heading 解析）。
 */
describe("buildSectionPath", () => {
  it("层级路径：# A / ## B / ### C 的正文 offset → A > B > C", () => {
    const text = "# A\n\n正文甲。\n\n## B\n\n正文乙。\n\n### C\n\n正文丙。";
    const offset = text.indexOf("正文丙");
    expect(buildSectionPath(text, offset)).toBe("A > B > C");
  });

  it("同级标题覆盖：第二个 ## 取代第一个 ##，深层级随之清除", () => {
    const text = "# A\n\n## B1\n\n### X\n\n## B2\n\n正文丁。";
    const offset = text.indexOf("正文丁");
    expect(buildSectionPath(text, offset)).toBe("A > B2"); // B1 被同级 B2 取代，B 从未存在
  });

  it("跳级（# 后直接 ###）也能组装", () => {
    const text = "# A\n\n### C\n\n正文戊。";
    const offset = text.indexOf("正文戊");
    expect(buildSectionPath(text, offset)).toBe("A > C");
  });

  it("无标题 → undefined（indexer 写 NULL 的依据）", () => {
    expect(buildSectionPath("纯正文没有标题。\n\n第二段。", 5)).toBeUndefined();
    expect(buildSectionPath("任意文本", 0)).toBeUndefined();
  });

  it("offset 越界按全文处理；正文里以 # 开头的行也算标题（markdown 语义）", () => {
    const text = "# A\n正文。\n## B\n更多。";
    expect(buildSectionPath(text, text.length)).toBe("A > B");
  });
});

describe("findHeadingBefore（迁移自 citation-anchor，行为不变）", () => {
  it("返回 offset 前最近标题（不含 #）", () => {
    expect(findHeadingBefore("# 甲\n内容\n## 乙\n更多", 12)).toBe("乙");
    expect(findHeadingBefore("无标题", 3)).toBeUndefined();
    expect(findHeadingBefore("# 甲", 0)).toBeUndefined();
  });
});

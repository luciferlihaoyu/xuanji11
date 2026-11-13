import { describe, expect, it } from "vitest";
import { parseDocumentIdFromMetadata } from "./document-node-match";

/**
 * T1-02：图谱节点 metadata.documentId 的 JS 侧解析口径。
 *
 * 背景（线上实测 2026-11-13）：3,019 个 document 节点里 2,917 存字符串、102 无该键。
 * deleteNode 旧实现只认 `typeof === "number"` ⇒ 清理分支对 97% 节点永不触发 ⇒ 删节点必留孤儿块。
 * 本函数必须与 SQL 侧 documentNodeMatch（CAST AS INTEGER）严格同源：数字与数字字符串都认。
 */
describe("parseDocumentIdFromMetadata", () => {
  it("数字形态命中（keyword-auto-tag 写入形状）", () => {
    expect(parseDocumentIdFromMetadata({ documentId: 1855 })).toBe(1855);
  });

  it("数字字符串命中（ingestion/workflow/kb-router 写入形状 String(id)）", () => {
    expect(parseDocumentIdFromMetadata({ documentId: "1855" })).toBe(1855);
  });

  it("非数字字符串不命中", () => {
    expect(parseDocumentIdFromMetadata({ documentId: "abc" })).toBeUndefined();
    expect(parseDocumentIdFromMetadata({ documentId: "12.5" })).toBeUndefined();
    expect(parseDocumentIdFromMetadata({ documentId: "" })).toBeUndefined();
  });

  it("缺键 / null / 非对象 metadata 不命中", () => {
    expect(parseDocumentIdFromMetadata({})).toBeUndefined();
    expect(parseDocumentIdFromMetadata(null)).toBeUndefined();
    expect(parseDocumentIdFromMetadata(undefined)).toBeUndefined();
    expect(parseDocumentIdFromMetadata("not-an-object")).toBeUndefined();
    expect(parseDocumentIdFromMetadata(42)).toBeUndefined();
  });

  it("与 SQL 侧 documentNodeMatch 语义同源：两种类型都能对上同一 id", () => {
    // SQL 侧 CAST('1855' AS INTEGER)=1855 与 CAST(1855 AS INTEGER)=1855 都命中 id=1855
    // ⇒ JS 侧对两种形态都必须返回同一个 number
    expect(parseDocumentIdFromMetadata({ documentId: 1855 })).toBe(
      parseDocumentIdFromMetadata({ documentId: "1855" }),
    );
  });
});

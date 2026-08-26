import { describe, it, expect } from "vitest";
import { collectDescendantFolderIds } from "./kb-tree";

const folders = [
  { id: 1, parentId: null },
  { id: 2, parentId: 1 },
  { id: 3, parentId: 1 },
  { id: 4, parentId: 2 },
  { id: 5, parentId: 4 },
  { id: 6, parentId: null },
];

describe("collectDescendantFolderIds", () => {
  it("递归收集全部层级子孙（不含根自身）", () => {
    expect(collectDescendantFolderIds(folders, 1).sort()).toEqual([2, 3, 4, 5]);
  });

  it("叶子节点无子孙返回空", () => {
    expect(collectDescendantFolderIds(folders, 5)).toEqual([]);
    expect(collectDescendantFolderIds(folders, 6)).toEqual([]);
  });

  it("环引用不产生死循环", () => {
    const cyclic = [
      { id: 1, parentId: 2 as number | null },
      { id: 2, parentId: 1 },
      { id: 3, parentId: 1 },
    ];
    expect(collectDescendantFolderIds(cyclic, 1).sort()).toEqual([2, 3]);
  });

  it("自引用安全", () => {
    const self = [{ id: 9, parentId: 9 as number | null }];
    expect(collectDescendantFolderIds(self, 9)).toEqual([]);
  });
});

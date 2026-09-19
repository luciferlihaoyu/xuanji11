import { describe, it, expect } from "vitest";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  InvalidCursorError,
  decodeCursor,
  encodeCursor,
  paginate,
} from "./mcp-pagination";

describe("encodeCursor / decodeCursor", () => {
  it("编解码往返一致", () => {
    expect(decodeCursor(encodeCursor(0))).toBe(0);
    expect(decodeCursor(encodeCursor(137))).toBe(137);
  });

  it("cursor 是 URL 安全字符串（不含 + / =）", () => {
    for (const n of [0, 1, 61, 62, 63, 1000]) {
      const c = encodeCursor(n);
      expect(c).not.toMatch(/[+/=]/);
    }
  });

  it("非法 cursor 抛 InvalidCursorError（不静默从头开始，避免误导分页）", () => {
    // 负数 offset：encodeCursor 自会拒绝，故手工构造伪造 cursor
    const forgedNegative = Buffer.from("o:-5", "utf8").toString("base64url");
    const forgedFloat = Buffer.from("o:1.5", "utf8").toString("base64url");
    for (const bad of ["", "!!!", "not-base64", "b3g6MQ", forgedNegative, forgedFloat]) {
      expect(() => decodeCursor(bad)).toThrow(InvalidCursorError);
    }
  });
});

describe("paginate", () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({ id: i + 1 }));

  it("默认页大小与 total", () => {
    const p = paginate(rows);
    expect(p.items).toHaveLength(DEFAULT_PAGE_SIZE);
    expect(p.total).toBe(250);
    expect(p.nextCursor).not.toBeNull();
  });

  it("首尾项与 nextCursor 指向下一页", () => {
    const p1 = paginate(rows, { limit: 10 });
    expect(p1.items[0]).toEqual({ id: 1 });
    expect(p1.items[9]).toEqual({ id: 10 });
    const p2 = paginate(rows, { limit: 10, cursor: p1.nextCursor as string });
    expect(p2.items[0]).toEqual({ id: 11 });
  });

  it("最后一页 nextCursor 为 null（不足一页 / cursor 落在尾部）", () => {
    const small = rows.slice(0, 5);
    const p = paginate(small, { limit: 50 });
    expect(p.items).toHaveLength(5);
    expect(p.nextCursor).toBeNull();
    // 尾部页：cursor=200 取剩余 50 条，无下一页
    const tail = paginate(rows, { limit: 200, cursor: encodeCursor(200) });
    expect(tail.items).toHaveLength(50);
    expect(tail.nextCursor).toBeNull();
  });

  it("顺着 nextCursor 翻页能遍历全部且不重不漏", () => {
    const seen: number[] = [];
    let cursor: string | null = null;
    const opts: { limit: number; cursor?: string } = { limit: 7 };
    for (let guard = 0; guard < 100; guard++) {
      if (cursor !== null) opts.cursor = cursor;
      const p = paginate(rows, opts);
      seen.push(...p.items.map((r) => r.id));
      cursor = p.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toHaveLength(250);
    expect(new Set(seen).size).toBe(250);
    expect(seen[0]).toBe(1);
    expect(seen[249]).toBe(250);
  });

  it("limit 越界被夹到合法区间；非法 limit 用默认值", () => {
    expect(paginate(rows, { limit: 0 }).items).toHaveLength(1);
    expect(paginate(rows, { limit: -5 }).items).toHaveLength(1);
    expect(paginate(rows, { limit: 10_000 }).items).toHaveLength(MAX_PAGE_SIZE);
    expect(paginate(rows, { limit: Number.NaN }).items).toHaveLength(DEFAULT_PAGE_SIZE);
    expect(paginate(rows, { limit: 2.5 }).items).toHaveLength(2);
  });

  it("空列表：items 空、total 0、nextCursor null", () => {
    expect(paginate([], { limit: 10 })).toEqual({ items: [], nextCursor: null, total: 0 });
  });

  it("offset 超出总数：返回空页且 nextCursor null（尾页边界）", () => {
    const p = paginate(rows, { limit: 10, cursor: encodeCursor(250) });
    expect(p.items).toEqual([]);
    expect(p.nextCursor).toBeNull();
    expect(p.total).toBe(250);
  });

  it("非法 cursor 抛错（由调用方转成 MCP isError）", () => {
    expect(() => paginate(rows, { limit: 10, cursor: "garbage!!" })).toThrow(InvalidCursorError);
  });

  it("不修改入参数组", () => {
    const src = [{ id: 1 }, { id: 2 }, { id: 3 }];
    paginate(src, { limit: 2 });
    expect(src).toHaveLength(3);
  });
});

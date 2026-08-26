import { describe, expect, it } from "vitest";
import { connectorNas } from "./nas";

describe("NAS / 本地连接器契约", () => {
  it("暴露 name + authType 元数据", () => {
    expect(connectorNas.name).toBe("NAS / 本地存储");
    expect(connectorNas.authType).toBe("apikey");
  });

  it("testConnection 无 path 时返回失败（不抛错）", async () => {
    const r = await connectorNas.testConnection({});
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/缺少路径/);
  });

  it("listFiles 无 path 时返回空数组（不抛错）", async () => {
    const r = await connectorNas.listFiles({});
    expect(r).toEqual([]);
  });

  it("getDownloadUrl 返回 fileId 本地路径", async () => {
    expect(await connectorNas.getDownloadUrl({}, "/some/path/a.txt")).toBe("/some/path/a.txt");
  });
});

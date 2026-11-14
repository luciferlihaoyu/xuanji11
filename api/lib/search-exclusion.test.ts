import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";

/**
 * T3-01 排除位语义钉（hybrid-search 三处腿共用的 SQL 片段口径）：
 * `json_extract(metadata,'$.excludeFromDefaultSearch') IS NOT 1`
 * —— 显式 true 排除；无字段(NULL)/false/脏值一律保留（默认搜索不误伤存量）。
 * 接线点见 api/lib/hybrid-search.ts NOT_EXCLUDED_FROM_SEARCH（关键词两条 + 向量回表一条）。
 */
describe("excludeFromDefaultSearch SQL 语义", () => {
  it("true 排除；缺省/false/NULL 保留", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("CREATE TABLE kb_documents (id INTEGER PRIMARY KEY, metadata TEXT)");
    sqlite.exec(`INSERT INTO kb_documents VALUES
      (1, '{"excludeFromDefaultSearch":true}'),
      (2, '{"source":"upload"}'),
      (3, NULL),
      (4, '{"excludeFromDefaultSearch":false}')`);
    const kept = sqlite
      .prepare("SELECT id FROM kb_documents WHERE json_extract(metadata, '$.excludeFromDefaultSearch') IS NOT 1")
      .all() as Array<{ id: number }>;
    expect(kept.map((r) => r.id)).toEqual([2, 3, 4]);
  });
});

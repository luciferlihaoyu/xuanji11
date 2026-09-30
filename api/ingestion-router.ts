import { z } from "zod";
import { eq, desc, sql } from "drizzle-orm";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { ingestionJobs, ingestionItems } from "@db/schema";

export const ingestionRouter = createRouter({
  listJobs: authedQuery.query(async () => {
    const db = getDb();
    return db.select().from(ingestionJobs).orderBy(desc(ingestionJobs.createdAt));
  }),

  getJobById: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const results = await db.select().from(ingestionJobs).where(eq(ingestionJobs.id, input.id));
      return results[0] ?? null;
    }),

  getItemsByJobId: authedQuery
    .input(z.object({ jobId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      return db.select().from(ingestionItems).where(eq(ingestionItems.jobId, input.jobId));
    }),

  getItemsBySource: authedQuery
    .input(
      z.object({
        sourceType: z.enum(["upload", "datasource", "backup", "manual"]),
        sourceId: z.string(),
      })
    )
    .query(async ({ input }) => {
      const db = getDb();
      return db
        .select()
        .from(ingestionItems)
        .where(eq(ingestionItems.jobId, Number(input.sourceId)))
        .orderBy(desc(ingestionItems.createdAt));
    }),
  getItemsByUploadedFileId: authedQuery
    .input(z.object({ uploadedFileId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      return db
        .select()
        .from(ingestionItems)
        .where(
          // ⚠️ 必须先 CAST 成 TEXT 再比：SQLite 3.38+ 的 `->>` 会把 JSON 值转成**对应存储类**的
          // SQL 值（JSON 数字 → INTEGER、JSON 字符串 → TEXT、JSON null → NULL），而这里的比较值是
          // `String(...)`（better-sqlite3 按 TEXT 绑定）。SQLite **不做 INTEGER↔TEXT 的隐式相等**，
          // 所以对 `{"uploadedFileId":7}`（`api/lib/ingestion.ts` 就是这么落的：JS number → JSON 数字）
          // 裸写 `->>'$.uploadedFileId' = '7'` **恒为假**（sqlite 3.53.4 实测命中 0），
          // 这条查询对所有行永远返回空 —— 与 api/datasource-router.ts:294（t14）、
          // api/lib/document-node-match.ts（2026-09-22 线上 graph_orphans 事故立下的统一口径）同款。
          // CAST AS TEXT 把两侧拉平到同一存储类，顺带兼容历史上把 id 存成 JSON 字符串的行；
          // JSON null / 无此键 → 表达式为 NULL，`NULL = '7'` 不为真，其它通路（uploadedFileId: null）
          // 的行不会被误命中。
          // 注：前端实际调的是 `GET /api/upload/:id/ingestion`（api/boot.ts:368），那里是**同款缺陷的
          // 孪生查询**（`json_extract(...,'$.uploadedFileId') = String(id)`，同样恒不命中）——另案处理。
          sql`CAST(${ingestionItems.metadata}->>'$.uploadedFileId' AS TEXT) = ${String(input.uploadedFileId)}`,
        )
        .orderBy(desc(ingestionItems.createdAt));
    }),
});

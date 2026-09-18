/**
 * 检索评测路由：测试台的用例管理 + 跑评测。
 *
 * - listCases：任何登录用户可看（测试台展示）
 * - createCase/deleteCase：管理员（评测集是共享资产，别乱删）
 * - runEval：管理员（逐条真实检索，开销大）
 */
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { createRouter, authedQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { kbEvalCases } from "@db/schema";
import { logAudit } from "./lib/audit";
import { runEval } from "./lib/search-eval";

export const searchEvalRouter = createRouter({
  /** 评测用例列表 */
  listCases: authedQuery.query(async () => {
    const db = getDb();
    return db.select().from(kbEvalCases).orderBy(desc(kbEvalCases.createdAt));
  }),

  /** 新增评测用例：查询 → 期望命中的文档 id 集合 */
  createCase: adminQuery
    .input(
      z.object({
        query: z.string().min(1).max(500),
        expectedDocIds: z.array(z.number().int().positive()).min(1).max(50),
        note: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const result = await db.insert(kbEvalCases).values({
        query: input.query,
        expectedDocIds: JSON.stringify(input.expectedDocIds),
        note: input.note ?? null,
      });
      const id = Number(result.lastInsertRowid);
      await logAudit(ctx, "kb_eval_case", "create", id, {
        query: input.query,
        expectedDocIds: input.expectedDocIds,
        note: input.note,
      } as Record<string, unknown>);
      return { id };
    }),

  /** 删除评测用例 */
  deleteCase: adminQuery
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const deleted = await db.delete(kbEvalCases).where(eq(kbEvalCases.id, input.id));
      await logAudit(ctx, "kb_eval_case", "delete", input.id, {} as Record<string, unknown>);
      return { success: true, existed: (deleted.changes ?? 0) > 0 };
    }),

  /** 跑全量评测集：recall@K / MRR 报告 */
  runEval: adminQuery
    .input(
      z.object({
        mode: z.enum(["keyword", "vector", "hybrid"]).default("hybrid"),
        rerank: z.boolean().default(false),
        topK: z.number().int().min(1).max(20).default(5),
      }),
    )
    .mutation(async ({ input }) => {
      return runEval({ mode: input.mode, rerank: input.rerank, topK: input.topK });
    }),
});

/**
 * 审核收件箱：所有待人工确认事项的统一入口。
 *
 * 分拣建议（triage）/ 疑似重复（dedup）/ 质量异常（quality）/
 * 索引失败（index_failure）/ 自动动作记录（auto_action）。
 *
 * 审批动作按 kind 分发执行：
 * - triage approve → 应用建议的 folder/tags
 * - dedup approve → 软删除副本 + mergedIntoId 指向保留篇
 * - quality approve → 按 payload.decision 执行真动作（T3-02：keep 清排除位 /
 *   exclude 打标退出默认搜索 / reindex 重建索引；缺省 keep），拒绝类不动文档
 * - 其余 approve/reject 只改状态（记录人工判断，供反馈评估）
 */
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { createRouter, authedQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { kbReviewItems, kbDocuments } from "@db/schema";
import { logAudit } from "./lib/audit";

export const reviewRouter = createRouter({
  /** 收件箱列表（默认只看 pending） */
  list: authedQuery
    .input(z.object({
      kind: z.enum(["triage", "dedup", "quality", "index_failure", "auto_action"]).optional(),
      status: z.enum(["pending", "approved", "rejected", "ignored"]).default("pending"),
      limit: z.number().min(1).max(200).default(50),
    }))
    .query(async ({ input }) => {
      const db = getDb();
      const conditions = [eq(kbReviewItems.status, input.status)];
      if (input.kind) conditions.push(eq(kbReviewItems.kind, input.kind));
      const rows = await db.select().from(kbReviewItems)
        .where(and(...conditions))
        .orderBy(desc(kbReviewItems.createdAt))
        .limit(input.limit);
      return rows;
    }),

  /** 各状态计数（收件箱角标） */
  counts: authedQuery.query(async () => {
    const db = getDb();
    const rows = await db.select({
      status: kbReviewItems.status,
      kind: kbReviewItems.kind,
      c: sql<number>`count(*)`,
    }).from(kbReviewItems).groupBy(kbReviewItems.status, kbReviewItems.kind);
    return rows;
  }),

  /** 反馈评估报告：删边率/审批率/分拣准确率（调参依据） */
  feedbackReport: authedQuery.query(async () => {
    const { generateFeedbackReport } = await import("./lib/feedback-report");
    return generateFeedbackReport();
  }),

  /**
   * T3-02 积压透视：每类 kind 的 pending 数与**最老 pending 的秒龄**。
   * 存在的意义就是不再让问题沉默 48 天——巡检与人工盯梢都取这里的 oldestPendingSeconds 说话。
   */
  backlogStats: authedQuery.query(async () => {
    const db = getDb();
    const rows = await db
      .select({
        kind: kbReviewItems.kind,
        pending: sql<number>`count(*)`,
        oldestCreatedAt: sql<number>`min(${kbReviewItems.createdAt})`,
      })
      .from(kbReviewItems)
      .where(eq(kbReviewItems.status, "pending"))
      .groupBy(kbReviewItems.kind);
    const nowMs = Date.now();
    return rows.map((r) => ({
      kind: r.kind,
      pending: r.pending,
      oldestPendingSeconds: Math.max(0, Math.round((nowMs - Number(r.oldestCreatedAt)) / 1000)),
    }));
  }),

  /** 审批/驳回/忽略 */
  resolve: adminQuery
    .input(z.object({
      id: z.number(),
      action: z.enum(["approved", "rejected", "ignored"]),
      note: z.string().max(500).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const [item] = await db.select().from(kbReviewItems).where(eq(kbReviewItems.id, input.id)).limit(1);
      if (!item) throw new Error(`审核项不存在: ${input.id}`);
      if (item.status !== "pending") return { success: true, already: true };

      let actionResult: Record<string, unknown> = { skipped: true };

      // approve 时按 kind 执行实际动作
      if (input.action === "approved") {
        if (item.kind === "triage" && item.documentId && item.payload) {
          const p = item.payload;
          const updates: Record<string, unknown> = {};
          if (typeof p.suggestedFolderId === "number") updates.folderId = p.suggestedFolderId;
          if (Array.isArray(p.suggestedTags)) updates.tags = p.suggestedTags;
          if (Object.keys(updates).length > 0) {
            await db.update(kbDocuments).set(updates).where(eq(kbDocuments.id, item.documentId));
            actionResult = { applied: updates };
          }
        } else if (item.kind === "dedup" && item.documentId && item.relatedDocumentId) {
          // P2 护栏（碧霄 2026-11-14，处置 43 条积压前的代码前提）：
          // 旧形无条件盖 deletedAt——副本早就被别的路径删过时，会把真实删除历史覆盖成"现在"，
          // 还在尸体上补 mergedIntoId 伪指认；保留方已死时点批准更危险：把唯一活着的删掉=净丢内容。
          const [keepDoc] = await db.select().from(kbDocuments).where(eq(kbDocuments.id, item.documentId)).limit(1);
          const [dupDoc] = await db.select().from(kbDocuments).where(eq(kbDocuments.id, item.relatedDocumentId)).limit(1);
          if (keepDoc?.deletedAt && !dupDoc?.deletedAt) {
            throw new Error(
              `保留篇（doc ${item.documentId}）已删除，直接批准会把活文档一并软删、净丢内容——` +
              `请先修改本条的保留指向，或选 rejected 留痕`
            );
          }
          if (dupDoc?.deletedAt) {
            // 死者不复活也不改写历史：只记账，不动 deletedAt/mergedIntoId
            actionResult = { alreadyDeleted: item.relatedDocumentId, kept: item.documentId };
          } else {
            // 保留 documentId，软删 relatedDocumentId
            await db.update(kbDocuments).set({
              deletedAt: new Date(),
              deletedReason: "dedup",
              mergedIntoId: item.documentId,
            }).where(eq(kbDocuments.id, item.relatedDocumentId));
            actionResult = { softDeleted: item.relatedDocumentId, kept: item.documentId };
          }
        } else if (item.kind === "quality" && item.documentId) {
          // T3-02：处置必须产生真实副作用——否则 quality 队列就是下一个「连报 48 天的档案柜」。
          // payload.decision 选动作（入库自动入队时不带 decision → 缺省 keep：人工点批准=放行）。
          const p = (item.payload ?? {}) as Record<string, unknown>;
          const decision = typeof p.decision === "string" ? p.decision : "keep";
          if (decision === "reindex") {
            const { tryIndexDocumentById } = await import("./lib/document-indexer");
            const r = await tryIndexDocumentById(item.documentId);
            actionResult = { reindexed: item.documentId, chunks: r.chunks, failed: r.failed === true };
          } else {
            const [doc] = await db.select().from(kbDocuments).where(eq(kbDocuments.id, item.documentId)).limit(1);
            if (doc) {
              const md = { ...((doc.metadata ?? {}) as Record<string, unknown>) };
              if (decision === "exclude") md.excludeFromDefaultSearch = true;
              else delete md.excludeFromDefaultSearch;
              await db.update(kbDocuments).set({ metadata: md }).where(eq(kbDocuments.id, item.documentId));
              actionResult = decision === "exclude" ? { excluded: item.documentId } : { kept: item.documentId };
            }
          }
        }
      }

      await db.update(kbReviewItems).set({
        status: input.action,
        resolverNote: input.note ?? null,
        resolvedAt: new Date(),
      }).where(eq(kbReviewItems.id, input.id));

      await logAudit(ctx, "kb_review_item", "update", input.id, {
        action: input.action, kind: item.kind, note: input.note, actionResult,
      } as Record<string, unknown>);

      return { success: true, actionResult };
    }),

  /** 手动创建审核项（测试/外部系统用） */
  create: adminQuery
    .input(z.object({
      kind: z.enum(["triage", "dedup", "quality", "index_failure", "auto_action"]),
      documentId: z.number().optional(),
      relatedDocumentId: z.number().optional(),
      title: z.string().min(1).max(300),
      payload: z.record(z.string(), z.unknown()).optional(),
      confidence: z.number().min(0).max(1).optional(),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const result = await db.insert(kbReviewItems).values({
        kind: input.kind,
        documentId: input.documentId ?? null,
        relatedDocumentId: input.relatedDocumentId ?? null,
        title: input.title,
        payload: input.payload ?? null,
        confidence: input.confidence ?? null,
      });
      return { id: Number(result.lastInsertRowid) };
    }),
});

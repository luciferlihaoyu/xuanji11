import { z } from "zod";
import { eq, desc, like, isNull, inArray } from "drizzle-orm";
import { createRouter, authedQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { kbFolders, kbDocuments, kbDocumentVersions, kbSearchEvents, documentChunks } from "@db/schema";
import { getChunkContext } from "./lib/chunk-context";
import { clean } from "./lib/clean";
import { logAudit, logAction } from "./lib/audit";
import { vectorEngine } from "./lib/vector";
import { indexDocumentById, tryIndexDocumentById, startReindexAll, getReindexProgress } from "./lib/document-indexer";
import { collectDescendantFolderIds } from "./lib/kb-tree";
import { documentNodeMatch } from "./lib/document-node-match";
import { deleteDocumentCascade, purgeDocumentsCascade } from "./lib/document-removal";

async function deleteDocumentVectors(documentId: number): Promise<void> {
  void import("./lib/hybrid-search").then((m) => m.invalidateSearchCache());
  const db = getDb();
  // 先清 FTS（依赖 document_chunks 的 id 子查询，必须赶在删 chunks 之前）
  try {
    const { deleteDocumentFromFts } = await import("./lib/fts-search");
    deleteDocumentFromFts(documentId);
  } catch { /* FTS 清理失败不阻塞删除 */ }
  await db.delete(documentChunks).where(eq(documentChunks.documentId, documentId));
  await vectorEngine.deleteByDocumentId(documentId);
}

export const kbRouter = createRouter({
  listFolders: authedQuery.query(async () => {
    const db = getDb();
    return db.select().from(kbFolders).orderBy(kbFolders.sortOrder);
  }),

  /** 知识库状态统计：设置页展示用（文档/chunks/向量/FTS/图谱/收件箱） */
  stats: authedQuery.query(async () => {
    const { getRawDb } = await import("./queries/connection");
    const raw = getRawDb();
    const c = (sql: string): number => (raw.prepare(sql).get() as { c: number }).c;
    return {
      documents: c("SELECT COUNT(*) c FROM kb_documents WHERE deletedAt IS NULL"),
      deletedDocuments: c("SELECT COUNT(*) c FROM kb_documents WHERE deletedAt IS NOT NULL"),
      folders: c("SELECT COUNT(*) c FROM kb_folders"),
      chunks: c("SELECT COUNT(*) c FROM document_chunks"),
      vectors: c("SELECT COUNT(*) c FROM vec_chunk_meta"),
      ftsRows: c("SELECT COUNT(*) c FROM chunks_fts"),
      graphNodes: c("SELECT COUNT(*) c FROM knowledge_nodes"),
      graphEdges: c("SELECT COUNT(*) c FROM knowledge_edges"),
      pendingReviews: c("SELECT COUNT(*) c FROM kb_review_items WHERE status = 'pending'"),
      versions: c("SELECT COUNT(*) c FROM kb_document_versions"),
    };
  }),

  listRootFolders: authedQuery.query(async () => {
    const db = getDb();
    return db.select().from(kbFolders)
      .where(isNull(kbFolders.parentId))
      .orderBy(kbFolders.sortOrder);
  }),

  listSubFolders: authedQuery
    .input(z.object({ parentId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      return db.select().from(kbFolders)
        .where(eq(kbFolders.parentId, input.parentId))
        .orderBy(kbFolders.sortOrder);
    }),

  createFolder: adminQuery
    .input(
      z.object({
        name: z.string().min(1).max(255),
        parentId: z.number().nullable().optional(),
        icon: z.string().max(100).default("folder"),
        sortOrder: z.number().default(0),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const result = await db.insert(kbFolders).values({
        name: input.name,
        parentId: input.parentId ?? null,
        icon: input.icon,
        sortOrder: input.sortOrder,
        createdBy: ctx.user?.id ?? null,
      });
      const id = Number(result.lastInsertRowid);
      await logAudit(ctx, "kb_folder", "create", id, input as Record<string, unknown>);
      return { id };
    }),

  updateFolder: adminQuery
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).max(255).optional(),
        parentId: z.number().nullable().optional(),
        icon: z.string().max(100).optional(),
        sortOrder: z.number().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const { id, ...data } = input;
      await db.update(kbFolders).set(clean(data as Record<string, unknown>)).where(eq(kbFolders.id, id));
      await logAudit(ctx, "kb_folder", "update", id, input as Record<string, unknown>);
      return { success: true };
    }),

  deleteFolder: adminQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      // 收集全部层级子孙（修复旧实现只递归一层导致孙级成孤儿的问题），逐层清理文档向量与记录
      const allFolders = await db.select({ id: kbFolders.id, parentId: kbFolders.parentId }).from(kbFolders);
      const descendantIds = collectDescendantFolderIds(allFolders, input.id);
      const targetFolderIds = [input.id, ...descendantIds];

      // 统一走级联删除（此前这里只清向量/chunks/FTS，漏掉图谱节点与边 → 每次删文件夹都留孤儿）
      let purgeFailed: Array<{ id: number; error: string }> = [];
      for (const folderId of targetFolderIds) {
        const docs = await db.select({ id: kbDocuments.id }).from(kbDocuments)
          .where(eq(kbDocuments.folderId, folderId));
        const r = await purgeDocumentsCascade(db, vectorEngine, docs.map((d) => d.id));
        purgeFailed = purgeFailed.concat(r.failed);
      }
      // 先删子孙再删根（id 集合含全部层级，一次 in 条件删除）。
      // 注意：kb_documents.folderId → kb_folders(id) 有外键（线上 foreign_keys=ON）。
      // 若某篇文档 purge 失败，其文档行仍留在文件夹里，直接删文件夹会 FK 500 —— 连
      // 「如实汇报失败」的机会都没有。因此只删**确实已空**的文件夹，并回报被保留的。
      const remainingDocs = await db
        .select({ folderId: kbDocuments.folderId })
        .from(kbDocuments)
        .where(inArray(kbDocuments.folderId, targetFolderIds));
      const blockedFolderIds = new Set(
        remainingDocs.map((r) => r.folderId).filter((x): x is number => typeof x === "number"),
      );
      const deletableFolderIds = targetFolderIds.filter((fid) => !blockedFolderIds.has(fid));
      if (deletableFolderIds.length > 0) {
        await db.delete(kbFolders).where(inArray(kbFolders.id, deletableFolderIds));
      }
      const foldersPreserved = blockedFolderIds.size > 0;
      await logAudit(ctx, "kb_folder", "delete", input.id, {
        ...input,
        removedFolderCount: deletableFolderIds.length,
        targetFolderCount: targetFolderIds.length,
        foldersPreserved,
        purgeFailed,
      } as Record<string, unknown>);
      // 有文档没能删掉就如实带出来（不假装全部清干净）
      return {
        success: purgeFailed.length === 0,
        removedFolderCount: deletableFolderIds.length,
        foldersPreserved,
        purgeFailed,
      };
    }),

  listDocuments: authedQuery
    .input(z.object({
      folderId: z.number().nullable().optional(),
      limit: z.number().int().min(1).max(1000).default(200),
      offset: z.number().int().min(0).default(0),
    }))
    .query(async ({ input }) => {
      const db = getDb();
      if (input.folderId) {
        return db.select().from(kbDocuments)
          .where(eq(kbDocuments.folderId, input.folderId))
          .orderBy(desc(kbDocuments.updatedAt))
          .limit(input.limit)
          .offset(input.offset);
      }
      return db.select().from(kbDocuments).orderBy(desc(kbDocuments.updatedAt))
        .limit(input.limit)
        .offset(input.offset);
    }),

  searchDocuments: authedQuery
    .input(z.object({
      query: z.string().min(1).max(500),
      limit: z.number().int().min(1).max(1000).default(200),
      offset: z.number().int().min(0).default(0),
    }))
    .query(async ({ input }) => {
      const db = getDb();
      return db.select().from(kbDocuments)
        .where(like(kbDocuments.title, `%${input.query}%`))
        .orderBy(desc(kbDocuments.updatedAt))
        .limit(input.limit)
        .offset(input.offset);
    }),

  /** 混合搜索（BM25+向量+RRF+可选重排）：带命中原因和证据片段，支持 folder/tags/type 过滤 */
  hybridSearch: authedQuery
    .input(z.object({
      query: z.string().min(1).max(500),
      mode: z.enum(["keyword", "vector", "hybrid"]).default("hybrid"),
      limit: z.number().int().min(1).max(50).default(10),
      rerank: z.boolean().default(false),
      filters: z.object({
        type: z.string().optional(),
        folder: z.number().int().optional(),
        tags: z.array(z.string()).optional(),
      }).optional(),
    }))
    .query(async ({ input }) => {
      const { executeHybridSearch } = await import("./lib/hybrid-search");
      return executeHybridSearch(input);
    }),

  /** 搜索行为埋点：结果点击 / 问答触发（供反馈评估调权重） */
  logSearchEvent: authedQuery
    .input(z.object({
      query: z.string().min(1).max(500),
      documentId: z.number().int().optional(),
      event: z.enum(["click", "ask"]),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.insert(kbSearchEvents).values({
        query: input.query,
        documentId: input.documentId ?? null,
        event: input.event,
      });
      return { success: true };
    }),

  /** 引用式问答：检索→LLM→带引用的回答；证据不足明确拒答；支持多轮历史 */
  ask: authedQuery
    .input(z.object({
      query: z.string().min(2).max(500),
      history: z.array(z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(4000),
      })).max(12).optional(),
    }))
    .mutation(async ({ input }) => {
      const { askKnowledgeBase } = await import("./lib/ask-rag");
      return askKnowledgeBase(input.query, input.history ?? []);
    }),

  getDocument: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const results = await db.select().from(kbDocuments).where(eq(kbDocuments.id, input.id));
      return results[0] ?? null;
    }),

  /**
   * 命中块上下文：引用锚点（documentId + chunkIndex）→ 该块原文与总块数。
   * 供「点引用跳转并高亮」使用；块不存在返回 null（不做近似匹配）。
   */
  getChunkContext: authedQuery
    .input(z.object({ documentId: z.number().int().min(1), chunkIndex: z.number().int().min(0) }))
    .query(async ({ input }) => getChunkContext(input.documentId, input.chunkIndex)),

  /**
   * 入库分拣建议：文档创建后调用，LLM 给出 folderId/tags/概念实体建议。
   * 建议不落库——前端展示后由用户确认，confirmIngestion 才写入。
   */
  suggestIngestion: authedQuery
    .input(z.object({ documentId: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const doc = await db.select({
        title: kbDocuments.title,
        content: kbDocuments.content,
      }).from(kbDocuments).where(eq(kbDocuments.id, input.documentId)).limit(1);
      if (!doc[0]) throw new Error(`Document not found: ${input.documentId}`);
      const { suggestIngestion } = await import("./lib/ingestion-suggester");
      return suggestIngestion(doc[0].title, doc[0].content ?? "");
    }),

  /**
   * 确认入库建议：把用户确认后的 folderId/tags/concepts 落库。
   * concepts 建为知识图谱节点（concept/entity），并连 contains 边到文档节点。
   */
  confirmIngestion: adminQuery
    .input(z.object({
      documentId: z.number(),
      folderId: z.number().nullable(),
      newFolderName: z.string().optional(),
      tags: z.array(z.string()),
      concepts: z.array(z.object({
        title: z.string(),
        type: z.enum(["concept", "entity"]),
        summary: z.string(),
      })),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const { knowledgeNodes, knowledgeEdges } = await import("@db/schema");

      // 1) 文件夹（可能新建）
      let folderId = input.folderId;
      if (!folderId && input.newFolderName?.trim()) {
        const f = await db.insert(kbFolders).values(clean({
          name: input.newFolderName.trim(),
          createdBy: ctx.user?.id ?? null,
        }));
        folderId = Number(f.lastInsertRowid);
      }

      // 2) 文档归位 + 打标签
      await db.update(kbDocuments)
        .set({ folderId: folderId ?? null, tags: input.tags })
        .where(eq(kbDocuments.id, input.documentId));

      // 3) 概念/实体节点（查重：同 title 同 type 不重复建）
      let createdNodes = 0;
      // 文档对应的 document 节点（metadata.documentId 匹配）用于连 contains 边
      const { sql } = await import("drizzle-orm");
      const docNode = await db.select({ id: knowledgeNodes.id }).from(knowledgeNodes)
        .where(documentNodeMatch(input.documentId))
        .limit(1);
      const docNodeId = docNode[0]?.id;

      for (const c of input.concepts) {
        const dup = await db.select({ id: knowledgeNodes.id }).from(knowledgeNodes)
          .where(sql`${knowledgeNodes.title} = ${c.title} AND ${knowledgeNodes.type} = ${c.type}`)
          .limit(1);
        let nodeId: number;
        if (dup[0]) {
          nodeId = dup[0].id;
        } else {
          const r = await db.insert(knowledgeNodes).values(clean({
            title: c.title,
            content: c.summary,
            type: c.type,
            metadata: { source: "ingestion", documentId: String(input.documentId) },
            createdBy: ctx.user?.id ?? null,
          }));
          nodeId = Number(r.lastInsertRowid);
          createdNodes++;
        }
        // 概念节点 → 文档节点 contains 边
        if (docNodeId) {
          const edgeExists = await db.select({ id: knowledgeEdges.id }).from(knowledgeEdges)
            .where(sql`${knowledgeEdges.sourceId} = ${nodeId} AND ${knowledgeEdges.targetId} = ${docNodeId}`)
            .limit(1);
          if (!edgeExists[0]) {
            await db.insert(knowledgeEdges).values(clean({
              sourceId: nodeId,
              targetId: docNodeId,
              label: "contains",
              type: "contains",
              weight: 1,
              createdBy: ctx.user?.id ?? null,
            }));
          }
        }
      }

      await logAction(ctx.user?.id ?? null, "update", {
        entityType: "kb_document",
        entityId: input.documentId,
        ingestionConfirmed: true,
        folderId,
        tags: input.tags,
        conceptsCreated: createdNodes,
      });
      return { folderId, createdNodes, docNodeId: docNodeId ?? null };
    }),

  /** 语义聚类：全部文档 embedding → KMeans++ → LLM 命名簇（只读分析，不落库） */
  clusterDocuments: authedQuery
    .input(z.object({
      k: z.number().int().min(3).max(24).optional(),
      labelWithLlm: z.boolean().default(true),
    }).optional())
    .mutation(async ({ input }) => {
      const { clusterDocuments } = await import("./lib/doc-clusterer");
      return clusterDocuments(input?.k, input?.labelWithLlm ?? true);
    }),

  createDocument: adminQuery
    .input(
      z.object({
        folderId: z.number().nullable().optional(),
        title: z.string().min(1).max(500),
        content: z.string().optional(),
        format: z.enum(["markdown", "text", "json", "html", "code"]).default("markdown"),
        tags: z.array(z.string()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const result = await db.insert(kbDocuments).values(clean({
        folderId: input.folderId ?? null,
        title: input.title,
        content: input.content,
        format: input.format,
        tags: input.tags,
        metadata: input.metadata as Record<string, unknown>,
        createdBy: ctx.user?.id ?? null,
      }));
      const id = Number(result.lastInsertRowid);
      await logAction(ctx.user?.id ?? null, "create", {
        entityType: "kb_document",
        entityId: id,
        ...input,
      });
      // 自动索引：有内容即入向量库；索引失败不影响文档创建
      const indexed = input.content ? await tryIndexDocumentById(id) : { chunks: 0, skipped: true };
      // 事件触发：新文档 → 触发订阅 document-created 的工作流（fire-and-forget）
      import("./lib/workflow-events").then(({ fireDocumentCreated }) =>
        fireDocumentCreated(id, input.title)
      ).catch((err) => console.error("[WorkflowEvent] fire 失败:", err));
      return { id, chunks: indexed.chunks };
    }),

  updateDocument: adminQuery
    .input(
      z.object({
        id: z.number(),
        folderId: z.number().nullable().optional(),
        title: z.string().min(1).max(500).optional(),
        content: z.string().optional(),
        format: z.enum(["markdown", "text", "json", "html", "code"]).optional(),
        tags: z.array(z.string()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const { id, ...data } = input;
      // 内容/标题变更前快照旧版本（安全网：可回溯；失败不阻塞更新）
      if (input.content !== undefined || input.title !== undefined) {
        try {
          const { snapshotDocumentVersion } = await import("./lib/doc-versioning");
          await snapshotDocumentVersion(id, "manual", "update", ctx.user?.id ?? null);
        } catch (err) {
          console.error("[DocVersion] 快照失败（不阻塞更新）:", err);
        }
      }
      await db.update(kbDocuments).set(clean(data as Record<string, unknown>)).where(eq(kbDocuments.id, id));
      await logAudit(ctx, "kb_document", "update", id, input as Record<string, unknown>);
      // 内容变更时自动重建索引；索引失败不影响文档更新
      if (input.content !== undefined) {
        await tryIndexDocumentById(id);
      void import("./lib/hybrid-search").then((m) => m.invalidateSearchCache());
      }
      return { success: true };
    }),

  /** 删除 = 软删进回收站（可从 listDeleted 恢复；彻底删除用 purgeDocument） */
  deleteDocument: adminQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      await deleteDocumentVectors(input.id);
      const db = getDb();
      await db.update(kbDocuments)
        .set({ deletedAt: new Date(), deletedReason: "user" })
        .where(eq(kbDocuments.id, input.id));
      await logAudit(ctx, "kb_document", "delete", input.id, input as Record<string, unknown>);
      return { success: true };
    }),

  /** 回收站列表 */
  listDeleted: authedQuery.query(async () => {
    const { isNotNull } = await import("drizzle-orm");
    const db = getDb();
    return db.select().from(kbDocuments)
      .where(isNotNull(kbDocuments.deletedAt))
      .orderBy(desc(kbDocuments.deletedAt));
  }),

  /** 从回收站恢复（重新索引） */
  restoreDocument: adminQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      await db.update(kbDocuments)
        .set({ deletedAt: null, deletedReason: null, mergedIntoId: null })
        .where(eq(kbDocuments.id, input.id));
      await logAudit(ctx, "kb_document", "update", input.id, { action: "restore" });
      await tryIndexDocumentById(input.id);
      return { success: true };
    }),

  /** 彻底删除（不可恢复） */
  purgeDocument: adminQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      // 统一走级联（此前只清向量/chunks/FTS，漏图谱节点与边 → 留下 graph_orphans）
      const db = getDb();
      const r = await deleteDocumentCascade(db, vectorEngine, input.id);
      await logAudit(ctx, "kb_document", "delete", input.id, { action: "purge", ...r } as Record<string, unknown>);
      return { success: true, ...r };
    }),

  /** 版本历史列表（不含正文，省流量） */
  listVersions: authedQuery
    .input(z.object({ documentId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const rows = await db.select({
        id: kbDocumentVersions.id,
        versionNumber: kbDocumentVersions.versionNumber,
        title: kbDocumentVersions.title,
        contentHash: kbDocumentVersions.contentHash,
        source: kbDocumentVersions.source,
        changeReason: kbDocumentVersions.changeReason,
        createdAt: kbDocumentVersions.createdAt,
      }).from(kbDocumentVersions)
        .where(eq(kbDocumentVersions.documentId, input.documentId))
        .orderBy(desc(kbDocumentVersions.versionNumber));
      return rows;
    }),

  /** 读取单个版本的正文（预览用） */
  getVersion: authedQuery
    .input(z.object({ versionId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const rows = await db.select().from(kbDocumentVersions)
        .where(eq(kbDocumentVersions.id, input.versionId));
      return rows[0] ?? null;
    }),

  /** 回滚到指定版本：当前内容先快照，再应用旧版本并重建索引 */
  rollbackVersion: adminQuery
    .input(z.object({ versionId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const rows = await db.select().from(kbDocumentVersions)
        .where(eq(kbDocumentVersions.id, input.versionId));
      const version = rows[0];
      if (!version) throw new Error("版本不存在");

      // 回滚前把当前内容快照成一个新版本（回滚本身也可再回滚）
      const { snapshotDocumentVersion } = await import("./lib/doc-versioning");
      await snapshotDocumentVersion(version.documentId, "manual", "回滚前自动快照");

      await db.update(kbDocuments)
        .set({
          title: version.title,
          content: version.content ?? "",
          tags: version.tags ?? [],
        })
        .where(eq(kbDocuments.id, version.documentId));
      await logAudit(ctx, "kb_document", "update", version.documentId, {
        action: "rollback", toVersion: version.versionNumber,
      });
      await tryIndexDocumentById(version.documentId);
      return { success: true, restoredVersion: version.versionNumber };
    }),

  moveDocument: adminQuery
    .input(
      z.object({
        id: z.number(),
        folderId: z.number().nullable(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      await db.update(kbDocuments)
        .set({ folderId: input.folderId ?? null })
        .where(eq(kbDocuments.id, input.id));
      await logAudit(ctx, "kb_document", "update", input.id, input as Record<string, unknown>);
      return { success: true };
    }),

  reindexDocument: adminQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const result = await indexDocumentById(input.id);
      await logAudit(ctx, "kb_document", "update", input.id, { action: "reindex" } as Record<string, unknown>);
      return { success: true, chunks: result.chunks };
    }),

  reindexAll: adminQuery.mutation(async () => {
    return startReindexAll();
  }),

  reindexStatus: authedQuery.query(async () => {
    return { ...getReindexProgress(), vectorSize: vectorEngine.size };
  }),

  /**
   * 清理 FTS 孤儿（rowid 指向已删 chunk 的历史行）。
   * 巡检会报 `fts_orphans`，但巡检只报不改；这里是显式维护动作。
   * `dryRun: true` 只报数不删（沿用破坏性操作的 dryRun 约定）。
   */
  pruneFtsOrphans: adminQuery
    .input(z.object({ dryRun: z.boolean().default(false) }).optional())
    .mutation(async ({ input, ctx }) => {
      const { pruneFtsOrphans } = await import("./lib/fts-search");
      const result = pruneFtsOrphans({ dryRun: input?.dryRun ?? false });
      if (!input?.dryRun && result.pruned > 0) {
        await logAudit(ctx, "kb_fts", "delete", 0, { orphans: result.orphans, pruned: result.pruned } as Record<string, unknown>);
      }
      return result;
    }),

  /**
   * 清理图谱孤儿（document 节点指向已删文档）。巡检只报不改，这里是显式维护动作。
   * dryRun 只报数（沿用破坏性操作的 dryRun 约定）。
   */
  pruneGraphOrphans: adminQuery
    .input(z.object({ dryRun: z.boolean().default(false) }).optional())
    .mutation(async ({ input, ctx }) => {
      const { pruneGraphOrphans } = await import("./lib/graph-maintenance");
      const result = pruneGraphOrphans({ dryRun: input?.dryRun ?? false });
      if (!input?.dryRun && result.prunedNodes > 0) {
        await logAudit(ctx, "kb_graph", "delete", 0, { ...result } as Record<string, unknown>);
      }
      return result;
    }),

  getTree: authedQuery.query(async () => {
    const db = getDb();
    const folders = await db.select().from(kbFolders).orderBy(kbFolders.sortOrder);
    const docs = await db.select().from(kbDocuments).orderBy(desc(kbDocuments.updatedAt));
    return { folders, documents: docs };
  }),
});

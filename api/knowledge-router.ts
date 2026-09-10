import { z } from "zod";
import { eq, desc, sql } from "drizzle-orm";
import { createRouter, authedQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { knowledgeNodes, knowledgeEdges, documentChunks } from "@db/schema";
import { clean } from "./lib/clean";
import { vectorEngine } from "./lib/vector";
import { searchVectors as semanticSearchVectors } from "./lib/vector-service";
import { logAudit, logAction } from "./lib/audit";

export const knowledgeRouter = createRouter({
  listNodes: authedQuery
    .input(z.object({
      limit: z.number().int().min(1).max(1000).default(500),
      offset: z.number().int().min(0).default(0),
    }).optional())
    .query(async ({ input }) => {
      const db = getDb();
      return db.select().from(knowledgeNodes).orderBy(desc(knowledgeNodes.updatedAt))
        .limit(input?.limit ?? 500)
        .offset(input?.offset ?? 0);
    }),

  searchNodes: authedQuery
    .input(z.object({
      query: z.string().max(500),
      limit: z.number().int().min(1).max(1000).default(200),
      offset: z.number().int().min(0).default(0),
    }))
    .query(async ({ input }) => {
      const db = getDb();
      const q = `%${input.query}%`;
      return db.select().from(knowledgeNodes)
        .where(sql`${knowledgeNodes.title} LIKE ${q} OR ${knowledgeNodes.content} LIKE ${q}`)
        .orderBy(desc(knowledgeNodes.updatedAt))
        .limit(input.limit)
        .offset(input.offset);
    }),

  getNode: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const results = await db.select().from(knowledgeNodes).where(eq(knowledgeNodes.id, input.id));
      return results[0] ?? null;
    }),

  createNode: adminQuery
    .input(
      z.object({
        title: z.string().min(1).max(500),
        content: z.string().optional(),
        type: z.enum(["concept", "document", "topic", "entity", "note", "tag"]).default("concept"),
        posX: z.number().default(0),
        posY: z.number().default(0),
        style: z.record(z.string(), z.unknown()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const result = await db.insert(knowledgeNodes).values(clean({
        title: input.title,
        content: input.content,
        type: input.type,
        posX: input.posX,
        posY: input.posY,
        style: input.style as Record<string, unknown>,
        metadata: input.metadata as Record<string, unknown>,
        createdBy: ctx.user?.id ?? null,
      }));
      const id = Number(result.lastInsertRowid);
      await logAudit(ctx, "knowledge_node", "create", id, input as Record<string, unknown>);
      return { id };
    }),

  updateNode: adminQuery
    .input(
      z.object({
        id: z.number(),
        title: z.string().min(1).max(500).optional(),
        content: z.string().optional(),
        type: z.enum(["concept", "document", "topic", "entity", "note", "tag"]).optional(),
        posX: z.number().optional(),
        posY: z.number().optional(),
        style: z.record(z.string(), z.unknown()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const { id, ...data } = input;
      await db.update(knowledgeNodes).set(clean(data as Record<string, unknown>)).where(eq(knowledgeNodes.id, id));
      await logAudit(ctx, "knowledge_node", "update", id, input as Record<string, unknown>);
      return { success: true };
    }),

  deleteNode: adminQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const [node] = await db.select().from(knowledgeNodes).where(eq(knowledgeNodes.id, input.id));
      const linkedDocId = node?.metadata && typeof node.metadata === "object"
        ? (node.metadata as Record<string, unknown>).documentId
        : undefined;
      if (typeof linkedDocId === "number") {
        const [doc] = await db.select({ id: knowledgeNodes.id }).from(knowledgeNodes)
          .where(eq(knowledgeNodes.id, linkedDocId));
        if (doc) {
          await db.delete(documentChunks).where(eq(documentChunks.documentId, linkedDocId));
          await vectorEngine.deleteByDocumentId(linkedDocId);
        }
      }
      await db.delete(knowledgeEdges).where(
        sql`${knowledgeEdges.sourceId} = ${input.id} OR ${knowledgeEdges.targetId} = ${input.id}`
      );
      await db.delete(knowledgeNodes).where(eq(knowledgeNodes.id, input.id));
      await logAction(ctx.user?.id ?? null, "delete", {
        entityType: "knowledge_node",
        entityId: input.id,
      });
      return { success: true };
    }),

  updateNodePositions: adminQuery
    .input(
      z.array(z.object({
        id: z.number(),
        posX: z.number(),
        posY: z.number(),
      }))
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      // N+1 优化：drizzle 不支持「每行不同值」的批量 update，改用并行 + 事务消除串行 RTT
      const { applyPositionUpdates, buildPositionUpdatePlans } = await import("./lib/knowledge-position-batch");
      const plans = buildPositionUpdatePlans(input);
      const result = await applyPositionUpdates(plans, async (u) =>
        db.update(knowledgeNodes).set({ posX: u.posX, posY: u.posY }).where(eq(knowledgeNodes.id, u.id)),
      );
      await logAudit(ctx, "knowledge_node", "update", null, { nodes: input } as Record<string, unknown>);
      return { success: true, updated: result.updated };
    }),

  listEdges: authedQuery.query(async () => {
    const db = getDb();
    return db.select().from(knowledgeEdges).orderBy(desc(knowledgeEdges.createdAt));
  }),

  createEdge: adminQuery
    .input(
      z.object({
        sourceId: z.number(),
        targetId: z.number(),
        label: z.string().optional(),
        type: z.enum(["related", "contains", "references", "extends", "similar", "sequence"]).default("related"),
        weight: z.number().default(1),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const result = await db.insert(knowledgeEdges).values(clean({
        sourceId: input.sourceId,
        targetId: input.targetId,
        label: input.label,
        type: input.type,
        weight: input.weight,
        createdBy: ctx.user?.id ?? null,
      }));
      const id = Number(result.lastInsertRowid);
      await logAudit(ctx, "knowledge_edge", "create", id, input as Record<string, unknown>);
      return { id };
    }),

  deleteEdge: adminQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      await db.delete(knowledgeEdges).where(eq(knowledgeEdges.id, input.id));
      await logAudit(ctx, "knowledge_edge", "delete", input.id, input as Record<string, unknown>);
      return { success: true };
    }),

  /**
   * 一键自动建边：embed 全部节点的 title+content，全对余弦相似度，
   * 超过阈值且尚无边的节点对建 similar 边（权重=相似度）。
   * 用途：把知识库里的孤岛连通块（实测 20 个）按语义连起来。
   * dryRun=true 只预览不落库，供前端确认。
   */
  autoLinkEdges: adminQuery
    .input(z.object({
      threshold: z.number().min(0.3).max(0.95).default(0.62),
      maxPerNode: z.number().int().min(1).max(10).default(3),
      dryRun: z.boolean().default(true),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const nodes = await db.select({
        id: knowledgeNodes.id,
        title: knowledgeNodes.title,
        content: knowledgeNodes.content,
      }).from(knowledgeNodes);
      if (nodes.length < 2) return { created: 0, candidates: [], considered: 0, isolated: 0 };

      // 1) embed 全部节点（title + 内容前 200 字）
      const texts = nodes.map((n) => `${n.title}\n${(n.content ?? "").slice(0, 200)}`);
      const { embedTextsWithFallback } = await import("./lib/vector-service");
      const vectors = await embedTextsWithFallback(texts);
      const dims = vectors[0]?.length ?? 0;
      if (dims === 0) throw new Error("embedding 返回空向量");

      // L2 归一化 → 余弦 = 点积
      const normed = vectors.map((v) => {
        let s = 0;
        for (const x of v) s += x * x;
        const inv = s > 0 ? 1 / Math.sqrt(s) : 0;
        return v.map((x) => x * inv);
      });

      // 2) 已有边集合（双向去重）
      const existing = await db.select({
        s: knowledgeEdges.sourceId,
        t: knowledgeEdges.targetId,
      }).from(knowledgeEdges);
      const hasEdge = new Set<string>();
      for (const e of existing) {
        hasEdge.add(`${e.s}:${e.t}`);
        hasEdge.add(`${e.t}:${e.s}`);
      }

      // 3) 全对相似度，每节点保留 top maxPerNode 候选
      const perNode: Array<Array<{ j: number; score: number }>> = nodes.map(() => []);
      let considered = 0;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const key = `${nodes[i].id}:${nodes[j].id}`;
          if (hasEdge.has(key)) continue;
          let dot = 0;
          const a = normed[i];
          const b = normed[j];
          for (let k = 0; k < dims; k++) dot += a[k] * b[k];
          if (dot < input.threshold) continue;
          considered++;
          perNode[i].push({ j, score: dot });
          perNode[j].push({ j: i, score: dot });
        }
      }

      // 4) 每节点取 top maxPerNode，双边一致才建（A 的 top 含 B 且 B 的 top 含 A）
      const picked = new Map<string, { s: number; t: number; score: number }>();
      for (let i = 0; i < nodes.length; i++) {
        const top = perNode[i].sort((x, y) => y.score - x.score).slice(0, input.maxPerNode);
        for (const { j, score } of top) {
          const key = i < j ? `${i}:${j}` : `${j}:${i}`;
          if (picked.has(key)) {
            // 第二次出现 = 双边一致，确认建边
            picked.set(key, { s: nodes[Math.min(i, j)].id, t: nodes[Math.max(i, j)].id, score });
          } else {
            picked.set(key, { s: -1, t: -1, score }); // 占位：单边
          }
        }
      }
      const candidates = [...picked.values()]
        .filter((c) => c.s > 0)
        .sort((x, y) => y.score - x.score);

      // 5) dryRun 只预览
      if (input.dryRun) {
        return {
          created: 0,
          considered,
          isolated: nodes.length - new Set(existing.flatMap((e) => [e.s, e.t])).size,
          candidates: candidates.slice(0, 50).map((c) => ({
            sourceId: c.s,
            targetId: c.t,
            score: Math.round(c.score * 1000) / 1000,
            sourceTitle: nodes.find((n) => n.id === c.s)?.title ?? "",
            targetTitle: nodes.find((n) => n.id === c.t)?.title ?? "",
          })),
          totalCandidates: candidates.length,
        };
      }

      // 6) 落库（同步事务——drizzle 回调禁止 async）
      const created = db.transaction((tx) => {
        let n = 0;
        for (const c of candidates) {
          tx.insert(knowledgeEdges).values({
            sourceId: c.s,
            targetId: c.t,
            label: "auto",
            type: "similar",
            weight: Math.round(c.score * 100) / 100,
            createdBy: ctx.user?.id ?? null,
          }).run();
          n++;
        }
        return n;
      });
      await logAudit(ctx, "knowledge_edge", "create", 0, {
        autoLink: true, threshold: input.threshold, maxPerNode: input.maxPerNode, created,
      });
      return {
        created,
        considered,
        isolated: nodes.length - new Set(existing.flatMap((e) => [e.s, e.t])).size,
        candidates: [],
        totalCandidates: candidates.length,
      };
    }),

  getGraph: authedQuery.query(async () => {
    const db = getDb();
    const nodes = await db.select().from(knowledgeNodes);
    const edges = await db.select().from(knowledgeEdges);
    return { nodes, edges };
  }),

  /** 语义搜索 — 使用向量引擎 */
  semanticSearch: authedQuery
    .input(z.object({ query: z.string().min(1).max(500), topK: z.number().min(1).max(50).default(10) }))
    .query(async ({ input }) => {
      // 走 vectorService.searchVectors：内部先 embed query 再 search（与旧 zvec 行为一致）。
      // R3 重构时 SqliteVecEngine.searchByText 移除了 embed 逻辑，这里改用带 embed 的入口。
      const results = await semanticSearchVectors(input.query, input.topK);

      // 回退：向量库为空时回退到 LIKE 搜索
      if (results.length === 0) {
        const db = getDb();
        const q = `%${input.query}%`;
        const dbResults = await db.select().from(knowledgeNodes)
          .where(sql`${knowledgeNodes.title} LIKE ${q} OR ${knowledgeNodes.content} LIKE ${q}`)
          .orderBy(desc(knowledgeNodes.updatedAt))
          .limit(input.topK);
        return {
          mode: "fallback" as const,
          engine: "mysql-like",
          results: dbResults.map((n) => ({
            id: String(n.id),
            score: 1,
            title: n.title,
            snippet: (n.content ?? "").slice(0, 200),
            type: n.type,
          })),
        };
      }

      return {
        mode: "semantic" as const,
        engine: "cosine",
        results: results.map((r) => ({
          id: r.id,
          score: Math.round(r.score * 100) / 100,
          title: (r.metadata.title as string) ?? r.id,
          snippet: (r.metadata.content as string)?.slice(0, 200) ?? "",
          type: r.metadata.type as string ?? "note",
        })),
      };
    }),

  /** 向量健康检查 */
  vectorHealth: authedQuery.query(async () => {
    const engine = await vectorEngine.healthCheck();
    return {
      ...engine,
      mode: engine.mode === 'indexed' ? 'semantic' : 'fallback',
    };
  }),
});

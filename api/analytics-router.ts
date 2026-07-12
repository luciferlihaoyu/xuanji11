import { desc, eq, sql } from "drizzle-orm";
import { createRouter, scopedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { kbDocuments, knowledgeEdges, knowledgeNodes, type KnowledgeNode } from "@db/schema";

export interface AnalyticsTotals {
  readonly nodes: number;
  readonly edges: number;
  readonly documents: number;
  readonly tags: number;
}

export interface TagCount {
  readonly tag: string;
  readonly count: number;
}

export interface AnalyticsData {
  readonly totals: AnalyticsTotals;
  readonly topTags: TagCount[];
  readonly recentNodes: KnowledgeNode[];
  readonly orphanNodes: KnowledgeNode[];
}

async function fetchCount(table: typeof knowledgeNodes | typeof knowledgeEdges | typeof kbDocuments, where?: ReturnType<typeof eq>): Promise<number> {
  const db = getDb();
  const query = db.select({ count: sql<string>`count(*)` }).from(table);
  const [row] = where ? await query.where(where) : await query;
  return Number(row?.count ?? 0);
}

export async function getAnalyticsData(): Promise<AnalyticsData> {
  const db = getDb();

  const [nodes, edges, documents, tags] = await Promise.all([
    fetchCount(knowledgeNodes),
    fetchCount(knowledgeEdges),
    fetchCount(kbDocuments),
    fetchCount(knowledgeNodes, eq(knowledgeNodes.type, "tag")),
  ]);

  const docs = await db.select({ tags: kbDocuments.tags }).from(kbDocuments);
  const tagCounts = new Map<string, number>();
  for (const doc of docs) {
    if (Array.isArray(doc.tags)) {
      for (const tag of doc.tags) {
        if (typeof tag === "string" && tag.trim()) {
          const key = tag.trim();
          tagCounts.set(key, (tagCounts.get(key) ?? 0) + 1);
        }
      }
    }
  }
  const topTags = [...tagCounts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const [recentNodes, allNodes, allEdges] = await Promise.all([
    db.select().from(knowledgeNodes).orderBy(desc(knowledgeNodes.updatedAt)).limit(20),
    db.select().from(knowledgeNodes),
    db.select({ sourceId: knowledgeEdges.sourceId, targetId: knowledgeEdges.targetId }).from(knowledgeEdges),
  ]);

  const connectedIds = new Set<number>();
  for (const edge of allEdges) {
    connectedIds.add(edge.sourceId);
    connectedIds.add(edge.targetId);
  }
  const orphanNodes = allNodes.filter((node) => !connectedIds.has(node.id));

  return {
    totals: { nodes, edges, documents, tags },
    topTags,
    recentNodes,
    orphanNodes,
  };
}

export const analyticsRouter = createRouter({
  getAnalytics: scopedQuery("knowledge:read").query(async () => getAnalyticsData()),
});

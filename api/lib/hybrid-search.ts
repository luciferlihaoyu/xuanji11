import { z } from "zod";
import { desc, inArray, sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { kbDocuments, knowledgeNodes } from "@db/schema";
import type { KbDocument, KnowledgeNode } from "@db/schema";
import * as vectorService from "./vector-service";
import {
  type Filters,
  type InternalHit,
  type MergedHit,
  type Source,
  filtersSchema,
  makeSnippet,
  mergeResults,
  applyFilters,
  buildFacets,
} from "./hybrid-search-utils";

export const searchModeSchema = z.enum(["keyword", "vector", "hybrid"]);

export const searchInputSchema = z.object({
  query: z.string().min(1).max(500),
  mode: searchModeSchema.default("hybrid"),
  limit: z.number().int().min(1).max(50).default(10),
  filters: filtersSchema,
  /** LLM 重排：对融合后的 top 结果逐条打相关度分再排序（慢但准） */
  rerank: z.boolean().default(false),
});

export type SearchMode = z.infer<typeof searchModeSchema>;
export type SearchInput = z.input<typeof searchInputSchema>;
export type { Source, Filters };
export {
  makeSnippet,
  rrfScore,
  mergeResults,
  applyFilters,
  buildFacets,
} from "./hybrid-search-utils";

export interface SearchResult {
  readonly id: string;
  readonly title: string;
  readonly snippet: string;
  readonly type: string;
  readonly score: number;
  readonly sources: readonly Source[];
  readonly tags: readonly string[];
  readonly folderId: number | null;
}

export interface Facets {
  readonly types: Readonly<Record<string, number>>;
  readonly tags: Readonly<Record<string, number>>;
  readonly folders: Readonly<Record<string, number>>;
}

export interface SearchResponse {
  readonly results: readonly SearchResult[];
  readonly facets: Facets;
  readonly metadata: {
    readonly mode: SearchMode;
    readonly query: string;
    readonly limit: number;
    readonly total: number;
    readonly keywordResults: number;
    readonly vectorResults: number;
  };
}

function documentIdFromMetadata(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const docId = (metadata as Record<string, unknown>).documentId;
  if (typeof docId === "string" && docId.length > 0) return docId;
  if (typeof docId === "number" && Number.isFinite(docId)) return String(docId);
  return undefined;
}

function toSearchResult(hit: MergedHit, query: string): SearchResult {
  const sources = [...new Set(hit.sources)] as Source[];
  return {
    id: hit.id,
    title: hit.title,
    snippet: makeSnippet(hit.content, query),
    type: hit.type,
    score: Math.round(hit.score * 1000) / 1000,
    sources,
    tags: hit.tags,
    folderId: hit.folderId,
  };
}

async function fetchKeywordResults(query: string, limit: number): Promise<InternalHit[]> {
  const db = getDb();
  const q = `%${query}%`;

  // 1) 知识图谱节点（原有路径）
  const nodeRows = (await db
    .select()
    .from(knowledgeNodes)
    .where(sql`${knowledgeNodes.title} LIKE ${q} OR ${knowledgeNodes.content} LIKE ${q}`)
    .orderBy(desc(knowledgeNodes.updatedAt))
    .limit(limit)) as KnowledgeNode[];

  const nodeHits = nodeRows.map((node, index) => ({
    id: documentIdFromMetadata(node.metadata) ?? String(node.id),
    title: node.title,
    content: node.content ?? node.title ?? "",
    type: node.type,
    tags: [],
    folderId: null,
    source: "keyword" as Source,
    rank: index + 1,
  }));

  // 2) 知识库文档：优先 BM25（FTS5 trigram 对 chunk 全文检索，按相关度排序），
  //    无命中或 FTS 不可用时回退 LIKE（短查询 <3 字符 trigram 无法命中，必须回退）
  let docHits: InternalHit[] = [];
  try {
    const { bm25Search } = await import("./fts-search");
    const bm25Hits = bm25Search(query, limit * 2);
    // chunk 级 → 文档级聚合（同文档取最佳名次的 chunk 做代表）
    const byDoc = new Map<number, { rank: number; content: string }>();
    for (const h of bm25Hits) {
      const cur = byDoc.get(h.documentId);
      if (!cur || h.rank < cur.rank) byDoc.set(h.documentId, { rank: h.rank, content: h.content });
    }
    const docIds = [...byDoc.keys()];
    if (docIds.length > 0) {
      const docs = (await db
        .select()
        .from(kbDocuments)
        .where(inArray(kbDocuments.id, docIds))) as KbDocument[];
      const docMap = new Map(docs.map((d) => [d.id, d]));
      docHits = docIds
        .sort((a, b) => (byDoc.get(a)?.rank ?? 0) - (byDoc.get(b)?.rank ?? 0))
        .slice(0, limit)
        .map((id, index) => {
          const doc = docMap.get(id);
          return {
            id: String(id),
            title: doc?.title ?? `文档 #${id}`,
            content: byDoc.get(id)?.content ?? doc?.title ?? "",
            type: "document",
            tags: doc?.tags ?? [],
            folderId: doc?.folderId ?? null,
            source: "keyword" as Source,
            rank: nodeHits.length + index + 1,
          };
        });
    }
  } catch {
    // FTS 不可用（表损坏等）静默降级
  }

  if (docHits.length === 0) {
    const docRows = (await db
      .select()
      .from(kbDocuments)
      .where(sql`${kbDocuments.title} LIKE ${q} OR ${kbDocuments.content} LIKE ${q}`)
      .orderBy(desc(kbDocuments.updatedAt))
      .limit(limit)) as KbDocument[];

    docHits = docRows.map((doc, index) => ({
      id: String(doc.id),
      title: doc.title,
      content: doc.content ?? doc.title ?? "",
      type: "document",
      tags: doc.tags ?? [],
      folderId: doc.folderId ?? null,
      source: "keyword" as Source,
      rank: nodeHits.length + index + 1,
    }));
  }

  return [...nodeHits, ...docHits];
}

async function fetchVectorResults(query: string, limit: number): Promise<InternalHit[]> {
  const results = await vectorService.searchVectors(query, limit);
  return results.map((result, index) => {
    const metadata = result.metadata;
    const content = typeof metadata.content === "string" ? metadata.content : "";
    const title = typeof metadata.title === "string" ? metadata.title : result.id;
    const type = typeof metadata.type === "string" ? metadata.type : "document";
    return {
      id: documentIdFromMetadata(metadata) ?? result.id,
      title,
      content,
      type,
      tags: [],
      folderId: null,
      source: "vector" as Source,
      rank: index + 1,
    };
  });
}

async function enrichWithKbDocuments(hits: MergedHit[]): Promise<void> {
  const docIds = [
    ...new Set(hits.map((hit) => hit.id).filter((id) => /^\d+$/.test(id)).map(Number)),
  ];
  if (docIds.length === 0) return;

  const db = getDb();
  const docs = (await db.select().from(kbDocuments).where(inArray(kbDocuments.id, docIds))) as KbDocument[];
  const map = new Map(docs.map((doc) => [String(doc.id), doc]));

  for (const hit of hits) {
    const doc = map.get(hit.id);
    if (!doc) continue;
    if (hit.tags.length === 0) hit.tags = doc.tags ?? [];
    if (hit.folderId === null) hit.folderId = doc.folderId ?? null;
  }
}

/**
 * LLM 重排：对融合后的 top 候选逐条打 0~10 相关度分，按分重排。
 * 只在用户显式开 rerank=true 时跑（每次搜索多一次 LLM 调用，慢 1~3 秒）。
 * LLM 不可用/打分失败时静默回退到 RRF 原序。
 */
async function rerankWithLlm(query: string, hits: MergedHit[], limit: number): Promise<MergedHit[]> {
  const { chatCompletion, hasLlmAvailable } = await import("./llm-chat");
  if (!(await hasLlmAvailable())) return hits;

  // 一次调用评全部（比逐条调用快 N 倍；候选 <= 20 条塞得进 prompt）
  const candidates = hits.slice(0, Math.min(20, hits.length));
  const listing = candidates.map((h, i) => `${i + 1}. ${h.title} — ${h.content.slice(0, 80)}`).join("\n");
  const resp = await chatCompletion(
    `查询：${query}\n\n对下面候选按与查询的相关度打分（0~10 整数，10 最相关）。只输出 JSON 数组，长度 ${candidates.length}，顺序对应候选编号：\n${listing}\n\n只输出 JSON 数组，例：[8,3,0,...]`,
    { temperature: 0, maxTokens: 80, timeoutMs: 15000 },
  );
  if (!resp) return hits;

  try {
    const text = resp.content.replace(/```json\s*|\s*```/g, "").trim();
    const scores: unknown = JSON.parse(text);
    if (!Array.isArray(scores) || scores.length !== candidates.length) return hits;
    const scored = candidates.map((h, i) => ({
      hit: h,
      llmScore: typeof scores[i] === "number" ? (scores[i] as number) : 0,
    }));
    scored.sort((a, b) => b.llmScore - a.llmScore);
    // 重排后的候选放前面，超出 20 的尾部保持原序接在后面
    const tail = hits.slice(candidates.length);
    return [...scored.map((s) => s.hit), ...tail].slice(0, limit * 2);
  } catch {
    return hits;
  }
}

export async function executeHybridSearch(input: SearchInput): Promise<SearchResponse> {
  const { query, mode, limit, filters, rerank } = searchInputSchema.parse(input);

  const keywordHits: InternalHit[] = mode !== "vector" ? await fetchKeywordResults(query, limit) : [];
  const vectorHits: InternalHit[] = mode !== "keyword" ? await fetchVectorResults(query, limit) : [];

  let merged = mergeResults(keywordHits, vectorHits);

  // LLM 重排（可选）：融合后、过滤前——重排影响名次，过滤是硬性条件
  if (rerank && merged.length > 1) {
    merged = await rerankWithLlm(query, merged, limit);
  }

  await enrichWithKbDocuments(merged);

  const filtered = applyFilters(merged, filters);
  const limited = filtered.slice(0, limit);
  const results = limited.map((hit) => toSearchResult(hit, query));
  const facets = buildFacets(limited);

  return {
    results,
    facets,
    metadata: {
      mode,
      query,
      limit,
      total: results.length,
      keywordResults: keywordHits.length,
      vectorResults: vectorHits.length,
    },
  };
}

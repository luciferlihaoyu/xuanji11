import { z } from "zod";
import { desc, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { kbDocuments, knowledgeNodes } from "@db/schema";
import type { KbDocument, KnowledgeNode } from "@db/schema";
import * as vectorService from "./vector-service";
import {
  type EvidenceChunk,
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
  /** 命中原因（可解释性：用户能看懂为什么这条排上来） */
  readonly reasons: readonly string[];
  /** 证据片段（同文档的多个命中 chunk，展开查看用） */
  readonly evidence: readonly EvidenceChunk[];
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
  const reasons: string[] = [];
  if (query && hit.title.toLowerCase().includes(query.toLowerCase())) reasons.push("标题命中");
  if (sources.includes("keyword")) reasons.push("关键词命中（BM25）");
  if (sources.includes("vector")) reasons.push("语义命中");
  if (sources.length > 1) reasons.push("多路一致（关键词+语义）");
  // evidence 去重（同 snippet）+ 最多 5 条
  const seen = new Set<string>();
  const evidence = (hit.evidence ?? [])
    .filter((e) => {
      const key = e.snippet.slice(0, 60);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);
  return {
    id: hit.id,
    title: hit.title,
    snippet: makeSnippet(hit.content, query),
    type: hit.type,
    score: Math.round(hit.score * 1000) / 1000,
    sources,
    tags: hit.tags,
    folderId: hit.folderId,
    reasons,
    evidence,
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
    // chunk 级 → 文档级聚合（同文档取最佳名次的 chunk 做代表 + 收集 top-3 证据片段）
    const byDoc = new Map<number, { rank: number; content: string; evidence: EvidenceChunk[] }>();
    for (const h of bm25Hits) {
      const cur = byDoc.get(h.documentId);
      if (!cur) {
        byDoc.set(h.documentId, {
          rank: h.rank,
          content: h.content,
          evidence: [{ snippet: h.content, source: "keyword", rank: h.rank }],
        });
      } else {
        if (h.rank < cur.rank) { cur.rank = h.rank; cur.content = h.content; }
        if (cur.evidence.length < 3) cur.evidence.push({ snippet: h.content, source: "keyword", rank: h.rank });
      }
    }
    const docIds = [...byDoc.keys()];
    if (docIds.length > 0) {
      const docs = (await db
        .select()
        .from(kbDocuments)
        .where(sql`${inArray(kbDocuments.id, docIds)} AND ${isNull(kbDocuments.deletedAt)}`)) as KbDocument[];
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
            evidence: byDoc.get(id)?.evidence ?? [],
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
      .where(sql`(${kbDocuments.title} LIKE ${q} OR ${kbDocuments.content} LIKE ${q}) AND ${isNull(kbDocuments.deletedAt)}`)
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
  // 多取一些 chunk 级结果用于按文档聚合证据（同文档多个 chunk 命中合并成一条文档结果）
  const results = await vectorService.searchVectors(query, limit * 3);
  const byDoc = new Map<string, InternalHit & { evidence: EvidenceChunk[] }>();
  for (const [index, result] of results.entries()) {
    const metadata = result.metadata;
    const content = typeof metadata.content === "string" ? metadata.content : "";
    const title = typeof metadata.title === "string" ? metadata.title : result.id;
    const type = typeof metadata.type === "string" ? metadata.type : "document";
    const docId = documentIdFromMetadata(metadata) ?? result.id;
    const rank = index + 1;
    const existing = byDoc.get(docId);
    if (!existing) {
      byDoc.set(docId, {
        id: docId,
        title,
        content,
        type,
        tags: [],
        folderId: null,
        source: "vector" as Source,
        rank,
        evidence: content ? [{ snippet: content, source: "vector", rank }] : [],
      });
    } else if (content && existing.evidence.length < 3) {
      existing.evidence.push({ snippet: content, source: "vector", rank });
    }
  }
  return [...byDoc.values()].slice(0, limit);
}

async function enrichWithKbDocuments(hits: MergedHit[]): Promise<MergedHit[]> {
  const docIds = [
    ...new Set(hits.map((hit) => hit.id).filter((id) => /^\d+$/.test(id)).map(Number)),
  ];
  if (docIds.length === 0) return hits;

  const db = getDb();
  // 软删文档不进搜索结果（deletedAt 非 null 直接排除）
  const docs = (await db.select().from(kbDocuments)
    .where(sql`${inArray(kbDocuments.id, docIds)} AND ${isNull(kbDocuments.deletedAt)}`)) as KbDocument[];
  const map = new Map(docs.map((doc) => [String(doc.id), doc]));

  const kept: MergedHit[] = [];
  for (const hit of hits) {
    if (/^\d+$/.test(hit.id)) {
      const doc = map.get(hit.id);
      if (!doc) continue; // 文档不存在或已软删 → 从结果剔除
      if (hit.tags.length === 0) hit.tags = doc.tags ?? [];
      if (hit.folderId === null) hit.folderId = doc.folderId ?? null;
    }
    kept.push(hit);
  }
  return kept;
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

  merged = await enrichWithKbDocuments(merged);

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

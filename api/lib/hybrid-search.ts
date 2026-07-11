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
});

export type SearchMode = z.infer<typeof searchModeSchema>;
export type SearchInput = z.infer<typeof searchInputSchema>;
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
  const rows = (await db
    .select()
    .from(knowledgeNodes)
    .where(sql`${knowledgeNodes.title} LIKE ${q} OR ${knowledgeNodes.content} LIKE ${q}`)
    .orderBy(desc(knowledgeNodes.updatedAt))
    .limit(limit)) as KnowledgeNode[];

  return rows.map((node, index) => ({
    id: documentIdFromMetadata(node.metadata) ?? String(node.id),
    title: node.title,
    content: node.content ?? node.title ?? "",
    type: node.type,
    tags: [],
    folderId: null,
    source: "keyword" as Source,
    rank: index + 1,
  }));
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

export async function executeHybridSearch(input: SearchInput): Promise<SearchResponse> {
  const { query, mode, limit, filters } = input;

  const keywordHits: InternalHit[] = mode !== "vector" ? await fetchKeywordResults(query, limit) : [];
  const vectorHits: InternalHit[] = mode !== "keyword" ? await fetchVectorResults(query, limit) : [];

  const merged = mergeResults(keywordHits, vectorHits);
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

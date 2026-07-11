import { z } from "zod";

export type Source = "keyword" | "vector";

export interface InternalHit {
  id: string;
  title: string;
  content: string;
  type: string;
  tags: string[];
  folderId: number | null;
  source: Source;
  rank: number;
}

export interface MergedHit {
  id: string;
  title: string;
  content: string;
  type: string;
  tags: string[];
  folderId: number | null;
  sources: Source[];
  ranks: Partial<Record<Source, number>>;
  score: number;
}

export const RRF_K = 60;
export const MAX_SNIPPET_LENGTH = 200;

export const filtersSchema = z
  .object({
    type: z.string().optional(),
    folder: z.number().int().optional(),
    tags: z.array(z.string()).optional(),
  })
  .optional();

export type Filters = z.infer<typeof filtersSchema>;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function makeSnippet(content: string, query: string, maxLength = MAX_SNIPPET_LENGTH): string {
  const raw = content.slice(0, maxLength);
  if (!raw || !query) return raw;
  const escaped = escapeHtml(raw);
  const pattern = new RegExp(escapeRegex(query), "gi");
  return escaped.replace(pattern, (match) => `<mark>${escapeHtml(match)}</mark>`);
}

export function rrfScore(rank: number, k = RRF_K): number {
  return 1 / (k + rank);
}

export function mergeResults(keywordHits: readonly InternalHit[], vectorHits: readonly InternalHit[]): MergedHit[] {
  const map = new Map<string, MergedHit>();

  for (const hit of keywordHits) {
    const existing = map.get(hit.id);
    if (!existing) {
      map.set(hit.id, {
        ...hit,
        sources: [hit.source],
        ranks: { keyword: hit.rank },
        score: rrfScore(hit.rank),
      });
    } else {
      existing.sources.push(hit.source);
      existing.score += rrfScore(hit.rank);
    }
  }

  for (const hit of vectorHits) {
    const existing = map.get(hit.id);
    if (!existing) {
      map.set(hit.id, {
        ...hit,
        sources: [hit.source],
        ranks: { vector: hit.rank },
        score: rrfScore(hit.rank),
      });
    } else {
      existing.sources.push(hit.source);
      existing.score += rrfScore(hit.rank);
      if (hit.content) {
        existing.content = hit.content;
      }
    }
  }

  return [...map.values()].sort((a, b) => b.score - a.score);
}

function hasIntersection(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a);
  return b.some((tag) => set.has(tag));
}

export function applyFilters(results: readonly MergedHit[], filters: Filters): MergedHit[] {
  if (!filters) return [...results];
  return results.filter((hit) => {
    if (filters.type && hit.type !== filters.type) return false;
    if (filters.folder !== undefined && hit.folderId !== filters.folder) return false;
    if (filters.tags && filters.tags.length > 0 && !hasIntersection(hit.tags, filters.tags)) return false;
    return true;
  });
}

export function buildFacets(results: readonly MergedHit[]): {
  readonly types: Readonly<Record<string, number>>;
  readonly tags: Readonly<Record<string, number>>;
  readonly folders: Readonly<Record<string, number>>;
} {
  const types: Record<string, number> = {};
  const tags: Record<string, number> = {};
  const folders: Record<string, number> = {};

  for (const hit of results) {
    types[hit.type] = (types[hit.type] ?? 0) + 1;
    for (const tag of hit.tags) {
      tags[tag] = (tags[tag] ?? 0) + 1;
    }
    if (hit.folderId !== null) {
      folders[String(hit.folderId)] = (folders[String(hit.folderId)] ?? 0) + 1;
    }
  }

  return { types, tags, folders };
}

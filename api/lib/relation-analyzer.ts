import { z } from "zod";
import { eq, and, inArray, sql, or } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { knowledgeNodes, knowledgeEdges, kbDocuments } from "@db/schema";
import type { KbDocument } from "@db/schema";
import { searchVectors } from "./vector-service";

export const STRATEGIES = ["co-occurrence", "vector", "reference"] as const;
export type Strategy = (typeof STRATEGIES)[number];

export const discoverInputSchema = z.object({
  documentId: z.number().int().positive(),
  strategies: z.array(z.enum([...STRATEGIES])).min(1).optional().default([...STRATEGIES]),
  limit: z.number().int().positive().max(100).default(20),
});

export type DiscoverInput = z.infer<typeof discoverInputSchema>;

export interface RelationSuggestion {
  readonly strategy: Strategy;
  readonly targetType: "document" | "node";
  readonly targetId: number;
  readonly title: string;
  readonly score: number;
  readonly reason: string;
}

export interface DiscoverResult {
  readonly documentId: number;
  readonly strategies: readonly Strategy[];
  readonly suggestions: readonly RelationSuggestion[];
}

function assertNever(value: never): never {
  throw new Error(`Unexpected strategy: ${String(value)}`);
}

async function findDocumentNodeId(documentId: number): Promise<number | undefined> {
  const db = getDb();
  const rows = await db
    .select({ id: knowledgeNodes.id })
    .from(knowledgeNodes)
    .where(
      and(
        eq(knowledgeNodes.type, "document"),
        sql`JSON_UNQUOTE(JSON_EXTRACT(${knowledgeNodes.metadata}, '$.documentId')) = ${String(documentId)}`,
      ),
    )
    .limit(1);
  return rows[0]?.id;
}

async function loadDocument(documentId: number): Promise<KbDocument> {
  const db = getDb();
  const rows = await db.select().from(kbDocuments).where(eq(kbDocuments.id, documentId)).limit(1);
  const document = rows[0];
  if (!document) throw new Error("Document not found");
  return document;
}

async function cooccurrenceStrategy(
  docNodeId: number | undefined,
  limit: number,
): Promise<readonly RelationSuggestion[]> {
  if (docNodeId === undefined) return [];

  const db = getDb();
  const tagEdges = await db
    .select({ sourceId: knowledgeEdges.sourceId })
    .from(knowledgeEdges)
    .where(and(eq(knowledgeEdges.targetId, docNodeId), eq(knowledgeEdges.label, "tag")));

  const tagIds = tagEdges.map((edge) => edge.sourceId);
  if (tagIds.length === 0) return [];

  const relatedEdges = await db
    .select({ targetId: knowledgeEdges.targetId })
    .from(knowledgeEdges)
    .where(
      and(
        inArray(knowledgeEdges.sourceId, tagIds),
        eq(knowledgeEdges.label, "tag"),
        sql`${knowledgeEdges.targetId} != ${docNodeId}`,
      ),
    );

  const sharedCounts = new Map<number, number>();
  for (const edge of relatedEdges) {
    if (edge.targetId === docNodeId) continue;
    sharedCounts.set(edge.targetId, (sharedCounts.get(edge.targetId) ?? 0) + 1);
  }

  const relatedDocNodeIds = [...sharedCounts.keys()];
  if (relatedDocNodeIds.length === 0) return [];

  const nodes = await db
    .select({ id: knowledgeNodes.id, title: knowledgeNodes.title, metadata: knowledgeNodes.metadata })
    .from(knowledgeNodes)
    .where(inArray(knowledgeNodes.id, relatedDocNodeIds));

  const suggestions: RelationSuggestion[] = [];
  for (const node of nodes) {
    const metadata = node.metadata ?? {};
    const targetDocumentId =
      typeof metadata.documentId === "number"
        ? metadata.documentId
        : typeof metadata.documentId === "string"
          ? Number.parseInt(metadata.documentId, 10)
          : undefined;
    if (targetDocumentId === undefined || Number.isNaN(targetDocumentId)) continue;

    const shared = sharedCounts.get(node.id) ?? 0;
    if (shared === 0) continue;
    suggestions.push({
      strategy: "co-occurrence",
      targetType: "document",
      targetId: targetDocumentId,
      title: node.title,
      score: shared,
      reason: `Shares ${shared} tag edge${shared === 1 ? "" : "s"}`,
    });
  }

  return suggestions
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit);
}

function extractWikiLinks(content: string): readonly string[] {
  const links: string[] = [];
  const pattern = /\[\[(.*?)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const title = match[1].trim();
    if (title.length > 0) links.push(title);
  }
  return [...new Set(links)];
}

async function referenceStrategy(
  document: KbDocument,
  docNodeId: number | undefined,
  limit: number,
): Promise<readonly RelationSuggestion[]> {
  const links = extractWikiLinks(document.content ?? "");
  if (links.length === 0) return [];

  const db = getDb();
  const targetNodes = await db
    .select({ id: knowledgeNodes.id, title: knowledgeNodes.title })
    .from(knowledgeNodes)
    .where(inArray(knowledgeNodes.title, [...links]));

  const targetNodeIds = targetNodes.map((node) => node.id);
  const linkedNodeIds = new Set<number>();

  if (docNodeId !== undefined && targetNodeIds.length > 0) {
    const existingEdges = await db
      .select({ sourceId: knowledgeEdges.sourceId, targetId: knowledgeEdges.targetId })
      .from(knowledgeEdges)
      .where(
        or(
          and(eq(knowledgeEdges.sourceId, docNodeId), inArray(knowledgeEdges.targetId, targetNodeIds)),
          and(eq(knowledgeEdges.targetId, docNodeId), inArray(knowledgeEdges.sourceId, targetNodeIds)),
        ),
      );
    for (const edge of existingEdges) {
      linkedNodeIds.add(edge.sourceId === docNodeId ? edge.targetId : edge.sourceId);
    }
  }

  const suggestions: RelationSuggestion[] = [];
  for (const node of targetNodes) {
    if (linkedNodeIds.has(node.id)) continue;
    suggestions.push({
      strategy: "reference",
      targetType: "node",
      targetId: node.id,
      title: node.title,
      score: 1,
      reason: `Wiki-link reference [[${node.title}]]`,
    });
  }

  return suggestions.slice(0, limit);
}

function readDocumentIdFromMetadata(metadata: Record<string, unknown>): number | undefined {
  if (typeof metadata.documentId === "number") return metadata.documentId;
  if (typeof metadata.documentId === "string") {
    const parsed = Number.parseInt(metadata.documentId, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

async function vectorStrategy(
  document: KbDocument,
  limit: number,
  threshold: number,
): Promise<readonly RelationSuggestion[]> {
  const query = `${document.title}\n${document.content ?? ""}`.trim();
  if (query.length === 0) return [];

  const results = await searchVectors(query, limit * 2);
  const suggestions: RelationSuggestion[] = [];

  for (const result of results) {
    if (result.score < threshold) continue;
    const targetDocumentId = readDocumentIdFromMetadata(result.metadata);
    if (targetDocumentId === undefined || targetDocumentId === document.id) continue;

    const title =
      typeof result.metadata.title === "string" && result.metadata.title.length > 0
        ? result.metadata.title
        : String(result.id);

    suggestions.push({
      strategy: "vector",
      targetType: "document",
      targetId: targetDocumentId,
      title,
      score: Math.round(result.score * 100) / 100,
      reason: "Vector cosine similarity",
    });
  }

  return suggestions.slice(0, limit);
}

function deduplicateSuggestions(suggestions: readonly RelationSuggestion[]): readonly RelationSuggestion[] {
  const seen = new Map<string, RelationSuggestion>();
  for (const suggestion of suggestions) {
    const key = `${suggestion.targetType}-${suggestion.targetId}`;
    const existing = seen.get(key);
    if (!existing || existing.score < suggestion.score) {
      seen.set(key, suggestion);
    }
  }
  return [...seen.values()].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

export async function discoverRelations(input: DiscoverInput): Promise<DiscoverResult> {
  const document = await loadDocument(input.documentId);
  const docNodeId = await findDocumentNodeId(input.documentId);
  const activeStrategies = [...new Set(input.strategies)];
  const perStrategyLimit = Math.max(1, Math.ceil(input.limit / activeStrategies.length));

  const allSuggestions: RelationSuggestion[] = [];

  for (const strategy of activeStrategies) {
    switch (strategy) {
      case "co-occurrence":
        allSuggestions.push(...(await cooccurrenceStrategy(docNodeId, perStrategyLimit)));
        break;
      case "vector":
        allSuggestions.push(...(await vectorStrategy(document, perStrategyLimit, 0.7)));
        break;
      case "reference":
        allSuggestions.push(...(await referenceStrategy(document, docNodeId, perStrategyLimit)));
        break;
      default:
        assertNever(strategy);
    }
  }

  return {
    documentId: input.documentId,
    strategies: activeStrategies,
    suggestions: deduplicateSuggestions(allSuggestions).slice(0, input.limit),
  };
}

import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { knowledgeNodes, knowledgeEdges, kbDocuments } from "@db/schema";
import { clean } from "./clean";
import { extractKeywords } from "./keyword-extractor";

export const autoTagInputSchema = z.object({
  documentId: z.number().int().positive(),
});

export type AutoTagInput = z.infer<typeof autoTagInputSchema>;

export interface AutoTagResult {
  readonly tags: string[];
  readonly created: number;
  readonly edges: number;
}

async function findOrCreateDocumentNode(documentId: number, createdBy: number | null): Promise<number> {
  const db = getDb();
  const existing = await db
    .select()
    .from(knowledgeNodes)
    .where(
      and(
        eq(knowledgeNodes.type, "document"),
        sql`JSON_UNQUOTE(JSON_EXTRACT(${knowledgeNodes.metadata}, '$.documentId')) = ${String(documentId)}`,
      ),
    )
    .limit(1);

  if (existing.length > 0) return existing[0].id;

  const [doc] = await db.select().from(kbDocuments).where(eq(kbDocuments.id, documentId));
  if (!doc) throw new Error("Document not found");

  const result = await db.insert(knowledgeNodes).values(clean({
    title: doc.title,
    content: doc.content ?? undefined,
    type: "document",
    metadata: { documentId: doc.id },
    createdBy,
  }));
  return Number(result[0].insertId);
}

async function findOrCreateTagNode(tag: string, createdBy: number | null): Promise<{ id: number; created: boolean }> {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(knowledgeNodes)
    .where(and(eq(knowledgeNodes.title, tag), eq(knowledgeNodes.type, "tag")))
    .limit(1);

  if (existing) return { id: existing.id, created: false };

  const result = await db.insert(knowledgeNodes).values(clean({
    title: tag,
    type: "tag",
    createdBy,
  }));
  return { id: Number(result[0].insertId), created: true };
}

async function findOrCreateTagEdge(tagId: number, docNodeId: number, createdBy: number | null): Promise<boolean> {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(knowledgeEdges)
    .where(
      and(
        eq(knowledgeEdges.sourceId, tagId),
        eq(knowledgeEdges.targetId, docNodeId),
        eq(knowledgeEdges.label, "tag"),
      ),
    )
    .limit(1);

  if (existing) return false;

  await db.insert(knowledgeEdges).values(clean({
    sourceId: tagId,
    targetId: docNodeId,
    label: "tag",
    type: "related",
    createdBy,
  }));
  return true;
}

export async function autoTagDocument(
  documentId: number,
  maxKeywords: number,
  createdBy: number | null,
): Promise<AutoTagResult> {
  const db = getDb();
  const [doc] = await db.select().from(kbDocuments).where(eq(kbDocuments.id, documentId));
  if (!doc) throw new Error("Document not found");

  const text = `${doc.title ?? ""}\n${doc.content ?? ""}`;
  const keywords = await extractKeywords(text, "auto", maxKeywords);
  const tags = keywords.map((k) => k.word);

  if (tags.length === 0) return { tags, created: 0, edges: 0 };

  const docNodeId = await findOrCreateDocumentNode(documentId, createdBy);
  let createdCount = 0;
  let edgeCount = 0;

  for (const tag of tags) {
    const { id: tagId, created } = await findOrCreateTagNode(tag, createdBy);
    if (created) createdCount++;
    const edgeCreated = await findOrCreateTagEdge(tagId, docNodeId, createdBy);
    if (edgeCreated) edgeCount++;
  }

  return { tags, created: createdCount, edges: edgeCount };
}

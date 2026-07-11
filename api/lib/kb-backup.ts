import { z } from "zod";
import { getDb } from "../queries/connection";
import { knowledgeNodes, knowledgeEdges, kbDocuments } from "@db/schema";
import type { KnowledgeNode, KnowledgeEdge, KbDocument } from "@db/schema";

const BACKUP_VERSION = "1.0";

const nodeTypeSchema = z.enum(["concept", "document", "topic", "entity", "note", "tag"]);
const edgeTypeSchema = z.enum(["related", "contains", "references", "extends", "similar", "sequence"]);
const documentFormatSchema = z.enum(["markdown", "text", "json", "html", "code"]);

const dateOrStringSchema = z.union([z.string().datetime({ offset: true }), z.date()]);

export const knowledgeNodeSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1).max(500),
  content: z.string().max(50_000).optional(),
  type: nodeTypeSchema,
  posX: z.number().optional(),
  posY: z.number().optional(),
  style: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdBy: z.number().int().positive().nullable().optional(),
  createdAt: dateOrStringSchema,
  updatedAt: dateOrStringSchema,
});

export const knowledgeEdgeSchema = z.object({
  id: z.number().int().positive(),
  sourceId: z.number().int().positive(),
  targetId: z.number().int().positive(),
  label: z.string().max(255).optional(),
  type: edgeTypeSchema,
  weight: z.number().optional(),
  createdBy: z.number().int().positive().nullable().optional(),
  createdAt: dateOrStringSchema,
});

export const kbDocumentSchema = z.object({
  id: z.number().int().positive(),
  folderId: z.number().int().positive().nullable().optional(),
  title: z.string().min(1).max(500),
  content: z.string().max(100_000).optional(),
  format: documentFormatSchema,
  tags: z.array(z.string().max(100)).max(100).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdBy: z.number().int().positive().nullable().optional(),
  createdAt: dateOrStringSchema,
  updatedAt: dateOrStringSchema,
});

export const kbBackupSchema = z.object({
  version: z.string().max(10),
  exportedAt: z.string().max(50).optional(),
  data: z.object({
    nodes: z.array(knowledgeNodeSchema).max(10_000),
    edges: z.array(knowledgeEdgeSchema).max(10_000),
    documents: z.array(kbDocumentSchema).max(10_000),
  }),
});

export type KbBackupData = z.infer<typeof kbBackupSchema>;

export interface KbBackupResult {
  readonly version: string;
  readonly exportedAt: string;
  readonly data: {
    readonly nodes: readonly KnowledgeNode[];
    readonly edges: readonly KnowledgeEdge[];
    readonly documents: readonly KbDocument[];
  };
}

export interface KbImportResult {
  readonly nodes: number;
  readonly edges: number;
  readonly documents: number;
}

function toDate(value: Date | string): Date {
  return typeof value === "string" ? new Date(value) : value;
}

export async function exportKnowledgeBase(): Promise<KbBackupResult> {
  const db = getDb();
  const [nodes, edges, documents] = await Promise.all([
    db.select().from(knowledgeNodes),
    db.select().from(knowledgeEdges),
    db.select().from(kbDocuments),
  ]);
  return {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    data: { nodes, edges, documents },
  };
}

export async function importKnowledgeBase(input: unknown): Promise<KbImportResult> {
  const parsed = kbBackupSchema.parse(input);
  const db = getDb();

  const nodeValues = parsed.data.nodes.map((node) => ({
    ...node,
    createdAt: toDate(node.createdAt),
    updatedAt: toDate(node.updatedAt),
  }));

  const edgeValues = parsed.data.edges.map((edge) => ({
    ...edge,
    createdAt: toDate(edge.createdAt),
  }));

  const documentValues = parsed.data.documents.map((doc) => ({
    ...doc,
    createdAt: toDate(doc.createdAt),
    updatedAt: toDate(doc.updatedAt),
  }));

  let nodes = 0;
  let edges = 0;
  let documents = 0;

  if (nodeValues.length > 0) {
    const result = await db.insert(knowledgeNodes).ignore().values(nodeValues);
    nodes = Number(result[0].affectedRows ?? 0);
  }
  if (edgeValues.length > 0) {
    const result = await db.insert(knowledgeEdges).ignore().values(edgeValues);
    edges = Number(result[0].affectedRows ?? 0);
  }
  if (documentValues.length > 0) {
    const result = await db.insert(kbDocuments).ignore().values(documentValues);
    documents = Number(result[0].affectedRows ?? 0);
  }

  return { nodes, edges, documents };
}

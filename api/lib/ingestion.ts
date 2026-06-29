import { eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import {
  kbDocuments,
  ingestionJobs,
  ingestionItems,
  documentChunks,
  knowledgeNodes,
  type InsertIngestionJob,
  type InsertIngestionItem,
  type InsertKbDocument,
  type InsertDocumentChunk,
} from "@db/schema";
import { vectorEngine } from "./vector";
import * as fs from "fs";
import * as path from "path";

export type IngestionSourceType = "upload" | "datasource" | "backup" | "manual";

export interface IngestFileOptions {
  sourceType: IngestionSourceType;
  sourceId?: string;
  fileName: string;
  mimeType: string;
  size: number;
  storagePath?: string;
  uploadedFileId?: number;
  externalId?: string;
  sourceUrl?: string;
  downloadUrl?: string;
  metadata?: Record<string, unknown>;
  createdBy?: number | null;
}

const SUPPORTED_TEXT_MIMES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "text/css",
  "application/json",
  "application/xml",
]);

function isTextMime(mimeType: string): boolean {
  return SUPPORTED_TEXT_MIMES.has(mimeType) || mimeType.startsWith("text/");
}

const TEMP_DIR = process.env.UPLOAD_DIR || "./uploads";

async function ensureLocalPath(options: IngestFileOptions): Promise<{ localPath: string; isTemp: boolean }> {
  if (options.storagePath && fs.existsSync(options.storagePath)) {
    return { localPath: options.storagePath, isTemp: false };
  }
  const url = options.downloadUrl || options.sourceUrl;
  if (!url) {
    throw new Error("No local path or downloadable URL provided");
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const ext = path.extname(options.fileName) || ".bin";
  const tempPath = path.join(TEMP_DIR, `ds-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  fs.writeFileSync(tempPath, buffer);
  return { localPath: tempPath, isTemp: true };
}

function chunkText(text: string, maxChars = 800, overlap = 100): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxChars) return normalized ? [normalized] : [];
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(start + maxChars, normalized.length);
    let slice = normalized.slice(start, end);
    if (end < normalized.length) {
      const lastBreak = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf("。"), slice.lastIndexOf(". "));
      if (lastBreak > overlap) {
        slice = slice.slice(0, lastBreak + 1);
      }
    }
    chunks.push(slice.trim());
    start += Math.max(slice.length - overlap, 1);
  }
  return chunks.filter((c) => c.length > 0);
}

async function parseFileToText(storagePath: string, mimeType: string): Promise<{ text: string; supported: boolean }> {
  if (!fs.existsSync(storagePath)) {
    return { text: "", supported: false };
  }

  if (isTextMime(mimeType)) {
    const buffer = fs.readFileSync(storagePath);
    return { text: buffer.toString("utf-8"), supported: true };
  }

  if (mimeType === "application/pdf") {
    try {
      const pdfjs = await import("pdfjs-dist");
      const data = new Uint8Array(fs.readFileSync(storagePath));
      const doc = await pdfjs.getDocument({ data }).promise;
      const pages: string[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        pages.push(content.items.map((item) => (item as { str: string }).str).join(""));
      }
      return { text: pages.join("\n"), supported: true };
    } catch (err) {
      console.error("[Ingestion] PDF parse failed:", err);
      return { text: "", supported: false };
    }
  }

  return { text: "", supported: false };
}

export async function createIngestionJob(
  sourceType: IngestionSourceType,
  sourceId: string | undefined,
  createdBy: number | null
): Promise<number> {
  const db = getDb();
  const values: InsertIngestionJob = {
    sourceType,
    sourceId: sourceId ?? null,
    status: "pending",
    totalItems: 0,
    processedItems: 0,
    failedItems: 0,
    error: null,
    retryCount: 0,
    metadata: {},
    createdBy,
  };
  const result = await db.insert(ingestionJobs).values(values);
  return Number(result[0].insertId);
}

export async function ingestFile(options: IngestFileOptions): Promise<{ itemId: number; documentId?: number }> {
  const db = getDb();
  const {
    sourceType,
    sourceId,
    fileName,
    mimeType,
    size,
    storagePath,
    uploadedFileId,
    externalId,
    sourceUrl,
    metadata: extraMetadata,
    createdBy,
  } = options;

  let localPath = storagePath;
  let isTemp = false;
  try {
    const ensured = await ensureLocalPath(options);
    localPath = ensured.localPath;
    isTemp = ensured.isTemp;
  } catch (err) {
    const jobId = await createIngestionJob(sourceType, sourceId, createdBy ?? null);
    const itemResult = await db.insert(ingestionItems).values({
      jobId,
      externalId: externalId ?? null,
      name: fileName,
      mimeType,
      size,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      sourceUrl: sourceUrl ?? null,
      storagePath: storagePath ?? null,
      documentId: null,
      metadata: { ...(extraMetadata ?? {}), uploadedFileId: uploadedFileId ?? null },
    });
    await db.update(ingestionJobs).set({ totalItems: 1, processedItems: 1, failedItems: 1, status: "completed" }).where(eq(ingestionJobs.id, jobId));
    return { itemId: Number(itemResult[0].insertId) };
  }

  const ext = path.extname(fileName).toLowerCase();
  const jobId = await createIngestionJob(sourceType, sourceId, createdBy ?? null);

  const itemValues: InsertIngestionItem = {
    jobId,
    externalId: externalId ?? null,
    name: fileName,
    mimeType,
    size,
    status: "pending",
    error: null,
    sourceUrl: sourceUrl ?? null,
    storagePath: isTemp ? null : localPath,
    documentId: null,
    metadata: { ...(extraMetadata ?? {}), uploadedFileId: uploadedFileId ?? null },
  };
  const itemResult = await db.insert(ingestionItems).values(itemValues);
  const itemId = Number(itemResult[0].insertId);

  await db
    .update(ingestionJobs)
    .set({ totalItems: 1, status: "running" })
    .where(eq(ingestionJobs.id, jobId));

  const { text, supported } = await parseFileToText(localPath, mimeType);

  if (isTemp && fs.existsSync(localPath)) {
    try { fs.unlinkSync(localPath); } catch { /* ignore cleanup errors */ }
  }

  if (!supported || text.trim().length === 0) {
    await db
      .update(ingestionItems)
      .set({ status: supported ? "completed" : "unsupported", error: supported ? null : `Unsupported format: ${mimeType}` })
      .where(eq(ingestionItems.id, itemId));
    await db
      .update(ingestionJobs)
      .set({ processedItems: 1, failedItems: supported ? 0 : 1, status: "completed" })
      .where(eq(ingestionJobs.id, jobId));
    return { itemId };
  }

  await db.update(ingestionItems).set({ status: "parsing" }).where(eq(ingestionItems.id, itemId));

  const docValues: InsertKbDocument = {
    folderId: null,
    title: path.basename(fileName, ext),
    content: text,
    format: mimeTypeToFormat(mimeType),
    tags: [],
    metadata: { source: sourceType, vectorized: false },
    createdBy: createdBy ?? null,
  };
  const docResult = await db.insert(kbDocuments).values(docValues);
  const documentId = Number(docResult[0].insertId);

  await db.update(ingestionItems).set({ status: "chunking", documentId }).where(eq(ingestionItems.id, itemId));

  const chunks = chunkText(text);
  const chunkRecords: InsertDocumentChunk[] = chunks.map((content, idx) => ({
    documentId,
    itemId,
    content,
    chunkIndex: idx,
    embedding: null,
    embeddingModel: null,
    metadata: {},
  }));

  if (chunkRecords.length > 0) {
    await db.insert(documentChunks).values(chunkRecords);
  }

  await db.update(ingestionItems).set({ status: "indexing" }).where(eq(ingestionItems.id, itemId));

  const indexedCount = await vectorEngine.indexDocumentChunks(
    documentId,
    chunks.map((content, idx) => ({ content, index: idx })),
    {
      title: docValues.title,
      type: "document",
      itemId: String(itemId),
    }
  );

  await db
    .update(kbDocuments)
    .set({ metadata: { source: sourceType, vectorized: indexedCount > 0 } })
    .where(eq(kbDocuments.id, documentId));

  const nodeTitle = docValues.title ?? fileName;
  await db.insert(knowledgeNodes).values({
    title: nodeTitle,
    content: text.slice(0, 500),
    type: "document",
    posX: 0,
    posY: 0,
    style: {},
    metadata: { documentId: String(documentId), source: sourceType },
    createdBy: createdBy ?? null,
  });

  await db.update(ingestionItems).set({ status: "completed" }).where(eq(ingestionItems.id, itemId));
  await db
    .update(ingestionJobs)
    .set({ processedItems: 1, failedItems: 0, status: "completed" })
    .where(eq(ingestionJobs.id, jobId));

  return { itemId, documentId };
}

function mimeTypeToFormat(mimeType: string): InsertKbDocument["format"] {
  if (mimeType.includes("markdown")) return "markdown";
  if (mimeType.includes("html")) return "html";
  if (mimeType.includes("json")) return "json";
  if (mimeType.includes("text")) return "text";
  return "text";
}

/**
 * 璇玑向量引擎 — Zvec 持久化优先，未配置时回退到内置余弦相似度
 */

// allow: SIZE_OK — 向量引擎是持有私有可变状态（collection / zvecInitialized / fallbackStore）的单体模块，
// 嵌入配置、请求、解析逻辑是 vectorEngine 的私有辅助函数；拆分会暴露内部状态并增加耦合。

import * as fs from "fs";
import * as path from "path";
import zvec from "@zvec/zvec";
import type { ZVecCollection, ZVecCollectionSchema, ZVecDataType, ZVecDocInput, ZVecStatus } from "@zvec/zvec";
import { eq } from "drizzle-orm";
import { systemSettings } from "@db/schema";
import { env } from "./env";
import { getDb } from "../queries/connection";

interface VectorEntry {
  id: string;
  vector: number[];
  metadata: Record<string, unknown>;
}

const fallbackStore: VectorEntry[] = [];
const collectionName = "document_chunks";
const vectorFieldName = "embedding";
let zvecInitialized = false;
let collection: ZVecCollection | null = null;

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function simpleTextHash(text: string, dims: number = 64): number[] {
  const vec = new Array(dims).fill(0);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    vec[i % dims] += (code / 65535) * 2 - 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm === 0 ? vec : vec.map((v) => v / norm);
}

interface EmbeddingConfig {
  enabled: boolean;
  url: string;
  key: string;
  model: string;
  dimension: number;
}

type EmbeddingProvider = "openai" | "volcengine";

function detectProvider(url: string): EmbeddingProvider {
  try {
    const u = new URL(url);
    if (u.hostname.includes("ark.cn-beijing.volces.com")) return "volcengine";
  } catch {
    // fall through to default
  }
  return "openai";
}

function defaultEmbeddingDimension(model: string): number {
  return model.includes("doubao-embedding-vision") ? 2048 : 1536;
}

function getEmbeddingConfig(): EmbeddingConfig {
  const url = process.env.LLM_API_URL || "";
  const key = process.env.LLM_API_KEY || "";
  const model = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
  const dimension = parseInt(process.env.EMBEDDING_DIMENSION || String(defaultEmbeddingDimension(model)), 10) || defaultEmbeddingDimension(model);
  return { enabled: Boolean(url && key), url, key, model, dimension };
}

async function loadEmbeddingConfig(): Promise<EmbeddingConfig> {
  try {
    const db = getDb();
    const keys = ["embedding_api_url", "embedding_api_key", "embedding_model", "embedding_dimension"];
    const settings = new Map<string, string>();
    for (const key of keys) {
      const row = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
      if (row[0]?.value) settings.set(key, row[0].value);
    }
    const url = settings.get("embedding_api_url") || process.env.LLM_API_URL || "";
    const key = settings.get("embedding_api_key") || process.env.LLM_API_KEY || "";
    const model = settings.get("embedding_model") || process.env.EMBEDDING_MODEL || "text-embedding-3-small";
    const rawDimension = settings.get("embedding_dimension") || process.env.EMBEDDING_DIMENSION;
    const dimension = rawDimension ? parseInt(rawDimension, 10) || defaultEmbeddingDimension(model) : defaultEmbeddingDimension(model);
    return { enabled: Boolean(url && key), url, key, model, dimension };
  } catch (err) {
    console.warn("[VectorEngine] Failed to load embedding config from DB, falling back to env:", err instanceof Error ? err.message : String(err));
    return getEmbeddingConfig();
  }
}

async function fetchEmbeddings(texts: string[]): Promise<number[][]> {
  const cfg = await loadEmbeddingConfig();
  if (!cfg.enabled) throw new Error("Embedding provider not configured");
  const isVolcengine = detectProvider(cfg.url) === "volcengine";
  const endpoint = isVolcengine ? new URL("/embeddings/multimodal", cfg.url) : new URL("/embeddings", cfg.url);
  const body = isVolcengine
    ? { model: cfg.model, input: texts.map((text) => ({ type: "text", text })), encoding_format: "float", ...(cfg.model.includes("doubao-embedding-vision") ? { dimensions: cfg.dimension } : {}) }
    : { input: texts, model: cfg.model, encoding_format: "float" };
  const res = await fetch(endpoint.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify(body),
  });
  const rawText = await res.text().catch(() => "");
  const payload = (() => { try { return JSON.parse(rawText); } catch { return undefined; } })();
  const errPayload = payload as { error?: { code?: string; message?: string } } | undefined;
  if (!res.ok) {
    throw new Error(`Embedding API ${res.status}: ${errPayload?.error?.message ? `${errPayload.error.code ?? "error"}: ${errPayload.error.message}` : rawText.slice(0, 200)}`);
  }
  if (errPayload?.error?.message) throw new Error(`${errPayload.error.code ?? "Embedding API error"}: ${errPayload.error.message}`);
  const data = payload as { data?: Array<{ embedding?: number[] | number[][]; index?: number }> } | undefined;
  const embeddings = (data?.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => {
    if (!isVolcengine) return Array.isArray(d.embedding) ? (d.embedding as number[]) : [];
    const nested = Array.isArray(d.embedding) ? (d.embedding as number[][])[0] : undefined;
    return Array.isArray(nested) ? nested : [];
  });
  if (embeddings.length !== texts.length) throw new Error(`Embedding API returned ${embeddings.length} vectors for ${texts.length} texts`);
  return embeddings;
}

async function embedWithFallback(texts: string[]): Promise<number[][]> {
  const cfg = await loadEmbeddingConfig();
  if (!cfg.enabled) return texts.map((t) => simpleTextHash(t, 64));
  try {
    return await fetchEmbeddings(texts);
  } catch (err) {
    console.warn("[VectorEngine] Embedding API failed, falling back to hash:", err instanceof Error ? err.message : String(err));
    return texts.map((t) => simpleTextHash(t, 64));
  }
}

function normalizeVector(vector: number[]): number[] {
  if (vector.length === env.zvecDimension) return vector;
  if (vector.length > env.zvecDimension) return vector.slice(0, env.zvecDimension);
  return [...vector, ...new Array(env.zvecDimension - vector.length).fill(0)];
}

function scalarFields(metadata: Record<string, unknown>): Record<string, string | number | boolean> {
  const fields: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") fields[key] = value;
  }
  return fields;
}

function fieldType(value: string | number | boolean): ZVecDataType {
  if (typeof value === "boolean") return zvec.ZVecDataType.BOOL;
  if (typeof value === "number") return Number.isInteger(value) ? zvec.ZVecDataType.INT64 : zvec.ZVecDataType.DOUBLE;
  return zvec.ZVecDataType.STRING;
}

function assertStatus(status: ZVecStatus | ZVecStatus[]): void {
  const failed = Array.isArray(status) ? status.find((item) => !item.ok) : status.ok ? undefined : status;
  if (failed) throw new Error(`Zvec ${failed.code}: ${failed.message}`);
}

export function initializeZvec(): void {
  if (zvecInitialized || !env.zvecEnabled) return;
  zvec.ZVecInitialize({ logLevel: zvec.ZVecLogLevel.WARN });
  zvecInitialized = true;
}

function createSchema(): ZVecCollectionSchema {
  return new zvec.ZVecCollectionSchema({
    name: collectionName,
    vectors: { name: vectorFieldName, dataType: zvec.ZVecDataType.VECTOR_FP32, dimension: env.zvecDimension },
    fields: [
      { name: "documentId", dataType: zvec.ZVecDataType.STRING, indexParams: { indexType: zvec.ZVecIndexType.INVERT } },
      { name: "chunkIndex", dataType: zvec.ZVecDataType.INT64 },
      { name: "content", dataType: zvec.ZVecDataType.STRING },
      { name: "title", dataType: zvec.ZVecDataType.STRING, nullable: true },
      { name: "type", dataType: zvec.ZVecDataType.STRING, nullable: true },
      { name: "itemId", dataType: zvec.ZVecDataType.STRING, nullable: true },
      { name: "format", dataType: zvec.ZVecDataType.STRING, nullable: true },
    ],
  });
}

function getCollection(): ZVecCollection {
  if (collection) return collection;
  initializeZvec();
  fs.mkdirSync(env.zvecDataDir, { recursive: true });
  collection = zvec.ZVecCreateAndOpen(path.join(env.zvecDataDir, collectionName), createSchema());
  return collection;
}

function ensureMetadataColumns(fields: Record<string, string | number | boolean>): void {
  const store = getCollection();
  for (const [name, value] of Object.entries(fields)) {
    try {
      store.schema.field(name);
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      store.addColumnSync({ fieldSchema: { name, dataType: fieldType(value), nullable: true } });
    }
  }
}

function toZvecDoc(id: string, vector: number[], metadata: Record<string, unknown>): ZVecDocInput {
  const fields = scalarFields(metadata);
  ensureMetadataColumns(fields);
  return { id, vectors: { [vectorFieldName]: normalizeVector(vector) }, fields };
}

function documentFilter(documentId: number | string): string {
  return `documentId == '${String(documentId).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export interface SearchResult {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
}

export const vectorEngine = {
  async insert(id: string, vector: number[], metadata: Record<string, unknown> = {}): Promise<void> {
    if (!env.zvecEnabled) {
      fallbackStore.push({ id, vector: normalizeVector(vector), metadata });
      return;
    }
    assertStatus(getCollection().upsertSync(toZvecDoc(id, vector, metadata)));
  },

  async insertBatch(entries: Array<{ id: string; vector: number[]; metadata?: Record<string, unknown> }>): Promise<void> {
    if (!env.zvecEnabled) {
      fallbackStore.push(...entries.map((entry) => ({ id: entry.id, vector: normalizeVector(entry.vector), metadata: entry.metadata ?? {} })));
      return;
    }
    assertStatus(getCollection().upsertSync(entries.map((entry) => toZvecDoc(entry.id, entry.vector, entry.metadata ?? {}))));
  },

  async indexDocumentChunks(documentId: number | string, chunks: Array<{ content: string; index: number; metadata?: Record<string, unknown> }>, baseMetadata: Record<string, unknown> = {}): Promise<number> {
    const docKey = String(documentId);
    await this.deleteByDocumentId(docKey);
    const embeddings = await embedWithFallback(chunks.map((c) => c.content));
    const entries = chunks.map((chunk, i) => ({
      id: `chunk-${docKey}-${chunk.index}`,
      vector: embeddings[i] ?? [],
      metadata: { ...baseMetadata, ...chunk.metadata, documentId: docKey, chunkIndex: chunk.index, content: chunk.content },
    }));
    await this.insertBatch(entries);
    return entries.length;
  },

  async deleteByDocumentId(documentId: number | string): Promise<number> {
    if (!env.zvecEnabled) {
      const before = fallbackStore.length;
      for (let i = fallbackStore.length - 1; i >= 0; i--) if (String(fallbackStore[i].metadata.documentId) === String(documentId)) fallbackStore.splice(i, 1);
      return before - fallbackStore.length;
    }
    const store = getCollection();
    const before = store.stats.docCount;
    assertStatus(store.deleteByFilterSync(documentFilter(documentId)));
    return before - store.stats.docCount;
  },

  async search(queryVector: number[], topK: number = 10): Promise<SearchResult[]> {
    const vector = normalizeVector(queryVector);
    if (!env.zvecEnabled) {
      return fallbackStore.map((entry) => ({ id: entry.id, score: cosineSimilarity(vector, entry.vector), metadata: entry.metadata })).sort((a, b) => b.score - a.score).slice(0, topK);
    }
    return getCollection().querySync({ fieldName: vectorFieldName, vector, topk: topK }).map((doc) => ({ id: doc.id, score: doc.score, metadata: doc.fields }));
  },

  async searchByText(query: string, topK: number = 10): Promise<SearchResult[]> {
    const [queryVector] = await embedWithFallback([query]);
    return this.search(queryVector ?? [], topK);
  },

  async embedText(text: string): Promise<number[]> {
    const [vector] = await embedWithFallback([text]);
    return normalizeVector(vector ?? []);
  },

  get size(): number {
    return env.zvecEnabled ? getCollection().stats.docCount : fallbackStore.length;
  },

  clear(): void {
    if (!env.zvecEnabled) {
      fallbackStore.length = 0;
      return;
    }
    getCollection().destroySync();
    collection = null;
  },

  async healthCheck(): Promise<{ ok: boolean; engine: string; size: number; mode: "empty" | "indexed"; provider: string; model: string }> {
    const cfg = await loadEmbeddingConfig();
    const size = this.size;
    return { ok: true, engine: env.zvecEnabled ? "zvec" : cfg.enabled ? "embedding-api" : "cosine-fallback", size, mode: size === 0 ? "empty" : "indexed", provider: cfg.enabled ? cfg.url : "hash-fallback", model: cfg.enabled ? cfg.model : "simple-hash-64" };
  },
};

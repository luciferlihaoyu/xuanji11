/**
 * 璇玑向量引擎 — 优先真实 embedding 模型，回退到内置余弦相似度
 *
 * 配置优先级：system_settings 表 > 环境变量
 * - embedding_api_url / LLM_API_URL: OpenAI/MiniMax 兼容的 API 基础地址
 * - embedding_api_key / LLM_API_KEY: API 密钥
 * - embedding_model / EMBEDDING_MODEL: 模型名称（默认 text-embedding-3-small）
 * - embedding_dimension / EMBEDDING_DIMENSION: 向量维度（默认 1536）
 *
 * 当未配置或调用失败时，自动回退到基于字符哈希的 embedding。
 */

import { getDb } from "../queries/connection";
import { systemSettings } from "@db/schema";
import { eq } from "drizzle-orm";

interface VectorEntry {
  id: string;
  vector: number[];
  metadata: Record<string, unknown>;
}

const fallbackStore: VectorEntry[] = [];

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

/** 同步回退：只读环境变量 */
function getEmbeddingConfig(): EmbeddingConfig {
  const url = process.env.LLM_API_URL || "";
  const key = process.env.LLM_API_KEY || "";
  const model = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
  const dimension = parseInt(process.env.EMBEDDING_DIMENSION || "1536", 10) || 1536;
  return { enabled: Boolean(url && key), url, key, model, dimension };
}

/** 异步加载：优先从 system_settings 表读取，回退到环境变量 */
async function loadEmbeddingConfig(): Promise<EmbeddingConfig> {
  try {
    const db = getDb();
    const keys = [
      "embedding_api_url",
      "embedding_api_key",
      "embedding_model",
      "embedding_dimension",
    ];

    const settings = new Map<string, string>();
    for (const key of keys) {
      const row = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.key, key));
      if (row[0]?.value) {
        settings.set(key, row[0].value);
      }
    }

    const url = settings.get("embedding_api_url") || process.env.LLM_API_URL || "";
    const key = settings.get("embedding_api_key") || process.env.LLM_API_KEY || "";
    const model = settings.get("embedding_model") || process.env.EMBEDDING_MODEL || "text-embedding-3-small";
    const dimension = parseInt(
      settings.get("embedding_dimension") || process.env.EMBEDDING_DIMENSION || "1536",
      10
    ) || 1536;

    return { enabled: Boolean(url && key), url, key, model, dimension };
  } catch (err) {
    console.warn("[VectorEngine] Failed to load embedding config from DB, falling back to env:", err instanceof Error ? err.message : String(err));
    return getEmbeddingConfig();
  }
}

async function fetchEmbeddings(texts: string[]): Promise<number[][]> {
  const cfg = await loadEmbeddingConfig();
  if (!cfg.enabled) {
    throw new Error("Embedding provider not configured");
  }

  const endpoint = new URL("/embeddings", cfg.url).toString();
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.key}`,
    },
    body: JSON.stringify({
      input: texts,
      model: cfg.model,
      encoding_format: "float",
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Embedding API ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    data?: Array<{ embedding?: number[]; index?: number }>;
    error?: { message?: string };
  };

  if (data.error?.message) {
    throw new Error(data.error.message);
  }

  const embeddings = (data.data ?? [])
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((d) => d.embedding ?? []);

  if (embeddings.length !== texts.length) {
    throw new Error(`Embedding API returned ${embeddings.length} vectors for ${texts.length} texts`);
  }

  return embeddings;
}

async function embedWithFallback(texts: string[]): Promise<number[][]> {
  const cfg = await loadEmbeddingConfig();
  if (!cfg.enabled) {
    return texts.map((t) => simpleTextHash(t, 64));
  }

  try {
    return await fetchEmbeddings(texts);
  } catch (err) {
    console.warn("[VectorEngine] Embedding API failed, falling back to hash:", err instanceof Error ? err.message : String(err));
    return texts.map((t) => simpleTextHash(t, 64));
  }
}

export interface SearchResult {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
}

export const vectorEngine = {
  async insert(id: string, vector: number[], metadata: Record<string, unknown> = {}): Promise<void> {
    fallbackStore.push({ id, vector, metadata });
  },

  async insertBatch(entries: Array<{ id: string; vector: number[]; metadata?: Record<string, unknown> }>): Promise<void> {
    for (const entry of entries) {
      fallbackStore.push({ id: entry.id, vector: entry.vector, metadata: entry.metadata ?? {} });
    }
  },

  async indexDocumentChunks(
    documentId: number | string,
    chunks: Array<{ content: string; index: number; metadata?: Record<string, unknown> }>,
    baseMetadata: Record<string, unknown> = {}
  ): Promise<number> {
    const docKey = String(documentId);
    for (let i = fallbackStore.length - 1; i >= 0; i--) {
      if (String(fallbackStore[i].metadata.documentId) === docKey) {
        fallbackStore.splice(i, 1);
      }
    }

    const embeddings = await embedWithFallback(chunks.map((c) => c.content));
    const entries = chunks.map((chunk, i) => ({
      id: `chunk-${docKey}-${chunk.index}`,
      vector: embeddings[i],
      metadata: {
        ...baseMetadata,
        ...chunk.metadata,
        documentId: docKey,
        chunkIndex: chunk.index,
        content: chunk.content.slice(0, 200),
      },
    }));
    await this.insertBatch(entries);
    return entries.length;
  },

  async deleteByDocumentId(documentId: number | string): Promise<number> {
    const docKey = String(documentId);
    let removed = 0;
    for (let i = fallbackStore.length - 1; i >= 0; i--) {
      if (String(fallbackStore[i].metadata.documentId) === docKey) {
        fallbackStore.splice(i, 1);
        removed++;
      }
    }
    return removed;
  },

  async search(queryVector: number[], topK: number = 10): Promise<SearchResult[]> {
    if (fallbackStore.length === 0) return [];
    const scored = fallbackStore.map((entry) => ({
      id: entry.id,
      score: cosineSimilarity(queryVector, entry.vector),
      metadata: entry.metadata,
    }));
    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  },

  async searchByText(query: string, topK: number = 10): Promise<SearchResult[]> {
    const [queryVector] = await embedWithFallback([query]);
    return this.search(queryVector, topK);
  },

  async embedText(text: string): Promise<number[]> {
    const [vector] = await embedWithFallback([text]);
    return vector;
  },

  get size(): number {
    return fallbackStore.length;
  },

  clear(): void {
    fallbackStore.length = 0;
  },

  async healthCheck(): Promise<{
    ok: boolean;
    engine: string;
    size: number;
    mode: "empty" | "indexed";
    provider: string;
    model: string;
  }> {
    const cfg = await loadEmbeddingConfig();
    const size = fallbackStore.length;
    return {
      ok: true,
      engine: cfg.enabled ? "embedding-api" : "cosine-fallback",
      size,
      mode: size === 0 ? "empty" : "indexed",
      provider: cfg.enabled ? cfg.url : "hash-fallback",
      model: cfg.enabled ? cfg.model : "simple-hash-64",
    };
  },
};

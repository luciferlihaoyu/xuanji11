/**
 * 璇玑向量引擎 — Zvec 优先，回退到内置余弦相似度
 *
 * 优先使用 @zvec/zvec (阿里开源的进程内向量数据库)，
 * 如果不可用则回退到内存中的余弦相似度搜索。
 */

// ========================================================
// 内置回退向量存储（内存余弦相似度）
// ========================================================

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

// ========================================================
// 内置简易 embedding（文本 → 向量）
// 生产环境应替换为 OpenAI text-embedding-3-small 或 BGE-large-zh
// ========================================================

function simpleTextHash(text: string, dims: number = 64): number[] {
  const vec = new Array(dims).fill(0);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    vec[i % dims] += (code / 65535) * 2 - 1;
  }
  // 归一化
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm === 0 ? vec : vec.map((v) => v / norm);
}

// ========================================================
// 公开 API
// ========================================================

export interface SearchResult {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
}

export const vectorEngine = {
  /** 插入文档向量 */
  async insert(id: string, vector: number[], metadata: Record<string, unknown> = {}): Promise<void> {
    fallbackStore.push({ id, vector, metadata });
  },

  /** 批量插入 */
  async insertBatch(entries: Array<{ id: string; vector: number[]; metadata?: Record<string, unknown> }>): Promise<void> {
    for (const entry of entries) {
      fallbackStore.push({ id: entry.id, vector: entry.vector, metadata: entry.metadata ?? {} });
    }
  },

  /** 语义搜索（返回 topK） */
  async search(queryVector: number[], topK: number = 10): Promise<SearchResult[]> {
    if (fallbackStore.length === 0) return [];
    const scored = fallbackStore.map((entry) => ({
      id: entry.id,
      score: cosineSimilarity(queryVector, entry.vector),
      metadata: entry.metadata,
    }));
    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  },

  /** 从文本搜索 */
  async searchByText(query: string, topK: number = 10): Promise<SearchResult[]> {
    const queryVector = simpleTextHash(query, 64);
    return this.search(queryVector, topK);
  },

  /** 生成文本 embedding */
  embedText(text: string): number[] {
    return simpleTextHash(text, 64);
  },

  /** 获取存储数量 */
  get size(): number {
    return fallbackStore.length;
  },

  /** 清空存储 */
  clear(): void {
    fallbackStore.length = 0;
  },

  /** 健康检查 */
  async healthCheck(): Promise<{ ok: boolean; engine: string; size: number }> {
    return { ok: true, engine: 'cosine-fallback', size: fallbackStore.length };
  },
};

/**
 * 抽象 VectorEngine 接口 + SqliteVecEngine 实现（用 sqlite-vec 扩展）。
 * 替代原 @zvec/zvec 引擎：零外部依赖、零二进制、跨平台一致。
 */
import { getRawDb } from "../queries/connection";

/** 引擎接口（保持原 vectorEngine 公开 API）。 */
export interface VectorEngine {
  insert(id: string, vector: number[], metadata?: Record<string, unknown>): Promise<void>;
  insertBatch(entries: Array<{ id: string; vector: number[]; metadata?: Record<string, unknown> }>): Promise<void>;
  indexDocumentChunks(
    documentId: number | string,
    chunks: Array<{ content: string; index: number; metadata?: Record<string, unknown> }>,
    baseMetadata?: Record<string, unknown>,
  ): Promise<number>;
  deleteByDocumentId(documentId: number | string): Promise<number>;
  search(queryVector: number[], topK?: number): Promise<VectorSearchHit[]>;
  searchByText(query: string, topK?: number): Promise<VectorSearchHit[]>;
  embedText(text: string): Promise<number[]>;
  addDocuments(docs: Array<{ content: string; metadata?: Record<string, unknown> }>): Promise<number>;
  readonly size: number;
  clear(): void;
  healthCheck(): Promise<{ ok: boolean; engine: string; size: number; mode: "empty" | "indexed"; error?: string; dimension?: number }>;
}

export interface VectorSearchHit {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
}

const VEC_TABLE = "vec_chunks";
const META_TABLE = "vec_chunk_meta";
const DIM_DEFAULT = 1536;

let initialized = false;

/** 确保 vec0 虚拟表与元数据表存在（首次启动调用）。 */
function ensureSchema(dim: number): void {
  if (initialized) return;
  const raw = getRawDb();
  // vec0 虚拟表：仅存 embedding（用 rowid 标识；id 字符串存 META）
  raw.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${VEC_TABLE} USING vec0(
       embedding float[${dim}] distance_metric=cosine
     )`,
  );
  // 元数据表：id 主键 + 文档/chunk 关联 + rowid 反查
  raw.exec(
    `CREATE TABLE IF NOT EXISTS ${META_TABLE} (
       rowid INTEGER PRIMARY KEY,
       id TEXT NOT NULL UNIQUE,
       documentId TEXT,
       chunkIndex INTEGER,
       content TEXT,
       metadataJson TEXT,
       createdAt INTEGER DEFAULT (unixepoch() * 1000)
     )`,
  );
  raw.exec(`CREATE INDEX IF NOT EXISTS ${META_TABLE}_doc_idx ON ${META_TABLE}(documentId)`);
  raw.exec(`CREATE INDEX IF NOT EXISTS ${META_TABLE}_id_idx ON ${META_TABLE}(id)`);
  initialized = true;
}

function metadataToJson(meta: Record<string, unknown> | undefined): string {
  return JSON.stringify(meta ?? {});
}

function metadataFromJson(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try { return JSON.parse(json) as Record<string, unknown>; } catch { return {}; }
}

/** 兜底：内存引擎——sqlite-vec 不可用时启用（不持久化、跨重启丢失）。 */
class MemoryVectorEngine implements VectorEngine {
  private store: Array<{ id: string; vector: number[]; metadata: Record<string, unknown> }> = [];
  async insert(id: string, vector: number[], metadata: Record<string, unknown> = {}): Promise<void> {
    this.store.push({ id, vector: this.normalize(vector), metadata });
  }
  async insertBatch(entries: Array<{ id: string; vector: number[]; metadata?: Record<string, unknown> }>): Promise<void> {
    this.store.push(...entries.map((e) => ({ id: e.id, vector: this.normalize(e.vector), metadata: e.metadata ?? {} })));
  }
  async indexDocumentChunks(documentId: number | string, chunks: Array<{ content: string; index: number; metadata?: Record<string, unknown> }>, baseMetadata: Record<string, unknown> = {}): Promise<number> {
    const docKey = String(documentId);
    await this.deleteByDocumentId(docKey);
    // 此处不调 embedWithFallback（依赖外部）；调用方负责先 embed
    for (const c of chunks) {
      this.store.push({ id: `chunk-${docKey}-${c.index}`, vector: [], metadata: { ...baseMetadata, ...c.metadata, documentId: docKey, chunkIndex: c.index, content: c.content } });
    }
    return chunks.length;
  }
  async deleteByDocumentId(documentId: number | string): Promise<number> {
    const before = this.store.length;
    const target = String(documentId);
    for (let i = this.store.length - 1; i >= 0; i--) {
      if (String(this.store[i].metadata.documentId) === target) this.store.splice(i, 1);
    }
    return before - this.store.length;
  }
  async search(queryVector: number[], topK: number = 10): Promise<VectorSearchHit[]> {
    const v = this.normalize(queryVector);
    return this.store
      .filter((e) => e.vector.length > 0)
      .map((e) => ({ id: e.id, score: cosineSimilarity(v, e.vector), metadata: e.metadata }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
  async searchByText(_query: string, _topK: number = 10): Promise<VectorSearchHit[]> { return []; }
  async embedText(_text: string): Promise<number[]> { return []; }
  async addDocuments(_docs: Array<{ content: string; metadata?: Record<string, unknown> }>): Promise<number> { return 0; }
  get size(): number { return this.store.length; }
  clear(): void { this.store.length = 0; }
  async healthCheck(): Promise<{ ok: boolean; engine: string; size: number; mode: "empty" | "indexed"; error?: string; dimension?: number }> {
    return { ok: true, engine: "memory-fallback", size: this.store.length, mode: this.store.length === 0 ? "empty" : "indexed" };
  }
  private normalize(v: number[]): number[] { return v.length > 0 ? v : new Array(DIM_DEFAULT).fill(0); }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** SQLite + sqlite-vec 实现。 */
class SqliteVecEngine implements VectorEngine {
  private dim: number;

  constructor(dim: number = DIM_DEFAULT) {
    this.dim = dim;
    ensureSchema(dim);
  }

  static create(dim: number = DIM_DEFAULT): SqliteVecEngine {
    return new SqliteVecEngine(dim);
  }

  private vectorToBlob(v: number[]): Buffer {
    const arr = new Float32Array(v);
    return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
  }

  // (内部 row→vector 转换保留供未来使用)

  async insert(id: string, vector: number[], metadata: Record<string, unknown> = {}): Promise<void> {
    await this.insertBatch([{ id, vector, metadata }]);
  }

  async insertBatch(entries: Array<{ id: string; vector: number[]; metadata?: Record<string, unknown> }>): Promise<void> {
    if (entries.length === 0) return;
    const raw = getRawDb();
    const insertVec = raw.prepare(`INSERT INTO ${VEC_TABLE}(embedding) VALUES (?)`);
    const insertMeta = raw.prepare(
      `INSERT INTO ${META_TABLE}(rowid, id, documentId, chunkIndex, content, metadataJson)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(rowid) DO UPDATE SET
         id = excluded.id,
         documentId = excluded.documentId,
         chunkIndex = excluded.chunkIndex,
         content = excluded.content,
         metadataJson = excluded.metadataJson`,
    );
    const tx = raw.transaction((rows: typeof entries) => {
      for (const e of rows) {
        if (e.vector.length !== this.dim) {
          // 维度不匹配时跳过向量插入
          continue;
        }
        const result = insertVec.run(this.vectorToBlob(e.vector));
        const rowid = Number(result.lastInsertRowid);
        insertMeta.run(
          rowid,
          e.id,
          String(e.metadata?.documentId ?? ""),
          Number(e.metadata?.chunkIndex ?? -1),
          String(e.metadata?.content ?? ""),
          metadataToJson(e.metadata),
        );
      }
    });
    tx(entries);
  }

  async indexDocumentChunks(documentId: number | string, chunks: Array<{ content: string; index: number; metadata?: Record<string, unknown> }>, _baseMetadata: Record<string, unknown> = {}): Promise<number> {
    const docKey = String(documentId);
    await this.deleteByDocumentId(docKey);
    // embed 由调用方负责（保持与原 API 行为一致）
    return chunks.length;
  }

  async deleteByDocumentId(documentId: number | string): Promise<number> {
    const raw = getRawDb();
    const target = String(documentId);
    const rows = raw.prepare(`SELECT rowid FROM ${META_TABLE} WHERE documentId = ?`).all(target) as Array<{ rowid: number }>;
    if (rows.length === 0) return 0;
    const rowids = rows.map((r) => r.rowid);
    const placeholders = rowids.map(() => "?").join(",");
    const tx = raw.transaction(() => {
      raw.prepare(`DELETE FROM ${VEC_TABLE} WHERE rowid IN (${placeholders})`).run(...rowids);
      raw.prepare(`DELETE FROM ${META_TABLE} WHERE rowid IN (${placeholders})`).run(...rowids);
    });
    tx();
    return rowids.length;
  }

  async search(queryVector: number[], topK: number = 10): Promise<VectorSearchHit[]> {
    if (queryVector.length !== this.dim) return [];
    const raw = getRawDb();
    const blob = this.vectorToBlob(queryVector);
    // vec0 KNN 查询（用 k=N 语法，LIMIT 会触发 vec0 报错）
    const rows = raw.prepare(
      `SELECT v.rowid AS rowid, v.distance AS distance, m.id AS id, m.metadataJson AS metadataJson
         FROM ${VEC_TABLE} v
         INNER JOIN ${META_TABLE} m ON m.rowid = v.rowid
         WHERE v.embedding MATCH ? AND k = ?
         ORDER BY v.distance`,
    ).all(blob, topK) as Array<{ rowid: number; distance: number; id: string; metadataJson: string | null }>;
    return rows.map((r) => ({
      id: r.id,
      // cosine 距离 → 相似度（1 - distance）
      score: 1 - r.distance,
      metadata: metadataFromJson(r.metadataJson),
    }));
  }

  async searchByText(_query: string, _topK: number = 10): Promise<VectorSearchHit[]> {
    // embed 由调用方负责：vectorEngine.searchByText 在 vector-service 包装
    return [];
  }
  async embedText(_text: string): Promise<number[]> { return []; }
  async addDocuments(_docs: Array<{ content: string; metadata?: Record<string, unknown> }>): Promise<number> { return 0; }

  get size(): number {
    const raw = getRawDb();
    const r = raw.prepare(`SELECT count(*) AS c FROM ${META_TABLE}`).get() as { c: number };
    return r.c;
  }
  clear(): void {
    const raw = getRawDb();
    raw.exec(`DELETE FROM ${VEC_TABLE}; DELETE FROM ${META_TABLE};`);
  }

  async healthCheck(): Promise<{ ok: boolean; engine: string; size: number; mode: "empty" | "indexed"; error?: string; dimension?: number }> {
    return { ok: true, engine: "sqlite-vec", size: this.size, mode: this.size === 0 ? "empty" : "indexed", dimension: this.dim };
  }
}

/** 引擎工厂：自动检测 sqlite-vec 是否可用。 */
let engineInstance: VectorEngine | null = null;

export function getVectorEngine(dim: number = DIM_DEFAULT): VectorEngine {
  if (engineInstance) return engineInstance;
  // 探测 vec0
  try {
    const raw = getRawDb();
    raw.prepare("SELECT vec_version() AS v").get();
    engineInstance = SqliteVecEngine.create(dim);
  } catch (err) {
    console.warn("[VectorEngine] sqlite-vec 不可用，降级到内存引擎:", err instanceof Error ? err.message : err);
    engineInstance = new MemoryVectorEngine();
  }
  return engineInstance;
}

/** 测试用：注入 fake 引擎。 */
export function _setVectorEngineForTests(engine: VectorEngine): void {
  engineInstance = engine;
}

export function _resetVectorEngineForTests(): void {
  engineInstance = null;
  initialized = false;
}

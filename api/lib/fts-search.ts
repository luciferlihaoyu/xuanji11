/**
 * SQLite FTS5（trigram）BM25 全文检索。
 *
 * 为什么 trigram：unicode61 分词器对中文无效（整句一个词），
 * trigram 按 3 字滑窗匹配，中文/中英混排/代码标识符都能命中，无需外部分词器。
 *
 * 表：chunks_fts(rowid=document_chunks.id, content)
 * 同步：document-indexer 插入 chunk 后调 syncChunkToFts；
 *       document-removal 删除文档后调 deleteDocumentFromFts；
 *       首次检索 ensureFts() 幂等回填存量。
 */
import { getRawDb } from "../queries/connection";

const FTS_TABLE = "chunks_fts";
let ftsReady = false;

/** 建表 + 幂等回填存量 chunks */
export function ensureFts(): void {
  if (ftsReady) return;
  const raw = getRawDb();
  raw.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(content, tokenize='trigram')`
  );
  const ftsCount = (raw.prepare(`SELECT COUNT(*) c FROM ${FTS_TABLE}`).get() as { c: number }).c;
  const chunkCount = (raw.prepare(`SELECT COUNT(*) c FROM document_chunks`).get() as { c: number }).c;
  if (ftsCount < chunkCount) {
    raw.exec(
      `INSERT INTO ${FTS_TABLE}(rowid, content)
       SELECT c.id, c.content FROM document_chunks c
       WHERE NOT EXISTS (SELECT 1 FROM ${FTS_TABLE} f WHERE f.rowid = c.id)`
    );
  }
  ftsReady = true;
}

/** 新 chunk 同步进 FTS（未初始化时跳过，等 ensureFts 回填） */
export function syncChunkToFts(chunkId: number, content: string): void {
  if (!ftsReady) return;
  getRawDb()
    .prepare(`INSERT OR REPLACE INTO ${FTS_TABLE}(rowid, content) VALUES (?, ?)`)
    .run(chunkId, content);
}

/** 删除文档的全部 FTS 记录 */
export function deleteDocumentFromFts(documentId: number): void {
  if (!ftsReady) return;
  getRawDb()
    .prepare(
      `DELETE FROM ${FTS_TABLE} WHERE rowid IN (SELECT id FROM document_chunks WHERE documentId = ?)`
    )
    .run(documentId);
}

export interface Bm25Hit {
  readonly chunkId: number;
  readonly documentId: number;
  readonly content: string;
  readonly rank: number; // bm25 原始名次（1 起，越小越好）
}

/**
 * BM25 检索。返回 chunk 级命中，按 bm25 名次升序。
 * 短查询（<3 字符）trigram 无法命中，返回空——由调用方回退 LIKE。
 */
export function bm25Search(query: string, limit: number): Bm25Hit[] {
  ensureFts();
  const raw = getRawDb();
  const safe = query.replace(/"/g, '""').trim();
  if (safe.length < 3) return [];
  const rows = raw
    .prepare(
      `SELECT f.rowid AS chunkId, c.documentId AS documentId, c.content AS content,
              bm25(${FTS_TABLE}) AS score
       FROM ${FTS_TABLE} f
       JOIN document_chunks c ON c.id = f.rowid
       WHERE ${FTS_TABLE} MATCH ?
       ORDER BY score
       LIMIT ?`
    )
    .all(`"${safe}"`, limit) as Array<{ chunkId: number; documentId: number; content: string; score: number }>;
  return rows.map((r, i) => ({
    chunkId: r.chunkId,
    documentId: r.documentId,
    content: r.content,
    rank: i + 1,
  }));
}

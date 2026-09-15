/**
 * 索引一致性巡检：对账 documents / chunks / FTS / vector / 图谱节点。
 *
 * 每天跑一次（cron），发现不一致只报告不自动修（避免误删）；
 * 报告落「工作流报告」文件夹，供人工或后续自动修复参考。
 *
 * 检查项：
 *   1. 文档无 chunks（该索引未索引）
 *   2. chunks 无 FTS 记录（BM25 路缺失）
 *   3. chunks 无向量（语义路缺失）
 *   4. FTS 孤儿（指向已删 chunk）
 *   5. 向量孤儿（指向已删文档）
 *   6. 图谱 document 节点指向不存在的文档
 */
import { getRawDb } from "../queries/connection";

export interface IndexHealthReport {
  checkedAt: string;
  documents: number;
  chunks: number;
  ftsRows: number;
  vectorRows: number;
  graphDocNodes: number;
  issues: Array<{ kind: string; count: number; detail: string }>;
  healthy: boolean;
}

export function checkIndexHealth(): IndexHealthReport {
  const db = getRawDb();
  const issues: IndexHealthReport["issues"] = [];

  const count = (sql: string): number => (db.prepare(sql).get() as { c: number }).c;

  const documents = count("SELECT COUNT(*) c FROM kb_documents WHERE deletedAt IS NULL");
  const chunks = count("SELECT COUNT(*) c FROM document_chunks");
  const ftsRows = count("SELECT COUNT(*) c FROM chunks_fts");
  const vectorRows = count("SELECT COUNT(*) c FROM vec_chunk_meta");
  const graphDocNodes = count("SELECT COUNT(*) c FROM knowledge_nodes WHERE type = 'document'");

  // 1. 文档无 chunks
  const docsNoChunks = count(`
    SELECT COUNT(*) c FROM kb_documents d
    WHERE d.deletedAt IS NULL
      AND d.content IS NOT NULL AND length(trim(d.content)) > 0
      AND d.id NOT IN (SELECT DISTINCT documentId FROM document_chunks)
  `);
  if (docsNoChunks > 0) issues.push({ kind: "docs_without_chunks", count: docsNoChunks, detail: "有内容但未索引的文档" });

  // 2. chunks 无 FTS
  const chunksNoFts = count(`
    SELECT COUNT(*) c FROM document_chunks WHERE id NOT IN (SELECT rowid FROM chunks_fts)
  `);
  if (chunksNoFts > 0) issues.push({ kind: "chunks_without_fts", count: chunksNoFts, detail: "缺 BM25 索引" });

  // 3. chunks 无向量
  const chunksNoVec = count(`
    SELECT COUNT(*) c FROM document_chunks dc
    WHERE NOT EXISTS (
      SELECT 1 FROM vec_chunk_meta vm WHERE vm.documentId = CAST(dc.documentId AS TEXT) AND vm.chunkIndex = dc.chunkIndex
    )
  `);
  if (chunksNoVec > 0) issues.push({ kind: "chunks_without_vector", count: chunksNoVec, detail: "缺语义向量" });

  // 4. FTS 孤儿
  const ftsOrphans = count(`
    SELECT COUNT(*) c FROM chunks_fts WHERE rowid NOT IN (SELECT id FROM document_chunks)
  `);
  if (ftsOrphans > 0) issues.push({ kind: "fts_orphans", count: ftsOrphans, detail: "FTS 指向已删 chunk" });

  // 5. 向量孤儿
  const vecOrphans = count(`
    SELECT COUNT(*) c FROM vec_chunk_meta WHERE CAST(documentId AS INTEGER) NOT IN (SELECT id FROM kb_documents)
  `);
  if (vecOrphans > 0) issues.push({ kind: "vector_orphans", count: vecOrphans, detail: "向量指向已删文档" });

  // 6. 图谱节点孤儿
  const graphOrphans = count(`
    SELECT COUNT(*) c FROM knowledge_nodes
    WHERE type = 'document'
      AND CAST(json_extract(metadata, '$.documentId') AS INTEGER) NOT IN (SELECT id FROM kb_documents)
  `);
  if (graphOrphans > 0) issues.push({ kind: "graph_orphans", count: graphOrphans, detail: "图谱节点指向已删文档" });

  // 7. 模型版本漂移：向量 metadata 里的 embeddingModel 与当前激活模型不一致
  const modelDist = db.prepare(`
    SELECT json_extract(metadataJson, '$.embeddingModel') AS model, COUNT(*) AS c
    FROM vec_chunk_meta
    WHERE json_extract(metadataJson, '$.embeddingModel') IS NOT NULL
    GROUP BY 1 ORDER BY c DESC
  `).all() as Array<{ model: string; c: number }>;
  if (modelDist.length > 1) {
    issues.push({
      kind: "mixed_embedding_models",
      count: modelDist.length,
      detail: `向量由多个模型生成（语义搜索会混合不可比分数）: ${modelDist.map((m) => `${m.model}×${m.c}`).join(", ")}`,
    });
  }
  const noModelTag = count(`
    SELECT COUNT(*) c FROM vec_chunk_meta
    WHERE json_extract(metadataJson, '$.embeddingModel') IS NULL
  `);
  if (noModelTag > 0 && vectorRows > 0) {
    issues.push({ kind: "vectors_without_model_tag", count: noModelTag, detail: "旧向量未记录模型身份（下次重建后会补齐）" });
  }

  return {
    checkedAt: new Date().toISOString(),
    documents,
    chunks,
    ftsRows,
    vectorRows,
    graphDocNodes,
    issues,
    healthy: issues.length === 0,
  };
}

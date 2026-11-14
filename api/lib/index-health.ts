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
 *   7. 嵌入模型身份（mixed / 无标签）
 *   8. 嵌入降级文档（向量腿没建成，评审 S4）
 *   9.  chunks 无字符位置（T3-04：溯源回填后不许再出现 NULL）
 *  10. 边证据悬空（T3-04：evidenceChunkId 指向不存在的 chunk——比缺证据更严重）
 *  11. 新边缺证据（T3-04：cutoff 后创建的溯源类边必须有 evidence；
 *      cutoff 未设 = edge-writer 未上线，判据不响；存量边不追溯 = 登记册 R7）
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

  // 8. 嵌入降级文档（2026-11-11 评审 S4：降级标记必须有真消费者）
  // embeddingDegraded=true = 该文档最近一次索引时嵌入服务不可用、向量腿没建成。
  // 这些文档**检索不到语义结果**，却不会出现在上面任何一项判据里（它们的 chunks/FTS 都在），
  // 于是就成了巡检盲区。接进来，降级文档就会每天被点名，直到重建索引把标记清掉。
  const degradedDocs = count(`
    SELECT COUNT(*) c FROM kb_documents
    WHERE deletedAt IS NULL
      AND CAST(json_extract(metadata, '$.embeddingDegraded') AS INTEGER) = 1
  `);
  if (degradedDocs > 0) {
    issues.push({
      kind: "docs_embedding_degraded",
      count: degradedDocs,
      detail: "嵌入服务不可用导致向量腿缺失的文档（需重建索引才能恢复语义检索）",
    });
  }

  // 9. chunks 无字符位置（T3-04）。二期回填后，任何「未删文档 + charStart IS NULL」的块
  //    都意味着新入库代码没把溯源写进去（或被旁路改动），必须点名——引用定位的根基在这列上。
  const chunksNoPosition = count(`
    SELECT COUNT(*) c FROM document_chunks dc
    JOIN kb_documents d ON d.id = dc.documentId
    WHERE d.deletedAt IS NULL AND dc.charStart IS NULL
  `);
  if (chunksNoPosition > 0) {
    issues.push({
      kind: "chunks_without_position",
      count: chunksNoPosition,
      detail: "chunk 缺 charStart（引用溯源定位失效；跑 scripts/backfill-chunk-provenance 修复）",
    });
  }

  // 10/11. 边证据两条（T3-04）。表缺失（极老库/测试残库）视作「证据链未启用」跳过，不误报。
  try {
    // 10. 证据悬空：evidenceChunkId 指着一个不存在的 chunk 行——证据比没有更糟，因为它在撒谎。
    //     chunkRowId 是 document_chunks.id 主键，无类型坑（TEXT=INTEGER 陷阱只属于 vec_chunk_meta）。
    const danglingEvidence = count(`
      SELECT COUNT(*) c FROM knowledge_edges e
      WHERE e.evidenceChunkId IS NOT NULL
        AND e.evidenceChunkId NOT IN (SELECT id FROM document_chunks)
    `);
    if (danglingEvidence > 0) {
      issues.push({
        kind: "dangling_edge_evidence",
        count: danglingEvidence,
        detail: "边的 evidenceChunkId 指向已不存在的 chunk（证据失效，需重挂或清列）",
      });
    }

    // 11. 新边缺证据：只对 edge-writer 上线**之后**创建的边要求 evidence（cutoff 存在
    //     system_settings.edge_evidence_cutoff_ms）。存量 6000+ 边不追溯——R7 明载，
    //     否则这条判据永亮，告警文件变噪音（等于没有告警）。
    const cutoffRow = db
      .prepare("SELECT value FROM system_settings WHERE key = 'edge_evidence_cutoff_ms'")
      .get() as { value: string | null } | undefined;
    const cutoff = cutoffRow?.value ? Number(cutoffRow.value) : NaN;
    if (Number.isFinite(cutoff)) {
      const edgesNoEvidence = count(`
        SELECT COUNT(*) c FROM knowledge_edges e
        WHERE e.createdAt > ${cutoff}
          AND e.evidence IS NULL
          AND e.type IN ('references', 'contains', 'extends', 'sequence')
      `);
      if (edgesNoEvidence > 0) {
        issues.push({
          kind: "edges_without_evidence",
          count: edgesNoEvidence,
          detail: "edge-writer 上线后新建的溯源类边缺 evidence（旁路写入没走统一出口，须修写入点）",
        });
      }
    }
  } catch (err) {
    console.warn("[IndexHealth] 边证据判据跳过（knowledge_edges/system_settings 表缺失？）:", err);
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

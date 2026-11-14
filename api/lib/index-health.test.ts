/**
 * 索引一致性巡检的「嵌入降级」判据（评审 S4 / 缺陷 ⑥）。
 *
 * 为什么必须有一条判据：`embeddingDegraded:true` 的文档，chunks / FTS / 图谱全都在，
 * 只是**向量腿没建成** —— 于是它不会触发原有 6 项判据里的任何一项，成为巡检盲区：
 * 用户搜不到语义结果，系统却报 healthy:true。降级标记既然写进了库，就必须有真消费者，
 * 否则它只是「写了个标记自己看」。
 *
 * 本文件用内存 SQLite（真实 SQL 语义：json_extract / deletedAt / CAST）驱动 checkIndexHealth，
 * 断言的是**巡检报告的真实结论**，不是某个函数被调用过。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { checkIndexHealth } from "./index-health";
import { _setDbForTests, _resetDbForTests } from "../queries/connection";

vi.hoisted(() => {
  // env.ts 对必填变量做存在性校验，缺了就 process.exit(1)（本仓既有测试都在 hoisted 里补）
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "correct-password";
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.JWT_SECRET = "fixed-test-jwt-secret-with-32-chars";
});

interface DocFixture {
  readonly id: number;
  /** kb_documents.metadata 的 JSON 内容（null = 无 metadata） */
  readonly metadata: Record<string, unknown> | null;
  /** 软删除时间戳（非 null = 已删，巡检只统计未删文档） */
  readonly deletedAt?: number | null;
}

/**
 * 造一份「除降级标记外，六项判据全绿」的库：
 * 每篇文档都有 1 个 chunk + 对应 FTS 行 + 对应向量 + 对应图谱节点，
 * 向量都记了同一个 embeddingModel（避免 mixed_embedding_models 噪音）。
 */
function createHealthDb(docs: readonly DocFixture[]): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE kb_documents (id INTEGER PRIMARY KEY, content TEXT, metadata TEXT, deletedAt INTEGER);
    CREATE TABLE document_chunks (id INTEGER PRIMARY KEY, documentId INTEGER, chunkIndex INTEGER, content TEXT,
      charStart INTEGER,
      charEnd INTEGER,
      pageStart INTEGER,
      pageEnd INTEGER,
      sectionPath TEXT,
      contentHash TEXT
    );
    CREATE TABLE chunks_fts (rowid INTEGER PRIMARY KEY, content TEXT);
    CREATE TABLE vec_chunk_meta (rowid INTEGER PRIMARY KEY, id TEXT, documentId TEXT, chunkIndex INTEGER, metadataJson TEXT);
    CREATE TABLE knowledge_nodes (id INTEGER PRIMARY KEY, type TEXT, metadata TEXT);
    CREATE TABLE knowledge_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT, sourceId INTEGER, targetId INTEGER,
      label TEXT, type TEXT NOT NULL DEFAULT 'related', weight REAL, createdBy INTEGER,
      createdAt INTEGER NOT NULL DEFAULT 0,
      evidence TEXT, evidenceDocumentId INTEGER, evidenceChunkId INTEGER
    );
    CREATE TABLE system_settings (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, value TEXT, category TEXT, updatedBy INTEGER, updatedAt INTEGER NOT NULL DEFAULT 0);
  `);
  for (const doc of docs) {
    sqlite
      .prepare("INSERT INTO kb_documents (id, content, metadata, deletedAt) VALUES (?, ?, ?, ?)")
      .run(doc.id, "正文内容", doc.metadata === null ? null : JSON.stringify(doc.metadata), doc.deletedAt ?? null);
    const chunkId = doc.id * 10;
    sqlite
      .prepare("INSERT INTO document_chunks (id, documentId, chunkIndex, content, charStart, charEnd) VALUES (?, ?, 0, ?, 0, 4)")
      .run(chunkId, doc.id, "正文内容");
    sqlite.prepare("INSERT INTO chunks_fts (rowid, content) VALUES (?, ?)").run(chunkId, "正文内容");
    sqlite
      .prepare("INSERT INTO vec_chunk_meta (id, documentId, chunkIndex, metadataJson) VALUES (?, ?, 0, ?)")
      .run(`chunk-${doc.id}-0`, String(doc.id), JSON.stringify({ embeddingModel: "qwen3.7-text-embedding-flash" }));
    sqlite
      .prepare("INSERT INTO knowledge_nodes (type, metadata) VALUES ('document', ?)")
      .run(JSON.stringify({ documentId: String(doc.id) }));
  }
  return sqlite;
}

function issueOf(report: ReturnType<typeof checkIndexHealth>, kind: string) {
  return report.issues.find((issue) => issue.kind === kind);
}

describe("checkIndexHealth · 嵌入降级文档（docs_embedding_degraded）", () => {
  let sqlite: Database.Database | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetDbForTests();
    sqlite?.close();
    sqlite = null;
  });

  it("基线：全部正常时巡检干净，且**不**出现 docs_embedding_degraded", () => {
    sqlite = createHealthDb([
      { id: 1, metadata: { vectorized: true, embeddingDegraded: false } },
      { id: 2, metadata: { vectorized: true } }, // 从未降级过 = 无 key
    ]);
    _setDbForTests(sqlite);

    const report = checkIndexHealth();

    expect(report.issues).toEqual([]);
    expect(report.healthy).toBe(true);
    expect(issueOf(report, "docs_embedding_degraded")).toBeUndefined();
  });

  it("识别 embeddingDegraded=true 的文档：issue 出现且 count 正确", () => {
    sqlite = createHealthDb([
      { id: 1, metadata: { vectorized: false, embeddingDegraded: true } },
      { id: 2, metadata: { vectorized: true, embeddingDegraded: false } },
    ]);
    _setDbForTests(sqlite);

    const report = checkIndexHealth();

    const issue = issueOf(report, "docs_embedding_degraded");
    expect(issue).toBeDefined();
    expect(issue!.count).toBe(1);
    // detail 必须能让人知道「该怎么办」：这不是删数据的问题，是要重建索引
    expect(issue!.detail).toContain("重建索引");
    expect(report.healthy).toBe(false);
    // 其它判据仍全绿 —— 降级文档确实只会被这一条点名（这正是它此前是盲区的原因）
    expect(report.issues.map((i) => i.kind)).toEqual(["docs_embedding_degraded"]);
  });

  it("多篇降级 + 一篇软删降级：只数未删的（count 正确，软删的不算）", () => {
    sqlite = createHealthDb([
      { id: 1, metadata: { embeddingDegraded: true } },
      { id: 2, metadata: { embeddingDegraded: true } },
      { id: 3, metadata: { vectorized: true, embeddingDegraded: false } },
      { id: 4, metadata: { embeddingDegraded: true }, deletedAt: 1_760_000_000_000 }, // 软删
    ]);
    _setDbForTests(sqlite);

    const report = checkIndexHealth();

    const issue = issueOf(report, "docs_embedding_degraded");
    expect(issue).toBeDefined();
    expect(issue!.count).toBe(2); // 4 号已软删，不该再把用户的收件箱刷红
    expect(report.documents).toBe(3);
  });

  it("降级标记被重建索引清成 false 之后，issue 立刻消失（标记有生命周期）", () => {
    sqlite = createHealthDb([{ id: 1, metadata: { vectorized: false, embeddingDegraded: true } }]);
    _setDbForTests(sqlite);
    expect(issueOf(checkIndexHealth(), "docs_embedding_degraded")?.count).toBe(1);

    // 重建索引成功后 indexer 会写 {vectorized:true, embeddingDegraded:false}
    sqlite
      .prepare("UPDATE kb_documents SET metadata = ? WHERE id = 1")
      .run(JSON.stringify({ vectorized: true, embeddingDegraded: false }));

    const after = checkIndexHealth();
    expect(issueOf(after, "docs_embedding_degraded")).toBeUndefined();
    expect(after.healthy).toBe(true);
  });
});

describe("checkIndexHealth · T3-04 溯源与证据判据（回填后不许倒退，证据不许撒谎）", () => {
  let sqlite: Database.Database | null = null;

  afterEach(() => {
    _resetDbForTests();
    sqlite?.close();
    sqlite = null;
  });

  it("chunks_without_position：未删文档的块 charStart=NULL 被点名；全填位置则不出现", () => {
    sqlite = createHealthDb([{ id: 1, metadata: { vectorized: true } }]);
    sqlite.prepare("UPDATE document_chunks SET charStart = NULL, charEnd = NULL WHERE documentId = 1").run();
    _setDbForTests(sqlite);
    const issue = issueOf(checkIndexHealth(), "chunks_without_position");
    expect(issue?.count).toBe(1);

    // 回填修复后即消失（标记有生命周期，不是永久噪音）
    sqlite.prepare("UPDATE document_chunks SET charStart = 0, charEnd = 4 WHERE documentId = 1").run();
    const after = checkIndexHealth();
    expect(issueOf(after, "chunks_without_position")).toBeUndefined();
    expect(after.healthy).toBe(true);
  });

  it("dangling_edge_evidence：evidenceChunkId 指着已不存在的 chunk = 证据在撒谎，必点名", () => {
    sqlite = createHealthDb([{ id: 1, metadata: { vectorized: true } }]);
    sqlite.prepare("INSERT INTO knowledge_edges (sourceId, targetId, type, createdAt, evidence, evidenceChunkId) VALUES (1, 1, 'references', 0, '原文摘录', 99999)").run();
    _setDbForTests(sqlite);
    const issue = issueOf(checkIndexHealth(), "dangling_edge_evidence");
    expect(issue?.count).toBe(1);

    // 改指向真实存在的 chunk（createHealthDb 的 doc1 chunkId = 10）→ 消失
    sqlite.prepare("UPDATE knowledge_edges SET evidenceChunkId = 10 WHERE evidenceChunkId = 99999").run();
    expect(issueOf(checkIndexHealth(), "dangling_edge_evidence")).toBeUndefined();
  });

  it("edges_without_evidence：只查 cutoff 之后的溯源类新边；存量旧边与 similar 不追溯（R7）", () => {
    sqlite = createHealthDb([{ id: 1, metadata: { vectorized: true } }]);
    // 存量 references 边（cutoff 前）无证据 → 不该被点名
    sqlite.prepare("INSERT INTO knowledge_edges (sourceId, targetId, type, createdAt, evidence) VALUES (1, 1, 'references', 1000, NULL)").run();
    // similar 边即使新也不要求证据（它是相似度推荐，不是溯源断言）
    sqlite.prepare("INSERT INTO knowledge_edges (sourceId, targetId, type, createdAt, evidence) VALUES (1, 1, 'similar', 9000, NULL)").run();
    _setDbForTests(sqlite);

    // cutoff 未设（edge-writer 还没上线）→ 判据整体不响
    expect(issueOf(checkIndexHealth(), "edges_without_evidence")).toBeUndefined();

    // 设 cutoff=5000 → cutoff 后的 references 无证据边被点名，similar 豁免
    sqlite.prepare("INSERT INTO system_settings (key, value) VALUES ('edge_evidence_cutoff_ms', '5000')").run();
    sqlite.prepare("INSERT INTO knowledge_edges (sourceId, targetId, type, createdAt, evidence) VALUES (1, 1, 'extends', 6000, NULL)").run();
    const issue = issueOf(checkIndexHealth(), "edges_without_evidence");
    expect(issue?.count).toBe(1); // 只有 extends@6000：references@1000 在 cutoff 前，similar@9000 豁免

    // edge-writer 补上证据 → 消失
    sqlite.prepare("UPDATE knowledge_edges SET evidence = '摘录' WHERE createdAt = 6000").run();
    expect(issueOf(checkIndexHealth(), "edges_without_evidence")).toBeUndefined();
  });

  it("表缺失的老库：证据判据降级跳过（console.warn），位置判据照常工作，不炸整个巡检", () => {
    const lite = new Database(":memory:");
    lite.exec(`
      CREATE TABLE kb_documents (id INTEGER PRIMARY KEY, content TEXT, metadata TEXT, deletedAt INTEGER);
      CREATE TABLE document_chunks (id INTEGER PRIMARY KEY, documentId INTEGER, chunkIndex INTEGER, content TEXT, charStart INTEGER, charEnd INTEGER, pageStart INTEGER, pageEnd INTEGER, sectionPath TEXT, contentHash TEXT);
      CREATE TABLE chunks_fts (rowid INTEGER PRIMARY KEY, content TEXT);
      CREATE TABLE vec_chunk_meta (rowid INTEGER PRIMARY KEY, id TEXT, documentId TEXT, chunkIndex INTEGER, metadataJson TEXT);
      CREATE TABLE knowledge_nodes (id INTEGER PRIMARY KEY, type TEXT, metadata TEXT);
      INSERT INTO kb_documents VALUES (1, '正文内容', '{"vectorized":true}', NULL);
      INSERT INTO document_chunks (id, documentId, chunkIndex, content, charStart, charEnd) VALUES (10, 1, 0, '正文内容', 0, 4);
      INSERT INTO chunks_fts (rowid, content) VALUES (10, '正文内容');
      INSERT INTO vec_chunk_meta (id, documentId, chunkIndex, metadataJson) VALUES ('chunk-1-0', '1', 0, '{"embeddingModel":"m"}');
      INSERT INTO knowledge_nodes (type, metadata) VALUES ('document', '{"documentId":"1"}');
    `);
    _setDbForTests(lite);
    const report = checkIndexHealth();
    expect(report.healthy).toBe(true); // 没表 = 证据链未启用，不该拦「全绿」
    lite.close();
  });
});

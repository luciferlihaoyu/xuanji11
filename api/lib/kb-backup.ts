import { z } from "zod";
import { getDb } from "../queries/connection";
import { knowledgeNodes, knowledgeEdges, kbDocuments } from "@db/schema";
import type { KnowledgeNode, KnowledgeEdge, KbDocument } from "@db/schema";

const BACKUP_VERSION = "1.0";

const nodeTypeSchema = z.enum(["concept", "document", "topic", "entity", "note", "tag"]);
const edgeTypeSchema = z.enum(["related", "contains", "references", "extends", "similar", "sequence"]);
const documentFormatSchema = z.enum(["markdown", "text", "json", "html", "code"]);

const dateOrStringSchema = z.union([z.string().datetime({ offset: true }), z.date()]);

// ⚠️ 备份 schema 必须**忠实反映真实列的可空性**（2026-11-12 碧霄，真库集成测试抓出）：
// 可空列 = `.nullable().optional()`。只写 `.optional()` 不够 —— optional 只允许"键不存在"，
// 而真实导出里这些列是**显式 null**（drizzle JSON/可空列导出即 null）→ zod 拒收 → 恢复 100% 失败。
// 旧 mock 测试永远发现不了：假数据里这些键干脆不存在。
export const knowledgeNodeSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1).max(500),
  content: z.string().max(50_000).nullable().optional(),
  type: nodeTypeSchema,
  posX: z.number().nullable().optional(),
  posY: z.number().nullable().optional(),
  style: z.record(z.string(), z.unknown()).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  createdBy: z.number().int().positive().nullable().optional(),
  createdAt: dateOrStringSchema,
  updatedAt: dateOrStringSchema,
});

export const knowledgeEdgeSchema = z.object({
  id: z.number().int().positive(),
  sourceId: z.number().int().positive(),
  targetId: z.number().int().positive(),
  label: z.string().max(255).nullable().optional(),
  type: edgeTypeSchema,
  weight: z.number().nullable().optional(),
  createdBy: z.number().int().positive().nullable().optional(),
  createdAt: dateOrStringSchema,
  // 二期证据链列（T2-02）：灾备 schema 与 db/schema.ts 同步声明，否则导出/导入静默丢证据（审查 D4）
  evidence: z.string().nullable().optional(),
  evidenceDocumentId: z.number().int().positive().nullable().optional(),
  evidenceChunkId: z.number().int().positive().nullable().optional(),
});

export const kbDocumentSchema = z.object({
  id: z.number().int().positive(),
  folderId: z.number().int().positive().nullable().optional(),
  title: z.string().min(1).max(500),
  content: z.string().max(100_000).nullable().optional(),
  format: documentFormatSchema,
  tags: z.array(z.string().max(100)).max(100).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  createdBy: z.number().int().positive().nullable().optional(),
  createdAt: dateOrStringSchema,
  updatedAt: dateOrStringSchema,
  // 软删三列必须进备份 schema（2026-11-12 碧霄修）：
  // zod 对未声明键**默认剥离**，缺这三列 → 恢复时 deletedAt 落 NULL →
  // 已归档文档复活、合并关系(mergedIntoId)丢失。全部 optional → 旧备份（无这三列）仍可导入。
  deletedAt: dateOrStringSchema.nullable().optional(),
  deletedReason: z.string().max(64).nullable().optional(),
  mergedIntoId: z.number().int().positive().nullable().optional(),
});

/**
 * 备份 payload 的形状契约。
 *
 * 上限 50_000 的依据（2026-11-12 真库实测）：
 *   knowledge_nodes 3,107 / knowledge_edges **11,431** / kb_documents 5,964。
 * 旧上限 10_000 → **自己导出的备份自己导不回去**（生产 knowledge_edges 已超），
 * 灾备恢复在真实数据上 100% 失败（ZodError too_big）。50_000 留约 4 倍余量。
 */
export const kbBackupSchema = z.object({
  version: z.string().max(10),
  exportedAt: z.string().max(50).optional(),
  data: z.object({
    nodes: z.array(knowledgeNodeSchema).max(50_000),
    edges: z.array(knowledgeEdgeSchema).max(50_000),
    documents: z.array(kbDocumentSchema).max(50_000),
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
  /**
   * 本次**实际写入**、因而需要重建索引的文档数（2026-11-12 碧霄加）。
   *
   * 恢复只还原 nodes/edges/documents —— **不含 chunks / 向量 / FTS**，
   * 所以新写进来的文档在库里、但一条都搜不到，必须重建索引才可检索。
   * 这里**不自动触发**全量回填：那会对整库发起重建、打满 embedding API、耗时以小时计，
   * 是"恢复"动作里最不该偷偷发生的事。改为显式回报 + 提示运维手动跑 kb.reindex_all。
   *
   * 口径：取**实际写入数**（= documents/changes），不是备份里的文档数 ——
   * 重复导入同一份备份时实际写入 0 篇，就该报 0；报备份总数会让调用方
   * 误以为有 N 篇待重建（那 N 篇早已存在、也早已有索引）。
   */
  readonly documentsNeedingReindex: number;
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
  const payload = {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    data: { nodes, edges, documents },
  };
  // 自校验：**导出成功 ⇒ 一定能导回去**（2026-11-12）。
  // 以前导出端不校验、只有导入端校验，于是"导得出、导不回"能悄悄成立
  // （实测两例：① 可空列导出成 null 被 zod 拒收；② edges 超上限被拒收）——
  // 备份文件躺在那儿看着是好的，真要用时才发现恢复不了。
  // 现在导出即校验：不合契约就地失败（显式失败 > 产出一个残缺的备份）。
  kbBackupSchema.parse(payload);
  return payload;
}

/**
 * 单条 INSERT 的绑定变量上限：SQLite 老版本 999、新版 32766，取小的最稳。
 * 一次插 11,431 条边 × 8 列 = **91,448 个变量** → 直接 `SqliteError: too many SQL variables`
 * （2026-11-12 生产实测：导出成功、导回报 Internal tool error）。
 * 所以分批插入：50 行 × 13 列 = 650 个变量，两个上限下都安全。
 */
const INSERT_BATCH_SIZE = 50;

/**
 * 分批插入并累计实际写入行数（onConflictDoNothing → 主键冲突的行不算写入）。
 * 批量大小固定，不做"越大越快"的优化：灾备路径一年跑不了几次，可读性/稳定性优先。
 */
async function insertInBatches<TTable extends Parameters<ReturnType<typeof getDb>["insert"]>[0]>(
  db: ReturnType<typeof getDb>,
  table: TTable,
  rows: unknown[],
): Promise<number> {
  let changes = 0;
  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + INSERT_BATCH_SIZE);
    const result = await (db.insert(table) as { values: (r: unknown[]) => { onConflictDoNothing: () => Promise<{ changes?: number }> } })
      .values(batch)
      .onConflictDoNothing();
    changes += Number(result.changes ?? 0);
  }
  return changes;
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
    // deletedAt 是 timestamp_ms 列 → 必须给 Date（给字符串会写错类型）
    deletedAt: doc.deletedAt ? toDate(doc.deletedAt) : null,
  }));

  // 分批插入（SQLite 绑定变量上限，见 INSERT_BATCH_SIZE 注释）
  const nodes = await insertInBatches(db, knowledgeNodes, nodeValues);
  const edges = await insertInBatches(db, knowledgeEdges, edgeValues);
  const documents = await insertInBatches(db, kbDocuments, documentValues);

  return {
    nodes,
    edges,
    documents,
    // 恢复不带索引 → 本次导入的文档都还不可检索，明说，不让调用方误以为"恢复完就能用"
    documentsNeedingReindex: documents,
  };
}

/**
 * 入库幂等：source + externalId + contentHash → 唯一 idempotencyKey。
 *
 * 重复上传/记忆同步重跑/工作流重触发时，返回既有 documentId 而非新建文档。
 * 根治「每次同步新建文档」类重复（场景膨胀组 x14 的同类问题）。
 */
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { kbDocuments, kbDocumentVersions, kbIngestionKeys } from "@db/schema";

export function makeIdempotencyKey(source: string, externalId: string | null, contentHash: string): string {
  return createHash("sha256")
    .update(`${source}|${externalId ?? ""}|${contentHash}`, "utf8")
    .digest("hex");
}

export interface IngestionKeyResult {
  /** true = 已存在（幂等命中），documentId 为既有文档；false = 新登记 */
  existing: boolean;
  documentId: number;
}

/**
 * 检查幂等键；不存在则登记。
 * 调用方负责在 existing=true 时跳过创建逻辑。
 */
export async function checkIngestionKey(
  source: string,
  externalId: string | null,
  contentHash: string,
  documentIdIfNew: number,
): Promise<IngestionKeyResult> {
  const db = getDb();
  const key = makeIdempotencyKey(source, externalId, contentHash);
  const [existing] = await db
    .select({ documentId: kbIngestionKeys.documentId })
    .from(kbIngestionKeys)
    .where(eq(kbIngestionKeys.idempotencyKey, key))
    .limit(1);
  if (existing) return { existing: true, documentId: existing.documentId };

  await db.insert(kbIngestionKeys).values({
    idempotencyKey: key,
    documentId: documentIdIfNew,
    source,
    externalId,
    contentHash,
  });
  return { existing: false, documentId: documentIdIfNew };
}

/**
 * 按内容查是否已有未删除文档（质量门「重复程度」维度）。
 *
 * T3-01 新口径：**不再查 kb_ingestion_keys**——该表生产 0 行、checkIngestionKey 零调用者
 * （死路径），旧实现下「重复程度」恒 null。改为两查：
 * ① kb_document_versions.contentHash（走 kb_doc_versions_hash_idx；被更新过的文档必有快照）；
 * ② kb_documents.content 直查（新建文档没有版本行，只能等值扫；约 6k 行、每次入库一次，可接受）。
 * content 参数可选：不传则仅走 hash（兼容旧调用形态）。
 */
export async function findDocumentByContentHash(contentHash: string, content?: string): Promise<number | null> {
  const db = getDb();
  // ① 版本 hash 路：表缺失/查询失败不应废掉②路（测试库常见无版本表）
  try {
    const [versionHit] = await db
      .select({ documentId: kbDocumentVersions.documentId })
      .from(kbDocumentVersions)
      .innerJoin(kbDocuments, eq(kbDocuments.id, kbDocumentVersions.documentId))
      .where(and(eq(kbDocumentVersions.contentHash, contentHash), isNull(kbDocuments.deletedAt)))
      .limit(1);
    if (versionHit) return versionHit.documentId;
  } catch { /* 继续走正文直查 */ }

  // ② 正文直查路
  if (content !== undefined && content.length > 0) {
    const [contentHit] = await db
      .select({ id: kbDocuments.id })
      .from(kbDocuments)
      .where(and(isNull(kbDocuments.deletedAt), eq(kbDocuments.content, content)))
      .limit(1);
    return contentHit?.id ?? null;
  }
  return null;
}

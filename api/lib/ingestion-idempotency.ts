/**
 * 入库幂等：source + externalId + contentHash → 唯一 idempotencyKey。
 *
 * 重复上传/记忆同步重跑/工作流重触发时，返回既有 documentId 而非新建文档。
 * 根治「每次同步新建文档」类重复（场景膨胀组 x14 的同类问题）。
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { kbIngestionKeys } from "@db/schema";

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

/** 按内容 hash 查是否已有文档（去重候选探测） */
export async function findDocumentByContentHash(contentHash: string): Promise<number | null> {
  const db = getDb();
  const [row] = await db
    .select({ documentId: kbIngestionKeys.documentId })
    .from(kbIngestionKeys)
    .where(eq(kbIngestionKeys.contentHash, contentHash))
    .limit(1);
  return row?.documentId ?? null;
}

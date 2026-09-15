/**
 * 文档版本快照：updateDocument 前把当前版本存入 kb_document_versions。
 *
 * 设计：
 * - 快照旧版本（不是新版本），恢复时把快照内容写回主表再快照一次
 * - contentHash 用于幂等：相同内容的连续更新不产生重复版本
 * - 快照失败不阻塞更新（版本是安全网不是主流程）
 */
import { createHash } from "node:crypto";
import { eq, desc } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { kbDocuments, kbDocumentVersions } from "@db/schema";

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * 在文档变更前快照当前版本。
 * @param documentId 文档 id
 * @param source 来源标记（manual/workflow/api/...）
 * @param changeReason 变更原因
 * @returns 快照的版本号；内容未变化返回 null（跳过快照）
 */
export async function snapshotDocumentVersion(
  documentId: number,
  source: string,
  changeReason: string,
  changedBy: number | null = null,
): Promise<number | null> {
  const db = getDb();
  const [doc] = await db.select().from(kbDocuments).where(eq(kbDocuments.id, documentId));
  if (!doc) return null;

  const currentHash = hashContent(doc.content ?? "");
  // 与最近一个版本 hash 相同 → 内容没变，不重复快照
  const [latest] = await db
    .select({ versionNumber: kbDocumentVersions.versionNumber, contentHash: kbDocumentVersions.contentHash })
    .from(kbDocumentVersions)
    .where(eq(kbDocumentVersions.documentId, documentId))
    .orderBy(desc(kbDocumentVersions.versionNumber))
    .limit(1);
  if (latest && latest.contentHash === currentHash) return null;

  const nextVersion = (latest?.versionNumber ?? 0) + 1;
  await db.insert(kbDocumentVersions).values({
    documentId,
    versionNumber: nextVersion,
    title: doc.title,
    content: doc.content,
    format: doc.format,
    tags: doc.tags,
    contentHash: currentHash,
    source,
    changedBy,
    changeReason,
  });
  return nextVersion;
}

/**
 * 引用定位锚点（Citation 2.0 的定位层）。
 *
 * 目标：让每条引用能回答「出自哪一块、哪一行、块内哪个片段」——
 * 而不是只给一个文档标题。
 *
 * 语义约定（诚实优先）：
 * - chunkIndex：块级证据命中的分块序号；无块级证据时为 null（不猜）
 * - charStart/charEnd：查询词在该块正文内的字符区间；语义命中（块内无字面查询词）
 *   时留空，不伪造位置
 * - heading：该位置之前最近的 markdown 标题（便于人读时定位章节）
 */

export interface CitationAnchor {
  readonly chunkIndex: number | null;
  readonly heading?: string;
  readonly charStart?: number;
  readonly charEnd?: number;
  // ===== T2-04：库级溯源（ask-rag 组装时从 document_chunks 行读取；buildAnchor 不产这些字段） =====
  /** 块所在章节路径（document_chunks.sectionPath；无标题文档缺省） */
  readonly sectionPath?: string;
  /** 块在 normalized 全文中的 [charStart, charEnd) 码元区间（与上方块内 query 命中区间语义不同） */
  readonly charRange?: readonly [number, number];
  /** document_chunks.id 主键（行级深链/回表定位；区别于 chunkIndex 序号） */
  readonly chunkRowId?: number;
}

// T2-03：heading 解析迁至 section-path.ts（单一实现），此处 re-export 保持既有引用方不变
import { findHeadingBefore } from "./section-path";
export { findHeadingBefore };

/** 构造定位锚点：块序号 + （能定位时）块内字符区间与所属标题 */
export function buildAnchor(chunkText: string, query: string, chunkIndex: number | null): CitationAnchor {
  const anchor: { chunkIndex: number | null; heading?: string; charStart?: number; charEnd?: number } = { chunkIndex };
  const q = query.trim();
  if (!q) return anchor;
  const idx = chunkText.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return anchor;
  anchor.charStart = idx;
  anchor.charEnd = idx + q.length;
  const heading = findHeadingBefore(chunkText, idx);
  if (heading) anchor.heading = heading;
  return anchor;
}

export interface LatestVersion {
  /** 版本行 id（供精确溯源/深链） */
  readonly id: number;
  /** 人类可读版本号（UI 显示 v{versionNumber}，注意它通常 ≠ 行 id） */
  readonly versionNumber: number;
}

/**
 * 批量解析每个文档的最新版本（取 versionNumber 最大者；同号取行 id 大者）。
 * 失败时返回空 Map（不阻塞问答），版本信息缺失即 null。
 */
export async function resolveLatestVersions(documentIds: readonly number[]): Promise<Map<number, LatestVersion>> {
  const latest = new Map<number, LatestVersion>();
  const ids = [...new Set(documentIds.filter((n) => Number.isFinite(n)))];
  if (ids.length === 0) return new Map();
  try {
    const { getDb } = await import("../queries/connection");
    const { kbDocumentVersions } = await import("@db/schema");
    const { inArray } = await import("drizzle-orm");
    const rows = await getDb()
      .select({
        id: kbDocumentVersions.id,
        documentId: kbDocumentVersions.documentId,
        versionNumber: kbDocumentVersions.versionNumber,
      })
      .from(kbDocumentVersions)
      .where(inArray(kbDocumentVersions.documentId, ids));
    for (const row of rows) {
      if (typeof row.id !== "number" || typeof row.documentId !== "number" || typeof row.versionNumber !== "number") continue;
      const cur = latest.get(row.documentId);
      if (!cur || row.versionNumber > cur.versionNumber || (row.versionNumber === cur.versionNumber && row.id > cur.id)) {
        latest.set(row.documentId, { id: row.id, versionNumber: row.versionNumber });
      }
    }
  } catch {
    // DB 不可用：版本溯源缺失但不影响回答
  }
  return latest;
}

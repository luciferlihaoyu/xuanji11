/**
 * 命中块上下文：把「引用锚点」变成人能看到的东西。
 *
 * 场景：用户在问答里点引用 `[1]` → 跳到文档并定位到第 N 块。
 * 本模块负责取回该块内容、总块数、块内标题，以及块内查询词高亮区间。
 *
 * 约定：块序号不存在时返回 null（**不做近似匹配**，避免把用户带到错误位置）。
 */

export interface ChunkContext {
  readonly documentId: number;
  readonly chunkIndex: number;
  readonly content: string;
  readonly totalChunks: number;
  readonly heading?: string;
}

/** 取块内首个 markdown 标题（不含 # 号） */
export function extractChunkHeading(content: string): string | undefined {
  for (const line of content.split("\n")) {
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

/** 查询词在块内的字符区间（大小写不敏感）；未命中或空查询返回 null */
export function highlightSpan(text: string, query: string): { start: number; end: number } | null {
  const q = query.trim();
  if (!q) return null;
  const start = text.toLowerCase().indexOf(q.toLowerCase());
  if (start < 0) return null;
  return { start, end: start + q.length };
}

/**
 * 取指定文档第 chunkIndex 块的内容。
 * 任何异常（DB 不可用、非法入参、块不存在）都返回 null，由调用方降级展示。
 */
export async function getChunkContext(documentId: number, chunkIndex: number): Promise<ChunkContext | null> {
  if (!Number.isFinite(documentId) || documentId <= 0) return null;
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) return null;
  try {
    const { getDb } = await import("../queries/connection");
    const { documentChunks } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const rows = await getDb()
      .select({ content: documentChunks.content, chunkIndex: documentChunks.chunkIndex })
      .from(documentChunks)
      .where(eq(documentChunks.documentId, documentId));
    const hit = rows.find((r) => r.chunkIndex === chunkIndex);
    if (!hit) return null;
    const heading = extractChunkHeading(hit.content);
    return {
      documentId,
      chunkIndex,
      content: hit.content,
      totalChunks: rows.length,
      ...(heading ? { heading } : {}),
    };
  } catch {
    return null;
  }
}

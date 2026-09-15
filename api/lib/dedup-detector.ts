/**
 * 去重候选探测：只建议、不删除。
 *
 * 两级：
 *  - exact：规范化标题完全相同（去空白/大小写/括号差异）
 *  - near：内容 sha256 相同但标题不同（同步重复典型形态）
 *
 * 扫描结果写入 kb_review_items（kind=dedup），由人工在收件箱决定
 * 保留哪篇、是否合并。自动删除永远不发生在这里。
 */
import { getRawDb } from "../queries/connection";
import { getDb } from "../queries/connection";
import { kbReviewItems } from "@db/schema";
import { hashContent } from "./doc-versioning";

export interface DuplicateGroup {
  hash: string;
  documentIds: number[];
  titles: string[];
}

function normalizeTitle(title: string): string {
  return title
    .replace(/\s+/g, " ")
    .replace(/[【】\[\]()（）]/g, "")
    .trim()
    .toLowerCase();
}

/** 扫描重复候选（不写入收件箱，只返回） */
export function findDuplicateCandidates(): DuplicateGroup[] {
  const raw = getRawDb();
  const docs = raw.prepare(`
    SELECT id, title, content FROM kb_documents
    WHERE deletedAt IS NULL AND content IS NOT NULL AND length(trim(content)) > 0
  `).all() as Array<{ id: number; title: string; content: string }>;

  const groups = new Map<string, DuplicateGroup>();

  // 标题规范化分组
  for (const doc of docs) {
    const key = `title:${normalizeTitle(doc.title)}`;
    const g = groups.get(key) ?? { hash: key, documentIds: [], titles: [] };
    g.documentIds.push(doc.id);
    g.titles.push(doc.title);
    groups.set(key, g);
  }

  // 内容 hash 分组（标题不同但内容相同的同步重复）
  for (const doc of docs) {
    const key = `content:${hashContent(doc.content)}`;
    const g = groups.get(key) ?? { hash: key, documentIds: [], titles: [] };
    if (!g.documentIds.includes(doc.id)) {
      g.documentIds.push(doc.id);
      g.titles.push(doc.title);
    }
    groups.set(key, g);
  }

  return [...groups.values()].filter((g) => g.documentIds.length > 1);
}

/**
 * 扫描并把候选写入收件箱（幂等：同组已有 pending 项则跳过）。
 * @returns 新建审核项数量
 */
export async function scanDuplicatesToInbox(): Promise<{ groups: number; created: number }> {
  const db = getDb();
  const raw = getRawDb();
  const candidates = findDuplicateCandidates();

  let created = 0;
  for (const group of candidates) {
    // 幂等：这组文档已有 pending dedup 项 → 跳过
    const existing = raw.prepare(`
      SELECT COUNT(*) c FROM kb_review_items
      WHERE kind = 'dedup' AND status = 'pending'
        AND documentId = ? AND relatedDocumentId = ?
    `).get(group.documentIds[0], group.documentIds[1]) as { c: number };
    if (existing.c > 0) continue;

    await db.insert(kbReviewItems).values({
      kind: "dedup",
      documentId: group.documentIds[0],
      relatedDocumentId: group.documentIds[1],
      title: `疑似重复（${group.documentIds.length} 篇）：${group.titles[0].slice(0, 40)}`,
      payload: {
        groupHash: group.hash,
        documentIds: group.documentIds,
        titles: group.titles,
        matchType: group.hash.startsWith("content:") ? "exact_content" : "same_title",
      },
      confidence: group.hash.startsWith("content:") ? 0.99 : 0.75,
    });
    created++;
  }

  return { groups: candidates.length, created };
}

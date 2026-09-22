/**
 * 「文档 ↔ 图谱节点」匹配判据的**唯一出处**。
 *
 * 为什么需要它：图谱节点的写入方**类型不统一**——
 *   · `api/lib/ingestion.ts`、`api/lib/workflow-runtime.ts`、`api/kb-router.ts` 写 `String(documentId)`（字符串）
 *   · `api/lib/keyword-auto-tag.ts`（autoTagDocument）写 `doc.id`（**数字**）
 * 而删除侧此前用**字符串等值比较**匹配：`json_extract(...) = String(id)`。
 * 结果：数字型节点永远匹配不上 → 每次删除都把它留下 → 产生 `graph_orphans`
 * （线上 2026-09-22 实测：目录 1855 的节点 metadata 正是 `{"documentId":1855}` 数字，删除后成孤儿；
 *   同一晚探针文档 #2220 复现：purge 返回 deletedNodes=0，删完立刻 graph_orphans=1）。
 *
 * 统一口径：`CAST(json_extract(metadata,'$.documentId') AS INTEGER) = <id>`，
 * 与巡检 `api/lib/index-health.ts` 的 `graph_orphans` 判据严格同源（两种类型都认）。
 */
import { sql, type SQL } from "drizzle-orm";
import { knowledgeNodes } from "@db/schema";

/** 生成「该图谱节点属于文档 id」的 SQL 条件（documentId 为字符串或数字都能命中） */
export function documentNodeMatch(id: number): SQL {
  return sql`CAST(json_extract(${knowledgeNodes.metadata}, '$.documentId') AS INTEGER) = ${id}`;
}

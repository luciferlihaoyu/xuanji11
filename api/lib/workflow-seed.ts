/**
 * 默认工作流种子：boot 时自动建 4 条开箱工作流（幂等按名查重）。
 *
 * 与 scripts/seed-workflows.mjs 同一套定义——.mjs 是手动 exec 版，
 * 本文件是 boot 自动版（service exec 不可用时兜住）。
 */
import { eq, and, isNull } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { workflows, workflowNodes, kbFolders } from "@db/schema";

/** 确保「工作流报告」根目录文件夹存在，返回 id（报告统一收这里，不落根目录） */
function ensureReportFolderId(): number {
  const db = getDb();
  const existing = db.select({ id: kbFolders.id }).from(kbFolders)
    .where(and(eq(kbFolders.name, "工作流报告"), isNull(kbFolders.parentId))).limit(1).all();
  if (existing.length > 0) return existing[0].id;
  const r = db.insert(kbFolders).values({ name: "工作流报告", parentId: null, sortOrder: 99 }).run();
  return Number(r.lastInsertRowid);
}

interface SeedNode {
  type: string;
  label: string;
  config: Record<string, unknown>;
  connections: Array<{ targetIndex: number }>;
}

interface SeedWorkflow {
  name: string;
  description: string;
  triggers: Array<Record<string, unknown>>;
  nodes: SeedNode[];
}

const DEFAULT_WORKFLOWS: SeedWorkflow[] = [
  {
    name: "每日自动建边",
    description: "每天凌晨用语义相似度连接知识孤岛，把新入库文档自动连进知识网络",
    triggers: [{ type: "cron", schedule: "0 3 * * *", enabled: true }],
    nodes: [
      { type: "auto-link", label: "自动建边", config: { threshold: 0.62, maxPerNode: 3, dryRun: false }, connections: [{ targetIndex: 1 }] },
      { type: "save-result", label: "存档建边报告", config: { targetFolderId: 0, title: "每日自动建边报告" }, connections: [] },
    ],
  },
  {
    name: "每周聚类报告",
    description: "每周一对全部文档做语义聚类，生成主题群报告，观察知识版图演变",
    triggers: [{ type: "cron", schedule: "0 4 * * 1", enabled: true }],
    nodes: [
      { type: "cluster", label: "语义聚类", config: { labelWithLlm: true }, connections: [{ targetIndex: 1 }] },
      { type: "save-result", label: "存档聚类报告", config: { targetFolderId: 0, title: "每周语义聚类报告" }, connections: [] },
    ],
  },
  {
    name: "新文档自动分拣",
    description: "新文档入库后自动 LLM 分拣：建议文件夹/标签/抽取概念实体并直接落库",
    triggers: [{ type: "document-created", enabled: true }],
    nodes: [
      { type: "ingest-triage", label: "入库分拣", config: {}, connections: [] },
    ],
  },
  {
    name: "新文档自动摘要",
    description: "新文档入库后自动生成 3 句摘要并写到文档头部",
    triggers: [{ type: "document-created", enabled: true }],
    nodes: [
      { type: "summarize", label: "生成摘要", config: {}, connections: [{ targetIndex: 1 }] },
      { type: "update-document", label: "写回文档头部", config: { mode: "prepend" }, connections: [] },
    ],
  },
  {
    name: "每日索引巡检",
    description: "每天凌晨做索引一致性体检（FTS/向量/分块对账），异常自动进收件箱",
    triggers: [{ type: "cron", schedule: "30 3 * * *", enabled: true }],
    nodes: [
      { type: "index-health", label: "索引巡检", config: {}, connections: [{ targetIndex: 1 }] },
      { type: "save-result", label: "存档巡检报告", config: { targetFolderId: 0, title: "每日索引巡检报告" }, connections: [] },
    ],
  },
  {
    name: "每周去重扫描",
    description: "每周一扫描疑似重复文档（内容哈希+标题归一），候选进收件箱人工裁决，绝不自动删除",
    triggers: [{ type: "cron", schedule: "30 4 * * 1", enabled: true }],
    nodes: [
      { type: "dedup-scan", label: "去重扫描", config: {}, connections: [{ targetIndex: 1 }] },
      { type: "save-result", label: "存档去重报告", config: { targetFolderId: 0, title: "每周去重扫描报告" }, connections: [] },
    ],
  },
];

/** 幂等种子：按 name 查重，返回新建条数 */
export async function seedDefaultWorkflows(): Promise<number> {
  const db = getDb();
  const reportFolderId = ensureReportFolderId();
  let created = 0;
  for (const wf of DEFAULT_WORKFLOWS) {
    const existing = await db.select({ id: workflows.id }).from(workflows)
      .where(eq(workflows.name, wf.name)).limit(1);
    if (existing.length > 0) continue;

    // save-result 节点落「工作流报告」文件夹（targetFolderId 0 = 根目录的占位替换为真实 id）
    const nodes = wf.nodes.map((n) =>
      n.type === "save-result" && Number(n.config.targetFolderId ?? 0) === 0
        ? { ...n, config: { ...n.config, targetFolderId: reportFolderId } }
        : n
    );

    // drizzle/better-sqlite3 同步事务
    db.transaction((tx) => {
      const r = tx.insert(workflows).values({
        name: wf.name,
        description: wf.description,
        status: "active",
        triggers: wf.triggers,
      }).run();
      const workflowId = Number(r.lastInsertRowid);

      // 先插节点拿真实 id，再回填 connections
      const nodeIds = nodes.map((n, i) => {
        const nr = tx.insert(workflowNodes).values({
          workflowId,
          type: n.type,
          label: n.label,
          positionX: 100 + i * 200,
          positionY: 100,
          config: n.config,
          connections: [],
          sortOrder: i,
        }).run();
        return Number(nr.lastInsertRowid);
      });
      nodes.forEach((n, i) => {
        const conns = (n.connections ?? []).map((c) => ({ targetId: nodeIds[c.targetIndex] }));
        tx.update(workflowNodes).set({ connections: conns })
          .where(eq(workflowNodes.id, nodeIds[i])).run();
      });
    });
    created++;
  }
  return created;
}

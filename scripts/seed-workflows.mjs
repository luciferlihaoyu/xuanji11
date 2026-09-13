/**
 * 种子：4 条开箱即用工作流。
 * 用法：service exec -- node scripts/seed-workflows.mjs
 * 幂等：按 name 查重，已存在则跳过。
 */
import Database from "better-sqlite3";

const db = new Database(process.env.SQLITE_PATH || "/data/app/xuanji.db");

const WORKFLOWS = [
  {
    name: "每日自动建边",
    description: "每天凌晨用语义相似度连接知识孤岛，把新入库文档自动连进知识网络",
    status: "active",
    triggers: [{ type: "cron", schedule: "0 3 * * *", enabled: true }], // 每天 03:00
    nodes: [
      { type: "auto-link", label: "自动建边", config: { threshold: 0.62, maxPerNode: 3, dryRun: false }, connections: [{ targetIndex: 1 }] },
      { type: "save-result", label: "存档建边报告", config: { targetFolderId: 0, title: "每日自动建边报告" }, connections: [] },
    ],
  },
  {
    name: "每周聚类报告",
    description: "每周一对全部文档做语义聚类，生成主题群报告，观察知识版图演变",
    status: "active",
    triggers: [{ type: "cron", schedule: "0 4 * * 1", enabled: true }], // 每周一 04:00
    nodes: [
      { type: "cluster", label: "语义聚类", config: { labelWithLlm: true }, connections: [{ targetIndex: 1 }] },
      { type: "save-result", label: "存档聚类报告", config: { targetFolderId: 0, title: "每周语义聚类报告" }, connections: [] },
    ],
  },
  {
    name: "新文档自动分拣",
    description: "新文档入库后自动 LLM 分拣：建议文件夹/标签/抽取概念实体并直接落库",
    status: "active",
    triggers: [{ type: "document-created", enabled: true }],
    nodes: [
      { type: "ingest-triage", label: "入库分拣", config: {}, connections: [] },
    ],
  },
  {
    name: "新文档自动摘要",
    description: "新文档入库后自动生成 3 句摘要并写到文档头部",
    status: "active",
    triggers: [{ type: "document-created", enabled: true }],
    nodes: [
      { type: "summarize", label: "生成摘要", config: {}, connections: [{ targetIndex: 1 }] },
      { type: "update-document", label: "写回文档头部", config: { mode: "prepend" }, connections: [] },
    ],
  },
];

// 节点间数据流： summarize 的 summary 需要流到 update-document 的 ctx.input
// 当前 runtime 的 ctx.input 是工作流输入不是上游输出——summarize 摘要放 outputs[nodeId]，
// update-document 读 ctx.input.summary 读不到。这是 runtime 的数据流限制，
// 种子先用「摘要直接进 save-result」规避？ 不——update-document 已兼容：
// 它读 config.content ?? ctx.input.summary。runtime 需要把上游输出合入 input。
// 见 runtime 修改：executeWorkflow 里把上游输出展平进下一个节点的 input。

const insertWorkflow = db.prepare(
  "INSERT INTO workflows (name, description, status, triggers, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)"
);
const insertNode = db.prepare(
  "INSERT INTO workflow_nodes (workflowId, type, label, positionX, positionY, config, connections, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
);
const findByName = db.prepare("SELECT id FROM workflows WHERE name = ?");

let created = 0;
for (const wf of WORKFLOWS) {
  if (findByName.get(wf.name)) {
    console.log(`跳过（已存在）: ${wf.name}`);
    continue;
  }
  const now = Date.now();
  const tx = db.transaction(() => {
    const r = insertWorkflow.run(wf.name, wf.description, wf.status, JSON.stringify(wf.triggers), now, now);
    const workflowId = Number(r.lastInsertRowid);
    // 先插节点拿 id，再把 targetIndex 换成真实 id
    const nodeIds = wf.nodes.map((n, i) => {
      const nr = insertNode.run(workflowId, n.type, n.label, 100 + i * 200, 100, JSON.stringify(n.config), "[]", i, now);
      return Number(nr.lastInsertRowid);
    });
    // 回填 connections
    wf.nodes.forEach((n, i) => {
      const conns = (n.connections ?? []).map((c) => ({ targetId: nodeIds[c.targetIndex] }));
      db.prepare("UPDATE workflow_nodes SET connections = ? WHERE id = ?").run(JSON.stringify(conns), nodeIds[i]);
    });
    return workflowId;
  });
  const id = tx();
  console.log(`创建: ${wf.name} (id=${id})`);
  created++;
}
console.log(`\n完成：新建 ${created} 条，共 ${WORKFLOWS.length} 条定义`);

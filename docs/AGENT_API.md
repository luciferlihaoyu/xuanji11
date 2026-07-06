# 璇玑智脑 Agent 接入指南

## 1. 获取 API Key

1. 登录璇玑 → Agent 管理 → 点击已有 Agent（或新建一个）
2. 右侧详情面板，找到「API 密钥」区域
3. 点击「生成密钥」→ 输入名称 → 生成
4. **密钥只显示一次，立即复制保存**

密钥格式：`xu_sk_` + 64 位十六进制字符
权限：继承该 Agent 的 7 项权限（读/写/删/管理/触发工作流/执行工作流/设计工作流）

---

## 2. REST API 调用

**认证方式**：所有请求带 Header `Authorization: Bearer <你的API Key>`

**端点前缀**：`https://xuanjj29.zeabur.app/api/trpc/`

### 知识图谱

```bash
# 查询所有节点
POST /api/trpc/knowledge.listNodes?input={}

# 按关键词搜索
POST /api/trpc/knowledge.listNodes?input={"search":"机器学习"}

# 创建节点
POST /api/trpc/knowledge.createNode
Body: {"title":"新概念","content":"节点内容","type":"concept"}

# 更新节点
POST /api/trpc/knowledge.updateNode
Body: {"id":1,"title":"新标题","content":"更新内容"}

# 删除节点
POST /api/trpc/knowledge.deleteNode
Body: {"id":1}
```

### 文档管理

```bash
# 列出文件夹
POST /api/trpc/kb.listFolders?input={}

# 列出文档
POST /api/trpc/kb.listDocuments?input={"folderId":1}

# 读取文档
POST /api/trpc/kb.getDocument?input={"id":1}

# 创建文档
POST /api/trpc/kb.createDocument
Body: {"folderId":1,"title":"新文档","content":"# Hello","format":"markdown"}

# 更新文档
POST /api/trpc/kb.updateDocument
Body: {"id":1,"title":"改标题","content":"更新后的内容"}
```

### Agent 管理

```bash
# 列出所有 Agent
POST /api/trpc/agent.list?input={}

# 测试 LLM 连接
POST /api/trpc/agent.testLlmConnection
Body: {"apiUrl":"https://api.openai.com/v1","apiKey":"sk-xxx","model":"gpt-4"}
```

### 工作流

```bash
# 列出工作流
POST /api/trpc/workflow.list?input={}

# 执行工作流
POST /api/trpc/workflow.run
Body: {"workflowId":1}
```

### 备份

```bash
# 列出备份任务
POST /api/trpc/backup.listJobs?input={}

# 创建备份
POST /api/trpc/backup.createJob
Body: {"target":"全量","sourcePath":"/data/app/uploads"}

# 触发备份执行
POST /api/trpc/backup.triggerJob
Body: {"jobId":1}
```

### 数据源

```bash
# 列出数据源
POST /api/trpc/datasource.list?input={}
```

---

## 3. MCP 协议连接

适用于 Claude Desktop、Cursor、或其他 MCP 兼容客户端。

### 配置文件（`mcp.json` 或 `claude_desktop_config.json`）

```json
{
  "mcpServers": {
    "xuanji": {
      "url": "https://xuanjj29.zeabur.app/api/mcp",
      "headers": {
        "Authorization": "Bearer xu_sk_你的密钥"
      }
    }
  }
}
```

### 可用工具（8 个）

| 工具名 | 功能 | 参数 |
|--------|------|------|
| `knowledge_search` | 搜索知识图谱节点 | `query`（搜索词）, `type`（可选: concept/document/topic/entity/note/tag） |
| `knowledge_create` | 创建知识节点 | `title`（标题）, `content`（内容）, `type`（类型） |
| `document_read` | 读取文档内容 | `documentId`（文档 ID） |
| `document_write` | 创建/更新文档 | `documentId`（更新时用）, `folderId`, `title`, `content`, `format` |
| `backup_list` | 查看备份任务列表 | 无 |
| `backup_trigger` | 触发备份任务 | `jobId` |
| `workflow_list` | 查看工作流列表 | 无 |
| `workflow_execute` | 执行工作流 | `workflowId` |

---

## 4. 权限说明

API Key 的权限继承自创建时绑定的 Agent：

| 权限项 | 能做什么 |
|--------|----------|
| `read` | 知识图谱、文档、工作流、Agent、备份 → 读取 |
| `write` | 知识图谱、文档、工作流 → 创建/编辑 |
| `delete` | 知识图谱、文档、工作流 → 删除 |
| `manage` | 系统管理（设置、用户） |
| `triggerWorkflow` | 手动触发工作流 |
| `executeWorkflow` | 执行工作流 |
| `designWorkflow` | 设计/修改工作流编排 |

---

## 5. 快速验证

拿到 Key 后验证连通性：

```bash
# 测试服务健康
curl -s https://xuanjj29.zeabur.app/health

# 测试 MCP 握手
curl -s -X POST https://xuanjj29.zeabur.app/api/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"test"},"capabilities":{}}}'
```

---

**一句话总结**：Agent 拿着 Key，走 REST（任意 HTTP 客户端）或 MCP（标准 AI Agent 协议），就能直接操作璇玑的知识图谱、文档、工作流、备份等全部功能。

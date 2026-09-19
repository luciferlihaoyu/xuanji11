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

**端点前缀**：`https://xuanji.xianrealme.com/api/trpc/`

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

### 文件接口

```bash
# 下载文件（二进制流）
GET /api/files/:id
```

- **鉴权**：`Authorization: Bearer <API Key>` 或本地管理员会话 Cookie（通过 `/api/*` 认证中间件）。
- **响应格式**：成功返回文件二进制流，响应头包含：
  - `Content-Type: <mime-type>`
  - `Content-Disposition: attachment; filename*=UTF-8''<URL编码后的原始文件名>`
  - `X-Content-Type-Options: nosniff`
- **错误码**：
  - `401` 未认证：`{ success: false, error: "Authentication required" }`
  - `403` 无权限：`{ success: false, error: "无权限下载此文件" }`（非管理员只能访问自己上传的文件）
  - `404` 文件不存在：`{ success: false, error: "文件不存在" }`

## 3. MCP 协议连接

适用于 Claude Desktop、Cursor、或其他 MCP 兼容客户端。

### 配置文件（`mcp.json` 或 `claude_desktop_config.json`）

```json
{
  "mcpServers": {
    "xuanji": {
      "url": "https://xuanji.xianrealme.com/api/mcp",
      "headers": {
        "Authorization": "Bearer xu_sk_你的密钥"
      }
    }
  }
}
```

### 可用工具（本节列 8 个核心工具；实际共 29 个，`tools/list` 为准）

| 工具名             | 功能                 | 参数                                                                                                                                                                                 | 必填                                         |
| ------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `knowledge_search` | 搜索知识图谱节点与边 | `query` 搜索词（标题/内容/边标签，默认空字符串）<br>`type` 节点类型过滤（可选：`concept`/`document`/`topic`/`entity`/`note`/`tag`）                                                  | `query` 可选<br>`type` 可选                  |
| `knowledge_create` | 创建知识节点         | `title` 节点标题<br>`content` 节点内容<br>`type` 节点类型（默认 `concept`）                                                                                                          | `title` 必填<br>`content`/`type` 可选        |
| `document_read`    | 读取文档内容         | `id` 文档 ID                                                                                                                                                                         | `id` 必填                                    |
| `document_write`   | 创建或更新文档       | `id` 已有文档 ID（更新时传入）<br>`folderId` 文件夹 ID<br>`title` 文档标题（创建时必填）<br>`content` 文档内容<br>`format` 格式（默认 `markdown`，可选 `text`/`json`/`html`/`code`） | `id` 可选<br>其余可选（创建时 `title` 必填） |
| `backup_list`      | 查看备份任务列表     | `status` 状态过滤（可选：`pending`/`running`/`completed`/`failed`/`partial`/`cancelled`）<br>`cursor` 分页游标（上次响应的 `nextCursor`）<br>`limit` 页大小（默认 50，上限 200；非法值按边界夹取）      | 均可选                                       |
| `backup_trigger`   | 立即触发备份任务     | `jobId` **必须是定时调度行（有 cron）**，返回 `{taskId, scheduleId, runJobId, status}`，不再需要干等                                                                                  | `jobId` 必填                                 |
| `workflow_list`    | 查看工作流列表       | `status` 状态过滤（可选：`draft`/`active`/`paused`/`error`/`archived`）<br>`cursor` 分页游标<br>`limit` 页大小（默认 50，上限 200；非法值按边界夹取）                                    | 均可选                                       |
| `workflow_execute` | 执行工作流           | `id` 工作流 ID<br>`input` 工作流输入 payload（对象，默认 `{}`）                                                                                                                      | `id` 必填<br>`input` 可选                    |

> 注：`document_write` 在代码层面还接受 `tags`（字符串数组）和 `metadata`（对象）用于扩展文档属性，可直接在参数中传入。

#### document_delete 的 dryRun（v2 新增，破坏性操作先预览）

`document_delete` 增参 `dryRun`（布尔，默认 `false`）：

```json
{"method": "tools/call", "params": {"name": "document_delete", "arguments": {"id": 1922, "dryRun": true}}}
```

返回（**不删除任何数据**，含向量）：

```json
{"dryRun": true, "id": 1922, "title": "…", "format": "markdown", "folderId": null,
 "wouldDelete": {"chunks": 119, "vectors": 119, "graphNodes": 1, "graphEdges": 0}}
```

`wouldDelete` 各项与真实级联删除同源计数（`vectors` 由向量引擎真实统计，不用 chunks 近似）。文档不存在时与真删返回同样的 `isError`。

#### 列表工具的分页信封（v2 变更，**破坏性变更**）

`folder_list` / `backup_list` / `workflow_list` 的返回值由「裸数组」改为分页信封：

```json
{"items": [ … ], "nextCursor": "bzoxMA", "total": 137}
```

- `nextCursor` 为 `null` 表示已到末页；请求下一页时把该字符串**原样**传回 `cursor`
- `cursor` 非法（伪造/过期）→ `isError`，**不会静默返回第一页**（避免调用方重复处理数据却毫无察觉）
- `limit` 越界按边界夹取（`<1` → 1，`>200` → 200），非整数向下取整
- 排序是全序：`folder_list` 按 `sortOrder, id`；`backup_list` 按 `createdAt desc, id desc`；`workflow_list` 按 `updatedAt desc, id desc`——保证跨页不漏项/重项
- 已知取舍：cursor 是 offset 语义（非 keyset），两页之间若有数据增删，`total` 与后续页可能漂移；分页期间建议以首页 `total` 为准或重新取首页
- 迁移指引：把原来的「直接当数组用」改成读 `items`；只取前 N 条时传 `limit`

#### 长任务统一句柄（v2 新增：task_get / task_cancel）

备份、全库回填这类长任务以前只能干等或去业务表里猜哪一行是自己刚触发的那次运行。现在统一走**任务句柄**：

```json
{"method": "tools/call", "params": {"name": "backup_trigger", "arguments": {"jobId": 3}}}
```
```json
{"taskId": "tsk_backup_m3k2a01", "scheduleId": 3, "runJobId": 41, "status": "running"}
```

- `task_get`（只读）：`{"taskId": "..."}` → `{taskId, kind, refId, status, progress, startedAt, finishedAt?, error?, meta, cancelRequested}`
  - `kind`：`backup`（`refId` = 本次运行行 backup_jobs.id）或 `reindex`
  - 进度/状态**以业务真相为准**：备份读 `backup_jobs` 行（`meta.filesTotal/filesDone/filesFailed`），回填读索引器进度——进程重启后句柄依然准确，不会永远停在 running
- `task_get` 是**有意的惰性收口点**：只读注解指它不改业务数据，但句柄若停在 running 而业务早已结束，读一次会把它落成终态（同一进程内让状态收敛，而不是永远漂着）
- `task_cancel`：`{"taskId": "..."}` → `{taskId, accepted, status, reason?}`
  - **两段式语义**：`accepted: true` 只表示取消请求已记录（执行方在安全点收手：备份在文件之间、回填在文档之间），`status` 仍为 `running`；执行方确认后状态才会变 `cancelled`
  - 任务已结束时**不谎报成功**：返回 `accepted: false` + `reason`（如「任务已 completed，无需取消」）
  - 取消的运行为 `cancelled` 状态，与 `failed`（故障）区分——调用方不该按失败重试
- `kb.reindex_all` 同样返回 `taskId`（全库回填的进度用 `kb.reindex_status` 或 `task_get` 都行）
- 边界（**重要，别误读**）：句柄保存在服务进程内存里，**不跨进程重启**——重启后旧 `taskId` 一律返回 `isError: Task not found`（不假装成功、也不谎报状态）
  - 「状态以业务真相为准」说的是**同一次进程生命周期内**：句柄只存身份，进度/终态每次都从 `backup_jobs` 行或索引器实况重新读，所以不会出现「业务早已结束、句柄永远 running」的漂移
  - 重启后要查历史：备份用 `backup_list`（`refId` = 运行行 id，可直接对上）；回填可重新触发（`kb.reindex_all` 幂等）
  - 若一次备份运行的行在进程重启时仍停在 `pending`/`running`（进程被杀），它不会有人再来收尾：请以 `backup_list` 的行状态为准，必要时重新触发
- 幂等入口：回填已在运行时再调 `kb.reindex_all` **不会新造句柄**，而是复用/认领正在跑的那个（返回 `reused: true`）；否则会给出一个没人轮询的句柄，取消它也是空转。UI 直接发起的回填没有句柄，MCP 调用会**认领**它，认领之后即可取消
- 未提供服务端强制中断：取消是协作式的，单次长上传/单篇索引会跑完当前单元才停

- `backup_trigger` 的边界：`backup_jobs` 是双职表（调度行 + 每次运行行），**运行行（cron 为空）会被拒绝**——否则会悄悄多派生一份备份；触发走「按 id 直取」，不会改 `enabled`，所以停用的调度也能手动触发一次（无需先启用），也不会把行弄成 due
- 取消的部分快照同样进 `keepLastN` 保留策略（连续取消不会让网盘被半截快照无声堆满）

#### 工具注解（v2 新增）

`tools/list` 返回的每个工具都带 `annotations`（MCP 2025-06-18）：`title`、`readOnlyHint`、`destructiveHint`、`idempotentHint`、`openWorldHint`。客户端可据此决定是否自动批准：例如 `knowledge_search`/`folder_list` 为只读；`document_delete`、`zvec.deleteCollection` 标 `destructiveHint: true`；`backup_trigger`、`workflow_execute` 会触达外部系统（`openWorldHint: true`）。

---

## 4. API 中心

访问路径：页面顶部导航「API 中心」（`/api`）。

### 4.1 在线调试

内置 HTTP 请求调试台，支持：

- 选择方法（GET / POST / PUT / DELETE）与预置端点（`/health`、`/api/trpc/*`、`/api/mcp`、`/api/upload`、`/api/files/:id`）。
- 自定义请求头、请求体（JSON）。
- 发送真实请求并查看状态码、响应头、响应体与耗时。

调试请求通过 `fetch` 发送，会自动携带当前会话 Cookie；若调用需要认证的外部接口，请在请求头中加上 `Authorization: Bearer <API Key>`。

### 4.2 Token 管理

仅管理员可操作：

1. 选择目标 Agent。
2. 输入密钥名称 → 创建新 Token。
3. 系统一次性返回完整密钥 `xu_sk_...`，**请立即复制保存**；再次查看只能看到前缀、状态与权限范围。
4. 可随时撤销密钥；撤销后 `isActive` 置为 `false`，该密钥立即失效。

Token 的权限范围继承自创建时所选 Agent 的 7 项权限，并映射为细粒度 scope（如 `knowledge:read`、`workflows:execute`）。

---

## 5. 向量嵌入配置

在「设置 → 向量化模型」中配置嵌入模型，用于语义搜索、文档切片的向量化索引等。

### 5.1 配置字段

| 字段         | 设置键                           | 说明                                      |
| ------------ | -------------------------------- | ----------------------------------------- |
| 模型提供商   | `embedding_provider`             | `openai` / `minimax` / `local` / `custom` |
| API URL      | `embedding_api_url`              | OpenAI 兼容的 embeddings 接口地址         |
| API Key      | `embedding_api_key`              | 访问密钥                                  |
| 模型         | `embedding_model`                | 模型名，如 `text-embedding-3-small`       |
| 向量维度     | `embedding_dimension`            | 默认 `1536`                               |
| 索引更新模式 | `embedding_index_mode`           | `realtime` 等                             |
| 相似度阈值   | `embedding_similarity_threshold` | 默认 `0.75`                               |

所有配置持久化在 `system_settings` 表，分类为 `vectorization`。

### 5.2 火山引擎 Ark / doubao-embedding-vision

支持火山引擎 Ark 多模态嵌入模型 `doubao-embedding-vision`：

- 在「模型提供商」中选择 `openai` 或 `custom`。
- API URL 设置为 `https://ark.cn-beijing.volces.com/api/v3`（或包含 `ark.cn-beijing.volces.com` 的地址）。
- 模型名填写 `doubao-embedding-vision`。
- 向量维度自动识别为 `2048`。

后端会根据 URL 主机名自动切换为火山引擎调用方式：使用 `/embeddings/multimodal` 端点、`input` 为 `[{ type: "text", text: "..." }]` 数组，并自动附加 `dimensions` 参数。

### 5.3 OpenAI 兼容嵌入模型

任何提供 OpenAI 兼容 `/embeddings` 接口的服务均可使用：

- 填入标准 API URL、Key 与模型名。
- 请求体会按标准格式发送：`{ input: ["文本"], model: "...", encoding_format: "float" }`。
- 支持的示例模型：`text-embedding-3-small`、`text-embedding-3-large`、`bge-large-zh`、`m3e-base` 等。

### 5.4 健康检查

保存配置后，可点击「健康检查」调用 `trpc.knowledge.vectorHealth.query()`，后端会发送一个探测 embedding 并返回服务状态。

---

## 6. 新增云盘备份

除本地/服务器备份外，现支持将备份目标设为 **115 网盘** 或 **阿里云盘**。

### 6.1 Token 配置

进入「备份」或「数据源」页面，选择目标类型：

| 平台     | 标识          | 所需凭证                      | 存储位置                                                                                             |
| -------- | ------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| 115 网盘 | `115`         | `accessToken`、`refreshToken` | `system_settings.key = connector_115_config`；备份任务本身也会复制一份到 `backupJobs.config`         |
| 阿里云盘 | `aliyundrive` | `accessToken`、`refreshToken` | `system_settings.key = connector_aliyundrive_config`；备份任务本身也会复制一份到 `backupJobs.config` |

### 6.2 Token 持久化与自动刷新

- 首次在 UI 中填写并保存后，Token 写入 `system_settings` 表，键名为 `connector_{platform}_config`。
- 创建备份任务时，Token 会同时写入 `backupJobs.config` JSON 字段。
- 执行定时备份时，若 `accessToken` 过期但 `refreshToken` 有效，系统会自动刷新 Token，并回写到 `backupJobs.config`。
- 也可在 UI 中手动点击「刷新 Token」。

### 6.3 相关 tRPC 接口

- `connector.getConfig` — 读取连接器配置
- `connector.saveConfig` — 保存连接器配置
- `connector.testConnection` — 测试连接
- `connector.refreshToken` — 手动刷新 Token
- `backup.listJobs` / `backup.createJob` / `backup.triggerJob` — 备份任务管理

---

## 7. 安全特性

### 7.1 API Key scope 权限模型

API Key 的权限继承自创建时绑定的 Agent，并解析为具体 scope：

| Agent 权限                            | 对应 scope                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| `read`                                | `knowledge:read`、`documents:read`、`workflows:read`、`agents:read`、`backups:read` |
| `write`                               | `knowledge:write`、`documents:write`、`workflows:write`、`backups:write`            |
| `delete`                              | `knowledge:delete`、`documents:delete`、`workflows:delete`                          |
| `manage`                              | `system:manage`                                                                     |
| `triggerWorkflow` / `executeWorkflow` | `workflows:execute`                                                                 |
| `designWorkflow`                      | `workflows:design`                                                                  |

认证时，系统从 `Authorization: Bearer <key>` 中提取密钥，计算 SHA-256 哈希后查询 `api_keys` 表；仅当 `isActive = 'true'` 且未过期时才通过，并同时更新 `lastUsedAt`。

### 7.2 JWT 强校验

- 本地管理员会话使用 `HS256` 算法签发 JWT，并严格指定 `algorithms: ["HS256"]` 进行校验，防止 algorithm confusion 攻击。
- 生产环境启动时强制校验 `JWT_SECRET` 长度 ≥ 32 字符，否则直接退出。
- JWT 包含 `jti`（随机 UUID）与 `iat`（签发时间）；修改管理员密码后，所有在该时间之前签发的会话自动失效。
- 会话 Cookie：`xuanji_session`，`httpOnly: true`，默认 `SameSite=Lax`，生产环境 `secure=true`。

### 7.3 CSRF 防护

- 对 `/api/*` 下所有 `POST`/`PUT`/`PATCH`/`DELETE` 请求，要求请求头必须包含 `X-Requested-With: XMLHttpRequest`，否则返回 403。
- 以下路径豁免：MCP 接口 `/api/mcp`、SSE 端点 `/api/mcp/sse`、以及工作流 Webhook `/api/workflows/:id/webhook`。
- 登录、改密等敏感突变操作还会额外校验 `Origin` 头与请求来源一致。

### 7.4 安全响应头

由 Hono 全局中间件统一设置：

| 响应头                      | 值                                                                                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `X-Content-Type-Options`    | `nosniff`                                                                                                                                                                                                                      |
| `X-Frame-Options`           | `DENY`                                                                                                                                                                                                                         |
| `Referrer-Policy`           | `strict-origin-when-cross-origin`                                                                                                                                                                                              |
| `Permissions-Policy`        | `camera=(), microphone=(), geolocation=()`                                                                                                                                                                                     |
| `Content-Security-Policy`   | `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'` |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload`（生产环境且非 localhost）                                                                                                                                                       |

### 7.5 登录限流

为防止登录爆破，系统对登录失败进行滑动窗口限流：

- 窗口：5 分钟。
- 阈值：同一 IP + 同一用户名连续失败 5 次。
- 锁定时长：15 分钟。
- 锁定期间，即使密码正确也会拒绝登录；成功登录会清空该窗口计数。

---

## 8. 速率限制

当前系统的速率限制集中在登录防护层面：详见「7.5 登录限流」。

REST / tRPC / MCP 业务接口暂未启用全局 QPS 限流；如部署到公网，建议在前置 CDN、网关或负载均衡层按 API Key 或客户端 IP 配置额外限流策略。

---

## 9. 权限说明

API Key 的权限继承自创建时绑定的 Agent：

| 权限项            | 能做什么                                   |
| ----------------- | ------------------------------------------ |
| `read`            | 知识图谱、文档、工作流、Agent、备份 → 读取 |
| `write`           | 知识图谱、文档、工作流 → 创建/编辑         |
| `delete`          | 知识图谱、文档、工作流 → 删除              |
| `manage`          | 系统管理（设置、用户）                     |
| `triggerWorkflow` | 手动触发工作流                             |
| `executeWorkflow` | 执行工作流                                 |
| `designWorkflow`  | 设计/修改工作流编排                        |

---

## 10. 快速验证

拿到 Key 后验证连通性：

```bash
# 测试服务健康（无需鉴权）
curl -s https://xuanji.xianrealme.com/health

# 测试 MCP 握手（无需鉴权）
curl -s -X POST https://xuanji.xianrealme.com/api/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"test"},"capabilities":{}}}'

# 使用 API Key 调用 REST 接口（需鉴权）
curl -s -X POST "https://xuanji.xianrealme.com/api/trpc/knowledge.listNodes?input={}" \
  -H "Authorization: Bearer xu_sk_你的密钥" \
  -H "X-Requested-With: XMLHttpRequest"
```

---

**一句话总结**：Agent 拿着 Key，走 REST（任意 HTTP 客户端）或 MCP（标准 AI Agent 协议），就能直接操作璇玑的知识图谱、文档、工作流、备份等全部功能。

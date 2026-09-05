# 璇玑知识库服务端开发计划（需求 v1：document_delete + folder 管理 + document_upsert）

> 来源：`/115/dsh/报告/璇玑知识库服务端开发需求-v1.md`（薇子整理，2026-09-05）
> 仓库：`/data/dsh/璇玑/xuanji11-review`（分支 main，直接开发）
> 铁律：**不动线上真实文档数据**；所有测试用临时测试文档/内存 mock；不回退向量引擎修复（5592701/1164fda/0d32f0f/8012d52/553467e/2e249c3/eaeb056）

## 现状勘察结论

- MCP 工具注册集中在 `api/mcp-server.ts`（`tools` 数组 + `callTool` switch），现有 24 工具
- trpc 层（`api/kb-router.ts`）已有 `deleteDocument`（adminQuery）但**不删知识图谱节点/边、无删除计数**；MCP 层完全缺删除/文件夹/upsert
- `kb_folders` 表已存在（`db/schema.ts:147`），`kbDocuments.folderId` 字段已存在
- 向量删除：`vectorEngine.deleteByDocumentId`（`api/lib/vector-engine.ts:202` SqliteVecEngine 版）已按 META rowid 事务性清理 vec_chunks + vec_chunk_meta
- 图谱节点与文档关联：`knowledgeNodes.type='document'` AND `json_extract(metadata,'$.documentId')=<id>`（`api/lib/relation-analyzer.ts:45`）
- 边清理参照 `api/knowledge-router.ts:114`（sourceId/targetId 双向删）
- scope 常量：`documents:write` / `documents:delete` 均在 `MANAGEMENT_SCOPES`；API key `write` 权限组映射 `documents:write`、`delete` 组映射 `documents:delete`。需求方要求 `knowledge:write` 同级——**用 `documents:write`（与 document_write 同级，语义最准）**，文档删除额外要求 `documents:delete`（有则免二次确认……不，保持简单：删除要求 `documents:delete`，若 token 只有 write 会拒绝；但薇子验收 5 用 "无 write scope 的 token 返回鉴权错误"——因此**删除/写 folder/upsert 统一要求 `documents:write`**，与 document_write 完全同级，满足验收第 5 条且不引入新 scope 门槛）
- 测试模式：mock `./queries/connection` 的 `getDb` + `./lib/auth` + `./local-auth` + `./lib/vector-service`（见 `api/mcp-server.test.ts`）

## 任务

### t1-document-delete
- **goal**: 新增 MCP 工具 `document_delete`，级联删文档记录/chunks/向量/图谱节点与边，返回删除计数
- **files**:
  - `api/mcp-server.ts`：tools 数组加 `document_delete` 条目；新增 `handleDocumentDelete`；callTool 加 case
  - `api/lib/document-removal.ts`（新建）：`deleteDocumentCascade(db, id)` 返回 `{ deletedChunks, deletedVectors, deletedNodes, deletedEdges }`；单 drizzle 事务（`db.transaction`）
- **change**:
  - `deleteDocumentCascade` 步骤（事务内顺序）：
    1. `select` 文档存在性——不存在抛 `Error("Document not found: <id>")`
    2. 删 `documentChunks` where documentId=id → 计数 deletedChunks（`db.delete(...).run().changes` 或先 count）
    3. `vectorEngine.deleteByDocumentId(id)` → deletedVectors（内部自事务，嵌套 OK，因为 vec0 表不在 drizzle 事务里也能回滚语义等价——先删向量再删记录，失败抛出则文档记录保留，幂等可重试）
    4. 查图谱节点：`type='document'` AND `json_extract(metadata,'$.documentId')=String(id)` → 收集 nodeIds
    5. 有 nodeIds：删边（sourceId OR targetId IN nodeIds）→ deletedEdges；删节点 → deletedNodes
    6. 删 `kbDocuments` 记录
  - `handleDocumentDelete`：`assertScope(auth, "documents:write")`；zod `{ id: int().positive() }`；返回 `{ success: true, id, deletedChunks, deletedVectors, deletedNodes, deletedEdges }`
  - MCP tools 数组条目描述含 "Cascade-deletes chunks, vectors, and linked knowledge graph nodes"
- **verify**: `cd /data/dsh/璇玑/xuanji11-review && SQLITE_PATH=/tmp/t.db UPLOAD_DIR=/tmp/u ADMIN_USERNAME=admin ADMIN_PASSWORD='correct-password' JWT_SECRET='fixed-test-jwt-secret-with-32-chars' EGRESS_ALLOW_PRIVATE_NET=1 ./node_modules/.bin/vitest run api/mcp-document-delete.test.ts` → 全绿（测试文件 t4 写）

### t2-folder-tools
- **goal**: 新增 MCP 工具 `folder_create` / `folder_list` / `document_set_folder`
- **files**: `api/mcp-server.ts`（tools 数组 + handlers + cases）
- **change**:
  - `folder_create`：zod `{ name: string().min(1).max(255), parentId: int().positive().nullable().optional() }`；parentId 非空时校验父存在（不存在报错）；同名同层查重——`where(name=name AND parentId is/null)`，已存在返回 `{ success:false, error:"folder exists", id:<已有id> }`（isError: true）；成功 insert 返回 `{ id, name, parentId }`。scope `documents:write`
  - `folder_list`：无参（可选 parentId 过滤）；select 全部 kbFolders + 按 folderId group count 文档数；返回数组 `[{ id, name, parentId, icon, sortOrder, documentCount }]`。scope `documents:read`
  - `document_set_folder`：zod `{ id: int().positive(), folderId: int().positive().nullable() }`；folderId 非空校验存在；文档不存在报错；`update kbDocuments set folderId`（**不触发索引/向量化**）；返回 `{ success:true, id, folderId }`。scope `documents:write`
  - tools 描述注明 "Lightweight metadata change; does NOT re-chunk or re-vectorize"
- **verify**: 同 t1 命令但跑 `api/mcp-folder-tools.test.ts`（t4 写）→ 全绿

### t3-document-upsert
- **goal**: 新增 MCP 工具 `document_upsert`，按规范化标题查重实现幂等写入（修同步重复 bug 的服务端能力）
- **files**:
  - `api/mcp-server.ts`（tools 数组 + handler + case）
  - `api/lib/title-normalize.ts`（新建）：`normalizeTitle(title: string): string` —— trim、去所有 `[...]` 前缀段、连续空白折叠为单空格、toLowerCase
- **change**:
  - `handleDocumentUpsert`：zod `{ title: string().min(1).max(500), content: string().optional(), format: documentFormatSchema.default("markdown"), tags/metadata/folderId optional }`；scope `documents:write`
  - 逻辑：normalizeTitle(title) → 遍历全部 kbDocuments（select id,title）用同 normalize 比对 → 命中最早 id（asc 取第一个）→ 复用 handleDocumentWrite 的更新路径（带 id 覆盖 content，自动重索引）→ 返回 `{ id, action:"updated" }`；无命中 → insert → `{ id, action:"created" }`
  - 大表 1826 篇全量拉 id+title 可接受（仅两列）；写清注释
- **verify**: 同 t1 命令但跑 `api/mcp-document-upsert.test.ts`（t4 写）→ 全绿

### t4-tests
- **goal**: 三个 MCP 新工具的单测（mock 模式参照 mcp-server.test.ts）
- **files**:
  - `api/mcp-document-delete.test.ts`：文档不存在→isError；正常删→返回计数且各 delete 被调；无 scope→-32003/鉴权错误文案（assertScope 抛错被 catch 成 -32603 "Internal tool error"——断言 text 含 "scope"）
  - `api/mcp-folder-tools.test.ts`：create 成功/重名报 exists/父不存在报错；list 返回 documentCount；set_folder 更新且不触发 tryIndexDocumentById（mock 断言未调用）
  - `api/mcp-document-upsert.test.ts`：新标题→created；同标题（含 `[前缀]` 差异）→updated 同 id 不新建；normalizeTitle 单元用例
- **change**: 每个 test mock `./queries/connection`（getDb 返回内存 fake：prepare 风格用 drizzle builder 不易 mock——改用真实 better-sqlite3 内存库 + 真实 schema migrate？成本高。**用 vi.mock 模块级 fake db 对象**：`getDb: () => fakeDb`，fakeDb 提供 select/insert/delete/update 链式 stub，按 mcp-server.test.ts 现有风格扩展）；mock `./lib/vector`（vectorEngine.deleteByDocumentId）
- **verify**: 单文件 vitest 均绿 + `tsc -b` 0 错误

### t5-build-push-deploy
- **goal**: 构建、提交推送、Zeabur 部署、MCP tools/list 验证
- **files**: 无新文件；`git push` + `zeabur service redeploy`
- **change**:
  1. `npm run build`（本地，<2min）
  2. commit 消息：`feat(mcp): document_delete + folder tools + document_upsert`
  3. `github_push` 到 luciferlihaoyu/xuanji11 main
  4. `zeabur auth login --token <新token> -i=false` + `service redeploy --id 6a60d9f64d439e41ee4db8e1 --env-id 6a60d9f5b0b7a4abeb4e6f5c`
  5. 部署 RUNNING 后：容器内 curl MCP `tools/list` 验证 5 个新工具可见（document_delete / folder_create / folder_list / document_set_folder / document_upsert）
  6. 用测试文档走一遍验收链：document_write 建测试文档 → document_delete 删 → folder_create 建 `test-folder` → document_set_folder 分配 → document_upsert 同标题两次（第二次 updated）
  7. 验收完删除测试 folder；通知薇子远程验收（5.2 清单）
- **verify**: tools/list JSON 含 5 个新工具名；验收链每步返回符合 5.2 表格

## 风险与约束

- **不动线上数据**：验收测试文档用完即删
- **不回退向量修复**：改动仅在 mcp-server.ts + 新增 lib 文件，不触碰 vector-engine/vector-service/document-indexer 逻辑（upsert 更新路径复用 handleDocumentWrite → tryIndexDocumentById，这是现有行为）
- **事务性**：删除链路用 drizzle `db.transaction` 包裹 SQL 部分；向量删除在事务外（better-sqlite3 同步事务 + vec0 虚表限制），顺序为"先向量后记录"，失败可重试幂等
- AGENTS.md：只跑单文件测试，不跑全量

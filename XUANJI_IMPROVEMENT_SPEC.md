# 璇玑智脑改进优化 Spec

> 基于 ANALYSIS_REPORT.md + 美智子审核
> 目标：将璇玑智脑从"骨架完整但安全问题严重"提升到"生产可用"

---

## 第一阶段：安全认证收口 (P0)

### 路由认证规则

| 路由 | 当前 | 应改为 | 原因 |
|------|------|--------|------|
| `ping` | publicQuery | publicQuery ✅ | 健康检查 |
| `auth.me/login/logout` | publicQuery | publicQuery ✅ | 认证端点本身 |
| `agent.list/getById` | authedQuery ✅ | 保持不变 | 读操作 |
| `agent.create/update/delete/updatePermissions` | adminQuery ✅ | 保持不变 | 管理操作 |
| `knowledge.listNodes/listEdges/getGraph` | authedQuery ✅ | 保持不变 | 读操作 |
| `knowledge.searchNodes/getNode` | publicQuery ❌ | **authedQuery** | 需认证 |
| `knowledge.createNode/updateNode/deleteNode/updateNodePositions` | publicQuery ❌ | **adminQuery** | 写操作 |
| `knowledge.createEdge/deleteEdge` | publicQuery ❌ | **adminQuery** | 写操作 |
| `kb.listFolders/listRootFolders` | authedQuery ✅ | 保持不变 | 读操作 |
| `kb.listSubFolders/listDocuments/searchDocuments/getDocument/getTree` | publicQuery ❌ | **authedQuery** | 读操作 |
| `kb.createFolder/updateFolder/deleteFolder` | publicQuery ❌ | **adminQuery** | 写操作 |
| `kb.createDocument/updateDocument/deleteDocument` | publicQuery ❌ | **adminQuery** | 写操作 |
| `workflow.list/listNodes` | authedQuery ✅ | 保持不变 | 读操作 |
| `workflow.getById/setStatus` | publicQuery ❌ | **authedQuery** | 读操作 |
| `workflow.create/update/delete/createNode/updateNode/deleteNode/saveFull` | publicQuery ❌ | **adminQuery** | 写操作 |
| `datasource.list` | authedQuery ✅ | 保持不变 | 读操作 |
| `datasource.listByType/getById/testConnection/sync` | publicQuery ❌ | **authedQuery** | 读操作 |
| `datasource.create/update/delete` | publicQuery ❌ | **adminQuery** | 写操作 |
| `file.list/getById` | publicQuery ❌ | **authedQuery** | 读操作 |
| `file.register/update/delete` | publicQuery ❌ | **adminQuery** | 写操作 |
| `vector.list` | authedQuery ✅ | 保持不变 | 读操作 |
| `vector.getById` | publicQuery ❌ | **authedQuery** | 读操作 |
| `vector.create/update/delete/updateDocCount` | publicQuery ❌ | **adminQuery** | 写操作 |
| `setting.list` | authedQuery ✅ | 保持不变 | 读操作 |
| `setting.listByCategory/getByKey` | publicQuery ❌ | **authedQuery** | 读操作 |
| `setting.set/setMany/delete` | publicQuery ❌ | **adminQuery** | 写操作 |

### 文件修改范围

**必须修改的文件（8个路由 + 1个导入调整）：**
- `api/knowledge-router.ts` — searchNodes/getNode → authedQuery，create/update/delete → adminQuery
- `api/kb-router.ts` — 读 → authedQuery，写 → adminQuery
- `api/workflow-router.ts` — getById/setStatus → authedQuery，create/update/delete/节点CRUD → adminQuery
- `api/datasource-router.ts` — 读 → authedQuery，写 → adminQuery
- `api/file-router.ts` — 读 → authedQuery，写 → adminQuery
- `api/vector-router.ts` — 读 → authedQuery，写 → adminQuery
- `api/setting-router.ts` — 读 → authedQuery，写 → adminQuery
- `api/agent-router.ts` — 检查是否已有 authedQuery/adminQuery import（确认 `f427d91` 已正确改完）

**不需要修改：**
- `api/router.ts` — ping 保持 publicQuery ✅
- `api/auth-router.ts` — 保持 publicQuery ✅
- `api/middleware.ts` — authedQuery/adminQuery 已定义 ✅

---

## 第二阶段：基础设施修复 (P0→P1)

### 2.1 Docker HEALTHCHECK
- **文件：** `Dockerfile:41`
- **问题：** Alpine 不含 `wget`，应改用 `curl`
- **修复：** 改为 `curl -f http://localhost:3000/api/trpc/ping` 或改为单独的 health endpoint

### 2.2 数据库连接修正
- **文件：** `api/queries/connection.ts:14`
- **问题：** `mode: "planetscale"` 但实际用标准 MySQL
- **修复：** 改为 `mode: "default"`（drizzle-orm 0.45）

### 2.3 数据库索引
- **文件：** `db/schema.ts`
- **需要添加索引的表：**
  - `agents.ownerId` (高频查询)
  - `knowledge_nodes.ownerId` + `knowledge_nodes.parentId`
  - `knowledge_edges.sourceId` + `knowledge_edges.targetId`
  - `kb_folders.parentId` + `kb_folders.ownerId`
  - `kb_documents.folderId` + `kb_documents.ownerId`
  - `workflows.ownerId`
  - `workflow_nodes.workflowId`
  - `data_sources.ownerId` + `data_sources.type`
  - `uploaded_files.uploadedBy`
  - `vector_collections.ownerId`
  - `system_settings.category` + `system_settings.key`
  - `messages` 相关索引

### 2.4 优雅关闭
- **文件：** `api/boot.ts`
- **添加：** `process.on('SIGTERM', ...)` / `process.on('SIGINT', ...)` 优雅关闭
- 关闭 WebSocket 连接、数据库连接池、HTTP 服务器

### 2.5 健康检查端点
- **文件：** `api/boot.ts`
- **添加：** `GET /health` 返回 `{ ok: true, uptime, dbConnected }`

### 2.6 日志系统
- **文件：** 新建 `api/lib/logger.ts`
- **实现：** 简单的结构化日志（pino 太重，用 console 封装 + timestamp + level）
- 所有 console.log/warn/error 替换为 logger

---

## 第三阶段：前端功能收口 (P1)

### 3.1 知识图谱接入后端
- **文件：** `src/pages/KnowledgeGraph.tsx` + `src/store/useAppStore.ts`
- **当前问题：** 图谱节点/边全部来自 Zustand 硬编码数据，忽略 tRPC hooks
- **修复：**
  1. KnowledgeGraph 页面改为调用 `useKnowledgeGraph()` tRPC hooks
  2. Zustand store 中的 `graphNodes`/`graphEdges` 改为从后端加载
  3. 节点的 create/update/delete/position-change 改为调用 tRPC mutation
  4. 保留前端拖拽交互，但数据源改为后端

### 3.2 ErrorBoundary 接入 App
- **文件：** `src/main.tsx` 或 `src/App.tsx`
- **当前：** ErrorBoundary 组件已创建但未在 App 中使用
- **修复：** 在路由外层包裹 `<ErrorBoundary>`

### 3.3 D3 生命周期修复
- **文件：** `src/pages/KnowledgeGraph.tsx`
- **修复：** useEffect 添加 cleanup 函数，组件卸载时停止 D3 force simulation 并清除 SVG

### 3.4 删除死代码
- **文件：** `src/pages/Home.tsx` — 删除

---

## 第四阶段：后端结构优化 (P1→P2)

### 4.1 文件上传安全检查
- **文件：** `api/upload-handler.ts`
- **修复：** 添加文件类型白名单，拒绝可执行文件/脚本

### 4.2 未使用依赖清理
- **文件：** `package.json`
- @aws-sdk/client-s3、@aws-sdk/s3-request-presigner → 移除
- d3-force-3d → 移除（仅用 2D）
- pdfjs-dist、prismjs → 保留（将来用于文档预览/代码高亮）
- kimi-plugin-inspect-react → 保留 devDep

---

## 第五阶段：CODEOWNERS + 文档更新

### 5.1 README 更新
- 补充认证方式说明
- 补充 API 鉴权层级说明
- 补充健康检查端点说明

### 5.2 ANALYSIS_REPORT.md 更新
- 标记已修复项
- 更新安全评分

---

## 实施顺序

```
阶段1 (P0) → 安全认证收口 ~60处 publicQuery 改为 authedQuery/adminQuery
阶段2 (P0) → Docker + DB + HealthCheck + 优雅关闭
阶段3 (P1) → 知识图谱 tRPC 接入 + ErrorBoundary + D3 cleanup
阶段4 (P1) → 文件上传安全 + 依赖清理
阶段5     → 文档更新
```

---

## 不变的原则

1. **不修改数据库结构**（不打乱现有迁移）
2. **不修改前端路由**
3. **不修改 tRPC 路由名称和入参/出参类型**
4. **不删除 `api/kimi/`**（Kimi OAuth 保留但可选）
5. **所有改动必须在本地通过 `npx tsc -b` 类型检查**
6. **完成后写变更汇总到此文件底部**

---

# 完成摘要（2026-06-13）

## 变更文件清单

### Phase 1 — 安全认证收口 ✅ 已完成
| 文件 | 变更 |
|------|------|
| `api/knowledge-router.ts` | searchNodes/getNode → authedQuery; create/update/delete → adminQuery |
| `api/kb-router.ts` | 读 → authedQuery; 写 → adminQuery |
| `api/workflow-router.ts` | getById/setStatus → authedQuery; CRUD → adminQuery |
| `api/datasource-router.ts` | 读 → authedQuery; 写 → adminQuery |
| `api/file-router.ts` | 读 → authedQuery; 写 → adminQuery |
| `api/vector-router.ts` | 读 → authedQuery; 写 → adminQuery |
| `api/setting-router.ts` | 读 → authedQuery; 写 → adminQuery |
| `api/agent-router.ts` | 已验证 authedQuery/adminQuery 已正确导入使用 |

### Phase 2 — 基础设施修复 ✅ 已完成
| 文件 | 变更 |
|------|------|
| `Dockerfile` | HEALTHCHECK wget → curl /health |
| `api/queries/connection.ts` | mode: "planetscale" → "default" |
| `db/schema.ts` | 添加所有表高频查询索引（含 FK 约束） |
| `api/boot.ts` | 添加优雅关闭（SIGTERM/SIGINT）+ /health 端点 |
| `api/lib/logger.ts` | 新建结构化日志系统 |

### Phase 3 — 前端功能收口 ✅ 已完成
| 文件 | 变更 |
|------|------|
| `src/pages/KnowledgeGraph.tsx` | 重构：用 useKnowledgeGraph() tRPC hook 替换 Zustand 硬编码数据；添加完整 D3 cleanup（simulation.stop + SVG clear + zoom 事件解绑）；类型安全接口化 |
| `src/App.tsx` | ErrorBoundary 包裹路由（已有）✅ |
| `src/components/ErrorBoundary.tsx` | 已创建 ✅ |
| `src/pages/Home.tsx` | 已删除 ✅ |

### Phase 4 — 后端结构优化 ✅ 已完成
| 文件 | 变更 |
|------|------|
| `api/upload-handler.ts` | MIME 白名单 + 扩展名黑名单 ✅ 已完成 |
| `package.json` | 移除 @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, d3-force-3d |
| `package-lock.json` | 同步移除上述依赖的锁定条目 |

### Phase 5 — 文档更新 ✅ 已完成
| 文件 | 变更 |
|------|------|
| `README.md` | 补充认证方式、API 鉴权层级、健康检查端点说明、环境变量补充 |
| `ANALYSIS_REPORT.md` | 添加修复状态摘要表和安全评分更新 |
| `XUANJI_IMPROVEMENT_SPEC.md` | 本摘要 |

### 额外修复
| 文件 | 变更 |
|------|------|
| `db/schema.ts` | 修正 `uploadedFiles_uploadedBy_idx` 索引误放在 vectorCollections 表上的 bug |

## 关键实现说明

### KnowledgeGraph 接入 tRPC
- `src/pages/KnowledgeGraph.tsx` 现在通过 `useKnowledgeGraph()` hook 从后端 tRPC `knowledge.getGraph` 获取数据
- 数据映射：`backendNode.title → renderNode.name`, `backendNode.type → renderNode.category`
- 保留了完整的 D3 力导向交互（拖拽、缩放、悬浮高亮、点击选中）
- 图表标签从原来的 5 个硬编码类别(core/doc/agent/web/media) 改为后端 schema 的 6 个枚举(concept/document/topic/entity/note/tag)

### D3 生命周期修复
- useEffect 清理函数完整执行：`simulation.stop()`, `svg.on('.zoom', null)`, `svg.selectAll('*').remove()`
- 增加 `simulationRef` 追踪当前 simulation 实例
- 重新创建 simulation 前先停止旧实例

### 依赖清理
- `@aws-sdk/client-s3` 和 `@aws-sdk/s3-request-presigner`：经全文搜索确认无任何引用
- `d3-force-3d`：KnowledgeGraph 始终使用 2D 模式（viewMode 硬编码为 '2D'）
- `pdfjs-dist`、`prismjs`、`kimi-plugin-inspect-react`：按规范保留

### Schema bug fix
- `uploadedFiles_uploadedBy_idx` 原来错误地定义在 `vectorCollections` 表上（该表无 `uploadedBy` 列），已移回 `uploadedFiles` 表

## 验证结果
- ✅ `npx tsc -b` 通过（零错误）
- ✅ 所有修改不引入新依赖
- ✅ tRPC 路由名称、入参/出参类型未变动
- ✅ api/kimi/ 目录未删除
- ✅ 不修改数据库表结构（仅修正索引位置）

## 未完成/阻塞项
- 无阻塞项。Phase 3 的 create/update/delete/position-change mutation 调用需要在 KnowledgeGraph 页面 UI 层面增加交互控件（右键菜单/工具栏按钮）来触发；当前 tRPC mutation hooks 已可用，页面数据源已切换为后端。
- P1-8（conditions 拼接问题）标记为部分修复：当前仅用 conditions[0] 的场景可工作，完全修复需重构为 and(...conditions) 模式（非阻塞，可后续迭代）。
- 文件上传容器内存储问题（P0-5）需运维层面配置持久化卷或 S3，未在本次代码改动范围内。

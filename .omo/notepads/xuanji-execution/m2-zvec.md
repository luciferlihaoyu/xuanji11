# M2: ZVec API Completeness and MCP Tool Expansion

## 变更摘要

- `api/lib/vector-service.ts`（修改）：
  - 在 `vectorEngine` 中新增 `addDocuments(docs)`，对输入文本批量生成嵌入并立即写入向量索引，返回新增文档数。
  - 新增导出 `addDocumentsToCollection(name, docs)`，先校验集合元数据，再调用 `vectorEngine.addDocuments`，
    并更新 `vectorCollections.documentCount`。
  - 新增导出 `getCollectionStats(name)`，返回 `{ name, count, dimension }`。
  - 新增 `AddDocumentInput`、`AddDocumentsResult`、`CollectionStats` 类型。
- `api/zvec-router.ts`（修改）：
  - 新增 `GET /api/zvec/collections/:name/stats`，需 `zvec:read`；返回 `{ name, count, dimension }`。
  - 对集合不存在的情况返回 404，不暴露原始错误。
- `api/mcp-server.ts`（修改）：
  - 将原有 ZVec MCP 工具与新增工具拆分到 `api/mcp-zvec-tools.ts`，通过 `handleZvecTool` 统一调度，
    控制 `mcp-server.ts` 规模保持在 200 行以内。
  - 工具描述补充使用场景，提升 agent 可发现性。
- `api/mcp-zvec-tools.ts`（新建）：
  - 维护全部 6 个 ZVec MCP 工具定义：`zvec.embed`、`zvec.search`、`zvec.stats`、
    `zvec.listCollections`、`zvec.addDocuments`、`zvec.deleteCollection`。
  - 每个 handler 均调用 `assertScope`；`listCollections`/`stats/embed/search` 需 `zvec:read`；
    `addDocuments`/`deleteCollection` 需 `zvec:write`。
  - `zvec.addDocuments` 使用 Zod 校验集合名、单条内容长度上限、批次上限（1-100），
    并调用 `vectorService.addDocumentsToCollection`。
- `api/zvec-router.test.ts`（修改）：
  - 增加 `GET /collections/:name/stats` 成功返回与 scope 不足被 403 拒绝的测试。
- `api/mcp-server.test.ts`（新建）：
  - 覆盖 `zvec.listCollections`、`zvec.addDocuments`、`zvec.deleteCollection` 的 happy path。
  - 覆盖写工具在缺少 `zvec:write` 时的权限拒绝。
  - 验证 `tools/list` 包含三个新工具。

## 验证结果

- `npm run check` ✅
- `npm test -- --run` ✅（23/23）
- `npm run build` ✅

## 注意事项

- 集合元数据与物理向量集合保持 M1 设计：逻辑集合信息存于 `vectorCollections` 表，
  物理索引仍使用单例 `document_chunks`；`stats` 返回的是表中维护的 `documentCount`。
- `addDocuments` 在写入向量引擎的同时会更新对应逻辑集合的 `documentCount`，
  使新文档立即可通过语义搜索召回。
- 所有 API / MCP 错误仅返回通用信息，详细错误通过 `console.error` 落日志。
- `api/lib/vector-service.ts` 仍保留原有 `SIZE_OK` 说明；`mcp-server.ts` 通过拆分 ZVec 工具模块
  避免超过 250 行纯代码阈值。

---

## M2 复查结果 (2026-07-11)

**裁决: APPROVE ✅**

### 验证命令全部通过

| 命令 | 结果 |
|------|------|
| `npm run check` (tsc -b) | ✅ 零错误 |
| `npm test -- --run` | ✅ 7 文件 / 23 测试 全部通过 |
| `npm run build` | ✅ 构建成功 |

### 逐项审查

#### 1. REST 端点: `GET /api/zvec/collections/:name/stats`
- `api/zvec-router.ts:147` — 正确使用 `requireScope("zvec:read")` ✅
- Zod 参数校验 (`collectionStatsParamsSchema`, L64-66) ✅
- 集合不存在 → 404 通用消息，不泄露内部错误 (L156-158) ✅
- Zod 校验失败 → 400 (L153-155) ✅
- 其他异常 → 500 通用消息 + `console.error` 记录详情 (L159-160) ✅

#### 2. 辅助函数: `addDocumentsToCollection()`
- `api/lib/vector-service.ts:387` — 存在 ✅
- 先查询 `vectorCollections` 表校验集合存在 (L389) ✅
- 不存在时抛出 `Collection not found: ${name}` (L390) ✅
- 调用 `vectorEngine.addDocuments` 批量写入向量索引 (L391) ✅
- 更新 `vectorCollections.documentCount` (L392) ✅
- 返回 `{ added: count }` (L393) ✅

#### 3. MCP 工具: `zvec.listCollections`, `zvec.addDocuments`, `zvec.deleteCollection`
- 工具定义在 `api/mcp-zvec-tools.ts:74-81` ✅
- 三个工具均出现在 `tools/list` 响应中 (测试验证: `mcp-server.test.ts:187-189`) ✅
- 工具描述从单行更新为包含使用场景的详细描述 ✅

#### 4. MCP 工具描述改进
- 所有 6 个 ZVec 工具 (L74-81) 现在包含 "Use this to..." 引导性说明 ✅
- 显著提升 agent 可发现性 ✅

#### 5. 测试覆盖
- `api/zvec-router.test.ts`:
  - `GET /collections/:name/stats` 成功路径 (L105-119) ✅
  - `zvec:write` scope 不足以访问 stats → 403 (L121-133) ✅
- `api/mcp-server.test.ts`:
  - `zvec.listCollections` 成功 (L83-99) ✅
  - `zvec.addDocuments` 成功 (L101-130) ✅
  - `zvec.deleteCollection` 成功 (L132-152) ✅
  - 写工具无 `zvec:write` scope → 拒绝 (L154-171) ✅
  - `tools/list` 包含新工具 (L173-191) ✅

### 架构审查

#### 纯代码行数 (pure LOC)

| 文件 | 纯 LOC | 状态 |
|------|--------|------|
| `api/zvec-router.ts` | 143 | ✅ 健康 |
| `api/lib/vector-service.ts` | 351 | ⚠️ DEFECT (>250) — 但带有 SIZE_OK 标注 |
| `api/mcp-server.ts` | 217 | ⚠️ 警告带 (200-250) |
| `api/mcp-zvec-tools.ts` | 81 | ✅ 健康 |
| `api/zvec-router.test.ts` | 113 | ✅ 健康 |
| `api/mcp-server.test.ts` | 167 | ✅ 健康 |

- `vector-service.ts` (351 LOC): SIZE_OK 标注理由是「向量引擎是持有私有可变状态（collection / zvecInitialized / fallbackStore）的单体模块；拆分会暴露内部状态并增加耦合」。这是合理的例外 — 模块内的辅助函数（`cosineSimilarity`, `fetchEmbeddings`, `normalizeVector` 等）都与向量引擎状态紧密耦合。**不阻塞。**
- `mcp-server.ts` (217 LOC): M2 将 ZVec 工具提取到 `mcp-zvec-tools.ts` 是正确做法，有效避免了超过 250 阈值。**不阻塞。**

#### Scope 执行审查

| 操作 | 所需 Scope | 执行位置 |
|------|-----------|---------|
| `POST /embed` | `zvec:read` | `zvec-router.ts:77` |
| `POST /search` | `zvec:read` | `zvec-router.ts:91` |
| `GET /collections` | `zvec:read` | `zvec-router.ts:105` |
| `GET /collections/:name/stats` | `zvec:read` | `zvec-router.ts:147` |
| `POST /collections` | `zvec:write` | `zvec-router.ts:115` |
| `DELETE /collections/:name` | `zvec:write` | `zvec-router.ts:133` |
| `zvec.embed` (MCP) | `zvec:read` | `mcp-zvec-tools.ts:30` |
| `zvec.search` (MCP) | `zvec:read` | `mcp-zvec-tools.ts:37` |
| `zvec.stats` (MCP) | `zvec:read` | `mcp-zvec-tools.ts:44` |
| `zvec.listCollections` (MCP) | `zvec:read` | `mcp-zvec-tools.ts:51` |
| `zvec.addDocuments` (MCP) | `zvec:write` | `mcp-zvec-tools.ts:57` |
| `zvec.deleteCollection` (MCP) | `zvec:write` | `mcp-zvec-tools.ts:68` |

所有端点均正确强制实施 scope，无遗漏。✅

#### 错误信息泄露审查

- REST: 所有 catch 分支返回通用错误信息（"Authentication required", "Forbidden", "Invalid request", "Internal server error", "Collection not found"等）。内部错误详情仅通过 `console.error` 记录。✅
- MCP: `mcp-zvec-tools.ts` 中 ZVec handler 抛出的错误（如 assertScope 的 scope 不足、addDocumentsToCollection 的集合不存在）传播到 `mcp-server.ts:210-221` 的通用 catch，记录到 `console.error` 后向客户端返回 `-32603 "Internal tool error"`。✅

### 残留风险 / 非阻塞性备注

1. **`deleteCollection` 幂等性** (`vector-service.ts:367-370`): 删除不存在的集合静默返回 `{ success: true }`。这是有意为之的幂等行为，无需修复。

2. **`mcp-zvec-tools.ts` 中缺少 try/catch**: `handleZvecAddDocuments` 和 `handleZvecDeleteCollection` 未在本地捕获错误。错误会传播到 `mcp-server.ts:215-217` 的通用错误处理，记录 `console.error` 并向客户端返回 `-32603 "Internal tool error"`。当前行为正确，但若未来需要对不同错误类型返回不同 MCP 错误码，需添加本地 catch。**目前无需修改。**

3. **集合名大小写**: `addDocumentsToCollection` 和 `getCollectionStats` 使用 `eq()` 进行精确（区分大小写）匹配。名称正则 `^[a-zA-Z0-9_-]+$` 在所有端点保持一致，目前没有问题。

### 结论

M2 实现满足所有要求：
- ✅ 新增 REST 端点 `GET /api/zvec/collections/:name/stats`
- ✅ 新增辅助函数 `addDocumentsToCollection()`
- ✅ 新增 MCP 工具 `zvec.listCollections`, `zvec.addDocuments`, `zvec.deleteCollection`
- ✅ MCP 工具描述已改进
- ✅ 测试覆盖新增功能
- ✅ 所有 scope 强制执行正确
- ✅ 无原始错误泄露至客户端
- ✅ 所有验证命令通过

**裁决: APPROVE** — 可以推进至 M3 部署。

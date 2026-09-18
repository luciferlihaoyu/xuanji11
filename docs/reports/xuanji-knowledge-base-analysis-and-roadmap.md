# 璇玑个人知识库：现状评估与完善路径

> 版本：v1.0 ｜ 日期：2026-09-18 ｜ 视角：统筹（碧霄）
> 依据：**仓库代码实地核实**（每条"已有"结论均附文件位置）+ **官方文档调研**（`docs/research/knowledge-base-product-analysis.md`，149 条带官方 URL 的事实）
> 纪律：本文不写"看起来应该有"的功能。凡标"已实现"必在代码中核对过；凡标"缺口"必是检索后确认不存在。

---

## 0. 结论摘要

**璇玑已经越过"要补 RAG"的阶段。** 检索、问答、审核、备份四条主线都已有真实实现，且若干设计（强制引用、证据不足拒答、入库监控、审核收件箱）比多数开源知识库更克制、更可信。

所以下一阶段的资源**不应该**投在：

- ❌ 从零搭 RAG
- ❌ 更换向量数据库
- ❌ 继续加新页面

而应该投在四处**真实缺口**：

| # | 缺口 | 一句话症状 |
|---|------|-----------|
| 1 | **引用不可定位** | 回答带 `[1]`，但点不出"出自哪一段、哪个版本、匹配度多少" |
| 2 | **检索改动无回归保护** | 没有评测集；问答链路 `rerank` 被硬编码关闭，改参数无法自证好坏 |
| 3 | **MCP 工具面不合规** | 15 个工具无 annotations / 分页 / 发现机制；长任务返回值里没有可轮询的任务句柄 |
| 4 | **缺"空间"抽象与主动治理** | 用户要自己拼文件夹+向量集合+Agent+权限；连接器无自动同步；无重复/冲突/过期扫描 |

**推荐路线（三阶段九项）**：P0 四件（引用可定位、检索测试台+评测集、MCP 现代化、任务句柄统一）→ P1 三件（知识空间、scoped key+执行分级、增量同步）→ P2 两件（知识健康、可观测性闭环）。

---

## 1. 现状盘点（代码核实）

### 1.1 已实现能力

| 能力 | 实现位置 | 成熟度 | 关键事实 |
|------|----------|--------|----------|
| 混合检索 | `api/lib/hybrid-search.ts` | ★★★★☆ | 关键词 + 向量双路，RRF 融合；可选 LLM 重排（`rerank` 显式开启，失败静默回退到 RRF 原序） |
| 检索返回结构 | 同上 `SearchResult`/`SearchResponse` | ★★★★☆ | 每个结果带 `score`、`sources[]`（命中来源）、`reasons[]`（命中原因）、`evidence[]`（多片段）；响应带 `facets`（type/tag/folder 计数）与 `metadata`（mode/total/keywordResults/vectorResults/durationMs/cached） |
| 引用式问答 | `api/lib/ask-rag.ts` | ★★★★★ | 强制 `[n]` 引用；`MIN_EVIDENCE=2` 证据不足直接拒答；只保留答案里**真正引用过**的条目（`usedCitations` 过滤）；区分"知识库原文/模型归纳" |
| 流式问答 | `api/ask-stream-router.ts` | ★★★★☆ | SSE 事件序列 `citations → token×N → result`（含 citations/insufficient/evidenceCount/model） |
| 搜索与问答前端 | `src/pages/SearchResults.tsx`（471 行） | ★★★★☆ | 已展示匹配度分数、命中原因、多命中片段、关键词/向量命中计数、引用列表、证据条数与模型名 |
| 入库监控 | `src/pages/IngestionPage.tsx` + `api/ingestion-router.ts` | ★★★★☆ | 任务总数/运行中/已完成/失败 + 进度条 + 任务级与条目级状态徽章（`ingestion_jobs`/`ingestion_items`） |
| 审核收件箱 | `src/pages/ReviewInbox.tsx` + `api/review-router.ts` | ★★★★☆ | 待处理/已通过/已驳回/已忽略；含"反馈评估报告"（自动边删除率、收件箱通过率、分拣建议准确率） |
| 幂等与版本 | `db/schema.ts` | ★★★★★ | `kb_ingestion_keys.idempotencyKey` 唯一约束（sha256(source\|externalId\|contentHash)）+ `kb_document_versions`（versionNumber/contentHash/changedBy）→ 重复导入不产生脏数据 |
| 备份 | `api/backup-repositories/*` | ★★★★★ | 每次运行独立 UTC 时间戳快照目录 + `manifest.json` + 保留最近 N 份自动清理 + 可选加密；**本会话线上实证**（定时任务自动产出快照、远端旧版本被真删） |
| MCP 接口 | `api/mcp-server.ts` | ★★★☆☆ | 15 个工具：folder_list/create、document_read/write/upsert/set_folder/delete、knowledge_search/create、workflow_list/execute、backup_list/trigger、kb.reindex_all/status |
| 权限 | `api/middleware.ts` + `api_keys` | ★★★★☆ | tRPC 三级鉴权（public/authed/admin）+ Agent API Key 继承 7 项细粒度权限（读/写/删/管理/触发工作流/执行工作流/设计工作流） |
| 审计与分析 | `api/audit-router.ts`、`api/analytics-router.ts`、`kb_search_events` | ★★★☆☆ | 有审计日志页与分析台；检索事件已落表 |

### 1.2 真实缺口（逐条附证据）

| # | 缺口 | 代码证据 |
|---|------|----------|
| G1 | 引用只到文档级，**不可定位到段落** | `AskCitation` 仅 `{n, documentId, title, snippet}`（`api/lib/ask-rag.ts:12-17`）——无 versionId、无段落锚点/页码、无分数 |
| G2 | 问答链路**重排被硬关** | `askKnowledgeBase` 调检索时写死 `rerank: false`（`api/lib/ask-rag.ts:43`）；重排在 `hybrid-search.ts:344` 只有显式开启才跑 |
| G3 | **无检索评测集与回归基线** | 全仓检索无 golden set / recall@k / MRR 相关实现 |
| G4 | MCP 工具**无注解、无分页、无发现** | 工具定义只有 `name/description/inputSchema`（`api/mcp-server.ts:76-80`），无 `annotations`、无 cursor 分页、无 discover |
| G5 | **长任务句柄不统一** | `kb.reindex_all` 已带后台 + `kb.reindex_status` 轮询（较好），但 `backup_trigger` 只返回 `{success, scheduledJobId}`（`api/mcp-server.ts:333-338`），Agent 拿不到可轮询的任务 id |
| G6 | **无"知识空间"抽象** | 无空间/工作区表；范围=文件夹，策略（检索模式/重排/权限/Agent）散落在各处配置 |
| G7 | **连接器无自动同步排程** | `api/datasource-router.ts`、`api/connectors/*`、`api/ingestion-router.ts` 中检索不到 cron/schedule/autoSync |
| G8 | **无主动知识治理** | 无重复/冲突/过期/孤立扫描；`kb_search_events` 有数据但未形成质量指标 |
| G9 | 无 scoped API Key | `api_keys` 只绑定 Agent，不能按空间/数据集收窄作用域 |

---

## 2. 架构评估

### 2.1 当前分层（代码图谱实测）

用代码知识图谱对 306 个文件、2536 个节点、27106 条边做社区检测，得到 19 个社区与 12 处高耦合告警，其中三处最值得处理：

| 耦合 | 边数 | 含义与风险 |
|------|------|-----------|
| `api-fake`(564 节点) ↔ `lib-vector`(620 节点) | 272 | 路由层与检索/向量层深度交织，检索逻辑分散在多处 |
| `ui-menu`(362) ↔ `lib-storage`(261) | 261 | 页面直接关心存储/上传细节 |
| `api-fake` ↔ `queries-db`(7) | 87 | 路由层承担了过多数据编排 |

> 注：社区名由图谱按文件簇自动生成（`api-fake` 含 `api/*router.ts` 与测试；`lib-vector` 含 `api/lib/*` 检索与向量实现）。

**这不是"代码烂"，而是"缺少领域层"的信号。** 最直接的证据就是 G2：检索参数本应集中在一处策略里，实际却在 `ask-rag.ts` 里按调用方硬编码。

### 2.2 建议的目标分层

```
UI（页面只做呈现 + 参数收集）
        │  tRPC / REST / SSE / MCP
        ▼
应用层（编排用例：search / ask / ingest / backup / agent-task）
        │
┌───────┼──────────────┬──────────────┐
▼       ▼              ▼              ▼
Knowledge   Retrieval      Agent Runtime     Task/Job
Domain      Domain         Domain            Domain
文档/版本    kw/vec/hybrid  tool/plan/approve 任务句柄/进度/重试
/幂等       /rerank/评测   /audit/rollback   /取消
└───────┴──────────────┴──────────────┘
        ▼
数据与基础设施：SQLite/MySQL · 文件存储 · 向量库(Zvec) · 网盘(AList)
```

关键约束（避免重蹈覆辙）：

1. **检索只有一个入口**（`RetrievalService`）：搜索页、问答、MCP、工作流都调它，参数由策略对象决定，禁止调用方硬编码。
2. **路由层只做鉴权、校验、转调**，编排逻辑下沉到 `api/lib/*`。
3. **Agent 不直接碰数据库**：所有写操作经过领域服务，天然带审计与版本。
4. **原文 / 知识 / 索引三层分离**：索引可重建，知识可溯源，原文不可变。

---

## 3. 对标：值得抄的六件事（附官方来源）

| 来源 | 值得抄的点 | 官方链接 |
|------|-----------|----------|
| **Dify** | 把检索做成可配置的"知识检索节点"（知识库选择/过滤/混合检索/rerank/结果上下文），并提供**测试与生产同端点**的检索测试台 | [Knowledge Retrieval](https://docs.dify.ai/en/cloud/use-dify/nodes/knowledge-retrieval)、[Workflow Tools](https://docs.dify.ai/en/learn/tutorials/workflow-101/lesson-07) |
| **AnythingLLM** | 工作区（Workspace）概念把"文档范围 + 对话 + Agent 工具"绑成一体；零配置内置嵌入器，开箱即用 | [官方文档](https://docs.anythingllm.com/) |
| **Obsidian** | 原文优先：落盘 Markdown + frontmatter 属性 + 双向链接；未解析链接天然是"待建页"待办；官方同步自带版本历史 | [数据存储](https://obsidian.md/help/data-storage)、[反向链接](https://obsidian.md/zh/help/plugins/backlinks)、[版本历史](https://obsidian.md/help/sync/version-history) |
| **AFFiNE** | 文档/白板/数据库/AI 在同一知识空间；AI 围绕用户原始内容工作，不夺走所有权 | [Knowledge Base](https://affine.pro/solutions/knowledge-base) |
| **LlamaIndex** | Agent 是**有状态工作流**（分阶段、可交接、可追踪），不是一问一答 | [AgentWorkflow](https://www.llamaindex.cloud/blog/introducing-agentworkflow-a-powerful-system-for-building-ai-agent-systems)、[Workflows 1.0](https://www.llamaindex.ai/blog/announcing-workflows-1-0-a-lightweight-framework-for-agentic-systems) |
| **MCP 规范（2026-07-28）** | 工具注解（只读/破坏性/幂等提示）、结果可缓存与确定性排序、cursor 分页、长任务走 Tasks 扩展 | 见调研报告 §9 来源汇总：`docs/research/knowledge-base-product-analysis.md` |

> 其余五套系统（Outline / RAGFlow / Open WebUI / LangChain / 旧版 MCP）的逐项分析与 149 条官方引用，见配套调研报告。

---

## 4. 完善路径

### P0-1 引用可定位（Citation 2.0）

| 项 | 内容 |
|---|---|
| **目标** | 每条回答引用可一键跳回原文对应段落，并显示版本与匹配度 |
| **现状** | `AskCitation{n,documentId,title,snippet}`（`api/lib/ask-rag.ts:12-17`） |
| **做法** | ① 扩展为 `{n, documentId, versionId, title, snippet, anchor:{heading?, chunkIndex, charStart, charEnd}, score, retrievedBy[]}`；② 复用 `SearchResult.evidence`（已含片段级信息）；③ 引用条目在 `SearchResults.tsx` 变可点击链接 → `DocumentDetail` 定位并高亮段落 |
| **代码落点** | `api/lib/ask-rag.ts`、`api/ask-stream-router.ts`、`src/pages/SearchResults.tsx`（引用渲染块）、`src/pages/DocumentDetail` |
| **验收** | 单测：构造含重复片段的文档，断言引用必带 `anchor.charStart`；线上：问答后点引用能高亮到正确段落；`insufficient=true` 时引用列表为空 |

### P0-2 检索测试台 + 评测集（改检索的前提）

| 项 | 内容 |
|---|---|
| **目标** | 改任何检索参数前后，能用同一评测集自证召回是否变好 |
| **做法** | ① UI 测试台：mode（kw/vec/hybrid）、topK、过滤器、rerank 开关、并排显示 keyword/vector/RRF/rerank 分数与耗时、一键"把这次查询存为测试用例"；② 评测集：黄金集（查询 → 期望文档 id 列表），跑 recall@5 / MRR 出趋势；③ 用 `kb_search_events` 的真实查询做回归样本；④ 把 `ask-rag.ts:43` 的硬编码 `rerank:false` 改为读取检索策略，默认值由测试台结论决定 |
| **代码落点** | `api/lib/hybrid-search.ts`（导出评分明细）、新增 `api/lib/search-eval.ts`、新增评测表、`src/pages/SearchTestbed.tsx`、`api/search-router.ts` |
| **验收** | 同一评测集在 rerank 开/关下给出两份 recall@5 报告；测试台显示的融合分数与 API 返回一致（单测断言） |

### P0-3 MCP 工具现代化（Agent 稳定性）

| 项 | 内容 |
|---|---|
| **目标** | Agent 能判断工具风险、能分页、能正确处理长任务 |
| **现状** | 15 工具无 `annotations`、无 cursor 分页（`api/mcp-server.ts:76-80`） |
| **做法** | ① 每个工具补 `annotations: {title, readOnlyHint, destructiveHint, idempotentHint}`（如 `document_delete` = destructive，`knowledge_search` = readOnly）；② `folder_list`/`backup_list`/`workflow_list` 加 cursor 分页；③ 引入工具发现（按命名空间 `kb.* / doc.* / backup.* / task.*` 分组）；④ 破坏性工具支持 `dryRun` |
| **验收** | MCP inspector 能读到全部注解；>50 条时返回 `nextCursor` 且可翻页；`dryRun:true` 的删除调用不改变数据（单测） |

### P0-4 长任务句柄统一（Task 视图）

| 项 | 内容 |
|---|---|
| **目标** | 任何长任务（重建索引/备份/入库/工作流）都返回统一 `taskId`，可查询、可取消、可看到阶段进度 |
| **现状** | `kb.reindex_all` + `kb.reindex_status` 已是异步轮询（较好）；`backup_trigger` 只返回 `{success, scheduledJobId}`（`api/mcp-server.ts:333-338`）；入库单列 `ingestion_jobs/items` |
| **做法** | ① 建统一 Task 视图（聚合 reindex_all / backup run / ingestion_job / workflow_run）；② 新增 MCP 工具 `task_get`、`task_cancel`；③ `backup_trigger` 返回 `{taskId, status}`；④ UI 增加"任务中心"页，一处看全部长任务 |
| **验收** | Agent 触发备份后能拿到 taskId 并轮询到 `completed`；线上实测一次（本会话已验证调度器可自动跑，此处只补句柄层） |

### P1-1 知识空间（Space）：傻瓜式的主抓手

| 项 | 内容 |
|---|---|
| **目标** | 用户说一句"建一个研发空间"，系统自动把目录/检索策略/Agent/权限/工作流/同步规则一次配好 |
| **做法** | ① 新增 `kb_spaces` 表（范围=文件夹集合、检索策略=默认 mode/topK/rerank、权限、默认 Agent、绑定的工作流与同步规则）；② 提供 6 个模板（个人/工作项目/研发/学习/阅读/会议）；③ 所有列表与检索默认按空间过滤 |
| **验收** | 新用户 5 分钟内完成"建空间 → 导入 → 问答"，全程不需要接触 embedding/向量库/rerank 概念 |

### P1-2 作用域 Key 与执行分级

| 项 | 内容 |
|---|---|
| **目标** | Agent 最小权限；高风险动作先预览、需确认、可撤销 |
| **现状** | 已有 7 项 Agent 权限与 `kb_review_items` 审核流（`src/pages/ReviewInbox.tsx`）——**审核这一环已有基础设施，不必重造** |
| **做法** | ① `api_keys` 增加 scope（空间/数据集白名单）；② 工具调用分级：只读直接执行、低风险写自动执行但可撤销、高风险写生成"计划 + 预览 diff"进审核收件箱；③ 每次 Agent 执行落审计并附回滚句柄 |
| **验收** | 越界 scope 的调用返回 403；高风险写操作在收件箱可见 diff 且被驳回后数据未变 |

### P1-3 增量同步（把外部资料接进来）

| 项 | 内容 |
|---|---|
| **目标** | AList/数据源变更自动入库，不重复、不产生脏数据 |
| **现状** | `kb_ingestion_keys` 已有幂等唯一键（sha256(source\|externalId\|contentHash)）打底；但连接器无排程（G7） |
| **做法** | ① 给数据源加同步排程（复用备份调度器的 `nextCronTime` 与运行记录模式）；② 同步时用 contentHash 判定新增/变更/删除；③ 冲突策略（同名不同内容）默认"新建版本 + 标记冲突"，不覆盖 |
| **验收** | 同一目录连续同步两次，文档数不变（幂等）；修改一个文件后仅该文件产生新版本 |

### P2-1 知识健康扫描

| 项 | 内容 |
|---|---|
| **做法** | 定期任务扫描：完全重复（同 contentHash）、近似重复（分块相似度）、冲突事实、长期未更新、孤立节点（无入边无出边）、引用完整性 |
| **原则** | **只发现、只建议，绝不自动改正式知识**；建议项进审核收件箱 |
| **验收** | 扫描报告给出各类问题数量与可点击清单；用户确认后才执行合并/归档 |

### P2-2 可观测性闭环

| 项 | 内容 |
|---|---|
| **做法** | 在已有 `kb_search_events` / `audit_logs` / 分析台基础上补：检索质量指标（命中率、零结果率、点开率、采纳率）、token 用量与花费、长任务耗时分布 |
| **验收** | 分析台能回答"这周哪些查询零结果""重排开启后采纳率是否上升" |

---

## 5. 交互设计：一脑双面

同四块基础设施同时支撑普通用户与 Agent：**检索测试台、引用溯源、任务状态、审计与审批**。

### 5.1 傻瓜式（普通用户）

1. **默认值必须开箱即正确**：检索模式默认"自动推荐"，不暴露 topK/chunk/rerank。
2. **进度可视化**：入库监控已有（`IngestionPage`），扩展到"任务中心"覆盖全部长任务。
3. **一键兜底**：解析失败可一键重试；索引损坏可一键重建；数据可一键整库导出。
4. **模板化**：空间模板取代 7 个配置页的组合拳。
5. **自然语言操作**：支持"把这批资料归到旅行空间""找出互相矛盾的备份配置"，系统先出**可预览计划**再执行。
6. **引用默认可见**：回答下方直接列出出处（当前已列标题，P0-1 后补段落跳转）。
7. **能力边界明示**：每个 Agent 页面写清"能做 / 不能做 / 需确认"。

### 5.2 Agent-first（智能体）

1. **规范的工具面**：注解 + 分页 + 发现 + dry-run（P0-3）。
2. **最小权限**：scoped key，越界即 403。
3. **全程溯源**：每次调用可回放到"谁、用什么 key、读了哪些文档、改了哪条版本"。
4. **长任务有句柄**：统一 `taskId`（P0-4）。
5. **高风险走审批**：复用已有审核收件箱，不另造一套。
6. **引用可验证**：Agent 拿到的证据同样带锚点与分数，可自检。
7. **失败可重试且幂等**：依赖已有 `idempotencyKey`，重放安全。
8. **不给直连数据库的口子**：所有写经领域服务与版本表。

---

## 6. 实施纪律（沿用本项目已验证的做法）

1. 每项改动走 **RED → GREEN → REFACTOR**：先写失败测试，再写实现。
2. 类型检查与构建：`npx tsc --noEmit` + `npx vite build` 必须干净。
3. 测试：本容器只跑**单文件** vitest（<30s）；全量套件不在本容器跑（见作业规矩）。
4. 上线：`github_push` → Zeabur 自动部署 → 等 `RUNNING` → **线上实测**（不接受"编译通过即完成"）。
5. 复核：独立子代理做两阶段审查（先规格符合度、后代码质量），critical 先修再收。
6. 结论当场写记忆（`mcp__xuanji__write_memory`，project=`dsh`），教训标 `lesson`、决策标 `decision`。

---

## 7. 不建议做的事（避坑清单）

| 不做 | 原因 |
|------|------|
| 立刻更换向量数据库 | 当前瓶颈不在库，而在评测缺失、引用不可定位、参数分散（G1-G3） |
| 继续新增孤立页面 | 新功能若说不清"用哪类知识 / 是否进统一检索 / Agent 怎么调 / 权限如何 / 能否备份"，就先别做页面 |
| 让 Agent 直连数据库 | 绕过版本与审计，等于放弃可回滚性 |
| 让系统自动"整理知识" | 自动改标题/合并/删除极易造成不可逆损失；一律"发现 → 建议 → 确认 → 执行 → 可撤销" |
| 把向量库当主数据源 | 原文必须始终是权威来源，索引随时可重建 |

---

## 8. 附录

- 配套调研报告（149 条官方 URL、8 产品×10 维度矩阵）：`docs/research/knowledge-base-product-analysis.md`
- 原始四路研究笔记：`docs/research/.notes/batch-{a-pkm,b-rag,c-dify,d-frameworks-mcp}.md`
- 历史代码审计：`ANALYSIS_REPORT.md`、`XUANJI_IMPROVEMENT_SPEC.md`
- Agent 接入说明：`docs/AGENT_API.md`
- 本文所有"已实现"结论的核对文件：`api/lib/hybrid-search.ts`、`api/lib/ask-rag.ts`、`api/ask-stream-router.ts`、`api/search-router.ts`、`api/mcp-server.ts`、`api/ingestion-router.ts`、`api/review-router.ts`、`db/schema.ts`、`src/pages/{SearchResults,IngestionPage,ReviewInbox}.tsx`

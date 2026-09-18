# 璇玑个人知识库完善调研：傻瓜式操作与 Agent 操作

> 调研人：博士（三仙岛·研究）｜ 日期：2026-09-18 ｜ 版本：v1.0
> 调研问题：璇玑智脑（xuanji11）个人知识库如何完善，同时做到「傻瓜式操作」（普通用户零门槛）与「Agent 操作」（智能体可稳定读写）。
> 方法：联网检索（web_search 多轮），仅采信**官方文档 / 官方 GitHub 仓库 / 官方规范站点**；四路并行研究（个人 PKM、开箱即用 RAG、Dify、框架与协议标准）+ 交叉复核；关键事实逐条附官方 URL；官方来源查不到的一律标【未核实】。检索窗口截至 2026-09。
> 底稿：四路原始笔记存于 `docs/research/.notes/batch-{a-pkm,b-rag,c-dify,d-frameworks-mcp}.md`，本报告为汇总与提炼。

---

## 1. 评估框架：十个维度

围绕「傻瓜式操作」与「Agent 操作」两条主线，定义十个评估维度：

| # | 维度 | 关键问题 |
|---|------|----------|
| D1 | 信息模型 | 知识的组织单元是什么（文件/块/数据集/工作区）？粒度、层级、元数据、版本如何表达？ |
| D2 | 检索 / RAG | 关键词、向量、混合检索；分块策略与默认值；重排序；检索质量自测工具 |
| D3 | 引用与溯源 | 答案能否回指原文档/片段？版本与来源记录是否可审计？ |
| D4 | 导入与同步 | 从外部系统（网盘、Notion、网页等）导入的路径；增量同步与幂等 |
| D5 | 权限 | 多用户/角色/资源级权限；API 令牌的权限边界 |
| D6 | Agent 工具协议 | REST/MCP 等机器接口的覆盖度、稳定性、工具注解与发现机制 |
| D7 | 工作流 | 编排能力；知识库操作能否作为流程节点被触发 |
| D8 | 备份 | 快照/导出/恢复；保留策略；备份的可验证性 |
| D9 | 可观测性 | 日志、用量统计、tracing、审计 |
| D10 | 易用性 | 安装引导、默认值质量、中文支持、开箱体验 |

两条主线的操作性定义：

- **傻瓜式操作**：用户不读文档也能完成导入→检索→问答→备份闭环；出错信息可行动；默认值开箱即正确。
- **Agent 操作**：机器接口覆盖知识全生命周期（发现/读/写/删/检索/回滚），权限可最小化授予，每次操作可溯源可审计，长任务有异步语义。

---

## 2. 璇玑智脑现状基线

（本节基于仓库 `xuanji11` 当前代码与文档快照，作为产品对照的基准。）

### 2.1 已有能力

- **技术栈**：React 19 + Hono + tRPC 11 + MySQL(Drizzle) + Zvec 向量库（`@zvec/zvec`，维度可配，默认 1536），部署于 Zeabur（README「技术栈」）。
- **信息模型**：`kb_folders`/`kb_documents`（含 `tags`、`metadata`、软删 `deletedAt/deletedReason`、合并标记 `mergedIntoId`）；独立文档版本表（`versionNumber`、`contentHash`、`changedBy`、`changeReason`）；写入幂等键（`idempotencyKey` + `source` + `externalId`）；知识图谱 `knowledge_nodes/edges`；`workflows/workflow_nodes`；`data_sources`；`vector_collections`；`backup_jobs`。
- **检索**：关键词（DB 检索）+ 向量（Zvec）双路，Reciprocal Rank Fusion 融合，提供 keyword/vector/hybrid 三种模式（`api/mcp-hybrid-search.ts`）。
- **Agent 接入**：Agent API Key（`xu_sk_` 前缀，继承 Agent 的 7 项细粒度权限：读/写/删/管理/触发工作流/执行工作流/设计工作流）；tRPC REST 端点；MCP server（`api/mcp-server.ts`）已暴露 15 个工具：`folder_list`、`folder_create`、`document_read`、`document_write`、`document_upsert`、`document_set_folder`、`document_delete`、`knowledge_search`、`knowledge_create`、`workflow_list`、`workflow_execute`、`backup_list`、`backup_trigger`、`kb.reindex_all`、`kb.reindex_status`（docs/AGENT_API.md「MCP 协议连接」）。
- **导入/连接器**：AList 网盘连接器（工作目录限定、浏览导入、文本自动分块向量化）；数据源（云盘/NAS/API）；多格式文件上传。
- **备份**：快照式全量备份到本地/NAS/AList（REST 协议），UTC 时间戳快照目录 + `manifest.json`，保留最近 N 份自动清理，可选加密（`BACKUP_ENCRYPTION_KEY`）。
- **天宫联动**：任务完成记忆自动写入（带 `traceId` 溯源）；Agent 可经 `searchContext` 检索知识库作为任务上下文。
- **安全基线**：tRPC 路由三级鉴权（public/authed/admin）、bcrypt 密码、JWT 会话、登录限速、结构化日志、`/health` 健康检查、Docker HEALTHCHECK（README；XUANJI_IMPROVEMENT_SPEC.md）。

### 2.2 初步缺口（经产品对照后在 §7 细化为路线图）

1. **检索质量无自证工具**：有融合检索，但缺「检索测试台」（输入查询→看命中片段与分数），用户与 Agent 都难判断召回好坏。
2. **引用与溯源在问答链路中缺产品化**：`ask-stream-router` 存在，但回答附来源片段/分数的机制未见产品化定义。
3. **导入同步的增量与冲突语义**：有幂等键与版本表打底，但 AList 重导入、网页抓取等连接器的自动同步未见排程。
4. **MCP 工具面偏「CRUD」**：缺只读检索类工具的注解（readOnlyHint）、缺资源（Resources）化暴露、缺长任务（备份/重建索引）的异步任务语义。
5. **可观测性**：有日志与审计路由（`analytics-router`/`audit-router`），缺 token 用量、检索质量指标、tracing。

---

## 3. 产品逐项分析

### 3.1 Obsidian —— 傻瓜式的天花板，Agent 接入的洼地

**信息模型（D1）**
- vault 即本地文件夹：笔记、附件、配置全部是落盘纯文本 Markdown，无数据库锁定，任何工具（grep/git/Agent）共用同一真实来源 —— [How Obsidian stores data](https://obsidian.md/help/data-storage)
- frontmatter 属性（YAML）构成结构化字段层；标签+属性+wikilink 双链均为开放文本约定 —— [Properties](https://github.com/obsidianmd/obsidian-help/blob/029ba842/en/Editing%20and%20formatting/Properties.md)、[How Obsidian stores data](https://obsidian.md/help/data-storage)

**检索（D2）**：内置全文搜索支持操作符组合（`file:`/`path:`/`task:`/`tag:`，可嵌套、可正则）—— [Search](https://github.com/obsidianmd/obsidian-help/blob/5fb785ac/en/Plugins/Search.md)；无向量/语义检索（官方未见）。

**引用与溯源（D3）**
- 反向链接面板为官方核心插件，含链接提及/未链接提及；未解析链接（`[[不存在页]]`）天然可见，等价于「待建页」待办 —— [反向链接（官方中文帮助）](https://obsidian.md/zh/help/plugins/backlinks)

**导入与同步（D4）**
- 官方 Importer 插件：Apple Notes、OneNote、Evernote、Notion、Google Keep 等转 Markdown 入 vault —— [obsidianmd/obsidian-importer](https://github.com/obsidianmd/obsidian-importer)
- Obsidian Sync 官方付费同步，端到端加密，自带版本历史（可回溯/恢复）—— [Obsidian Sync](https://obsidian.md/sync)、[Version history](https://obsidian.md/help/sync/version-history)

**权限（D5）**：不覆盖——单机单用户，无内建多用户/角色/集合权限（数据为本地私有文件）—— [How Obsidian stores data](https://obsidian.md/help/data-storage)。

**Agent 工具协议（D6）**
- 官方 URI 协议 `obsidian://` 可打开 vault/笔记、新建笔记、执行搜索等深链动作，可被外部程序无凭据调用 —— [Obsidian URI（官方帮助）](https://obsidian.md/fr/help/uri)
- 官方 API/官方 MCP：检索未见（【未核实】=截至检索日未发现官方实现）；事实标准是社区 Local REST API 插件（HTTP REST + API key，README 自带 MCP 集成章节）—— [obsidian-local-rest-api README](https://raw.githubusercontent.com/coddingtonbear/obsidian-local-rest-api/master/README.md)
- 结论：Agent 覆盖 = URI（官方、偏只读）+ 社区 REST 插件（读写完整），无官方 API 层——「知识在本地，接口靠社区」。

**工作流（D7）**：插件经官方市场分发，官方帮助设「社区插件」专章（含风险提示）—— [插件（官方中文帮助）](https://obsidian.md/zh/help/plugins)；无编排引擎。

**备份（D8）**：三重保障范本——①纯文件复制即备份（Markdown 落盘）；②File Recovery 核心插件定期快照、应用内恢复误删误改；③Sync 版本历史 —— [File recovery](https://obsidian.md/help/plugins/file-recovery)、[How Obsidian stores data](https://obsidian.md/help/data-storage)、[Version history](https://obsidian.md/help/sync/version-history)

**可观测性（D9）**：不覆盖（本地单机，无审计/上报产品功能）。

**易用性（D10）**：桌面/移动端装完即用，vault 打开文件夹即可写，零服务端依赖；个人使用免费 —— [Download and install Obsidian](https://obsidian.md/help/install)、[Pricing](https://obsidian.md/pricing)

### 3.2 AFFiNE —— 块模型 + 云/自托管双形态，官方 MCP

**信息模型（D1）**：Workspace 顶层容器 → Docs（Page/Edgeless 双模式：页面写作+无限画布）→ 内容由 Block 组成；底层自研 BlockSuite 框架，文档数据模型与渲染分离 —— [Workspaces](https://docs.affine.pro/core-concepts/elements-of-affine/workspaces)、[Page Mode](https://docs.affine.pro/core-concepts/elements-of-affine/page-mode)、[Blocks](https://docs.affine.pro/core-concepts/elements-of-affine/blocks)、[BlockSuite Architecture](https://docs.affine.pro/blocksuite-wip/architecture)
- BlockSuite 官方 `MarkdownTransformer`：块模型可转 Markdown（经 Transformer/Adapter 管道出入）—— [MarkdownTransformer](https://block-suite.com/api/@blocksuite/affine-block-root/variables/MarkdownTransformer.html)、[Transformer & Adapter](https://docs.affine.pro/blocksuite-wip/store/transformer-and-adapter)

**检索（D2）**：自托管版可配置 Indexer（搜索索引组件）—— [Self-host Indexer Guide](https://docs.affine.pro/self-host-affine/administer/indexer)；云端语义检索细节【未核实】。

**导入与同步（D4）**：官方 Notion 导入教程；云端版与自托管（docker-compose）并存 —— [Import your data from Notion](https://affine.pro/blog/import-your-data-from-notion-into-affine)、[Self-host Docker Compose](https://docs.affine.pro/self-host-affine/install/docker-compose-recommended)

**Agent 工具协议（D6）**：有官方 MCP Server 产品页「AFFiNE MCP Server — Connect AI to Your Knowledge Base」—— [AFFiNE MCP Server](https://affine.pro/mcp)；官方域下未见公开 REST/GraphQL API 文档（仅第三方镜像，【未核实】）。

**备份（D8）**：官方自托管备份恢复指南明确三分：Postgres、Blobs、配置 —— [Backup and Restore](https://docs.affine.pro/self-host-affine/administer/backup-and-restore)

**权限（D5）/易用性（D10）**：云端 Free/Pro/Team 计划分层（$0 起）；自托管 docker-compose 推荐路径，但需维护 Postgres 等依赖 —— [Pricing](https://affine.pro/pricing)、[Self-host AFFiNE](https://docs.affine.pro/self-host-affine/)

### 3.3 Outline —— 团队 Wiki 的「正规军」：API 规范化 + 官方 MCP + 审计

**信息模型（D1）**：集合（Collection）→ 文档树形层级；服务端数据库形态（自托管 Postgres 体系），无本地纯文件形态 —— [Collections](https://docs.getoutline.com/s/guide/doc/collections-l9o3LD22sV)、[Docker](https://docs.getoutline.com/s/hosting/doc/docker-7pfeLP5a8t)

**检索（D2）**：官方把「Search & AI answers」做成一等功能——全文搜索与 AI 问答一体入口 —— [Search & AI answers](https://docs.getoutline.com/s/guide/doc/search-ai-answers-NIKPvYrx06)；语义搜索技术细节【未核实】。

**引用与溯源（D3）**：文档修订历史（Revision history）可查看并回溯历史版本 —— [Revision history](https://docs.getoutline.com/s/guide/doc/revision-history-AiL6p22Ssq)；反向链接专页【未核实】。

**导入与同步（D4）**：官方 Import data 指南；导出分「Export documents（文档）」与「Export data（整库）」两档；官方 Slack/Zapier 集成 —— [Import data](https://docs.getoutline.com/s/guide/doc/import-data-D2ZvLqz411)、[Export data](https://docs.getoutline.com/s/guide/doc/export-data-Da6C7HqL8M)、[Slack](http://www.getoutline.com/integrations/slack)、[Zapier](https://www.getoutline.com/integrations/zapier)

**权限（D5）**：四件套最全——Users & roles、Groups、Sharing（分享/公开链接粒度）、Audit log（审计日志查询）—— [Users & roles](https://docs.getoutline.com/s/guide/doc/users-roles-cwCxXP8R3V)、[Groups](https://docs.getoutline.com/s/guide/doc/groups-Jy1rROTFmN)、[Sharing](https://docs.getoutline.com/s/guide/doc/sharing-LG2sGOLIpl)、[Audit log](https://docs.getoutline.com/s/guide/doc/audit-log-cEpf9ayBaQ)

**Agent 工具协议（D6）**
- 官方 REST API（API key 鉴权，覆盖文档/集合等资源读写）+ **官方维护的 OpenAPI 规范**（outline/openapi `spec3.yml`，可机器生成 SDK）—— [API](https://docs.getoutline.com/s/guide/doc/api-1rEIXDfLF6)、[outline/openapi spec3.yml](https://raw.githubusercontent.com/outline/openapi/main/spec3.yml)
- 官方 MCP：changelog 发布「MCP Improvements」，官方指南含 MCP「Client setup」页（v1.6.0 release 附带）—— [MCP Improvements（官方 changelog）](https://www.getoutline.com/changelog/mcp-improvements)、[Client setup（官方指南）](https://docs.getoutline.com/s/guide/doc/mcp-6j9jtENNKL)、[Release v1.6.0](https://github.com/outline/outline/releases/tag/v1.6.0)（批次 A 检索未命中此项，已由本报告作者以官方域名复核确认）
- 结论：三者（Obsidian/AFFiNE/Outline）中 Agent 正规化程度最高——「REST API + OpenAPI 规范 + API key + 官方 MCP」齐备。

**备份（D8）/安全（D9）**：Export data 整库导出即官方备份路径；官方 Security 文档明示传输与静态均加密 —— [Export data](https://docs.getoutline.com/s/guide/doc/export-data-Da6C7HqL8M)、[Security](https://docs.getoutline.com/s/guide/doc/security-DlJBglbImQ)

### 3.4 AnythingLLM —— 零配置起跑 + `@agent` 技能化 Agent

**信息模型（D1）**：核心隔离单元是工作区（workspace）——LLM 只能看到已嵌入该工作区的文档；RAG 参数（重排偏好、Max Context Snippets、相似度阈值）按工作区设置；嵌入模型/LLM/向量库是实例级设置，Manager 角色被禁止修改 —— [RAG in AnythingLLM](https://docs.anythingllm.com/chatting-with-documents/rag-in-anythingllm)、[Using Documents](https://docs.anythingllm.com/chatting-with-documents/introduction)、[Security and Access](https://docs.anythingllm.com/features/security-and-access)

**检索/RAG（D2）**
- **傻瓜式第一关**：默认嵌入模型内置 all-MiniLM-L6-v2（CPU，首次嵌入自动下载 25MB 即用）—— [AnythingLLM Default Embedder](https://docs.anythingllm.com/setup/embedder-configuration/local/built-in)
- 分块仅 LangChain RecursiveCharacterTextSplitter 一种，默认 chunk 1000 / overlap 20；chunk 超嵌入模型上限时自动按上限截断并告警（防呆）—— [Text Splitting & Chunking](https://docs.anythingllm.com/setup/embedder-configuration/text-splitting)
- 「Accuracy Optimized」重排偏好（多召回再重排，仅默认 LanceDB 可用，+100–500ms）；相似度阈值默认过滤 <20% 的 chunk —— [Using Documents](https://docs.anythingllm.com/chatting-with-documents/introduction)
- 默认向量库 LanceDB（私有内嵌），可换 Chroma/Milvus/Qdrant/Weaviate/Pinecone 等 —— [Vector Databases](https://docs.anythingllm.com/features/vector-databases)
- BM25/全文+向量混合检索：官方文档未见【未核实】

**导入与同步（D4）**：Live document sync（beta）可 watch 已嵌入文件（网站链接、Confluence/GitHub/YouTube 等连接器采集物、桌面版本地文件），变更自动重嵌入并更新所有使用方；桌面版每 10 分钟检查 —— [Live document sync](https://docs.anythingllm.com/beta-preview/active-features/live-document-sync)

**权限（D5）**：多用户为 Docker 版独占、开启后不可回退；三角色 Admin/Manager/Default（Default 仅能访问被显式加入的工作区）；无资源级 ACL 共享模型【不覆盖】—— [Security and Access](https://docs.anythingllm.com/features/security-and-access)

**Agent 工具协议（D6）**
- 任意工作区 `@agent <prompt>` 进入 agent 会话；内置技能：RAG Search、Web Browsing（默认 DuckDuckGo 免配置）、Web Scraping、Save Files、List/Summarize Documents、Chart、SQL Agent、Gmail/Calendar、**Scheduled Jobs** 等 —— [AI Agent Setup](https://docs.anythingllm.com/agent/setup)、[RAG Search](https://docs.anythingllm.com/agent/usage/rag-search)
- 自定义技能 = NodeJS handler + plugin.json；**Agent Flows** 无代码可视化编排（Web Scraper/API Call/LLM Instruction/Read/Write File 块）—— [custom agent skills](https://docs.anythingllm.com/agent/custom/introduction)、[Agent Flows](https://docs.anythingllm.com/agent-flows/overview)
- **MCP 官方支持**（仅 Tools，不支持 Resources/Prompts/Sampling）：Docker 版经 `anythingllm_mcp_servers.json` 配置，Agent Skills 页可视化管理与查看错误日志 —— [MCP on AnythingLLM Docker](https://docs.anythingllm.com/mcp-compatibility/docker)、[MCP Compatibility](https://docs.anythingllm.com/mcp-compatibility/overview)
- **Intelligent Tool Selection**（默认开）：按对话相关性只挂载相关工具/MCP，官方称省最多 80% token、每次 +100–500ms —— [Intelligent Tool Selection](https://docs.anythingllm.com/agent/intelligent-tool-selection)

**API（D6/D7）**：实例自带 `/api/docs`；仓库维护 OpenAPI 规范 `server/swagger/openapi.json` —— [API Access & Keys](https://docs.anythingllm.com/features/api)、[openapi.json](https://github.com/Mintplex-Labs/anything-llm/blob/master/server/swagger/openapi.json)

**备份（D8）/可观测（D9）**：Docker 必须挂载 `${STORAGE_LOCATION}:/app/server/storage` 否则重启丢数据；整库导出【不覆盖】；Event Logs（登录/消息/设置变更/上传）+ Workspace Chat Logs（可导出 CSV/JSON/JSONL fine-tune 格式）—— [Get Started with AnythingLLM in Docker](https://docs.anythingllm.com/installation-docker/local-docker)、[Event Logs](https://docs.anythingllm.com/features/event-logs)、[Workspace Chat Logs](https://docs.anythingllm.com/features/chat-logs)

**易用性（D10）**：单镜像 `mintplexlabs/anythingllm` 起服务即用；零 key 起跑（内置嵌入器 + LanceDB + DuckDuckGo）；桌面端一键安装 —— [Quickstart](https://docs.anythingllm.com/installation-docker/quickstart)、[README](https://github.com/Mintplex-Labs/anything-llm)

### 3.5 RAGFlow —— 「检索质量自证」与「同步可排障」的范本

**信息模型（D1）**：Dataset（知识库）是承载知识源与检索的工作空间，被 Chat/Search/Agent 复用；详情页五入口：File list、**Retrieval Testing**、Artifacts（Wiki/Navigation/Graph）、**Logs**、Configuration —— [Dataset Overview](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/dataset_overview.md)
- Chunk 级管理：查看/搜索/编辑（正文+关键词+问题+标签）/启停用/删除，chunk 点击联动原文预览定位 —— [Chunk 管理](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/chunk_parsing_results_and_knowledge_fragment_management.md)
- Dataset 配置含 PageRank 分数（并入混合相似度）与 Tag sets（相似度批量打标、查询自动关联）—— [Configuration](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/configuration.md)

**检索/RAG（D2）**
- 模板化解析 10 种：General、Q&A、Manual（层级章节 PDF）、Table（每行一 chunk）、Paper、Book、Laws、Presentation（每页一 chunk）、One、Tag —— [Configuration](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/configuration.md)
- PDF 解析器可选：DeepDoc（OCR+表格结构 TSR+版面分析）、Naive（纯文本加速）、Docling、腾讯 TCADPParser、VLM 视觉模型 —— 同上
- 内容增强：Auto-keyword / Auto-question（每 chunk 自动关键词/问题数）/ Auto metadata —— 同上
- 混合检索参数（检索测试页）：Similarity threshold（默认 0.2）、**Vector similarity weight**（向量 vs 关键词加权）、Rerank model、Cross-language search、Metadata 过滤、Top N —— [Retrieval Testing](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/retrieval_testing.md)
- 多路召回引擎 Elasticsearch 或 Infinity；知识图谱开关支持多跳问答；「知识编译」可从 dataset 生成 Wiki/Navigation/Graph 三类 Artifacts —— [Quickstart](https://github.com/infiniflow/ragflow/blob/main/docs/quickstart.mdx)、[Agent 基础组件](https://github.com/infiniflow/ragflow/blob/main/docs/guides/agent/agent_workflow/basic_component.md)、[Artifacts](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/artifacts_knowledge_artifact_generation_and_management.md)

**引用与溯源（D3）**：Chat 配置双开关——"Show citations"（回答展示所引内容并可溯源到原文档）与 "Show chunk metadata"（附 source/author/date 等元数据）—— [Chat configuration](https://github.com/infiniflow/ragflow/blob/main/docs/guides/chat/chat_configuration.md)

**导入与同步（D4）**
- 内置数据源连接器 40+（Confluence、Notion、Google Drive、飞书 Wiki、OneDrive、SharePoint、S3、WebDAV、RSS、钉钉等）—— [Data Source Configuration](https://github.com/infiniflow/ragflow/blob/main/docs/guides/data_source/data_source_configuration.md)
- **同步语义完整**：首次全量 → 刷新周期增量 → 可选 Sync deleted files（外部删除同步清理索引）；数据源页有同步日志（首次/增量/清理任务类型）—— [Add a Data Source and Sync](https://github.com/infiniflow/ragflow/blob/main/docs/guides/data_source/add_to_knowledge_base_and_sync.md)、[Data Source Overview](https://github.com/infiniflow/ragflow/blob/main/docs/guides/data_source/overview_and_page_management.md)
- 解析进度可视化：文档 Status 列（等待/运行/完成/失败/取消）+ 文档级 Logs（执行过程与错误）+ 失败一键重跑 —— [Files 管理](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/files_dataset_document_management.md)

**权限（D5）**：三层体系：team membership → resource sharing scope → resource operation permissions（Read/Write/Manage，覆盖知识库、Chat、Agents、MCP servers、模型配置等资源）—— [Permission System Overview](https://github.com/infiniflow/ragflow/blob/main/docs/guides/team/permission_system_overview/index.md)、[Resource Operation Permissions](https://github.com/infiniflow/ragflow/blob/main/docs/guides/team/permission_system_overview/resource_operation_permissions.md)

**Agent 工具协议（D6/D7）**
- Agent = 无代码画布：Agent/Retrieval/Message/Switch/Iteration/Categorize/Code/SQL/HTTP 组件 + 工具组件（Tavily、Google、SearXNG、arXiv、PubMed 等）；Retrieval 组件可由 LLM 自主触发（agentic RAG）—— [Understand the Canvas](https://github.com/infiniflow/ragflow/blob/main/docs/guides/agent/understand_the_canvas.md)、[Agent Overview](https://github.com/infiniflow/ragflow/blob/main/docs/guides/agent/agent_overview.md)、[Tool Components](https://github.com/infiniflow/ragflow/blob/main/docs/guides/agent/agent_workflow/tool_components.md)
- **MCP 双向**：作为 MCP server 独立组件（默认端口 9382，Streamable HTTP `/mcp` 与 SSE，暴露知识库检索）；亦可连接外部 MCP server 供 Agent 使用 —— [Use RAGFlow as an MCP Server](https://github.com/infiniflow/ragflow/blob/main/docs/develop/mcp/use_ragflow_as_mcp_server.md)、[Connect an External MCP Server](https://github.com/infiniflow/ragflow/blob/main/docs/develop/mcp/connect_an_external_mcp_to_ragflow.md)

**API（D6）**：HTTP API 全覆盖（OpenAI 兼容 Chat/Agent completion；DATASET/文件/CHUNK/会话/AGENT CRUD；`/api/v1/retrieval` 召回接口），API key 有专页 —— [HTTP API Reference](https://github.com/infiniflow/ragflow/blob/main/docs/references/http_api_reference.md)、[Acquire a RAGFlow API key](https://github.com/infiniflow/ragflow/blob/main/docs/develop/acquire_ragflow_api_key.md)

**备份（D8）**：四卷清单（ES 索引/MinIO 对象存储/MySQL 元数据/Redis）+ 官方迁移脚本 `docker/migration.sh backup|restore`；警告 `docker compose down -v` 删数据 —— [Backup & Migration](https://github.com/infiniflow/ragflow/blob/main/docs/administrator/migration/backup_and_migration.md)

**可观测（D9）**：Dataset Logs（统计+分文档任务日志）；官方内置 Langfuse 全链路追踪（≥0.18.0，trace/span/prompt 级）—— [Logs](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/logs.md)、[Tracing](https://github.com/infiniflow/ragflow/blob/main/docs/administrator/tracing.mdx)

**易用性（D10）**：Docker Compose 上手（要求 `vm.max_map_count≥262144`）；无内置默认嵌入模型（建库时必须自选）—— [Quickstart](https://github.com/infiniflow/ragflow/blob/main/docs/quickstart.mdx)、[Dataset 创建](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/dataset_list_and_creation.md)——功能深但起跑门槛高于 AnythingLLM。

### 3.6 Open WebUI —— 「把知识库做成 Agent 的文件系统」

**信息模型（D1）**：Workspace 五构件：Models / Knowledge / Prompts / Skills / Tools；Model preset = 系统提示词+知识库+工具+技能+参数绑定在基础模型上成为专用 agent —— [Workspace](https://docs.openwebui.com/features/workspace/)、[Models](https://github.com/open-webui/docs/blob/main/docs/features/workspace/models.md)

**检索/RAG（D2）**
- Markdown Header Splitting（先按 H1–H6 结构切分再常规切分；官方实测 2000/1000 配置减少 90% chunk 且提准确率）—— [RAG](https://docs.openwebui.com/features/chat-conversations/rag/)
- 混合检索 `ENABLE_RAG_HYBRID_SEARCH`（BM25+向量+CrossEncoder 重排）；文档提取引擎 8 种（Tika/Docling/Mistral OCR/MinerU/PaddleOCR 等，可按文件类型路由）—— 同上、[Document Extraction](https://github.com/open-webui/docs/blob/main/docs/features/chat-conversations/rag/document-extraction/index.md)
- 双检索模式：Focused Retrieval（RAG）vs Full Context（整文档注入）；换嵌入模型必须 Reindex —— [RAG](https://docs.openwebui.com/features/chat-conversations/rag/)
- **Agentic 检索工具面**（原生函数调用）：`list_knowledge`、`search_knowledge_files`、`query_knowledge_files`、`grep_knowledge_files`（正则+行号）、`view_file`（offset 分页读）；`ENABLE_KB_EXEC=True` 提供 shell 风格 `kb_exec`（ls/tree/grep/cat + 管道）—— [Knowledge Bases and Document Chat](https://github.com/open-webui/docs/blob/main/docs/features/workspace/knowledge.mdx)

**引用与溯源（D3）**：Citations 为模型级能力开关（默认开），覆盖知识库、网页搜索与工具返回；agentic 检索的 chunk 同样渲染为 citations —— [Models](https://github.com/open-webui/docs/blob/main/docs/features/workspace/models.md)、[What are Tools?](https://github.com/open-webui/docs/blob/main/docs/features/extensibility/plugin/tools/index.mdx)

**导入与同步（D4）**：`#URL` 抓网页、YouTube 转写管线、Google Drive（Picker API+OAuth）；**本地文件夹镜像增量同步**（仅传新增/修改、删除同步移除、保留目录结构）；远程源（Git/Confluence/S3 等 45+）经官方周边工具 oikb 持续同步；知识库可导出 zip —— [Knowledge Bases and Document Chat](https://github.com/open-webui/docs/blob/main/docs/features/workspace/knowledge.mdx)、[README](https://github.com/open-webui/open-webui/blob/main/README.md)

**权限（D5）**：三层 RBAC——Roles（admin/user/pending）+ Permissions（Workspace/Sharing/Chat/Features/Settings 五类开关）+ Groups（用户组+资源 ACL，加法模型）；模型绑定知识库即限定可达范围（scoping），Admin 有 Preview User/Group Access 面板 —— [RBAC](https://github.com/open-webui/docs/blob/main/docs/features/authentication-access/rbac/index.mdx)、[Groups](https://github.com/open-webui/docs/blob/main/docs/features/authentication-access/rbac/groups.md)

**Agent 工具协议（D6）**
- 原生 MCP 支持（v0.6.31+）：Admin 添加 MCP (Streamable HTTP) 工具服务器，认证 None/Bearer/OAuth 2.1(DCR)/OAuth 2.1(Static)；仅管理员可添加，可经 Access Control 分发给用户/组 —— [MCP](https://github.com/open-webui/docs/blob/main/docs/features/extensibility/mcp.mdx)
- mcpo：官方 MCP→OpenAPI 代理（把 stdio MCP 服务器包装成 OpenAPI 端点）—— [MCP Support (mcpo)](https://github.com/open-webui/docs/blob/main/docs/features/extensibility/plugin/tools/openapi-servers/mcp.mdx)
- Skills = Markdown 指令集（`$` 注入、绑定模型后懒加载）；API key 每账号一枚、继承创建者权限且每次请求实时校验、可限制可访问路由 —— [Skills](https://github.com/open-webui/docs/blob/main/docs/features/workspace/skills.md)、[API Keys](https://github.com/open-webui/docs/blob/main/docs/features/authentication-access/api-keys.md)
- 无内置可视化工作流画布（Pipelines/外部编排外挂）【不覆盖】—— [Pipelines](https://github.com/open-webui/docs/blob/main/docs/features/extensibility/pipelines/index.mdx)

**备份（D8）/可观测（D9）**：单卷 `/app/backend/data`（库+上传+向量）；Admin Analytics（消息量、**token 用量与成本估算**、用户活跃、时序趋势）+ 个人 Usage 页（730 天本人数据，免配置）—— [Backups](https://github.com/open-webui/docs/blob/main/docs/tutorials/maintenance/backups.md)、[Analytics](https://github.com/open-webui/docs/blob/main/docs/features/administration/analytics/index.mdx)

**易用性（D10）**：`pip install open-webui` 一行或 docker run；桌面原生 App（内置 llama.cpp 全本地）；首个账户即 Admin —— [README](https://github.com/open-webui/open-webui/blob/main/README.md)

### 3.7 Dify —— 「检索测试台 + 引用双轨 + Scoped Key」三个样板间

当前版本 v1.17.1（2026-09-10，GitHub API 核实）。官方文档支持 llms.txt 与整页 Markdown 抓取（对 Agent 友好）—— [llms.txt](https://docs.dify.ai/llms.txt)

**信息模型（D1）**：Knowledge（API 即 Dataset）→ Documents → Chunks 全链路 CRUD；元数据系统（内置字段可启停+自定义 string/number/time，批量写）；索引两档：High-Quality（向量，可混合检索，不可降级）与 Economical（每块抽 10 关键词走倒排，零 token）；分块模式 General 与 Parent-child（子块匹配、命中返父块；父块 Paragraph 或 Full Doc）—— [Knowledge API](https://docs.dify.ai/en/api-reference/guides/knowledge)、[Chunk Settings](https://docs.dify.ai/en/cloud/use-dify/knowledge/create-knowledge/chunking-and-cleaning-text)、[Index Method and Retrieval Settings](https://docs.dify.ai/en/cloud/use-dify/knowledge/create-knowledge/setting-indexing-methods)、[Metadata](https://docs.dify.ai/en/cloud/use-dify/knowledge/metadata)

**检索/RAG（D2）**
- 三种检索：向量/全文/混合（权重滑杆或 Rerank 模型二选一）；TopK 默认 3、Score 阈值默认 0.5；检索设置分两层：知识库级召回池 + 应用/节点级二次 rerank/截断 —— [Index Method and Retrieval Settings](https://docs.dify.ai/en/cloud/use-dify/knowledge/create-knowledge/setting-indexing-methods)、[Knowledge Retrieval 节点](https://docs.dify.ai/en/cloud/use-dify/nodes/knowledge-retrieval)
- 元数据过滤三档：Disabled / Automatic（LLM 从 query 抽条件）/ Manual（字段+操作符+AND/OR）—— 同上
- **检索测试台（Retrieval Testing）**：模拟查询+临时试参；Records 同时记录测试查询与所有关联应用（含生产）的检索事件；**测试与生产共用同一 API 端点** —— [Test Knowledge Retrieval](https://docs.dify.ai/en/cloud/use-dify/knowledge/test-retrieval)
- 多库多路召回：应用可挂多个知识库，结果按加权分或 Rerank 统一排序 —— [Integrate Knowledge within Apps](https://docs.dify.ai/en/cloud/use-dify/knowledge/integrate-knowledge-within-application)

**引用与溯源（D3）**
- UI 双轨：应用勾选「Citation and Attribution」→ 回答带编号引用，点击回原文档/分块；API 轨：chat 流式 `message_end.metadata.retriever_resources` 返回命中分段与分数 —— [App Toolkit](https://docs.dify.ai/en/cloud/use-dify/build/additional-features)、[Send Chat Message](https://docs.dify.ai/en/api-reference/chat-messages/send-chat-message)
- 节点级追踪：流式事件含 `workflow_started/finished`、`node_started/finished`、`agent_thought`、`agent_log` —— 同上
- Annotation Reply：人工 Q&A 语义匹配超阈值直接命中返回（不调 LLM），可批量导入导出 —— [App Toolkit](https://docs.dify.ai/en/cloud/use-dify/build/additional-features)

**导入与同步（D4）**
- 数据源：本地文件、Notion 同步、网页爬虫；批量导入 API 返回 batch id 异步索引，轮询 Get Document Indexing Status（waiting→parsing→cleaning→splitting→indexing）—— [Upload/Sync/Import](https://docs.dify.ai/en/cloud/use-dify/knowledge/create-knowledge/import-text-data/readme)、[Create Document by File](https://docs.dify.ai/en/api-reference/documents/create-document-by-file)、[Indexing Status](https://docs.dify.ai/en/api-reference/documents/get-document-indexing-status)
- **Knowledge Pipeline（可视化 ETL）**：画布编排「数据源→处理→输出」，5 种内置模板（Parent-child-HQ、Simple Q&A、LLM Generated Q&A、Office 转 Markdown 等）；数据源即插件（Google Drive/Notion 先授权再抽取）—— [Create Knowledge Pipeline](https://docs.dify.ai/en/cloud/use-dify/knowledge/knowledge-pipeline/create-knowledge-pipeline)、[Authorize Data Source](https://docs.dify.ai/en/cloud/use-dify/knowledge/knowledge-pipeline/authorize-data-source)

**权限（D5）**：Workspace 为基础单元；4 内置角色 Owner/Admin/Editor/Normal；**创建权与使用权分离**（能建库 ≠ 能用库，访问由知识库自身 Permissions 决定）；企业版资源访问范围「全部/指定成员」+ 按资源覆盖角色；SSO 为企业版 —— [Team Members](https://docs.dify.ai/en/cloud/use-dify/workspace/team-members-management)、[企业版权限](https://enterprise-docs.dify.ai/zh/3.12.x/use/workspace/roles-and-permissions)、[企业版 SSO](https://enterprise-docs.dify.ai/zh/3.3.x/administer/systems/single-sign-on)；（`dataset_operator` 角色在现行官方文档未见【未核实】）

**Agent 工具协议（D6）**
- 工具四类：Tool 插件（Marketplace）、Swagger/OpenAPI 导入自动生成工具、**Workflow as Tool**（一键把工作流转工具）、MCP —— [Dify Tools](https://docs.dify.ai/en/cloud/use-dify/workspace/tools)
- **MCP 双向原生内置**：client 侧仅 HTTP transport，支持 OAuth Dynamic Client Registration、静态 Token 自定义 Header；server 侧应用 Access Point 一键发布为 MCP Server（生成带鉴权凭据的 URL）—— [Dify Tools](https://docs.dify.ai/en/cloud/use-dify/workspace/tools)、[Publish MCP Server](https://docs.dify.ai/en/cloud/use-dify/publish/publish-mcp)
- **Scoped API Key**：Knowledge API 的 Key 可按 dataset_id 圈定作用域（越界 403；删库联动删专属 Key）；每个知识库可单独关闭 API Access —— [Knowledge API](https://docs.dify.ai/en/api-reference/guides/knowledge)

**工作流（D7）**：Workflow 与 Chatflow 同节点体系；触发器 Schedule/Webhook/插件事件；知识检索节点（多库并发+元数据过滤）；Iteration/Loop 节点；DSL（yaml）导入导出 —— [Workflow & Chatflow](https://docs.dify.ai/en/cloud/use-dify/build/workflow-chatflow)、[Trigger](https://docs.dify.ai/en/cloud/use-dify/nodes/trigger/overview)、[Manage Apps](https://docs.dify.ai/en/self-host/use-dify/workspace/app-management)

**备份（D8）**：两级口径——应用级 = DSL(yaml) 导出入 git；实例级 = 官方明确「备份整个 `dify/docker/volumes` 目录」（实测卷含 app/storage、db/data、redis、weaviate、plugin_daemon、sandbox）；升级前 `cp -r` 快照 —— [Storage & Migration](https://docs.dify.ai/en/self-host/deploy/troubleshooting/storage-and-migration)、[docker-compose.yaml](https://github.com/langgenius/dify/blob/main/docker/docker-compose.yaml)

**可观测（D9）**：内置 Dashboard（性能/成本/参与度）+ Logs（会话/运行日志、归档下载）+ **LLM tracing 官方集成**（Langfuse、LangSmith、Opik、W&B Weave、Arize Phoenix、阿里云 ARMS/OTel）+ 每消息 `metadata.usage`（token/延迟）—— [Dashboard](https://docs.dify.ai/en/cloud/use-dify/monitor/analysis)、[Langfuse 集成](https://docs.dify.ai/en/cloud/use-dify/monitor/integrations/integrate-langfuse)、[Send Chat Message](https://docs.dify.ai/en/api-reference/chat-messages/send-chat-message)

**易用性（D10）**：Docker Compose 一键自托管 + `/install` 初始化向导；模型接入向导（先验证再启用）；官方中文文档全量 —— [Docker Compose 部署](https://docs.dify.ai/en/self-host/deploy/quick-start/docker-compose)、[Model Providers](https://docs.dify.ai/en/cloud/use-dify/workspace/model-providers)

### 3.8 LlamaIndex 与 LangChain —— 框架参照系（不选型，只取范式）

**LlamaIndex**
- 信息模型：Document（文本+元数据）→ Node（可检索最小单元），NodeRelationship（SOURCE/PARENT/PREVIOUS/NEXT/CHILD）构成层级与来源关系图；存储三抽象（vector store / doc store / index store）经 StorageContext 可插拔 —— [Documents / Nodes](https://developers.llamaindex.ai/python/framework/module_guides/loading/documents_and_nodes/)、[NodeRelationship](https://ts.llamaindex.ai/docs/api/type-aliases/NodeRelationship)、[Storing](https://developers.llamaindex.ai/python/framework/module_guides/storing/)
- **Ingestion Pipeline = 傻瓜式增量答案**：声明式转换管线，内置 docstore 缓存——重复运行跳过已处理文档、upsert/duplicate 检测，「重跑不重算」—— [Ingestion Pipeline](https://developers.llamaindex.ai/python/framework/module_guides/loading/ingestion_pipeline/)
- 引用溯源：**CitationQueryEngine** 按来源节点输出引用编号+引文，答案级溯源 —— [CitationQueryEngine 示例](https://developers.llamaindex.ai/python/examples/query_engine/citation_query_engine/)
- 混合检索：Reciprocal Rerank Fusion Retriever（与璇玑现用 RRF 同款思路的官方实现）—— [Reciprocal Rerank Fusion](https://developers.llamaindex.ai/python/framework/integrations/retrievers/reciprocal_rerank_fusion/)
- Agent 与 MCP：官方 Python 模块内置 MCP 章节（MCP 工具转框架工具）；官方「for-agents」门户 + 官方托管文档检索 MCP 服务器；全站 llms.txt + 每页 `.md` 原文——**Agent 友好是官方一级目标** —— [MCP 模块](https://developers.llamaindex.ai/python/framework/module_guides/mcp/)、[for-agents](https://developers.llamaindex.ai/for-agents/)、[文档 MCP 服务器](https://developers.llamaindex.ai/for-agents/mcp/)
- 可观测：Observability 一行代码切换 provider；评估模块（faithfulness/relevancy/correctness）—— [Observability](https://developers.llamaindex.ai/python/framework/module_guides/observability/)、[Evaluating](https://developers.llamaindex.ai/python/framework/module_guides/evaluating/)
- 脚手架：create-llama 交互式生成应用 —— [run-llama/create-llama](https://github.com/run-llama/create-llama)

**LangChain / LangGraph / LangSmith**
- RAG 主线：Document（page_content+metadata）→ 切分 → 嵌入 → 向量库 → 检索；ParentDocumentRetriever（小块检索、返回父块）—— [Knowledge base](https://docs.langchain.com/oss/python/langchain/knowledge-base)、[ParentDocumentRetriever](https://reference.langchain.com/python/langchain-classic/retrievers/parent_document_retriever/ParentDocumentRetriever)
- LangGraph：checkpointer 按步持久化（可接 SQLite/Postgres）、interrupt() 人工介入、time-travel 回放/分叉、LangGraph Platform 托管 GA —— [Checkpointers](https://docs.langchain.com/oss/python/langgraph/checkpointers)、[Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)、[Use time-travel](https://docs.langchain.com/oss/javascript/langgraph/use-time-travel)、[Platform GA](https://www.langchain.com/blog/langgraph-platform-ga)
- LangSmith：tracing/监控 + 数据集→实验→LLM 判分评估闭环（llms.txt 显示主站 460 页全量机读）—— [Observability](https://docs.langchain.com/langsmith/observability)、[Evaluate a chatbot](https://docs.langchain.com/langsmith/evaluate-chatbot-tutorial)、[llms.txt](https://docs.langchain.com/llms.txt)
- MCP 生态巨变：langchain-mcp-adapters 官宣停止维护，MCP 并入主库 `langchain[mcp]`（支持 stateless 协议+elicitation）—— [langchain-mcp-adapters README](https://github.com/langchain-ai/langchain-mcp-adapters)、[MCP in LangChain](https://www.langchain.com/blog/mcp-in-langchain-stateless-protocol-elicitation-and-more)、[迁移指南](https://docs.langchain.com/oss/python/migrate/langchain-mcp-adapters)

### 3.9 MCP 官方规范（2026-07-28 修订版）—— Agent 操作的协议基线

规范修订序列：2024-11-05 → 2025-03-26 → 2025-06-18 → 2025-11-25 → **2026-07-28（当前最新）**；官方博客发布文与 changelog —— [Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)、[The 2026-07-28 Specification（官方博客）](https://blog.modelcontextprotocol.io/posts/2026-07-28/)

**2026-07-28 核心范式转变（直接影响璇玑 MCP server 设计）**
- **协议全面无状态化**：移除 `initialize` 握手与 `Mcp-Session-Id`；版本/能力经 `_meta` 每请求携带；新增 `server/discover` RPC（服务器必须实现，自报版本/能力/身份）—— [Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- **列表结果可缓存**：`tools/list`/`resources/list` 等必须带 `CacheableResult`（`ttlMs` + `cacheScope`），且 SHOULD 确定性排序（利于客户端缓存与 LLM prompt cache 命中）；分页统一 cursor —— 同上
- **废弃三特性**：Sampling/Roots/Logging 整体废弃（SEP-2577）；Elicitation 改由 MRTR（`InputRequiredResult` + 请求重试）承载；HTTP+SSE 传输正式 Deprecated，迁移 Streamable HTTP —— 同上
- **长任务扩展**：Tasks 移出核心协议成为官方扩展 `io.modelcontextprotocol/tasks`（`tasks/get` 轮询 + `tasks/update` 补充输入）—— SEP-2663：[Tasks Extension](https://modelcontextprotocol.io/seps/2663-tasks-extension)
- **资源与订阅**：Resources 支持 RFC 6570 URI 模板（`uriTemplate`）；单一长连接 `subscriptions/listen` 取代原订阅端点 —— [Resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources)、[Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)

**工具规范姿势（Tools）**
- `tools/list`（cursor 分页）+ `tools/call`；Tool 定义含 `name/title/description/inputSchema/outputSchema/annotations`；结构化结果走 `structuredContent` —— [Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- 四个行为注解：`readOnlyHint`、`destructiveHint`、`idempotentHint`、`openWorldHint`；**规范明示注解是提示且不可信，不构成安全边界——真正鉴权必须在服务端做** —— [Tools（注解语义）](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)

**授权与安全**
- OAuth 2.1：MCP 服务器为 resource server，MUST 实现 RFC 9728 Protected Resource Metadata；RFC 8707 Resource Indicators 纳入；RFC 7591 动态注册废弃 → Client ID Metadata Documents —— [Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- 官方安全最佳实践开篇即 confused deputy 攻击面；要求与 RFC 9700 同读 —— [Security Best Practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)
- OpenTelemetry trace 上下文传播写入规范（`_meta` 中 `traceparent/tracestate/baggage`）—— [Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)

**生态**：官方 SDK Tier 1 = TypeScript/Python/C#/Go/Rust；官方 Registry 上线（registry.modelcontextprotocol.io）；官方文档站 llms.txt + 每页 `.md` 原文（官方定位「供 Agent 消费」）—— [SDKs](https://modelcontextprotocol.io/docs/2026-07-28/sdk)、[llms.txt](https://modelcontextprotocol.io/llms.txt)

---

## 4. 横向对比矩阵

| 维度 | Obsidian | AFFiNE | Outline | AnythingLLM | RAGFlow | Open WebUI | Dify |
|------|----------|--------|---------|-------------|---------|------------|------|
| D1 信息模型 | vault=本地 Markdown 文件夹+frontmatter+双链 | Workspace→Docs(Page/Edgeless)→Block(BlockSuite) | Collection→文档树（服务端库） | Workspace 隔离嵌入；AI 设置实例级 | Dataset→文档→Chunk(+PageRank/Tag sets) | Workspace 五构件；Model preset 绑 KB/工具 | KB→Document→Segment+元数据+父子分块 |
| D2 检索 | 操作符全文搜索，无向量 | 自托管 Indexer 组件 | 全文+AI answers 一体 | 向量+可选重排；BM25 混合【未核实】 | 混合(阈值/权重/rerank)+图谱+双引擎 | BM25+向量+CrossEncoder；Header 切分 | 向量/全文/混合+Rerank/权重+元数据过滤 |
| D3 引用溯源 | Backlinks+未解析链接 | 【未核实】 | Revision history | 机制有、展示细节【未核实】 | Show citations + chunk metadata 双开关 | Citations 默认开，agentic 检索同渲染 | UI 编号引用 + API retriever_resources |
| D4 导入同步 | Importer(Notion 等)+Sync(E2EE) | Notion 导入+Transformer | Import/Export+Slack/Zapier | 连接器+Live sync(beta) | 40+连接器，全量/增量/删除同步+日志 | #URL/YouTube/Drive+目录镜像增量 | Notion/爬虫+Pipeline ETL 插件 |
| D5 权限 | 不覆盖（单机） | 计划分层，细节【未核实】 | roles/Groups/Sharing/Audit 四件套 | Admin/Manager/Default 三角色 | 团队→共享范围→R/W/M 三层 | admin/user/pending+组 ACL+资源级 | Workspace 4 角色，创建/使用分离 |
| D6 Agent 协议 | URI+社区 REST 插件，无官方 API | 官方 MCP 页；公开 API【未核实】 | REST+OpenAPI 规范+**官方 MCP** | @agent 技能+Agent Flows+MCP(仅 Tools) | MCP server+client+HTTP API 全覆盖 | 原生 MCP client+Tools/Functions/Pipelines | MCP 双向+Scoped Key+Workflow-as-Tool |
| D7 工作流 | 插件市场，无编排 | 【未核实】 | Zapier/Slack 自动化 | Agent Flows+Scheduled Jobs | Agent 画布(分支/迭代/SQL/HTTP) | 无画布（Pipelines 外挂） | Workflow/Chatflow+Trigger(定时/Webhook) |
| D8 备份 | 文件复制+File Recovery+Sync 历史 | Postgres/Blobs/配置三分 | Export data 整库导出 | 挂 storage 目录；整库导出【不覆盖】 | migration.sh backup/restore(4 卷) | data 单卷+KB zip 导出 | volumes 整目录+DSL 导出 |
| D9 可观测 | 不覆盖 | Indexer 运维 | Audit log+Security | Event Logs+Chat Logs 可导出 | Dataset Logs+Langfuse tracing | Analytics(token/成本)+个人 Usage | Dashboard+Logs+Langfuse/LangSmith/OTel |
| D10 易用性 | 装完即用，零服务端 | 云+compose，需维护 PG | Docker/云托管 | 单镜像+零 key 内置模型 | compose 门槛较高 | pip 一行+首户即 Admin | compose 一键+/install 向导+中文 |

**框架/协议参照**：LlamaIndex 贡献「ingestion 缓存增量 + CitationQueryEngine + llms.txt」范式；LangChain 生态贡献「checkpointer/interrupt/评估数据集」范式；MCP 2026-07-28 是所有 Agent 接口的协议基线（§3.9）。

---

## 5. 关键发现：傻瓜式操作的七条产品级模式

1. **零配置默认值是第一竞争力**：AnythingLLM 内置嵌入模型+内置 LanceDB+免配置搜索，零 API key 跑通 RAG；Obsidian「打开文件夹即用」。反面教材：RAGFlow 建库必须自选嵌入模型、要求调内核参数——能力强但劝退新手。璇玑应有「零 key 默认嵌入」，模型上限自动钳制防呆（AnythingLLM 做法）。
2. **本地/纯文本优先是傻瓜式的根源**：Obsidian 把纯 Markdown 落盘当存储契约，人与 grep/git/Agent 共用同一真实来源、永不锁定；璇玑应以 Markdown-on-disk（或至少「可整库导出为 Markdown」）为 source of truth，索引只是派生缓存。
3. **解析/同步进度可视化 + 失败可重试**：RAGFlow 的 Status 列+文档级 Logs+一键重跑、数据源同步日志（首次/增量/清理）是把「傻瓜式」落到排障上的范本；Dify 的 batch id + indexing status 状态机是 API 侧同款。
4. **检索测试台，且测试与生产同端点**：Dify Retrieval Testing（临时试参+Records 全量留痕+与生产共用 `/retrieve`）与 RAGFlow 检索测试页（阈值/权重/rerank/TopN 即调即测、结果带相关度与源文档）共同证明：调参沙箱是 RAG 产品「可信赖」的最低配置。
5. **引用展示是默认项而非可选项**：Open WebUI Citations 默认开；RAGFlow Show citations/Show chunk metadata 双开关；Dify UI 编号引用+API `retriever_resources` 双轨——「每个结论可点回原文」是知识库可信度的底线。
6. **模板化导入/解析替代参数轰炸**：RAGFlow 10 种解析模板（Paper/Laws/Manual/Table…）、Dify Knowledge Pipeline 5 种内置模板、Obsidian Importer 一键迁移——普通用户选模板，不读分块理论。
7. **一键备份与分级恢复**：Obsidian 三重（文件复制/File Recovery/Sync 历史）、AFFiNE 官方三分清单（DB/Blobs/配置）、Dify「备份=拷 volumes 目录+DSL 入 git」、RAGFlow `migration.sh backup/restore`、Outline Export data——共同范式是「一条命令/一个按钮 + 恢复路径写清楚」。

---

## 6. 关键发现：Agent 操作的八条产品级模式

1. **知识库即 MCP server 已是行业收敛点**：RAGFlow（独立 server 组件，Streamable HTTP）、Dify（应用一键发布为 MCP Server）、AFFiNE（官方 MCP 产品页）、Outline（官方 MCP + changelog）、Open WebUI（原生 MCP client）全线支持。璇玑已有 15 工具的 MCP server，方向正确，差距在规范符合度（见下条）。
2. **对齐 MCP 2026-07-28 无状态化**：实现 `server/discover`；不依赖会话状态；`tools/list` 确定性排序 + `ttlMs/cacheScope` + cursor 分页；交互式澄清用 MRTR（`InputRequiredResult`）而非已废弃的 Elicitation/Sampling —— [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)。
3. **工具注解表达意图，服务端落实权限**：检索/列举类标 `readOnlyHint`，删除类标 `destructiveHint`，但规范明示注解不可信——真正边界在服务端。产品侧参考：Dify Scoped API Key（按 dataset 作用域、越界 403、删库联动删 Key）；Open WebUI API key 每请求实时校验+可限制路由。
4. **知识双通道暴露：tools 细粒度检索 + resources 整体读取**：MCP Resources 的 `uriTemplate`（如 `xuanji://kb/{docId}`）+ `subscriptions/listen` 变更通知，比全走 tools 更省 token、更可缓存；Open WebUI 的 `grep_knowledge_files`/`view_file`（offset 分页）展示了「把知识库当文件系统给 Agent 用」的极致形态。
5. **检索-问答 API 双轨 + 流式事件**：Dify 的 `retriever_resources`（消息收尾携带命中分段与分数）与 `node_started/agent_thought` 事件是「Agent 可编程溯源」的样板；RAGFlow `/api/v1/retrieval` 独立召回接口同理——检索能力和问答能力都应是一等 API。
6. **工具面要裁剪**：AnythingLLM Intelligent Tool Selection 按相关性挂载工具省最多 80% token——工具多时必须做选择/路由，否则 Agent 上下文爆炸。
7. **长任务必须有异步语义**：MCP Tasks 扩展（`tasks/get` 轮询 + `tasks/update`）是规范答案；Dify 批量导入的 batch id + indexing status 是产品答案。璇玑的 `kb.reindex_all/backup_trigger` 目前是同步触发+独立状态查询，应升级为统一「任务句柄」语义。
8. **审计与用量观测面向 Agent 读写**：Outline Audit log、AnythingLLM Event Logs（登录/上传/设置变更）+ Chat Logs 导出（可转 fine-tune 数据）、Open WebUI Analytics（token 用量与成本估算）、Dify/RAGFlow 的 Langfuse tracing——个人知识库也需「谁（哪个 Agent Key）在何时动了什么」的可回放记录。

---

## 7. 按优先级的可行改进清单

> 原则：璇玑已有 15 工具 MCP server、RRF 混合检索、幂等键+文档版本表、AList 快照备份四个好底子。以下 15 项按「先补可信度底线 → 再打通知识进出 → 后拉开差距」排序；每项给出**做什么 / 验收标准（可检验的完成定义）/ 落点（璇玑现有代码）/ 参照（官方 URL）**。

### P0 —— 可信度底线（建议 1~2 周，做完即「敢用」）

1. **检索测试台**（傻瓜式）
   - 做什么：知识库页新增「检索测试」——输入查询即返回命中片段+分数+来源；可临时调 hybrid 权重/TopK/检索模式，并可「另存为默认」。
   - 验收：测试页与 `knowledge_search`/`searchContext` 调用**同一个检索函数**（测试≠另一套实现）；任意查询 2s 内返回 top10 带分数与来源；测试记录留痕可回看。
   - 落点：`api/search-router.ts` / `api/mcp-hybrid-search.ts`（检索内核复用）+ 前端知识库页。
   - 参照：Dify [Test Knowledge Retrieval](https://docs.dify.ai/en/cloud/use-dify/knowledge/test-retrieval)；RAGFlow [Retrieval Testing](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/retrieval_testing.md)。
2. **引用双轨**（傻瓜式 + Agent）
   - 做什么：`ask-stream` 回答流收尾事件携带 `sources[]`（文档 id/标题/chunk 文本/分数）；UI 渲染编号引用卡片，点击打开原文并高亮。
   - 验收：每条 AI 回答默认可点开≥1 个来源；API 消费方（天宫 Agent）能从同一响应解析出结构化 sources；UI 提供「显示片段元数据」开关。
   - 落点：`api/ask-stream-router.ts` + 前端问答/检索组件。
   - 参照：Dify [`message_end.metadata.retriever_resources`](https://docs.dify.ai/en/api-reference/chat-messages/send-chat-message)；RAGFlow [Chat configuration 双开关](https://github.com/infiniflow/ragflow/blob/main/docs/guides/chat/chat_configuration.md)。
3. **MCP 规范现代化**（Agent）
   - 做什么：15 个工具补 `annotations`（`document_read/knowledge_search/folder_list/workflow_list/backup_list` → `readOnlyHint:true`；`document_delete` → `destructiveHint:true`）；`tools/list` 确定性排序+cursor 分页；实现 `server/discover`；传输对齐 Streamable HTTP。
   - 验收：用官方 inspector/SDK 客户端连接不需会话保持；`tools/list` 两次调用返回顺序一致且带 `ttlMs`；只读工具在注解中可被客户端识别（同时服务端仍强制鉴权——规范明示注解不可信）。
   - 落点：`api/mcp-server.ts`（工具注册处集中加注解与排序）。
   - 参照：MCP [Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)、[2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)。
4. **长任务统一异步句柄**（Agent + 傻瓜式）
   - 做什么：`kb.reindex_all`/`backup_trigger`/批量导入统一返回 `{taskId}`，新增通用 `task_status` 查询；UI 用同一任务态渲染进度条。
   - 验收：触发重建索引立即返回（<500ms）；Agent 凭 taskId 轮询到 `running/succeeded/failed` 与进度百分比；失败带可行动错误信息。
   - 落点：`api/mcp-zvec-tools.ts`（reindex）、`api/mcp-kb-backup.ts`、`api/backup-router.ts`。
   - 参照：MCP [SEP-2663 Tasks 扩展](https://modelcontextprotocol.io/seps/2663-tasks-extension)；Dify [Get Document Indexing Status](https://docs.dify.ai/en/api-reference/documents/get-document-indexing-status)。
5. **解析/嵌入进度可视化**（傻瓜式）
   - 做什么：上传/导入后的文档状态列（等待→解析→分块→向量化→完成/失败）+ 单文档日志 + 失败一键重跑。
   - 验收：导入 10 个混合格式文件，每个卡片状态实时变化；故意上传损坏文件能看到失败原因与「重试」按钮；重试成功后状态收敛为完成。
   - 落点：`api/ingestion-router.ts` + `api/upload-handler.ts` + 前端文件列表。
   - 参照：RAGFlow [Files 管理（Status/Logs/Run）](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/files_dataset_document_management.md)。

### P1 —— 让知识「进得来、拿得走」（建议 2~4 周）

6. **AList 连接器增量同步**（傻瓜式）
   - 做什么：目录级 watch——按刷新周期只导新增/修改（用现有 `contentHash`/幂等键比对），可选「删除同步」开关 + 同步日志页（首次/增量/清理）。
   - 验收：网盘内改 1 个文件、增 1 个文件、删 1 个文件，下一周期仅 3 条变更被处理（其余跳过）；同步日志可查每条任务类型与结果。
   - 落点：`api/connectors/`（AList 连接器）+ `data_sources` 表加 sync 配置字段。
   - 参照：RAGFlow [同步语义](https://github.com/infiniflow/ragflow/blob/main/docs/guides/data_source/add_to_knowledge_base_and_sync.md)；AnythingLLM [Live document sync](https://docs.anythingllm.com/beta-preview/active-features/live-document-sync)；Open WebUI [目录镜像增量](https://github.com/open-webui/docs/blob/main/docs/features/workspace/knowledge.mdx)。
7. **一键整库导出/导入**（傻瓜式）
   - 做什么：设置页常驻「导出全部为 Markdown zip」（含 tags/metadata/文件夹结构 manifest）；支持从同格式 zip 导入。
   - 验收：导出 zip 在全新实例一键导入后，文档树/标签/内容逐字节一致；导出≤1 分钟（千文档级）。
   - 落点：`api/kb-router.ts` 新增 export/import 端点（复用 `BACKUP_TEMP_DIR`）。
   - 参照：Outline [Export data](https://docs.getoutline.com/s/guide/doc/export-data-Da6C7HqL8M)；Obsidian [纯文件存储范式](https://obsidian.md/help/data-storage)。
8. **Scoped API Key**（Agent）
   - 做什么：Agent Key 在现有 7 权限位之上加资源作用域（按 folder/知识库圈定；越界 403；删除资源联动吊销其专属 Key）。
   - 验收：作用域外的 `document_read/write/delete` 一律 403 且写审计；删除 folder 后其 scoped key 自动失效。
   - 落点：`api/agent-router.ts`（Key 签发）+ `api/middleware.ts`（作用域校验）。
   - 参照：Dify [Knowledge API Scoped Key](https://docs.dify.ai/en/api-reference/guides/knowledge)；Open WebUI [API Keys 实时校验+路由限制](https://github.com/open-webui/docs/blob/main/docs/features/authentication-access/api-keys.md)。
9. **Agent 友好文档面与资源化**（Agent）
   - 做什么：提供 `llms.txt` 全量索引与每文档 `.md` 原文端点；MCP 新增 resources 暴露（`xuanji://kb/{folderId}/{docId}` URI 模板）+ `subscriptions/listen` 变更通知。
   - 验收：任意外部 Agent 可经 MCP 列出/读取资源 URI；文档更新后订阅客户端收到通知；`GET /llms.txt` 返回全站索引。
   - 落点：`api/mcp-server.ts` + 新增轻量路由。
   - 参照：MCP [Resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources)；LlamaIndex [for-agents / llms.txt 范式](https://developers.llamaindex.ai/for-agents/)。
10. **审计日志产品化**（Agent + 运维）
    - 做什么：把 `audit-router` 落成 Event Logs 页——以 Agent Key 为主维度记录「谁/何时/何工具/参数摘要/结果」；操作与聊天记录可导出。
    - 验收：任何 MCP/REST 写操作在 Event Logs 可查到对应 Key 与结果；导出 JSON 可被外部系统消费。
    - 落点：`api/audit-router.ts` + `api/middleware.ts`（埋点）+ 前端设置页。
    - 参照：Outline [Audit log](https://docs.getoutline.com/s/guide/doc/audit-log-cEpf9ayBaQ)；AnythingLLM [Event Logs](https://docs.anythingllm.com/features/event-logs)。

### P2 —— 拉开差距（长期）

11. **模板化解析与父子分块**：按文档类型给推荐解析模板（表格/论文/问答对），父子分块（子块匹配返父块）——参照 RAGFlow [10 种解析模板](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/configuration.md)、Dify [Parent-child](https://docs.dify.ai/en/cloud/use-dify/knowledge/create-knowledge/chunking-and-cleaning-text)。验收：同批 PDF 用「论文模板」解析后，章节级命中率高于通用分块（用 §7.14 的评估集量化）。
12. **知识图谱自动生成**：从文档抽取实体/关系入 `knowledge_nodes/edges`，图谱由手工维护变派生产物——参照 RAGFlow [Artifacts Graph](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/artifacts_knowledge_artifact_generation_and_management.md)。验收：导入一个文件夹后图谱自动新增节点/边并可追溯到源文档。
13. **双链与未解析链接**：文档支持 `[[wikilink]]`；未解析链接作为「待建页」待办，Agent 可扫描并自动补链建页——参照 Obsidian [Backlinks](https://obsidian.md/zh/help/plugins/backlinks)。验收：含未解析链接的文档在图谱/列表中可见待办数；Agent 一键补链后待办清零。
14. **检索质量评估闭环**：内置评估集（query→期望来源）+ faithfulness/relevancy 判分，参数改动前后可对比——参照 LangSmith [Evaluate a chatbot](https://docs.langchain.com/langsmith/evaluate-chatbot-tutorial)、LlamaIndex [Evaluating](https://developers.llamaindex.ai/python/framework/module_guides/evaluating/)。验收：改分块参数后一键跑评估出对比报告。
15. **全链路 tracing 与用量面板**：检索/问答链路默认吐 OpenTelemetry trace（与 MCP `_meta` traceparent 约定对齐）；token 用量与成本面板——参照 Dify [Langfuse 集成](https://docs.dify.ai/en/cloud/use-dify/monitor/integrations/integrate-langfuse)、Open WebUI [Analytics](https://github.com/open-webui/docs/blob/main/docs/features/administration/analytics/index.mdx)。验收：一次问答在 trace 后端可见 retrieve→rerank→generate 三段耗时与 token 数。

### 一个战略判断

- 「傻瓜式」的尽头是 **默认值 + 可视化反馈 + 一键兜底**（模式 §5.1/§5.3/§5.7）；
- 「Agent 操作」的尽头是 **规范符合的 MCP 面 + 最小权限 Key + 全程可溯源**（模式 §6.2/§6.3/§6.5）。
- 两者共享同一基础设施：**检索测试台、引用溯源、任务状态机、审计日志**——先建这四块，两条线同时受益。

---

## 8. 傻瓜式 / Agent-first 交互设计

### 8.0 总原则：一脑双面（One brain, two faces）

同一检索/写入内核，**人走 UI、Agent 走 MCP/API**，两面共用端点、参数与默认值。Dify 已证明此路可行：检索测试页与生产检索共用同一 `/retrieve` 端点，人工调好的参数 Agent 直接复用（§3.7）。璇玑的每次「傻瓜式」改进都必须问一句：**这个状态 Agent 看得见吗？每次「Agent」改进都必须问：这个结果人看得懂吗？**

### 8.1 傻瓜式交互（人的那一面）——六个设计决策

1. **首次启动零配置**：不填任何 Key 即可完成「连数据源→导入一批→问一句」三步（嵌入走天枢兜底模型）；LLM/嵌入配置做成「可选增强」而非前置门槛。
   参照：AnythingLLM [零 key 内置嵌入器](https://docs.anythingllm.com/setup/embedder-configuration/local/built-in)。
2. **单一入口「检索即问答」**：搜索框=问答框——AI 回答置顶（带引用），全文检索结果兜底展示在下；不设「问答」与「搜索」两个心智。
   参照：Outline [Search & AI answers](https://docs.getoutline.com/s/guide/doc/search-ai-answers-NIKPvYrx06)。
3. **进度永远可见**：导入/解析/向量化/备份/重建索引全部走同一状态机与进度条（等 P0-4/5）；失败信息必须「可行动」（下一步做什么写清楚）。
   参照：RAGFlow [Status 列+文档 Logs+重跑](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/files_dataset_document_management.md)。
4. **引用卡片**：回答底部编号引用，点击打开原文并高亮片段；「显示元数据」默认关、可开。
   参照：RAGFlow [Show citations / Show chunk metadata](https://github.com/infiniflow/ragflow/blob/main/docs/guides/chat/chat_configuration.md)；Open WebUI [Citations 默认开](https://github.com/open-webui/docs/blob/main/docs/features/workspace/models.md)。
5. **危险操作可撤销**：删除进回收站（软删字段 `deletedAt/deletedReason` 已备）+ 恢复入口；恢复备份前先校验 manifest 完整性（dry-run）。
   参照：Obsidian [File Recovery 快照恢复](https://obsidian.md/help/plugins/file-recovery)。
6. **一键兜底常驻**：设置页固定「导出全部为 Markdown zip」——用户任何时候都能拿走全部数据，这是信任的底线。
   参照：Outline [Export data](https://docs.getoutline.com/s/guide/doc/export-data-Da6C7HqL8M)。

### 8.2 Agent-first 交互（机器的那一面）——七个设计决策

1. **工具即契约**：每个 MCP 工具的 `description` 写成四段式——用途/前置条件/副作用/返回结构；并补齐 `readOnlyHint`/`destructiveHint`/`idempotentHint` 注解。注解只表达意图，**真正的权限永远在服务端校验**（规范明示注解不可信）。
   参照：MCP [Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)。
2. **检索优先于遍历**：给 Agent 的第一工具是 `knowledge_search`（hybrid），引导「先搜后读」；`document_read` 支持按 chunk 定位与 offset 分页，避免整文灌上下文。
   参照：Open WebUI [`search_knowledge_files`/`grep_knowledge_files`/`view_file`](https://github.com/open-webui/docs/blob/main/docs/features/workspace/knowledge.mdx)。
3. **双通道暴露**：tools 做细粒度检索与写操作；resources 做 `xuanji://kb/{folderId}/{docId}` URI 模板整体读取 + 订阅变更通知——省 token、可缓存。
   参照：MCP [Resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources)。
4. **写入幂等 + 明确错误语义**：`document_upsert` 的 `idempotencyKey` 写进工具描述（同 key 重放返回同结果）；错误码区分「校验失败/权限不足/冲突/不存在」四类，Agent 能据此自纠。
   参照：Dify [批量导入 batch id + 状态机](https://docs.dify.ai/en/api-reference/documents/get-document-indexing-status)。
5. **长任务句柄**：所有耗时操作返回 `{taskId}`，统一轮询接口查状态/进度/错误；杜绝「同步阻塞+另一接口猜状态」。
   参照：MCP [SEP-2663 Tasks](https://modelcontextprotocol.io/seps/2663-tasks-extension)。
6. **澄清走 MRTR，不自作主张**：检索目标含糊（如「帮我改一下那篇文档」）时，返回结构化候选（folder/文档列表）请调用方补选，而不是猜一个改掉。
   参照：MCP 2026-07-28 [InputRequiredResult / MRTR](https://modelcontextprotocol.io/specification/2026-07-28/changelog)。
7. **每次调用可溯源**：所有 MCP/REST 响应携带 `traceId`（天宫 `traceId` 机制已备，推广到全工具面）；Event Logs 按 Agent Key 记录读写删。
   参照：Outline [Audit log](https://docs.getoutline.com/s/guide/doc/audit-log-cEpf9ayBaQ)。

### 8.3 两面的交汇点：四个共享件

| 共享件 | 人的那一面 | Agent 的那一面 |
|--------|-----------|---------------|
| 检索测试台 | 调参沙箱，试出好参数 | 复用同一参数同一端点，所见即所得 |
| 引用溯源 | 编号引用卡片，点开看原文 | 响应内 `sources[]` 结构化字段 |
| 任务状态机 | 进度条+失败重试按钮 | `{taskId}` 轮询+结构化错误 |
| 审计日志 | Event Logs 页面可视化 | 按查询 API 导出、可对接告警 |

---

## 9. 参考来源汇总

> 正文每条事实已内联官方 URL；本节列各产品的官方入口（文档站/仓库/规范），供后续复查。

**Obsidian**：[help.obsidian.md](https://obsidian.md/help/data-storage) ｜ [obsidianmd/obsidian-help](https://github.com/obsidianmd/obsidian-help) ｜ [obsidianmd/obsidian-importer](https://github.com/obsidianmd/obsidian-importer) ｜ [Obsidian Sync](https://obsidian.md/sync) ｜ [File recovery](https://obsidian.md/help/plugins/file-recovery) ｜ [Obsidian URI](https://obsidian.md/fr/help/uri) ｜ [Pricing](https://obsidian.md/pricing)

**AFFiNE**：[docs.affine.pro](https://docs.affine.pro/self-host-affine/) ｜ [Workspaces](https://docs.affine.pro/core-concepts/elements-of-affine/workspaces) ｜ [BlockSuite](https://block-suite.com/api/@blocksuite/affine-block-root/variables/MarkdownTransformer.html) ｜ [AFFiNE MCP Server](https://affine.pro/mcp) ｜ [Backup and Restore](https://docs.affine.pro/self-host-affine/administer/backup-and-restore) ｜ [Pricing](https://affine.pro/pricing)

**Outline**：[docs.getoutline.com](https://docs.getoutline.com/s/guide/doc/collections-l9o3LD22sV) ｜ [Search & AI answers](https://docs.getoutline.com/s/guide/doc/search-ai-answers-NIKPvYrx06) ｜ [API](https://docs.getoutline.com/s/guide/doc/api-1rEIXDfLF6) ｜ [outline/openapi](https://raw.githubusercontent.com/outline/openapi/main/spec3.yml) ｜ [MCP Improvements](https://www.getoutline.com/changelog/mcp-improvements) ｜ [MCP Client setup](https://docs.getoutline.com/s/guide/doc/mcp-6j9jtENNKL) ｜ [Audit log](https://docs.getoutline.com/s/guide/doc/audit-log-cEpf9ayBaQ) ｜ [Export data](https://docs.getoutline.com/s/guide/doc/export-data-Da6C7HqL8M)

**AnythingLLM**：[docs.anythingllm.com](https://docs.anythingllm.com/chatting-with-documents/rag-in-anythingllm) ｜ [Default Embedder](https://docs.anythingllm.com/setup/embedder-configuration/local/built-in) ｜ [Text Splitting](https://docs.anythingllm.com/setup/embedder-configuration/text-splitting) ｜ [AI Agents](https://docs.anythingllm.com/agent/setup) ｜ [Agent Flows](https://docs.anythingllm.com/agent-flows/overview) ｜ [MCP on Docker](https://docs.anythingllm.com/mcp-compatibility/docker) ｜ [Intelligent Tool Selection](https://docs.anythingllm.com/agent/intelligent-tool-selection) ｜ [Security and Access](https://docs.anythingllm.com/features/security-and-access) ｜ [Live sync](https://docs.anythingllm.com/beta-preview/active-features/live-document-sync) ｜ [Mintplex-Labs/anything-llm](https://github.com/Mintplex-Labs/anything-llm)

**RAGFlow**：[infiniflow/ragflow docs](https://github.com/infiniflow/ragflow/blob/main/docs/quickstart.mdx) ｜ [Dataset Overview](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/dataset_overview.md) ｜ [Configuration](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/configuration.md) ｜ [Retrieval Testing](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/retrieval_testing.md) ｜ [Data Source](https://github.com/infiniflow/ragflow/blob/main/docs/guides/data_source/data_source_configuration.md) ｜ [MCP Server](https://github.com/infiniflow/ragflow/blob/main/docs/develop/mcp/use_ragflow_as_mcp_server.md) ｜ [HTTP API](https://github.com/infiniflow/ragflow/blob/main/docs/references/http_api_reference.md) ｜ [Backup & Migration](https://github.com/infiniflow/ragflow/blob/main/docs/administrator/migration/backup_and_migration.md) ｜ [Tracing](https://github.com/infiniflow/ragflow/blob/main/docs/administrator/tracing.mdx)

**Open WebUI**：[docs.openwebui.com](https://docs.openwebui.com/features/workspace/) ｜ [RAG](https://docs.openwebui.com/features/chat-conversations/rag/) ｜ [Knowledge Bases](https://github.com/open-webui/docs/blob/main/docs/features/workspace/knowledge.mdx) ｜ [RBAC](https://github.com/open-webui/docs/blob/main/docs/features/authentication-access/rbac/index.mdx) ｜ [MCP](https://github.com/open-webui/docs/blob/main/docs/features/extensibility/mcp.mdx) ｜ [API Keys](https://github.com/open-webui/docs/blob/main/docs/features/authentication-access/api-keys.md) ｜ [Analytics](https://github.com/open-webui/docs/blob/main/docs/features/administration/analytics/index.mdx) ｜ [open-webui/open-webui](https://github.com/open-webui/open-webui)

**Dify**：[docs.dify.ai](https://docs.dify.ai/llms.txt) ｜ [Knowledge API](https://docs.dify.ai/en/api-reference/guides/knowledge) ｜ [Test Retrieval](https://docs.dify.ai/en/cloud/use-dify/knowledge/test-retrieval) ｜ [Chunk Settings](https://docs.dify.ai/en/cloud/use-dify/knowledge/create-knowledge/chunking-and-cleaning-text) ｜ [Knowledge Pipeline](https://docs.dify.ai/en/cloud/use-dify/knowledge/knowledge-pipeline/create-knowledge-pipeline) ｜ [Dify Tools(MCP)](https://docs.dify.ai/en/cloud/use-dify/workspace/tools) ｜ [Publish MCP Server](https://docs.dify.ai/en/cloud/use-dify/publish/publish-mcp) ｜ [Storage & Migration](https://docs.dify.ai/en/self-host/deploy/troubleshooting/storage-and-migration) ｜ [langgenius/dify](https://github.com/langgenius/dify)

**LlamaIndex**：[docs.llamaindex.ai](https://developers.llamaindex.ai/python/framework/module_guides/loading/ingestion_pipeline/) ｜ [CitationQueryEngine](https://developers.llamaindex.ai/python/examples/query_engine/citation_query_engine/) ｜ [for-agents](https://developers.llamaindex.ai/for-agents/) ｜ [run-llama/create-llama](https://github.com/run-llama/create-llama)

**LangChain / LangGraph / LangSmith**：[docs.langchain.com](https://docs.langchain.com/oss/python/langchain/knowledge-base) ｜ [LangGraph Checkpointers](https://docs.langchain.com/oss/python/langgraph/checkpointers) ｜ [LangSmith Observability](https://docs.langchain.com/langsmith/observability) ｜ [MCP in LangChain](https://www.langchain.com/blog/mcp-in-langchain-stateless-protocol-elicitation-and-more)

**MCP 规范**：[Specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog) ｜ [官方博客发布文](https://blog.modelcontextprotocol.io/posts/2026-07-28/) ｜ [Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) ｜ [Resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources) ｜ [Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) ｜ [Security Best Practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices) ｜ [SEP-2663 Tasks](https://modelcontextprotocol.io/seps/2663-tasks-extension) ｜ [SDKs](https://modelcontextprotocol.io/docs/2026-07-28/sdk)

---

## 附录：调研方法与局限

- **检索方式**：web_search 多轮（四个研究子代理合计 40+ 轮查询）+ 关键官方页面直接抓取核实（HTTP 200/原文比对）。所有 URL 均来自搜索结果中真实出现的官方域名；未命中官方来源的事实标【未核实】，产品明确不做的标【不覆盖】。
- **交叉复核**：MCP 2026-07-28 规范、Outline 官方 MCP、AnythingLLM MCP、Dify 版本等关键事实经本报告作者独立二次检索确认；批次 A 对「Outline 官方 MCP」的【未核实】判断已被官方 changelog/docs 页推翻并更正（§3.3）。
- **局限**：snippet 级核实无法覆盖官方页面的全部细节；个别【未核实】项（如 AFFiNE 公开 API、AnythingLLM 混合检索、Dify `dataset_operator` 现行口径）建议落地前以官方页面原文复核。
- **原始底稿**：`docs/research/.notes/batch-{a-pkm,b-rag,c-dify,d-frameworks-mcp}.md`（四路研究子代理原始笔记，含逐条来源）。

# Batch-B 调研：AnythingLLM / RAGFlow / Open WebUI 知识库产品（官方源）

调研方法：仅采信官方来源（docs.anythingllm.com 及其源仓库 Mintplex-Labs/anythingllm-docs、github.com/Mintplex-Labs/anything-llm；ragflow.io 对应仓库 github.com/infiniflow/ragflow；docs.openwebui.com 及其源仓库 github.com/open-webui/docs、github.com/open-webui/open-webui）。所有 URL 均经实际抓取或搜索结果验证。检索日期：2026 年（注意各产品版本号以文中标注为准）。

## AnythingLLM（Mintplex-Labs，当前文档对应 v1.16.x）

### 信息模型
- 核心隔离单元是工作区（workspace）：LLM 只能"看到"已嵌入（embed）该工作区的文档，未嵌入的文档模型无法访问 —— [RAG in AnythingLLM](https://docs.anythingllm.com/chatting-with-documents/rag-in-anythingllm)
- 聊天内拖入的文件是 workspace+thread 作用域、以全文插入；超出上下文窗口时提示转为嵌入（RAG）—— [Using Documents in AnythingLLM](https://docs.anythingllm.com/chatting-with-documents/introduction)
- 多用户模式下，嵌入文档对所有拥有该工作区访问权的用户可见 —— [Using Documents in AnythingLLM](https://docs.anythingllm.com/chatting-with-documents/introduction)
- RAG 参数按工作区设置（工作区齿轮图标）：Search Preference（重排）、Max Context Snippets、Document similarity threshold；文档钉住（Document Pinning）按工作区全文本插入 —— [Using Documents in AnythingLLM](https://docs.anythingllm.com/chatting-with-documents/introduction)
- 嵌入模型/LLM/向量库是实例级设置（Settings > AI Providers），非工作区级；Manager 角色被禁止修改这三类设置 —— [Security and Access](https://docs.anythingllm.com/features/security-and-access)
- 系统提示词等工作区配置在工作区设置内维护；agentic 会话的模型/提供商可按工作区单独指定 —— [AI Agent Setup](https://docs.anythingllm.com/agent/setup)

### 检索/RAG 管线
- 默认嵌入模型为内置 all-MiniLM-L6-v2（CPU 运行，首次嵌入时下载 25MB，英语为主）—— [AnythingLLM Default Embedder](https://docs.anythingllm.com/setup/embedder-configuration/local/built-in)
- 嵌入 provider：本地 Built-in/Ollama/LM Studio/LocalAI/Lemonade，云 OpenAI/Azure OpenAI/Cohere/Voyage/LiteLLM/Mistral/Generic OpenAI/Gemini/OpenRouter —— [Embedding Models](https://docs.anythingllm.com/features/embedding-models)
- 分块仅一种策略：LangChain RecursiveCharacterTextSplitter，默认 chunk 1000 字符、overlap 20 字符；修改只影响此后嵌入的文档 —— [Text Splitting & Chunking](https://docs.anythingllm.com/setup/embedder-configuration/text-splitting)
- chunk size 超过嵌入模型上限时自动按模型上限截断并告警，不报错 —— [Text Splitting & Chunking](https://docs.anythingllm.com/setup/embedder-configuration/text-splitting)
- 重排："Accuracy Optimized"搜索偏好会多召回再重排，仅默认向量库 LanceDB 可用，首次使用下载模型，实测增加约 100–500ms —— [Using Documents in AnythingLLM](https://docs.anythingllm.com/chatting-with-documents/introduction)
- Max Context Snippets 控制送入 LLM 的片段数（建议 4–6），超窗自动裁剪 —— [Using Documents in AnythingLLM](https://docs.anythingllm.com/chatting-with-documents/introduction)
- 相似度阈值默认过滤低于 20% 的 chunk，可设 No Restriction —— [Using Documents in AnythingLLM](https://docs.anythingllm.com/chatting-with-documents/introduction)
- 默认向量库 LanceDB（私有内嵌），可换 Chroma/Milvus/Qdrant/Weaviate/Pinecone/AstraDB/Zilliz/Chroma Cloud —— [Vector Databases](https://docs.anythingllm.com/features/vector-databases)
- BM25/全文+向量混合检索、多路召回：官方文档未见说明【未核实】

### 引用与溯源
- RAG 机制上每个向量都附带其来源原文文本，检索时低分块被过滤 —— [RAG in AnythingLLM](https://docs.anythingllm.com/chatting-with-documents/rag-in-anythingllm)
- 回答内引用展示（文档名/片段/分数）的具体机制：官方文档站未找到专页【未核实】

### 导入与同步
- Live document sync（beta 预览）："watch" 单个已嵌入文件，检测变更后自动重嵌入并更新所有使用该文件的工作区 —— [Live document sync](https://docs.anythingllm.com/beta-preview/active-features/live-document-sync)
- 可 watch 的范围：网站链接、数据连接器采集的文件（官方举例 Confluence、GitHub、YouTube）；桌面版额外支持本地手动上传文件；桌面版每 10 分钟检查一次且应用须在线 —— [Live document sync](https://docs.anythingllm.com/beta-preview/active-features/live-document-sync)
- 数据连接器完整清单：当前文档站无专页【未核实】（仅上述页面确认 Confluence/GitHub/YouTube 与网页链接存在）
- 批量/程序化嵌入：开发者 API 可"manage, update, embed"工作区 —— [API Access & Keys](https://docs.anythingllm.com/features/api)
- 嵌入失败排查专页存在（fetch-failed-on-upload），说明上传→嵌入链路有官方排障路径 —— [Fetch failed error on embed](https://docs.anythingllm.com/fetch-failed-on-upload)

### 权限
- 单用户/多用户两种模式；多用户为 Docker 版独占，且开启后不可回退单用户 —— [Security and Access](https://docs.anythingllm.com/features/security-and-access)
- 三种角色：Admin 全权；Manager 可见所有工作区、可管理除 LLM/Embedder/向量库设置外的一切；Default 用户只能对被显式加入的工作区发消息，看不到其他工作区与系统设置 —— [Security and Access](https://docs.anythingllm.com/features/security-and-access)
- 无组/资源级 ACL 共享模型说明【不覆盖】

### Agent 工具协议
- 在任意工作区输入 `@agent <prompt>` 进入 agent 会话，`exit` 退出；技能全工作区共享，作用域为调用时所在工作区 —— [AI Agents](https://docs.anythingllm.com/features/ai-agents)
- 内置技能（官方"Using AI Agents"目录）：RAG Search、Web Browsing（默认 DuckDuckGo 免配置）、Web Scraping、Save Files、List Documents、Summarize Documents、Chart Generation、SQL Agent、File System Agent、Document Generation Agent、Gmail/Google Calendar/Outlook Agent、Scheduled Jobs —— [AI Agent Setup](https://docs.anythingllm.com/agent/setup)
- RAG Search 技能：`@agent can you check what you already know about X`，检索结果可写入 agent 自身记忆供后续召回 —— [RAG Search](https://docs.anythingllm.com/agent/usage/rag-search)
- 自定义 agent 技能：NodeJS handler.js + plugin.json（支持 setup_args 动态 UI），Docker ≥v1.2.2、Desktop ≥1.6.5，Cloud 不支持 —— [Introduction to custom agent skills](https://docs.anythingllm.com/agent/custom/introduction)
- Agent Flows：无代码可视化方式构建 agent 技能，块类型含 Web Scraper/API Call/LLM Instruction/Read File/Write File，可被 `@agent` 调用、LLM 可串联多个 flow —— [What is an Agent Flow?](https://docs.anythingllm.com/agent-flows/overview)
- MCP 官方支持（工具面）：Docker 版经 `plugins/anythingllm_mcp_servers.json`（STORAGE_LOCATION 下）配置，Agent Skills 页可视化管理（启动/停止/刷新/状态/错误日志）；仅支持 Tools，不支持 Resources/Prompts/Sampling；容器预装 npx/uv/uvx/node —— [MCP on AnythingLLM Docker](https://docs.anythingllm.com/mcp-compatibility/docker)
- MCP 不随容器启动自动拉起，打开 Agent Skills 页或调用 `@agent` 时自动启动；`anythingllm.autoStart: false` 可禁止自动启动 —— [MCP on AnythingLLM Docker](https://docs.anythingllm.com/mcp-compatibility/docker)
- Intelligent Tool Selection（默认开启）：按对话相关性只挂载相关工具/MCP 进提示词，官方称省最多 80% token、每次 chat 增加 100–500ms 重排开销 —— [Intelligent Tool Selection](https://docs.anythingllm.com/agent/intelligent-tool-selection)

### API 与工作流
- 每实例自带 API 文档页 `/api/docs`；API key 可随时创建/删除 —— [API Access & Keys](https://docs.anythingllm.com/features/api)
- 仓库内维护 OpenAPI 规范文件 server/swagger/openapi.json —— [server/swagger/openapi.json](https://github.com/Mintplex-Labs/anything-llm/blob/master/server/swagger/openapi.json)
- 工作流形态：Agent Flows（可视化）+ Scheduled Jobs（定时任务，Cron 构建器）—— [What is an Agent Flow?](https://docs.anythingllm.com/agent-flows/overview)、[Using AI Agents 目录](https://docs.anythingllm.com/agent/setup)
- 流式端点细节：官方文档页未展开【未核实】

### 备份
- Docker 持久化：必须挂载 `-v ${STORAGE_LOCATION}:/app/server/storage`，否则容器重启丢全部数据 —— [Get Started with AnythingLLM in Docker](https://docs.anythingllm.com/installation-docker/local-docker)
- 桌面版数据目录（macOS/Linux/Windows 路径）含 lancedb/、documents/、vector-cache/、models/、anythingllm.db（SQLite）、plugins/、logs/ —— [Where is my data stored?](https://docs.anythingllm.com/installation-desktop/storage)
- 知识库整体导出/备份专页：不覆盖（仅聊天日志可导出，见可观测性）

### 可观测性
- Event Logs 页记录：登录成功/失败、用户发消息、设置变更、文档上传，含事件类型/用户/时间戳 —— [Event Logs](https://docs.anythingllm.com/features/event-logs)
- Workspace Chat Logs：按工作区/用户查看，≥10 条后可导出 CSV、JSON、JSON (Alpaca)、JSONL (OpenAI fine-tune) —— [Workspace Chat Logs](https://docs.anythingllm.com/features/chat-logs)
- Admin 角色"可访问整个系统、logs、analytics" —— [Security and Access](https://docs.anythingllm.com/features/security-and-access)
- token 用量统计面板：官方文档未见【未核实】

### 易用性
- Docker 单镜像 `mintplexlabs/anythingllm:latest`，访问 http://localhost:3001 即用 —— [Quickstart](https://docs.anythingllm.com/installation-docker/quickstart)
- 桌面端 macOS/Windows/Linux 一键安装包 —— [Installation Guides 目录](https://docs.anythingllm.com/installation-desktop/overview)
- 零配置起步：内置嵌入器 + 内置 LanceDB + 默认 DuckDuckGo 搜索，无需任何 API key 即可本地跑通 RAG —— [AnythingLLM Default Embedder](https://docs.anythingllm.com/setup/embedder-configuration/local/built-in)、[AI Agent Setup](https://docs.anythingllm.com/agent/setup)
- LLM 接入向导覆盖本地（AnythingLLM Default/Ollama/LM Studio/LocalAI/KobaldCPP/oMLX）与 20+ 云提供商 —— [Language Models 目录](https://docs.anythingllm.com/features/language-models)、[README](https://github.com/Mintplex-Labs/anything-llm)
- 界面中文支持：官方文档未见 i18n 说明【未核实】

## RAGFlow（InfiniFlow，main 文档对应 v0.27.2）

### 信息模型
- Dataset（知识库）是承载知识源与检索内容的工作空间：导入→解析→分块→维护元数据→验证召回，被 Chat/Search/Agent 复用 —— [Dataset Overview](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/dataset_overview.md)
- Dataset 详情页五入口：File list（文档管理）、Retrieval Testing（检索测试）、Artifacts（Wiki/Navigation/Graph 知识产物）、Logs（解析与任务日志）、Configuration —— [Dataset Overview](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/dataset_overview.md)
- 创建 dataset 必填三项：Name、Embedding model、Parse type（Built-in 预设解析 或 Pipeline 自定义管线）—— [Dataset List and Creation](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/dataset_list_and_creation.md)
- Chunk 管理：查看/搜索/过滤/编辑（正文+关键词+问题+标签）/新增/启停用/删除，chunk 点击可联动原文预览定位 —— [Chunk: Parsing Results and Knowledge Fragment Management](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/chunk_parsing_results_and_knowledge_fragment_management.md)
- Dataset 配置含 PageRank 分数（检索时加进混合相似度，提升多库检索时的排序权重）与 Tag sets（按文本相似度批量打标，查询自动关联标签）—— [Configuration](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/configuration.md)

### 检索/RAG 管线
- 嵌入模型在 dataset 级选定；解析后更换嵌入模型会影响索引，需谨慎 —— [Configuration](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/configuration.md)
- 内置解析模板（模板化解析）：General、Q&A、Manual（层级章节 PDF）、Table（XLSX/CSV 每行一 chunk）、Paper（摘要/章节结构）、Book、Laws（法条结构切分）、Presentation（PDF/PPTX 每页一 chunk）、One（整篇一 chunk）、Tag（供标签集，不直接参与检索）—— [Configuration](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/configuration.md)
- PDF 解析器可选：DeepDoc（默认，OCR+表格结构识别 TSR+版面分析 DLR）、Naive（纯文本加速跳过 OCR）、Docling、TCADPParser（腾讯开源）、以及支持 PDF 解析的 VLM 视觉大模型 —— [Configuration](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/configuration.md)
- 分块参数：Recommended chunk size、Delimiter for text、Overlapped percent (%)、子 chunk 参与检索开关、Page Index、图像/表格上下文窗口 —— [Configuration](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/configuration.md)
- 内容增强：Auto metadata（自定义字段生成 + 内置 update_time/file_name）、Auto-keyword（每 chunk 自动关键词数）、Auto-question（每 chunk 自动问题数）—— [Configuration](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/configuration.md)
- 混合检索参数（检索测试页）：Similarity threshold（默认 0.2）、Vector similarity weight（向量权重，其余给全文/关键词相似度）、Rerank model（未选时=关键词相似度+向量余弦综合）、Cross-language search、Metadata 过滤、Top N —— [Retrieval Testing: Retrieval Test](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/retrieval_testing.md)
- 多路召回引擎：Elasticsearch 或 Infinity（v0.27.2）—— [Quickstart](https://github.com/infiniflow/ragflow/blob/main/docs/quickstart.mdx)
- 知识图谱：Agent 的 Retrieval 组件提供 "Use knowledge graph" 开关做多跳问答 —— [Agent Workflow 基础组件](https://github.com/infiniflow/ragflow/blob/main/docs/guides/agent/agent_workflow/basic_component.md)
- 知识编译（Knowledge Compilation）可从 dataset 生成 Wiki/Navigation/Graph 三类 Artifacts —— [Artifacts: Knowledge Artifact Generation and Management](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/artifacts_knowledge_artifact_generation_and_management.md)
- RAPTOR 层级摘要：main 分支 dataset 配置文档未见该项（旧版本曾有），当前状态【未核实】

### 引用与溯源
- Chat 配置："Show citations" 开启后回答展示所引用的 dataset 内容及其来源，可溯源到原文档；"Show chunk metadata" 在引用上附加 source/author/date 等元数据 —— [Chat configuration](https://github.com/infiniflow/ragflow/blob/main/docs/guides/chat/chat_configuration.md)
- 检索测试结果展示召回 chunk 内容+相关度+源文档，可按文件过滤 —— [Retrieval Testing: Retrieval Test](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/retrieval_testing.md)
- HTTP API 提供 Retrieve chunks 接口（/api/v1/retrieval）返回召回块 —— [HTTP API Reference](https://github.com/infiniflow/ragflow/blob/main/docs/references/http_api_reference.md)
- 相似度分数逐 chunk 返回的响应字段细节【未核实】（API 文档有响应示例，未逐字段核对）

### 导入与同步
- 内置数据源连接器 40+：Confluence、Notion、Google Drive、Feishu Wiki、OneDrive、SharePoint、Box、Dropbox、SeaFile、S3、Google Cloud Storage、Oracle、R2、Azure Blob、MySQL、PostgreSQL、BigQuery、GitHub、GitLab、Bitbucket、Azure DevOps、Jira、Asana、Gmail、Outlook、IMAP、Microsoft Teams、Slack、Discord、钉钉 AI 表格、Zendesk、Moodle、REST API、RSS、Sitemap、WebDAV、Airtable、Salesforce 等 —— [Data Source Configuration](https://github.com/infiniflow/ragflow/blob/main/docs/guides/data_source/data_source_configuration.md)
- 连接配置项：认证信息、同步范围、Sync deleted files、Refresh interval、Cleanup interval、Timeout；部分数据源支持测试连接 —— [Data Source Overview and Page Management](https://github.com/infiniflow/ragflow/blob/main/docs/guides/data_source/overview_and_page_management.md)
- 数据源设置页底部有同步日志（开始时间/状态/目标知识库/任务类型[首次同步/增量/清理]/摘要），便于排障 —— [Data Source Overview and Page Management](https://github.com/infiniflow/ragflow/blob/main/docs/guides/data_source/overview_and_page_management.md)
- 同步语义：首次全量导入，新增/修改内容在下一刷新周期同步，启用 Sync deleted 后外部删除会同步清理索引 —— [Add a Data Source to a Knowledge Base and Synchronization and Updates](https://github.com/infiniflow/ragflow/blob/main/docs/guides/data_source/add_to_knowledge_base_and_sync.md)
- 解析进度：文档列表 Status 列显示 等待/运行中/完成/失败/取消，支持 Parse on creation、批量 Run/Cancel —— [Files: Dataset Document Management](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/files_dataset_document_management.md)
- 失败重试：解析失败查看该文档 Logs（含执行过程与错误信息）后重新 Run —— [Files: Dataset Document Management](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/files_dataset_document_management.md)
- 0.22.0 官方发布说明：数据源同步、增强解析器、Agent 优化、Admin UI —— [RAGFlow 0.22.0 Overview](https://ragflow.com.cn/blog/ragflow-0.22.0-data-source-synchronization-enhanced-parser-agent-optimization-and-admin-ui)

### 权限
- 三层权限体系：team membership（团队成员）→ resource sharing scope（共享范围）→ resource operation permissions（操作权限）—— [Permission System Overview](https://github.com/infiniflow/ragflow/blob/main/docs/guides/team/permission_system_overview/index.md)
- 操作权限覆盖资源类型：知识库及文档、Chat 应用、Agents、MCP servers、Memories、Search 应用、模型提供商/实例/默认模型配置；权限级含 Read/Write/Manage —— [Resource Operation Permissions](https://github.com/infiniflow/ragflow/blob/main/docs/guides/team/permission_system_overview/resource_operation_permissions.md)
- 知识库共享：把 KB 的 Permissions 从 "Only me" 改为 "Team"，成员即可上传并解析文件 —— [Share Knowledge Bases](https://github.com/infiniflow/ragflow/blob/main/docs/guides/team/sharing_scope_configuration/share_knowledge_bases.md)
- 团队管理：邀请/移除成员、接受或拒绝邀请、加入/离开团队、以团队视角共享资源（开源版共享范围另有配置文档）—— [Team Management 目录](https://github.com/infiniflow/ragflow/blob/main/docs/guides/team/team_management/index.md)

### Agent 工具协议
- Agent = 无代码画布工作流编排：组件顺序/条件分支/分类/循环执行 —— [Agent Overview](https://github.com/infiniflow/ragflow/blob/main/docs/guides/agent/agent_overview.md)
- 画布组件：Begin、Agent、Retrieval、Message、Await response、Switch、Iteration、Categorize、Code、Text processing、Execute SQL、HTTP Request，及管线组件 Parser/Title chunker/Token chunker/Transformer/Indexer —— [Understand the Canvas](https://github.com/infiniflow/ragflow/blob/main/docs/guides/agent/understand_the_canvas.md)
- 工具组件：Tavily Search/Extract、Google、DuckDuckGo、SearXNG、Wikipedia、GitHub、Google Scholar、ArXiv、PubMed、BGPT、Execute SQL、Yahoo Finance、WenCai、Email、HTTP Request、DocGenerator、Browser —— [Tool Components](https://github.com/infiniflow/ragflow/blob/main/docs/guides/agent/agent_workflow/tool_components.md)
- Retrieval 组件既可编排调用，也可挂在 Agent 组件下由 LLM 自主决定何时检索（agentic RAG）—— [Agent Overview](https://github.com/infiniflow/ragflow/blob/main/docs/guides/agent/agent_overview.md)
- 变量系统：sys.query、formalized_content、chunks、content 等系统/全局/上游变量经 `/` 选择器注入组件输入 —— [Understand the Canvas](https://github.com/infiniflow/ragflow/blob/main/docs/guides/agent/understand_the_canvas.md)
- Ingestion Pipeline 可在 Agent 里搭建并绑定为 dataset 的解析方法（解析/分块/转换/索引四类节点）—— [Configuration](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/configuration.md)
- Agent 支持导入/导出（import_and_export_agents）与嵌入网页（embed_into_web_pages）—— [Agent 文档目录](https://github.com/infiniflow/ragflow/tree/main/docs/guides/agent)
- MCP 双向支持：① RAGFlow 作为 MCP server（独立组件，默认端口 9382；Self-host 模式绑 API key / Host 模式按客户端鉴权；传输 Streamable HTTP `/mcp` 与 SSE），对外暴露知识库检索等能力 —— [Use RAGFlow as an MCP Server](https://github.com/infiniflow/ragflow/blob/main/docs/develop/mcp/use_ragflow_as_mcp_server.md)、[MCP Overview](https://github.com/infiniflow/ragflow/blob/main/docs/develop/mcp/overview.md)；② RAGFlow 连接外部 MCP server，工具供 Agent 使用 —— [Connect an External MCP Server to RAGFlow](https://github.com/infiniflow/ragflow/blob/main/docs/develop/mcp/connect_an_external_mcp_to_ragflow.md)

### API 与工作流
- HTTP API 全覆盖：OpenAI 兼容 Chat/Agent completion；DATASET（创建/删除/更新/列表，含解析状态）；文件（upload/update/download/list/delete/parse/ingest/stop）；CHUNK（add/list/get/delete/update/availability/metadata 摘要与更新/Retrieve chunks）；CHAT ASSISTANT CRUD；SESSION（创建/更新/列表/删除消息/反馈/converse）；AGENT CRUD与会话 —— [HTTP API Reference](https://github.com/infiniflow/ragflow/blob/main/docs/references/http_api_reference.md)
- API key 获取有专页（Acquire a RAGFlow API key）—— [Acquire a RAGFlow API key](https://github.com/infiniflow/ragflow/blob/main/docs/develop/acquire_ragflow_api_key.md)
- 另有 Python API reference 与 OpenAI 兼容流式端点（chat completion 响应示例）—— [HTTP API Reference](https://github.com/infiniflow/ragflow/blob/main/docs/references/http_api_reference.md)

### 备份
- 默认 Docker 卷四件套：esdata01（ES 索引）、minio_data（对象存储）、mysql_data（元数据）、redis_data（队列/缓存），前缀随 compose 项目名 —— [Backup & Migration](https://github.com/infiniflow/ragflow/blob/main/docs/administrator/migration/backup_and_migration.md)
- 官方迁移脚本：`bash docker/migration.sh backup [名称]` / `restore`，打包/还原全部数据卷；明确警告 `docker compose down -v` 会删数据 —— [Backup & Migration](https://github.com/infiniflow/ragflow/blob/main/docs/administrator/migration/backup_and_migration.md)
- 默认每 KB 一个 bucket + 每用户一个 bucket，可切 Single Bucket Mode —— [Backup & Migration](https://github.com/infiniflow/ragflow/blob/main/docs/administrator/migration/backup_and_migration.md)
- 应用内知识库导出功能【不覆盖】（文档未见）

### 可观测性
- Dataset Logs：顶部统计（Total files/Processing/Downloading），分文档日志（ID/Filename/Source/Ingestion pipeline/Task/Status/Operations）与数据集级日志（如 Knowledge Compilation 任务）—— [Logs](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/logs.md)
- 官方内置 Langfuse 全链路追踪（≥0.18.0）：检查/调试每次检索与生成步骤的 trace/span/prompt —— [Tracing](https://github.com/infiniflow/ragflow/blob/main/docs/administrator/tracing.mdx)
- 用户级 token 用量统计面板【未核实】

### 易用性
- 安装要求：Docker ≥24.0.0、Compose ≥v2.26.1、`vm.max_map_count ≥ 262144`；git checkout 指定版本（示例 v0.27.2）后 `cd ragflow/docker && docker compose up -d`，浏览器访问服务器 IP —— [Quickstart](https://github.com/infiniflow/ragflow/blob/main/docs/quickstart.mdx)
- 官方支持 x86 CPU + Nvidia GPU；ARM64 仅测试不维护镜像 —— [Quickstart](https://github.com/infiniflow/ragflow/blob/main/docs/quickstart.mdx)
- 模型接入：30+ 模型提供商列表 + 本地 LLM 部署文档（deploy_local_llm）—— [Model Providers](https://github.com/infiniflow/ragflow/blob/main/docs/guides/models/supported_models.mdx)
- 默认嵌入模型：无内置默认，需在创建 dataset 时自选已配置的嵌入模型 —— [Dataset List and Creation](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/dataset_list_and_creation.md)
- 中文支持：dataset 可设 Language 影响解析语言假设；官方中文站 ragflow.com.cn 提供中文文档/博客 —— [Configuration](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/configuration.md)、[RAGFlow 引擎博客](https://ragflow.com.cn/blog/page/3)

## Open WebUI（open-webui）

### 信息模型
- Workspace 五构件：Models（模型预设）、Knowledge（知识库）、Prompts（模板）、Skills（Markdown 技能）、Tools（工具）—— [Workspace](https://docs.openwebui.com/features/workspace/)
- Knowledge base = 文档集合：Workspace > Knowledge 创建，经 `#` 在聊天中引用，或绑定到模型（Workspace > Models > Edit）—— [Knowledge Bases and Document Chat](https://github.com/open-webui/docs/blob/main/docs/features/workspace/knowledge.mdx)
- Model preset = 系统提示词+知识库+工具+技能+参数覆盖绑在一个基础模型上，成为专用 agent；同一底模可派生多个预设 —— [Models](https://github.com/open-webui/docs/blob/main/docs/features/workspace/models.md)
- RAG 设置（嵌入模型、分块）是实例级（Settings > Admin > Documents）；更换嵌入模型必须 Reindex（删集合→按当前参数重分块→重嵌入全部知识库）—— [Retrieval Augmented Generation (RAG)](https://docs.openwebui.com/features/chat-conversations/rag/)
- 向量库 13 种：ChromaDB 与 PGVector 官方维护，另有 Qdrant/Milvus/OpenSearch/Elasticsearch 等非核心集成 —— [Knowledge Bases and Document Chat](https://github.com/open-webui/docs/blob/main/docs/features/workspace/knowledge.mdx)
- 外部向量库直连（实验性）：Qdrant/Milvus/pgvector，字段映射（content/title/source/url/score 等）+ 测试查询，文档不重 ingest；要求向量与 Open WebUI 嵌入模型同源同维 —— [Retrieval Augmented Generation (RAG)](https://docs.openwebui.com/features/chat-conversations/rag/)

### 检索/RAG 管线
- 嵌入模型支持 Ollama 与 OpenAI 兼容两种接入方式，在 Admin > Documents 切换 —— [Retrieval Augmented Generation (RAG)](https://docs.openwebui.com/features/chat-conversations/rag/)
- 分块：Text splitter = character（默认 RecursiveCharacterTextSplitter，`RAG_TEXT_SPLITTER`）/ token（Tiktoken）/ token_transformers（HuggingFace tokenizer，`RAG_TOKENIZER_MODEL`）；参数 Chunk Size / Chunk Overlap / Chunk Min Size Target —— [Retrieval Augmented Generation (RAG)](https://docs.openwebui.com/features/chat-conversations/rag/)
- Markdown Header Splitting：先按 H1–H6 结构切分再走常规切分器；Min Size Target 智能合并碎片（官方实测 2000/1000 配置可减少 90% chunk 且提准确率）—— [Retrieval Augmented Generation (RAG)](https://docs.openwebui.com/features/chat-conversations/rag/)
- 混合检索：`ENABLE_RAG_HYBRID_SEARCH` 开启 BM25 关键词 + 向量检索，CrossEncoder 重排，可配相关度阈值 —— [Retrieval Augmented Generation (RAG)](https://docs.openwebui.com/features/chat-conversations/rag/)
- Top K 默认 5（agentic 检索工具 query_knowledge_files 的上限同 RAG Top K）—— [Knowledge Bases and Document Chat](https://github.com/open-webui/docs/blob/main/docs/features/workspace/knowledge.mdx)
- 文档提取引擎 8 种：Tika、Docling、Azure、Mistral OCR、Datalab Marker、MinerU、PaddleOCR、自定义 external 引擎（可按文件类型路由）—— [Knowledge Bases and Document Chat](https://github.com/open-webui/docs/blob/main/docs/features/workspace/knowledge.mdx)、[Document Extraction](https://github.com/open-webui/docs/blob/main/docs/features/chat-conversations/rag/document-extraction/index.md)
- RAG 模板：Admin > Documents 自定义，`{{CONTEXT}}` 占位符注入检索上下文；query 自动追加，模板里再写 `{{QUERY}}` 会重复 —— [Retrieval Augmented Generation (RAG)](https://docs.openwebui.com/features/chat-conversations/rag/)
- 双检索模式：Focused Retrieval（RAG，默认）vs Full Context（整文档逐字注入，适合短文档）—— [Knowledge Bases and Document Chat](https://github.com/open-webui/docs/blob/main/docs/features/workspace/knowledge.mdx)
- 网页检索集成：`#URL` 直接抓取网页；YouTube 专属 RAG 管线（转写/Captions，`YOUTUBE_LOADER_LANGUAGE` 多语言、`YOUTUBE_LOADER_PROXY_URL` 代理）；Google Drive 集成（Picker API+OAuth）—— [Retrieval Augmented Generation (RAG)](https://docs.openwebui.com/features/chat-conversations/rag/)
- 网页搜索：搜索引擎（20+ provider：Tavily/Exa/Brave/SearXNG/Google PSE/Kagi 等）与 Web Loader（读页器）分离配置 —— [Web Search](https://github.com/open-webui/docs/blob/main/docs/features/chat-conversations/web-search/index.mdx)
- Agentic 检索：原生函数调用下内置知识工具 list_knowledge / list_knowledge_bases / search_knowledge_files / query_knowledge_files / grep_knowledge_files（正则+行号）/ view_file（offset/行号分页读）；`ENABLE_KB_EXEC=True` 提供 shell 风格 kb_exec（ls/tree/grep/cat/head/tail + 管道）—— [Knowledge Bases and Document Chat](https://github.com/open-webui/docs/blob/main/docs/features/workspace/knowledge.mdx)

### 引用与溯源
- "Citations in RAG"：引用让用户追踪送入 LLM 的文档上下文 —— [Retrieval Augmented Generation (RAG)](https://docs.openwebui.com/features/chat-conversations/rag/)
- Citations 是模型级能力开关（默认开）：展示回复背后的来源，覆盖知识库、网页搜索与返回引用的内置工具；关闭则不显示任何来源 —— [Models](https://github.com/open-webui/docs/blob/main/docs/features/workspace/models.md)
- agentic 检索返回的 chunk 同样渲染为 citations（与知识库结果一致）—— [What are Tools?](https://github.com/open-webui/docs/blob/main/docs/features/extensibility/plugin/tools/index.mdx)
- 逐 chunk 相似度分数是否外显：官方文档未说明【未核实】

### 导入与同步
- 单文件聊天上传 + Knowledge 集合上传；File Manager（Settings > Data Controls > Manage Files）集中管理，删除自动清理对应 RAG 嵌入 —— [Retrieval Augmented Generation (RAG)](https://docs.openwebui.com/features/chat-conversations/rag/)
- 网页抓取（#URL）、YouTube 转写、Google Drive 导入（见上）—— [Retrieval Augmented Generation (RAG)](https://docs.openwebui.com/features/chat-conversations/rag/)
- 增量目录同步：本地文件夹镜像进 KB（仅传新增/修改，删除同步移除，保留目录结构）；远程源（Git/Confluence/S3 等 45+ 源）经官方周边工具 oikb 持续同步 —— [Knowledge Bases and Document Chat](https://github.com/open-webui/docs/blob/main/docs/features/workspace/knowledge.mdx)、[README](https://github.com/open-webui/open-webui/blob/main/README.md)
- 知识库可导出 zip 备份，并可通过 REST API 管理 —— [Knowledge Bases and Document Chat](https://github.com/open-webui/docs/blob/main/docs/features/workspace/knowledge.mdx)
- "Save Search Results to Knowledge" Function Action：一键把带引用的网页搜索结果批量存入知识库（自动去重）—— [Save Search Results to Knowledge](https://github.com/open-webui/docs/blob/main/docs/features/chat-conversations/web-search/save-to-knowledge.mdx)
- Reindex 只处理知识库内文件、且基于首次提取文本（不重新解析）；聊天内直传文件不在 reindex 范围 —— [Retrieval Augmented Generation (RAG)](https://docs.openwebui.com/features/chat-conversations/rag/)

### 权限
- 三层 RBAC：Roles（admin/user/pending）、Permissions（Workspace/Sharing/Chat/Features/Settings 五类细粒度开关）、Groups（用户组 + 资源 ACL）；权限为加法模型（角色默认权 + 组授权取并集）—— [Role-Based Access Control (RBAC)](https://github.com/open-webui/docs/blob/main/docs/features/authentication-access/rbac/index.mdx)
- 角色：Admin 超管（默认旁路权限检查，`BYPASS_ADMIN_ACCESS_CONTROL` 关闭后受 ACL 约束）；User 完全靠授权；Pending 零权限待审批 —— [Roles](https://github.com/open-webui/docs/blob/main/docs/features/authentication-access/rbac/roles.md)
- 新用户默认角色由 `DEFAULT_USER_ROLE`（pending/user/admin）控制；首个注册用户自动成为 Admin —— [Roles](https://github.com/open-webui/docs/blob/main/docs/features/authentication-access/rbac/roles.md)
- 模型/知识库/工具等资源可设 Private（仅所有者+授权对象）、按组/按用户授 Read/Write、或 Public（全体登录用户可读）—— [Groups](https://github.com/open-webui/docs/blob/main/docs/features/authentication-access/rbac/groups.md)
- 共享类权限独立细分：Knowledge Sharing / Knowledge Public Sharing / Models Sharing 等，按资源族逐一授权 —— [Permissions](https://github.com/open-webui/docs/blob/main/docs/features/authentication-access/rbac/permissions.md)
- 模型绑定知识库时访问即被限定（scoping）：绑定的 KB 外内容模型不可达；Admin 有 Preview User/Group Access 面板聚合查看可达资源 —— [Groups](https://github.com/open-webui/docs/blob/main/docs/features/authentication-access/rbac/groups.md)

### Agent 工具协议
- 工具四分法：Native Features（内置）、Workspace Tools（Python 自定义插件）、MCP、OpenAPI/Function Calling Servers —— [What are Tools?](https://github.com/open-webui/docs/blob/main/docs/features/extensibility/plugin/tools/index.mdx)
- 工具调用模式：Native（原生函数调用，agentic 模式，官方称唯一支持模式）与 Legacy（提示词注入，兼容旧模型）—— [What are Tools?](https://github.com/open-webui/docs/blob/main/docs/features/extensibility/plugin/tools/index.mdx)
- Functions 四类：Pipe（接管模型调用）、Filter（入口/出口处理）、Action（消息按钮动作）、Event（事件回调）—— [Functions](https://github.com/open-webui/docs/blob/main/docs/features/extensibility/plugin/functions/index.mdx)
- Pipelines：UI 无关的 OpenAI API 插件框架（独立进程，Docker 部署）—— [Pipelines](https://github.com/open-webui/docs/blob/main/docs/features/extensibility/pipelines/index.mdx)
- 原生 MCP 支持（v0.6.31+）：Settings > Admin > Integrations 添加 MCP (Streamable HTTP) 工具服务器，认证支持 None/Bearer/OAuth 2.1(DCR)/OAuth 2.1(Static)；仅管理员可添加 MCP 服务器，可经 Access Control 分配给用户/组 —— [Model Context Protocol (MCP)](https://github.com/open-webui/docs/blob/main/docs/features/extensibility/mcp.mdx)
- mcpo：官方 MCP→OpenAPI 代理，把 stdio MCP 服务器包装成 OpenAPI 端点供 Open WebUI 与一般客户端使用 —— [MCP Support (mcpo)](https://github.com/open-webui/docs/blob/main/docs/features/extensibility/plugin/tools/openapi-servers/mcp.mdx)
- 有 Direct Tool Servers 权限的普通用户可自接 OpenAPI 工具服务器（MCP 不开放）—— [Model Context Protocol (MCP)](https://github.com/open-webui/docs/blob/main/docs/features/extensibility/mcp.mdx)
- Skills：Markdown 指令集（方法论/步骤/家规），`$` 即时注入，绑定模型后懒加载（仅清单入上下文，按需 view_skill）—— [Skills](https://github.com/open-webui/docs/blob/main/docs/features/workspace/skills.md)
- 内置工具类别：Time/Memory/Chats/Notes/Knowledge/Channels/Files/Task Management/Automations（模型编辑器按类勾选）—— [Models](https://github.com/open-webui/docs/blob/main/docs/features/workspace/models.md)
- 工作流画布类编排（节点图）：不覆盖（Open WebUI 无内置可视化工作流，靠 Pipelines/外部编排）

### API 与工作流
- API key：每账号一枚、`Authorization: Bearer`、以创建者身份继承角色与组权限且每次请求实时校验；全局 `ENABLE_API_KEYS` 开关 + 组级 feature 权限；可限制可访问路由 —— [API Keys](https://github.com/open-webui/docs/blob/main/docs/features/authentication-access/api-keys.md)
- Swagger 文档链接（实例 /docs），官方 API Endpoints 文档列出：Models 全量/管理（导出导入同步 models.json）、Chat Completions（OpenAI 兼容）、Anthropic Messages API、Ollama API 代理、RAG（文件上传/知识库）端点 —— [API Endpoints](https://docs.openwebui.com/reference/api-endpoints/)
- Chat Completions 支持流式；经 API 调用时 Filter/Function 行为有专节说明 —— [API Endpoints](https://docs.openwebui.com/reference/api-endpoints/)

### 备份
- Docker 卷：`open-webui:/app/backend/data`（数据库+上传+向量库）与 `ollama:/root/.ollama`；官方 compose 已含，自组 compose 必须显式挂载 —— [Backups](https://github.com/open-webui/docs/blob/main/docs/tutorials/maintenance/backups.md)、[README](https://github.com/open-webui/open-webui/blob/main/README.md)
- 备份教程标注为社区贡献（非官方团队支持），含 docker volume inspect 定位宿主路径、直接 host bind 方案 —— [Backups](https://github.com/open-webui/docs/blob/main/docs/tutorials/maintenance/backups.md)
- 知识库级导出 zip（见导入与同步）—— [Knowledge Bases and Document Chat](https://github.com/open-webui/docs/blob/main/docs/features/workspace/knowledge.mdx)

### 可观测性
- Analytics（仅 Admin，Settings > Admin > Analytics）：消息量（按模型/时段）、token 用量（成本估算）、用户活跃、时序趋势（24h/7d/…），数据来自消息库，`ENABLE_ADMIN_ANALYTICS` 可关 —— [Analytics](https://github.com/open-webui/docs/blob/main/docs/features/administration/analytics/index.mdx)
- 个人 Usage 页（每个用户免配置）：输入/输出 token 总量、消息与聊天数、活跃热图、最长连击、最常用模型与工具（近 730 天，本人数据）—— [Analytics](https://github.com/open-webui/docs/blob/main/docs/features/administration/analytics/index.mdx)
- 会话级日志导出 CSV/JSON：聊天记录可经 API/设置导出【未核实】（Analytics 文档未展开）

### 易用性
- 安装：`pip install open-webui && open-webui serve`（Python 3.11，http://localhost:8080）或 `docker run -d -p 3000:8080 -v open-webui:/app/backend/data ghcr.io/open-webui/open-webui:main` —— [README](https://github.com/open-webui/open-webui/blob/main/README.md)
- 官方镜像变体：`:ollama`（内置 Ollama）、`:cuda`（NVIDIA 加速）；桌面原生 App（macOS/Windows/Linux，内置 llama.cpp 可全本地推理）—— [README](https://github.com/open-webui/open-webui/blob/main/README.md)
- 首个账户即 Admin，向导式连接 provider（OpenAI 兼容/Ollama 等）；默认嵌入与分块开箱可用 —— [README](https://github.com/open-webui/open-webui/blob/main/README.md)、[Roles](https://github.com/open-webui/docs/blob/main/docs/features/authentication-access/rbac/roles.md)
- 中文界面：官方文档未见 i18n 专页【未核实】

## 对璇玑知识库的启示
- 默认嵌入模型是傻瓜式第一关：AnythingLLM 内置 all-MiniLM-L6-v2 首嵌自动下载即用；Open WebUI 默认参数开箱可跑、换模型一键 Reindex——璇玑应提供"零 key 默认嵌入 + 更换模型自动重建索引"，并把模型上限自动钳制（AnythingLLM 的做法）防呆。
- 解析进度可视化照抄 RAGFlow：文档列表 Status（等待/运行/完成/失败/取消）+ 文档级 Logs（任务/状态/错误详情）+ 失败后一键重跑（Run），数据源另有独立同步日志——这是把"傻瓜式"落到排障上的范本。
- 检索测试页是 RAGFlow 最值得抄的单页：阈值/向量权重/rerank/Top N 即调即测、结果带相关度+源文档+按文件过滤，并明示"测试参数不自动同步到应用"——璇玑应有同款"调参沙箱"。
- 引用展示双开关（RAGFlow Show citations / Show chunk metadata；Open WebUI Citations 能力默认开）：回答必须可溯源到文档名与片段，元数据可选展示。
- 面向 Agent 的工具面三选一已收敛：RAGFlow MCP server（Streamable HTTP/SSE，暴露知识库检索）最直接；Open WebUI 原生 MCP client（admin 添加+ACL 分发）适合多工具聚合；AnythingLLM 的 Intelligent Tool Selection 证明工具多时必须按相关性裁剪挂载以省 token。
- 工作区级权限照 RAGFlow 三层（团队→共享范围→Read/Write/Manage）设计最完整；Open WebUI 的 Private/组/用户 Read-Write ACL 与"模型绑定知识库即限定可达范围"也值得借鉴。
- 模板化解析降低用户心智：RAGFlow 内置 Paper/Book/Laws/Manual/Table/Q&A 模板 + DeepDoc/Docling/VLM 解析器可选，比单一通用分块更傻瓜；璇玑可按文档类型给推荐模板 + 默认值。
- 同步语义要对齐用户预期：RAGFlow"首次全量+刷新周期增量+可选删除同步"与 AnythingLLM watch 文件自动重嵌入是两条已验证路线；璇玑的 watch 同步必须显式声明成本（嵌入费用）与停止条件（进程关闭即停）。

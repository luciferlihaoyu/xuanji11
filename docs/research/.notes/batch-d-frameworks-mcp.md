# Batch D 调研笔记：LlamaIndex / LangChain 知识库与 RAG 能力 + MCP 官方规范

> 调研方式：web_search 检索 + 对官方页面/.md 端点直接抓取核实（HTTP 200 验证）。
> 采信范围：docs.llamaindex.ai / developers.llamaindex.ai / llamaindex.ai / github.com/run-llama；
> docs.langchain.com / reference.langchain.com / langchain.com / github.com/langchain-ai；
> modelcontextprotocol.io / modelcontextprotocol.org / modelcontextprotocol.info / blog.modelcontextprotocol.io / github.com/modelcontextprotocol / registry.modelcontextprotocol.io。
> 核实时间：2026-09（当前 MCP 最新修订版 2026-07-28）。

## Part 3: MCP 官方规范（重点，先写——两个框架的 MCP 能力都要对齐它）

### 规范版本与修订时间线
- MCP 官方规范修订版序列：2024-11-05 → 2025-03-26 → 2025-06-18 → 2025-11-25 → **2026-07-28（当前最新）** —— [Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- 2026-07-28 修订版发布公告（官方博客）—— [The 2026-07-28 Specification](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- 规范采用 SEP 流程管理（seps/ 目录、PR 编号、sponsor 制），并新增「功能生命周期与废弃政策」：Active/Deprecated/Removed 三态、最少 12 个月废弃窗口、官方废弃特性登记表 —— [Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- 2026-07-28 废弃登记表位置 /specification/2026-07-28/deprecated，跟踪所有处于 Deprecated 状态的特性 —— [Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- 官方文档站提供 llms.txt 全量索引，且每页可加 `.md`/`index.md` 取原始 Markdown——官方明确定位「供 Agent 消费」 —— [Model Context Protocol llms.txt](https://modelcontextprotocol.io/llms.txt)

### 2026-07-28 核心范式转变（相对 2025-06-18/2025-11-25）
- 移除 `initialize`/`notifications/initialized` 握手，协议全面无状态化：每个请求经 `_meta` 携带 `io.modelcontextprotocol/protocolVersion`、`clientCapabilities`、`clientInfo`，结果 `_meta` 携带 `serverInfo`；版本不匹配返回 `UnsupportedProtocolVersionError`（SEP-2575） —— [Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- 新增 `server/discover` RPC：服务器必须实现，用于自报支持的协议版本/能力/身份；客户端可首发调用做版本选择或 stdio 兼容探测（SEP-2575） —— [Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- 移除协议级会话与 Streamable HTTP 的 `Mcp-Session-Id` 头；`tools/list`、`resources/list`、`prompts/list` 等列表端点不再随连接变化；需要跨调用状态用服务器自铸句柄（opaque handle）当普通工具参数传（SEP-2567） —— [Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- 多轮往返请求（MRTR）模式取代服务器主动发起的 `roots/list`、`sampling/createMessage`、`elicitation/create`：服务器返回 `InputRequiredResult`（`resultType: "input_required"`，`inputRequests` 携带所需信息），客户端把 `inputResponses` 附在原请求重试中；所有结果新增必填 `resultType` 字段（`"complete"`/`"input_required"`），旧版省略视为 `complete`（SEP-2322） —— [Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- 移除 `ping`、`logging/setLevel`、`notifications/roots/list_changed`；日志级别改为每请求 `_meta["io.modelcontextprotocol/logLevel"]`（SEP-2575） —— [Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- 实验性 tasks 移出核心协议，改为官方扩展 `io.modelcontextprotocol/tasks`：以 `tasks/get` 轮询 + 新增 `tasks/update`（客户端→服务器补充输入）取代阻塞式 `tasks/result`（SEP-2663） —— [Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- 新增 `CacheableResult` 接口：`tools/list`、`prompts/list`、`resources/list`、`resources/read`、`resources/templates/list` 结果必须带 `ttlMs`（新鲜度提示）与 `cacheScope`（`public`/`private`），与既有 `listChanged` 通知互补（SEP-2549） —— [Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- 服务器 SHOULD 以确定性顺序返回 `tools/list`，便于客户端缓存与提升 LLM prompt cache 命中率 —— [Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- OpenTelemetry trace 上下文传播约定写入规范（`_meta` 中 `traceparent`/`tracestate`/`baggage`）—— [Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- 错误码分配政策：`-32000~-32019` 实现自定义（存量豁免），`-32020~-32099` 规范保留；`UnsupportedProtocolVersion` 定为 `-32022` —— [Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)

### 废弃清单（新实现不得采用）
- Roots、Sampling、Logging 三大特性整体废弃（SEP-2577），官方迁移建议：目录/文件改走工具参数、资源 URI 或服务器配置；Sampling 改为直连 LLM provider API；Logging 改 stderr（stdio）或 OpenTelemetry —— [Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- HTTP+SSE 传输（2025-03-26 起废弃）按生命周期政策正式归类 Deprecated，迁移到 Streamable HTTP（SEP-2596） —— [Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- OAuth 2.0 动态客户端注册（RFC 7591）废弃，改用 Client ID Metadata Documents（SEP-2577/#2858）；`elicitationId` 与 `notifications/completion`（2025-11-25 引入）随 MRTR 一并移除 —— [Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)

### 核心原语：Tools
- Tools 页（最新版）：服务器经 `tools/list`（cursor 分页，返回 `nextCursor`）暴露、客户端经 `tools/call` 调用 —— [Tools - Model Context Protocol](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- Tool 定义含 `name`/`title`/`description`/`inputSchema`/`outputSchema`/`annotations`；`outputSchema` 为 JSON Schema（默认 2020-12），结构化结果经 `structuredContent` 字段返回且与 LLM 上下文相互独立 —— [Tools - Model Context Protocol](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- 四个工具行为注解 hint：`readOnlyHint`、`destructiveHint`、`idempotentHint`、`openWorldHint` 定义于官方 schema（2025-06-18 tag 实测存在） —— [Tools - Model Context Protocol](https://modelcontextprotocol.org/specification/2025-06-18/server/tools)
- 规范明示注解是「提示且不可信」：出于信任与安全，客户端必须（MUST）将工具注解视为不可信，除非来自受信服务器——即 hint 不构成安全边界 —— [Tools - Model Context Protocol](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- 工具命名规约：1–128 字符、区分大小写、限字母数字 `_-.`、服务器内唯一；聚合多服务器时可能同名冲突，聚合器 SHOULD 处理 —— [Tools - Model Context Protocol](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- 2026-07-28 新增 `x-mcp-header` 注解：工具参数可声明为 HTTP 头传递（SEP-2243），POST 请求要求标准头 `Mcp-Method`/`Mcp-Name` —— [Tools - Model Context Protocol](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)

### 核心原语：Resources / Prompts / Sampling / Elicitation
- Resources 以 URI 标识、`resources/read` 读取，支持 RFC 6570 URI 模板（`uriTemplate`，如 `file:///{path}`）与 `resources/templates/list`；资源/资源模板/内容块均支持 `annotations`（audience/priority 等）提示客户端如何使用与展示 —— [Resources - Model Context Protocol](https://modelcontextprotocol.io/specification/2026-07-28/server/resources)
- 2026-07-28 用单一长连接 `subscriptions/listen`（POST 响应流）取代原 HTTP GET 端点与 `resources/subscribe`/`resources/unsubscribe`；客户端按类型订阅（`toolsListChanged`、`promptsListChanged`、`resourcesListChanged`、`resourceSubscriptions`），服务器以 `io.modelcontextprotocol/subscriptionId` 标注通知 —— [Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- Prompts 原语（`prompts/list`、`prompts/get`）在最新版继续存在 —— [Prompts - Model Context Protocol](https://modelcontextprotocol.io/specification/2026-07-28/server/prompts)
- Sampling（`sampling/createMessage`，服务器反向请求客户端侧 LLM 补全）定义于 2025-06-18 —— [Sampling - Model Context Protocol](https://modelcontextprotocol.io/specification/2025-06-18/client/sampling)
- Elicitation（`elicitation/create`，服务器向用户征询输入）于 2025-06-18 修订版首次加入 —— [Elicitation - Model Context Protocol](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation)
- 2026-07-28 中 Sampling 被废弃、Elicitation 改由 MRTR 的 `InputRequiredResult` 模式承载（详见上文范式转变） —— [Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)

### 传输层与生命周期
- 传输层两种：stdio 与 Streamable HTTP —— [Streamable HTTP - Model Context Protocol](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- 2026-07-28 的 Streamable HTTP 移除 SSE 断线续传与消息重投（`Last-Event-ID`/事件 ID）：响应流断掉即丢失进行中请求，客户端必须以新请求 ID 重新发起（SEP-2575） —— [Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- 原「生命周期 initialize 握手与版本协商」页面在 2026-07-28 已改写为「Versioning and Compatibility」：无协商握手，每个请求自带协议版本，服务器逐请求接受或拒绝 —— [Versioning and Compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/lifecycle)

### 授权（OAuth）
- 授权框架基于 OAuth 2.1（draft-ietf-oauth-v2-1-13）：受保护 MCP 服务器充当 OAuth 2.1 resource server，MCP 客户端充当 client —— [Authorization - Model Context Protocol](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- MCP 服务器必须（MUST）实现 OAuth 2.0 Protected Resource Metadata（RFC 9728），客户端必须用它做授权服务器发现；同时必须支持 RFC 8414 授权服务器元数据发现；RFC 8707 Resource Indicators 纳入 —— [Authorization - Model Context Protocol](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- OAuth Client ID Metadata Documents（draft-ietf-oauth-client-id-metadata-document-00）成为推荐注册方式，RFC 7591 动态注册废弃保留兼容 —— [Authorization - Model Context Protocol](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)

### 安全最佳实践（官方页面）
- 官方安全页逐条给出攻击面与缓解，开篇即 confused deputy：MCP 代理服务器用静态 client ID 连第三方 API + 允许动态注册 + 第三方授权服务器种 consent cookie + 代理缺每客户端同意校验时，恶意客户端可绕过用户同意拿授权码 —— [Security Best Practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)
- 官方要求与 IETF RFC 9700（OAuth 2.0 安全最佳实践）同读，token 受众绑定（resource indicator，RFC 8707）与 protected resource metadata 是配套防线 —— [Security Best Practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)

### 官方 SDK 与 Registry
- 官方 SDK 分层（Tier 制）：TypeScript、Python、C#、Go、Rust 为 Tier 1；Java 为 Tier 2（仓库 modelcontextprotocol/{typescript,python,csharp,go,rust,java}-sdk） —— [SDKs](https://modelcontextprotocol.io/docs/2026-07-28/sdk)
- 官方 Registry 上线于 registry.modelcontextprotocol.io（页面标题实测「Official MCP Registry」），预览公告发布在官方 info 站 —— [Introducing the MCP Registry](https://modelcontextprotocol.info/blog/mcp-registry-preview/)

## Part 1: LlamaIndex

### 信息模型：Document/Node 与存储抽象
- Documents/Nodes 模块指南：Document 是文本+元数据容器，Node 是可检索最小单元，支持层级与关系图（父子、前后） —— [Documents / Nodes](https://developers.llamaindex.ai/python/framework/module_guides/loading/documents_and_nodes/)
- NodeRelationship 类型（TS API）：`SOURCE`、`PARENT`、`PREVIOUS`、`NEXT`、`CHILD`，构成文档层级/顺序/来源的关系图 —— [NodeRelationship](https://ts.llamaindex.ai/docs/api/type-aliases/NodeRelationship)
- Storing 模块指南：默认存储分三类抽象——vector store（嵌入）、document store（Node）、index store（索引元数据），经 StorageContext 组装切换后端 —— [Storing](https://developers.llamaindex.ai/python/framework/module_guides/storing/)
- RAG 五步心智模型中 storing 为独立一步（加载→解析→索引→存储→查询），存储后端可插拔 —— [Storing](https://developers.llamaindex.ai/python/framework/understanding/rag/storing/)
- 可插拔向量库清单的官方规模数字【未核实】；官方入口为 storing 模块指南与 integrations 页 —— [Storing](https://developers.llamaindex.ai/python/framework/module_guides/storing/)

### Ingestion Pipeline：转换、缓存与增量
- Ingestion Pipeline 把「加载→转换（分块/embedding/元数据抽取）」编成声明式管线，组件化可替换 —— [Ingestion Pipeline](https://developers.llamaindex.ai/python/framework/module_guides/loading/ingestion_pipeline/)
- 管线内置 docstore 缓存：重复运行时对已处理文档跳过重复计算，官方以「cache + 增量更新」为设计点（upsert/duplicate 检测能力同页） —— [Ingestion Pipeline](https://developers.llamaindex.ai/python/framework/module_guides/loading/ingestion_pipeline/)
- LlamaParse 已升级为完整文档平台：Parse（版面感知 OCR，PDF/扫描件/表格/图表转 markdown/text/JSON）、Extract（结构化抽取）、Classify（分类）、Split（拆分）统一入口 —— [LlamaParse Platform Quickstart](https://developers.llamaindex.ai/llamaparse/)
- Parse 定位为「为 LLM 管线打造的 agentic 文档解析器」 —— [Overview of Parse](https://developers.llamaindex.ai/llamaparse/parse/)
- LlamaCloud Index 相关文档已移入 deprecated 目录（data sinks/sources、embedding models 等），平台重心转向 Parse/Extract/Split —— [Index Examples](https://developers.llamaindex.ai/llamaparse/deprecated/cloud-index/examples/)

### 检索：Retriever/QueryEngine/混合/路由/引用
- Retriever 模块指南：检索是独立抽象层，可组合（检索器之间、检索器+查询引擎解耦） —— [Retrievers](https://developers.llamaindex.ai/python/framework/module_guides/querying/retriever/)
- Router 模块指南：按查询动态路由到不同查询引擎/检索器/索引 —— [Routers](https://developers.llamaindex.ai/python/framework/module_guides/querying/router/)
- Retriever Router Query Engine 官方示例：用 Router 在多个检索器间选择 —— [Retriever Router Query Engine](https://developers.llamaindex.ai/python/examples/query_engine/retrieverrouterqueryengine/)
- 混合检索官方形态：Reciprocal Rerank Fusion Retriever（多检索器结果倒数排名融合+重排） —— [Reciprocal Rerank Fusion Retriever](https://developers.llamaindex.ai/python/framework/integrations/retrievers/reciprocal_rerank_fusion/)
- auto-retrieval（自动从自然语言推断检索过滤器，VectorIndexAutoRetriever）在旧版文档有专页，当前新版站点未单列页面【未核实新版位置】 —— [Routers](https://developers.llamaindex.ai/python/framework/module_guides/querying/router/)
- CitationQueryEngine 官方示例：回答按 source node 切片输出引用编号+引文，实现答案级溯源 —— [CitationQueryEngine](https://developers.llamaindex.ai/python/examples/query_engine/citation_query_engine/)

### Agent：工作流与 MCP 接入
- AgentWorkflow/FunctionAgent 官方教程：多 agent 工作流（handoff/工具代理），页内含 human-in-the-loop 环节 —— [FunctionAgent / AgentWorkflow Basic Introduction](https://developers.llamaindex.ai/python/examples/agent/agent_workflow_basic/)
- LlamaIndex 官方 Python 模块指南已内置 MCP 章节（客户端接入 MCP 服务器把 MCP 工具转为框架工具） —— [Model Context Protocol (MCP)](https://developers.llamaindex.ai/python/framework/module_guides/mcp/)
- 官方推出「面向 Agent 的 LlamaIndex」门户：MCP 服务器、agent skills、插件、workflow 节点的一站式地图 —— [Using LlamaIndex with AI Agents](https://developers.llamaindex.ai/for-agents/)
- 官方托管 LlamaIndex 文档检索 MCP 服务器，供任意 Agent 接入查文档 —— [MCP Documentation Search](https://developers.llamaindex.ai/for-agents/mcp/)
- 官方博客：LlamaIndex 文档站原生接入 MCP 搜索 —— [Adding Native MCP to LlamaIndex Docs](https://www.llamaindex.ai/blog/adding-native-mcp-to-llamaindex-docs)
- LlamaCloud 为托管服务层（解析/索引/检索托管），配套 docs.cloud.llamaindex.ai 站点（实测 200） —— [LlamaParse Platform Quickstart](https://developers.llamaindex.ai/llamaparse/)

### 可观测性与评估
- Observability 模块指南：一行代码接入第三方观测平台（secret key/回调方式切换 provider），新版拆出 Callbacks 页 —— [Observability](https://developers.llamaindex.ai/python/framework/module_guides/observability/)
- Evaluating 模块指南：评估模块覆盖 faithfulness/relevancy/correctness 等指标 —— [Evaluating](https://developers.llamaindex.ai/python/framework/module_guides/evaluating/)
- 评估使用模式官方页（数据集构建、evaluate() 入口） —— [Evaluating - Usage Pattern](https://developers.llamaindex.ai/python/framework/module_guides/evaluating/usage_pattern/)
- 具体接入 partner 清单（Arize Phoenix、Langfuse 等）在 observability 页以 provider 形式列出【 partners 名单未逐一核验】 —— [Observability](https://developers.llamaindex.ai/python/framework/module_guides/observability/)

### 易用性：脚手架
- create-llama 官方脚手架仓库（run-llama/create-llama，实测 200）：交互式生成 LlamaIndex 应用（前端+后端模板），自称「the easiest way to get started with LlamaIndex」 —— [Create Llama](https://github.com/run-llama/create-llama)
- LlamaIndex 文档对 Agent 友好：全站 llms.txt + 每页 `index.md` 原始 Markdown + `api/read` 分页接口 —— [Using LlamaIndex with AI Agents](https://developers.llamaindex.ai/for-agents/)

## Part 2: LangChain / LangGraph

### 信息模型：Document 与 RAG 组件
- 官方 RAG「知识库」指南页：Document（page_content+metadata）→ 切分 → 嵌入 → 向量库 → 检索的官方主线教程 —— [Knowledge base](https://docs.langchain.com/oss/python/langchain/knowledge-base)
- 文档加载器参考总览（langchain-community 文档加载器目录） —— [document_loaders | langchain_community](https://reference.langchain.com/python/langchain-community/document_loaders)
- 文档加载器 integrations 索引（数十种数据源：Google Drive、S3、Notion、Confluence 等） —— [Document loader integrations](https://docs.langchain.com/oss/python/integrations/document_loaders/index.md)
- 文本切分器 integrations 索引（字符切分、代码切分、语义切分等） —— [Text splitter integrations](https://docs.langchain.com/oss/python/integrations/splitters/index.md)
- Retriever integrations 索引（含父文档/多查询等可组合检索器入口） —— [Retriever integrations](https://docs.langchain.com/oss/python/integrations/retrievers/index.md)
- ParentDocumentRetriever 参考页（小块检索+返回父块上下文的双层检索经典模式） —— [ParentDocumentRetriever | langchain_classic](https://reference.langchain.com/python/langchain-classic/retrievers/parent_document_retriever/ParentDocumentRetriever)
- VectorStore/Retriever 为官方抽象接口，v1 后经典实现集中于 langchain-classic/reference 体系【v1 中 Retriever 接口细节页面未在 llms.txt 单列，未核实】 —— [Knowledge base](https://docs.langchain.com/oss/python/langchain/knowledge-base)

### LangGraph：图状态机、持久化、HITL、时间旅行、部署
- Checkpointers 官方文档：图状态按 step 持久化，checkpointer 接口可接 SQLite/Postgres 等后端 —— [Checkpointers - Docs by LangChain](https://docs.langchain.com/oss/python/langgraph/checkpointers)
- Checkpointer integrations 索引（官方列出的持久化后端清单） —— [Checkpointer integrations](https://docs.langchain.com/oss/python/integrations/checkpointers/index.md)
- Interrupts 官方文档：interrupt() 暂停图执行等人工输入，恢复后从断点续跑（human-in-the-loop 标准姿势） —— [Interrupts - Docs by LangChain](https://docs.langchain.com/oss/javascript/langgraph/interrupts)
- Use time-travel 官方文档：基于 checkpoint 历史回放/分叉执行状态（时间旅行调试） —— [Use time-travel - Docs by LangChain](https://docs.langchain.com/oss/javascript/langgraph/use-time-travel)
- Deployment 官方文档：LangGraph 应用可本地 dev server 或 LangGraph Platform 部署 —— [Deployment - Docs by LangChain](https://docs.langchain.com/oss/python/langgraph/deploy)
- LangGraph Platform 官宣 GA：长时运行有状态 agent 的托管部署/管理平面 —— [LangGraph Platform is now Generally Available](https://www.langchain.com/blog/langgraph-platform-ga)

### LangSmith：tracing、评估、监控
- LangSmith 观测页（tracing/监控入口，实测 200） —— [Observability](https://docs.langchain.com/langsmith/observability)
- 评估教程：构建数据集→跑实验→LLM 判分评估 chatbot 的官方路径 —— [Evaluate a chatbot - Docs by LangChain](https://docs.langchain.com/langsmith/evaluate-chatbot-tutorial)
- 数据集管理（UI 创建/管理评测数据集） —— [Create and manage datasets in the UI - Docs by LangChain](https://docs.langchain.com/langsmith/manage-datasets-in-application)
- LangSmith 文档规模：官方 llms.txt 显示主站 /langsmith 分区 460 页 + smith-api 358 页（文档体系庞大且全量机读） —— [Docs by LangChain llms.txt](https://docs.langchain.com/llms.txt)

### MCP 生态
- langchain-mcp-adapters 仓库 README 官宣「不再积极维护」：MCP 支持已并入 LangChain 主库 `langchain.mcp` 命名空间（`pip install langchain[mcp]`），支持 stateless 协议、elicitation 等 —— [LangChain MCP Adapters](https://github.com/langchain-ai/langchain-mcp-adapters)
- 官方迁移公告：MCP in LangChain（stateless protocol、elicitation and more） —— [MCP in LangChain: stateless protocol, elicitation and more](https://www.langchain.com/blog/mcp-in-langchain-stateless-protocol-elicitation-and-more)
- 官方迁移指南：langchain-mcp-adapters → langchain[mcp] —— [LangChain MCP adapters migration](https://docs.langchain.com/oss/python/migrate/langchain-mcp-adapters)
- 新代码位置：langchain 主库 libs/langchain_v1/langchain/mcp —— [LangChain MCP Adapters](https://github.com/langchain-ai/langchain-mcp-adapters)
- JS/TS 版适配器仍在 langchainjs 仓库内（libs/langchain-mcp-adapters），参考页 reference.langchain.com/javascript/langchain-mcp-adapters —— [LangChain MCP Adapters](https://github.com/langchain-ai/langchain-mcp-adapters)
- LangGraph 平台对 MCP 的原生支持页面【未核实独立页面；以迁移指南与适配器文档为准】 —— [LangChain MCP adapters migration](https://docs.langchain.com/oss/python/migrate/langchain-mcp-adapters)

### 易用性：v1 简化 API 与 deep agents
- What's new in LangChain v1 官方发布页：v1 以 create_agent 为核心简化 API，抽象收敛 —— [What's new in LangChain v1 - Docs by LangChain](https://docs.langchain.com/oss/javascript/releases/langchain-v1)
- v1 迁移指南（Python） —— [LangChain v1 migration guide - Docs by LangChain](https://docs.langchain.com/oss/python/migrate/langchain-v1)
- deep agents 官方仓库（langchain-ai/deepagents，基于 LangGraph 的长任务深度 agent 框架，实测 releases API 可访问） —— [deepagents](https://github.com/langchain-ai/deepagents)
- Agentic RAG 官方教程：LangGraph 编排 agent 化检索-生成循环 —— [Agentic RAG - Docs by LangChain](https://docs.langchain.com/oss/python/langgraph/agentic-rag)

## 对璇玑知识库的启示

1. **MCP server 是「Agent 操作」的规范出口**：璇玑知识库对外应做成 MCP server（官方 Tier 1 Python/TS SDK 可选），检索类工具标 `readOnlyHint=true`、删改类标 `destructiveHint`，但牢记规范「注解不可信、不构成安全边界」——真正的权限控制在服务端做。
2. **对齐 2026-07-28 无状态化**：不要依赖 MCP 会话状态；实现 `server/discover`；`tools/list` 用确定性排序 + `ttlMs`/`cacheScope`（客户端可缓存、少轮询）；分页用 cursor——知识库工具列表天然适合缓存。
3. **资源 URI 设计**：知识条目双通道暴露——细粒度检索走 tools（search/read），整文档/章节走 resources（URI + `uriTemplate` 如 `xuanji://kb/{docId}#chunk`），文档更新走 `subscriptions/listen` 通知，替代轮询。
4. **交互式提问用 MRTR**：需要用户澄清（「检索哪个项目？」）时用 `InputRequiredResult` + 请求重试模式；Sampling/Roots/Logging 已废弃，新代码不要引入，调试日志走 OpenTelemetry `_meta` 约定。
5. **傻瓜式 ingestion 抄 LlamaIndex**：IngestionPipeline 的 docstore 缓存 + 去重/upsert 是标准答案——璇玑上传文档按内容指纹（hash）跳过重复解析、按文档粒度增量更新，重跑不重算。
6. **引用溯源抄 CitationQueryEngine**：答案默认带 source node 引用（文档名+切片），配合高保真解析（LlamaParse 式版面 OCR），「每个结论可点回原文」是知识库可信度的关键。
7. **傻瓜式脚手架抄 create-llama + llms.txt**：璇玑也应提供 llms.txt 全量索引、每页 .md 原文（MCP 官网与 LlamaIndex/LangChain 文档皆如此），再配一个「查璇玑文档」的 MCP 工具——Agent 与人共用同一套文档入口。
8. **可观测性一行接入**：学 LlamaIndex Observability 的「一行切换 provider」设计，璇玑检索/问答链路默认吐 OTel trace（与 MCP 2026-07-28 的 traceparent `_meta` 约定直接对齐），评估用 LangSmith 式数据集+判分闭环。

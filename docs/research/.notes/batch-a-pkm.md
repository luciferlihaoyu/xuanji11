# PKM 产品调研 · 批次 A：Obsidian / AFFiNE / Outline

- 调研目的：为「璇玑个人知识库如何完善，做到傻瓜式操作与 Agent 操作」提供参照。
- 检索方式：web_search 联网检索（minimax 检索通道 API key 失效未用上）；只采信官方来源。
- 来源纪律：仅引用搜索结果中真实出现的官方 URL（obsidian.md / github.com/obsidianmd；affine.pro / docs.affine.pro / block-suite.com；getoutline.com / docs.getoutline.com / outline.app / github.com/outline / hub.docker.com/outlinewiki）。未命中官方来源的一律标【未核实】。
- 说明：Obsidian 官方帮助文档在搜索结果中多以 obsidian.md/help/* 及其官方多语言镜像（obsidian.md/zh|fr|de/help/*）形式出现，均为官方域名；Affine 底层编辑器 BlockSuite 官方站点为 block-suite.com。

## Obsidian

### 信息模型
- vault 即本地文件夹：笔记、附件、配置全部为落盘的纯文本 Markdown 文件，无数据库锁定 —— [How Obsidian stores data](https://obsidian.md/help/data-storage)
- 笔记支持 frontmatter 属性（YAML 元数据），构成结构化字段层 —— [Properties · obsidianmd/obsidian-help（官方文档仓库）](https://github.com/obsidianmd/obsidian-help/blob/029ba842/en/Editing%20and%20formatting/Properties.md)
- 组织维度 = 文件/文件夹 + 标签 + 属性 + wikilink 双链，均为开放文本约定而非黑盒 —— [How Obsidian stores data](https://obsidian.md/help/data-storage)
- 标签可直接作为检索维度（搜索操作符 tag:）—— [Search.md · obsidianmd/obsidian-help（官方文档仓库）](https://github.com/obsidianmd/obsidian-help/blob/5fb785ac/en/Plugins/Search.md)

### 检索
- 内置全文搜索支持操作符组合（file:、path:、task:、tag: 等，可嵌套、可正则）—— [Search.md · obsidianmd/obsidian-help（官方文档仓库）](https://github.com/obsidianmd/obsidian-help/blob/5fb785ac/en/Plugins/Search.md)
- 官方中文帮助亦提供搜索语法文档（与英文站同步的多语言官方帮助体系）—— [搜索 - Obsidian 中文帮助](https://obsidian.md/zh/help/plugins/search)
- QuickSwitcher 快速跳转的官方文档页未在本次检索命中，机制存在但细节【未核实】

### 引用与溯源
- 反向链接面板（Backlinks）为官方核心插件，含链接提及/未链接提及视图，未解析链接（[[不存在页]]）天然可见 —— [反向链接 - Obsidian 中文帮助](https://obsidian.md/zh/help/plugins/backlinks)
- 双向链接以 wikilink 写入纯文本，未解析链接等价于「待建页」待办 —— [How Obsidian stores data](https://obsidian.md/help/data-storage)
- 块级引用（^block-id）机制的官方文档页未在本次检索命中【未核实】

### 导入与同步
- 官方 obsidian-importer 插件：把 Apple Notes、OneNote、Evernote、Notion、Google Keep 等格式转成 Markdown 导入 vault —— [obsidianmd/obsidian-importer](https://github.com/obsidianmd/obsidian-importer)
- Obsidian Sync 为官方付费同步服务，端到端加密 —— [Obsidian Sync](https://obsidian.md/sync)
- Sync 自带版本历史（可回溯/恢复历史版本）—— [Version history](https://obsidian.md/help/sync/version-history)
- Sync 按存储档位订阅（官方 Plans and storage limits 页）—— [Plans and storage limits](https://obsidian.md/help/sync/plans)
- 数据即本地纯 Markdown 文件，可用任意文件系统手段同步/备份，不锁定 —— [How Obsidian stores data](https://obsidian.md/help/data-storage)

### 权限
- 不覆盖：单机单用户架构，无内建多用户/角色/集合权限模型（数据为本地私有文件）—— [How Obsidian stores data](https://obsidian.md/help/data-storage)
- 协作只能靠 Sync/第三方文件同步间接实现，无权限边界产品功能【未核实】

### Agent 工具协议
- 官方 URI 协议（obsidian://）支持打开 vault/笔记、新建笔记、执行搜索等深链动作，可被外部程序无凭据调用 —— [Obsidian URI（官方帮助）](https://obsidian.md/fr/help/uri)
- 未发现官方 MCP server：搜索未见 obsidianmd 官方 MCP 仓库或官方公告【未核实】
- 社区事实标准是 Local REST API 插件（REST over HTTP + API key，其 README 自带 MCP 集成章节）—— [obsidian-local-rest-api README（Local REST API with MCP）](https://raw.githubusercontent.com/coddingtonbear/obsidian-local-rest-api/master/README.md)
- 结论：Agent 操作覆盖=URI（官方、只读偏向）+ REST 插件（社区、读写完整），无官方 API 层

### 工作流/自动化
- 插件生态经官方插件市场分发，官方帮助设「社区插件」专章（第三方插件安装与风险提示）—— [插件 - Obsidian 中文帮助](https://obsidian.md/zh/help/plugins)
- 官方插件市场规模数字未在官方来源命中【未核实】
- Templater 等自动化插件的官方口径未命中【未核实】

### 备份
- 内置 File recovery 核心插件：定期保存笔记快照，可在应用内恢复误删/误改 —— [File recovery](https://obsidian.md/help/plugins/file-recovery)
- Sync 版本历史构成云端第二层恢复手段 —— [Version history](https://obsidian.md/help/sync/version-history)
- 终极备份=复制文件夹：纯 Markdown 落盘使「文件即备份」成立 —— [How Obsidian stores data](https://obsidian.md/help/data-storage)

### 可观测性
- 不覆盖：本地单机应用，官方无审计日志/上报类产品功能

### 易用性
- 官方提供桌面与移动端下载安装文档（Download and install Obsidian）—— [Download and install Obsidian](https://obsidian.md/help/install)
- 官方定价页：个人使用免费，Sync/Publish/商业授权为付费项 —— [Pricing](https://obsidian.md/pricing)
- 默认体验：装完即用，vault 打开文件夹即可写作，零服务端依赖 —— [How Obsidian stores data](https://obsidian.md/help/data-storage)

## AFFiNE

### 信息模型
- Workspace 为顶层容器，一个工作区内组织全部文档与白板 —— [AFFiNE Workspaces: Concepts & Workflows](https://docs.affine.pro/core-concepts/elements-of-affine/workspaces)
- 文档（Docs）有 Page / Edgeless 双模式：页面模式写作、无限画布白板，同一内容双形态 —— [AFFiNE Page Mode: Concepts & Workflows](https://docs.affine.pro/core-concepts/elements-of-affine/page-mode)
- 内容由 Block 组成（文本、列表、代码、链接、画布等块类型）—— [AFFiNE Blocks Guide: Text, Lists, Code, Links & Canvas](https://docs.affine.pro/core-concepts/elements-of-affine/blocks)
- 底层为自研 BlockSuite 编辑器框架，文档数据模型与渲染分离 —— [BlockSuite Architecture Guide | AFFiNE Docs](https://docs.affine.pro/blocksuite-wip/architecture)
- BlockSuite 官方 API 暴露 MarkdownTransformer，块模型可转 Markdown —— [Variable: MarkdownTransformer · BlockSuite API](https://block-suite.com/api/@blocksuite/affine-block-root/variables/MarkdownTransformer.html)
- 边栏「集合（Collection）」等组织细节未在官方域命中【未核实】

### 检索
- 自托管版支持配置 Indexer（搜索索引组件，官方管理文档）—— [AFFiNE Self-host Indexer Guide](https://docs.affine.pro/self-host-affine/administer/indexer)
- 云端搜索/语义检索的官方能力细节未在官方域命中【未核实】

### 引用与溯源
- 不覆盖（就本次检索而言）：未见反向链接/块引用/文档历史的官方专页【未核实】
- 数据模型层面的版本/追溯能力未在官方域命中【未核实】

### 导入与同步
- 官方教程：从 Notion 导入数据到 AFFiNE —— [Import your data from Notion into AFFiNE](https://affine.pro/blog/import-your-data-from-notion-into-affine)
- Markdown 进出经 BlockSuite Transformer/Adapter 机制（导入/导出管道）—— [Transformer & Adapter · BlockSuite](https://docs.affine.pro/blocksuite-wip/store/transformer-and-adapter)
- 云端版与自托管版并存，自托管走 docker-compose（官方推荐路径）—— [AFFiNE Self-host Docker Compose [Recommended] Guide](https://docs.affine.pro/self-host-affine/install/docker-compose-recommended)

### 权限
- 云端按 Free / Pro / Team 计划分层（$0 起），协作与成员能力挂在付费计划上 —— [AFFiNE Pricing 2026: Free, Pro, Team Plans from $0](https://affine.pro/pricing)
- 成员角色/页面级权限的官方文档未在官方域命中【未核实】

### Agent 工具协议
- 有官方 MCP Server 产品页：AFFiNE MCP Server — Connect AI to Your Knowledge Base —— [AFFiNE MCP Server](https://affine.pro/mcp)
- 官方域下未见公开 REST/GraphQL API 文档页（搜索仅命中第三方 Mintlify 镜像，不计为官方来源）【未核实】
- 结论：Agent 操作覆盖=官方 MCP（有），公开 API（官方域未核实）

### 工作流/自动化
- 不覆盖（就本次检索而言）：官方域未见 Zapier/自动化集成文档

### 备份
- 官方自托管备份恢复指南：覆盖 Postgres、Blobs、配置三部分 —— [AFFiNE Self-host Backup and Restore: Postgres, Blobs & Configuration](https://docs.affine.pro/self-host-affine/administer/backup-and-restore)
- Self-host 总览文档含 Docker Compose 搭建、需求、备份与 HTTPS 常见问题 —— [Self-host AFFiNE: Docker Compose Setup, Requirements, Backup & HTTPS](https://docs.affine.pro/self-host-affine/)
- 云端数据导出的官方专页未命中【未核实】

### 可观测性
- 自托管管理文档含 Indexer 运维（组件级可管理性）—— [AFFiNE Self-host Indexer Guide](https://docs.affine.pro/self-host-affine/administer/indexer)
- 审计日志/Sentry 等可观测性官方口径未命中【未核实】

### 易用性
- 官方推荐安装方式为 Docker Compose（自托管）—— [AFFiNE Self-host Docker Compose [Recommended] Guide](https://docs.affine.pro/self-host-affine/install/docker-compose-recommended)
- 云端免费层 $0 起可用，注册即用 —— [AFFiNE Pricing 2026](https://affine.pro/pricing)
- 默认体验：写作+白板一体，但自托管需维护 Postgres 等依赖（见备份文档结构）—— [Self-host AFFiNE](https://docs.affine.pro/self-host-affine/)

## Outline

### 信息模型
- 集合（Collection）是文档组织单元，文档挂在集合下构成知识库骨架 —— [Collections](https://docs.getoutline.com/s/guide/doc/collections-l9o3LD22sV)
- 文档为树形层级（集合→文档→子文档），官方指南整体按此结构展开 —— [Collections](https://docs.getoutline.com/s/guide/doc/collections-l9o3LD22sV)
- 不覆盖：无本地纯文件形态，数据在服务端数据库（自托管为 Postgres 体系）—— [Docker](https://docs.getoutline.com/s/hosting/doc/docker-7pfeLP5a8t)

### 检索
- 官方搜索文档「Search & AI answers」：全文搜索 + AI 回答一体 —— [Search & AI answers](https://docs.getoutline.com/s/guide/doc/search-ai-answers-NIKPvYrx06)
- AI 问答已产品化为检索的组成部分（提问式入口）—— [Search & AI answers](https://docs.getoutline.com/s/guide/doc/search-ai-answers-NIKPvYrx06)
- 语义搜索技术细节未在官方域命中【未核实】

### 引用与溯源
- 文档修订历史（Revision history）：可查看并回溯历史版本 —— [Revision history](https://docs.getoutline.com/s/guide/doc/revision-history-AiL6p22Ssq)
- 反向链接/回链功能的官方专页未命中【未核实】

### 导入与同步
- 官方 Import data 指南：外部数据导入 Outline —— [Import data](https://docs.getoutline.com/s/guide/doc/import-data-D2ZvLqz411)
- 官方导出两档：Export documents（文档导出）与 Export data（整库导出）—— [Export documents](https://docs.getoutline.com/s/guide/doc/export-documents-svbz5EcJZu) / [Export data](https://docs.getoutline.com/s/guide/doc/export-data-Da6C7HqL8M)
- Slack 集成官方页（频道通知/链接预览类能力）—— [Slack Integration](http://www.getoutline.com/integrations/slack)
- Zapier 集成官方页 —— [Zapier Integration](https://www.getoutline.com/integrations/zapier)
- Google Drive 集成的官方文档页未命中【未核实】

### 权限
- 官方 Users & roles 文档：成员与角色管理 —— [Users & roles](https://docs.getoutline.com/s/guide/doc/users-roles-cwCxXP8R3V)
- 官方 Groups 文档：组级权限管理 —— [Groups](https://docs.getoutline.com/s/guide/doc/groups-Jy1rROTFmN)
- 官方 Sharing 文档：分享/公开链接粒度的访问控制 —— [Sharing](https://docs.getoutline.com/s/guide/doc/sharing-LG2sGOLIpl)
- 商业模式为订阅制并保留免费层（V4 公告页）—— [Outline V4 - Subscription Model and Free Tier](https://www.outline.app/v4)

### Agent 工具协议
- 官方 REST API 文档（API key 鉴权，覆盖文档/集合等资源读写）—— [API - Outline](https://docs.getoutline.com/s/guide/doc/api-1rEIXDfLF6)
- 官方维护 OpenAPI 规范（github.com/outline/openapi 的 spec3.yml），可机器生成 SDK —— [outline/openapi spec3.yml](https://raw.githubusercontent.com/outline/openapi/main/spec3.yml)
- 官方 MCP server 未命中；社区有第三方 mcp-outline（Vortiago）—— [Vortiago/mcp-outline](https://github.com/Vortiago/mcp-outline)
- 结论：三者中 API 正规化程度最高（REST + OpenAPI 规范 + API key）

### 工作流/自动化
- Zapier 官方集成：Outline 作为触发/动作接入自动化流 —— [Zapier Integration](https://www.getoutline.com/integrations/zapier)
- Slack 官方集成可作通知型自动化通道 —— [Slack Integration](http://www.getoutline.com/integrations/slack)

### 备份
- Export data（整库导出）即官方备份路径 —— [Export data](https://docs.getoutline.com/s/guide/doc/export-data-Da6C7HqL8M)
- 自托管数据在自有数据库卷内，配合官方 Docker 部署文档管理 —— [Docker](https://docs.getoutline.com/s/hosting/doc/docker-7pfeLP5a8t)
- 官方组织发布企业版镜像 outlinewiki/outline-enterprise（Docker Hub）—— [outlinewiki/outline-enterprise](https://hub.docker.com/r/outlinewiki/outline-enterprise)
- 一键安装脚本官方口径未命中【未核实】

### 可观测性
- 官方 Audit log 文档：审计日志可查询操作事件 —— [Audit log](https://docs.getoutline.com/s/guide/doc/audit-log-cEpf9ayBaQ)
- 官方 Security 文档：数据传输与静态均加密 —— [Security](https://docs.getoutline.com/s/guide/doc/security-DlJBglbImQ)
- Sentry 集成官方口径未命中【未核实】

### 易用性
- 自托管官方路径为 Docker 部署文档（hosting 专区）—— [Docker](https://docs.getoutline.com/s/hosting/doc/docker-7pfeLP5a8t)
- 官方定价页提供云托管订阅（免运维路径）—— [Pricing](https://www.getoutline.com/pricing)
- 默认体验：面向团队Wiki，安装即有集合/权限/搜索全套，但自托管依赖组件多于单机应用

## 对璇玑知识库的启示

1. 零配置默认值学 Obsidian：目录即库、打开即写、无初始化向导；璇玑知识库应做到「给一个目录路径就可用」，服务端依赖（DB/索引器）全部做成可选增强而非前置条件。
2. 本地文件优先是傻瓜式的根源：Obsidian 把纯 Markdown 落盘作为存储契约，人和 Agent、grep、git 共用同一真实来源且永不锁定；璇玑应以 Markdown-on-disk 为 source of truth，任何索引/数据库只作派生缓存。
3. 双链与「未解析链接」值得抄：wikilink 让「先写后连」成立，未解析链接天然就是待建页待办，Agent 可扫描未解析链接自动建页补链；树形结构（Outline）没有这个自组织能力。
4. 检索+回答合并成一个入口：Outline 把 AI answers 做进搜索（Search & AI answers 官方文档），璇玑应把「问答即检索」作为唯一用户入口，全文检索作底、LLM 作答、引用回链到笔记。
5. Agent 协议覆盖度排序：Outline（REST API + 官方 OpenAPI spec + API key）> AFFiNE（官方 MCP，但公开 API 未核实）> Obsidian（无官方 API/MCP，靠社区 Local REST API 插件）。璇玑若选 Obsidian 式底座必须自建 API 层；其 OpenAPI 规范先行值得效仿——先发 spec 再谈工具。
6. 备份恢复做成一键：Obsidian 三重保障（纯文件复制 + File Recovery 快照 + Sync 版本历史）最傻瓜；璇玑应内置「一键整库导出（Markdown zip）+ 定时快照 + 版本回滚」，对齐 Outline Export data 与 AFFiNE 的 Postgres/Blobs/配置三分备份清单。
7. 权限边界按场景选型：多用户/审计场景 Outline 最成熟（Users & roles / Groups / Sharing / Audit log 四件套）；单人知识库 Obsidian 明确不覆盖权限。璇玑作为个人知识库可不做细粒度权限，但 Agent 写入应有独立的「API 侧权限边界」（类似 API key + 审计日志），这在 Outline 模式里已有现成参照。
8. 导入器决定迁移成本：Obsidian Importer 官方支持 Notion/Evernote/Apple Notes/OneNote/Google Keep 转 Markdown，三家都支持 Notion 导入；璇玑应优先内置「Notion → Markdown」导入器与 Markdown Transformer（参照 BlockSuite Transformer/Adapter 思路），把「进得来」作为完善的第一步。

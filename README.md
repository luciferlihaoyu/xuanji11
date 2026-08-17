# 璇玑智脑（Xuanji Brain）

璇玑智脑是一个部署在 Zeabur 的全栈智能知识库与工作流平台，提供知识图谱、Obsidian 风格文档管理、Agent 权限管理、数据源接入、文件上传与本地管理员认证。当前线上地址：<https://xuanjj29.zeabur.app/>。

## 核心功能

- **知识图谱**：D3.js 力导向图谱、节点搜索、拖拽布局、节点右键菜单、节点增删改与连线。
- **知识库**：文件夹/文档 CRUD、Markdown 编辑与文档详情页。
- **工作流编排**：可视化节点画布、连线配置、运行状态与运行历史记录。
- **Agent 管理**：智能助手 CRUD、类型/状态管理、细粒度权限配置、LLM 连接测试、API Key（Agent Token）签发与权限范围管理，详见 [Agent API 文档](docs/AGENT_API.md)。
- **数据源与上传**：NAS/API 等数据源配置，多格式文件上传，统一摄取管道（任务/条目/文档分块）。115/阿里云盘连接器已停用（deprecated），仅保留历史记录。
- **向量与搜索**：Zvec 向量库管理与重建索引面板，关键词 + 向量混合搜索。
- **MCP 集成**：注册/测试外部 MCP 服务器（如 Dify 工作流），工作流 call-agent 节点可直接调用 MCP 工具；内置 MCP server 工具集。
- **备份与恢复**：本地 / NAS / AList（WebDAV）备份仓库，AES-256-GCM 加密备份包，cron 调度与保留策略，manifest 校验的恢复流程。
- **认证与安全**：本地管理员账号密码登录，bcrypt 密码存储，兼容旧版 scrypt 哈希自动迁移，登录失败限流锁定，JWT 会话 Cookie，操作审计日志。
- **体验增强**：全局命令面板、深空/昼白主题、页面懒加载与科幻风加载态。

## 技术栈

- **前端**：React 19、TypeScript、Vite、React Router、Tailwind CSS、shadcn/ui、Zustand、D3.js、ECharts。
- **API**：Hono、tRPC 11、Zod、superjson、JWT（`jose`）。
- **数据库**：MySQL、Drizzle ORM、Drizzle Kit。
- **向量与存储**：Zvec（`@zvec/zvec`）以及可配置的 upload、backup、vector 数据目录。
- **认证**：bcrypt 本地管理员密码哈希，旧版 scrypt 平滑迁移；可选 Kimi OAuth。
- **构建与 QA**：Vite、esbuild、TypeScript project references、Vitest。
- **部署**：兼容 Docker 的 Node 服务，Zeabur 环境变量与持久化存储。

## 认证与安全

### 认证方式

| 方式 | 说明 |
|------|------|
| OAuth 2.0（Kimi） | 用户通过 Kimi 平台授权登录，获取 JWT 会话 |
| 本地管理员登录 | 备选：用户名/密码 → JWT Token |
| Agent Token | API 调用使用 Agent Token 认证（Bearer Token），参见 [Agent API 文档](docs/AGENT_API.md) |

### API 鉴权层级

所有 tRPC API 根据敏感度分为三级：

| 级别 | 说明 | 示例路由 |
|------|------|----------|
| `publicQuery` | 无需认证，仅健康检查和认证端点 | `ping`、`auth.*` |
| `authedQuery` | 需登录（JWT 会话），读操作 | `knowledge.listNodes`、`kb.getDocument`、`file.list` |
| `adminQuery` | 需管理员角色，写操作 | `agent.create`、`knowledge.deleteNode`、`workflow.saveFull` |

未认证访问受保护路由返回 `UNAUTHORIZED`，非管理员执行管理操作返回 `FORBIDDEN`。

### 健康检查

```
GET /health
→ { "ok": true, "uptime": 123, "dbConnected": true }
```

Docker 容器内置 `HEALTHCHECK`，每 30 秒检测 `http://localhost:3000/health`。

## 环境变量

运行时校验位于 `api/lib/env.ts`，`.env.example` 提供 starter 值。

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `ADMIN_USERNAME` | 是 | - | 本地管理员登录用户名 |
| `ADMIN_PASSWORD` | 是 | - | 本地管理员登录密码；首次成功登录后持久化为 bcrypt |
| `DATABASE_URL` | 是 | - | MySQL 连接字符串 |
| `JWT_SECRET` | 生产必填 | 开发环境随机生成 | JWT 签名密钥；生产环境必须为 ≥32 字符稳定随机字符串，缺失或过短将拒绝启动 |
| `APP_SECRET` | 可选 | - | Kimi OAuth 密钥 |
| `APP_ID` | 可选 | - | Kimi OAuth 应用 ID |
| `VITE_APP_ID` | 可选 | - | 前端 Kimi 应用 ID |
| `KIMI_AUTH_URL` | 可选 | `https://auth.kimi.com` | 后端 Kimi 授权端点 |
| `VITE_KIMI_AUTH_URL` | 可选 | `https://auth.kimi.com` | 前端 Kimi 授权端点 |
| `KIMI_OPEN_URL` | 可选 | `https://open.kimi.com` | Kimi Open API 端点 |
| `OWNER_UNION_ID` | 可选 | - | 管理员 Union ID |
| `BACKUP_ENCRYPTION_KEY` | 可选 | - | AList 加密备份的 AES-256-GCM 密钥；使用加密备份时必填，丢失则无法恢复已有加密备份 |
| `UPLOAD_DIR` | 可选 | `/data/app/uploads` | 持久化上传目录 |
| `BACKUP_TEMP_DIR` | 可选 | `/data/app/backups` | 临时备份/导出目录 |
| `ZVEC_DATA_DIR` | 可选 | `/data/app/zvec` | Zvec 向量数据目录 |
| `ZVEC_DIMENSION` | 可选 | `1536` | Zvec 向量维度，非法值回退到 `1536` |
| `ZVEC_ENABLED` | 可选 | `true` | 设置为 `false` 禁用 Zvec 向量功能 |
| `NODE_ENV` | 可选 | `development` | 生产环境设为 `production` |
| `PORT` | 可选 | `3000` | 服务端口 |

## 本地开发

```bash
npm install
cp .env.example .env
# 编辑 .env：设置 ADMIN_USERNAME、ADMIN_PASSWORD、DATABASE_URL、JWT_SECRET
npm run db:push
npm run dev
```

打开 <http://localhost:3000>。Vite dev server 通过 `@hono/vite-dev-server` 同时运行 Hono API 和 React 应用。

## 质量门禁

```bash
npm test       # vitest run
npm run check  # TypeScript project references
npm run build  # Vite 前端构建 + esbuild 服务端打包
```

## 生产构建与启动

```bash
npm run build
npm start
```

`npm run build` 将前端写入 `dist/public`，并将 `api/boot.ts` 打包为 `dist/boot.js`。服务端打包将 Zvec 原生包保持 external，便于部署环境/镜像提供对应的本地绑定。

## Zeabur 部署

详见 [DEPLOY.md](DEPLOY.md)。快速步骤：

1. 在 Zeabur Dashboard 创建项目，选择 GitHub 仓库 `luciferlihaoyu/xuanji11` 部署。
2. 配置至少 `ADMIN_USERNAME`、`ADMIN_PASSWORD`、`DATABASE_URL` 和稳定的 `JWT_SECRET`。
3. 如需上传/备份/向量数据持久化，为 `/data/app/uploads`、`/data/app/backups`、`/data/app/zvec` 添加持久化存储。
4. 部署完成后执行 `npx drizzle-kit push` 同步数据库。
5. 推送代码到 `main` 分支会自动触发 Zeabur 重新构建部署。

## 项目结构

```text
xuanji11/
├── api/                  # Hono/tRPC API、认证、路由、数据库查询
│   ├── router.ts         # tRPC 路由注册
│   ├── middleware.ts     # 认证/权限中间件
│   ├── *-router.ts       # 各模块路由（知识图谱/知识库/工作流/数据源/文件/向量/设置/备份/审计/搜索/MCP 等）
│   ├── local-auth.ts     # 本地管理员认证（bcrypt + scrypt 迁移）
│   ├── login-rate-limit.ts # 登录失败限流锁定
│   ├── backup-repositories/ # 备份仓库抽象（local / nas / alist WebDAV）
│   ├── connectors/       # 数据源连接器
│   ├── mcp-*.ts          # MCP 客户端/服务器与内置工具
│   ├── kimi/             # Kimi OAuth（可选）
│   ├── lib/              # 工具函数
│   └── queries/          # 数据库查询
├── contracts/            # 前后端共享常量与类型
├── db/
│   ├── schema.ts         # 数据库表定义
│   └── relations.ts      # 表关系
├── docs/                 # 专项文档（如 AGENT_API.md）
├── scripts/              # 运维脚本
├── src/                  # React 应用
│   ├── pages/            # 页面组件
│   ├── components/       # 通用组件
│   ├── hooks/            # 自定义 Hooks
│   ├── store/            # Zustand 状态
│   └── providers/        # tRPC Provider
├── Dockerfile            # Docker 构建
├── docker-compose.yml    # 本地 Docker 测试
├── DEPLOY.md             # Zeabur 部署指南
└── vitest.config.ts      # 测试配置
```

## 数据库表

| 分组 | 表名 | 用途 |
|------|------|------|
| 账户与安全 | `users` | OAuth 用户认证 |
| | `system_settings` | 系统配置（含管理员密码哈希） |
| | `api_keys` | Agent API Key（哈希存储 + 权限范围） |
| | `audit_logs` | 操作审计日志 |
| Agent 与 MCP | `agents` | 智能助手 + 权限配置 |
| | `mcp_servers` | 外部 MCP 服务器配置 |
| 知识图谱与知识库 | `knowledge_nodes` | 知识图谱节点 |
| | `knowledge_edges` | 知识图谱关系 |
| | `kb_folders` | 知识库文件夹 |
| | `kb_documents` | 知识库文档 |
| | `document_chunks` | 文档分块（向量搜索基本单元） |
| | `vector_collections` | 向量集合配置 |
| 工作流 | `workflows` | 工作流 |
| | `workflow_nodes` | 工作流节点 |
| | `workflow_runs` | 工作流运行记录 |
| | `workflow_run_nodes` | 运行中各节点结果 |
| 数据接入 | `data_sources` | 数据源 |
| | `uploaded_files` | 上传文件 |
| | `ingestion_jobs` | 摄取任务（上传/同步/备份统一入口） |
| | `ingestion_items` | 摄取条目（任务中的单个文件/对象） |
| 备份与恢复 | `backup_jobs` | 备份任务 |
| | `backup_job_files` | 备份任务文件清单 |
| | `restore_jobs` | 恢复任务 |

## 文档

- [DEPLOY.md](DEPLOY.md) — Zeabur 部署指南
- [docs/AGENT_API.md](docs/AGENT_API.md) — Agent API / Token 使用说明
- `ANALYSIS_REPORT.md`、`XUANJI_IMPROVEMENT_SPEC.md`、`璇玑修复计划-SPEC.md` — 历史分析与修复计划存档，内容已过期，仅供回溯

## 后续更新推送

```bash
# 修改代码后
npm run check
npm run build
npm test

# 提交并推送（会自动触发 Zeabur 重新部署）
git add .
git commit -m "更新描述"
git push origin main
```

## 许可证

[MIT](LICENSE)

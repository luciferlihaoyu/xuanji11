# 璇玑智脑（Xuanji）代码全面分析报告

> 分析日期：2026-06-03 | 分析范围：全项目 | 代码行数：~6436 行（业务代码）
> **最后更新：2026-06-13 — 已根据 XUANJI_IMPROVEMENT_SPEC.md 完成多阶段修复**

## 修复状态摘要

| 问题编号 | 问题 | 状态 | 修复日期 |
|----------|------|------|----------|
| P0-1 | 所有 API 端点无认证保护 | ✅ 已修复 | 2026-06-13 |
| P0-4 | 健康检查端点不存在 | ✅ 已修复 | 2026-06-13 |
| P0-6 | 前端无 ErrorBoundary | ✅ 已修复 | 2026-06-13 |
| P1-7 | 知识图谱使用本地硬编码数据 | ✅ 已修复 | 2026-06-13 |
| P1-8 | 后台 conditions 仅取 conditions[0] | ⚠️ 部分修复 | 2026-06-13 |
| P1-9 | 文件上传无类型验证 | ✅ 已修复 | 2026-06-13 |
| P1-13 | Home.tsx 死代码 | ✅ 已删除 | 2026-06-13 |
| P2-18 | 无数据库索引 | ✅ 已添加 | 2026-06-13 |
| P2-19 | mode: "planetscale" 修正 | ✅ 已修正 | 2026-06-13 |
| P2-21 | Docker HEALTHCHECK 改用 curl | ✅ 已修复 | 2026-06-13 |
| P3-28 | 未使用的依赖清理 | ✅ 已清理 | 2026-06-13 |
| — | 无日志系统 | ✅ 已实现 | 2026-06-13 |
| — | 无优雅关闭 | ✅ 已实现 | 2026-06-13 |

### 安全评分更新

| 维度 | 修复前 | 修复后 | 变化 |
|------|--------|--------|------|
| 安全性 | ⭐⭐ | ⭐⭐⭐⭐ | +2 |
| 完整性 | ⭐⭐⭐ | ⭐⭐⭐⭐ | +1 |
| 可部署性 | ⭐⭐⭐ | ⭐⭐⭐⭐ | +1 |
| **综合评分** | **⭐⭐⭐ (3/5)** | **⭐⭐⭐⭐ (4/5)** | **+1** |

---

## 目录

1. [项目架构](#1-项目架构)
2. [前端分析](#2-前端分析)
3. [后端分析](#3-后端分析)
4. [数据库分析](#4-数据库分析)
5. [安全问题](#5-安全问题)
6. [部署与运维](#6-部署与运维)
7. [代码质量](#7-代码质量)
8. [功能缺失](#8-功能缺失)
9. [改进建议（按优先级排序）](#9-改进建议)

---

## 1. 项目架构

### 1.1 技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| 前端框架 | React + TypeScript | 19.2 / 5.9 |
| 构建工具 | Vite | 7.2 |
| CSS 方案 | Tailwind CSS + CSS 变量 | 3.4 |
| UI 组件库 | shadcn/ui (Radix UI) | — |
| 状态管理 | Zustand | 5.0 |
| 图形可视化 | D3.js + ECharts + Recharts | — |
| 后端框架 | Hono | 4.8 |
| API 层 | tRPC 11.x | 11.8 |
| ORM | Drizzle ORM | 0.45 |
| 数据库 | MySQL (mysql2 驱动) | 3.14 |
| 认证 | JWT (jose) + Cookie | 6.1.3 |
| 部署 | Docker (多阶段) | — |

### 1.2 目录结构

```
xuanji11/
├── api/                    # 后端：Hono + tRPC
│   ├── router.ts           # tRPC 根路由（注册所有子路由）
│   ├── boot.ts             # 应用入口：Hono 实例 + 静态文件 + 上传
│   ├── middleware.ts       # tRPC 中间件（认证/权限）
│   ├── context.ts          # tRPC 请求上下文
│   ├── *-router.ts         # 各模块 tRPC 路由（9个）
│   ├── local-auth.ts       # 本地管理员认证（用户名/密码 → JWT）
│   ├── upload-handler.ts   # 文件上传处理器
│   ├── connectors/         # 数据源连接器（115网盘、阿里云盘）
│   ├── kimi/               # Kimi OAuth 认证（可选）
│   ├── lib/                # 工具函数
│   └── queries/            # 数据库查询封装
├── contracts/              # 前后端共享类型/常量
│   ├── types.ts            # 从 db/schema 导出类型
│   ├── constants.ts        # Session/Error/Path 常量
│   └── errors.ts           # 错误类型定义
├── db/                     # 数据库层
│   ├── schema.ts           # 12 张表的 Drizzle Schema
│   ├── relations.ts        # 表关系定义
│   └── seed.ts             # 种子数据（未实现）
├── src/                    # 前端
│   ├── pages/              # 13 个页面
│   ├── components/         # 通用组件 + 54 个 shadcn/ui 组件
│   ├── hooks/              # 自定义 Hooks（tRPC 封装）
│   ├── store/              # Zustand 全局状态
│   ├── providers/          # tRPC Provider
│   ├── types/              # 前端类型定义
│   └── lib/                # 工具函数
├── Dockerfile              # 多阶段 Docker 构建
├── docker-compose.yml      # 本地 Docker 测试
├── DEPLOY.md               # Zeabur 部署指南
└── 配置文件（package.json, vite.config.ts, tsconfig*.json 等）
```

### 1.3 架构评价

**优点：**
- 全栈 TypeScript + tRPC 实现真正的端到端类型安全
- Hono 作为轻量级 HTTP 框架，适合边缘部署
- Drizzle ORM 提供类型安全的数据库操作
- React 19 + Vite 7 使用前沿技术
- 清晰的模块化分离（api/src/contracts/db 四层）

**问题：**
- 单仓库无 monorepo 工具（如 turborepo），前后端混合一个 `package.json`
- 构建依赖 esbuild 直接打包后端，路径别名（@db, @contracts）在构建产物中可能无法正确解析
- 前端和后端类型系统有重叠但不完全一致（`src/types/index.ts` 与 `db/schema.ts` 定义不同结构）

---

## 2. 前端分析

### 2.1 页面/路由清单

| 路径 | 页面组件 | 行数 | 状态 |
|------|----------|------|------|
| `/` | KnowledgeGraph | 317 | ✅ 已实现 |
| `/kb` / `/kb/:path` | KnowledgeBase | 346 | ✅ 已实现 |
| `/workflows` / `/workflows/:id` | WorkflowBuilder | 388 | ✅ 已实现 |
| `/agents` | AgentManagement | 391 | ✅ 已实现 |
| `/api` | APICenter | 421 | ✅ 已实现 |
| `/sources` | DataSources | 386 | ✅ 已实现 |
| `/upload` | UploadPage | 318 | ✅ 已实现 |
| `/search` | SearchResults | 201 | ✅ 已实现 |
| `/doc/:id` | DocumentDetail | 273 | ✅ 已实现 |
| `/settings/:category` | Settings | 416 | ✅ 已实现 |
| `/login` | Login | 137 | ✅ 已实现 |
| `*` | NotFound | 21 | ✅ 已实现 |
| — | Home | 20 | ❌ 死代码（未在路由中注册） |

### 2.2 组件分析

**自定义组件（10 个）：**
- `AppLayout` — 主布局，包含 TopNavbar + Outlet + 命令面板。实现较短（35 行），结构合理。
- `TopNavbar` — 顶部导航，支持桌面/移动端响应式。164 行，功能完备。
- `CommandPalette` — ⌘+K 命令面板，199 行，支持页面导航和知识库文件搜索。
- `KnowledgeGraph` — D3.js 力导向图，317 行，整个页面作为组件（应拆分）。
- `GraphControlPanel` — 图谱控制面板，86 行。
- `NodeDetailPanel` — 节点详情面板，119 行。
- `PermissionSelector` — 7 项权限配置组件，99 行。
- `BgImageUpload` — 脑图背景上传，71 行。
- `ThemeSwitch` — 主题切换按钮，32 行。
- `ToastContainer` — Toast 通知容器，62 行。

**Shadcn/UI 组件（54 个）：** 大量预置组件，覆盖率很高。存在一些从未被引用的组件（如 `carousel`, `drawer`, `toggle-group` 等）。

### 2.3 UI/UX 问题

| 问题 | 位置 | 严重性 |
|------|------|--------|
| 大量内联 style 替代 Tailwind 类 | 几乎所有页面 | 🟡 中 |
| 自定义 CSS 变量名缺乏统一规范，无法通过 Tailwind 主题配置 | `src/index.css` | 🟡 中 |
| D3 力导向图与 React 生命周期绑定不当，无 cleanup | `src/pages/KnowledgeGraph.tsx:42-47` | 🔴 高 |
| `Home.tsx` 是 Vite 脚手架残留代码，未被引用 | `src/pages/Home.tsx` | 🟢 低 |
| 无 React.lazy 代码分割，首屏加载所有页面 | `src/App.tsx` | 🟡 中 |
| 无 Error Boundary，组件异常会导致白屏 | 项目全局 | 🔴 高 |
| 搜索输入框功能未实现（仅 UI） | `src/components/TopNavbar.tsx:105-117` | 🟡 中 |
| 通知 Bell 按钮无实际功能 | `src/components/TopNavbar.tsx:125-130` | 🟢 低 |

### 2.4 状态管理

**Zustand Store (`useAppStore`) 特点：**
- Agent 数据在前端有独立的模型（`Agent` 接口），与数据库 `agents` 表不完全一致
- 包含 10 个硬编码的初始 Agent 和 15 个硬编码的图谱节点（演示数据）
- 知识库树（`kbTree`）在前端维护，与 DB 数据模型分离
- Toast 通知系统直接实现在 Store 中，较为简洁

**问题：**
- 前端 Zustand 和后端 tRPC 数据流并存——Agent 管理页可能同时从两个源头获取数据
- 知识图谱页面完全不使用 tRPC hooks，仅依赖 Zustand 中的演示数据
- 知识库页面和文档详情页也主要依赖 Zustand 数据

---

## 3. 后端分析

### 3.1 API 端点清单

#### tRPC 路由（9 个子路由）

| 路由 | 过程数 | 文件 | 行数 |
|------|--------|------|------|
| `ping` | 1 | `api/router.ts` | 25 |
| `auth` | 3 (me, login, logout) | `api/auth-router.ts` | 69 |
| `agent` | 6 (list, getById, create, update, delete, updatePermissions) | `api/agent-router.ts` | 116 |
| `knowledge` | 10 (listNodes, searchNodes, getNode, createNode, updateNode, deleteNode, updateNodePositions, listEdges, createEdge, deleteEdge, getGraph) | `api/knowledge-router.ts` | 152 |
| `kb` | 14 (listFolders, listRootFolders, listSubFolders, createFolder, updateFolder, deleteFolder, listDocuments, searchDocuments, getDocument, createDocument, updateDocument, deleteDocument, getTree) | `api/kb-router.ts` | 165 |
| `workflow` | 12 (list, getById, create, update, delete, setStatus, listNodes, createNode, updateNode, deleteNode, saveFull) | `api/workflow-router.ts` | 198 |
| `datasource` | 7 (list, listByType, getById, create, update, delete, testConnection, sync) | `api/datasource-router.ts` | 166 |
| `file` | 5 (list, getById, register, update, delete) | `api/file-router.ts` | 90 |
| `vector` | 6 (list, getById, create, update, delete, updateDocCount) | `api/vector-router.ts` | 86 |
| `setting` | 6 (list, listByCategory, getByKey, set, setMany, delete) | `api/setting-router.ts` | 104 |

#### REST API 端点（Hono 直连）

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/api/upload` | 文件上传（multipart，50MB 限制） |
| GET | `/api/upload/list` | 文件列表 |
| DELETE | `/api/upload/:id` | 删除文件 |
| GET | `/api/files/:filename` | 下载/查看文件 |
| GET | `/api/oauth/callback` | Kimi OAuth 回调（可选） |

### 3.2 数据模型（12 张表）

参见 [数据库分析](#4-数据库分析)。

### 3.3 认证体系

项目实现了双层认证：

1. **本地管理员登录**（主要）：
   - 通过 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 环境变量配置
   - tRPC `auth.login` 验证凭据 → 签发 JWT（30 天有效期）→ 设置 httpOnly Cookie
   - JWT 存储在 `kimi_sid` Cookie 中（命名不当——与 Kimi OAuth 共用 cookie 名）

2. **Kimi OAuth 登录**（可选）：
   - 需要配置 APP_ID / APP_SECRET
   - 支持授权码流程 + JWKS 验证
   - 用户信息写入 `users` 表

### 3.4 重大安全问题

> ⚠️ 详见 [安全问题](#5-安全问题) 章节

---

## 4. 数据库分析

### 4.1 ORM 配置

**文件：** `drizzle.config.ts`  
**数据库类型：** MySQL（dialect: "mysql"）  
**注意：** 连接代码 `api/queries/connection.ts:14` 使用 `mode: "planetscale"`，但配置文件使用标准 `mysql` dialect，存在不一致。

### 4.2 表结构（12 张表）

| 表名 | 用途 | 行数 | 外键 |
|------|------|------|------|
| `users` | OAuth 用户认证 | 13 | — |
| `agents` | 智能助手 | 17 | → users |
| `knowledge_nodes` | 知识图谱节点 | 17 | → users |
| `knowledge_edges` | 知识图谱关系 | 20 | → knowledge_nodes (×2), users |
| `kb_folders` | 知识库文件夹 | 18 | → kb_folders (自引用), users |
| `kb_documents` | 知识库文档 | 20 | → kb_folders, users |
| `workflows` | 工作流 | 16 | → users |
| `workflow_nodes` | 工作流节点 | 18 | → workflows |
| `data_sources` | 数据源 | 21 | → users |
| `uploaded_files` | 上传文件 | 12 | — |
| `vector_collections` | 向量集合 | 17 | → users |
| `system_settings` | 系统设置 | 11 | → users |

### 4.3 数据库问题

| 问题 | 位置 | 严重性 |
|------|------|--------|
| 无数据库索引定义（影响查询性能） | `db/schema.ts` 全局 | 🟡 中 |
| `connections.ts` 使用 `mode: "planetscale"` 但实际用标准 MySQL | `api/queries/connection.ts:14` | 🟡 中 |
| `updatedAt` 自动更新依赖 JS 运行时（`$onUpdate`），非数据库触发器 | `db/schema.ts` 多处 | 🟢 低 |
| `seed.ts` 仅有 TODO 注释，未实现 | `db/seed.ts` | 🟢 低 |
| 无迁移文件（`db/migrations/` 仅有 .gitkeep） | `db/migrations/` | 🟡 中 |
| `serial` 类型用于主键在 MySQL 中映射为 AUTO_INCREMENT，与 bigint 外键类型不匹配 | `db/schema.ts` | 🟡 中 |
| `json` 字段中大量使用 `$type<>()` 但未验证运行时类型 | `db/schema.ts` 多处 | 🟢 低 |
| `vector_collections` 表虽然有 `documentCount`，但无实际向量数据存储表 | `db/schema.ts` | 🔴 高 |

---

## 5. 安全问题

### 5.1 🔴 严重：全后端无认证保护

**位置：** 除 `auth-router.ts` 外的所有 tRPC 路由

所有业务的 tRPC 过程均使用 `publicQuery`（定义于 `api/middleware.ts:26`），这意味着**任何人无需登录即可执行所有 CRUD 操作**。

```typescript
// api/middleware.ts:26
export const publicQuery = t.procedure;  // 无任何认证中间件

// api/agent-router.ts:13
list: publicQuery  // ❌ 任何人可以列出所有 Agent
// api/kb-router.ts:14
listFolders: publicQuery  // ❌ 任何人可以读取知识库

// 正确的做法应该使用：
// authedQuery = t.procedure.use(requireAuth)   // 已定义但未使用
// adminQuery = authedQuery.use(requireRole("admin"))
```

**已定义的认证中间件但未被使用：**
```typescript
// api/middleware.ts:38
export const authedQuery = t.procedure.use(requireAuth);
// api/middleware.ts:49
export const adminQuery = authedQuery.use(requireRole("admin"));
```

### 5.2 🔴 严重：硬编码默认密码和密钥

**位置：** `api/lib/env.ts:17-19`

```typescript
adminUsername: process.env.ADMIN_USERNAME ?? "admin",
adminPassword: process.env.ADMIN_PASSWORD ?? "xuanji123456",
jwtSecret: process.env.JWT_SECRET ?? process.env.APP_SECRET ?? "xuanji-local-auth-secret-change-in-production",
```

如果部署者忘记设置环境变量，系统将使用这些硬编码的默认值，**任何知道这些值的人都可以直接登录为管理员**。

### 5.3 🔴 高：密码明文传输（tRPC）

**位置：** `src/pages/Login.tsx:34`

```typescript
loginMutation.mutate({ username: username.trim(), password });
```

tRPC 使用 HTTP POST + JSON 传输，密码在请求体中以明文传输。虽然 tRPC 可以通过 HTTPS 加密，但：
- 本地开发时 `http://localhost:3000` 没有 TLS
- 后端没有对密码做哈希处理（直接字符串比较）
- Cookie `sameSite: "Lax"` 在 localhost 上，生产应为 `"Strict"`

### 5.4 🟡 中：无文件上传安全检查

**位置：** `api/boot.ts:47-65`, `api/upload-handler.ts`

- 无文件类型白名单/黑名单验证
- 无文件内容扫描（可上传恶意脚本）
- 上传文件直接写入磁盘，使用原始扩展名
- `getFileStream` 返回 `application/octet-stream` 无条件，可能引发 XSS

### 5.5 🟡 中：SQL 注入风险（LIKE 查询）

**位置：** `api/knowledge-router.ts:14-16`, `api/kb-router.ts:77`, `api/agent-router.ts:18-19`, `api/file-router.ts:20-21`

```typescript
like(knowledgeNodes.title, `%${input.query}%`),
```

虽然 Drizzle ORM 的 `like()` 使用参数化查询，但 `%` 通配符来自用户输入拼接，特殊字符（如 `%`, `_`）可能导致意外匹配。应转义这些字符。

### 5.6 🟡 中：Cookie 命名不当

**位置：** `contracts/constants.ts:2`

```typescript
cookieName: "kimi_sid",
```

本地管理员登录和 Kimi OAuth 共用同一个 Cookie 名称 `kimi_sid`，可能导致：
- 用户先 Kimi 登录再本地登录时状态混乱
- 管理员登出不会清除 Kimi 会话

### 5.7 🟢 低：JWT 过期时间过长

**位置：** `api/local-auth.ts:36`

本地 JWT 有效期 30 天，Kimi OAuth JWT 有效期 1 年（`api/kimi/session.ts:9`）。过期时间过长增加了 Token 泄露的风险。

### 5.8 🟢 低：未配置 CORS

Hono 未显式配置 CORS 中间件。如果前端和后端不同域部署，会出现跨域问题。

---

## 6. 部署与运维

### 6.1 Docker 配置

**Dockerfile**（`Dockerfile`）：
- 多阶段构建：`node:20-slim` → 构建 → `node:20-alpine` 运行
- ✅ 合理利用 Docker 缓存层
- ❌ HEALTHCHECK 使用 `wget`，但 Alpine 默认不包含 wget（需 `curl`）
- ❌ `RUN npm ci --ignore-scripts` 可能跳过必要的 postinstall 脚本

**docker-compose.yml**：
- ❌ 未包含 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 环境变量
- ❌ 使用 `version: "3.8"` 但已废弃（现代 Docker Compose 不需要此字段）

### 6.2 构建配置

**build 脚本**（`package.json:7`）：
```bash
vite build && esbuild api/boot.ts --platform=node --bundle --format=esm --outdir=dist --banner:js="import { createRequire } from 'module';const require = createRequire(import.meta.url);"
```

- esbuild 直接打包 `api/boot.ts`，未处理路径别名（`@db`, `@contracts`）
- 打包后的 ESM 模块可能无法正确解析相对导入
- `dist/public` 目录用于前端静态文件，`dist/boot.js` 用于后端入口

### 6.3 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `ADMIN_USERNAME` | 是 | 管理员账号 |
| `ADMIN_PASSWORD` | 是 | 管理员密码 |
| `DATABASE_URL` | 是 | MySQL 连接字符串 |
| `JWT_SECRET` | 否 | JWT 密钥 |
| `APP_ID` | 否 | Kimi OAuth 应用 ID |
| `APP_SECRET` | 否 | Kimi OAuth 密钥 |
| `VITE_APP_ID` | 否 | 前端 Kimi 应用 ID |
| `KIMI_AUTH_URL` | 否 | Kimi 认证地址 |
| `OWNER_UNION_ID` | 否 | 管理员 Union ID |

### 6.4 运维问题

| 问题 | 位置 | 严重性 |
|------|------|--------|
| 无日志系统（仅 `console.log/warn/error`） | 全局 | 🟡 中 |
| 无健康检查端点（HEALTHCHECK 指向不存在的 `/api/trpc/ping`） | `Dockerfile:41` | 🔴 高 |
| 无优雅关闭处理 | `api/boot.ts` | 🟡 中 |
| 数据库连接无连接池配置 | `api/queries/connection.ts` | 🟡 中 |
| 上传文件存储在容器内（容器重启后丢失） | `api/upload-handler.ts` | 🔴 高 |
| 无环境变量校验——运行时才发现缺失配置 | `api/boot.ts` | 🟡 中 |

---

## 7. 代码质量

### 7.1 TypeScript 使用

**优点：**
- 严格模式 (`strict: true`) 启用
- `noUnusedLocals` / `noUnusedParameters` 启用
- tRPC + Drizzle 提供端到端类型安全

**问题：**
| 问题 | 位置 | 示例 |
|------|------|------|
| `any` 类型滥用 | `src/store/useAppStore.ts`, `src/pages/KnowledgeGraph.tsx` 等 | `const collectFiles = (nodes: any[])` |
| `as` 断言过度使用 | `src/store/useAppStore.ts:99` | `...agentData as any` |
| `as unknown as` 双重断言 | `api/boot.ts:92` | `fileInfo.stream as unknown as ReadableStream` |
| JSON 字段类型标注使用 `as` 而非运行时校验 | 多个 api/*-router.ts | `input.config as Record<string, unknown>` |

### 7.2 错误处理

| 问题 | 位置 | 严重性 |
|------|------|--------|
| catch 只打印日志不返回用户友好错误 | `api/connectors/*.ts` | 🟡 中 |
| TRPCError 仅在 auth-router 中使用，其他路由不抛错 | 多个业务路由 | 🔴 高 |
| 文件操作无异常处理 | `api/upload-handler.ts:27` | 🟡 中 |
| 前端无全局错误捕获 | `src/main.tsx` | 🟡 中 |
| try-catch 吞没所有异常 | `api/context.ts:17-21` | 🟡 中 |

### 7.3 依赖管理

**关键依赖：**
- `react` + `react-dom`: 19.2 ✅ 最新
- `react-router`: 7.6 ✅ 最新（v7）
- `@trpc/server` + `@trpc/client`: 11.8 ✅ 最新
- `drizzle-orm`: 0.45 ✅
- `zod`: 4.3.5 ✅ 最新
- `jose`: 6.1.3 (JWT 库) ✅
- `node` 运行时: v20 ✅ Active LTS

**问题：**
- `@aws-sdk/client-s3` 和 `@aws-sdk/s3-request-presigner` 已安装但未在任何代码中使用
- `d3-force-3d` 已安装但 KnowledgeGraph 仅使用 2D 模式
- `pdfjs-dist` 已安装但未见使用
- `prismjs` (代码高亮) 已安装但未见使用
- `kimi-plugin-inspect-react` (devDep) 是 Kimi 平台特定插件，在其他环境无用

### 7.4 代码风格

**ESLint 配置**（`eslint.config.js`）：
- ✅ Flat config 格式
- ✅ TypeScript + React Hooks 规则
- ❌ 缺少 import 排序规则
- ❌ 缺少 unicorn / security 等增强规则

**Prettier 配置**（`.prettierrc`）：基本配置，无特殊规则。

---

## 8. 功能缺失

### 8.1 知识图谱模块

| 缺失功能 | 说明 |
|----------|------|
| 知识图谱页面未接入后端 | 使用 Zustand 硬编码数据，tRPC hooks 已写好但未被页面调用 |
| 3D 模式未实现 | 代码中仅有 `useState<'2D'>('2D')`，强制 2D |
| 图谱自动布局 | 无自动布局算法，仅靠用户拖拽 |
| 图谱快照/历史版本 | 无法回到之前的状态 |
| 导出/导入 | 无 JSON/PNG 导出 |
| 节点搜索高亮 | 搜索框未与图谱联动 |

### 8.2 向量化/搜索模块

| 缺失功能 | 说明 |
|----------|------|
| 实际 Embedding 调用 | 无调用 OpenAI/本地 Embedding API 的代码 |
| 向量存储 | 无向量数据库集成（Pinecone/Qdrant/Milvus） |
| 语义搜索 | `searchNodes` 仅为 LIKE 查询，不是语义搜索 |
| 文档向量化管道 | `pdfjs-dist` 已安装但无 PDF 解析/向量化代码 |

### 8.3 工作流模块

| 缺失功能 | 说明 |
|----------|------|
| 工作流执行引擎 | 仅有存储层，无执行逻辑 |
| 触发器 | `triggers` 字段存储但未处理（定时/Webhook） |
| 工作流历史 | 无运行日志/历史记录表 |

### 8.4 通用功能

| 缺失功能 | 说明 |
|----------|------|
| 用户管理 | 仅有一个管理员账号，无用户 CRUD、角色管理 |
| 审计日志 | 无操作日志记录 |
| 数据备份/恢复 | 无备份机制 |
| 国际化 (i18n) | 所有文案硬编码为中文 |
| 响应式适配 | 移动端功能不完整 |
| 性能监控 | 无 APM / Metrics 集成 |
| 文件预览 | 无 Office/PDF 文档预览 |
| 全文搜索 | 仅 LIKE 查询，无全文索引 |

---

## 9. 改进建议（按优先级排序）

### 🔴 P0 - 严重/阻塞问题（建议立即修复）

| # | 问题 | 位置 | 修复方案 |
|---|------|------|----------|
| 1 | **所有 API 端点无认证保护** | `api/*-router.ts` 全局 | 将 `publicQuery` 改为 `authedQuery`，敏感操作使用 `adminQuery` |
| 2 | **默认密码硬编码** | `api/lib/env.ts:18` | 移除默认值，启动时检测未设置则拒绝启动 |
| 3 | **默认 JWT 密钥硬编码** | `api/lib/env.ts:19` | 移除默认值，启动时自动生成随机密钥并输出警告 |
| 4 | **健康检查端点不存在** | `Dockerfile:41` | 添加 `/api/trpc/ping` 返回正确格式或改用 `/api/health` |
| 5 | **文件上传存于容器内** | `api/upload-handler.ts:12` | 使用 S3/OSS 或持久化卷 |
| 6 | **前端无 Error Boundary** | `src/App.tsx` | 添加 React ErrorBoundary 包裹路由 |

### 🟡 P1 - 高优先级（建议本周修复）

| # | 问题 | 位置 | 修复方案 |
|---|------|------|----------|
| 7 | 知识图谱页面使用本地硬编码数据 | `src/pages/KnowledgeGraph.tsx` | 接入 tRPC hooks (`useKnowledgeGraph()`) |
| 8 | 后台 `conditions` 数组仅取 `conditions[0]` | `api/agent-router.ts:28`, `api/file-router.ts:23` | 使用 `and(...conditions)` 合并多个条件 |
| 9 | 文件上传无类型验证 | `api/boot.ts:47` | 添加文件类型白名单和大小校验 |
| 10 | 无数据库迁移文件 | `db/migrations/` | 运行 `npm run db:generate` 生成迁移 |
| 11 | 搜索功能未实现 | `src/components/TopNavbar.tsx:105` | 连接搜索输入框到 SearchResults 页面 |
| 12 | 密码明文存储和传输 | `api/local-auth.ts:30`, `src/pages/Login.tsx:34` | 前端 HTTPS + 后端 bcrypt 哈希 |
| 13 | `Home.tsx` 死代码 | `src/pages/Home.tsx` | 删除文件 |

### 🟢 P2 - 中等优先级（建议本月完成）

| # | 问题 | 位置 | 修复方案 |
|---|------|------|----------|
| 14 | 代码分割 | `src/App.tsx` | `React.lazy()` + `Suspense` 懒加载页面 |
| 15 | 内联 style 迁移到 Tailwind | 全局 | 将 CSS 变量对应的样式定义为 Tailwind 工具类 |
| 16 | 向量化功能实现 | `api/vector-router.ts` | 集成 Embedding API + 向量数据库 |
| 17 | 工作流执行引擎 | `api/workflow-router.ts` | 实现节点执行逻辑和触发器调度 |
| 18 | 无数据库索引 | `db/schema.ts` | 为高频查询字段添加索引 |
| 19 | `mode: "planetscale"` 修正 | `api/queries/connection.ts:14` | 改为 `mode: "default"` |
| 20 | Seed 脚本补全 | `db/seed.ts` | 添加开发环境初始数据 |
| 21 | Docker HEALTHCHECK 改用 curl | `Dockerfile:41` | 使用 `curl` 替代 `wget`（Alpine 支持） |
| 22 | 用户管理功能 | 全局 | 添加用户 CRUD 页面和 API |

### 🔵 P3 - 低优先级（建议后续迭代）

| # | 问题 | 位置 | 修复方案 |
|---|------|------|----------|
| 23 | 任何 `any` 类型替换为具体类型 | 多个文件 | 定义接口类型替代 `any` |
| 24 | 独立日志系统 | `api/*.ts` | 引入 pino/winston 替代 console |
| 25 | 审计日志 | 全局 | 添加操作记录表和中间件 |
| 26 | 国际化 (i18n) | `src/` | 引入 react-i18next |
| 27 | 3D 知识图谱 | `src/pages/KnowledgeGraph.tsx` | 实现 3D 模式切换 |
| 28 | 未使用的依赖清理 | `package.json` | 移除 `@aws-sdk/*`, `d3-force-3d` 等 |
| 29 | 性能优化：虚拟列表 | `src/pages/DataSources.tsx` 等 | 大列表使用 react-window |
| 30 | 文件预览功能 | `src/pages/DocumentDetail.tsx` | 集成 Office/PDF/图片预览 |

---

## 附录 A：文件大小统计

```
api/                     ~1,600 行（15 个文件）
contracts/               ~40 行（3 个文件）
db/                      ~300 行（3 个文件）
src/pages/               ~3,635 行（13 个文件）
src/components/          ~1,150 行（10 个自定义组件）
src/components/ui/       54 个 shadcn 组件
src/hooks/               ~200 行（8 个文件）
src/store/               ~280 行（1 个文件）
其他前端文件             ~70 行
配置文件                 ~200 行
─────────────────────────────
业务代码总计             ~6,436 行
```

## 附录 B：技术债务评级

| 维度 | 评分 | 说明 |
|------|------|------|
| 代码架构 | ⭐⭐⭐⭐ | 清晰的分层和模块化 |
| 类型安全 | ⭐⭐⭐ | tRPC 类型安全好，但前端 `any` 过多 |
| 安全性 | ⭐⭐ | **严重不足**：无认证保护、硬编码密码 |
| 完整性 | ⭐⭐⭐ | 核心功能骨架完整，但高级功能缺失 |
| 可维护性 | ⭐⭐⭐ | 代码结构好但缺乏注释和文档 |
| 可部署性 | ⭐⭐⭐ | Docker 化但缺少持久化存储 |

**综合评分：⭐⭐⭐ (3/5) — 架构良好，但安全问题需立即解决。**

---

*报告由 OpenClaw CodeMaster 自动生成。所有文件路径和行号基于分析时刻的代码快照。*

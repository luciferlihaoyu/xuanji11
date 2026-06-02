# 璇玑智脑 - 智能知识库系统

> 一个全栈智能知识库平台，融合中国科幻美学与现代化 AI 架构

## 功能概览

| 模块 | 功能 |
|------|------|
| 知识脑图 | D3.js 力导向图谱，支持拖拽编辑、节点搜索 |
| 知识库 | Obsidian 风格编辑器，文件夹/文档完整 CRUD |
| 工作流编排 | 可视化节点编程，支持连线与运行动画 |
| Agent 管理 | 智能助手 CRUD + 7 项细粒度权限控制 |
| 数据源 | 云盘/NAS/API 等多源数据接入管理 |
| 文件上传 | 多格式文件上传与向量化预处理 |
| API 中心 | RESTful 接口文档与在线调试 |
| 全局搜索 | 全文检索与向量语义搜索 |
| 主题系统 | 深空/昼白双模式 + 脑图背景自定义上传 |
| 命令面板 | ⌘+K 全局快速导航 |

## 技术架构

### 前端
- React 19 + TypeScript + Vite
- Tailwind CSS + shadcn/ui
- D3.js（知识图谱）+ ECharts（数据可视化）
- Zustand（状态管理）+ tRPC（类型安全 API）

### 后端
- Hono + tRPC 11.x（类型安全路由）
- Drizzle ORM + MySQL（数据库）
- OAuth 2.0（Kimi 认证）
- JWT 会话管理

### 部署
- Docker 多阶段构建
- Zeabur 云原生部署支持

## 快速开始

### 本地开发

```bash
# 1. 克隆仓库
git clone https://github.com/luciferlihaoyu/xuanji11.git
cd xuanji11

# 2. 安装依赖
npm install

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env 填入数据库和 OAuth 配置

# 4. 同步数据库
npm run db:push

# 5. 启动开发服务器
npm run dev
# 访问 http://localhost:3000
```

### 生产构建

```bash
npm run build    # 构建前端 + 后端
npm start        # 启动生产服务器
```

### Docker 部署

```bash
docker build -t xuanji-brain .
docker run -p 3000:3000 --env-file .env xuanji-brain
```

### Zeabur 部署

详见 [DEPLOY.md](DEPLOY.md)

1. 在 Zeabur Dashboard 选择 GitHub 仓库部署
2. 配置环境变量（DATABASE_URL, APP_ID, APP_SECRET 等）
3. 运行 `npx drizzle-kit push` 同步数据库
4. 完成部署

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `DATABASE_URL` | 是 | MySQL 连接字符串 |
| `APP_ID` | 是 | Kimi 应用 ID |
| `APP_SECRET` | 是 | Kimi 应用密钥 |
| `VITE_APP_ID` | 是 | 前端应用 ID（同 APP_ID）|
| `OWNER_UNION_ID` | 否 | 管理员 Union ID |

## 项目结构

```
xuanji11/
├── api/                  # 后端 API
│   ├── router.ts         # tRPC 路由注册
│   ├── middleware.ts     # 认证/权限中间件
│   ├── *-router.ts       # 各模块路由
│   ├── kimis/            # Kimi OAuth 认证
│   ├── lib/              # 工具函数
│   └── queries/          # 数据库查询
├── contracts/            # 前后端共享类型
├── db/
│   ├── schema.ts         # 数据库表定义（11张表）
│   └── relations.ts      # 表关系
├── src/
│   ├── pages/            # 页面组件
│   ├── components/       # 通用组件
│   ├── hooks/            # 自定义 Hooks
│   ├── store/            # Zustand 状态
│   └── providers/        # tRPC Provider
├── Dockerfile            # Docker 构建
├── docker-compose.yml    # 本地 Docker 测试
└── DEPLOY.md             # Zeabur 部署指南
```

## 数据库表

| 表名 | 用途 |
|------|------|
| `users` | OAuth 用户认证 |
| `agents` | 智能助手 + 权限配置 |
| `knowledge_nodes` | 知识图谱节点 |
| `knowledge_edges` | 知识图谱关系 |
| `kb_folders` | 知识库文件夹 |
| `kb_documents` | 知识库文档 |
| `workflows` | 工作流 |
| `workflow_nodes` | 工作流节点 |
| `data_sources` | 数据源 |
| `uploaded_files` | 上传文件 |
| `vector_collections` | 向量集合 |

## 后续更新推送

```bash
# 修改代码后
npm run check    # 类型检查
npm run build    # 构建

# 提交并推送（会自动触发 Zeabur 重新部署）
git add .
git commit -m "更新描述"
git push origin main
```

## 许可证

MIT

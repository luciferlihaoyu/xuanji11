# 璇玑修复与完善计划 SPEC v1.0

> 2026-07-01 | 范围：5 个问题域，按优先级排序

## 问题 1: 上传文件失败（P0 🔴）

### 现状
- 上传 `/api/upload` 无 JWT 认证
- 上传后 `ingestFile()` 在后台 fire-and-forget，异常只打日志不返回
- 前端 fetch 检测到 `data.error` 但错误信息是 "Failed query: insert into uploaded_files (...)"，具体 SQL 错误被吞了

### 修复要求
1. **REST API 加 JWT 认证** — `/api/upload`, `/api/upload/list`, `/api/upload/:id`, `/api/files/:filename`, `/api/upload/:id/ingestion` 全部需要 `requireAuth` 校验
2. **上传成功后 `saveUploadedFile` 传入 `uploadedBy`** — 从 JWT 中提取当前用户 ID
3. **错误处理增强** — logging 输出完整 SQL 错误，前端显示具体原因
4. **后端 upload-handler.ts 中 `saveUploadedFile` 的 `metadata` 字段** — MySQL json 列需确保序列化正确
5. **ingestFile 错误不回吞** — 上传成功但 ingestion 失败要在前端有展示

## 问题 2: 数据备份修复（P1 🟡）

### 现状
- `BackupPage.tsx` 有一个 `access_token` 输入框但云盘备份流程未实际验证
- 115/阿里云盘连接器的 token 刷新逻辑可能过时
- 备份调度器 `backup-scheduler.ts` 未验证

### 修复要求
1. **备份配置文件存储** — 云盘认证信息（access token / refresh token）通过 `system_settings` 表持久化，不在前端暴露
2. **后端验证云盘连接器** — 确保 `uploadFile` 和 `syncFiles` 方法可用，增加错误返回
3. **前端备份页面联调** — 创建/执行/查看备份状态走过完整流程
4. **备份调度器日志增强** — 明确记录调度和过期清理

## 问题 3: 向量模型配置（P1 🟡）

### 现状
- Settings 页面"向量化模型"设置是纯静态 UI（select/input 全用 defaultValue，没绑定 tRPC）
- 实际向量引擎读的是环境变量 `LLM_API_URL` / `LLM_API_KEY` / `EMBEDDING_MODEL`
- 用户部署后无法在运行时修改

### 修复要求
1. **后端新增 `/api/setting` 读写** —`setting.getByKey` 和 `setting.set` 已经实现，确认可用
2. **前端 Settings 页面向量配置绑定后端** — 读 `setting.getByKey('embedding_model')` 等，写 `setting.set`
3. **向量引擎 `getEmbeddingConfig()` 改为支持运行时配置** — 优先检查 `system_settings` 表，没有才回退到环境变量
4. **Settings Agent 配置页面也联调** — 天宫 Hub URL / Agent Token / 心跳间隔等存到 `system_settings`

## 问题 4: Agent 连接与使用说明（P2 🟢）

### 现状
- `AgentManagement.tsx` 完全基于 Zustand 前端内存数据，不读写 `agents` 表
- Agent 页面没有"对话/执行/测试连接"功能
- `api/agent-router.ts` 已有完整 CRUD 但前端没用

### 修复要求
1. **Agent 管理页面接入后端** — 使用 `trpc.agent.list` 替代 `useAppStore` 的 agents
2. **Agent 详情抽屉增加 LLM 连接配置** — API URL / API Key / Model 等，存入 `agents.config` JSON 字段
3. **新增"测试连接"后端 API** —`adminQuery` 调用指定的 LLM API 测试有效性
4. **Agent 创建/编辑/删除全部走 tRPC** — 移除纯前端 Zustand 数据

## 问题 5: 网页安全 / 认证完善（P2 🟢）

### 现状
- tRPC 路由已正确使用 `authedQuery` / `adminQuery`
- 但 REST API (`/api/upload` 等) 全部无认证
- JWT cookie 名 `kimi_sid` 不当（共用 Kimi OAuth cookie 名）
- 前端 Settings 页面没有登出/密码修改功能

### 修复要求
1. **所有 REST API 添加 JWT 认证中间件** — 在 `boot.ts` 的 Hono 上添加通用 auth middleware
2. **Cookie 名改 `xuanji_session`** — 修改 `contracts/constants.ts` 和 `local-auth.ts`
3. **前端添加登出按钮** — Settings 页面的 Security tab 增加登出和清除会话
4. **修改密码功能** — 后端新增 `auth.changePassword`、前端新增表单

## 技术栈

- 前端: React 19 + TypeScript + Vite + tRPC 11.x + shadcn/ui
- 后端: Hono + tRPC 11.x + Drizzle ORM + mysql2
- 认证: JWT (jose) + httpOnly Cookie
- 部署: Docker + Zeabur

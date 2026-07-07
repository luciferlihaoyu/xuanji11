# Phase 2 安全加固决策记录

## 2026-07-07
- 开始 Phase 2：P1 级安全加固。
- JWT secret 不再使用 `APP_SECRET` 回退；生产环境 `JWT_SECRET` 缺失或长度 <32 时 `console.error` 后 `process.exit(1)`，开发环境才允许生成临时随机 secret 并警告。
- 登录限流采用进程内 `Map`，key 为 `ip::username`，5 分钟内 5 次失败锁定 15 分钟；客户端仍只收到通用认证失败，锁定细节只写服务端日志。
- 本地 JWT 增加 `jti` 与 `iat`；`verifyLocalToken` 读取 `system_settings.admin_password_changed_at`，拒绝密码修改前签发的旧 token。
- 改密成功后写入 `system_settings.admin_password_changed_at` 并立即重新签发 cookie，使当前会话保持登录，同时让旧会话在后续校验中失效。
- 登录与改密 mutation 要求 `X-Requested-With: XMLHttpRequest` 或 same-origin `Origin`，作为后续 CSRF 加固的最小兼容前置条件。
- Cookie 默认 `SameSite=Lax`，包括非 localhost；仅当 `COOKIE_SAMESITE=None` 显式配置时启用跨站 cookie，用于 iframe/嵌入等特殊场景，`httpOnly`/`secure`/`path` 行为不变。
- CSRF 校验放在 `/api/*` 认证中间件之前，仅保护 `POST/PUT/PATCH/DELETE`，要求 `X-Requested-With: XMLHttpRequest`；GET、MCP (`/api/mcp`, `/api/mcp/sse`) 与 workflow webhook (`/api/workflows/:id/webhook`) 不拦截，避免破坏既有 MCP/webhook 调用方。
- 前端 tRPC client 统一带 `X-Requested-With`；现有直接 POST/DELETE fetch（上传、上传删除、知识库手写 tRPC POST）同步补头，保证 SameSite=Lax 下同站登录与上传继续正常。
- 非 MCP API 错误响应继续使用业务通用文案；服务端通过 `console.error` 保留完整错误，workflow webhook 触发失败统一返回 `Webhook 触发失败`，不透出调度器返回的内部错误文本。
- Hono 安全升级采用 `^4.12.28`：当前 registry 无 `^4.13.0` 可安装版本，`4.12.28` 是可见最高版本且满足 `>4.12.24`。
- Docker runner 阶段使用官方 `node` 非 root 用户运行；root 仅用于安装依赖、复制文件、设置 `docker-entrypoint.sh` 可执行位和目录归属。
- `/data/app/uploads`、`/data/app/backups`、`/data/app/zvec` 统一授权给 `node:node`，保障持久卷挂载后的应用读写路径与默认环境变量一致。
- `.env.example` 中 `ADMIN_PASSWORD` 和 `JWT_SECRET` 改为占位符，并用注释要求生产环境设置强密码及 ≥32 字符随机 JWT secret；`ADMIN_USERNAME=admin` 仅保留为示例并注明必须修改。
- 非 MCP 路由错误详情泄露收敛：
  - `api/agent-router.ts` 的 `testLlmConnection` catch 不再返回 `err.message`，统一返回 `"连接测试失败"`，完整异常写入 `console.error("[TestLlm] Failed:", err)`。
  - `api/datasource-router.ts` 的 `testConnection` / `sync` catch 返回固定文案 `"连接测试失败"` / `"同步失败"`，`dataSources.lastError` 写入 `"Internal error"`，真实异常写入 `console.error`。
  - `api/backup-router.ts` 的 `backupJobFiles`、`backupJobs`、`restoreJobs` 的 `.error` 字段不再写入 `err.message`，统一写入 `"Internal error"`，真实异常写入 `console.error`。
  - `api/lib/ingestion.ts` 的 `ingestFile` catch 将 `ingestionItems.error` 改为 `"Internal error"`，真实异常写入 `console.error`。
  - `api/connectors/115.ts` 与 `api/connectors/aliyundrive.ts` 的 `testConnection` catch 不再把 `err.message` 放入 `result.message`，返回 `"连接测试失败"`，真实异常写入 `console.error`。
  - 验证：`npm run check`、`npm test -- --run`、`npm run build` 全部通过。

## 2026-07-07 Deployment

### D7: GitHub Push + Zeabur Direct Deploy
- **Decision**: Push Phase 2 commits to `main` via GitHub, then deploy via `npx zeabur@latest deploy --service-id`.
- **Commits**: 6 atomic commits covering core security, tests, frontend CSRF, deps, Docker, and docs.
- **Deployment ID**: `6a4cf98e49ff5417a9a111c6`
- **Service**: `https://xuanjj29.zeabur.app/`
- **Health check**: `GET /health` → `200 OK` with `{"ok":true,"uptime":15,"dbConnected":true}`
- **Runtime logs**: No errors observed; service booted cleanly, backup scheduler started, all migration checks passed.

## 2026-07-07 Deployment (F1 Error Convergence)

### D8: GitHub Push + Zeabur Direct Deploy
- **Decision**: Push F1 error message convergence fix to `main`, then deploy via `npx zeabur@latest deploy --service-id 6a355024558aac447d432fdd`.
- **Commits**: 4 atomic commits — `fix: converge error messages across API routes`, `fix: converge error messages in cloud connectors`, `docs: record F1 error convergence decisions`, `docs: record knowledge graph phases and learnings`.
- **Service**: `https://xuanjj29.zeabur.app/`
- **Health check**: `GET /health` → `200 OK` with `{"ok":true,"uptime":400,"dbConnected":true}`
- **Runtime logs**: No errors observed; service booted cleanly.

## 2026-07-07 F1 重审残余错误详情泄露修复

### D9: 修复 workflow-runtime.ts 和 backup-scheduler.ts 残余错误详情泄露
- **Decision**: F1 重审发现 2 处残余错误详情泄露，本次修复：
  - `api/lib/workflow-runtime.ts` line ~162: `error: err instanceof Error ? err.message : String(err)` → `error: "Internal workflow error"`，真实异常通过 `console.error` 记录。
  - `api/lib/backup-scheduler.ts` line ~198、~220: `error: errorMsg` → `error: "Internal backup error"`（真实异常已通过 `console.error` 记录，无需新增）。
- **Files changed**: `api/lib/workflow-runtime.ts`, `api/lib/backup-scheduler.ts`
- **Verification**: `npm run check` (tsc -b), `npm test -- --run` (13 tests passed), `npm run build` 全部通过。

## 2026-07-07 Deployment (F1 Residual Error Leak Fix)

### D10: GitHub Push + Zeabur Direct Deploy
- **Decision**: Push F1 residual error message leak fix to `main`, then deploy via `npx zeabur@latest deploy --service-id 6a355024558aac447d432fdd --project-id 6a23dcd2f1be9943f1f95ca0`.
- **Commits**: 2 atomic commits — `fix: redact error details in workflow-runtime and backup-scheduler`, `docs: record F1 residual error leak fix`.
- **Service**: `https://xuanjj29.zeabur.app/`
- **Health check**: `GET /health` → `200 OK` with `{"ok":true,"uptime":185,"dbConnected":true}`
- **Runtime logs**: No errors observed; service booted cleanly.
- **F1 重审确认**: 逐文件 grep `err\.message`，以下 8 个位置均无向 DB 或外部响应泄露 `err.message`：
  - `api/agent-router.ts` ✅
  - `api/datasource-router.ts` ✅
  - `api/backup-router.ts` ✅
  - `api/lib/ingestion.ts` ✅
  - `api/connectors/115.ts` ✅
  - `api/connectors/aliyundrive.ts` ✅
  - `api/lib/workflow-runtime.ts` ✅
  - `api/lib/backup-scheduler.ts` ✅（仅 `console.error` 日志使用 `errorMsg`，DB 字段统一写入 `"Internal backup error"`）

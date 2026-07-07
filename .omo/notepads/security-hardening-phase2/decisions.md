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

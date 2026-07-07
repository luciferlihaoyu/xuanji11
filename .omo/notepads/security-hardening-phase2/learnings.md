# Phase 2 安全加固学习笔记

## 当前上下文
- 仓库: /opt/xuanji11
- 分支: main
- 线上: https://xuanjj29.zeabur.app/
- Zeabur 项目: 6a23dcd2f1be9943f1f95ca0
- Zeabur 服务: 6a355024558aac447d432fdd

## 关键决策
- Phase 1 已完成 P0：API Key scope、上传安全、Markdown XSS、MCP 错误收敛。
- Phase 2 处理 P1：认证/会话、CSRF/错误收敛、依赖/运行环境。
- 登录限流基于 IP + 用户名，使用内存 Map（个人实例简单可行）。
- 改密码后通过更新用户 `updatedAt` 并在 JWT 校验时对比签发时间来吊销旧 token。
- CSRF：Cookie SameSite 改为 Lax；为 SPA 增加 `X-Requested-With` header 校验后端 tRPC 非 GET 请求。
- 错误详情：非 MCP 路由的 `err.message` / `details` 统一收敛。
- 2026-07-07 P1 实施：`COOKIE_SAMESITE=None` 是唯一允许 SameSite=None 的显式开关；默认同站登录/上传使用 Lax。
- 2026-07-07 P1 实施：`POST/PUT/PATCH/DELETE` 的 `/api/*` 请求需要 `X-Requested-With: XMLHttpRequest`，MCP 与 workflow webhook 保持豁免。
- 2026-07-07 P1 实施：`/api/upload`、上传列表/删除/ingestion、workflow webhook 的 catch/result 错误只向客户端返回通用文案，完整错误写入服务端 `console.error`。
- hono 升级到 >4.12.24。
- Dockerfile 改为非 root 用户运行，上传目录权限正确。
- .env.example 移除默认弱密码；JWT_SECRET 生产环境强制非空且长度 ≥32。

## 验证命令
- npm run check
- npm test
- npm run build

## 2026-07-07 P1 认证与会话加固补充
- `api/lib/env.ts` 之前会在 `JWT_SECRET` 缺失时回退到 `APP_SECRET` 或随机值；生产 Zeabur 环境需要启动即失败，避免弱 secret 或重启后会话全部失效。
- 登录入口有两条路径：Hono `createLocalLoginHandler` 与 tRPC `auth.login`；限流必须放在共享的 `verifyAdminCredentials` seam，并由两条路径传入 `x-forwarded-for`/`x-real-ip` 解析出的 IP。
- `jose` 的 `iat` 为秒级精度；`admin_password_changed_at` 存 ISO 字符串到既有 `system_settings`，校验时拒绝明确早于该时间的 token，改密后重新签发当前会话 token。
- SPA tRPC client 已经发送 `X-Requested-With: XMLHttpRequest`，登录和改密 mutation 可用该 header 或同源 `Origin` 做最小 CSRF-compatible 校验，不影响现有 UI。

## 2026-07-07 P1 依赖与运行环境加固
- 当前 npm registry 可见的 hono 最高稳定版为 4.12.28；`^4.13.0` 无法解析，因此采用 `^4.12.28`，满足安全约束 `>4.12.24` 且避免无关依赖升级。
- Docker runner 阶段继续用 root 完成依赖安装与文件复制，然后 `chown -R node:node /app /data/app` 并 `USER node`，确保入口脚本可执行且运行时不再以 root 启动。
- `/data/app/uploads`、`/data/app/backups`、`/data/app/zvec` 在镜像内显式创建并授权给 `node`，匹配应用默认 `UPLOAD_DIR`、`BACKUP_TEMP_DIR`、`ZVEC_DATA_DIR`。
- `.env.example` 保留必填项说明，但不再提供可直接上线的默认弱管理员密码或弱 JWT secret。

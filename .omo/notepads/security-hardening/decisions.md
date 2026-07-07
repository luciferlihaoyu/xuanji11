# 安全加固决策记录

## 2026-07-07
- 按用户要求，优先执行 P0 安全修复：API Key scope、上传安全、Markdown XSS。
- 不引入公开 Agent 注册，保持管理员手动创建模式。
- 知识库 Markdown 预览采用 `marked` + DOMPurify allow-list + React 节点转换；保留标题、列表、代码块、引用、链接、内部链接和标签 chip 视觉样式，同时禁止 raw HTML 执行路径。
- API Key 只代表带 scope 的调用身份；管理类 tRPC mutation 继续走 `adminQuery`，且仅 session 管理员可通过，避免 API Key 继承管理员权限。
- MCP tool 调用统一在 handler 起始处执行 scope 校验：读写知识库、文档、备份、工作流分别映射到独立 scope。
- 上传文件磁盘名改为服务端 `randomUUID()` 加安全 MIME 白名单推导扩展名；无法安全推导时使用 `.bin`，不再信任用户文件名或原始扩展名。
- 下载接口改为 `/api/files/:id`，先查 `uploaded_files` 记录，再用 `path.resolve(UPLOAD_DIR, record.storagePath)` 并要求结果位于 `UPLOAD_DIR + path.sep` 下，避免路径穿越。
- 下载统一 `Content-Disposition: attachment`、`X-Content-Type-Options: nosniff`，HTML/SVG/XML 等可执行或高风险扩展不允许作为上传扩展保留。
- 非管理员下载必须显式校验 `uploadedBy === user.id`，不依赖线上数据库 FK。
- 上传失败仅向客户端返回通用错误，详细错误只写服务端日志。
- MCP `handleMcpRequest` 的异常处理改为仅向调用方返回通用 JSON-RPC 错误：`ZodError` 返回 `Invalid tool arguments`，其他 `Error` 返回 `Internal tool error`；真实异常与请求方法仅写入服务端日志，避免内部详情泄露给 MCP 调用方。

## 2026-07-07 部署记录
- 安全加固提交: `b50bd95 fix: enforce P0 security hardening`，已推送到 GitHub `main`。
- 提交前复验: `npm run check` 通过，`npm run build` 通过。
- Zeabur 直传部署: `project_id=6a23dcd2f1be9943f1f95ca0`，`service_id=6a355024558aac447d432fdd`，CLI 返回 `status: success`。
- 线上健康检查: `https://xuanjj29.zeabur.app/health` 返回 HTTP 200，`ok: true`，`dbConnected: true`。

## 2026-07-07 MCP 错误详情泄露修复部署记录
- 修复提交: `85dbc19 fix: redact MCP error details`，已推送到 GitHub `main`。
- Zeabur 重新直传部署: `project_id=6a23dcd2f1be9943f1f95ca0`，`service_id=6a355024558aac447d432fdd`，最新部署 ID `6a4cb38949ff5417a9a10a16`，状态 `RUNNING`。
- 线上健康检查: `https://xuanjj29.zeabur.app/health` 返回 HTTP 200，`ok: true`，`dbConnected: true`。
- F1 最后一个阻塞问题修复：`api/mcp-server.ts:191` 的 JSON-RPC 解析失败现在只返回通用 `Invalid JSON-RPC request`，`parsed.error.issues` 仅记录到服务端日志，不再回传给 MCP 调用方。

## 2026-07-07 F1 最后一次修复部署确认
- 提交: `2463847 fix: redact MCP JSON-RPC parse errors`，已推送到 GitHub `main`。
- Zeabur 直传部署: `project_id=6a23dcd2f1be9943f1f95ca0`，`service_id=6a355024558aac447d432fdd`，最新部署 ID `6a4cb6506ec90535ce43d0ee`，状态 `RUNNING`。
- Runtime 日志确认服务已启动：`璇玑智脑 running on http://localhost:8080/`，无运行错误。
- 线上健康检查: `https://xuanjj29.zeabur.app/health` 返回 HTTP 200，`ok: true`，`dbConnected: true`。

## 2026-07-07 MCP 错误消息收敛修复部署记录
- F1 最后一次修复已完成：`api/mcp-server.ts` 的认证失败与 method not found 统一改为客户端通用消息；服务端分别记录 `hasAuthorization` 与 `method`，但不记录完整 Authorization token。
- 部署提交: 待本次提交落盘后补充。
- Zeabur 直传部署: `project_id=6a23dcd2f1be9943f1f95ca0`，`service_id=6a355024558aac447d432fdd`，最新部署 ID `6a4cba2349ff5417a9a10ae9`，状态 `RUNNING`。
- Runtime 日志确认服务已启动：`璇玑智脑 running on http://localhost:8080/`，并持续打印 `BackupScheduler` 日志，无运行错误。
- 线上健康检查: `https://xuanjj29.zeabur.app/health` 返回 HTTP 200，`{"ok":true,"dbConnected":true}`。

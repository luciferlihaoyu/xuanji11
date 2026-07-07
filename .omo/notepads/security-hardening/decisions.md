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

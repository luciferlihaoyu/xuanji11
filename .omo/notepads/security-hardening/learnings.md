# 安全加固学习笔记

## 当前上下文
- 仓库: /opt/xuanji11
- 分支: main
- 线上: https://xuanjj29.zeabur.app/
- Zeabur 项目: 6a23dcd2f1be9943f1f95ca0
- Zeabur 服务: 6a355024558aac447d432fdd

## 关键决策
- API Key 不能再映射为 role="admin"，必须独立 authType 和 scopes。
- 文件保存使用服务端生成 UUID，不信任用户文件名；下载按数据库记录 + 路径校验。
- Markdown 渲染改为安全库或 DOMPurify 清洗，禁用 raw HTML。
- 线上 DB 表无 FK，代码不依赖 FK 做权限校验，必须显式检查。

## 验证命令
- npm run check
- npm test
- npm run build

## 2026-07-07 Markdown XSS 修复补充
- 知识库 Markdown 预览不能对用户内容使用 `dangerouslySetInnerHTML`；即使先经过正则转换，原始 HTML、事件处理器和 `javascript:` 链接仍可能形成存储型 XSS。
- 当前修复路径：`marked` 负责 Markdown 解析，自定义 renderer 将 raw HTML 转义为文本，DOMPurify 使用 allow-list 清洗，再转换为 React 节点渲染。
- `[[...]]` 和 `#tag` 的自定义视觉 chip 只在已 escape 的文本 token 上生成，避免链接文本或标签文本重新引入 HTML 执行路径。

## 2026-07-07 API Key scope enforcement
- tRPC context must keep `ctx.user` for audit/createdBy but put authorization facts in `ctx.auth`; API Key auth must never fabricate `role: "admin"`.
- MCP auth and tRPC auth should share the same `api_keys.keyHash/isActive/expiresAt` lookup and `scopes` parsing path; duplicate fallback column guessing can accidentally accept unexpected credentials.
- `backup_trigger` requires a dedicated `backups:write` scope, so Agent `write` permission must include that scope when generating API keys.

## 2026-07-07 上传/下载加固发现
- `/api/files/` 的运行时代码引用只有 `api/upload-handler.ts` 返回值、`api/boot.ts` 路由、`src/pages/UploadPage.tsx` 列表 URL；旧 `/api/files/:filename` 只剩历史分析文档引用。
- `uploaded_files.storagePath` 当前保存绝对路径；路径校验需兼容绝对路径和相对路径，因此使用 `path.resolve(UPLOAD_DIR, record.storagePath)` 后再做上传目录前缀约束。
- XML MIME 可被记录为已知类型，但 `.xml` 原始扩展名仍拒绝，避免浏览器回显或后续解析链路触发 XSS/XXE 风险。

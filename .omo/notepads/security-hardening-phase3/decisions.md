# Phase 3 安全加固决策记录

## 2026-07-07
- 开始 Phase 3：纵深防御（依赖漏洞、安全响应头、输入校验）。

## 2026-07-07
- 在 `api/boot.ts` 新增全局安全响应头中间件 `securityHeadersMiddleware`。
- 中间件注册顺序：app 创建后尽早挂载（`app.use(securityHeadersMiddleware)`），位于 `bodyLimit` 和路由注册之前；因当前 `boot.ts` 未配置 CORS，后续如引入 CORS 应放在本中间件之前。
- 统一为所有响应添加以下头：
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=()`
  - `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`
- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` 仅在 `NODE_ENV=production` 且请求 hostname 不是 localhost/127.0.0.1/[::1] 时添加。
- 静态资源通过生产分支 `serveStaticFiles(app)` 注册，`serveStatic` 使用 `app.use("*", ...)`，由于安全中间件已先全局挂载，静态文件响应会继承所有安全头。
- `/api/mcp`、`/api/mcp/sse` 不特殊豁免，与所有路由统一加头。
- 未引入新 npm 依赖，使用纯 Hono 中间件实现。
- 验证结果：`npm run check` 通过；`npm test -- --run` 通过（13/13）；`npm run build` 通过。
- 环境限制：当前容器缺少 Zvec 原生依赖及 curl/openssl，无法在本地起生产服务实测响应头，部署后需用 curl 复查线上响应头。

## 2026-07-07 依赖漏洞修复（npm audit）
### 初始状态
- `npm audit --audit-level=moderate` 报告 13 个漏洞：5 high、8 moderate。
- 涉及包：`ajv`、`brace-expansion`、`esbuild`（drizzle-kit 传递依赖）、`flatted`、`js-yaml`、`lodash`、`minimatch`、`picomatch`、`postcss`、`rollup`。

### 修复操作
- 运行 `npm audit fix`（未带 `--force`）。
- 结果：package-lock.json 更新，升级了 ajv、brace-expansion、flatted、js-yaml、lodash、minimatch、picomatch、postcss、rollup、tsx 的 esbuild 等 transitive 依赖。
- package.json 未变更，因为修复均为非破坏性的 transitive 依赖升级。

### 残余漏洞
- `npm audit --audit-level=moderate` 剩余 4 个 moderate 漏洞。
- 全部来自 `drizzle-kit@0.31.8` → `@esbuild-kit/esm-loader` → `@esbuild-kit/core-utils` → `esbuild <=0.24.2`。
- `npm audit fix --force` 会降级 `drizzle-kit` 至 `0.18.1`，属于 breaking change，本次不执行。

### 验证
- `npm run check`：通过。
- `npm test -- --run`：5 个测试文件、13 个测试全部通过。
- `npm run build`：成功。
- `npm audit --audit-level=moderate`：残余 4 moderate（上述已记录）。

### 决策
- 已采用非破坏性修复，high 等级漏洞已清零。
- 剩余 4 个 moderate 漏洞因修复需 breaking change（drizzle-kit 大版本降级），本次跳过，后续在 drizzle-kit 官方升级后再次评估。

## 2026-07-07 P2: 全路由输入校验与注入风险复核

### 扫描范围
- `api/*-router.ts`（11 个 tRPC router）、`api/boot.ts`（Hono 路由）、`api/mcp-server.ts`。
- `api/lib/workflow-runtime.ts`、`api/lib/backup-scheduler.ts`、`api/lib/ingestion.ts`。
- `api/upload-handler.ts`（路径穿越复核）。

### 发现与修复

#### 1. Hono 路由参数仅做 `parseInt` / `isNaN`，未校验正整数
- 位置：`api/boot.ts` 的 `DELETE /api/upload/:id`、`GET /api/upload/:id/ingestion`、`POST /api/workflows/:id/webhook`。
- 风险：负数 / 零 / 非整数 ID 会进入后续业务逻辑，可能被利用绕过权限或产生异常。
- 修复：新增 `parsePositiveIntParam` 辅助函数，要求 `Number.isInteger(id) && id > 0`，三处路由统一使用。

#### 2. 多个 `LIKE` 搜索字段未限制长度
- 位置：
  - `api/agent-router.ts`：`list.search`（原 `z.string().optional()`）
  - `api/file-router.ts`：`list.search`、`list.mimeType`
  - `api/kb-router.ts`：`searchDocuments.query`
  - `api/knowledge-router.ts`：`searchNodes.query`、`semanticSearch.query`
  - `api/mcp-server.ts`：`knowledge_search.query`
- 风险：Drizzle ORM 使用参数化查询，无 SQL 注入；但超长搜索串可能导致 LIKE 性能风暴或 wildcard 滥用。
- 修复：为上述字段增加 `.max(...)`（搜索串 200–500、mimeType 100）。

#### 3. 备份 / 恢复路径存在路径穿越风险
- 位置：
  - `api/backup-router.ts`：`create.sourcePath`、`createRestore.targetPath` 仅校验 `min(1)`。
  - `api/backup-router.ts` / `api/lib/backup-scheduler.ts`：`executeBackup` / `executeBackupJob` 直接读取 `job.sourcePath`；`executeRestore` 使用 `path.join(job.targetPath, file.relativePath)`。
- 风险：管理员身份被利用时，`sourcePath` 可指向任意目录读取文件；`targetPath` 与 DB 中 `relativePath` 可能包含 `..`，导致恢复文件写到预期目录外。
- 修复：
  - 新增 `api/lib/backup-path.ts`：提供 `hasPathTraversal`、`sanitizeRelativePath`、`resolveRestoreDestPath`。
  - Router 输入 schema 对 `sourcePath`、`targetPath` 增加 `max(500)` 并通过 `refine` 拒绝 `..` / NUL 字节。
  - 备份执行前校验 `sourcePath`；备份文件写入前对 `relativePath` 消毒并重新使用消毒后的路径落库。
  - 恢复时使用 `resolveRestoreDestPath` 解析目标路径，并二次校验解析后的绝对路径必须位于目标目录内。

#### 4. `fileRouter.register.storagePath` 未做路径安全校验
- 位置：`api/file-router.ts`。
- 风险：管理员可注册含 `..` 或 NUL 的 storagePath；虽然 `upload-handler.ts` 的 `path.resolve` + `startsWith` 前缀校验能阻止逃出 `UPLOAD_DIR`，但防御点应在输入层。
- 修复：为 `storagePath` 增加 `max(500)` 并拒绝 `..` / NUL 字节。

#### 5. 未发现命令注入 / SQL 注入 / NoSQL JSON 注入
- 全项目（含 `api/lib`）未使用 `child_process.exec` / `execFile` / `spawn`。
- 所有 SQL / JSON 路径操作均使用 Drizzle 参数化查询或模板字面量绑定变量（`sql"..."` + `${variable}`），无可信输入直接拼接 SQL。
- `api/mcp-server.ts` 所有 tool arguments 均经过 Zod `.parse()`。
- `api/upload-handler.ts` 已使用 `path.resolve` + 前缀校验，无路径穿越残余风险。
- `api/lib/workflow-runtime.ts` 的节点执行器均为内存函数，无 `eval` / shell；`condition` 节点仅做字符串相等比较。

### 验证
- `npm run check`：通过。
- `npm test -- --run`：5 个测试文件、13 个测试全部通过。
- `npm run build`：成功。

### 决策
- 本次仅做最小修复，未修改 schema / 数据库结构，未大规模重构。
- 备份/恢复路径安全由输入层 `zod refine` + 执行层 `backup-path.ts` 双重防御，后续如新增连接器应复用同一套消毒逻辑。

## 2026-07-07 部署 Phase 3（生产验证）

### Git 提交（5 个原子 commit，均为 semantic style）
1. `63eb542` `fix: prevent path traversal in backup/restore and NAS connector`
   - `api/lib/backup-path.ts`（新增）+ `api/lib/backup-scheduler.ts` + `api/backup-router.ts` + `api/connectors/nas.ts`
2. `a3b0fac` `feat: add global security response headers and positive-int param validation`
   - `api/boot.ts`
3. `c8e9a25` `fix: constrain max length on all user-facing search/query inputs`
   - `api/agent-router.ts` + `api/file-router.ts` + `api/kb-router.ts` + `api/knowledge-router.ts` + `api/mcp-server.ts`
4. `16fab18` `chore: fix dependency vulnerabilities via npm audit fix`
   - `package-lock.json`
5. `aa20136` `docs: record Phase 3 security hardening decisions, issues, and learnings`
   - `.omo/notepads/security-hardening-phase3/`

### Zeabur 部署
- 部署方式：`npx zeabur@latest deploy --project-id 6a23dcd2f1be9943f1f95ca0 --service-id 6a355024558aac447d432fdd --json`
- 目标环境：`6a23dcd295b39806d284a971`
- 状态：RUNNING（finishedAt 2026-07-07T14:35:39Z）
- 服务域名：`https://xuanjj29.zeabur.app`

### 生产验证
- `GET /health` → `200`，`{"ok":true,"uptime":148,"dbConnected":true}`
- 安全响应头全部存在：
  - `X-Frame-Options: DENY`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Content-Security-Policy: default-src 'self'; …`
  - `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- 由于线上环境为 production（经 Zeabur 代理），且 hostname 非 localhost，HSTS 正确添加。


# 璇玑知识库 P0 实施计划（依据 docs/reports/xuanji-knowledge-base-analysis-and-roadmap.md）

> 纪律：每任务先写失败测试（RED）→ 最小实现（GREEN）→ 重构；**类型门禁 = `npm run check`（`tsc -b`）**；本容器只跑**单文件** vitest（禁止全量套件）；完成后走部署 + 线上验证 + 独立审查。
>
> ⚠️ 口径更正（2026-09-18，天演审查实证）：根 `tsconfig.json` 是 `files: []` + references，**`npx tsc --noEmit` 是零文件检查、恒 exit 0 的空转**——本文件早期记录的「tsc 零错」从未覆盖任何代码。真实门禁是 `npm run check`（`tsc -b`，含 app/node/server 三项目）。已修：我引入的类型错误 + 存量 alist 7 处 → **2026-09-18 `npm run check` 首次 exit 0**。
> 环境：仓库 `/data/dsh/璇玑/xuanji11-review`，SQLite（`db/schema.ts` sqliteTable），boot 自动执行 `db/migrations`（`api/boot.ts:45`），生成迁移用 `npm run db:generate`。
> 历史计划见 `PLAN.md`（审查修复 Round 1，已执行完毕，勿改）。

## t1 评测数据模型 + 检索分数分解（后端）

- **goal**: 建评测用例表；检索结果暴露每来源分数分解；评测核心算 recall@k / MRR。
- **files**:
  - `db/schema.ts`（新增 `kbEvalCases` 表）
  - `db/migrations/0007_*.sql`（`npm run db:generate` 生成）
  - `api/lib/hybrid-search-utils.ts`（`EvidenceChunk`/`MergedHit` 如需补分数字段）
  - `api/lib/hybrid-search.ts`（`SearchResult` 增加可选 `scoreBreakdown?: { keyword?: number; vector?: number; rrf?: number; llmRerank?: number }`，从 MergedHit/InternalHit 填充）
  - `api/lib/search-eval.ts`（新）
  - `api/lib/search-eval.test.ts`（新，先写失败）
- **change**:
  - `kbEvalCases`: `id PK, query TEXT NOT NULL, expectedDocIds TEXT NOT NULL (JSON 数组字符串), note TEXT, createdAt timestamp_ms`。
  - `search-eval.ts**: `export interface EvalCaseResult { caseId: number, query: string, expectedDocIds: number[], hitDocIds: number[], recallAtK: number, reciprocalRank: number }`；`export function computeEvalMetrics(cases: EvalCaseResult[]): { caseCount: number, meanRecallAtK: number, mrr: number }`（纯函数：MRR=首个命中期望文档的排名倒数，无命中记 0）；`export async function runEval(opts: { mode, rerank, topK }): Promise<{ results: EvalCaseResult[], metrics, durationMs }>`——逐条调 `executeHybridSearch`，命中集合取 `results.filter(r => r.type === "document")` 的 `id`（id 为 string，与 expected 的 number 对比需 Number() 转换）。
- **verify**: `npx vitest run api/lib/search-eval.test.ts` 全绿（含空集/全命中/部分命中的 recall、MRR 手算断言）；`npm run check`（`tsc -b`）无错误。

## t2 评测路由 + 问答重排策略化（后端）

- **goal**: tRPC 暴露评测 CRUD 与 run；ask-rag 的 rerank 不再硬编码。
- **files**:
  - `api/search-eval-router.ts`（新；在 `api/router.ts` 照 `reviewRouter` 的注册方式注册为 `searchEval`）
  - `api/lib/ask-rag.ts`（检索参数策略化）
  - `api/ask-rag.test.ts`（新，先写失败；mock `./hybrid-search` 与 `./llm-chat`，mock 模式参考 `api/lib/backup-scheduler.test.ts`）
- **change**:
  - 路由：`listCases: authedQuery`；`createCase/deleteCase: adminQuery`（zod：`query: z.string().min(1)`、`expectedDocIds: z.array(z.number().int()).min(1)`、`note: z.string().optional()`）；`runEval: adminQuery`（`{ mode: z.enum(["keyword","vector","hybrid"]).default("hybrid"), rerank: z.boolean().default(false), topK: z.number().int().min(1).max(20).default(5) }`）调 `runEval` 返回逐条结果与汇总。
  - `ask-rag.ts`: 新增 `export async function resolveAskRetrievalOptions(): Promise<{ mode: "hybrid"; limit: number; rerank: boolean }>`——读 `systemSettings.key = "ask_retrieval_rerank"`（"true"/"false"，缺省与异常兜底 false；读法照 `api/lib/egress.ts:107-111`）；`askKnowledgeBase` 用它替换 `api/lib/ask-rag.ts:43` 的硬编码，并新增可选参数 `retrievalOverride?: Partial<{ limit: number; rerank: boolean }>`（调用方/测试可显式控制，优先级最高）。
- **verify**: `npx vitest run api/ask-rag.test.ts` 全绿（断言：设置 "true" 时传给 executeHybridSearch 的 rerank=true；无设置 false；override 覆盖一切）；`npm run check`（`tsc -b`）干净。

## t3 检索测试台前端

- **goal**: 一页看清每次检索的命中、分数分解与耗时；可固化为评测用例、跑评测集看指标。
- **files**: `src/pages/SearchTestbed.tsx`（新）、`src/App.tsx`（注册 `/search-testbed`）、`src/components/TopNavbar.tsx`（导航入口「测试台」）。
- **change**:
  - 控件：query、mode（keyword/vector/hybrid）、rerank 开关、topK 1-20；调既有搜索端点（调用方式照 `src/pages/SearchResults.tsx`）；结果表列：title / score / scoreBreakdown 四列（kw·vec·rrf·rerank）/ sources / reasons / evidence 片段数；顶部 metadata（durationMs、keywordResults、vectorResults、cached、total）与 facets 计数。
  - 「存为评测用例」：勾选结果中文档 → `searchEval.createCase`；用例列表可删。
  - 「跑评测集」：`searchEval.runEval`（当前 mode/rerank/topK）→ meanRecallAtK、MRR、逐条 recall/首个命中排名。
  - 样式沿用 `SearchResults.tsx` 的 Tailwind + CSS 变量（`var(--text-primary)` 等）。
- **verify**: `npx vite build` 成功且 `ls dist/public/assets | grep -i testbed` 有产物；`npm run check`（`tsc -b`）干净；部署后线上 `/search-testbed` 完成一次检索并显示分数分解。

## t4 Citation 2.0 后端（P0-1）

- **goal**: 引用带版本号、段落锚点、分数与来源，可定位原文。
- **files**: `api/lib/ask-rag.ts`、`api/ask-stream-router.ts`、`api/lib/hybrid-search.ts`（evidence 带定位所需信息）、`api/ask-rag.test.ts`。
- **change**: `AskCitation` 扩展为 `{ n, documentId, versionId: number | null, title, snippet, anchor: { chunkIndex: number, heading?: string, charStart?: number, charEnd?: number }, score?: number, retrievedBy: readonly ("keyword"|"vector")[] }`——锚点由 `SearchResult.evidence`（`EvidenceChunk{snippet,source,rank}`）+ `document_chunks` 行反查（snippet 在原文 `indexOf` 定位 charStart/charEnd；heading 取原文中该位置之前最近的 `^#{1,6} ` 行）；`versionId` 取 `kb_document_versions` 该文档最新行 id（无则 null）。`ask-stream-router` 的 `result` 事件透传新字段（旧字段保留，向后兼容）。
- **verify**: `npx vitest run api/ask-rag.test.ts` 新增用例：构造含已知 snippet 的检索结果，断言每条 citation 的 `anchor.chunkIndex` 为 number 且 `charStart >= 0`；无匹配文本时 anchor 各字段为 null/undefined 但对象本身必须存在。

## t5 Citation 2.0 前端（P0-1）

- **files**: `src/pages/SearchResults.tsx`（引用条目变链接）、`src/pages/DocumentDetail`（支持 `#chunk-N`：滚动到第 N 块并高亮 2 秒）。
- **verify**: build 成功；线上问答后点引用跳 `/doc/:id#chunk-N` 并高亮对应块。

## t6 MCP 现代化（P0-3）

- **files**: `api/mcp-server.ts`、`api/mcp-server.test.ts`。
- **change**: 全部 15 工具补 `annotations: { title, readOnlyHint, destructiveHint, idempotentHint }`（`document_delete`=destructiveHint true、`knowledge_search`=readOnlyHint true、`document_upsert`=idempotentHint true，其余按语义）；`folder_list`/`backup_list`/`workflow_list` 支持 `{ cursor?: string, limit?: number }` → 返回 `{ content, nextCursor? }`（cursor=base64(offset)）；`document_delete` 支持 `dryRun: true`（返回将删除的文档元数据，不执行删除）。
- **verify**: `npx vitest run api/mcp-server.test.ts` 全绿（注解存在性逐工具断言、分页两页翻页正确、dryRun 不改库）。

## t7 长任务句柄统一（P0-4）

- **files**: `api/mcp-server.ts`、`api/lib/task-registry.ts`（新）、`api/mcp-server.test.ts`。
- **change**: `backup_trigger` 返回 `{ taskId, status: "queued" }`（仍置 `nextRunAt=now` 走既有调度，taskId 由 task-registry 生成并映射 jobId）；新增 `task_get { taskId }`（status/progress/关联 jobId/最近错误）与 `task_cancel { taskId }`（备份队列可置 enabled=false，其余返回明确不支持）。task-registry 用内存 Map + 启动时重建（从 DB 查最近 run），进程内语义即可，不要求跨重启。
- **verify**: `npx vitest run api/mcp-server.test.ts` 全绿；线上 MCP 触发备份后 `task_get` 能轮询到 completed。

## t8 部署与线上验证（每波收尾）

- **verify**: `github_push` → Zeabur RUNNING → 线上实测（测试台/引用跳转/MCP 注解/task_get）→ 证据记录回本节。

## t9 独立两阶段审查（每波收尾）

- 规格符合度（对照本计划与 roadmap §4 验收）→ 代码质量；critical 先修再收。

---

## 验证记录

### wave1 后端（t1+t2）— 2026-09-18，碧霄亲自实施（子代理通道两批四任均停滞，改亲手 TDD）
- RED：`npx vitest run api/lib/search-eval.test.ts api/ask-rag.test.ts` → 6 failed / 3 passed（缺模块与策略化，证明测试有效）
- GREEN：同命令 → **18/18 通过**；邻接回归 `api/hybrid-search.test.ts` + 上述两文件 → **36/36 通过**（期间修复 rrfScore 未导入的真 bug）
- ~~`npx tsc --noEmit` exit 0~~（**空转，无效证据**，见顶部口径更正）；`npx vite build` exit 0（10.91s）
- 迁移：`db/migrations/0007_rapid_sir_ram.sql`（kb_eval_cases 表 + query 索引，boot 自动执行）
- 交付物：`api/lib/search-eval.ts`、`api/lib/search-eval.test.ts`、`api/search-eval-router.ts`（router.ts 已注册 searchEval）、`api/ask-rag.test.ts`；`SearchResult.scoreBreakdown{keyword,vector,rrf,llmRerank}`、`MergedHit.llmScore`、`ask-rag.resolveAskRetrievalOptions()`（设置 ask_retrieval_rerank 驱动，替换 :43 硬编码）+ `retrievalOverride` 参数

### wave1 前端（t3）— 2026-09-18，碧霄亲自实施
- 交付物：`src/pages/SearchTestbed.tsx`（检索控件 mode/rerank/topK + metadata 条 + 分数分解四列表 + 评测用例管理 + 评测报告三指标卡）；App.tsx 注册 `/search-testbed`（lazy chunk）；CommandPalette 加「检索测试台」入口
- 验证：~~`npx tsc --noEmit` exit 0~~（空转）；`npx vite build` exit 0，产物 `dist/public/assets/SearchTestbed-BE2tM8bL.js`（16.95 kB / gzip 4.36 kB）

### wave1 线上验证 — 2026-09-18（e3afdd7，commit 后等 RUNNING 再验）
- `/health` 502 约 3 分钟后转 200（容器切换期），随后 `searchEval.listCases` → HTTP 200，确认新版上线
- `searchEval.createCase` → id=2；`runEval` → **caseCount=1 recall@5=1 mrr=1**，命中列表 `[1922, 118, 711, 1876, 1923]`（期望的 1922 排第一）
- `/api/search` 结果带 `scoreBreakdown` = `{"rrf":0.033,"keyword":0.016}`；metadata 含 mode/durationMs/keywordResults/vectorResults
- `setting.set(ask_retrieval_rerank=true)` → `getByKey` 回读 `'true'`；ask 流式端点在重排开启下正常返回带引用答案
- 脚本缺陷修正：tRPC GET 的 `input` 必须 superjson 包装（`{"json":{...}}`），否则带参 GET 报 400
- 清理：设置回 false、临时评测用例删除

### wave2 引用可定位（t4+t5）— 2026-09-18，碧霄亲自实施
- 新增 `api/lib/citation-anchor.ts`：`findHeadingBefore` / `buildAnchor` / `resolveLatestVersionIds`（9 用例）
- 新增 `api/lib/chunk-context.ts`：`extractChunkHeading` / `highlightSpan` / `getChunkContext`（11 用例）
- `AskCitation` 扩展：`versionId`（最新版本 id，缺失为 null）、`anchor{chunkIndex,heading,charStart,charEnd}`、`score`、`retrievedBy`
- 检索层透传块序号：`EvidenceChunk.chunkIndex`（bm25 走 `c.chunkIndex`，向量走索引器写入的 `metadata.chunkIndex`）
- 新过程 `kb.getChunkContext`（薄封装，块不存在返回 null 不做近似匹配）
- 前端：搜索结果引用变可点击（`/doc/:id?q=..&chunk#chunk-N` + 块号/章节/分数/版本/来源）；DocumentDetail 新增「引用定位」面板（命中块原文 + 查询词高亮 + 关闭）
- 验证：~~`npx tsc --noEmit` exit 0~~（空转）；`npx vite build` exit 0；回归 5 文件 **61/61 通过**

### wave2 线上验证 — 2026-09-18（c5306f1）
- `kb.getChunkContext(1922, 0)` → 返回真实块原文，`totalChunks=119`，`heading=璇玑个人知识库：现状评估与完善路径`
- 不存在的块（99999）→ `null`（不做近似匹配）✅
- `/api/ask/stream` 引用 7 条：`anchor={chunkIndex:0}`、`retrievedBy=['vector']`、`score=0.016`、`versionId` 字段存在、`n/documentId/title/snippet` 向后兼容 ✅
- **端到端闭环**：引用给出的 `chunkIndex=0` 回查 `getChunkContext` 命中同文档同块 ✅
- 线上数据暴露一处标注缺陷并已修：`versionId` 是版本**行 id**，UI 曾显示成 `v1`（多版本文档会显示成 `v31` 这类误导标签）→ 新增 `versionNumber` 字段，UI 改显 `v{versionNumber}`

### 独立审查（天演，审 e3afdd7）— 2026-09-18
- 阶段一规格符合度 6/7 PASS + **1 critical**：`0007_rapid_sir_ram.sql` 被 `.gitignore` 吞掉未入库，而 `meta/_journal.json` 已引用它 → 干净环境 `readMigrationFiles` 抛错、启动即崩（天演在纯净 worktree 实证）。**该 critical 与线上 12:55 停机事故同源**，已由 d219953/98c95f6 修复，本轮变基继承
- 阶段二代码质量 PASS + 6 minor；测试真实性经变异验证（改 rerank 恒 true → 3 红；改 RR 公式 → 4 红）
- 本轮已修 minor：① 测试台改参数不再打出请求风暴（草稿态 + 点击生效，按钮提示「参数已改」）② 删除用例失败不再静默 ③ `runEval` 单条检索失败不再毁全盘报告（标 error + `failedCount` 且失败项不计入指标）④ 布尔设置口径与 egress 对齐（接受 "true"/"1"）⑤ 补 TopNavbar「检索测试台」导航入口 ⑥ 补测试：runEval 容错、布尔 "1"、版本号标注
- 未修（记录在案）：`api/kb-backup.test.ts` 2 例失败为**存量**问题——在 e0d2f5b（本波次之前）上同样失败，与 P0 无关，另行处理

### wave3 P0-3 MCP 现代化（t10 注解 / t11 分页 / t12 dryRun）— 2026-09-18
- **t10 工具注解**：`annotations {title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint}` 补齐 **全部 29 个工具**（核心 15 + zvec 6 + hybrid 1 + kb-backup 2 + keyword 2 + relation 2 + analytics 1）；`McpTool.annotations` 设为**必填**，6 个模块各自的 `McpTool` 副本改为从 `mcp-server` 类型导入——从此新增工具漏写注解会被 `tsc -b` 拦下
- **t11 cursor 分页**：新增 `api/lib/mcp-pagination.ts`（不透明 base64url cursor，`DEFAULT=50/MAX=200`，非法 cursor 抛 `InvalidCursorError`）；`folder_list`/`backup_list`/`workflow_list` 改为 `{items, nextCursor, total}` 信封；排序补 id 兜底防漏项重项
- **t12 dryRun**：`document_delete` 增 `dryRun`（默认 false 保持向后兼容）；新增 `previewDocumentDeletion`（与级联删除同源计数，`vectors` 由新增的 `vectorEngine.countByDocumentId` 真实统计，不用 chunks 近似）
- **对外的破坏性变更**：三个列表工具返回值由裸数组改为信封 → 已更新 `docs/AGENT_API.md`（含迁移指引与 dryRun/注解说明）
- **验证**：`npm run check` exit 0；`vite build` 成功；MCP 相关 12 文件 **81/81 通过**；新测试 12（分页纯函数）+ 11（MCP 端到端）+ 4（预览）+ 1（向量计数）
- **RED 证据**：分页用朴素桩实现跑出 6 failed 后才写实现；注解/分页/dryRun 的 MCP 端到端 8 failed → 实现后 11 passed
- **变异自证**：`countByDocumentId` 改为恒 0 → 测试变红（1 failed）；`resolveLatestVersions` 改按行 id → 测试变红（1 failed）
- **顺带修复既有验证腐化**（均以 HEAD worktree 版本对照证明是存量、非本波次引入）：
  - `api/lib/document-removal.test.ts`：手写 DDL 缺 `deletedAt`（dd7eef6 软删除字段）→ 3 例失败，已补齐
  - `api/mcp-folder-tools.test.ts` / `api/mcp-document-upsert.test.ts`：同类 DDL 腐化 → 共 4 例失败，已补齐
  - `api/mcp-reindex.test.ts` / `api/mcp-client-router.test.ts` / `api/mcp-kb-backup.test.ts`：测试替身仍是 MySQL 口径（`insertId`/`affectedRows`），而生产侧已统一 better-sqlite3（`lastInsertRowid`/`changes`）→ 断言拿到 NaN/null 而失败，共 4 例；已把替身改为 SQLite 口径（反查确认生产代码无残留 MySQL 口径，故非生产缺陷）

### wave4 P0-4 长任务统一句柄（t13）— 2026-09-19
**目标**：`backup_trigger` 不再让调用方干等——立即返回 `taskId`；新增 `task_get` / `task_cancel`；重建索引并入同一句柄。

**交付**
- 新增 `api/lib/task-registry.ts`：进程内句柄注册表（`createTask/getTask/listTasks/updateTaskProgress/finishTask/requestCancel/isCancelRequested`）
  - 取消是**两段式**：`requestCancel` 只置位并返回 accepted，执行方在安全点收手后 `finishTask(id,"cancelled")` 才确认——绝不出现「报了取消成功、实际还在跑」
  - 终态不可改写（幂等）；进度夹到 0..100；返回副本（外部改不到内部）
  - 容量上限 `MAX_TASKS=200`：**只淘汰终态**，运行中句柄永不淘汰（淘汰运行中句柄 = 调用方失去轮询/取消能力）
- `api/lib/backup-scheduler.ts`：`runDueBackupSchedules({scheduleId})` 返回 `BackupRunHandle[]`；每次运行注册 `kind:"backup"` 任务并把 `shouldCancel` 注入执行器；终态以 `backup_jobs` 行为准
- `api/backup-repositories/execution.ts`：`executeBackup(jobId, cfg, {shouldCancel})` → 上传循环在**文件之间**检查取消点，命中则停止并把运行标为 `cancelled`（不是 failed，不写 error）
- `api/lib/document-indexer.ts`：`startReindexAll(taskId)` → 循环在**文档之间**检查取消点，每篇回写进度到句柄，终态 `cancelled`/`failed`/`completed` 收口
- `api/mcp-server.ts`：`task_get`（只读注解）、`task_cancel`（非破坏、幂等注解）两工具 + `backup_trigger` 返回句柄 + `kb.reindex_all` 返回句柄；`syncTaskFromSource` 统一「句柄 ← 业务真相」映射
- `db/schema.ts`：`backup_jobs.status` 枚举新增 `cancelled`（TEXT 列，纯 TS 约束，无需 SQL 迁移）

**TDD 证据**
- 注册表：先落**故意朴素**的桩实现（固定 id / 无夹取 / 终态可改写 / 无淘汰 / 取消恒 false），`api/lib/task-registry.test.ts` **9 failed | 4 passed** → 真实现后 15/15
- MCP 层：`api/mcp-tasks.test.ts` 先写 9 例 → 全红（工具不存在）→ 实现后 9/9；其中「以业务表为真相」用可控执行器替身（默认挂起）分别验证 running/failed/completed 同步
- 备份取消：`api/lib/backup-cancel.test.ts` 用真实执行链路 + 注入假仓库（4 个文件）：对照（无信号）4/4 上传 completed；取消（第 1 个文件后置位）只上传 1 个且状态 `cancelled`、error 为 null
- 回填取消：`api/lib/reindex-cancel.test.ts` 对照 3/3 篇 completed；启动前取消 → done 停在 0、状态 `cancelled`
- **变异自证**（两处取消点都验过）：禁用上传循环取消点 → `expected 4 to be 1` 变红；禁用回填循环取消点 → `expected 3 to be +0` 变红；均已复原
- **门禁抓错（真实收益）**：`npm run check` 首次 exit 2，抓出 `backup_jobs.status` 枚举缺 `cancelled`、`progress` 可为 null 未兜底、假仓库缺 `listFiles` 等问题 → 修完 exit 0
- 批次回归：9 文件 **65/65** 通过

**审查后续修（天演审 498396c 后，见下一节）**
- 幂等入口孤儿句柄：回填在跑时再调 `kb.reindex_all` 曾会新造一个无人轮询的句柄（其取消 accepted 却无效）→ 改为**复用/认领**正在跑的句柄（`getActiveReindexTaskId`），循环每轮读模块态句柄，UI 起的回填也能被后到的 MCP 句柄认领后取消。新增 3 例测试（MCP 层 2 例断言「不产生第二个句柄」+ 索引器 1 例断言认领后可取消），并做变异自证（退回旧实现 → 变红）
- 取消收尾不再回写 `progress`：原来会把运行开始时读到的旧 `job.progress` 覆盖上传循环已推进的进度
- 前端补 `cancelled` 徽标（「已取消」，避免新状态落到灰色英文兜底）
- 文档口径纠偏：句柄不跨重启 vs「以业务真相为准」的作用域；`backup_list` 的 `status` 过滤补 `cancelled`；`backup_trigger` 只认调度行；保留策略纳入 cancelled
- **Q2/Q7 终态判定单点化**：新增 `api/lib/task-sync.ts`（纯函数 + 可辨识联合 + 重载）
  - `decideReindexOutcome`：取消优先 → running → **进度丢失（本进程无运行痕迹）判 failed 而非 completed（原来会谎报成功）** → 有失败即 failed（**不再附加 lastError 条件**，这是「同一事实两个终态」的根因）→ completed
  - `decideBackupOutcome(row, {settled})`：`settled` 区分「执行方已收手」（pending/running=异常→failed）与「读时收口」（=还在跑）；meta 计数统一 `?? 0` 兜底
  - 执行方（调度器 `.then`、索引器 `finally`）与读时收口（`task_get`/`task_cancel`）共用同一函数；`settled:true`/`running:false` 有重载，编译器保证收口处拿不到 running
  - 归属校验：别的回填在跑时，不拿全局进度给**不属于它**的句柄收口
- **Q8**：`backup_trigger` 改为「读行 → 必须是调度行（有 cron）→ `runDueBackupSchedules({scheduleId, force:true})` 按 id 直取」，不再无条件写 `enabled=true`+`nextRunAt=now`（原来一旦传入运行行，它会变成 due 被 tick 当调度再跑一份）
- **Q10**：取消的部分快照纳入 `keepLastN` retention
- 新增测试：`api/lib/task-sync.test.ts`（10 例纯函数规则）+ `api/mcp-tasks.test.ts`（幂等复用/新建/认领、enabled 不被改、运行行拒绝）；变异自证 3 处（判定规则退回旧口径 → 变红；退回无条件 enable → 变红）；门禁 `npm run check` exit 0

**天演复核 f5b0f37（2026-09-19）：Q1–Q10 → 9 已修 1 部分修，结论「可收」**，遗留 1 残句 + 2 个 LOW 观察项，本次一并收口：
- Q4 残句：`AGENT_API.md` 里「进程重启后句柄依然准确」改为「**同一进程生命周期内**不会永远停在 running；句柄不跨重启，重启后按边界段处理」——旧的错误承诺彻底删除（上次只新增了正确段落，没删旧句）
- N1 抢跑回退只认**在跑**句柄：已终结的旧句柄不再冒充「刚触发」返回 `reused:true`，改为 isError 并报出最近句柄 id/状态（该分支为防御性代码，无测试覆盖，已在报告里声明）
- N2 `reused`/`adopted` 语义如实：`reused` = 本次调用没有新起回填；`adopted` = 把原本没有句柄的运行（控制台发起）纳入句柄管理。`adopted` 的联合语义此前会让人误以为「认领也返回 reused:true」
- 复核测试证据：门禁 exit 0；6 文件 48/48；变异 3 组全红（进度丢失改判 completed / 退回无条件 createTask / force 退回 due 过滤 5 例全红）；工作区逐字节复原

**设计取舍（记录在案）**
- 句柄存进程内存：**不跨进程重启**——重启后旧句柄查不到（返回 `Task not found`，不假装成功）；「以业务真相为准」的作用域是**同一次进程生命周期内**（避免业务早结束后句柄永远 running 的漂移），重启后的历史看 `backup_list`，回填可幂等重跑
- 取消是协作式的：单次上传/单篇索引会跑完当前单元，不提供强制中断（避免留下半截对象）
- `backup_trigger` 只跑指定的那一个调度（`{scheduleId}` 过滤），保证句柄对得上刚触发的那次运行

### 独立审查（天演，审 ff7fb36 = wave3 P0-3）— 2026-09-18
**总结论：可接受，需先修 1 项**（规格 t10 PASS / t11 一处偏离 / t12 PASS / 测试真实性 PASS；3 组变异全部变红）

| 编号 | 问题 | 处置 |
| --- | --- | --- |
| Q1（major，必修） | `folder_list` 只 `orderBy(sortOrder)`，无 id 兜底；而 sortOrder 默认 0 且 folder_create 不写入 → 全并列 → SQLite 不保证顺序 → offset 分页可漏项/重项（commit 声称的「排序补 id 兜底」在 folder_list 上未落实） | **已修**：抽出具名 `folderListQuery(db)` 并改为 `.orderBy(kbFolders.sortOrder, kbFolders.id)` |
| Q2（minor） | `keywords.extract` / `keywords.autoTag` 标 `openWorldHint:false`，但 mode=llm/auto 会 `fetch` 外部 LLM 端点（keyword-extractor.ts:159；autoTag 走 `extractKeywords(...,"auto")`） | **已修**：两者改 `openWorldHint:true`，文件头写明原因 |
| Q3（minor） | cursor 是无签名 base64url，可伪造合法格式；越界 offset 返回空页而非 isError | **记录不改**：分页安全由服务端定界（取出后切片），空页 + `nextCursor:null` 不会造成重复处理或死循环；若要防篡改需 HMAC，收益不抵复杂度 |
| Q4（minor） | limit 负数被静默夹为 1 | **文档化**：AGENT_API.md 写明夹取语义（保持向后兼容，避免调用方传 500 时突然报错） |
| Q5（nit） | `folderId: doc.folderId ?? null` 看似冗余 | **记录不改**：保留可保证响应恒含 `folderId` 键（`undefined` 会被 JSON.stringify 丢掉，响应形状会随数据变化） |
| Q6（nit） | offset cursor 在翻页期间数据变动会漂移 | **文档化**：AGENT_API.md 已加已知取舍与建议 |
| Q7（nit） | folder_list 翻页测试只造 3 条不同名记录，未覆盖 sort 并列 | **已修**：新增「同 sortOrder 且插入序与 id 序相反」的全页遍历守卫 + ORDER BY 全序断言 |
| Q1 的 RED 复盘 | 先用「真 SQLite + 插入序与 id 序相反」写行为测试，**pre-fix 也是绿的**（GROUP BY 走主键索引，返回恰好是有序的）→ 说明该缺陷在当前数据/查询计划下是**潜伏**的 | 因此改用**可观测真值断言**：断言实际下发 SQL 的 ORDER BY 含两个键。RED 证据：`expected 'order by "kb_folders"."sortOrder"' to match /,/`；修复后 13/13 通过 |

### 独立审查（天演，审 c5306f1 + 41ebcbf）— 2026-09-18
- 阶段一规格符合度 **7/7 PASS**（含块序号透传链路真实性、LIKE 回退诚实留空、测试真实性经变异验证）
- 阶段二 **1 critical + 11 minor**：
  - **C1（critical，我引入）**：`EvalCaseResult` 漏声明 `error?: string`（我上轮批量替换打偏），真实门禁 `tsc -b` 报 4 错；vitest 不查类型故测试照绿 → **已修**
  - **C2（critical，流程）**：`npx tsc --noEmit` 空转（见顶部口径更正）→ 已把门禁改为 `npm run check` 并修到 exit 0
  - 已修 minor：M4（bm25 chunkIndex 缺失不再伪造为 0）· M7（补 `resolveLatestVersions` 6 例直接测试，**变异 M2 实证由「存活」转「杀死」**）· M9（kb.getChunkContext zod 对称 `.int().min(1)`）· M10（版本号 `!= null` 判空）
  - 记录不修：M2/M3（详情页 anchor 状态随路由重置——当前入口单一，风险低）· M5/M6（Unicode/代码围栏标题边界）· M8（全量 select 可优化为双条件+count，119 块无碍）· M1（建议补 totalCases/degraded，非阻塞）
- 顺带修复两处「验证基建失效」：`api/lib/fts-search.test.ts` 因缺环境变量在导入期 `process.exit(1)` → 该文件此前**根本无法运行**（零保护），已补 `vi.hoisted` 环境桩，现 5/5 通过；仓库扫描确认无同类死文件

### 已知存量问题（非本波次引入）
- `api/kb-backup.test.ts > imports valid backup data` / `REST imports with knowledge:write scope`：mock 未实现 drizzle 的 `insert().values()` 链，报 `db.insert(...).values is not a function`；证据：e0d2f5b 与 c5306f1 上均 2 例失败

### 线上实测抓出的两个严重缺陷与修复（t13 收尾，提交 99d8221）— 2026-09-19

**起因**：t13 的线上实测（`/tmp/verify-t7b.py` 的「真实在飞取消回填」）在版本指纹关（`adopted` 字段）就中止，
但**已经把回填留在线上跑**。追查这轮回填，抓出两个都发生在「单测全绿」时的严重缺陷。

**缺陷一（历史，产品级）：全库回填在健康库上「每篇都失败 + 把索引删残」**
- 现象：`done == failed` 同步增长，每篇 `UNIQUE constraint failed: vec_chunk_meta.id`；而 document_chunks 已先被删 → 索引残缺
- 根因：① `SqliteVecEngine.insertBatch` 的 `vec_chunk_meta.id` 是 `TEXT NOT NULL UNIQUE`，插入语句却只有 `ON CONFLICT(rowid) DO UPDATE`（重复 id 以新 rowid 撞 id 唯一索引）；② `indexDocumentById` 删了 chunks 却没删旧向量就 insertBatch
- 为什么以前没暴露：上次单篇 `reindexDocument(1922)` 成功，是因为那篇的向量在前一次事故里已被清空（没有旧行可撞）——**「修过一次成功」不等于路径正确**
- 修复：insertBatch 按 id 先清旧行（vec + meta，同事务）再插；`indexDocumentById` 在 insertBatch 前 `deleteByDocumentId`
- RED 证据：`vector-engine.test.ts` 新增「同 id 重复插入不报错」——**修前精准复现线上同一错误**（`UNIQUE constraint failed: vec_chunk_meta.id`）
- 二次保护：`reindex-cancel.test.ts` 新增「每篇文档先删后插」顺序断言（`invocationCallOrder`）

**缺陷二（本波次自己引入）：把「取消请求」当成「已取消」→ 谎报**
- 现象：`task_cancel` 返回 `accepted:true` 后句柄立刻 `cancelled`，而索引循环还在跑（done 4→30 持续增长）
- 根因：读时收口把 `isCancelRequested()`（请求）当既成事实传给判定函数，规则①立即判 cancelled
- 修复：判定函数区分 `cancelled`（执行方确认）/ `cancelRequested`（仅请求）；读时收口只传后者，运行中一律 running
- 顺带堵住两个同族谎报：①「运行已停 + 没跑完 + 无取消请求」原判 completed/100 → 改判 failed（提前结束）；② completed 判据改为 `done >= total`
- RED 证据：`task-sync.test.ts` 5 例，`expected 'completed' to be 'cancelled'` / `expected 'completed' to be 'failed'`

**线上事故面与修复（已复原，逐篇终审为证）**
- 事故面：回填循环处理到 30 篇时被换版重启杀掉；损伤经逐篇 dryRun 盘点为 **1 篇分块丢失（id=138：chunks 0 / vectors 130 孤儿）**，另发现 1 篇历史不自洽（id=1885：chunks 178 / vectors 124，为 insertBatch 维度静默跳过所致），7 篇日报未索引
- 修复：`reindexDocument` 逐篇修复（138 → 130/130、1885 → 178/178、7 篇日报成功）→ **逐篇终审 1524 篇：chunks/vectors 不一致 0 篇、未置 vectorized 0 篇，全库 chunks == vectors == 43375**
- 注：回填失败文档不会置 `metadata.vectorized=true` 的推断**不成立**（旧标记会被保留），故清零式修复只能靠 `dryRun` 逐篇对账——已记录

**t13 线上终验（两次，完全一致）**
- `kb.reindex_all` → 句柄含 `adopted` 字段（de86aa9+ 指纹）→ 运行中触发 `task_cancel` → `accepted:true`，**立刻再查 `task_get` 仍是 `running` + `cancelRequested:true`（未谎报）** → 循环 **2s 内真停**（`kb.reindex_status.running=false`）→ 终态 `cancelled`（done=1/1524、failed=0、chunksTotal=107，非 completed）→ 再取消 `accepted:false` + reason
- 索引自洽复查：chunks == vectors == 43375

**为何以前没抓到「取消不停」**：该现象在换版窗口只出现一次、之后两次实测均按时停止，**未能复现**，如实记录为未解观察（当时正处新旧容器并存窗口）；能确证的机制是上面缺陷二的读时谎报。

### 独立审查（天演，审 99d8221）与跟进（提交 6e29eee）— 2026-09-19
**总结论：可收**（两个修复真实存在；`npm run check` exit 0；4 文件 39/39 两次确认；5 组变异中 3 组被精准抓红）。
天演同时点出 **3 项必跟进** + 1 项 DEVIATION，全部闭环，且每条新测试都自己做了变异验证：

| 编号 | 问题（严重度） | 处置与证据 |
| --- | --- | --- |
| R1 | 读时收口接线（`cancelRequested`）**无判别力测试**（变异 M4 在 4 文件全绿下存活）— HIGH | **已补测**：`mcp-tasks` 新增「取消请求已记录但任务仍在跑：再查句柄必须仍是 running」；**变异 M-A（读侧改回 cancelled）实测变红** |
| R2 | `vector-engine` 新测试断言 vacuous（v1/v2 为平行向量，cosine 无差别；M5 变异存活）— MEDIUM | **已重写**：改用两两正交向量 + 直接数 `vec_chunks`/`vec_chunk_meta` 行数；**变异 M-B（漏删 vec 行）实测变红** |
| R3 | `indexDocumentById` 先清旧向量再 embed → embed 抛错时文档同时失去 chunks 与向量 — MEDIUM | **已改序**：删除挪到 `embedTextsWithFallback` 成功之后；新增「embed 失败不动旧向量」用例；**变异 M-C（挪回 embed 之前）实测变红** |
| R4 | 判定规则不对称（读侧 failed 先于 cancel、执行方 cancel 优先）→ 残余「同事实两终态」窗口 — DEVIATION(minor) | **已对称化**：`done<total && cancelRequested → cancelled` 提到 `failed>0` 之前；新增用例 + **变异 M-D 实测变红** |
| R5 | 降级引擎（sqlite-vec 不可用）insertBatch 不幂等 — MEDIUM/LOW | **已修**：同 id 先丢旧行；新增用例 + **变异 M-E 实测变红** |
| R6 | `findMetaByld` typo；规则③注释与实现不符 — LOW | **已修**：改名 `findMetaById`；注释写明「需全零才触发，句柄不属本进程的 run 时如实透出对方数字」 |

- 真实门禁再次体现价值：`MemoryVectorEngine(dim)` 构造器实际 0 参 → **vitest 全绿而 `tsc -b` 报 TS2554**，已修
- 门禁 exit 0；批次 8 文件 79/79；`vite build` 成功；变异全部字节级还原（diff 逐文件校验一致）
- 天演未验证项（如实记录）：insertBatch 真实并发竞态（better-sqlite3 单连接同步模型，理论无抢占，未做压测）

### 6e29eee 线上终验 — 2026-09-19
- `kb.reindex_all` → 句柄含 `adopted`（版本指纹）；本轮**真索引成功**：`done=3、failed=0`（修复前是 `done == failed` 全篇失败）
- 取消链路：`task_cancel` → `accepted:true`，**立刻再查仍是 `running` + `cancelRequested:true`（未谎报）** → 循环 **2s 内停** → 终态 `cancelled`（done=4/1525、failed=0、chunksTotal=314，即真的嵌入并写入了 314 块）→ 再取消 `accepted:false`+reason
- **幂等实证**：4 篇重索引写入 314 块后，全库 `chunks == vectors == 43479`、文档 1525 篇，计数一字不变（旧行被正确替换而非堆积）

## 全库重建与 FTS 清理：执行记录（2026-09-21 → 09-22）

### 结论：三项归零 + 全库零不一致
以**每日巡检报告**（工作流自动存档的硬数据）对比，比任何自述都可信：

| 巡检项 | 09-19 | 09-20（重建前） | 09-22（重建后） |
| --- | --- | --- | --- |
| 旧向量未记模型身份 | 25230 | 24782 | **0** |
| 缺 BM25 索引 | 929 | 5423 | **0** |
| FTS 孤儿 | 25003 | 28950 | **0** |
| 缺语义向量 | 54 | 0 | **0** |
| 有内容但未索引文档 | 6 | 1 | 6 → 补齐后 **0** |
| 图谱孤儿 | 1 | 1 | 1（未处理，独立小项） |

- 全库逐篇终审（1555 篇 `document_delete` dryRun 对账）：**chunks/vectors 不一致 0 篇、零分块 0 篇、未置 vectorized 0 篇**
- 全局计数一致：`chunks == vectors == ftsRows == 45028`
- 评测复跑：keyword 1/1、hybrid 1/1、hybrid+rerank 1/1、vector recall@5=0.3 / MRR 0.233（重建前 0.153 → 有提升，但纯向量召回仍偏低，列为 P1：用检索测试台查是否查询/文档嵌入模板不一致，或用例偏关键词）

### FTS 孤儿根因与修复（提交 743f7ca）
`ensureFts()` 的回填判据是 `ftsCount < chunkCount`，而**孤儿把 ftsCount 抬到高于 chunkCount → 判据恒假 → 缺行永不回填**；
孤儿本身也清不掉（`deleteDocumentFromFts` 靠 `rowid IN (SELECT id ...)` 定位，已删 chunk 的 id 不在表里）。
修复：判据改为「存在缺失行」的存在性检查；新增 `pruneFtsOrphans({dryRun})` + 管理员接口 `kb.pruneFtsOrphans`。
线上执行：dryRun 报 28950 → 真删 28950 → 复检 0。

### 重建过程实测抓出的两个新缺陷（提交 f6c0400）
1. **hash 兜底不留身份**：候选嵌入配置全部失败时 `simpleTextHash` 兜底写伪向量且**不更新模型身份** ——
   回填前段 2 分钟「成功」了 550+ 篇、`failed=0`，实则语义质量归零，任何状态码都不报错。
   修复：导出 `HASH_FALLBACK_MODEL`，兜底写入时显式标注 → 巡检的模型漂移检查可直接点名兜底产物。
2. **工作流 `save-result` 不走索引**：直接插库 → 每天新增 2 篇「有内容但未索引」报告文档，**巡检为此天天自报红**。
   修复：落盘后调 `indexDocumentById`；索引失败不阻断工作流但返回 `indexed:false + indexError`，不假装成功。
   上线指纹：跑一次「每日索引巡检」工作流 → 新报告 #2212 落盘即 `chunks=1/vectors=1`（改前恒为 0）✅

### 事故与教训
- **我自己造成的一次**：重建跑到 1149/1542（75%）时，我为上线 FTS 修复执行了 push → 自动部署换容器 →
  进程内存里的回填与句柄一起消失，只能整跑重来。**铁律：长任务在飞时禁止 push；push 前先查在飞长任务。**
  （本项目句柄不跨重启，是已文档化的边界——但意味着「部署」就是长任务的硬杀手。）
- **平台侧的一次（非代码问题）**：f6c0400 部署后服务 502 约 45 分钟。运行时日志显示 Pod 反复
  `ErrImagePull` / `ImagePullBackOff` / `DeadlineExceeded`（对 `registry-oci.zeabur.cloud` 连接被重置），
  直到 13:52:35 才拉取成功（1m39s / 564MB）→ Pod 起、服务恢复。旧 Pod 已被替换，故窗口期一直回源失败。
  **判据**：`npx zeabur@latest deployment list --service-id <id> -i=false` 看 STATUS/COMMITSHA，
  `deployment log -t runtime` 看 Pod 事件。

### 嵌入服务吞吐实测（供后续估时）
批量 64 条 = 24.6s → **2.6 条/s**；批量 8 条 0.29s/条；单条 1.06s。全库 4.5 万块 ≈ 4-5 小时（实测跨夜跑完）。

## P1 收口：图谱孤儿根因 + 向量召回低归因（2026-09-22，提交 3da1eed / 45c9546）

### 一、graph_orphans 的**真根因**：两条删除路径漏清图谱
巡检一直报 `graph_orphans: 1`（文档节点指向已删文档）。线上定位到具体行：
`knowledge_nodes.id=189`（title「[薇子/测试] 闲置工具探测-0908」，`metadata.documentId=1855`，文档 1855 已不存在），
并有 10 条 `tag` 边指向它（`autoTagDocument` 打标时建的 tag 节点 → 文档节点；与历史 orphan 形状一致）。

根因不是巡检误报，而是**删除路径不统一**：
- MCP `document_delete` → `deleteDocumentCascade`：chunks → FTS → 图谱边 → 图谱节点 → 文档行，全清 ✅
- 控制台 tRPC `kb.purgeDocument`（彻底删除）与 `kb.deleteFolder`（文件夹删除）→
  只调 `deleteDocumentVectors`（清缓存 + FTS + chunks + 向量）**独漏 `knowledge_nodes` / `knowledge_edges`** ✗
  → 每次这类删除都留孤儿；这也是历史 FTS 孤儿那一族问题的同源产物。

修复（提交 3da1eed）：
1. `kb.purgeDocument` 改走 `deleteDocumentCascade`，删除计数如实回传；
2. `kb.deleteFolder` 改走新增的 `purgeDocumentsCascade`（逐篇级联、汇总计数、**单篇失败不中断其余**、
   失败明细放 `purgeFailed`，`success: purgeFailed.length === 0` —— 不假装全清干净）；
3. 新增 `api/lib/graph-maintenance.ts`：`pruneGraphOrphans({dryRun})` 清存量孤儿节点及其牵连边，
   判据与巡检**严格同源**；`documentId` 为空的 document 节点不算孤儿（`NULL NOT IN (...)` 非真，巡检也不计；
   线上这类节点有 102 个，误删会伤及历史数据）；
4. 新增管理员入口 `kb.pruneGraphOrphans({dryRun})`（真删写审计；巡检只报不改，这是显式维护动作）；
5. 搜索缓存失效收进级联（此前只有 kb-router 两处入口手动调，MCP 删除路径会在 60s 内返回已删文档）。

线上验收（3da1eed RUNNING 后）：
`kb.pruneGraphOrphans {dryRun:true}` → `{orphans:1, edges:10}` → 真删 `{prunedNodes:1, prunedEdges:10}` → 复检 `0` ✅

### 二、意外抓到的**线上真故障**：`FOREIGN KEY constraint failed`（提交 45c9546）
3da1eed 上线后，用**自建探针文档**（#2220，建后经 `auto-tag` 造出 1 个文档节点 + 10 条边）跑删除验收，
`kb.purgeDocument` 直接 500：`{"message":"FOREIGN KEY constraint failed"}`。

查线上真库 `PRAGMA foreign_key_list`：指向 `kb_documents` 的外键**共 3 条**——
`document_chunks` ✅（级联已清）、**`kb_document_versions`** ❌、**`kb_ingestion_keys`** ❌。
凡是**有版本历史**的文档（更新过 / 打标过 / 工作流改过）就删不掉；MCP `document_delete` 与本次改的
purgeDocument/deleteFolder 共用同一级联实现，**全都受影响**（属于此前未被发现的存量缺陷）。

修复：级联事务内、删文档行**之前**补清两张子表，`DocumentRemovalResult` / `PurgeManyResult` 增加
`deletedVersions` / `deletedIngestionKeys` 计数（不静默吞掉）。

**为什么单测没抓到**：手写 DDL 没有外键、连接也没开 `foreign_keys` → FK 违反在单测里完全不可见。
已把**线上真实的三条外键**写进单测 DDL 并 `PRAGMA foreign_keys = ON`：新的回归用例现在能
**精确复现线上的 `FOREIGN KEY constraint failed`**（变异自检 M-fk 变红 ✅）。

### 三、向量 recall 0.3 归因：**不是检索坏了，是用例集的可分性上限**
逐条复跑 10 条评测用例（limit=50，看期望文档排第几）：

| 查询（即标题） | 期望文档 | 向量模式命中名次 |
|---|---|---|
| [科目/不动产] 完整错题库解析 (第4部分/共5部分) | #135 | 9 |
| [科目/不动产] GroupF_郑州多选与操作规范 (第1部分/共2部分) | #143 | 1 |
| [科目/不动产] 试题题库-汇总5.20 (第2部分/共4部分) | #140 | **50 名内都没有** |
| [科目/不动产] 试题题库-汇总5.20 (第3部分/共4部分) | #141 | 15 |
| 知识库产品对标调研（149 条官方来源） | #1923 | 1 |
| [openclaw][nvwa] 记忆增量 2026-09-18 14:32Z | #1935 | 7 |
| [openclaw][main] 记忆增量 2026-09-18 14:32Z | #1931 | 16 |
| [科目/不动产] 完整错题库解析 (第1/2/3部分) | #132/#133/#134 | 2 / 17 / 6 |

**10 条里 9 条是「同族兄弟文档 + 查询就是标题」**：向量空间天然分不开「第4部分」与「第1部分」
（内容同构、标题只差一个数字），这不是检索链路缺陷，而是用例本身的可分性上限。

**反证**（决定性）：改用**唯一内容**当查询——取文档正文中段 40~70 字原句检索，
向量 top5 命中源文档 **9/12**（未命中的 3 条又是同族近重复的「作业教训」兄弟文档）
→ **嵌入管线健康**（若查询/文档嵌入模板不一致，连"原文回查原文"都会失败）。

### 四、测试台加「同族兄弟」失败归因（同提交 45c9546）
不改 recall/MRR 口径（兄弟命中**不算**命中），只让报告自己解释指标：
- `normalizeDocTitle()`：剥 `[前缀]` 与 `（第N部分/共M部分）` 等分册标记后归一
- `classifyMissReason()`：`none` / `sibling`（命中同族兄弟）/ `other`；保守原则——期望标题缺失或归一不等一律 `other`，宁可漏判不可错判
- `EvalCaseResult.missReason` + `EvalMetrics.siblingConfusionCount`
- UI `src/pages/SearchTestbed.tsx`：新增「同族兄弟混淆」指标卡 + 逐条蓝色标注「同族兄弟（近重复，可分性上限）」

判读规则（写给后来者）：**向量 recall 低 + siblingConfusionCount 高 → 用例近重复，换用例；
siblingConfusionCount = 0 还低 → 才需要查嵌入模板 / 链路。**

### 五、测试与自检
新增/改动测试：`api/kb-router.test.ts`（新，**锁路由层接线**——纯 lib 测试覆盖不到）、
`api/lib/graph-maintenance.test.ts`（新）、`api/lib/document-removal.test.ts`（+`purgeDocumentsCascade`、+FK 回归）、
`api/lib/search-eval.test.ts`（+归因纯函数与 runEval 端到端）、`api/mcp-document-delete.test.ts`（计数对齐）。

变异自检（每组都确认源码字节级还原）：
| 变异 | 结果 |
|---|---|
| M-r1 purgeDocument 退回旧实现（漏图谱） | 路由测试变红 ✅ |
| M-r2 deleteFolder 退回旧实现 | 路由测试变红 ✅ |
| M-r3 孤儿清理只删 source 端边 | 图谱测试变红 ✅ |
| M-r4 批量删除遇错即中断 | 变红 ✅ |
| M-fk 不清子表（复现线上 500） | `FOREIGN KEY constraint failed` 复现并变红 ✅ |
| M-s1 runEval 不写归因 | 端到端归因测试变红 ✅ |

门禁：`npm run check` exit 0（真实门禁本轮又抓出两处：测试 DDL 缺 `icon`/`entityType` 列、
`knowledge_edges` 多了 schema 不存在的 `updatedAt` 列、mock 结果缺新字段——vitest 全都无感而 tsc 报错）；
5 文件 42/42；`vite build` 成功。

### 六、本轮新踩的坑（供后来者）
1. **手写 DDL 不带外键 = 测试盲区**：FK 违反类 bug 在单测里完全看不见，线上才炸。凡是"删父表"的改动，
   测试 DDL 必须带真实外键并 `PRAGMA foreign_keys = ON`。
2. **真实门禁与单测的差距**：`tsc -b` 抓出了 vitest 抓不到的列名/类型漂移（本轮 3 次）。改完必跑真门禁。
3. **部署状态可用"行为指纹"判断**：新接口出现/旧接口消失即换版完成；
   本轮用「探针文档删除从 500 变成功」当指纹（旧版本必然 500，新版本成功）——比翻 CLI 状态更直接。
4. **tRPC 方法语义**：mutation 用 GET 会得到 **405**（过程已存在）而非 404（过程不存在）——
   这两个码正好可以用来判断"新版本是否已上线"。

### 七、二轮审查（天演 ×2：规格符合度 + 代码质量）与处置 — 2026-09-22
对 `f2bca2e..95b96e8` 做了两阶段独立审查（先规格符合度、再代码质量），共 3 个 high + 8 个 medium/low，**全部处置并复核通过**。
最有价值的两个发现都不是我主动找的，而是"线上探针 + 审查"逼出来的：

#### 7.1 孤儿真根因是**判据类型**，不只是"路径漏调级联"（提交 a8168c0）
第一次修复（3da1eed）让 purge/deleteFolder 都走级联后，我用**自建探针文档**验收：
purge 返回 `deletedNodes: 0`，删完立刻 `graphOrphans: 1` —— **删除自己刚造出一个孤儿**。
根因：图谱节点 `metadata.documentId` 的**写入类型不统一**——
`ingestion.ts`/`workflow-runtime.ts`/`kb-router.ts` 写 `String(id)`（字符串），
`keyword-auto-tag.ts`（autoTagDocument）写 `doc.id`（**数字**）；
而所有匹配点都用字符串等值比较 `json_extract(...) = String(id)`（SQLite 数值与文本永不相等）✗。
后果：数字型节点删除时漏删（留孤儿）、auto-tag 去重时找不到自己建的节点（**重复建节点**）；
巡检 `index-health` 用 `CAST(... AS INTEGER)` 所以看得见，删除侧却看不见 —— 于是"巡检天天报红、代码看着没毛病"。
历史孤儿 `node 189`（`{"documentId":1855}` 数字）正是这条链的产物。
修复：新增 `api/lib/document-node-match.ts`，判据收口为一处
`CAST(json_extract(metadata,'$.documentId') AS INTEGER) = id`（与巡检同源），
替换删除级联、dryRun 预览、kb-router、workflow-runtime、relation-analyzer、auto-tag 去重共 5 处。
**线上终验**：探针 purge → `deletedNodes: 1, deletedEdges: 14`，删后 docs/chunks/versions 全 0、孤儿 0 ✅

#### 7.2 我这轮改动自己引入的缺陷：deleteFolder 失败路径 FK 500（提交 95b96e8，审查预言 + 测试复现）
`kb_documents.folderId → kb_folders(id)` 有外键。"某篇 purge 失败 → 文档行还在 → 无条件删文件夹" → 
`FOREIGN KEY constraint failed`，而且**连"如实汇报失败"的机会都没有**（500 把诚实结果吞了）。
测试 DDL 此前**没建** `folderId` 外键（正是藏住它的盲区）→ 补上后立刻复现。
修复：只要有一篇没清掉就**一篇文件夹都不删**（`foldersPreserved: true` + `removedFolderCount: 0` + `purgeFailed` 明细）。
二轮复核又指出残留边界：深层子文件夹失败时若只删"看着是空的"祖先，会撞
`kb_folders.parentId → kb_folders(id)` 外键 —— 已用变异自检确认（退回部分删除 → `FOREIGN KEY constraint failed` 红），
收紧为"有失败则全保留"后转绿。前端 `KnowledgeBase.tsx` 同步消费 `purgeFailed`（不再假弹「已删除」）。

#### 7.3 其余处置（medium/low，全部落地）
缓存失效改为**事务提交后再失效一次**（删除前的失效挡不住提交前的并发搜索写回旧结果）；
`runEval` 取期望标题的辅助查询加 try/catch 降级（失败 → `missReason` 全 other，recall/MRR 一字不动，不让辅助查询毁掉整份报告）；
`normalizeDocTitle` 收窄为**只剥开头连续 `[前缀]`**（审查反例：`每日晨报 [2026-09-01]` vs `[2026-09-02]` 是不同日期的独立文档，不得判成同族）；
测试补 `vi.hoisted` env 消除并行 flake；两套手写 DDL 对齐（补 `knowledge_edges` 双外键、`kb_folders.parentId` 自引用、调建表顺序）；
UI 对缺字段兜底（旧后端响应显示「—」而非误报「无近重复干扰」）。

#### 7.4 证据留档（审查指出"结论无脚本无输出"）
新增 `scripts/vector-recall-attribution.mjs`（两组对照、凭据走环境变量、只读、login 5xx 可重试、灰区输出 inconclusive），
线上跑出的原始报告归档在 `docs/reports/vector-recall-attribution-20260922.json`；
四模式评测报告归档在 `docs/reports/search-eval-modes-20260922.json`。
**线上实测（2026-09-22 16:1x）**：

| 模式 | recall@5 | MRR | siblingConfusionCount |
|---|---|---|---|
| keyword | 1.0 | 1.0 | 0 |
| vector | **0.3** | 0.25 | **3** |
| hybrid | 1.0 | 1.0 | 0 |

→ 向量模式 3 条未命中被归因为"命中了同族兄弟"，其余 4 条为 other（保守口径，不硬拗）；
唯一内容反证 12 条命中 9 条（未命中 3 条仍是近重复兄弟）→ **嵌入管线健康，低指标是用例集可分性上限**。
阈值 0.6/0.6 是启发式的，不是理论值；灰区现在会输出 `inconclusive` 而不是硬下结论。

#### 7.5 本轮新增的已知边界（如实记录，未修）
1. **概念/实体节点的悬挂引用**：`type='concept'|'entity'` 的知识抽取节点也带 `metadata.documentId`，
   源文档删除后会变成悬挂引用（线上实测 10 个，本次已连边清掉自己探针造的）。
   巡检只把 `type='document'` 的算孤儿，所以它不报红 —— 属**有意边界**（这些节点是独立知识产物）。
2. **726 条 hash 兜底向量**：巡检 `mixed_embedding_models` 报
   `qwen3.7-text-embedding-flash×45141 / __hash_fallback__×726` → 巡检 `healthy: false`。
   根因是 f6c0400 那个"兜底不留身份"缺陷造成的存量（语义不可检索）。属下一轮开项：
   需要向量引擎侧（sqlite-vec 扩展）按模型列出文档 id 后逐篇 `kb.reindexDocument`，本次未做（判据不在本次范围）。

#### 7.6 复核结论
- 规格符合度二轮：H-1（线上孤儿）修好 ✅、H-2（deleteFolder 失败路径）修好 ✅、判据收口全覆盖 ✅、
  归因结论**独立复刻**（A 组 top5 命中 3/10、B 组 9/12，与我报告逐字一致）✅
- 代码质量二轮：8 条处置全部"修好"，新增 N1/N2/G1~G3 均已处置；总评**可合并**
- 复核提出的新问题（脚本 502 无重试、祖先外键残留边界、MCP 层缺数字形态回归）已在本轮全部修掉

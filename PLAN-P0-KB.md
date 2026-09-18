# 璇玑知识库 P0 实施计划（依据 docs/reports/xuanji-knowledge-base-analysis-and-roadmap.md）

> 纪律：每任务先写失败测试（RED）→ 最小实现（GREEN）→ 重构；`npx tsc --noEmit` 干净；本容器只跑**单文件** vitest（禁止全量套件）；完成后走部署 + 线上验证 + 独立审查。
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
- **verify**: `npx vitest run api/lib/search-eval.test.ts` 全绿（含空集/全命中/部分命中的 recall、MRR 手算断言）；`npx tsc --noEmit` 无错误。

## t2 评测路由 + 问答重排策略化（后端）

- **goal**: tRPC 暴露评测 CRUD 与 run；ask-rag 的 rerank 不再硬编码。
- **files**:
  - `api/search-eval-router.ts`（新；在 `api/router.ts` 照 `reviewRouter` 的注册方式注册为 `searchEval`）
  - `api/lib/ask-rag.ts`（检索参数策略化）
  - `api/ask-rag.test.ts`（新，先写失败；mock `./hybrid-search` 与 `./llm-chat`，mock 模式参考 `api/lib/backup-scheduler.test.ts`）
- **change**:
  - 路由：`listCases: authedQuery`；`createCase/deleteCase: adminQuery`（zod：`query: z.string().min(1)`、`expectedDocIds: z.array(z.number().int()).min(1)`、`note: z.string().optional()`）；`runEval: adminQuery`（`{ mode: z.enum(["keyword","vector","hybrid"]).default("hybrid"), rerank: z.boolean().default(false), topK: z.number().int().min(1).max(20).default(5) }`）调 `runEval` 返回逐条结果与汇总。
  - `ask-rag.ts`: 新增 `export async function resolveAskRetrievalOptions(): Promise<{ mode: "hybrid"; limit: number; rerank: boolean }>`——读 `systemSettings.key = "ask_retrieval_rerank"`（"true"/"false"，缺省与异常兜底 false；读法照 `api/lib/egress.ts:107-111`）；`askKnowledgeBase` 用它替换 `api/lib/ask-rag.ts:43` 的硬编码，并新增可选参数 `retrievalOverride?: Partial<{ limit: number; rerank: boolean }>`（调用方/测试可显式控制，优先级最高）。
- **verify**: `npx vitest run api/ask-rag.test.ts` 全绿（断言：设置 "true" 时传给 executeHybridSearch 的 rerank=true；无设置 false；override 覆盖一切）；`npx tsc --noEmit` 干净。

## t3 检索测试台前端

- **goal**: 一页看清每次检索的命中、分数分解与耗时；可固化为评测用例、跑评测集看指标。
- **files**: `src/pages/SearchTestbed.tsx`（新）、`src/App.tsx`（注册 `/search-testbed`）、`src/components/TopNavbar.tsx`（导航入口「测试台」）。
- **change**:
  - 控件：query、mode（keyword/vector/hybrid）、rerank 开关、topK 1-20；调既有搜索端点（调用方式照 `src/pages/SearchResults.tsx`）；结果表列：title / score / scoreBreakdown 四列（kw·vec·rrf·rerank）/ sources / reasons / evidence 片段数；顶部 metadata（durationMs、keywordResults、vectorResults、cached、total）与 facets 计数。
  - 「存为评测用例」：勾选结果中文档 → `searchEval.createCase`；用例列表可删。
  - 「跑评测集」：`searchEval.runEval`（当前 mode/rerank/topK）→ meanRecallAtK、MRR、逐条 recall/首个命中排名。
  - 样式沿用 `SearchResults.tsx` 的 Tailwind + CSS 变量（`var(--text-primary)` 等）。
- **verify**: `npx vite build` 成功且 `ls dist/public/assets | grep -i testbed` 有产物；`npx tsc --noEmit` 干净；部署后线上 `/search-testbed` 完成一次检索并显示分数分解。

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
- `npx tsc --noEmit` exit 0；`npx vite build` exit 0（10.91s）
- 迁移：`db/migrations/0007_rapid_sir_ram.sql`（kb_eval_cases 表 + query 索引，boot 自动执行）
- 交付物：`api/lib/search-eval.ts`、`api/lib/search-eval.test.ts`、`api/search-eval-router.ts`（router.ts 已注册 searchEval）、`api/ask-rag.test.ts`；`SearchResult.scoreBreakdown{keyword,vector,rrf,llmRerank}`、`MergedHit.llmScore`、`ask-rag.resolveAskRetrievalOptions()`（设置 ask_retrieval_rerank 驱动，替换 :43 硬编码）+ `retrievalOverride` 参数

### wave1 前端（t3）— 2026-09-18，碧霄亲自实施
- 交付物：`src/pages/SearchTestbed.tsx`（检索控件 mode/rerank/topK + metadata 条 + 分数分解四列表 + 评测用例管理 + 评测报告三指标卡）；App.tsx 注册 `/search-testbed`（lazy chunk）；CommandPalette 加「检索测试台」入口
- 验证：`npx tsc --noEmit` exit 0；`npx vite build` exit 0，产物 `dist/public/assets/SearchTestbed-BE2tM8bL.js`（16.95 kB / gzip 4.36 kB）

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
- 验证：`npx tsc --noEmit` exit 0；`npx vite build` exit 0；回归 5 文件 **61/61 通过**

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

### 已知存量问题（非本波次引入）
- `api/kb-backup.test.ts > imports valid backup data` / `REST imports with knowledge:write scope`：mock 未实现 drizzle 的 `insert().values()` 链，报 `db.insert(...).values is not a function`；证据：e0d2f5b 与 c5306f1 上均 2 例失败

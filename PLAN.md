# xuanji11 审查修复实施计划（Round 1）

> 基线：main@842adf0，工作副本 `/data/dsh/璇玑/xuanji11-review`。
> 依据：《xuanji11-审查总报告.md》《xuanji11-安全架构评审报告.md》。
> 纪律：每任务先写失败测试（RED）→ 最小实现（GREEN）→ `npx tsc -b` 通过；禁止本容器跑全量 vitest（AGENTS.md 规矩），只跑任务相关单测文件。
> 文件所有权互斥，组内并行安全。

## 组 1（四路并行）

### t2-ssrf-guard
- goal: 所有服务端 fetch 用户可控 URL 前强制内网地址过滤，消除 SSRF。
- files: 新建 `api/lib/egress.ts` + `api/lib/egress.test.ts`；修改 `api/connectors/alist.ts`、`api/connectors/115.ts`、`api/connectors/aliyundrive.ts`、`api/connectors/nas.ts`（凡 fetch 用户 config URL 处）、`api/lib/vector-service.ts`(:354 testEmbeddingConfig)、`api/backup-repositories/alist.ts`。
- change: 导出 `assertEgressAllowed(url: string): Promise<void>`——DNS resolve 后拒绝 loopback/RFC1918/link-local(169.254 含 metadata)/IPv6 ULA/0.0.0.0；URL 必须 http(s)；各 fetch 点前置调用，抛错信息不含远端响应体；删除 vector-service.ts:360-368 的 `rawText.slice(0,200)` 回显。
- verify: `cd /data/dsh/璇玑/xuanji11-review && ./node_modules/.bin/vitest run api/lib/egress.test.ts` 全绿（用例：127.0.0.1/10.x/192.168.x/169.254.169.254/::1 拒绝；公网域名放行；非 http 协议拒绝）+ `./node_modules/.bin/tsc -b` 零错误。

### t3-settings-admin
- goal: 敏感设置只许管理员读且秘密值脱敏；误标的写操作提权。
- files: `api/setting-router.ts`、`api/connector-router.ts`、`api/datasource-router.ts`、新建 `api/setting-mask.test.ts`。
- change: ① setting.list/getByKey/listByCategory 改 adminQuery，输出前对 key 匹配 `/password|secret|token|api_key/i` 的值替换为 `"***masked***"`（getByKey 同规则）；② connector.getConfig 提权 adminQuery 且 config.password 掩码；③ datasource.testConnection(:106)/sync(:152)、connector.testConnection(:132) 提权 adminQuery。不动 workflow-router（归 t1）。前端调用方均为 admin 会话（本地认证唯一 admin），UI 不受影响——在 PR 说明中注明。
- verify: `./node_modules/.bin/vitest run api/setting-mask.test.ts` 全绿（掩码规则表驱动用例）+ `./node_modules/.bin/tsc -b`。

### t6-workflow-real
- goal: 工作流桩执行器接真实现或显式 skipped，消灭假绿灯。
- files: `api/lib/workflow-runtime.ts`、`api/lib/workflow-runtime.test.ts`（更新既有断言）、必要时新建 `api/lib/llm-chat.ts`（薄封装天枢/直连 LLM chat，参考 `api/lib/keyword-extractor.ts` 与 `api/lib/tianshu.ts` 的既有模式）。
- change: `vectorize`→调 vector-service 真实 embedding 入库（config 支持 text 或 documentId）；`find-similar`→调 `executeHybridSearch` 返回真实 matches；`summarize`→LLM 总结（无 LLM 配置时返回 skipped）；`keywords`→优先 keyword-extractor LLM 抽取，失败回退现分词并在结果标注 `fallback:true`；`create-link`→真实插入 knowledge 边表（查 `db/schema.ts` 实际表名）并去重；`save-result`→写入目标知识库文档（config.targetFolderId 必填，缺失则 skipped）；`notify-agent/send-notification/file-upload/text-extract/cron/webhook`→返回 `{status:'skipped', reason}`；执行器返回协议增加可选 `skipped?: string`，run node 记录 skipped 时状态记 `skipped`（非 completed），前端 WorkflowBuilder 渲染灰色/黄色标签（最小改动：读 status 直接展示）。
- verify: `./node_modules/.bin/vitest run api/lib/workflow-runtime.test.ts` 全绿（mock LLM/embedding 依赖，断言：vectorize 调用了 embedding 服务、create-link 落库、无配置时 summarize=skipped、skipped 不标记 completed）+ `./node_modules/.bin/tsc -b`。

### t7-settings-frontend
- goal: Settings 半成品 tab 清理成诚实可用。
- files: `src/pages/Settings.tsx`、`src/hooks/useSettings.ts`、`vite.config.ts`（版本注入，可选）。
- change: ① 个人设置表单接 `setting.setMany`（key: profile_nickname/profile_email/profile_timezone/profile_language）+保存按钮+`auth.me`/存量设置回填；② 「更换头像」按钮移除（无后端能力）；③ Agent tab 测试连接改调 `trpc.tianshu.*` 连接测试或按所填 Hub URL 发 HEAD 探活（选 tianshu 既有过程，若无则 fetch `${hubUrl}/health` 5s 超时）；④ 存储饼图：三键全空时隐藏 SVG 区块；有值时按实际数值比例计算 strokeDasharray（替换硬编码 25/15/10）；⑤ 左侧导航移除「工作流默认」项；⑥ 关于页版本号读 `import.meta.env`（vite define `__APP_VERSION__` from package.json），移除写死日期；⑦ 「立即清理缓存」「知识库设置即将上线」占位保留但文案明确标注未实现。
- verify: `./node_modules/.bin/tsc -b` + `./node_modules/.bin/vitest run src/pages/KnowledgeBase.test.tsx src/components/PageLoader.test.tsx`（回归既有前端测试）+ 手动清单写入 PR 描述。

## 组 2（两路并行，依赖组 1 完成后启动以避免 boot.ts 相邻文件竞争）

### t1-boot-hardening（含原 t5）
- goal: CSRF 豁免收紧 + webhook token 鉴权 + CSP/异常/JWT_SECRET 加固。
- files: `api/boot.ts`、`api/local-auth.ts`（导出 isTrustedMutationRequest 供复用）、`api/workflow-router.ts`、`api/lib/workflow-scheduler.ts`、新建 `api/boot-csrf.test.ts`、`api/lib/env.ts`。
- change: ① csrfMiddleware：五个 REST 前缀的非 GET 请求不再直接豁免，改要求 `isTrustedMutationRequest`（X-Requested-With 或 Origin 同源）；MCP/SSE/webhook 维持豁免但 webhook 改 token 鉴权；② webhook：`POST /api/workflows/:id/webhook?token=` 校验 `HMAC-SHA256(jwtSecret,'wf-webhook:'+id)` 前 32 hex，移除会话 cookie 要求；`workflow.webhookUrl`(adminQuery) 返回带 token 完整 URL；③ CSP script-src 去 `'unsafe-inline'`；④ process.on('unhandledRejection'/'uncaughtException') 结构化日志+受控 exit(1)；⑤ env.ts JWT_SECRET 缺省时生成一次并持久化到 `${ZVEC_DATA_DIR}/../.jwt-secret`（目录不存在则创建，0600），重启复用。
- verify: `./node_modules/.bin/vitest run api/boot-csrf.test.ts`（表驱动：豁免前缀+无头 POST→403；带 Origin 同源→pass；webhook 正确/错误 token→200/403）+ `./node_modules/.bin/tsc -b`。

### t4-kb-delete-paging
- goal: 文件夹删除递归清理全部层级；四个 list 加分页上限。
- files: `api/kb-router.ts`、`api/knowledge-router.ts`、`api/file-router.ts`、`api/vector-router.ts`、新建 `api/kb-tree.test.ts`。
- change: ① 把「收集全部子孙文件夹 id」抽成纯函数 `collectDescendantFolderIds(folders, rootId): number[]`（应用层迭代至闭包），deleteFolder 用它一次性清理所有层级的文档向量与记录、再删文件夹；② listDocuments/listNodes/searchNodes/file.list/vector.list 增加可选 `limit`(默认 200, 上限 1000)/`offset` 入参，向后兼容。
- verify: `./node_modules/.bin/vitest run api/kb-tree.test.ts`（三层嵌套树收集断言、环引用防御）+ `./node_modules/.bin/tsc -b`。

## 终验 t8-final-verify
- 全仓 `./node_modules/.bin/tsc -b`；逐个跑本 round 新增/改动测试文件（不全量）；`npm run lint` 若快则跑；
- git 提交分组清晰，推 GitHub 分支 `fix/audit-round1`，PR 描述含每任务 verify 证据。

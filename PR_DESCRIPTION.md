# PR 标题

fix: 审查修复 Round 1 — 安全加固 / 工作流真执行 / kb 递归修复 / Settings 清理

# PR 正文

## 概述
按两份审查报告（xuanji11-审查总报告.md / xuanji11-安全架构评审报告.md）完成 Round 1 全部七项修复，4 个提交，104 个测试用例通过，全仓 tsc 零错误。

## 安全加固 (28b010e)
- **CSRF 收紧**：内部 REST 前缀（zvec/search/kb/keywords/relations）非 GET 请求改走 `isTrustedMutationRequest`（X-Requested-With 或 Origin 同源），消除携带管理员 cookie 的跨站伪造写请求面
- **SSRF guard**：新增 `api/lib/egress.ts`，DNS 解析后拒绝环回/RFC1918/link-local/云 metadata 地址；AList 连接器×5、备份仓库×7、向量嵌入测试共 14 处外呼前置校验；嵌入错误不再回显远端响应体；`EGRESS_ALLOW_PRIVATE_NET=true` 可放行内网自托管部署（NAS AList / 内网 LLM）
- **设置接口提权脱敏**：setting.list/listByCategory → adminQuery + 敏感键统一掩码；connector.getConfig 脱敏；datasource.testConnection/sync 等 6 处误标权限提权 adminQuery
- **webhook 真鉴权**：POST /api/workflows/:id/webhook 改 HMAC token（`?token=`），外部系统终于可调；webhookUrl 返回带 token 地址
- CSP 移除 `unsafe-inline`；JWT_SECRET 缺省时持久化至挂载卷 `.jwt-secret`(0600)

## kb 正确性 (896235a)
- `deleteFolder` 用 BFS 收集任意层级子孙后单条 `inArray` 删除，修复旧实现只递归一层导致孙级文件夹与文档向量成孤儿的 bug
- kb/knowledge/file/vector 六个列表接口增加 limit(默认200,上限1000)/offset 分页，向后兼容

## 工作流真执行 (fed22c7)
桩执行器转真实现，消灭假绿灯：
- vectorize→真实嵌入调用返回维度；find-similar→executeHybridSearch 真实匹配；summarize→LLM 总结；keywords→keyword-extractor auto 链路；create-link→幂等落库 knowledge_edges；save-result→写入目标知识库文档
- 未实现节点显式返回 `skipped`，运行节点状态记 `skipped`（schema 枚举原生支持），画布灰色横线替代绿色对勾
- 新增 `api/lib/llm-chat.ts`（OpenAI 兼容封装，出站过 egress guard）

## Settings 前端清理 (c0bbf4a)
- 个人设置 profile_* 持久化 + 保存按钮 + 回填；移除无后端能力的「更换头像」死按钮
- 测试连接改为探测所填 Hub URL `/health`(5s 超时)，不再误调向量健康检查
- 存储饼图按真实数值渲染比例（支持 K/M/G 解析），无数据隐藏而非硬编码 25%/15%/10%
- 移除无实现的「工作流默认」导航项；知识库设置/缓存清理文案诚实标注未实现
- 版本号经 vite define 从 package.json 注入

## 测试
- 新增测试：egress 21 例 / csrf 23 例 / setting-mask 17 例 / kb-tree 4 例 / workflow-executors 9 例 / storage-ratios 5 例 = **74 例全绿**
- 回归：auth/local-auth/vector-service/kb-backup/workflow-runtime/KnowledgeBase/KnowledgeGraph3D/PageLoader/utils = **30 例全绿**
- `tsc -b` 全仓零错误

## 部署注意
- 内网自托管 AList/LLM 需加环境变量 `EGRESS_ALLOW_PRIVATE_NET=true`（公网部署无需任何操作）
- 生产建议显式配置稳定 `JWT_SECRET`

# M6: Relation Discovery Engine

## 已实现

- `api/lib/relation-analyzer.ts`：关系发现核心逻辑，包含 3 种策略：
  - **Co-occurrence**：基于 `knowledge_edges` 中 `label = "tag"` 的边，统计与目标文档共享的 tag 数量。
  - **Vector**：调用 `searchVectors()`，使用文档标题+内容作为查询，过滤 cosine score >= 0.7 的结果，排除目标文档自身。
  - **Reference**：解析内容中 `[[...]]` wiki-link，匹配 `knowledge_nodes.title`，对未建立边关系的节点建议 `reference` 边。
- `api/relation-router.ts`：REST endpoint `POST /api/relations/discover`。
- `api/mcp-relation.ts`：MCP tool `relations.discover`。
- `api/relation.test.ts`：覆盖核心逻辑、REST 认证/鉴权/错误、MCP tool 注册与执行。
- 注册集成：
  - `api/router.ts` 导出 `relationRouter`。
  - `api/boot.ts` 挂载 `/api/relations` 路由，并加入 CSRF/Auth 豁免。
  - `api/mcp-server.ts` 注册 `relationTools` 与 `handleRelationTool`。

## 关键设计

- Scope：`knowledge:read`。
- 错误处理：路由器统一拦截 `ZodError` 返回 400，目标文档不存在返回 404，其它异常返回通用 500 并 `console.error` 记录。
- 输入校验：`discoverInputSchema` 限定 `documentId` 为正整数、`strategies` 为 3 种之一、`limit` 1-100。
- 输出格式：
  - `documentId`
  - `strategies`
  - `suggestions[]`（含 `strategy`, `targetType`, `targetId`, `title`, `score`, `reason`）

## 验证命令

```bash
npm run check
npm test -- --run
npm run build
```

结果：待回填。

## 验证结果

- `npm run check`：通过
- `npm test -- --run`：13 个测试文件，81 个测试全部通过
- `npm run build`：通过，`dist/boot.js` 生成成功

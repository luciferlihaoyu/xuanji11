# M1: ZVec REST API Layer

## 变更摘要

- `api/lib/vector-service.ts`（新建）：承载向量引擎实现与私有可变状态（collection / fallbackStore / zvecInitialized），
  导出 `embedTexts`、`searchVectors`、`listCollections`、`createCollection`、`deleteCollection`
  以及 `getStats`、`vectorEngine`、`initializeZvec`、`SearchResult`。
- `api/lib/vector.ts`（修改）：改为从 `vector-service.ts` 重新导出，保持原有 `vectorEngine` / `initializeZvec` / `SearchResult` API
  不变，已有引用方无需改动。
- `api/lib/auth.ts`（修改）：在 `MANAGEMENT_SCOPES` 中加入 `zvec:read` 与 `zvec:write`；
  在 `PERMISSION_SCOPES` 的 `read` / `write` 映射中加入对应 scope，使 API key 权限模型覆盖 ZVec。
- `api/zvec-router.ts`（新建）：Hono 子路由，挂载为 `/api/zvec/*`。
  - `POST /embed`：生成向量，需 `zvec:read`
  - `POST /search`：语义搜索，需 `zvec:read`
  - `GET /collections`：列出集合，需 `zvec:read`
  - `POST /collections`：创建集合，需 `zvec:write`
  - `DELETE /collections/:name`：删除集合，需 `zvec:write`
  - 自带 API key / 本地 session 双重认证中间件与 scope 校验；错误仅返回通用信息，详情通过 `console.error` 落日志。
- `api/router.ts`（修改）：导入并重新导出 `zvecRouter`，方便主应用在入口文件引用。
- `api/boot.ts`（修改）：
  - 将 `auth: AuthInfo` 加入 Hono `ContextVariableMap`；
  - 在 CSRF 与 auth 中间件中放行 `/api/zvec/*`；
  - 使用 `app.route("/api/zvec", zvecRouter)` 注册路由。
- `api/mcp-server.ts`（修改）：新增 `zvec.embed`、`zvec.search`、`zvec.stats` 工具，
  均调用 `assertScope("zvec:read")` 并使用 `vector-service` 函数。
- `api/lib/auth.test.ts`（修改）：补充 `zvec:read` / `zvec:write` 的 scope 映射断言。
- `api/zvec-router.test.ts`（新建）：覆盖未认证、scope 不足、正常嵌入三个场景。

## 验证结果

- `npm run check` ✅
- `npm test -- --run` ✅（16/16）
- `npm run build` ✅

## 注意事项

- `api/router.ts` 在本项目中是 tRPC `appRouter`，无法直接注册 Hono 子路由；
  实际挂载点在 `api/boot.ts` 的 `app.route("/api/zvec", zvecRouter)`。
  `api/router.ts` 通过重新导出 `zvecRouter` 保持与任务要求一致。
- `/api/zvec/*` 被显式排除在主应用的 CSRF 与本地 session 认证中间件之外，
  由 `zvec-router.ts` 自行完成 API key + session 双重认证与 scope 检查。
- 集合的 list/create/delete 目前基于 `vectorCollections` 元数据表；
  实际 ZVec 物理集合仍维持单例 `document_chunks`，以匹配现有引擎行为。
- `vector-service.ts` 沿用原 `vector.ts` 的 `SIZE_OK` 说明：私有状态与大量嵌入解析逻辑集中在单一模块中，
  拆分将暴露内部状态并增加耦合。

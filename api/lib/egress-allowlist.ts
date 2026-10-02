/**
 * 出网登记清单（2026-10-01 D5 棘轮制度）。
 *
 * 规矩：api/ 下**所有**直呼 fetch( 的调用点必须登记在这里，且 note 必须给理由。
 * - 新增出网点：优先改走 ./safe-fetch 的 safeFetch（用户/上游可控 URL 用默认 scope，管理员配置目标传 scope:"admin"）；
 *   确实要直呼 fetch 的，带理由登记到本清单。
 * - 出网点减少：必须同步收缩本清单（egress-ratchet.test.ts 双向对账，清单只减不涨）。
 *
 * 历史：
 * - 2026-10-01 初始登记 30 处/14 文件（全部为管理员配置的固定服务端点）。
 * - lib/ingestion.ts 的裸 fetch（原全仓唯一无门禁出网点）已迁 safeFetch(scope:"admin")，不在此列。
 * - lib/http.ts（HttpClient，全仓无引用的死代码）已删除，不在此列。
 */

export type FetchSiteStatus = "ok-admin" | "ok-internal" | "to-migrate";

export interface FetchSiteEntry {
  /** 相对 api/ 的文件路径（POSIX 分隔符） */
  file: string;
  /** 该文件内直呼 fetch( 的行数（不含注释行） */
  count: number;
  /** 登记理由（必填，为空会被棘轮测试打回） */
  note: string;
  status: FetchSiteStatus;
}

export const FETCH_SITES: FetchSiteEntry[] = [
  { file: "agent-router.ts", count: 1, note: "agent 相关外呼（管理员配置的平台端点）", status: "ok-admin" },
  { file: "backup-repositories/alist.ts", count: 8, note: "备份上传/下载 AList API（管理员配置的备份目标）", status: "ok-admin" },
  { file: "backup-repositories/restore.ts", count: 1, note: "恢复时从 AList 拉取清单/分片（管理员配置的备份目标）", status: "ok-admin" },
  { file: "connectors/115.ts", count: 3, note: "115 网盘连接器（管理员配置账号）", status: "ok-admin" },
  { file: "connectors/alist.ts", count: 5, note: "AList 网盘连接器（管理员配置 base URL）", status: "ok-admin" },
  { file: "connectors/aliyundrive.ts", count: 3, note: "阿里云盘连接器（管理员配置账号）", status: "ok-admin" },
  { file: "kimi/auth.ts", count: 1, note: "Kimi 平台鉴权（平台固定端点）", status: "ok-admin" },
  { file: "kimi/platform.ts", count: 1, note: "Kimi 平台 API（平台固定端点）", status: "ok-admin" },
  { file: "lib/keyword-extractor.ts", count: 1, note: "关键词抽取外呼（管理员配置的 LLM 端点）", status: "ok-admin" },
  { file: "lib/llm-chat.ts", count: 2, note: "LLM 对话外呼（管理员配置端点）", status: "ok-admin" },
  { file: "lib/mcp-client.ts", count: 1, note: "天书 MCP 客户端（管理员配置端点）", status: "ok-admin" },
  { file: "lib/vector-service.ts", count: 1, note: "embedding 外呼（管理员配置端点）", status: "ok-admin" },
  { file: "sso-router.ts", count: 1, note: "SSO 回调校验（平台固定端点）", status: "ok-admin" },
  { file: "tianshu-router.ts", count: 1, note: "天书路由外呼（管理员配置端点）", status: "ok-admin" },
];

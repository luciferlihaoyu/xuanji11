/**
 * MCP 列表工具的 cursor 分页（纯函数，无 DB 依赖，便于单测）。
 *
 * 为什么用不透明 cursor 而不是 offset：调用方（其他 Agent）不该推导分页语义，
 * 也不该把 cursor 当数字拼接；cursor 只保证「传回来就能拿到下一页」。
 * 为什么非法 cursor 抛错而不是从头开始：静默重开会把第 1 页当下一页返回，
 * 调用方会重复处理数据且毫无察觉——分页错误必须显式暴露。
 */

/** 未指定 limit 时的页大小 */
export const DEFAULT_PAGE_SIZE = 50;
/** limit 上限：防止一次调用把整库拉给模型（省 token 是本设计的目的之一） */
export const MAX_PAGE_SIZE = 200;

const CURSOR_PREFIX = "o:";

/** cursor 非法（损坏、伪造、非本服务签发）时抛出；调用方应转成 MCP isError */
export class InvalidCursorError extends Error {
  constructor(cursor: string) {
    super(`Invalid cursor: ${JSON.stringify(cursor)}（cursor 必须原样来自上一次响应的 nextCursor）`);
    this.name = "InvalidCursorError";
  }
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly total: number;
}

/** offset → 不透明 cursor（base64url，无 +/=，可安全放进 URL 与 JSON） */
export function encodeCursor(offset: number): string {
  if (!Number.isInteger(offset) || offset < 0) throw new InvalidCursorError(String(offset));
  return Buffer.from(`${CURSOR_PREFIX}${offset}`, "utf8").toString("base64url");
}

/** 不透明 cursor → offset；任何非法输入都抛 InvalidCursorError */
export function decodeCursor(cursor: string): number {
  if (typeof cursor !== "string" || cursor.length === 0) throw new InvalidCursorError(String(cursor));
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new InvalidCursorError(cursor);
  }
  if (!decoded.startsWith(CURSOR_PREFIX)) throw new InvalidCursorError(cursor);
  const raw = decoded.slice(CURSOR_PREFIX.length);
  if (!/^\d+$/.test(raw)) throw new InvalidCursorError(cursor);
  const offset = Number(raw);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new InvalidCursorError(cursor);
  return offset;
}

/** limit 归一：非法（非有限数字/NaN）→ 默认值；越界 → 夹到 [1, MAX_PAGE_SIZE]（向下取整） */
function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PAGE_SIZE;
  const int = Math.floor(limit);
  if (int < 1) return 1;
  if (int > MAX_PAGE_SIZE) return MAX_PAGE_SIZE;
  return int;
}

/**
 * 对已排序的完整结果集做游标分页。
 * 入参 rows 必须已按稳定顺序排好（调用方负责排序），本函数不改动入参。
 */
export function paginate<T>(rows: readonly T[], opts: { cursor?: string; limit?: number } = {}): Page<T> {
  const limit = normalizeLimit(opts.limit);
  const offset = opts.cursor === undefined || opts.cursor === "" ? 0 : decodeCursor(opts.cursor);
  const items = rows.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  const nextCursor = nextOffset < rows.length ? encodeCursor(nextOffset) : null;
  return { items, nextCursor, total: rows.length };
}

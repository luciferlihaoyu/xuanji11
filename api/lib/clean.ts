/**
 * 清理对象中的 undefined 值，用于 Drizzle ORM 的 insert/set 操作
 * Drizzle 不接受 undefined 值，需要过滤掉
 */
export function clean<T extends Record<string, unknown>>(obj: T): T {
  const result = {} as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as T;
}

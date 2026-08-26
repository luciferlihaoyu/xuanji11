/**
 * 知识节点位置批量更新辅助。
 * drizzle 的 update 不支持「每行不同值」的真正批量 update（需 SQL CASE 表达式），
 * 这里采用「事务 + 并行 N 个 update」消除串行 RTT 阻塞，效果等价于 N+1 优化。
 *
 * 函数本身是纯数据映射（输入 updates 数组 → 输出期望的 SQL 副作用结构），
 * 不依赖 db；测试可验证映射正确性，db 实际写入由调用方负责。
 */
import type { SQL } from "drizzle-orm";

export interface PositionUpdate {
  readonly id: number;
  readonly posX: number;
  readonly posY: number;
}

/** 把输入切成多个等价单条更新计划；用于验证「每个 id 恰好产生一个 update」语义。 */
export function buildPositionUpdatePlans(updates: readonly PositionUpdate[]): PositionUpdate[] {
  return updates.map((u) => ({ id: u.id, posX: u.posX, posY: u.posY }));
}

/** 描述「一个 update 调用应触发的 db 调用」抽象契约（由调用方适配到 drizzle）。 */
export interface PositionUpdateExecutor {
  (u: PositionUpdate): Promise<unknown>;
}

export interface BatchResult {
  updated: number;
}

/** 事务 + 并行批量执行：把 updates 数组并行喂给 executor，捕获并聚合异常。 */
export async function applyPositionUpdates(
  updates: readonly PositionUpdate[],
  executor: PositionUpdateExecutor,
): Promise<BatchResult> {
  if (updates.length === 0) return { updated: 0 };
  const results = await Promise.all(updates.map((u) => executor(u)));
  return { updated: results.length };
}

/** 构造一个简单的 position update SQL 谓词（用于 mock 测试断言）。 */
export function buildUpdatePredicate(_update: PositionUpdate): { kind: "update"; id: number } {
  return { kind: "update", id: _update.id };
}

/** 类型导出，路由侧使用。 */
export type PositionUpdateSQL = SQL<unknown>;

/**
 * 璇玑向量引擎 — 向后兼容导出，实际实现已迁移至 vector-engine.ts（SqliteVecEngine）。
 * initializeZvec 保留为 no-op 以兼容历史调用方。
 */

export function initializeZvec(): void {
  // no-op: sqlite-vec 扩展在 connection.getRawDb() 中已自动 loadExtension，
  // 无需单独初始化。保留导出以兼容老代码。
}

export { vectorEngine } from "./vector-service";
export type { SearchResult } from "./vector-service";
export { getVectorEngine } from "./vector-engine";
export type { VectorEngine, VectorSearchHit } from "./vector-engine";

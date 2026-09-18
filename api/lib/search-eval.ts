/**
 * 检索评测核心：评测用例（查询 → 期望文档）× 检索结果 → recall@k / MRR。
 *
 * 用途：改动检索参数（mode/rerank/topK/分块策略）前后跑同一评测集，
 * 用指标变化自证「改好了还是改坏了」，替代拍脑袋。
 */
import { desc } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { kbEvalCases } from "@db/schema";
import { executeHybridSearch } from "./hybrid-search";

export interface EvalCaseResult {
  readonly caseId: number;
  readonly query: string;
  readonly expectedDocIds: readonly number[];
  readonly hitDocIds: readonly number[];
  /** |命中∩期望| / |期望| */
  readonly recallAtK: number;
  /** 首个命中期望文档的名次倒数，无命中记 0 */
  readonly reciprocalRank: number;
}

export interface EvalMetrics {
  readonly caseCount: number;
  readonly meanRecallAtK: number;
  readonly mrr: number;
}

export interface RunEvalOptions {
  readonly mode?: "keyword" | "vector" | "hybrid";
  readonly rerank?: boolean;
  readonly topK?: number;
}

export interface RunEvalReport {
  readonly results: readonly EvalCaseResult[];
  readonly metrics: EvalMetrics;
  readonly durationMs: number;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** 单用例打分（纯函数，可手算验证） */
export function evaluateSingleCase(
  caseId: number,
  query: string,
  expectedDocIds: readonly number[],
  hitDocIds: readonly number[],
): EvalCaseResult {
  const expected = new Set(expectedDocIds);
  const hitCount = hitDocIds.filter((id) => expected.has(id)).length;
  const recall = expected.size > 0 ? hitCount / expected.size : 0;
  const firstIndex = hitDocIds.findIndex((id) => expected.has(id));
  const rr = firstIndex >= 0 ? 1 / (firstIndex + 1) : 0;
  return {
    caseId,
    query,
    expectedDocIds: [...expected],
    hitDocIds,
    recallAtK: round3(recall),
    reciprocalRank: round3(rr),
  };
}

/** 汇总指标（纯函数）：meanRecall@K 与 MRR，空集全 0 */
export function computeEvalMetrics(cases: readonly EvalCaseResult[]): EvalMetrics {
  if (cases.length === 0) return { caseCount: 0, meanRecallAtK: 0, mrr: 0 };
  const meanRecall = cases.reduce((s, c) => s + c.recallAtK, 0) / cases.length;
  const mrr = cases.reduce((s, c) => s + c.reciprocalRank, 0) / cases.length;
  return {
    caseCount: cases.length,
    meanRecallAtK: round3(meanRecall),
    mrr: round3(mrr),
  };
}

/** 解析 expectedDocIds 列（JSON 数组字符串）；坏数据按空处理，不抛错 */
function parseExpectedDocIds(raw: string): number[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  } catch {
    return [];
  }
}

/** 跑全量评测集：读 kb_eval_cases → 逐条检索 → 打分汇总 */
export async function runEval(opts: RunEvalOptions = {}): Promise<RunEvalReport> {
  const startedAt = Date.now();
  const mode = opts.mode ?? "hybrid";
  const rerank = opts.rerank ?? false;
  const topK = opts.topK ?? 5;

  const db = getDb();
  const rows = await db.select().from(kbEvalCases).orderBy(desc(kbEvalCases.createdAt));

  const results: EvalCaseResult[] = [];
  for (const row of rows) {
    const search = await executeHybridSearch({ query: row.query, mode, limit: topK, rerank });
    const hitDocIds = search.results
      .filter((r) => r.type === "document")
      .map((r) => Number(r.id))
      .filter((n) => Number.isFinite(n));
    results.push(evaluateSingleCase(row.id, row.query, parseExpectedDocIds(row.expectedDocIds), hitDocIds));
  }

  return { results, metrics: computeEvalMetrics(results), durationMs: Date.now() - startedAt };
}

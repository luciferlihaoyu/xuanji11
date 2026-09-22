/**
 * 检索评测核心：评测用例（查询 → 期望文档）× 检索结果 → recall@k / MRR。
 *
 * 用途：改动检索参数（mode/rerank/topK/分块策略）前后跑同一评测集，
 * 用指标变化自证「改好了还是改坏了」，替代拍脑袋。
 */
import { desc } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { inArray } from "drizzle-orm";
import { kbDocuments, kbEvalCases } from "@db/schema";
import { executeHybridSearch } from "./hybrid-search";

export type MissReason = "none" | "sibling" | "other";

export interface EvalCaseResult {
  readonly caseId: number;
  readonly query: string;
  readonly expectedDocIds: readonly number[];
  readonly hitDocIds: readonly number[];
  /** |命中∩期望| / |期望| */
  readonly recallAtK: number;
  /** 首个命中期望文档的名次倒数，无命中记 0 */
  readonly reciprocalRank: number;
  /** 该条检索失败时的错误摘要（仅失败项存在；失败项不计入指标） */
  readonly error?: string;
  /**
   * 未命中原因归类（只做解释，**不改变 recall/MRR 口径**）：
   * - `none`：期望文档已命中
   * - `sibling`：没命中期望文档，但命中的是它的「同族兄弟」——
   *   标题归一后相同（剥掉 `[前缀]` 与 `（第N部分/共M部分）`），典型如
   *   「完整错题库解析 (第4部分/共5部分)」查询命中「(第1部分/共5部分)」。
   *   向量空间对这类近重复天然分不开，属于用例本身的可分性上限，不是检索坏了。
   * - `other`：命中与期望无关，或根本没有命中
   */
  readonly missReason?: MissReason;
}

export interface EvalMetrics {
  /** 参与打分的成功用例数（失败用例不计入） */
  readonly caseCount: number;
  readonly meanRecallAtK: number;
  readonly mrr: number;
  /** 检索失败的用例数 */
  readonly failedCount: number;
  /**
   * 未命中里「命中同族兄弟文档」的用例数。
   * 用于解释低 recall 的性质：向量指标低但全是 sibling → 用例是近重复分辨题（可分性上限），
   * 不是检索链路坏了；若 sibling=0 还低 → 才需要查嵌入/链路。
   */
  readonly siblingConfusionCount: number;
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

/**
 * 同族兄弟判定用的标题归一：剥掉**开头连续的** `[前缀]`（如 `[openclaw][main]`、`[科目/不动产]`）
 * 与 `（第N部分/共M部分）` 等分册标记后小写。
 *
 * 只剥开头：`每日晨报 [2026-09-01]` 与 `每日晨报 [2026-09-02]` 是**不同日期的独立文档**，
 * 若把行内方括号也剥掉就会归一成同一条而被误判成「同族兄弟」（审查反例），
 * 归因会误导调参方向。宁可漏判，不可错判。
 */
export function normalizeDocTitle(title: string): string {
  return title
    .replace(/^\s*(?:\[[^\]]*\]\s*)+/, " ")
    .replace(/[（(]\s*第\s*\d+\s*部分[^)）]*[)）]/g, " ")
    .replace(/[（(]\s*part\s*\d+[^)）]*[)）]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** 标题归一后长度低于此值不参与兄弟判定（避免 "(第1部分)" 这种剥完只剩空串的误判） */
const MIN_SIBLING_TITLE_LEN = 4;

/**
 * 未命中原因归类（纯函数）。
 * 保守原则：期望标题缺失、命中原标题与期望归一后不等 → 一律 `other`，宁可漏判不可错判。
 */
export function classifyMissReason(
  expectedDocIds: readonly number[],
  hitDocIds: readonly number[],
  expectedTitles: readonly string[],
  hitTitles: readonly string[],
): "none" | "sibling" | "other" {
  const expected = new Set(expectedDocIds);
  if (hitDocIds.some((id) => expected.has(id))) return "none";
  if (hitDocIds.length === 0) return "other";
  const expectedNorms = new Set(
    expectedTitles.map(normalizeDocTitle).filter((t) => t.length >= MIN_SIBLING_TITLE_LEN),
  );
  if (expectedNorms.size === 0) return "other";
  for (const title of hitTitles) {
    const n = normalizeDocTitle(title);
    if (n.length >= MIN_SIBLING_TITLE_LEN && expectedNorms.has(n)) return "sibling";
  }
  return "other";
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

/**
 * 汇总指标（纯函数）：meanRecall@K 与 MRR。
 * 失败用例（error 非空）不计入分母——检索挂掉不该被算成「没召回」，否则指标会骗人。
 */
export function computeEvalMetrics(cases: readonly EvalCaseResult[]): EvalMetrics {
  const scored = cases.filter((c) => !c.error);
  const failedCount = cases.length - scored.length;
  const siblingConfusionCount = scored.filter((c) => c.missReason === "sibling").length;
  if (scored.length === 0) return { caseCount: 0, meanRecallAtK: 0, mrr: 0, failedCount, siblingConfusionCount: 0 };
  const meanRecall = scored.reduce((s, c) => s + c.recallAtK, 0) / scored.length;
  const mrr = scored.reduce((s, c) => s + c.reciprocalRank, 0) / scored.length;
  return {
    caseCount: scored.length,
    meanRecallAtK: round3(meanRecall),
    mrr: round3(mrr),
    failedCount,
    siblingConfusionCount,
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

  // 期望文档标题（用于兄弟混淆归因）：一次查完所有用例的期望 id，避免逐条查库
  const allExpectedIds = [...new Set(rows.flatMap((row) => parseExpectedDocIds(row.expectedDocIds)))];
  const titleById = new Map<number, string>();
  if (allExpectedIds.length > 0) {
    // 降级而不是毁盘：标题只用于「兄弟混淆」归因，查失败就退化成「无标题」（missReason 一律 other），
    // recall/MRR 一个字都不受影响——不能让一次辅助查询把整份评测报告带走。
    try {
      const titleRows = await db
        .select({ id: kbDocuments.id, title: kbDocuments.title })
        .from(kbDocuments)
        .where(inArray(kbDocuments.id, allExpectedIds));
      for (const r of titleRows) titleById.set(r.id, r.title);
    } catch (err) {
      console.warn("[search-eval] 取期望文档标题失败，兄弟归因降级为 other:", err instanceof Error ? err.message : err);
    }
  }

  const results: EvalCaseResult[] = [];
  for (const row of rows) {
    try {
      const search = await executeHybridSearch({ query: row.query, mode, limit: topK, rerank });
      const docHits = search.results.filter((r) => r.type === "document");
      const hitDocIds = docHits
        .map((r) => Number(r.id))
        .filter((n) => Number.isFinite(n));
      const expectedDocIds = parseExpectedDocIds(row.expectedDocIds);
      const missReason = classifyMissReason(
        expectedDocIds,
        hitDocIds,
        expectedDocIds.map((id) => titleById.get(id) ?? "").filter((t) => t.length > 0),
        docHits.map((r) => r.title ?? ""),
      );
      results.push({
        ...evaluateSingleCase(row.id, row.query, expectedDocIds, hitDocIds),
        missReason,
      });
    } catch (e) {
      // 单条失败（嵌入服务抖动、超时等）不该让整份评测报告消失
      results.push({
        caseId: row.id,
        query: row.query,
        expectedDocIds: parseExpectedDocIds(row.expectedDocIds),
        hitDocIds: [],
        recallAtK: 0,
        reciprocalRank: 0,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { results, metrics: computeEvalMetrics(results), durationMs: Date.now() - startedAt };
}

/**
 * 引用式问答（RAG）：检索 → 证据编号 → LLM 生成带引用的回答。
 *
 * 铁律：
 * - 只允许使用检索到的证据，每条结论必须带 [n] 引用
 * - 证据不足时明确拒答，绝不编造
 * - 答案区分「知识库原文」「模型归纳」
 */
import { executeHybridSearch } from "./hybrid-search";
import { chatCompletionStream, hasLlmAvailable, type ChatMessage } from "./llm-chat";
import { buildAnchor, resolveLatestVersionIds, type CitationAnchor } from "./citation-anchor";

export interface AskCitation {
  readonly n: number;
  readonly documentId: string;
  readonly title: string;
  readonly snippet: string;
  /** 版本溯源：该文档当前最新版本 id（无版本记录时为 null，不伪造） */
  readonly versionId: number | null;
  /** 定位锚点：块序号 + 块内字符区间 + 所属标题 */
  readonly anchor: CitationAnchor;
  /** 该文档的融合检索分 */
  readonly score?: number;
  /** 命中来源（keyword / vector），供用户判断「为什么会引用它」 */
  readonly retrievedBy: readonly string[];
}

export interface AskResult {
  readonly answer: string;
  readonly citations: readonly AskCitation[];
  /** 证据不足拒答 */
  readonly insufficient: boolean;
  /** 检索到的证据数量 */
  readonly evidenceCount: number;
  readonly model?: string;
}

const MIN_EVIDENCE = 2; // 至少 2 条证据才回答
const MAX_EVIDENCE = 8; // 最多给 LLM 8 条（prompt 长度控制）

export interface AskHistoryItem {
  readonly role: "user" | "assistant";
  readonly content: string;
}

/** 问答链路的检索参数（由系统设置驱动，不再硬编码） */
export interface AskRetrievalOptions {
  readonly mode: "hybrid";
  readonly limit: number;
  readonly rerank: boolean;
}

/**
 * 解析问答检索策略：读系统设置 ask_retrieval_rerank（"true" 开启 LLM 重排）。
 * 缺省/脏值/DB 异常一律兜底 false（重排慢 1~3 秒，默认关）。
 */
export async function resolveAskRetrievalOptions(): Promise<AskRetrievalOptions> {
  let rerank = false;
  try {
    const { getDb } = await import("../queries/connection");
    const { systemSettings } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [row] = await getDb().select({ value: systemSettings.value }).from(systemSettings)
      .where(eq(systemSettings.key, "ask_retrieval_rerank"));
    if (row?.value === "true") rerank = true;
  } catch {
    // DB 不可用（启动早期等）：保持默认 false
  }
  return { mode: "hybrid", limit: MAX_EVIDENCE, rerank };
}

export async function askKnowledgeBase(
  query: string,
  history: readonly AskHistoryItem[] = [],
  onToken?: (token: string) => void,
  retrievalOverride?: Partial<Pick<AskRetrievalOptions, "limit" | "rerank">>,
): Promise<AskResult> {
  // 1. 混合检索取证（rerank 由设置驱动；调用方可用 override 显式控制，优先级最高）
  const retrieval = { ...(await resolveAskRetrievalOptions()), ...retrievalOverride };
  const search = await executeHybridSearch({
    query,
    mode: retrieval.mode,
    limit: retrieval.limit,
    rerank: retrieval.rerank,
  });
  const docs = search.results.filter((r) => r.type === "document" && r.snippet.trim().length > 0);

  if (docs.length < MIN_EVIDENCE) {
    return {
      answer: "知识库中没有找到足够证据，无法回答这个问题。建议换个问法，或先补充相关文档。",
      citations: [],
      insufficient: true,
      evidenceCount: docs.length,
    };
  }

  if (!(await hasLlmAvailable())) {
    return {
      answer: "LLM 未配置，无法生成回答。请先在设置中配置模型。",
      citations: [],
      insufficient: true,
      evidenceCount: docs.length,
    };
  }

  // 2. 证据编号 + 溯源（版本 + 段落锚点 + 分数 + 来源）
  const versionIds = await resolveLatestVersionIds(
    docs.map((d) => Number(d.id)).filter((n) => Number.isFinite(n)),
  );
  const citations: AskCitation[] = docs.map((d, i) => {
    const topEvidence = d.evidence?.[0];
    const chunkText = topEvidence?.snippet ?? "";
    const chunkIndex = typeof topEvidence?.chunkIndex === "number" ? topEvidence.chunkIndex : null;
    const numericId = Number(d.id);
    return {
      n: i + 1,
      documentId: d.id,
      title: d.title,
      snippet: d.snippet,
      versionId: Number.isFinite(numericId) ? (versionIds.get(numericId) ?? null) : null,
      anchor: buildAnchor(chunkText, query, chunkIndex),
      score: d.score,
      retrievedBy: [...(d.sources ?? [])],
    };
  });

  const evidenceText = citations
    .map((c) => `[${c.n}] ${c.title}\n${c.snippet}`)
    .join("\n\n---\n\n");

  // 3. LLM 生成（强制引用格式）
  const systemPrompt = `你是知识库问答助手。基于下面给出的证据回答用户问题。

规则（必须遵守）：
1. 只能使用证据中的信息，不要用你自己的知识
2. 每个结论后面标注引用编号，如 [1] 或 [1][3]
3. 如果证据不足以回答，直接说"根据现有证据无法确定"，不要编造
4. 回答控制在 300 字以内
5. 用中文回答`;

  const evidencePrompt = `证据：
${evidenceText}

用户问题：${query}

回答（带引用编号）：`;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...history.slice(-6).map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: evidencePrompt },
  ];

  const resp = await chatCompletionStream(
    messages,
    onToken ?? (() => {}),
    { temperature: 0.2, maxTokens: 600, timeoutMs: 60000 },
  );
  if (!resp) {
    return {
      answer: "LLM 调用失败，请稍后重试。",
      citations,
      insufficient: true,
      evidenceCount: docs.length,
    };
  }

  // 4. 检查答案是否真的引用了证据（防止模型无视规则）
  const usedCitations = new Set<number>();
  const citePattern = /\[(\d+)\]/g;
  let match;
  while ((match = citePattern.exec(resp.content)) !== null) {
    const n = parseInt(match[1], 10);
    if (n >= 1 && n <= citations.length) usedCitations.add(n);
  }

  // 一个引用都没有 → 模型在自由发挥，标记不可信
  const answer = usedCitations.size === 0
    ? `⚠️ 以下回答未引用知识库证据，仅供参考：\n\n${resp.content}`
    : resp.content;

  return {
    answer,
    citations: citations.filter((c) => usedCitations.has(c.n)),
    insufficient: false,
    evidenceCount: docs.length,
    model: resp.model,
  };
}

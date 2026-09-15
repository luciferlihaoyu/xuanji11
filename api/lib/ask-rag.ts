/**
 * 引用式问答（RAG）：检索 → 证据编号 → LLM 生成带引用的回答。
 *
 * 铁律：
 * - 只允许使用检索到的证据，每条结论必须带 [n] 引用
 * - 证据不足时明确拒答，绝不编造
 * - 答案区分「知识库原文」「模型归纳」
 */
import { executeHybridSearch } from "./hybrid-search";
import { chatCompletion, hasLlmAvailable } from "./llm-chat";

export interface AskCitation {
  readonly n: number;
  readonly documentId: string;
  readonly title: string;
  readonly snippet: string;
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

export async function askKnowledgeBase(query: string): Promise<AskResult> {
  // 1. 混合检索取证
  const search = await executeHybridSearch({ query, mode: "hybrid", limit: MAX_EVIDENCE, rerank: false });
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

  // 2. 证据编号
  const citations: AskCitation[] = docs.map((d, i) => ({
    n: i + 1,
    documentId: d.id,
    title: d.title,
    snippet: d.snippet,
  }));

  const evidenceText = citations
    .map((c) => `[${c.n}] ${c.title}\n${c.snippet}`)
    .join("\n\n---\n\n");

  // 3. LLM 生成（强制引用格式）
  const prompt = `你是知识库问答助手。基于下面的证据回答用户问题。

规则（必须遵守）：
1. 只能使用下面证据中的信息，不要用你自己的知识
2. 每个结论后面标注引用编号，如 [1] 或 [1][3]
3. 如果证据不足以回答，直接说"根据现有证据无法确定"，不要编造
4. 回答控制在 300 字以内
5. 用中文回答

证据：
${evidenceText}

用户问题：${query}

回答（带引用编号）：`;

  const resp = await chatCompletion(prompt, { temperature: 0.2, maxTokens: 600, timeoutMs: 30000 });
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

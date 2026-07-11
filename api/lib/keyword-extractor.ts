import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { agents } from "@db/schema";

export const extractionModeSchema = z.enum(["internal", "llm", "auto"]).default("internal");

export const extractInputSchema = z.object({
  text: z.string().min(1).max(100_000),
  mode: extractionModeSchema,
  maxKeywords: z.number().int().min(1).max(100).default(10),
});

export type ExtractInput = z.infer<typeof extractInputSchema>;

export interface KeywordResult {
  readonly word: string;
  readonly score: number;
}

interface LlmConfig {
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

const CHINESE_STOPWORDS = new Set([
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一", "一个", "上", "也", "很", "到", "说", "要", "去", "你", "会", "着", "没有", "看", "好", "自己", "这", "那", "我们", "就是", "之", "与", "及", "等", "或", "但", "而", "因为", "所以", "如果", "则", "为", "被", "让", "把", "向", "从", "将", "于", "以", "可以", "这个", "那个", "这些", "那些", "什么", "怎么", "多少", "这里", "那里", "时候", "现在", "然后", "还是", "这样", "那样", "一下", "一些", "很多", "非常", "已经", "正在", "曾经", "一直", "起来", "出来", "过来", "进去", "知道", "觉得", "认为", "可能", "应该", "必须", "需要", "能够", "不能", "不要", "不会", "那么", "哪", "谁", "为什么", "怎样", "如何", "某", "每个", "各", "种", "类", "等等", "地", "得",
]);

const ENGLISH_STOPWORDS = new Set([
  "the", "be", "to", "of", "and", "a", "an", "in", "that", "have", "i", "it", "for", "not", "on", "with", "he", "as", "you", "do", "at", "this", "but", "his", "by", "from", "they", "we", "say", "her", "she", "or", "will", "my", "one", "all", "would", "there", "their", "what", "so", "up", "out", "if", "about", "who", "get", "which", "go", "me", "when", "make", "can", "like", "time", "no", "just", "him", "know", "take", "people", "into", "year", "your", "good", "some", "could", "them", "see", "other", "than", "then", "now", "look", "only", "come", "its", "over", "think", "also", "back", "after", "use", "two", "how", "our", "work", "first", "well", "way", "even", "new", "want", "because", "any", "these", "give", "day", "most", "us", "is", "are", "was", "were", "been", "being", "has", "had", "did", "does", "doing", "done", "am",
]);

const STOPWORDS = new Set([...CHINESE_STOPWORDS, ...ENGLISH_STOPWORDS]);

function isCjkChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
    (code >= 0x3040 && code <= 0x309f) || // Hiragana
    (code >= 0x30a0 && code <= 0x30ff) || // Katakana
    (code >= 0xac00 && code <= 0xd7af) // Hangul
  );
}

function isWordChar(char: string): boolean {
  return /[a-zA-Z0-9_]/.test(char);
}

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const chars = [...text];

  for (let i = 0; i < chars.length; ) {
    if (isCjkChar(chars[i])) {
      let j = i;
      while (j < chars.length && isCjkChar(chars[j])) j++;
      const run = chars.slice(i, j).join("");
      for (let k = 0; k < run.length - 1; k++) {
        tokens.push(run.slice(k, k + 2));
      }
      i = j;
    } else if (isWordChar(chars[i])) {
      let j = i;
      while (j < chars.length && isWordChar(chars[j])) j++;
      const word = chars.slice(i, j).join("").toLowerCase();
      if (word.length > 2) tokens.push(word);
      i = j;
    } else {
      i++;
    }
  }

  return tokens.filter((t) => !STOPWORDS.has(t));
}

export function extractKeywordsInternal(text: string, maxKeywords: number): KeywordResult[] {
  const tokens = tokenize(text);
  if (tokens.length === 0) return [];

  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  const totalTokens = tokens.length;
  const results: KeywordResult[] = [];
  for (const [word, count] of counts) {
    results.push({ word, score: Math.round((count / totalTokens) * 1000) / 1000 });
  }

  results.sort((a, b) => b.score - a.score || a.word.localeCompare(b.word));
  return results.slice(0, maxKeywords);
}

export async function findLlmAgent(): Promise<LlmConfig | undefined> {
  const db = getDb();
  const rows = await db.select({ config: agents.config }).from(agents).where(eq(agents.status, "active"));

  for (const row of rows) {
    const cfg = row.config;
    if (!cfg || typeof cfg !== "object") continue;
    const apiUrl = cfg.apiUrl;
    const apiKey = cfg.apiKey;
    const model = cfg.model;
    if (typeof apiUrl === "string" && typeof apiKey === "string" && apiUrl.length > 0 && apiKey.length > 0) {
      return {
        apiUrl,
        apiKey,
        model: typeof model === "string" ? model : "gpt-3.5-turbo",
      };
    }
  }

  return undefined;
}

export async function extractKeywordsWithLlm(
  text: string,
  maxKeywords: number,
  config: LlmConfig,
): Promise<KeywordResult[] | undefined> {
  const url = config.apiUrl.endsWith("/chat/completions")
    ? config.apiUrl
    : config.apiUrl.replace(/\/$/, "") + "/chat/completions";

  const prompt =
    `Extract up to ${maxKeywords} keywords from the following text. ` +
    `Return ONLY a JSON array of objects, each with "word" (string) and "score" (number 0-1). ` +
    `Text: ${text.slice(0, 4000)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 1000,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.error("[KeywordLLM] HTTP error:", res.status);
      return undefined;
    }

    const data = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string } }[] } | null;
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return undefined;

    const json = parseLlmJson(content);
    if (!json || !Array.isArray(json)) return undefined;

    const results: KeywordResult[] = [];
    for (const item of json.slice(0, maxKeywords)) {
      if (typeof item === "string") {
        results.push({ word: item.trim(), score: 1 });
      } else if (item && typeof item === "object") {
        const word = typeof item.word === "string" ? item.word.trim() : "";
        const score = typeof item.score === "number" ? item.score : 1;
        if (word) results.push({ word, score });
      }
    }

    return results.length > 0 ? results : undefined;
  } catch (err) {
    clearTimeout(timeout);
    console.error("[KeywordLLM] Failed:", err);
    return undefined;
  }
}

function parseLlmJson(content: string): unknown {
  const start = content.indexOf("[");
  const end = content.lastIndexOf("]");
  if (start !== -1 && end !== -1 && start < end) {
    try {
      return JSON.parse(content.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

export async function extractKeywords(
  text: string,
  mode: "internal" | "llm" | "auto",
  maxKeywords: number,
): Promise<KeywordResult[]> {
  if (mode === "internal") {
    return extractKeywordsInternal(text, maxKeywords);
  }

  if (mode === "llm" || mode === "auto") {
    const config = await findLlmAgent();
    if (config) {
      const llmResults = await extractKeywordsWithLlm(text, maxKeywords, config);
      if (llmResults && llmResults.length > 0) return llmResults;
    }
  }

  return extractKeywordsInternal(text, maxKeywords);
}

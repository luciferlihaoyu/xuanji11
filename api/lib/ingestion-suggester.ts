/**
 * 入库分拣管线：文档上传后由 LLM 给出结构化建议——
 *   folderId：归入哪个已有文件夹（或建议新建）
 *   tags：3~6 个标签
 *   concepts：抽取的概念/实体节点（图谱的概念层——解决 141/187 都是
 *     document、concept/entity 为 0 的类型失衡）
 *
 * 设计原则：建议先行、用户确认后才落库（半自动分拣，不静默改数据）。
 * LLM 不可用时返回 skipped，前端回退到纯手动。
 */
import { getDb } from "../queries/connection";
import { kbFolders, knowledgeNodes } from "@db/schema";
import { eq } from "drizzle-orm";
import { chatCompletion, hasLlmAvailable } from "./llm-chat";

export interface IngestionSuggestion {
  readonly skipped: boolean;
  readonly reason?: string;
  readonly folderId: number | null;
  readonly newFolderName?: string;
  readonly tags: string[];
  readonly concepts: Array<{ title: string; type: "concept" | "entity"; summary: string }>;
}

interface LlmSuggestionPayload {
  folderId?: number | null;
  newFolderName?: string;
  tags?: string[];
  concepts?: Array<{ title?: string; type?: string; summary?: string }>;
}

const VALID_NODE_TYPES = new Set(["concept", "entity"]);

/**
 * 为文档生成入库建议。
 * @param title 文档标题
 * @param content 文档内容（截断到前 1500 字喂给 LLM）
 */
export async function suggestIngestion(title: string, content: string): Promise<IngestionSuggestion> {
  const empty: IngestionSuggestion = { skipped: true, folderId: null, tags: [], concepts: [] };
  if (!(await hasLlmAvailable())) {
    return { ...empty, reason: "LLM 未配置" };
  }

  const db = getDb();
  const folders = await db.select({ id: kbFolders.id, name: kbFolders.name }).from(kbFolders);
  // 现有 tag 节点（图谱里的 tag 类型）供 LLM 优先复用，防标签膨胀
  const existingTags = (await db.select({ title: knowledgeNodes.title })
    .from(knowledgeNodes)
    .where(eq(knowledgeNodes.type, "tag"))
    .limit(50)).map((t) => t.title);

  const folderList = folders.map((f) => `${f.id}:${f.name}`).join(", ") || "（暂无文件夹）";
  const tagList = existingTags.join(", ") || "（暂无标签）";

  const prompt = `你是知识库分拣助手。为下面的文档给出入库建议（JSON）：

现有文件夹（id:名称）：${folderList}
现有标签：${tagList}

文档标题：${title}
文档内容（前1500字）：
${content.slice(0, 1500)}

只输出 JSON（不要 markdown 代码块），字段：
{
  "folderId": 数字或null（归入现有文件夹的 id；都不合适则 null 并给 newFolderName）,
  "newFolderName": "建议新建的文件夹名（可选）",
  "tags": ["3~6个标签，优先复用现有标签"],
  "concepts": [{"title": "概念/实体名", "type": "concept或entity", "summary": "一句话描述"}]（2~5个）
}`;

  const result = await chatCompletion(prompt, { temperature: 0.2, maxTokens: 600, timeoutMs: 30000 });
  if (!result) return { ...empty, reason: "LLM 调用失败" };

  // 解析 JSON（容忍 LLM 包 markdown 代码块）
  let payload: LlmSuggestionPayload;
  try {
    const text = result.content.replace(/```json\s*|\s*```/g, "").trim();
    payload = JSON.parse(text);
  } catch {
    return { ...empty, reason: "LLM 返回非 JSON" };
  }

  // 校验 + 清洗
  const folderId = typeof payload.folderId === "number" && folders.some((f) => f.id === payload.folderId)
    ? payload.folderId
    : null;
  const tags = Array.isArray(payload.tags)
    ? payload.tags.filter((t): t is string => typeof t === "string").slice(0, 8)
    : [];
  const concepts = Array.isArray(payload.concepts)
    ? payload.concepts
        .filter((c): c is { title: string; type: string; summary: string } =>
          typeof c?.title === "string" && typeof c?.summary === "string" && VALID_NODE_TYPES.has(c?.type ?? ""))
        .slice(0, 5)
        .map((c) => ({ title: c.title, type: c.type as "concept" | "entity", summary: c.summary }))
    : [];

  return {
    skipped: false,
    folderId,
    newFolderName: typeof payload.newFolderName === "string" ? payload.newFolderName : undefined,
    tags,
    concepts,
  };
}

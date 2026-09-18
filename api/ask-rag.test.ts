import { describe, it, expect, beforeEach, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.ADMIN_USERNAME = "test-admin";
  process.env.ADMIN_PASSWORD = "test-password-at-least-32-characters-long!!";
});

vi.mock("./lib/hybrid-search", () => ({ executeHybridSearch: vi.fn() }));
vi.mock("./lib/llm-chat", () => ({
  hasLlmAvailable: vi.fn(async () => true),
  chatCompletionStream: vi.fn(async () => ({ content: "答案：引用可定位方案[1]", model: "test-model" })),
}));
vi.mock("./queries/connection", () => ({ getDb: vi.fn() }));

import { askKnowledgeBase, resolveAskRetrievalOptions } from "./lib/ask-rag";
import { executeHybridSearch } from "./lib/hybrid-search";
import { chatCompletionStream } from "./lib/llm-chat";
import { getDb } from "./queries/connection";

function twoDocs() {
  const mk = (id: string, t: string) => ({
    type: "document", id, title: t, snippet: `${t} 的证据片段`, score: 0.02,
    sources: [], tags: [], folderId: null, reasons: [], evidence: [],
  });
  return {
    results: [mk("1922", "路线图"), mk("1923", "调研")],
    facets: { types: {}, tags: {}, folders: {} },
    metadata: { mode: "hybrid", query: "q", limit: 8, total: 2, keywordResults: 2, vectorResults: 2, durationMs: 1, cached: false },
  };
}

function settingsDb(rows: Array<{ value: string | null }>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => rows),
      })),
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(executeHybridSearch).mockResolvedValue(twoDocs() as never);
});

describe("resolveAskRetrievalOptions（设置驱动）", () => {
  it("设置 ask_retrieval_rerank=true → rerank true", async () => {
    vi.mocked(getDb).mockReturnValue(settingsDb([{ value: "true" }]) as never);
    const o = await resolveAskRetrievalOptions();
    expect(o).toEqual({ mode: "hybrid", limit: 8, rerank: true });
  });

  it("无设置行 → rerank false", async () => {
    vi.mocked(getDb).mockReturnValue(settingsDb([]) as never);
    expect((await resolveAskRetrievalOptions()).rerank).toBe(false);
  });

  it("设置值非 true（如 false/脏值）→ rerank false", async () => {
    vi.mocked(getDb).mockReturnValue(settingsDb([{ value: "false" }]) as never);
    expect((await resolveAskRetrievalOptions()).rerank).toBe(false);
  });

  it("DB 异常兜底 false，不抛错", async () => {
    vi.mocked(getDb).mockImplementation(() => {
      throw new Error("db down");
    });
    await expect(resolveAskRetrievalOptions()).resolves.toEqual({ mode: "hybrid", limit: 8, rerank: false });
  });
});

describe("askKnowledgeBase（检索参数策略化）", () => {
  it("无设置：传给检索的 rerank=false（不再依赖硬编码）", async () => {
    vi.mocked(getDb).mockReturnValue(settingsDb([]) as never);
    await askKnowledgeBase("引用可定位是什么");
    expect(executeHybridSearch).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "hybrid", rerank: false }),
    );
  });

  it("设置 true：rerank=true 生效到检索调用", async () => {
    vi.mocked(getDb).mockReturnValue(settingsDb([{ value: "true" }]) as never);
    await askKnowledgeBase("引用可定位是什么");
    expect(executeHybridSearch).toHaveBeenCalledWith(
      expect.objectContaining({ rerank: true }),
    );
  });

  it("retrievalOverride 优先级最高（覆盖设置与默认 limit）", async () => {
    vi.mocked(getDb).mockReturnValue(settingsDb([{ value: "false" }]) as never);
    await askKnowledgeBase("引用可定位是什么", [], undefined, { rerank: true, limit: 3 });
    expect(executeHybridSearch).toHaveBeenCalledWith(
      expect.objectContaining({ rerank: true, limit: 3 }),
    );
  });

  it("证据不足拒答行为保留：insufficient=true 且无引用", async () => {
    vi.mocked(getDb).mockReturnValue(settingsDb([]) as never);
    vi.mocked(executeHybridSearch).mockResolvedValue({
      results: [], facets: { types: {}, tags: {}, folders: {} },
      metadata: { mode: "hybrid", query: "q", limit: 8, total: 0, keywordResults: 0, vectorResults: 0, durationMs: 1, cached: false },
    } as never);
    const r = await askKnowledgeBase("完全不相关的问题");
    expect(r.insufficient).toBe(true);
    expect(r.citations).toEqual([]);
    expect(r.answer).toContain("没有找到足够证据");
  });

  it("只保留答案真正引用过的条目（[1] 用到、[2] 没用到）", async () => {
    vi.mocked(getDb).mockReturnValue(settingsDb([]) as never);
    const r = await askKnowledgeBase("引用可定位是什么");
    expect(r.insufficient).toBe(false);
    expect(r.citations).toHaveLength(1);
    expect(r.citations[0].documentId).toBe("1922");
    expect(r.model).toBe("test-model");
    expect(chatCompletionStream).toHaveBeenCalled();
  });
});

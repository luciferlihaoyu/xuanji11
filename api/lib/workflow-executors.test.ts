import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeNode } from "./workflow-runtime";

vi.hoisted(() => {
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
});

vi.mock("./vector-service", () => ({
  embedTexts: vi.fn(async (texts: string[]) => texts.map(() => Array.from({ length: 8 }, () => 0.1))),
}));

vi.mock("./hybrid-search", () => ({
  executeHybridSearch: vi.fn(async () => ({
    results: [
      { id: "doc-1", title: "匹配一", snippet: "……", type: "document", score: 0.9, sources: [], tags: [], folderId: null },
      { id: "node-2", title: "匹配二", snippet: "……", type: "knowledge", score: 0.7, sources: [], tags: [], folderId: null },
    ],
    facets: {},
    metadata: { mode: "hybrid", query: "", limit: 10, total: 2, keywordResults: 1, vectorResults: 1 },
  })),
}));

vi.mock("./llm-chat", () => ({
  chatCompletion: vi.fn(),
}));

vi.mock("../queries/connection", () => ({
  getDb: vi.fn(),
}));

import { embedTexts } from "./vector-service";
import { executeHybridSearch } from "./hybrid-search";
import { chatCompletion } from "./llm-chat";
import { getDb } from "../queries/connection";

const CTX = { input: {}, outputs: {} };

describe("真实执行器", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("vectorize 调用真实嵌入服务并返回维度", async () => {
    const out = await executeNode("vectorize", { text: "hello world" }, CTX);
    expect(embedTexts).toHaveBeenCalledWith(["hello world"]);
    expect(out.vectorized).toBe(true);
    expect(out.dimensions).toBe(8);
  });

  it("vectorize 无嵌入配置时返回 skipped 而非假成功", async () => {
    vi.mocked(embedTexts).mockRejectedValueOnce(new Error("Embedding provider not configured"));
    const out = await executeNode("vectorize", { text: "hello" }, CTX);
    expect(typeof out.skipped).toBe("string");
    expect(out.vectorized).toBeUndefined();
  });

  it("find-similar 返回混合搜索真实结果", async () => {
    const out = await executeNode("find-similar", { query: "知识图谱" }, CTX);
    expect(executeHybridSearch).toHaveBeenCalledWith(expect.objectContaining({ query: "知识图谱" }));
    expect((out.matches as unknown[]).length).toBe(2);
    expect((out.matches as { title: string }[])[0].title).toBe("匹配一");
  });

  it("summarize 有 LLM 时返回模型摘要", async () => {
    vi.mocked(chatCompletion).mockResolvedValueOnce({ content: "这是摘要。", model: "test-model" });
    const out = await executeNode("summarize", { text: "长文本……" }, CTX);
    expect(out.summary).toBe("这是摘要。");
    expect(out.model).toBe("test-model");
  });

  it("summarize 无 LLM 时返回 skipped", async () => {
    vi.mocked(chatCompletion).mockResolvedValueOnce(undefined);
    const out = await executeNode("summarize", { text: "长文本……" }, CTX);
    expect(typeof out.skipped).toBe("string");
  });

  it("未实现的通知类节点一律显式 skipped", async () => {
    for (const type of ["notify-agent", "send-notification", "file-upload"]) {
      const out = await executeNode(type, {}, CTX);
      expect(typeof out.skipped).toBe("string");
    }
  });

  it("触发器节点 cron/webhook 运行时跳过", async () => {
    for (const type of ["cron", "webhook"]) {
      const out = await executeNode(type, {}, CTX);
      expect(typeof out.skipped).toBe("string");
    }
  });
});

describe("落库型执行器（mock DB）", () => {
  function fakeDbForInsert(insertId: number) {
    const where = vi.fn(() => Promise.resolve([])); // 幂等检查：无边存在
    return {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })),
      insert: vi.fn(() => ({ values: vi.fn(async () => [{ insertId }]) })),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("create-link 缺参数时 skipped；有参数时插入边表", async () => {
    const missing = await executeNode("create-link", {}, CTX);
    expect(typeof missing.skipped).toBe("string");

    const db = fakeDbForInsert(42);
    vi.mocked(getDb).mockReturnValue(db as never);
    const out = await executeNode("create-link", { sourceId: 1, targetId: 2, label: "相关" }, CTX);
    expect(out.created).toBe(true);
    expect(out.edgeId).toBe(42);
    expect(db.insert).toHaveBeenCalled();
  });

  it("save-result 无 targetFolderId 时 skipped；有配置时写入文档", async () => {
    const missing = await executeNode("save-result", { content: "x" }, CTX);
    expect(typeof missing.skipped).toBe("string");

    const db = fakeDbForInsert(77);
    vi.mocked(getDb).mockReturnValue(db as never);
    const out = await executeNode("save-result", { targetFolderId: 3, title: "结果" }, CTX);
    expect(out.saved).toBe(true);
    expect(out.documentId).toBe(77);
  });
});

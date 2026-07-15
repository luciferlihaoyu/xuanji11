import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "correct-password";
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.JWT_SECRET = "fixed-test-jwt-secret-with-32-chars";
});

vi.mock("@zvec/zvec", () => ({
  default: {
    ZVecInitialize: vi.fn(),
    ZVecLogLevel: { WARN: 1 },
    ZVecDataType: { BOOL: 1, INT64: 2, DOUBLE: 3, STRING: 4, VECTOR_FP32: 5 },
    ZVecIndexType: { INVERT: 1 },
    ZVecCreateAndOpen: vi.fn(),
  },
}));

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    ...actual,
    eq: vi.fn((column: unknown, value: string) => value),
    desc: vi.fn(() => "desc"),
  };
});

type MockStore = Record<string, string>;

function createMockDb(store: MockStore) {
  let operation: "select" | "update" | "delete" = "select";
  let whereKey: string | undefined;
  let updateValues: Record<string, string> | undefined;

  const chain = {
    select: () => {
      operation = "select";
      whereKey = undefined;
      updateValues = undefined;
      return chain;
    },
    from: () => chain,
    where: (key: string) => {
      whereKey = key;
      return chain;
    },
    update: () => {
      operation = "update";
      whereKey = undefined;
      updateValues = undefined;
      return chain;
    },
    set: (values: Record<string, string>) => {
      updateValues = values;
      return chain;
    },
    insert: () => ({
      values: (values: Record<string, string>) => {
        store[values.key] = values.value;
        return Promise.resolve([]);
      },
    }),
    delete: () => ({
      where: (key: string) => {
        delete store[key];
        return Promise.resolve();
      },
    }),
    orderBy: () => chain,
    limit: () => Promise.resolve([]),
    then: (resolve: (value: unknown) => unknown) => {
      switch (operation) {
        case "select":
          return Promise.resolve(whereKey != null && store[whereKey] != null ? [{ key: whereKey, value: store[whereKey] }] : []).then(resolve);
        case "update":
          if (whereKey != null && updateValues != null) {
            store[whereKey] = updateValues.value;
          }
          return Promise.resolve(undefined).then(resolve);
        default:
          return Promise.resolve(undefined).then(resolve);
      }
    },
  };
  return chain;
}

const mockStore: MockStore = {};

vi.mock("../queries/connection", () => ({
  getDb: vi.fn(() => createMockDb(mockStore)),
}));

const openaiResponse = {
  data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
  usage: { prompt_tokens: 1, total_tokens: 1 },
};

const volcengineMultimodalResponse = {
  data: [{ index: 0, embedding: [[0.1, 0.2, 0.3]] }],
  usage: { prompt_tokens: 1, total_tokens: 1 },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lastFetchUrl(): string {
  const calls = vi.mocked(fetch).mock.calls;
  const [url] = calls[calls.length - 1] ?? [];
  return String(url ?? "");
}

function lastFetchBody(): Record<string, unknown> | undefined {
  const calls = vi.mocked(fetch).mock.calls;
  const [, init] = calls[calls.length - 1] ?? [];
  if (!isRecord(init) || typeof init.body !== "string") return undefined;
  try {
    const parsed = JSON.parse(init.body);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function importVectorService() {
  return import("./vector-service");
}

describe("normalizeEmbeddingUrl", () => {
  it("appends /embeddings to a base OpenAI-compatible URL", async () => {
    const { normalizeEmbeddingUrl } = await importVectorService();
    const result = normalizeEmbeddingUrl("https://api.openai.com/v1", "openai");
    expect(result).toBe("https://api.openai.com/v1/embeddings");
  });

  it("leaves a full /embeddings URL unchanged", async () => {
    const { normalizeEmbeddingUrl } = await importVectorService();
    const result = normalizeEmbeddingUrl("https://api.openai.com/v1/embeddings", "openai");
    expect(result).toBe("https://api.openai.com/v1/embeddings");
  });

  it("uses standard OpenAI-compatible path for Volcengine Agent Plan", async () => {
    const { normalizeEmbeddingUrl } = await importVectorService();
    const result = normalizeEmbeddingUrl("https://ark.cn-beijing.volces.com/api/plan/v3/embeddings", "volcengine");
    expect(result).toBe("https://ark.cn-beijing.volces.com/api/plan/v3/embeddings");
  });

  it("uses multimodal path for Volcengine non-Agent-Plan", async () => {
    const { normalizeEmbeddingUrl } = await importVectorService();
    const result = normalizeEmbeddingUrl("https://ark.cn-beijing.volces.com/api/v3", "volcengine");
    expect(result).toBe("https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal");
  });
});

describe("testEmbeddingConfig", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    Object.keys(mockStore).forEach((key) => delete mockStore[key]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(openaiResponse), { status: 200 }),
    );
  });

  it("sends the provided config to the wire and returns dimension and resolved URL", async () => {
    const { testEmbeddingConfig } = await importVectorService();

    const result = await testEmbeddingConfig({
      provider: "openai",
      apiUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      model: "text-embedding-3-small",
      dimension: 1536,
    });

    expect(result.ok).toBe(true);
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("text-embedding-3-small");
    expect(result.dimension).toBe(3);
    expect(result.resolvedUrl).toBe("https://api.openai.com/v1/embeddings");
    expect(result.status).toBeUndefined();

    expect(lastFetchUrl()).toBe("https://api.openai.com/v1/embeddings");
    expect(lastFetchBody()).toMatchObject({
      input: ["ping"],
      model: "text-embedding-3-small",
      encoding_format: "float",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sk-test" },
      }),
    );
  });

  it("uses multimodal format for Volcengine non-Agent-Plan", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(volcengineMultimodalResponse), { status: 200 }),
    );
    const { testEmbeddingConfig } = await importVectorService();

    const result = await testEmbeddingConfig({
      apiUrl: "https://ark.cn-beijing.volces.com/api/v3",
      apiKey: "volc-test",
      model: "doubao-embedding-text",
      dimension: 2048,
    });

    expect(result.ok).toBe(true);
    expect(result.resolvedUrl).toBe("https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal");

    expect(lastFetchUrl()).toBe("https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal");
    expect(lastFetchBody()).toMatchObject({
      input: [{ type: "text", text: "ping" }],
      model: "doubao-embedding-text",
      encoding_format: "float",
    });
  });

  it("returns HTTP status and resolved URL on failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Unauthorized", code: "invalid_api_key" } }), { status: 401 }),
    );
    const { testEmbeddingConfig } = await importVectorService();

    const result = await testEmbeddingConfig({
      apiUrl: "https://api.openai.com/v1",
      apiKey: "bad-key",
      model: "text-embedding-3-small",
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.resolvedUrl).toBe("https://api.openai.com/v1/embeddings");
    expect(result.error).toContain("401");
    expect(result.error).toContain("Unauthorized");
  });
});

describe("vector model template management", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    Object.keys(mockStore).forEach((key) => delete mockStore[key]);
  });

  it("masks apiKey in list summaries", async () => {
    const { saveVectorModelTemplate, listVectorModelTemplates } = await importVectorService();

    await saveVectorModelTemplate({
      name: "OpenAI Embedding",
      provider: "openai",
      apiUrl: "https://api.openai.com/v1",
      apiKey: "sk-secret",
      model: "text-embedding-3-small",
      dimension: 1536,
    });

    const summaries = await listVectorModelTemplates();
    expect(summaries).toHaveLength(1);
    const summary = summaries[0];
    expect(summary).toBeDefined();
    expect(summary.hasApiKey).toBe(true);
    expect("apiKey" in summary).toBe(false);
    expect(summary.apiUrl).toBe("https://api.openai.com/v1");
  });

  it("preserves the existing apiKey when saving with a blank key", async () => {
    const { saveVectorModelTemplate, listVectorModelTemplates } = await importVectorService();

    const created = await saveVectorModelTemplate({
      name: "OpenAI Embedding",
      provider: "openai",
      apiUrl: "https://api.openai.com/v1",
      apiKey: "sk-secret",
      model: "text-embedding-3-small",
      dimension: 1536,
    });

    await saveVectorModelTemplate({
      id: created.id,
      name: "OpenAI Embedding Updated",
      provider: "openai",
      apiUrl: "https://api.openai.com/v1",
      apiKey: "",
      model: "text-embedding-3-large",
      dimension: 3072,
    });

    const summaries = await listVectorModelTemplates();
    expect(summaries[0]?.hasApiKey).toBe(true);
  });

  it("syncs legacy embedding settings when selecting a template", async () => {
    const { saveVectorModelTemplate, selectVectorModelTemplate } = await importVectorService();

    const created = await saveVectorModelTemplate({
      name: "Volcengine Template",
      provider: "custom",
      customProviderName: "volcengine",
      apiUrl: "https://ark.cn-beijing.volces.com/api/v3",
      apiKey: "volc-secret",
      model: "doubao-embedding-text",
      dimension: 2048,
    });

    await selectVectorModelTemplate(created.id);

    expect(mockStore["embedding_active_template_id"]).toBe(created.id);
    expect(mockStore["embedding_provider"]).toBe("custom");
    expect(mockStore["embedding_api_url"]).toBe("https://ark.cn-beijing.volces.com/api/v3");
    expect(mockStore["embedding_api_key"]).toBe("volc-secret");
    expect(mockStore["embedding_model"]).toBe("doubao-embedding-text");
    expect(mockStore["embedding_dimension"]).toBe("2048");
  });
});

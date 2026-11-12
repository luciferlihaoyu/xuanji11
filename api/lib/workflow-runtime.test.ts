import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@db/schema";
import { systemSettings, workflowNodes, workflowRuns, workflowRunNodes, workflows } from "@db/schema";
import { getDb } from "../queries/connection";
import { executeCallAgent, executeWorkflow } from "./workflow-runtime";
import { getLastEmbeddingIdentity, HASH_FALLBACK_MODEL } from "./vector-service";
import { setEgressPolicyForTests } from "./egress";

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

vi.hoisted(() => {
  // env.ts 在模块加载时强制校验必填变量；测试进程需提供桩值
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.ADMIN_USERNAME = "test-admin";
  process.env.ADMIN_PASSWORD = "test-password-at-least-32-characters-long!!";
});

vi.mock("../queries/connection", () => ({
  getDb: vi.fn(),
  // vector-service 顶层还会用到连接层的 raw 句柄；无 sqlite 时引擎自动降级到内存实现，
  // 这里显式给出桩，避免 vitest 报 "No getRawDb export is defined on the mock"
  getRawDb: vi.fn(),
}));

// vectorize 用例需要按 key 返回 system_settings 的值：把 eq 降级成可读的 { column, value }，
// 其余 drizzle 导出保持真实实现（workflow-runtime 只用到 eq/and）。
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  };
});

function createFakeDb(server: McpServer | null) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(server ? [server] : [])),
      })),
    })),
  };
}

function installFetchMock(): FetchMock {
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function rpcResponse(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
}

function sampleServer(): McpServer {
  return {
    id: 1,
    name: "OpenCode",
    url: "https://mcp.example.test",
    authToken: "stored-token",
    enabled: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

/** McpClient 把凭据放在 Authorization: Bearer <token> 头里（api/lib/mcp-client.ts requestHeaders）。 */
function authHeaderOf(fetchMock: FetchMock, index = 0): string | undefined {
  const init = fetchMock.mock.calls[index]?.[1];
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.Authorization;
}

describe("executeCallAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the legacy placeholder when no MCP config is provided", async () => {
    // Given: an existing workflow node only names an agent.
    const config = { agentName: "legacy-agent" };

    // When: the call-agent node executes.
    const result = await executeCallAgent(config);

    // Then: the previous placeholder shape is preserved.
    expect(result.agent).toBe("legacy-agent");
    expect(typeof result.calledAt).toBe("string");
  });

  it("calls a saved MCP server when serverId and toolName are configured", async () => {
    // Given: a saved MCP server and a successful remote tool result.
    vi.mocked(getDb).mockReturnValue(createFakeDb(sampleServer()) as never);
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue(rpcResponse({ content: [{ type: "text", text: "done" }] }));

    // When: the call-agent node executes with MCP config.
    const result = await executeCallAgent({
      serverId: 1,
      toolName: "agent.run",
      arguments: { prompt: "hello" },
    });

    // Then: the real remote result is returned.
    expect(result).toEqual({ content: [{ type: "text", text: "done" }] });
    expect(fetchMock).toHaveBeenCalledWith("https://mcp.example.test", expect.objectContaining({ method: "POST" }));
  });

  // -------------------------------------------------------------------------
  // 直连 URL 优先级：前端文案是「直连 URL（可选，覆盖上方选择）」，
  // 后端必须与之一致 —— 填了直连 URL 就连直连，凭据也用直连填的那个 token。
  // -------------------------------------------------------------------------

  it("同时配 serverId 与 serverUrl 时，直连 URL 优先且凭据用节点填的 authToken", async () => {
    // Given: 服务器表里那台 url/token 与节点直连配置不同
    vi.mocked(getDb).mockReturnValue(createFakeDb(sampleServer()) as never);
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue(rpcResponse({ content: [{ type: "text", text: "direct" }] }));

    // When: 节点同时填了「MCP 服务器」和「直连 URL」
    const result = await executeCallAgent({
      serverId: 1,
      serverUrl: "https://direct.example.test/mcp",
      authToken: "node-token",
      toolName: "agent.run",
      arguments: { prompt: "hello" },
    });

    // Then: 请求真的打到直连 URL（不是服务器表里那台）
    expect(fetchMock).toHaveBeenCalledWith(
      "https://direct.example.test/mcp",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result).toEqual({ content: [{ type: "text", text: "direct" }] });

    // And: 凭据用节点填的 token，不取服务器表里的 stored-token（否则凭据错配）
    expect(authHeaderOf(fetchMock)).toBe("Bearer node-token");

    // And: 直连就是直连，不查服务器表（也就谈不上要求 serverId 必须存在）
    expect(getDb).not.toHaveBeenCalled();
  });

  it("只配 serverId（未填直连 URL）时仍连服务器表里的 url 与 token", async () => {
    // Given: 只有已注册服务器，没有直连 URL
    vi.mocked(getDb).mockReturnValue(createFakeDb(sampleServer()) as never);
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue(rpcResponse({ content: [{ type: "text", text: "stored" }] }));

    // When
    const result = await executeCallAgent({ serverId: 1, toolName: "agent.run", arguments: {} });

    // Then: 旧行为不回归
    expect(fetchMock).toHaveBeenCalledWith("https://mcp.example.test", expect.objectContaining({ method: "POST" }));
    expect(authHeaderOf(fetchMock)).toBe("Bearer stored-token");
    expect(result).toEqual({ content: [{ type: "text", text: "stored" }] });
  });

  it("填了直连 URL 而服务器表里找不到该 serverId 时，仍按直连执行", async () => {
    // Given: 表里查不到 id=999（createFakeDb(null) 返回空数组）
    vi.mocked(getDb).mockReturnValue(createFakeDb(null) as never);
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue(rpcResponse({ content: [{ type: "text", text: "direct" }] }));

    // When / Then: 不抛 "MCP server not found"，请求走直连 URL
    const result = await executeCallAgent({
      serverId: 999,
      serverUrl: "https://direct.example.test/mcp",
      toolName: "agent.run",
      arguments: {},
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://direct.example.test/mcp",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result).toEqual({ content: [{ type: "text", text: "direct" }] });
  });

  it("清空直连 URL（serverUrl 为空串）时回落到 serverId，而不是报无效配置", async () => {
    // Given: 用户在面板里清空了「直连 URL」输入框 —— 前端写入的是空串而不是删除字段
    vi.mocked(getDb).mockReturnValue(createFakeDb(sampleServer()) as never);
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue(rpcResponse({ content: [{ type: "text", text: "stored" }] }));

    // When
    const result = await executeCallAgent({ serverId: 1, serverUrl: "", toolName: "agent.run", arguments: {} });

    // Then: 空串不算「填了直连 URL」，按 serverId 走（旧实现会抛 Invalid call-agent MCP configuration）
    expect(fetchMock).toHaveBeenCalledWith("https://mcp.example.test", expect.objectContaining({ method: "POST" }));
    expect(authHeaderOf(fetchMock)).toBe("Bearer stored-token");
    expect(result).toEqual({ content: [{ type: "text", text: "stored" }] });
  });
});

describe("executeWorkflow N+1 批量化", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("N 个节点的 workflowRunNodes 逐行插入拿准确自增 id（better-sqlite3 批量 lastInsertRowid 是末行）", async () => {
    // 行为变更：MySQL 批量 insert lastInsertRowid=首行 id，SQLite 是末行——
    // 批量插会导致节点状态/输出写错行（前面节点永远 pending）。
    // 改逐行插换正确性，此测试锁定逐行语义：insert 次数 = 1(workflowRuns) + N(nodes)
    const nodes = [
      { id: 1, workflowId: 10, type: "delay", label: "A", config: { ms: 0 }, position: 0, dependsOn: null, createdAt: new Date(), updatedAt: new Date() },
      { id: 2, workflowId: 10, type: "delay", label: "B", config: { ms: 0 }, position: 1, dependsOn: null, createdAt: new Date(), updatedAt: new Date() },
      { id: 3, workflowId: 10, type: "delay", label: "C", config: { ms: 0 }, position: 2, dependsOn: null, createdAt: new Date(), updatedAt: new Date() },
    ];
    const workflow = { id: 10, name: "test", description: "", enabled: true, createdBy: null, createdAt: new Date(), updatedAt: new Date() };

    let insertCalls = 0;
    let selectCall = 0;
    const fakeDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            selectCall++;
            // 第一次 select：拿 workflow；第二次：拿 nodes
            return Promise.resolve(selectCall === 1 ? [workflow] : nodes);
          }),
        })),
      })),
      insert: vi.fn((_table: unknown) => ({
        values: vi.fn((_rows: unknown) => {
          insertCalls++;
          return Promise.resolve({ lastInsertRowid: 1000 + insertCalls });
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve()),
        })),
      })),
    };
    vi.mocked(getDb).mockReturnValue(fakeDb as never);

    await executeWorkflow(10, {});

    // 1 次 workflowRuns + 3 次 workflowRunNodes（逐行）
    expect(insertCalls).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// vectorize 节点诚实性：
//   ① 用户在下拉里选的模型必须真的发给嵌入服务（config.model 不能被静默忽略）；
//   ② 返回的 model 必须是【实际使用的模型】，不是 config 回显；
//   ③ 嵌入失败必须让节点 failed 并抛错，绝不静默返回 hash 伪向量。
// 这三个用例【不 mock vector-service】，走真实 embedTextsStrict 路径，
// 只桩掉 DB / fetch / egress 私网判定。
// ---------------------------------------------------------------------------

/** 嵌入模板候选（唯一候选：环境变量兜底的 legacy 候选在 beforeEach 里被清空，enabled=false） */
const TEMPLATE_MODEL = "provider-embed-model";
const EMBED_ENDPOINT = "https://embed.example.test/v1/embeddings";
const EMBED_VECTOR = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];

function embeddingSettingsStore(): Map<string, string> {
  return new Map<string, string>([
    [
      "embedding_model_templates",
      JSON.stringify({
        templates: [
          {
            id: "tpl-1",
            name: "测试嵌入模板",
            provider: "openai",
            apiUrl: "https://embed.example.test/v1",
            apiKey: "test-key",
            model: TEMPLATE_MODEL,
            dimension: 8,
          },
        ],
      }),
    ],
    ["embedding_active_template_id", "tpl-1"],
  ]);
}

interface CapturedWrite {
  readonly table: unknown;
  readonly values: Record<string, unknown>;
}

/** 一个既能喂 executeWorkflow、又能喂 vector-service 读设置的极简假库。 */
function createVectorizeDb(config: Record<string, unknown>, settings: Map<string, string>) {
  const writes: CapturedWrite[] = [];
  let insertCount = 0;
  const workflow = { id: 10, name: "vectorize-flow", description: "", enabled: true, createdBy: null, createdAt: new Date(), updatedAt: new Date() };
  const nodes = [
    {
      id: 1,
      workflowId: 10,
      type: "vectorize",
      label: "向量化",
      config,
      connections: [] as unknown[],
      position: 0,
      dependsOn: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: (condition?: { value?: unknown }) => {
          if (table === systemSettings) {
            const key = typeof condition?.value === "string" ? condition.value : "";
            const value = settings.get(key);
            return Promise.resolve(value === undefined ? [] : [{ key, value }]);
          }
          if (table === workflows) return Promise.resolve([workflow]);
          if (table === workflowNodes) return Promise.resolve(nodes);
          return Promise.resolve([]);
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        insertCount += 1;
        writes.push({ table, values });
        return Promise.resolve({ lastInsertRowid: 1000 + insertCount });
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          writes.push({ table, values });
          return Promise.resolve();
        },
      }),
    }),
  };

  return { db, writes };
}

function nodeStatusUpdates(writes: CapturedWrite[]): CapturedWrite[] {
  return writes.filter((w) => w.table === workflowRunNodes && typeof w.values.status === "string");
}

function lastNodeStatusUpdate(writes: CapturedWrite[]): CapturedWrite | undefined {
  return nodeStatusUpdates(writes).at(-1);
}

async function runVectorizeWorkflow(config: Record<string, unknown>): Promise<CapturedWrite[]> {
  const { db, writes } = createVectorizeDb(config, embeddingSettingsStore());
  vi.mocked(getDb).mockReturnValue(db as never);
  await executeWorkflow(10, {});
  return writes;
}

function quickEmbeddingResponse(): Response {
  return new Response(JSON.stringify({ data: [{ embedding: EMBED_VECTOR, index: 0 }] }));
}

function requestBodyOf(fetchMock: FetchMock, index = 0): { model?: string } {
  const init = fetchMock.mock.calls[index]?.[1];
  return JSON.parse(String(init?.body)) as { model?: string };
}

describe("vectorize 节点：模型真实生效 + 嵌入失败必须 failed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 嵌入端点用公网域名：放开 admin 私网判定，避免测试进程做真实 DNS
    setEgressPolicyForTests(async () => true);
    // 去掉环境变量兜底的嵌入配置，保证候选只有测试模板一个（否则会多打一次 fetch）
    delete process.env.LLM_API_URL;
    delete process.env.LLM_API_KEY;
    delete process.env.EMBEDDING_MODEL;
    delete process.env.TIANSHU_API_KEY;
    delete process.env.TIANSHU_EMBEDDING_MODEL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("采用 config.model：嵌入请求实际收到 my-embed-model，返回的 model 是实际使用的模型", async () => {
    // Given: 用户在下拉里选了 my-embed-model，嵌入服务正常
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue(quickEmbeddingResponse());

    // When: vectorize 节点执行
    const writes = await runVectorizeWorkflow({ text: "土地管理法规定土地使用权可以依法转让", model: "my-embed-model" });

    // Then: 嵌入请求真的带上了用户选的模型（不是全局默认 provider-embed-model）
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(EMBED_ENDPOINT);
    expect(requestBodyOf(fetchMock).model).toBe("my-embed-model");

    // And: 返回的 model 是实际使用的模型，维度取自真实向量
    expect(lastNodeStatusUpdate(writes)?.values.output).toEqual({
      model: "my-embed-model",
      dimensions: EMBED_VECTOR.length,
      vectorized: true,
    });
  });

  it("嵌入失败时节点 failed、抛出原始错误，且绝不产出 hash 伪向量", async () => {
    // Given: 嵌入服务 500
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue(new Response("", { status: 500 }));

    // When: vectorize 节点执行
    const writes = await runVectorizeWorkflow({ text: "任意文本" });

    // Then: 节点标记失败，运行整体失败
    expect(lastNodeStatusUpdate(writes)?.values.status).toBe("failed");
    expect(writes.filter((w) => w.table === workflowRuns).at(-1)?.values.status).toBe("failed");

    // And: 运行记录里的错误能看懂（含嵌入服务错误原文），不是含糊的 "Internal workflow error"
    expect(String(lastNodeStatusUpdate(writes)?.values.error)).toContain("Embedding API 500");

    // And: 任何一次节点写入都不含 vectorized: true（不许假装成功）
    const pretendedSuccess = nodeStatusUpdates(writes).some(
      (w) => (w.values.output as Record<string, unknown> | undefined)?.vectorized === true,
    );
    expect(pretendedSuccess).toBe(false);

    // And: 没有走 hash 兜底（身份没被写成 __hash_fallback__）
    expect(getLastEmbeddingIdentity()?.model).not.toBe(HASH_FALLBACK_MODEL);
  });

  it("config.model 缺省时不覆盖候选模型名（用系统默认嵌入模型）", async () => {
    // Given: 节点没配模型，嵌入服务正常
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue(quickEmbeddingResponse());

    // When: vectorize 节点执行
    const writes = await runVectorizeWorkflow({ text: "任意文本" });

    // Then: 请求用的是候选配置原值
    expect(requestBodyOf(fetchMock).model).toBe(TEMPLATE_MODEL);

    // And: 返回的 model 是候选里真正的模型名（config 里没有 model，回显旧实现会是 undefined）
    expect(lastNodeStatusUpdate(writes)?.values.output).toEqual({
      model: TEMPLATE_MODEL,
      dimensions: EMBED_VECTOR.length,
      vectorized: true,
    });
  });
});

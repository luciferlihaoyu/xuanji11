import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@db/schema";
import { getDb } from "../queries/connection";
import { executeCallAgent, executeWorkflow } from "./workflow-runtime";

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

vi.hoisted(() => {
  // env.ts 在模块加载时强制校验必填变量；测试进程需提供桩值
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.ADMIN_USERNAME = "test-admin";
  process.env.ADMIN_PASSWORD = "test-password-at-least-32-characters-long!!";
});

vi.mock("../queries/connection", () => ({
  getDb: vi.fn(),
}));

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

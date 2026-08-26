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

  it("N 个节点的 workflowRunNodes 走单次 batch insert（不是 N 次）", async () => {
    // 构造一个 3 节点的工作流：delay → delay → delay（无依赖循环，topological 顺序稳定）
    const nodes = [
      { id: 1, workflowId: 10, type: "delay", label: "A", config: { ms: 0 }, position: 0, dependsOn: null, createdAt: new Date(), updatedAt: new Date() },
      { id: 2, workflowId: 10, type: "delay", label: "B", config: { ms: 0 }, position: 1, dependsOn: null, createdAt: new Date(), updatedAt: new Date() },
      { id: 3, workflowId: 10, type: "delay", label: "C", config: { ms: 0 }, position: 2, dependsOn: null, createdAt: new Date(), updatedAt: new Date() },
    ];
    const workflow = { id: 10, name: "test", description: "", enabled: true, createdBy: null, createdAt: new Date(), updatedAt: new Date() };

    let insertCalls = 0;
    let lastInsertRows: unknown[] = [];
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
        values: vi.fn((rows: unknown) => {
          insertCalls++;
          if (Array.isArray(rows)) {
            lastInsertRows = rows;
            return Promise.resolve([{ insertId: 1000 }]);
          }
          lastInsertRows = [rows];
          return Promise.resolve([{ insertId: 1000 + insertCalls }]);
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

    // 第一次 insert：workflowRuns（单条），第二次：workflowRunNodes batch
    expect(insertCalls).toBe(2);
    // 第二次的 rows 是数组且长度 = 节点数（=3）
    expect(Array.isArray(lastInsertRows)).toBe(true);
    expect((lastInsertRows as unknown[]).length).toBe(3);
  });
});

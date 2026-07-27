import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@db/schema";
import { getDb } from "../queries/connection";
import { executeCallAgent } from "./workflow-runtime";

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

vi.hoisted(() => {
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
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

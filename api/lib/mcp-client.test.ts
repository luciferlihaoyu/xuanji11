import { afterEach, describe, expect, it, vi } from "vitest";
import { McpClient, McpError } from "./mcp-client";

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function installFetchMock(): FetchMock {
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function rpcResponse(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
}

function requestHeaders(fetchMock: FetchMock, callIndex: number): Headers {
  const call = fetchMock.mock.calls[callIndex];
  if (!call) throw new Error("fetch was not called");
  const init = call[1];
  if (!init?.headers) throw new Error("fetch headers were not set");
  return new Headers(init.headers);
}

describe("McpClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses initialize from a plain JSON response", async () => {
    // Given: a remote MCP server returns the standard initialize envelope.
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue(rpcResponse({
      protocolVersion: "2024-11-05",
      serverInfo: { name: "opencode", version: "1.2.3" },
    }));

    // When: the client initializes against the server.
    const serverInfo = await new McpClient({ url: "https://mcp.example.test" }).initialize();

    // Then: the nested serverInfo is normalized for callers.
    expect(serverInfo).toEqual({ name: "opencode", version: "1.2.3", protocolVersion: "2024-11-05" });
  });

  it("parses listTools from an SSE data frame", async () => {
    // Given: a remote MCP server frames the JSON-RPC payload as server-sent events.
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue(new Response([
      "event: message",
      'data: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"agent.run","description":"Run an agent","inputSchema":{"type":"object"}}]}}',
      "",
    ].join("\n")));

    // When: tools are listed.
    const tools = await new McpClient({ url: "https://mcp.example.test" }).listTools();

    // Then: only the data frame is parsed as JSON-RPC.
    expect(tools).toEqual([
      { name: "agent.run", description: "Run an agent", inputSchema: { type: "object" } },
    ]);
  });

  it("throws McpError when callTool receives a JSON-RPC error", async () => {
    // Given: the remote tool call fails with a JSON-RPC error object.
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32001, message: "Denied", data: { reason: "missing scope" } },
    })));

    // When / Then: the domain error preserves code, message, and data.
    const call = new McpClient({ url: "https://mcp.example.test" }).callTool("agent.run", {});
    await expect(call).rejects.toMatchObject({
      code: -32001,
      message: "Denied",
      data: { reason: "missing scope" },
    });
    await expect(call).rejects.toBeInstanceOf(McpError);
  });

  it("sets Authorization only when authToken is configured", async () => {
    // Given: two clients, one authenticated and one anonymous.
    const fetchMock = installFetchMock();
    fetchMock.mockImplementation(async () => rpcResponse({ serverInfo: { name: "server", version: "1" } }));

    // When: both clients initialize.
    await new McpClient({ url: "https://mcp.example.test", authToken: "secret-token" }).initialize();
    await new McpClient({ url: "https://mcp.example.test" }).initialize();

    // Then: only the authenticated request carries a bearer token.
    expect(requestHeaders(fetchMock, 0).get("Authorization")).toBe("Bearer secret-token");
    expect(requestHeaders(fetchMock, 1).has("Authorization")).toBe(false);
  });

  it("sends a complete initialize handshake for strict MCP servers", async () => {
    // Given: a strict server (e.g. Dify) that rejects initialize without params.
    const fetchMock = installFetchMock();
    fetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { params?: Record<string, unknown> };
      const params = body.params;
      if (!params || !params.protocolVersion || !params.clientInfo) {
        return new Response(JSON.stringify({
          jsonrpc: "2.0", id: 1,
          error: { code: -32602, message: "Invalid params" },
        }));
      }
      return rpcResponse({
        protocolVersion: String(params.protocolVersion),
        serverInfo: { name: "dify", version: "1.0.0" },
      });
    });

    // When: the client initializes without an explicit protocol version.
    const info = await new McpClient({ url: "https://mcp.example.test" }).initialize();

    // Then: initialize succeeds and the full params were sent.
    expect(info).toEqual({ name: "dify", version: "1.0.0", protocolVersion: "2025-06-18" });
    const sentBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}")) as {
      params: Record<string, unknown>;
    };
    expect(sentBody.params).toEqual({
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "xuanji", version: "0.0.0" },
    });
  });

  it("advertises the MCP protocol version header on requests", async () => {
    // Given: a remote MCP server.
    const fetchMock = installFetchMock();
    fetchMock.mockImplementation(async () => rpcResponse({ tools: [] }));

    // When: a request is made with an explicit protocol version.
    await new McpClient({ url: "https://mcp.example.test", protocolVersion: "2025-03-26" }).listTools();

    // Then: the header carries that version; the default is used otherwise.
    expect(requestHeaders(fetchMock, 0).get("MCP-Protocol-Version")).toBe("2025-03-26");

    await new McpClient({ url: "https://mcp.example.test" }).listTools();
    expect(requestHeaders(fetchMock, 1).get("MCP-Protocol-Version")).toBe("2025-06-18");
  });
});

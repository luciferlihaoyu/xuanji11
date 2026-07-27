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
});

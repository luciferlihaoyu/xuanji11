import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@db/schema";
import { mcpServers } from "@db/schema";
import type { TrpcContext } from "./context";
import { getDb } from "./queries/connection";
import { sessionAuth } from "./lib/auth";
import { mcpClientRouter } from "./mcp-client-router";

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;
type McpServerRow = typeof mcpServers.$inferSelect;

vi.hoisted(() => {
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "correct-password";
  process.env.DATABASE_URL = "mysql://user:password@example.test:3306/xuanji";
  process.env.JWT_SECRET = "fixed-test-jwt-secret-with-32-chars";
});

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./lib/vector", () => ({
  vectorEngine: { size: 0 },
  initializeZvec: vi.fn(),
}));

vi.mock("./lib/vector-service", () => ({
  listCollections: vi.fn(),
  addDocumentsToCollection: vi.fn(),
  deleteCollection: vi.fn(),
  embedTexts: vi.fn(),
  searchVectors: vi.fn(),
  getStats: vi.fn(),
  initializeZvec: vi.fn(),
  vectorEngine: { size: 0 },
}));

function fakeUser(): User {
  return {
    id: 1,
    unionId: "local_admin",
    name: "admin",
    email: null,
    avatar: null,
    role: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignInAt: new Date(),
  };
}

function fakeContext(): TrpcContext {
  const user = fakeUser();
  return {
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
    user,
    auth: sessionAuth(user),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordFrom(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new Error("expected record value");
}

function createFakeDb(seed: readonly McpServerRow[] = []) {
  const rows = seed.map((row) => ({ ...row }));
  let nextId = rows.reduce((maxId, row) => Math.max(maxId, row.id), 0) + 1;
  const readRows = () => rows.map((row) => ({ ...row }));

  return {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        orderBy: vi.fn(() => Promise.resolve(table === mcpServers ? readRows() : [])),
        where: vi.fn(() => Promise.resolve(table === mcpServers ? readRows() : [])),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: unknown) => {
        const insertId = nextId;
        nextId += 1;
        if (table === mcpServers) {
          const record = recordFrom(value);
          rows.push({
            id: insertId,
            name: String(record.name),
            url: String(record.url),
            authToken: typeof record.authToken === "string" ? record.authToken : null,
            enabled: typeof record.enabled === "boolean" ? record.enabled : true,
            createdAt: new Date("2026-01-01T00:00:00Z"),
            updatedAt: new Date("2026-01-01T00:00:00Z"),
          });
        }
        return Promise.resolve([{ insertId }]);
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve()),
    })),
  };
}

function rpcResponse(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
}

function installFetchMock(): FetchMock {
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("mcpClientRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(createFakeDb() as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists remote tools from an ad-hoc MCP server URL", async () => {
    // Given: a remote server exposes one callable tool.
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue(rpcResponse({ tools: [{ name: "agent.run", description: "Run" }] }));

    // When: an authenticated user lists remote tools without saving the server.
    const tools = await mcpClientRouter.createCaller(fakeContext()).listRemoteTools({
      url: "https://mcp.example.test",
      authToken: "test-token",
    });

    // Then: the tRPC procedure returns the remote MCP tool definitions.
    expect(tools).toEqual([{ name: "agent.run", description: "Run" }]);
  });

  it("creates and lists saved servers without leaking authToken", async () => {
    // Given: an empty MCP server table.
    const fakeDb = createFakeDb();
    vi.mocked(getDb).mockReturnValue(fakeDb as never);
    const caller = mcpClientRouter.createCaller(fakeContext());

    // When: an admin saves a server and lists configured servers.
    const created = await caller.create({
      name: "OpenCode",
      url: "https://mcp.example.test",
      authToken: "stored-token-1234",
    });
    const servers = await caller.list();

    // Then: the token is represented only by metadata.
    expect(created.id).toBe(1);
    expect(servers).toHaveLength(1);
    const [server] = servers;
    if (!server) throw new Error("server row missing");
    expect(server).toMatchObject({ id: 1, name: "OpenCode", hasToken: true, authTokenLast4: "1234" });
    expect(server).not.toHaveProperty("authToken");
  });

  it("returns serverInfo when testConnection succeeds", async () => {
    // Given: the remote initialize call succeeds.
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue(rpcResponse({
      protocolVersion: "2024-11-05",
      serverInfo: { name: "openclaw", version: "2.0.0" },
    }));

    // When: an admin tests the connection.
    const result = await mcpClientRouter.createCaller(fakeContext()).testConnection({ url: "https://mcp.example.test" });

    // Then: normalized server info is returned.
    expect(result).toEqual({ name: "openclaw", version: "2.0.0", protocolVersion: "2024-11-05" });
  });

  it("throws a tRPC-friendly error when testConnection fails", async () => {
    // Given: the remote initialize call returns a JSON-RPC failure.
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "Remote denied" },
    })));

    // When / Then: the procedure surfaces the message as a BAD_REQUEST.
    await expect(
      mcpClientRouter.createCaller(fakeContext()).testConnection({ url: "https://mcp.example.test" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Remote denied" });
  });

  it("calls a remote tool through a saved server", async () => {
    // Given: a saved MCP server and a successful remote tool response.
    vi.mocked(getDb).mockReturnValue(createFakeDb([
      {
        id: 7,
        name: "OpenCode",
        url: "https://mcp.example.test",
        authToken: "stored-token",
        enabled: true,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]) as never);
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue(rpcResponse({ content: [{ type: "text", text: "done" }] }));

    // When: an admin calls the remote tool through the router.
    const result = await mcpClientRouter.createCaller(fakeContext()).callRemoteTool({
      serverId: 7,
      toolName: "agent.run",
      arguments: { prompt: "hello" },
    });

    // Then: the remote JSON-RPC result is returned unchanged.
    expect(result).toEqual({ content: [{ type: "text", text: "done" }] });
    expect(fetchMock).toHaveBeenCalledWith("https://mcp.example.test", expect.objectContaining({ method: "POST" }));
  });
});

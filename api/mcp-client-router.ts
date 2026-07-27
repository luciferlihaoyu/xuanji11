import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { mcpServers, type McpServer } from "@db/schema";
import { createRouter, adminQuery, scopedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { clean } from "./lib/clean";
import { logAudit } from "./lib/audit";
import { McpClient, type McpServerConfig } from "./lib/mcp-client";

type PublicMcpServer = {
  readonly id: number;
  readonly name: string;
  readonly url: string;
  readonly enabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly hasToken: boolean;
  readonly authTokenLast4?: string;
};

const createInputSchema = z.object({
  name: z.string().min(1).max(255),
  url: z.string().url().max(2048),
  authToken: z.string().max(4096).optional(),
  enabled: z.boolean().optional(),
});

const updateInputSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).max(255).optional(),
  url: z.string().url().max(2048).optional(),
  authToken: z.string().max(4096).optional(),
  enabled: z.boolean().optional(),
});

const idInputSchema = z.object({ id: z.number().int().positive() });

const testConnectionInputSchema = z.object({
  url: z.string().url().max(2048),
  authToken: z.string().max(4096).optional(),
});

const remoteToolsInputSchema = z.union([
  z.object({ serverId: z.number().int().positive() }),
  testConnectionInputSchema,
]);

const callRemoteToolInputSchema = z.object({
  serverId: z.number().int().positive(),
  toolName: z.string().min(1).max(255),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

type CreateInput = z.infer<typeof createInputSchema>;
type UpdateInput = z.infer<typeof updateInputSchema>;
type RemoteToolsInput = z.infer<typeof remoteToolsInputSchema>;
type TestConnectionInput = z.infer<typeof testConnectionInputSchema>;

function normalizeAuthToken(authToken: string | undefined): string | null {
  if (authToken === undefined || authToken.length === 0) return null;
  return authToken;
}

function authTokenLast4(authToken: string | null): string | undefined {
  return authToken ? authToken.slice(-4) : undefined;
}

function serializeServer(server: McpServer): PublicMcpServer {
  return {
    id: server.id,
    name: server.name,
    url: server.url,
    enabled: server.enabled,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
    hasToken: server.authToken !== null && server.authToken.length > 0,
    authTokenLast4: authTokenLast4(server.authToken),
  };
}

function auditDetails(input: CreateInput | UpdateInput): Record<string, unknown> {
  return clean({
    id: "id" in input ? input.id : undefined,
    name: input.name,
    url: input.url,
    enabled: input.enabled,
    hasToken: input.authToken === undefined ? undefined : normalizeAuthToken(input.authToken) !== null,
  });
}

function configFromDirectInput(input: TestConnectionInput): McpServerConfig {
  const authToken = normalizeAuthToken(input.authToken);
  return authToken ? { url: input.url, authToken } : { url: input.url };
}

function configFromServer(server: McpServer): McpServerConfig {
  return server.authToken ? { url: server.url, authToken: server.authToken } : { url: server.url };
}

function connectionErrorMessage(caught: unknown): string {
  if (caught instanceof Error && caught.message.length > 0) return caught.message;
  return "MCP request failed";
}

async function getServerById(id: number): Promise<McpServer> {
  const [server] = await getDb().select().from(mcpServers).where(eq(mcpServers.id, id));
  if (!server) {
    throw new TRPCError({ code: "NOT_FOUND", message: "MCP server not found" });
  }
  if (!server.enabled) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "MCP server is disabled" });
  }
  return server;
}

async function clientFromRemoteInput(input: RemoteToolsInput): Promise<McpClient> {
  if ("serverId" in input) {
    return new McpClient(configFromServer(await getServerById(input.serverId)));
  }
  return new McpClient(configFromDirectInput(input));
}

export const mcpClientRouter = createRouter({
  list: scopedQuery("agents:read").query(async () => {
    const servers = await getDb().select().from(mcpServers).orderBy(desc(mcpServers.updatedAt));
    return servers.map(serializeServer);
  }),

  getById: scopedQuery("agents:read")
    .input(idInputSchema)
    .query(async ({ input }) => {
      const [server] = await getDb().select().from(mcpServers).where(eq(mcpServers.id, input.id));
      return server ? serializeServer(server) : null;
    }),

  create: adminQuery
    .input(createInputSchema)
    .mutation(async ({ input, ctx }) => {
      const result = await getDb().insert(mcpServers).values(clean({
        name: input.name,
        url: input.url,
        authToken: normalizeAuthToken(input.authToken),
        enabled: input.enabled ?? true,
      }));
      const id = Number(result[0].insertId);
      await logAudit(ctx, "mcp_server", "create", id, auditDetails(input));
      return { id };
    }),

  update: adminQuery
    .input(updateInputSchema)
    .mutation(async ({ input, ctx }) => {
      const { id, ...data } = input;
      await getDb().update(mcpServers).set(clean({
        name: data.name,
        url: data.url,
        authToken: data.authToken === undefined ? undefined : normalizeAuthToken(data.authToken),
        enabled: data.enabled,
      })).where(eq(mcpServers.id, id));
      await logAudit(ctx, "mcp_server", "update", id, auditDetails(input));
      return { success: true };
    }),

  delete: adminQuery
    .input(idInputSchema)
    .mutation(async ({ input, ctx }) => {
      await getDb().delete(mcpServers).where(eq(mcpServers.id, input.id));
      await logAudit(ctx, "mcp_server", "delete", input.id, input);
      return { success: true };
    }),

  testConnection: adminQuery
    .input(testConnectionInputSchema)
    .mutation(async ({ input }) => {
      try {
        return await new McpClient(configFromDirectInput(input)).initialize();
      } catch (caught) {
        throw new TRPCError({ code: "BAD_REQUEST", message: connectionErrorMessage(caught) });
      }
    }),

  listRemoteTools: scopedQuery("agents:read")
    .input(remoteToolsInputSchema)
    .query(async ({ input }) => {
      const client = await clientFromRemoteInput(input);
      try {
        return await client.listTools();
      } catch (caught) {
        throw new TRPCError({ code: "BAD_REQUEST", message: connectionErrorMessage(caught) });
      }
    }),

  callRemoteTool: adminQuery
    .input(callRemoteToolInputSchema)
    .mutation(async ({ input }) => {
      const server = await getServerById(input.serverId);
      try {
        return await new McpClient(configFromServer(server)).callTool(input.toolName, input.arguments);
      } catch (caught) {
        throw new TRPCError({ code: "BAD_REQUEST", message: connectionErrorMessage(caught) });
      }
    }),
});

import { z } from "zod";

const DEFAULT_TIMEOUT_MS = 30_000;
const LATEST_PROTOCOL_VERSION = "2025-06-18";
const CLIENT_NAME = "xuanji";
const CLIENT_VERSION = "0.0.0";

export interface McpServerConfig {
  readonly url: string;
  readonly authToken?: string;
  readonly timeoutMs?: number;
  readonly protocolVersion?: string;
}

export interface McpToolDef {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

export interface McpServerInfo {
  readonly name: string;
  readonly version: string;
  readonly protocolVersion?: string;
}

export class McpError extends Error {
  readonly name = "McpError";
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

type JsonRpcMethod = "initialize" | "tools/list" | "tools/call";

type ParsedJsonRpcResponse =
  | { readonly kind: "success"; readonly result: unknown }
  | { readonly kind: "error"; readonly code: number; readonly message: string; readonly data?: unknown };

const jsonRpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});

const jsonRpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number(), z.string(), z.null()]).optional(),
  result: z.unknown().optional(),
  error: jsonRpcErrorSchema.optional(),
});

const mcpToolDefSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: z.unknown().optional(),
});

const toolsListResultSchema = z.object({
  tools: z.array(mcpToolDefSchema),
});

const serverInfoSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  protocolVersion: z.string().optional(),
});

const initializeResultSchema = z.union([
  serverInfoSchema,
  z.object({
    protocolVersion: z.string().optional(),
    serverInfo: z.object({
      name: z.string().min(1),
      version: z.string().min(1),
    }),
  }),
]);

function parseResponsePayload(text: string): unknown {
  const lines = text.split(/\r?\n/);
  const dataLines = lines.filter((line) => line.startsWith("data:"));
  const payload = dataLines.length > 0
    ? dataLines.map((line) => line.replace(/^data:\s*/, "")).join("")
    : text;
  return JSON.parse(payload);
}

function parseJsonRpcResponse(payload: unknown): ParsedJsonRpcResponse {
  const response = jsonRpcResponseSchema.parse(payload);
  if (response.error !== undefined) {
    return { kind: "error", ...response.error };
  }
  if ("result" in response) {
    return { kind: "success", result: response.result };
  }
  throw new McpError(-32603, "JSON-RPC response did not include result or error");
}

function parseRpcText(text: string): ParsedJsonRpcResponse {
  try {
    return parseJsonRpcResponse(parseResponsePayload(text));
  } catch (caught) {
    if (caught instanceof McpError) throw caught;
    if (caught instanceof z.ZodError) {
      throw new McpError(-32603, "Invalid JSON-RPC response", caught.issues);
    }
    if (caught instanceof SyntaxError) {
      throw new McpError(-32700, "Invalid JSON response", caught.message);
    }
    throw caught;
  }
}

function requestHeaders(authToken: string | undefined, protocolVersion: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": protocolVersion,
  };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  return headers;
}

export class McpClient {
  private readonly config: McpServerConfig;
  private requestId = 1;

  constructor(config: McpServerConfig) {
    this.config = config;
  }

  private get protocolVersion(): string {
    return this.config.protocolVersion ?? LATEST_PROTOCOL_VERSION;
  }

  async initialize(): Promise<McpServerInfo> {
    const result = await this.request("initialize", {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
    });
    const parsed = initializeResultSchema.parse(result);
    if ("serverInfo" in parsed) {
      return {
        name: parsed.serverInfo.name,
        version: parsed.serverInfo.version,
        protocolVersion: parsed.protocolVersion,
      };
    }
    return parsed;
  }

  async listTools(): Promise<readonly McpToolDef[]> {
    const result = await this.request("tools/list", {});
    return toolsListResultSchema.parse(result).tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args });
  }

  private async request(method: JsonRpcMethod, params: Record<string, unknown>): Promise<unknown> {
    const id = this.requestId;
    this.requestId += 1;
    const response = await fetch(this.config.url, {
      method: "POST",
      headers: requestHeaders(this.config.authToken, this.protocolVersion),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new McpError(-32000, `HTTP ${response.status}: ${text || response.statusText}`);
    }
    const rpcResponse = parseRpcText(text);
    if (rpcResponse.kind === "error") {
      throw new McpError(rpcResponse.code, rpcResponse.message, rpcResponse.data);
    }
    return rpcResponse.result;
  }
}

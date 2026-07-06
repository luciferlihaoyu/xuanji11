import { trpc } from "@/providers/trpc";
import type { Agent, AgentPermission, AgentStatus, AgentType } from "@/store/useAppStore";

type CreateAgentInput = Omit<Agent, "id" | "status" | "lastHeartbeat"> & {
  readonly status?: AgentStatus;
  readonly config?: Record<string, unknown>;
};

export interface UiAgent extends Agent {
  config: Record<string, unknown>;
}

function toUiAgent(dbAgent: {
  id: number;
  name: string;
  description: string | null;
  type: AgentType;
  status: AgentStatus;
  updatedAt: Date | string;
  config: Record<string, unknown> | null;
  permissions: Record<string, unknown> | null;
}): UiAgent {
  const config = (dbAgent.config || {}) as Record<string, unknown>;
  const perms = (dbAgent.permissions || {}) as Record<string, unknown>;

  return {
    id: String(dbAgent.id),
    name: dbAgent.name,
    type: dbAgent.type,
    role: dbAgent.description || "助手",
    department: String(config.department || "技术部"),
    platform: String(config.platform || "天宫"),
    status: dbAgent.status,
    lastHeartbeat:
      typeof dbAgent.updatedAt === "string"
        ? new Date(dbAgent.updatedAt).toLocaleString("zh-CN", {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })
        : dbAgent.updatedAt instanceof Date
          ? dbAgent.updatedAt.toLocaleString("zh-CN", {
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })
          : "刚刚",
    capabilities: Array.isArray(config.capabilities)
      ? (config.capabilities as string[])
      : ["知识管理"],
    avatar: dbAgent.name?.charAt(0) || "A",
    knowledgeAccess: String(config.knowledgeAccess || "指定文件夹"),
    permissions: {
      read: perms.read !== false,
      write: perms.write !== false,
      delete: perms.delete === true,
      manage: perms.manage === true,
      triggerWorkflow: perms.triggerWorkflow !== false,
      executeWorkflow: perms.executeWorkflow !== false,
      designWorkflow: perms.designWorkflow === true,
    },
    abilities: (config.abilities as unknown as { knowledge: number; creation: number; coding: number; analysis: number; communication: number; learning: number } | undefined) || {
      knowledge: 70,
      creation: 60,
      coding: 50,
      analysis: 60,
      communication: 70,
      learning: 65,
    },
    config: dbAgent.config || {},
  };
}

function toCreateInput(
  data: CreateAgentInput,
) {
  const config: Record<string, unknown> = {
    department: data.department,
    platform: data.platform,
    capabilities: data.capabilities,
    abilities: data.abilities,
    knowledgeAccess: data.knowledgeAccess,
    ...(data.config || {}),
  };

  return {
    name: data.name,
    description: data.role,
    type: data.type,
    status: data.status ?? "active",
    config,
    permissions: data.permissions as unknown as Record<string, unknown>,
  };
}

function toUpdateInput(
  id: string,
  updates: Partial<Agent> & { config?: Record<string, unknown> },
) {
  const config: Record<string, unknown> = {
    ...(updates.department !== undefined
      ? { department: updates.department }
      : {}),
    ...(updates.platform !== undefined ? { platform: updates.platform } : {}),
    ...(updates.capabilities !== undefined
      ? { capabilities: updates.capabilities }
      : {}),
    ...(updates.abilities !== undefined
      ? { abilities: updates.abilities }
      : {}),
    ...(updates.knowledgeAccess !== undefined
      ? { knowledgeAccess: updates.knowledgeAccess }
      : {}),
    ...(updates.config || {}),
  };

  const hasConfig = Object.keys(config).length > 0;

  return {
    id: Number(id),
    name: updates.name,
    description: updates.role,
    type: updates.type,
    status: updates.status,
    config: hasConfig ? config : undefined,
    permissions: updates.permissions as unknown as Record<string, unknown> | undefined,
  };
}

export function useAgents() {
  const utils = trpc.useUtils();

  const listQuery = trpc.agent.list.useQuery({});
  const createMutation = trpc.agent.create.useMutation({
    onSuccess: () => utils.agent.list.invalidate(),
  });
  const updateMutation = trpc.agent.update.useMutation({
    onSuccess: () => {
      utils.agent.list.invalidate();
    },
  });
  const deleteMutation = trpc.agent.delete.useMutation({
    onSuccess: () => utils.agent.list.invalidate(),
  });
  const updatePermissionsMutation = trpc.agent.updatePermissions.useMutation({
    onSuccess: () => utils.agent.list.invalidate(),
  });
  const testLlmMutation = trpc.agent.testLlmConnection.useMutation();

  return {
    agents: (listQuery.data ?? []).map(toUiAgent),
    isLoading: listQuery.isLoading,
    create: async (
      data: CreateAgentInput,
    ) => {
      return createMutation.mutateAsync(toCreateInput(data));
    },
    update: async (
      id: string,
      updates: Partial<Agent> & { config?: Record<string, unknown> },
    ) => {
      return updateMutation.mutateAsync(toUpdateInput(id, updates));
    },
    delete: async (id: string) => {
      return deleteMutation.mutateAsync({ id: Number(id) });
    },
    updatePermissions: async (id: string, permissions: AgentPermission) => {
      return updatePermissionsMutation.mutateAsync({
        id: Number(id),
        permissions: permissions as unknown as Record<string, unknown>,
      });
    },
    testLlmConnection: async (params: {
      apiUrl: string;
      apiKey: string;
      model?: string;
    }) => {
      return testLlmMutation.mutateAsync(params);
    },
    isCreating: createMutation.isPending,
    isUpdating: updateMutation.isPending,
    isDeleting: deleteMutation.isPending,
    isUpdatingPermissions: updatePermissionsMutation.isPending,
    isTestingLlm: testLlmMutation.isPending,
  };
}

export function useAgent(id: string | number | null) {
  const numericId = typeof id === "string" ? Number(id) : id;
  return trpc.agent.getById.useQuery(
    { id: numericId! },
    { enabled: numericId !== null && !Number.isNaN(numericId) },
  );
}

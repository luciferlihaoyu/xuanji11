import { trpc } from "@/providers/trpc";

export function useAgents() {
  const utils = trpc.useUtils();

  const listQuery = trpc.agent.list.useQuery({});
  const createMutation = trpc.agent.create.useMutation({
    onSuccess: () => utils.agent.list.invalidate(),
  });
  const updateMutation = trpc.agent.update.useMutation({
    onSuccess: () => utils.agent.list.invalidate(),
  });
  const deleteMutation = trpc.agent.delete.useMutation({
    onSuccess: () => utils.agent.list.invalidate(),
  });
  const updatePermissionsMutation = trpc.agent.updatePermissions.useMutation({
    onSuccess: () => utils.agent.list.invalidate(),
  });

  return {
    agents: listQuery.data ?? [],
    isLoading: listQuery.isLoading,
    create: createMutation.mutateAsync,
    update: updateMutation.mutateAsync,
    delete: deleteMutation.mutateAsync,
    updatePermissions: updatePermissionsMutation.mutateAsync,
    isCreating: createMutation.isPending,
    isUpdating: updateMutation.isPending,
    isDeleting: deleteMutation.isPending,
  };
}

export function useAgent(id: number) {
  return trpc.agent.getById.useQuery({ id });
}

import { trpc } from "@/providers/trpc";

export function useDataSources() {
  const utils = trpc.useUtils();

  const listQuery = trpc.datasource.list.useQuery();
  const createMutation = trpc.datasource.create.useMutation({
    onSuccess: () => utils.datasource.list.invalidate(),
  });
  const updateMutation = trpc.datasource.update.useMutation({
    onSuccess: () => utils.datasource.list.invalidate(),
  });
  const deleteMutation = trpc.datasource.delete.useMutation({
    onSuccess: () => utils.datasource.list.invalidate(),
  });
  const testConnectionMutation = trpc.datasource.testConnection.useMutation({
    onSuccess: () => utils.datasource.list.invalidate(),
  });
  const syncMutation = trpc.datasource.sync.useMutation({
    onSuccess: () => utils.datasource.list.invalidate(),
  });

  return {
    dataSources: listQuery.data ?? [],
    isLoading: listQuery.isLoading,
    create: createMutation.mutateAsync,
    update: updateMutation.mutateAsync,
    delete: deleteMutation.mutateAsync,
    testConnection: testConnectionMutation.mutateAsync,
    sync: syncMutation.mutateAsync,
    isTesting: testConnectionMutation.isPending,
    isSyncing: syncMutation.isPending,
  };
}

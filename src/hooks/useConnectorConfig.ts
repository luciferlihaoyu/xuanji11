import { trpc } from "@/providers/trpc";
import { useCallback } from "react";

export function useConnectorConfig(platform: string) {
  const utils = trpc.useUtils();

  const configQuery = trpc.connector.getConfig.useQuery(
    { platform },
    { enabled: Boolean(platform) }
  );

  const saveMutation = trpc.connector.saveConfig.useMutation({
    onSuccess: () => utils.connector.getConfig.invalidate({ platform }),
  });

  const testMutation = trpc.connector.testConnection.useMutation();

  const refreshMutation = trpc.connector.refreshToken.useMutation({
    onSuccess: () => utils.connector.getConfig.invalidate({ platform }),
  });

  const save = useCallback(
    async (config: Record<string, unknown>) => {
      await saveMutation.mutateAsync({ platform, config });
    },
    [saveMutation, platform]
  );

  const test = useCallback(
    async (config: Record<string, unknown>) => {
      return testMutation.mutateAsync({ platform, config });
    },
    [testMutation, platform]
  );

  const refresh = useCallback(
    async (config: Record<string, unknown>) => {
      return refreshMutation.mutateAsync({ platform, config });
    },
    [refreshMutation, platform]
  );

  return {
    config: configQuery.data,
    isLoading: configQuery.isLoading,
    save,
    test,
    refresh,
    isSaving: saveMutation.isPending,
    isTesting: testMutation.isPending,
    isRefreshing: refreshMutation.isPending,
  };
}

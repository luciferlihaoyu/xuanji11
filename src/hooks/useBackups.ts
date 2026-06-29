import { trpc } from "@/providers/trpc";

export function useBackups() {
  const utils = trpc.useUtils();

  const listQuery = trpc.backup.list.useQuery();
  const targetsQuery = trpc.backup.targets.useQuery();
  const restoresQuery = trpc.backup.listRestores.useQuery();

  const createMutation = trpc.backup.create.useMutation({
    onSuccess: () => {
      utils.backup.list.invalidate();
    },
  });

  const createRestoreMutation = trpc.backup.createRestore.useMutation({
    onSuccess: () => {
      utils.backup.listRestores.invalidate();
    },
  });

  return {
    backups: listQuery.data ?? [],
    targets: targetsQuery.data ?? [],
    restores: restoresQuery.data ?? [],
    isLoading: listQuery.isLoading || targetsQuery.isLoading || restoresQuery.isLoading,
    create: createMutation.mutateAsync,
    createRestore: createRestoreMutation.mutateAsync,
  };
}

export function useBackup(id: number) {
  return trpc.backup.getById.useQuery({ id });
}

export function useRestore(id: number) {
  return trpc.backup.getRestoreById.useQuery({ id });
}

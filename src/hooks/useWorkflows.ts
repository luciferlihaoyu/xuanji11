import { trpc } from "@/providers/trpc";

export function useWorkflows() {
  const utils = trpc.useUtils();

  const listQuery = trpc.workflow.list.useQuery();
  const createMutation = trpc.workflow.create.useMutation({
    onSuccess: () => utils.workflow.list.invalidate(),
  });
  const updateMutation = trpc.workflow.update.useMutation({
    onSuccess: () => utils.workflow.list.invalidate(),
  });
  const deleteMutation = trpc.workflow.delete.useMutation({
    onSuccess: () => utils.workflow.list.invalidate(),
  });
  const setStatusMutation = trpc.workflow.setStatus.useMutation({
    onSuccess: () => utils.workflow.list.invalidate(),
  });
  const saveFullMutation = trpc.workflow.saveFull.useMutation({
    onSuccess: () => {
      utils.workflow.list.invalidate();
    },
  });

  return {
    workflows: listQuery.data ?? [],
    isLoading: listQuery.isLoading,
    create: createMutation.mutateAsync,
    update: updateMutation.mutateAsync,
    delete: deleteMutation.mutateAsync,
    setStatus: setStatusMutation.mutateAsync,
    saveFull: saveFullMutation.mutateAsync,
  };
}

export function useWorkflow(id: number) {
  return trpc.workflow.getById.useQuery({ id });
}

export function useWorkflowRuns(workflowId: number) {
  return trpc.workflow.listRuns.useQuery({ workflowId });
}

export function useWorkflowRun(id: number | null) {
  return trpc.workflow.getRun.useQuery(
    { id: id ?? 0 },
    { enabled: id !== null, refetchInterval: (query) => {
      const state = query.state.data;
      if (!state) return 1000;
      return state.status === "running" || state.status === "pending" ? 1000 : false;
    }}
  );
}

export function useRunWorkflow() {
  const utils = trpc.useUtils();
  return trpc.workflow.run.useMutation({
    onSuccess: (_, vars) => {
      utils.workflow.listRuns.invalidate({ workflowId: vars.id });
    },
  });
}

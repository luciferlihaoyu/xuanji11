import { trpc } from "@/providers/trpc";

export function useKnowledgeGraph() {
  const utils = trpc.useUtils();

  const graphQuery = trpc.knowledge.getGraph.useQuery();
  const createNodeMutation = trpc.knowledge.createNode.useMutation({
    onSuccess: () => {
      utils.knowledge.getGraph.invalidate();
      utils.knowledge.listNodes.invalidate();
    },
  });
  const updateNodeMutation = trpc.knowledge.updateNode.useMutation({
    onSuccess: () => {
      utils.knowledge.getGraph.invalidate();
      utils.knowledge.listNodes.invalidate();
    },
  });
  const deleteNodeMutation = trpc.knowledge.deleteNode.useMutation({
    onSuccess: () => {
      utils.knowledge.getGraph.invalidate();
      utils.knowledge.listNodes.invalidate();
    },
  });
  const updatePositionsMutation = trpc.knowledge.updateNodePositions.useMutation({
    onSuccess: () => utils.knowledge.getGraph.invalidate(),
  });
  const createEdgeMutation = trpc.knowledge.createEdge.useMutation({
    onSuccess: () => utils.knowledge.getGraph.invalidate(),
  });
  const deleteEdgeMutation = trpc.knowledge.deleteEdge.useMutation({
    onSuccess: () => utils.knowledge.getGraph.invalidate(),
  });

  return {
    nodes: graphQuery.data?.nodes ?? [],
    edges: graphQuery.data?.edges ?? [],
    isLoading: graphQuery.isLoading,
    createNode: createNodeMutation.mutateAsync,
    updateNode: updateNodeMutation.mutateAsync,
    deleteNode: deleteNodeMutation.mutateAsync,
    updatePositions: updatePositionsMutation.mutateAsync,
    createEdge: createEdgeMutation.mutateAsync,
    deleteEdge: deleteEdgeMutation.mutateAsync,
  };
}

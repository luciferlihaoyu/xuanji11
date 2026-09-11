import { trpc } from "@/providers/trpc";

export function useKbTree() {
  const utils = trpc.useUtils();

  const treeQuery = trpc.kb.getTree.useQuery();
  const createFolderMutation = trpc.kb.createFolder.useMutation({
    onSuccess: () => utils.kb.getTree.invalidate(),
  });
  const updateFolderMutation = trpc.kb.updateFolder.useMutation({
    onSuccess: () => utils.kb.getTree.invalidate(),
  });
  const deleteFolderMutation = trpc.kb.deleteFolder.useMutation({
    onSuccess: () => utils.kb.getTree.invalidate(),
  });
  const createDocumentMutation = trpc.kb.createDocument.useMutation({
    onSuccess: () => utils.kb.getTree.invalidate(),
  });
  const updateDocumentMutation = trpc.kb.updateDocument.useMutation({
    onSuccess: () => utils.kb.getTree.invalidate(),
  });
  const deleteDocumentMutation = trpc.kb.deleteDocument.useMutation({
    onSuccess: () => utils.kb.getTree.invalidate(),
  });

  return {
    folders: treeQuery.data?.folders ?? [],
    documents: treeQuery.data?.documents ?? [],
    isLoading: treeQuery.isLoading,
    createFolder: createFolderMutation.mutateAsync,
    updateFolder: updateFolderMutation.mutateAsync,
    deleteFolder: deleteFolderMutation.mutateAsync,
    createDocument: createDocumentMutation.mutateAsync,
    updateDocument: updateDocumentMutation.mutateAsync,
    deleteDocument: deleteDocumentMutation.mutateAsync,
  };
}

export function useDocument(id: number, options?: { enabled?: boolean }) {
  return trpc.kb.getDocument.useQuery({ id }, { enabled: options?.enabled ?? id > 0 });
}

/** 入库分拣：建议（dryRun）+ 确认落库 */
export function useIngestion() {
  const utils = trpc.useUtils();
  const suggestMutation = trpc.kb.suggestIngestion.useMutation();
  const confirmMutation = trpc.kb.confirmIngestion.useMutation({
    onSuccess: () => {
      utils.kb.getTree.invalidate();
      utils.knowledge.getGraph.invalidate();
    },
  });
  return {
    suggest: suggestMutation.mutateAsync,
    confirm: confirmMutation.mutateAsync,
  };
}

/** 语义聚类：全文档 KMeans++ 分析（只读） */
export function useClusterDocuments() {
  const mutation = trpc.kb.clusterDocuments.useMutation();
  return { cluster: mutation.mutateAsync, isClustering: mutation.isPending };
}

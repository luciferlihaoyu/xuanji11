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

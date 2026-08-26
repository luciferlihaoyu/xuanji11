/**
 * 知识库文件夹树工具（纯函数，便于单测）。
 */

interface FolderNode {
  id: number;
  parentId: number | null;
}

/**
 * 收集 rootId 文件夹的全部子孙 id（不含根自身），任意层级。
 * 使用已访问集合防御环引用/自引用，保证终止。
 */
export function collectDescendantFolderIds(
  folders: readonly FolderNode[],
  rootId: number,
): number[] {
  const childrenOf = new Map<number, number[]>();
  for (const f of folders) {
    if (f.parentId === null) continue;
    const list = childrenOf.get(f.parentId);
    if (list) list.push(f.id);
    else childrenOf.set(f.parentId, [f.id]);
  }

  const visited = new Set<number>([rootId]);
  const result: number[] = [];
  const stack = [...(childrenOf.get(rootId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    result.push(id);
    for (const child of childrenOf.get(id) ?? []) {
      if (!visited.has(child)) stack.push(child);
    }
  }
  return result;
}

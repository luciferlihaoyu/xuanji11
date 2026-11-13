/**
 * 章节路径提取的唯一出处（T2-03）。
 *
 * 为什么独立成模块：`document_chunks.sectionPath`（索引时写入）与引用锚点的 heading
 * （检索时计算）需要**同一套** markdown 标题解析——两套实现必然漂移（v1 审查教训）。
 * citation-anchor.ts 的 findHeadingBefore 已迁入本模块，原处改为 re-export。
 */

/** 返回 offset 之前最近的 markdown 标题文本（不含 # 号）；没有则 undefined */
export function findHeadingBefore(text: string, offset: number): string | undefined {
  if (offset <= 0) return undefined;
  const lines = text.slice(0, offset).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(lines[i]);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * offset 之前的层级章节路径：按标题级别（# → ######）维护层级栈，同级覆盖、深层清除，
 * 输出形如 "第一章 总论 > 1.1 背景"。offset 处无任何前导标题时 undefined（indexer 写 NULL）。
 */
export function buildSectionPath(text: string, offset: number): string | undefined {
  if (offset <= 0) return undefined;
  const lines = text.slice(0, offset).split("\n");
  const stack = new Map<number, string>();
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const level = m[1].length;
    for (const l of [...stack.keys()]) {
      if (l >= level) stack.delete(l);
    }
    stack.set(level, m[2]);
  }
  if (stack.size === 0) return undefined;
  return [...stack.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, title]) => title)
    .join(" > ");
}

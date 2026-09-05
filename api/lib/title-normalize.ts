/**
 * 标题归一化：用于知识库文档去重/匹配场景。
 *
 * 规则（顺序固定）：
 *   1. 去除首尾空白
 *   2. 移除开头连续的 `[xxx]` 段落（可多个叠加）
 *   3. 折叠连续空白为单个空格
 *   4. 再次 trim
 *   5. 全部转小写
 *
 * 示例：
 *   "  [OpenClaw记忆/public/共享知识] 场景: xxx  "
 *     → "[openclaw记忆/public/共享知识] 场景: xxx"
 *     → "场景: xxx"
 *     → "场景: xxx"
 */
const PREFIX_TAG_RE = /^(\s*\[[^\]]*\]\s*)+/;

export function normalizeTitle(title: string): string {
  // 1) 去掉首尾空白
  // 2) 剥离所有连续 [xxx] 前缀
  // 3) 折叠空白 + trim + toLowerCase
  return title.trim().replace(PREFIX_TAG_RE, "").replace(/\s+/g, " ").trim().toLowerCase();
}

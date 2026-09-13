/**
 * 自动建边核心逻辑（从 knowledge-router 抽出，router 与工作流节点共用）。
 *
 * 规则：全节点 embed → 全对余弦 → 每节点 top maxPerNode → 双边一致才建
 * （A 的 top 含 B 且 B 的 top 含 A）→ similar 边，label=auto。
 */
import { getDb } from "../queries/connection";
import { knowledgeNodes, knowledgeEdges } from "@db/schema";

export interface AutoLinkInput {
  threshold: number;
  maxPerNode: number;
  dryRun: boolean;
  createdBy?: number | null;
}

export interface AutoLinkResult {
  created: number;
  considered: number;
  isolated: number;
  totalCandidates: number;
  candidates: Array<{
    sourceId: number;
    targetId: number;
    score: number;
    sourceTitle: string;
    targetTitle: string;
  }>;
}

export async function autoLinkEdgesCore(input: AutoLinkInput): Promise<AutoLinkResult> {
  const db = getDb();
  const nodes = await db.select({
    id: knowledgeNodes.id,
    title: knowledgeNodes.title,
    content: knowledgeNodes.content,
  }).from(knowledgeNodes);
  if (nodes.length < 2) return { created: 0, considered: 0, isolated: 0, totalCandidates: 0, candidates: [] };

  // 1) embed 全部节点（title + 内容前 200 字）
  const texts = nodes.map((n) => `${n.title}\n${(n.content ?? "").slice(0, 200)}`);
  const { embedTextsWithFallback } = await import("./vector-service");
  const vectors = await embedTextsWithFallback(texts);
  const dims = vectors[0]?.length ?? 0;
  if (dims === 0) throw new Error("embedding 返回空向量");

  // L2 归一化 → 余弦 = 点积
  const normed = vectors.map((v) => {
    let s = 0;
    for (const x of v) s += x * x;
    const inv = s > 0 ? 1 / Math.sqrt(s) : 0;
    return v.map((x) => x * inv);
  });

  // 2) 已有边集合（双向去重）
  const existing = await db.select({
    s: knowledgeEdges.sourceId,
    t: knowledgeEdges.targetId,
  }).from(knowledgeEdges);
  const hasEdge = new Set<string>();
  for (const e of existing) {
    hasEdge.add(`${e.s}:${e.t}`);
    hasEdge.add(`${e.t}:${e.s}`);
  }

  // 3) 全对相似度，每节点保留候选
  const perNode: Array<Array<{ j: number; score: number }>> = nodes.map(() => []);
  let considered = 0;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (hasEdge.has(`${nodes[i].id}:${nodes[j].id}`)) continue;
      let dot = 0;
      const a = normed[i];
      const b = normed[j];
      for (let k = 0; k < dims; k++) dot += a[k] * b[k];
      if (dot < input.threshold) continue;
      considered++;
      perNode[i].push({ j, score: dot });
      perNode[j].push({ j: i, score: dot });
    }
  }

  // 4) 每节点 top maxPerNode，双边一致才建
  const picked = new Map<string, { s: number; t: number; score: number }>();
  for (let i = 0; i < nodes.length; i++) {
    const top = perNode[i].sort((x, y) => y.score - x.score).slice(0, input.maxPerNode);
    for (const { j, score } of top) {
      const key = i < j ? `${i}:${j}` : `${j}:${i}`;
      if (picked.has(key)) {
        picked.set(key, { s: nodes[Math.min(i, j)].id, t: nodes[Math.max(i, j)].id, score });
      } else {
        picked.set(key, { s: -1, t: -1, score });
      }
    }
  }
  const candidates = [...picked.values()]
    .filter((c) => c.s > 0)
    .sort((x, y) => y.score - x.score);

  const isolated = nodes.length - new Set(existing.flatMap((e) => [e.s, e.t])).size;
  const preview = candidates.slice(0, 50).map((c) => ({
    sourceId: c.s,
    targetId: c.t,
    score: Math.round(c.score * 1000) / 1000,
    sourceTitle: nodes.find((n) => n.id === c.s)?.title ?? "",
    targetTitle: nodes.find((n) => n.id === c.t)?.title ?? "",
  }));

  // 5) dryRun 只预览
  if (input.dryRun) {
    return { created: 0, considered, isolated, totalCandidates: candidates.length, candidates: preview };
  }

  // 6) 落库（同步事务——drizzle 回调禁止 async）
  const created = db.transaction((tx) => {
    let n = 0;
    for (const c of candidates) {
      tx.insert(knowledgeEdges).values({
        sourceId: c.s,
        targetId: c.t,
        label: "auto",
        type: "similar",
        weight: Math.round(c.score * 100) / 100,
        createdBy: input.createdBy ?? null,
      }).run();
      n++;
    }
    return n;
  });

  return { created, considered, isolated, totalCandidates: candidates.length, candidates: preview };
}

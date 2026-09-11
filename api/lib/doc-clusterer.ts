/**
 * 语义聚类：文档 embedding → KMeans++ → LLM 命名簇。
 *
 * 定位：发现「你自己都没意识到」的主题群——和自动建边同源（bge-m3 embedding），
 * 但视角从「点对点相似」换成「群体结构」。36 个手工 topic 之外的自动视图。
 *
 * 性能：1468 文档 × 1024 维，全对距离矩阵 O(n²·d) ≈ 2.2G 次乘加，
 * JS 单线程约 2~4 秒可接受（一次性分析，非热路径）。
 * KMeans++ 初始化 + 20 轮迭代足够收敛到可用簇。
 */
import { getDb } from "../queries/connection";
import { kbDocuments } from "@db/schema";
import { chatCompletion, hasLlmAvailable } from "./llm-chat";

export interface DocCluster {
  readonly label: string;
  readonly docIds: number[];
  readonly docTitles: string[]; // 前 8 个代表
  readonly size: number;
}

export interface ClusterResult {
  readonly clusters: DocCluster[];
  readonly totalDocs: number;
  readonly k: number;
  readonly llmLabeled: boolean;
}

/** KMeans++ 初始化：第一个中心随机，后续按距离平方加权选（远离已有中心的优先） */
function kmeansPP(vectors: number[][], k: number, rng: () => number): number[][] {
  const n = vectors.length;
  const dims = vectors[0].length;
  const centroids: number[][] = [vectors[Math.floor(rng() * n)].slice()];
  const dist2 = new Array<number>(n).fill(Infinity);
  for (let c = 1; c < k; c++) {
    const last = centroids[c - 1];
    let sum = 0;
    for (let i = 0; i < n; i++) {
      let d = 0;
      for (let j = 0; j < dims; j++) {
        const diff = vectors[i][j] - last[j];
        d += diff * diff;
      }
      if (d < dist2[i]) dist2[i] = d;
      sum += dist2[i];
    }
    let target = rng() * sum;
    let chosen = n - 1;
    for (let i = 0; i < n; i++) {
      target -= dist2[i];
      if (target <= 0) { chosen = i; break; }
    }
    centroids.push(vectors[chosen].slice());
  }
  return centroids;
}

/** KMeans 主循环（余弦空间——先 L2 归一化，点积即余弦） */
function kmeans(vectors: number[][], k: number, maxIter: number, rng: () => number): number[] {
  const n = vectors.length;
  const dims = vectors[0].length;
  let centroids = kmeansPP(vectors, k, rng);
  const assign = new Array<number>(n).fill(-1);

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = 0;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestSim = -Infinity;
      for (let c = 0; c < k; c++) {
        let sim = 0;
        for (let j = 0; j < dims; j++) sim += vectors[i][j] * centroids[c][j];
        if (sim > bestSim) { bestSim = sim; best = c; }
      }
      if (assign[i] !== best) { assign[i] = best; changed++; }
    }
    if (changed === 0) break;
    // 重算中心（L2 归一化）
    const next: number[][] = Array.from({ length: k }, () => new Array(dims).fill(0));
    const counts = new Array<number>(k).fill(0);
    for (let i = 0; i < n; i++) {
      const c = assign[i];
      counts[c]++;
      for (let j = 0; j < dims; j++) next[c][j] += vectors[i][j];
    }
    centroids = next.map((centroid, c) => {
      if (counts[c] === 0) return centroid;
      let norm = 0;
      for (let j = 0; j < dims; j++) norm += centroid[j] * centroid[j];
      const inv = norm > 0 ? 1 / Math.sqrt(norm) : 0;
      return centroid.map((x) => x * inv);
    });
  }
  return assign;
}

/** 简单可复现的 PRNG（避免 Math.random 不可测试） */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 文档语义聚类主入口。
 * @param kOverride 手动指定簇数；缺省 k = clamp(round(sqrt(n/2)), 6, 16)
 * @param labelWithLlm 是否用 LLM 给簇起名（false 时用代表文档标题截断）
 */
export async function clusterDocuments(kOverride?: number, labelWithLlm: boolean = true): Promise<ClusterResult> {
  const db = getDb();
  const docs = await db.select({
    id: kbDocuments.id,
    title: kbDocuments.title,
    content: kbDocuments.content,
  }).from(kbDocuments);
  if (docs.length < 4) return { clusters: [], totalDocs: docs.length, k: 0, llmLabeled: false };

  // 1) embed 全部文档（title + 内容前 200 字）
  const texts = docs.map((d) => `${d.title}\n${(d.content ?? "").slice(0, 200)}`);
  const { embedTextsWithFallback } = await import("./vector-service");
  const vectors = await embedTextsWithFallback(texts);
  const dims = vectors[0]?.length ?? 0;
  if (dims === 0) throw new Error("embedding 返回空向量");

  // L2 归一化
  const normed = vectors.map((v) => {
    let s = 0;
    for (const x of v) s += x * x;
    const inv = s > 0 ? 1 / Math.sqrt(s) : 0;
    return v.map((x) => x * inv);
  });

  // 2) KMeans++
  const k = kOverride ?? Math.min(16, Math.max(6, Math.round(Math.sqrt(docs.length / 2))));
  const assign = kmeans(normed, k, 20, mulberry32(42));

  // 3) 按簇分组
  const groups = new Map<number, number[]>();
  assign.forEach((c, i) => {
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c)!.push(i);
  });

  // 4) LLM 命名（可选）——喂簇内前 6 个标题，出 4~8 字簇名
  const canLlm = labelWithLlm && (await hasLlmAvailable());
  const clusters: DocCluster[] = [];
  for (const [, idxList] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const titles = idxList.slice(0, 8).map((i) => docs[i].title);
    let label: string;
    if (canLlm) {
      const resp = await chatCompletion(
        `这些文档标题属于同一语义簇，起一个 4~8 字的主题名（只输出名字，不要标点）：\n${titles.slice(0, 6).map((t) => `- ${t}`).join("\n")}`,
        { temperature: 0.2, maxTokens: 20, timeoutMs: 15000 },
      );
      label = resp?.content.trim().replace(/["""''。\.]/g, "").slice(0, 12) || titles[0].slice(0, 12);
    } else {
      label = titles[0].slice(0, 12);
    }
    clusters.push({
      label,
      docIds: idxList.map((i) => docs[i].id),
      docTitles: titles,
      size: idxList.length,
    });
  }

  return { clusters, totalDocs: docs.length, k: clusters.length, llmLabeled: canLlm };
}

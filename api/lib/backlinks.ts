/**
 * 反链查询（T4-02，2026-11-14 碧霄）。HTTP `/relations/backlinks/:nodeId`
 * 与 MCP `relations.backlinks` 共用本实现——两处语义必须一模一样。
 *
 * 分流铁律：
 *  - referencesIn / outgoingDirected：只有**有向边族**（references/extends/
 *    contains/sequence）——「谁引用我」在这些类型上才成立；
 *  - undirectedNeighbors：related/similar 双向收集，附方向免责说明
 *    （similar 的 source/target 实为节点 id 大小序，无语义——auto-link 明文如此）；
 *  - 空入边 → 空数组；节点不存在 → null（HTTP 404 / MCP 明确报错，两型不混）。
 */
import { and, eq, or } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { knowledgeEdges, knowledgeNodes } from "@db/schema";

export const DIRECTED_EDGE_TYPES = ["references", "extends", "contains", "sequence"] as const;
export const UNDIRECTED_EDGE_TYPES = ["related", "similar"] as const;

export interface BacklinkReferenceRow {
  edgeId: number;
  fromNodeId: number;
  fromTitle: string;
  type: string;
  label: string | null;
  evidence: string | null;
}
export interface BacklinkOutgoingRow {
  edgeId: number;
  toNodeId: number;
  toTitle: string;
  type: string;
  label: string | null;
  evidence: string | null;
}
export interface UndirectedNeighborRow {
  edgeId: number;
  neighborNodeId: number;
  neighborTitle: string;
  type: string;
  weight: number | null;
  evidence: string | null;
  directionNote: string;
}
export interface BacklinksResult {
  nodeId: number;
  referencesIn: BacklinkReferenceRow[];
  outgoingDirected: BacklinkOutgoingRow[];
  undirectedNeighbors: UndirectedNeighborRow[];
  directionSemantics: string;
}

const UNDIRECTED_NOTE = "方向无语义（similar 的 source/target 由节点 id 大小决定；related 双向同义）";

export const DIRECTION_SEMANTICS =
  "referencesIn 只含有向边族（references/extends/contains/sequence 指向本节点）；" +
  "related/similar 属无向边，单列 undirectedNeighbors，不参与「谁引用我」统计。" + UNDIRECTED_NOTE.split("（")[0];

type Db = ReturnType<typeof getDb>;

export async function getBacklinks(nodeId: number, db: Db = getDb()): Promise<BacklinksResult | null> {
  const [self] = await db
    .select({ id: knowledgeNodes.id, title: knowledgeNodes.title })
    .from(knowledgeNodes)
    .where(eq(knowledgeNodes.id, nodeId))
    .limit(1);
  if (!self) return null;

  const rows = await db
    .select({
      edgeId: knowledgeEdges.id,
      sourceId: knowledgeEdges.sourceId,
      targetId: knowledgeEdges.targetId,
      type: knowledgeEdges.type,
      label: knowledgeEdges.label,
      weight: knowledgeEdges.weight,
      evidence: knowledgeEdges.evidence,
      sourceTitle: knowledgeNodes.title,
    })
    .from(knowledgeEdges)
    .innerJoin(knowledgeNodes, eq(knowledgeNodes.id, knowledgeEdges.sourceId))
    .where(
      or(
        eq(knowledgeEdges.sourceId, nodeId),
        eq(knowledgeEdges.targetId, nodeId),
      ),
    );

  const referencesIn: BacklinkReferenceRow[] = [];
  const outgoingDirected: BacklinkOutgoingRow[] = [];
  const undirectedNeighbors: UndirectedNeighborRow[] = [];

  // 目标节点标题按需查（去重缓存，避免 N+1）
  const titleCache = new Map<number, string>([[self.id, self.title]]);
  const titleOf = async (id: number): Promise<string> => {
    if (titleCache.has(id)) return titleCache.get(id)!;
    const [n] = await db.select({ title: knowledgeNodes.title }).from(knowledgeNodes).where(eq(knowledgeNodes.id, id)).limit(1);
    const t = n?.title ?? `#${id}`;
    titleCache.set(id, t);
    return t;
  };

  for (const r of rows) {
    const isIncoming = r.targetId === nodeId;
    if ((DIRECTED_EDGE_TYPES as readonly string[]).includes(r.type)) {
      if (isIncoming && r.sourceId !== nodeId) {
        referencesIn.push({ edgeId: r.edgeId, fromNodeId: r.sourceId, fromTitle: r.sourceTitle, type: r.type, label: r.label, evidence: r.evidence });
      } else if (r.sourceId === nodeId && r.targetId !== nodeId) {
        outgoingDirected.push({ edgeId: r.edgeId, toNodeId: r.targetId, toTitle: await titleOf(r.targetId), type: r.type, label: r.label, evidence: r.evidence });
      }
    } else if ((UNDIRECTED_EDGE_TYPES as readonly string[]).includes(r.type)) {
      const other = isIncoming ? r.sourceId : r.targetId;
      if (other === nodeId) continue; // 自环不配当邻居
      undirectedNeighbors.push({
        edgeId: r.edgeId,
        neighborNodeId: other,
        neighborTitle: await titleOf(other),
        type: r.type,
        weight: r.weight,
        evidence: r.evidence,
        directionNote: UNDIRECTED_NOTE,
      });
    }
    // 未知类型（未来扩展）：不进任何组，静默但不谎报
  }

  referencesIn.sort((a, b) => b.edgeId - a.edgeId);
  outgoingDirected.sort((a, b) => b.edgeId - a.edgeId);
  undirectedNeighbors.sort((a, b) => b.edgeId - a.edgeId);

  return { nodeId, referencesIn, outgoingDirected, undirectedNeighbors, directionSemantics: DIRECTION_SEMANTICS };
}

// 保持 or/and 引用不告警（and 供未来软删过滤）
void and;

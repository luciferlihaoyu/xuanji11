export interface LayoutNode {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly x: number;
  readonly y: number;
  readonly edgeCount: number;
}

export interface LayoutEdge {
  readonly source: string;
  readonly target: string;
  readonly strength: number;
}

export interface LayoutNode3D {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
  readonly edgeCount: number;
}

export interface LayoutConfig {
  readonly iterations: number;
  readonly repulsion: number;
  readonly attraction: number;
  readonly damping: number;
  readonly centering: number;
  readonly zSpread: number;
  readonly scale: number;
}

export const DEFAULT_LAYOUT_CONFIG: LayoutConfig = {
  iterations: 80,
  repulsion: 120,
  attraction: 0.008,
  damping: 0.6,
  centering: 0.02,
  zSpread: 80,
  scale: 3,
} as const;

export const CATEGORY_COLORS_3D: Record<string, string> = {
  concept: '#00e5ff',
  document: '#00d68f',
  topic: '#ff8c42',
  entity: '#a78bfa',
  note: '#ff6b81',
  tag: '#f0f0f0',
} as const;

export function getNodeColor(category: string): string {
  return CATEGORY_COLORS_3D[category] ?? CATEGORY_COLORS_3D.concept;
}

export function getNodeRadius(edgeCount: number): number {
  return Math.max(0.3, Math.log2((edgeCount || 1) + 1) * 0.5);
}

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return hash;
}

function seededRandom(seed: number): number {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

export function calculate3DLayout(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  config: Partial<LayoutConfig> = {}
): LayoutNode3D[] {
  const { iterations, repulsion, attraction, damping, centering, zSpread, scale } = {
    ...DEFAULT_LAYOUT_CONFIG,
    ...config,
  };

  if (nodes.length === 0) return [];

  const positions = new Map<string, Vector3Like>();
  const velocities = new Map<string, Vector3Like>();

  for (const node of nodes) {
    const seed = hashString(node.id);
    positions.set(node.id, {
      x: node.x * scale,
      y: node.y * scale,
      z: (seededRandom(seed) - 0.5) * zSpread,
    });
    velocities.set(node.id, { x: 0, y: 0, z: 0 });
  }

  const edgeLookup = buildEdgeLookup(edges);

  for (let i = 0; i < iterations; i++) {
    applyForces(nodes, positions, velocities, edgeLookup, {
      repulsion,
      attraction,
      centering,
      damping,
    });
  }

  return nodes.map((node) => {
    const pos = positions.get(node.id);
    if (!pos) {
      throw new Error(`Missing position for node ${node.id}`);
    }
    return {
      id: node.id,
      name: node.name,
      category: node.category,
      x: pos.x,
      y: pos.y,
      z: pos.z,
      radius: getNodeRadius(node.edgeCount),
      edgeCount: node.edgeCount,
    };
  });
}

interface Vector3Like {
  x: number;
  y: number;
  z: number;
}

interface ForceConfig {
  repulsion: number;
  attraction: number;
  centering: number;
  damping: number;
}

function buildEdgeLookup(edges: readonly LayoutEdge[]): Map<string, readonly LayoutEdge[]> {
  const lookup = new Map<string, LayoutEdge[]>();
  for (const edge of edges) {
    const list = lookup.get(edge.source) ?? [];
    list.push(edge);
    lookup.set(edge.source, list);
    const reverse = lookup.get(edge.target) ?? [];
    reverse.push(edge);
    lookup.set(edge.target, reverse);
  }
  return lookup;
}

function applyForces(
  nodes: readonly LayoutNode[],
  positions: Map<string, Vector3Like>,
  velocities: Map<string, Vector3Like>,
  edgeLookup: Map<string, readonly LayoutEdge[]>,
  config: ForceConfig
): void {
  const { repulsion, attraction, centering, damping } = config;

  for (const node of nodes) {
    const pos = positions.get(node.id);
    const vel = velocities.get(node.id);
    if (!pos || !vel) continue;

    let fx = -pos.x * centering;
    let fy = -pos.y * centering;
    let fz = -pos.z * centering;

    for (const other of nodes) {
      if (other.id === node.id) continue;
      const otherPos = positions.get(other.id);
      if (!otherPos) continue;

      const dx = pos.x - otherPos.x;
      const dy = pos.y - otherPos.y;
      const dz = pos.z - otherPos.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      const dist = Math.sqrt(distSq);
      const minDist = 0.1;
      const safeDist = Math.max(dist, minDist);
      const force = repulsion / (safeDist * safeDist);
      const scale = force / safeDist;

      fx += dx * scale;
      fy += dy * scale;
      fz += dz * scale;
    }

    const connectedEdges = edgeLookup.get(node.id) ?? [];
    for (const edge of connectedEdges) {
      const neighborId = edge.source === node.id ? edge.target : edge.source;
      const neighborPos = positions.get(neighborId);
      if (!neighborPos) continue;

      const dx = neighborPos.x - pos.x;
      const dy = neighborPos.y - pos.y;
      const dz = neighborPos.z - pos.z;
      const strength = edge.strength || 1;

      fx += dx * attraction * strength;
      fy += dy * attraction * strength;
      fz += dz * attraction * strength;
    }

    vel.x = (vel.x + fx) * damping;
    vel.y = (vel.y + fy) * damping;
    vel.z = (vel.z + fz) * damping;

    pos.x += vel.x;
    pos.y += vel.y;
    pos.z += vel.z;
  }
}

export function findNodeByName(
  nodes: readonly LayoutNode3D[],
  query: string
): LayoutNode3D | null {
  const lower = query.toLowerCase();
  return nodes.find((n) => n.name.toLowerCase().includes(lower)) ?? null;
}

export function findNodeById(
  nodes: readonly LayoutNode3D[],
  id: string
): LayoutNode3D | null {
  return nodes.find((n) => n.id === id) ?? null;
}

export function getConnectedNodeIds(
  nodeId: string,
  edges: readonly LayoutEdge[]
): Set<string> {
  const connected = new Set<string>();
  for (const edge of edges) {
    if (edge.source === nodeId) connected.add(edge.target);
    if (edge.target === nodeId) connected.add(edge.source);
  }
  return connected;
}

import type { LayoutNode3D } from '@/lib/graph-layout-3d';
import { getNodeColor } from '@/lib/graph-layout-3d';

interface GraphClustersProps {
  readonly nodes: readonly LayoutNode3D[];
  readonly hiddenNodeIds: ReadonlySet<string>;
}

interface Cluster {
  readonly category: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
  readonly color: string;
}

export default function GraphClusters({ nodes, hiddenNodeIds }: GraphClustersProps) {
  const clusters = buildCategoryClusters(nodes, hiddenNodeIds);

  return (
    <group>
      {clusters.map((cluster) => (
        <mesh key={cluster.category} position={[cluster.x, cluster.y, cluster.z]} scale={cluster.radius}>
          <sphereGeometry args={[1, 32, 32]} />
          <meshBasicMaterial
            color={cluster.color}
            transparent
            opacity={0.04}
            depthWrite={false}
          />
        </mesh>
      ))}
    </group>
  );
}

function buildCategoryClusters(nodes: readonly LayoutNode3D[], hiddenNodeIds: ReadonlySet<string>): Cluster[] {
  const byCategory = new Map<string, LayoutNode3D[]>();
  for (const node of nodes) {
    if (hiddenNodeIds.has(node.id)) continue;
    const list = byCategory.get(node.category) ?? [];
    list.push(node);
    byCategory.set(node.category, list);
  }

  const clusters: Cluster[] = [];
  for (const [category, categoryNodes] of byCategory) {
    if (categoryNodes.length < 3) continue;
    const centroid = categoryNodes.reduce(
      (acc, n) => ({ x: acc.x + n.x, y: acc.y + n.y, z: acc.z + n.z }),
      { x: 0, y: 0, z: 0 }
    );
    const count = categoryNodes.length;
    const avgX = centroid.x / count;
    const avgY = centroid.y / count;
    const avgZ = centroid.z / count;
    const radius = Math.max(
      5,
      Math.sqrt(
        categoryNodes.reduce((sum, n) => {
          const dx = n.x - avgX;
          const dy = n.y - avgY;
          const dz = n.z - avgZ;
          return sum + dx * dx + dy * dy + dz * dz;
        }, 0) / count
      ) + 6
    );
    clusters.push({
      category,
      x: avgX,
      y: avgY,
      z: avgZ,
      radius,
      color: getNodeColor(category),
    });
  }
  return clusters;
}

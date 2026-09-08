import { useMemo } from 'react';
import * as THREE from 'three';
import type { LayoutEdge } from '@/lib/graph-layout-3d';
import type { LayoutNode3D } from '@/lib/graph-layout-3d';
import { getNodeColor } from '@/lib/graph-layout-3d';

interface GraphEdgesProps {
  readonly nodes: readonly LayoutNode3D[];
  readonly edges: readonly LayoutEdge[];
  readonly hiddenNodeIds: ReadonlySet<string>;
}

/**
 * 全部边合并进单个 LineSegments：一次 draw call、零每帧几何开销。
 * 旧实现每条边一个 TubeGeometry(32×8)（≈1000 三角面/条，364 条边时
 * 首帧构建与渲染都过重），是 3D 视图加载超时的主要来源。
 */
export default function GraphEdges({ nodes, edges, hiddenNodeIds }: GraphEdgesProps) {
  const geometry = useMemo(() => {
    const visible = edges.filter(
      (e) => !hiddenNodeIds.has(e.source) && !hiddenNodeIds.has(e.target)
    );
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const positions = new Float32Array(visible.length * 6);
    const colors = new Float32Array(visible.length * 6);
    const color = new THREE.Color();

    let i = 0;
    for (const edge of visible) {
      const source = nodeMap.get(edge.source);
      const target = nodeMap.get(edge.target);
      if (!source || !target) continue;
      positions[i * 6 + 0] = source.x;
      positions[i * 6 + 1] = source.y;
      positions[i * 6 + 2] = source.z;
      positions[i * 6 + 3] = target.x;
      positions[i * 6 + 4] = target.y;
      positions[i * 6 + 5] = target.z;

      // 按目标端节点分类着色
      color.set(getNodeColor(target.category));
      colors[i * 6 + 0] = color.r;
      colors[i * 6 + 1] = color.g;
      colors[i * 6 + 2] = color.b;
      colors[i * 6 + 3] = color.r;
      colors[i * 6 + 4] = color.g;
      colors[i * 6 + 5] = color.b;
      i++;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions.slice(0, i * 6), 3));
    geom.setAttribute('color', new THREE.BufferAttribute(colors.slice(0, i * 6), 3));
    return geom;
  }, [nodes, edges, hiddenNodeIds]);

  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial
        vertexColors
        transparent
        opacity={0.35}
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </lineSegments>
  );
}

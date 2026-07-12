import { useMemo } from 'react';
import * as THREE from 'three';
import type { LayoutEdge } from '@/lib/graph-layout-3d';
import type { LayoutNode3D } from '@/lib/graph-layout-3d';

interface GraphEdgesProps {
  readonly nodes: readonly LayoutNode3D[];
  readonly edges: readonly LayoutEdge[];
  readonly hiddenNodeIds: ReadonlySet<string>;
}

export default function GraphEdges({ nodes, edges, hiddenNodeIds }: GraphEdgesProps) {
  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  return (
    <group>
      {edges.map((edge) => {
        const source = nodeMap.get(edge.source);
        const target = nodeMap.get(edge.target);
        if (!source || !target) return null;
        const isHidden = hiddenNodeIds.has(edge.source) || hiddenNodeIds.has(edge.target);
        return (
          <EdgeTube
            key={`${edge.source}-${edge.target}`}
            source={source}
            target={target}
            strength={edge.strength}
            hidden={isHidden}
          />
        );
      })}
    </group>
  );
}

interface EdgeTubeProps {
  readonly source: LayoutNode3D;
  readonly target: LayoutNode3D;
  readonly strength: number;
  readonly hidden: boolean;
}

function EdgeTube({ source, target, strength, hidden }: EdgeTubeProps) {
  const geometry = useMemo(() => {
    const start = new THREE.Vector3(source.x, source.y, source.z);
    const end = new THREE.Vector3(target.x, target.y, target.z);
    const mid = new THREE.Vector3().lerpVectors(start, end, 0.5);
    const offset = new THREE.Vector3(0, 0, start.distanceTo(end) * 0.15);
    mid.add(offset);
    const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
    const thickness = Math.max(0.03, strength * 0.04);
    return new THREE.TubeGeometry(curve, 32, thickness, 8, false);
  }, [source, target, strength]);

  const opacity = hidden ? 0.03 : 0.45;

  return (
    <mesh geometry={geometry} visible={!hidden}>
      <meshBasicMaterial color="#2a4060" transparent opacity={opacity} />
    </mesh>
  );
}

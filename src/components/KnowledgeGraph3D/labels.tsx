import { Text } from '@react-three/drei';
import type { LayoutNode3D } from '@/lib/graph-layout-3d';

interface GraphLabelsProps {
  readonly nodes: readonly LayoutNode3D[];
  readonly hiddenNodeIds: ReadonlySet<string>;
}

export default function GraphLabels({ nodes, hiddenNodeIds }: GraphLabelsProps) {
  return (
    <group>
      {nodes.map((node) => {
        if (hiddenNodeIds.has(node.id)) return null;
        const fontSize = Math.max(0.35, Math.min(0.8, node.radius * 0.4));
        return (
          <Text
            key={node.id}
            position={[node.x, node.y - node.radius - 0.6, node.z]}
            fontSize={fontSize}
            color="#e8edf5"
            anchorX="center"
            anchorY="top"
            maxWidth={8}
            outlineWidth={0.02}
            outlineColor="#060a14"
          >
            {node.name}
          </Text>
        );
      })}
    </group>
  );
}

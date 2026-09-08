import { useMemo } from 'react';
import { Text } from '@react-three/drei';
import type { LayoutNode3D } from '@/lib/graph-layout-3d';

interface GraphLabelsProps {
  readonly nodes: readonly LayoutNode3D[];
  readonly hiddenNodeIds: ReadonlySet<string>;
}

/** 最多渲染的常驻标签数：每个 drei Text 都会建 glyph atlas，
 * 全量渲染 160+ 个是 3D 首帧卡顿的重要来源。只保留连通度最高的节点标签，
 * 其余节点悬停/选中时由节点自身高亮反馈。 */
const MAX_LABELS = 60;

export default function GraphLabels({ nodes, hiddenNodeIds }: GraphLabelsProps) {
  const visible = useMemo(() => {
    return nodes
      .filter((n) => !hiddenNodeIds.has(n.id))
      .sort((a, b) => b.edgeCount - a.edgeCount)
      .slice(0, MAX_LABELS);
  }, [nodes, hiddenNodeIds]);

  return (
    <group>
      {visible.map((node) => {
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

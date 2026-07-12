import { useRef, useState, useCallback } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { LayoutNode3D } from '@/lib/graph-layout-3d';
import { getNodeColor } from '@/lib/graph-layout-3d';

interface GraphNodesProps {
  readonly nodes: readonly LayoutNode3D[];
  readonly selectedNodeId: string | null;
  readonly multiSelectedIds: readonly string[];
  readonly onNodeClick: (nodeId: string, event: ThreeEvent<MouseEvent>) => void;
  readonly onNodeDoubleClick: (nodeId: string) => void;
  readonly hiddenNodeIds: ReadonlySet<string>;
}

interface NodeInstanceProps {
  readonly node: LayoutNode3D;
  readonly isSelected: boolean;
  readonly isMultiSelected: boolean;
  readonly onClick: (nodeId: string, event: ThreeEvent<MouseEvent>) => void;
  readonly onDoubleClick: (nodeId: string) => void;
  readonly hiddenNodeIds: ReadonlySet<string>;
}

export default function GraphNodes({
  nodes,
  selectedNodeId,
  multiSelectedIds,
  onNodeClick,
  onNodeDoubleClick,
  hiddenNodeIds,
}: GraphNodesProps) {
  const multiSelectedSet = new Set(multiSelectedIds);
  return (
    <group>
      {nodes.map((node) => (
        <NodeInstance
          key={node.id}
          node={node}
          isSelected={selectedNodeId === node.id}
          isMultiSelected={multiSelectedSet.has(node.id)}
          onClick={onNodeClick}
          onDoubleClick={onNodeDoubleClick}
          hiddenNodeIds={hiddenNodeIds}
        />
      ))}
    </group>
  );
}

function NodeInstance({
  node,
  isSelected,
  isMultiSelected,
  onClick,
  onDoubleClick,
  hiddenNodeIds,
}: NodeInstanceProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);
  const color = getNodeColor(node.category);
  const baseScale = node.radius;
  const hoverScale = hovered ? 1.25 : 1;
  const selectedScale = isSelected ? 1.15 : 1;
  const visibleScale = hiddenNodeIds.has(node.id) ? 0.0001 : 1;
  const scale = baseScale * hoverScale * selectedScale * visibleScale;

  useFrame(({ clock }) => {
    if (!meshRef.current || !ringRef.current) return;
    const pulse = isSelected ? 1 + Math.sin(clock.getElapsedTime() * 3) * 0.08 : 1;
    meshRef.current.scale.setScalar(scale * pulse);
    ringRef.current.visible = isSelected || isMultiSelected;
    ringRef.current.rotation.z = clock.getElapsedTime() * 0.5;
    if (isSelected || isMultiSelected) {
      ringRef.current.scale.setScalar(1.4 * pulse);
    }
  });

  const handleClick = useCallback(
    (event: ThreeEvent<MouseEvent>) => {
      event.stopPropagation();
      onClick(node.id, event);
    },
    [node.id, onClick]
  );

  const handleDoubleClick = useCallback(
    (event: ThreeEvent<MouseEvent>) => {
      event.stopPropagation();
      onDoubleClick(node.id);
    },
    [node.id, onDoubleClick]
  );

  return (
    <group position={[node.x, node.y, node.z]}>
      <mesh
        ref={meshRef}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onPointerOver={() => setHovered(true)}
        onPointerOut={() => setHovered(false)}
        scale={scale}
      >
        <sphereGeometry args={[1, 32, 32]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.35}
          roughness={0.4}
          metalness={0.6}
          transparent
          opacity={hiddenNodeIds.has(node.id) ? 0.05 : 0.92}
        />
      </mesh>
      <mesh ref={ringRef} visible={false} rotation={[Math.PI / 2, 0, 0]} scale={1.4}>
        <ringGeometry args={[0.85, 1, 64]} />
        <meshBasicMaterial color={isSelected ? '#ffffff' : color} transparent opacity={0.75} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

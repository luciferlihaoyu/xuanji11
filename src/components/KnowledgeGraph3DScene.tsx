import {
  Suspense,
  useRef,
  useState,
  useCallback,
  useMemo,
  useEffect,
  Component,
  type ReactNode,
  type ErrorInfo,
  type JSX,
} from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import type { LayoutEdge } from '@/lib/graph-layout-3d';
import type { LayoutNode3D } from '@/lib/graph-layout-3d';
import { getConnectedNodeIds } from '@/lib/graph-layout-3d';
import GraphNodes from './KnowledgeGraph3D/nodes';
import GraphEdges from './KnowledgeGraph3D/edges';
import GraphLabels from './KnowledgeGraph3D/labels';
import GraphClusters from './KnowledgeGraph3D/clusters';
import GraphControls, { type GraphControlsHandle } from './KnowledgeGraph3D/controls';
import Starfield from './KnowledgeGraph3D/starfield';
import { updateGraphHash } from './KnowledgeGraph3D/webgl';

export interface KnowledgeGraph3DProps {
  readonly nodes: readonly LayoutNode3D[];
  readonly edges: readonly LayoutEdge[];
  readonly onNodeSelect: (nodeId: string | null) => void;
  readonly selectedNodeId: string | null;
  readonly flyToTarget: { readonly id: string; readonly x: number; readonly y: number; readonly z: number } | null;
  readonly onRegisterExport: (handler: () => void) => void;
  readonly onRegisterReset: (handler: () => void) => void;
  readonly initialCamera?: [number, number, number];
}

interface GraphSceneProps {
  readonly nodes: readonly LayoutNode3D[];
  readonly edges: readonly LayoutEdge[];
  readonly selectedNodeId: string | null;
  readonly multiSelectedIds: readonly string[];
  readonly hiddenNodeIds: ReadonlySet<string>;
  readonly onNodeSelect: (nodeId: string, event: ThreeEvent<MouseEvent>) => void;
  readonly onNodeDoubleClick: (nodeId: string) => void;
  readonly onCameraChange: (position: [number, number, number]) => void;
  readonly initialCamera?: [number, number, number];
  readonly controlsRef: React.RefObject<GraphControlsHandle | null>;
}

export default function KnowledgeGraph3D({
  nodes,
  edges,
  onNodeSelect,
  selectedNodeId,
  flyToTarget,
  onRegisterExport,
  onRegisterReset,
  initialCamera,
}: KnowledgeGraph3DProps) {
  const controlsRef = useRef<GraphControlsHandle>(null);
  const [multiSelectedIds, setMultiSelectedIds] = useState<string[]>([]);
  const [hiddenNodeIds, setHiddenNodeIds] = useState<Set<string>>(new Set());

  const handleNodeClick = useCallback(
    (nodeId: string, event: ThreeEvent<MouseEvent>) => {
      if (event.nativeEvent.ctrlKey || event.nativeEvent.metaKey) {
        setMultiSelectedIds((prev) => {
          const exists = prev.includes(nodeId);
          return exists ? prev.filter((id) => id !== nodeId) : [...prev, nodeId];
        });
      }
      onNodeSelect(nodeId);
    },
    [onNodeSelect]
  );

  const handleNodeDoubleClick = useCallback(
    (nodeId: string) => {
      setHiddenNodeIds((prev) => {
        const connected = getConnectedNodeIds(nodeId, edges);
        const next = new Set(prev);
        let toggled = false;
        for (const id of [nodeId, ...connected]) {
          if (next.has(id)) {
            next.delete(id);
          } else {
            next.add(id);
            toggled = true;
          }
        }
        return toggled ? next : prev;
      });
    },
    [edges]
  );

  const handleExportPng = useCallback(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = `knowledge-graph-3d-${Date.now()}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  }, []);

  const handleReset = useCallback(() => {
    controlsRef.current?.reset();
  }, []);

  useEffect(() => {
    onRegisterExport(handleExportPng);
  }, [handleExportPng, onRegisterExport]);

  useEffect(() => {
    onRegisterReset(handleReset);
  }, [handleReset, onRegisterReset]);

  useEffect(() => {
    if (!flyToTarget) return;
    controlsRef.current?.flyTo(flyToTarget.x, flyToTarget.y, flyToTarget.z + 25);
  }, [flyToTarget]);

  const handleCameraChange = useCallback(
    (position: [number, number, number]) => {
      updateGraphHash(position, selectedNodeId);
    },
    [selectedNodeId]
  );

  return (
    <div className="absolute inset-0 w-full h-full" style={{ backgroundColor: '#060a14' }}>
      <ErrorBoundary fallback={<GraphErrorFallback />}>
        <Suspense fallback={<GraphLoadingFallback />}>
          <Canvas
            camera={{ position: [0, 0, 120], fov: 60, near: 0.1, far: 1000 }}
            gl={{ antialias: true, preserveDrawingBuffer: true }}
            onCreated={({ gl }) => {
              gl.setClearColor(new THREE.Color('#060a14'));
            }}
            onPointerMissed={() => onNodeSelect(null)}
          >
            <GraphScene
              nodes={nodes}
              edges={edges}
              selectedNodeId={selectedNodeId}
              multiSelectedIds={multiSelectedIds}
              hiddenNodeIds={hiddenNodeIds}
              onNodeSelect={handleNodeClick}
              onNodeDoubleClick={handleNodeDoubleClick}
              onCameraChange={handleCameraChange}
              initialCamera={initialCamera}
              controlsRef={controlsRef}
            />
          </Canvas>
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

function GraphScene({
  nodes,
  edges,
  selectedNodeId,
  multiSelectedIds,
  hiddenNodeIds,
  onNodeSelect,
  onNodeDoubleClick,
  onCameraChange,
  initialCamera,
  controlsRef,
}: GraphSceneProps) {
  const visibleNodes = useMemo(() => nodes, [nodes]);
  const visibleEdges = useMemo(() => edges, [edges]);

  return (
    <>
      <ambientLight intensity={0.25} />
      <pointLight position={[100, 100, 100]} intensity={0.8} color="#00e5ff" />
      <pointLight position={[-100, -100, 50]} intensity={0.5} color="#a78bfa" />
      <pointLight position={[0, 0, 120]} intensity={0.4} color="#ffffff" />
      <Starfield />
      <GraphClusters nodes={visibleNodes} hiddenNodeIds={hiddenNodeIds} />
      <GraphEdges nodes={visibleNodes} edges={visibleEdges} hiddenNodeIds={hiddenNodeIds} />
      <GraphNodes
        nodes={visibleNodes}
        selectedNodeId={selectedNodeId}
        multiSelectedIds={multiSelectedIds}
        onNodeClick={onNodeSelect}
        onNodeDoubleClick={onNodeDoubleClick}
        hiddenNodeIds={hiddenNodeIds}
      />
      <GraphLabels nodes={visibleNodes} hiddenNodeIds={hiddenNodeIds} />
      <GraphControls
        ref={controlsRef}
        onCameraChange={onCameraChange}
        initialCamera={initialCamera}
      />
    </>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode; fallback: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('3D graph error:', error, info);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

function GraphLoadingFallback(): JSX.Element {
  return (
    <div className="absolute inset-0 flex items-center justify-center" style={{ backgroundColor: '#060a14' }}>
      <div className="flex flex-col items-center gap-4">
        <div className="relative w-10 h-10">
          <div
            className="animate-rotate w-10 h-10 border-2 border-t-transparent rounded-full"
            style={{ borderColor: 'var(--accent-cyan)', borderTopColor: 'transparent' }}
          />
        </div>
        <span className="text-sm tracking-wider" style={{ color: 'var(--text-secondary)' }}>
          正在加载 3D 知识星图...
        </span>
      </div>
    </div>
  );
}

function GraphErrorFallback(): JSX.Element {
  return (
    <div className="absolute inset-0 flex items-center justify-center" style={{ backgroundColor: '#060a14' }}>
      <div className="text-center p-6 rounded-lg border" style={{ borderColor: 'var(--border-subtle)' }}>
        <h3 className="text-lg font-bold mb-2" style={{ color: 'var(--accent-rose)' }}>3D 图谱渲染失败</h3>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          您的浏览器可能不支持 WebGL，请切换到 2D 视图。
        </p>
      </div>
    </div>
  );
}

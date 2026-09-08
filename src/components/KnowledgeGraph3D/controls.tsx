import { useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import { useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { GRAPH_CAMERA_DISTANCE } from '@/lib/graph-layout-3d';
import { updateGraphHash } from './webgl';

export interface GraphControlsHandle {
  flyTo: (x: number, y: number, z: number) => void;
  reset: () => void;
  getCameraPosition: () => [number, number, number];
}

interface GraphControlsProps {
  readonly onCameraChange?: (position: [number, number, number]) => void;
  readonly initialCamera?: [number, number, number];
}

/** 陈旧机位阈值：布局已归一化到固定球体，存档机位离原点超过此值视为旧版遗留，忽略之。 */
const STALE_CAMERA_DISTANCE = 250;

const GraphControls = forwardRef<GraphControlsHandle, GraphControlsProps>(
  function GraphControls({ onCameraChange, initialCamera }, ref) {
    const controlsRef = useRef<OrbitControlsImpl>(null);
    const { camera } = useThree();

    useEffect(() => {
      if (initialCamera) {
        const dist = Math.hypot(...initialCamera);
        // 旧版散布布局的存档机位会把新球体布局甩出视野——只在合理范围内恢复
        if (dist < STALE_CAMERA_DISTANCE) {
          camera.position.set(...initialCamera);
        } else {
          camera.position.set(0, 0, GRAPH_CAMERA_DISTANCE);
        }
      } else {
        camera.position.set(0, 0, GRAPH_CAMERA_DISTANCE);
      }
    }, [camera, initialCamera]);

    useEffect(() => {
      const controls = controlsRef.current;
      if (!controls || !onCameraChange) return;

      const handleChange = () => {
        onCameraChange([camera.position.x, camera.position.y, camera.position.z]);
      };

      controls.addEventListener('change', handleChange);
      return () => {
        controls.removeEventListener('change', handleChange);
      };
    }, [camera, onCameraChange]);

    useImperativeHandle(ref, () => ({
      flyTo: (x: number, y: number, z: number) => {
        const start = camera.position.clone();
        const focus = new THREE.Vector3(x, y, z);
        const cameraTarget = focus.clone().add(new THREE.Vector3(0, 0, 35));
        const startTarget = controlsRef.current?.target.clone() ?? new THREE.Vector3();
        const startTime = performance.now();
        const duration = 900;

        const animate = (now: number) => {
          const elapsed = now - startTime;
          const t = Math.min(elapsed / duration, 1);
          const eased = t * (2 - t);
          camera.position.lerpVectors(start, cameraTarget, eased);
          if (controlsRef.current) {
            controlsRef.current.target.lerpVectors(startTarget, focus, eased);
            controlsRef.current.update();
          }
          if (t < 1) {
            requestAnimationFrame(animate);
          }
        };
        requestAnimationFrame(animate);
      },
      reset: () => {
        camera.position.set(0, 0, GRAPH_CAMERA_DISTANCE);
        if (controlsRef.current) {
          controlsRef.current.target.set(0, 0, 0);
          controlsRef.current.update();
        }
        // 复位同时清掉 URL 里的陈旧机位存档，避免刷新后又跳回远处
        updateGraphHash([0, 0, GRAPH_CAMERA_DISTANCE], null);
      },
      getCameraPosition: (): [number, number, number] => [camera.position.x, camera.position.y, camera.position.z],
    }));

    return (
      <OrbitControls
        ref={controlsRef}
        enableDamping
        dampingFactor={0.05}
        rotateSpeed={0.6}
        zoomSpeed={0.8}
        panSpeed={0.8}
        minDistance={10}
        maxDistance={400}
      />
    );
  }
);

export default GraphControls;

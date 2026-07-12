import { useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import { useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';

export interface GraphControlsHandle {
  flyTo: (x: number, y: number, z: number) => void;
  reset: () => void;
  getCameraPosition: () => [number, number, number];
}

interface GraphControlsProps {
  readonly onCameraChange?: (position: [number, number, number]) => void;
  readonly initialCamera?: [number, number, number];
}

const GraphControls = forwardRef<GraphControlsHandle, GraphControlsProps>(
  function GraphControls({ onCameraChange, initialCamera }, ref) {
    const controlsRef = useRef<OrbitControlsImpl>(null);
    const { camera } = useThree();

    useEffect(() => {
      if (initialCamera) {
        camera.position.set(...initialCamera);
      } else {
        camera.position.set(0, 0, 120);
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
        const target = new THREE.Vector3(x, y, z);
        const startTarget = controlsRef.current?.target.clone() ?? new THREE.Vector3();
        const endTarget = new THREE.Vector3(x, y, z);
        const startTime = performance.now();
        const duration = 900;

        const animate = (now: number) => {
          const elapsed = now - startTime;
          const t = Math.min(elapsed / duration, 1);
          const eased = t * (2 - t);
          camera.position.lerpVectors(start, target, eased);
          if (controlsRef.current) {
            controlsRef.current.target.lerpVectors(startTarget, endTarget, eased);
          }
          if (t < 1) {
            requestAnimationFrame(animate);
          }
        };
        requestAnimationFrame(animate);
      },
      reset: () => {
        camera.position.set(0, 0, 120);
        if (controlsRef.current) {
          controlsRef.current.target.set(0, 0, 0);
        }
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

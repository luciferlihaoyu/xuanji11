import { useMemo } from 'react';

interface StarfieldProps {
  readonly count?: number;
  readonly radius?: number;
}

function seededRandom(seed: number): number {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function generateStarfield(count: number, radius: number): Float32Array {
  const array = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const theta = seededRandom(i * 7 + 1) * Math.PI * 2;
    const phi = Math.acos(2 * seededRandom(i * 13 + 2) - 1);
    const r = radius * (0.8 + seededRandom(i * 19 + 3) * 0.4);
    array[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    array[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    array[i * 3 + 2] = r * Math.cos(phi);
  }
  return array;
}

export default function Starfield({ count = 2500, radius = 500 }: StarfieldProps) {
  const positions = useMemo(() => generateStarfield(count, radius), [count, radius]);

  return (
    <points>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[positions, 3]}
        />
      </bufferGeometry>
      <pointsMaterial color="#ffffff" size={0.35} transparent opacity={0.55} sizeAttenuation />
    </points>
  );
}

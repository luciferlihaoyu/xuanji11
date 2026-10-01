declare module 'd3-force-3d' {
  export interface ForceLike { strength: (v: number) => ForceLike }
  export function forceRadial(radius: number, x?: number, y?: number, z?: number): ForceLike;
}

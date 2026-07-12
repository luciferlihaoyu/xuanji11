# M8-M10: 3D Knowledge Brain Graph Implementation

## What was built

- Replaced the single 2D D3 view with a 2D/3D switchable knowledge graph.
- Added a Three.js / React Three Fiber 3D scene alongside the existing D3 graph (kept intact).

## New files

- `src/lib/graph-layout-3d.ts` — deterministic 3D force-directed layout adapter, color/radius helpers, and graph utilities.
- `src/lib/graph-layout-3d.test.tsx` — unit tests for layout, colors, radius, search, and neighbor lookup.
- `src/components/KnowledgeGraph3D.tsx` — main 3D scene wrapper (Canvas, lights, starfield, Suspense, ErrorBoundary).
- `src/components/KnowledgeGraph3D/nodes.tsx` — sphere nodes with radius based on `log2(edgeCount+1)`, color by category, hover/selection/multi-select rings, and pulse animation.
- `src/components/KnowledgeGraph3D/edges.tsx` — quadratic bezier tube edges with thickness based on relation weight.
- `src/components/KnowledgeGraph3D/labels.tsx` — SDF-style text labels using `@react-three/drei` `Text`.
- `src/components/KnowledgeGraph3D/controls.tsx` — `OrbitControls` + imperative `flyTo`, `reset`, and `getCameraPosition` handlers.
- `src/components/KnowledgeGraph3D/clusters.tsx` — faint category centroid spheres for dense regions.
- `src/components/KnowledgeGraph3D/starfield.tsx` — 2500 random starfield particles.
- `src/components/KnowledgeGraph3D/webgl.ts` — WebGL detection, mobile/low-end default detection, URL hash encoding/decoding for camera + selected node.
- `src/components/KnowledgeGraph3D.test.tsx` — tests for WebGL utilities and 3D component SSR fallback.

## Modified files

- `src/pages/KnowledgeGraph.tsx` — added `spatialMode` ('2d'/'3d'), WebGL auto-fallback, low-end/mobile default to 2D, 3D layout computation, search fly-to integration, camera URL hash restore, and conditional 2D/3D rendering.
- `src/components/GraphControlPanel.tsx` — added 2D/3D toggle buttons.
- `src/components/TopNavbar.tsx` — when on the graph page (`/`), pressing Enter in the search box dispatches a `knowledge-graph-search` custom event instead of navigating to `/search`.
- `src/components/PermissionSelector.tsx` — minor type fix (`React.ElementType` → `LucideIcon`) to keep `tsc` green.
- `package.json` — added `three`, `@react-three/fiber`, `@react-three/drei`, `@types/three`.

## Dependencies added

- `three`
- `@react-three/fiber`
- `@react-three/drei`
- `@types/three` (dev)

## Verification

- `npm run check` — passes.
- `npm test -- --run` — passes (15 files, 98 tests).
- `npm run build` — passes.

## Notes / trade-offs

- The 3D chunk is ~1.1 MB due to Three.js. Code splitting via dynamic import could reduce initial bundle size but was not requested.
- glTF export was not implemented because the task listed it as optional and the primary deliverables were PNG export, WebGL fallback, and interactions.
- The 3D layout runs on the main thread for a fixed 80 iterations; it stays responsive for the expected 500-node range and recalculates when filters change.

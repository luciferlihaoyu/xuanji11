# Phase 8 — Automated Tests and Documentation

## What was done
- Added `api/local-auth.test.ts` with Vitest coverage for bcrypt hash shape, bcrypt credential verification, wrong-password rejection, and legacy 128-hex scrypt migration to bcrypt.
- Added `src/components/PageLoader.test.tsx` as a smoke test using `react-dom/server`; no `jsdom` or Testing Library dependency was added because the project does not currently install them.
- Updated `vitest.config.ts` so `npm test` discovers `src/**/*.test.tsx` and includes the missing `@db` alias for server-side test imports.
- Rewrote `README.md` with current project description, stack, env vars from `api/lib/env.ts` / `.env.example`, local development, build, quality gates, and Zeabur deployment notes for `https://xuanjj29.zeabur.app/`.

## Findings
- Vitest was configured to include only `api/**/*.test.ts` and `api/**/*.spec.ts`; frontend smoke tests require adding an explicit TSX include pattern.
- `api/lib/env.ts` exits on missing `ADMIN_USERNAME`, `ADMIN_PASSWORD`, or `DATABASE_URL`, so auth tests must set these env vars before dynamically importing `api/local-auth.ts`.
- The auth unit test can stay DB-free by mocking `getDb()` with the fluent Drizzle methods used by `local-auth.ts`: `select().from().where()`, `update().set().where()`, and `insert().values()`.
- `PageLoader.tsx` can be tested in the node environment by rendering static markup and asserting the `animate-rotate` spinner class plus `加载中...` text.

# Phase 7 — Frontend Lazy-Loading Optimization

## What was done
- Converted all 14 page component imports in `src/App.tsx` to `React.lazy(() => import(...))`.
- Wrapped the `<Routes>` block in `<Suspense fallback={<PageLoader />}>`.
- Created `src/components/PageLoader.tsx` — a sci-fi themed loading fallback using `--accent-cyan`, `--accent-cyan-dim`, `--bg-primary`, and the existing `animate-rotate` keyframe from `index.css`.
- Shell components (`HashRouter`, `ErrorBoundary`, `ThemeInit`, `CommandPalette`, `AuthGuard`, `AppLayout`) remain eager-imported for instant authenticated shell render.

## Verification
- `npm run check` (tsc -b): passed, zero errors.
- `npm run build` (vite build): passed in 6.18s, 2465 modules transformed.
- Build output confirms 14 separate page chunks:
  - NotFound (0.93 kB), Login (5.28 kB), SearchResults (11.08 kB), IngestionPage (11.83 kB),
    UploadPage (12.28 kB), DocumentDetail (15.12 kB), DataSources (16.33 kB), APICenter (21.94 kB),
    BackupPage (26.06 kB), KnowledgeBase (27.94 kB), Settings (38.31 kB), AgentManagement (39.18 kB),
    WorkflowBuilder (41.50 kB), KnowledgeGraph (93.78 kB).
- Main shell chunk (`index-*.js`): 360.14 kB (gzip 111.48 kB) — contains router, AuthGuard, AppLayout, CommandPalette, and shared vendor code.
- Total JS chunks produced: 46 (14 page chunks + shared icon chunks + main shell).

## Key decisions
- **PageLoader as separate component** (not inline): cleaner, reusable, and keeps App.tsx focused on routing. Uses inline styles with CSS variables to match the existing pattern in `PermissionSelector.tsx`.
- **Suspense placement**: wraps only `<Routes>`, not the entire `HashRouter` content. This means `ThemeInit` and `CommandPalette` render immediately (no flash of loader for the shell), while only page content shows the fallback during chunk fetch.
- **All 14 pages confirmed default-export**: verified via grep before refactoring — `React.lazy` requires default exports.

## Notes
- The `animate-rotate` class (1s linear infinite) from `index.css` was reused for the spinner — no new keyframes or dependencies added.
- Route paths, AuthGuard nesting, and AppLayout nesting are unchanged.

# Phase 6 — Local Auth bcrypt Migration

## What was learned
- `api/local-auth.ts` is the shared seam for both login surfaces: `auth-router.ts` calls `verifyAdminCredentials`, `signLocalToken`, and `hashPassword`, while the Hono local login handler in the same module uses the same helpers.
- Legacy admin password hashes are deterministic 128-character hex strings produced by `crypto.scryptSync(password, crypto.scryptSync(env.jwtSecret, "admin-salt", 64), 64).toString("hex")`.
- Bcrypt hashes start with `$2` (`$2a$`, `$2b$`, etc.), so legacy detection can safely require both “does not start with `$2`” and the 128-hex-character shape before running the scrypt fallback.
- `Session.maxAgeMs` is the single source of truth for the session cookie TTL; JWT expiry should be computed from it as seconds (`Math.floor(Session.maxAgeMs / 1000)`) to avoid cookie/token lifetime drift.

## Migration edge cases
- A malformed stored hash that is neither bcrypt nor a 128-hex legacy scrypt hash fails closed and does not trigger migration.
- A correct legacy password stored in `system_settings.admin_password_hash` is accepted once, then rewritten as bcrypt with cost 10.
- If no `system_settings` password exists, the env password fallback is still verified with the legacy scrypt algorithm; a successful fallback login now persists a bcrypt hash under `admin_password_hash`, preserving the same password while moving future logins off scrypt.
- Vite automatically code-splits `React.lazy` imports — no manual `manualChunks` config needed.
# Learnings — Xuanji Knowledge Graph UI

## Phase 4: Context Menu, Node Editing, Create Node Button

### Architecture
- `useKnowledgeGraph()` hook in `src/hooks/useKnowledge.ts` exposes all CRUD mutations: `createNode`, `updateNode`, `deleteNode`, `createEdge`, `deleteEdge`, `updatePositions`. Each mutation auto-invalidates `getGraph` and `listNodes` queries on success, so the graph refreshes automatically after any mutation — no manual refetch needed.
- `KnowledgeGraph.tsx` already had `createNode` and `deleteNode` wired (add-node modal + panel delete button). `updateNode` was exposed by the hook but NOT destructured in the page component — had to add it.

### Data Model
- `knowledgeNodes` DB table has NO `importance` or `tags` columns. Both are stored inside the `metadata` JSON column (`metadata.tags: string[]`, `metadata.importance: number`).
- `updateNode` mutation REPLACES the entire `metadata` object (not a merge). To avoid losing other metadata fields (e.g. `documentId` used by delete-node cleanup), the update handler must spread existing metadata before overwriting tags/importance: `metadata: { ...existingMetadata, tags, importance }`.
- `RenderNode` interface in `KnowledgeGraph.tsx` was missing `importance` and `metadata` fields. Added both to the interface and the `backendNodes.map()` mapping so the edit form and update handler can access them.

### D3 Integration
- D3 v7 passes the DOM event as the first argument to `.on()` handlers. The `contextmenu` handler signature is `(event: MouseEvent, d: RenderNode)`. Call `event.preventDefault()` + `event.stopPropagation()` to suppress the browser context menu and prevent the window-level close listener from firing.
- State setters from `useState` are stable references and can be used directly inside D3 effect closures without refs (the existing code already does this with `setSelectedNodeId`, `setEdgeMode`).
- The context menu close-on-click listener is attached to `window` with a `setTimeout(0)` delay so the same right-click event that opened the menu doesn't immediately close it.

### Styling
- Sci-fi CSS classes available: `input-base`, `btn-primary`, `btn-secondary`, `btn-danger`, `btn-ghost`, `panel-floating`, `chip`, `gradient-bar`, `sci-corner`.
- CSS variables: `--text-primary`, `--text-secondary`, `--text-muted`, `--text-dim`, `--bg-tertiary`, `--bg-elevated`, `--bg-glass`, `--accent-cyan`, `--accent-cyan-dim`, `--accent-rose`, `--border-subtle`, `--border-active`.
- Range sliders use `style={{ backgroundColor: 'var(--bg-tertiary)', accentColor: 'var(--accent-cyan)' }}` — matches the existing GraphControlPanel slider pattern.

### TypeScript
- `tsconfig.app.json` has `noUnusedLocals: true` and `noUnusedParameters: true` — any unused variable/parameter will fail `npm run check`. Removed an unused `contextMenuRef` that was initially declared but not needed.
- `npm run check` = `tsc -b` (type check only). `npm run build` = `vite build` + `esbuild` for the server bundle.

# Phase 5 — Agent Management Wiring Verification

## What was already correct
- `api/agent-router.ts` exposes the required Phase 5 endpoints: `list`, `create`, `update`, `delete`, and `testLlmConnection` (plus `getById` and `updatePermissions`).
- `src/hooks/useAgents.ts` already used tRPC for `agent.list`, `agent.create`, `agent.update`, `agent.delete`, `agent.updatePermissions`, and `agent.testLlmConnection`.
- Create, update, delete, and permission mutations already invalidated `utils.agent.list` on success.
- `src/pages/AgentManagement.tsx` already consumed the hook for listing, create, edit/update, delete, permission update, LLM config save, and LLM connection test, with success/error toast feedback around the UI actions.

## What was fixed
- Removed the stale frontend-only status mapping (`active -> online`, everything else -> offline`) from `useAgents.ts`; backend agent statuses now flow through as the schema enum values: `active | inactive | error | training`.
- Added shared `AgentStatus` and `AgentType` unions in `src/store/useAppStore.ts` matching the Drizzle enum values, and added `Agent.type` so backend `type` is preserved in the UI model.
- Updated `useAgents.ts` create/update adapters to send `type` and `status` to the existing backend contracts instead of hardcoding all creates to `custom`/`active` or dropping update enum fields.
- Updated `AgentManagement.tsx` status filter/options and add/edit modal type/status selects to match schema values: `active | inactive | error | training` and `assistant | analyst | curator | connector | custom`.
- Updated the one downstream stale status comparison in `KnowledgeGraph.tsx` from `online` to `active` after the shared Agent status type was corrected.

## Verification
- `npm run check` (`tsc -b`) passes with zero errors after the enum/wiring fixes.
- Grep confirmed no `TODO` entries in `src/pages/AgentManagement.tsx` or `src/hooks/useAgents.ts`; remaining `status-dot-online/offline` strings are CSS class names only, not agent enum values.

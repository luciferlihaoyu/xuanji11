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

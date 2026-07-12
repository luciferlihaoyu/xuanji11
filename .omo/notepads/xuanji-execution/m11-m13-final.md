# M11-M13 Final Execution Record

Date: 2026-07-12

## M11: Connector Management

- Added `listConnectors` tRPC query to `api/connector-router.ts` that returns registered connectors with their configured/connected status.
- Added a new "连接器" tab in `src/pages/Settings.tsx` using the existing `useConnectorConfig` hook.
- Each connector card shows name, status badge, basic config fields (tokens for 115/AliyunDrive, path for NAS), save and test-connection buttons.

## M12: Audit Logs

- Added `logAction(userId, action, details)` helper to `api/lib/audit.ts`; it writes to the existing `audit_logs` table with entityType `action`.
- Created `api/audit-router.ts` with `listLogs` (admin-only, paginated) and `getLogEntry` (admin-only) endpoints.
- Registered `auditRouter` under `audit` in `api/router.ts`.
- Hooked `logAction` into 5 key operations:
  - KB document creation (`api/kb-router.ts`)
  - Knowledge node deletion (`api/knowledge-router.ts`)
  - Backup job creation/run (`api/backup-router.ts`)
  - API key generation (`api/agent-router.ts`)
  - KB export (`api/kb-backup-router.ts`)
- Created `src/pages/AuditLog.tsx` with a paginated table showing timestamp, user, action, and details.
- Added `/audit` route in `src/App.tsx` and a "审计" nav item in `src/components/TopNavbar.tsx`.

## M13: Test Coverage

Added 8 edge-case tests across the target files:
- `api/zvec-router.test.ts`: empty search query, query max-length overflow, invalid JSON body, null/undefined inputs.
- `api/hybrid-search.test.ts`: empty search query, query max-length overflow, null/undefined inputs, concurrent requests.
- `api/mcp-server.test.ts`: invalid JSON-RPC request, null/undefined tool arguments, concurrent tool calls.

## Verification

- `npm run check` passed.
- `npm run test -- --run` passed: 15 test files, 107 tests.
- `npm run build` passed.

## Notes

- No new npm dependencies added.
- All new files are under 250 pure LOC.
- Generic error messages returned to clients from audit endpoints.
- Existing lint errors in the codebase remain unchanged; only the new Settings.tsx sync effect is suppressed with an inline lint comment matching the project's existing patterns.

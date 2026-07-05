## 2026-07-05 — Phase 1/2 upload and backup persistence

- Added `env.uploadDir` and `env.backupTempDir` with defaults `/data/app/uploads` and `/data/app/backups`, while still honoring `UPLOAD_DIR` and `BACKUP_TEMP_DIR`.
- Updated upload save/read paths to use the centralized upload dir and resolve it to an absolute path before writing `storagePath` to the database.
- Updated ingestion temporary downloads to use the same upload dir and create it recursively before temp writes.
- Updated backup temp staging to use `env.backupTempDir`; also fixed the scheduled backup worker because it had the same staging pattern as `backup-router.ts`.
- Verification issue: this execution environment has no `npm`, `node`, or `bun` binary on `PATH`, so `npm run check` and `npm run build` could not be executed here.

## 2026-07-05 — Phase 3 Zvec vector persistence

- Added `env.zvecDataDir`, `env.zvecDimension`, and `env.zvecEnabled`; defaults are `/data/app/zvec`, `1536`, and enabled unless `ZVEC_ENABLED=false`.
- Replaced the primary vector store with a lazy `@zvec/zvec` collection at `/data/app/zvec/document_chunks`, using the `embedding` vector field and scalar chunk fields (`documentId`, `chunkIndex`, `content`) plus scalar metadata columns.
- Kept the existing embedding provider fallback path intact, but vectors are normalized to the configured Zvec dimension before insert/search so short hash fallback embeddings are padded.
- `api/boot.ts` now initializes Zvec global logging once at startup; the vector module also guards lazy initialization for non-boot import paths.

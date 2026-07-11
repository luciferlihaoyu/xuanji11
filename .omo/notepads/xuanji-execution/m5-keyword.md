# M5 Keyword Extraction Engine — Execution Record

## Summary

Implemented a dual-mode keyword extraction engine for the Xuanji knowledge base. The engine extracts keywords from text using an internal, dependency-free frequency analyzer (Chinese character bigrams + English words, with stopword removal and length-normalized scores), and optionally calls an LLM when an active agent is configured. The functionality is exposed via Hono REST endpoints and MCP tools, with auto-tagging that creates `knowledge_nodes` of type `tag` and links them to a document knowledge node.

## Files Created

- `api/lib/keyword-extractor.ts` — core extraction logic
  - `extractKeywordsInternal(text, maxKeywords)` — tokenizes CJK text into overlapping character bigrams and English words, removes stopwords, counts frequencies, normalizes by token count, and returns top-N `{ word, score }` results
  - `findLlmAgent()` — scans active `agents` for a config containing `apiUrl` + `apiKey`, returns the first valid LLM config
  - `extractKeywordsWithLlm(text, maxKeywords, config)` — calls an OpenAI-compatible `/chat/completions` endpoint with a JSON-keyword prompt, parses the response, and returns `{ word, score }` results
  - `extractKeywords(text, mode, maxKeywords)` — public entry point; `internal` always uses local analysis, `llm`/`auto` try LLM first and fall back to internal on failure or missing config
  - Zod schemas for `extract` input (`text`, `mode`, `maxKeywords`)
- `api/lib/keyword-auto-tag.ts` — auto-tag persistence logic
  - `autoTagDocument(documentId, maxKeywords, createdBy)` — fetches the KB document, extracts keywords, finds or creates a `document` knowledge node, finds or creates `tag` nodes, and links each tag to the document node via `knowledge_edges` (label `tag`, type `related`)
  - Zod schema for `auto-tag` input (`documentId`)
- `api/keyword-router.ts` — Hono REST router
  - `POST /api/keywords/extract` requires `knowledge:read`
  - `POST /api/keywords/auto-tag` requires `knowledge:write`
  - API-key + session auth middleware, generic error responses, Zod validation
- `api/mcp-keyword.ts` — MCP tools
  - `keywords.extract` with `knowledge:read` scope
  - `keywords.autoTag` with `knowledge:write` scope
- `api/keyword.test.ts` — core + REST + auto-tag unit tests (14 tests)
- `api/mcp-keyword.test.ts` — MCP tool registration and auth tests (4 tests)

## Files Modified

- `api/router.ts` — re-export `keywordRouter`
- `api/boot.ts` — mount `/api/keywords`, exempt from CSRF and global auth middleware (router handles its own auth + scopes)
- `api/mcp-server.ts` — register `keywords.extract`/`keywords.autoTag` tools and dispatch handler

## Backward Compatibility

- `knowledge-router.ts` was **not** modified.
- No new npm dependencies were added.
- All existing tests continue to pass.

## Verification

```text
npm run check          ✅ tsc -b passed
npm test -- --run      ✅ 68 tests passed (12 files)
npm run build          ✅ vite + esbuild bundle succeeded
```

Lint was also run on the new files with zero new errors (the repository has pre-existing lint issues in unrelated frontend and connector files).

## Notes

- Scope required: `knowledge:read` for extract, `knowledge:write` for auto-tag.
- Internal errors are logged via `console.error`; API/MCP consumers receive generic messages.
- LLM mode uses the same fetch pattern as `agent-router.ts` `testLlmConnection` (15-second timeout, OpenAI-compatible chat completions, Bearer auth). It falls back to internal mode on any failure or when no active agent is configured.
- Auto-tag creates a `document` knowledge node to represent the KB document (storing `documentId` in `metadata`) because `knowledge_edges` can only reference `knowledge_nodes` ids.
- Tags and edges are created idempotently: existing nodes/edges are reused and not duplicated.
- The implementation uses only built-in JavaScript APIs and existing project dependencies (no `nodejieba`, no new npm packages).
- Test files were split into two files to keep each under the 250 pure LOC ceiling.

---

## Architecture

```text
                ┌──────────────────────┐
                │   keyword-router.ts  │  POST /api/keywords/extract  (knowledge:read)
                │   (Hono router)      │  POST /api/keywords/auto-tag (knowledge:write)
                └─────────┬────────────┘
                          │ calls
                ┌─────────▼────────────┐
                │   keyword-extractor  │  extractKeywordsInternal()
                │   (core logic)       │  extractKeywordsWithLlm()
                │                      │  extractKeywords()
                └─────────┬────────────┘
                          │ calls for auto-tag
                ┌─────────▼────────────┐
                │   keyword-auto-tag   │  autoTagDocument()
                │   (persistence)      │
                └─────────┬────────────┘
                          │ reads/writes
                ┌─────────▼────────────┐
                │   Drizzle DB         │  kbDocuments / knowledgeNodes / knowledgeEdges
                └──────────────────────┘

                ┌──────────────────────┐
                │   mcp-keyword.ts     │  keywords.extract (knowledge:read)
                │   (MCP tools)        │  keywords.autoTag (knowledge:write)
                └─────────┬────────────┘
                          │ dispatched by
                ┌─────────▼────────────┐
                │   mcp-server.ts      │  callTool() → handleKeywordTool()
                └──────────────────────┘
```

---

## Test Coverage Map

| Layer | Test File | Tests |
|---|---|---|
| Core extraction | `api/keyword.test.ts` | Chinese bigrams, English words, stopwords, maxKeywords (4 tests) |
| REST API | `api/keyword.test.ts` | 401 unauth, 403 scope, 400 invalid, 200 extract, 404 auto-tag, 200 auto-tag (6 tests) |
| Auto-tag logic | `api/keyword.test.ts` | document not found, creates tags/edges, empty result (3 tests) |
| MCP tools | `api/mcp-keyword.test.ts` | tools/list inclusion, extract, autoTag reject, autoTag accept (4 tests) |
| **Total** | | **17 tests** (14 in keyword.test, 3 in mcp-keyword.test) |

---

## Pure LOC Check

| File | Pure LOC |
|---|---|
| `api/lib/keyword-extractor.ts` | 187 |
| `api/lib/keyword-auto-tag.ts` | 100 |
| `api/keyword-router.ts` | 74 |
| `api/mcp-keyword.ts` | 77 |
| `api/keyword.test.ts` | 237 |
| `api/mcp-keyword.test.ts` | 117 |

All source files are under the 250 pure LOC ceiling.

---

## Independent Review — 2026-07-11

### VERDICT: **APPROVE** ✅

### Verification Results

| Gate | Command | Status |
|---|---|---|
| TypeScript | `npm run check` (tsc -b) | ✅ Zero errors |
| Unit/Integration | `npm test -- --run` | ✅ 68/68 pass (12 files) |
| Production bundle | `npm run build` | ✅ vite + esbuild success |

### Requirement Checklist

| Requirement | File/Line | Status |
|---|---|---|
| Scopes enforced (read → extract) | `keyword-router.ts:54`, `mcp-keyword.ts:30` | ✅ `knowledge:read` required |
| Scopes enforced (write → auto-tag) | `keyword-router.ts:68`, `mcp-keyword.ts:41` | ✅ `knowledge:write` required |
| No raw errors leaked | `keyword-router.ts:49-52, 59-66, 74-83` | ✅ All errors caught; generic 500 messages |
| No new npm dependencies | `package.json` diff | ✅ Zero new deps |
| `knowledge-router.ts` unchanged | `api/knowledge-router.ts` | ✅ No keyword imports; content matches baseline |
| Dual-mode (internal + LLM) | `keyword-extractor.ts:203-221` | ✅ `internal` = frequency; `auto`/`llm` = LLM with fallback |
| Auto-tag idempotent | `keyword-auto-tag.ts:48-64, 66-90` | ✅ `findOrCreate*` pattern for nodes + edges |
| Tests cover scope enforcement | `keyword.test.ts:136-248`, `mcp-keyword.test.ts:107-119` | ✅ 403/error on missing scopes |

### Architecture Review

- **Boundary purity**: Zod schemas (`extractInputSchema`, `autoTagInputSchema`) parse at the boundary; internal code receives typed values. ✅
- **Error handling**: LLM mode catches all fetch/parse errors, returns `undefined` to trigger internal fallback. Router catches `ZodError` → 400, domain errors → 404, everything else → 500 with generic messages. No raw stack traces in responses. ✅
- **Escape hatches**: No `any`, no `as` casts, no `!`, no `@ts-ignore` in new code. ✅
- **Pure LOC**: All files under the 250 ceiling (max: 237 in test, 187 in source). ✅
- **No helpers for one-off**: `parseLlmJson` is a single-use helper but is a legitimate extraction of non-trivial parsing logic. Acceptable. ⚪
- **Stopword coverage**: Combined CJK + English stopword sets (~130 entries). Reasonable baseline; not exhaustive but covers common function words. ⚪

### Observations (non-blocking)

1. **MySQL-specific JSON extraction**: `keyword-auto-tag.ts:28` uses `JSON_UNQUOTE(JSON_EXTRACT(...))` which is MySQL dialect. Acceptable since the project uses `mysql2` as its only DB driver and this pattern matches existing codebase usage.

2. **LLM prompt injection surface**: `extractKeywordsWithLlm` sends raw user text as part of the prompt body (truncated to 4000 chars). Since the endpoint is auth-gated and scoped, this is low risk for an internal application.

3. **Logging consistency**: Uses `console.error` for error paths. Follows the existing project pattern (no structured logger). Adequate for this stage.

4. **Test isolation**: Tests mock `getDb`, `authenticateApiKey`, and `authenticateLocalRequest` at module level. No test pollution observed. MCP tests additionally mock `vector-service` to avoid side effects.

5. **M5-M4 interaction**: Auto-tag creates `knowledge_nodes` of type `"tag"` which the existing `knowledge-router.ts:39` `type` enum already accepts. No schema conflict.

### Summary

All six changed files are well-structured, correctly scoped, and covered by 17 tests across 2 test files. The implementation adds keyword extraction capability without modifying existing routers or adding new dependencies. Three verification gates pass cleanly.


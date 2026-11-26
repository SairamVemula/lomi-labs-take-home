# Extraction & Review App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Turborepo monorepo where PDFs are uploaded, extracted by any OpenAI-compatible LLM through a crash-safe BullMQ pipeline with Postgres as the record, reviewed in a Next.js UI, and re-extracted with review carry-over; deployed to `lomi.sairam.cc`.

**Architecture:** Postgres is the outbox and the only durable state; Redis only delivers run IDs. A NestJS API commits state then enqueues; a separate Nest worker claims runs atomically, heartbeats a lease, and finalizes values + carried reviews in one guarded transaction; a reconciler re-enqueues anything Redis lost. All domain logic (normalization, evidence validation, carry-over) lives in a pure `packages/extraction`.

**Tech Stack:** pnpm 10 + Turborepo 2, Node 24, TypeScript 5 strict, NestJS 11, BullMQ 5, Drizzle ORM + drizzle-kit, Postgres 17, Redis 7, `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (MinIO in tests), unpdf, openai SDK, zod, Next.js 15 + Tailwind CSS 4 + TanStack Query, Vitest, Testcontainers, Playwright, Caddy 2, GitHub Actions + GHCR.

**Spec:** `docs/superpowers/specs/2026-11-26-extraction-review-design.md` (brief: `assignment/README.md`)

## Global Constraints

- Endpoints exactly: `POST /documents`, `POST /documents/:id/versions`, `GET /documents/:id`, `POST /values/:id/review`, `GET /documents/:id/progress` (plus auth, `GET /documents`, `POST /documents/:id/retry`).
- Document statuses exactly: `queued`, `extracting`, `extracted`, `failed` (non-current versions display `superseded`).
- Progress buckets exactly: `pending`, `approved`, `corrected`, `carried_over`.
- Upload responds without waiting on Redis or the LLM; enqueue happens after commit.
- Evidence not found in that version's `parsed_text` → stored as gap `value: null` with reason; never kept.
- Only providers that accept `response_format: { type: "json_schema" }` are supported; rejected at login.
- Fixtures read from `assignment/fixtures/`; seed version 1 only.
- PDF bytes never live in Postgres: storage is S3 when `S3_BUCKET` + `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY` are set, local `STORAGE_DIR` otherwise. Keys are `pdfs/<lowercase-slug-of-filename>-<lowercase sha256>.pdf`. Storage write happens before the DB commit.
- PDFs are served only to their authenticated owner: local → streamed by the API; S3 → 302 to a 300-second presigned URL.
- `docker compose up` at repo root starts everything, migrates, and seeds.
- `assignment/jd.md`, `.env`, `.env.deploy`, `*.jsonl` are gitignored. VPS address never committed.
- Tests never call a real LLM: unit tests use `FakeLlmClient`; e2e uses `packages/testing` fake OpenAI-compatible server.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Typographic mismatch in evidence** — PDF text has `’`/`–`/`ﬁ` ligature while LLM quotes `'`/`-`/`fi`: expect evidence to validate (NFKC + quote/dash folding applied on both sides before matching). Test in Task 3.
2. **Double-click "upload new version"** — two concurrent `POST /documents/:id/versions`: expect versions 2 and 3, no unique-violation 500. Test in Task 11.
3. **Stale tab reviews an old version's value** — expect `409 VALUE_NOT_CURRENT`, no review row. Test in Task 11.
4. **Correction not valid for the field type** (`"abc"` for money, `"31/02/2026"` for date) — expect `400` with a field-type message. Test in Task 11.
5. **Model omits a field or adds an unrequested one** — expect the omitted field stored as gap `"field missing from model output"` and extras ignored. Test in Task 8.

---

### Task 1: Monorepo skeleton, git, CI

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `.gitignore`, `.nvmrc`, `.env.example`, `packages/config/{package.json,tsconfig.base.json,eslint.config.mjs,vitest.shared.ts}`, `.github/workflows/ci.yml`

**Interfaces:**
- Produces: every workspace package exposes scripts `build`, `lint`, `typecheck`, `test`, and (where relevant) `test:integration`; `turbo.json` tasks `build` (dependsOn `^build`, outputs `dist/**`, `.next/**`), `typecheck` (dependsOn `^build`), `lint`, `test` (dependsOn `^build`), `test:integration` (dependsOn `^build`, `cache: false`), `dev` (persistent, no cache).

- [ ] **Step 1:** `git init`, write `.gitignore` (node_modules, dist, .next, .turbo, .env, .env.deploy, `*.jsonl`, `assignment/jd.md`, playwright-report, test-results).
- [ ] **Step 2:** Root `package.json` (`packageManager: pnpm@10`, scripts proxy to `turbo run …`), `pnpm-workspace.yaml` (`apps/*`, `packages/*`), `turbo.json` as above, `packages/config` with strict tsconfig (`"module": "NodeNext"`, `"strict": true`, `"noUncheckedIndexedAccess": true`) and flat eslint config (typescript-eslint recommended).
- [ ] **Step 3:** `.env.example` with `STORAGE_DIR=/data/files`, commented-out `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, plus `AUTH_MODE=local`, `LLM_BASE_URL=https://api.openai.com/v1`, `LLM_API_KEY=`, `LLM_MODEL=gpt-4.1-mini`, `SESSION_SECRET=`, `KEY_ENCRYPTION_KEY=` (64 hex), `POSTGRES_PASSWORD=postgres`, `DATABASE_URL`, `REDIS_URL`, `PUBLIC_ORIGIN=http://localhost:3000`.
- [ ] **Step 4:** `ci.yml`: on `pull_request` and `push`; setup pnpm + Node 24 with cache; `pnpm install --frozen-lockfile`; `pnpm turbo lint typecheck test build`; `pnpm turbo test:integration` (Testcontainers uses the runner's Docker).
- [ ] **Step 5:** Verify: `pnpm install && pnpm turbo lint typecheck test build` exits 0 (no packages yet → "No tasks were executed" is fine).
- [ ] **Step 6:** `gh repo create lomi-labs-take-home --public --source . --remote origin`; commit `chore: monorepo skeleton`; push.

### Task 2: `packages/shared` — field types and API contract

**Files:**
- Create: `packages/shared/src/{fields.ts,values.ts,api.ts,index.ts}`, `packages/shared/test/values.test.ts`

**Interfaces:**
- Produces:
  - `type FieldType = 'string'|'date'|'money'|'percent'|'number'`; `type DocumentType = 'invoice'|'lease'|'market_report'`
  - `EXPECTED_FIELDS: Record<DocumentType, {field: string; type: FieldType}[]>` — imported from `assignment/fixtures/expected-fields.json` at build time (copy into `src/expected-fields.json` via a `prebuild` script; test asserts equality with the fixture).
  - `type Money = { amount: string; currency: string }`; `type FieldValue = string | number | Money`
  - `normalizeValue(type: FieldType, raw: unknown): { ok: true; value: FieldValue } | { ok: false; reason: string }`
  - `canonicalJson(v: FieldValue | null): string` (sorted keys)
  - zod schemas: `ReviewRequest = { action: 'approve' } | { action: 'correct'; value: unknown; note?: string }`, `DocumentStatus`, `ChangeStatus`, `Progress = {pending,approved,corrected,carried_over,total}`, `DocumentSummary`, `DocumentDetail`, `ValueView`, `LoginRequest = {baseUrl, apiKey, model}`.

- [ ] **Step 1: Write failing tests** `values.test.ts`:
  - `normalizeValue('date','March 3, 2026')` → `{ok:true,value:'2026-03-03'}`; `'2026-02-31'` → `ok:false`, reason contains `date`.
  - `normalizeValue('money','$1,234.5')` → `{amount:'1234.50',currency:'USD'}`; `{amount:1234.5,currency:'usd'}` → same; `'abc'` → `ok:false`.
  - `normalizeValue('percent','4.2%')` → `4.2`; `normalizeValue('number','12 months')` → `12`.
  - `canonicalJson({currency:'USD',amount:'1.00'}) === canonicalJson({amount:'1.00',currency:'USD'})`.
  - `EXPECTED_FIELDS` deep-equals the fixture JSON.
- [ ] **Step 2:** `pnpm --filter @lomi/shared test` → FAIL (module not found).
- [ ] **Step 3:** Implement. Dates: accept ISO, `Month D, YYYY`, `D Month YYYY`, `MM/DD/YYYY`; reject invalid calendar dates. Money: currency from symbol (`$`→USD, `€`→EUR, `£`→GBP) or 3-letter code, default USD; amount fixed 2 dp as string.
- [ ] **Step 4:** Tests PASS.
- [ ] **Step 5:** Commit `feat(shared): field types, value normalization, API contract`.

### Task 3: `packages/extraction` — evidence validation

**Files:**
- Create: `packages/extraction/src/text.ts`, `packages/extraction/src/evidence.ts`, `packages/extraction/test/evidence.test.ts`

**Interfaces:**
- Produces:
  - `foldForMatch(s: string): { folded: string; map: number[] }` — NFKC, curly quotes→straight, en/em dash→`-`, whitespace runs→single space, trimmed; `map[i]` = index in the original string of folded char `i`.
  - `findEvidence(parsedText: string, quote: string): { start: number; end: number } | null` — offsets into the **original** `parsedText`.
  - `normalizeEvidenceForCompare(s: string): string` — `foldForMatch(s).folded.toLowerCase()` (used by carry-over).

- [ ] **Step 1: Write failing tests:**
  - quote split across a PDF line break (`"Total Due:\n$1,234.50"` vs `"Total Due: $1,234.50"`) → found, and `parsedText.slice(start,end)` contains `"Total Due:"` and `"$1,234.50"`.
  - Review Focus 1: text `"Tenant’s deposit – ﬁve hundred"`, quote `"Tenant's deposit - five hundred"` → found.
  - hallucinated quote `"Total Due: $9,999.00"` → `null`.
  - empty / whitespace-only quote → `null`.
  - quote matching only case-insensitively → `null` (matching stays case-sensitive).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement with `foldForMatch` on both sides and `indexOf` on folded text, mapping back through `map`.
- [ ] **Step 4:** PASS. **Step 5:** Commit `feat(extraction): verbatim evidence validation`.

### Task 4: `packages/extraction` — extraction result assembly and carry-over

**Files:**
- Create: `packages/extraction/src/assemble.ts`, `packages/extraction/src/carryover.ts`, tests `assemble.test.ts`, `carryover.test.ts`

**Interfaces:**
- Consumes: `normalizeValue`, `canonicalJson`, `EXPECTED_FIELDS` (Task 2); `findEvidence`, `normalizeEvidenceForCompare` (Task 3).
- Produces:
  - `type LlmField = { value: unknown; evidence: string | null; gap_reason: string | null }`
  - `type AssembledValue = { fieldName; fieldType; value: FieldValue|null; evidence: string|null; evidenceStart: number|null; evidenceEnd: number|null; gapReason: string|null }`
  - `assembleValues(docType: DocumentType, parsedText: string, output: Record<string, LlmField | undefined>): AssembledValue[]` — one entry per expected field, in fixture order.
  - `type BaselineValue = { id: string; value: FieldValue|null; evidence: string|null; gapReason: string|null; latestReview: { id: string; action: 'approved'|'corrected'; correctedValue: FieldValue|null; note: string|null } | null }`
  - `type CarryDecision = { fieldName: string; changeStatus: 'new'|'unchanged'|'changed'; previousValueId: string|null; carryReviewId: string|null }`
  - `diffAgainstBaseline(next: AssembledValue[], baseline: Map<string, BaselineValue> | null): CarryDecision[]`

- [ ] **Step 1: Failing tests `assemble.test.ts`:**
  - LLM value `null` + `gap_reason:"not stated"` → gap with that reason.
  - value present, evidence not in text → value `null`, gapReason `"evidence not found verbatim in document text"`.
  - value present, evidence `null` → gap `"no evidence quoted"`.
  - value `"abc"` for money with valid evidence → gap `"value not parseable as money"`.
  - field missing from output → gap `"field missing from model output"`; extra key `foo` ignored; result length equals expected count (Review Focus 5).
- [ ] **Step 2: Failing tests `carryover.test.ts`:**
  - baseline `null` → all `new`, no carry.
  - same evidence differing only in whitespace/case + same canonical value + baseline review → `unchanged`, `carryReviewId` = that review id.
  - same evidence, different value → `changed`, `previousValueId` set, no carry.
  - different evidence, same value → `changed`.
  - both gaps with equal reason → `unchanged`; unchanged with no baseline review → `unchanged`, `carryReviewId: null`.
  - field absent from baseline → `new`.
- [ ] **Step 3:** Run → FAIL. **Step 4:** Implement. **Step 5:** PASS. **Step 6:** Commit `feat(extraction): value assembly and carry-over diff`.

### Task 5: `packages/extraction` — prompt, JSON schema, LLM client, SSRF guard

**Files:**
- Create: `packages/extraction/src/prompt.ts`, `src/llm.ts`, `src/safe-fetch.ts`, `src/pdf.ts`, tests `prompt.test.ts`, `safe-fetch.test.ts`, `llm.test.ts`

**Interfaces:**
- Produces:
  - `buildExtractionRequest(docType: DocumentType, parsedText: string): { system: string; user: string; jsonSchema: object }` — schema: object with one required property per expected field, each `{value: [type-appropriate|null], evidence: string|null, gap_reason: string|null}`, `additionalProperties:false`, `strict:true`. Prompt instructs: quote evidence verbatim, copy exactly, null + reason when absent, never guess.
  - `interface LlmClient { completeJson(req: { system: string; user: string; jsonSchema: object; schemaName: string }): Promise<{ parsed: unknown; raw: unknown }> }`
  - `class LlmError extends Error { kind: 'transient'|'permanent'; status?: number }` — 408/429/5xx/network/timeout → transient; other 4xx and JSON parse failures → permanent.
  - `createOpenAiCompatibleClient(opts: { baseUrl: string; apiKey: string; model: string; allowPrivateHosts: boolean; timeoutMs?: number }): LlmClient` — `openai` SDK with `fetch: createSafeFetch(...)`, `maxRetries: 0`, `temperature: 0`, `response_format: { type:'json_schema', json_schema:{ name, schema, strict:true } }`.
  - `verifyProvider(opts): Promise<void>` — one completion with a 1-property schema; throws `LlmError` (used by login).
  - `createSafeFetch(opts: { allowPrivateHosts: boolean }): typeof fetch` — undici `Agent` with custom `connect.lookup` rejecting blocked IPs; `redirect: 'error'`; rejects non-https unless `allowPrivateHosts`.
  - `isBlockedAddress(ip: string): boolean`
  - `class FakeLlmClient implements LlmClient` (exported from `@lomi/extraction/testing`) — constructed with `(req) => unknown | Promise<unknown>`; records calls.
  - `extractPdfText(pdf: Uint8Array): Promise<string>` — unpdf `extractText` with `mergePages: true`; throws `LlmError('permanent')`-style `PdfParseError` on failure/empty text.

- [ ] **Step 1: Failing tests:**
  - `prompt.test.ts`: invoice schema `required` equals the 5 invoice field names; `additionalProperties === false`.
  - `safe-fetch.test.ts`: `isBlockedAddress` true for `127.0.0.1`, `10.1.2.3`, `172.16.0.1`, `192.168.1.1`, `169.254.169.254`, `100.64.0.1`, `::1`, `fd00::1`, `::ffff:127.0.0.1`; false for `1.1.1.1`, `2606:4700::1111`. `createSafeFetch({allowPrivateHosts:false})('http://example.com')` rejects with `https required`.
  - `llm.test.ts` (against a local `http.createServer` stub, `allowPrivateHosts:true`): 200 with JSON content → `parsed` equals content; 503 → `LlmError` kind `transient`; 401 → `permanent`; content `"not json"` → `permanent`; the request body contains `response_format.type === 'json_schema'`.
  - `pdf.test.ts`: `extractPdfText(invoice-001.pdf)` non-empty and contains `"Meridian"`; record which two invoice fields differ between v1 and v2 text in a comment at top of `carryover.test.ts` for later tasks.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(extraction): prompt, OpenAI-compatible client, SSRF guard, PDF text`.

### Task 6: `packages/storage` — local + S3 file storage

**Files:**
- Create: `packages/storage/src/{types.ts,keys.ts,local.ts,s3.ts,create-storage.ts,index.ts}`, tests `packages/storage/test/{keys.test.ts,create-storage.test.ts,contract.int.test.ts}`

**Interfaces:**
- Produces:
  - `interface FileStorage { readonly kind: 'local'|'s3'; put(key: string, bytes: Uint8Array, contentType: string): Promise<void>; get(key: string): Promise<Uint8Array>; exists(key: string): Promise<boolean>; delete(key: string): Promise<void>; list(prefix: string): Promise<{ key: string; lastModified: Date }[]>; signedGetUrl(key: string, ttlSeconds: number): Promise<string | null> }`
  - `class FileNotFoundError extends Error { key: string }` — thrown by `get` for a missing key in both implementations.
  - `pdfStorageKey(originalFilename: string, sha256Hex: string): string` → `pdfs/<slug>-<sha256>.pdf` per spec §File storage.
  - `sha256Hex(bytes: Uint8Array): string` (lowercase).
  - `class LocalFileStorage implements FileStorage` — `constructor(rootDir: string)`; rejects keys containing `..` or starting with `/`; `put` writes `<file>.tmp-<random>` then `rename`; `signedGetUrl` → `null`.
  - `class S3FileStorage implements FileStorage` — `constructor(cfg: S3Config)`; `signedGetUrl` via `@aws-sdk/s3-request-presigner` `GetObjectCommand` with `ResponseContentType: 'application/pdf'`, `ResponseContentDisposition: 'inline; filename="<original>"'` passed by caller via optional 3rd arg `{ filename?: string }`.
  - `type S3Config = { endpoint?: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean }`
  - `createStorage(env: Record<string, string | undefined>): FileStorage`

- [ ] **Step 1: Failing unit tests:**
  - `keys.test.ts`: `pdfStorageKey('Invoice 001 (Rev).PDF', 'AB12…')` → `pdfs/invoice-001-rev-ab12….pdf` (hash lowercased); `'../../etc/passwd.pdf'` → `pdfs/etc-passwd-<hash>.pdf`; `'.pdf'` → `pdfs/document-<hash>.pdf`; 200-char name → slug length ≤ 80; non-ASCII `'Factura Nº 7.pdf'` → `pdfs/factura-n-7-<hash>.pdf` (NFKD, strip marks).
  - `create-storage.test.ts`: no S3 vars → `kind 'local'` rooted at `STORAGE_DIR ?? '/data/files'`; bucket+key+secret → `kind 's3'`; only `S3_BUCKET` set → throws with message containing `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`; `S3_FORCE_PATH_STYLE='true'` parsed to boolean.
- [ ] **Step 2: Failing contract test** `contract.int.test.ts` — one `describe.each` over `[local (tmp dir), s3 (Testcontainers minio/minio, bucket created in beforeAll)]`:
  - put → exists true → get returns identical bytes; put same key twice → no error, bytes unchanged.
  - get missing → `FileNotFoundError`; delete missing → resolves.
  - list(`pdfs/`) returns put keys with `lastModified` within 60s of now.
  - local: `signedGetUrl` → `null`; local key `'../x'` → throws. s3: `signedGetUrl(key, 300)` → `fetch` returns 200 with same bytes; URL contains `X-Amz-Expires=300`.
- [ ] **Step 3:** Run → FAIL. **Step 4:** Implement. **Step 5:** PASS. **Step 6:** Commit `feat(storage): local and S3 file storage with auto-selection`.

### Task 7: `packages/db` — schema, migrations, repositories, seed

**Files:**
- Create: `packages/db/src/{schema.ts,client.ts,repo/documents.ts,repo/runs.ts,repo/values.ts,repo/users.ts,seed.ts,migrate.ts}`, `drizzle.config.ts`, `drizzle/` (generated), `packages/db/test/{setup.ts,documents.int.test.ts,progress.int.test.ts,seed.int.test.ts}`

**Interfaces:**
- Consumes: shared types (Task 2); `FileStorage`, `pdfStorageKey`, `sha256Hex` (Task 6).
- Produces (all take `db: Db` first):
  - Tables exactly as in spec §Schema, pgEnums `run_status`, `change_status`, `review_action`, `review_origin`, `doc_type`.
  - `type StoredFile = { storageKey: string; originalFilename: string; sha256: string; sizeBytes: number }`
  - `storePdf(storage: FileStorage, originalFilename: string, bytes: Uint8Array): Promise<StoredFile>` — computes hash + key, `put` (spec order: storage before DB).
  - `createDocumentWithVersion(db, { userId, type, title, externalId?, file: StoredFile }): Promise<{ documentId; versionId; runId }>` — one tx.
  - `addVersion(db, { documentId, userId, file: StoredFile }): Promise<{ versionId; versionNumber; runId }>` — tx: `SELECT … FROM documents WHERE id=$1 AND user_id=$2 FOR UPDATE`, next number = max+1, insert version + queued run, set `active_run_id`, set `current_version_id`.
  - `createRetryRun(db, { documentId, userId }): Promise<{ runId } | { error: 'NOT_FAILED' }>`
  - `getDocumentDetail(db, { documentId, userId, versionNumber? }): Promise<DocumentDetail | null>` — values joined with latest review (`DISTINCT ON (value_id) ORDER BY created_at DESC`) and previous value + its latest review.
  - `listDocuments(db, userId): Promise<DocumentSummary[]>`
  - `getProgress(db, { documentId, userId }): Promise<Progress | null>`
  - `insertReview(db, { valueId, userId, action, correctedValue, note }): Promise<{ id } | { error: 'NOT_FOUND' | 'VALUE_NOT_CURRENT' }>`
  - `getVersionFile(db, { documentId, userId, versionNumber }): Promise<StoredFile | null>` (ownership-checked).
  - `listReferencedStorageKeys(db): Promise<Set<string>>`
  - `seedWorkspace(db, storage, userId, fixturesDir): Promise<string[]>` — stores each v1 PDF via `storePdf`; returns runIds created (empty on repeat).
  - `migrateToLatest(databaseUrl): Promise<void>`
  - `src/crypto.ts`: `encryptKey(plain: string, keyHex: string): Buffer`, `decryptKey(buf: Buffer, keyHex: string): string` (AES-256-GCM, 12-byte IV prefix, tag suffix); `identityHash(secret, baseUrl, apiKey): string` (baseUrl lowercased, trailing `/` stripped). Test `test/crypto.test.ts`: round-trip; tampered byte → throws; `identityHash` equal for `https://x/v1` vs `https://X/v1/`.
  - Test helper `startTestDb(): Promise<{ db; url; stop }>` (Testcontainers `postgres:17-alpine` + migrate).

- [ ] **Step 1:** Write schema; `pnpm --filter @lomi/db drizzle-kit generate`; commit migration SQL.
- [ ] **Step 2: Failing integration tests:**
  - `documents.int.test.ts`: `createDocumentWithVersion` → detail status `queued`, version 1, `active_run_id` = runId; `addVersion` twice concurrently via `Promise.all` → version numbers `{2,3}` (Review Focus 2); other user's `documentId` → `null`.
  - inserting two `extracted_values` with same `(version_id, field_name)` → unique violation (`23505`).
  - `progress.int.test.ts`: fixture with 5 values: 1 no review, 1 approved, 1 corrected, 1 carried, 1 approved-then-corrected → `{pending:1, approved:1, corrected:2, carried_over:1, total:5}`.
  - `insertReview` on a value of version 1 after version 2 is current → `VALUE_NOT_CURRENT` (Review Focus 3).
  - `seed.int.test.ts` (with `LocalFileStorage` on a tmp dir): `seedWorkspace` creates 3 documents, version 1 each, 3 queued runs, `storage_key` = `pdfs/invoice-001-<sha>.pdf` etc. and each key `exists`; second call returns `[]` and document count stays 3.
  - `getVersionFile` for another user's document → `null`.
- [ ] **Step 3:** Run `pnpm --filter @lomi/db test:integration` → FAIL. **Step 4:** Implement repos. **Step 5:** PASS. **Step 6:** Commit `feat(db): schema, migrations, repositories, seed`.

### Task 8: `apps/worker` — run lifecycle

**Files:**
- Create: `apps/worker/src/{main.ts,worker.module.ts,config.ts,queue.ts,process-run.ts,finalize.ts,llm-for-user.ts}`, `apps/worker/test/process-run.int.test.ts`
- Modify: `packages/db/src/repo/runs.ts` (add the run functions below)

**Interfaces:**
- Consumes: Tasks 3–7 (`FileStorage.get` for the version's `storage_key`).
- Produces:
  - `QUEUE_NAME = 'extraction'`; job data `{ runId: string }`; `enqueueRun(queue, runId)` = `queue.add('extract', {runId}, { jobId: runId, attempts: 1, removeOnComplete: 1000, removeOnFail: 1000 })` (exported from `packages/db/src/queue.ts` so the API shares it).
  - `claimRun(db, runId): Promise<ClaimedRun | null>`; `heartbeat(db, runId): Promise<void>`; `markSuperseded`, `markFailed(db, runId, { kind, message, prompt?, raw? })` — `markFailed` with kind `transient` and attempt < 3 also inserts the next-attempt queued run, sets `active_run_id`, and returns its id.
  - `processRun(deps: { db; storage: FileStorage; llmFor(userId): Promise<LlmClient>; enqueue(runId): Promise<void>; now?(): Date }, runId: string): Promise<'extracted'|'failed'|'superseded'|'skipped'>`
  - `finalizeRun(db, { runId, values: AssembledValue[], decisions: CarryDecision[], prompt, raw }): Promise<boolean>` — single tx guarded as in spec; `false` when the guard fails.

- [ ] **Step 1: Failing integration tests** (Testcontainers Postgres, `FakeLlmClient`, real fixture PDFs):
  - happy path invoice → `'extracted'`, 5 values, document status `extracted`, run has `prompt` and `raw_response` non-null.
  - **duplicate delivery:** `Promise.all([processRun(id), processRun(id)])` → one `'extracted'`, one `'skipped'`; exactly 5 values.
  - **retry after success:** create retry-style second run for same version manually, process it → finalize returns false, still 5 values.
  - **supersede before LLM:** add version 2 before processing v1 run → v1 returns `'superseded'`, fake LLM call count 0.
  - fake throws `LlmError('transient')` → run 1 `failed`, run 2 `queued` and active, `enqueue` called with run 2; on attempt 3 failure no new run and document status `failed`.
  - fake throws `permanent` → document `failed`, error message stored.
  - storage file deleted before processing → run `failed` (permanent) with error `source file missing`, fake LLM call count 0.
  - fake returns a quote not in the text for `total_amount` → stored gap with reason `evidence not found verbatim in document text`.
  - Review Focus 5: fake omits `due_date` and adds `foo` → `due_date` gap `field missing from model output`, 5 values.
  - **re-extraction:** v1 extracted with reviews on all 5 fields; upload `invoice-001.v2.pdf`; fake returns v2 values → exactly the 2 changed fields (from Task 5 note) have no review and `change_status='changed'` with `previous_value_id`; other 3 have a review `origin='carried_over'`; progress `{pending:2, carried_over:3}`; v1 values and reviews still returned by `getDocumentDetail(…, versionNumber:1)`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement `processRun`: claim → supersede check → ensure `parsed_text` (`storage.get(storage_key)`, `FileNotFoundError` → permanent "source file missing"; parse once, `UPDATE … WHERE parsed_text IS NULL`) → start heartbeat interval (15s, lease 60s) → LLM → `assembleValues` → load baseline → `diffAgainstBaseline` → `finalizeRun`; errors classified to `markFailed`. `llmFor(userId)`: local user → env `LLM_*` if set, else the user's stored config, else throw `LlmError('permanent', 'No LLM configured')`; byok user → decrypt key (`decryptKey` from Task 7). `allowPrivateHosts = AUTH_MODE==='local'`. Add test: local user with no env and no stored config → run `failed`, error `No LLM configured`. Worker `config.ts` refuses to start when `AUTH_MODE=local` and `PUBLIC_ORIGIN` host isn't `localhost`/`127.0.0.1`.
- [ ] **Step 4:** PASS. **Step 5:** Wire `main.ts`: Nest `createApplicationContext`, BullMQ `Worker` concurrency 4 calling `processRun`; graceful shutdown on SIGTERM (close worker, leave runs for reconciler). **Step 6:** Commit `feat(worker): idempotent run lifecycle with carry-over`.

### Task 9: `apps/worker` — reconciler and cleanup

**Files:**
- Create: `apps/worker/src/reconciler.ts`, `apps/worker/src/cleanup.ts`, `apps/worker/test/reconciler.int.test.ts`

**Interfaces:**
- Produces: `reconcile(deps: { db; enqueue(runId): Promise<void>; now(): Date }): Promise<{ requeued: string[]; expired: string[] }>`; `cleanupIdleUsers(db, now): Promise<number>`; `sweepOrphanFiles(db, storage, now): Promise<string[]>` (deleted keys). Scheduled in `main.ts`: reconcile at boot then every 30s; cleanup hourly only when `AUTH_MODE==='byok'`; orphan sweep hourly always.

- [ ] **Step 1: Failing tests** (Testcontainers Postgres **and** Redis):
  - **FLUSHALL:** create 2 queued runs, enqueue, `redis.flushall()`, `reconcile` → both re-added; queue `getJob(runId)` exists for each.
  - re-running `reconcile` with jobs present → queue job count unchanged (jobId dedupe).
  - **killed worker:** run `extracting` with `lease_expires_at` in the past → marked `failed` (`worker lost lease`), new queued attempt created and enqueued; at attempt 3 → document `failed`, no new run.
  - live lease (future) → untouched.
  - `cleanupIdleUsers`: byok user idle 8 days deleted with documents; local user and 6-day user kept.
  - `sweepOrphanFiles` (`LocalFileStorage` tmp dir, `now` injected): unreferenced key 2h old → deleted; unreferenced key 10 min old → kept (in-flight upload); referenced key 2h old → kept; after `cleanupIdleUsers` deletes a user, that user's keys are swept unless another version references the same key.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(worker): reconciler, idle-user cleanup, orphan file sweep`.

### Task 10: `apps/api` — auth modes (local: no sessions; byok: sessions)

**Files:**
- Create: `apps/api/src/{main.ts,app.module.ts,config.ts}`, `apps/api/src/auth/{user-resolver.ts,local-user.resolver.ts,session-user.resolver.ts,auth.guard.ts,auth.controller.ts,auth.service.ts,current-user.decorator.ts}`, `apps/api/src/settings/settings.controller.ts`, tests `apps/api/test/auth-byok.int.test.ts`, `apps/api/test/auth-local.int.test.ts`, `apps/api/test/config.test.ts`
- Modify: `packages/db/src/repo/users.ts` (add `ensureLocalUser(db): Promise<User>`, `saveLlmConfig(db, userId, { baseUrl, model, encryptedKey })`, `retryFailedRunsForUser(db, userId): Promise<string[]>`)

**Interfaces:**
- Consumes: `verifyProvider` (Task 5), `seedWorkspace`, `encryptKey`, `identityHash` (Task 7).
- Produces:
  - `interface UserResolver { resolve(req: Request): Promise<User | null> }`; `LocalUserResolver` (always the `is_local` user, no cookie read); `SessionUserResolver` (reads `sid`, refreshes `expires_at` + `last_seen_at`). Bound in `AppModule` by `AUTH_MODE`. Global `AuthGuard` (except `/auth/*`, `/health`) calls the resolver → 401 on `null`; sets `req.user`.
  - `loadConfig(env)` throws `"AUTH_MODE=local is only allowed when PUBLIC_ORIGIN is localhost"` for a non-local origin.
  - `GET /auth/config` → `{ mode: 'local'|'byok', llmConfigured: boolean, llmSource: 'env'|'settings'|null, presets: {name, baseUrl}[] }` (no key material).
  - **byok only** (404 in local mode): `POST /auth/login` body `LoginRequest` → verifies provider, upserts user by identity hash (updates model + encrypted key), creates session, seeds workspace if new, sets cookie; `401 PROVIDER_REJECTED` with provider message; `429` beyond 10/min/IP (`@nestjs/throttler`). `POST /auth/logout` → deletes session, clears `encrypted_key`.
  - **local only** (404 in byok mode): `PUT /settings/llm` body `LoginRequest` → `verifyProvider`, `saveLlmConfig`, `retryFailedRunsForUser` + enqueue each → `200 { llmConfigured: true, retried: n }`; `409 ENV_CONFIGURED` when `.env` `LLM_*` is set (env wins).
  - `GET /auth/me` → `{ mode, model, baseUrl }`.

- [ ] **Step 1: Failing tests:**
  - `config.test.ts`: `AUTH_MODE=local` + `PUBLIC_ORIGIN=https://lomi.sairam.cc` → throws; `http://localhost:3000` and `http://127.0.0.1:3000` → ok; byok + any origin → ok.
  - `auth-local.int.test.ts`: `GET /documents` with **no cookie** → 200 with the 3 seeded docs; no `Set-Cookie` header on any response; `POST /auth/login` → 404; zero rows in `sessions`; with no env LLM: `/auth/config` → `llmConfigured:false`; `PUT /settings/llm` (verifyProvider overridden) → 200, failed runs re-queued, `/auth/config` → `llmSource:'settings'`; with env LLM set → `PUT /settings/llm` → 409 `ENV_CONFIGURED`.
  - `auth-byok.int.test.ts` (Nest testing module + supertest; `verifyProvider` overridden): login sets `sid` cookie `HttpOnly; SameSite=Lax`; same key twice → same user id and still 3 documents; different key → different user; `/documents` without cookie → 401; `PUT /settings/llm` → 404; `baseUrl: 'http://10.0.0.5/v1'` → 400 `https required` / blocked host; logout → `encrypted_key` null and cookie no longer works; key never appears in any response body.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(api): local no-auth mode and bring-your-own-key sessions`.

### Task 11: `apps/api` — documents, versions, reviews, progress

**Files:**
- Create: `apps/api/src/documents/{documents.controller.ts,documents.service.ts}`, `apps/api/src/values/values.controller.ts`, `apps/api/src/queue/queue.provider.ts`, `apps/api/src/health.controller.ts`, test `apps/api/test/documents.int.test.ts`

**Interfaces:**
- Consumes: repos + `storePdf` + `getVersionFile` (Task 7), `createStorage` (Task 6), `enqueueRun` (Task 8).
- Produces:
  - Upload order in both upload routes: validate → `storePdf` (storage put) → DB tx → enqueue. Storage failure → `500 STORAGE_UNAVAILABLE`, no DB rows.
  - `GET /documents/:id/versions/:n/file` → owner only (404 otherwise); local storage → `200 application/pdf` streamed with `Content-Disposition: inline; filename="<original_filename>"` and `Cache-Control: private, no-store`; S3 → `302 Location: <signedGetUrl(key, 300, {filename})>`.
  - `DocumentDetail.versions[]` include `originalFilename` and `fileUrl: '/api/documents/:id/versions/:n/file'`.
  - `GET /documents` → `DocumentSummary[]` (with `progress`).
  - `POST /documents` multipart `type` + `file` (+ optional `title`, default filename) → `201 { id, status:'queued', version:1 }`; rejects non-PDF (magic bytes `%PDF-`) or >5 MB → 400; 26th document → `409 DOCUMENT_LIMIT`; 6th in-flight run → `429 TOO_MANY_IN_FLIGHT`.
  - `POST /documents/:id/versions` multipart `file` → `201 { id, version, status:'queued' }`.
  - `GET /documents/:id?version=N` → `DocumentDetail` (`status`, `currentVersion`, `versions[]`, `parsedText`, `values: ValueView[]`, `latestRun {status,error,attempt}`).
  - `POST /documents/:id/retry` → `202` or `409 NOT_FAILED`.
  - `POST /values/:id/review` body `ReviewRequest` → `201 ValueView`; correction normalized by `normalizeValue`, invalid → `400 INVALID_VALUE` with reason; `409 VALUE_NOT_CURRENT`.
  - `GET /documents/:id/progress` → `Progress`.
  - `GET /health` → `{ ok: true }`.
  - Enqueue after commit; Redis error caught and logged (`warn`), response still 201.

- [ ] **Step 1: Failing tests** (Testcontainers Postgres + Redis):
  - upload invoice → 201 in < 500 ms with a fake LLM that never resolves (proves no LLM wait); job exists in queue with id = runId.
  - **Redis down:** stop Redis container, upload → still 201, run `queued` in DB.
  - Review Focus 2: two concurrent version uploads → 201 + 201 with versions 2 and 3.
  - Review Focus 3: review v1 value after v2 uploaded → 409 `VALUE_NOT_CURRENT`.
  - Review Focus 4: correct money with `"abc"` → 400 and message contains `money`; date `"31/02/2026"` → 400.
  - correct with value + note → response `effectiveValue` equals normalized correction, `review.note` set; progress `corrected:1`.
  - other user's document → 404 on every route.
  - text file renamed `.pdf` → 400.
  - upload `Invoice 001.PDF` → version `storage_key` = `pdfs/invoice-001-<lowercase sha256>.pdf`, file exists in storage.
  - storage `put` stubbed to throw → 500 `STORAGE_UNAVAILABLE`, zero document rows.
  - file route: owner → 200 `application/pdf` with identical bytes; no cookie → 401; other user → 404; with `S3FileStorage` (MinIO container) → 302 whose `Location` fetches the same bytes.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (multer memory storage, 5 MB limit; storage injected via a `STORAGE` provider from `createStorage(process.env)`). **Step 4:** PASS. **Step 5:** Commit `feat(api): documents, versions, reviews, progress`.

### Task 12: Design system and screen designs (Claude Artifacts)

The account has no design system yet, so this task creates one, then designs every screen with it. Nothing in `apps/web` is written until the user approves the designs.

**Files:**
- Create: `docs/design/README.md` (links to both artifacts + the approved token table), `apps/web/design-tokens.css` (the `@theme` block derived from the design system)

**Interfaces:**
- Consumes: spec §UI, §Auth (login fields), §File storage ("Open PDF"); API shapes `DocumentSummary`, `DocumentDetail`, `ValueView`, `Progress` (Task 2) so mockups show real fields.
- Produces: an approved **"Lomi Review" design system** artifact (from the Design System type) and an approved **"Lomi Review — Screens"** design artifact (from the Design type, using that system); `design-tokens.css` exporting Tailwind 4 `@theme` variables: `--color-*` (surface, text, border, accent, and the six status colors `pending`, `approved`, `corrected`, `carried`, `failed`, `queued`), `--font-sans`, `--font-mono`, `--radius-*`, `--shadow-*`. Task 13 Step 0 imports this file instead of inventing colors.

- [ ] **Step 1:** `Artifact` quickstart with `intent: "other"`, start from the Design System type; define brand-neutral "Lomi Review" foundations: color tokens (light + dark), type scale (sans for UI, mono for document text and evidence quotes), spacing, radius, elevation, and components: Button (primary/secondary/ghost/danger), Input, Select, Textarea, Badge (one per status + Carried over / Changed / New / Gap), ProgressBar (4 segments), Table row, Card, Quote block, Highlight mark, Toast, Empty state. Publish; user reviews and approves.
- [ ] **Step 2:** `Artifact` quickstart with `intent: "design"` using the approved design system; artboards at 1440 desktop and 390 mobile for: (1) Login — live mode only (provider presets, base URL, key, model, provider-rejected error); (1b) Local-mode "No LLM configured" banner + LLM settings form; (2) Document list (all four statuses, failed + Retry, progress bars, upload dialog, empty state); (3) Document detail on first extraction ("5 values need your review", value rows beside quotes, a gap row with reason, correct form open with an inline validation error, parsed text with the active quote highlighted, Open PDF); (4) Detail after re-extraction ("2 values need your review", 3 Carried over, 2 Changed rows each with a "Previously" box showing old value + review); (5) Historical version view (read-only, superseded label); (6) Extracting / failed states of the detail header. Acceptance bar from the brief: a reviewer knows what needs attention within five seconds.
- [ ] **Step 3:** User reviews the screens and comments on the artifact; iterate until approved.
- [ ] **Step 4:** Write `apps/web/design-tokens.css` from the design system's token values and `docs/design/README.md` (artifact links, token table, component → React file mapping for Tasks 13–14). Commit `docs(design): design system and approved screen designs`.

### Task 13: `apps/web` — login and document list

**Files:**
- Create: `apps/web/{next.config.ts,postcss.config.mjs,app/globals.css,app/layout.tsx,app/providers.tsx,app/login/page.tsx,app/page.tsx,lib/api.ts,components/StatusBadge.tsx,components/ProgressBar.tsx,components/UploadDialog.tsx}`

**Interfaces:**
- Consumes: shared zod types (Task 2); API routes (Tasks 10–11); approved designs + tokens (Task 12).
- Produces: `next.config.ts` rewrites `/api/:path*` → `${API_INTERNAL_URL}/:path*`; `lib/api.ts` typed `apiGet/apiPost/apiUpload` throwing `ApiError {status, code, message}`; `usePollWhileBusy(query)` — `refetchInterval: data has queued|extracting ? 2000 : false`.

- [ ] **Step 0:** Tailwind CSS 4 via `@tailwindcss/postcss`; `app/globals.css` = `@import "tailwindcss"; @import "../design-tokens.css";` (tokens from Task 12; no ad-hoc hex colors in components). All styling is Tailwind utility classes built from those tokens, matching the approved Task 12 screens; no other CSS framework or component library. `layout.tsx` imports `globals.css`.
- [ ] **Step 1:** Login page (byok mode): provider preset select (fills base URL), API key (password input), model; shown only in byok mode (local mode never shows a login page: `/login` redirects to `/`); error from `PROVIDER_REJECTED` shown inline; in local mode with `llmConfigured:false`, a banner "No LLM configured" links to `/settings` (same form, `PUT /settings/llm`, success toast "Saved — retrying N documents"); note "Your key is encrypted and only used for your extractions."
- [ ] **Step 2:** List page: table of title, type, `StatusBadge` (queued grey, extracting animated blue, extracted green, failed red with Retry button), current version, `ProgressBar` (segments pending amber / approved green / corrected blue / carried-over teal, plus "N pending"), Upload button (type select + file). Redirect to `/login` on 401.
- [ ] **Step 3:** Verify: `pnpm --filter web build` passes; run stack via `pnpm dev`, log in, see 3 seeded docs go queued → extracted without manual refresh.
- [ ] **Step 4:** Commit `feat(web): login and document list with live status`.

### Task 14: `apps/web` — document detail and review

**Files:**
- Create: `apps/web/app/documents/[id]/page.tsx`, `components/{ValueRow.tsx,ReviewForm.tsx,EvidenceText.tsx,VersionSwitcher.tsx,ChangeBadge.tsx}`

**Interfaces:**
- Consumes: `GET /documents/:id`, `POST /values/:id/review`, `POST /documents/:id/versions`, `POST /documents/:id/retry`.

- [ ] **Step 1:** Header: title, status, version switcher (non-current versions read-only, labeled "superseded / historical") showing each version's original filename with an "Open PDF" link to `fileUrl` (new tab; works for both local streaming and S3 redirect), headline **"N values need your review"** (or "All reviewed ✓"), Upload new version, Retry when failed with error text.
- [ ] **Step 2:** Left column `ValueRow`s sorted pending-first: field label, effective value (corrected value shown with original struck through), evidence in a quote block, gap shown as `Gap: <reason>` in amber (never hidden), `ChangeBadge` (`Carried over` teal, `Changed` amber, `New`); for changed rows a "Previously" box with old value + old review (action, corrected value, note). Approve button; Correct opens inline form (type-aware input + optional note), shows 400 message inline.
- [ ] **Step 3:** Right column `EvidenceText`: version's `parsedText` in monospace with `<mark>` over `[evidenceStart, evidenceEnd)` of the hovered/selected row; clicking a row scrolls to its mark.
- [ ] **Step 4:** Verify manually against the stack: approve/correct update progress; upload `invoice-001.v2.pdf` → headline shows 2 needing review, 3 carried over. Commit `feat(web): review detail with evidence highlighting and carry-over`.

### Task 15: Docker Compose, Dockerfiles, seed on boot

**Files:**
- Create: `compose.yml`, `apps/{api,worker,web}/Dockerfile`, `packages/db/Dockerfile.migrate` (or a `migrate` target), `.dockerignore`, `scripts/chaos.sh`

**Interfaces:**
- Produces: compose services `postgres` (healthcheck, volume), `redis` (no persistence: `--save "" --appendonly no`, proving Postgres is the record), `migrate` (runs `migrateToLatest`, then in local mode `ensureLocalUser` + `seedWorkspace` always, key or not; `restart: "no"`), `api` (depends_on migrate `service_completed_successfully`), `worker` (same), `web` (port 3000). Named volume `files` mounted at `/data/files` in `migrate`, `api` and `worker`. Optional `minio` + `minio-init` (creates bucket `lomi`) under `profiles: [s3]`; README shows `S3_*` values to point at it. Multi-stage Dockerfiles using `turbo prune --docker`. Compose reads `.env` with defaults so `docker compose up` works without one (then login requires a key).

- [ ] **Step 1:** Write Dockerfiles + compose. Copy `assignment/fixtures` into the migrate image.
- [ ] **Step 2:** Verify `docker compose up --build` → `http://localhost:3000` loads; with `LLM_API_KEY` set, the list opens directly (no login) and 3 documents reach `extracted`; with no `LLM_*` set, docs show `failed` + "No LLM configured" banner, and saving the settings form makes them reach `extracted`; "Open PDF" opens the file. Repeat with `docker compose --profile s3 up` and `S3_*` set → api logs `storage: s3`, "Open PDF" redirects to a MinIO signed URL.
- [ ] **Step 3:** `scripts/chaos.sh` (bash, documented in README): (a) upload v2 then `docker compose kill worker` while `extracting`, `docker compose up -d worker`, poll until `extracted` or `failed`; (b) `docker compose exec redis redis-cli FLUSHALL && docker compose restart`, assert no document stuck in `extracting` after 90s and value/review counts unchanged (via `docker compose exec postgres psql`). Run it; both PASS.
- [ ] **Step 4:** Commit `feat: docker compose stack with migrate+seed and chaos script`.

### Task 16: End-to-end test with fake OpenAI-compatible server

**Files:**
- Create: `packages/testing/src/fake-openai-server.ts` (HTTP server answering `POST /chat/completions` by doc type detected from the prompt, with recorded responses in `packages/testing/fixtures/*.json` that quote real fixture text), `apps/web/e2e/review-flow.spec.ts`, `apps/web/playwright.config.ts`, `compose.e2e.yml` (adds `fake-llm` service, sets `LLM_BASE_URL=http://fake-llm:4010/v1`, `AUTH_MODE=local`)

- [ ] **Step 1: Failing test** `review-flow.spec.ts`: open `/` (no login, no cookie) → 3 rows reach `extracted`; open invoice → "5 values need your review"; approve all 5 → "All reviewed"; upload `invoice-001.v2.pdf` → status reaches `extracted`; headline "2 values need your review"; exactly 3 `Carried over` badges and 2 `Changed` badges each with a "Previously" box.
- [ ] **Step 2:** `docker compose -f compose.yml -f compose.e2e.yml up -d --build && pnpm --filter web test:e2e` → FAIL until fake server and fixtures exist; implement; PASS.
- [ ] **Step 3:** Add an `e2e` job to `ci.yml` running the same. Commit `test: e2e review and re-extraction flow`.

### Task 17: Production deploy

**Files:**
- Create: `compose.prod.yml`, `Caddyfile`, `.github/workflows/deploy.yml`, `scripts/setup-deploy.sh` (from the wizard skill's `template.sh`)

**Interfaces:**
- Produces: `compose.prod.yml` overrides images to `ghcr.io/<owner>/lomi-{api,worker,web}:${IMAGE_TAG}`, sets `AUTH_MODE=byok`, adds `caddy` (ports 80/443, volume for certs), removes host ports from api/web. `Caddyfile`: `lomi.sairam.cc { reverse_proxy web:3000 }`. `deploy.yml`: on push to `main` after CI success → build+push 3 images tagged `${{ github.sha }}` and `latest`; `appleboy/ssh-action` (or plain `ssh`) with `VPS_SSH_KEY` → `mkdir -p ~/lomi`, copy `compose.yml compose.prod.yml Caddyfile` via scp, write `.env` from secrets (optional `S3_*` secrets written only when non-empty, so the VPS uses the `files` volume until S3 keys are added), `docker login ghcr.io`, `docker compose -f compose.yml -f compose.prod.yml pull && up -d --remove-orphans`, then `curl -fsS https://lomi.sairam.cc/api/health`.

- [ ] **Step 1:** Write `setup-deploy.sh` wizard stages: generate `ssh-keygen -t ed25519 -f ~/.ssh/lomi_deploy`; append pubkey to VPS `authorized_keys` (asks `user@ip`, saved only to `.env.deploy`); install Docker on VPS if missing (confirm first); DNS A record `lomi` → VPS IP (opens the DNS dashboard URL the user names); generate `SESSION_SECRET` and `KEY_ENCRYPTION_KEY` with `openssl rand -hex 32`; `gh secret set` for all six required secrets; optional stage "Use S3-compatible storage?" → if yes, opens the provider dashboard URL the user names and captures the six `S3_*` values (`ask_secret` for the secret key) into `gh secret set`. `bash -n` and `shellcheck` clean.
- [ ] **Step 2:** User runs the wizard (human step; Claude does not run it).
- [ ] **Step 3:** Push to `main`; deploy workflow green; `https://lomi.sairam.cc` serves the login page with a valid cert; login with a real key extracts the seeded docs; `GET /api/documents` without a cookie returns 401 and `PUT /api/settings/llm` returns 404.
- [ ] **Step 4:** Commit `ci: automated deploy to lomi.sairam.cc`.

### Task 18: README

**Files:**
- Create: `README.md` (root; the brief stays at `assignment/README.md`)

- [ ] **Step 1:** Sections in the brief's order: run + what to click first (live link, local `cp .env.example .env`, `docker compose up`, open `localhost:3000` (no login in local mode; if no key in `.env`, use the LLM settings banner), open the invoice, upload `assignment/fixtures/documents/invoice-001.v2.pdf`); monorepo layout and why; schema diagram + versions/values/reviews relationship; Redis vs Postgres line and failure matrix (Redis flush, worker kill, API crash between commit and enqueue, Postgres down); file storage (local vs S3 auto-selection, key format, storage-before-DB order, orphan sweep, signed URLs); open decisions table (Q6 supersede, Q7 annotation model, Q8 polling, Q10 unchanged definition, Q24 json_schema only, BYOK auth on live vs no-session local mode and its startup guard, per-user workspaces); cut for time; 10,000 documents (S3 by default + presigned direct-to-bucket uploads, partition values by document, LISTEN/NOTIFY or SSE instead of polling, per-tenant queue fairness, batch LLM API, text-diff anchored carry-over). Chaos script usage.
- [ ] **Step 2:** Commit `docs: README`.

# Extraction & Review App — Design Spec

Source brief: `assignment/README.md`. This spec records every decision settled in the planning session (Q1–Q28) so the plan and the README argue from one place.

## Stack
- Turborepo + pnpm workspaces. Node 24, TypeScript strict.
- API: NestJS. Worker: separate Nest application context (BullMQ consumer). Web: Next.js (App Router) styled with Tailwind CSS 4.
- Postgres 17 (system of record) via Drizzle ORM + drizzle-kit migrations. Redis 7 + BullMQ (delivery only).
- PDF text: `unpdf`. LLM: `openai` SDK against any OpenAI-compatible base URL.
- Tests: Vitest (unit + integration with Testcontainers), Playwright (one e2e).

## Packages
| Path | Responsibility |
|---|---|
| `apps/api` | HTTP API, auth/sessions, uploads, reviews, enqueue-after-commit |
| `apps/worker` | Job consumer, run lifecycle, reconciler, inactivity cleanup |
| `apps/web` | Review UI; proxies `/api/*` to the API (same-origin cookies) |
| `packages/db` | Drizzle schema, migrations, seed (`seedWorkspace`), repositories shared by api+worker |
| `packages/shared` | zod schemas for API contract + field types, shared by web/api/worker |
| `packages/storage` | `FileStorage` interface, local + S3 implementations, `createStorage(env)` |
| `packages/extraction` | Pure logic: normalization, evidence validation, prompt building, carry-over diff, `LlmClient` + SSRF-safe fetch |
| `packages/config` | Shared tsconfig / eslint config |

## Auth (Q1, Q13, Q17, Q19, Q23, Q25, Q26)
- No guest mode on live. A user = `HMAC-SHA256(SESSION_SECRET, normalizedBaseUrl + "\n" + apiKey)`; same key+endpoint → same workspace.
- Login form: base URL, API key, model; presets OpenAI, Anthropic (OpenAI-compat endpoint), OpenRouter, Groq, Ollama (local only).
- Login validation = one tiny chat completion **with `response_format: json_schema`** against the chosen model. Providers/models that reject it are rejected at login (Q24: json_schema only, no fallbacks).
- `AUTH_MODE=byok` (live): key required, cookie sessions.
- `AUTH_MODE=local` (compose default, Q35–Q38): **no login, no cookies, no session rows.** Every request resolves to the single built-in local user (`identity_hash = 'local'`, `is_local = true`) created by `migrate`. A `UserResolver` interface has two implementations (`LocalUserResolver`, `SessionUserResolver`); controllers only see `req.user`.
- Local LLM config precedence: `.env` `LLM_*` → else the local user's stored config (saved via `PUT /settings/llm`, same `verifyProvider` json_schema check, key AES-GCM encrypted) → else none: runs fail `permanent` with "No LLM configured" and the UI shows a banner linking to the settings form; saving settings retries all failed runs of the local user.
- Safety: api and worker refuse to start when `AUTH_MODE=local` and `PUBLIC_ORIGIN` host is not `localhost`/`127.0.0.1`. `compose.prod.yml` sets `AUTH_MODE=byok`.
- Keys stored AES-256-GCM with `KEY_ENCRYPTION_KEY`, never returned to the browser, deleted on logout.
- Session: random 32-byte token, sha256 stored in Postgres, cookie `sid` httpOnly + Secure (live) + SameSite=Lax, 7-day sliding expiry.
- SSRF (live mode): https only, resolve hostname and reject loopback/private/link-local/CGNAT/metadata/unique-local IPv6, no redirects, re-checked at connect time (DNS-rebinding safe). Local mode allows `http://localhost`.
- Limits: login 10/min/IP; PDF only, ≤5 MB; ≤25 documents per user; ≤5 in-flight runs per user; byok users idle >7 days are deleted (cascade).

## Workspaces & seeding (Q9, Q18)
- Every user has a private workspace. On first login `seedWorkspace(userId)` inserts the 3 manifest documents at version 1 with queued runs, extracted with that user's key. Idempotent via `unique(user_id, external_id)`.
- `docker compose up` (local mode): the `migrate` service runs migrations, upserts the local user, and seeds its workspace (always, key or not); the reconciler enqueues the queued runs.

## Schema
- `users(id, identity_hash unique, base_url, model, encrypted_key bytea null, is_local bool, created_at, last_seen_at)`
- `sessions(token_hash pk, user_id fk cascade, expires_at)`
- `documents(id, user_id fk cascade, external_id null, type, title, current_version_id null, created_at)`; unique(user_id, external_id)
- `document_versions(id, document_id fk, version_number, storage_key, original_filename, sha256, size_bytes, parsed_text null, active_run_id null, created_at)`; unique(document_id, version_number)
- `extraction_runs(id, version_id fk, attempt, status queued|extracting|extracted|failed|superseded, lease_expires_at null, error null, error_kind transient|permanent null, model, prompt jsonb null, raw_response jsonb null, created_at, started_at, finished_at)`; unique(version_id, attempt)
- `extracted_values(id, version_id fk, run_id fk, field_name, field_type, value jsonb null, evidence text null, evidence_start int null, evidence_end int null, gap_reason text null, change_status new|unchanged|changed, previous_value_id null fk)`; **unique(version_id, field_name)**
- `reviews(id, value_id fk, action approved|corrected, corrected_value jsonb null, note null, origin manual|carried_over, carried_from_review_id null, created_at)` — append-only; the latest row is the value's current review.
- Document status = status of the current version's active run. A non-current version is shown as `superseded`.

## File storage (Q29–Q34)
- `packages/storage`: `FileStorage { put(key, bytes, contentType); get(key): Uint8Array; exists(key); delete(key); list(prefix): {key, lastModified}[]; signedGetUrl(key, ttlSeconds): string | null }`.
- `LocalFileStorage` (`STORAGE_DIR`, default `/data/files`; write temp + rename; `signedGetUrl` returns `null`). `S3FileStorage` (`@aws-sdk/client-s3` + `s3-request-presigner`; `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`).
- `createStorage(env)`: S3 when bucket + access key + secret are all set, local otherwise; a partial S3 config fails startup with a message naming the missing vars.
- Key: `pdfs/<slug>-<sha256>.pdf` — slug = original filename without extension, lowercased, non `[a-z0-9]` runs → `-`, trimmed of `-`, max 80 chars, `document` if empty; sha256 lowercase hex. Same name + same bytes → same key (idempotent overwrite).
- Upload goes through the API (multipart, 5 MB, `%PDF-` check). Order: **storage put → DB commit**. Version rows always reference an existing file; a missing file at extraction is a `permanent` failure "source file missing".
- Access only for the authenticated owner: `GET /documents/:id/versions/:n/file` checks session + ownership; local → streams `application/pdf`; S3 → `302` to a presigned GET URL with 300s TTL.
- Orphan sweep (worker, hourly): delete storage keys under `pdfs/` older than 1h that no `document_versions.storage_key` references. User deletion only deletes rows; the sweep removes their files.
- Compose: named volume `files` at `/data/files` for api + worker; optional `minio` service under profile `s3`.

## Review model (Q7)
- Corrections live beside the value: `extracted_values` is immutable; effective value = latest review's `corrected_value` if corrected, else `value`.
- A gap can be approved (confirm missing) or corrected (reviewer supplies the value).
- Progress buckets per current version: `pending` (no review), `approved` (latest manual approved), `corrected` (latest manual corrected), `carried_over` (latest review origin carried_over). Buckets are exclusive and sum to field count.

## Extraction coordination (Q11, Q12)
- Postgres is the outbox. API commits `version + run(status=queued) + active_run_id` in one tx, then `queue.add('extract', {runId}, {jobId: runId})`. Enqueue failure is logged, not surfaced — the reconciler covers it.
- Worker claim: `UPDATE extraction_runs SET status='extracting', started_at=now(), lease_expires_at=now()+60s WHERE id=$1 AND status='queued' RETURNING *`. 0 rows → ack and drop (duplicate delivery). Heartbeat extends lease every 15s.
- Before the LLM call: if the run's version is no longer the document's current version → mark `superseded`, stop.
- Parse PDF (store `parsed_text` once per version), call LLM, validate, compute carry-over, then **one transaction**: insert all values (`ON CONFLICT (version_id, field_name) DO NOTHING`) + carried reviews + `run.status='extracted'`, guarded by `run.status='extracting' AND version.active_run_id = run.id`. Guard fails → rollback, nothing written.
- Failures: `transient` (network, 5xx, 429, timeout) → run `failed`, new run attempt+1 queued (becomes active) while attempt < 3. `permanent` (PDF parse, schema-invalid output, 4xx auth) → run `failed`, document visibly failed. `POST /documents/:id/retry` creates a new queued run for the current version.
- Reconciler (worker boot + every 30s): re-add every `queued` run (jobId=runId → no-op if present); every `extracting` run with expired lease → `failed`/`transient` with "worker lost lease" and retry per the rule above. This makes FLUSHALL, `docker compose restart`, and kill -9 safe.
- BullMQ jobs use `attempts: 1`; retries are owned by Postgres run rows.
- Every run stores its prompt and raw response.

## Evidence & gaps
- LLM returns, per field: `{ value | null, evidence | null, gap_reason | null }` via strict json_schema built from `expected-fields.json`.
- Value normalization by type: `string` trimmed; `date` → `YYYY-MM-DD`; `money` → `{ amount: "1234.50", currency: "USD" }`; `percent` → number (4.2 means 4.2%); `number` → number. Unparseable → gap "value not parseable as <type>".
- Evidence validation: the quote must appear in the version's `parsed_text` after collapsing whitespace runs to one space on both sides (PDF line breaks); otherwise gap `"evidence not found verbatim in document text"`. Empty evidence with a value → gap. Offsets are mapped back to raw text for highlighting.

## Carry-over (Q10)
- Baseline = the most recent *other* version of the document with an `extracted` run at finalize time.
- Per field name: `unchanged` iff normalized evidence (collapse whitespace, unify quotes/dashes, casefold) **and** canonical value JSON are equal (gaps: both null and equal gap reason). Unchanged + baseline value has a review → insert review copy with `origin=carried_over`, `carried_from_review_id`. Unchanged without review → pending, `change_status=unchanged`.
- Otherwise `changed` (or `new` with no baseline) → pending; UI shows the previous value + its latest review via `previous_value_id`.
- Revised invoice must yield exactly its 2 changed fields as pending.

## Versions arriving mid-extraction (Q6)
- Supersede: the new version becomes current at once. The old run, if not yet at the LLM, marks itself `superseded`; if already past it, it completes and its values remain queryable on that version but are never current.

## UI (Q8)
- Designed first: a "Lomi Review" design system and screen designs are made as Claude Artifacts and approved by the user before any front-end code; their tokens become the Tailwind `@theme`.
- Polling every 2s via TanStack Query, only while any shown document is `queued`/`extracting`.
- List: title, type, status badge, current version, progress bar (pending/approved/corrected/carried-over).
- Detail: "N need review" headline; fields sorted pending first; each row: effective value, evidence quote, gap reason, change badge (carried over / changed / new), previous value + review for changed; approve / correct (value + optional note). Right pane: version's parsed text with active quote highlighted. Version switcher for history. Upload-new-version and retry buttons.

## Deploy (Q5, Q15, Q21, Q27, Q28)
- Single VPS, `lomi.sairam.cc`, Caddy for TLS in `compose.prod.yml`, images from GHCR.
- GitHub Actions: `ci.yml` on PR/push runs `pnpm turbo lint typecheck test build`; `deploy.yml` on push to main builds/pushes images, SSHes with a dedicated deploy key, writes `.env` from secrets, `docker compose pull && up -d`.
- Secrets: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, `SESSION_SECRET`, `KEY_ENCRYPTION_KEY`, `POSTGRES_PASSWORD`; optional `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` (written to `.env` only when set). VPS address never committed.
- A wizard script (`scripts/setup-deploy.sh`) walks the human through deploy key, DNS A record and `gh secret set`.

## Repo (Q22)
- Public GitHub repo `lomi-labs-take-home`. `assignment/jd.md` and session logs are gitignored.

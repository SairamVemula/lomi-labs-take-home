import {
  DEFAULT_LEASE_MS,
  claimRun,
  heartbeat,
  isCurrentVersion,
  markFailed,
  markSuperseded,
  saveParsedText,
  type Db,
} from "@lomi/db";
import {
  LlmError,
  PdfParseError,
  assembleValues,
  buildExtractionRequest,
  diffAgainstBaseline,
  extractPdfText,
  type LlmClient,
  type LlmField,
  type LlmRequest,
} from "@lomi/extraction";
import { FileNotFoundError, type FileStorage } from "@lomi/storage";
import { finalizeRun, loadBaseline } from "./finalize.js";

export const DEFAULT_HEARTBEAT_MS = 15_000;

export type ProcessRunDeps = {
  db: Db;
  storage: FileStorage;
  llmFor(userId: string): Promise<LlmClient>;
  /** Hand a freshly queued retry run to the queue. Failures are only logged: the reconciler re-adds. */
  enqueue(runId: string): Promise<void>;
  heartbeatMs?: number;
  leaseMs?: number;
  log?: (msg: string) => void;
};

export type ProcessRunResult = "extracted" | "failed" | "superseded" | "skipped";

type Failure = { kind: "transient" | "permanent"; message: string };

/** Only an LlmError can be transient; a missing file, bad PDF or any other exception is permanent. */
export function classifyFailure(err: unknown): Failure {
  if (err instanceof LlmError) return { kind: err.kind, message: err.message };
  if (err instanceof FileNotFoundError) return { kind: "permanent", message: "source file missing" };
  if (err instanceof PdfParseError) return { kind: "permanent", message: err.message };
  return { kind: "permanent", message: err instanceof Error ? err.message : String(err) };
}

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * Idempotent run lifecycle. Postgres decides everything: a run that is not `queued` is skipped,
 * a run whose version is no longer current stops before the LLM, and results land in one guarded
 * transaction. A thrown error ends the run as failed; it is never left `extracting`.
 */
export async function processRun(deps: ProcessRunDeps, runId: string): Promise<ProcessRunResult> {
  const { db } = deps;
  const log = deps.log ?? ((m: string) => console.warn(m));
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;

  const claimed = await claimRun(db, runId, leaseMs);
  if (!claimed) return "skipped";

  const timer = setInterval(() => {
    heartbeat(db, runId, leaseMs).catch((e: unknown) => log(`heartbeat failed for run ${runId}: ${String(e)}`));
  }, deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);

  const supersede = async (): Promise<ProcessRunResult> =>
    (await markSuperseded(db, runId)) ? "superseded" : "skipped";

  let prompt: LlmRequest | undefined;
  let raw: unknown;
  try {
    if (!(await isCurrentVersion(db, claimed.versionId))) return await supersede();

    const parsedText =
      claimed.parsedText ??
      (await saveParsedText(db, claimed.versionId, await extractPdfText(await deps.storage.get(claimed.storageKey))));

    // Last check before the (expensive) model call: a newer version wins.
    if (!(await isCurrentVersion(db, claimed.versionId))) return await supersede();

    const llm = await deps.llmFor(claimed.userId);
    prompt = {
      ...buildExtractionRequest(claimed.documentType, parsedText),
      schemaName: `${claimed.documentType}_extraction`,
    };
    const res = await llm.completeJson(prompt);
    raw = res.raw;
    if (!isObject(res.parsed)) throw new LlmError("permanent", "model output is not a JSON object");

    const values = assembleValues(claimed.documentType, parsedText, res.parsed as Record<string, LlmField | undefined>);
    const decisions = diffAgainstBaseline(values, await loadBaseline(db, claimed.versionId));
    if (await finalizeRun(db, { runId, values, decisions, prompt, raw })) return "extracted";
    // Guard failed (no longer the active run, version already extracted, or lease lost): nothing written.
    return await supersede();
  } catch (err) {
    const failure = classifyFailure(err);
    const next = await markFailed(db, runId, { ...failure, prompt, raw });
    if (next) {
      await deps.enqueue(next).catch((e: unknown) => log(`enqueue of retry run ${next} failed: ${String(e)}`));
    }
    return "failed";
  } finally {
    clearInterval(timer);
  }
}

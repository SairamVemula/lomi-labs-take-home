import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { extractionRuns, markFailed, type Db } from "@lomi/db";

export type ReconcileDeps = {
  db: Db;
  enqueue: (runId: string) => Promise<void>;
  /** Used for runs still `queued` in Postgres; should also clear a finished job with the same id. Defaults to `enqueue`. */
  requeue?: (runId: string) => Promise<void>;
  /** Only for JS-side timestamps; lease expiry is decided with the database clock. */
  now?: () => Date;
  log?: (message: string) => void;
};

/** A run that is `extracting` with no lease at all is treated as expired once it is this old. */
const NULL_LEASE_GRACE_SECONDS = 60;

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Postgres `extraction_runs` is the outbox; Redis only delivers run ids. Re-add every queued run
 * (jobId = runId makes that a no-op while the job exists) and fail extracting runs whose lease
 * expired (crashed worker, FLUSHALL + crash), enqueueing the retry markFailed creates.
 * Every run is handled independently; errors are logged, never thrown.
 */
export async function reconcile(deps: ReconcileDeps): Promise<{ requeued: string[]; expired: string[] }> {
  const { db, enqueue } = deps;
  const log = deps.log ?? (() => undefined);
  const requeued: string[] = [];
  const expired: string[] = [];

  const safeEnqueue = async (runId: string, add = enqueue): Promise<boolean> => {
    try {
      await add(runId);
      return true;
    } catch (err) {
      log(`reconcile: enqueue ${runId} failed: ${msg(err)}`);
      return false;
    }
  };

  let queued: { id: string }[] = [];
  try {
    queued = await db.select({ id: extractionRuns.id }).from(extractionRuns).where(eq(extractionRuns.status, "queued"));
  } catch (err) {
    log(`reconcile: listing queued runs failed: ${msg(err)}`);
  }
  for (const { id } of queued) {
    if (await safeEnqueue(id, deps.requeue ?? enqueue)) requeued.push(id);
  }

  let stale: { id: string }[] = [];
  try {
    stale = await db
      .select({ id: extractionRuns.id })
      .from(extractionRuns)
      .where(
        and(
          eq(extractionRuns.status, "extracting"),
          or(
            lt(extractionRuns.leaseExpiresAt, sql`now()`),
            and(
              isNull(extractionRuns.leaseExpiresAt),
              lt(
                sql`coalesce(${extractionRuns.startedAt}, ${extractionRuns.createdAt})`,
                sql`now() - make_interval(secs => ${NULL_LEASE_GRACE_SECONDS})`,
              ),
            ),
          ),
        ),
      );
  } catch (err) {
    log(`reconcile: listing expired runs failed: ${msg(err)}`);
  }
  for (const { id } of stale) {
    try {
      const nextRunId = await markFailed(db, id, { kind: "transient", message: "worker lost lease" });
      expired.push(id);
      if (nextRunId) await safeEnqueue(nextRunId);
    } catch (err) {
      log(`reconcile: expiring ${id} failed: ${msg(err)}`);
    }
  }
  return { requeued, expired };
}

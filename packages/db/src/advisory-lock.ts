import type { Sql } from "postgres";

/**
 * A named, cluster-wide mutual exclusion (PRD Phase 16 task 7).
 *
 * PostgreSQL advisory locks are the only mutual exclusion available to two FlightRules workers that
 * share nothing but a database, and one operation genuinely needs it: replacing a saved view.
 *
 * `signoz_update_view` is unusable on the pinned server (SL-057), so a view is replaced by deleting
 * it and creating it again. That sequence is not atomic and has no remote equivalent of a
 * compare-and-set, so two syncs of the same agent overlapping inside it each delete one view and
 * create another — leaving two resources of the same managed name, which is precisely the duplicate
 * PRD section 20.1 forbids. Job idempotency does not cover it: two *different* contract versions of
 * one agent are two legitimately different jobs.
 *
 * Session-scoped rather than transaction-scoped, on a reserved connection: the critical section
 * makes network calls to SigNoz, and holding an open transaction across them would pin a pooled
 * connection in an idle-in-transaction state for the duration.
 *
 * The lock is advisory in the strict sense — it constrains only the code that asks for it. Nothing
 * here can stop a human editing the same resource in the SigNoz console, which is why ownership is
 * still decided by the register and read-back rather than by this.
 */

/**
 * Runs `body` while holding the named lock, releasing it whatever happens.
 *
 * The key is hashed to the `bigint` the advisory-lock functions take. `hashtextextended` is
 * PostgreSQL's own hash, so the mapping is stable across processes and releases — two workers on
 * different machines derive the same lock from the same name, which is the entire point.
 */
export async function withAdvisoryLock<T>(
  sql: Sql,
  key: string,
  body: () => Promise<T>,
): Promise<T> {
  const connection = await sql.reserve();
  try {
    await connection`select pg_advisory_lock(hashtextextended(${key}, 0))`;
    try {
      return await body();
    } finally {
      await connection`select pg_advisory_unlock(hashtextextended(${key}, 0))`;
    }
  } finally {
    connection.release();
  }
}

/** The lock one agent's SigNoz artefact sync serialises on. */
export function artifactSyncLockKey(agentId: string): string {
  return `flightrules:signoz-sync:${agentId}`;
}

import { readFile } from "node:fs/promises";
import {
  connect,
  findJob,
  jobQueueDepth,
  MIGRATIONS_DIR,
  migrateUp,
  reclaimExpiredLeases,
  requestCancellation,
  type Sql,
  submitJob,
} from "@flightrules/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadWorkerConfig } from "./config.js";
import {
  CancelledError,
  type JobHandler,
  JobRunner,
  TerminalJobError,
  WORKER_STAGES,
} from "./runner.js";

/**
 * Runner mechanics against a real PostgreSQL, with synthetic handlers.
 *
 * The handlers here are deliberately not the product's: what is under test is the contract between
 * the runner and the job table — claim, lease, progress, atomic commit, retry classification,
 * cancellation and shutdown. The real handlers are exercised against live SigNoz in
 * `worker.signoz.integration.test.ts`, where their own behaviour is the subject.
 */

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  throw new Error("DATABASE_URL must be set for database integration tests. Run `make up` first.");
}

const ENV = {
  NODE_ENV: "test",
  DATABASE_URL: databaseUrl,
  SIGNOZ_URL: "http://localhost:8080",
  SIGNOZ_MCP_URL: "http://localhost:8000/mcp",
  SIGNOZ_API_KEY: "test-key-not-a-real-secret",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
  IDEMPOTENCY_HASH_SALT: "0123456789abcdef0123456789abcdef",
  WORKER_LEASE_SECONDS: "60",
  WORKER_HEARTBEAT_INTERVAL_MS: "1000",
  WORKER_POLL_INTERVAL_MS: "20",
  WORKER_RETRY_DELAY_SECONDS: "0",
} as const;

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

let sql: Sql;

beforeAll(async () => {
  sql = connect(databaseUrl, { max: 6 });
  await sql`drop schema public cascade`;
  await sql`create schema public`;
  await migrateUp(sql, MIGRATIONS_DIR);
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await sql`truncate jobs restart identity cascade`;
});

function runnerWith(
  handler: JobHandler,
  workerId = "worker-1",
  overrides: Readonly<Record<string, string>> = {},
): JobRunner {
  return new JobRunner({
    sql,
    config: loadWorkerConfig({ ...ENV, WORKER_ID: workerId, ...overrides }),
    log: silentLog,
    handlers: {
      baseline_mining: handler,
      contract_proposal: handler,
      evaluation: handler,
      demo_run: handler,
    },
  });
}

async function queue(key: string, maxAttempts = 3): Promise<string> {
  const submitted = await submitJob(sql, {
    jobType: "baseline_mining",
    entityType: "agent",
    entityId: null,
    projectId: null,
    idempotencyKey: key,
    input: { key },
    maxAttempts,
  });
  return submitted.job.id;
}

describe("stage vocabulary", () => {
  it("extends PRD section 8.7's five states rather than redeclaring them", () => {
    expect(WORKER_STAGES.slice(0, 5)).toEqual([
      "discovering_traces",
      "fetching_span_trees",
      "normalising_routes",
      "grouping_route_families",
      "proposing_contract_rules",
    ]);
    expect(WORKER_STAGES).toContain("evaluating_runs");
  });
});

describe("running a job", () => {
  it("claims, reports progress, commits the result and marks success in one transaction", async () => {
    const jobId = await queue("success");
    const runner = runnerWith(async (context) => {
      await context.progress("discovering_traces", "looking");
      await context.progress("normalising_routes", "reconstructing");
      return async (tx) => {
        await tx`insert into projects (name, slug) values ('Side effect', 'side-effect')`;
        return { ok: true };
      };
    });

    const outcome = await runner.runOnce();
    expect(outcome).toMatchObject({ claimed: true, jobId, outcome: "succeeded" });

    const job = await findJob(sql, jobId);
    expect(job?.status).toBe("succeeded");
    expect(job?.result).toEqual({ ok: true });
    expect(job?.progressEvents.map((event) => event.stage)).toEqual([
      "discovering_traces",
      "normalising_routes",
    ]);
    expect(job?.leaseOwner).toBeNull();

    const projects = await sql<{ count: string }[]>`
      select count(*)::text as count from projects where slug = 'side-effect'`;
    expect(projects[0]?.count).toBe("1");
  });

  it("leaves no output behind when the commit fails", async () => {
    const jobId = await queue("commit-failure");
    const runner = runnerWith(async () => async (tx) => {
      await tx`insert into projects (name, slug) values ('Doomed', 'doomed')`;
      throw new Error("the commit failed");
    });

    const outcome = await runner.runOnce();
    expect(outcome.outcome).toBe("failed");

    const projects = await sql<{ count: string }[]>`
      select count(*)::text as count from projects where slug = 'doomed'`;
    expect(projects[0]?.count).toBe("0");
    expect((await findJob(sql, jobId))?.status).toBe("queued");
  });

  it("classifies a terminal failure as terminal and does not retry it", async () => {
    const jobId = await queue("terminal", 3);
    const runner = runnerWith(async () => {
      throw new TerminalJobError("CONTRACT_INVALID", "the generated contract does not validate");
    });

    await runner.runOnce();
    const job = await findJob(sql, jobId);
    expect(job?.status).toBe("failed");
    expect(job?.failure).toMatchObject({ code: "CONTRACT_INVALID", retryable: false });
    expect(job?.attempt).toBe(1);
  });

  it("retries a dependency failure until the attempt ceiling", async () => {
    const jobId = await queue("retryable", 2);
    let attempts = 0;
    const runner = runnerWith(async () => {
      attempts += 1;
      throw new Error("SigNoz went away");
    });

    await runner.runOnce();
    expect((await findJob(sql, jobId))?.status).toBe("queued");
    await runner.runOnce();

    expect(attempts).toBe(2);
    const job = await findJob(sql, jobId);
    expect(job?.status).toBe("failed");
    expect(job?.failure?.retryable).toBe(true);
    expect(job?.attempt).toBe(2);
  });

  it("does not leak an unexpected error's message into the stored failure", async () => {
    const jobId = await queue("leaky");
    const runner = runnerWith(async () => {
      throw new Error("postgres://flightrules:flightrules@localhost:5433/flightrules");
    });
    await runner.runOnce();
    const job = await findJob(sql, jobId);
    expect(job?.failure?.message).toBe("The job failed with an unexpected error.");
    expect(JSON.stringify(job?.failure)).not.toContain("postgres://");
  });

  it("cancels a running job when cancellation was requested", async () => {
    const jobId = await queue("cancel");
    const runner = runnerWith(async (context) => {
      await requestCancellation(sql, context.job.id);
      if (await context.cancelled()) throw new CancelledError();
      return async () => ({});
    });

    const outcome = await runner.runOnce();
    expect(outcome.outcome).toBe("cancelled");
    expect((await findJob(sql, jobId))?.status).toBe("cancelled");
  });

  it("does not claim a job type it has no handler for", async () => {
    const jobId = await queue("no-handler");
    const runner = new JobRunner({
      sql,
      config: loadWorkerConfig(ENV),
      log: silentLog,
      handlers: {} as never,
    });

    // #then a worker that cannot do the work leaves it for one that can
    expect((await runner.runOnce()).claimed).toBe(false);
    expect((await findJob(sql, jobId))?.status).toBe("queued");

    // #and if it is forced to claim one anyway, that is a terminal failure rather than a retry loop
    await runner.runOnce(["baseline_mining"]);
    const job = await findJob(sql, jobId);
    expect(job?.status).toBe("failed");
    expect(job?.failure?.retryable).toBe(false);
  });
});

describe("two workers", () => {
  it("never execute the same job", async () => {
    await queue("shared");
    const started: string[] = [];
    const handler: JobHandler = async (context) => {
      started.push(context.config.owner);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return async () => ({});
    };

    const [a, b] = await Promise.all([
      runnerWith(handler, "worker-a").runOnce(),
      runnerWith(handler, "worker-b").runOnce(),
    ]);

    expect(started).toHaveLength(1);
    expect([a.outcome, b.outcome].filter((outcome) => outcome === "succeeded")).toHaveLength(1);
    expect([a.outcome, b.outcome].filter((outcome) => outcome === "idle")).toHaveLength(1);
  });

  it("share a queue rather than duplicating it", async () => {
    await queue("first");
    await queue("second");
    const seen: string[] = [];
    const handler: JobHandler = async (context) => {
      seen.push(String((context.job.input as { key: string }).key));
      return async () => ({});
    };

    await Promise.all([
      runnerWith(handler, "worker-a").runOnce(),
      runnerWith(handler, "worker-b").runOnce(),
    ]);
    expect(seen.sort()).toEqual(["first", "second"]);
  });
});

describe("shutdown", () => {
  it("finishes the active job and claims nothing further", async () => {
    await queue("in-flight");
    await queue("next");

    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = runnerWith(async () => {
      await gate;
      return async () => ({ finished: true });
    });

    const running = runner.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const stopping = runner.stop();
    release();
    const outcome = await running;
    await stopping;

    expect(outcome.outcome).toBe("succeeded");
    // #and a stopping runner claims nothing more
    expect((await runner.runOnce()).claimed).toBe(false);

    const remaining = await sql<{ status: string }[]>`
      select status from jobs where status = 'queued'`;
    expect(remaining).toHaveLength(1);
  });
});

describe("staying alive while idle", () => {
  /**
   * A worker that exits when it has nothing to do is indistinguishable from a healthy one until a
   * job is submitted and never claimed.
   *
   * This is a regression test for a real defect: the idle poll timer was `unref`ed, so once
   * `postgres.js` closed its idle connections the timer was the only pending handle, Node drained
   * the event loop and the process exited with "Detected unsettled top-level await" and code 13 —
   * silently, after logging nothing but successes. Every job submitted afterwards sat `queued` with
   * nothing to claim it.
   *
   * The test drives the real `loop()` across several idle polls and then submits work, which is the
   * sequence that broke: idle first, work second.
   */
  it("keeps polling across an idle period and claims a job submitted afterwards", async () => {
    // #given a runner whose poll interval is short enough to cross several times
    const claimed: string[] = [];
    const runner = runnerWith(
      async (context) => {
        claimed.push(context.job.id);
        return async () => ({ finished: true });
      },
      "idle-worker",
      { WORKER_POLL_INTERVAL_MS: "25" },
    );

    // #when the loop runs with nothing to do at all
    const loop = runner.loop();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(claimed).toHaveLength(0);

    // #and a job arrives only after that idle period
    const jobId = await queue("arrived-after-idle");
    await new Promise((resolve) => setTimeout(resolve, 250));

    // #then the loop was still running, and claimed it
    expect(claimed, "the idle loop stopped polling").toContain(jobId);

    await runner.stop();
    await loop;
  });

  /**
   * The poll timer must hold the event loop open. Asserted directly rather than only through
   * behaviour, because the behavioural test above would still pass if the timer were unref'ed and
   * something unrelated happened to be keeping the process alive during the test run — which is
   * exactly how the original defect survived.
   */
  it("does not unref the idle poll timer", async () => {
    const source = await readFile(new URL("./runner.ts", import.meta.url), "utf8");
    const loopBody = source.slice(source.indexOf("async loop("), source.indexOf("async stop("));
    const pollTimer = loopBody.slice(loopBody.indexOf("setTimeout(resolve"));
    expect(pollTimer).not.toContain("unref");
  });
});

/* -------------------------------------------------------------------------- */
/* Restart, crash and recovery                                                */
/* -------------------------------------------------------------------------- */

/**
 * What happens to a job when the worker holding it stops (PRD Phase 16 task 8, PRD section 20.1:
 * "worker restarts resume or safely fail jobs").
 *
 * A worker can stop in four materially different places, and each has a different correct outcome:
 * before it claims anything, while idle, between the claim and the commit, and after the commit. The
 * dangerous one is the third, because a job left `running` by a process that no longer exists is
 * invisible: nothing is working on it and nothing will, until its lease expires.
 *
 * The lease is expired here by moving `lease_expires_at` into the past rather than by waiting, so
 * the test states the condition it is testing instead of encoding a timeout in a sleep.
 */
describe("a worker that stops mid-job", () => {
  /** Simulates `kill -9`: the row stays `running`, its owner is gone, and its lease is stale. */
  async function expireLease(jobId: string): Promise<void> {
    await sql`update jobs set lease_expires_at = now() - interval '1 second' where id = ${jobId}`;
  }

  it("leaves the job claimable again once its lease expires", async () => {
    // #given a job claimed by a worker that then died without failing it. The claim is written
    // directly, because the state under test is the one a `kill -9` leaves behind: `running`, owned
    // by a process that no longer exists, with a lease nobody is renewing.
    const jobId = await queue("crash-after-claim");
    await sql`update jobs set status = 'running', lease_owner = 'dead-worker',
      lease_expires_at = now() + interval '60 seconds', attempt = 1 where id = ${jobId}`;
    expect((await findJob(sql, jobId))?.status).toBe("running");

    // #when the lease expires and recovery runs
    await expireLease(jobId);
    const recovered = await reclaimExpiredLeases(sql);

    // #then the job is queued again, with attempts remaining, and says why
    expect(recovered.requeued).toContain(jobId);
    const job = await findJob(sql, jobId);
    expect(job?.status).toBe("queued");
    expect(job?.leaseOwner).toBeNull();
    expect(job?.failure?.retryable).toBe(true);
    expect(job?.failure?.message).toContain("stopped responding");
  });

  it("fails a job terminally when its worker died and no attempts remain", async () => {
    const jobId = await queue("crash-at-final-attempt", 1);
    await sql`update jobs set status = 'running', lease_owner = 'dead-worker',
      lease_expires_at = now() - interval '1 second', attempt = 1 where id = ${jobId}`;

    const recovered = await reclaimExpiredLeases(sql);

    expect(recovered.abandoned).toContain(jobId);
    const job = await findJob(sql, jobId);
    expect(job?.status).toBe("failed");
    expect(job?.failure?.retryable).toBe(false);
  });

  it("is picked up and completed by the next worker after recovery", async () => {
    const jobId = await queue("recovered-then-run");
    await sql`update jobs set status = 'running', lease_owner = 'dead-worker',
      lease_expires_at = now() - interval '1 second', attempt = 1 where id = ${jobId}`;
    await reclaimExpiredLeases(sql);

    const outcome = await runnerWith(async () => async () => ({ ok: true })).runOnce();

    expect(outcome).toMatchObject({ claimed: true, jobId, outcome: "succeeded" });
    expect((await findJob(sql, jobId))?.status).toBe("succeeded");
  });

  it("commits no output when the lease was lost before the commit", async () => {
    // #given a job whose lease is taken by another worker while the handler is still running
    const jobId = await queue("lease-lost-mid-run");
    const runner = runnerWith(async (context) => {
      // Somebody else claims it: the lease owner changes under the running handler.
      await sql`update jobs set lease_owner = 'other-worker',
        lease_expires_at = now() + interval '60 seconds' where id = ${context.job.id}`;
      return async (tx) => {
        await tx`insert into projects (name, slug) values ('Stolen', 'stolen')`;
        return { ok: true };
      };
    });

    // #when it finishes and tries to commit
    const outcome = await runner.runOnce();

    // #then the whole transaction rolled back: no side effect, and no success recorded by the
    // worker that no longer owns the job
    expect(outcome.outcome).toBe("failed");
    const projects = await sql<{ count: string }[]>`
      select count(*)::text as count from projects where slug = 'stolen'`;
    expect(projects[0]?.count).toBe("0");
    expect((await findJob(sql, jobId))?.result).toBeNull();
  });

  it("commits its output exactly once even when the same job is run twice", async () => {
    // #given a job whose handler is not itself idempotent
    const jobId = await queue("run-twice");
    let runs = 0;
    const runner = runnerWith(async () => {
      runs += 1;
      return async (tx) => {
        await tx`insert into projects (name, slug) values ('Once', 'once')`;
        return { runs };
      };
    });

    // #when the runner is asked to run twice over the same queue
    await runner.runOnce();
    const second = await runner.runOnce();

    // #then the second call found nothing to claim: a succeeded job is not claimable
    expect(second.claimed).toBe(false);
    expect(runs).toBe(1);
    const projects = await sql<{ count: string }[]>`
      select count(*)::text as count from projects where slug = 'once'`;
    expect(projects[0]?.count).toBe("1");
    expect((await findJob(sql, jobId))?.status).toBe("succeeded");
  });

  it("submits one job, not two, for a repeated idempotency key", async () => {
    const first = await queue("same-key");
    const second = await queue("same-key");

    expect(second).toBe(first);
    const rows = await sql<{ count: string }[]>`select count(*)::text as count from jobs`;
    expect(rows[0]?.count).toBe("1");
  });
});

describe("shutdown while idle", () => {
  it("returns from the loop promptly and claims nothing afterwards", async () => {
    // #given a running loop with nothing to do
    const runner = runnerWith(async () => async () => ({}), "idle-shutdown", {
      WORKER_POLL_INTERVAL_MS: "25",
    });
    const loop = runner.loop();
    await new Promise((resolve) => setTimeout(resolve, 60));

    // #when it is stopped while idle
    await runner.stop();
    await loop;

    // #then a job submitted afterwards is left for another worker rather than silently claimed
    const jobId = await queue("after-shutdown");
    expect((await runner.runOnce()).claimed).toBe(false);
    expect((await findJob(sql, jobId))?.status).toBe("queued");
  });
});

/* -------------------------------------------------------------------------- */
/* Operational visibility                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A stalled queue has to be detectable in production (PRD Phase 16 task 8).
 *
 * When the worker stops claiming, every other health signal stays green: the API answers, the
 * database answers, SigNoz answers. Only the queue itself says anything, which is why
 * `GET /health/dependencies` reports it and why the reading it reports is asserted here.
 */
describe("queue depth", () => {
  it("reports nothing waiting on an empty queue", async () => {
    const depth = await jobQueueDepth(sql);
    expect(depth).toMatchObject({ queued: 0, running: 0, oldestQueuedSeconds: null });
  });

  it("reports the age of the oldest claimable job", async () => {
    const jobId = await queue("waiting");
    await sql`update jobs set available_at = now() - interval '600 seconds' where id = ${jobId}`;

    const depth = await jobQueueDepth(sql);
    expect(depth.queued).toBe(1);
    expect(depth.oldestQueuedSeconds).toBeGreaterThanOrEqual(600);
  });

  it("does not count a job deferred by a retry backoff as waiting", async () => {
    // #given a job whose next attempt is deliberately in the future
    const jobId = await queue("backing-off");
    await sql`update jobs set available_at = now() + interval '300 seconds' where id = ${jobId}`;

    // #then it is queued but not yet waiting to be claimed, so it is not a stall
    const depth = await jobQueueDepth(sql);
    expect(depth.queued).toBe(1);
    expect(depth.oldestQueuedSeconds).toBeNull();
  });

  it("counts a running job whose lease has already expired", async () => {
    const jobId = await queue("expired-lease");
    await sql`update jobs set status = 'running', lease_owner = 'dead-worker',
      lease_expires_at = now() - interval '1 second' where id = ${jobId}`;

    const depth = await jobQueueDepth(sql);
    expect(depth.running).toBe(1);
    expect(depth.expiredLeases).toBe(1);
  });

  it("returns to zero once the work has been done", async () => {
    await queue("will-finish");
    await runnerWith(async () => async () => ({})).runOnce();

    const depth = await jobQueueDepth(sql);
    expect(depth).toMatchObject({ queued: 0, running: 0, oldestQueuedSeconds: null });
  });
});

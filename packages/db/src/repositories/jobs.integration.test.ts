import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connect, MIGRATIONS_DIR, migrateUp, type Sql } from "../index.js";
import { toPageRequest } from "../pagination.js";
import {
  cancelClaimedJob,
  claimJob,
  completeJob,
  failJob,
  findJob,
  listJobs,
  MAX_PROGRESS_EVENTS,
  reclaimExpiredLeases,
  recordProgress,
  renewLease,
  requestCancellation,
  submitJob,
} from "./jobs.js";

/**
 * The job system against a real PostgreSQL.
 *
 * Every claim, lease and idempotency assertion here uses the database's own semantics rather than
 * a simulation. The concurrency tests open genuinely separate connections, because
 * `for update skip locked` is a property of two sessions and cannot be demonstrated inside one.
 */

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  throw new Error("DATABASE_URL must be set for database integration tests. Run `make up` first.");
}

let sql: Sql;
let other: Sql;

beforeAll(async () => {
  sql = connect(databaseUrl, { max: 4 });
  other = connect(databaseUrl, { max: 4 });
  await sql`drop schema public cascade`;
  await sql`create schema public`;
  await migrateUp(sql, MIGRATIONS_DIR);
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await other?.end({ timeout: 5 });
});

beforeEach(async () => {
  await sql`truncate jobs restart identity cascade`;
});

const input = { window: "6h", release: "refund-agent-v1" };

async function submit(key: string, overrides: Partial<Parameters<typeof submitJob>[1]> = {}) {
  return submitJob(sql, {
    jobType: "baseline_mining",
    entityType: "agent",
    entityId: null,
    projectId: null,
    idempotencyKey: key,
    input,
    ...overrides,
  });
}

describe("submission and idempotency", () => {
  it("creates a job once", async () => {
    const first = await submit("selection-a");
    expect(first.created).toBe(true);
    expect(first.job.status).toBe("queued");
    expect(first.job.attempt).toBe(0);
  });

  it("returns the existing job for a repeated identical submission", async () => {
    const first = await submit("selection-a");
    const second = await submit("selection-a");
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
  });

  it("is idempotent under key order: the same input written differently is the same job", async () => {
    const first = await submit("selection-a", { input: { a: 1, b: 2 } });
    const second = await submit("selection-a", { input: { b: 2, a: 1 } });
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
  });

  it("refuses the same key carrying different work", async () => {
    await submit("selection-a");
    await expect(submit("selection-a", { input: { window: "12h" } })).rejects.toThrow(
      /different input/,
    );
  });

  it("resolves concurrent duplicate submissions to one row", async () => {
    // #given two connections submitting the same selection at the same moment
    const submitOn = (handle: Sql) =>
      submitJob(handle, {
        jobType: "baseline_mining",
        entityType: "agent",
        entityId: null,
        projectId: null,
        idempotencyKey: "concurrent",
        input,
      });

    const [a, b] = await Promise.all([submitOn(sql), submitOn(other)]);

    // #then exactly one insert won, and both callers hold the same job
    expect(a.job.id).toBe(b.job.id);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);

    const all = await listJobs(sql, {}, toPageRequest({ limit: 10 }));
    expect(all.items).toHaveLength(1);
  });

  it("keeps a repeated submission after terminal success pointing at the finished job", async () => {
    const first = await submit("selection-a");
    const claimed = await claimJob(sql, {
      jobTypes: ["baseline_mining"],
      owner: "w1",
      leaseSeconds: 60,
    });
    await completeJob(sql, claimed?.id ?? "", "w1", { baselineId: "bl-1" });

    const repeat = await submit("selection-a");
    expect(repeat.created).toBe(false);
    expect(repeat.job.id).toBe(first.job.id);
    expect(repeat.job.status).toBe("succeeded");
    // #and no second computation was created
    const all = await listJobs(sql, {}, toPageRequest({ limit: 10 }));
    expect(all.items).toHaveLength(1);
  });
});

describe("claiming", () => {
  it("claims the oldest available job and takes the lease", async () => {
    await submit("a");
    const job = await claimJob(sql, {
      jobTypes: ["baseline_mining"],
      owner: "w1",
      leaseSeconds: 60,
    });
    expect(job?.status).toBe("running");
    expect(job?.leaseOwner).toBe("w1");
    expect(job?.attempt).toBe(1);
    expect(job?.startedAt).not.toBeNull();
  });

  it("returns null when nothing is available", async () => {
    expect(
      await claimJob(sql, { jobTypes: ["evaluation"], owner: "w1", leaseSeconds: 60 }),
    ).toBeNull();
  });

  it("never lets two workers hold the same job", async () => {
    // #given one queued job and two workers on separate connections
    await submit("single");

    const [a, b] = await Promise.all([
      claimJob(sql, { jobTypes: ["baseline_mining"], owner: "w1", leaseSeconds: 60 }),
      claimJob(other, { jobTypes: ["baseline_mining"], owner: "w2", leaseSeconds: 60 }),
    ]);

    // #then exactly one of them got it, and the other was not blocked into an error
    const claimed = [a, b].filter((job) => job !== null);
    expect(claimed).toHaveLength(1);
  });

  it("gives two workers different jobs rather than making one wait", async () => {
    await submit("one");
    await submit("two");
    const [a, b] = await Promise.all([
      claimJob(sql, { jobTypes: ["baseline_mining"], owner: "w1", leaseSeconds: 60 }),
      claimJob(other, { jobTypes: ["baseline_mining"], owner: "w2", leaseSeconds: 60 }),
    ]);
    expect(a?.id).not.toBe(b?.id);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  it("does not claim a job whose retry delay has not elapsed", async () => {
    await submit("delayed");
    const claimed = await claimJob(sql, {
      jobTypes: ["baseline_mining"],
      owner: "w1",
      leaseSeconds: 60,
    });
    await failJob(sql, {
      jobId: claimed?.id ?? "",
      owner: "w1",
      code: "SIGNOZ_UNREACHABLE",
      message: "unreachable",
      retryable: true,
      retryDelaySeconds: 60,
    });
    expect(
      await claimJob(sql, { jobTypes: ["baseline_mining"], owner: "w1", leaseSeconds: 60 }),
    ).toBeNull();
  });
});

describe("progress", () => {
  it("records ordered stages and refuses a regression", async () => {
    await submit("progress");
    const job = await claimJob(sql, {
      jobTypes: ["baseline_mining"],
      owner: "w1",
      leaseSeconds: 60,
    });
    const id = job?.id ?? "";

    expect(
      await recordProgress(sql, {
        jobId: id,
        owner: "w1",
        index: 1,
        stage: "discovering_traces",
        detail: "a",
        at: new Date(),
      }),
    ).toBe(true);
    expect(
      await recordProgress(sql, {
        jobId: id,
        owner: "w1",
        index: 2,
        stage: "fetching_span_trees",
        detail: "b",
        at: new Date(),
      }),
    ).toBe(true);

    // #when a replayed or out-of-order event arrives
    const replay = await recordProgress(sql, {
      jobId: id,
      owner: "w1",
      index: 1,
      stage: "discovering_traces",
      detail: "a again",
      at: new Date(),
    });

    // #then it is a no-op rather than a regression or an error
    expect(replay).toBe(false);
    const stored = await findJob(sql, id);
    expect(stored?.progressIndex).toBe(2);
    expect(stored?.progressStage).toBe("fetching_span_trees");
    expect(stored?.progressEvents.map((event) => event.stage)).toEqual([
      "discovering_traces",
      "fetching_span_trees",
    ]);
  });

  it("refuses a progress write from a worker that does not hold the lease", async () => {
    await submit("lease-guard");
    const job = await claimJob(sql, {
      jobTypes: ["baseline_mining"],
      owner: "w1",
      leaseSeconds: 60,
    });
    expect(
      await recordProgress(sql, {
        jobId: job?.id ?? "",
        owner: "w2",
        index: 1,
        stage: "discovering_traces",
        detail: "x",
        at: new Date(),
      }),
    ).toBe(false);
  });

  it("bounds the stored event list", async () => {
    await submit("bounded");
    const job = await claimJob(sql, {
      jobTypes: ["baseline_mining"],
      owner: "w1",
      leaseSeconds: 60,
    });
    const id = job?.id ?? "";
    for (let index = 1; index <= MAX_PROGRESS_EVENTS + 5; index += 1) {
      await recordProgress(sql, {
        jobId: id,
        owner: "w1",
        index,
        stage: "s",
        detail: "d",
        at: new Date(),
      });
    }
    const stored = await findJob(sql, id);
    expect(stored?.progressEvents).toHaveLength(MAX_PROGRESS_EVENTS);
    // #and the index still advanced, so the stage a caller polls for is current
    expect(stored?.progressIndex).toBe(MAX_PROGRESS_EVENTS + 5);
  });

  it("survives a process restart, because the events are on the row", async () => {
    await submit("restart");
    const job = await claimJob(sql, {
      jobTypes: ["baseline_mining"],
      owner: "w1",
      leaseSeconds: 60,
    });
    await recordProgress(sql, {
      jobId: job?.id ?? "",
      owner: "w1",
      index: 3,
      stage: "normalising_routes",
      detail: "c",
      at: new Date(),
    });

    // #when a different connection reads the job, as a restarted API would
    const seen = await findJob(other, job?.id ?? "");
    expect(seen?.progressEvents.at(-1)?.stage).toBe("normalising_routes");
  });
});

describe("completion, failure and retry", () => {
  it("commits the result and the success transition together", async () => {
    await submit("commit");
    const job = await claimJob(sql, {
      jobTypes: ["baseline_mining"],
      owner: "w1",
      leaseSeconds: 60,
    });

    // #when the transaction that writes the output fails after the output was written
    await expect(
      sql.begin(async (tx) => {
        await tx`insert into projects (name, slug) values ('Committed', 'committed-side-effect')`;
        await completeJob(tx, job?.id ?? "", "w1", { ok: true });
        throw new Error("crash after producing output");
      }),
    ).rejects.toThrow(/crash after producing output/);

    // #then neither the output nor the success survived
    const project = await sql<{ count: string }[]>`
      select count(*)::text as count from projects where slug = 'committed-side-effect'`;
    expect(project[0]?.count).toBe("0");
    const stored = await findJob(sql, job?.id ?? "");
    expect(stored?.status).toBe("running");
  });

  it("refuses completion from a worker that lost the lease", async () => {
    await submit("lost-lease");
    const job = await claimJob(sql, {
      jobTypes: ["baseline_mining"],
      owner: "w1",
      leaseSeconds: 60,
    });
    expect(await completeJob(sql, job?.id ?? "", "w2", { ok: true })).toBeNull();
    expect((await findJob(sql, job?.id ?? ""))?.status).toBe("running");
  });

  it("requeues a retryable failure and fails terminally at the attempt ceiling", async () => {
    await submit("retries", { maxAttempts: 2 });

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const job = await claimJob(sql, {
        jobTypes: ["baseline_mining"],
        owner: "w1",
        leaseSeconds: 60,
      });
      expect(job?.attempt).toBe(attempt);
      await failJob(sql, {
        jobId: job?.id ?? "",
        owner: "w1",
        code: "SIGNOZ_UNREACHABLE",
        message: "unreachable",
        retryable: true,
        retryDelaySeconds: 0,
      });
    }

    const finished = await listJobs(sql, {}, toPageRequest({ limit: 5 }));
    expect(finished.items[0]?.status).toBe("failed");
    expect(finished.items[0]?.failure?.retryable).toBe(true);
    expect(finished.items[0]?.attempt).toBe(2);
    // #and it is no longer claimable
    expect(
      await claimJob(sql, { jobTypes: ["baseline_mining"], owner: "w1", leaseSeconds: 60 }),
    ).toBeNull();
  });

  it("fails a terminal error on the first attempt", async () => {
    await submit("terminal");
    const job = await claimJob(sql, {
      jobTypes: ["baseline_mining"],
      owner: "w1",
      leaseSeconds: 60,
    });
    const failed = await failJob(sql, {
      jobId: job?.id ?? "",
      owner: "w1",
      code: "CONTRACT_INVALID",
      message: "the contract is invalid",
      retryable: false,
    });
    expect(failed?.status).toBe("failed");
    expect(failed?.failure?.code).toBe("CONTRACT_INVALID");
    expect(failed?.completedAt).not.toBeNull();
  });
});

describe("lease recovery", () => {
  it("returns a job whose worker died to the queue", async () => {
    await submit("crashed", { maxAttempts: 3 });
    const job = await claimJob(sql, {
      jobTypes: ["baseline_mining"],
      owner: "w1",
      leaseSeconds: 60,
    });
    // #given the worker stopped responding: its lease is now in the past
    await sql`update jobs set lease_expires_at = now() - interval '1 second' where id = ${job?.id ?? ""}`;

    const recovered = await reclaimExpiredLeases(sql);
    expect(recovered.requeued).toContain(job?.id);
    expect(recovered.abandoned).toEqual([]);

    // #then another worker can pick it up
    const reclaimed = await claimJob(other, {
      jobTypes: ["baseline_mining"],
      owner: "w2",
      leaseSeconds: 60,
    });
    expect(reclaimed?.id).toBe(job?.id);
    expect(reclaimed?.attempt).toBe(2);
  });

  it("abandons a job whose attempts are exhausted", async () => {
    await submit("exhausted", { maxAttempts: 1 });
    const job = await claimJob(sql, {
      jobTypes: ["baseline_mining"],
      owner: "w1",
      leaseSeconds: 60,
    });
    await sql`update jobs set lease_expires_at = now() - interval '1 second' where id = ${job?.id ?? ""}`;

    const recovered = await reclaimExpiredLeases(sql);
    expect(recovered.abandoned).toContain(job?.id);
    expect((await findJob(sql, job?.id ?? ""))?.status).toBe("failed");
  });

  it("renews a lease only for the worker that holds it", async () => {
    await submit("renew");
    const job = await claimJob(sql, {
      jobTypes: ["baseline_mining"],
      owner: "w1",
      leaseSeconds: 1,
    });
    expect(await renewLease(sql, job?.id ?? "", "w1", 300)).toBe(true);
    expect(await renewLease(sql, job?.id ?? "", "w2", 300)).toBe(false);

    // #and a renewed lease is no longer expired
    const recovered = await reclaimExpiredLeases(sql);
    expect(recovered.requeued).not.toContain(job?.id);
  });
});

describe("cancellation", () => {
  it("cancels a queued job immediately", async () => {
    const submitted = await submit("cancel-queued");
    const cancelled = await requestCancellation(sql, submitted.job.id);
    expect(cancelled?.status).toBe("cancelled");
    expect(
      await claimJob(sql, { jobTypes: ["baseline_mining"], owner: "w1", leaseSeconds: 60 }),
    ).toBeNull();
  });

  it("flags a running job and lets its worker finish the transition", async () => {
    await submit("cancel-running");
    const job = await claimJob(sql, {
      jobTypes: ["baseline_mining"],
      owner: "w1",
      leaseSeconds: 60,
    });

    const flagged = await requestCancellation(sql, job?.id ?? "");
    expect(flagged?.status).toBe("running");
    expect(flagged?.cancelRequested).toBe(true);

    const cancelled = await cancelClaimedJob(sql, job?.id ?? "", "w1");
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.completedAt).not.toBeNull();
  });
});

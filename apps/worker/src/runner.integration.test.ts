import {
  connect,
  findJob,
  MIGRATIONS_DIR,
  migrateUp,
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

function runnerWith(handler: JobHandler, workerId = "worker-1"): JobRunner {
  return new JobRunner({
    sql,
    config: loadWorkerConfig({ ...ENV, WORKER_ID: workerId }),
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

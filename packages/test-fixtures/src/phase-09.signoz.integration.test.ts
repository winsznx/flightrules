import { buildApi } from "@flightrules/api/app";
import { loadApiConfig } from "@flightrules/api/config";
import { liveSignozGateway } from "@flightrules/api/signoz";
import { parseContract } from "@flightrules/contract-schema";
import { connect, findJob, MIGRATIONS_DIR, migrateUp, type Sql } from "@flightrules/db";
import { loadWorkerConfig } from "@flightrules/worker/config";
import { createHandlers } from "@flightrules/worker/handlers";
import { JobRunner } from "@flightrules/worker/runner";
import { liveSignozFactory } from "@flightrules/worker/signoz";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The Phase 09 exit gate, end to end, against the live stack.
 *
 * The whole chain runs here with nothing simulated: the API submits a job, a worker claims it,
 * `packages/baseline-miner` retrieves real traces through the supported MCP path, the baseline and
 * its families are persisted transactionally, a human approval is recorded through the API, a
 * contract is proposed and stored as a draft, the Phase 07 validator accepts the stored document,
 * the contract is activated, and the canary is evaluated against it with its violations persisted
 * and retrievable through the API.
 *
 * Requires: `make up`, a deployed SigNoz, and a recent demo batch —
 * `DEMO_RUNS=25 make demo-v1 && make demo-v2`.
 */

const databaseUrl = process.env["DATABASE_URL"];
const signozApiKey = process.env["SIGNOZ_API_KEY"];
if (!databaseUrl || !signozApiKey || signozApiKey === "replace-me") {
  throw new Error(
    "DATABASE_URL and SIGNOZ_API_KEY must be set. Source .env, run `make up`, and seed a demo batch.",
  );
}

const ENV: Record<string, string> = {
  NODE_ENV: "test",
  DATABASE_URL: databaseUrl,
  SIGNOZ_URL: process.env["SIGNOZ_URL"] ?? "http://localhost:8080",
  SIGNOZ_MCP_URL: process.env["SIGNOZ_MCP_URL"] ?? "http://localhost:8000/mcp",
  SIGNOZ_API_KEY: signozApiKey,
  OTEL_EXPORTER_OTLP_ENDPOINT:
    process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ?? "http://localhost:4318",
  IDEMPOTENCY_HASH_SALT: process.env["IDEMPOTENCY_HASH_SALT"] ?? "0123456789abcdef0123456789abcdef",
  DEPLOYMENT_ENVIRONMENT_NAME: process.env["DEPLOYMENT_ENVIRONMENT_NAME"] ?? "local",
  DEMO_MODE: "true",
  WORKER_LEASE_SECONDS: "300",
  WORKER_HEARTBEAT_INTERVAL_MS: "5000",
};

const END_MS = Date.now();
const START_MS = END_MS - 6 * 60 * 60 * 1000;

let sql: Sql;
let server: FastifyInstance;
let runner: JobRunner;
let projectId = "";
let agentId = "";

beforeAll(async () => {
  sql = connect(databaseUrl, { max: 6 });
  await sql`drop schema public cascade`;
  await sql`create schema public`;
  await migrateUp(sql, MIGRATIONS_DIR);

  const apiConfig = loadApiConfig(ENV);
  const built = buildApi({
    logger: false,
    context: {
      sql,
      config: apiConfig,
      migrationsDir: MIGRATIONS_DIR,
      now: () => new Date(END_MS),
      gateway: () => liveSignozGateway(apiConfig),
    },
  });
  server = built.server;
  await server.ready();

  const workerConfig = loadWorkerConfig({ ...ENV, WORKER_ID: "phase-09-live" });
  runner = new JobRunner({
    sql,
    config: workerConfig,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    handlers: createHandlers({ signoz: liveSignozFactory(workerConfig) }),
  });

  const reset = await server.inject({
    method: "POST",
    url: "/api/demo/reset",
    payload: { confirm: true },
  });
  expect(reset.statusCode).toBe(200);
  projectId = reset.json().projectId as string;
  agentId = reset.json().agentId as string;
}, 120_000);

afterAll(async () => {
  await server?.close();
  await sql?.end({ timeout: 5 });
});

async function drain(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await runner.runOnce();
    if (!result.claimed) return;
  }
  throw new Error("the queue did not drain");
}

describe("the Phase 09 exit gate against the live stack", () => {
  let baselineId = "";
  let contractId = "";

  it("verifies the SigNoz connection through the API and stores the snapshot", async () => {
    const response = await server.inject({ method: "POST", url: "/api/setup/signoz/verify" });
    expect(response.statusCode).toBe(200);
    expect(response.json().satisfied).toBe(true);
    expect(response.json().server?.version).toBeTruthy();

    const stored = await sql<{ api_key_secret_reference: string }[]>`
      select api_key_secret_reference from signoz_connections`;
    // PRD section 14.2: the reference, never the key.
    expect(stored[0]?.api_key_secret_reference).toBe("env:SIGNOZ_API_KEY");
  });

  it("mines a real baseline through the job system and persists it", async () => {
    const submitted = await server.inject({
      method: "POST",
      url: `/api/agents/${agentId}/baselines`,
      payload: {
        releaseKey: "refund-agent-v1",
        environment: ENV["DEPLOYMENT_ENVIRONMENT_NAME"],
        startMs: START_MS,
        endMs: END_MS,
        minimumRuns: 20,
        rootSpanName: "refund.request",
      },
    });
    expect(submitted.statusCode).toBe(202);
    const jobId = submitted.json().jobId as string;

    // #and a repeated identical submission is the same job, not a second mining run
    const repeat = await server.inject({
      method: "POST",
      url: `/api/agents/${agentId}/baselines`,
      payload: {
        releaseKey: "refund-agent-v1",
        environment: ENV["DEPLOYMENT_ENVIRONMENT_NAME"],
        startMs: START_MS,
        endMs: END_MS,
        minimumRuns: 20,
        rootSpanName: "refund.request",
      },
    });
    expect(repeat.json().jobId).toBe(jobId);
    expect(repeat.json().created).toBe(false);

    await drain();

    const job = await findJob(sql, jobId);
    expect(job?.status, JSON.stringify(job?.failure)).toBe("succeeded");
    const result = job?.result as {
      baselineId: string;
      routeFamilies: number;
      eligibleRuns: number;
    };
    expect(result.routeFamilies).toBeGreaterThanOrEqual(1);
    expect(result.eligibleRuns).toBeGreaterThanOrEqual(20);
    baselineId = result.baselineId;

    // #and the progress events PRD section 8.7 defines were recorded in order
    const stages = job?.progressEvents.map((event) => event.stage) ?? [];
    expect(stages[0]).toBe("discovering_traces");
    expect(stages).toContain("grouping_route_families");

    // #and the baseline is retrievable through the API with its families and statistics
    const detail = await server.inject({ method: "GET", url: `/api/baselines/${baselineId}` });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.status).toBe("pending_review");
    expect(body.families.length).toBeGreaterThanOrEqual(1);
    expect(body.families[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(body.selectionHash).toMatch(/^[0-9a-f]{64}$/);

    // #and the runs it was mined from were persisted as trace runs and canonical graphs
    const runs = await sql<{ count: string }[]>`select count(*)::text as count from trace_runs`;
    expect(Number.parseInt(runs[0]?.count ?? "0", 10)).toBeGreaterThanOrEqual(20);
    const graphs = await sql<{ count: string }[]>`select count(*)::text as count from trace_graphs`;
    expect(graphs[0]?.count).toBe(runs[0]?.count);
  }, 300_000);

  it("records a human approval and proposes a contract that the Phase 07 validator accepts", async () => {
    const detail = await server.inject({ method: "GET", url: `/api/baselines/${baselineId}` });
    const family = detail.json().families[0] as { id: string; fingerprint: string };

    const approved = await server.inject({
      method: "POST",
      url: `/api/baselines/${baselineId}/route-families/${family.id}/approve`,
      payload: {},
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ baselineStatus: "approved" });

    const proposal = await server.inject({
      method: "POST",
      url: `/api/baselines/${baselineId}/propose-contract`,
      payload: { workflowName: "refund-workflow", createdAt: "2026-07-25T00:00:00Z" },
    });
    expect(proposal.statusCode).toBe(202);

    await drain();

    const job = await findJob(sql, proposal.json().jobId as string);
    expect(job?.status, JSON.stringify(job?.failure)).toBe("succeeded");
    const result = job?.result as { contractId: string; status: string; rules: number };
    // FR-018 and ADR-0007 decision 14: a proposal is a draft. Nothing was activated.
    expect(result.status).toBe("draft");
    expect(result.rules).toBeGreaterThan(10);
    contractId = result.contractId;

    const stored = await server.inject({ method: "GET", url: `/api/contracts/${contractId}` });
    expect(stored.json().source).toBe("mined");
    expect(stored.json().rules.length).toBe(result.rules);
    // FR-008: every proposed rule carries its evidence basis.
    for (const rule of stored.json().rules as { evidenceBasis: unknown }[]) {
      expect(rule.evidenceBasis).not.toBeNull();
    }

    const exported = await server.inject({
      method: "GET",
      url: `/api/contracts/${contractId}/export`,
    });
    const reparsed = parseContract(exported.json().yaml as string);
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) expect(reparsed.value.contentHash).toBe(stored.json().contentHash);
  }, 300_000);

  it("approves and activates the generated contract", async () => {
    const approved = await server.inject({
      method: "POST",
      url: `/api/contracts/${contractId}/approve`,
      payload: {},
    });
    expect(approved.json().status).toBe("approved");

    const activated = await server.inject({
      method: "POST",
      url: `/api/contracts/${contractId}/activate`,
      payload: {},
    });
    expect(activated.json().status).toBe("active");
  });

  it("passes a fresh known-good run and fails the unsafe canary, with evidence", async () => {
    const evaluate = async (releaseKey: string) => {
      const submitted = await server.inject({
        method: "POST",
        url: `/api/agents/${agentId}/evaluations`,
        payload: {
          contractId,
          releaseKey,
          environment: ENV["DEPLOYMENT_ENVIRONMENT_NAME"],
          rootSpanName: "refund.request",
          startMs: START_MS,
          endMs: END_MS,
          maxTraces: 5,
        },
      });
      expect(submitted.statusCode).toBe(202);
      await drain();
      const job = await findJob(sql, submitted.json().jobId as string);
      expect(job?.status, JSON.stringify(job?.failure)).toBe("succeeded");
      const detail = await server.inject({
        method: "GET",
        url: `/api/evaluations/${submitted.json().evaluationId}`,
      });
      return detail.json();
    };

    const good = await evaluate("refund-agent-v1");
    expect(good.status).toBe("pass");
    expect(good.runs.length).toBeGreaterThan(0);
    for (const run of good.runs as { status: string; routeApproved: boolean }[]) {
      expect(run.status).toBe("pass");
      expect(run.routeApproved).toBe(true);
    }
    expect(good.summary.violations).toBe(0);

    const canary = await evaluate("refund-agent-v2");
    expect(canary.status).toBe("fail");
    expect(canary.summary.violations).toBeGreaterThan(0);
    expect(canary.summary.zeroToleranceViolations).toBeGreaterThanOrEqual(3);

    // #and each violation links to real trace evidence through the API (FR-017)
    const violations = await server.inject({
      method: "GET",
      url: `/api/projects/${projectId}/violations?limit=50`,
    });
    const items = violations.json().items as { id: string; violationType: string }[];
    expect(items.length).toBeGreaterThan(0);
    const codes = items.map((item) => item.violationType);
    expect(codes).toContain("REQUIRED_SPAN_MISSING");
    expect(codes).toContain("CARDINALITY_ABOVE_MAX");

    const evidence = await server.inject({
      method: "GET",
      url: `/api/violations/${items[0]?.id}/evidence`,
    });
    expect(evidence.statusCode).toBe(200);
    expect(evidence.json().traceId).toMatch(/^[0-9a-f]+$/);
    expect(evidence.json().contractId).toBe(contractId);
    expect(evidence.json().evaluatorVersion).toBeTruthy();
  }, 300_000);

  it("keeps every result available after the applications restart", async () => {
    // #given a completely new API over the same database
    const apiConfig = loadApiConfig(ENV);
    const restarted = buildApi({
      logger: false,
      context: {
        sql: connect(databaseUrl, { max: 2 }),
        config: apiConfig,
        migrationsDir: MIGRATIONS_DIR,
        now: () => new Date(),
        gateway: () => liveSignozGateway(apiConfig),
      },
    });
    await restarted.server.ready();

    const status = await restarted.server.inject({ method: "GET", url: "/api/demo/status" });
    expect(status.json()).toMatchObject({
      projectId,
      agentId,
      activeContractId: contractId,
    });
    expect(status.json().baselineCount).toBeGreaterThanOrEqual(1);

    const baseline = await restarted.server.inject({
      method: "GET",
      url: `/api/baselines/${baselineId}`,
    });
    expect(baseline.json().status).toBe("approved");
    await restarted.server.close();
  });
});

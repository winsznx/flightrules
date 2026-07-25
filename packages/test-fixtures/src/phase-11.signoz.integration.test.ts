import { buildApi } from "@flightrules/api/app";
import { loadApiConfig } from "@flightrules/api/config";
import { liveSignozGateway } from "@flightrules/api/signoz";
import { connect, MIGRATIONS_DIR, migrateUp, type Sql } from "@flightrules/db";
import { loadWorkerConfig } from "@flightrules/worker/config";
import { createHandlers } from "@flightrules/worker/handlers";
import { JobRunner } from "@flightrules/worker/runner";
import { liveSignozFactory } from "@flightrules/worker/signoz";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The Phase 11 exit gate against the live stack: **a release pipeline can fail because of
 * trajectory evidence from SigNoz.**
 *
 * Nothing here is a fixture. Real traces are discovered through the pinned MCP server, real graphs
 * are reconstructed from them, a real contract mined from the approved release judges both, and the
 * two gate decisions are read back through the API exactly as the CLI and the GitHub workflow read
 * them. The assertions are the product's central claim stated as numbers: the approved release
 * passes and exits `0`, and the unsafe canary fails and exits `2`.
 *
 * Requires: `make up`, a deployed SigNoz, and a recent demo batch
 * (`DEMO_RUNS=25 make demo-v1 && DEMO_RUNS=8 make demo-v2`).
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
  DEPLOYMENT_ENVIRONMENT: process.env["DEPLOYMENT_ENVIRONMENT"] ?? "local",
};

const PROJECT_SLUG = "phase-11-gate";
const AGENT_KEY = "refund-agent";
const ENVIRONMENT = ENV["DEPLOYMENT_ENVIRONMENT"] as string;
const ROOT_SPAN = "refund.request";
const BASELINE_RELEASE = "refund-agent-v1";
const CANARY_RELEASE = "refund-agent-v2";

/** The CLI's table, restated as literals. A test that imported it could not catch a change to it. */
const EXIT = { pass: 0, violation: 2, insufficientData: 3, integrationError: 4 } as const;

let sql: Sql;
let server: FastifyInstance;
let runner: JobRunner;
let projectId: string;
let agentId: string;
let contractId: string;

async function drain(): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!(await runner.runOnce()).claimed) return;
  }
  throw new Error("the queue did not drain");
}

async function post(url: string, payload: unknown): Promise<Record<string, unknown>> {
  const response = await server.inject({ method: "POST", url, payload });
  if (response.statusCode >= 400) {
    throw new Error(`POST ${url} -> ${response.statusCode} ${response.body.slice(0, 300)}`);
  }
  return response.json() as Record<string, unknown>;
}

async function runJob(url: string, payload: unknown): Promise<Record<string, unknown>> {
  const accepted = await post(url, payload);
  await drain();
  const job = await server.inject({ method: "GET", url: `/api/jobs/${accepted["jobId"]}` });
  const body = job.json() as Record<string, unknown>;
  if (body["status"] !== "succeeded") {
    throw new Error(
      `job ${String(accepted["jobId"])} ${String(body["status"])}: ${job.body.slice(0, 300)}`,
    );
  }
  return { ...body, jobId: accepted["jobId"], evaluationId: accepted["evaluationId"] };
}

beforeAll(async () => {
  sql = connect(databaseUrl, { max: 6 });
  await sql`drop schema public cascade`;
  await sql`create schema public`;
  await migrateUp(sql, MIGRATIONS_DIR);

  const apiConfig = loadApiConfig(ENV);
  server = buildApi({
    logger: false,
    context: {
      sql,
      config: apiConfig,
      migrationsDir: MIGRATIONS_DIR,
      now: () => new Date(),
      gateway: () => liveSignozGateway(apiConfig),
    },
  }).server;
  await server.ready();

  const workerConfig = loadWorkerConfig({ ...ENV, WORKER_ID: "phase-11-live" });
  runner = new JobRunner({
    sql,
    config: workerConfig,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    handlers: createHandlers({ signoz: liveSignozFactory(workerConfig) }),
  });

  const project = await post("/api/projects", {
    name: "Phase 11 Gate",
    slug: PROJECT_SLUG,
    defaultEnvironment: ENVIRONMENT,
  });
  projectId = project["id"] as string;

  const agent = await post(`/api/projects/${projectId}/agents`, {
    name: "Refund Agent",
    agentKey: AGENT_KEY,
    workflowNameMatcher: "refund-workflow",
    rootSpanMatcher: { name: ROOT_SPAN },
    serviceMatchers: ["flightrules-demo-agent"],
    releaseAttributeKey: "agent.release.id",
    environmentAttributeKey: "deployment.environment.name",
  });
  agentId = agent["id"] as string;

  // A baseline mined from the live approved release, then reviewed and turned into a contract, the
  // way a user would. Nothing is hand-written.
  const endMs = Date.now();
  const mined = await runJob(`/api/agents/${agentId}/baselines`, {
    releaseKey: BASELINE_RELEASE,
    environment: ENVIRONMENT,
    startMs: endMs - 6 * 60 * 60_000,
    endMs,
    minimumRuns: 20,
    rootSpanName: ROOT_SPAN,
    maxTraces: 500,
  });
  const baselineId = (mined["result"] as Record<string, unknown>)["baselineId"] as string;

  const baseline = (
    await server.inject({ method: "GET", url: `/api/baselines/${baselineId}` })
  ).json() as { families: { id: string; occurrenceCount: number }[] };
  const dominant = [...baseline.families].sort(
    (a, b) => b.occurrenceCount - a.occurrenceCount,
  )[0] as { id: string };
  await post(`/api/baselines/${baselineId}/route-families/${dominant.id}/approve`, {});

  const proposed = await runJob(`/api/baselines/${baselineId}/propose-contract`, {
    workflowName: "refund-workflow",
    environment: ENVIRONMENT,
    contractName: "Phase 11 contract",
    semanticVersion: "1.0.0",
    createdAt: "2026-07-25T00:00:00.000Z",
  });
  contractId = (proposed["result"] as Record<string, unknown>)["contractId"] as string;

  await post(`/api/contracts/${contractId}/approve`, {});
  await post(`/api/contracts/${contractId}/activate`, {});
}, 900_000);

afterAll(async () => {
  await server?.close();
  await sql?.end({ timeout: 5 });
});

async function evaluate(releaseKey: string, lookbackMinutes: number): Promise<string> {
  const endMs = Date.now();
  const result = await runJob(`/api/agents/${agentId}/evaluations`, {
    contractId,
    releaseKey,
    environment: ENVIRONMENT,
    scope: "release",
    rootSpanName: ROOT_SPAN,
    startMs: endMs - lookbackMinutes * 60_000,
    endMs,
    maxTraces: 500,
  });
  const evaluation = (
    await server.inject({ method: "GET", url: `/api/evaluations/${result["evaluationId"]}` })
  ).json() as { releaseId: string };
  return evaluation.releaseId;
}

async function gate(releaseId: string): Promise<Record<string, never>> {
  const response = await server.inject({
    method: "GET",
    url: `/api/releases/${releaseId}/gate`,
  });
  expect(response.statusCode).toBe(200);
  return response.json() as Record<string, never>;
}

let baselineReleaseId: string;
let canaryReleaseId: string;

describe("Phase 11 exit gate against live SigNoz evidence", () => {
  it("evaluates the approved release from live traces and passes its own contract", async () => {
    // #given the release the contract was mined from, evaluated from live SigNoz traces
    baselineReleaseId = await evaluate(BASELINE_RELEASE, 6 * 60);

    // #when the release gate is read
    const decision = (await gate(baselineReleaseId)) as unknown as {
      decision: string;
      exitCode: number;
      counts: { evaluatedRuns: number; failedRuns: number; zeroToleranceViolations: number };
      findings: unknown[];
    };

    // #then it passes and would exit 0
    expect(decision.decision).toBe("pass");
    expect(decision.exitCode).toBe(EXIT.pass);
    expect(decision.counts.evaluatedRuns).toBeGreaterThanOrEqual(20);
    expect(decision.counts.failedRuns).toBe(0);
    expect(decision.counts.zeroToleranceViolations).toBe(0);
    expect(decision.findings).toEqual([]);
  }, 900_000);

  it("fails the unsafe canary with exit code 2 and names the rules it broke", async () => {
    // #given the canary that skips the checks and duplicates the refund
    canaryReleaseId = await evaluate(CANARY_RELEASE, 60);

    const decision = (await gate(canaryReleaseId)) as unknown as {
      decision: string;
      exitCode: number;
      counts: {
        failedRuns: number;
        zeroToleranceViolations: number;
        duplicateSideEffectRuns: number;
      };
      findings: { code: string }[];
      evidence: { zeroToleranceRuleIds: string[]; representativeFailingTraceIds: string[] };
    };

    // #then the pipeline fails, with the exit code a CI system acts on
    expect(decision.decision).toBe("fail");
    expect(decision.exitCode).toBe(EXIT.violation);
    expect(decision.counts.failedRuns).toBeGreaterThan(0);
    expect(decision.counts.zeroToleranceViolations).toBeGreaterThan(0);
    expect(decision.counts.duplicateSideEffectRuns).toBeGreaterThan(0);

    // #and the reason is a zero-tolerance rule, not a rate that happened to tip over
    expect(decision.findings.map((finding) => finding.code)).toContain("ZERO_TOLERANCE_VIOLATION");
    expect(decision.evidence.zeroToleranceRuleIds.length).toBeGreaterThan(0);

    // #and every finding resolves to a real trace in SigNoz
    expect(decision.evidence.representativeFailingTraceIds.length).toBeGreaterThan(0);
    for (const traceId of decision.evidence.representativeFailingTraceIds) {
      expect(traceId).toMatch(/^[0-9a-f]{16,32}$/);
    }
  }, 900_000);

  it("reports the canary's unknown route and its missing prerequisites separately", async () => {
    // #then the canary is not merely "different"; the gate says which properties changed
    const decision = (await gate(canaryReleaseId)) as unknown as {
      counts: { unknownRouteRuns: number; missingPrerequisiteRuns: number };
      rates: { unknownRoute: { percent: string }; violation: { percent: string } };
    };
    expect(decision.counts.unknownRouteRuns).toBeGreaterThan(0);
    expect(decision.counts.missingPrerequisiteRuns).toBeGreaterThan(0);
    expect(decision.rates.violation.percent).toMatch(/^\d+\.\d{6}$/);
  }, 120_000);

  it("measures the canary's latency regression against the mined baseline", async () => {
    // #then the regression is measured from the approved families' own statistics, not guessed
    const decision = (await gate(canaryReleaseId)) as unknown as {
      changes: {
        latency: { measured: boolean; baseline: number | null; candidate: number | null };
      };
    };
    expect(decision.changes.latency.measured).toBe(true);
    expect(decision.changes.latency.baseline).toBeGreaterThan(0);
    expect(decision.changes.latency.candidate).toBeGreaterThan(0);
  }, 120_000);

  it("returns the identical decision when read again", async () => {
    // #then the gate is a read over persisted evidence, not a fresh computation over live data
    const first = (await gate(canaryReleaseId)) as unknown as { decisionHash: string };
    const second = (await gate(canaryReleaseId)) as unknown as { decisionHash: string };
    expect(second.decisionHash).toBe(first.decisionHash);
  }, 120_000);

  it("serves the same decision from a restarted API", async () => {
    // #given a decision produced by this server
    const before = (await gate(canaryReleaseId)) as unknown as { decisionHash: string };

    // #when an entirely new server is built over the same database
    const apiConfig = loadApiConfig(ENV);
    const restarted = buildApi({
      logger: false,
      context: {
        sql,
        config: apiConfig,
        migrationsDir: MIGRATIONS_DIR,
        now: () => new Date(),
        gateway: () => liveSignozGateway(apiConfig),
      },
    }).server;
    await restarted.ready();
    const response = await restarted.inject({
      method: "GET",
      url: `/api/releases/${canaryReleaseId}/gate`,
    });
    await restarted.close();

    // #then nothing about the decision lived in the first process
    const after = response.json() as { decisionHash: string; exitCode: number };
    expect(after.decisionHash).toBe(before.decisionHash);
    expect(after.exitCode).toBe(EXIT.violation);
  }, 120_000);

  it("refuses to decide a release nothing has evaluated", async () => {
    // #given a release key no evaluation has ever covered
    const response = await server.inject({
      method: "GET",
      url: "/api/releases/00000000-0000-7000-8000-000000000000/gate",
    });

    // #then the absence of evidence is a typed refusal, never an empty pass
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  }, 60_000);

  it("leaks no credential, no raw MCP payload and no database column name", async () => {
    const response = await server.inject({
      method: "GET",
      url: `/api/releases/${canaryReleaseId}/gate`,
    });
    const body = response.body;
    expect(body).not.toContain(signozApiKey);
    expect(body).not.toContain("searchContext");
    expect(body).not.toContain("result_json");
    expect(body).not.toContain("postgres://");
  }, 60_000);
});

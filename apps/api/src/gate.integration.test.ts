import { readFileSync } from "node:fs";
import path from "node:path";
import type { RunEvaluation, Violation } from "@flightrules/contract-engine";
import {
  canonicalContract,
  contractContentHash,
  parseContract,
} from "@flightrules/contract-schema";
import {
  activateContract,
  approveContract,
  completeEvaluation,
  connect,
  createContract,
  createEvaluation,
  MIGRATIONS_DIR,
  migrateUp,
  observeRelease,
  persistRunEvaluation,
  type Sql,
  upsertTraceGraph,
  upsertTraceRun,
} from "@flightrules/db";
import type { CanonicalGraph } from "@flightrules/trace-graph";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApi } from "./app.js";
import { loadApiConfig } from "./config.js";
import type { SignozGateway } from "./signoz.js";

/**
 * `GET /api/releases/:releaseId/gate` against a real PostgreSQL (PRD section 15.7, FR-011, FR-012).
 *
 * The evidence these tests read is written the way the worker writes it — a release row, trace
 * runs, canonical graphs, an evaluation header and per-run results — so what is exercised is the
 * real read path, not a fixture handed to the aggregation. That matters because the route's whole
 * job is to turn stored evidence into a decision without recomputing anything.
 */

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  throw new Error("DATABASE_URL must be set for database integration tests. Run `make up` first.");
}

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CONTRACT_YAML = readFileSync(
  path.join(REPO_ROOT, "contracts/demo-commerce/refund-agent/production/contract.yaml"),
  "utf8",
);

const ENV = {
  NODE_ENV: "test",
  DATABASE_URL: databaseUrl,
  SIGNOZ_URL: "http://localhost:8080",
  SIGNOZ_MCP_URL: "http://localhost:8000/mcp",
  SIGNOZ_API_KEY: "test-key-not-a-real-secret",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
  IDEMPOTENCY_HASH_SALT: "0123456789abcdef0123456789abcdef",
} as const;

const NOW = new Date("2026-07-25T12:00:00.000Z");
const WINDOW_START = new Date(NOW.getTime() - 30 * 60_000);
const WINDOW_END = new Date(NOW.getTime() - 60_000);

const CONTRACT = (() => {
  const parsed = parseContract(CONTRACT_YAML);
  if (!parsed.ok) throw new Error("the committed contract does not parse");
  return parsed.value.contract;
})();
const CONTENT_HASH = contractContentHash(CONTRACT);
const APPROVED_FINGERPRINT = CONTRACT.spec.approvedRoutes[0] as string;
const FINGERPRINT_HEX = APPROVED_FINGERPRINT.replace("sha256:", "").padEnd(64, "0");

let sql: Sql;
let server: FastifyInstance;

const stubGateway = (): SignozGateway =>
  ({
    async verify() {
      return {
        capturedAtUtc: NOW.toISOString(),
        server: { name: "signoz-mcp-server", version: "0.9.0" },
        toolNames: [],
        resourceUris: [],
        requiredPresent: [],
        requiredMissing: [],
        satisfied: true,
      };
    },
    async discoverFields() {
      return [];
    },
    async previewTraces() {
      return [];
    },
    async close() {},
  }) as SignozGateway;

function build(now: () => Date = () => NOW): FastifyInstance {
  return buildApi({
    logger: false,
    context: {
      sql,
      config: loadApiConfig(ENV),
      migrationsDir: MIGRATIONS_DIR,
      now,
      gateway: stubGateway,
    },
  }).server;
}

beforeAll(async () => {
  sql = connect(databaseUrl, { max: 4 });
  await sql`drop schema public cascade`;
  await sql`create schema public`;
  await migrateUp(sql, MIGRATIONS_DIR);
  server = build();
  await server.ready();
});

afterAll(async () => {
  await server?.close();
  await sql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await sql`truncate projects restart identity cascade`;
});

/* -------------------------------------------------------------------------- */
/* Fixtures written the way the worker writes them                            */
/* -------------------------------------------------------------------------- */

function canonicalGraph(retryNumber: number | null): CanonicalGraph {
  return {
    normaliserVersion: "1.0.0",
    normaliserConfigHash: "1".repeat(64),
    nodes: [
      {
        order: 0,
        depth: 0,
        label: "refund.request",
        service: "flightrules-demo-agent",
        kind: "SERVER",
        sideEffect: "none",
        tool: null,
        dataDomain: null,
        retryNumber,
        attributes: {},
      },
    ],
    edges: [],
  };
}

function violation(overrides: Partial<Violation> = {}): Violation {
  return {
    id: "v-fraud",
    ruleId: "require-fraud-check",
    ruleType: "required_span",
    code: "REQUIRED_SPAN_MISSING",
    severity: "critical",
    zeroTolerance: true,
    summary: "A refund was issued without a fraud check.",
    expected: "at least 1",
    observed: "0",
    evidence: { spanIds: ["span-1"], canonicalNodes: [0], labels: ["fraud.check"] },
    ...overrides,
  };
}

function runEvaluation(traceId: string, overrides: Partial<RunEvaluation> = {}): RunEvaluation {
  const violations = overrides.violations ?? [];
  return {
    status: violations.length > 0 ? "fail" : "pass",
    evaluatorVersion: "1.0.0",
    normaliserVersion: "1.0.0",
    normaliserConfigHash: "1".repeat(64),
    contractId: CONTRACT.metadata.id,
    contractVersion: CONTRACT.metadata.version,
    contractContentHash: CONTENT_HASH,
    traceId,
    routeFingerprint: FINGERPRINT_HEX,
    routeApproved: violations.length === 0,
    nearestApprovedFingerprint: FINGERPRINT_HEX,
    similarity: { numerator: 1, denominator: 1, decimal: "1.000000" },
    traceQuality: "complete",
    traceWarnings: [],
    ruleResults: [],
    violations,
    counts: {
      rulesEvaluated: 15,
      rulesPassed: 15 - violations.length,
      rulesViolated: violations.length,
      rulesInsufficient: 0,
      rulesDeferred: 2,
      violations: violations.length,
      criticalViolations: violations.filter((entry) => entry.severity === "critical").length,
      zeroToleranceViolations: violations.filter((entry) => entry.zeroTolerance).length,
    },
    ...overrides,
  };
}

interface Seeded {
  readonly projectId: string;
  readonly agentId: string;
  readonly contractId: string;
  readonly releaseId: string;
  readonly evaluationId: string;
}

async function seed(options: {
  readonly runs: number;
  readonly failing?: number;
  readonly durationMs?: number;
  readonly activate?: boolean;
  readonly status?: "pass" | "fail" | "error" | "insufficient_data";
  readonly releaseKey?: string;
}): Promise<Seeded> {
  const project = await server.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name: "Demo Commerce", slug: "demo-commerce" },
  });
  expect(project.statusCode).toBe(201);
  const projectId = project.json().id as string;

  const agent = await server.inject({
    method: "POST",
    url: `/api/projects/${projectId}/agents`,
    payload: {
      name: "Refund agent",
      agentKey: "refund-agent",
      workflowNameMatcher: "refund-workflow",
      rootSpanMatcher: { name: "refund.request" },
      releaseAttributeKey: "agent.release.id",
      environmentAttributeKey: "deployment.environment.name",
    },
  });
  expect(agent.statusCode).toBe(201);
  const agentId = agent.json().id as string;

  const created = await createContract(sql, {
    agentId,
    baselineVersionId: null,
    jobId: null,
    environment: "production",
    source: "authored",
    contract: CONTRACT,
    canonical: canonicalContract(CONTRACT),
    contentHash: CONTENT_HASH,
    yamlText: CONTRACT_YAML,
  });
  const contractId = created.contract.id;
  await approveContract(sql, contractId);
  if (options.activate !== false) await activateContract(sql, contractId);

  const release = await observeRelease(sql, {
    agentId,
    releaseKey: options.releaseKey ?? "refund-agent-v2",
    environment: "production",
    observedAt: WINDOW_END,
  });

  const evaluation = await createEvaluation(sql, {
    agentId,
    contractId,
    releaseId: release.id,
    scope: "release",
    evaluatorVersion: "1.0.0",
    normaliserVersion: "1.0.0",
    normaliserConfigHash: "1".repeat(64),
    contractContentHash: CONTENT_HASH,
    idempotencyKey: "a".repeat(64),
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    jobId: null,
  });

  const failing = options.failing ?? 0;
  for (let index = 0; index < options.runs; index += 1) {
    const traceId = `${index.toString(16).padStart(8, "0")}${"b".repeat(24)}`;
    const traceRun = await upsertTraceRun(sql, {
      agentId,
      releaseId: release.id,
      traceId,
      runId: null,
      signozWebUrl: `http://localhost:8080/trace/${traceId}`,
      rootSpanId: null,
      startedAt: WINDOW_START,
      completedAt: WINDOW_END,
      durationMs: options.durationMs ?? 100,
      status: "ok",
      qualityStatus: "complete",
      summary: {},
    });
    await upsertTraceGraph(sql, {
      traceRunId: traceRun.id,
      normaliserVersion: "1.0.0",
      normaliserConfigHash: "1".repeat(64),
      graphSchemaVersion: "1.0.0",
      fingerprint: FINGERPRINT_HEX,
      canonical: canonicalGraph(0),
      featureSet: {},
      qualityWarnings: [],
    });
    const evaluated = runEvaluation(traceId, index < failing ? { violations: [violation()] } : {});
    await persistRunEvaluation(sql, evaluation.evaluation.id, {
      traceRunId: traceRun.id,
      nearestRouteFamilyId: null,
      evaluated: {
        evaluation: evaluated,
        runtime: { completedAt: WINDOW_END.toISOString(), durationMs: 5 },
        evaluationHash: `${index.toString(16).padStart(2, "0")}${"c".repeat(62)}`,
      },
      signozWebUrl: `http://localhost:8080/trace/${traceId}`,
    });
  }

  await completeEvaluation(
    sql,
    evaluation.evaluation.id,
    options.status ?? (failing > 0 ? "fail" : "pass"),
    { runs: options.runs, requestedRuns: options.runs, violations: failing },
  );

  return {
    projectId,
    agentId,
    contractId,
    releaseId: release.id,
    evaluationId: evaluation.evaluation.id,
  };
}

/* -------------------------------------------------------------------------- */

describe("GET /api/releases/:releaseId/gate", () => {
  it("passes a release of 25 clean runs", async () => {
    // #given 25 evaluated runs, none violating
    const seeded = await seed({ runs: 25 });

    // #when the gate is read
    const response = await server.inject({
      method: "GET",
      url: `/api/releases/${seeded.releaseId}/gate`,
    });

    // #then the decision is a pass and the exit code is 0
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.decision).toBe("pass");
    expect(body.exitCode).toBe(0);
    expect(body.counts.evaluatedRuns).toBe(25);
    expect(body.findings).toEqual([]);
  });

  it("fails a release carrying zero-tolerance violations with exit code 2", async () => {
    // #given 25 runs of which 14 violated a zero-tolerance rule
    const seeded = await seed({ runs: 25, failing: 14 });

    const response = await server.inject({
      method: "GET",
      url: `/api/releases/${seeded.releaseId}/gate`,
    });

    // #then the canonical failing-canary decision
    const body = response.json();
    expect(body.decision).toBe("fail");
    expect(body.exitCode).toBe(2);
    expect(body.counts.zeroToleranceViolations).toBe(14);
    expect(body.evidence.zeroToleranceRuleIds).toContain("require-fraud-check");
    expect(body.findings.map((finding: { code: string }) => finding.code)).toContain(
      "ZERO_TOLERANCE_VIOLATION",
    );
  });

  it("reports insufficient data below the contract's minimum run count", async () => {
    // #given five clean runs against a minimum of twenty
    const seeded = await seed({ runs: 5 });

    const body = (
      await server.inject({ method: "GET", url: `/api/releases/${seeded.releaseId}/gate` })
    ).json();

    // #then the gate withholds a decision rather than passing on a small sample
    expect(body.decision).toBe("insufficient_data");
    expect(body.exitCode).toBe(3);
  });

  it("returns a typed RELEASE_INSUFFICIENT_DATA for a release that was never evaluated", async () => {
    // #given a release with no evaluation at all
    const seeded = await seed({ runs: 1 });
    const bare = await observeRelease(sql, {
      agentId: seeded.agentId,
      releaseKey: "refund-agent-v3",
      environment: "production",
      observedAt: WINDOW_END,
    });

    const response = await server.inject({
      method: "GET",
      url: `/api/releases/${bare.id}/gate`,
    });

    // #then the absence of evidence is typed, never an empty pass
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("RELEASE_INSUFFICIENT_DATA");
  });

  it("returns NOT_FOUND for an unknown release", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/releases/00000000-0000-7000-8000-000000000000/gate",
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });

  it("refuses a malformed release identifier without touching the database", async () => {
    // #then an identifier that cannot name a resource is answered as "no such resource", the same
    // way every other route answers it — never as a server error and never as a gate decision
    const response = await server.inject({ method: "GET", url: "/api/releases/not-a-uuid/gate" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });

  it("refuses a freshness bound outside its declared range", async () => {
    const seeded = await seed({ runs: 25 });
    const response = await server.inject({
      method: "GET",
      url: `/api/releases/${seeded.releaseId}/gate?maxAgeSeconds=1`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_FAILED");
  });

  it("returns an error decision when the contract is no longer active", async () => {
    // #given a release evaluated against a contract that was never activated
    const seeded = await seed({ runs: 25, activate: false });

    const body = (
      await server.inject({ method: "GET", url: `/api/releases/${seeded.releaseId}/gate` })
    ).json();

    // #then a stale contract cannot silently gate a release
    expect(body.decision).toBe("error");
    expect(body.exitCode).toBe(4);
    expect(body.findings.map((finding: { code: string }) => finding.code)).toContain(
      "CONTRACT_NOT_ACTIVE",
    );
  });

  it("is idempotent apart from its retrieval timestamp", async () => {
    // #given one release read twice
    const seeded = await seed({ runs: 25, failing: 3 });
    const first = (
      await server.inject({ method: "GET", url: `/api/releases/${seeded.releaseId}/gate` })
    ).json();
    const second = (
      await server.inject({ method: "GET", url: `/api/releases/${seeded.releaseId}/gate` })
    ).json();

    // #then the decision hash is identical; only `retrievedAt` may differ
    expect(second.decisionHash).toBe(first.decisionHash);
    expect(second.decision).toBe(first.decision);
    delete first.retrievedAt;
    delete second.retrievedAt;
    expect(second).toEqual(first);
  });

  it("serves the same decision from a restarted API", async () => {
    // #given a decision read from one server instance
    const seeded = await seed({ runs: 25, failing: 14 });
    const before = (
      await server.inject({ method: "GET", url: `/api/releases/${seeded.releaseId}/gate` })
    ).json();

    // #when a completely new server is built over the same database
    const restarted = build();
    await restarted.ready();
    const after = (
      await restarted.inject({ method: "GET", url: `/api/releases/${seeded.releaseId}/gate` })
    ).json();
    await restarted.close();

    // #then nothing about the decision lived in the first process
    expect(after.decisionHash).toBe(before.decisionHash);
    expect(after.decision).toBe("fail");
  });

  it("produces one decision under concurrent reads", async () => {
    // #given eight simultaneous reads of one release
    const seeded = await seed({ runs: 25, failing: 14 });
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        server.inject({ method: "GET", url: `/api/releases/${seeded.releaseId}/gate` }),
      ),
    );

    // #then every one agrees, byte for byte
    const hashes = new Set(responses.map((response) => response.json().decisionHash as string));
    expect(hashes.size).toBe(1);
  });

  it("reports a stale aggregation when the window is older than the freshness bound", async () => {
    // #given a decision read two hours after its window closed, against a one-hour bound
    const seeded = await seed({ runs: 25 });
    const later = build(() => new Date(NOW.getTime() + 2 * 60 * 60_000));
    await later.ready();

    const body = (
      await later.inject({
        method: "GET",
        url: `/api/releases/${seeded.releaseId}/gate?maxAgeSeconds=3600`,
      })
    ).json();
    await later.close();

    // #then it is not presented as a statement about the current release state
    expect(body.decision).toBe("insufficient_data");
    expect(body.findings.map((finding: { code: string }) => finding.code)).toContain(
      "AGGREGATION_STALE",
    );
  });

  it("reports truncated retrieval from the evaluation's own summary", async () => {
    // #given an evaluation whose summary records more requested runs than it returned
    const seeded = await seed({ runs: 25 });
    await sql`
      update evaluations
      set summary_json = jsonb_set(summary_json, '{requestedRuns}', '400')
      where id = ${seeded.evaluationId}`;

    const body = (
      await server.inject({ method: "GET", url: `/api/releases/${seeded.releaseId}/gate` })
    ).json();

    expect(body.decision).toBe("insufficient_data");
    expect(body.retrieval).toEqual({ truncated: true, requested: 400, returned: 25 });
  });

  it("reads the newest completed evaluation and lists the earlier ones", async () => {
    // #given a second, later evaluation of the same release
    const seeded = await seed({ runs: 25 });
    const later = await createEvaluation(sql, {
      agentId: seeded.agentId,
      contractId: seeded.contractId,
      releaseId: seeded.releaseId,
      scope: "release",
      evaluatorVersion: "1.0.0",
      normaliserVersion: "1.0.0",
      normaliserConfigHash: "1".repeat(64),
      contractContentHash: CONTENT_HASH,
      idempotencyKey: "d".repeat(64),
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      jobId: null,
    });
    await completeEvaluation(sql, later.evaluation.id, "insufficient_data", { runs: 0 });

    const body = (
      await server.inject({ method: "GET", url: `/api/releases/${seeded.releaseId}/gate` })
    ).json();

    // #then the newest is the decision and the earlier one is still visible as history
    expect(body.evaluationId).toBe(later.evaluation.id);
    expect(body.history.map((entry: { evaluationId: string }) => entry.evaluationId)).toContain(
      seeded.evaluationId,
    );
  });

  it("pins the gate to one contract when asked", async () => {
    // #given a filter naming the contract the caller intends to gate on
    const seeded = await seed({ runs: 25 });
    const body = (
      await server.inject({
        method: "GET",
        url: `/api/releases/${seeded.releaseId}/gate?contractId=${seeded.contractId}`,
      })
    ).json();

    expect(body.contractId).toBe(seeded.contractId);
    expect(body.decision).toBe("pass");
  });

  it("exposes no raw database row and no credential", async () => {
    // #given a full decision document
    const seeded = await seed({ runs: 25, failing: 14 });
    const raw = (
      await server.inject({ method: "GET", url: `/api/releases/${seeded.releaseId}/gate` })
    ).body;

    // #then nothing snake_cased, no connection string and no key reaches the client
    expect(raw).not.toContain("result_json");
    expect(raw).not.toContain("summary_json");
    expect(raw).not.toContain("canonical_graph_json");
    expect(raw).not.toContain("postgres://");
    expect(raw).not.toContain(ENV.SIGNOZ_API_KEY);
  });

  it("appears in the generated OpenAPI document", async () => {
    // #then the route is described by the same declaration that serves it
    const document = (await server.inject({ method: "GET", url: "/api/openapi.json" })).json();
    expect(document.paths["/api/releases/{releaseId}/gate"]?.get).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* The release diff (PRD section 8.11, PRD Phase 14)                          */
/* -------------------------------------------------------------------------- */

describe("GET /api/releases/:releaseId/diff", () => {
  it("compares the release's representative run against an approved route family", async () => {
    // #given a release whose runs took a route the contract's baseline does not approve
    const seeded = await seed({ runs: 3, failing: 3 });

    // #when the diff is read
    const response = await server.inject({
      method: "GET",
      url: `/api/releases/${seeded.releaseId}/diff`,
    });

    // #then it names the evaluation it compared, and the run it chose
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      evaluationId: string;
      candidate: { trace: { status: string; signozWebUrl: string | null } } | null;
      changes: { kind: string; label: string; severity: string }[];
      representativeFailingTraces: unknown[];
      identical: boolean;
    };
    expect(body.evaluationId).toBe(seeded.evaluationId);
    // A failing run is the representative, because a regression is what the page exists to explain.
    expect(body.candidate?.trace.status).toBe("fail");
    expect(body.representativeFailingTraces.length).toBeGreaterThan(0);
  });

  it("builds a browser-reachable SigNoz link for every representative trace", async () => {
    // #given SL-061: the builder query returns no webUrl, so the link is constructed
    const seeded = await seed({ runs: 2, failing: 1 });

    const response = await server.inject({
      method: "GET",
      url: `/api/releases/${seeded.releaseId}/diff`,
    });

    // #then every link uses the configured origin and SigNoz's own `/trace/<id>` path
    const body = response.json() as {
      representativeFailingTraces: { traceId: string; signozWebUrl: string | null }[];
      representativePassingTraces: { traceId: string; signozWebUrl: string | null }[];
    };
    const traces = [...body.representativeFailingTraces, ...body.representativePassingTraces];
    expect(traces.length).toBeGreaterThan(0);
    for (const trace of traces) {
      expect(trace.signozWebUrl).toBe(`${ENV.SIGNOZ_URL}/trace/${trace.traceId}`);
    }
  });

  it("returns the same change list twice, byte for byte", async () => {
    // #given determinism is the whole basis for showing this to a reviewer
    const seeded = await seed({ runs: 4, failing: 2 });

    const first = await server.inject({
      method: "GET",
      url: `/api/releases/${seeded.releaseId}/diff`,
    });
    const second = await server.inject({
      method: "GET",
      url: `/api/releases/${seeded.releaseId}/diff`,
    });

    // #then only the retrieval timestamp differs
    const strip = (raw: string): string =>
      JSON.stringify({ ...(JSON.parse(raw) as Record<string, unknown>), retrievedAt: null });
    expect(strip(second.body)).toBe(strip(first.body));
  });

  it("labels every change with PRD section 8.11's own wording", async () => {
    const seeded = await seed({ runs: 2, failing: 2 });
    const response = await server.inject({
      method: "GET",
      url: `/api/releases/${seeded.releaseId}/diff`,
    });

    // #then no change is reported with an engine-internal name the PRD does not use
    const body = response.json() as { changes: { kind: string; label: string }[] };
    const PRD_LABELS = new Set([
      "Added step",
      "Removed step",
      "New edge",
      "Missing edge",
      "Cardinality changed",
      "New tool",
      "New service",
      "New data domain",
      "Retry increase",
      "Duplicate side effect",
      "Attribute changed",
      "Route not approved",
    ]);
    for (const change of body.changes) {
      expect(PRD_LABELS.has(change.label), `${change.kind} produced "${change.label}"`).toBe(true);
    }
  });

  it("discloses rather than guesses when the contract approves no route", async () => {
    // #given a contract whose baseline has no approved route family — the seeded contract is
    // authored, so no `route_families` rows exist for it at all
    const seeded = await seed({ runs: 2, failing: 1 });

    const response = await server.inject({
      method: "GET",
      url: `/api/releases/${seeded.releaseId}/diff`,
    });

    // #then the page is told why the comparison is empty, rather than being shown "no changes"
    const body = response.json() as {
      approvedRouteCount: number;
      baseline: unknown;
      disclosures: { code: string }[];
    };
    expect(body.approvedRouteCount).toBe(0);
    expect(body.baseline).toBeNull();
    expect(body.disclosures.map((entry) => entry.code)).toContain("NO_APPROVED_ROUTE");
  });

  it("refuses to produce a diff for a release that was never evaluated", async () => {
    // #given a release with no completed evaluation
    const seeded = await seed({ runs: 1 });
    const other = await observeRelease(sql, {
      agentId: seeded.agentId,
      releaseKey: "refund-agent-v3",
      environment: "production",
      observedAt: WINDOW_END,
    });

    const response = await server.inject({ method: "GET", url: `/api/releases/${other.id}/diff` });

    // #then it is a typed refusal, never an empty diff that would read as "nothing changed"
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("RELEASE_INSUFFICIENT_DATA");
  });

  it("returns NOT_FOUND for an unknown release", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/releases/00000000-0000-7000-8000-000000000000/diff",
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });
});

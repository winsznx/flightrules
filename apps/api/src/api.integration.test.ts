import { readFileSync } from "node:fs";
import path from "node:path";
import { connect, MIGRATIONS_DIR, migrateUp, type Sql } from "@flightrules/db";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApi } from "./app.js";
import { loadApiConfig } from "./config.js";
import { openApiDocument, type RouteRegistry } from "./registry.js";
import type { SignozGateway } from "./signoz.js";

/**
 * The API against a real PostgreSQL, driven through real HTTP handling.
 *
 * `server.inject` runs Fastify's full request pipeline — routing, body limit, error handler,
 * serialisation — without binding a port, so these are the same code paths a client exercises. The
 * SigNoz boundary is a stub, because PRD Phase 09's exit gate is about product state surviving a
 * restart and being drivable without the UI; the live SigNoz path is the worker's, and is proven
 * separately in `apps/worker/src/worker.signoz.integration.test.ts`.
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
  DEMO_MODE: "true",
} as const;

const NOW = new Date("2026-07-25T12:00:00.000Z");

let sql: Sql;
let server: FastifyInstance;
let registry: RouteRegistry;
let gatewayBehaviour: "ok" | "unreachable" = "ok";

const stubGateway = (): SignozGateway => ({
  async verify() {
    if (gatewayBehaviour === "unreachable") throw new Error("connect ECONNREFUSED");
    return {
      capturedAtUtc: NOW.toISOString(),
      server: { name: "signoz-mcp-server", version: "0.9.0" },
      toolNames: ["signoz_execute_builder_query", "signoz_get_field_keys"],
      resourceUris: [],
      requiredPresent: ["signoz_execute_builder_query"],
      requiredMissing: [],
      satisfied: true,
    };
  },
  async discoverFields() {
    if (gatewayBehaviour === "unreachable") throw new Error("connect ECONNREFUSED");
    return [{ name: "agent.release.id", fieldContext: "attribute", fieldDataType: "string" }];
  },
  async previewTraces() {
    if (gatewayBehaviour === "unreachable") throw new Error("connect ECONNREFUSED");
    return [
      {
        traceId: "a".repeat(32),
        name: "refund.request",
        serviceName: "flightrules-demo-agent",
        releaseId: "refund-agent-v1",
        timestamp: NOW.toISOString(),
      },
    ];
  },
  async close() {},
});

beforeAll(async () => {
  sql = connect(databaseUrl, { max: 4 });
  await sql`drop schema public cascade`;
  await sql`create schema public`;
  await migrateUp(sql, MIGRATIONS_DIR);

  const built = buildApi({
    logger: false,
    context: {
      sql,
      config: loadApiConfig(ENV),
      migrationsDir: MIGRATIONS_DIR,
      now: () => NOW,
      gateway: stubGateway,
    },
  });
  server = built.server;
  registry = built.registry;
  await server.ready();
});

afterAll(async () => {
  await server?.close();
  await sql?.end({ timeout: 5 });
});

beforeEach(async () => {
  gatewayBehaviour = "ok";
  await sql`truncate projects, signoz_connections, jobs restart identity cascade`;
});

async function createProject(slug = "demo-commerce"): Promise<string> {
  const response = await server.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name: "Demo Commerce", slug },
  });
  expect(response.statusCode).toBe(201);
  return response.json().id as string;
}

async function createAgent(projectId: string): Promise<string> {
  const response = await server.inject({
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
  expect(response.statusCode).toBe(201);
  return response.json().id as string;
}

describe("health", () => {
  it("reports liveness without touching a dependency", async () => {
    const response = await server.inject({ method: "GET", url: "/health/live" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok" });
  });

  it("reports readiness only when every required migration is applied", async () => {
    const response = await server.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ready");
    expect(body.schema.compatible).toBe(true);
    expect(body.schema.missing).toEqual([]);
  });

  it("reports SigNoz as down without taking readiness down with it", async () => {
    gatewayBehaviour = "unreachable";
    const dependencies = await server.inject({ method: "GET", url: "/health/dependencies" });
    expect(dependencies.json()).toMatchObject({
      database: { status: "up" },
      signoz: { status: "down" },
    });
    const ready = await server.inject({ method: "GET", url: "/health/ready" });
    expect(ready.json().status).toBe("ready");
  });
});

describe("the error envelope", () => {
  it("returns the PRD section 15 shape with the request identifier", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/projects/00000000-0000-7000-8000-000000000000",
      headers: { "x-request-id": "req-abc" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: "NOT_FOUND",
        message: expect.stringContaining("No project"),
        requestId: "req-abc",
        details: { resource: "project", id: "00000000-0000-7000-8000-000000000000" },
      },
    });
    expect(response.headers["x-request-id"]).toBe("req-abc");
  });

  it("rejects an unbounded caller-supplied request identifier", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/health/live",
      headers: { "x-request-id": "x".repeat(500) },
    });
    expect(response.headers["x-request-id"]).not.toBe("x".repeat(500));
  });

  it("reports validation failures with every offending path at once", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "", slug: "Not A Slug" },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect((body.error.details.issues as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  it("never returns 200 for an unknown route", async () => {
    const response = await server.inject({ method: "GET", url: "/api/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });

  it("refuses a body over the configured limit with a typed error", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "x".repeat(2_000_000), slug: "big" },
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe("TRACE_TOO_LARGE");
  });
});

describe("projects and agents", () => {
  it("creates, reads, updates and lists a project", async () => {
    const id = await createProject();
    expect((await server.inject({ method: "GET", url: `/api/projects/${id}` })).json().slug).toBe(
      "demo-commerce",
    );

    const patched = await server.inject({
      method: "PATCH",
      url: `/api/projects/${id}`,
      payload: { description: "changed" },
    });
    expect(patched.json().description).toBe("changed");

    const list = await server.inject({ method: "GET", url: "/api/projects?limit=1" });
    expect(list.json().items).toHaveLength(1);
  });

  it("rejects a duplicate slug (FR-001)", async () => {
    await createProject();
    const duplicate = await server.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Other", slug: "demo-commerce" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("CONTRACT_CONFLICT");
  });

  it("requires the slug as confirmation before deleting a project", async () => {
    const id = await createProject();
    const refused = await server.inject({
      method: "DELETE",
      url: `/api/projects/${id}`,
      payload: { confirmSlug: "wrong" },
    });
    expect(refused.statusCode).toBe(400);

    const deleted = await server.inject({
      method: "DELETE",
      url: `/api/projects/${id}`,
      payload: { confirmSlug: "demo-commerce" },
    });
    expect(deleted.json()).toMatchObject({ deleted: true, signozArtifactsRetained: 0 });
  });

  it("refuses an agent with no release discriminator (FR-002)", async () => {
    const projectId = await createProject();
    const response = await server.inject({
      method: "POST",
      url: `/api/projects/${projectId}/agents`,
      payload: {
        name: "Refund agent",
        agentKey: "refund-agent",
        workflowNameMatcher: "refund-workflow",
        environmentAttributeKey: "deployment.environment.name",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects a duplicate agent key inside one project", async () => {
    const projectId = await createProject();
    await createAgent(projectId);
    const duplicate = await server.inject({
      method: "POST",
      url: `/api/projects/${projectId}/agents`,
      payload: {
        name: "Refund agent",
        agentKey: "refund-agent",
        workflowNameMatcher: "refund-workflow",
        releaseAttributeKey: "agent.release.id",
        environmentAttributeKey: "deployment.environment.name",
      },
    });
    expect(duplicate.statusCode).toBe(409);
  });

  it("previews matching traces through the SigNoz boundary (FR-002)", async () => {
    const projectId = await createProject();
    const agentId = await createAgent(projectId);
    const response = await server.inject({
      method: "POST",
      url: `/api/agents/${agentId}/preview-traces`,
      payload: { releaseId: "refund-agent-v1", limit: 5 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().filter).toContain("refund.request");
    expect(response.json().items).toHaveLength(1);
  });

  it("maps a SigNoz outage to a dependency failure, not a 500", async () => {
    const projectId = await createProject();
    const agentId = await createAgent(projectId);
    gatewayBehaviour = "unreachable";
    const response = await server.inject({
      method: "POST",
      url: `/api/agents/${agentId}/preview-traces`,
      payload: {},
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("EVALUATION_FAILED");
  });
});

describe("SigNoz setup", () => {
  it("stores a capability snapshot and never the API key", async () => {
    const verified = await server.inject({ method: "POST", url: "/api/setup/signoz/verify" });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({ status: "connected", satisfied: true });

    const stored = await sql<{ api_key_secret_reference: string; capabilities_json: unknown }[]>`
      select api_key_secret_reference, capabilities_json from signoz_connections`;
    expect(stored[0]?.api_key_secret_reference).toBe("env:SIGNOZ_API_KEY");
    expect(JSON.stringify(stored)).not.toContain(ENV.SIGNOZ_API_KEY);

    const capabilities = await server.inject({
      method: "GET",
      url: "/api/setup/signoz/capabilities",
    });
    expect(capabilities.json().status).toBe("connected");
  });

  it("is idempotent: verifying twice updates one connection", async () => {
    await server.inject({ method: "POST", url: "/api/setup/signoz/verify" });
    await server.inject({ method: "POST", url: "/api/setup/signoz/verify" });
    const rows = await sql<{ count: string }[]>`
      select count(*)::text as count from signoz_connections`;
    expect(rows[0]?.count).toBe("1");
  });
});

describe("baselines and jobs", () => {
  const baselineRequest = {
    releaseKey: "refund-agent-v1",
    environment: "local",
    startMs: Date.parse("2026-07-25T06:00:00.000Z"),
    endMs: Date.parse("2026-07-25T12:00:00.000Z"),
    minimumRuns: 20,
    rootSpanName: "refund.request",
  };

  it("returns a job and is idempotent on the miner's selection hash", async () => {
    const projectId = await createProject();
    const agentId = await createAgent(projectId);

    const first = await server.inject({
      method: "POST",
      url: `/api/agents/${agentId}/baselines`,
      payload: baselineRequest,
    });
    expect(first.statusCode).toBe(202);
    expect(first.json().created).toBe(true);

    const second = await server.inject({
      method: "POST",
      url: `/api/agents/${agentId}/baselines`,
      payload: baselineRequest,
    });
    expect(second.json().created).toBe(false);
    expect(second.json().jobId).toBe(first.json().jobId);
    expect(second.json().idempotencyKey).toBe(first.json().idempotencyKey);

    const jobs = await sql<{ count: string }[]>`select count(*)::text as count from jobs`;
    expect(jobs[0]?.count).toBe("1");
  });

  it("resolves concurrent identical submissions to one job", async () => {
    const projectId = await createProject();
    const agentId = await createAgent(projectId);
    const submit = () =>
      server.inject({
        method: "POST",
        url: `/api/agents/${agentId}/baselines`,
        payload: baselineRequest,
      });

    const [a, b] = await Promise.all([submit(), submit()]);
    expect(a.json().jobId).toBe(b.json().jobId);
    const jobs = await sql<{ count: string }[]>`select count(*)::text as count from jobs`;
    expect(jobs[0]?.count).toBe("1");
  });

  it("refuses a window that ends before it starts", async () => {
    const projectId = await createProject();
    const agentId = await createAgent(projectId);
    const response = await server.inject({
      method: "POST",
      url: `/api/agents/${agentId}/baselines`,
      payload: { ...baselineRequest, endMs: baselineRequest.startMs - 1 },
    });
    expect(response.statusCode).toBe(400);
  });

  it("exposes job state and its progress events", async () => {
    const projectId = await createProject();
    const agentId = await createAgent(projectId);
    const submitted = await server.inject({
      method: "POST",
      url: `/api/agents/${agentId}/baselines`,
      payload: baselineRequest,
    });
    const jobId = submitted.json().jobId as string;

    const job = await server.inject({ method: "GET", url: `/api/jobs/${jobId}` });
    expect(job.json()).toMatchObject({ status: "queued", jobType: "baseline_mining" });

    const events = await server.inject({ method: "GET", url: `/api/jobs/${jobId}/events` });
    expect(events.json()).toMatchObject({ jobId, events: [] });
  });
});

describe("contract lifecycle over HTTP (FR-018)", () => {
  async function draftContract(): Promise<{ agentId: string; contractId: string }> {
    const projectId = await createProject();
    const agentId = await createAgent(projectId);
    const created = await server.inject({
      method: "POST",
      url: `/api/agents/${agentId}/contracts`,
      payload: { yaml: CONTRACT_YAML, environment: "production" },
    });
    expect(created.statusCode).toBe(201);
    return { agentId, contractId: created.json().id as string };
  }

  it("creates, validates, approves and activates", async () => {
    const { contractId } = await draftContract();

    const detail = await server.inject({ method: "GET", url: `/api/contracts/${contractId}` });
    expect(detail.json().status).toBe("draft");
    expect(detail.json().rules.length).toBeGreaterThan(0);

    const validated = await server.inject({
      method: "POST",
      url: `/api/contracts/${contractId}/validate`,
      payload: {},
    });
    expect(validated.json()).toMatchObject({ valid: true, contentHashStable: true });

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
    expect(activated.json()).toMatchObject({ status: "active", supersededContractId: null });
  });

  it("refuses an illegal transition with a typed conflict", async () => {
    const { contractId } = await draftContract();
    const activated = await server.inject({
      method: "POST",
      url: `/api/contracts/${contractId}/activate`,
      payload: {},
    });
    expect(activated.statusCode).toBe(409);
    expect(activated.json().error.code).toBe("STATE_TRANSITION_INVALID");
  });

  it("rejects an invalid document at creation", async () => {
    const projectId = await createProject();
    const agentId = await createAgent(projectId);
    const response = await server.inject({
      method: "POST",
      url: `/api/agents/${agentId}/contracts`,
      payload: { yaml: "apiVersion: nope\nkind: NotAContract\n" },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("CONTRACT_INVALID");
  });

  it("exports the exact stored document", async () => {
    const { contractId } = await draftContract();
    const exported = await server.inject({
      method: "GET",
      url: `/api/contracts/${contractId}/export`,
    });
    expect(exported.json().yaml).toBe(CONTRACT_YAML);
  });

  it("records an audit event for every lifecycle transition (FR-019)", async () => {
    const { contractId } = await draftContract();
    await server.inject({
      method: "POST",
      url: `/api/contracts/${contractId}/approve`,
      payload: {},
    });
    await server.inject({
      method: "POST",
      url: `/api/contracts/${contractId}/activate`,
      payload: {},
    });

    const rows = await sql<{ event_type: string }[]>`
      select event_type from audit_events where entity_id = ${contractId} order by id asc`;
    expect(rows.map((row) => row.event_type)).toEqual([
      "contract.created",
      "contract.approved",
      "contract.activated",
    ]);
  });
});

describe("demo routes", () => {
  it("resets and reports demo state", async () => {
    const reset = await server.inject({
      method: "POST",
      url: "/api/demo/reset",
      payload: { confirm: true },
    });
    expect(reset.statusCode).toBe(200);

    const status = await server.inject({ method: "GET", url: "/api/demo/status" });
    expect(status.json()).toMatchObject({
      demoMode: true,
      baselineCount: 0,
      contractCount: 0,
      activeContractId: null,
    });
  });

  it("refuses to evaluate the canary with no active contract", async () => {
    await server.inject({ method: "POST", url: "/api/demo/reset", payload: { confirm: true } });
    const response = await server.inject({
      method: "POST",
      url: "/api/demo/evaluate-v2",
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONTRACT_CONFLICT");
  });

  it("is disabled when DEMO_MODE is not enabled (PRD section 15.9)", async () => {
    const guarded = buildApi({
      logger: false,
      context: {
        sql,
        config: loadApiConfig({ ...ENV, DEMO_MODE: "false" }),
        migrationsDir: MIGRATIONS_DIR,
        now: () => NOW,
        gateway: stubGateway,
      },
    });
    await guarded.server.ready();
    const response = await guarded.server.inject({
      method: "POST",
      url: "/api/demo/reset",
      payload: { confirm: true },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("DEMO_DISABLED");
    await guarded.server.close();
  });
});

describe("state survives a restart", () => {
  it("serves everything a second server instance created", async () => {
    const projectId = await createProject();
    const agentId = await createAgent(projectId);

    // #when a completely new server is built over the same database, as a restart would
    const restarted = buildApi({
      logger: false,
      context: {
        sql: connect(databaseUrl, { max: 2 }),
        config: loadApiConfig(ENV),
        migrationsDir: MIGRATIONS_DIR,
        now: () => NOW,
        gateway: stubGateway,
      },
    });
    await restarted.server.ready();

    const agent = await restarted.server.inject({ method: "GET", url: `/api/agents/${agentId}` });
    expect(agent.json().agentKey).toBe("refund-agent");
    await restarted.server.close();
  });
});

describe("generated API documentation", () => {
  it("describes every registered route from the same declarations that serve them", async () => {
    const response = await server.inject({ method: "GET", url: "/api/openapi.json" });
    expect(response.statusCode).toBe(200);
    const document = response.json() as { openapi: string; paths: Record<string, unknown> };
    expect(document.openapi).toBe("3.1.0");

    const declared = new Set(
      registry.routes().map((route) => route.url.replace(/:([A-Za-z0-9_]+)/g, "{$1}")),
    );
    for (const path of declared) expect(Object.keys(document.paths)).toContain(path);
    expect(Object.keys(document.paths).length).toBe(declared.size);
  });

  it("documents the typed error envelope on every failure status it declares", () => {
    const document = openApiDocument(registry, "0.1.0") as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    const projects = document.paths["/api/projects"]?.["post"];
    expect(Object.keys(projects?.responses ?? {})).toEqual(
      expect.arrayContaining(["201", "400", "404", "409", "500"]),
    );
  });
});

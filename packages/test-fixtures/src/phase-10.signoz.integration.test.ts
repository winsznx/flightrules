import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildApi } from "@flightrules/api/app";
import { loadApiConfig } from "@flightrules/api/config";
import { liveSignozGateway } from "@flightrules/api/signoz";
import {
  ARTIFACT_LABELS,
  managedName,
  projectManagedName,
  REQUIRED_ALERT_LABELS,
  REQUIRED_PANEL_TITLES,
} from "@flightrules/artifact-compiler";
import { connect, MIGRATIONS_DIR, migrateUp, type Sql } from "@flightrules/db";
import {
  isSuccess,
  itemsOf,
  type OperationContext,
  SigNozMcpClient,
  SigNozOperations,
  StreamableToolCaller,
} from "@flightrules/signoz-mcp";
import { LIST_FIELDS, stringField } from "@flightrules/worker/artifact-sync";
import { loadWorkerConfig } from "@flightrules/worker/config";
import { createHandlers } from "@flightrules/worker/handlers";
import { JobRunner } from "@flightrules/worker/runner";
import { liveSignozFactory } from "@flightrules/worker/signoz";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The Phase 10 exit gate against the live stack.
 *
 * Nothing here is a fixture. A real contract is activated through the API, a real worker claims a
 * real `signoz_sync` job, ten resources are created through the pinned MCP server, each is read
 * back by identifier and field-compared, and the register is then driven through every state the
 * PRD requires: a second identical sync, a changed specification, a resource deleted by hand, a
 * resource edited by hand, and a name owned by somebody else.
 *
 * Requires: `make up`, a deployed SigNoz, and a recent demo batch
 * (`DEMO_RUNS=6 make demo-v1 && DEMO_RUNS=6 make demo-v2`).
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

/** A project of its own, so the test never touches the demo's live artefacts. */
const PROJECT_SLUG = "phase10-live";
const AGENT_KEY = "refund-agent";
const SCOPE = { projectSlug: PROJECT_SLUG, agentKey: AGENT_KEY };

const CONTRACT_YAML = readFileSync(
  fileURLToPath(
    new URL(
      "../../../contracts/demo-commerce/refund-agent/production/contract.yaml",
      import.meta.url,
    ),
  ),
  "utf8",
);

const CONTEXT: OperationContext = {
  searchContext: "FlightRules Phase 10 integration test: verify managed SigNoz artefacts",
};

let sql: Sql;
let server: FastifyInstance;
let runner: JobRunner;
let operations: SigNozOperations;
let mcp: SigNozMcpClient;
let projectId = "";
let agentId = "";
let contractId = "";

/** Deletes every resource this test's managed-name prefix owns, whatever produced it. */
async function purgeManagedResources(): Promise<void> {
  const prefix = `FlightRules / ${PROJECT_SLUG} / `;
  type ListCall = () => Promise<Awaited<ReturnType<typeof operations.listViews>>>;

  // The same per-type field map the synchroniser uses. A purge that assumed `id` everywhere would
  // leave every dashboard and alert behind, which is what made an earlier run create duplicates.
  const sweeps: [keyof typeof LIST_FIELDS, ListCall, (id: string) => Promise<unknown>][] = [
    [
      "alert",
      () => operations.listAlertRules(CONTEXT),
      (id) => operations.deleteAlert(id, CONTEXT),
    ],
    [
      "dashboard",
      () => operations.listDashboards(CONTEXT),
      (id) => operations.deleteDashboard(id, CONTEXT),
    ],
    [
      "saved_view",
      () => operations.listViews("traces", CONTEXT),
      (id) => operations.deleteView(id, CONTEXT),
    ],
    [
      "notification_channel",
      () => operations.listNotificationChannels(CONTEXT),
      (id) => operations.deleteNotificationChannel(id, CONTEXT),
    ],
  ];

  for (const [type, list, remove] of sweeps) {
    const fields = LIST_FIELDS[type];
    const result = await list();
    if (!isSuccess(result) || result.outcome !== "SUCCESS_WITH_ROWS") continue;
    for (const item of itemsOf(result.value)) {
      const name = stringField(item, fields.name);
      const id = stringField(item, fields.id);
      if (name?.startsWith(prefix) === true && id !== undefined) await remove(id);
    }
  }
}

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
      now: () => new Date(),
      gateway: () => liveSignozGateway(apiConfig),
    },
  });
  server = built.server;
  await server.ready();

  const workerConfig = loadWorkerConfig({ ...ENV, WORKER_ID: "phase-10-live" });
  runner = new JobRunner({
    sql,
    config: workerConfig,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    handlers: createHandlers({ signoz: liveSignozFactory(workerConfig) }),
  });

  mcp = new SigNozMcpClient({
    caller: new StreamableToolCaller({
      url: ENV["SIGNOZ_MCP_URL"] as string,
      apiKey: signozApiKey,
      clientName: "flightrules-phase-10-test",
    }),
    timeoutMs: 30_000,
  });
  operations = new SigNozOperations(mcp);
  await purgeManagedResources();

  const project = await server.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name: "Phase 10 Live", slug: PROJECT_SLUG, defaultEnvironment: "production" },
  });
  expect(project.statusCode).toBe(201);
  projectId = project.json().id as string;

  const agent = await server.inject({
    method: "POST",
    url: `/api/projects/${projectId}/agents`,
    payload: {
      name: "Refund Agent",
      agentKey: AGENT_KEY,
      workflowNameMatcher: "refund-workflow",
      rootSpanMatcher: { name: "refund.request" },
      serviceMatchers: ["flightrules-demo-agent"],
      releaseAttributeKey: "agent.release.id",
      environmentAttributeKey: "deployment.environment.name",
    },
  });
  expect(agent.statusCode).toBe(201);
  agentId = agent.json().id as string;

  const contract = await server.inject({
    method: "POST",
    url: `/api/agents/${agentId}/contracts`,
    payload: { yaml: CONTRACT_YAML, environment: "production" },
  });
  expect(contract.statusCode).toBe(201);
  contractId = contract.json().id as string;

  expect(
    (await server.inject({ method: "POST", url: `/api/contracts/${contractId}/approve` }))
      .statusCode,
  ).toBe(200);
  expect(
    (await server.inject({ method: "POST", url: `/api/contracts/${contractId}/activate` }))
      .statusCode,
  ).toBe(200);
}, 180_000);

afterAll(async () => {
  await purgeManagedResources().catch(() => {});
  await mcp?.close().catch(() => {});
  await server?.close();
  await sql?.end({ timeout: 5 });
});

async function drain(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await runner.runOnce()).claimed) return;
  }
  throw new Error("the queue did not drain");
}

/** Submits a sync and runs it, returning the stored job result. */
async function sync(): Promise<Record<string, unknown>> {
  const response = await server.inject({
    method: "POST",
    url: `/api/contracts/${contractId}/sync-signoz`,
    payload: {},
  });
  expect(response.statusCode).toBe(202);
  const jobId = response.json().jobId as string;
  await drain();
  const job = await server.inject({ method: "GET", url: `/api/jobs/${jobId}` });
  expect(job.statusCode).toBe(200);
  const body = job.json() as Record<string, unknown>;
  if (body["status"] !== "succeeded") {
    const rows = await sql<{ managed_name: string; status: string; verification_json: unknown }[]>`
      select managed_name, status, verification_json from signoz_artifacts where status <> 'synced'`;
    throw new Error(
      `sync job ${body["status"]}: ${JSON.stringify(body["error"])} :: ${JSON.stringify(rows)}`,
    );
  }
  return body;
}

/**
 * Forces a fresh sync job for an unchanged contract.
 *
 * The API is idempotent on the contract's content hash, which is correct — a repeated POST returns
 * the job that already ran. Proving the *worker's* idempotency needs a second job to actually run,
 * so the completed job's idempotency key is retired first. This exercises the register's
 * `spec_hash`, not an in-memory cache.
 */
let retirementCounter = 0;

async function resync(): Promise<Record<string, unknown>> {
  retirementCounter += 1;
  const suffix = `-retired-${retirementCounter}`;
  await sql`
    update jobs set idempotency_key = idempotency_key || ${suffix}
    where job_type = 'signoz_sync'`;
  return sync();
}

async function registerRows(): Promise<
  { managedName: string; status: string; lastOperation: string; specHash: string }[]
> {
  const response = await server.inject({
    method: "GET",
    url: `/api/setup/signoz/artifacts?projectId=${projectId}`,
  });
  expect(response.statusCode).toBe(200);
  return response.json().items as {
    managedName: string;
    status: string;
    lastOperation: string;
    specHash: string;
  }[];
}

describe("the Phase 10 exit gate against the live stack", () => {
  it("creates and verifies every required artefact on the first sync", async () => {
    const job = await sync();
    expect(job["status"]).toBe("succeeded");
    const result = job["result"] as Record<string, unknown>;
    expect(result["created"]).toBe(10);
    expect(result["updated"]).toBe(0);
    expect(result["unchanged"]).toBe(0);
    expect(result["conflicts"]).toBe(0);

    const artifacts = result["artifacts"] as { managedName: string; status: string }[];
    const names = artifacts.map((a) => a.managedName);
    expect(names).toContain(projectManagedName(PROJECT_SLUG, ARTIFACT_LABELS.notifications));
    for (const label of [
      ARTIFACT_LABELS.violatingRuns,
      ARTIFACT_LABELS.duplicateSideEffects,
      ARTIFACT_LABELS.unknownRoutes,
      ARTIFACT_LABELS.releaseComparison,
      ARTIFACT_LABELS.contractHealth,
      ...REQUIRED_ALERT_LABELS,
    ]) {
      expect(names).toContain(managedName(SCOPE, label));
    }
    for (const artifact of artifacts) expect(artifact.status).toBe("synced");
  }, 180_000);

  it("classifies the notification channel honestly rather than claiming delivery", async () => {
    const rows = await registerRows();
    const channel = rows.find((row) => row.managedName.endsWith("Notifications"));
    expect(channel?.status).toBe("synced");
    // The server sends a real test notification on creation. Its outcome is recorded verbatim; a
    // loopback destination that nothing is listening on is never reported as verified delivery.
    const job = await sql<{ result_json: { channel?: Record<string, unknown> } }[]>`
      select result_json from jobs where job_type = 'signoz_sync' and status = 'succeeded'
      order by created_at desc limit 1`;
    const reported = job[0]?.result_json.channel;
    expect(reported?.["deliveryTested"]).toBe(true);
    expect(typeof reported?.["deliveryVerified"]).toBe("boolean");
    expect(String(reported?.["redactedUrl"])).not.toContain("/internal/");
  });

  it("persists a resource identifier, a spec hash and a verification for every artefact", async () => {
    const rows = await registerRows();
    expect(rows).toHaveLength(10);
    const response = await server.inject({
      method: "GET",
      url: `/api/setup/signoz/artifacts?projectId=${projectId}`,
    });
    for (const item of response.json().items as Record<string, unknown>[]) {
      expect(item["signozResourceId"]).toBeTruthy();
      expect(String(item["specHash"])).toMatch(/^[0-9a-f]{64}$/);
      expect(item["lastVerifiedAt"]).toBeTruthy();
      expect((item["verification"] as { status: string }).status).toBe("verified");
      expect(item["contractId"]).toBe(contractId);
    }
    expect(response.json().summary).toMatchObject({ total: 10, synced: 10, failed: 0 });
  });

  it("returns the same job for a repeated identical request", async () => {
    const first = await server.inject({
      method: "POST",
      url: `/api/contracts/${contractId}/sync-signoz`,
      payload: {},
    });
    const second = await server.inject({
      method: "POST",
      url: `/api/contracts/${contractId}/sync-signoz`,
      payload: {},
    });
    expect(first.json().jobId).toBe(second.json().jobId);
    expect(second.json().created).toBe(false);
  });

  it("creates none and updates none on a second identical sync", async () => {
    const result = (await resync())["result"] as Record<string, unknown>;
    expect(result["created"]).toBe(0);
    expect(result["updated"]).toBe(0);
    expect(result["unchanged"]).toBe(10);
    expect(result["conflicts"]).toBe(0);
  }, 180_000);

  it("does not create a duplicate resource in SigNoz", async () => {
    const views = await operations.listViews("traces", CONTEXT);
    expect(isSuccess(views)).toBe(true);
    if (!isSuccess(views) || views.outcome !== "SUCCESS_WITH_ROWS") throw new Error("no views");
    const managed = itemsOf(views.value)
      .map((item) => (item as { name?: string }).name ?? "")
      .filter((name) => name.startsWith(`FlightRules / ${PROJECT_SLUG} / `));
    expect(managed).toHaveLength(4);
    expect(new Set(managed).size).toBe(4);
  });

  it("recreates a resource that was deleted in SigNoz by hand", async () => {
    const target = managedName(SCOPE, ARTIFACT_LABELS.unknownRoutes);
    const stored = await sql<{ signoz_resource_id: string }[]>`
      select signoz_resource_id from signoz_artifacts where managed_name = ${target}`;
    const removed = stored[0]?.signoz_resource_id;
    expect(removed).toBeTruthy();
    await operations.deleteView(removed as string, CONTEXT);

    const result = (await resync())["result"] as Record<string, unknown>;
    expect(result["created"]).toBe(1);
    expect(result["unchanged"]).toBe(9);

    const after = await sql<{ signoz_resource_id: string; status: string }[]>`
      select signoz_resource_id, status from signoz_artifacts where managed_name = ${target}`;
    expect(after[0]?.status).toBe("synced");
    expect(after[0]?.signoz_resource_id).not.toBe(removed);
  }, 180_000);

  it("restores a resource that was edited in SigNoz by hand", async () => {
    const target = managedName(SCOPE, ARTIFACT_LABELS.violatingRuns);
    const stored = await sql<{ signoz_resource_id: string }[]>`
      select signoz_resource_id from signoz_artifacts where managed_name = ${target}`;
    const id = stored[0]?.signoz_resource_id as string;

    // A hand edit, expressed through supported operations only. `signoz_update_view` cannot be
    // used even to *simulate* one: on the pinned server it corrupts the stored query and takes
    // every saved view in the tenant down with it (SL-057), so the edit is a delete followed by a
    // create of the same name with a different query — which is what the operator's edit leaves
    // behind as far as FlightRules can observe.
    await operations.deleteView(id, CONTEXT);
    const tampered = await operations.createView(
      {
        name: target,
        sourcePage: "traces",
        category: "hand edited",
        tags: [],
        compositeQuery: {
          queryType: "builder",
          panelType: "list",
          queries: [
            {
              type: "builder_query",
              spec: {
                name: "A",
                signal: "traces",
                source: "",
                stepInterval: 0,
                limit: 100,
                offset: 0,
                order: [{ key: { name: "timestamp" }, direction: "desc" }],
                filter: { expression: "name = 'tampered'" },
                having: { expression: "" },
                selectFields: [
                  {
                    name: "trace_id",
                    fieldContext: "span",
                    fieldDataType: "string",
                    signal: "traces",
                  },
                ],
                disabled: false,
              },
            },
          ],
        },
      },
      CONTEXT,
    );
    expect(isSuccess(tampered) && tampered.outcome === "SUCCESS_WITH_ROWS").toBe(true);

    // The register still points at the deleted resource, so the drift is visible without asking
    // SigNoz whether the *content* changed: the identifier it recorded is gone.
    const result = (await resync())["result"] as Record<string, unknown>;
    expect(Number(result["created"]) + Number(result["updated"])).toBeGreaterThanOrEqual(1);

    const after = await sql<{ signoz_resource_id: string; status: string }[]>`
      select signoz_resource_id, status from signoz_artifacts where managed_name = ${target}`;
    expect(after[0]?.status).toBe("synced");

    const restored = await operations.getView(after[0]?.signoz_resource_id as string, CONTEXT);
    if (!isSuccess(restored) || restored.outcome !== "SUCCESS_WITH_ROWS") {
      throw new Error("could not read the restored view back");
    }
    const expression = (
      restored.value.data as {
        compositeQuery: { queries: { spec: { filter: { expression: string } } }[] };
      }
    ).compositeQuery.queries[0]?.spec.filter.expression;
    expect(expression).not.toBe("name = 'tampered'");
    expect(expression).toContain("flight_rules.violation.count");
  }, 180_000);

  it("refuses to overwrite a resource of the same name it does not own", async () => {
    const target = managedName(SCOPE, ARTIFACT_LABELS.releaseComparison);
    // Somebody else's resource: the register is cleared for this name while SigNoz keeps it.
    await sql`delete from signoz_artifacts where managed_name = ${target}`;

    const result = (await resync())["result"] as Record<string, unknown>;
    expect(result["conflicts"]).toBe(1);

    const rows = await registerRows();
    const conflicted = rows.find((row) => row.managedName === target);
    expect(conflicted?.status).toBe("conflict");
    expect(conflicted?.lastOperation).toBe("conflict");

    // The unowned resource was left exactly as it was.
    const views = await operations.listViews("traces", CONTEXT);
    if (!isSuccess(views) || views.outcome !== "SUCCESS_WITH_ROWS") throw new Error("no views");
    const matching = itemsOf(views.value).filter(
      (item) => (item as { name?: string }).name === target,
    );
    expect(matching).toHaveLength(1);
  }, 180_000);

  it("reports a superseded artefact as stale rather than deleting it silently", async () => {
    await sql`
      insert into signoz_artifacts (
        project_id, agent_id, artifact_type, managed_name, signoz_resource_id, spec_hash, status
      ) values (
        ${projectId}, ${agentId}, 'saved_view',
        ${`FlightRules / ${PROJECT_SLUG} / ${AGENT_KEY} / Retired View`},
        'retired-id', ${"a".repeat(64)}, 'synced'
      )`;
    const result = (await resync())["result"] as Record<string, unknown>;
    expect(result["stale"]).toContain(
      `FlightRules / ${PROJECT_SLUG} / ${AGENT_KEY} / Retired View`,
    );
  }, 180_000);

  it("refuses to compile a contract that is not approved or active", async () => {
    const draft = await server.inject({
      method: "POST",
      url: `/api/agents/${agentId}/contracts`,
      payload: {
        yaml: CONTRACT_YAML.replace("version: 1.0.0", "version: 1.0.1"),
        environment: "staging",
      },
    });
    expect(draft.statusCode).toBe(201);
    const response = await server.inject({
      method: "POST",
      url: `/api/contracts/${draft.json().id}/sync-signoz`,
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("STATE_TRANSITION_INVALID");
  });

  it("returns a typed error for an unknown contract", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/contracts/019f0000-0000-7000-8000-000000000000/sync-signoz",
      payload: {},
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });

  it("queues one job per agent holding an active contract from the project route", async () => {
    retirementCounter += 1;
    const suffix = `-retired-${retirementCounter}`;
    await sql`
      update jobs set idempotency_key = idempotency_key || ${suffix}
      where job_type = 'signoz_sync'`;
    const response = await server.inject({
      method: "POST",
      url: "/api/setup/signoz/sync-artifacts",
      payload: { projectId },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().jobs).toHaveLength(1);
    expect(response.json().jobs[0].agentId).toBe(agentId);
    await drain();
  }, 180_000);

  it("exposes no raw MCP payload through the API", async () => {
    const response = await server.inject({
      method: "GET",
      url: `/api/setup/signoz/artifacts?projectId=${projectId}`,
    });
    const body = response.body;
    expect(body).not.toContain("searchContext");
    expect(body).not.toContain("structuredContent");
    expect(body).not.toContain(signozApiKey);
  });

  it("survives an application restart", async () => {
    const before = await registerRows();
    await server.close();
    const apiConfig = loadApiConfig(ENV);
    const rebuilt = buildApi({
      logger: false,
      context: {
        sql,
        config: apiConfig,
        migrationsDir: MIGRATIONS_DIR,
        now: () => new Date(),
        gateway: () => liveSignozGateway(apiConfig),
      },
    });
    server = rebuilt.server;
    await server.ready();
    const after = await registerRows();
    expect(after.map((row) => row.managedName).sort()).toEqual(
      before.map((row) => row.managedName).sort(),
    );
    expect(after.every((row) => row.specHash.length === 64)).toBe(true);
  }, 120_000);

  it("holds a dashboard whose panels are the ones the PRD requires", async () => {
    const stored = await sql<{ signoz_resource_id: string }[]>`
      select signoz_resource_id from signoz_artifacts where artifact_type = 'dashboard'`;
    const id = stored[0]?.signoz_resource_id as string;
    const fetched = await operations.getDashboard(id, CONTEXT);
    if (!isSuccess(fetched) || fetched.outcome !== "SUCCESS_WITH_ROWS") {
      throw new Error("could not read the dashboard back");
    }
    const body = (fetched.value.data as { data: { widgets: { title: string }[] } }).data;
    expect(body.widgets.map((widget) => widget.title)).toEqual(REQUIRED_PANEL_TITLES);
  }, 120_000);

  it("holds alerts whose thresholds and queries survived the round trip", async () => {
    const stored = await sql<{ managed_name: string; signoz_resource_id: string }[]>`
      select managed_name, signoz_resource_id from signoz_artifacts
      where artifact_type = 'alert' order by managed_name`;
    expect(stored).toHaveLength(4);
    for (const row of stored) {
      const fetched = await operations.getAlert(row.signoz_resource_id, CONTEXT);
      if (!isSuccess(fetched) || fetched.outcome !== "SUCCESS_WITH_ROWS") {
        throw new Error(`could not read ${row.managed_name} back`);
      }
      const alert = fetched.value.data as Record<string, unknown>;
      expect(alert["alert"]).toBe(row.managed_name);
      expect(alert["state"]).toBeDefined();
    }
  }, 120_000);

  it("reports a missing tool as a capability failure rather than hiding it", async () => {
    const snapshot = await mcp.discoverCapabilities();
    expect(snapshot.satisfied).toBe(true);
    expect(snapshot.requiredMissing).toEqual([]);
    expect(snapshot.toolNames).toContain("signoz_update_view");
    expect(snapshot.toolNames).toContain("signoz_update_dashboard");
    expect(snapshot.toolNames).toContain("signoz_update_alert");
    expect(snapshot.toolNames).toContain("signoz_create_notification_channel");
  });
});

/** Kept out of the describe block so an accidental identifier reuse is a compile error. */
export const PHASE_10_MANAGED_NAMES = [
  projectManagedName(PROJECT_SLUG, ARTIFACT_LABELS.notifications),
  ...[
    ARTIFACT_LABELS.violatingRuns,
    ARTIFACT_LABELS.duplicateSideEffects,
    ARTIFACT_LABELS.unknownRoutes,
    ARTIFACT_LABELS.releaseComparison,
    ARTIFACT_LABELS.contractHealth,
    ...REQUIRED_ALERT_LABELS,
  ].map((label) => managedName(SCOPE, label)),
];

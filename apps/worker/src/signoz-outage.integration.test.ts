import { discoverRuns, fetchTraces, type MiningSelection } from "@flightrules/baseline-miner";
import {
  artifactSyncLockKey,
  connect,
  createAgent,
  createProject,
  listArtifacts,
  MIGRATIONS_DIR,
  migrateUp,
  type Sql,
  withAdvisoryLock,
} from "@flightrules/db";
import { SigNozMcpClient, SigNozOperations, silentLogger } from "@flightrules/signoz-mcp";
import { FakeSigNoz } from "@flightrules/signoz-mcp/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ArtifactSynchroniser,
  type ArtifactSyncInput,
  type ArtifactSyncResult,
  persistArtifactWrites,
  readRegisteredArtifacts,
  synchroniseArtifacts,
} from "./artifact-sync.js";

/**
 * SigNoz going away, and coming back (PRD Phase 16 task 9).
 *
 * A dependency outage is only dangerous when it is invisible. Every case here interrupts SigNoz at a
 * different instruction and asserts the same three things: the failure is reported, nothing already
 * proven is destroyed, and nothing unproven is recorded as proven.
 *
 * The instants that matter cannot be staged against a live deployment — "the create landed and the
 * response did not" is not something a running server can be asked to do on cue — so the transport
 * is a fake and everything above it is the product's own code, including the real client's retry
 * policy and circuit breaker.
 *
 * The complementary evidence is live: `make signoz-verify` and the `*.signoz.integration.test.ts`
 * suites run against the pinned server, and the runbook's recovery procedure is exercised by
 * stopping and restarting the container.
 */

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  throw new Error("DATABASE_URL must be set for database integration tests. Run `make up` first.");
}

const PROJECT_SLUG = "outage-project";
const AGENT_KEY = "outage-agent";
const DASHBOARD_NAME = `FlightRules / ${PROJECT_SLUG} / ${AGENT_KEY} / Contract Health`;
const CONTEXT = { searchContext: "FlightRules Phase 16: SigNoz outage behaviour" };

let sql: Sql;
let projectId: string;
let agentId: string;
let contractId: string;

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
  await sql`truncate signoz_artifacts, agents, projects restart identity cascade`;
  const project = await createProject(sql, {
    name: "Outage Project",
    slug: PROJECT_SLUG,
    defaultEnvironment: "production",
  });
  projectId = project.id;
  const agent = await createAgent(sql, {
    projectId,
    agentKey: AGENT_KEY,
    name: "Outage Agent",
    workflowNameMatcher: "refund-workflow",
    releaseAttributeKey: "agent.release.id",
    environmentAttributeKey: "deployment.environment.name",
  });
  agentId = agent.id;
  const contract = await sql<{ id: string }[]>`
    insert into contracts (
      agent_id, baseline_version_id, name, contract_key, semantic_version, schema_version,
      environment, status, source, yaml_text, canonical_json, content_hash, job_id
    ) values (
      ${agentId}, null, 'Outage contract', 'outage-agent-production', '1.0.0',
      'flightrules.dev/v1alpha1', 'production', 'draft', 'mined', 'apiVersion: x',
      '{}'::jsonb, ${"b".repeat(64)}, null
    ) returning id`;
  contractId = contract[0]?.id ?? "";
});

function operationsOver(fake: FakeSigNoz): SigNozOperations {
  return new SigNozOperations(
    new SigNozMcpClient({
      caller: fake,
      logger: silentLogger,
      retry: { maxAttempts: 1 },
      sleep: async () => {},
    }),
  );
}

function inputFor(overrides: Partial<ArtifactSyncInput> = {}): ArtifactSyncInput {
  return {
    projectId,
    agentId,
    contractId,
    projectSlug: PROJECT_SLUG,
    agentKey: AGENT_KEY,
    contractVersion: "1.0.0",
    rootSpanName: "refund.request",
    violationThreshold: 0,
    webhookUrl: "http://host.docker.internal:4000/internal/alert-sink",
    signozBaseUrl: "http://localhost:8080",
    attempt: 1,
    ...overrides,
  };
}

async function sync(
  fake: FakeSigNoz,
  overrides: Partial<ArtifactSyncInput> = {},
): Promise<ArtifactSyncResult> {
  return withAdvisoryLock(sql, artifactSyncLockKey(agentId), async () => {
    const registered = await readRegisteredArtifacts(sql, projectId);
    const { result, writes } = await synchroniseArtifacts(inputFor(overrides), registered, {
      synchroniser: new ArtifactSynchroniser(operationsOver(fake)),
      now: () => new Date("2026-07-26T00:00:00.000Z"),
    });
    await sql.begin((tx) => persistArtifactWrites(tx, writes));
    return result;
  });
}

/* -------------------------------------------------------------------------- */
/* Outage before anything happens                                             */
/* -------------------------------------------------------------------------- */

describe("SigNoz unreachable from the first call", () => {
  it("reports failure and records nothing as synced", async () => {
    const fake = new FakeSigNoz({ faults: [{ tool: "signoz_", mode: "transport" }] });

    await expect(sync(fake)).rejects.toThrow();

    expect(await listArtifacts(sql, projectId)).toHaveLength(0);
    expect(fake.allResources()).toHaveLength(0);
  });

  it("reports failure when MCP answers with a declared tool error", async () => {
    const fake = new FakeSigNoz({ faults: [{ tool: "signoz_list", mode: "error" }] });

    await expect(sync(fake)).rejects.toThrow();
    expect(fake.allResources()).toHaveLength(0);
  });

  it("never reports success from a list that returned an HTML page", async () => {
    // SL-012: an unmatched SigNoz path answers with the single-page application and status 200.
    const fake = new FakeSigNoz({ faults: [{ tool: "signoz_list", mode: "html" }] });

    await expect(sync(fake)).rejects.toThrow();
    expect(await listArtifacts(sql, projectId)).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Outage part-way through a sync                                             */
/* -------------------------------------------------------------------------- */

describe("SigNoz failing part-way through a sync", () => {
  it("marks the artefact it could not verify as failed, not synced", async () => {
    // #given a read-back that fails after the resource was created
    const fake = new FakeSigNoz({ faults: [{ tool: "signoz_get_dashboard", mode: "transport" }] });

    const result = await sync(fake);

    expect(result.failed).toBeGreaterThan(0);
    const row = (await listArtifacts(sql, projectId)).find(
      (entry) => entry.managedName === DASHBOARD_NAME,
    );
    expect(row?.status).not.toBe("synced");
  });

  it("keeps the artefacts it did verify before the outage began", async () => {
    // #given the channel and the views succeed and the alerts do not
    const fake = new FakeSigNoz({ faults: [{ tool: "signoz_create_alert", mode: "transport" }] });

    const result = await sync(fake);

    expect(result.failed).toBeGreaterThan(0);
    const rows = await listArtifacts(sql, projectId);
    const synced = rows.filter((row) => row.status === "synced");
    expect(synced.length).toBeGreaterThan(0);
    expect(synced.every((row) => row.artifactType !== "alert")).toBe(true);
  });

  it("does not erase a previously verified artefact when a later sync fails", async () => {
    // #given a sync that fully succeeded
    const fake = new FakeSigNoz();
    await sync(fake);
    const before = await listArtifacts(sql, projectId);
    expect(before.filter((row) => row.status === "synced")).toHaveLength(10);

    // #when SigNoz goes away and a second sync is attempted
    fake.injectFault({ tool: "signoz_list", mode: "transport" });
    await expect(sync(fake)).rejects.toThrow();

    // #then the register still holds every verified artefact and its identifier
    const after = await listArtifacts(sql, projectId);
    expect(after.filter((row) => row.status === "synced")).toHaveLength(10);
    for (const row of after) {
      expect(row.signozResourceId).not.toBeNull();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Recovery                                                                   */
/* -------------------------------------------------------------------------- */

describe("recovery", () => {
  it("completes the sync once SigNoz answers again", async () => {
    const fake = new FakeSigNoz({
      faults: [{ tool: "signoz_create_alert", mode: "transport", times: 4 }],
    });

    const during = await sync(fake);
    expect(during.failed).toBeGreaterThan(0);

    fake.clearFaults();
    const after = await sync(fake);

    expect(after.failed).toBe(0);
    const rows = await listArtifacts(sql, projectId);
    expect(rows.filter((row) => row.status === "synced")).toHaveLength(10);
  });

  it("is idempotent across the outage: no duplicate survives it", async () => {
    const fake = new FakeSigNoz({
      faults: [{ tool: "signoz_get_dashboard", mode: "transport", times: 1 }],
    });

    await sync(fake);
    fake.clearFaults();
    await sync(fake);
    await sync(fake);

    const names = fake.allResources().map((resource) => resource.name);
    expect(new Set(names).size).toBe(names.length);
    expect(fake.allResources()).toHaveLength(10);
  });

  it("reaches a fully unchanged sync once everything is verified", async () => {
    const fake = new FakeSigNoz({
      faults: [{ tool: "signoz_create_alert", mode: "error", times: 4 }],
    });
    await sync(fake);
    fake.clearFaults();
    await sync(fake);

    const settled = await sync(fake);
    expect(settled.unchanged).toBe(10);
    expect(settled.created).toBe(0);
    expect(settled.failed).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Outage during trace retrieval                                              */
/* -------------------------------------------------------------------------- */

describe("an outage during trace retrieval", () => {
  const SELECTION: MiningSelection = {
    releaseId: "refund-agent-v1",
    rootSpanName: "refund.request",
    environment: "production",
    startMs: 1_700_000_000_000,
    endMs: 1_700_003_600_000,
    maxTraces: 6,
    batchSize: 3,
    maxSpansPerTrace: 100,
  };

  function rows(count: number): readonly Record<string, unknown>[] {
    return Array.from({ length: count }, (_unused, index) => ({
      trace_id: `abcdef${String(index).padStart(26, "0")}`,
      timestamp: new Date(SELECTION.startMs + index).toISOString(),
    }));
  }

  it("returns a discovery failure rather than a short dataset", async () => {
    // #given the first page succeeds and the second does not
    const fake = new FakeSigNoz({
      rows: rows(6),
      faults: [{ tool: "signoz_execute_builder_query", mode: "transport", fromCall: 2 }],
    });

    const discovered = await discoverRuns(operationsOver(fake), SELECTION, CONTEXT);

    // #then the caller is told discovery failed. A truncated set returned as `ok` would become a
    // baseline mined from half the runs — and nothing downstream could tell.
    expect(discovered.ok).toBe(false);
    if (!discovered.ok) expect(discovered.error.code).toBe("DISCOVERY_FAILED");
  });

  it("returns a discovery failure when the very first page fails", async () => {
    const fake = new FakeSigNoz({
      rows: rows(6),
      faults: [{ tool: "signoz_execute_builder_query", mode: "error" }],
    });

    const discovered = await discoverRuns(operationsOver(fake), SELECTION, CONTEXT);
    expect(discovered.ok).toBe(false);
  });

  it("does not mistake an HTML page for an empty result set", async () => {
    const fake = new FakeSigNoz({
      rows: rows(6),
      faults: [{ tool: "signoz_execute_builder_query", mode: "html" }],
    });

    const discovered = await discoverRuns(operationsOver(fake), SELECTION, CONTEXT);
    expect(discovered.ok).toBe(false);
  });

  it("reports each trace it could not fetch rather than dropping it", async () => {
    const fake = new FakeSigNoz({
      rows: rows(3),
      faults: [{ tool: "signoz_execute_builder_query", mode: "transport", fromCall: 2 }],
    });

    const fetched = await fetchTraces(
      operationsOver(fake),
      ["aaaaaaaa", "bbbbbbbb", "cccccccc"],
      SELECTION,
      CONTEXT,
    );

    expect(fetched.traces.length + fetched.failures.length).toBe(3);
    expect(fetched.failures.length).toBeGreaterThan(0);
    expect(fetched.failures.every((failure) => failure.code === "TRACE_FETCH_FAILED")).toBe(true);
  });

  it("succeeds cleanly once retrieval recovers", async () => {
    const fake = new FakeSigNoz({ rows: rows(6) });

    const discovered = await discoverRuns(operationsOver(fake), SELECTION, CONTEXT);

    expect(discovered.ok).toBe(true);
    if (discovered.ok) {
      expect(discovered.dataset.traceIds).toHaveLength(6);
      expect(discovered.dataset.pages).toBeGreaterThan(1);
    }
  });
});

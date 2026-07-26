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
 * Duplicate artefact creation, ownership and reconciliation (PRD Phase 16 task 7).
 *
 * The register and SigNoz are two stores that can disagree, and every way they can disagree ends in
 * one of two failures: FlightRules creates a second copy of a resource it already owns, or it
 * overwrites a resource somebody else created. Both are silent — the sync reports success either
 * way — so each disagreement is staged here deliberately rather than waited for.
 *
 * The database is real. The MCP transport is a fake, because the interesting instants are the ones
 * between a write and its read-back, and those cannot be staged against a live SigNoz without
 * breaking it for everything else that uses it. Everything above the socket is the product's own
 * code: the real client with its retries and breaker, the real operations, the real synchroniser,
 * the real plan and the real register.
 *
 * The live double-sync remains proven separately, by `make signoz-sync` and by
 * `packages/test-fixtures/src/phase-10.signoz.integration.test.ts` against the pinned server.
 */

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  throw new Error("DATABASE_URL must be set for database integration tests. Run `make up` first.");
}

const PROJECT_SLUG = "race-project";
const AGENT_KEY = "race-agent";
const CHANNEL_NAME = `FlightRules / ${PROJECT_SLUG} / Notifications`;
const DASHBOARD_NAME = `FlightRules / ${PROJECT_SLUG} / ${AGENT_KEY} / Contract Health`;
const VIEW_NAME = `FlightRules / ${PROJECT_SLUG} / ${AGENT_KEY} / Violating Runs`;

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
    name: "Race Project",
    slug: PROJECT_SLUG,
    defaultEnvironment: "production",
  });
  projectId = project.id;
  const agent = await createAgent(sql, {
    projectId,
    agentKey: AGENT_KEY,
    name: "Race Agent",
    workflowNameMatcher: "refund-workflow",
    releaseAttributeKey: "agent.release.id",
    environmentAttributeKey: "deployment.environment.name",
  });
  agentId = agent.id;

  // The register's `contract_id` is a foreign key, so a real row has to exist. Only the identity
  // matters here; the contract's content is compiled from `ArtifactSyncInput`, not read back.
  const contract = await sql<{ id: string }[]>`
    insert into contracts (
      agent_id, baseline_version_id, name, contract_key, semantic_version, schema_version,
      environment, status, source, yaml_text, canonical_json, content_hash, job_id
    ) values (
      ${agentId}, null, 'Race contract', 'race-agent-production', '1.0.0',
      'flightrules.dev/v1alpha1', 'production', 'draft', 'mined', 'apiVersion: x',
      '{}'::jsonb, ${"a".repeat(64)}, null
    ) returning id`;
  contractId = contract[0]?.id ?? "";
});

function operationsOver(fake: FakeSigNoz): SigNozOperations {
  return new SigNozOperations(
    new SigNozMcpClient({
      caller: fake,
      logger: silentLogger,
      // One attempt, so a scripted fault is the outcome rather than something the retry policy
      // papers over. Retry behaviour has its own coverage in `client.test.ts`.
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

/**
 * One sync, exactly as `signozSyncHandler` runs it: take the per-agent lock, read the register,
 * sync, persist the writes.
 *
 * The lock is part of the sequence under test rather than an incidental detail — it is what stops
 * two concurrent syncs of one agent each deleting a saved view and creating another.
 */
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

/** Every managed name SigNoz holds more than once. Empty is the property the whole task is about. */
function duplicateNames(fake: FakeSigNoz): readonly string[] {
  const counts = new Map<string, number>();
  for (const resource of fake.allResources()) {
    counts.set(resource.name, (counts.get(resource.name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort();
}

/* -------------------------------------------------------------------------- */
/* Repeated and concurrent syncs                                              */
/* -------------------------------------------------------------------------- */

describe("syncing the same contract more than once", () => {
  it("creates ten artefacts the first time and none the second", async () => {
    const fake = new FakeSigNoz();

    const first = await sync(fake);
    expect(first.created).toBe(10);
    expect(first.conflicts).toBe(0);
    expect(first.failed).toBe(0);

    const second = await sync(fake);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(10);
    expect(duplicateNames(fake)).toEqual([]);
    expect(fake.allResources()).toHaveLength(10);
  });

  it("creates no duplicate when two syncs run concurrently over one register", async () => {
    // #given two API processes or two workers reaching the same contract at the same moment
    const fake = new FakeSigNoz();

    // #when both run against the same register and the same SigNoz
    const [a, b] = await Promise.all([sync(fake), sync(fake)]);

    // #then between them they created ten resources and no name exists twice. Each sync reports
    // what it did rather than what it wished had happened.
    expect(a.created + b.created).toBeGreaterThanOrEqual(10);
    expect(duplicateNames(fake)).toEqual([]);
    expect(fake.countNamed(DASHBOARD_NAME)).toBe(1);
    expect(fake.countNamed(CHANNEL_NAME)).toBe(1);

    const registered = await listArtifacts(sql, projectId);
    expect(registered).toHaveLength(10);
  });

  it("reconciles the register with SigNoz after a concurrent pair", async () => {
    const fake = new FakeSigNoz();
    await Promise.all([sync(fake), sync(fake)]);

    // A third, quiet sync must find everything already correct — that is what reconciled means.
    const third = await sync(fake);
    expect(third.unchanged).toBe(10);
    expect(third.created).toBe(0);
    expect(third.failed).toBe(0);

    const registered = await listArtifacts(sql, projectId);
    for (const row of registered) {
      expect(row.status).toBe("synced");
      expect(row.signozResourceId).not.toBeNull();
      // Every recorded identifier still resolves to a resource SigNoz holds.
      expect(fake.allResources().some((resource) => resource.id === row.signozResourceId)).toBe(
        true,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* A write that landed and an answer that did not                             */
/* -------------------------------------------------------------------------- */

describe("a create whose response was lost", () => {
  it("adopts the resource on the next sync rather than creating a second one", async () => {
    // #given a dashboard create that reaches SigNoz and whose response never arrives
    const fake = new FakeSigNoz({
      faults: [{ tool: "signoz_create_dashboard", mode: "transport", afterEffect: true, times: 1 }],
    });

    const first = await sync(fake);
    expect(first.failed).toBeGreaterThan(0);
    expect(fake.countNamed(DASHBOARD_NAME)).toBe(1);

    // The register recorded the failure rather than a resource it cannot prove.
    const afterFirst = await listArtifacts(sql, projectId);
    const dashboardRow = afterFirst.find((row) => row.managedName === DASHBOARD_NAME);
    expect(dashboardRow?.status).not.toBe("synced");

    // #when the sync is retried against a healthy server
    fake.clearFaults();
    const second = await sync(fake);

    // #then there is still exactly one dashboard of that name
    expect(fake.countNamed(DASHBOARD_NAME)).toBe(1);
    expect(duplicateNames(fake)).toEqual([]);
    expect(second.failed).toBe(0);
  });

  it("does not report success for a create whose identifier could not be read", async () => {
    const fake = new FakeSigNoz({
      faults: [{ tool: "signoz_create_alert", mode: "empty" }],
    });

    const result = await sync(fake);

    expect(result.failed).toBeGreaterThan(0);
    const alerts = (await listArtifacts(sql, projectId)).filter(
      (row) => row.artifactType === "alert",
    );
    expect(alerts.every((row) => row.status !== "synced")).toBe(true);
  });

  it("records nothing as synced when the register write fails after the remote create", async () => {
    // #given a healthy SigNoz and a register write that fails
    const fake = new FakeSigNoz();
    const registered = await readRegisteredArtifacts(sql, projectId);
    const { writes } = await synchroniseArtifacts(inputFor(), registered, {
      synchroniser: new ArtifactSynchroniser(operationsOver(fake)),
      now: () => new Date("2026-07-26T00:00:00.000Z"),
    });

    // #when the transaction that persists the register rolls back
    await expect(
      sql.begin(async (tx) => {
        await persistArtifactWrites(tx, writes);
        throw new Error("the register commit failed");
      }),
    ).rejects.toThrow(/register commit failed/);

    // #then the register holds nothing, SigNoz holds ten resources, and the next sync adopts them
    // by name instead of creating a second set
    expect(await listArtifacts(sql, projectId)).toHaveLength(0);
    expect(fake.allResources()).toHaveLength(10);

    const recovery = await sync(fake);
    expect(duplicateNames(fake)).toEqual([]);
    expect(fake.allResources()).toHaveLength(10);
    // Every one of them belongs to a name FlightRules generated but has never recorded, so the
    // honest answer is conflict — not a silent overwrite of a resource whose provenance is unknown.
    expect(recovery.conflicts).toBe(10);
    expect(recovery.created).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Ownership                                                                  */
/* -------------------------------------------------------------------------- */

describe("resources FlightRules does not own", () => {
  it("reports a conflict and writes nothing when the name is already taken", async () => {
    // #given somebody else's dashboard carrying a name FlightRules would generate
    const fake = new FakeSigNoz({
      preexisting: [{ kind: "dashboard", name: DASHBOARD_NAME, id: "someone-elses-dashboard" }],
    });

    const result = await sync(fake);

    // #then it is left exactly as it was
    expect(result.conflicts).toBe(1);
    expect(fake.countNamed(DASHBOARD_NAME)).toBe(1);
    expect(fake.allResources().find((r) => r.id === "someone-elses-dashboard")).toBeDefined();

    const row = (await listArtifacts(sql, projectId)).find(
      (entry) => entry.managedName === DASHBOARD_NAME,
    );
    expect(row?.status).toBe("conflict");
    expect(row?.signozResourceId).toBeNull();
  });

  it("keeps reporting the same conflict rather than resolving it on a later sync", async () => {
    const fake = new FakeSigNoz({
      preexisting: [{ kind: "view", name: VIEW_NAME, id: "someone-elses-view" }],
    });

    const first = await sync(fake);
    const second = await sync(fake);

    expect(first.conflicts).toBe(1);
    expect(second.conflicts).toBe(1);
    expect(fake.countNamed(VIEW_NAME)).toBe(1);
    expect(fake.allResources().find((r) => r.id === "someone-elses-view")).toBeDefined();
  });

  it("never touches a resource outside its own project", async () => {
    const OTHER = "FlightRules / other-project / other-agent / Contract Health";
    const fake = new FakeSigNoz({
      preexisting: [{ kind: "dashboard", name: OTHER, id: "other-project-dashboard" }],
    });

    await sync(fake);

    expect(fake.allResources().find((r) => r.id === "other-project-dashboard")?.name).toBe(OTHER);
    expect((await listArtifacts(sql, projectId)).some((row) => row.managedName === OTHER)).toBe(
      false,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Somebody changed it by hand                                                */
/* -------------------------------------------------------------------------- */

describe("a managed resource edited outside FlightRules", () => {
  it("recreates one that was deleted, without leaving a second behind", async () => {
    const fake = new FakeSigNoz();
    await sync(fake);
    fake.deleteByName(DASHBOARD_NAME);
    expect(fake.countNamed(DASHBOARD_NAME)).toBe(0);

    const result = await sync(fake);

    expect(fake.countNamed(DASHBOARD_NAME)).toBe(1);
    expect(duplicateNames(fake)).toEqual([]);
    expect(result.failed).toBe(0);
    const row = (await listArtifacts(sql, projectId)).find(
      (entry) => entry.managedName === DASHBOARD_NAME,
    );
    expect(row?.status).toBe("synced");
  });

  it("restores one that was renamed, and does not adopt the renamed resource", async () => {
    const fake = new FakeSigNoz();
    await sync(fake);
    fake.renameByName(DASHBOARD_NAME, "Renamed by hand");

    const result = await sync(fake);

    // The renamed resource is somebody's deliberate edit and is left alone; the managed name is
    // restored beside it.
    expect(fake.countNamed("Renamed by hand")).toBe(1);
    expect(fake.countNamed(DASHBOARD_NAME)).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("restores a managed resource whose contents were edited", async () => {
    const fake = new FakeSigNoz();
    await sync(fake);
    fake.editByName(DASHBOARD_NAME, { widgets: [] });

    const result = await sync(fake);

    expect(result.failed).toBe(0);
    expect(duplicateNames(fake)).toEqual([]);
    const restored = await sync(fake);
    expect(restored.unchanged).toBe(10);
  });

  it("replaces a saved view by delete-and-create, never by signoz_update_view", async () => {
    // SL-057: `signoz_update_view` corrupts the stored view and then breaks `signoz_list_views` for
    // the whole tenant. The fake refuses the tool, so a regression here fails rather than passing
    // quietly against a server that would have been damaged.
    const fake = new FakeSigNoz();
    await sync(fake);
    fake.editByName(VIEW_NAME, { sourcePage: "logs" });

    const result = await sync(fake, { contractVersion: "1.0.1" });

    expect(fake.calls.some((call) => call.name === "signoz_update_view")).toBe(false);
    expect(fake.calls.some((call) => call.name === "signoz_delete_view")).toBe(true);
    expect(result.failed).toBe(0);
    expect(fake.countNamed(VIEW_NAME)).toBe(1);
  });

  it("creates no duplicate view when two syncs race through a delete-and-recreate", async () => {
    const fake = new FakeSigNoz();
    await sync(fake);

    // Both syncs see a changed contract version, so both plan a view replacement.
    await Promise.all([
      sync(fake, { contractVersion: "2.0.0" }),
      sync(fake, { contractVersion: "2.0.0" }),
    ]);

    expect(fake.countNamed(VIEW_NAME)).toBe(1);
    expect(duplicateNames(fake)).toEqual([]);

    // And the register still points at a view that exists.
    const row = (await listArtifacts(sql, projectId)).find(
      (entry) => entry.managedName === VIEW_NAME,
    );
    expect(fake.allResources().some((resource) => resource.id === row?.signozResourceId)).toBe(
      true,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Superseded contracts                                                       */
/* -------------------------------------------------------------------------- */

describe("a stale resource from a superseded contract", () => {
  it("is reported rather than silently deleted", async () => {
    const fake = new FakeSigNoz();
    await sync(fake);

    // A register row for a managed name the current contract no longer produces.
    await sql`
      insert into signoz_artifacts (
        project_id, agent_id, artifact_type, managed_name, signoz_resource_id,
        spec_hash, status, remote_snapshot_json, verification_json
      ) values (
        ${projectId}, ${agentId}, 'saved_view',
        ${`FlightRules / ${PROJECT_SLUG} / ${AGENT_KEY} / Retired View`},
        'retired-view-id', ${"0".repeat(64)}, 'synced', '{}'::jsonb, '{}'::jsonb
      )`;

    const result = await sync(fake);

    expect(result.stale).toContain(`FlightRules / ${PROJECT_SLUG} / ${AGENT_KEY} / Retired View`);
    expect(result.failed).toBe(0);
    // Reported, not removed: deleting a resource a human may still be using is not this job's call.
    expect(
      (await listArtifacts(sql, projectId)).some((row) => row.managedName.endsWith("Retired View")),
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Every successful write is read back                                        */
/* -------------------------------------------------------------------------- */

describe("read-back", () => {
  it("follows every create with a read of the resource it claims to have made", async () => {
    const fake = new FakeSigNoz();
    await sync(fake);

    const creates = fake.calls.filter((call) => call.name.startsWith("signoz_create"));
    const reads = fake.calls.filter((call) => call.name.startsWith("signoz_get"));
    expect(creates).toHaveLength(10);
    expect(reads.length).toBeGreaterThanOrEqual(10);

    const registered = await listArtifacts(sql, projectId);
    for (const row of registered) {
      expect(row.status).toBe("synced");
      expect(row.verification).toMatchObject({ status: "verified" });
    }
  });

  it("fails the artefact when the read-back does not match what was asked for", async () => {
    // #given a read-back that returns an HTML document rather than a resource (SL-012)
    const fake = new FakeSigNoz({ faults: [{ tool: "signoz_get_dashboard", mode: "html" }] });

    const result = await sync(fake);

    expect(result.failed).toBeGreaterThan(0);
    const row = (await listArtifacts(sql, projectId)).find(
      (entry) => entry.managedName === DASHBOARD_NAME,
    );
    expect(row?.status).not.toBe("synced");
  });
});

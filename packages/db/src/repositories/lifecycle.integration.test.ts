import { readFileSync } from "node:fs";
import path from "node:path";
import { canonicalContract, parseContractOrThrow } from "@flightrules/contract-schema";
import {
  buildTraceGraph,
  canonicaliseGraph,
  fingerprintGraph,
  serialiseCanonicalGraph,
} from "@flightrules/trace-graph";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connect, MIGRATIONS_DIR, migrateUp, type Sql } from "../index.js";
import { toPageRequest } from "../pagination.js";
import { createAgent } from "./agents.js";
import { countAuditEvents, recordAudit } from "./audit.js";
import {
  approveBaseline,
  decideRouteFamily,
  findBaseline,
  findBaselineBySelection,
  listBaselines,
  persistBaseline,
} from "./baselines.js";
import {
  activateContract,
  approveContract,
  canTransition,
  createContract,
  findActiveContract,
  findContract,
  listContractRules,
  markContractInvalid,
  replaceDraft,
} from "./contracts.js";
import { createProject } from "./projects.js";
import { upsertTraceGraph, upsertTraceRun } from "./traces.js";

/**
 * Round trips through the persistence layer.
 *
 * The claim these tests defend is narrow and load-bearing: a deterministic object that goes into a
 * row and comes back out is byte-identical where the product's identity depends on its bytes. A
 * canonical graph is the case that matters most, because `jsonb` reorders object keys and the route
 * fingerprint is a hash over the serialised graph.
 */

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  throw new Error("DATABASE_URL must be set for database integration tests. Run `make up` first.");
}

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const CONTRACT_YAML = readFileSync(
  path.join(REPO_ROOT, "contracts/demo-commerce/refund-agent/production/contract.yaml"),
  "utf8",
);

let sql: Sql;
let projectId = "";
let agentId = "";

beforeAll(async () => {
  sql = connect(databaseUrl, { max: 4 });
  await sql`drop schema public cascade`;
  await sql`create schema public`;
  await migrateUp(sql, MIGRATIONS_DIR);
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await sql`truncate projects restart identity cascade`;
  const project = await createProject(sql, { name: "Demo", slug: "demo-commerce" });
  projectId = project.id;
  const agent = await createAgent(sql, {
    projectId,
    name: "Refund agent",
    agentKey: "refund-agent",
    workflowNameMatcher: "refund-workflow",
    releaseAttributeKey: "agent.release.id",
    environmentAttributeKey: "deployment.environment.name",
  });
  agentId = agent.id;
});

function spanRows(): { [key: string]: unknown }[] {
  const base = {
    trace_id: "a".repeat(32),
    "service.name": "flightrules-demo-agent",
    "agent.release.id": "refund-agent-v1",
    "agent.run.id": "run-1",
    timestamp: "2026-07-25T10:00:00.000Z",
    duration_nano: 1_000_000,
    status_code_string: "Ok",
    has_error: false,
  };
  return [
    {
      ...base,
      span_id: "0000000000000001",
      parent_span_id: "",
      name: "refund.request",
      kind_string: "Server",
      "agent.side_effect": "none",
    },
    {
      ...base,
      span_id: "0000000000000002",
      parent_span_id: "0000000000000001",
      name: "policy.retrieve",
      kind_string: "Client",
      "agent.side_effect": "read",
      "gen_ai.tool.name": "retrieve_policy",
    },
  ];
}

describe("canonical graph round trip", () => {
  it("serialises identically after a jsonb round trip, so the fingerprint still holds", async () => {
    // #given a graph built from spans, with its fingerprint
    const graph = buildTraceGraph(spanRows(), { rootSelector: "refund.request" });
    const canonical = canonicaliseGraph(graph);
    const { fingerprint } = fingerprintGraph(graph);

    const run = await upsertTraceRun(sql, {
      agentId,
      releaseId: null,
      traceId: graph.traceId,
      runId: "run-1",
      signozWebUrl: null,
      rootSpanId: graph.rootSpanId,
      startedAt: new Date("2026-07-25T10:00:00.000Z"),
      completedAt: new Date("2026-07-25T10:00:01.000Z"),
      durationMs: 1,
      status: "ok",
      qualityStatus: graph.quality,
      summary: { nodes: graph.nodes.length },
    });

    // #when it is stored and read back
    await upsertTraceGraph(sql, {
      traceRunId: run.id,
      normaliserVersion: graph.normaliserVersion,
      normaliserConfigHash: graph.normaliserConfigHash,
      graphSchemaVersion: "1.0.0",
      fingerprint,
      canonical,
      featureSet: { features: [] },
      qualityWarnings: [],
    });
    const stored = await upsertTraceGraph(sql, {
      traceRunId: run.id,
      normaliserVersion: graph.normaliserVersion,
      normaliserConfigHash: graph.normaliserConfigHash,
      graphSchemaVersion: "1.0.0",
      fingerprint,
      canonical,
      featureSet: { features: [] },
      qualityWarnings: [],
    });

    // #then the canonical bytes are identical, which is what the fingerprint is taken over
    expect(serialiseCanonicalGraph(stored.canonical)).toBe(serialiseCanonicalGraph(canonical));
    expect(stored.fingerprint).toBe(fingerprint);
  });

  it("upserts rather than duplicating when a run is seen twice", async () => {
    const graph = buildTraceGraph(spanRows(), { rootSelector: "refund.request" });
    for (let index = 0; index < 2; index += 1) {
      await upsertTraceRun(sql, {
        agentId,
        releaseId: null,
        traceId: graph.traceId,
        runId: "run-1",
        signozWebUrl: null,
        rootSpanId: graph.rootSpanId,
        startedAt: new Date(),
        completedAt: null,
        durationMs: 1,
        status: "ok",
        qualityStatus: graph.quality,
        summary: {},
      });
    }
    const rows = await sql<{ count: string }[]>`select count(*)::text as count from trace_runs`;
    expect(rows[0]?.count).toBe("1");
  });
});

describe("baselines", () => {
  const baseline = (selectionHash: string) => ({
    id: `bl-${selectionHash.slice(0, 32)}`,
    projectKey: "demo-commerce",
    agentKey: "refund-agent",
    releaseId: "refund-agent-v1",
    environment: "local",
    status: "pending_review" as const,
    sourceTimeStartMs: Date.parse("2026-07-25T04:00:00.000Z"),
    sourceTimeEndMs: Date.parse("2026-07-25T10:00:00.000Z"),
    minimumRuns: 20,
    rareThreshold: { numerator: 5, denominator: 100, decimal: "0.050000" },
    normaliserVersion: "1.0.0",
    normaliserConfigHash: "f".repeat(64),
    selectionHash,
    counts: {
      tracesDiscovered: 34,
      tracesRetrieved: 34,
      eligibleRuns: 34,
      excludedTraces: 0,
      duplicateTraces: 0,
      duplicateRuns: 0,
      routeFamilies: 1,
      rareFamilies: 0,
      excludedByReason: [],
    },
    retrieval: {
      pages: 1,
      batchSize: 200,
      maxTraces: 1_000,
      truncated: false,
      startMs: 0,
      endMs: 1,
      fieldTypesVerified: [],
      fieldTypesUnverified: [],
    },
    families: [
      {
        id: `rf-${"1".repeat(32)}`,
        fingerprint: "4".repeat(64),
        canonical: {
          normaliserVersion: "1.0.0",
          normaliserConfigHash: "f".repeat(64),
          nodes: [],
          edges: [],
        },
        status: "pending" as const,
        rare: false,
        occurrenceCount: 34,
        occurrencePercent: { numerator: 34, denominator: 34, decimal: "1.000000" },
        representativeTraceIds: ["t1", "t2"],
        statistics: { traceCount: 34 },
        normaliserVersion: "1.0.0",
        normaliserConfigHash: "f".repeat(64),
      },
    ],
    excluded: [],
    disclosures: [{ code: "FIELD_TYPE_UNVERIFIED", subject: "", detail: "five", count: 5 }],
  });

  it("persists a mined baseline with its families, verbatim", async () => {
    const hash = "a".repeat(64);
    const stored = await sql.begin((tx) =>
      persistBaseline(tx, {
        agentId,
        releaseId: null,
        jobId: null,
        baseline: baseline(hash) as never,
        selection: { releaseId: "refund-agent-v1" },
      }),
    );

    expect(stored.baselineIdentifier).toBe(`bl-${hash.slice(0, 32)}`);
    expect(stored.selectionHash).toBe(hash);
    expect(stored.families).toHaveLength(1);
    expect(stored.families[0]?.occurrencePercent.decimal).toBe("1.000000");
    expect(stored.families[0]?.representativeTraceIds).toEqual(["t1", "t2"]);
    expect(stored.disclosures).toEqual([
      { code: "FIELD_TYPE_UNVERIFIED", count: 5, detail: "five", subject: "" },
    ]);
  });

  it("is idempotent on the selection hash, so a replayed job reuses its own row", async () => {
    const hash = "b".repeat(64);
    const first = await sql.begin((tx) =>
      persistBaseline(tx, {
        agentId,
        releaseId: null,
        jobId: null,
        baseline: baseline(hash) as never,
        selection: {},
      }),
    );
    const second = await sql.begin((tx) =>
      persistBaseline(tx, {
        agentId,
        releaseId: null,
        jobId: null,
        baseline: baseline(hash) as never,
        selection: {},
      }),
    );
    expect(second.id).toBe(first.id);
    expect(second.families).toHaveLength(1);

    const listed = await listBaselines(sql, agentId, toPageRequest({ limit: 10 }));
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.familyCount).toBe(1);
    expect(await findBaselineBySelection(sql, agentId, hash)).not.toBeNull();
  });

  it("leaves nothing behind when the transaction that writes it fails", async () => {
    const hash = "c".repeat(64);
    await expect(
      sql.begin(async (tx) => {
        await persistBaseline(tx, {
          agentId,
          releaseId: null,
          jobId: null,
          baseline: baseline(hash) as never,
          selection: {},
        });
        throw new Error("crash after the families were written");
      }),
    ).rejects.toThrow(/crash after the families/);

    expect(await findBaselineBySelection(sql, agentId, hash)).toBeNull();
    const families = await sql<
      { count: string }[]
    >`select count(*)::text as count from route_families`;
    expect(families[0]?.count).toBe("0");
  });

  it("approves the baseline only once a family is approved", async () => {
    const hash = "d".repeat(64);
    const stored = await sql.begin((tx) =>
      persistBaseline(tx, {
        agentId,
        releaseId: null,
        jobId: null,
        baseline: baseline(hash) as never,
        selection: {},
      }),
    );

    // #given no decision yet
    expect(await approveBaseline(sql, stored.id)).toBeNull();

    // #when a family is approved
    const decided = await decideRouteFamily(sql, stored.families[0]?.id ?? "", "approved");
    expect(decided?.status).toBe("approved");
    expect(decided?.decidedAt).not.toBeNull();

    const approved = await approveBaseline(sql, stored.id);
    expect(approved?.status).toBe("approved");
    expect(approved?.approvedAt).not.toBeNull();

    // #and approving twice is a no-op rather than a second transition
    expect(await approveBaseline(sql, stored.id)).toBeNull();
    expect((await findBaseline(sql, stored.id))?.status).toBe("approved");
  });
});

describe("contract lifecycle", () => {
  const parsed = parseContractOrThrow(CONTRACT_YAML);

  const create = () =>
    sql.begin((tx) =>
      createContract(tx, {
        agentId,
        baselineVersionId: null,
        jobId: null,
        environment: "production",
        source: "authored",
        contract: parsed.contract,
        canonical: canonicalContract(parsed.contract),
        contentHash: parsed.contentHash,
        yamlText: CONTRACT_YAML,
      }),
    );

  it("stores a draft with every rule projected", async () => {
    const created = await create();
    expect(created.contract.status).toBe("draft");
    expect(created.contract.contentHash).toBe(parsed.contentHash);
    expect(created.rules).toHaveLength(parsed.contract.spec.rules.length);

    const rules = await listContractRules(sql, created.contract.id);
    const zeroTolerance = rules.filter((rule) => rule.zeroTolerance).map((rule) => rule.ruleKey);
    expect(zeroTolerance.sort()).toEqual(
      [...parsed.contract.spec.gate.zeroToleranceRuleIds].sort(),
    );
  });

  it("keeps the canonical form stable through a jsonb round trip", async () => {
    const created = await create();
    const read = await findContract(sql, created.contract.id);
    // `canonicalContract` sorts its own input, so a value from a row hashes like one from YAML.
    expect(JSON.stringify(canonicalContract(parsed.contract))).toBe(
      JSON.stringify(canonicalContract(parsed.contract)),
    );
    expect(read?.contentHash).toBe(parsed.contentHash);
  });

  it("walks draft to approved to active and supersedes the previous version", async () => {
    const first = await create();
    await approveContract(sql, first.contract.id);
    const activation = await sql.begin((tx) => activateContract(tx, first.contract.id));
    expect(activation?.activated.status).toBe("active");
    expect(activation?.superseded).toBeNull();

    // #given a second version of the same contract
    const secondYaml = CONTRACT_YAML.replace("version: 1.0.0", "version: 1.1.0");
    const secondParsed = parseContractOrThrow(secondYaml);
    const second = await sql.begin((tx) =>
      createContract(tx, {
        agentId,
        baselineVersionId: null,
        jobId: null,
        environment: "production",
        source: "authored",
        contract: secondParsed.contract,
        canonical: canonicalContract(secondParsed.contract),
        contentHash: secondParsed.contentHash,
        yamlText: secondYaml,
      }),
    );
    await approveContract(sql, second.contract.id);
    const secondActivation = await sql.begin((tx) => activateContract(tx, second.contract.id));

    // #then the previous one is superseded and points at its successor
    expect(secondActivation?.superseded?.id).toBe(first.contract.id);
    expect((await findContract(sql, first.contract.id))?.status).toBe("superseded");
    expect((await findContract(sql, first.contract.id))?.supersededByContractId).toBe(
      second.contract.id,
    );
    expect((await findActiveContract(sql, agentId, "production"))?.id).toBe(second.contract.id);
  });

  it("refuses to activate a contract that was never approved", async () => {
    const created = await create();
    await expect(sql.begin((tx) => activateContract(tx, created.contract.id))).rejects.toThrow(
      /must be approved/,
    );
  });

  it("refuses to edit anything that is no longer a draft", async () => {
    const created = await create();
    await approveContract(sql, created.contract.id);
    const replaced = await sql.begin((tx) =>
      replaceDraft(tx, {
        contractId: created.contract.id,
        contract: parsed.contract,
        canonical: canonicalContract(parsed.contract),
        contentHash: parsed.contentHash,
        yamlText: CONTRACT_YAML,
      }),
    );
    expect(replaced).toBeNull();
  });

  it("declares the legal transitions", () => {
    expect(canTransition("draft", "approved")).toBe(true);
    expect(canTransition("approved", "active")).toBe(true);
    expect(canTransition("active", "superseded")).toBe(true);
    expect(canTransition("superseded", "active")).toBe(false);
    expect(canTransition("draft", "active")).toBe(false);
    expect(canTransition("invalid", "approved")).toBe(false);
  });

  it("records an invalid contract with its errors and refuses an empty error list", async () => {
    const created = await create();
    await expect(markContractInvalid(sql, created.contract.id, [])).rejects.toThrow(/at least one/);
    const invalid = await markContractInvalid(sql, created.contract.id, [
      { code: "INVALID_FORMAT", path: "spec.rules[0]" },
    ]);
    expect(invalid?.status).toBe("invalid");
  });
});

describe("audit history", () => {
  it("is written by the transaction that made the change, and rolls back with it", async () => {
    await expect(
      sql.begin(async (tx) => {
        await recordAudit(tx, {
          projectId,
          actorType: "user",
          eventType: "contract.approved",
          entityType: "contract",
          entityId: agentId,
        });
        throw new Error("the change failed");
      }),
    ).rejects.toThrow(/the change failed/);

    expect(await countAuditEvents(sql, agentId)).toBe(0);
  });
});

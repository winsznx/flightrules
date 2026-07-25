import { readFileSync } from "node:fs";
import path from "node:path";
import { evaluateRun } from "@flightrules/contract-engine";
import { formatValidationErrors, parseContract } from "@flightrules/contract-schema";
import {
  buildTraceQuery,
  rowsOf as mcpRowsOf,
  SigNozMcpClient,
  SigNozOperations,
  StreamableToolCaller,
} from "@flightrules/signoz-mcp";
import { buildTraceGraph, fingerprintGraph, type SpanRowData } from "@flightrules/trace-graph";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyRouteDecisions } from "./decisions.js";
import { emitContractYaml } from "./emit.js";
import { type MinedBaseline, mineBaseline, signozTraceSource } from "./mine.js";
import { approvedRouteInputs } from "./model.js";
import { type ContractProposal, proposeContract } from "./propose.js";
import { MINING_SELECT_FIELDS, verifyFieldTypes } from "./retrieve.js";
import type { MiningSelectionInput } from "./selection.js";

/**
 * Phase 08 integration tests.
 *
 * These mine a baseline from telemetry the demo emitted minutes ago, through the same MCP client the
 * product uses, and then put the generated contract through the Phase 07 validator and evaluator. A
 * fixture-only test would prove the algorithms and nothing about SigNoz; the two questions only a live
 * run can answer are whether the field catalogue confirms the types the miner declares, and whether a
 * freshly executed run lands in the same route family as the ones before it.
 *
 * Requires a recent `DEMO_RUNS=25 make demo-v1` and `make demo-v2`.
 */

const mcpUrl = process.env["SIGNOZ_MCP_URL"] ?? "http://localhost:8000/mcp";
const apiKey = process.env["SIGNOZ_API_KEY"];

if (!apiKey || apiKey === "replace-me") {
  throw new Error("SIGNOZ_API_KEY must be set for SigNoz integration tests. Source .env.");
}

const CONTEXT = {
  searchContext:
    "FlightRules Phase 08 integration test: mine a baseline from live known-good telemetry",
};
const ROOT_SELECTOR = "refund.request";
const ENVIRONMENT = process.env["DEPLOYMENT_ENVIRONMENT"] ?? "local";
/** Fewest live runs the pipeline is exercised on. `make demo-v1` seeds more than this. */
const MINIMUM_RUNS = 5;

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const DEMO_CONTRACT = path.join(
  REPO_ROOT,
  "contracts",
  "demo-commerce",
  "refund-agent",
  "production",
  "contract.yaml",
);

let caller: StreamableToolCaller;
let client: SigNozMcpClient;
let operations: SigNozOperations;

function window(): { readonly startMs: number; readonly endMs: number } {
  const endMs = Date.now();
  return { startMs: endMs - 6 * 60 * 60 * 1000, endMs };
}

function selection(overrides: Partial<MiningSelectionInput> = {}): MiningSelectionInput {
  return {
    projectKey: "demo-commerce",
    agentKey: "refund-agent",
    releaseId: "refund-agent-v1",
    environment: ENVIRONMENT,
    ...window(),
    minimumRuns: MINIMUM_RUNS,
    rootSpanName: ROOT_SELECTOR,
    ...overrides,
  };
}

/** Fetches the spans of the newest run of a release, for evaluating against the proposal. */
async function newestRunRows(releaseId: string): Promise<readonly SpanRowData[]> {
  const found = await operations.executeBuilderQuery(
    buildTraceQuery({
      filter: `agent.release.id = '${releaseId}' AND name = '${ROOT_SELECTOR}'`,
      selectFields: [{ name: "trace_id", context: "span", dataType: "string" }],
      ...window(),
      limit: 1,
      orderDirection: "desc",
    }),
    CONTEXT,
  );
  if (found.outcome !== "SUCCESS_WITH_ROWS") {
    throw new Error(`no ${releaseId} run in the last 6 hours. Run make demo-v1 and make demo-v2.`);
  }
  const traceId = mcpRowsOf(found.value)[0]?.data["trace_id"] as string;

  const spans = await operations.getTraceSpans(
    traceId,
    {
      selectFields: MINING_SELECT_FIELDS.map((field) => ({
        name: field.name,
        context: field.context,
        dataType: field.dataType,
      })),
      ...window(),
      limit: 500,
    },
    CONTEXT,
  );
  if (spans.outcome !== "SUCCESS_WITH_ROWS") {
    throw new Error(`could not fetch ${releaseId} trace ${traceId}: ${spans.outcome}`);
  }
  return mcpRowsOf(spans.value).map((row) => row.data);
}

async function mineLive(overrides: Partial<MiningSelectionInput> = {}): Promise<MinedBaseline> {
  const result = await mineBaseline({
    selection: selection(overrides),
    source: signozTraceSource(operations, CONTEXT),
  });
  if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));
  return result.value;
}

function proposeFrom(mined: MinedBaseline): {
  readonly proposal: ContractProposal;
  readonly baseline: MinedBaseline["baseline"];
} {
  const decided = applyRouteDecisions(
    mined.baseline,
    mined.baseline.families.map((family) => ({
      fingerprint: family.fingerprint,
      decision: "approve" as const,
    })),
  );
  if (!decided.ok) throw new Error(JSON.stringify(decided.errors, null, 2));

  const proposal = proposeContract({
    baseline: decided.baseline,
    runsByFingerprint: mined.runsByFingerprint,
    options: {
      createdAt: "2026-07-25T00:00:00Z",
      environment: "production",
      workflowName: "refund-workflow",
    },
  });
  if (!proposal.ok) throw new Error(JSON.stringify(proposal.errors, null, 2));
  return { proposal: proposal.proposal, baseline: decided.baseline };
}

beforeAll(async () => {
  caller = new StreamableToolCaller({
    url: mcpUrl,
    apiKey: apiKey as string,
    clientName: "flightrules-phase08-tests",
  });
  client = new SigNozMcpClient({ caller, timeoutMs: 60_000 });
  operations = new SigNozOperations(client);
  await client.discoverCapabilities();
}, 120_000);

afterAll(async () => {
  await client?.close().catch(() => {});
});

describe("field types confirmed against the live catalogue", () => {
  it("confirms every declared type SigNoz reports, and names the ones it does not list", async () => {
    const result = await verifyFieldTypes(operations, MINING_SELECT_FIELDS, CONTEXT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // #then the two typed tags the evaluator depends on are confirmed by the server itself
    expect(result.report.verified).toContain("agent.idempotency.present");
    expect(result.report.verified).toContain("agent.retry.number");
    expect(result.report.verified).toContain("duration_nano");
    expect(result.report.mismatched).toEqual([]);

    // #and the fields the catalogue genuinely omits are named rather than assumed
    expect(result.report.unverified).toContain("timestamp");
    expect(result.report.unverified).toContain("service.name");
  });

  it("refuses a mining run that declares a type the live catalogue contradicts", async () => {
    // #given the SL-046 mistake made deliberately: a boolean tag declared as a number
    const result = await verifyFieldTypes(
      operations,
      [{ name: "agent.idempotency.present", context: "tag", dataType: "number" }],
      CONTEXT,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("FIELD_TYPE_MISMATCH");
  });
});

describe("mining a baseline from live known-good telemetry", () => {
  it("collapses every fresh known-good run into one route family", async () => {
    const mined = await mineLive();

    expect(mined.baseline.status).toBe("pending_review");
    expect(mined.baseline.counts.eligibleRuns).toBeGreaterThanOrEqual(MINIMUM_RUNS);
    expect(mined.baseline.counts.routeFamilies).toBe(1);
    expect(mined.baseline.families[0]?.occurrencePercent.decimal).toBe("1.000000");
  }, 300_000);

  it("mines the fingerprint the committed contract already approves", async () => {
    const mined = await mineLive();
    const contract = parseContract(readFileSync(DEMO_CONTRACT, "utf8"));
    if (!contract.ok) throw new Error(formatValidationErrors(contract.errors));

    // #then the route identity the miner derives is the one Phase 07 committed, so neither is a stale
    // constant
    expect(contract.value.contract.spec.approvedRoutes).toContain(
      mined.baseline.families[0]?.fingerprint,
    );
  }, 300_000);

  it("puts a newly executed run in the same family despite new identifiers and timestamps", async () => {
    const mined = await mineLive();
    const rows = await newestRunRows("refund-agent-v1");
    const fresh = buildTraceGraph(rows, { rootSelector: ROOT_SELECTOR });

    expect(fingerprintGraph(fresh).fingerprint).toBe(mined.baseline.families[0]?.fingerprint);
  }, 300_000);

  it("excludes no trace without recording a reason", async () => {
    const mined = await mineLive();

    for (const excluded of mined.baseline.excluded) {
      expect(excluded.reason.length).toBeGreaterThan(0);
      expect(excluded.detail.length).toBeGreaterThan(0);
    }
    const tallied = mined.baseline.counts.excludedByReason.reduce(
      (sum, entry) => sum + entry.count,
      0,
    );
    expect(tallied).toBe(mined.baseline.excluded.length);
    expect(mined.baseline.counts.eligibleRuns + mined.baseline.counts.excludedTraces).toBe(
      mined.baseline.counts.tracesDiscovered,
    );
  }, 300_000);

  it("records the retrieval it is founded on, including the unverified fields", async () => {
    const mined = await mineLive();

    expect(mined.baseline.retrieval.pages).toBeGreaterThanOrEqual(1);
    expect(mined.baseline.retrieval.truncated).toBe(false);
    expect(mined.baseline.retrieval.fieldTypesVerified).toContain("agent.retry.number");
    expect(mined.baseline.retrieval.fieldTypesUnverified).toContain("timestamp");
  }, 300_000);

  it("reports a dataset as truncated when the window holds more runs than it may fetch", async () => {
    // #given a selection permitting fewer traces than the window contains
    const mined = await mineLive({ maxTraces: 2, batchSize: 2, minimumRuns: 1 });

    expect(mined.baseline.retrieval.truncated).toBe(true);
    expect(mined.baseline.status).toBe("dataset_truncated");
    expect(mined.baseline.disclosures.map((entry) => entry.code)).toContain("DATASET_TRUNCATED");
  }, 300_000);

  it("refuses to review or propose from a truncated dataset", async () => {
    const mined = await mineLive({ maxTraces: 2, batchSize: 2, minimumRuns: 1 });

    const decided = applyRouteDecisions(mined.baseline, [
      { fingerprint: mined.baseline.families[0]?.fingerprint as string, decision: "approve" },
    ]);

    expect(decided.ok).toBe(false);
    if (decided.ok) return;
    expect(decided.errors[0]?.code).toBe("BASELINE_NOT_REVIEWABLE");
  }, 300_000);
});

describe("the contract proposed from live telemetry", () => {
  it("is accepted by the Phase 07 validator through the public parser", async () => {
    const { proposal } = proposeFrom(await mineLive());
    const emitted = emitContractYaml(proposal);

    expect(emitted.ok).toBe(true);
    if (!emitted.ok) return;

    const reparsed = parseContract(emitted.yaml);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.value.contentHash).toBe(proposal.contentHash);
  }, 300_000);

  it("is a draft carrying its evidence and its disclosures", async () => {
    const { proposal } = proposeFrom(await mineLive());

    expect(proposal.status).toBe("draft");
    expect(proposal.rules.length).toBeGreaterThan(0);
    for (const entry of proposal.rules) {
      expect(entry.evidence.sampleSize).toBeGreaterThanOrEqual(MINIMUM_RUNS);
      expect(entry.evidence.observed.length).toBeGreaterThan(0);
    }
    // #then the agent makes no model call, so no token budget is proposed and both metrics are named
    expect(
      proposal.disclosures.filter(
        (entry) =>
          entry.code === "BUDGET_NOT_PROPOSED" && entry.subject.startsWith("gen_ai.usage."),
      ),
    ).toHaveLength(2);
  }, 300_000);

  it("passes a freshly executed known-good run", async () => {
    const mined = await mineLive();
    const { proposal, baseline } = proposeFrom(mined);
    const rows = await newestRunRows("refund-agent-v1");
    const graph = buildTraceGraph(rows, { rootSelector: ROOT_SELECTOR });

    const { evaluation } = evaluateRun({
      graph,
      contract: proposal.contract,
      approvedRoutes: approvedRouteInputs(baseline),
    });

    expect(evaluation.status).toBe("pass");
    expect(evaluation.violations).toEqual([]);
    expect(evaluation.routeApproved).toBe(true);
  }, 300_000);

  it("fails the live canary on the missing policy check, the missing fraud check and the duplicate refund", async () => {
    const mined = await mineLive();
    const { proposal, baseline } = proposeFrom(mined);
    const rows = await newestRunRows("refund-agent-v2");
    const graph = buildTraceGraph(rows, { rootSelector: ROOT_SELECTOR });

    const { evaluation } = evaluateRun({
      graph,
      contract: proposal.contract,
      approvedRoutes: approvedRouteInputs(baseline),
    });

    expect(evaluation.status).toBe("fail");
    const zeroTolerance = evaluation.violations.filter((entry) => entry.zeroTolerance);
    expect(zeroTolerance).toHaveLength(3);
    const summaries = zeroTolerance.map((entry) => entry.summary).join(" ");
    expect(summaries).toContain("policy.retrieve");
    expect(summaries).toContain("fraud.check");
    expect(summaries).toContain("payment.refund");
    expect(zeroTolerance.some((entry) => entry.code === "CARDINALITY_ABOVE_MAX")).toBe(true);
  }, 300_000);

  it("reports insufficient evidence for the canary's aborted handler rather than a skipped step", async () => {
    const mined = await mineLive();
    const { proposal, baseline } = proposeFrom(mined);
    const rows = await newestRunRows("refund-agent-v2");
    const graph = buildTraceGraph(rows, { rootSelector: ROOT_SELECTOR });

    expect(graph.warnings.map((warning) => warning.kind)).toContain(
      "client_span_without_server_span",
    );

    const { evaluation } = evaluateRun({
      graph,
      contract: proposal.contract,
      approvedRoutes: approvedRouteInputs(baseline),
    });

    const undecided = evaluation.ruleResults.filter(
      (entry) => entry.outcome === "insufficient_evidence",
    );
    expect(undecided.length).toBeGreaterThan(0);
    expect(undecided.every((entry) => entry.insufficientReason === "unobservable_subtree")).toBe(
      true,
    );
    // #and the duplicate refund still fails, so one local gap did not suppress a real finding
    expect(evaluation.violations.some((entry) => entry.code === "CARDINALITY_ABOVE_MAX")).toBe(
      true,
    );
  }, 300_000);
});

describe("determinism across repeated live mining", () => {
  it("produces a byte-identical proposal when the dataset has not changed", async () => {
    // #given one dataset, fixed by a window that both runs share
    const bounds = window();
    const fixed = { startMs: bounds.startMs, endMs: bounds.endMs };

    const first = proposeFrom(await mineLive(fixed));
    const second = proposeFrom(await mineLive(fixed));

    const firstYaml = emitContractYaml(first.proposal);
    const secondYaml = emitContractYaml(second.proposal);

    expect(firstYaml.ok && secondYaml.ok).toBe(true);
    if (!firstYaml.ok || !secondYaml.ok) return;
    expect(secondYaml.yaml).toBe(firstYaml.yaml);
    expect(second.proposal.contentHash).toBe(first.proposal.contentHash);
    expect(second.baseline.id).toBe(first.baseline.id);
    expect(second.baseline.selectionHash).toBe(first.baseline.selectionHash);
  }, 300_000);

  it("mines the same family fingerprint from a smaller page size", async () => {
    const bounds = window();
    const wide = await mineLive({ ...bounds, batchSize: 200 });
    const narrow = await mineLive({ ...bounds, batchSize: 2 });

    expect(narrow.baseline.families[0]?.fingerprint).toBe(wide.baseline.families[0]?.fingerprint);
    expect(narrow.baseline.counts.eligibleRuns).toBe(wide.baseline.counts.eligibleRuns);
    expect(narrow.baseline.retrieval.pages).toBeGreaterThan(wide.baseline.retrieval.pages);
  }, 300_000);
});

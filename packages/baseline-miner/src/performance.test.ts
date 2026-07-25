import { knownGoodTrace, renumberTrace, rowsOf, wideTraceRows } from "@flightrules/test-fixtures";
import { describe, expect, it } from "vitest";
import { applyRouteDecisions } from "./decisions.js";
import type { RetrievedTrace } from "./eligibility.js";
import { emitContractYaml } from "./emit.js";
import { type MinedBaseline, mineBaseline, type TraceSource } from "./mine.js";
import { proposeContract } from "./propose.js";
import { TEXT_LIMITS } from "./safety.js";

/**
 * Mining performance budgets.
 *
 * Each budget is generous relative to the measured figure, deliberately. A budget tuned to the current
 * number fails on a slower machine and gets deleted, and then nothing is measured at all. The Phase 06
 * precedent is the reason these exist: a quadratic canonical path took 5.6 seconds and only a budget
 * caught it.
 *
 * The shape that matters here is that mining is linear in the number of runs and in the number of
 * families. Grouping is by fingerprint through a `Map`, and family statistics are computed once per
 * family from its canonical graph rather than once per run, so neither dimension should be quadratic.
 */

const KNOWN_GOOD = rowsOf(knownGoodTrace());
const BASE_MS = Date.parse("2026-07-25T10:00:00Z");

function traceOf(
  index: number,
  rows: readonly Record<string, unknown>[] = KNOWN_GOOD,
): RetrievedTrace {
  const traceId = `t${String(index).padStart(31, "0")}`;
  return {
    traceId,
    rows: renumberTrace(rows, {
      traceId,
      runId: `run_${String(index).padStart(20, "0")}`,
      startedAtUtc: new Date(BASE_MS + index * 1000).toISOString(),
      rootDurationNano: (25 + (index % 40)) * 1_000_000,
    }),
    webUrl: null,
    untrustedFields: [],
  };
}

/** One distinct family per index, produced by giving each run an extra step of its own. */
function distinctFamilyTrace(index: number): RetrievedTrace {
  const extra = KNOWN_GOOD.map((row) => ({ ...row }));
  const root = extra.find((row) => row["parent_span_id"] === "") as Record<string, unknown>;
  extra.push({
    ...root,
    span_id: `extra${String(index).padStart(11, "0")}`,
    parent_span_id: root["span_id"],
    name: `extra.step.${index}`,
    kind_string: "Client",
    "gen_ai.tool.name": `extra_tool_${index}`,
    "gen_ai.operation.name": "execute_tool",
    "agent.side_effect": "read",
    "agent.data_domain": "extra",
    "agent.retry.number": 0,
  });
  return traceOf(index, extra);
}

function sourceOf(traces: readonly RetrievedTrace[]): TraceSource {
  return {
    verifyFieldTypes: async () => ({
      ok: true,
      report: { verified: ["trace_id"], unverified: [], mismatched: [] },
    }),
    discover: async () => ({
      ok: true,
      dataset: { traceIds: traces.map((trace) => trace.traceId), pages: 1, truncated: false },
    }),
    fetch: async () => ({ traces, failures: [] }),
  };
}

async function mine(
  traces: readonly RetrievedTrace[],
  overrides: Record<string, unknown> = {},
): Promise<MinedBaseline> {
  const result = await mineBaseline({
    selection: {
      projectKey: "demo-commerce",
      agentKey: "refund-agent",
      releaseId: "refund-agent-v1",
      environment: null,
      startMs: BASE_MS - 3_600_000,
      endMs: BASE_MS + 86_400_000 * 30,
      minimumRuns: 1,
      rootSpanName: "refund.request",
      maxTraces: TEXT_LIMITS.maxTraces,
      ...overrides,
    },
    source: sourceOf(traces),
  });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

async function elapsedMs(work: () => Promise<unknown>): Promise<number> {
  const started = process.hrtime.bigint();
  await work();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

describe("mining performance", () => {
  it("mines the seeded demo dataset well inside a second", async () => {
    const traces = Array.from({ length: 20 }, (_, index) => traceOf(index + 1));

    const elapsed = await elapsedMs(() => mine(traces));

    expect(elapsed).toBeLessThan(1_000);
  });

  it("mines a thousand runs of one route within ten seconds", async () => {
    const traces = Array.from({ length: 1_000 }, (_, index) => traceOf(index + 1));

    const elapsed = await elapsedMs(async () => {
      const mined = await mine(traces);
      expect(mined.baseline.counts.eligibleRuns).toBe(1_000);
      expect(mined.baseline.counts.routeFamilies).toBe(1);
    });

    expect(elapsed).toBeLessThan(10_000);
  }, 30_000);

  it("mines five hundred distinct route families within ten seconds", async () => {
    const traces = Array.from({ length: 500 }, (_, index) => distinctFamilyTrace(index + 1));

    const elapsed = await elapsedMs(async () => {
      const mined = await mine(traces);
      expect(mined.baseline.counts.routeFamilies).toBe(500);
    });

    expect(elapsed).toBeLessThan(10_000);
  }, 30_000);

  it("mines a run carrying a thousand spans within two seconds", async () => {
    // #given one wide run, which is the shape PRD section 20.2's canonicalisation target describes
    const wide = wideTraceRows(999, "wide00000000000000000000000000001").map((row) => ({
      ...row,
      "agent.release.id": "refund-agent-v1",
      "agent.run.id": "run_wide000000000001",
    }));

    const elapsed = await elapsedMs(async () => {
      const mined = await mine([
        {
          traceId: "wide00000000000000000000000000001",
          rows: wide,
          webUrl: null,
          untrustedFields: [],
        },
      ]);
      expect(mined.baseline.counts.eligibleRuns).toBe(1);
    });

    expect(elapsed).toBeLessThan(2_000);
  }, 30_000);

  it("proposes and emits a contract for the demo dataset within a second", async () => {
    const mined = await mine(Array.from({ length: 20 }, (_, index) => traceOf(index + 1)));
    const decided = applyRouteDecisions(
      mined.baseline,
      mined.baseline.families.map((family) => ({
        fingerprint: family.fingerprint,
        decision: "approve" as const,
      })),
    );
    if (!decided.ok) throw new Error("expected the approval to be recorded");

    const elapsed = await elapsedMs(async () => {
      const proposal = proposeContract({
        baseline: decided.baseline,
        runsByFingerprint: mined.runsByFingerprint,
        options: {
          createdAt: "2026-07-25T00:00:00Z",
          environment: "production",
          workflowName: "refund-workflow",
        },
      });
      if (!proposal.ok) throw new Error(JSON.stringify(proposal.errors));
      const emitted = emitContractYaml(proposal.proposal);
      expect(emitted.ok).toBe(true);
    });

    expect(elapsed).toBeLessThan(1_000);
  });

  it("refuses a proposal larger than it will emit, rather than emitting an unusable one", async () => {
    // #given a route with more distinct steps than a proposal will carry rules for
    const traceId = "wide00000000000000000000000000002";
    const wide = wideTraceRows(1, traceId).map((row) => ({
      ...row,
      "agent.release.id": "refund-agent-v1",
      "agent.run.id": "run_wide000000000002",
    }));
    const root = wide.find((row) => row["parent_span_id"] === "") as Record<string, unknown>;
    // Alphabetic suffixes, not numeric ones: the normaliser replaces an all-digit path segment with a
    // placeholder by design, so `step.1` and `step.2` are one canonical label and would collapse into
    // one rule.
    const suffix = (index: number): string =>
      `${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`;
    for (let index = 0; index < TEXT_LIMITS.maxProposedRules + 20; index += 1) {
      wide.push({
        ...root,
        span_id: `step${String(index).padStart(12, "0")}`,
        parent_span_id: root["span_id"],
        name: `distinct.step.${suffix(index)}`,
        kind_string: "Client",
        "gen_ai.tool.name": `tool.${suffix(index)}`,
        "gen_ai.operation.name": "execute_tool",
        "agent.side_effect": "read",
        "agent.retry.number": 0,
      });
    }

    const mined = await mine([{ traceId, rows: wide, webUrl: null, untrustedFields: [] }]);
    const decided = applyRouteDecisions(
      mined.baseline,
      mined.baseline.families.map((family) => ({
        fingerprint: family.fingerprint,
        decision: "approve" as const,
      })),
    );
    if (!decided.ok) throw new Error("expected the approval to be recorded");

    const proposal = proposeContract({
      baseline: decided.baseline,
      runsByFingerprint: mined.runsByFingerprint,
      options: {
        createdAt: "2026-07-25T00:00:00Z",
        environment: "production",
        workflowName: "refund-workflow",
      },
    });

    expect(proposal.ok).toBe(false);
    if (proposal.ok) return;
    expect(proposal.errors[0]?.code).toBe("TOO_MANY_RULES");
  }, 30_000);
});

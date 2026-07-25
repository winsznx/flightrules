import {
  approvedRefundRows,
  knownGoodTrace,
  renumberTrace,
  rowsOf,
} from "@flightrules/test-fixtures";
import { describe, expect, it } from "vitest";
import { applyRouteDecisions, approvedFingerprints, ROUTE_FAMILY_DECISIONS } from "./decisions.js";
import type { RetrievedTrace } from "./eligibility.js";
import { type MinedBaseline, mineBaseline, type TraceSource } from "./mine.js";
import { approvedRouteInputs } from "./model.js";

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
      startedAtUtc: new Date(BASE_MS + index * 60_000).toISOString(),
      rootDurationNano: (30 + (index % 5)) * 1_000_000,
    }),
    webUrl: null,
    untrustedFields: [],
  };
}

function sourceOf(traces: readonly RetrievedTrace[], truncated = false): TraceSource {
  return {
    verifyFieldTypes: async () => ({
      ok: true,
      report: { verified: ["trace_id"], unverified: [], mismatched: [] },
    }),
    discover: async () => ({
      ok: true,
      dataset: { traceIds: traces.map((trace) => trace.traceId), pages: 1, truncated },
    }),
    fetch: async () => ({ traces, failures: [] }),
  };
}

async function mined(input: {
  readonly traces: readonly RetrievedTrace[];
  readonly minimumRuns?: number;
  readonly truncated?: boolean;
}): Promise<MinedBaseline> {
  const result = await mineBaseline({
    selection: {
      projectKey: "demo-commerce",
      agentKey: "refund-agent",
      releaseId: "refund-agent-v1",
      environment: null,
      startMs: BASE_MS - 3_600_000,
      endMs: BASE_MS + 86_400_000,
      minimumRuns: input.minimumRuns ?? 1,
      rootSpanName: "refund.request",
    },
    source: sourceOf(input.traces, input.truncated ?? false),
  });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

describe("reviewing route families", () => {
  it("starts every family pending, so nothing is approved by mining alone", async () => {
    const { baseline } = await mined({ traces: [traceOf(1), traceOf(2)] });

    expect(baseline.families.every((family) => family.status === "pending")).toBe(true);
    expect(baseline.status).toBe("pending_review");
    expect(approvedFingerprints(baseline)).toEqual([]);
  });

  it("approves the named family and leaves the rest untouched", async () => {
    const { baseline } = await mined({
      traces: [traceOf(1), traceOf(2), traceOf(90, approvedRefundRows({ remove: ["c4calcul"] }))],
    });
    const target = baseline.families[0]?.fingerprint as string;

    const result = applyRouteDecisions(baseline, [{ fingerprint: target, decision: "approve" }]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.baseline.status).toBe("approved");
    expect(approvedFingerprints(result.baseline)).toEqual([target]);
    expect(result.baseline.families.filter((family) => family.status === "pending")).toHaveLength(
      1,
    );
  });

  it("records every action PRD section 8.8 offers", async () => {
    const { baseline } = await mined({
      traces: [
        traceOf(1),
        traceOf(90, approvedRefundRows({ remove: ["c4calcul"] })),
        traceOf(91, approvedRefundRows({ remove: ["c6notify", "s6notify"] })),
        traceOf(92, approvedRefundRows({ remove: ["c2order0", "s2order0"] })),
      ],
    });

    const decisions = baseline.families.map((family, index) => ({
      fingerprint: family.fingerprint,
      decision: ROUTE_FAMILY_DECISIONS[index] as (typeof ROUTE_FAMILY_DECISIONS)[number],
    }));

    const result = applyRouteDecisions(baseline, decisions);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.baseline.families.map((family) => family.status).sort()).toEqual([
      "approved",
      "excluded_fixture_error",
      "optional",
      "rejected",
    ]);
  });

  it("returns to pending review when no family is approved", async () => {
    const { baseline } = await mined({ traces: [traceOf(1)] });

    const result = applyRouteDecisions(baseline, [
      { fingerprint: baseline.families[0]?.fingerprint as string, decision: "reject" },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.baseline.status).toBe("pending_review");
  });

  it("rejects a decision naming a family this baseline does not have", async () => {
    const { baseline } = await mined({ traces: [traceOf(1)] });

    const result = applyRouteDecisions(baseline, [
      { fingerprint: "0".repeat(64), decision: "approve" },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("UNKNOWN_FAMILY");
  });

  it("rejects two decisions for one family in the same request", async () => {
    const { baseline } = await mined({ traces: [traceOf(1)] });
    const fingerprint = baseline.families[0]?.fingerprint as string;

    const result = applyRouteDecisions(baseline, [
      { fingerprint, decision: "approve" },
      { fingerprint, decision: "reject" },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("DUPLICATE_DECISION");
  });

  it("refuses to review a baseline with too few runs", async () => {
    const { baseline } = await mined({ traces: [traceOf(1)], minimumRuns: 20 });

    expect(baseline.status).toBe("insufficient_runs");

    const result = applyRouteDecisions(baseline, [
      { fingerprint: baseline.families[0]?.fingerprint as string, decision: "approve" },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("BASELINE_NOT_REVIEWABLE");
    expect(result.errors[0]?.message).toContain("at least 20");
  });

  it("refuses to review a baseline whose dataset was truncated", async () => {
    const { baseline } = await mined({ traces: [traceOf(1)], truncated: true });

    expect(baseline.status).toBe("dataset_truncated");

    const result = applyRouteDecisions(baseline, [
      { fingerprint: baseline.families[0]?.fingerprint as string, decision: "approve" },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("BASELINE_NOT_REVIEWABLE");
  });

  it("leaves the original baseline unchanged, so a review is a new value", async () => {
    const { baseline } = await mined({ traces: [traceOf(1)] });

    applyRouteDecisions(baseline, [
      { fingerprint: baseline.families[0]?.fingerprint as string, decision: "approve" },
    ]);

    expect(baseline.families[0]?.status).toBe("pending");
    expect(baseline.status).toBe("pending_review");
  });

  it("hands the approved families to the evaluator as bare fingerprints", async () => {
    const { baseline } = await mined({ traces: [traceOf(1)] });
    const result = applyRouteDecisions(baseline, [
      { fingerprint: baseline.families[0]?.fingerprint as string, decision: "approve" },
    ]);
    if (!result.ok) throw new Error("expected the decision to be recorded");

    const routes = approvedRouteInputs(result.baseline);

    expect(routes).toHaveLength(1);
    // #then no `sha256:` prefix, which is the form the evaluator compares against
    expect(routes[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(routes[0]?.canonical.nodes.length).toBeGreaterThan(0);
  });

  it("hands over nothing when no family is approved", async () => {
    const { baseline } = await mined({ traces: [traceOf(1)] });

    expect(approvedRouteInputs(baseline)).toEqual([]);
  });
});

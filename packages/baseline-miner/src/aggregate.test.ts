import {
  approvedRefundRows,
  knownGoodTrace,
  renumberTrace,
  rowsOf,
} from "@flightrules/test-fixtures";
import { describe, expect, it } from "vitest";
import { aggregateApproved, PROPOSAL_ATTRIBUTES } from "./aggregate.js";
import { applyRouteDecisions, type RouteFamilyDecisionKind } from "./decisions.js";
import type { RetrievedTrace } from "./eligibility.js";
import { mineBaseline, type TraceSource } from "./mine.js";
import type { BaselineVersion, EligibleRun } from "./model.js";
import { ONE_RATIO, ratioFromDecimal } from "./statistics.js";

const KNOWN_GOOD = rowsOf(knownGoodTrace());
const BASE_MS = Date.parse("2026-07-25T10:00:00Z");
const OPTIONS = { requiredSupport: ONE_RATIO, rareThreshold: ratioFromDecimal(0.05) };

function traceOf(
  index: number,
  rows: readonly Record<string, unknown>[] = KNOWN_GOOD,
  durationMs = 30,
): RetrievedTrace {
  const traceId = `t${String(index).padStart(31, "0")}`;
  return {
    traceId,
    rows: renumberTrace(rows, {
      traceId,
      runId: `run_${String(index).padStart(20, "0")}`,
      startedAtUtc: new Date(BASE_MS + index * 60_000).toISOString(),
      rootDurationNano: durationMs * 1_000_000,
    }),
    webUrl: null,
    untrustedFields: [],
  };
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

/** Mines, then approves every family unless a decision map says otherwise. */
async function approvedBaseline(
  traces: readonly RetrievedTrace[],
  decisionFor: (index: number) => RouteFamilyDecisionKind = () => "approve",
): Promise<{
  readonly baseline: BaselineVersion;
  readonly runsByFingerprint: ReadonlyMap<string, readonly EligibleRun[]>;
}> {
  const result = await mineBaseline({
    selection: {
      projectKey: "demo-commerce",
      agentKey: "refund-agent",
      releaseId: "refund-agent-v1",
      environment: null,
      startMs: BASE_MS - 3_600_000,
      endMs: BASE_MS + 86_400_000,
      minimumRuns: 1,
      rootSpanName: "refund.request",
    },
    source: sourceOf(traces),
  });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));

  const decided = applyRouteDecisions(
    result.value.baseline,
    result.value.baseline.families.map((family, index) => ({
      fingerprint: family.fingerprint,
      decision: decisionFor(index),
    })),
  );
  if (!decided.ok) throw new Error(JSON.stringify(decided.errors));

  return { baseline: decided.baseline, runsByFingerprint: result.value.runsByFingerprint };
}

function aggregate(
  input: Awaited<ReturnType<typeof approvedBaseline>>,
  minimumBudgetObservations = 1,
) {
  return aggregateApproved({
    approved: input.baseline.families.filter((family) => family.status === "approved"),
    runsByFingerprint: input.runsByFingerprint,
    options: OPTIONS,
    minimumBudgetObservations,
  });
}

describe("aggregating the approved families", () => {
  it("classifies a step present in every run as always observed", async () => {
    const result = aggregate(await approvedBaseline([traceOf(1), traceOf(2), traceOf(3)]));
    const fraud = result.labels.find((label) => label.label === "fraud.check");

    expect(fraud?.presenceClass).toBe("always");
    expect(fraud?.presence.decimal).toBe("1.000000");
    expect(fraud?.observableRuns).toBe(3);
    expect(fraud?.cardinality.min).toBe(1);
    expect(fraud?.cardinality.max).toBe(1);
  });

  it("classifies a step missing from one approved family as optional", async () => {
    // #given two approved families, one of which skipped the fraud check
    const input = await approvedBaseline([
      traceOf(1),
      traceOf(2),
      traceOf(90, approvedRefundRows({ remove: ["c3fraud0", "s3fraud0"] })),
    ]);

    const fraud = aggregate(input).labels.find((label) => label.label === "fraud.check");

    expect(fraud?.presenceClass).toBe("optional");
    expect(fraud?.presence).toEqual({ numerator: 2, denominator: 3, decimal: "0.666666" });
    expect(fraud?.cardinality.min).toBe(0);
  });

  it("reports a step present in a small minority as rare rather than merely optional", async () => {
    const traces = [
      ...Array.from({ length: 25 }, (_, index) =>
        traceOf(index + 1, approvedRefundRows({ remove: ["c3fraud0", "s3fraud0"] })),
      ),
      traceOf(90),
    ];

    const fraud = aggregate(await approvedBaseline(traces)).labels.find(
      (label) => label.label === "fraud.check",
    );

    expect(fraud?.presenceClass).toBe("rare");
  });

  it("counts a step twice in a run that performed it twice", async () => {
    // #given one family that issues the refund twice
    const duplicated = approvedRefundRows({
      add: [
        {
          name: "payment.refund",
          spanId: "c5paymnt2",
          parentSpanId: "root0000",
          tool: "issue_refund",
          operation: "execute_tool",
          sideEffect: "write",
          dataDomain: "payments",
          retry: 1,
          idempotencyPresent: true,
        },
      ],
    });

    const payment = aggregate(await approvedBaseline([traceOf(1, duplicated)])).labels.find(
      (label) => label.label === "payment.refund",
    );

    expect(payment?.cardinality.max).toBe(2);
    expect(payment?.presenceClass).toBe("always");
  });

  it("weights a rare family's cardinality by its own run count", async () => {
    // #given twenty single-refund runs and one that refunded twice
    const duplicated = approvedRefundRows({
      add: [
        {
          name: "payment.refund",
          spanId: "c5paymnt2",
          parentSpanId: "root0000",
          tool: "issue_refund",
          operation: "execute_tool",
          sideEffect: "write",
          dataDomain: "payments",
          retry: 1,
          idempotencyPresent: true,
        },
      ],
    });
    const traces = [
      ...Array.from({ length: 20 }, (_, index) => traceOf(index + 1)),
      traceOf(90, duplicated),
    ];

    const payment = aggregate(await approvedBaseline(traces)).labels.find(
      (label) => label.label === "payment.refund",
    );

    // #then the maximum sees the outlier while the 95th percentile does not
    expect(payment?.cardinality.max).toBe(2);
    expect(payment?.cardinality.p95).toBe(1);
    expect(payment?.cardinality.count).toBe(21);
  });

  it("does not count an absence inside an unobservable subtree as an absence", async () => {
    // #given a family whose remote write call has no exported handler span, and one that has it
    const input = await approvedBaseline([
      traceOf(1),
      traceOf(2),
      traceOf(90, approvedRefundRows({ remove: ["s5paymnt"] })),
    ]);

    const handler = aggregate(input).labels.find(
      (label) => label.label === "payment.refund.handler",
    );

    // #then the run that could not observe it is excluded from the denominator rather than counted
    // as a run in which the handler did not happen
    expect(handler?.unobservableRuns).toBe(1);
    expect(handler?.observableRuns).toBe(2);
    expect(handler?.presenceClass).toBe("always");
    expect(handler?.presence.decimal).toBe("1.000000");
  });

  it("still proves a genuine absence elsewhere in a run with an unobservable subtree", async () => {
    // #given a family that both lost its payment handler span and skipped the fraud check
    const input = await approvedBaseline([
      traceOf(1),
      traceOf(90, approvedRefundRows({ remove: ["s5paymnt", "c3fraud0", "s3fraud0"] })),
    ]);

    const result = aggregate(input);
    const fraud = result.labels.find((label) => label.label === "fraud.check");
    const handler = result.labels.find((label) => label.label === "payment.refund.handler");

    // #then the uncertainty is local: the handler is undecidable in that run, the fraud check is not
    expect(handler?.unobservableRuns).toBe(1);
    expect(fraud?.unobservableRuns).toBe(0);
    expect(fraud?.presenceClass).toBe("optional");
  });

  it("marks a Server label under a Client label as a remote handler", async () => {
    const result = aggregate(await approvedBaseline([traceOf(1)]));

    expect(
      result.labels.find((label) => label.label === "payment.refund.handler")?.remoteHandler,
    ).toBe(true);
    expect(result.labels.find((label) => label.label === "payment.refund")?.remoteHandler).toBe(
      false,
    );
    expect(result.labels.find((label) => label.label === "refund.request")?.remoteHandler).toBe(
      false,
    );
  });

  it("reports an attribute every span of a label agreed on", async () => {
    const result = aggregate(await approvedBaseline([traceOf(1), traceOf(2)]));
    const payment = result.labels.find((label) => label.label === "payment.refund");

    expect(payment?.attributes).toEqual([
      {
        key: "agent.idempotency.present",
        value: true,
        carryingSpans: 2,
        totalSpans: 2,
        support: { numerator: 2, denominator: 2, decimal: "1.000000" },
      },
    ]);
  });

  it("reports partial agreement rather than collapsing it into one claim", async () => {
    // #given one run whose refund carried no idempotency key
    const missing = approvedRefundRows({
      replace: [
        {
          name: "payment.refund",
          spanId: "c5paymnt",
          parentSpanId: "root0000",
          tool: "issue_refund",
          operation: "execute_tool",
          sideEffect: "write",
          dataDomain: "payments",
          retry: 0,
          idempotencyPresent: false,
        },
      ],
    });

    const result = aggregate(await approvedBaseline([traceOf(1), traceOf(90, missing)]));
    const payment = result.labels.find((label) => label.label === "payment.refund");

    expect(payment?.attributes.map((entry) => entry.value).sort()).toEqual([false, true]);
    expect(payment?.attributes.every((entry) => entry.support.decimal === "0.500000")).toBe(true);
  });

  it("reads only the allowlisted evidence attributes", () => {
    // A denylist would admit every attribute a future service adds; this is the closed set.
    expect([...PROPOSAL_ATTRIBUTES]).toEqual(["agent.idempotency.present"]);
  });

  it("aggregates retries by the evaluator's own grouping and reports the run total", async () => {
    const result = aggregate(await approvedBaseline([traceOf(1), traceOf(2)]));

    expect(result.retries.map((entry) => entry.group)).toContain("issue_refund");
    expect(result.retries.every((entry) => entry.maxRetry.max === 0)).toBe(true);
    expect(result.retryRunTotal?.max).toBe(0);
    expect(result.retrySideEffectMax?.max).toBe(0);
  });

  it("reports the operations a retried step ran under, for the retry-budget selector", async () => {
    const result = aggregate(await approvedBaseline([traceOf(1)]));
    const refund = result.retries.find((entry) => entry.group === "issue_refund");

    expect(refund?.operations).toEqual(["execute_tool"]);
  });

  it("sees a retried side effect when one happened", async () => {
    const retried = approvedRefundRows({
      add: [
        {
          name: "payment.refund",
          spanId: "c5paymnt2",
          parentSpanId: "root0000",
          tool: "issue_refund",
          operation: "execute_tool",
          sideEffect: "write",
          dataDomain: "payments",
          retry: 1,
          idempotencyPresent: true,
        },
      ],
    });

    const result = aggregate(await approvedBaseline([traceOf(1, retried)]));

    expect(result.retrySideEffectMax?.max).toBe(1);
    expect(result.retries.find((entry) => entry.group === "issue_refund")?.maxRetry.max).toBe(1);
  });

  it("makes the duration budget available from the runs' own durations", async () => {
    const result = aggregate(
      await approvedBaseline([traceOf(1, KNOWN_GOOD, 20), traceOf(2, KNOWN_GOOD, 40)]),
    );

    expect(result.duration.available).toBe(true);
    if (!result.duration.available) return;
    expect(result.duration.distribution.min).toBe(20);
    expect(result.duration.distribution.max).toBe(40);
    expect(result.duration.coverage.decimal).toBe("1.000000");
  });

  it("reports a token budget as not emitted rather than as zero", async () => {
    const result = aggregate(await approvedBaseline([traceOf(1), traceOf(2)]));

    expect(result.outputTokens.available).toBe(false);
    if (result.outputTokens.available) return;
    expect(result.outputTokens.reason).toBe("ATTRIBUTE_NOT_EMITTED");
    expect(result.outputTokens.observedRuns).toBe(0);
    expect(result.outputTokens.totalRuns).toBe(2);
  });

  it("reports too few observations rather than proposing from one sample", async () => {
    const withTokens = KNOWN_GOOD.map((row) =>
      row["name"] === "refund.request" ? { ...row, "gen_ai.usage.output_tokens": 100 } : row,
    );

    const result = aggregate(await approvedBaseline([traceOf(1, withTokens), traceOf(2)]), 2);

    expect(result.outputTokens.available).toBe(false);
    if (result.outputTokens.available) return;
    expect(result.outputTokens.reason).toBe("INSUFFICIENT_OBSERVATIONS");
    expect(result.outputTokens.observedRuns).toBe(1);
  });

  it("treats an explicit zero token count as an observation", async () => {
    const zeroTokens = KNOWN_GOOD.map((row) =>
      row["name"] === "refund.request" ? { ...row, "gen_ai.usage.output_tokens": 0 } : row,
    );

    const result = aggregate(await approvedBaseline([traceOf(1, zeroTokens)]));

    expect(result.outputTokens.available).toBe(true);
    if (!result.outputTokens.available) return;
    expect(result.outputTokens.distribution.max).toBe(0);
  });

  it("ignores a Query Builder null caused by an omitted dataType rather than reading it as zero", async () => {
    // #given the SL-046 shape: the column is present and null because the query resolved the wrong
    // type, exactly as a genuinely unset attribute looks
    const nulled = KNOWN_GOOD.map((row) => ({ ...row, "gen_ai.usage.output_tokens": null }));

    const result = aggregate(await approvedBaseline([traceOf(1, nulled)]));

    expect(result.outputTokens.available).toBe(false);
    if (result.outputTokens.available) return;
    expect(result.outputTokens.reason).toBe("ATTRIBUTE_NOT_EMITTED");
  });

  it("aggregates nothing but reports no crash when no family is approved", async () => {
    const input = await approvedBaseline([traceOf(1)], () => "reject");

    const result = aggregate(input);

    expect(result.approvedRuns).toBe(0);
    expect(result.labels).toEqual([]);
    expect(result.duration.available).toBe(false);
  });

  it("unions the tools, services and data domains of every approved family", async () => {
    const result = aggregate(await approvedBaseline([traceOf(1)]));

    expect(result.tools).toEqual([
      "calculate_refund",
      "check_fraud",
      "issue_refund",
      "lookup_order",
      "notify_customer",
      "retrieve_policy",
    ]);
    expect(result.services).toContain("flightrules-payment-service");
    expect(result.dataDomains).toContain("payments");
  });

  it("produces the same aggregate whatever order the runs arrive in", async () => {
    const traces = Array.from({ length: 6 }, (_, index) =>
      traceOf(index + 1, KNOWN_GOOD, 20 + index),
    );

    const forward = aggregate(await approvedBaseline(traces));
    const reversed = aggregate(await approvedBaseline([...traces].reverse()));

    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });
});

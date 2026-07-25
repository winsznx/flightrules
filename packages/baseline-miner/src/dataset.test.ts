import { DEFAULT_NORMALISER_CONFIG, identityOf } from "@flightrules/normaliser";
import { knownGoodTrace, renumberTrace, rowsOf } from "@flightrules/test-fixtures";
import { describe, expect, it } from "vitest";
import { assembleDataset } from "./dataset.js";
import type { EligibilityContext, RetrievedTrace } from "./eligibility.js";
import { resolveSelection } from "./selection.js";

const IDENTITY = identityOf(DEFAULT_NORMALISER_CONFIG);
const KNOWN_GOOD = rowsOf(knownGoodTrace());

const CONTEXT: EligibilityContext = {
  selection: resolveSelection({
    projectKey: "demo-commerce",
    agentKey: "refund-agent",
    releaseId: "refund-agent-v1",
    environment: "local",
    startMs: Date.parse("2026-07-25T00:00:00Z"),
    endMs: Date.parse("2026-07-26T00:00:00Z"),
    minimumRuns: 1,
    rootSpanName: "refund.request",
  }),
  config: DEFAULT_NORMALISER_CONFIG,
  normaliserVersion: IDENTITY.version,
  normaliserConfigHash: IDENTITY.configHash,
};

function run(index: number, runId = `run_${String(index).padStart(20, "0")}`): RetrievedTrace {
  const traceId = `t${String(index).padStart(31, "0")}`;
  return {
    traceId,
    rows: renumberTrace(KNOWN_GOOD, {
      traceId,
      runId,
      startedAtUtc: new Date(Date.parse("2026-07-25T10:00:00Z") + index * 60_000).toISOString(),
      rootDurationNano: (30 + index) * 1_000_000,
    }),
    webUrl: `http://localhost:8080/trace/${traceId}`,
    untrustedFields: [],
  };
}

describe("assembling a mining dataset", () => {
  it("keeps every distinct run and reports counts that reconcile", () => {
    const traces = [run(1), run(2), run(3)];

    const dataset = assembleDataset({
      discoveredTraceIds: traces.map((trace) => trace.traceId),
      traces,
      context: CONTEXT,
    });

    expect(dataset.eligible).toHaveLength(3);
    expect(dataset.excluded).toHaveLength(0);
    expect(dataset.tracesDiscovered).toBe(3);
    expect(dataset.tracesRetrieved).toBe(3);
    expect(dataset.excludedByReason).toEqual([]);
  });

  it("does not double-count a trace identifier discovery returned twice", () => {
    // #given a page boundary that returned one trace on both pages
    const traces = [run(1), run(2)];

    const dataset = assembleDataset({
      discoveredTraceIds: [
        traces[0]?.traceId as string,
        traces[1]?.traceId as string,
        traces[0]?.traceId as string,
      ],
      traces,
      context: CONTEXT,
    });

    expect(dataset.eligible).toHaveLength(2);
    expect(dataset.duplicateTraces).toBe(1);
    expect(dataset.excluded.map((entry) => entry.reason)).toEqual(["DUPLICATE_TRACE"]);
    expect(dataset.tracesDiscovered).toBe(3);
    expect(dataset.tracesRetrieved).toBe(2);
  });

  it("collapses two traces reporting one run, keeping the smaller trace identifier", () => {
    // #given the same logical run retrieved under two trace identifiers
    const shared = "run_00000000000000000042";
    const traces = [run(9, shared), run(4, shared)];

    const dataset = assembleDataset({
      discoveredTraceIds: traces.map((trace) => trace.traceId),
      traces,
      context: CONTEXT,
    });

    expect(dataset.eligible).toHaveLength(1);
    expect(dataset.eligible[0]?.traceId).toBe(run(4).traceId);
    expect(dataset.duplicateRuns).toBe(1);
    expect(dataset.excluded[0]?.reason).toBe("DUPLICATE_RUN");
  });

  it("keeps two distinct runs that operated on the same order", () => {
    // #given two runs refunding one order, which the demo does on purpose
    const traces = [run(1), run(2)];
    for (const trace of traces) {
      for (const row of trace.rows as Record<string, unknown>[])
        row["agent.order.id"] = "ord-98271";
    }

    const dataset = assembleDataset({
      discoveredTraceIds: traces.map((trace) => trace.traceId),
      traces,
      context: CONTEXT,
    });

    // #then both survive: deduplication is by run, never by business object
    expect(dataset.eligible).toHaveLength(2);
    expect(dataset.duplicateRuns).toBe(0);
  });

  it("records a discovered trace whose spans could not be fetched", () => {
    const traces = [run(1)];

    const dataset = assembleDataset({
      discoveredTraceIds: [traces[0]?.traceId as string, "tmissing0000000000000000000000000"],
      traces,
      context: CONTEXT,
    });

    expect(dataset.eligible).toHaveLength(1);
    expect(dataset.excludedByReason).toEqual([{ reason: "TRACE_FETCH_FAILED", count: 1 }]);
    expect(dataset.tracesDiscovered).toBe(2);
    expect(dataset.tracesRetrieved).toBe(1);
  });

  it("classifies only what discovery named, so an undiscovered trace cannot enter a denominator", () => {
    const traces = [run(1), run(2)];

    const dataset = assembleDataset({
      discoveredTraceIds: [traces[0]?.traceId as string],
      traces,
      context: CONTEXT,
    });

    expect(dataset.eligible).toHaveLength(1);
    expect(dataset.tracesDiscovered).toBe(1);
  });

  it("produces the same dataset whatever order the traces arrive in", () => {
    const traces = [run(1), run(2), run(3), run(4)];
    const ids = traces.map((trace) => trace.traceId);

    const forward = assembleDataset({ discoveredTraceIds: ids, traces, context: CONTEXT });
    const reversed = assembleDataset({
      discoveredTraceIds: [...ids].reverse(),
      traces: [...traces].reverse(),
      context: CONTEXT,
    });

    expect(reversed.eligible.map((entry) => entry.traceId)).toEqual(
      forward.eligible.map((entry) => entry.traceId),
    );
    expect(reversed.eligible.map((entry) => entry.fingerprint)).toEqual(
      forward.eligible.map((entry) => entry.fingerprint),
    );
  });

  it("sorts exclusions by reason then trace identifier, and tallies each reason once", () => {
    const good = run(1);
    const wrongRelease: RetrievedTrace = {
      ...run(2),
      rows: run(2).rows.map((row) => ({ ...row, "agent.release.id": "refund-agent-v2" })),
    };
    const noRun: RetrievedTrace = {
      ...run(3),
      rows: run(3).rows.map((row) => {
        const copy = { ...row };
        delete copy["agent.run.id"];
        return copy;
      }),
    };

    const traces = [good, wrongRelease, noRun];
    const dataset = assembleDataset({
      discoveredTraceIds: traces.map((trace) => trace.traceId),
      traces,
      context: CONTEXT,
    });

    expect(dataset.excluded.map((entry) => entry.reason)).toEqual([
      "RELEASE_MISMATCH",
      "RUN_ID_MISSING",
    ]);
    expect(dataset.excludedByReason).toEqual([
      { reason: "RELEASE_MISMATCH", count: 1 },
      { reason: "RUN_ID_MISSING", count: 1 },
    ]);
    expect(dataset.eligible).toHaveLength(1);
  });

  it("produces an empty dataset without failing when nothing is eligible", () => {
    const wrongRelease: RetrievedTrace = {
      ...run(1),
      rows: run(1).rows.map((row) => ({ ...row, "agent.release.id": "refund-agent-v2" })),
    };

    const dataset = assembleDataset({
      discoveredTraceIds: [wrongRelease.traceId],
      traces: [wrongRelease],
      context: CONTEXT,
    });

    expect(dataset.eligible).toHaveLength(0);
    expect(dataset.excluded).toHaveLength(1);
  });

  it("retains the SigNoz deep link on an eligible run", () => {
    const traces = [run(1)];
    const dataset = assembleDataset({
      discoveredTraceIds: [traces[0]?.traceId as string],
      traces,
      context: CONTEXT,
    });

    expect(dataset.eligible[0]?.webUrl).toContain("/trace/");
  });
});

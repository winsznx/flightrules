import { DEFAULT_NORMALISER_CONFIG, identityOf } from "@flightrules/normaliser";
import {
  approvedRefundRows,
  knownGoodTrace,
  renumberTrace,
  rowsOf,
} from "@flightrules/test-fixtures";
import { buildTraceGraph } from "@flightrules/trace-graph";
import { describe, expect, it } from "vitest";
import { classifyTrace, type EligibilityContext, type RetrievedTrace } from "./eligibility.js";
import { EXCLUSION_REASONS } from "./model.js";
import { resolveSelection } from "./selection.js";

/**
 * Eligibility is decided over real captured telemetry wherever the case exists in it, and over built
 * rows only for the topologies the demo legitimately never emits.
 */

const IDENTITY = identityOf(DEFAULT_NORMALISER_CONFIG);

function context(
  overrides: Partial<Parameters<typeof resolveSelection>[0]> = {},
): EligibilityContext {
  return {
    selection: resolveSelection({
      projectKey: "demo-commerce",
      agentKey: "refund-agent",
      releaseId: "refund-agent-v1",
      environment: "local",
      startMs: Date.parse("2026-07-25T00:00:00Z"),
      endMs: Date.parse("2026-07-26T00:00:00Z"),
      minimumRuns: 1,
      rootSpanName: "refund.request",
      ...overrides,
    }),
    config: DEFAULT_NORMALISER_CONFIG,
    normaliserVersion: IDENTITY.version,
    normaliserConfigHash: IDENTITY.configHash,
  };
}

function trace(
  rows: readonly Record<string, unknown>[],
  overrides: Partial<RetrievedTrace> = {},
): RetrievedTrace {
  return {
    traceId: String(rows[0]?.["trace_id"] ?? "unknown"),
    rows,
    webUrl: null,
    untrustedFields: [],
    ...overrides,
  };
}

const KNOWN_GOOD = rowsOf(knownGoodTrace());

describe("classifying a retrieved trace", () => {
  it("accepts a complete known-good trace and records its run identity", () => {
    // #given the captured v1 trace
    const outcome = classifyTrace(trace(KNOWN_GOOD), context());

    // #then it is eligible, with the run identifier read from the rows rather than from the graph
    expect(outcome.eligible).toBe(true);
    if (!outcome.eligible) return;
    expect(outcome.run.releaseId).toBe("refund-agent-v1");
    expect(outcome.run.runId).toMatch(/^run_/);
    expect(outcome.run.environment).toBe("local");
    expect(outcome.run.fingerprint).toHaveLength(64);
    expect(outcome.run.durationMs).toBeGreaterThan(0);
  });

  it("excludes an incomplete trace, because an absence observed in it proves nothing", () => {
    // #given a trace whose root span was never exported, leaving its children orphaned
    const orphaned = KNOWN_GOOD.filter((row) => row["name"] !== "refund.request");

    const outcome = classifyTrace(trace(orphaned), context());

    expect(outcome.eligible).toBe(false);
    if (outcome.eligible) return;
    expect(outcome.reason).toBe("TRACE_INCOMPLETE");
    expect(outcome.graph?.quality).toBe("incomplete");
  });

  it("excludes an inconsistent trace whose duplicate records disagree", () => {
    // #given two records for one span that disagree on its parent
    const first = KNOWN_GOOD.find((row) => row["name"] === "fraud.check") as Record<
      string,
      unknown
    >;
    const contradiction = { ...first, parent_span_id: "0000000000000000" };

    const outcome = classifyTrace(trace([...KNOWN_GOOD, contradiction]), context());

    expect(outcome.eligible).toBe(false);
    if (outcome.eligible) return;
    expect(outcome.reason).toBe("TRACE_INCONSISTENT");
  });

  it("excludes a malformed row set that cannot become a graph at all", () => {
    const outcome = classifyTrace(trace([{ trace_id: "abc" }]), context());

    expect(outcome.eligible).toBe(false);
    if (outcome.eligible) return;
    expect(outcome.reason).toBe("TRACE_MALFORMED");
  });

  it("excludes a trace larger than the configured span maximum", () => {
    const outcome = classifyTrace(trace(KNOWN_GOOD), context({ maxSpansPerTrace: 3 }));

    expect(outcome.eligible).toBe(false);
    if (outcome.eligible) return;
    expect(outcome.reason).toBe("TRACE_TOO_LARGE");
    expect(outcome.spanCount).toBe(KNOWN_GOOD.length);
  });

  it("excludes a trace with no span matching the root selector when the toggle asks for it", () => {
    const outcome = classifyTrace(trace(KNOWN_GOOD), context({ rootSpanName: "checkout.request" }));

    expect(outcome.eligible).toBe(false);
    if (outcome.eligible) return;
    expect(outcome.reason).toBe("ROOT_SPAN_MISSING");
  });

  it("accepts a trace with no root-selector match when the toggle is off", () => {
    const outcome = classifyTrace(
      trace(KNOWN_GOOD),
      context({ rootSpanName: "checkout.request", excludeMissingRootSpan: false }),
    );

    expect(outcome.eligible).toBe(true);
  });

  it("excludes a trace carrying no release identifier", () => {
    const stripped = KNOWN_GOOD.map((row) => {
      const copy = { ...row };
      delete copy["agent.release.id"];
      return copy;
    });

    const outcome = classifyTrace(trace(stripped), context());

    expect(outcome.eligible).toBe(false);
    if (outcome.eligible) return;
    expect(outcome.reason).toBe("RELEASE_ID_MISSING");
  });

  it("excludes a trace belonging to a different release", () => {
    const outcome = classifyTrace(trace(KNOWN_GOOD), context({ releaseId: "refund-agent-v2" }));

    expect(outcome.eligible).toBe(false);
    if (outcome.eligible) return;
    expect(outcome.reason).toBe("RELEASE_MISMATCH");
  });

  it("excludes a trace whose spans report two different releases", () => {
    const mixed = KNOWN_GOOD.map((row, index) =>
      index === 0 ? { ...row, "agent.release.id": "refund-agent-v2" } : row,
    );

    const outcome = classifyTrace(trace(mixed), context());

    expect(outcome.eligible).toBe(false);
    if (outcome.eligible) return;
    expect(outcome.reason).toBe("RELEASE_MISMATCH");
  });

  it("excludes a trace from a different environment", () => {
    const outcome = classifyTrace(trace(KNOWN_GOOD), context({ environment: "staging" }));

    expect(outcome.eligible).toBe(false);
    if (outcome.eligible) return;
    expect(outcome.reason).toBe("ENVIRONMENT_MISMATCH");
  });

  it("ignores the environment when the selection does not constrain it", () => {
    const outcome = classifyTrace(trace(KNOWN_GOOD), context({ environment: null }));

    expect(outcome.eligible).toBe(true);
  });

  it("excludes a trace carrying no run identifier, since it cannot be deduplicated", () => {
    const stripped = KNOWN_GOOD.map((row) => {
      const copy = { ...row };
      delete copy["agent.run.id"];
      return copy;
    });

    const outcome = classifyTrace(trace(stripped), context());

    expect(outcome.eligible).toBe(false);
    if (outcome.eligible) return;
    expect(outcome.reason).toBe("RUN_ID_MISSING");
  });

  it("excludes a trace whose spans report two different runs", () => {
    const mixed = KNOWN_GOOD.map((row, index) =>
      index === 0 ? { ...row, "agent.run.id": "run_other" } : row,
    );

    const outcome = classifyTrace(trace(mixed), context());

    expect(outcome.eligible).toBe(false);
    if (outcome.eligible) return;
    expect(outcome.reason).toBe("RUN_ID_MISSING");
  });

  it("excludes a failed run when the selection asks for successful runs only", () => {
    const failed = KNOWN_GOOD.map((row, index) =>
      index === 2 ? { ...row, has_error: true } : row,
    );

    const outcome = classifyTrace(trace(failed), context());

    expect(outcome.eligible).toBe(false);
    if (outcome.eligible) return;
    expect(outcome.reason).toBe("RUN_NOT_SUCCESSFUL");
  });

  it("keeps a failed run when the toggle permits it", () => {
    const failed = KNOWN_GOOD.map((row, index) =>
      index === 2 ? { ...row, has_error: true } : row,
    );

    expect(classifyTrace(trace(failed), context({ successfulRunsOnly: false })).eligible).toBe(
      true,
    );
  });

  it("excludes a trace whose typed attribute could not be trusted", () => {
    // #given a retrieval that found a bool tag returning a string, the SL-046 failure mode
    const outcome = classifyTrace(
      trace(KNOWN_GOOD, { untrustedFields: ["agent.idempotency.present"] }),
      context(),
    );

    expect(outcome.eligible).toBe(false);
    if (outcome.eligible) return;
    expect(outcome.reason).toBe("UNTRUSTED_TYPED_ATTRIBUTE");
    expect(outcome.detail).toContain("agent.idempotency.present");
  });

  it("excludes a graph fingerprinted under a different normaliser", () => {
    // #given a graph the caller built with a different configuration, so its fingerprint is not
    // comparable with the rest of the dataset
    const foreign = buildTraceGraph(KNOWN_GOOD, {
      config: { ...DEFAULT_NORMALISER_CONFIG, version: "9.9.9" },
      rootSelector: "refund.request",
    });

    const outcome = classifyTrace(trace(KNOWN_GOOD, { graph: foreign }), context());

    expect(outcome.eligible).toBe(false);
    if (outcome.eligible) return;
    expect(outcome.reason).toBe("NORMALISER_VERSION_MISMATCH");
  });

  it("uses a caller-supplied graph rather than rebuilding one", () => {
    const supplied = buildTraceGraph(KNOWN_GOOD, {
      config: DEFAULT_NORMALISER_CONFIG,
      rootSelector: "refund.request",
    });

    const outcome = classifyTrace(trace(KNOWN_GOOD, { graph: supplied }), context());

    expect(outcome.eligible).toBe(true);
    if (!outcome.eligible) return;
    expect(outcome.run.graph).toBe(supplied);
  });

  it("keeps a locally unobservable subtree eligible, because the route it evidences is determined", () => {
    // #given a route where a remote write call has no server span beneath it
    const rows = approvedRefundRows({ remove: ["s5paymnt"] });

    const outcome = classifyTrace(trace(rows), context());

    // #then the trace is still complete and still eligible; the gap is a warning, not a disqualification
    expect(outcome.eligible).toBe(true);
    if (!outcome.eligible) return;
    expect(outcome.run.warnings).toContain("client_span_without_server_span");
  });

  it("renumbering a run does not change its route identity", () => {
    // #given the same behaviour with different identifiers, timestamps and durations
    const original = classifyTrace(trace(KNOWN_GOOD), context());
    const renumbered = classifyTrace(
      trace(
        renumberTrace(KNOWN_GOOD, {
          traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          runId: "run_renumbered0000001",
          startedAtUtc: "2026-07-25T11:11:11.000Z",
          rootDurationNano: 99_000_000,
        }),
      ),
      context(),
    );

    expect(original.eligible && renumbered.eligible).toBe(true);
    if (!original.eligible || !renumbered.eligible) return;
    expect(renumbered.run.fingerprint).toBe(original.run.fingerprint);
    expect(renumbered.run.traceId).not.toBe(original.run.traceId);
    expect(renumbered.run.durationMs).toBe(99);
  });
});

describe("the exclusion vocabulary", () => {
  it("declares every reason the classifier and the assembler can produce", () => {
    // A reason the model does not declare could not be rendered by the UI or queried by the API.
    expect([...EXCLUSION_REASONS]).toEqual([
      "TRACE_MALFORMED",
      "TRACE_TOO_LARGE",
      "TRACE_INCOMPLETE",
      "TRACE_INCONSISTENT",
      "ROOT_SPAN_MISSING",
      "RELEASE_ID_MISSING",
      "RELEASE_MISMATCH",
      "ENVIRONMENT_MISMATCH",
      "RUN_ID_MISSING",
      "RUN_NOT_SUCCESSFUL",
      "TRACE_FETCH_FAILED",
      "DUPLICATE_TRACE",
      "DUPLICATE_RUN",
      "NORMALISER_VERSION_MISMATCH",
      "UNTRUSTED_TYPED_ATTRIBUTE",
    ]);
  });
});

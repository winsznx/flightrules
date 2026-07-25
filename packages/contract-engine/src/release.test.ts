import type { RationalThreshold, TrajectoryContract } from "@flightrules/contract-schema";
import { describe, expect, it } from "vitest";
import {
  type AggregateReleaseInput,
  aggregateRelease,
  hashReleaseEvaluation,
  percentExceeds,
  percentileOfAscending,
  type ReleaseBaselineReference,
  type ReleaseRunRecord,
  toRate,
} from "./release.js";
import type { RunEvaluation, Violation } from "./result.js";
import { EVALUATOR_VERSION } from "./version.js";

/**
 * Release aggregation and the release gate (FR-011, FR-012, PRD sections 10.5 and 11.11).
 *
 * Every expectation here is a hand-computed number, not a value read back from the function under
 * test. The gate is the product's load-bearing claim — a release pipeline fails because of
 * trajectory evidence — so a test that merely asserted internal consistency would prove nothing.
 */

const APPROVED = "sha256:aaaa";
const CONTENT_HASH = "0".repeat(64);

function threshold(text: string): RationalThreshold {
  const [whole, fraction = ""] = text.split(".");
  return {
    numerator: Number.parseInt(`${whole}${fraction}`, 10),
    denominator: 10 ** fraction.length,
    text,
  };
}

function contract(overrides: Partial<TrajectoryContract["spec"]> = {}): TrajectoryContract {
  return {
    apiVersion: "flightrules.dev/v1alpha1",
    kind: "TrajectoryContract",
    metadata: {
      id: "refund-agent-production",
      name: "Refund Agent",
      version: "1.0.0",
      project: "demo-commerce",
      agent: "refund-agent",
      environment: "production",
      createdAt: "2026-07-25T00:00:00Z",
      baselineRelease: "refund-agent-v1",
    },
    spec: {
      selectors: {
        workflowName: "refund-workflow",
        releaseAttribute: "agent.release.id",
        environmentAttribute: "deployment.environment.name",
      },
      approvedRoutes: [APPROVED],
      rules: [],
      gate: {
        minCompletedRuns: 20,
        evaluationTimeoutSeconds: 600,
        maxViolationPercent: threshold("0.5"),
        maxUnknownRoutePercent: threshold("1.0"),
        maxLatencyRegressionPercent: threshold("20"),
        maxTokenRegressionPercent: threshold("25"),
        zeroToleranceRuleIds: ["require-fraud-check"],
      },
      ...overrides,
    },
  } as TrajectoryContract;
}

function violation(overrides: Partial<Violation> = {}): Violation {
  return {
    id: "v-1",
    ruleId: "require-fraud-check",
    ruleType: "required_span",
    code: "REQUIRED_SPAN_MISSING",
    severity: "critical",
    zeroTolerance: true,
    summary: "fraud check missing",
    expected: "at least 1",
    observed: "0",
    evidence: { spanIds: [], canonicalNodes: [], labels: [] },
    ...overrides,
  };
}

function runEvaluation(overrides: Partial<RunEvaluation> = {}): RunEvaluation {
  const violations = overrides.violations ?? [];
  return {
    status: "pass",
    evaluatorVersion: EVALUATOR_VERSION,
    normaliserVersion: "1.0.0",
    normaliserConfigHash: "1".repeat(64),
    contractId: "refund-agent-production",
    contractVersion: "1.0.0",
    contractContentHash: CONTENT_HASH,
    traceId: "trace-a",
    routeFingerprint: APPROVED,
    routeApproved: true,
    nearestApprovedFingerprint: APPROVED,
    similarity: { numerator: 1, denominator: 1, decimal: "1.000000" },
    traceQuality: "complete",
    traceWarnings: [],
    ruleResults: [],
    violations,
    counts: {
      rulesEvaluated: 1,
      rulesPassed: 1,
      rulesViolated: 0,
      rulesInsufficient: 0,
      rulesDeferred: 0,
      violations: violations.length,
      criticalViolations: violations.filter((entry) => entry.severity === "critical").length,
      zeroToleranceViolations: violations.filter((entry) => entry.zeroTolerance).length,
    },
    ...overrides,
  };
}

function record(index: number, overrides: Partial<RunEvaluation> = {}): ReleaseRunRecord {
  return {
    traceId: `trace-${String(index).padStart(3, "0")}`,
    durationMs: 100,
    retryCount: 0,
    evaluation: runEvaluation({ traceId: `trace-${String(index).padStart(3, "0")}`, ...overrides }),
  };
}

function passingRuns(count: number): readonly ReleaseRunRecord[] {
  return Array.from({ length: count }, (_, index) => record(index));
}

function input(overrides: Partial<AggregateReleaseInput> = {}): AggregateReleaseInput {
  return {
    contract: contract(),
    contractContentHash: CONTENT_HASH,
    contractState: "active",
    releaseKey: "refund-agent-v1",
    environment: "production",
    runs: passingRuns(25),
    baseline: null,
    retrieval: { truncated: false, requested: 25, returned: 25 },
    window: { startMs: 1_000_000, endMs: 2_000_000 },
    evaluationStartedMs: 1_900_000,
    evaluationCompletedMs: 1_950_000,
    nowMs: 2_010_000,
    maxAgeSeconds: 3_600,
    ...overrides,
  };
}

describe("exact arithmetic", () => {
  it("renders a rate as an exact fraction and both fixed decimals", () => {
    // #given 1 of 8
    const rate = toRate(1, 8);

    // #then the fraction is preserved and both renderings come from integer division
    expect(rate).toEqual({
      numerator: 1,
      denominator: 8,
      decimal: "0.125000",
      percent: "12.500000",
    });
  });

  it("renders a zero denominator without dividing by zero", () => {
    // #given no runs at all
    // #then the rate is zero rather than NaN
    expect(toRate(0, 0)).toEqual({
      numerator: 0,
      denominator: 0,
      decimal: "0.000000",
      percent: "0.000000",
    });
  });

  it("compares a percentage without floating-point division", () => {
    // #given 1 failing run in 200, which is exactly 0.5 per cent
    // #then it is not *over* a 0.5 per cent limit
    expect(percentExceeds(1, 200, threshold("0.5"))).toBe(false);
    // #and 2 in 200 is 1 per cent, which is over
    expect(percentExceeds(2, 200, threshold("0.5"))).toBe(true);
  });

  it("uses nearest-rank percentiles", () => {
    // #given ten ascending samples
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

    // #then p95 is the tenth (ceil(9.5) = 10) and p50 the fifth
    expect(percentileOfAscending(samples, 95)).toBe(10);
    expect(percentileOfAscending(samples, 50)).toBe(5);
    expect(percentileOfAscending([], 95)).toBeNull();
  });
});

describe("aggregateRelease", () => {
  it("passes a release of 25 clean runs", () => {
    // #when 25 passing runs are aggregated against the demo gate
    const result = aggregateRelease(input());

    // #then the decision is a pass with no findings
    expect(result.decision).toBe("pass");
    expect(result.findings).toEqual([]);
    expect(result.counts.evaluatedRuns).toBe(25);
    expect(result.counts.passedRuns).toBe(25);
    expect(result.rates.violation.percent).toBe("0.000000");
  });

  it("reports insufficient data for zero runs", () => {
    // #when nothing was evaluated
    const result = aggregateRelease(
      input({ runs: [], retrieval: { truncated: false, requested: 0, returned: 0 } }),
    );

    // #then the release is undecided, never a pass
    expect(result.decision).toBe("insufficient_data");
    expect(result.findings.map((finding) => finding.code)).toContain("MIN_RUNS_NOT_MET");
  });

  it("reports insufficient data below the minimum sample count", () => {
    // #given 19 passing runs against a minimum of 20
    const result = aggregateRelease(input({ runs: passingRuns(19) }));

    // #then the gate refuses to decide rather than passing on a small sample
    expect(result.decision).toBe("insufficient_data");
    const finding = result.findings.find((entry) => entry.code === "MIN_RUNS_NOT_MET");
    expect(finding?.observed).toBe("19 run(s)");
    expect(finding?.expected).toBe("at least 20 run(s)");
  });

  it("fails on a single zero-tolerance violation even below the minimum run count", () => {
    // #given three runs, one carrying a zero-tolerance violation
    const runs = [record(0), record(1), record(2, { status: "fail", violations: [violation()] })];
    const result = aggregateRelease(input({ runs }));

    // #then the proven violation outranks the missing evidence: a fail, not insufficient data
    expect(result.decision).toBe("fail");
    expect(result.findings[0]?.code).toBe("ZERO_TOLERANCE_VIOLATION");
    expect(result.counts.zeroToleranceViolations).toBe(1);
  });

  it("fails on a violation rate over the threshold without any zero-tolerance rule", () => {
    // #given 25 runs, one failing on a non-zero-tolerance rule — 4 per cent, over the 0.5 limit
    const runs = [
      ...passingRuns(24),
      record(24, {
        status: "fail",
        violations: [
          violation({ ruleId: "approved-tools-only", severity: "high", zeroTolerance: false }),
        ],
      }),
    ];
    const result = aggregateRelease(input({ runs }));

    // #then the rate finding fires and no zero-tolerance finding does
    expect(result.decision).toBe("fail");
    const codes = result.findings.map((finding) => finding.code);
    expect(codes).toContain("VIOLATION_RATE_EXCEEDED");
    expect(codes).not.toContain("ZERO_TOLERANCE_VIOLATION");
    expect(result.rates.violation.percent).toBe("4.000000");
  });

  it("counts every severity separately", () => {
    // #given one run carrying one violation of each severity
    const runs = [
      ...passingRuns(24),
      record(24, {
        status: "fail",
        violations: [
          violation({ id: "v-c", severity: "critical", zeroTolerance: false }),
          violation({ id: "v-h", severity: "high", zeroTolerance: false }),
          violation({ id: "v-m", severity: "medium", zeroTolerance: false }),
          violation({ id: "v-l", severity: "low", zeroTolerance: false }),
        ],
      }),
    ];
    const result = aggregateRelease(input({ runs }));

    // #then each is counted in its own bucket
    expect(result.counts.severities).toEqual({ critical: 1, high: 1, medium: 1, low: 1 });
  });

  it("reports unknown routes as their own rate", () => {
    // #given one run of 25 following an unapproved route
    const runs = [
      ...passingRuns(24),
      record(24, { routeApproved: false, routeFingerprint: "sha256:bbbb" }),
    ];
    const result = aggregateRelease(input({ runs }));

    // #then 4 per cent unknown routes is over the 1.0 limit
    expect(result.decision).toBe("fail");
    expect(result.rates.unknownRoute.percent).toBe("4.000000");
    expect(result.counts.observedRouteFamilies).toBe(2);
    expect(result.counts.approvedRouteFamiliesCovered).toBe(1);
  });

  it("separates duplicate side effects from missing prerequisites", () => {
    // #given one run that duplicated a write and another that skipped a required step
    const runs = [
      ...passingRuns(23),
      record(23, {
        status: "fail",
        violations: [
          violation({
            id: "v-dup",
            ruleId: "single-refund-write",
            ruleType: "cardinality",
            code: "CARDINALITY_ABOVE_MAX",
            zeroTolerance: false,
          }),
        ],
      }),
      record(24, { status: "fail", violations: [violation({ id: "v-miss" })] }),
    ];
    const result = aggregateRelease(input({ runs }));

    // #then each run is counted once, in the right bucket
    expect(result.counts.duplicateSideEffectRuns).toBe(1);
    expect(result.counts.missingPrerequisiteRuns).toBe(1);
    expect(result.rates.duplicateSideEffect.percent).toBe("4.000000");
  });

  it("returns an error, not a pass, when a run evaluation errored", () => {
    // #given 25 runs of which one errored and the rest passed
    const runs = [...passingRuns(24), record(24, { status: "error" })];
    const result = aggregateRelease(input({ runs }));

    // #then PRD section 20.1: no pass after an internal error
    expect(result.decision).toBe("error");
    expect(result.findings[0]?.code).toBe("RUN_EVALUATION_ERRORED");
  });

  it("ranks an error above a violation", () => {
    // #given both an errored run and a zero-tolerance violation
    const runs = [
      ...passingRuns(23),
      record(23, { status: "error" }),
      record(24, { status: "fail", violations: [violation()] }),
    ];
    const result = aggregateRelease(input({ runs }));

    // #then the incomplete evidence dominates, because the counts cannot be trusted as complete
    expect(result.decision).toBe("error");
    expect(result.findings.map((finding) => finding.code)).toContain("ZERO_TOLERANCE_VIOLATION");
  });

  it("reports insufficient data when every run was undecidable", () => {
    // #given 25 runs that could not be decided against the contract
    const runs = Array.from({ length: 25 }, (_, index) =>
      record(index, { status: "insufficient_data" }),
    );
    const result = aggregateRelease(input({ runs }));

    // #then absence of evidence is not evidence of compliance
    expect(result.decision).toBe("insufficient_data");
    expect(result.counts.insufficientRuns).toBe(25);
    expect(result.findings.map((finding) => finding.code)).toContain("RUN_EVIDENCE_INSUFFICIENT");
  });

  it("reports insufficient data for a mix of passing and undecidable runs", () => {
    // #given 24 passing runs and one that could not be decided
    const runs = [...passingRuns(24), record(24, { status: "insufficient_data" })];
    const result = aggregateRelease(input({ runs }));

    // #then one undecidable run is enough to withhold a pass
    expect(result.decision).toBe("insufficient_data");
  });

  it("reports a stale aggregation", () => {
    // #given a window that closed two hours before the freshness bound of one hour
    const result = aggregateRelease(input({ nowMs: 2_000_000 + 7_200_000 }));

    // #then the decision is not treated as current
    expect(result.decision).toBe("insufficient_data");
    expect(result.findings.map((finding) => finding.code)).toContain("AGGREGATION_STALE");
  });

  it("reports truncated retrieval", () => {
    // #given retrieval that returned 25 of 400 requested runs
    const result = aggregateRelease(
      input({ retrieval: { truncated: true, requested: 400, returned: 25 } }),
    );

    // #then the release was not fully observed, so no pass
    expect(result.decision).toBe("insufficient_data");
    const finding = result.findings.find((entry) => entry.code === "RETRIEVAL_TRUNCATED");
    expect(finding?.observed).toBe("25 of 400");
  });

  it("reports an evaluation that exceeded the contract's telemetry timeout", () => {
    // #given an evaluation that took 700 seconds against a 600-second budget
    const result = aggregateRelease(
      input({ evaluationStartedMs: 1_000_000, evaluationCompletedMs: 1_700_000 }),
    );

    // #then the evidence may be partial
    expect(result.decision).toBe("insufficient_data");
    expect(result.findings.map((finding) => finding.code)).toContain("EVALUATION_TIMED_OUT");
  });

  it("reports an evaluation that never completed", () => {
    // #given an evaluation with no completion timestamp
    const result = aggregateRelease(input({ evaluationCompletedMs: null }));

    // #then there is no decision yet, rather than a pass
    expect(result.decision).toBe("insufficient_data");
    expect(result.findings.map((finding) => finding.code)).toContain("EVALUATION_INCOMPLETE");
  });

  it("refuses to gate on a superseded contract", () => {
    // #given a contract that is no longer active
    const result = aggregateRelease(input({ contractState: "superseded" }));

    // #then the decision is an error, not a pass on stale rules
    expect(result.decision).toBe("error");
    const finding = result.findings.find((entry) => entry.code === "CONTRACT_NOT_ACTIVE");
    expect(finding?.observed).toBe("superseded");
  });

  it("refuses to aggregate results produced against a different contract version", () => {
    // #given one stored run judged against a different contract hash
    const runs = [...passingRuns(24), record(24, { contractContentHash: "f".repeat(64) })];
    const result = aggregateRelease(input({ runs }));

    // #then mixing versions into one decision is refused
    expect(result.decision).toBe("error");
    expect(result.findings.map((finding) => finding.code)).toContain("CONTRACT_MISMATCH");
  });

  it("is byte-identical when aggregated twice over the same evidence", () => {
    // #given one set of inputs
    const first = aggregateRelease(input());
    const second = aggregateRelease(input());

    // #then the decision hashes agree
    expect(hashReleaseEvaluation(first)).toBe(hashReleaseEvaluation(second));
  });

  it("does not depend on the order runs arrived in", () => {
    // #given the same 25 runs in two orders
    const runs = passingRuns(25);
    const forward = aggregateRelease(input({ runs }));
    const reversed = aggregateRelease(input({ runs: [...runs].reverse() }));

    // #then a database's row order cannot change a release decision
    expect(hashReleaseEvaluation(forward)).toBe(hashReleaseEvaluation(reversed));
  });

  it("counts a duplicate stored evaluation of one trace once", () => {
    // #given the same trace appearing twice in the record set
    const duplicated = [...passingRuns(24), record(23)];
    const result = aggregateRelease(input({ runs: duplicated }));

    // #then the run count reflects the records supplied, and the evidence lists one fingerprint
    expect(result.counts.evaluatedRuns).toBe(25);
    expect(result.evidence.observedRouteFingerprints).toEqual([APPROVED]);
  });

  it("bounds the representative trace identifiers it returns", () => {
    // #given twenty-five failing runs
    const runs = Array.from({ length: 25 }, (_, index) =>
      record(index, { status: "fail", violations: [violation({ zeroTolerance: false })] }),
    );
    const result = aggregateRelease(input({ runs }));

    // #then a release of any size cannot flood a response
    expect(result.evidence.representativeFailingTraceIds).toHaveLength(5);
    expect(result.evidence.violatedRuleIds).toEqual(["require-fraud-check"]);
  });
});

describe("release-scoped rules", () => {
  const budgetContract = (max: number, metric = "run.duration_ms") =>
    contract({
      approvedRoutes: [APPROVED],
      rules: [
        {
          id: "release-latency-budget",
          type: "numeric_budget",
          severity: "medium",
          metric,
          aggregation: "p95",
          max,
          scope: "release",
        },
      ],
    } as Partial<TrajectoryContract["spec"]>);

  function withSample(index: number, value: number, metric = "run.duration_ms"): ReleaseRunRecord {
    const base = record(index);
    return {
      ...base,
      evaluation: {
        ...base.evaluation,
        ruleResults: [
          {
            ruleId: "release-latency-budget",
            ruleType: "numeric_budget",
            severity: "medium",
            outcome: "deferred",
            insufficientReason: null,
            summary: "deferred to release scope",
            evidence: { spanIds: [], canonicalNodes: [], labels: [] },
            violations: [],
            samples: [{ metric, value, spanIds: ["s-1"] } as never],
          },
        ],
      },
    };
  }

  it("resolves a deferred release budget from the samples every run contributed", () => {
    // #given 25 runs each reporting 100 ms against a 200 ms release budget
    const runs = Array.from({ length: 25 }, (_, index) => withSample(index, 100));
    const result = aggregateRelease(input({ contract: budgetContract(200), runs }));

    // #then the rule is decided, not deferred forever
    expect(result.decision).toBe("pass");
    expect(result.releaseRules).toHaveLength(1);
    expect(result.releaseRules[0]?.outcome).toBe("pass");
    expect(result.releaseRules[0]?.observed).toBe(100);
  });

  it("fails a release budget that the p95 exceeds", () => {
    // #given 23 fast runs and 2 slow ones, so the nearest-rank p95 (the 24th of 25) is the slow value
    const runs = [
      ...Array.from({ length: 23 }, (_, index) => withSample(index, 100)),
      withSample(23, 900),
      withSample(24, 900),
    ];
    const result = aggregateRelease(input({ contract: budgetContract(200), runs }));

    // #then the release-scoped budget produces a violation finding
    expect(result.decision).toBe("fail");
    expect(result.findings.map((finding) => finding.code)).toContain("RELEASE_BUDGET_EXCEEDED");
    expect(result.releaseRules[0]?.observed).toBe(900);
  });

  it("discloses a budget no run of the release reports, rather than passing it", () => {
    // #given a token budget against an agent that emits no token attribute
    const result = aggregateRelease(
      input({ contract: budgetContract(1_200, "gen_ai.usage.output_tokens") }),
    );

    // #then the rule is `not_measured` and disclosed — not counted as a pass
    expect(result.releaseRules[0]?.outcome).toBe("not_measured");
    expect(result.disclosures.map((entry) => entry.code)).toContain("RELEASE_BUDGET_NOT_MEASURED");
    // #and the release itself may still pass, because nothing measurable failed
    expect(result.decision).toBe("pass");
  });

  it("reports insufficient evidence when only some runs report the metric", () => {
    // #given 24 runs reporting the metric and one that does not
    const runs = [...Array.from({ length: 24 }, (_, index) => withSample(index, 100)), record(24)];
    const result = aggregateRelease(input({ contract: budgetContract(200), runs }));

    // #then a percentile over an incomplete sample is refused
    expect(result.decision).toBe("insufficient_data");
    expect(result.releaseRules[0]?.outcome).toBe("insufficient_evidence");
    expect(result.findings.map((finding) => finding.code)).toContain(
      "RELEASE_RULE_EVIDENCE_INSUFFICIENT",
    );
  });
});

describe("change from baseline", () => {
  const baseline: ReleaseBaselineReference = {
    releaseKey: "refund-agent-v1",
    runCount: 40,
    latencyP95Ms: 100,
    inputTokensP95: 400,
    outputTokensP95: 200,
    retriesPerRun: 0,
  };

  it("measures a latency regression against the approved baseline", () => {
    // #given a release whose p95 latency is 150 ms against a 100 ms baseline
    const runs = passingRuns(25).map((entry) => ({ ...entry, durationMs: 150 }));
    const result = aggregateRelease(input({ runs, baseline }));

    // #then the change is exactly 50 per cent and it exceeds the 20 per cent threshold
    expect(result.changes.latency.changePercent).toBe("50.000000");
    expect(result.decision).toBe("fail");
    expect(result.findings.map((finding) => finding.code)).toContain("LATENCY_REGRESSION_EXCEEDED");
  });

  it("permits a latency change within the threshold", () => {
    // #given a p95 of 115 ms against 100 ms, a 15 per cent change
    const runs = passingRuns(25).map((entry) => ({ ...entry, durationMs: 115 }));
    const result = aggregateRelease(input({ runs, baseline }));

    // #then the release passes and the change is still reported
    expect(result.decision).toBe("pass");
    expect(result.changes.latency.changePercent).toBe("15.000000");
  });

  it("renders an improvement as a negative change", () => {
    // #given a release that got faster
    const runs = passingRuns(25).map((entry) => ({ ...entry, durationMs: 50 }));
    const result = aggregateRelease(input({ runs, baseline }));

    // #then the sign is preserved rather than clamped
    expect(result.changes.latency.changePercent).toBe("-50.000000");
    expect(result.decision).toBe("pass");
  });

  it("discloses every change when no baseline exists", () => {
    // #given a contract with no approved baseline version
    const result = aggregateRelease(input({ baseline: null }));

    // #then nothing is measured, everything is disclosed, and nothing is silently passed
    expect(result.changes.latency.measured).toBe(false);
    expect(result.changes.tokens.measured).toBe(false);
    expect(result.changes.retries.measured).toBe(false);
    const codes = result.disclosures.map((entry) => entry.code);
    expect(codes).toContain("BASELINE_UNAVAILABLE");
    expect(codes).toContain("LATENCY_REGRESSION_NOT_MEASURED");
  });

  it("discloses runs whose duration or graph were never recorded", () => {
    // #given one run with no recorded duration and no stored canonical graph
    const runs = [...passingRuns(24), { ...record(24), durationMs: null, retryCount: null }];
    const result = aggregateRelease(input({ runs, baseline }));

    // #then both gaps are stated rather than assumed to be zero
    const codes = result.disclosures.map((entry) => entry.code);
    expect(codes).toContain("RUN_DURATION_NOT_RECORDED");
    expect(codes).toContain("RUN_RETRIES_NOT_RECORDED");
  });
});

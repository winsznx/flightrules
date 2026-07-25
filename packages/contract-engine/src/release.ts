import type {
  CardinalityRule,
  ContractRule,
  NumericBudgetRule,
  RationalThreshold,
  TrajectoryContract,
} from "@flightrules/contract-schema";
import { canonicalHash, canonicalJson, type Severity } from "@flightrules/domain";
import type { RunEvaluation, ViolationCode } from "./result.js";
import { EVALUATOR_VERSION } from "./version.js";

/**
 * Release evaluation and the release gate (FR-011, FR-012, PRD sections 10.5 and 11.11).
 *
 * Everything here is pure. No I/O, no clock read, no iteration over anything whose order a database
 * chose: `nowMs`, the aggregation window and the retrieval state all arrive as inputs, exactly as
 * `evaluateRun` already takes its clock. That is what makes the gate reproducible — the same
 * persisted evidence produces the same decision, on any machine, at any time, and a CI run can be
 * replayed from an evidence file.
 *
 * No model is involved. An explanation may be generated from this result (PRD section 10.6); it may
 * never change it.
 */

export const RELEASE_SCHEMA_VERSION = "flightrules.dev/release-gate/v1" as const;

/** PRD FR-010's four outcomes, applied to a release rather than a run. */
export const RELEASE_DECISIONS = ["pass", "fail", "insufficient_data", "error"] as const;
export type ReleaseDecision = (typeof RELEASE_DECISIONS)[number];

/**
 * Decision precedence.
 *
 * `error` first: an evaluation that could not complete leaves the violation counts incomplete, so a
 * pass would be the false green PRD section 20.1 forbids. `fail` before `insufficient_data`: a
 * proven zero-tolerance violation in three runs is stronger evidence than the absence of a
 * twentieth run, and reporting "insufficient data" there would downgrade a finding the product
 * exists to surface.
 */
const DECISION_RANK: Readonly<Record<ReleaseDecision, number>> = {
  error: 3,
  fail: 2,
  insufficient_data: 1,
  pass: 0,
};

/**
 * Why a gate did not pass.
 *
 * A closed set, like every other vocabulary the evaluator emits. A finding names the threshold it
 * crossed and the decision it implies, so the CLI's exit code is derived rather than decided.
 */
export const GATE_FINDING_CODES = [
  "CONTRACT_NOT_ACTIVE",
  "CONTRACT_MISMATCH",
  "RUN_EVALUATION_ERRORED",
  "RETRIEVAL_TRUNCATED",
  "EVALUATION_TIMED_OUT",
  "EVALUATION_INCOMPLETE",
  "AGGREGATION_STALE",
  "MIN_RUNS_NOT_MET",
  "RUN_EVIDENCE_INSUFFICIENT",
  "RELEASE_RULE_EVIDENCE_INSUFFICIENT",
  "ZERO_TOLERANCE_VIOLATION",
  "VIOLATION_RATE_EXCEEDED",
  "UNKNOWN_ROUTE_RATE_EXCEEDED",
  "LATENCY_REGRESSION_EXCEEDED",
  "TOKEN_REGRESSION_EXCEEDED",
  "RELEASE_BUDGET_EXCEEDED",
  "RELEASE_CARDINALITY_EXCEEDED",
] as const;
export type GateFindingCode = (typeof GATE_FINDING_CODES)[number];

/**
 * Something the gate could not measure, stated rather than assumed.
 *
 * A disclosure is not a pass and not a failure. It is the honest third answer for a check whose
 * evidence is structurally absent — the metric is emitted by no run of the release and by no run of
 * the baseline — which is the same distinction the baseline miner draws with `BUDGET_NOT_PROPOSED`
 * and the Phase 10 dashboard draws with its empty token panel. A check whose evidence is *partially*
 * present is not disclosed, it is `..._EVIDENCE_INSUFFICIENT`, and it makes the release
 * `insufficient_data`.
 */
export const GATE_DISCLOSURE_CODES = [
  "BASELINE_UNAVAILABLE",
  "LATENCY_REGRESSION_NOT_MEASURED",
  "TOKEN_REGRESSION_NOT_MEASURED",
  "RETRY_CHANGE_NOT_MEASURED",
  "RELEASE_BUDGET_NOT_MEASURED",
  "RUN_DURATION_NOT_RECORDED",
  "RUN_RETRIES_NOT_RECORDED",
] as const;
export type GateDisclosureCode = (typeof GATE_DISCLOSURE_CODES)[number];

export interface GateFinding {
  readonly code: GateFindingCode;
  readonly implies: ReleaseDecision;
  readonly severity: Severity;
  /** Written from the observed numbers by this function. No model is involved. */
  readonly summary: string;
  readonly expected: string;
  readonly observed: string;
  /** The contract rule this finding came from, where one applies. */
  readonly ruleId: string | null;
}

export interface GateDisclosure {
  readonly code: GateDisclosureCode;
  readonly summary: string;
  readonly ruleId: string | null;
}

/**
 * An exact ratio and its two fixed-precision renderings.
 *
 * Both are produced by integer division so they are identical on every platform, and both are
 * carried so a percentage displayed in the UI can never drift from the counts it came from.
 */
export interface Rate {
  readonly numerator: number;
  readonly denominator: number;
  /** Six decimal places, `0.000000` to `1.000000`. */
  readonly decimal: string;
  /** Six decimal places, `0.000000` to `100.000000`. */
  readonly percent: string;
}

/** A measurement compared against the baseline. `measured` is false when either side is absent. */
export interface ChangeMeasure {
  readonly metric: string;
  readonly baseline: number | null;
  readonly candidate: number | null;
  /** Signed, six decimal places. `null` when the change was not measured. */
  readonly changePercent: string | null;
  readonly measured: boolean;
}

export interface ReleaseCounts {
  readonly evaluatedRuns: number;
  readonly passedRuns: number;
  readonly failedRuns: number;
  readonly erroredRuns: number;
  readonly insufficientRuns: number;
  readonly violations: number;
  readonly criticalViolations: number;
  readonly zeroToleranceViolations: number;
  readonly unknownRouteRuns: number;
  readonly duplicateSideEffectRuns: number;
  readonly missingPrerequisiteRuns: number;
  readonly degradedTraceRuns: number;
  readonly severities: Readonly<Record<Severity, number>>;
  /** Distinct canonical route fingerprints observed across the release. */
  readonly observedRouteFamilies: number;
  /** How many of the contract's approved fingerprints this release actually exercised. */
  readonly approvedRouteFamiliesCovered: number;
  readonly approvedRouteFamiliesDeclared: number;
}

export interface ReleaseRates {
  readonly violation: Rate;
  readonly unknownRoute: Rate;
  readonly duplicateSideEffect: Rate;
  readonly missingPrerequisite: Rate;
}

export interface ReleaseChanges {
  readonly latency: ChangeMeasure;
  readonly tokens: ChangeMeasure;
  readonly retries: ChangeMeasure;
}

export const RELEASE_RULE_OUTCOMES = [
  "pass",
  "violation",
  "insufficient_evidence",
  "not_measured",
] as const;
export type ReleaseRuleOutcome = (typeof RELEASE_RULE_OUTCOMES)[number];

/** A rule the run evaluator deferred, decided here from the samples every run contributed. */
export interface ReleaseRuleResult {
  readonly ruleId: string;
  readonly ruleType: ContractRule["type"];
  readonly severity: Severity;
  readonly outcome: ReleaseRuleOutcome;
  readonly aggregation: string;
  readonly metric: string;
  readonly observed: number | null;
  readonly limit: number;
  readonly runsReporting: number;
  readonly summary: string;
}

/** Trace identifiers a reviewer needs, bounded so a release of 5 000 runs cannot flood a response. */
export interface ReleaseEvidence {
  readonly representativeFailingTraceIds: readonly string[];
  readonly representativePassingTraceIds: readonly string[];
  readonly zeroToleranceRuleIds: readonly string[];
  readonly violatedRuleIds: readonly string[];
  readonly observedRouteFingerprints: readonly string[];
}

const MAX_REPRESENTATIVES = 5;

export interface ReleaseRunRecord {
  readonly traceId: string;
  /** From the persisted trace run. `null` when the run's duration was never recorded. */
  readonly durationMs: number | null;
  /** Summed `retryNumber` over the persisted canonical graph. `null` when no graph was stored. */
  readonly retryCount: number | null;
  readonly evaluation: RunEvaluation;
}

/** The approved baseline a regression is measured against. Every field may be absent. */
export interface ReleaseBaselineReference {
  readonly releaseKey: string | null;
  readonly runCount: number;
  readonly latencyP95Ms: number | null;
  readonly inputTokensP95: number | null;
  readonly outputTokensP95: number | null;
  readonly retriesPerRun: number | null;
}

export interface RetrievalState {
  readonly truncated: boolean;
  readonly requested: number;
  readonly returned: number;
}

export interface AggregateReleaseInput {
  readonly contract: TrajectoryContract;
  readonly contractContentHash: string;
  /** The stored lifecycle state. Anything but `active` is a configuration error, never a pass. */
  readonly contractState: string;
  readonly releaseKey: string;
  readonly environment: string;
  readonly runs: readonly ReleaseRunRecord[];
  readonly baseline: ReleaseBaselineReference | null;
  readonly retrieval: RetrievalState;
  readonly window: { readonly startMs: number; readonly endMs: number };
  /** When the underlying run evaluation started and finished. `null` means it never completed. */
  readonly evaluationStartedMs: number | null;
  readonly evaluationCompletedMs: number | null;
  readonly nowMs: number;
  /** How old the aggregation window may be before the decision is treated as stale. */
  readonly maxAgeSeconds: number;
}

export interface ReleaseEvaluation {
  readonly schemaVersion: typeof RELEASE_SCHEMA_VERSION;
  readonly decision: ReleaseDecision;
  readonly releaseKey: string;
  readonly environment: string;
  readonly contractId: string;
  readonly contractVersion: string;
  readonly contractContentHash: string;
  readonly contractState: string;
  readonly evaluatorVersion: string;
  readonly baselineReleaseKey: string | null;
  readonly window: { readonly startMs: number; readonly endMs: number };
  readonly retrieval: RetrievalState;
  readonly gate: {
    readonly minCompletedRuns: number;
    readonly evaluationTimeoutSeconds: number;
    readonly maxViolationPercent: string;
    readonly maxUnknownRoutePercent: string;
    readonly maxLatencyRegressionPercent: string;
    readonly maxTokenRegressionPercent: string;
    readonly zeroToleranceRuleIds: readonly string[];
  };
  readonly counts: ReleaseCounts;
  readonly rates: ReleaseRates;
  readonly changes: ReleaseChanges;
  readonly releaseRules: readonly ReleaseRuleResult[];
  readonly findings: readonly GateFinding[];
  readonly disclosures: readonly GateDisclosure[];
  readonly evidence: ReleaseEvidence;
}

/**
 * Canonical serialisation of a release decision.
 *
 * Keys are sorted at every depth by the one implementation the whole product uses, so a decision
 * written to an evidence file, returned by the API and printed by the CLI are the same bytes. The
 * hash is what makes "repeated aggregation over unchanged evidence is identical" a test rather than
 * a claim.
 */
export function serialiseReleaseEvaluation(evaluation: ReleaseEvaluation): string {
  return canonicalJson(evaluation);
}

export function hashReleaseEvaluation(evaluation: ReleaseEvaluation): string {
  return canonicalHash(evaluation);
}

/* -------------------------------------------------------------------------- */
/* Exact arithmetic                                                           */
/* -------------------------------------------------------------------------- */

const SCALE = 1_000_000;

function fixed(scaled: number): string {
  const negative = scaled < 0;
  const magnitude = Math.abs(scaled);
  const whole = Math.floor(magnitude / SCALE);
  const fraction = magnitude - whole * SCALE;
  return `${negative ? "-" : ""}${whole}.${String(fraction).padStart(6, "0")}`;
}

/** A rate as an exact fraction plus both renderings, produced by integer division only. */
export function toRate(numerator: number, denominator: number): Rate {
  if (denominator <= 0) {
    return { numerator, denominator: 0, decimal: "0.000000", percent: "0.000000" };
  }
  return {
    numerator,
    denominator,
    decimal: fixed(Math.floor((numerator * SCALE) / denominator)),
    percent: fixed(Math.floor((numerator * 100 * SCALE) / denominator)),
  };
}

/**
 * `numerator / denominator × 100 > threshold`, decided by cross-multiplication.
 *
 * Never by division: the threshold is the author's decimal held as an exact fraction precisely so a
 * release decision does not depend on how a double rounds.
 */
export function percentExceeds(
  numerator: number,
  denominator: number,
  threshold: RationalThreshold,
): boolean {
  if (denominator <= 0) return false;
  return numerator * 100 * threshold.denominator > threshold.numerator * denominator;
}

/**
 * Nearest-rank percentile over an ascending list.
 *
 * The same definition as `percentileOf` in `@flightrules/baseline-miner`, so a baseline percentile
 * and a candidate percentile are computed the same way and are comparable. A parity test asserts
 * the two agree.
 */
export function percentileOfAscending(
  ascending: readonly number[],
  percent: number,
): number | null {
  if (ascending.length === 0) return null;
  const rank = Math.ceil((percent * ascending.length) / 100);
  const index = Math.min(Math.max(rank, 1), ascending.length) - 1;
  return ascending[index] as number;
}

/* -------------------------------------------------------------------------- */
/* Aggregation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Violation codes that mean a step the contract requires before another one was absent.
 *
 * FR-011's "missing prerequisite rate". Closed, because "did the release skip a required step" has
 * to be answerable by a query rather than by reading prose.
 */
const MISSING_PREREQUISITE_CODES: ReadonlySet<ViolationCode> = new Set<ViolationCode>([
  "REQUIRED_SPAN_MISSING",
  "REQUIRED_ANCESTRY_MISSING",
  "REQUIRED_EDGE_MISSING",
  "CARDINALITY_BELOW_MIN",
]);

/** Violation codes that mean one side effect happened more than the contract permits. */
const DUPLICATE_SIDE_EFFECT_CODES: ReadonlySet<ViolationCode> = new Set<ViolationCode>([
  "CARDINALITY_ABOVE_MAX",
  "REQUIRED_SPAN_TOO_MANY",
  "RETRY_BUDGET_SIDE_EFFECT_EXCEEDED",
]);

export function aggregateRelease(input: AggregateReleaseInput): ReleaseEvaluation {
  const gate = input.contract.spec.gate;
  // Sorted by trace ID so the aggregation cannot depend on the order a database returned rows in.
  const runs = [...input.runs].sort((a, b) =>
    a.traceId < b.traceId ? -1 : a.traceId > b.traceId ? 1 : 0,
  );

  const counts = countRuns(runs, input.contract);
  const total = counts.evaluatedRuns;
  const rates: ReleaseRates = {
    violation: toRate(counts.failedRuns, total),
    unknownRoute: toRate(counts.unknownRouteRuns, total),
    duplicateSideEffect: toRate(counts.duplicateSideEffectRuns, total),
    missingPrerequisite: toRate(counts.missingPrerequisiteRuns, total),
  };

  const findings: GateFinding[] = [];
  const disclosures: GateDisclosure[] = [];

  const releaseRules = resolveReleaseRules(input.contract, runs, findings, disclosures);
  const changes = measureChanges(runs, input.baseline, disclosures);

  collectStateFindings(input, counts, findings);
  collectThresholdFindings(input, counts, rates, changes, findings);

  findings.sort(compareFindings);
  disclosures.sort((a, b) =>
    a.code === b.code ? compareNullableStrings(a.ruleId, b.ruleId) : a.code < b.code ? -1 : 1,
  );

  let decision: ReleaseDecision = "pass";
  for (const finding of findings) {
    if (DECISION_RANK[finding.implies] > DECISION_RANK[decision]) decision = finding.implies;
  }

  return {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    decision,
    releaseKey: input.releaseKey,
    environment: input.environment,
    contractId: input.contract.metadata.id,
    contractVersion: input.contract.metadata.version,
    contractContentHash: input.contractContentHash,
    contractState: input.contractState,
    evaluatorVersion: EVALUATOR_VERSION,
    baselineReleaseKey:
      input.baseline?.releaseKey ?? input.contract.metadata.baselineRelease ?? null,
    window: input.window,
    retrieval: input.retrieval,
    gate: {
      minCompletedRuns: gate.minCompletedRuns,
      evaluationTimeoutSeconds: gate.evaluationTimeoutSeconds,
      maxViolationPercent: gate.maxViolationPercent.text,
      maxUnknownRoutePercent: gate.maxUnknownRoutePercent.text,
      maxLatencyRegressionPercent: gate.maxLatencyRegressionPercent.text,
      maxTokenRegressionPercent: gate.maxTokenRegressionPercent.text,
      zeroToleranceRuleIds: [...gate.zeroToleranceRuleIds].sort(),
    },
    counts,
    rates,
    changes,
    releaseRules,
    findings,
    disclosures,
    evidence: collectEvidence(runs, gate.zeroToleranceRuleIds),
  };
}

function countRuns(runs: readonly ReleaseRunRecord[], contract: TrajectoryContract): ReleaseCounts {
  const severities: Record<Severity, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  const fingerprints = new Set<string>();
  let passed = 0;
  let failed = 0;
  let errored = 0;
  let insufficient = 0;
  let violations = 0;
  let critical = 0;
  let zeroTolerance = 0;
  let unknownRoute = 0;
  let duplicate = 0;
  let missingPrerequisite = 0;
  let degraded = 0;

  for (const record of runs) {
    const run = record.evaluation;
    fingerprints.add(run.routeFingerprint);
    if (run.status === "pass") passed += 1;
    if (run.status === "fail") failed += 1;
    if (run.status === "error") errored += 1;
    if (run.status === "insufficient_data") insufficient += 1;
    if (!run.routeApproved) unknownRoute += 1;
    if (run.traceQuality !== "complete") degraded += 1;

    violations += run.counts.violations;
    critical += run.counts.criticalViolations;
    zeroTolerance += run.counts.zeroToleranceViolations;

    let hasDuplicate = false;
    let hasMissing = false;
    for (const violation of run.violations) {
      severities[violation.severity] += 1;
      if (DUPLICATE_SIDE_EFFECT_CODES.has(violation.code)) hasDuplicate = true;
      if (MISSING_PREREQUISITE_CODES.has(violation.code)) hasMissing = true;
    }
    if (hasDuplicate) duplicate += 1;
    if (hasMissing) missingPrerequisite += 1;
  }

  const declared = new Set(contract.spec.approvedRoutes);
  let covered = 0;
  for (const approved of declared) {
    if (fingerprints.has(approved)) covered += 1;
  }

  return {
    evaluatedRuns: runs.length,
    passedRuns: passed,
    failedRuns: failed,
    erroredRuns: errored,
    insufficientRuns: insufficient,
    violations,
    criticalViolations: critical,
    zeroToleranceViolations: zeroTolerance,
    unknownRouteRuns: unknownRoute,
    duplicateSideEffectRuns: duplicate,
    missingPrerequisiteRuns: missingPrerequisite,
    degradedTraceRuns: degraded,
    severities,
    observedRouteFamilies: fingerprints.size,
    approvedRouteFamiliesCovered: covered,
    approvedRouteFamiliesDeclared: declared.size,
  };
}

/* -------------------------------------------------------------------------- */
/* Deferred release-scoped rules (PRD section 11.11)                          */
/* -------------------------------------------------------------------------- */

function resolveReleaseRules(
  contract: TrajectoryContract,
  runs: readonly ReleaseRunRecord[],
  findings: GateFinding[],
  disclosures: GateDisclosure[],
): readonly ReleaseRuleResult[] {
  const results: ReleaseRuleResult[] = [];

  for (const rule of contract.spec.rules) {
    if (rule.type === "numeric_budget" && rule.scope === "release") {
      results.push(resolveNumericBudget(rule, runs, findings, disclosures));
    }
    if (rule.type === "cardinality" && rule.scope === "release") {
      results.push(resolveCardinality(rule, runs, findings));
    }
  }

  return results.sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0));
}

/** Per-run values for a metric, and how many runs reported it at all. */
function perRunValues(
  ruleId: string,
  metric: string,
  runs: readonly ReleaseRunRecord[],
): { readonly values: readonly number[]; readonly reporting: number } {
  const values: number[] = [];
  let reporting = 0;
  for (const record of runs) {
    let total = 0;
    let seen = false;
    for (const result of record.evaluation.ruleResults) {
      if (result.ruleId !== ruleId) continue;
      for (const sample of result.samples) {
        if (sample.metric !== metric) continue;
        total += sample.value;
        seen = true;
      }
    }
    if (seen) {
      reporting += 1;
      values.push(total);
    }
  }
  return { values: [...values].sort((a, b) => a - b), reporting };
}

function aggregateValues(values: readonly number[], aggregation: string): number | null {
  if (values.length === 0) return null;
  switch (aggregation) {
    case "sum":
      return values.reduce((total, value) => total + value, 0);
    case "max":
      return values[values.length - 1] as number;
    case "avg":
      return Math.floor(values.reduce((total, value) => total + value, 0) / values.length);
    case "p95":
      return percentileOfAscending(values, 95);
    case "p99":
      return percentileOfAscending(values, 99);
    default:
      return null;
  }
}

function resolveNumericBudget(
  rule: NumericBudgetRule,
  runs: readonly ReleaseRunRecord[],
  findings: GateFinding[],
  disclosures: GateDisclosure[],
): ReleaseRuleResult {
  const { values, reporting } = perRunValues(rule.id, rule.metric, runs);
  const base = {
    ruleId: rule.id,
    ruleType: rule.type,
    severity: rule.severity,
    aggregation: rule.aggregation,
    metric: rule.metric,
    limit: rule.max,
    runsReporting: reporting,
  } as const;

  if (runs.length === 0 || reporting === 0) {
    disclosures.push({
      code: "RELEASE_BUDGET_NOT_MEASURED",
      ruleId: rule.id,
      summary: `No run of this release reports ${rule.metric}, so the release-scoped budget could not be measured. It is disclosed rather than counted as a pass.`,
    });
    return {
      ...base,
      outcome: "not_measured",
      observed: null,
      summary: `${rule.metric} is not emitted by any run of this release.`,
    };
  }

  if (reporting < runs.length) {
    findings.push({
      code: "RELEASE_RULE_EVIDENCE_INSUFFICIENT",
      implies: "insufficient_data",
      severity: rule.severity,
      ruleId: rule.id,
      summary: `${rule.metric} was reported by ${reporting} of ${runs.length} run(s), so the release-scoped ${rule.aggregation} would be computed over an incomplete sample.`,
      expected: `all ${runs.length} run(s) to report ${rule.metric}`,
      observed: `${reporting} run(s)`,
    });
    return {
      ...base,
      outcome: "insufficient_evidence",
      observed: null,
      summary: `${rule.metric} was reported by ${reporting} of ${runs.length} run(s).`,
    };
  }

  const observed = aggregateValues(values, rule.aggregation);
  if (observed === null) {
    findings.push({
      code: "RELEASE_RULE_EVIDENCE_INSUFFICIENT",
      implies: "insufficient_data",
      severity: rule.severity,
      ruleId: rule.id,
      summary: `The ${rule.aggregation} aggregation of ${rule.metric} could not be computed.`,
      expected: `a ${rule.aggregation} of ${rule.metric}`,
      observed: "no value",
    });
    return {
      ...base,
      outcome: "insufficient_evidence",
      observed: null,
      summary: `The ${rule.aggregation} of ${rule.metric} could not be computed.`,
    };
  }

  if (observed > rule.max) {
    findings.push({
      code: "RELEASE_BUDGET_EXCEEDED",
      implies: "fail",
      severity: rule.severity,
      ruleId: rule.id,
      summary: `Release-wide ${rule.aggregation} of ${rule.metric} was ${observed}, over the budget of ${rule.max}.`,
      expected: `at most ${rule.max}`,
      observed: String(observed),
    });
    return {
      ...base,
      outcome: "violation",
      observed,
      summary: `${rule.aggregation} of ${rule.metric} was ${observed}, exceeding ${rule.max}.`,
    };
  }

  return {
    ...base,
    outcome: "pass",
    observed,
    summary: `${rule.aggregation} of ${rule.metric} was ${observed}, within ${rule.max}.`,
  };
}

/**
 * Release-scoped cardinality.
 *
 * The run evaluator defers the decision but still records the spans it matched, so the per-run count
 * is the length of the deferred result's evidence. Summing those counts is the release-wide
 * occurrence, computed from stored evidence rather than by re-reading traces.
 */
function resolveCardinality(
  rule: CardinalityRule,
  runs: readonly ReleaseRunRecord[],
  findings: GateFinding[],
): ReleaseRuleResult {
  let observed = 0;
  let reporting = 0;
  for (const record of runs) {
    for (const result of record.evaluation.ruleResults) {
      if (result.ruleId !== rule.id) continue;
      observed += result.evidence.spanIds.length;
      reporting += 1;
    }
  }

  const base = {
    ruleId: rule.id,
    ruleType: rule.type,
    severity: rule.severity,
    aggregation: "sum",
    metric: "occurrences",
    limit: rule.max,
    runsReporting: reporting,
  } as const;

  if (reporting < runs.length) {
    findings.push({
      code: "RELEASE_RULE_EVIDENCE_INSUFFICIENT",
      implies: "insufficient_data",
      severity: rule.severity,
      ruleId: rule.id,
      summary: `Only ${reporting} of ${runs.length} run(s) carry a result for ${rule.id}, so the release-wide count is incomplete.`,
      expected: `a result from all ${runs.length} run(s)`,
      observed: `${reporting} run(s)`,
    });
    return {
      ...base,
      outcome: "insufficient_evidence",
      observed: null,
      summary: `${reporting} of ${runs.length} run(s) reported this rule.`,
    };
  }

  if (observed > rule.max || observed < rule.min) {
    findings.push({
      code: "RELEASE_CARDINALITY_EXCEEDED",
      implies: "fail",
      severity: rule.severity,
      ruleId: rule.id,
      summary: `The release matched ${rule.id} ${observed} time(s); the contract permits ${rule.min} to ${rule.max}.`,
      expected: `${rule.min} to ${rule.max}`,
      observed: String(observed),
    });
    return {
      ...base,
      outcome: "violation",
      observed,
      summary: `Matched ${observed} time(s) across the release; ${rule.min} to ${rule.max} permitted.`,
    };
  }

  return {
    ...base,
    outcome: "pass",
    observed,
    summary: `Matched ${observed} time(s) across the release, within ${rule.min} to ${rule.max}.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Regression measurement (FR-011)                                            */
/* -------------------------------------------------------------------------- */

const TOKEN_METRICS = ["gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens"] as const;

function measureChanges(
  runs: readonly ReleaseRunRecord[],
  baseline: ReleaseBaselineReference | null,
  disclosures: GateDisclosure[],
): ReleaseChanges {
  if (baseline === null) {
    disclosures.push({
      code: "BASELINE_UNAVAILABLE",
      ruleId: null,
      summary:
        "This contract has no approved baseline version, so latency, token and retry change from baseline could not be measured.",
    });
  }

  const durations = runs
    .map((record) => record.durationMs)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  if (durations.length < runs.length) {
    disclosures.push({
      code: "RUN_DURATION_NOT_RECORDED",
      ruleId: null,
      summary: `${runs.length - durations.length} of ${runs.length} run(s) have no recorded duration; the latency percentile uses the ${durations.length} that do.`,
    });
  }

  const retries = runs
    .map((record) => record.retryCount)
    .filter((value): value is number => value !== null);
  if (retries.length < runs.length) {
    disclosures.push({
      code: "RUN_RETRIES_NOT_RECORDED",
      ruleId: null,
      summary: `${runs.length - retries.length} of ${runs.length} run(s) have no stored canonical graph, so their retries were not counted.`,
    });
  }

  const tokenValues = tokenSamples(runs);

  return {
    latency: change(
      "run.duration_ms",
      baseline?.latencyP95Ms ?? null,
      percentileOfAscending(durations, 95),
      disclosures,
      "LATENCY_REGRESSION_NOT_MEASURED",
    ),
    tokens: change(
      "gen_ai.usage.total_tokens",
      sumOrNull(baseline?.inputTokensP95 ?? null, baseline?.outputTokensP95 ?? null),
      percentileOfAscending(tokenValues, 95),
      disclosures,
      "TOKEN_REGRESSION_NOT_MEASURED",
    ),
    retries: change(
      "agent.retry.count",
      baseline?.retriesPerRun ?? null,
      retries.length === 0
        ? null
        : Math.floor(retries.reduce((total, value) => total + value, 0) / retries.length),
      disclosures,
      "RETRY_CHANGE_NOT_MEASURED",
    ),
  };
}

/** Total tokens per run, ascending. A run reporting neither token metric contributes nothing. */
function tokenSamples(runs: readonly ReleaseRunRecord[]): readonly number[] {
  const values: number[] = [];
  for (const record of runs) {
    let total = 0;
    let seen = false;
    for (const result of record.evaluation.ruleResults) {
      for (const sample of result.samples) {
        if (!TOKEN_METRICS.includes(sample.metric as (typeof TOKEN_METRICS)[number])) continue;
        total += sample.value;
        seen = true;
      }
    }
    if (seen) values.push(total);
  }
  return values.sort((a, b) => a - b);
}

function sumOrNull(left: number | null, right: number | null): number | null {
  if (left === null && right === null) return null;
  return (left ?? 0) + (right ?? 0);
}

function change(
  metric: string,
  baseline: number | null,
  candidate: number | null,
  disclosures: GateDisclosure[],
  disclosureCode: GateDisclosureCode,
): ChangeMeasure {
  if (baseline === null || candidate === null || baseline === 0) {
    disclosures.push({
      code: disclosureCode,
      ruleId: null,
      summary:
        baseline === null || baseline === 0
          ? `No usable baseline value for ${metric}, so its change could not be measured.`
          : `This release reports no ${metric}, so its change could not be measured.`,
    });
    return { metric, baseline, candidate, changePercent: null, measured: false };
  }
  const scaled = Math.trunc(((candidate - baseline) * 100 * SCALE) / baseline);
  return { metric, baseline, candidate, changePercent: fixed(scaled), measured: true };
}

/** `(candidate - baseline) / baseline × 100 > threshold`, by cross-multiplication. */
function regressionExceeds(measure: ChangeMeasure, threshold: RationalThreshold): boolean {
  if (!measure.measured || measure.baseline === null || measure.candidate === null) return false;
  if (measure.baseline <= 0) return false;
  const delta = measure.candidate - measure.baseline;
  return delta * 100 * threshold.denominator > threshold.numerator * measure.baseline;
}

/* -------------------------------------------------------------------------- */
/* Findings                                                                   */
/* -------------------------------------------------------------------------- */

function collectStateFindings(
  input: AggregateReleaseInput,
  counts: ReleaseCounts,
  findings: GateFinding[],
): void {
  if (input.contractState !== "active") {
    findings.push({
      code: "CONTRACT_NOT_ACTIVE",
      implies: "error",
      severity: "critical",
      ruleId: null,
      summary: `The contract this release was judged against is ${input.contractState}, not active, so its decision is not a release decision.`,
      expected: "active",
      observed: input.contractState,
    });
  }

  for (const record of input.runs) {
    if (record.evaluation.contractContentHash !== input.contractContentHash) {
      findings.push({
        code: "CONTRACT_MISMATCH",
        implies: "error",
        severity: "critical",
        ruleId: null,
        summary:
          "At least one stored run evaluation was produced against a different contract version, so the results cannot be aggregated into one decision.",
        expected: input.contractContentHash,
        observed: record.evaluation.contractContentHash,
      });
      break;
    }
  }

  if (counts.erroredRuns > 0) {
    findings.push({
      code: "RUN_EVALUATION_ERRORED",
      implies: "error",
      severity: "critical",
      ruleId: null,
      summary: `${counts.erroredRuns} run evaluation(s) errored, so the violation counts are incomplete and no pass may be reported.`,
      expected: "0 errored run(s)",
      observed: `${counts.erroredRuns} errored run(s)`,
    });
  }

  if (input.retrieval.truncated) {
    findings.push({
      code: "RETRIEVAL_TRUNCATED",
      implies: "insufficient_data",
      severity: "high",
      ruleId: null,
      summary: `Trace retrieval was truncated at ${input.retrieval.returned} of ${input.retrieval.requested} run(s), so the release was not fully observed.`,
      expected: "complete retrieval",
      observed: `${input.retrieval.returned} of ${input.retrieval.requested}`,
    });
  }

  if (input.evaluationCompletedMs === null) {
    findings.push({
      code: "EVALUATION_INCOMPLETE",
      implies: "insufficient_data",
      severity: "high",
      ruleId: null,
      summary: "The run evaluation this gate reads has not completed, so there is no decision yet.",
      expected: "a completed evaluation",
      observed: "not completed",
    });
  } else if (input.evaluationStartedMs !== null) {
    const elapsedMs = input.evaluationCompletedMs - input.evaluationStartedMs;
    const budgetMs = input.contract.spec.gate.evaluationTimeoutSeconds * 1_000;
    if (elapsedMs > budgetMs) {
      findings.push({
        code: "EVALUATION_TIMED_OUT",
        implies: "insufficient_data",
        severity: "high",
        ruleId: null,
        summary: `Waiting for telemetry took ${elapsedMs} ms, over the contract's ${budgetMs} ms budget, so the evidence may be partial.`,
        expected: `at most ${budgetMs} ms`,
        observed: `${elapsedMs} ms`,
      });
    }
  }

  const ageMs = input.nowMs - input.window.endMs;
  const maxAgeMs = input.maxAgeSeconds * 1_000;
  if (ageMs > maxAgeMs) {
    findings.push({
      code: "AGGREGATION_STALE",
      implies: "insufficient_data",
      severity: "medium",
      ruleId: null,
      summary: `The aggregation window closed ${ageMs} ms ago, beyond the ${maxAgeMs} ms freshness bound, so this decision is not about the current release state.`,
      expected: `at most ${maxAgeMs} ms old`,
      observed: `${ageMs} ms old`,
    });
  }
}

function collectThresholdFindings(
  input: AggregateReleaseInput,
  counts: ReleaseCounts,
  rates: ReleaseRates,
  changes: ReleaseChanges,
  findings: GateFinding[],
): void {
  const gate = input.contract.spec.gate;

  if (counts.evaluatedRuns < gate.minCompletedRuns) {
    findings.push({
      code: "MIN_RUNS_NOT_MET",
      implies: "insufficient_data",
      severity: "high",
      ruleId: null,
      summary: `${counts.evaluatedRuns} completed run(s) were evaluated; the contract requires at least ${gate.minCompletedRuns} before a release decision.`,
      expected: `at least ${gate.minCompletedRuns} run(s)`,
      observed: `${counts.evaluatedRuns} run(s)`,
    });
  }

  if (counts.insufficientRuns > 0) {
    findings.push({
      code: "RUN_EVIDENCE_INSUFFICIENT",
      implies: "insufficient_data",
      severity: "medium",
      ruleId: null,
      summary: `${counts.insufficientRuns} run(s) could not be decided against the contract, so their evidence is missing rather than negative.`,
      expected: "0 undecidable run(s)",
      observed: `${counts.insufficientRuns} run(s)`,
    });
  }

  if (counts.zeroToleranceViolations > 0) {
    findings.push({
      code: "ZERO_TOLERANCE_VIOLATION",
      implies: "fail",
      severity: "critical",
      ruleId: null,
      summary: `${counts.zeroToleranceViolations} zero-tolerance violation(s) were observed. A zero-tolerance rule has no permitted rate.`,
      expected: "0 zero-tolerance violation(s)",
      observed: `${counts.zeroToleranceViolations} violation(s)`,
    });
  }

  if (percentExceeds(counts.failedRuns, counts.evaluatedRuns, gate.maxViolationPercent)) {
    findings.push({
      code: "VIOLATION_RATE_EXCEEDED",
      implies: "fail",
      severity: "critical",
      ruleId: null,
      summary: `${rates.violation.percent}% of runs violated the contract; the gate permits at most ${gate.maxViolationPercent.text}%.`,
      expected: `at most ${gate.maxViolationPercent.text}%`,
      observed: `${rates.violation.percent}% (${counts.failedRuns} of ${counts.evaluatedRuns})`,
    });
  }

  if (percentExceeds(counts.unknownRouteRuns, counts.evaluatedRuns, gate.maxUnknownRoutePercent)) {
    findings.push({
      code: "UNKNOWN_ROUTE_RATE_EXCEEDED",
      implies: "fail",
      severity: "high",
      ruleId: null,
      summary: `${rates.unknownRoute.percent}% of runs followed a route the contract does not approve; the gate permits at most ${gate.maxUnknownRoutePercent.text}%.`,
      expected: `at most ${gate.maxUnknownRoutePercent.text}%`,
      observed: `${rates.unknownRoute.percent}% (${counts.unknownRouteRuns} of ${counts.evaluatedRuns})`,
    });
  }

  if (regressionExceeds(changes.latency, gate.maxLatencyRegressionPercent)) {
    findings.push({
      code: "LATENCY_REGRESSION_EXCEEDED",
      implies: "fail",
      severity: "medium",
      ruleId: null,
      summary: `p95 latency moved ${changes.latency.changePercent}% against the baseline; the gate permits at most ${gate.maxLatencyRegressionPercent.text}%.`,
      expected: `at most ${gate.maxLatencyRegressionPercent.text}%`,
      observed: `${changes.latency.changePercent}% (${changes.latency.baseline} ms to ${changes.latency.candidate} ms)`,
    });
  }

  if (regressionExceeds(changes.tokens, gate.maxTokenRegressionPercent)) {
    findings.push({
      code: "TOKEN_REGRESSION_EXCEEDED",
      implies: "fail",
      severity: "medium",
      ruleId: null,
      summary: `p95 token usage moved ${changes.tokens.changePercent}% against the baseline; the gate permits at most ${gate.maxTokenRegressionPercent.text}%.`,
      expected: `at most ${gate.maxTokenRegressionPercent.text}%`,
      observed: `${changes.tokens.changePercent}% (${changes.tokens.baseline} to ${changes.tokens.candidate})`,
    });
  }
}

const FINDING_ORDER: ReadonlyMap<GateFindingCode, number> = new Map(
  GATE_FINDING_CODES.map((code, index) => [code, index]),
);

/** Decision severity first, then the declared code order, then rule identifier. Total, so stable. */
function compareFindings(a: GateFinding, b: GateFinding): number {
  const byDecision = DECISION_RANK[b.implies] - DECISION_RANK[a.implies];
  if (byDecision !== 0) return byDecision;
  const byCode = (FINDING_ORDER.get(a.code) ?? 0) - (FINDING_ORDER.get(b.code) ?? 0);
  if (byCode !== 0) return byCode;
  return compareNullableStrings(a.ruleId, b.ruleId);
}

function compareNullableStrings(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

function collectEvidence(
  runs: readonly ReleaseRunRecord[],
  zeroToleranceRuleIds: readonly string[],
): ReleaseEvidence {
  const failing: string[] = [];
  const passing: string[] = [];
  const violatedRules = new Set<string>();
  const fingerprints = new Set<string>();

  for (const record of runs) {
    fingerprints.add(record.evaluation.routeFingerprint);
    for (const violation of record.evaluation.violations) violatedRules.add(violation.ruleId);
    if (record.evaluation.status === "pass") {
      if (passing.length < MAX_REPRESENTATIVES) passing.push(record.traceId);
    } else if (failing.length < MAX_REPRESENTATIVES) {
      failing.push(record.traceId);
    }
  }

  const zeroTolerance = new Set(zeroToleranceRuleIds);
  return {
    representativeFailingTraceIds: failing,
    representativePassingTraceIds: passing,
    zeroToleranceRuleIds: [...violatedRules].filter((id) => zeroTolerance.has(id)).sort(),
    violatedRuleIds: [...violatedRules].sort(),
    observedRouteFingerprints: [...fingerprints].sort(),
  };
}

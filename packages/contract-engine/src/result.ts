import type { BudgetMetric, RuleType } from "@flightrules/contract-schema";
import type { EvaluationStatus, Severity, TraceQuality } from "@flightrules/domain";

/**
 * The evaluator's output vocabulary.
 *
 * Every code here is part of the product's API: it reaches the CLI's JSON mode, the violations
 * table, the SigNoz artefacts of Phase 10 and the Violation Inspector. Adding one is a deliberate
 * change, and none is ever generated from free text.
 */

export const RULE_OUTCOMES = ["pass", "violation", "insufficient_evidence", "deferred"] as const;
export type RuleOutcome = (typeof RULE_OUTCOMES)[number];

export const VIOLATION_CODES = [
  "REQUIRED_SPAN_MISSING",
  "REQUIRED_SPAN_TOO_MANY",
  "REQUIRED_ANCESTRY_MISSING",
  "REQUIRED_EDGE_MISSING",
  "FORBIDDEN_SPAN_PRESENT",
  "FORBIDDEN_PATH_PRESENT",
  "CARDINALITY_BELOW_MIN",
  "CARDINALITY_ABOVE_MAX",
  "DISALLOWED_VALUE",
  "ATTRIBUTE_CONSTRAINT_FAILED",
  "RETRY_BUDGET_PER_TOOL_EXCEEDED",
  "RETRY_BUDGET_RUN_TOTAL_EXCEEDED",
  "RETRY_BUDGET_SIDE_EFFECT_EXCEEDED",
  "ROUTE_NOT_APPROVED",
  "ROUTE_DRIFTED",
  "NUMERIC_BUDGET_EXCEEDED",
] as const;
export type ViolationCode = (typeof VIOLATION_CODES)[number];

/**
 * Reasons a rule could not be decided.
 *
 * Kept as a closed set rather than prose so "why can this not be decided" is queryable. A rule that
 * cannot be decided is the one place where the product must not guess, so the reason has to be as
 * legible as a violation.
 */
export const INSUFFICIENT_EVIDENCE_REASONS = [
  "trace_incomplete",
  "unobservable_subtree",
  "metric_not_emitted",
  "attribute_not_emitted",
  "side_effect_unclassified",
] as const;
export type InsufficientEvidenceReason = (typeof INSUFFICIENT_EVIDENCE_REASONS)[number];

/**
 * Where the evidence for a result sits in the graph.
 *
 * Both span IDs and canonical node orders are carried. Span IDs link to the trace in SigNoz
 * (FR-017); canonical orders identify the same node across two runs of one route, which is what the
 * Release Diff needs. Every list is sorted.
 */
export interface EvidenceReference {
  readonly spanIds: readonly string[];
  readonly canonicalNodes: readonly number[];
  readonly labels: readonly string[];
}

export const EMPTY_EVIDENCE: EvidenceReference = {
  spanIds: [],
  canonicalNodes: [],
  labels: [],
};

export interface Violation {
  /**
   * Stable identifier, derived from the rule, the code and the canonical evidence.
   *
   * Deliberately not derived from span IDs, so the same violation in two runs of the same route
   * carries the same identifier and can be counted as a recurrence rather than as a new finding.
   */
  readonly id: string;
  readonly ruleId: string;
  readonly ruleType: RuleType;
  readonly code: ViolationCode;
  readonly severity: Severity;
  readonly zeroTolerance: boolean;
  /** Written by the evaluator from the observed numbers. No model is involved. */
  readonly summary: string;
  readonly expected: string;
  readonly observed: string;
  readonly evidence: EvidenceReference;
}

/** A measurement the run contributed, for release-level aggregation in Phase 11. */
export interface MetricSample {
  readonly metric: BudgetMetric;
  readonly value: number;
  readonly spanIds: readonly string[];
}

export interface RuleResult {
  readonly ruleId: string;
  readonly ruleType: RuleType;
  readonly severity: Severity;
  readonly outcome: RuleOutcome;
  /** Present exactly when the outcome is `insufficient_evidence`. */
  readonly insufficientReason: InsufficientEvidenceReason | null;
  readonly summary: string;
  readonly evidence: EvidenceReference;
  readonly violations: readonly Violation[];
  readonly samples: readonly MetricSample[];
}

/** An exact ratio plus a fixed-precision decimal rendering of it. */
export interface SimilarityScore {
  readonly numerator: number;
  readonly denominator: number;
  /** Six decimal places, produced by integer arithmetic so it is identical on every platform. */
  readonly decimal: string;
}

/** A graph warning, carried separately so trace quality is never confused with a violation. */
export interface TraceWarningSummary {
  readonly kind: string;
  readonly spanIds: readonly string[];
}

export interface RunEvaluation {
  readonly status: EvaluationStatus;
  readonly evaluatorVersion: string;
  readonly normaliserVersion: string;
  readonly normaliserConfigHash: string;
  readonly contractId: string;
  readonly contractVersion: string;
  readonly contractContentHash: string;
  readonly traceId: string;
  readonly routeFingerprint: string;
  readonly routeApproved: boolean;
  readonly nearestApprovedFingerprint: string | null;
  readonly similarity: SimilarityScore;
  readonly traceQuality: TraceQuality;
  readonly traceWarnings: readonly TraceWarningSummary[];
  readonly ruleResults: readonly RuleResult[];
  readonly violations: readonly Violation[];
  readonly counts: RunEvaluationCounts;
}

export interface RunEvaluationCounts {
  readonly rulesEvaluated: number;
  readonly rulesPassed: number;
  readonly rulesViolated: number;
  readonly rulesInsufficient: number;
  readonly rulesDeferred: number;
  readonly violations: number;
  readonly criticalViolations: number;
  readonly zeroToleranceViolations: number;
}

/**
 * Runtime metadata excluded from the canonical evaluation and therefore from its hash.
 *
 * PRD section 11.12 requires byte-equivalent output for the same inputs "except for explicitly
 * excluded runtime metadata such as completion timestamp". Keeping those values in a separate
 * object rather than inside `RunEvaluation` means the exclusion is structural: there is no way to
 * hash them by accident.
 */
export interface EvaluationRuntime {
  readonly completedAt: string;
  readonly durationMs: number;
}

export interface EvaluatedRun {
  readonly evaluation: RunEvaluation;
  readonly runtime: EvaluationRuntime;
  /** SHA-256 over the canonical evaluation, excluding `runtime`. */
  readonly evaluationHash: string;
}

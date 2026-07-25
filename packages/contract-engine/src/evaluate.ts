import type { ContractRule, RuleType, TrajectoryContract } from "@flightrules/contract-schema";
import { contractContentHash } from "@flightrules/contract-schema";
import { FlightRulesError } from "@flightrules/domain";
import { fingerprintGraph, type TraceGraph } from "@flightrules/trace-graph";
import { canonicaliseEvaluation, hashEvaluation } from "./canonical.js";
import { GraphIndex } from "./graph-index.js";
import type {
  EvaluatedRun,
  RuleResult,
  RunEvaluation,
  RunEvaluationCounts,
  TraceWarningSummary,
  Violation,
} from "./result.js";
import {
  type ApprovedRoute,
  EXACT_SIMILARITY,
  RuleContext,
  ZERO_SIMILARITY,
} from "./rule-context.js";
import {
  evaluateCardinality,
  evaluateForbiddenPath,
  evaluateForbiddenSpan,
  evaluateRequiredAncestry,
  evaluateRequiredEdge,
  evaluateRequiredSpan,
} from "./rules-structure.js";
import {
  evaluateAllowedValues,
  evaluateApprovedRoutes,
  evaluateAttributeConstraint,
  evaluateNumericBudget,
  evaluateRetryBudget,
} from "./rules-values.js";
import { EVALUATOR_VERSION } from "./version.js";

/**
 * Run evaluation (PRD FR-010).
 *
 * Deterministic and offline. No clock, no random value and no network call participates in any
 * decision, and no model is consulted: given the same graph, contract, normaliser version and
 * evaluator version, this function returns byte-identical canonical output.
 */

export interface EvaluateRunInput {
  readonly graph: TraceGraph;
  readonly contract: TrajectoryContract;
  /**
   * Approved route families, for exact matching and nearest-similarity reporting. Phase 08 supplies
   * mined baselines; without them the evaluator can still decide exact fingerprint identity, and
   * says so rather than implying a similarity it could not measure.
   */
  readonly approvedRoutes?: readonly ApprovedRoute[];
  /** Injected so the caller owns the clock. Nothing inside the hashed region reads it. */
  readonly completedAt?: string;
  readonly nowMs?: () => number;
}

/**
 * PRD section 11.11's evaluation order, as data.
 *
 * The order is part of the specification, so it is expressed once, here, rather than implied by the
 * sequence of calls in a function body where a reordering during a refactor would go unnoticed.
 */
const EVALUATION_ORDER: readonly RuleType[] = [
  "required_span",
  "forbidden_span",
  "cardinality",
  "required_edge",
  "required_ancestry",
  "forbidden_path",
  "attribute_constraint",
  "allowed_values",
  "retry_budget",
  "approved_routes",
  "numeric_budget",
];

const ORDER_INDEX = new Map(EVALUATION_ORDER.map((type, index) => [type, index]));

function evaluateRule(rule: ContractRule, context: RuleContext): RuleResult {
  switch (rule.type) {
    case "required_span":
      return evaluateRequiredSpan(rule, context);
    case "required_ancestry":
      return evaluateRequiredAncestry(rule, context);
    case "required_edge":
      return evaluateRequiredEdge(rule, context);
    case "forbidden_span":
      return evaluateForbiddenSpan(rule, context);
    case "forbidden_path":
      return evaluateForbiddenPath(rule, context);
    case "cardinality":
      return evaluateCardinality(rule, context);
    case "allowed_values":
      return evaluateAllowedValues(rule, context);
    case "attribute_constraint":
      return evaluateAttributeConstraint(rule, context);
    case "retry_budget":
      return evaluateRetryBudget(rule, context);
    case "approved_routes":
      return evaluateApprovedRoutes(rule, context);
    case "numeric_budget":
      return evaluateNumericBudget(rule, context);
  }
}

export function evaluateRun(input: EvaluateRunInput): EvaluatedRun {
  const nowMs = input.nowMs ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
  const startedMs = nowMs();

  const index = new GraphIndex(input.graph);
  const fingerprint = fingerprintGraph(input.graph);
  const contentHash = contractContentHash(input.contract);

  const warnings: readonly TraceWarningSummary[] = input.graph.warnings
    .map((warning) => ({ kind: warning.kind, spanIds: [...warning.spanIds].sort() }))
    .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));

  const approvedRoutes = input.approvedRoutes ?? [];
  const context = new RuleContext({
    index,
    contract: input.contract,
    routeFingerprint: fingerprint.fingerprint,
    approvedRoutes,
  });

  const routeApproved = input.contract.spec.approvedRoutes.includes(fingerprint.fingerprint);
  const nearest = routeApproved
    ? { score: EXACT_SIMILARITY, nearest: fingerprint.fingerprint }
    : context.similarityTo(input.contract.spec.approvedRoutes);

  // PRD section 11.11 step 1: graph validity. A trace whose duplicate records contradict each other
  // cannot be judged at all — choosing one of two conflicting accounts of the same span is precisely
  // the guess the determinism boundary forbids — so no rule is evaluated and the run reports
  // insufficient data. Note this is *not* the same as an incomplete trace, which is still evaluated.
  if (input.graph.quality === "inconsistent") {
    const evaluation = assemble({
      status: "insufficient_data",
      input,
      index,
      fingerprint: fingerprint.fingerprint,
      contentHash,
      routeApproved,
      similarity: nearest.score,
      nearestApprovedFingerprint: nearest.nearest,
      warnings,
      ruleResults: [],
    });
    return finish(evaluation, input, startedMs, nowMs);
  }

  const ruleResults = [...input.contract.spec.rules]
    .map((rule) => evaluateRule(rule, context))
    .sort(compareRuleResults);

  const violations = ruleResults
    .flatMap((result) => result.violations)
    .sort((a, b) => {
      // Severity descending, then rule order, then identifier: the most serious finding first, and
      // a total order so the list is byte-stable.
      const bySeverity = severityRank(b.severity) - severityRank(a.severity);
      if (bySeverity !== 0) return bySeverity;
      const byRule = ruleOrder(a.ruleType) - ruleOrder(b.ruleType);
      if (byRule !== 0) return byRule;
      if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const evaluation = assemble({
    status: resolveStatus(ruleResults),
    input,
    index,
    fingerprint: fingerprint.fingerprint,
    contentHash,
    routeApproved,
    similarity: nearest.score,
    nearestApprovedFingerprint: nearest.nearest,
    warnings,
    ruleResults,
    violations,
  });

  return finish(evaluation, input, startedMs, nowMs);
}

/**
 * The run's status.
 *
 * Any violation fails the run. Otherwise, an undecidable rule makes the run `insufficient_data`
 * rather than a pass: a contract that could not be checked has not been satisfied, and reporting a
 * pass would be the false green the operating contract forbids. A rule deferred to release scope does
 * not count — it was not undecidable, it was simply not this scope's question.
 */
function resolveStatus(results: readonly RuleResult[]): RunEvaluation["status"] {
  if (results.some((result) => result.outcome === "violation")) return "fail";
  if (results.some((result) => result.outcome === "insufficient_evidence"))
    return "insufficient_data";
  return "pass";
}

function severityRank(severity: RuleResult["severity"]): number {
  switch (severity) {
    case "critical":
      return 3;
    case "high":
      return 2;
    case "medium":
      return 1;
    case "low":
      return 0;
  }
}

function ruleOrder(type: RuleType): number {
  return ORDER_INDEX.get(type) ?? EVALUATION_ORDER.length;
}

/** PRD section 11.11 order, then rule identifier, so declaration order cannot affect the output. */
function compareRuleResults(a: RuleResult, b: RuleResult): number {
  const byType = ruleOrder(a.ruleType) - ruleOrder(b.ruleType);
  if (byType !== 0) return byType;
  return a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0;
}

function assemble(parts: {
  readonly status: RunEvaluation["status"];
  readonly input: EvaluateRunInput;
  readonly index: GraphIndex;
  readonly fingerprint: string;
  readonly contentHash: string;
  readonly routeApproved: boolean;
  readonly similarity: RunEvaluation["similarity"];
  readonly nearestApprovedFingerprint: string | null;
  readonly warnings: readonly TraceWarningSummary[];
  readonly ruleResults: readonly RuleResult[];
  readonly violations?: readonly Violation[];
}): RunEvaluation {
  const violations = parts.violations ?? [];

  const counts: RunEvaluationCounts = {
    rulesEvaluated: parts.ruleResults.length,
    rulesPassed: parts.ruleResults.filter((result) => result.outcome === "pass").length,
    rulesViolated: parts.ruleResults.filter((result) => result.outcome === "violation").length,
    rulesInsufficient: parts.ruleResults.filter(
      (result) => result.outcome === "insufficient_evidence",
    ).length,
    rulesDeferred: parts.ruleResults.filter((result) => result.outcome === "deferred").length,
    violations: violations.length,
    criticalViolations: violations.filter((entry) => entry.severity === "critical").length,
    zeroToleranceViolations: violations.filter((entry) => entry.zeroTolerance).length,
  };

  return {
    status: parts.status,
    evaluatorVersion: EVALUATOR_VERSION,
    normaliserVersion: parts.input.graph.normaliserVersion,
    normaliserConfigHash: parts.input.graph.normaliserConfigHash,
    contractId: parts.input.contract.metadata.id,
    contractVersion: parts.input.contract.metadata.version,
    contractContentHash: parts.contentHash,
    traceId: parts.input.graph.traceId,
    routeFingerprint: parts.fingerprint,
    routeApproved: parts.routeApproved,
    nearestApprovedFingerprint: parts.nearestApprovedFingerprint,
    similarity: parts.routeApproved ? EXACT_SIMILARITY : (parts.similarity ?? ZERO_SIMILARITY),
    traceQuality: parts.input.graph.quality,
    traceWarnings: parts.warnings,
    ruleResults: parts.ruleResults,
    violations,
    counts,
  };
}

function finish(
  evaluation: RunEvaluation,
  input: EvaluateRunInput,
  startedMs: number,
  nowMs: () => number,
): EvaluatedRun {
  return {
    evaluation,
    runtime: {
      // Outside the hashed region by construction, not by convention. PRD section 11.12 excludes
      // completion time from byte-equivalence, and the only way to guarantee that is for the hash to
      // have no access to it.
      completedAt: input.completedAt ?? "",
      durationMs: Math.max(0, nowMs() - startedMs),
    },
    evaluationHash: hashEvaluation(evaluation),
  };
}

/**
 * Evaluates a run, converting an unexpected internal failure into an explicit error status.
 *
 * PRD section 20.1 requires that the release gate never returns pass after an internal error. That
 * is only enforceable if there is exactly one place where an internal error becomes a status, and
 * that place cannot produce `pass`.
 */
export function evaluateRunSafely(input: EvaluateRunInput): EvaluatedRun {
  try {
    return evaluateRun(input);
  } catch (error: unknown) {
    const code = error instanceof FlightRulesError ? error.code : "EVALUATION_FAILED";
    const evaluation: RunEvaluation = {
      status: "error",
      evaluatorVersion: EVALUATOR_VERSION,
      normaliserVersion: input.graph.normaliserVersion,
      normaliserConfigHash: input.graph.normaliserConfigHash,
      contractId: input.contract.metadata.id,
      contractVersion: input.contract.metadata.version,
      contractContentHash: contractContentHash(input.contract),
      traceId: input.graph.traceId,
      routeFingerprint: "",
      routeApproved: false,
      nearestApprovedFingerprint: null,
      similarity: ZERO_SIMILARITY,
      traceQuality: input.graph.quality,
      traceWarnings: [{ kind: "evaluation_error", spanIds: [] }],
      ruleResults: [],
      violations: [],
      counts: {
        rulesEvaluated: 0,
        rulesPassed: 0,
        rulesViolated: 0,
        rulesInsufficient: 0,
        rulesDeferred: 0,
        violations: 0,
        criticalViolations: 0,
        zeroToleranceViolations: 0,
      },
    };
    return {
      evaluation,
      runtime: { completedAt: input.completedAt ?? "", durationMs: 0 },
      // The error code travels in the hash region, so two runs that failed differently are
      // distinguishable, and neither can be mistaken for a pass.
      evaluationHash: hashEvaluation({
        ...evaluation,
        contractId: `${evaluation.contractId}#${code}`,
      }),
    };
  }
}

export { canonicaliseEvaluation };

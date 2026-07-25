import { createHash } from "node:crypto";
import type {
  EvidenceReference,
  MetricSample,
  RuleResult,
  RunEvaluation,
  Violation,
} from "./result.js";

/**
 * Canonical evaluation serialisation (PRD section 11.12).
 *
 * The requirement is byte-equivalent output for the same graph, contract, normaliser version and
 * evaluator version, excluding runtime metadata such as the completion timestamp. That exclusion is
 * structural: `EvaluationRuntime` is a separate object and nothing in this file can reach it.
 *
 * Every object is written with its keys in a fixed literal order, and every collection arriving here
 * has already been sorted by the evaluator. Nothing is sorted twice and nothing relies on the order
 * a `Map` happened to be filled in.
 */

function canonicalEvidence(evidence: EvidenceReference): unknown {
  return {
    spanIds: [...evidence.spanIds],
    canonicalNodes: [...evidence.canonicalNodes],
    labels: [...evidence.labels],
  };
}

function canonicalViolation(entry: Violation): unknown {
  return {
    id: entry.id,
    ruleId: entry.ruleId,
    ruleType: entry.ruleType,
    code: entry.code,
    severity: entry.severity,
    zeroTolerance: entry.zeroTolerance,
    summary: entry.summary,
    expected: entry.expected,
    observed: entry.observed,
    evidence: canonicalEvidence(entry.evidence),
  };
}

function canonicalSample(sample: MetricSample): unknown {
  return { metric: sample.metric, value: sample.value, spanIds: [...sample.spanIds] };
}

function canonicalRuleResult(result: RuleResult): unknown {
  return {
    ruleId: result.ruleId,
    ruleType: result.ruleType,
    severity: result.severity,
    outcome: result.outcome,
    insufficientReason: result.insufficientReason,
    summary: result.summary,
    evidence: canonicalEvidence(result.evidence),
    violations: result.violations.map(canonicalViolation),
    samples: result.samples.map(canonicalSample),
  };
}

export function canonicaliseEvaluation(evaluation: RunEvaluation): unknown {
  return {
    status: evaluation.status,
    evaluatorVersion: evaluation.evaluatorVersion,
    normaliserVersion: evaluation.normaliserVersion,
    normaliserConfigHash: evaluation.normaliserConfigHash,
    contractId: evaluation.contractId,
    contractVersion: evaluation.contractVersion,
    contractContentHash: evaluation.contractContentHash,
    traceId: evaluation.traceId,
    routeFingerprint: evaluation.routeFingerprint,
    routeApproved: evaluation.routeApproved,
    nearestApprovedFingerprint: evaluation.nearestApprovedFingerprint,
    similarity: {
      numerator: evaluation.similarity.numerator,
      denominator: evaluation.similarity.denominator,
      decimal: evaluation.similarity.decimal,
    },
    traceQuality: evaluation.traceQuality,
    traceWarnings: evaluation.traceWarnings.map((warning) => ({
      kind: warning.kind,
      spanIds: [...warning.spanIds],
    })),
    ruleResults: evaluation.ruleResults.map(canonicalRuleResult),
    violations: evaluation.violations.map(canonicalViolation),
    counts: {
      rulesEvaluated: evaluation.counts.rulesEvaluated,
      rulesPassed: evaluation.counts.rulesPassed,
      rulesViolated: evaluation.counts.rulesViolated,
      rulesInsufficient: evaluation.counts.rulesInsufficient,
      rulesDeferred: evaluation.counts.rulesDeferred,
      violations: evaluation.counts.violations,
      criticalViolations: evaluation.counts.criticalViolations,
      zeroToleranceViolations: evaluation.counts.zeroToleranceViolations,
    },
  };
}

export function serialiseEvaluation(evaluation: RunEvaluation): string {
  return JSON.stringify(canonicaliseEvaluation(evaluation));
}

export function hashEvaluation(evaluation: RunEvaluation): string {
  return createHash("sha256").update(serialiseEvaluation(evaluation)).digest("hex");
}

/**
 * The trace identifier is inside the canonical region.
 *
 * Two runs of the same route are two different runs, and an evaluation is a statement about one of
 * them. Excluding the trace ID would make two distinct evaluations hash identically, so
 * "byte-equivalent output for the same graph" would silently become "for the same route" — and a
 * stored evaluation could no longer be tied back to the trace that produced it.
 *
 * Determinism across *runs* is proven instead by re-evaluating the same graph, and route-level
 * stability by comparing the fingerprint, which excludes identifiers by design.
 */
export const TRACE_ID_IS_CANONICAL = true;

export {
  canonicaliseEvaluation,
  hashEvaluation,
  serialiseEvaluation,
} from "./canonical.js";
export type { EvaluateRunInput } from "./evaluate.js";
export { evaluateRun, evaluateRunSafely } from "./evaluate.js";
export { absentEvidence, describeSelector, evidenceFor, violation } from "./evidence.js";
export { GraphIndex } from "./graph-index.js";
export type {
  EvaluatedRun,
  EvaluationRuntime,
  EvidenceReference,
  InsufficientEvidenceReason,
  MetricSample,
  RuleOutcome,
  RuleResult,
  RunEvaluation,
  RunEvaluationCounts,
  SimilarityScore,
  TraceWarningSummary,
  Violation,
  ViolationCode,
} from "./result.js";
export {
  EMPTY_EVIDENCE,
  INSUFFICIENT_EVIDENCE_REASONS,
  RULE_OUTCOMES,
  VIOLATION_CODES,
} from "./result.js";
export type { ApprovedRoute } from "./rule-context.js";
export {
  atLeastThreshold,
  criticalNodeLabels,
  EXACT_SIMILARITY,
  exactJaccard,
  RuleContext,
  toSimilarityScore,
  ZERO_SIMILARITY,
} from "./rule-context.js";
export { CompiledSelector, scalarKey, sortByCanonicalOrder } from "./selector.js";
export { EVALUATOR_VERSION } from "./version.js";

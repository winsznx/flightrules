export {
  canonicaliseEvaluation,
  hashEvaluation,
  serialiseEvaluation,
} from "./canonical.js";
export type { EvaluateRunInput } from "./evaluate.js";
export { evaluateRun, evaluateRunSafely } from "./evaluate.js";
export { absentEvidence, describeSelector, evidenceFor, violation } from "./evidence.js";
export type { ExitCode } from "./exit-codes.js";
export {
  EXIT_CODE_DESCRIPTIONS,
  EXIT_CODES,
  exitCodeForDecision,
  exitCodeForError,
} from "./exit-codes.js";
export { GraphIndex } from "./graph-index.js";
export type {
  AggregateReleaseInput,
  ChangeMeasure,
  GateDisclosure,
  GateDisclosureCode,
  GateFinding,
  GateFindingCode,
  Rate,
  ReleaseBaselineReference,
  ReleaseChanges,
  ReleaseCounts,
  ReleaseDecision,
  ReleaseEvaluation,
  ReleaseEvidence,
  ReleaseRates,
  ReleaseRuleOutcome,
  ReleaseRuleResult,
  ReleaseRunRecord,
  RetrievalState,
} from "./release.js";
export {
  aggregateRelease,
  GATE_DISCLOSURE_CODES,
  GATE_FINDING_CODES,
  hashReleaseEvaluation,
  percentExceeds,
  percentileOfAscending,
  RELEASE_DECISIONS,
  RELEASE_RULE_OUTCOMES,
  RELEASE_SCHEMA_VERSION,
  serialiseReleaseEvaluation,
  toRate,
} from "./release.js";
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
export { countDuplicateSideEffects, sideEffectingRuleIds } from "./side-effects.js";
export { EVALUATOR_VERSION } from "./version.js";

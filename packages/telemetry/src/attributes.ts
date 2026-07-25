/**
 * Every attribute name FlightRules or its demo emits.
 *
 * Standard names are re-exported from the installed OpenTelemetry packages so the import path
 * itself states the stability: anything from `/incubating` is experimental and is documented as
 * such in `docs/research/otel-attributes.md`. Nothing here is a remembered string literal.
 */
import {
  ATTR_ERROR_TYPE,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_TYPE,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_WORKFLOW_NAME,
  ATTR_SERVICE_INSTANCE_ID,
  ATTR_VCS_REF_HEAD_REVISION,
} from "@opentelemetry/semantic-conventions/incubating";

/** Stable OpenTelemetry conventions. */
export const STABLE = {
  serviceName: ATTR_SERVICE_NAME,
  serviceVersion: ATTR_SERVICE_VERSION,
  errorType: ATTR_ERROR_TYPE,
} as const;

/**
 * Experimental OpenTelemetry conventions. Every `gen_ai.*` attribute is experimental in
 * semantic-conventions 1.43.0 — the stable entry point exports none of them. No critical contract
 * rule may depend on one of these alone; see ADR-0004.
 */
export const EXPERIMENTAL = {
  deploymentEnvironmentName: ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  serviceInstanceId: ATTR_SERVICE_INSTANCE_ID,
  vcsRefHeadRevision: ATTR_VCS_REF_HEAD_REVISION,
  genAiOperationName: ATTR_GEN_AI_OPERATION_NAME,
  genAiWorkflowName: ATTR_GEN_AI_WORKFLOW_NAME,
  genAiAgentName: ATTR_GEN_AI_AGENT_NAME,
  genAiToolName: ATTR_GEN_AI_TOOL_NAME,
  genAiToolType: ATTR_GEN_AI_TOOL_TYPE,
  genAiProviderName: ATTR_GEN_AI_PROVIDER_NAME,
  genAiRequestModel: ATTR_GEN_AI_REQUEST_MODEL,
  genAiResponseModel: ATTR_GEN_AI_RESPONSE_MODEL,
  genAiUsageInputTokens: ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  genAiUsageOutputTokens: ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
} as const;

/**
 * Demo agent attributes. PRD section 17.2 reserves `agent.*` for application-specific agent
 * metadata where no stable standard exists.
 */
export const AGENT = {
  releaseId: "agent.release.id",
  runId: "agent.run.id",
  stepCategory: "agent.step.category",
  sideEffect: "agent.side_effect",
  dataDomain: "agent.data_domain",
  retryNumber: "agent.retry.number",
  idempotencyPresent: "agent.idempotency.present",
  idempotencyKeyHash: "agent.idempotency.key_hash",
  contractId: "agent.contract.id",
  scenario: "agent.scenario",
  /**
   * PRD section 17.2 names this attribute. The released OpenTelemetry convention is
   * `vcs.ref.head.revision`; there is no `vcs.commit.sha` in the registry. Both are emitted with
   * the same value so neither the PRD nor the standard is weakened. See ADR-0004.
   */
  vcsCommitSha: "vcs.commit.sha",
} as const;

/** FlightRules evaluator attributes. PRD section 17.3. */
export const FLIGHT_RULES = {
  projectId: "flight_rules.project.id",
  agentId: "flight_rules.agent.id",
  contractId: "flight_rules.contract.id",
  contractVersion: "flight_rules.contract.version",
  releaseId: "flight_rules.release.id",
  evaluationId: "flight_rules.evaluation.id",
  evaluationStatus: "flight_rules.evaluation.status",
  violationCount: "flight_rules.violation.count",
  routeFingerprint: "flight_rules.route.fingerprint",
  routeSimilarity: "flight_rules.route.similarity",
  gateDecision: "flight_rules.gate.decision",
  ruleId: "flight_rules.rule.id",
  ruleType: "flight_rules.rule.type",
  violationSeverity: "flight_rules.violation.severity",
  artifactType: "flight_rules.artifact.type",
  normaliserVersion: "flight_rules.normaliser.version",
  evaluatorVersion: "flight_rules.evaluator.version",
} as const;

/** FlightRules span names. PRD section 17.3. */
export const SPAN_NAMES = {
  fetchTraces: "flight_rules.fetch_traces",
  reconstructTrace: "flight_rules.reconstruct_trace",
  normaliseGraph: "flight_rules.normalise_graph",
  mineBaseline: "flight_rules.mine_baseline",
  proposeContract: "flight_rules.propose_contract",
  evaluateRun: "flight_rules.evaluate_run",
  evaluateRelease: "flight_rules.evaluate_release",
  compileSignozArtifacts: "flight_rules.compile_signoz_artifacts",
  releaseGate: "flight_rules.release_gate",
} as const;

/** Metric instrument names. PRD section 17.4. */
export const METRIC_NAMES = {
  evaluations: "flight_rules.evaluations",
  evaluationDuration: "flight_rules.evaluation.duration",
  violations: "flight_rules.violations",
  unknownRoutes: "flight_rules.unknown_routes",
  duplicateSideEffects: "flight_rules.duplicate_side_effects",
  releaseGateDecisions: "flight_rules.release_gate.decisions",
  traceFetchFailures: "flight_rules.trace_fetch.failures",
  signozArtifactSync: "flight_rules.signoz_artifact_sync",
  routeSimilarity: "flight_rules.route.similarity",
} as const;

/**
 * Attributes marked high cardinality in the register. These may appear as span attributes but
 * never as metric dimensions (PRD section 17.4). Enforced by test, not by convention.
 */
export const HIGH_CARDINALITY_ATTRIBUTES: readonly string[] = [
  AGENT.runId,
  AGENT.idempotencyKeyHash,
  FLIGHT_RULES.evaluationId,
  FLIGHT_RULES.routeFingerprint,
];

const HIGH_CARDINALITY_SET: ReadonlySet<string> = new Set(HIGH_CARDINALITY_ATTRIBUTES);

export function isHighCardinality(attribute: string): boolean {
  return HIGH_CARDINALITY_SET.has(attribute);
}

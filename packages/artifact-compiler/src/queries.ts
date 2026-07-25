import { AGENT, FLIGHT_RULES } from "@flightrules/telemetry";

/**
 * The filter expressions and typed field references every generated artefact shares.
 *
 * Two rules govern everything here and both were learned from the running server.
 *
 * **SL-046.** A Query Builder field reference must carry the data type the field actually has.
 * `agent.idempotency.present` is `bool` and `agent.retry.number` is `number` in the live catalogue;
 * a reference that omits the type returns `null` rather than an error, and a `null` that is read as
 * `0` or `false` is a silently wrong panel. Every reference below is typed.
 *
 * **The two shapes are not interchangeable.** A saved view's builder spec takes wire ordering
 * (`order: [{key: {name}, direction}]`) and an object `having`. A dashboard widget takes editor
 * ordering (`orderBy: [{columnName, order}]`) and an array `having`. Sending one where the other is
 * expected is rejected by panel validation, so they are built by separate functions rather than by
 * one function with a flag.
 */

export type FieldContext = "span" | "resource" | "tag";
export type FieldDataType = "string" | "number" | "bool";

export interface TypedField {
  readonly name: string;
  readonly context: FieldContext;
  readonly dataType: FieldDataType;
}

/** Typed references to the attributes the demo emits, as the live field catalogue reports them. */
export const FIELDS = {
  traceId: { name: "trace_id", context: "span", dataType: "string" },
  spanName: { name: "name", context: "span", dataType: "string" },
  serviceName: { name: "service.name", context: "resource", dataType: "string" },
  durationNano: { name: "duration_nano", context: "span", dataType: "number" },
  releaseId: { name: AGENT.releaseId, context: "tag", dataType: "string" },
  runId: { name: AGENT.runId, context: "tag", dataType: "string" },
  stepCategory: { name: AGENT.stepCategory, context: "tag", dataType: "string" },
  sideEffect: { name: AGENT.sideEffect, context: "tag", dataType: "string" },
  dataDomain: { name: AGENT.dataDomain, context: "tag", dataType: "string" },
  retryNumber: { name: AGENT.retryNumber, context: "tag", dataType: "number" },
  idempotencyPresent: { name: AGENT.idempotencyPresent, context: "tag", dataType: "bool" },
  scenario: { name: AGENT.scenario, context: "tag", dataType: "string" },
  evaluationStatus: { name: FLIGHT_RULES.evaluationStatus, context: "tag", dataType: "string" },
  violationCount: { name: FLIGHT_RULES.violationCount, context: "tag", dataType: "number" },
  zeroToleranceCount: {
    name: "flight_rules.violation.zero_tolerance_count",
    context: "tag",
    dataType: "number",
  },
  duplicateSideEffectCount: {
    name: "flight_rules.duplicate_side_effect.count",
    context: "tag",
    dataType: "number",
  },
  routeApproved: { name: "flight_rules.route.approved", context: "tag", dataType: "bool" },
  routeFingerprint: { name: FLIGHT_RULES.routeFingerprint, context: "tag", dataType: "string" },
  evaluatedTraceId: { name: FLIGHT_RULES.evaluatedTraceId, context: "tag", dataType: "string" },
  contractVersion: { name: FLIGHT_RULES.contractVersion, context: "tag", dataType: "string" },
} as const satisfies Record<string, TypedField>;

/** Escapes a single-quoted filter literal. A managed name contains no quote, but a slug might. */
export function quote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * Filters.
 *
 * `EXISTS AND !=` rather than a bare `!=`: a negative operator matches rows that lack the field
 * entirely, so a bare inequality would sweep in every span of every other service.
 */
export const FILTERS = {
  /** Any span the demo agent produced for one release. */
  releaseRuns: (rootSpanName: string, releaseKey: string): string =>
    `name = ${quote(rootSpanName)} AND ${AGENT.releaseId} = ${quote(releaseKey)}`,

  /** Every run of the agent, whichever release produced it. */
  allRuns: (rootSpanName: string): string =>
    `name = ${quote(rootSpanName)} AND ${AGENT.releaseId} EXISTS`,

  /** Runs the evaluator judged and found violating. */
  violatingRuns: (): string =>
    `name = ${quote("flight_rules.evaluate_run")} AND ${FLIGHT_RULES.violationCount} > 0`,

  /** Runs whose route the active contract does not approve. */
  unknownRoutes: (): string =>
    `name = ${quote("flight_rules.evaluate_run")} AND flight_rules.route.approved = false`,

  /** Runs in which a write or external step happened more often than the contract permits. */
  duplicateSideEffects: (): string =>
    `name = ${quote("flight_rules.evaluate_run")} AND flight_rules.duplicate_side_effect.count > 0`,

  /** The side-effecting steps themselves, for the run-level investigation view. */
  sideEffectingSteps: (): string =>
    `${AGENT.sideEffect} IN ('write', 'external') AND ${AGENT.releaseId} EXISTS`,

  /** Every evaluation the release-comparison view compares. */
  evaluatedRuns: (): string =>
    `name = ${quote("flight_rules.evaluate_run")} AND ${AGENT.releaseId} EXISTS`,
} as const;

export const ROOT_SPAN_DEFAULT = "refund.request";

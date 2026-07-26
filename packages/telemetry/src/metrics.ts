import { HIGH_CARDINALITY_ATTRIBUTES, METRIC_NAMES } from "./attributes.js";

/**
 * Declared metric instruments and their permitted dimension sets.
 *
 * The dimensions are declared as data rather than being scattered across call sites so a single
 * test can cross-reference every one of them against the high-cardinality register. PRD section
 * 17.4 forbids trace IDs, span IDs, route fingerprints, evaluation IDs, run IDs, idempotency key
 * hashes, full error messages and user identifiers as metric labels.
 */
export interface MetricSpec {
  readonly name: string;
  readonly kind: "counter" | "histogram";
  readonly unit: string;
  readonly description: string;
  readonly dimensions: readonly string[];
}

/**
 * The dimensions that say *who* a measurement is about.
 *
 * Declared once and spread into every instrument, so an instrument cannot quietly carry a different
 * identity set from its neighbours — which is exactly how the emitting side and the querying side
 * came to disagree before Phase 16. The `flight_rules.*` names are the ones the API, the saved
 * views and the spans select on; the slug and key are what a dashboard legend shows. Both are
 * one-to-one with the identifier, so neither multiplies the series count.
 */
export const AGENT_IDENTITY = [
  "flight_rules.project.id",
  "flight_rules.agent.id",
  "project.slug",
  "agent.key",
] as const;

export const RELEASE_IDENTITY = [
  ...AGENT_IDENTITY,
  "flight_rules.release.id",
  "release.key",
] as const;

/**
 * The dimension names a caller may narrow a FlightRules metric by.
 *
 * `GET /api/violations/:id/metrics` groups by these. Exported rather than repeated there, because
 * the two lists being separate string literals is precisely the defect SL-062 recorded as a SigNoz
 * behaviour: the API grouped by names the instruments never emitted, so SigNoz returned the
 * requested labels carrying empty values and a real series read as unscoped.
 */
export const QUERYABLE_IDENTITY_DIMENSIONS = [
  "flight_rules.project.id",
  "flight_rules.agent.id",
] as const;

export const METRIC_SPECS: readonly MetricSpec[] = [
  {
    name: METRIC_NAMES.evaluations,
    kind: "counter",
    unit: "{evaluation}",
    description: "Contract evaluations completed, by outcome.",
    dimensions: [...RELEASE_IDENTITY, "status", "scope"],
  },
  {
    name: METRIC_NAMES.evaluationDuration,
    kind: "histogram",
    unit: "ms",
    description: "Wall-clock duration of a contract evaluation.",
    dimensions: [...RELEASE_IDENTITY, "scope"],
  },
  {
    name: METRIC_NAMES.violations,
    kind: "counter",
    unit: "{violation}",
    description: "Typed contract violations, by rule type and severity.",
    dimensions: [...RELEASE_IDENTITY, "rule.type", "severity"],
  },
  {
    name: METRIC_NAMES.unknownRoutes,
    kind: "counter",
    unit: "{run}",
    description: "Runs whose route fingerprint matched no approved route family.",
    dimensions: [...RELEASE_IDENTITY],
  },
  {
    name: METRIC_NAMES.duplicateSideEffects,
    kind: "counter",
    unit: "{occurrence}",
    description: "Side-effecting operations observed more than once within one run.",
    dimensions: [...RELEASE_IDENTITY],
  },
  {
    name: METRIC_NAMES.releaseGateDecisions,
    kind: "counter",
    unit: "{decision}",
    description: "Release gate decisions.",
    dimensions: [...RELEASE_IDENTITY, "decision"],
  },
  {
    name: METRIC_NAMES.traceFetchFailures,
    kind: "counter",
    unit: "{failure}",
    description: "Trace retrieval failures, by error type.",
    dimensions: [...AGENT_IDENTITY, "error.type"],
  },
  {
    name: METRIC_NAMES.signozArtifactSync,
    kind: "counter",
    unit: "{sync}",
    description: "SigNoz artifact sync attempts, by artifact type and outcome.",
    dimensions: [...AGENT_IDENTITY, "artifact.type", "status"],
  },
  {
    name: METRIC_NAMES.routeSimilarity,
    kind: "histogram",
    unit: "1",
    description: "Similarity of an observed route to its nearest approved family.",
    dimensions: [...RELEASE_IDENTITY],
  },
];

/**
 * Instruments that do not carry every dimension a caller is allowed to narrow by.
 *
 * A non-empty result means a query written against `QUERYABLE_IDENTITY_DIMENSIONS` would ask SigNoz
 * to group by a label that instrument never sets — which returns the label with an empty value
 * rather than an error, and so looks like real but unscoped data.
 */
export function metricDimensionDisagreement(): readonly { metric: string; missing: string }[] {
  const findings: { metric: string; missing: string }[] = [];
  for (const spec of METRIC_SPECS) {
    for (const dimension of QUERYABLE_IDENTITY_DIMENSIONS) {
      if (!spec.dimensions.includes(dimension))
        findings.push({ metric: spec.name, missing: dimension });
    }
  }
  return findings;
}

/** Dimensions that would blow up cardinality, found by cross-referencing the register. */
export function highCardinalityDimensions(): readonly { metric: string; dimension: string }[] {
  const forbidden = new Set<string>(HIGH_CARDINALITY_ATTRIBUTES);
  const findings: { metric: string; dimension: string }[] = [];
  for (const spec of METRIC_SPECS) {
    for (const dimension of spec.dimensions) {
      if (forbidden.has(dimension)) findings.push({ metric: spec.name, dimension });
    }
  }
  return findings;
}

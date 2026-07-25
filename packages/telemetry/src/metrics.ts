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

export const METRIC_SPECS: readonly MetricSpec[] = [
  {
    name: METRIC_NAMES.evaluations,
    kind: "counter",
    unit: "{evaluation}",
    description: "Contract evaluations completed, by outcome.",
    dimensions: ["project.slug", "agent.key", "release.key", "status", "scope"],
  },
  {
    name: METRIC_NAMES.evaluationDuration,
    kind: "histogram",
    unit: "ms",
    description: "Wall-clock duration of a contract evaluation.",
    dimensions: ["project.slug", "agent.key", "scope"],
  },
  {
    name: METRIC_NAMES.violations,
    kind: "counter",
    unit: "{violation}",
    description: "Typed contract violations, by rule type and severity.",
    dimensions: ["project.slug", "agent.key", "release.key", "rule.type", "severity"],
  },
  {
    name: METRIC_NAMES.unknownRoutes,
    kind: "counter",
    unit: "{run}",
    description: "Runs whose route fingerprint matched no approved route family.",
    dimensions: ["project.slug", "agent.key", "release.key"],
  },
  {
    name: METRIC_NAMES.duplicateSideEffects,
    kind: "counter",
    unit: "{occurrence}",
    description: "Side-effecting operations observed more than once within one run.",
    dimensions: ["project.slug", "agent.key", "release.key"],
  },
  {
    name: METRIC_NAMES.releaseGateDecisions,
    kind: "counter",
    unit: "{decision}",
    description: "Release gate decisions.",
    dimensions: ["project.slug", "agent.key", "release.key", "decision"],
  },
  {
    name: METRIC_NAMES.traceFetchFailures,
    kind: "counter",
    unit: "{failure}",
    description: "Trace retrieval failures, by error type.",
    dimensions: ["project.slug", "agent.key", "error.type"],
  },
  {
    name: METRIC_NAMES.signozArtifactSync,
    kind: "counter",
    unit: "{sync}",
    description: "SigNoz artifact sync attempts, by artifact type and outcome.",
    dimensions: ["project.slug", "agent.key", "artifact.type", "status"],
  },
  {
    name: METRIC_NAMES.routeSimilarity,
    kind: "histogram",
    unit: "1",
    description: "Similarity of an observed route to its nearest approved family.",
    dimensions: ["project.slug", "agent.key", "release.key"],
  },
];

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

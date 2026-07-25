import {
  type Attributes,
  type Counter,
  type Histogram,
  type Meter,
  metrics,
} from "@opentelemetry/api";
import { isHighCardinality, METRIC_NAMES } from "./attributes.js";
import { METRIC_SPECS } from "./metrics.js";

/**
 * The FlightRules metric instruments (PRD section 17.4, FR-016).
 *
 * `METRIC_SPECS` already declares every instrument and the dimensions it may carry, and a test
 * cross-references those against the high-cardinality register. This module is the emission side of
 * the same declaration: every recording goes through a typed method whose dimensions are fixed in
 * code, so a trace ID or a route fingerprint cannot become a label by accident. `filterDimensions`
 * is a second, runtime guard for the same rule — cardinality explosion is a cost incident, not a
 * type error, so it is worth catching twice.
 */

const SPEC_BY_NAME = new Map(METRIC_SPECS.map((spec) => [spec.name, spec]));

/** Drops any attribute the instrument did not declare, and any high-cardinality key outright. */
export function filterDimensions(metricName: string, attributes: Attributes): Attributes {
  const permitted = SPEC_BY_NAME.get(metricName)?.dimensions ?? [];
  const result: Attributes = {};
  for (const key of permitted) {
    const value = attributes[key];
    if (value === undefined || isHighCardinality(key)) continue;
    result[key] = value;
  }
  return result;
}

export interface EvaluationDimensions {
  readonly projectSlug: string;
  readonly agentKey: string;
  readonly releaseKey: string;
  readonly scope: "run" | "release";
}

/**
 * Typed recording surface. One instance per process; the instruments themselves are cached by the
 * SDK, so constructing this twice is harmless.
 */
export class FlightRulesMetrics {
  readonly #evaluations: Counter;
  readonly #evaluationDuration: Histogram;
  readonly #violations: Counter;
  readonly #unknownRoutes: Counter;
  readonly #duplicateSideEffects: Counter;
  readonly #gateDecisions: Counter;
  readonly #traceFetchFailures: Counter;
  readonly #artifactSync: Counter;
  readonly #routeSimilarity: Histogram;

  constructor(meter: Meter = metrics.getMeter("flightrules")) {
    const spec = (name: string) => {
      const found = SPEC_BY_NAME.get(name);
      if (!found) throw new Error(`No metric spec declared for ${name}`);
      return found;
    };
    const counter = (name: string): Counter => {
      const declared = spec(name);
      return meter.createCounter(name, {
        unit: declared.unit,
        description: declared.description,
      });
    };
    const histogram = (name: string): Histogram => {
      const declared = spec(name);
      return meter.createHistogram(name, {
        unit: declared.unit,
        description: declared.description,
      });
    };

    this.#evaluations = counter(METRIC_NAMES.evaluations);
    this.#evaluationDuration = histogram(METRIC_NAMES.evaluationDuration);
    this.#violations = counter(METRIC_NAMES.violations);
    this.#unknownRoutes = counter(METRIC_NAMES.unknownRoutes);
    this.#duplicateSideEffects = counter(METRIC_NAMES.duplicateSideEffects);
    this.#gateDecisions = counter(METRIC_NAMES.releaseGateDecisions);
    this.#traceFetchFailures = counter(METRIC_NAMES.traceFetchFailures);
    this.#artifactSync = counter(METRIC_NAMES.signozArtifactSync);
    this.#routeSimilarity = histogram(METRIC_NAMES.routeSimilarity);
  }

  recordEvaluation(dimensions: EvaluationDimensions, status: string, durationMs: number): void {
    const base = {
      "project.slug": dimensions.projectSlug,
      "agent.key": dimensions.agentKey,
      "release.key": dimensions.releaseKey,
      scope: dimensions.scope,
    };
    this.#evaluations.add(1, filterDimensions(METRIC_NAMES.evaluations, { ...base, status }));
    this.#evaluationDuration.record(
      durationMs,
      filterDimensions(METRIC_NAMES.evaluationDuration, base),
    );
  }

  recordViolation(
    dimensions: EvaluationDimensions,
    ruleType: string,
    severity: string,
    count = 1,
  ): void {
    this.#violations.add(
      count,
      filterDimensions(METRIC_NAMES.violations, {
        "project.slug": dimensions.projectSlug,
        "agent.key": dimensions.agentKey,
        "release.key": dimensions.releaseKey,
        "rule.type": ruleType,
        severity,
      }),
    );
  }

  recordUnknownRoute(dimensions: EvaluationDimensions): void {
    this.#unknownRoutes.add(
      1,
      filterDimensions(METRIC_NAMES.unknownRoutes, {
        "project.slug": dimensions.projectSlug,
        "agent.key": dimensions.agentKey,
        "release.key": dimensions.releaseKey,
      }),
    );
  }

  recordDuplicateSideEffect(dimensions: EvaluationDimensions, count: number): void {
    if (count <= 0) return;
    this.#duplicateSideEffects.add(
      count,
      filterDimensions(METRIC_NAMES.duplicateSideEffects, {
        "project.slug": dimensions.projectSlug,
        "agent.key": dimensions.agentKey,
        "release.key": dimensions.releaseKey,
      }),
    );
  }

  recordRouteSimilarity(dimensions: EvaluationDimensions, similarity: number): void {
    this.#routeSimilarity.record(
      similarity,
      filterDimensions(METRIC_NAMES.routeSimilarity, {
        "project.slug": dimensions.projectSlug,
        "agent.key": dimensions.agentKey,
        "release.key": dimensions.releaseKey,
      }),
    );
  }

  recordGateDecision(dimensions: EvaluationDimensions, decision: string): void {
    this.#gateDecisions.add(
      1,
      filterDimensions(METRIC_NAMES.releaseGateDecisions, {
        "project.slug": dimensions.projectSlug,
        "agent.key": dimensions.agentKey,
        "release.key": dimensions.releaseKey,
        decision,
      }),
    );
  }

  recordTraceFetchFailure(projectSlug: string, agentKey: string, errorType: string): void {
    this.#traceFetchFailures.add(
      1,
      filterDimensions(METRIC_NAMES.traceFetchFailures, {
        "project.slug": projectSlug,
        "agent.key": agentKey,
        "error.type": errorType,
      }),
    );
  }

  recordArtifactSync(
    projectSlug: string,
    agentKey: string,
    artifactType: string,
    status: string,
  ): void {
    this.#artifactSync.add(
      1,
      filterDimensions(METRIC_NAMES.signozArtifactSync, {
        "project.slug": projectSlug,
        "agent.key": agentKey,
        "artifact.type": artifactType,
        status,
      }),
    );
  }
}

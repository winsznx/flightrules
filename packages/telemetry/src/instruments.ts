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

/**
 * Who a measurement is about.
 *
 * Both the identifier and the human-readable key, deliberately. Until Phase 16 the instruments
 * emitted `project.slug` and `agent.key` while `GET /api/violations/:id/metrics` grouped by
 * `flight_rules.project.id` and `flight_rules.agent.id` — names nothing ever emitted. SigNoz duly
 * returned a series labelled with those two names and **empty values**, which SL-062 recorded as a
 * SigNoz behaviour. It was not: the two halves of the product had never agreed on a name.
 *
 * Emitting both is not redundancy. The identifier is what the API and the saved views select on and
 * what a span already carries, so a metric and a span can be joined; the key is what a human reads
 * on a dashboard legend. They are one-to-one, so carrying both costs no extra series.
 * `metricDimensionAgreement` in `metrics.ts` now fails if either side drifts again.
 */
export interface AgentIdentity {
  readonly projectId: string;
  readonly agentId: string;
  readonly projectSlug: string;
  readonly agentKey: string;
}

export interface EvaluationDimensions extends AgentIdentity {
  readonly releaseId: string;
  readonly releaseKey: string;
  readonly scope: "run" | "release";
}

function identityAttributes(identity: AgentIdentity): Attributes {
  return {
    "flight_rules.project.id": identity.projectId,
    "flight_rules.agent.id": identity.agentId,
    "project.slug": identity.projectSlug,
    "agent.key": identity.agentKey,
  };
}

function evaluationAttributes(dimensions: EvaluationDimensions): Attributes {
  return {
    ...identityAttributes(dimensions),
    "flight_rules.release.id": dimensions.releaseId,
    "release.key": dimensions.releaseKey,
  };
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
    const base = { ...evaluationAttributes(dimensions), scope: dimensions.scope };
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
        ...evaluationAttributes(dimensions),
        "rule.type": ruleType,
        severity,
      }),
    );
  }

  recordUnknownRoute(dimensions: EvaluationDimensions): void {
    this.#unknownRoutes.add(
      1,
      filterDimensions(METRIC_NAMES.unknownRoutes, evaluationAttributes(dimensions)),
    );
  }

  recordDuplicateSideEffect(dimensions: EvaluationDimensions, count: number): void {
    if (count <= 0) return;
    this.#duplicateSideEffects.add(
      count,
      filterDimensions(METRIC_NAMES.duplicateSideEffects, evaluationAttributes(dimensions)),
    );
  }

  recordRouteSimilarity(dimensions: EvaluationDimensions, similarity: number): void {
    this.#routeSimilarity.record(
      similarity,
      filterDimensions(METRIC_NAMES.routeSimilarity, evaluationAttributes(dimensions)),
    );
  }

  recordGateDecision(dimensions: EvaluationDimensions, decision: string): void {
    this.#gateDecisions.add(
      1,
      filterDimensions(METRIC_NAMES.releaseGateDecisions, {
        ...evaluationAttributes(dimensions),
        decision,
      }),
    );
  }

  recordTraceFetchFailure(identity: AgentIdentity, errorType: string): void {
    this.#traceFetchFailures.add(
      1,
      filterDimensions(METRIC_NAMES.traceFetchFailures, {
        ...identityAttributes(identity),
        "error.type": errorType,
      }),
    );
  }

  recordArtifactSync(identity: AgentIdentity, artifactType: string, status: string): void {
    this.#artifactSync.add(
      1,
      filterDimensions(METRIC_NAMES.signozArtifactSync, {
        ...identityAttributes(identity),
        "artifact.type": artifactType,
        status,
      }),
    );
  }
}

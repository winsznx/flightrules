import type { Severity } from "@flightrules/domain";

/**
 * The versioned contract DSL of PRD section 10.
 *
 * These types describe a contract that has already been validated. Nothing here is optional
 * because the author omitted it — every optional field is genuinely optional in the DSL, and
 * validation fills nothing in silently. A caller holding a `TrajectoryContract` can rely on it
 * without re-checking.
 */

/** The only accepted `apiVersion`. An unknown version is rejected, never coerced. */
export const CONTRACT_API_VERSION = "flightrules.dev/v1alpha1";
export const CONTRACT_KIND = "TrajectoryContract";

/** PRD section 10.3. */
export const SELECTOR_OPERATORS = [
  "equals",
  "not_equals",
  "in",
  "not_in",
  "exists",
  "matches",
] as const;
export type SelectorOperator = (typeof SELECTOR_OPERATORS)[number];

/** Operators that carry no value at all, as opposed to a value that happens to be absent. */
export const VALUELESS_OPERATORS = ["exists"] as const;

/** Operators whose value must be a non-empty list. */
export const LIST_OPERATORS = ["in", "not_in"] as const;

export type ScalarValue = string | number | boolean;

/**
 * One attribute condition.
 *
 * PRD section 10.3's shorthand `attributes: {key: value}` means `equals`, and is expanded to this
 * form during validation so the evaluator has exactly one shape to interpret.
 */
export interface AttributeCondition {
  readonly key: string;
  readonly operator: SelectorOperator;
  /** Absent only for `exists`. */
  readonly value?: ScalarValue | readonly ScalarValue[];
}

/**
 * A span selector (PRD section 10.3).
 *
 * `name`, `service` and `operation` are matched against the **canonical** name, the service name
 * and the operation name respectively. A selector with no field at all matches every span, which
 * validation rejects for every rule where it would be meaningless.
 */
export interface Selector {
  readonly name?: string;
  readonly service?: string;
  readonly operation?: string;
  /** Regular-expression alternative to `name`, matched with the RE2-compatible engine. */
  readonly namePattern?: string;
  readonly attributes?: readonly AttributeCondition[];
}

export interface Cardinality {
  readonly min: number;
  readonly max: number;
}

export const ANCESTRY_RELATIONSHIPS = ["direct", "any_depth"] as const;
export type AncestryRelationship = (typeof ANCESTRY_RELATIONSHIPS)[number];

/** PRD section 10.4 cardinality scope. `release` scope is aggregated in Phase 11. */
export const RULE_SCOPES = ["run", "release"] as const;
export type RuleScope = (typeof RULE_SCOPES)[number];

/** PRD section 10.4 numeric budget aggregations. */
export const AGGREGATIONS = ["sum", "max", "avg", "p95", "p99"] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];

/**
 * Metrics a numeric budget may bound.
 *
 * A closed set, not a free string. A budget naming a metric FlightRules cannot compute would
 * validate and then never decide anything, which is indistinguishable from a rule that passes.
 */
export const BUDGET_METRICS = [
  "run.duration_ms",
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
] as const;
export type BudgetMetric = (typeof BUDGET_METRICS)[number];

export const RULE_TYPES = [
  "required_span",
  "required_ancestry",
  "required_edge",
  "forbidden_span",
  "forbidden_path",
  "cardinality",
  "allowed_values",
  "attribute_constraint",
  "retry_budget",
  "approved_routes",
  "numeric_budget",
] as const;
export type RuleType = (typeof RULE_TYPES)[number];

interface RuleBase {
  readonly id: string;
  readonly severity: Severity;
  /** Author's note, carried into evidence but never interpreted. */
  readonly description?: string;
}

export interface RequiredSpanRule extends RuleBase {
  readonly type: "required_span";
  readonly selector: Selector;
  readonly cardinality: Cardinality;
}

export interface RequiredAncestryRule extends RuleBase {
  readonly type: "required_ancestry";
  readonly ancestor: Selector;
  readonly descendant: Selector;
  readonly relationship: AncestryRelationship;
}

export interface RequiredEdgeRule extends RuleBase {
  readonly type: "required_edge";
  readonly from: Selector;
  readonly to: Selector;
  readonly relationship: AncestryRelationship;
}

export interface ForbiddenSpanRule extends RuleBase {
  readonly type: "forbidden_span";
  readonly selector: Selector;
}

export interface ForbiddenPathRule extends RuleBase {
  readonly type: "forbidden_path";
  readonly from: Selector;
  readonly to: Selector;
  /** The path is permitted when a span on it matches this selector. */
  readonly unless?: { readonly contains: Selector };
}

export interface CardinalityRule extends RuleBase {
  readonly type: "cardinality";
  readonly selector: Selector;
  readonly min: number;
  readonly max: number;
  readonly scope: RuleScope;
}

export interface AllowedValuesRule extends RuleBase {
  readonly type: "allowed_values";
  readonly field: string;
  readonly values: readonly ScalarValue[];
  /** Restricts the rule to a subset of spans. Absent means every span carrying the field. */
  readonly selector?: Selector;
}

export interface AttributeConstraintRule extends RuleBase {
  readonly type: "attribute_constraint";
  readonly selector: Selector;
  readonly field: string;
  readonly operator: SelectorOperator;
  readonly value?: ScalarValue | readonly ScalarValue[];
}

export interface RetryBudgetRule extends RuleBase {
  readonly type: "retry_budget";
  readonly selector: Selector;
  readonly maxPerTool: number;
  readonly maxRunTotal: number;
  /** Maximum retries permitted on a span whose side effect is `write` or `external`. */
  readonly sideEffectMax: number;
}

export interface ApprovedRoutesRule extends RuleBase {
  readonly type: "approved_routes";
  readonly fingerprints: readonly string[];
  /**
   * Similarity at or above which an unapproved route is reported as drift within a known family
   * rather than as a materially different route. Both outcomes are violations; the threshold only
   * classifies. Held as an exact rational so the comparison never depends on floating point.
   */
  readonly minSimilarity: RationalThreshold;
}

export interface NumericBudgetRule extends RuleBase {
  readonly type: "numeric_budget";
  readonly metric: BudgetMetric;
  readonly aggregation: Aggregation;
  readonly max: number;
  readonly scope: RuleScope;
}

export type ContractRule =
  | RequiredSpanRule
  | RequiredAncestryRule
  | RequiredEdgeRule
  | ForbiddenSpanRule
  | ForbiddenPathRule
  | CardinalityRule
  | AllowedValuesRule
  | AttributeConstraintRule
  | RetryBudgetRule
  | ApprovedRoutesRule
  | NumericBudgetRule;

/**
 * A decimal threshold held as an exact fraction.
 *
 * `0.92` from YAML is a binary float that cannot represent 92/100 exactly, so comparing a
 * similarity ratio against it would depend on rounding. Keeping the author's decimal digits lets
 * the evaluator compare by integer cross-multiplication instead, which is reproducible everywhere.
 */
export interface RationalThreshold {
  readonly numerator: number;
  readonly denominator: number;
  /** The author's original text, preserved for round-tripping and for evidence. */
  readonly text: string;
}

export interface ContractSelectors {
  readonly workflowName: string;
  readonly releaseAttribute: string;
  readonly environmentAttribute: string;
  /** Canonical span name that identifies the run root. */
  readonly rootSpan?: string;
}

export interface ContractMetadata {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly project: string;
  readonly agent: string;
  readonly environment: string;
  /** ISO-8601 instant with an explicit offset. Not interpreted by the evaluator. */
  readonly createdAt: string;
  readonly baselineRelease?: string;
}

/** PRD section 10.5. Every threshold is required: an absent gate threshold is a silent pass. */
export interface ContractGate {
  readonly minCompletedRuns: number;
  readonly evaluationTimeoutSeconds: number;
  readonly maxViolationPercent: RationalThreshold;
  readonly maxUnknownRoutePercent: RationalThreshold;
  readonly maxLatencyRegressionPercent: RationalThreshold;
  readonly maxTokenRegressionPercent: RationalThreshold;
  readonly zeroToleranceRuleIds: readonly string[];
}

export interface ContractSpec {
  readonly selectors: ContractSelectors;
  /** Approved route fingerprints available to every `approved_routes` rule by reference. */
  readonly approvedRoutes: readonly string[];
  readonly rules: readonly ContractRule[];
  readonly gate: ContractGate;
}

export interface TrajectoryContract {
  readonly apiVersion: typeof CONTRACT_API_VERSION;
  readonly kind: typeof CONTRACT_KIND;
  readonly metadata: ContractMetadata;
  readonly spec: ContractSpec;
}

/** Bounds the DSL exposes so a caller can validate before submitting. PRD section 18.1. */
export const CONTRACT_LIMITS = {
  maxSourceBytes: 256 * 1024,
  maxSourceLines: 8_000,
  maxNestingDepth: 32,
  maxRules: 500,
  maxIdentifierLength: 128,
  maxSelectorAttributes: 32,
  maxValueListLength: 256,
  maxFingerprints: 1_000,
  maxPatternLength: 256,
  maxStringLength: 1_024,
  /** Highest integer any numeric field may hold; keeps every comparison exact. */
  maxInteger: Number.MAX_SAFE_INTEGER,
} as const;

const RULE_TYPE_SET: ReadonlySet<string> = new Set(RULE_TYPES);
export function isRuleType(value: unknown): value is RuleType {
  return typeof value === "string" && RULE_TYPE_SET.has(value);
}

const OPERATOR_SET: ReadonlySet<string> = new Set(SELECTOR_OPERATORS);
export function isSelectorOperator(value: unknown): value is SelectorOperator {
  return typeof value === "string" && OPERATOR_SET.has(value);
}

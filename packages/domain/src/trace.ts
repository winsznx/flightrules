/**
 * Vocabulary shared by the instrumentation, the graph engine and the contract evaluator.
 *
 * These are FlightRules domain concepts, not demo details: a contract rule selects on
 * `agent.side_effect`, and the evaluator classifies a duplicate side effect by it.
 */

/** PRD section 11.2. `unknown` is explicit so an unclassified span is never silently `none`. */
export const SIDE_EFFECTS = ["none", "read", "write", "external", "unknown"] as const;
export type SideEffect = (typeof SIDE_EFFECTS)[number];

/** The attribute a contract rule selects on to pin itself to a side-effecting step. */
export const SIDE_EFFECT_ATTRIBUTE = "agent.side_effect";

/**
 * The classifications that change the world outside the agent.
 *
 * `read` does not: repeating it is wasteful, not unsafe. A duplicate side effect is only a product
 * finding for these two.
 */
export const SIDE_EFFECTING_VALUES: readonly SideEffect[] = ["write", "external"];

const SIDE_EFFECT_SET: ReadonlySet<string> = new Set(SIDE_EFFECTS);

export function isSideEffect(value: unknown): value is SideEffect {
  return typeof value === "string" && SIDE_EFFECT_SET.has(value);
}

/** Falls back to `unknown` rather than `none`, so missing classification is visible. */
export function toSideEffect(value: unknown): SideEffect {
  return isSideEffect(value) ? value : "unknown";
}

/** PRD section 11.3. `inferred_time_order` is display-only and cannot satisfy a critical rule. */
export const EDGE_TYPES = [
  "parent",
  "span_link",
  "explicit_predecessor",
  "inferred_time_order",
] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

/** Edge types that count as causal evidence for a critical ancestry or ordering rule. */
export const CAUSAL_EDGE_TYPES = ["parent", "span_link", "explicit_predecessor"] as const;
export type CausalEdgeType = (typeof CAUSAL_EDGE_TYPES)[number];

const CAUSAL_EDGE_SET: ReadonlySet<string> = new Set(CAUSAL_EDGE_TYPES);

export function isCausalEdgeType(value: EdgeType): value is CausalEdgeType {
  return CAUSAL_EDGE_SET.has(value);
}

/** Trace-quality outcomes. Only `complete` traces may contribute to a baseline. */
export const TRACE_QUALITY = ["complete", "incomplete", "inconsistent", "too_large"] as const;
export type TraceQuality = (typeof TRACE_QUALITY)[number];

/** Run and release evaluation outcomes (PRD FR-010, FR-011). */
export const EVALUATION_STATUSES = ["pass", "fail", "error", "insufficient_data"] as const;
export type EvaluationStatus = (typeof EVALUATION_STATUSES)[number];

/** Rule severities, ordered from least to most serious. */
export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity);
}

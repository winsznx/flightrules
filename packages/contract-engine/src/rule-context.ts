import type {
  ContractRule,
  RationalThreshold,
  Selector,
  TrajectoryContract,
} from "@flightrules/contract-schema";
import { type CanonicalGraph, type FeatureSet, featuresOf } from "@flightrules/trace-graph";
import type { GraphIndex } from "./graph-index.js";
import type {
  InsufficientEvidenceReason,
  MetricSample,
  RuleResult,
  SimilarityScore,
  Violation,
} from "./result.js";
import { EMPTY_EVIDENCE, type EvidenceReference } from "./result.js";
import { CompiledSelector } from "./selector.js";

/**
 * An approved route family, as far as the run evaluator needs to know about one.
 *
 * The canonical graph rather than the trace graph: identity and similarity are both properties of
 * the canonical form, and a stored family has no span IDs to offer anyway. Phase 08 supplies these
 * from mined baselines; a test supplies them directly.
 */
export interface ApprovedRoute {
  readonly fingerprint: string;
  readonly canonical: CanonicalGraph;
}

/**
 * Shared state for one run evaluation.
 *
 * Selectors are compiled once and cached by their structural key, so two rules selecting the same
 * spans share one compiled selector and one pattern. Feature sets are computed at most once per
 * approved family.
 */
export class RuleContext {
  readonly index: GraphIndex;
  readonly contract: TrajectoryContract;
  readonly routeFingerprint: string;
  readonly #zeroTolerance: ReadonlySet<string>;
  readonly #selectorCache = new Map<string, CompiledSelector>();
  readonly #approved: readonly ApprovedRoute[];
  #runFeatures: FeatureSet | undefined;
  readonly #familyFeatures = new Map<string, FeatureSet>();

  constructor(input: {
    readonly index: GraphIndex;
    readonly contract: TrajectoryContract;
    readonly routeFingerprint: string;
    readonly approvedRoutes: readonly ApprovedRoute[];
  }) {
    this.index = input.index;
    this.contract = input.contract;
    this.routeFingerprint = input.routeFingerprint;
    this.#zeroTolerance = new Set(input.contract.spec.gate.zeroToleranceRuleIds);
    this.#approved = input.approvedRoutes;
  }

  /**
   * Whether an absence can be treated as proof that something did not happen.
   *
   * Only a `complete` trace supports that conclusion. An `incomplete` one is missing spans by
   * definition, so "we did not see a fraud check" and "there was no fraud check" are different
   * statements and the evaluator must not conflate them.
   *
   * A `client_span_without_server_span` warning does **not** land here. It marks one span's subtree
   * as unobservable, and Phase 06 deliberately keeps such a trace `complete` because the route it
   * evidences is fully determined by the client span. Treating it globally would turn the canary's
   * genuinely missing fraud check into "insufficient evidence" and destroy the release gate; the
   * rules that are actually anchored on a flagged span check for it individually.
   */
  get absenceDecidable(): boolean {
    return this.index.graph.quality === "complete";
  }

  isZeroTolerance(ruleId: string): boolean {
    return this.#zeroTolerance.has(ruleId);
  }

  compile(selector: Selector): CompiledSelector {
    const key = selectorCacheKey(selector);
    const existing = this.#selectorCache.get(key);
    if (existing !== undefined) return existing;
    const compiled = new CompiledSelector(selector);
    this.#selectorCache.set(key, compiled);
    return compiled;
  }

  select(selector: Selector): readonly string[] {
    return this.compile(selector).match(this.index);
  }

  get approvedRoutes(): readonly ApprovedRoute[] {
    return this.#approved;
  }

  /**
   * Similarity of this run to the nearest of the given approved families.
   *
   * Exact integer arithmetic throughout. The weighted Jaccard ratio is kept as its own numerator and
   * denominator and compared by cross-multiplication, because the alternative — dividing into a
   * double and comparing against a threshold that is itself an inexact binary approximation of the
   * author's decimal — makes the release decision depend on rounding.
   */
  similarityTo(fingerprints: readonly string[]): {
    readonly score: SimilarityScore;
    readonly nearest: string | null;
  } {
    const allowed = new Set(fingerprints);
    let best: {
      readonly intersection: number;
      readonly union: number;
      readonly fingerprint: string;
    } | null = null;

    for (const family of this.#approved) {
      if (!allowed.has(family.fingerprint)) continue;
      const ratio = exactJaccard(this.#features(), this.#featuresOfFamily(family));
      if (
        best === null ||
        ratio.intersection * best.union > best.intersection * ratio.union ||
        (ratio.intersection * best.union === best.intersection * ratio.union &&
          family.fingerprint < best.fingerprint)
      ) {
        best = { ...ratio, fingerprint: family.fingerprint };
      }
    }

    if (best === null) return { score: ZERO_SIMILARITY, nearest: null };
    return {
      score: toSimilarityScore(best.intersection, best.union),
      nearest: best.fingerprint,
    };
  }

  #features(): FeatureSet {
    if (this.#runFeatures === undefined) {
      this.#runFeatures = featuresOf(this.index.canonical, {
        criticalNodes: criticalNodeLabels(this.contract),
      });
    }
    return this.#runFeatures;
  }

  #featuresOfFamily(family: ApprovedRoute): FeatureSet {
    const existing = this.#familyFeatures.get(family.fingerprint);
    if (existing !== undefined) return existing;
    const features = featuresOf(family.canonical, {
      criticalNodes: criticalNodeLabels(this.contract),
    });
    this.#familyFeatures.set(family.fingerprint, features);
    return features;
  }
}

export const ZERO_SIMILARITY: SimilarityScore = {
  numerator: 0,
  denominator: 1,
  decimal: "0.000000",
};

export const EXACT_SIMILARITY: SimilarityScore = {
  numerator: 1,
  denominator: 1,
  decimal: "1.000000",
};

/**
 * Weighted Jaccard as an exact fraction.
 *
 * `weightedJaccard` in `@flightrules/trace-graph` returns the same value as a double, which is
 * correct for display and for ranking. A contract threshold comparison needs the integers.
 */
export function exactJaccard(
  left: FeatureSet,
  right: FeatureSet,
): { readonly intersection: number; readonly union: number } {
  if (left.byKey.size === 0 && right.byKey.size === 0) return { intersection: 1, union: 1 };

  let intersection = 0;
  for (const [key, feature] of left.byKey) {
    if (right.byKey.has(key)) intersection += feature.weight;
  }
  const union = left.totalWeight + right.totalWeight - intersection;
  return union === 0 ? { intersection: 1, union: 1 } : { intersection, union };
}

const SIMILARITY_SCALE = 1_000_000;

/** Six decimal places by integer division, so the rendering is identical on every platform. */
export function toSimilarityScore(numerator: number, denominator: number): SimilarityScore {
  if (denominator === 0) return ZERO_SIMILARITY;
  const scaled = Math.floor((numerator * SIMILARITY_SCALE) / denominator);
  const whole = Math.floor(scaled / SIMILARITY_SCALE);
  const fraction = scaled - whole * SIMILARITY_SCALE;
  return {
    numerator,
    denominator,
    decimal: `${whole}.${String(fraction).padStart(6, "0")}`,
  };
}

/** `numerator / denominator >= threshold`, decided without division. */
export function atLeastThreshold(
  numerator: number,
  denominator: number,
  threshold: RationalThreshold,
): boolean {
  return numerator * threshold.denominator >= threshold.numerator * denominator;
}

/** Canonical labels the contract treats as critical, for the similarity weighting of PRD 11.9. */
export function criticalNodeLabels(contract: TrajectoryContract): readonly string[] {
  const labels = new Set<string>();
  for (const rule of contract.spec.rules) {
    if (rule.severity !== "critical") continue;
    for (const selector of selectorsOf(rule)) {
      if (selector.name !== undefined) labels.add(selector.name);
    }
  }
  return [...labels].sort();
}

/** Every selector a rule carries, so shared logic does not need a switch per rule type. */
export function selectorsOf(rule: ContractRule): readonly Selector[] {
  switch (rule.type) {
    case "required_span":
    case "forbidden_span":
    case "cardinality":
    case "attribute_constraint":
    case "retry_budget":
      return [rule.selector];
    case "required_ancestry":
      return [rule.ancestor, rule.descendant];
    case "required_edge":
      return [rule.from, rule.to];
    case "forbidden_path":
      return rule.unless === undefined
        ? [rule.from, rule.to]
        : [rule.from, rule.to, rule.unless.contains];
    case "allowed_values":
      return rule.selector === undefined ? [] : [rule.selector];
    case "approved_routes":
    case "numeric_budget":
      return [];
  }
}

function selectorCacheKey(selector: Selector): string {
  return JSON.stringify([
    selector.name ?? null,
    selector.namePattern ?? null,
    selector.service ?? null,
    selector.operation ?? null,
    (selector.attributes ?? []).map((condition) => [
      condition.key,
      condition.operator,
      condition.value ?? null,
    ]),
  ]);
}

/* -------------------------------------------------------------------------- */
/* Result constructors                                                        */
/* -------------------------------------------------------------------------- */

export function passed(
  rule: ContractRule,
  summary: string,
  evidence: EvidenceReference = EMPTY_EVIDENCE,
  samples: readonly MetricSample[] = [],
): RuleResult {
  return {
    ruleId: rule.id,
    ruleType: rule.type,
    severity: rule.severity,
    outcome: "pass",
    insufficientReason: null,
    summary,
    evidence,
    violations: [],
    samples,
  };
}

export function insufficient(
  rule: ContractRule,
  reason: InsufficientEvidenceReason,
  summary: string,
  evidence: EvidenceReference = EMPTY_EVIDENCE,
  samples: readonly MetricSample[] = [],
): RuleResult {
  return {
    ruleId: rule.id,
    ruleType: rule.type,
    severity: rule.severity,
    outcome: "insufficient_evidence",
    insufficientReason: reason,
    summary,
    evidence,
    violations: [],
    samples,
  };
}

export function deferred(
  rule: ContractRule,
  summary: string,
  samples: readonly MetricSample[] = [],
): RuleResult {
  return {
    ruleId: rule.id,
    ruleType: rule.type,
    severity: rule.severity,
    outcome: "deferred",
    insufficientReason: null,
    summary,
    evidence: EMPTY_EVIDENCE,
    violations: [],
    samples,
  };
}

/**
 * A violating result.
 *
 * Violations are sorted by code then identifier, so the list is identical for the same graph and
 * contract regardless of the order the evaluator happened to discover them in.
 */
export function violated(
  rule: ContractRule,
  summary: string,
  violations: readonly Violation[],
  evidence: EvidenceReference,
  samples: readonly MetricSample[] = [],
): RuleResult {
  return {
    ruleId: rule.id,
    ruleType: rule.type,
    severity: rule.severity,
    outcome: "violation",
    insufficientReason: null,
    summary,
    evidence,
    violations: [...violations].sort((a, b) =>
      a.code !== b.code ? (a.code < b.code ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    ),
    samples,
  };
}

/**
 * Combines per-span outcomes into one rule result.
 *
 * A proven violation outranks an undecidable case. Within one rule, "two of these spans breached the
 * contract and a third could not be checked" is a violation — softening it to insufficient evidence
 * because of the third would let one gap in a trace suppress a real finding.
 */
export function combine(
  rule: ContractRule,
  outcome: {
    readonly violations: readonly Violation[];
    readonly undecidable: readonly string[];
    readonly undecidableReason: InsufficientEvidenceReason;
    readonly evidence: EvidenceReference;
    readonly violationSummary: string;
    readonly undecidableSummary: string;
    readonly passSummary: string;
  },
): RuleResult {
  if (outcome.violations.length > 0) {
    return violated(rule, outcome.violationSummary, outcome.violations, outcome.evidence);
  }
  if (outcome.undecidable.length > 0) {
    return insufficient(
      rule,
      outcome.undecidableReason,
      outcome.undecidableSummary,
      outcome.evidence,
    );
  }
  return passed(rule, outcome.passSummary, outcome.evidence);
}

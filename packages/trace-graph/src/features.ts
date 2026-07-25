import { type CanonicalGraph, canonicaliseGraph } from "./canonical.js";
import type { TraceGraph } from "./model.js";

/**
 * Weighted feature sets and similarity (PRD section 11.9).
 *
 * The score exists for display and for choosing the nearest approved family when a route is
 * unknown. It never decides pass or fail: the release decision comes from exact fingerprint
 * comparison and the contract rules, because a threshold on a similarity score is precisely the
 * kind of fuzzy judgement the determinism boundary excludes.
 */

/** PRD section 11.9's recommended weights, as data so the formula is inspectable and testable. */
export const FEATURE_WEIGHTS = {
  criticalNode: 5,
  criticalEdge: 5,
  sideEffectNode: 5,
  toolNode: 3,
  serviceNode: 2,
  ordinaryNode: 1,
} as const;

export type FeatureKind = keyof typeof FEATURE_WEIGHTS;

export interface Feature {
  readonly kind: FeatureKind;
  readonly key: string;
  readonly weight: number;
}

export interface FeatureSet {
  /** Keyed by `kind:key`, so two features of different kinds never collide. */
  readonly byKey: ReadonlyMap<string, Feature>;
  readonly totalWeight: number;
}

export interface FeatureOptions {
  /** Canonical node labels a contract treats as critical, e.g. the policy and fraud checks. */
  readonly criticalNodes?: readonly string[];
}

function featureKey(kind: FeatureKind, key: string): string {
  return `${kind}:${key}`;
}

/**
 * Derives the feature set from a canonical graph.
 *
 * Features are built from canonical paths and labels rather than span IDs, so the same behaviour
 * in two different runs produces the same features. A node contributes exactly one node-kind
 * feature — the most significant one that applies — so a critical write is not counted three
 * times over.
 */
export function featuresOf(canonical: CanonicalGraph, options: FeatureOptions = {}): FeatureSet {
  const critical = new Set(options.criticalNodes ?? []);
  const byKey = new Map<string, Feature>();

  const add = (kind: FeatureKind, key: string): void => {
    const composite = featureKey(kind, key);
    if (byKey.has(composite)) return;
    byKey.set(composite, { kind, key, weight: FEATURE_WEIGHTS[kind] });
  };

  for (const node of canonical.nodes) {
    if (critical.has(node.label)) add("criticalNode", node.label);
    else if (node.sideEffect === "write" || node.sideEffect === "external") {
      add("sideEffectNode", `${node.label}|${node.sideEffect}`);
    } else if (node.tool !== null) add("toolNode", node.tool);
    else add("ordinaryNode", node.label);

    // Service membership is a separate fact from the node itself: a route that moved a step to a
    // different service is a real behavioural change even when the step's label is unchanged.
    add("serviceNode", node.service);
  }

  const labelByOrder = new Map(canonical.nodes.map((node) => [node.order, node.label]));
  for (const edge of canonical.edges) {
    const from = labelByOrder.get(edge.from);
    const to = labelByOrder.get(edge.to);
    if (from === undefined || to === undefined) continue;
    const kind: FeatureKind =
      critical.has(from) || critical.has(to) ? "criticalEdge" : "ordinaryNode";
    add(kind, `${from}->${to}`);
  }

  let totalWeight = 0;
  for (const feature of byKey.values()) totalWeight += feature.weight;

  return { byKey, totalWeight };
}

export function featuresOfGraph(graph: TraceGraph, options: FeatureOptions = {}): FeatureSet {
  return featuresOf(canonicaliseGraph(graph), options);
}

/**
 * Weighted Jaccard similarity: the weight of the shared features over the weight of their union.
 *
 * Two empty sets score 1: they are identical, and returning 0 would report two empty graphs as
 * maximally different. The result is exact rational arithmetic over integer weights, so it is
 * reproducible across platforms rather than depending on floating-point accumulation order — the
 * intersection and union are summed as integers and divided once.
 */
export function weightedJaccard(left: FeatureSet, right: FeatureSet): number {
  if (left.byKey.size === 0 && right.byKey.size === 0) return 1;

  let intersection = 0;
  for (const [key, feature] of left.byKey) {
    if (right.byKey.has(key)) intersection += feature.weight;
  }

  const union = left.totalWeight + right.totalWeight - intersection;
  return union === 0 ? 1 : intersection / union;
}

export function similarity(
  left: TraceGraph,
  right: TraceGraph,
  options: FeatureOptions = {},
): number {
  return weightedJaccard(featuresOfGraph(left, options), featuresOfGraph(right, options));
}

import { type CanonicalGraph, type CanonicalNode, canonicaliseGraph } from "./canonical.js";
import type { TraceGraph } from "./model.js";

/**
 * Typed graph diff (PRD section 11.10).
 *
 * This is the data behind the product's hero surface, so the output is a list of named,
 * structured changes rather than a textual delta. "Two services disappeared and a write happened
 * twice" has to survive as a machine-readable fact all the way to the Release Diff screen and the
 * Violation Inspector.
 */

export const GRAPH_CHANGE_KINDS = [
  "node_added",
  "node_removed",
  "edge_added",
  "edge_removed",
  "cardinality_changed",
  "tool_added",
  "service_added",
  "data_domain_added",
  "side_effect_duplicated",
  "retry_increased",
  "attribute_changed",
  "route_unknown",
] as const;

export type GraphChangeKind = (typeof GRAPH_CHANGE_KINDS)[number];

export interface GraphChange {
  readonly kind: GraphChangeKind;
  /** Canonical label the change concerns, so the UI can name it without a span ID. */
  readonly subject: string;
  readonly detail: string;
  readonly baselineCount?: number;
  readonly candidateCount?: number;
  /** Observed span IDs in the candidate trace, for evidence linking (FR-017). */
  readonly candidateSpanIds: readonly string[];
}

export interface GraphDiff {
  readonly baselineFingerprint: string;
  readonly candidateFingerprint: string;
  readonly identical: boolean;
  readonly changes: readonly GraphChange[];
}

function countBy<T>(items: readonly T[], key: (item: T) => string): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

function setOf(values: Iterable<string | null>): ReadonlySet<string> {
  const result = new Set<string>();
  for (const value of values) {
    if (value !== null && value.length > 0) result.add(value);
  }
  return result;
}

/** Span IDs in the candidate graph whose canonical label matches, sorted for determinism. */
function spanIdsFor(graph: TraceGraph, label: string): readonly string[] {
  return graph.nodes
    .filter((node) => node.canonicalName === label)
    .map((node) => node.spanId)
    .sort();
}

/** Order-to-label index. Built once per graph; a linear scan per edge would be quadratic. */
function labelIndex(canonical: CanonicalGraph): ReadonlyMap<number, string> {
  return new Map(canonical.nodes.map((node) => [node.order, node.label]));
}

/**
 * Compares two graphs.
 *
 * Node comparison is by canonical label *count*, not by path. A step that moved position in the
 * tree is an edge change, and reporting it also as a node addition and removal would
 * double-count one behavioural difference into three findings.
 */
export function diffGraphs(
  baseline: TraceGraph,
  candidate: TraceGraph,
  fingerprints: { readonly baseline: string; readonly candidate: string },
): GraphDiff {
  const baselineCanonical = canonicaliseGraph(baseline);
  const candidateCanonical = canonicaliseGraph(candidate);
  const changes: GraphChange[] = [];

  const baselineNodes = countBy(baselineCanonical.nodes, (node) => node.label);
  const candidateNodes = countBy(candidateCanonical.nodes, (node) => node.label);

  for (const label of new Set([...baselineNodes.keys(), ...candidateNodes.keys()])) {
    const before = baselineNodes.get(label) ?? 0;
    const after = candidateNodes.get(label) ?? 0;
    if (before === after) continue;

    const spanIds = spanIdsFor(candidate, label);
    if (before === 0) {
      changes.push({
        kind: "node_added",
        subject: label,
        detail: `${label} appears in the candidate but not in the baseline.`,
        baselineCount: 0,
        candidateCount: after,
        candidateSpanIds: spanIds,
      });
    } else if (after === 0) {
      changes.push({
        kind: "node_removed",
        subject: label,
        detail: `${label} is present in the baseline but absent from the candidate.`,
        baselineCount: before,
        candidateCount: 0,
        candidateSpanIds: [],
      });
    } else {
      changes.push({
        kind: "cardinality_changed",
        subject: label,
        detail: `${label} occurs ${after} times in the candidate against ${before} in the baseline.`,
        baselineCount: before,
        candidateCount: after,
        candidateSpanIds: spanIds,
      });
    }
  }

  changes.push(...diffEdges(baselineCanonical, candidateCanonical, candidate));
  changes.push(...diffClassifications(baselineCanonical, candidateCanonical, candidate));
  changes.push(...diffSideEffects(baselineCanonical, candidateCanonical, candidate));
  changes.push(...diffRetries(baselineCanonical, candidateCanonical, candidate));
  changes.push(...diffAttributes(baselineCanonical, candidateCanonical, candidate));

  // Sorted by kind then subject so the same pair of graphs always yields the same list. The UI
  // orders by severity separately; determinism here is what makes the diff testable.
  changes.sort((a, b) =>
    a.kind !== b.kind ? (a.kind < b.kind ? -1 : 1) : a.subject < b.subject ? -1 : 1,
  );

  return {
    baselineFingerprint: fingerprints.baseline,
    candidateFingerprint: fingerprints.candidate,
    identical: fingerprints.baseline === fingerprints.candidate,
    changes,
  };
}

function diffEdges(
  baseline: CanonicalGraph,
  candidate: CanonicalGraph,
  candidateGraph: TraceGraph,
): readonly GraphChange[] {
  const labelEdges = (canonical: CanonicalGraph): ReadonlySet<string> => {
    const labels = labelIndex(canonical);
    return new Set(
      canonical.edges.map(
        (edge) =>
          `${labels.get(edge.from) ?? edge.from}->${labels.get(edge.to) ?? edge.to}|${edge.type}`,
      ),
    );
  };

  const before = labelEdges(baseline);
  const after = labelEdges(candidate);
  const changes: GraphChange[] = [];

  for (const edge of after) {
    if (before.has(edge)) continue;
    changes.push({
      kind: "edge_added",
      subject: edge,
      detail: `The candidate contains the relationship ${edge}, which the baseline does not.`,
      candidateSpanIds: spanIdsFor(candidateGraph, edge.split("->")[1]?.split("|")[0] ?? ""),
    });
  }
  for (const edge of before) {
    if (after.has(edge)) continue;
    changes.push({
      kind: "edge_removed",
      subject: edge,
      detail: `The baseline relationship ${edge} is absent from the candidate.`,
      candidateSpanIds: [],
    });
  }
  return changes;
}

/** Tools, services and data domains present in the candidate but never in the baseline. */
function diffClassifications(
  baseline: CanonicalGraph,
  candidate: CanonicalGraph,
  candidateGraph: TraceGraph,
): readonly GraphChange[] {
  const changes: GraphChange[] = [];

  const dimensions = [
    {
      kind: "tool_added" as const,
      before: setOf(baseline.nodes.map((node) => node.tool)),
      after: setOf(candidate.nodes.map((node) => node.tool)),
      noun: "tool",
      labelFor: (value: string) =>
        candidate.nodes.find((node) => node.tool === value)?.label ?? value,
    },
    {
      kind: "service_added" as const,
      before: setOf(baseline.nodes.map((node) => node.service)),
      after: setOf(candidate.nodes.map((node) => node.service)),
      noun: "service",
      labelFor: (value: string) =>
        candidate.nodes.find((node) => node.service === value)?.label ?? value,
    },
    {
      kind: "data_domain_added" as const,
      before: setOf(baseline.nodes.map((node) => node.dataDomain)),
      after: setOf(candidate.nodes.map((node) => node.dataDomain)),
      noun: "data domain",
      labelFor: (value: string) =>
        candidate.nodes.find((node) => node.dataDomain === value)?.label ?? value,
    },
  ];

  for (const dimension of dimensions) {
    for (const value of dimension.after) {
      if (dimension.before.has(value)) continue;
      changes.push({
        kind: dimension.kind,
        subject: value,
        detail: `The candidate uses the ${dimension.noun} ${value}, which the baseline never does.`,
        candidateSpanIds: spanIdsFor(candidateGraph, dimension.labelFor(value)),
      });
    }
  }

  return changes;
}

/**
 * A side effect performed more times than the baseline performed it.
 *
 * This is the change that catches the duplicate refund. It counts `(label, sideEffect)` pairs for
 * writing and external calls only: repeating a read is not a safety problem, and reporting it
 * alongside a duplicated payment would bury the finding that matters.
 */
function diffSideEffects(
  baseline: CanonicalGraph,
  candidate: CanonicalGraph,
  candidateGraph: TraceGraph,
): readonly GraphChange[] {
  const mutating = (node: CanonicalNode): boolean =>
    node.sideEffect === "write" || node.sideEffect === "external";

  const before = countBy(
    baseline.nodes.filter(mutating),
    (node) => `${node.label}|${node.sideEffect}`,
  );
  const after = countBy(
    candidate.nodes.filter(mutating),
    (node) => `${node.label}|${node.sideEffect}`,
  );

  const changes: GraphChange[] = [];
  for (const [key, candidateCount] of after) {
    const baselineCount = before.get(key) ?? 0;
    if (candidateCount <= baselineCount) continue;
    const label = key.split("|")[0] ?? key;
    changes.push({
      kind: "side_effect_duplicated",
      subject: key,
      detail:
        `${label} performed a ${key.split("|")[1]} side effect ${candidateCount} times in the ` +
        `candidate against ${baselineCount} in the baseline.`,
      baselineCount,
      candidateCount,
      candidateSpanIds: spanIdsFor(candidateGraph, label),
    });
  }
  return changes;
}

function diffRetries(
  baseline: CanonicalGraph,
  candidate: CanonicalGraph,
  candidateGraph: TraceGraph,
): readonly GraphChange[] {
  const maxRetry = (canonical: CanonicalGraph): ReadonlyMap<string, number> => {
    const result = new Map<string, number>();
    for (const node of canonical.nodes) {
      if (node.retryNumber === null) continue;
      result.set(node.label, Math.max(result.get(node.label) ?? 0, node.retryNumber));
    }
    return result;
  };

  const before = maxRetry(baseline);
  const after = maxRetry(candidate);
  const changes: GraphChange[] = [];

  for (const [label, candidateMax] of after) {
    const baselineMax = before.get(label) ?? 0;
    if (candidateMax <= baselineMax) continue;
    changes.push({
      kind: "retry_increased",
      subject: label,
      detail: `${label} retried up to attempt ${candidateMax} against ${baselineMax} in the baseline.`,
      baselineCount: baselineMax,
      candidateCount: candidateMax,
      candidateSpanIds: spanIdsFor(candidateGraph, label),
    });
  }
  return changes;
}

function diffAttributes(
  baseline: CanonicalGraph,
  candidate: CanonicalGraph,
  candidateGraph: TraceGraph,
): readonly GraphChange[] {
  const attributesByLabel = (
    canonical: CanonicalGraph,
  ): ReadonlyMap<string, ReadonlySet<string>> => {
    const result = new Map<string, Set<string>>();
    for (const node of canonical.nodes) {
      const existing = result.get(node.label) ?? new Set<string>();
      for (const [key, value] of Object.entries(node.attributes)) {
        existing.add(`${key}=${JSON.stringify(value)}`);
      }
      result.set(node.label, existing);
    }
    return result;
  };

  const before = attributesByLabel(baseline);
  const after = attributesByLabel(candidate);
  const changes: GraphChange[] = [];

  for (const [label, candidateFacts] of after) {
    const baselineFacts = before.get(label);
    // A label absent from the baseline is already reported as node_added.
    if (baselineFacts === undefined) continue;
    const added = [...candidateFacts].filter((fact) => !baselineFacts.has(fact)).sort();
    if (added.length === 0) continue;
    changes.push({
      kind: "attribute_changed",
      subject: label,
      detail: `${label} carries attribute values the baseline never showed: ${added.join(", ")}.`,
      candidateSpanIds: spanIdsFor(candidateGraph, label),
    });
  }
  return changes;
}

/**
 * Reports a candidate whose fingerprint matches no approved family.
 *
 * Separate from `diffGraphs` because it is a statement about the baseline set as a whole rather
 * than about one pair of graphs, and because an unknown route is a finding in its own right even
 * when the nearest family is very similar.
 */
export function unknownRouteChange(
  candidateFingerprint: string,
  approvedFingerprints: readonly string[],
): GraphChange | undefined {
  if (approvedFingerprints.includes(candidateFingerprint)) return undefined;
  return {
    kind: "route_unknown",
    subject: candidateFingerprint,
    detail:
      `The candidate route fingerprint matches none of the ${approvedFingerprints.length} ` +
      "approved baseline families.",
    candidateSpanIds: [],
  };
}

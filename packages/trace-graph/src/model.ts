import type { EdgeType, SideEffect, TraceQuality } from "@flightrules/domain";
import type { SafeAttributeValue } from "@flightrules/normaliser";

/** PRD section 11.2. Every field there is represented; `attributes` is split by identity role. */
export interface TraceNode {
  readonly spanId: string;
  readonly traceId: string;
  readonly parentSpanId: string | null;
  readonly name: string;
  readonly canonicalName: string;
  readonly serviceName: string;
  readonly operationName: string | null;
  readonly spanKind: string | null;
  readonly statusCode: string | null;
  /**
   * Reconstructed from the ISO-8601 `timestamp` column, which SigNoz returns at millisecond
   * precision. Excluded from the fingerprint (PRD section 11.7), so the lost precision cannot
   * affect route identity — but it does mean two spans starting inside the same millisecond
   * cannot be ordered from this evidence, which is why timestamp order is never causal truth.
   */
  readonly startTimeUnixNano: bigint;
  readonly endTimeUnixNano: bigint;
  readonly durationNano: bigint;
  /** Attributes that contribute to route identity. */
  readonly attributes: Readonly<Record<string, SafeAttributeValue>>;
  /** Attributes retained as evidence only. */
  readonly evidence: Readonly<Record<string, SafeAttributeValue>>;
  readonly toolName: string | null;
  readonly toolType: string | null;
  readonly sideEffect: SideEffect;
  readonly dataDomain: string | null;
  readonly retryNumber: number | null;
  readonly releaseId: string | null;
  readonly environment: string | null;
  /** True for the synthetic root created when a trace has several parentless spans. */
  readonly synthetic: boolean;
}

export interface TraceEdge {
  readonly from: string;
  readonly to: string;
  readonly type: EdgeType;
}

/** PRD section 11.4 and the Phase 04 handover: conditions a caller must be able to see. */
export const TRACE_QUALITY_WARNINGS = [
  "multiple_roots",
  "synthetic_root",
  "orphan_span",
  "cycle_detected",
  "duplicate_spans_merged",
  "conflicting_duplicate_spans",
  "client_span_without_server_span",
  "missing_root_selector_match",
  "span_limit_exceeded",
] as const;

export type TraceQualityWarningKind = (typeof TRACE_QUALITY_WARNINGS)[number];

export interface TraceQualityWarning {
  readonly kind: TraceQualityWarningKind;
  readonly message: string;
  /** Span IDs the warning concerns, sorted, so the warning list is itself deterministic. */
  readonly spanIds: readonly string[];
}

export interface TraceGraph {
  readonly traceId: string;
  readonly rootSpanId: string;
  /** Sorted by span ID. Structural ordering is applied during canonicalisation, not here. */
  readonly nodes: readonly TraceNode[];
  readonly edges: readonly TraceEdge[];
  readonly quality: TraceQuality;
  readonly warnings: readonly TraceQualityWarning[];
  readonly normaliserVersion: string;
  readonly normaliserConfigHash: string;
  /** Rows the builder could not use, counted rather than silently dropped. */
  readonly rejectedRowCount: number;
}

export function nodeById(graph: TraceGraph): ReadonlyMap<string, TraceNode> {
  return new Map(graph.nodes.map((node) => [node.spanId, node]));
}

export function childrenOf(graph: TraceGraph): ReadonlyMap<string, readonly string[]> {
  const children = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.type !== "parent") continue;
    const existing = children.get(edge.from);
    if (existing === undefined) children.set(edge.from, [edge.to]);
    else existing.push(edge.to);
  }
  for (const list of children.values()) list.sort();
  return children;
}

/** Only a `complete` trace may contribute to a baseline (PRD section 16.6, FR-007). */
export function isBaselineEligible(graph: TraceGraph): boolean {
  return graph.quality === "complete";
}

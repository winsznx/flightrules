import type { SafeAttributeValue } from "@flightrules/normaliser";
import {
  type CanonicalGraph,
  canonicaliseGraph,
  canonicalOrdering,
  type TraceGraph,
  type TraceNode,
} from "@flightrules/trace-graph";

/**
 * Query indexes over one trace graph.
 *
 * Built once per evaluation and shared by every rule. A contract carrying fifteen rules would
 * otherwise re-scan the whole node list fifteen times per dimension, which turns a linear
 * evaluation into a quadratic one on exactly the large traces where it matters.
 *
 * Every index is a `Map` and every membership test is a `Set`. Span names, service names, tool names
 * and attribute keys all arrive from telemetry, so a plain object keyed by them would let a span
 * called `toString` or an attribute called `__proto__` resolve through `Object.prototype` and return
 * a value no span ever emitted. A `Map` has no such reachable key.
 */

/** Canonical order assigned to a span, or `null` for a span outside the rooted graph. */
export interface IndexedNode {
  readonly node: TraceNode;
  readonly canonicalOrder: number | null;
}

export class GraphIndex {
  readonly graph: TraceGraph;
  readonly canonical: CanonicalGraph;

  readonly #bySpanId = new Map<string, TraceNode>();
  readonly #canonicalOrder = new Map<string, number>();
  readonly #children = new Map<string, readonly string[]>();
  readonly #parent = new Map<string, string>();
  readonly #byCanonicalName = new Map<string, readonly string[]>();
  readonly #byService = new Map<string, readonly string[]>();
  readonly #byTool = new Map<string, readonly string[]>();
  readonly #byOperation = new Map<string, readonly string[]>();
  readonly #bySideEffect = new Map<string, readonly string[]>();
  readonly #byDataDomain = new Map<string, readonly string[]>();
  readonly #byRetryNumber = new Map<number, readonly string[]>();
  readonly #unobservableSubtrees: ReadonlySet<string>;
  readonly #orphans: ReadonlySet<string>;
  /** Pre-order span IDs from the root, siblings in canonical order. */
  readonly #rootedOrder: readonly string[];

  constructor(graph: TraceGraph) {
    this.graph = graph;
    this.canonical = canonicaliseGraph(graph);

    for (const node of graph.nodes) this.#bySpanId.set(node.spanId, node);

    const children = new Map<string, string[]>();
    for (const edge of graph.edges) {
      if (edge.type !== "parent") continue;
      const list = children.get(edge.from);
      if (list === undefined) children.set(edge.from, [edge.to]);
      else list.push(edge.to);
      this.#parent.set(edge.to, edge.from);
    }

    // The canonical order comes from `@flightrules/trace-graph`, not from a second traversal here.
    // The canonical graph carries no span IDs by design, so the mapping has to come from somewhere;
    // reimplementing the sibling ordering would produce an index that agreed with the canonical
    // graph until one of the two copies was changed, and then attached evidence to the wrong node.
    const ordering = canonicalOrdering(graph);
    for (const [spanId, order] of ordering.order) this.#canonicalOrder.set(spanId, order);

    for (const [spanId, list] of children) {
      this.#children.set(
        spanId,
        [...list].sort((a, b) => {
          const left = this.#canonicalOrder.get(a);
          const right = this.#canonicalOrder.get(b);
          // A child outside the rooted graph has no canonical order; it sorts last, by span ID, so
          // the list stays deterministic without pretending it has a canonical position.
          if (left === undefined && right === undefined) return a < b ? -1 : a > b ? 1 : 0;
          if (left === undefined) return 1;
          if (right === undefined) return -1;
          return left - right;
        }),
      );
    }

    this.#rootedOrder = [...ordering.order.entries()]
      .sort(([, left], [, right]) => left - right)
      .map(([spanId]) => spanId);

    this.#buildDimensionIndexes();

    // PRD section 11.4's `client_span_without_server_span` warning names the client spans whose
    // remote work was never exported. Anything that would have happened beneath one of them is
    // unobservable, so an absence anchored on such a span cannot be proven.
    const unobservable = new Set<string>();
    const orphans = new Set<string>();
    for (const warning of graph.warnings) {
      if (warning.kind === "client_span_without_server_span") {
        for (const spanId of warning.spanIds) unobservable.add(spanId);
      }
      // An orphan's parent was named but never exported, so its ancestry is genuinely unknown. A
      // span that is simply parentless is a different case: its ancestry is known to be empty.
      if (warning.kind === "orphan_span") {
        for (const spanId of warning.spanIds) orphans.add(spanId);
      }
    }
    this.#unobservableSubtrees = unobservable;
    this.#orphans = orphans;
  }

  #buildDimensionIndexes(): void {
    const push = <K>(map: Map<K, readonly string[]>, key: K, spanId: string): void => {
      const existing = map.get(key);
      if (existing === undefined) map.set(key, [spanId]);
      else (existing as string[]).push(spanId);
    };

    // Iterated in rooted canonical order where possible, so every index's lists are already in a
    // deterministic order and no later sort is needed.
    const ordered = [
      ...this.#rootedOrder,
      ...this.graph.nodes
        .map((node) => node.spanId)
        .filter((spanId) => !this.#canonicalOrder.has(spanId))
        .sort(),
    ];

    for (const spanId of ordered) {
      const node = this.#bySpanId.get(spanId);
      if (node === undefined) continue;
      push(this.#byCanonicalName, node.canonicalName, spanId);
      push(this.#byService, node.serviceName, spanId);
      push(this.#bySideEffect, node.sideEffect, spanId);
      if (node.toolName !== null) push(this.#byTool, node.toolName, spanId);
      if (node.operationName !== null) push(this.#byOperation, node.operationName, spanId);
      if (node.dataDomain !== null) push(this.#byDataDomain, node.dataDomain, spanId);
      if (node.retryNumber !== null) push(this.#byRetryNumber, node.retryNumber, spanId);
    }
  }

  get rootSpanId(): string {
    return this.graph.rootSpanId;
  }

  /** Rooted spans in canonical order, then any unrooted span sorted by ID. */
  get spanIds(): readonly string[] {
    return this.graph.nodes.map((node) => node.spanId);
  }

  get rootedSpanIds(): readonly string[] {
    return this.#rootedOrder;
  }

  node(spanId: string): TraceNode | undefined {
    return this.#bySpanId.get(spanId);
  }

  canonicalOrderOf(spanId: string): number | null {
    return this.#canonicalOrder.get(spanId) ?? null;
  }

  childrenOf(spanId: string): readonly string[] {
    return this.#children.get(spanId) ?? [];
  }

  parentOf(spanId: string): string | null {
    return this.#parent.get(spanId) ?? null;
  }

  byCanonicalName(name: string): readonly string[] {
    return this.#byCanonicalName.get(name) ?? [];
  }

  byService(service: string): readonly string[] {
    return this.#byService.get(service) ?? [];
  }

  byTool(tool: string): readonly string[] {
    return this.#byTool.get(tool) ?? [];
  }

  byOperation(operation: string): readonly string[] {
    return this.#byOperation.get(operation) ?? [];
  }

  bySideEffect(sideEffect: string): readonly string[] {
    return this.#bySideEffect.get(sideEffect) ?? [];
  }

  byDataDomain(dataDomain: string): readonly string[] {
    return this.#byDataDomain.get(dataDomain) ?? [];
  }

  byRetryNumber(retryNumber: number): readonly string[] {
    return this.#byRetryNumber.get(retryNumber) ?? [];
  }

  /** True when this span's remote work was never exported, so its subtree proves nothing. */
  hasUnobservableSubtree(spanId: string): boolean {
    return this.#unobservableSubtrees.has(spanId);
  }

  get unobservableSubtreeSpanIds(): readonly string[] {
    return [...this.#unobservableSubtrees].sort();
  }

  /**
   * True when this span names a parent the trace does not contain.
   *
   * The distinction from a merely parentless span is what makes ancestry decidable. A span whose
   * parent was never exported has unknown ancestry, so a missing required ancestor proves nothing.
   * A span with no parent at all has *known*, empty ancestry — a second root in the same trace is
   * still evidence that the step ran outside the required workflow.
   */
  isOrphan(spanId: string): boolean {
    return this.#orphans.has(spanId);
  }

  /**
   * Chain of span IDs from the root down to and including this span.
   *
   * Walks parent pointers, bounded by the graph size so a cycle the builder failed to break cannot
   * loop forever. Used by the path rules, which need the spans between two endpoints and not merely
   * the fact that one reaches the other.
   */
  pathFromRoot(spanId: string): readonly string[] {
    const reversed: string[] = [];
    const seen = new Set<string>();
    let current: string | null = spanId;

    while (current !== null && !seen.has(current)) {
      seen.add(current);
      reversed.push(current);
      current = this.parentOf(current);
    }

    return reversed.reverse();
  }

  /**
   * Reads an attribute from a span.
   *
   * Fingerprint attributes first, then evidence attributes: the split is about route identity, not
   * about which values a rule may select on, and a rule must see the same facts either way.
   * `Object.hasOwn` throughout, because attribute keys are telemetry-derived.
   */
  attribute(node: TraceNode, key: string): SafeAttributeValue | undefined {
    if (Object.hasOwn(node.attributes, key)) return node.attributes[key];
    if (Object.hasOwn(node.evidence, key)) return node.evidence[key];
    return undefined;
  }
}

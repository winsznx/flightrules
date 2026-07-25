import { createHash } from "node:crypto";
import type { SafeAttributeValue } from "@flightrules/normaliser";
import { childrenOf, nodeById, type TraceGraph, type TraceNode } from "./model.js";

/**
 * Canonical serialisation and fingerprinting (PRD sections 11.7 and FR-006).
 *
 * The fingerprint answers one question: is this the same behavioural route? So it includes what a
 * contract rule can select on — structure, service, tool, side effect, the allowlisted attributes
 * — and excludes everything that varies between two runs of identical behaviour: trace and span
 * IDs, timestamps, durations, and every value the normaliser recognised as volatile.
 */

/**
 * A node's position in the tree, expressed without reference to any identifier.
 *
 * Sibling order is decided by the siblings' own canonical content, not by their span IDs or start
 * times, so two runs that executed the same steps produce the same paths even when the spans were
 * created in a different order or arrived from SigNoz shuffled.
 */
export interface CanonicalNode {
  /**
   * Position in a deterministic pre-order walk, siblings ordered by their subtree digest.
   *
   * An integer rather than a dotted path. A dotted path's length grows with depth, so a deep
   * trace produces quadratic storage and quadratic comparison cost — a 10,000-span chain took
   * seconds purely building and sorting its own path strings. The index carries the same
   * information because it is derived from the same canonical ordering, and structure remains
   * explicit in `depth` and in the edge list.
   */
  readonly order: number;
  readonly depth: number;
  readonly label: string;
  readonly service: string;
  readonly kind: string | null;
  readonly sideEffect: string;
  readonly tool: string | null;
  readonly dataDomain: string | null;
  readonly retryNumber: number | null;
  readonly attributes: Readonly<Record<string, SafeAttributeValue>>;
}

export interface CanonicalGraph {
  readonly normaliserVersion: string;
  readonly normaliserConfigHash: string;
  readonly nodes: readonly CanonicalNode[];
  /** Contract-relevant edges, referencing nodes by canonical order. */
  readonly edges: readonly { readonly from: number; readonly to: number; readonly type: string }[];
}

/**
 * The content that identifies a node independently of its position, used to order siblings.
 * Retry number is included because a second attempt is a different behavioural fact from a first.
 */
function labelOf(node: TraceNode): string {
  return JSON.stringify([
    node.canonicalName,
    node.serviceName,
    node.spanKind,
    node.sideEffect,
    node.toolName,
    node.dataDomain,
    node.retryNumber,
    sortedEntries(node.attributes),
  ]);
}

function sortedEntries(
  attributes: Readonly<Record<string, SafeAttributeValue>>,
): readonly (readonly [string, SafeAttributeValue])[] {
  return Object.keys(attributes)
    .sort()
    .map((key) => [key, attributes[key] as SafeAttributeValue] as const);
}

/**
 * Digest of one subtree: its own label plus its children's already-computed digests.
 *
 * Length-prefixing each part keeps the encoding unambiguous, so two different subtrees cannot
 * produce the same input string by concatenating differently.
 */
function subtreeDigest(label: string, childDigests: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(`${label.length}:${label}`);
  for (const digest of childDigests) hash.update(`|${digest}`);
  return hash.digest("hex");
}

/**
 * Builds the canonical graph.
 *
 * The traversal is iterative rather than recursive so a deep trace cannot overflow the stack, and
 * it computes each subtree's canonical content bottom-up so that a parent can order its children
 * by what they contain rather than by what they are called.
 */
export function canonicaliseGraph(graph: TraceGraph): CanonicalGraph {
  const byId = nodeById(graph);
  const children = childrenOf(graph);

  // Post-order without recursion: push a node twice, and process it the second time, by which
  // point every descendant already has a signature.
  const signature = new Map<string, string>();
  const postOrder: string[] = [];
  const stack: { readonly id: string; readonly expanded: boolean }[] = [
    { id: graph.rootSpanId, expanded: false },
  ];
  const seen = new Set<string>();

  while (stack.length > 0) {
    const frame = stack.pop() as { id: string; expanded: boolean };
    const node = byId.get(frame.id);
    if (node === undefined) continue;

    if (frame.expanded) {
      const childSignatures = (children.get(frame.id) ?? [])
        .map((childId) => signature.get(childId) ?? "")
        .sort();
      // Each subtree signature is *hashed* rather than nested. Nesting the children's signatures
      // verbatim makes a signature's length grow with the size of its subtree, so a deep trace
      // produces a quadratic string and a 10,000-span chain exceeds the maximum string length.
      // Hashing keeps every signature 64 characters wide while preserving the property that
      // matters: two subtrees have the same signature exactly when their content matches.
      signature.set(frame.id, subtreeDigest(labelOf(node), childSignatures));
      postOrder.push(frame.id);
      continue;
    }

    if (seen.has(frame.id)) continue;
    seen.add(frame.id);
    stack.push({ id: frame.id, expanded: true });
    for (const childId of children.get(frame.id) ?? []) {
      stack.push({ id: childId, expanded: false });
    }
  }

  // Assign a canonical order top-down by a pre-order walk in which siblings are visited in
  // subtree-digest order. Two graphs with the same behaviour therefore assign the same numbers,
  // and the assignment is independent of span IDs, timestamps and the order rows arrived in.
  //
  // Iterative with an explicit stack, so a deep trace cannot overflow.
  const order = new Map<string, number>();
  const depth = new Map<string, number>();
  const walkStack: { readonly id: string; readonly depth: number }[] = [
    { id: graph.rootSpanId, depth: 0 },
  ];
  let nextOrder = 0;

  while (walkStack.length > 0) {
    const frame = walkStack.pop() as { id: string; depth: number };
    if (order.has(frame.id)) continue;
    order.set(frame.id, nextOrder);
    nextOrder += 1;
    depth.set(frame.id, frame.depth);

    const ordered = [...(children.get(frame.id) ?? [])].sort((a, b) => {
      const left = signature.get(a) ?? "";
      const right = signature.get(b) ?? "";
      return left < right ? -1 : left > right ? 1 : 0;
    });
    // Reversed on push so the stack pops them in ascending digest order.
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      walkStack.push({ id: ordered[index] as string, depth: frame.depth + 1 });
    }
  }

  const nodes: CanonicalNode[] = [];
  for (const id of postOrder) {
    const node = byId.get(id) as TraceNode;
    const nodeOrder = order.get(id);
    // A node the traversal never reached is not part of the rooted graph and cannot contribute to
    // route identity. It is retained in the graph as evidence and reported through warnings.
    if (nodeOrder === undefined) continue;

    nodes.push({
      order: nodeOrder,
      depth: depth.get(id) ?? 0,
      label: node.canonicalName,
      service: node.serviceName,
      kind: node.spanKind,
      sideEffect: node.sideEffect,
      tool: node.toolName,
      dataDomain: node.dataDomain,
      retryNumber: node.retryNumber,
      attributes: Object.fromEntries(sortedEntries(node.attributes)),
    });
  }

  nodes.sort((a, b) => a.order - b.order);

  const edges = graph.edges
    .filter((edge) => order.has(edge.from) && order.has(edge.to))
    .map((edge) => ({
      from: order.get(edge.from) as number,
      to: order.get(edge.to) as number,
      type: edge.type,
    }))
    .sort((a, b) =>
      a.from !== b.from
        ? a.from - b.from
        : a.to !== b.to
          ? a.to - b.to
          : a.type < b.type
            ? -1
            : a.type > b.type
              ? 1
              : 0,
    );

  return {
    normaliserVersion: graph.normaliserVersion,
    normaliserConfigHash: graph.normaliserConfigHash,
    nodes,
    edges,
  };
}

/**
 * Serialises a canonical graph to a stable string.
 *
 * `JSON.stringify` preserves insertion order for object keys, so every object here is built with
 * its keys in a fixed literal order and every collection is sorted before serialisation. Nothing
 * relies on the order the graph happened to be constructed in.
 */
export function serialiseCanonicalGraph(canonical: CanonicalGraph): string {
  return JSON.stringify({
    normaliserVersion: canonical.normaliserVersion,
    normaliserConfigHash: canonical.normaliserConfigHash,
    nodes: canonical.nodes.map((node) => ({
      order: node.order,
      depth: node.depth,
      label: node.label,
      service: node.service,
      kind: node.kind,
      sideEffect: node.sideEffect,
      tool: node.tool,
      dataDomain: node.dataDomain,
      retryNumber: node.retryNumber,
      attributes: node.attributes,
    })),
    edges: canonical.edges.map((edge) => ({ from: edge.from, to: edge.to, type: edge.type })),
  });
}

export interface RouteFingerprint {
  readonly fingerprint: string;
  readonly normaliserVersion: string;
  readonly normaliserConfigHash: string;
}

/**
 * SHA-256 over the canonical serialisation.
 *
 * The normaliser version and config hash are inside the hashed content, not merely recorded
 * beside it, so a fingerprint produced under different rules cannot collide with one produced
 * under these. Comparing across normaliser versions then fails visibly instead of quietly
 * matching routes that were never computed the same way.
 */
export function fingerprintGraph(graph: TraceGraph): RouteFingerprint {
  const canonical = canonicaliseGraph(graph);
  return {
    fingerprint: createHash("sha256").update(serialiseCanonicalGraph(canonical)).digest("hex"),
    normaliserVersion: graph.normaliserVersion,
    normaliserConfigHash: graph.normaliserConfigHash,
  };
}

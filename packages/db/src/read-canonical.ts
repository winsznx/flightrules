import type { CanonicalGraph, CanonicalNode } from "@flightrules/trace-graph";

/**
 * Reconstructs a canonical graph from a `jsonb` value.
 *
 * `canonicaliseGraph` builds every node's attribute map with its keys in lexicographic order, and
 * `serialiseCanonicalGraph` writes that map through unchanged — so attribute key order is part of
 * the byte string a route fingerprint is taken over. PostgreSQL `jsonb` stores object keys by
 * length and then by bytes, which is a different order, so a graph read back from a row would
 * serialise differently from the one that produced the fingerprint stored beside it.
 *
 * Restoring the order here is what makes the persistence layer transparent: a graph that goes into
 * a row and comes back out serialises to identical bytes, which a round-trip test asserts directly
 * rather than assuming.
 */

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function readNode(value: unknown, index: number): CanonicalNode {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`canonical node ${index} is not an object`);
  }
  const node = value as Record<string, unknown>;
  const rawAttributes = node["attributes"];
  const attributes: Record<string, never> = {};
  if (typeof rawAttributes === "object" && rawAttributes !== null) {
    const source = rawAttributes as Record<string, never>;
    for (const key of Object.keys(source).sort(compareKeys)) {
      attributes[key] = source[key] as never;
    }
  }
  return {
    order: node["order"] as number,
    depth: node["depth"] as number,
    label: node["label"] as string,
    service: node["service"] as string,
    kind: (node["kind"] ?? null) as string | null,
    sideEffect: node["sideEffect"] as string,
    tool: (node["tool"] ?? null) as string | null,
    dataDomain: (node["dataDomain"] ?? null) as string | null,
    retryNumber: (node["retryNumber"] ?? null) as number | null,
    attributes,
  };
}

export function readCanonicalGraph(value: unknown): CanonicalGraph {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("a canonical graph column did not contain an object");
  }
  const graph = value as Record<string, unknown>;
  const nodes = Array.isArray(graph["nodes"]) ? graph["nodes"] : [];
  const edges = Array.isArray(graph["edges"]) ? graph["edges"] : [];
  return {
    normaliserVersion: graph["normaliserVersion"] as string,
    normaliserConfigHash: graph["normaliserConfigHash"] as string,
    nodes: nodes.map(readNode),
    edges: edges.map((edge) => {
      const entry = edge as Record<string, unknown>;
      return {
        from: entry["from"] as number,
        to: entry["to"] as number,
        type: entry["type"] as CanonicalGraph["edges"][number]["type"],
      };
    }),
  };
}

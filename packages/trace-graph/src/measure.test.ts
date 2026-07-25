import { describe, expect, it } from "vitest";
import type { CanonicalGraph, CanonicalNode } from "./canonical.js";
import { retryCountOf } from "./measure.js";

/**
 * Retry counting over a stored canonical graph (FR-011's "retry change from baseline").
 *
 * The distinction this file exists to protect: `retryNumber` is an attempt index, not a retry
 * count. Counting spans that carry the attribute would report every first attempt as a retry and
 * make a perfectly clean release look like a retry storm.
 */

function node(overrides: Partial<CanonicalNode> = {}): CanonicalNode {
  return {
    order: 0,
    depth: 0,
    label: "refund.request",
    service: "flightrules-demo-agent",
    kind: "SERVER",
    sideEffect: "none",
    tool: null,
    dataDomain: null,
    retryNumber: null,
    attributes: {},
    ...overrides,
  };
}

function graph(nodes: readonly CanonicalNode[]): CanonicalGraph {
  return {
    normaliserVersion: "1.0.0",
    normaliserConfigHash: "0".repeat(64),
    nodes,
    edges: [],
  };
}

describe("retryCountOf", () => {
  it("reports zero for a run where nothing was retried", () => {
    // #given three spans, none carrying an attempt index
    // #then the run made no extra attempts
    expect(retryCountOf(graph([node(), node({ order: 1 }), node({ order: 2 })]))).toBe(0);
  });

  it("does not count a first attempt as a retry", () => {
    // #given a span that explicitly reports attempt 0
    // #then attempt zero is the first attempt, not a retry
    expect(retryCountOf(graph([node({ retryNumber: 0 })]))).toBe(0);
  });

  it("counts extra attempts, not spans that carry the attribute", () => {
    // #given one span on its third attempt and one on its first retry
    const measured = retryCountOf(
      graph([node({ retryNumber: 2 }), node({ order: 1, retryNumber: 1 })]),
    );

    // #then the run made three extra attempts in total
    expect(measured).toBe(3);
  });

  it("ignores a negative attempt index rather than subtracting from the total", () => {
    // #given a malformed attribute that arrived as a negative number
    // #then it contributes nothing; a bad value cannot reduce another span's real retries
    expect(
      retryCountOf(graph([node({ retryNumber: -5 }), node({ order: 1, retryNumber: 2 })])),
    ).toBe(2);
  });

  it("reports zero for an empty graph", () => {
    // #then a graph with no nodes has no retries, and does not throw
    expect(retryCountOf(graph([]))).toBe(0);
  });
});

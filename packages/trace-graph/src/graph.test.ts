import { FlightRulesError } from "@flightrules/domain";
import { knownGoodTrace, rowsOf, unsafeTrace } from "@flightrules/test-fixtures";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildTraceGraph, type SpanRowData } from "./build.js";
import { canonicaliseGraph, fingerprintGraph, serialiseCanonicalGraph } from "./canonical.js";
import { diffGraphs, unknownRouteChange } from "./diff.js";
import { exportGraph } from "./export.js";
import { featuresOfGraph, similarity, weightedJaccard } from "./features.js";
import { isBaselineEligible } from "./model.js";

/**
 * Graph tests. The fixtures are real telemetry captured from the live SigNoz deployment, so these
 * assert against traces the instrumented system actually produced rather than against JSON shaped
 * to match the implementation.
 */

const ROOT_SELECTOR = "refund.request";

function goodGraph(rows = rowsOf(knownGoodTrace())) {
  return buildTraceGraph(rows, { rootSelector: ROOT_SELECTOR });
}

function unsafeGraph(rows = rowsOf(unsafeTrace())) {
  return buildTraceGraph(rows, { rootSelector: ROOT_SELECTOR });
}

/** Deterministic shuffle so a failing property replays identically from its seed. */
function shuffle<T>(items: readonly T[], seed: number): readonly T[] {
  const result = [...items];
  let state = seed || 1;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    const target = state % (index + 1);
    [result[index], result[target]] = [result[target] as T, result[index] as T];
  }
  return result;
}

describe("building graphs from real captured traces", () => {
  it("reconstructs the known-good release as a complete six-service trace", () => {
    // #given the captured refund-agent-v1 trace
    const graph = goodGraph();

    // #then every span is a node and every service is represented
    expect(graph.nodes).toHaveLength(12);
    expect(new Set(graph.nodes.map((node) => node.serviceName)).size).toBe(6);
    expect(graph.quality).toBe("complete");
  });

  it("selects the configured root rather than whichever span arrived first", () => {
    // #given rows whose first entry is not the root
    const graph = goodGraph();

    // #then the root is the span the selector names
    const root = graph.nodes.find((node) => node.spanId === graph.rootSpanId);
    expect(root?.canonicalName).toBe(ROOT_SELECTOR);
  });

  it("makes the known-good trace eligible for baseline mining", () => {
    expect(isBaselineEligible(goodGraph())).toBe(true);
  });

  it("reconstructs the unsafe release with the skipped services absent", () => {
    // #given the captured refund-agent-v2 trace
    const graph = unsafeGraph();
    const services = new Set(graph.nodes.map((node) => node.serviceName));

    // #then the prerequisites are missing from the evidence itself
    expect(graph.nodes).toHaveLength(8);
    expect(services).not.toContain("flightrules-policy-service");
    expect(services).not.toContain("flightrules-fraud-service");
  });

  it("classifies the two payment writes with their retry numbers", () => {
    // #given the unsafe trace
    const graph = unsafeGraph();

    // #then both client write spans are present and distinguishable by attempt
    const writes = graph.nodes.filter(
      (node) => node.sideEffect === "write" && node.spanKind === "Client",
    );
    expect(writes).toHaveLength(2);
    expect(new Set(writes.map((node) => node.retryNumber))).toEqual(new Set([0, 1]));
  });

  it("normalises volatile identifiers out of the canonical name", () => {
    // #given a trace whose run id is a random token
    const graph = goodGraph();

    // #then no canonical name carries it
    const runId = graph.nodes.find((node) => node.releaseId !== null)?.evidence["agent.run.id"];
    expect(runId).toBeUndefined(); // agent.run.id is configured volatile and dropped entirely
    for (const node of graph.nodes) {
      expect(node.canonicalName).not.toMatch(/run_[a-f0-9]{8}/);
    }
  });
});

describe("the Phase 04 aborted server span", () => {
  it("reports the missing server span as a trace-quality warning, not as absence of the call", () => {
    // #given the unsafe trace, whose first payment attempt aborted while the handler was in
    // flight, so Fastify never exported that handler's server span
    const graph = unsafeGraph();

    // #then the condition is visible
    const warning = graph.warnings.find(
      (entry) => entry.kind === "client_span_without_server_span",
    );
    expect(warning).toBeDefined();
    expect(warning?.spanIds.length).toBeGreaterThan(0);
  });

  it("still yields a usable graph, because the client spans carry the duplicate evidence", () => {
    // #given the same trace
    const graph = unsafeGraph();

    // #then the trace is not downgraded to incomplete: the duplicate refund is fully determined
    // by the two exported client write spans, so refusing to analyse it would turn a correctly
    // detected duplicate into a false negative
    expect(graph.quality).toBe("complete");
    expect(
      graph.nodes.filter((node) => node.sideEffect === "write" && node.spanKind === "Client"),
    ).toHaveLength(2);
  });
});

describe("determinism", () => {
  it("produces the same fingerprint for any input row order", () => {
    // #given the known-good rows in every permutation the generator produces
    const rows = rowsOf(knownGoodTrace());
    const expected = fingerprintGraph(goodGraph(rows)).fingerprint;

    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }), (seed) => {
        // #when the rows arrive shuffled, as SigNoz genuinely returns them
        const actual = fingerprintGraph(goodGraph(shuffle(rows, seed))).fingerprint;

        // #then the fingerprint is unchanged
        return actual === expected;
      }),
      { numRuns: 200 },
    );
  });

  it("produces the same fingerprint for any attribute key order", () => {
    // #given the same rows with their keys reordered
    const rows = rowsOf(knownGoodTrace());
    const expected = fingerprintGraph(goodGraph(rows)).fingerprint;

    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }), (seed) => {
        const reordered = rows.map((row) => {
          const keys = shuffle(Object.keys(row), seed);
          const rebuilt: Record<string, unknown> = {};
          for (const key of keys) rebuilt[key] = row[key];
          return rebuilt;
        });

        // #then JSON key order does not reach the fingerprint
        return fingerprintGraph(goodGraph(reordered)).fingerprint === expected;
      }),
      { numRuns: 200 },
    );
  });

  it("produces the same fingerprint when every volatile identifier is regenerated", () => {
    // #given a trace re-run: new trace id, new span ids, new run id, new order id, new timestamps
    const rows = rowsOf(knownGoodTrace());
    const expected = fingerprintGraph(goodGraph(rows)).fingerprint;

    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (traceSeed, offset) => {
          const traceId = traceSeed.toString(16).padStart(32, "0");
          const remap = new Map<string, string>();
          const rename = (id: string): string => {
            const existing = remap.get(id);
            if (existing !== undefined) return existing;
            const replacement = (offset + remap.size + 1).toString(16).padStart(16, "0");
            remap.set(id, replacement);
            return replacement;
          };

          // Parent ids must be remapped consistently, or the tree structure itself changes.
          for (const row of rows) rename(row["span_id"] as string);

          const regenerated = rows.map((row) => ({
            ...row,
            trace_id: traceId,
            span_id: rename(row["span_id"] as string),
            parent_span_id:
              typeof row["parent_span_id"] === "string" && row["parent_span_id"].length > 0
                ? rename(row["parent_span_id"])
                : row["parent_span_id"],
            "agent.run.id": `run_${offset.toString(16)}`,
            timestamp: new Date(1_700_000_000_000 + offset).toISOString(),
          }));

          // #then the route identity is unchanged: this is the same behaviour, run again
          return fingerprintGraph(goodGraph(regenerated)).fingerprint === expected;
        },
      ),
      { numRuns: 100 },
    );
  });

  it("serialises identically across repeated canonicalisation", () => {
    // #given one graph canonicalised twice
    const graph = goodGraph();

    // #then the bytes are equal, which is what makes stored fingerprints comparable
    expect(serialiseCanonicalGraph(canonicaliseGraph(graph))).toBe(
      serialiseCanonicalGraph(canonicaliseGraph(graph)),
    );
  });
});

describe("fingerprint sensitivity", () => {
  it("changes when a meaningful node is removed", () => {
    // #given the known-good trace with the fraud check dropped
    const rows = rowsOf(knownGoodTrace());
    const withoutFraud = rows.filter((row) => !String(row["name"]).startsWith("fraud."));

    // #then the route identity changes, which is what makes a skipped check detectable
    expect(fingerprintGraph(goodGraph(withoutFraud)).fingerprint).not.toBe(
      fingerprintGraph(goodGraph(rows)).fingerprint,
    );
  });

  it("changes when an edge is reparented", () => {
    // #given the same spans wired into a different shape
    const rows = rowsOf(knownGoodTrace());
    const root = rows.find((row) => row["name"] === ROOT_SELECTOR) as SpanRowData;
    const fraud = rows.find((row) => row["name"] === "fraud.check") as SpanRowData;
    const policy = rows.find((row) => row["name"] === "policy.retrieve") as SpanRowData;

    const reparented = rows.map((row) =>
      row === fraud ? { ...row, parent_span_id: policy["span_id"] } : row,
    );
    expect(root["span_id"]).toBeDefined();

    // #then structure is part of identity, not merely the set of steps
    expect(fingerprintGraph(goodGraph(reparented)).fingerprint).not.toBe(
      fingerprintGraph(goodGraph(rows)).fingerprint,
    );
  });

  it("changes when a side-effect classification changes", () => {
    // #given a read reclassified as a write
    const rows = rowsOf(knownGoodTrace());
    const altered = rows.map((row) =>
      row["name"] === "order.lookup" ? { ...row, "agent.side_effect": "write" } : row,
    );

    // #then the change is visible in the fingerprint
    expect(fingerprintGraph(goodGraph(altered)).fingerprint).not.toBe(
      fingerprintGraph(goodGraph(rows)).fingerprint,
    );
  });

  it("does not change when an excluded attribute changes", () => {
    // #given a differing order id, which is configured volatile
    const rows = rowsOf(knownGoodTrace());
    const altered = rows.map((row) => ({ ...row, "agent.order.id": "ord-00000" }));

    // #then route identity is unaffected
    expect(fingerprintGraph(goodGraph(altered)).fingerprint).toBe(
      fingerprintGraph(goodGraph(rows)).fingerprint,
    );
  });

  it("distinguishes the known-good release from the unsafe one", () => {
    expect(fingerprintGraph(goodGraph()).fingerprint).not.toBe(
      fingerprintGraph(unsafeGraph()).fingerprint,
    );
  });
});

describe("deduplication", () => {
  it("collapses identical duplicate spans", () => {
    // #given a row repeated verbatim, as a retried MCP fetch can produce
    const rows = rowsOf(knownGoodTrace());
    const duplicated = [...rows, rows[0] as SpanRowData];

    // #then the duplicate collapses and the fingerprint is unchanged
    const graph = goodGraph(duplicated);
    expect(graph.nodes).toHaveLength(12);
    expect(graph.warnings.some((w) => w.kind === "duplicate_spans_merged")).toBe(true);
    expect(fingerprintGraph(graph).fingerprint).toBe(fingerprintGraph(goodGraph(rows)).fingerprint);
  });

  it("prefers the more complete record when duplicates agree on identity", () => {
    // #given a partial record for a span that also arrived complete
    const rows = rowsOf(knownGoodTrace());
    const full = rows.find((row) => row["name"] === "payment.refund") as SpanRowData;
    const partial = {
      span_id: full["span_id"],
      trace_id: full["trace_id"],
      name: full["name"],
      "service.name": full["service.name"],
      parent_span_id: full["parent_span_id"],
      kind_string: full["kind_string"],
    };

    // #then the complete record wins and its classification survives
    const graph = goodGraph([partial, ...rows]);
    const node = graph.nodes.find((n) => n.spanId === full["span_id"]);
    expect(node?.sideEffect).toBe("write");
  });

  it("marks the trace inconsistent when duplicates disagree on identity", () => {
    // #given two records for one span that disagree on the service that emitted it
    const rows = rowsOf(knownGoodTrace());
    const conflicting = {
      ...(rows[0] as SpanRowData),
      "service.name": "a-completely-different-service",
    };

    // #then no merge is attempted and the trace is excluded from baseline mining
    const graph = goodGraph([...rows, conflicting]);
    expect(graph.quality).toBe("inconsistent");
    expect(graph.warnings.some((w) => w.kind === "conflicting_duplicate_spans")).toBe(true);
    expect(isBaselineEligible(graph)).toBe(false);
  });
});

describe("structural defects", () => {
  it("attaches orphan roots to a synthetic root and warns", () => {
    // #given a trace whose spans have no common parent
    const rows = rowsOf(knownGoodTrace()).map((row) => ({ ...row, parent_span_id: "" }));

    // #then a synthetic root is created rather than one span being promoted arbitrarily
    const graph = buildTraceGraph(rows, {});
    expect(graph.rootSpanId).toBe("synthetic-root");
    expect(graph.warnings.some((w) => w.kind === "synthetic_root")).toBe(true);
    expect(graph.warnings.some((w) => w.kind === "multiple_roots")).toBe(true);
    expect(graph.quality).toBe("incomplete");
  });

  it("records an orphan whose parent is absent from the trace", () => {
    // #given a span pointing at a parent that was never exported
    const rows = rowsOf(knownGoodTrace()).map((row) =>
      row["name"] === "fraud.check" ? { ...row, parent_span_id: "ffffffffffffffff" } : row,
    );

    // #then the orphan is reported and the trace is not silently treated as complete
    const graph = buildTraceGraph(rows, { rootSelector: ROOT_SELECTOR });
    expect(graph.warnings.some((w) => w.kind === "orphan_span")).toBe(true);
    expect(graph.quality).toBe("incomplete");
  });

  it("detects a cycle instead of recursing into it", () => {
    // #given two spans that claim each other as parent
    const rows = rowsOf(knownGoodTrace());
    const a = rows.find((row) => row["name"] === "policy.retrieve") as SpanRowData;
    const b = rows.find((row) => row["name"] === "order.lookup") as SpanRowData;
    const cyclic = rows.map((row) => {
      if (row === a) return { ...row, parent_span_id: b["span_id"] };
      if (row === b) return { ...row, parent_span_id: a["span_id"] };
      return row;
    });

    // #then the cycle is reported and the trace is inconsistent
    const graph = buildTraceGraph(cyclic, { rootSelector: ROOT_SELECTOR });
    expect(graph.warnings.some((w) => w.kind === "cycle_detected")).toBe(true);
    expect(graph.quality).toBe("inconsistent");
  });

  it("rejects rows spanning more than one trace", () => {
    const rows = rowsOf(knownGoodTrace());
    const mixed = [
      ...rows,
      { ...(rows[0] as SpanRowData), trace_id: "ff".repeat(16), span_id: "x" },
    ];
    expect(() => buildTraceGraph(mixed, {})).toThrow(FlightRulesError);
  });

  it("rejects an empty response", () => {
    expect(() => buildTraceGraph([], {})).toThrow(FlightRulesError);
  });

  it("rejects a trace beyond the configured span limit", () => {
    const rows = rowsOf(knownGoodTrace());
    try {
      buildTraceGraph(rows, { maxSpans: 3 });
      expect.unreachable("a trace over the limit must be refused");
    } catch (error) {
      expect((error as FlightRulesError).code).toBe("TRACE_TOO_LARGE");
    }
  });
});

describe("scale", () => {
  /** A synthetic chain, used only where the property under test is size rather than behaviour. */
  function chain(length: number, branching: number): readonly SpanRowData[] {
    const rows: SpanRowData[] = [];
    for (let index = 0; index < length; index += 1) {
      const parentIndex = index === 0 ? -1 : Math.floor((index - 1) / branching);
      rows.push({
        trace_id: "ab".repeat(16),
        span_id: index.toString(16).padStart(16, "0"),
        parent_span_id: parentIndex < 0 ? "" : parentIndex.toString(16).padStart(16, "0"),
        name: `step.${index % 7}`,
        "service.name": `service-${index % 5}`,
        kind_string: "Internal",
        duration_nano: 1000,
        timestamp: new Date(1_700_000_000_000 + index).toISOString(),
        "agent.side_effect": "read",
      });
    }
    return rows;
  }

  it("canonicalises a 1,000-span trace within the performance budget", () => {
    // #given a thousand spans, the scale PRD section 20.2 targets
    const rows = chain(1000, 3);

    // #when the graph is built and fingerprinted
    const started = performance.now();
    const fingerprint = fingerprintGraph(buildTraceGraph(rows, {})).fingerprint;
    const elapsedMs = performance.now() - started;

    // #then it completes well inside the one-second p95 budget
    expect(fingerprint).toHaveLength(64);
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("does not overflow the stack on a deeply nested trace", () => {
    // #given a 10,000-deep chain, which a recursive traversal cannot walk
    const rows = chain(10_000, 1);

    // #then it builds and fingerprints without throwing, and in linear time. The budget is
    // asserted because the first implementation used dotted structural paths, whose length grows
    // with depth: storage and comparison both became quadratic and this took over five seconds.
    const started = performance.now();
    const graph = buildTraceGraph(rows, { maxSpans: 20_000 });
    const fingerprint = fingerprintGraph(graph).fingerprint;
    const elapsedMs = performance.now() - started;

    expect(graph.nodes).toHaveLength(10_000);
    expect(fingerprint).toHaveLength(64);
    expect(elapsedMs).toBeLessThan(2000);
  });
});

describe("graph diff", () => {
  function diff() {
    const baseline = goodGraph();
    const candidate = unsafeGraph();
    return diffGraphs(baseline, candidate, {
      baseline: fingerprintGraph(baseline).fingerprint,
      candidate: fingerprintGraph(candidate).fingerprint,
    });
  }

  it("reports the two skipped prerequisites as removed nodes", () => {
    // #given the real v1 and v2 traces
    const removed = diff()
      .changes.filter((change) => change.kind === "node_removed")
      .map((change) => change.subject);

    // #then the skipped checks are named
    expect(removed).toContain("policy.retrieve");
    expect(removed).toContain("fraud.check");
  });

  it("reports the duplicated payment as a duplicated side effect", () => {
    // #given the same pair
    const duplicated = diff().changes.filter((change) => change.kind === "side_effect_duplicated");

    // #then the refund is named with both counts, which is the product's core finding
    const payment = duplicated.find((change) => change.subject.startsWith("payment.refund"));
    expect(payment).toBeDefined();
    expect(payment?.baselineCount).toBe(1);
    expect(payment?.candidateCount).toBe(2);
  });

  it("links the duplicated side effect to real span ids", () => {
    // #given the diff
    const payment = diff().changes.find((change) => change.kind === "side_effect_duplicated");

    // #then evidence linking has something to point at in SigNoz
    expect(payment?.candidateSpanIds.length).toBeGreaterThan(0);
  });

  it("reports the increased retry", () => {
    const retries = diff().changes.filter((change) => change.kind === "retry_increased");
    expect(retries.some((change) => change.subject === "payment.refund")).toBe(true);
  });

  it("marks the two graphs as not identical", () => {
    expect(diff().identical).toBe(false);
  });

  it("reports no changes when a graph is compared with itself", () => {
    // #given one graph on both sides
    const graph = goodGraph();
    const fingerprint = fingerprintGraph(graph).fingerprint;

    // #then nothing is reported, so a passing release produces an empty diff
    const result = diffGraphs(graph, graph, { baseline: fingerprint, candidate: fingerprint });
    expect(result.identical).toBe(true);
    expect(result.changes).toEqual([]);
  });

  it("produces the same diff regardless of input row order", () => {
    // #given both traces built from shuffled rows
    const baseline = goodGraph(shuffle(rowsOf(knownGoodTrace()), 7));
    const candidate = unsafeGraph(shuffle(rowsOf(unsafeTrace()), 11));
    const shuffled = diffGraphs(baseline, candidate, {
      baseline: fingerprintGraph(baseline).fingerprint,
      candidate: fingerprintGraph(candidate).fingerprint,
    });

    // #then the change list is byte-identical to the unshuffled one
    expect(JSON.stringify(shuffled.changes)).toBe(JSON.stringify(diff().changes));
  });

  it("flags a route matching no approved family", () => {
    // #given a candidate fingerprint absent from the approved set
    const change = unknownRouteChange("deadbeef", ["cafebabe"]);
    expect(change?.kind).toBe("route_unknown");
  });

  it("does not flag a route that is in the approved set", () => {
    expect(unknownRouteChange("cafebabe", ["cafebabe"])).toBeUndefined();
  });
});

describe("similarity", () => {
  it("scores a graph against itself as exactly 1", () => {
    expect(similarity(goodGraph(), goodGraph())).toBe(1);
  });

  it("scores the unsafe release below the known-good release", () => {
    // #given the two real traces
    const score = similarity(goodGraph(), unsafeGraph());

    // #then they are related but not identical
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it("weights a critical node above an ordinary one", () => {
    // #given the fraud check declared critical
    const withCritical = featuresOfGraph(goodGraph(), { criticalNodes: ["fraud.check"] });
    const withoutCritical = featuresOfGraph(goodGraph());

    // #then the critical declaration raises the total weight
    expect(withCritical.totalWeight).toBeGreaterThan(withoutCritical.totalWeight);
  });

  it("treats two empty feature sets as identical", () => {
    // #given nothing on either side, which must not read as maximally different
    expect(
      weightedJaccard({ byKey: new Map(), totalWeight: 0 }, { byKey: new Map(), totalWeight: 0 }),
    ).toBe(1);
  });

  it("is symmetric", () => {
    const a = goodGraph();
    const b = unsafeGraph();
    expect(similarity(a, b)).toBe(similarity(b, a));
  });
});

describe("safe export", () => {
  it("excludes span identifiers and timestamps from the canonical export", () => {
    // #given an exported graph
    const exported = JSON.stringify(exportGraph(goodGraph()));

    // #then no volatile identifier reached it
    expect(exported).not.toContain(knownGoodTrace().rows[0]?.data["span_id"]);
    expect(exported).not.toContain("timestamp");
  });

  it("redacts a secret that reached a span attribute", () => {
    // #given a span carrying an attribute under a secret-shaped key
    const rows = rowsOf(knownGoodTrace()).map((row) => ({
      ...row,
      "agent.api_key": "super-secret-value-that-must-not-escape",
    }));

    // #then the value does not appear in the export
    const exported = JSON.stringify(exportGraph(goodGraph(rows), { includeEvidence: true }));
    expect(exported).not.toContain("super-secret-value-that-must-not-escape");
  });

  it("carries the normaliser version so a fingerprint is never compared across rule changes", () => {
    const exported = exportGraph(goodGraph());
    expect(exported.normaliserVersion).toBe("1.0.0");
    expect(exported.normaliserConfigHash).toHaveLength(64);
  });
});

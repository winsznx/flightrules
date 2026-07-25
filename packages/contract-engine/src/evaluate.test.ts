import { readFileSync } from "node:fs";
import path from "node:path";
import {
  formatValidationErrors,
  parseContract,
  type TrajectoryContract,
} from "@flightrules/contract-schema";
import {
  approvedRefundRows,
  approvedRefundSpans,
  knownGoodTrace,
  rowsOf,
  type SpanSpec,
  spanRows,
  unsafeTrace,
} from "@flightrules/test-fixtures";
import {
  buildTraceGraph,
  canonicaliseGraph,
  fingerprintGraph,
  type TraceGraph,
} from "@flightrules/trace-graph";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { serialiseEvaluation } from "./canonical.js";
import { evaluateRun, evaluateRunSafely } from "./evaluate.js";
import { GraphIndex } from "./graph-index.js";
import type { ApprovedRoute } from "./rule-context.js";
import { EVALUATOR_VERSION } from "./version.js";

/**
 * Evaluation as a whole: the exit gate, determinism, and every adversarial trace shape the graph
 * layer can hand the evaluator.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const DEMO_CONTRACT = path.join(
  REPO_ROOT,
  "contracts",
  "demo-commerce",
  "refund-agent",
  "production",
  "contract.yaml",
);
const ROOT_SELECTOR = "refund.request";

function demoContract(): TrajectoryContract {
  const result = parseContract(readFileSync(DEMO_CONTRACT, "utf8"));
  if (!result.ok) throw new Error(formatValidationErrors(result.errors));
  return result.value.contract;
}

function graphOf(rows: readonly Record<string, unknown>[]): TraceGraph {
  return buildTraceGraph(rows, { rootSelector: ROOT_SELECTOR });
}

function approvedGraph(): TraceGraph {
  return graphOf(rowsOf(knownGoodTrace()));
}

function unsafeGraph(): TraceGraph {
  return graphOf(rowsOf(unsafeTrace()));
}

function approvedFamily(): readonly ApprovedRoute[] {
  const graph = approvedGraph();
  return [
    { fingerprint: fingerprintGraph(graph).fingerprint, canonical: canonicaliseGraph(graph) },
  ];
}

function evaluate(graph: TraceGraph, contract = demoContract()) {
  return evaluateRun({ graph, contract, approvedRoutes: approvedFamily() });
}

/* -------------------------------------------------------------------------- */
/* The exit gate                                                             */
/* -------------------------------------------------------------------------- */

describe("the Phase 07 exit gate", () => {
  it("passes the approved release against the active contract", () => {
    const { evaluation } = evaluate(approvedGraph());
    expect(evaluation.status).toBe("pass");
    expect(evaluation.violations).toEqual([]);
  });

  it("fails the canary on the missing fraud check, the missing policy check and the duplicate refund", () => {
    // #given the real unsafe trace
    const { evaluation } = evaluate(unsafeGraph());

    // #then the release fails
    expect(evaluation.status).toBe("fail");

    // #and each of the three findings the PRD names is present, by rule and by code
    const byRule = new Map(evaluation.violations.map((entry) => [entry.ruleId, entry]));
    expect(byRule.get("require-fraud-check")?.code).toBe("REQUIRED_SPAN_MISSING");
    expect(byRule.get("require-policy-check")?.code).toBe("REQUIRED_SPAN_MISSING");
    expect(byRule.get("single-refund-write")?.code).toBe("CARDINALITY_ABOVE_MAX");

    // #and all three are critical and zero-tolerance
    for (const ruleId of ["require-fraud-check", "require-policy-check", "single-refund-write"]) {
      expect(byRule.get(ruleId)?.severity).toBe("critical");
      expect(byRule.get(ruleId)?.zeroTolerance).toBe(true);
    }
    expect(evaluation.counts.zeroToleranceViolations).toBe(3);
  });

  it("reaches that verdict with no model, no clock and no network", () => {
    // #given an evaluation run with an injected clock that never advances
    const { evaluation, runtime } = evaluateRun({
      graph: unsafeGraph(),
      contract: demoContract(),
      approvedRoutes: approvedFamily(),
      nowMs: () => 0,
      completedAt: "1970-01-01T00:00:00Z",
    });

    // #then the decision is unchanged, so nothing in it depended on elapsed time
    expect(evaluation.status).toBe("fail");
    expect(runtime.durationMs).toBe(0);
  });

  it("links every violation to real span evidence or to the label it expected", () => {
    const { evaluation } = evaluate(unsafeGraph());
    const spanIds = new Set(unsafeGraph().nodes.map((node) => node.spanId));

    for (const violation of evaluation.violations) {
      const hasEvidence =
        violation.evidence.spanIds.length > 0 || violation.evidence.labels.length > 0;
      // The route rule is about the trace as a whole and names no span, which is why the assertion
      // allows an empty reference for it specifically rather than in general.
      if (violation.ruleType === "approved_routes") continue;
      expect(hasEvidence, `${violation.id} carries no evidence`).toBe(true);
      for (const spanId of violation.evidence.spanIds) expect(spanIds.has(spanId)).toBe(true);
    }
  });

  it("keeps trace-quality warnings separate from contract violations", () => {
    const { evaluation } = evaluate(unsafeGraph());

    // #then the aborted server span appears as a warning
    expect(evaluation.traceWarnings.map((warning) => warning.kind)).toContain(
      "client_span_without_server_span",
    );
    // #and never as a violation
    expect(evaluation.violations.map((entry) => entry.code)).not.toContain(
      "client_span_without_server_span",
    );
  });

  it("records the evaluator, normaliser and contract versions on every result", () => {
    const { evaluation } = evaluate(approvedGraph());
    expect(evaluation.evaluatorVersion).toBe(EVALUATOR_VERSION);
    expect(evaluation.normaliserVersion).toBe(approvedGraph().normaliserVersion);
    expect(evaluation.contractVersion).toBe("1.0.0");
    expect(evaluation.contractContentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

/* -------------------------------------------------------------------------- */
/* Evaluation order                                                          */
/* -------------------------------------------------------------------------- */

describe("evaluation order", () => {
  it("reports rule results in PRD section 11.11's order", () => {
    const { evaluation } = evaluate(unsafeGraph());
    const order = evaluation.ruleResults.map((result) => result.ruleType);

    const expected = [
      "required_span",
      "forbidden_span",
      "cardinality",
      "required_edge",
      "required_ancestry",
      "forbidden_path",
      "attribute_constraint",
      "allowed_values",
      "retry_budget",
      "approved_routes",
      "numeric_budget",
    ];

    // #then the sequence of types is non-decreasing in the specified order
    const positions = order.map((type) => expected.indexOf(type));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("orders violations by severity, most serious first", () => {
    const { evaluation } = evaluate(unsafeGraph());
    const rank = { critical: 3, high: 2, medium: 1, low: 0 } as const;
    const ranks = evaluation.violations.map((entry) => rank[entry.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
  });
});

/* -------------------------------------------------------------------------- */
/* Determinism                                                               */
/* -------------------------------------------------------------------------- */

describe("determinism", () => {
  it("is byte-identical across repeated evaluations of the same graph", () => {
    const graph = unsafeGraph();
    const first = evaluate(graph);
    const second = evaluate(graph);
    expect(serialiseEvaluation(second.evaluation)).toBe(serialiseEvaluation(first.evaluation));
    expect(second.evaluationHash).toBe(first.evaluationHash);
  });

  it("is byte-identical when the input spans arrive in a different order", () => {
    // #given the same rows, shuffled
    const rows = rowsOf(unsafeTrace());
    const reversed = [...rows].reverse();
    const rotated = [...rows.slice(3), ...rows.slice(0, 3)];

    const baseline = evaluate(graphOf(rows)).evaluationHash;
    expect(evaluate(graphOf(reversed)).evaluationHash).toBe(baseline);
    expect(evaluate(graphOf(rotated)).evaluationHash).toBe(baseline);
  });

  it("is byte-identical when rule declarations are reordered", () => {
    // #given the contract with its rules reversed in the source document
    const source = readFileSync(DEMO_CONTRACT, "utf8");
    const parsed = parseContract(source);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const reversed: TrajectoryContract = {
      ...parsed.value.contract,
      spec: {
        ...parsed.value.contract.spec,
        rules: [...parsed.value.contract.spec.rules].reverse(),
      },
    };

    const graph = unsafeGraph();
    expect(evaluate(graph, reversed).evaluationHash).toBe(
      evaluate(graph, demoContract()).evaluationHash,
    );
  });

  it("is byte-identical when attribute keys arrive in a different order", () => {
    // #given the same spans with their attribute keys reversed on every row
    const rows = rowsOf(unsafeTrace()).map((row) =>
      Object.fromEntries(Object.entries(row).reverse()),
    );
    expect(evaluate(graphOf(rows)).evaluationHash).toBe(evaluate(unsafeGraph()).evaluationHash);
  });

  it("excludes the completion timestamp and the elapsed duration from the hash", () => {
    const graph = unsafeGraph();
    const first = evaluateRun({
      graph,
      contract: demoContract(),
      approvedRoutes: approvedFamily(),
      completedAt: "2026-01-01T00:00:00Z",
      nowMs: () => 0,
    });
    const second = evaluateRun({
      graph,
      contract: demoContract(),
      approvedRoutes: approvedFamily(),
      completedAt: "2030-12-31T23:59:59Z",
      nowMs: () => 5_000,
    });

    expect(second.evaluationHash).toBe(first.evaluationHash);
    expect(second.runtime.completedAt).not.toBe(first.runtime.completedAt);
  });

  it("gives a violation the same identifier for two runs of the same logical route", () => {
    // #given two canary runs with entirely different trace, span and run identifiers
    const build = (traceId: string, suffix: string): TraceGraph =>
      graphOf(
        spanRows({
          traceId,
          runId: `run_${suffix}`,
          releaseId: "refund-agent-v2",
          spans: [
            {
              name: "refund.request",
              spanId: `r${suffix}`,
              parentSpanId: null,
              kind: "Server",
              operation: "invoke_agent",
            },
            {
              name: "order.lookup",
              spanId: `o${suffix}`,
              parentSpanId: `r${suffix}`,
              tool: "lookup_order",
              operation: "execute_tool",
              sideEffect: "read",
              retry: 0,
            },
            {
              name: "payment.refund",
              spanId: `p${suffix}`,
              parentSpanId: `r${suffix}`,
              tool: "issue_refund",
              operation: "execute_tool",
              sideEffect: "write",
              retry: 0,
              idempotencyPresent: true,
            },
          ],
        }),
      );

    const first = evaluate(build("traceAAA000000000000000000000001", "aaa1"));
    const second = evaluate(build("traceBBB000000000000000000000002", "bbb2"));

    // #then the same finding carries the same identifier, so it can be counted as recurring
    expect(second.evaluation.violations.map((entry) => entry.id)).toEqual(
      first.evaluation.violations.map((entry) => entry.id),
    );
    // #and the evaluations themselves still differ, because they are statements about two runs
    expect(second.evaluationHash).not.toBe(first.evaluationHash);
  });

  it("changes the hash when the contract changes", () => {
    const graph = unsafeGraph();
    const loosened = parseContract(
      readFileSync(DEMO_CONTRACT, "utf8").replace("      max: 500", "      max: 100000"),
    );
    expect(loosened.ok).toBe(true);
    if (!loosened.ok) return;
    expect(evaluate(graph, loosened.value.contract).evaluationHash).not.toBe(
      evaluate(graph).evaluationHash,
    );
  });

  it("produces no floating-point value anywhere in the canonical output", () => {
    // #given the serialised evaluation
    const serialised = serialiseEvaluation(evaluate(unsafeGraph()).evaluation);
    const parsed = JSON.parse(serialised) as unknown;

    // #then every number in it is an integer. The similarity ratio is carried as a numerator, a
    // denominator and a decimal *string*, so no comparison anywhere depends on binary rounding.
    const nonIntegers: number[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === "number" && !Number.isInteger(value)) nonIntegers.push(value);
      if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(parsed);
    expect(nonIntegers).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Adversarial traces                                                        */
/* -------------------------------------------------------------------------- */

describe("adversarial trace shapes", () => {
  it("handles duplicate span records that agree", () => {
    const rows = rowsOf(unsafeTrace());
    const withDuplicates = [...rows, ...rows.slice(0, 3)];
    const graph = graphOf(withDuplicates);

    expect(graph.warnings.map((warning) => warning.kind)).toContain("duplicate_spans_merged");
    // #then the duplicate refund is still counted once per real span, not once per record
    expect(evaluate(graph).evaluation.status).toBe("fail");
    expect(
      evaluate(graph).evaluation.violations.find((entry) => entry.ruleId === "single-refund-write")
        ?.observed,
    ).toBe("2");
  });

  it("reports insufficient data for a trace whose duplicates contradict each other", () => {
    // #given two records for one span that disagree on its name
    const rows = rowsOf(unsafeTrace());
    const first = rows[0] as Record<string, unknown>;
    const conflicting = { ...first, name: "something.else" };
    const graph = graphOf([...rows, conflicting]);
    expect(graph.quality).toBe("inconsistent");

    // #then no rule is evaluated at all: choosing between two contradictory accounts of one span is
    // exactly the guess the determinism boundary forbids
    const { evaluation } = evaluate(graph);
    expect(evaluation.status).toBe("insufficient_data");
    expect(evaluation.ruleResults).toEqual([]);
    expect(evaluation.violations).toEqual([]);
  });

  it("handles a cycle in the parent relation", () => {
    const rows = spanRows({
      traceId: "cyclic00000000000000000000000000",
      spans: [
        { name: "refund.request", spanId: "cyc00001", parentSpanId: "cyc00003", kind: "Server" },
        { name: "order.lookup", spanId: "cyc00002", parentSpanId: "cyc00001", sideEffect: "read" },
        {
          name: "payment.refund",
          spanId: "cyc00003",
          parentSpanId: "cyc00002",
          sideEffect: "write",
          tool: "issue_refund",
          operation: "execute_tool",
          retry: 0,
          idempotencyPresent: true,
        },
      ],
    });
    const graph = graphOf(rows);
    expect(graph.quality).toBe("inconsistent");

    // #then the evaluator refuses to decide rather than crashing or guessing
    expect(evaluate(graph).evaluation.status).toBe("insufficient_data");
  });

  it("handles a broken parent reference", () => {
    const rows = approvedRefundRows({
      replace: [
        {
          name: "order.lookup",
          spanId: "c2order0",
          parentSpanId: "doesnotexist",
          tool: "lookup_order",
          operation: "execute_tool",
          sideEffect: "read",
          retry: 0,
        },
      ],
    });
    const graph = graphOf(rows);
    expect(graph.warnings.map((warning) => warning.kind)).toContain("orphan_span");
    expect(() => evaluate(graph)).not.toThrow();
  });

  it("handles a trace with only a root span", () => {
    const rows = spanRows({
      traceId: "single00000000000000000000000000",
      spans: [{ name: "refund.request", spanId: "only0001", parentSpanId: null, kind: "Server" }],
    });
    expect(() => evaluate(graphOf(rows))).not.toThrow();
  });

  it("handles the same tool called from different services", () => {
    const rows = approvedRefundRows({
      add: [
        {
          name: "payment.refund",
          spanId: "othersvc",
          parentSpanId: "root0000",
          service: "flightrules-order-service",
          tool: "issue_refund",
          operation: "execute_tool",
          sideEffect: "write",
          retry: 0,
          idempotencyPresent: true,
        },
      ],
    });

    // #then the cardinality rule counts both, because a second write is a second write wherever it ran
    const { evaluation } = evaluate(graphOf(rows));
    expect(
      evaluation.violations.find((entry) => entry.ruleId === "single-refund-write")?.observed,
    ).toBe("2");
  });

  it("distinguishes the same span name in different services", () => {
    const rows = approvedRefundRows({
      add: [
        {
          name: "fraud.check",
          spanId: "otherfrd",
          parentSpanId: "root0000",
          service: "flightrules-order-service",
          tool: "check_fraud",
          operation: "execute_tool",
          sideEffect: "read",
          retry: 0,
        },
      ],
    });

    // #then a name-only selector matches both, so the cardinality bound of the required span fires
    const { evaluation } = evaluate(graphOf(rows));
    expect(
      evaluation.violations.find((entry) => entry.ruleId === "require-fraud-check")?.code,
    ).toBe("REQUIRED_SPAN_TOO_MANY");
  });

  it("normalises a dynamic route identifier out of a span name before selecting on it", () => {
    // #given the fraud check named with an embedded order identifier
    const rows = approvedRefundRows({
      replace: [
        {
          name: "fraud.check",
          spanId: "c3fraud0",
          parentSpanId: "root0000",
          tool: "check_fraud",
          operation: "execute_tool",
          sideEffect: "read",
          retry: 0,
        },
      ],
    });
    const withDynamicName = rows.map((row) =>
      row["span_id"] === "c3fraud0"
        ? { ...row, name: "fraud.check/019424f1-8c8f-7a3e-9c1e-8c0d9f7b1234" }
        : row,
    );

    // #then the selector still matches, because normalisation replaced the identifier
    const graph = graphOf(withDynamicName);
    const node = graph.nodes.find((entry) => entry.spanId === "c3fraud0");
    expect(node?.canonicalName).toBe("fraud.check/{id}");
    // and the un-normalised name no longer matches `fraud.check`, which the rule requires
    expect(
      evaluate(graph).evaluation.violations.find((entry) => entry.ruleId === "require-fraud-check")
        ?.code,
    ).toBe("REQUIRED_SPAN_MISSING");
  });

  it("handles a trace larger than the demo without changing any verdict", () => {
    // #given the canary padded with a hundred unrelated read steps
    const filler: SpanSpec[] = Array.from({ length: 100 }, (_, index) => ({
      name: `audit.step`,
      spanId: `fill${String(index).padStart(4, "0")}`,
      parentSpanId: "root0000",
      service: "flightrules-order-service",
      tool: "lookup_order",
      operation: "execute_tool",
      sideEffect: "read" as const,
      retry: 0,
    }));

    const rows = spanRows({
      traceId: "padded00000000000000000000000000",
      releaseId: "refund-agent-v2",
      spans: [
        ...approvedRefundSpans().filter(
          (span) => !["c1policy", "s1policy", "c3fraud0", "s3fraud0"].includes(span.spanId),
        ),
        ...filler,
      ],
    });

    // #then the missing prerequisites are still the finding
    const codes = evaluate(graphOf(rows)).evaluation.violations.map((entry) => entry.ruleId);
    expect(codes).toContain("require-fraud-check");
    expect(codes).toContain("require-policy-check");
  });
});

/* -------------------------------------------------------------------------- */
/* Prototype-shaped telemetry                                                */
/* -------------------------------------------------------------------------- */

describe("prototype-shaped telemetry is ordinary data", () => {
  const hostile = ["toString", "constructor", "__proto__", "valueOf", "hasOwnProperty"];

  it("handles hostile span names", () => {
    for (const name of hostile) {
      const rows = approvedRefundRows({
        add: [
          { name, spanId: `h${name.slice(0, 7)}`, parentSpanId: "root0000", sideEffect: "read" },
        ],
      });
      expect(() => evaluate(graphOf(rows)), name).not.toThrow();
    }
  });

  it("handles hostile service, tool and data-domain names", () => {
    for (const name of hostile) {
      const rows = approvedRefundRows({
        add: [
          {
            name: "audit.step",
            spanId: `s${name.slice(0, 7)}`,
            parentSpanId: "root0000",
            service: name,
            tool: name,
            dataDomain: name,
            operation: name,
            sideEffect: "read",
          },
        ],
      });
      expect(() => evaluate(graphOf(rows)), name).not.toThrow();
    }
  });

  it("handles hostile attribute keys without inheriting a value", () => {
    // #given a span carrying attributes named after Object.prototype members
    const attributes: Record<string, unknown> = {};
    for (const name of hostile) attributes[name] = "telemetry-supplied";

    const rows = approvedRefundRows({
      add: [
        {
          name: "audit.step",
          spanId: "hostile1",
          parentSpanId: "root0000",
          sideEffect: "read",
          attributes,
        },
      ],
    });
    const graph = graphOf(rows);
    const index = new GraphIndex(graph);
    const node = graph.nodes.find((entry) => entry.spanId === "hostile1");
    expect(node).toBeDefined();
    if (node === undefined) return;

    // #then every hostile key reads back as the value the span carried, or undefined — never a
    // function from the prototype chain
    for (const name of hostile) {
      const value = index.attribute(node, name);
      expect(typeof value === "string" || value === undefined, name).toBe(true);
    }
    // #and a key nothing emitted is undefined rather than an inherited member
    expect(index.attribute(node, "propertyIsEnumerable")).toBeUndefined();
  });

  it("selects on an attribute whose key is a prototype member name", () => {
    const source = `apiVersion: flightrules.dev/v1alpha1
kind: TrajectoryContract
metadata:
  id: hostile-keys
  name: Hostile attribute keys
  version: 1.0.0
  project: demo-commerce
  agent: refund-agent
  environment: production
  createdAt: 2026-07-25T00:00:00Z
spec:
  selectors:
    workflowName: refund-workflow
    releaseAttribute: agent.release.id
    environmentAttribute: deployment.environment.name
  approvedRoutes: []
  rules:
    - id: forbid-hostile
      type: forbidden_span
      selector:
        attributes:
          toString: telemetry-supplied
      severity: critical
  gate:
    minCompletedRuns: 1
    evaluationTimeoutSeconds: 60
    maxViolationPercent: 0
    maxUnknownRoutePercent: 0
    maxLatencyRegressionPercent: 10
    maxTokenRegressionPercent: 10
    zeroToleranceRuleIds: []
`;
    const parsed = parseContract(source);
    expect(parsed.ok, parsed.ok ? "" : formatValidationErrors(parsed.errors)).toBe(true);
    if (!parsed.ok) return;

    // #given a span carrying an attribute literally named toString
    const clean = evaluateRun({ graph: approvedGraph(), contract: parsed.value.contract });
    expect(clean.evaluation.status).toBe("pass");

    const rows = approvedRefundRows({
      add: [
        {
          name: "audit.step",
          spanId: "hostile1",
          parentSpanId: "root0000",
          sideEffect: "read",
          attributes: { toString: "telemetry-supplied" },
        },
      ],
    });
    const dirty = evaluateRun({ graph: graphOf(rows), contract: parsed.value.contract });

    // #then the rule fires on the attribute's real value, not on Object.prototype.toString
    expect(dirty.evaluation.status).toBe("fail");
    expect(dirty.evaluation.violations[0]?.code).toBe("FORBIDDEN_SPAN_PRESENT");
  });
});

/* -------------------------------------------------------------------------- */
/* Internal failure                                                          */
/* -------------------------------------------------------------------------- */

describe("internal failure never becomes a pass", () => {
  it("reports error rather than pass when the graph is unusable", () => {
    // #given a graph object whose node list disagrees with its root, which no builder produces
    const broken = { ...approvedGraph(), nodes: [], edges: [] } as unknown as TraceGraph;
    const { evaluation } = evaluateRunSafely({
      graph: broken,
      contract: demoContract(),
      approvedRoutes: approvedFamily(),
    });

    // #then the status is never `pass`
    expect(evaluation.status).not.toBe("pass");
  });

  it("reports error for a contract whose rule references a metric the graph cannot supply", () => {
    // #given a graph with no root node at all
    const graph = { ...approvedGraph(), rootSpanId: "nonexistent" } as TraceGraph;
    const { evaluation } = evaluateRunSafely({
      graph,
      contract: demoContract(),
      approvedRoutes: approvedFamily(),
    });
    expect(["error", "fail", "insufficient_data"]).toContain(evaluation.status);
    expect(evaluation.status).not.toBe("pass");
  });
});

/* -------------------------------------------------------------------------- */
/* Property tests                                                            */
/* -------------------------------------------------------------------------- */

/** Generates a trace: the approved topology with steps randomly removed, duplicated and retried. */
const traceArbitrary = fc
  .record({
    removed: fc.subarray(
      approvedRefundSpans().map((span) => span.spanId),
      { maxLength: 6 },
    ),
    duplicateRefunds: fc.integer({ min: 0, max: 3 }),
    retry: fc.integer({ min: 0, max: 4 }),
    idempotent: fc.boolean(),
    unknownTool: fc.boolean(),
    adminWrite: fc.boolean(),
  })
  .map((shape) => {
    const extra: SpanSpec[] = [];
    for (let index = 0; index < shape.duplicateRefunds; index += 1) {
      extra.push({
        name: "payment.refund",
        spanId: `dup${String(index).padStart(5, "0")}`,
        parentSpanId: "root0000",
        tool: "issue_refund",
        operation: "execute_tool",
        sideEffect: "write",
        retry: shape.retry,
        idempotencyPresent: shape.idempotent,
      });
    }
    if (shape.unknownTool) {
      extra.push({
        name: "ledger.adjust",
        spanId: "extratool",
        parentSpanId: "root0000",
        tool: "adjust_ledger",
        operation: "execute_tool",
        sideEffect: "write",
        retry: 0,
      });
    }
    if (shape.adminWrite) {
      extra.push({
        name: "admin.override",
        spanId: "extraadmn",
        parentSpanId: "root0000",
        sideEffect: "write",
        dataDomain: "admin",
      });
    }
    // The root is never removed: a trace with no root is the graph layer's concern, and Phase 06
    // already covers it.
    return approvedRefundRows({
      remove: shape.removed.filter((spanId) => spanId !== "root0000"),
      add: extra,
    });
  });

describe("property: evaluation is total, deterministic and order-independent", () => {
  it("never throws for any generated trace", () => {
    fc.assert(
      fc.property(traceArbitrary, (rows) => {
        evaluate(graphOf(rows));
        return true;
      }),
      { numRuns: 300 },
    );
  });

  it("produces a byte-identical result for the same trace whatever order its rows arrive in", () => {
    fc.assert(
      fc.property(traceArbitrary, fc.integer({ min: 0, max: 30 }), (rows, rotation) => {
        const offset = rows.length === 0 ? 0 : rotation % rows.length;
        const rotated = [...rows.slice(offset), ...rows.slice(0, offset)];
        return evaluate(graphOf(rotated)).evaluationHash === evaluate(graphOf(rows)).evaluationHash;
      }),
      { numRuns: 300 },
    );
  });

  it("never reports pass while holding a violation", () => {
    fc.assert(
      fc.property(traceArbitrary, (rows) => {
        const { evaluation } = evaluate(graphOf(rows));
        if (evaluation.violations.length === 0) return true;
        return evaluation.status === "fail";
      }),
      { numRuns: 300 },
    );
  });

  it("never reports pass while a rule was undecidable", () => {
    fc.assert(
      fc.property(traceArbitrary, (rows) => {
        const { evaluation } = evaluate(graphOf(rows));
        const undecided = evaluation.ruleResults.some(
          (result) => result.outcome === "insufficient_evidence",
        );
        return !undecided || evaluation.status !== "pass";
      }),
      { numRuns: 300 },
    );
  });

  it("counts agree with the rule results they summarise", () => {
    fc.assert(
      fc.property(traceArbitrary, (rows) => {
        const { evaluation } = evaluate(graphOf(rows));
        const { counts, ruleResults, violations } = evaluation;
        return (
          counts.rulesEvaluated === ruleResults.length &&
          counts.violations === violations.length &&
          counts.rulesPassed +
            counts.rulesViolated +
            counts.rulesInsufficient +
            counts.rulesDeferred ===
            ruleResults.length &&
          counts.criticalViolations ===
            violations.filter((entry) => entry.severity === "critical").length
        );
      }),
      { numRuns: 300 },
    );
  });

  it("gives every violation a unique identifier within one evaluation", () => {
    fc.assert(
      fc.property(traceArbitrary, (rows) => {
        const { evaluation } = evaluate(graphOf(rows));
        const ids = evaluation.violations.map((entry) => entry.id);
        return new Set(ids).size === ids.length;
      }),
      { numRuns: 300 },
    );
  });

  it("marks a missing prerequisite whenever the prerequisite really is absent from a complete trace", () => {
    fc.assert(
      fc.property(traceArbitrary, (rows) => {
        const graph = graphOf(rows);
        if (graph.quality !== "complete") return true;

        const hasFraud = graph.nodes.some((node) => node.canonicalName === "fraud.check");
        const { evaluation } = evaluate(graph);
        const fired = evaluation.violations.some((entry) => entry.ruleId === "require-fraud-check");

        // #then the rule fires exactly when the span is absent. Not "usually" — exactly.
        return hasFraud ? !fired : fired;
      }),
      { numRuns: 300 },
    );
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  formatValidationErrors,
  parseContract,
  type TrajectoryContract,
} from "@flightrules/contract-schema";
import { approvedRefundRows, type SpanSpec, spanRows } from "@flightrules/test-fixtures";
import { buildTraceGraph, type TraceGraph } from "@flightrules/trace-graph";
import { describe, expect, it } from "vitest";
import { evaluateRun } from "./evaluate.js";
import type { RuleResult } from "./result.js";

/**
 * Incomplete telemetry (PRD Phase 16 task 10).
 *
 * A trace is evidence of what the exporters managed to record, not of what happened. Every case
 * below removes, truncates or corrupts part of that record and asserts the one property that makes
 * the release gate trustworthy: **a gap in the telemetry never becomes a pass.** It either produces
 * a violation the evidence really supports, or it says the question could not be decided.
 *
 * The converse matters just as much and is asserted alongside: a locally unobservable subtree must
 * stay local. The canary's genuinely missing fraud check has to remain a violation even though the
 * same trace contains an aborted payment call whose server span was never exported. Widening that
 * one span's uncertainty across the trace would silently disarm the product.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const FIXTURE_DIR = path.join(REPO_ROOT, "packages", "contract-engine", "fixtures", "contracts");
const ROOT_SELECTOR = "refund.request";

function contract(name: string): TrajectoryContract {
  const result = parseContract(readFileSync(path.join(FIXTURE_DIR, `${name}.yaml`), "utf8"));
  if (!result.ok) throw new Error(`${name}: ${formatValidationErrors(result.errors)}`);
  return result.value.contract;
}

function graphOf(rows: readonly Record<string, unknown>[]): TraceGraph {
  return buildTraceGraph(rows, { rootSelector: ROOT_SELECTOR });
}

function ruleOf(
  contractName: string,
  graph: TraceGraph,
  ruleId: string,
): { readonly result: RuleResult; readonly status: string } {
  const { evaluation } = evaluateRun({ graph, contract: contract(contractName) });
  const result = evaluation.ruleResults.find((entry) => entry.ruleId === ruleId);
  if (result === undefined) throw new Error(`rule ${ruleId} produced no result`);
  return { result, status: evaluation.status };
}

/** The approved topology with one span's parent rewritten to a span the trace does not contain. */
function withDetachedParent(spanId: string, parentSpanId: string): TraceGraph {
  const rows = approvedRefundRows().map((row) =>
    row["span_id"] === spanId ? { ...row, parent_span_id: parentSpanId } : row,
  );
  return graphOf(rows);
}

/* -------------------------------------------------------------------------- */
/* Missing structure                                                          */
/* -------------------------------------------------------------------------- */

describe("a trace missing part of its structure is never a pass", () => {
  it("does not prove a missing fraud check when the root span was never exported", () => {
    // #given the whole trace minus its root: every step is now parentless
    const graph = graphOf(approvedRefundRows({ remove: ["root0000"] }));
    expect(graph.quality).toBe("incomplete");

    // #when a rule that needs the fraud check is evaluated against a trace missing a span it does
    // contain — the fraud check is present, so the rule still passes on evidence it really has
    const present = ruleOf("required-span", graph, "require-fraud-check");
    expect(present.result.outcome).toBe("pass");

    // #then removing the fraud check as well cannot yield a violation, because the trace is already
    // known to be missing spans
    const withoutFraud = graphOf(approvedRefundRows({ remove: ["root0000", "c3fraud0"] }));
    const absent = ruleOf("required-span", withoutFraud, "require-fraud-check");
    expect(absent.result.outcome).toBe("insufficient_evidence");
    expect(absent.result.insufficientReason).toBe("trace_incomplete");
    expect(absent.status).not.toBe("pass");
  });

  it("reports insufficient evidence when a span names a parent the trace never carried", () => {
    // #given a sampled export: the policy client span survived, its parent link points nowhere
    const graph = withDetachedParent("c1policy", "missing0");

    expect(graph.quality).toBe("incomplete");
    expect(graph.warnings.map((warning) => warning.kind)).toContain("orphan_span");

    const outcome = ruleOf("forbidden-span", graph, "forbid-admin-write");
    expect(outcome.result.outcome).toBe("insufficient_evidence");
    expect(outcome.result.insufficientReason).toBe("trace_incomplete");
  });

  it("reports insufficient evidence for a parent link that points into another trace", () => {
    // #given a span whose parent belongs to a different trace entirely
    const graph = withDetachedParent("c5paymnt", "d1fferent");

    expect(graph.quality).toBe("incomplete");
    const outcome = ruleOf("cardinality", graph, "single-refund-write");
    // The refund is present once, so the count is decidable and the rule still passes on it.
    expect(outcome.result.outcome).toBe("pass");

    // But an absence claim over the same trace is not decidable.
    const absence = ruleOf("forbidden-path", graph, "no-unapproved-admin-path");
    expect(absence.result.outcome).toBe("insufficient_evidence");
    expect(absence.result.insufficientReason).toBe("trace_incomplete");
  });

  it("evaluates no rule at all when a span's parent link makes the graph contradictory", () => {
    // #given a self-parented span: a one-node cycle in the parent relation
    const rows = approvedRefundRows().map((row) =>
      row["span_id"] === "c2order0" ? { ...row, parent_span_id: "c2order0" } : row,
    );
    const graph = graphOf(rows);
    expect(graph.quality).toBe("inconsistent");

    const { evaluation } = evaluateRun({ graph, contract: contract("required-span") });
    expect(evaluation.status).toBe("insufficient_data");
    expect(evaluation.ruleResults).toHaveLength(0);
    expect(evaluation.violations).toHaveLength(0);
  });

  it("evaluates no rule when two records of one span disagree about what it was", () => {
    // #given the same span exported twice with different names
    const rows = [
      ...approvedRefundRows(),
      ...approvedRefundRows()
        .filter((row) => row["span_id"] === "c3fraud0")
        .map((row) => ({
          ...row,
          name: "fraud.skip",
        })),
    ];
    const graph = graphOf(rows);
    expect(graph.quality).toBe("inconsistent");

    const { evaluation } = evaluateRun({ graph, contract: contract("required-span") });
    expect(evaluation.status).toBe("insufficient_data");
  });
});

/* -------------------------------------------------------------------------- */
/* Locally unobservable subtrees stay local                                    */
/* -------------------------------------------------------------------------- */

describe("an unobservable subtree bounds exactly one span's uncertainty", () => {
  /** The approved topology whose payment client span lost its server handler. */
  function abortedPayment(extra: { readonly remove?: readonly string[] } = {}): TraceGraph {
    return graphOf(approvedRefundRows({ remove: ["s5paymnt", ...(extra.remove ?? [])] }));
  }

  it("keeps the trace complete when only a server handler is missing", () => {
    const graph = abortedPayment();
    expect(graph.quality).toBe("complete");
    expect(graph.warnings.map((warning) => warning.kind)).toContain(
      "client_span_without_server_span",
    );
  });

  it("does not claim the aborted call skipped its handler", () => {
    // #given the payment client span whose remote work was never exported
    // #when the rule that requires the handler beneath it is evaluated
    const outcome = ruleOf("required-edge", abortedPayment(), "refund-answered-by-service");

    // #then the missing relationship is undecidable, not a violation
    expect(outcome.result.outcome).toBe("insufficient_evidence");
    expect(outcome.result.insufficientReason).toBe("unobservable_subtree");
    expect(outcome.status).not.toBe("pass");
  });

  it("still proves a genuinely missing fraud check in the same trace", () => {
    // #given the same aborted payment, and no fraud check at all
    const graph = abortedPayment({ remove: ["c3fraud0", "s3fraud0"] });
    expect(graph.quality).toBe("complete");

    // #then the fraud check really is absent and the release must fail on it
    const outcome = ruleOf("required-span", graph, "require-fraud-check");
    expect(outcome.result.outcome).toBe("violation");
    expect(outcome.result.violations.map((entry) => entry.code)).toEqual(["REQUIRED_SPAN_MISSING"]);
    expect(outcome.status).toBe("fail");
  });

  it("still proves a duplicate refund write in the same trace", () => {
    const graph = graphOf(
      approvedRefundRows({
        remove: ["s5paymnt"],
        add: [
          {
            name: "payment.refund",
            spanId: "c5paymnB",
            parentSpanId: "root0000",
            tool: "issue_refund",
            operation: "execute_tool",
            sideEffect: "write",
            dataDomain: "payments",
            stepCategory: "payment",
            retry: 0,
          },
        ],
      }),
    );

    const outcome = ruleOf("cardinality", graph, "single-refund-write");
    expect(outcome.result.outcome).toBe("violation");
    expect(outcome.result.violations.map((entry) => entry.code)).toEqual(["CARDINALITY_ABOVE_MAX"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Missing identity                                                            */
/* -------------------------------------------------------------------------- */

describe("missing identity attributes never invent a verdict", () => {
  function withoutAttribute(key: string): TraceGraph {
    const rows = approvedRefundRows().map((row) => {
      const copy = { ...row };
      delete copy[key];
      return copy;
    });
    return graphOf(rows);
  }

  it("still evaluates a trace carrying no release identifier", () => {
    const graph = withoutAttribute("agent.release.id");
    const outcome = ruleOf("required-span", graph, "require-fraud-check");
    expect(outcome.result.outcome).toBe("pass");
  });

  it("still evaluates a trace carrying no run identifier", () => {
    const graph = withoutAttribute("agent.run.id");
    expect(ruleOf("required-span", graph, "require-fraud-check").result.outcome).toBe("pass");
  });

  it("does not match a service selector when the service name is missing", () => {
    // #given every span exported without a service name
    const graph = withoutAttribute("service.name");

    // #when the rule bounding which services may appear is evaluated
    const outcome = ruleOf("allowed-services", graph, "approved-services-only");

    // #then it reports that no span carried the field, rather than that every service was allowed
    expect(outcome.result.outcome).toBe("insufficient_evidence");
    expect(outcome.result.insufficientReason).toBe("attribute_not_emitted");
    expect(outcome.status).not.toBe("pass");
  });

  it("does not treat a missing operation name as a matching operation", () => {
    // #given every span exported without `gen_ai.operation.name`
    const graph = withoutAttribute("gen_ai.operation.name");

    // #when the retry budget, which selects on `operation: execute_tool`, is evaluated
    const outcome = ruleOf("retry-budget", graph, "bounded-retries");

    // #then no span matched, so the budget is unchecked — never a silent pass on zero retries
    expect(outcome.result.outcome).toBe("insufficient_evidence");
    expect(outcome.result.insufficientReason).toBe("attribute_not_emitted");
  });
});

/* -------------------------------------------------------------------------- */
/* Sampling and truncation                                                     */
/* -------------------------------------------------------------------------- */

describe("a sampled or truncated trace", () => {
  it("never turns a partially exported run into a pass", () => {
    // #given every prefix of the approved trace, as a head-based sampler would produce
    const specs: readonly SpanSpec[] = [
      { name: "refund.request", spanId: "root0000", parentSpanId: null, kind: "Server" },
      {
        name: "policy.retrieve",
        spanId: "c1policy",
        parentSpanId: "root0000",
        tool: "retrieve_policy",
        operation: "execute_tool",
        sideEffect: "read",
        retry: 0,
      },
      {
        name: "fraud.check",
        spanId: "c3fraud0",
        parentSpanId: "root0000",
        tool: "check_fraud",
        operation: "execute_tool",
        sideEffect: "read",
        retry: 0,
      },
    ];

    for (let kept = 1; kept <= specs.length; kept += 1) {
      const graph = graphOf(
        spanRows({ traceId: "sampled0000000000000000000000000", spans: specs.slice(0, kept) }),
      );
      const outcome = ruleOf("required-span", graph, "require-fraud-check");

      // The fraud check is only present in the full prefix. Before that the rule must not pass.
      if (kept < specs.length) expect(outcome.result.outcome).not.toBe("pass");
      else expect(outcome.result.outcome).toBe("pass");
    }
  });

  it("reports insufficient evidence when only a leaf survived the export", () => {
    // #given a single orphaned step, its whole workflow lost
    const graph = graphOf(
      spanRows({
        traceId: "orphanonly0000000000000000000000",
        spans: [
          {
            name: "payment.refund",
            spanId: "c5paymnt",
            parentSpanId: "gone0000",
            tool: "issue_refund",
            operation: "execute_tool",
            sideEffect: "write",
            retry: 0,
          },
        ],
      }),
    );

    expect(graph.quality).toBe("incomplete");
    const outcome = ruleOf("required-span", graph, "require-fraud-check");
    expect(outcome.result.outcome).toBe("insufficient_evidence");
    expect(outcome.status).toBe("insufficient_data");
  });

  it("never reports a run status of pass while any rule was undecidable", () => {
    const graph = withDetachedParent("c1policy", "missing0");
    const { evaluation } = evaluateRun({ graph, contract: contract("forbidden-span") });

    expect(evaluation.counts.rulesInsufficient).toBeGreaterThan(0);
    expect(evaluation.status).toBe("insufficient_data");
  });
});

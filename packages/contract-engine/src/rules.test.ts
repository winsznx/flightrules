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
import { describe, expect, it } from "vitest";
import { evaluateRun } from "./evaluate.js";
import type { RuleOutcome, RuleResult, ViolationCode } from "./result.js";
import type { ApprovedRoute } from "./rule-context.js";

/**
 * Per-rule evaluation.
 *
 * Every one of the eleven rule types gets a passing trace, a violating trace and an empty- or
 * missing-evidence case. The passing side matters as much as the failing side: a rule that fires on
 * everything catches the canary and blocks every safe release too.
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

interface Outcome {
  readonly outcome: RuleOutcome;
  readonly codes: readonly ViolationCode[];
  readonly reason: string | null;
  readonly result: RuleResult;
}

function evaluate(
  contractName: string,
  graph: TraceGraph,
  ruleId: string,
  approvedRoutes: readonly ApprovedRoute[] = [],
): Outcome {
  const { evaluation } = evaluateRun({ graph, contract: contract(contractName), approvedRoutes });
  const result = evaluation.ruleResults.find((entry) => entry.ruleId === ruleId);
  if (result === undefined) throw new Error(`rule ${ruleId} produced no result`);
  return {
    outcome: result.outcome,
    codes: result.violations.map((violation) => violation.code),
    reason: result.insufficientReason,
    result,
  };
}

/* -------------------------------------------------------------------------- */
/* 1. required_span                                                           */
/* -------------------------------------------------------------------------- */

describe("required_span", () => {
  it("passes when the required span is present exactly once", () => {
    expect(evaluate("required-span", approvedGraph(), "require-fraud-check").outcome).toBe("pass");
  });

  it("violates when the required span is absent from a complete trace", () => {
    const outcome = evaluate("required-span", unsafeGraph(), "require-fraud-check");
    expect(outcome.outcome).toBe("violation");
    expect(outcome.codes).toEqual(["REQUIRED_SPAN_MISSING"]);
  });

  it("violates when the span occurs more often than the maximum", () => {
    // #given a trace with a second fraud check
    const rows = approvedRefundRows({
      add: [
        {
          name: "fraud.check",
          spanId: "c3fraudB",
          parentSpanId: "root0000",
          tool: "check_fraud",
          operation: "execute_tool",
          sideEffect: "read",
          retry: 1,
        },
      ],
    });

    const outcome = evaluate("required-span", graphOf(rows), "require-fraud-check");
    expect(outcome.outcome).toBe("violation");
    expect(outcome.codes).toEqual(["REQUIRED_SPAN_TOO_MANY"]);
  });

  it("reports insufficient evidence rather than a violation when the trace is incomplete", () => {
    // #given a trace whose fraud check is absent *and* which has an orphan, making it incomplete
    const rows = approvedRefundRows({
      remove: ["c3fraud0", "s3fraud0"],
      add: [
        {
          name: "order.enrich",
          spanId: "orphan01",
          parentSpanId: "missing0",
          sideEffect: "read",
        },
      ],
    });
    const graph = graphOf(rows);
    expect(graph.quality).toBe("incomplete");

    // #then the absence is not treated as proof of absence
    const outcome = evaluate("required-span", graph, "require-fraud-check");
    expect(outcome.outcome).toBe("insufficient_evidence");
    expect(outcome.reason).toBe("trace_incomplete");
  });

  it("names the expected label in evidence even when nothing matched", () => {
    const outcome = evaluate("required-span", unsafeGraph(), "require-fraud-check");
    expect(outcome.result.evidence.labels).toEqual(["fraud.check"]);
    expect(outcome.result.evidence.spanIds).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. required_ancestry                                                       */
/* -------------------------------------------------------------------------- */

describe("required_ancestry", () => {
  it("passes when the descendant sits under the required ancestor", () => {
    expect(evaluate("required-ancestry", approvedGraph(), "refund-under-root").outcome).toBe(
      "pass",
    );
  });

  it("passes on the canary too, because both refunds are still under the workflow root", () => {
    expect(evaluate("required-ancestry", unsafeGraph(), "refund-under-root").outcome).toBe("pass");
  });

  it("violates when the descendant occurs outside the required ancestor", () => {
    // #given a refund hanging directly off a second parentless root
    const rows = spanRows({
      traceId: "detached00000000000000000000test",
      spans: [
        {
          name: "refund.request",
          spanId: "root0000",
          parentSpanId: null,
          kind: "Server",
          operation: "invoke_agent",
        },
        { name: "batch.job", spanId: "root0001", parentSpanId: null, kind: "Server" },
        {
          name: "payment.refund",
          spanId: "detached",
          parentSpanId: "root0001",
          tool: "issue_refund",
          operation: "execute_tool",
          sideEffect: "write",
          retry: 0,
          idempotencyPresent: true,
        },
      ],
    });

    const outcome = evaluate("required-ancestry", graphOf(rows), "refund-under-root");
    expect(outcome.outcome).toBe("violation");
    expect(outcome.codes).toEqual(["REQUIRED_ANCESTRY_MISSING"]);
  });

  it("checks a direct relationship as parent, not merely as an ancestor", () => {
    // #given the handler nested one level deeper than the refund call
    const rows = approvedRefundRows({
      replace: [
        {
          name: "payment.refund.handler",
          spanId: "s5paymnt",
          parentSpanId: "s5middle",
          kind: "Server",
          service: "flightrules-payment-service",
          sideEffect: "write",
        },
      ],
      add: [
        {
          name: "payment.middleware",
          spanId: "s5middle",
          parentSpanId: "c5paymnt",
          kind: "Server",
          service: "flightrules-payment-service",
          sideEffect: "write",
        },
      ],
    });

    // #then a direct-relationship rule fails even though the ancestry holds at depth
    expect(
      evaluate("required-ancestry-direct", graphOf(rows), "handler-directly-under-call").outcome,
    ).toBe("violation");
    expect(
      evaluate("required-ancestry-direct", approvedGraph(), "handler-directly-under-call").outcome,
    ).toBe("pass");
  });

  it("passes trivially when no descendant matches, rather than claiming an absence", () => {
    const rows = approvedRefundRows({ remove: ["c5paymnt", "s5paymnt"] });
    expect(evaluate("required-ancestry", graphOf(rows), "refund-under-root").outcome).toBe("pass");
  });

  it("reports insufficient evidence for an orphaned descendant", () => {
    // #given a refund whose parent chain does not reach the root
    const rows = approvedRefundRows({
      replace: [
        {
          name: "payment.refund",
          spanId: "c5paymnt",
          parentSpanId: "vanished",
          tool: "issue_refund",
          operation: "execute_tool",
          sideEffect: "write",
          retry: 0,
          idempotencyPresent: true,
        },
      ],
      remove: ["s5paymnt"],
    });

    const outcome = evaluate("required-ancestry", graphOf(rows), "refund-under-root");
    expect(outcome.outcome).toBe("insufficient_evidence");
    expect(outcome.reason).toBe("trace_incomplete");
  });
});

/* -------------------------------------------------------------------------- */
/* 3. required_edge                                                           */
/* -------------------------------------------------------------------------- */

describe("required_edge", () => {
  it("passes when every refund call is answered by the payment service", () => {
    expect(evaluate("required-edge", approvedGraph(), "refund-answered-by-service").outcome).toBe(
      "pass",
    );
  });

  it("violates when a refund call has no handler and no reason for the gap", () => {
    // #given a refund whose handler is missing, on a span with no unobservable-subtree warning
    const rows = approvedRefundRows({
      remove: ["s5paymnt"],
      replace: [
        {
          name: "payment.refund",
          spanId: "c5paymnt",
          parentSpanId: "root0000",
          kind: "Internal",
          tool: "issue_refund",
          operation: "execute_tool",
          sideEffect: "write",
          retry: 0,
          idempotencyPresent: true,
        },
      ],
    });
    const graph = graphOf(rows);
    expect(graph.warnings.map((warning) => warning.kind)).not.toContain(
      "client_span_without_server_span",
    );

    const outcome = evaluate("required-edge", graph, "refund-answered-by-service");
    expect(outcome.outcome).toBe("violation");
    expect(outcome.codes).toEqual(["REQUIRED_EDGE_MISSING"]);
  });

  it("reports insufficient evidence for the canary's aborted first payment attempt", () => {
    // #given the real unsafe trace. Its first payment attempt timed out, so Fastify never exported a
    // server span for it, and Phase 06 records that as client_span_without_server_span.
    const graph = unsafeGraph();
    expect(graph.warnings.map((warning) => warning.kind)).toContain(
      "client_span_without_server_span",
    );

    // #then the missing handler is *not* a contract violation. The call demonstrably happened; only
    // the evidence of its completion is absent, and treating that as a skipped step would report an
    // aborted request as a policy breach.
    const outcome = evaluate("required-edge", graph, "refund-answered-by-service");
    expect(outcome.outcome).toBe("insufficient_evidence");
    expect(outcome.reason).toBe("unobservable_subtree");
  });

  it("passes trivially when no anchor span exists", () => {
    const rows = approvedRefundRows({ remove: ["c5paymnt", "s5paymnt"] });
    expect(evaluate("required-edge", graphOf(rows), "refund-answered-by-service").outcome).toBe(
      "pass",
    );
  });

  it("reports a violation even when another span of the same rule is undecidable", () => {
    // #given two refund calls: one with an unobservable subtree, one plainly missing its handler
    const rows = approvedRefundRows({
      remove: ["s5paymnt"],
      add: [
        {
          name: "payment.refund",
          spanId: "c5paymntB",
          parentSpanId: "root0000",
          kind: "Internal",
          tool: "issue_refund",
          operation: "execute_tool",
          sideEffect: "write",
          retry: 1,
          idempotencyPresent: true,
        },
      ],
    });

    // #then the proven violation is not softened by the undecidable one
    const outcome = evaluate("required-edge", graphOf(rows), "refund-answered-by-service");
    expect(outcome.outcome).toBe("violation");
  });
});

/* -------------------------------------------------------------------------- */
/* 4. forbidden_span                                                          */
/* -------------------------------------------------------------------------- */

describe("forbidden_span", () => {
  it("passes on both real releases, neither of which touches the admin domain", () => {
    expect(evaluate("forbidden-span", approvedGraph(), "forbid-admin-write").outcome).toBe("pass");
    expect(evaluate("forbidden-span", unsafeGraph(), "forbid-admin-write").outcome).toBe("pass");
  });

  it("violates when a span matches every forbidden attribute", () => {
    const rows = approvedRefundRows({
      add: [
        {
          name: "admin.override",
          spanId: "adminwr1",
          parentSpanId: "root0000",
          sideEffect: "write",
          dataDomain: "admin",
          tool: "override_policy",
          operation: "execute_tool",
          retry: 0,
        },
      ],
    });

    const outcome = evaluate("forbidden-span", graphOf(rows), "forbid-admin-write");
    expect(outcome.outcome).toBe("violation");
    expect(outcome.codes).toEqual(["FORBIDDEN_SPAN_PRESENT"]);
  });

  it("does not fire when only one of the forbidden attributes matches", () => {
    // #given an admin *read*, which the rule does not forbid
    const rows = approvedRefundRows({
      add: [
        {
          name: "admin.inspect",
          spanId: "adminrd1",
          parentSpanId: "root0000",
          sideEffect: "read",
          dataDomain: "admin",
        },
      ],
    });
    expect(evaluate("forbidden-span", graphOf(rows), "forbid-admin-write").outcome).toBe("pass");
  });

  it("reports insufficient evidence when the trace cannot prove the absence", () => {
    const rows = approvedRefundRows({
      add: [
        { name: "order.enrich", spanId: "orphan01", parentSpanId: "missing0", sideEffect: "read" },
      ],
    });
    const outcome = evaluate("forbidden-span", graphOf(rows), "forbid-admin-write");
    expect(outcome.outcome).toBe("insufficient_evidence");
    expect(outcome.reason).toBe("trace_incomplete");
  });
});

/* -------------------------------------------------------------------------- */
/* 5. forbidden_path                                                          */
/* -------------------------------------------------------------------------- */

describe("forbidden_path", () => {
  it("passes on both real releases", () => {
    expect(evaluate("forbidden-path", approvedGraph(), "no-unapproved-admin-path").outcome).toBe(
      "pass",
    );
    expect(evaluate("forbidden-path", unsafeGraph(), "no-unapproved-admin-path").outcome).toBe(
      "pass",
    );
  });

  it("violates when a path reaches the admin domain with no approval step on it", () => {
    const rows = approvedRefundRows({
      add: [
        {
          name: "admin.escalate",
          spanId: "admines1",
          parentSpanId: "root0000",
          sideEffect: "write",
          dataDomain: "admin",
        },
      ],
    });

    const outcome = evaluate("forbidden-path", graphOf(rows), "no-unapproved-admin-path");
    expect(outcome.outcome).toBe("violation");
    expect(outcome.codes).toEqual(["FORBIDDEN_PATH_PRESENT"]);
  });

  it("is exempted when the approval step sits on the path", () => {
    // #given the same admin step, reached through an approval
    const rows = approvedRefundRows({
      add: [
        {
          name: "approval.verify",
          spanId: "approve1",
          parentSpanId: "root0000",
          sideEffect: "read",
          dataDomain: "policy",
        },
        {
          name: "admin.escalate",
          spanId: "admines1",
          parentSpanId: "approve1",
          sideEffect: "write",
          dataDomain: "admin",
        },
      ],
    });

    expect(evaluate("forbidden-path", graphOf(rows), "no-unapproved-admin-path").outcome).toBe(
      "pass",
    );
  });

  it("is not exempted by an approval that is elsewhere in the trace but not on the path", () => {
    // #given an approval as a sibling rather than an ancestor of the admin step
    const rows = approvedRefundRows({
      add: [
        {
          name: "approval.verify",
          spanId: "approve1",
          parentSpanId: "root0000",
          sideEffect: "read",
        },
        {
          name: "admin.escalate",
          spanId: "admines1",
          parentSpanId: "c2order0",
          sideEffect: "write",
          dataDomain: "admin",
        },
      ],
    });

    // #then the rule still fires: "unless the path contains" means the path, not the run
    expect(evaluate("forbidden-path", graphOf(rows), "no-unapproved-admin-path").outcome).toBe(
      "violation",
    );
  });

  it("reports the offending path as evidence", () => {
    const rows = approvedRefundRows({
      add: [
        {
          name: "admin.escalate",
          spanId: "admines1",
          parentSpanId: "c2order0",
          sideEffect: "write",
          dataDomain: "admin",
        },
      ],
    });

    const outcome = evaluate("forbidden-path", graphOf(rows), "no-unapproved-admin-path");
    expect(outcome.result.evidence.labels).toEqual([
      "admin.escalate",
      "order.lookup",
      "refund.request",
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* 6. cardinality                                                             */
/* -------------------------------------------------------------------------- */

describe("cardinality", () => {
  it("passes when the refund is issued exactly once", () => {
    expect(evaluate("cardinality", approvedGraph(), "single-refund-write").outcome).toBe("pass");
  });

  it("violates when the canary issues the refund twice", () => {
    const outcome = evaluate("cardinality", unsafeGraph(), "single-refund-write");
    expect(outcome.outcome).toBe("violation");
    expect(outcome.codes).toEqual(["CARDINALITY_ABOVE_MAX"]);
  });

  it("violates below the minimum", () => {
    const rows = approvedRefundRows({ remove: ["c5paymnt", "s5paymnt"] });
    const outcome = evaluate("cardinality", graphOf(rows), "single-refund-write");
    expect(outcome.outcome).toBe("violation");
    expect(outcome.codes).toEqual(["CARDINALITY_BELOW_MIN"]);
  });

  it("passes at the exact upper boundary", () => {
    // #given exactly the maximum permitted count
    expect(
      evaluate("cardinality", approvedGraph(), "single-refund-write").result.evidence.spanIds,
    ).toHaveLength(1);
  });

  it("scopes duplicates to one run, not to an order identifier", () => {
    // #given two runs that both refund the same order, evaluated separately
    const orderId = "ord-99999";
    const build = (runId: string, traceId: string): TraceGraph =>
      graphOf(
        spanRows({
          traceId,
          runId,
          spans: approvedRefundSpans().map((span) => ({
            ...span,
            attributes: { "agent.order.id": orderId },
          })),
        }),
      );

    // #then neither is a duplicate: the second run is a separate, legitimate trajectory
    expect(
      evaluate(
        "cardinality",
        build("run_a", "traceA00000000000000000000000000"),
        "single-refund-write",
      ).outcome,
    ).toBe("pass");
    expect(
      evaluate(
        "cardinality",
        build("run_b", "traceB00000000000000000000000000"),
        "single-refund-write",
      ).outcome,
    ).toBe("pass");
  });

  it("defers a release-scoped rule instead of deciding it from one run", () => {
    const source = readFileSync(path.join(FIXTURE_DIR, "cardinality.yaml"), "utf8").replace(
      "scope: run",
      "scope: release",
    );
    const parsed = parseContract(source);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const { evaluation } = evaluateRun({ graph: unsafeGraph(), contract: parsed.value.contract });
    expect(evaluation.ruleResults[0]?.outcome).toBe("deferred");
    // #and a deferred rule does not fail the run
    expect(evaluation.status).toBe("pass");
  });
});

/* -------------------------------------------------------------------------- */
/* 7. allowed_values                                                          */
/* -------------------------------------------------------------------------- */

describe("allowed_values", () => {
  it("passes when every tool is on the approved list", () => {
    expect(evaluate("allowed-values", approvedGraph(), "approved-tools-only").outcome).toBe("pass");
    expect(evaluate("allowed-values", unsafeGraph(), "approved-tools-only").outcome).toBe("pass");
  });

  it("violates on an unknown tool", () => {
    const rows = approvedRefundRows({
      add: [
        {
          name: "ledger.adjust",
          spanId: "unknown1",
          parentSpanId: "root0000",
          tool: "adjust_ledger",
          operation: "execute_tool",
          sideEffect: "write",
          retry: 0,
        },
      ],
    });

    const outcome = evaluate("allowed-values", graphOf(rows), "approved-tools-only");
    expect(outcome.outcome).toBe("violation");
    expect(outcome.codes).toEqual(["DISALLOWED_VALUE"]);
  });

  it("reports one violation per distinct disallowed value, not per span", () => {
    const rows = approvedRefundRows({
      add: [
        {
          name: "ledger.adjust",
          spanId: "unknown1",
          parentSpanId: "root0000",
          tool: "adjust_ledger",
          operation: "execute_tool",
          retry: 0,
        },
        {
          name: "ledger.adjust",
          spanId: "unknown2",
          parentSpanId: "root0000",
          tool: "adjust_ledger",
          operation: "execute_tool",
          retry: 1,
        },
        {
          name: "ledger.void",
          spanId: "unknown3",
          parentSpanId: "root0000",
          tool: "void_ledger",
          operation: "execute_tool",
          retry: 0,
        },
      ],
    });

    const outcome = evaluate("allowed-values", graphOf(rows), "approved-tools-only");
    expect(outcome.result.violations).toHaveLength(2);
    expect(outcome.result.violations[0]?.evidence.spanIds).toHaveLength(2);
  });

  it("violates on an unknown service", () => {
    const rows = approvedRefundRows({
      add: [
        {
          name: "audit.write",
          spanId: "svcnew01",
          parentSpanId: "root0000",
          service: "flightrules-audit-service",
          sideEffect: "write",
        },
      ],
    });

    const outcome = evaluate("allowed-services", graphOf(rows), "approved-services-only");
    expect(outcome.outcome).toBe("violation");
    expect(outcome.codes).toEqual(["DISALLOWED_VALUE"]);
  });

  it("reports insufficient evidence when no span carries the field at all", () => {
    // #given a trace with no tool attribute anywhere
    const rows = spanRows({
      traceId: "notools0000000000000000000000000",
      spans: [{ name: "refund.request", spanId: "root0000", parentSpanId: null, kind: "Server" }],
    });

    const outcome = evaluate("allowed-values", graphOf(rows), "approved-tools-only");
    expect(outcome.outcome).toBe("insufficient_evidence");
    expect(outcome.reason).toBe("attribute_not_emitted");
  });

  it("ignores spans that do not carry the field, rather than treating absence as disallowed", () => {
    // #given the approved trace, where the handler spans carry no tool name
    const outcome = evaluate("allowed-values", approvedGraph(), "approved-tools-only");

    // #then only the six tool-bearing spans are in scope
    expect(outcome.outcome).toBe("pass");
    expect(outcome.result.evidence.spanIds).toHaveLength(6);
  });
});

/* -------------------------------------------------------------------------- */
/* 8. attribute_constraint                                                    */
/* -------------------------------------------------------------------------- */

describe("attribute_constraint", () => {
  it("passes when every refund declares an idempotency key", () => {
    expect(
      evaluate("attribute-constraint", approvedGraph(), "refund-must-be-idempotent").outcome,
    ).toBe("pass");
    expect(
      evaluate("attribute-constraint", unsafeGraph(), "refund-must-be-idempotent").outcome,
    ).toBe("pass");
  });

  it("violates when the attribute is present with the wrong value", () => {
    const rows = approvedRefundRows({
      replace: [
        {
          name: "payment.refund",
          spanId: "c5paymnt",
          parentSpanId: "root0000",
          tool: "issue_refund",
          operation: "execute_tool",
          sideEffect: "write",
          retry: 0,
          idempotencyPresent: false,
        },
      ],
    });

    const outcome = evaluate("attribute-constraint", graphOf(rows), "refund-must-be-idempotent");
    expect(outcome.outcome).toBe("violation");
    expect(outcome.codes).toEqual(["ATTRIBUTE_CONSTRAINT_FAILED"]);
  });

  it("reports insufficient evidence when an equality constraint's attribute is absent", () => {
    // #given a refund that never reports whether it was idempotent
    const rows = approvedRefundRows({
      replace: [
        {
          name: "payment.refund",
          spanId: "c5paymnt",
          parentSpanId: "root0000",
          tool: "issue_refund",
          operation: "execute_tool",
          sideEffect: "write",
          retry: 0,
          attributes: { "agent.idempotency.present": null },
        },
      ],
    });

    // #then the constraint is unconfirmed, not satisfied. Defaulting to a pass would let an
    // uninstrumented service satisfy a critical safety rule by saying nothing.
    const outcome = evaluate("attribute-constraint", graphOf(rows), "refund-must-be-idempotent");
    expect(outcome.outcome).toBe("insufficient_evidence");
    expect(outcome.reason).toBe("attribute_not_emitted");
  });

  it("violates when an exists constraint's attribute is absent", () => {
    const rows = approvedRefundRows({
      replace: [
        {
          name: "payment.refund",
          spanId: "c5paymnt",
          parentSpanId: "root0000",
          tool: "issue_refund",
          operation: "execute_tool",
          sideEffect: "write",
          retry: 0,
          attributes: { "agent.data_domain": null },
        },
      ],
    });

    const outcome = evaluate("attribute-exists", graphOf(rows), "refund-declares-domain");
    expect(outcome.outcome).toBe("violation");
    expect(outcome.codes).toEqual(["ATTRIBUTE_CONSTRAINT_FAILED"]);
  });

  it("passes trivially when the selector matches nothing", () => {
    const rows = approvedRefundRows({ remove: ["c5paymnt", "s5paymnt"] });
    expect(
      evaluate("attribute-constraint", graphOf(rows), "refund-must-be-idempotent").outcome,
    ).toBe("pass");
  });

  it("does not coerce a string to a boolean", () => {
    // #given the idempotency flag emitted as the string "true"
    const rows = approvedRefundRows({
      replace: [
        {
          name: "payment.refund",
          spanId: "c5paymnt",
          parentSpanId: "root0000",
          tool: "issue_refund",
          operation: "execute_tool",
          sideEffect: "write",
          retry: 0,
          attributes: { "agent.idempotency.present": "true" },
        },
      ],
    });

    // #then it does not satisfy `equals: true`. A safety rule must not accept a type it did not ask
    // for, because "true" is also what a broken serialiser emits for an unset field.
    expect(
      evaluate("attribute-constraint", graphOf(rows), "refund-must-be-idempotent").outcome,
    ).toBe("violation");
  });
});

/* -------------------------------------------------------------------------- */
/* 9. retry_budget                                                            */
/* -------------------------------------------------------------------------- */

describe("retry_budget", () => {
  it("passes when nothing was retried", () => {
    expect(evaluate("retry-budget", approvedGraph(), "bounded-retries").outcome).toBe("pass");
  });

  it("violates when a side-effecting step is retried", () => {
    const outcome = evaluate("retry-budget", unsafeGraph(), "bounded-retries");
    expect(outcome.outcome).toBe("violation");
    expect(outcome.codes).toEqual(["RETRY_BUDGET_SIDE_EFFECT_EXCEEDED"]);
  });

  it("violates when one tool exceeds its per-tool allowance", () => {
    const rows = approvedRefundRows({
      add: [1, 2, 3].map<SpanSpec>((attempt) => ({
        name: "order.lookup",
        spanId: `c2orderR${attempt}`,
        parentSpanId: "root0000",
        tool: "lookup_order",
        operation: "execute_tool",
        sideEffect: "read",
        retry: attempt,
      })),
    });

    const outcome = evaluate("retry-budget", graphOf(rows), "bounded-retries");
    expect(outcome.codes).toContain("RETRY_BUDGET_PER_TOOL_EXCEEDED");
  });

  it("violates when the run total is exceeded across several tools", () => {
    const rows = approvedRefundRows({
      add: [
        {
          name: "order.lookup",
          spanId: "c2orderR",
          parentSpanId: "root0000",
          tool: "lookup_order",
          operation: "execute_tool",
          sideEffect: "read",
          retry: 2,
        },
        {
          name: "policy.retrieve",
          spanId: "c1policR",
          parentSpanId: "root0000",
          tool: "retrieve_policy",
          operation: "execute_tool",
          sideEffect: "read",
          retry: 2,
        },
        {
          name: "fraud.check",
          spanId: "c3fraudR",
          parentSpanId: "root0000",
          tool: "check_fraud",
          operation: "execute_tool",
          sideEffect: "read",
          retry: 2,
        },
      ],
    });

    const outcome = evaluate("retry-budget", graphOf(rows), "bounded-retries");
    expect(outcome.codes).toContain("RETRY_BUDGET_RUN_TOTAL_EXCEEDED");
  });

  it("passes at the exact per-tool boundary", () => {
    const rows = approvedRefundRows({
      add: [
        {
          name: "order.lookup",
          spanId: "c2orderR",
          parentSpanId: "root0000",
          tool: "lookup_order",
          operation: "execute_tool",
          sideEffect: "read",
          retry: 2,
        },
      ],
    });
    expect(evaluate("retry-budget", graphOf(rows), "bounded-retries").outcome).toBe("pass");
  });

  it("reports insufficient evidence when no span reports a retry number", () => {
    const rows = approvedRefundRows({
      replace: approvedRefundSpans()
        .filter((span) => span.operation === "execute_tool")
        .map((span) => ({ ...span, retry: null })),
    });

    const outcome = evaluate("retry-budget", graphOf(rows), "bounded-retries");
    expect(outcome.outcome).toBe("insufficient_evidence");
    expect(outcome.reason).toBe("attribute_not_emitted");
  });

  it("reports insufficient evidence when a retried span's side effect is unclassified", () => {
    // #given a retried step nobody classified
    const rows = approvedRefundRows({
      add: [
        {
          name: "ledger.sync",
          spanId: "unclass1",
          parentSpanId: "root0000",
          tool: "sync_ledger",
          operation: "execute_tool",
          retry: 1,
          attributes: { "agent.side_effect": null },
        },
      ],
    });

    // #then the side-effect limit cannot be applied to it, and that is said rather than assumed
    const outcome = evaluate("retry-budget", graphOf(rows), "bounded-retries");
    expect(outcome.outcome).toBe("insufficient_evidence");
    expect(outcome.reason).toBe("side_effect_unclassified");
  });

  it("treats a retry number of the wrong type as absent rather than crashing", () => {
    const rows = approvedRefundRows({
      replace: [
        {
          name: "payment.refund",
          spanId: "c5paymnt",
          parentSpanId: "root0000",
          tool: "issue_refund",
          operation: "execute_tool",
          sideEffect: "write",
          idempotencyPresent: true,
          attributes: { "agent.retry.number": { nested: "object" } },
        },
      ],
    });

    expect(() => evaluate("retry-budget", graphOf(rows), "bounded-retries")).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* 10. approved_routes                                                        */
/* -------------------------------------------------------------------------- */

describe("approved_routes", () => {
  it("passes when the route fingerprint is approved", () => {
    expect(
      evaluate("approved-routes", approvedGraph(), "approved-route-family", approvedFamily())
        .outcome,
    ).toBe("pass");
  });

  it("reports the fixture fingerprint is the one the graph engine actually produces", () => {
    // #then the committed fixture cannot drift from the engine
    expect(fingerprintGraph(approvedGraph()).fingerprint).toBe(
      "43070aa4af4f6c2c912a8d7bcc724f1d199e0425dc8ad7256b528eec195cb037",
    );
  });

  it("violates as a materially different route when similarity is below the threshold", () => {
    const outcome = evaluate(
      "approved-routes",
      unsafeGraph(),
      "approved-route-family",
      approvedFamily(),
    );
    expect(outcome.outcome).toBe("violation");
    expect(outcome.codes).toEqual(["ROUTE_NOT_APPROVED"]);
  });

  it("violates as drift when similarity is at or above the threshold", () => {
    // #given the same unapproved route against a lenient drift threshold
    const outcome = evaluate(
      "approved-routes-lenient",
      unsafeGraph(),
      "approved-route-family",
      approvedFamily(),
    );

    // #then it is still a violation — only the classification changes. A similarity score never
    // decides pass or fail.
    expect(outcome.outcome).toBe("violation");
    expect(outcome.codes).toEqual(["ROUTE_DRIFTED"]);
  });

  it("still violates when no approved graph is available to measure similarity against", () => {
    const outcome = evaluate("approved-routes", unsafeGraph(), "approved-route-family", []);
    expect(outcome.outcome).toBe("violation");
    expect(outcome.codes).toEqual(["ROUTE_NOT_APPROVED"]);
    expect(outcome.result.summary).toContain("no approved graph was available");
  });

  it("reports similarity as an exact fraction and a stable decimal", () => {
    const { evaluation } = evaluateRun({
      graph: unsafeGraph(),
      contract: contract("approved-routes"),
      approvedRoutes: approvedFamily(),
    });

    expect(evaluation.similarity.decimal).toMatch(/^0\.\d{6}$/);
    expect(evaluation.similarity.denominator).toBeGreaterThan(0);
    // #and the decimal is the exact fraction rendered, not a floating-point round trip
    const expected = Math.floor(
      (evaluation.similarity.numerator * 1_000_000) / evaluation.similarity.denominator,
    );
    expect(evaluation.similarity.decimal).toBe(
      `0.${String(expected).padStart(6, "0")}`.replace("0.1000000", "1.000000"),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 11. numeric_budget                                                         */
/* -------------------------------------------------------------------------- */

describe("numeric_budget", () => {
  it("passes when the run is inside its latency budget", () => {
    expect(evaluate("run-latency-budget", approvedGraph(), "run-latency-budget").outcome).toBe(
      "pass",
    );
  });

  it("violates when the canary's retry storm blows the latency budget", () => {
    const outcome = evaluate("run-latency-budget", unsafeGraph(), "run-latency-budget");
    expect(outcome.outcome).toBe("violation");
    expect(outcome.codes).toEqual(["NUMERIC_BUDGET_EXCEEDED"]);
  });

  it("reports the measured sample so release aggregation has data", () => {
    const outcome = evaluate("run-latency-budget", unsafeGraph(), "run-latency-budget");
    expect(outcome.result.samples).toHaveLength(1);
    expect(outcome.result.samples[0]?.metric).toBe("run.duration_ms");
    expect(outcome.result.samples[0]?.value).toBeGreaterThan(500);
  });

  it("reports insufficient evidence for a metric this agent never emits", () => {
    // #given a run-scoped token budget and an agent that makes no model call
    for (const graph of [approvedGraph(), unsafeGraph()]) {
      const outcome = evaluate("run-scoped-token-budget", graph, "output-token-budget");

      // #then the budget is unconfirmed, not satisfied
      expect(outcome.outcome).toBe("insufficient_evidence");
      expect(outcome.reason).toBe("metric_not_emitted");
    }
  });

  it("measures and bounds a token budget when the attribute is emitted", () => {
    const rows = approvedRefundRows({
      replace: [
        {
          name: "refund.calculate",
          spanId: "c4calcul",
          parentSpanId: "root0000",
          tool: "calculate_refund",
          operation: "execute_tool",
          attributes: { "gen_ai.usage.output_tokens": 4_000 },
        },
      ],
    });

    const outcome = evaluate("run-scoped-token-budget", graphOf(rows), "output-token-budget");
    expect(outcome.outcome).toBe("violation");
    expect(outcome.codes).toEqual(["NUMERIC_BUDGET_EXCEEDED"]);
  });

  it("sums a token budget across every reporting span", () => {
    const rows = approvedRefundRows({
      replace: [
        {
          name: "refund.calculate",
          spanId: "c4calcul",
          parentSpanId: "root0000",
          tool: "calculate_refund",
          operation: "execute_tool",
          attributes: { "gen_ai.usage.output_tokens": 600 },
        },
        {
          name: "policy.retrieve",
          spanId: "c1policy",
          parentSpanId: "root0000",
          tool: "retrieve_policy",
          operation: "execute_tool",
          sideEffect: "read",
          attributes: { "gen_ai.usage.output_tokens": 500 },
        },
      ],
    });

    const outcome = evaluate("run-scoped-token-budget", graphOf(rows), "output-token-budget");
    expect(outcome.outcome).toBe("pass");
    expect(outcome.result.samples[0]?.value).toBe(1_100);
  });

  it("defers a release-scoped budget while still contributing its sample", () => {
    const outcome = evaluate("release-latency-budget", unsafeGraph(), "release-latency-budget");
    expect(outcome.outcome).toBe("deferred");
    expect(outcome.result.samples).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Selector operators                                                        */
/* -------------------------------------------------------------------------- */

describe("selector operators", () => {
  it("resolves all six operators against the approved trace", () => {
    const { evaluation } = evaluateRun({
      graph: approvedGraph(),
      contract: contract("selector-operators"),
    });

    // #then every operator selected at least one span, so none is silently matching nothing
    expect(evaluation.ruleResults.map((result) => result.outcome)).toEqual(
      Array.from({ length: 6 }, () => "pass"),
    );
  });

  it("selects on a regular expression through namePattern", () => {
    const { evaluation } = evaluateRun({
      graph: approvedGraph(),
      contract: contract("selector-operators"),
    });
    const matched = evaluation.ruleResults.find((result) => result.ruleId === "operator-matches");
    // payment.refund and payment.refund.handler both start with `payment.` but only the first
    // matches `^payment\.[a-z]+$`, because the handler has a second dot.
    expect(matched?.evidence.labels).toEqual(["payment.refund"]);
  });
});

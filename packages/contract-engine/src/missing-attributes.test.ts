import { readFileSync } from "node:fs";
import path from "node:path";
import {
  formatValidationErrors,
  parseContract,
  type TrajectoryContract,
} from "@flightrules/contract-schema";
import { approvedRefundRows } from "@flightrules/test-fixtures";
import { buildTraceGraph, type TraceGraph } from "@flightrules/trace-graph";
import { describe, expect, it } from "vitest";
import { evaluateRun } from "./evaluate.js";
import type { RuleOutcome, RuleResult } from "./result.js";

/**
 * Missing and degenerate attribute values (PRD Phase 16 task 11).
 *
 * Every rule that reads an attribute is put in front of the nine ways a value can fail to be the
 * value the contract expected: absent, explicitly `null`, `false`, `0`, empty string, the wrong
 * type, negative, out of range, and the `null` SL-046 records — a Query Builder column returned as
 * `null` because a non-string tag's `dataType` was omitted.
 *
 * Two properties are asserted throughout, and they pull in opposite directions:
 *
 *   - **Missing never becomes zero or false.** An absent `agent.idempotency.present` may not satisfy
 *     `equals: true` by defaulting, and it may not satisfy `equals: false` either. A trace that says
 *     nothing about idempotency has not demonstrated idempotency.
 *   - **`false` and `0` are real observations, not absences.** A span that reports
 *     `agent.idempotency.present = false` has failed the constraint, and softening that to
 *     "insufficient evidence" would let the canary through.
 *
 * SL-046 is the reason the first property is load-bearing rather than academic: a boolean tag
 * queried without its `dataType` comes back `null` from a call that reports success, so an evaluator
 * that read `null` as `false` — or as a pass — would report a green release built on a query that
 * returned nothing.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const FIXTURE_DIR = path.join(REPO_ROOT, "packages", "contract-engine", "fixtures", "contracts");
const ROOT_SELECTOR = "refund.request";

function contract(name: string): TrajectoryContract {
  const result = parseContract(readFileSync(path.join(FIXTURE_DIR, `${name}.yaml`), "utf8"));
  if (!result.ok) throw new Error(`${name}: ${formatValidationErrors(result.errors)}`);
  return result.value.contract;
}

/** The approved topology with one attribute of one span overridden. `undefined` deletes the key. */
function withAttribute(spanId: string, key: string, value: unknown): TraceGraph {
  const rows = approvedRefundRows().map((row) => {
    if (row["span_id"] !== spanId) return row;
    const copy = { ...row };
    if (value === undefined) delete copy[key];
    else copy[key] = value;
    return copy;
  });
  return buildTraceGraph(rows, { rootSelector: ROOT_SELECTOR });
}

/** The same override applied to every span, for the rules that scan the whole trace. */
function withAttributeEverywhere(key: string, value: unknown): TraceGraph {
  const rows = approvedRefundRows().map((row) => {
    const copy = { ...row };
    if (value === undefined) delete copy[key];
    else copy[key] = value;
    return copy;
  });
  return buildTraceGraph(rows, { rootSelector: ROOT_SELECTOR });
}

interface Outcome {
  readonly outcome: RuleOutcome;
  readonly reason: string | null;
  readonly codes: readonly string[];
  readonly runStatus: string;
  readonly result: RuleResult;
}

function evaluate(contractName: string, graph: TraceGraph, ruleId: string): Outcome {
  const { evaluation } = evaluateRun({ graph, contract: contract(contractName) });
  const result = evaluation.ruleResults.find((entry) => entry.ruleId === ruleId);
  if (result === undefined) throw new Error(`rule ${ruleId} produced no result`);
  return {
    outcome: result.outcome,
    reason: result.insufficientReason,
    codes: result.violations.map((entry) => entry.code),
    runStatus: evaluation.status,
    result,
  };
}

/**
 * The nine degenerate shapes, as data.
 *
 * `undefined` is the absent key. `null` is both the explicit null a producer can emit and the null
 * SL-046 produces from an omitted `dataType` — they are the same wire value and must therefore
 * reach the evaluator identically, which is itself worth asserting.
 */
const ABSENT_SHAPES = [
  { label: "absent", value: undefined },
  { label: "explicitly null", value: null },
  { label: "an empty string", value: "" },
] as const;

/* -------------------------------------------------------------------------- */
/* attribute_constraint                                                       */
/* -------------------------------------------------------------------------- */

describe("attribute_constraint against a degenerate value", () => {
  const RULE = "refund-must-be-idempotent"; // agent.idempotency.present equals true
  const FIELD = "agent.idempotency.present";

  for (const shape of ABSENT_SHAPES) {
    it(`reports insufficient evidence, not a pass, when the field is ${shape.label}`, () => {
      const outcome = evaluate(
        "attribute-constraint",
        withAttribute("c5paymnt", FIELD, shape.value),
        RULE,
      );

      expect(outcome.outcome).toBe("insufficient_evidence");
      expect(outcome.reason).toBe("attribute_not_emitted");
      expect(outcome.runStatus).not.toBe("pass");
    });
  }

  it("treats false as an observed failure rather than as an absence", () => {
    const outcome = evaluate("attribute-constraint", withAttribute("c5paymnt", FIELD, false), RULE);

    expect(outcome.outcome).toBe("violation");
    expect(outcome.codes).toEqual(["ATTRIBUTE_CONSTRAINT_FAILED"]);
    expect(outcome.result.violations[0]?.observed).toBe("false");
  });

  it('does not accept the string "true" for the boolean true', () => {
    const outcome = evaluate(
      "attribute-constraint",
      withAttribute("c5paymnt", FIELD, "true"),
      RULE,
    );

    expect(outcome.outcome).toBe("violation");
    expect(outcome.result.violations[0]?.observed).toBe("true");
  });

  it("does not accept 1 for the boolean true", () => {
    const outcome = evaluate("attribute-constraint", withAttribute("c5paymnt", FIELD, 1), RULE);
    expect(outcome.outcome).toBe("violation");
  });

  it("treats an object-valued attribute as unusable rather than as a match", () => {
    // The normaliser reduces a non-scalar to null rather than stringifying it, so this lands on the
    // absent path — never on a pass.
    const outcome = evaluate(
      "attribute-constraint",
      withAttribute("c5paymnt", FIELD, { present: true }),
      RULE,
    );

    expect(outcome.outcome).toBe("insufficient_evidence");
  });

  it("still passes on the genuine value", () => {
    const outcome = evaluate("attribute-constraint", withAttribute("c5paymnt", FIELD, true), RULE);
    expect(outcome.outcome).toBe("pass");
  });
});

describe("an exists constraint distinguishes absent from empty", () => {
  const RULE = "refund-declares-domain"; // agent.data_domain exists

  for (const shape of ABSENT_SHAPES) {
    it(`violates when the field is ${shape.label}`, () => {
      const outcome = evaluate(
        "attribute-exists",
        withAttribute("c5paymnt", "agent.data_domain", shape.value),
        RULE,
      );

      // `exists` is the one operator for which absence is the violation: the rule asks for the
      // attribute itself, so a missing attribute is exactly the thing it forbids.
      expect(outcome.outcome).toBe("violation");
      expect(outcome.codes).toEqual(["ATTRIBUTE_CONSTRAINT_FAILED"]);
      expect(outcome.result.violations[0]?.observed).toBe("absent");
    });
  }

  it("passes on a present value, including a falsy one", () => {
    expect(
      evaluate("attribute-exists", withAttribute("c5paymnt", "agent.data_domain", "payments"), RULE)
        .outcome,
    ).toBe("pass");
  });
});

/* -------------------------------------------------------------------------- */
/* allowed_values                                                              */
/* -------------------------------------------------------------------------- */

describe("allowed_values against a degenerate value", () => {
  const RULE = "approved-tools-only"; // gen_ai.tool.name within six names

  for (const shape of ABSENT_SHAPES) {
    it(`cannot be checked when no span carries the field (${shape.label})`, () => {
      const outcome = evaluate(
        "allowed-values",
        withAttributeEverywhere("gen_ai.tool.name", shape.value),
        RULE,
      );

      expect(outcome.outcome).toBe("insufficient_evidence");
      expect(outcome.reason).toBe("attribute_not_emitted");
      expect(outcome.runStatus).not.toBe("pass");
    });
  }

  it("does not let one span's missing tool name suppress another span's unknown tool", () => {
    const rows = approvedRefundRows().map((row) => {
      if (row["span_id"] === "c1policy") {
        const copy = { ...row };
        delete copy["gen_ai.tool.name"];
        return copy;
      }
      if (row["span_id"] === "c5paymnt") return { ...row, "gen_ai.tool.name": "wire_transfer" };
      return row;
    });

    const outcome = evaluate(
      "allowed-values",
      buildTraceGraph(rows, { rootSelector: ROOT_SELECTOR }),
      RULE,
    );

    expect(outcome.outcome).toBe("violation");
    expect(outcome.codes).toEqual(["DISALLOWED_VALUE"]);
  });

  it("treats a numeric tool name as a disallowed value rather than as an absence", () => {
    const outcome = evaluate(
      "allowed-values",
      withAttribute("c5paymnt", "gen_ai.tool.name", 0),
      RULE,
    );

    expect(outcome.outcome).toBe("violation");
    expect(outcome.codes).toEqual(["DISALLOWED_VALUE"]);
  });
});

/* -------------------------------------------------------------------------- */
/* retry_budget                                                                */
/* -------------------------------------------------------------------------- */

describe("retry_budget against a degenerate retry number", () => {
  const RULE = "bounded-retries";

  for (const shape of ABSENT_SHAPES) {
    it(`cannot be checked when every retry number is ${shape.label}`, () => {
      const outcome = evaluate(
        "retry-budget",
        withAttributeEverywhere("agent.retry.number", shape.value),
        RULE,
      );

      expect(outcome.outcome).toBe("insufficient_evidence");
      expect(outcome.reason).toBe("attribute_not_emitted");
      expect(outcome.runStatus).not.toBe("pass");
    });
  }

  it("reads zero as a real observation of no retries", () => {
    const outcome = evaluate(
      "retry-budget",
      withAttributeEverywhere("agent.retry.number", 0),
      RULE,
    );
    expect(outcome.outcome).toBe("pass");
    expect(outcome.result.summary).toContain("0 retry/retries");
  });

  it("does not let a negative retry number offset a real overspend", () => {
    // A negative attempt index is not a retry, and it is certainly not a budget saving. The run
    // total here is 9 against a limit of 4; a negative value that were summed in would bring it to
    // 4 and report a clean run.
    const rows = approvedRefundRows().map((row) => {
      if (row["span_id"] === "c1policy") return { ...row, "agent.retry.number": 9 };
      if (row["span_id"] === "c2order0") return { ...row, "agent.retry.number": -5 };
      return row;
    });

    const outcome = evaluate(
      "retry-budget",
      buildTraceGraph(rows, { rootSelector: ROOT_SELECTOR }),
      RULE,
    );

    expect(outcome.outcome).toBe("violation");
    expect(outcome.codes).toContain("RETRY_BUDGET_RUN_TOTAL_EXCEEDED");
  });

  it("does not treat a fractional retry number as an attempt index", () => {
    const outcome = evaluate(
      "retry-budget",
      withAttribute("c1policy", "agent.retry.number", 1.5),
      RULE,
    );

    expect(outcome.outcome).toBe("pass");
  });

  it("reads a numeric string retry count, as SigNoz returns it for a string data type", () => {
    const outcome = evaluate(
      "retry-budget",
      withAttribute("c5paymnt", "agent.retry.number", "3"),
      RULE,
    );

    // The refund is a write. Three retries of it breaches both the per-tool and the side-effect
    // limit — silently discarding the string would have reported a clean run.
    expect(outcome.outcome).toBe("violation");
    expect(outcome.codes).toContain("RETRY_BUDGET_PER_TOOL_EXCEEDED");
    expect(outcome.codes).toContain("RETRY_BUDGET_SIDE_EFFECT_EXCEEDED");
  });

  it("reports insufficient evidence when a retried span's side effect is unclassified", () => {
    const rows = approvedRefundRows().map((row) =>
      row["span_id"] === "c5paymnt"
        ? { ...row, "agent.side_effect": "", "agent.retry.number": 1 }
        : row,
    );

    const outcome = evaluate(
      "retry-budget",
      buildTraceGraph(rows, { rootSelector: ROOT_SELECTOR }),
      RULE,
    );

    expect(outcome.outcome).toBe("insufficient_evidence");
    expect(outcome.reason).toBe("side_effect_unclassified");
  });
});

/* -------------------------------------------------------------------------- */
/* numeric_budget                                                              */
/* -------------------------------------------------------------------------- */

describe("numeric_budget against a degenerate metric", () => {
  const RULE = "output-token-budget"; // sum of gen_ai.usage.output_tokens, max 1200

  it("cannot be checked when no span reports the metric", () => {
    const outcome = evaluate("run-scoped-token-budget", withAttributeEverywhere("x", 1), RULE);

    expect(outcome.outcome).toBe("insufficient_evidence");
    expect(outcome.reason).toBe("metric_not_emitted");
    expect(outcome.runStatus).not.toBe("pass");
  });

  for (const shape of ABSENT_SHAPES) {
    it(`cannot be checked when the metric is ${shape.label}`, () => {
      const outcome = evaluate(
        "run-scoped-token-budget",
        withAttribute("root0000", "gen_ai.usage.output_tokens", shape.value),
        RULE,
      );

      expect(outcome.outcome).toBe("insufficient_evidence");
      expect(outcome.reason).toBe("metric_not_emitted");
    });
  }

  it("reads zero as a measured value rather than as no measurement", () => {
    const outcome = evaluate(
      "run-scoped-token-budget",
      withAttribute("root0000", "gen_ai.usage.output_tokens", 0),
      RULE,
    );

    expect(outcome.outcome).toBe("pass");
    expect(outcome.result.samples[0]?.value).toBe(0);
  });

  it("ignores a non-numeric metric value rather than coercing it", () => {
    const outcome = evaluate(
      "run-scoped-token-budget",
      withAttribute("root0000", "gen_ai.usage.output_tokens", "900"),
      RULE,
    );

    expect(outcome.outcome).toBe("insufficient_evidence");
    expect(outcome.reason).toBe("metric_not_emitted");
  });

  it("violates on an out-of-range value", () => {
    const outcome = evaluate(
      "run-scoped-token-budget",
      withAttribute("root0000", "gen_ai.usage.output_tokens", 5_000),
      RULE,
    );

    expect(outcome.outcome).toBe("violation");
    expect(outcome.codes).toEqual(["NUMERIC_BUDGET_EXCEEDED"]);
  });

  it("does not let a negative sample offset a real overspend", () => {
    const rows = approvedRefundRows().map((row) => {
      if (row["span_id"] === "root0000")
        return { ...row, "gen_ai.usage.output_tokens": Number.MAX_SAFE_INTEGER };
      if (row["span_id"] === "c1policy") return { ...row, "gen_ai.usage.output_tokens": -10 };
      return row;
    });

    const outcome = evaluate(
      "run-scoped-token-budget",
      buildTraceGraph(rows, { rootSelector: ROOT_SELECTOR }),
      RULE,
    );

    expect(outcome.outcome).toBe("violation");
  });
});

/* -------------------------------------------------------------------------- */
/* Structural rules whose selectors read attributes                            */
/* -------------------------------------------------------------------------- */

describe("selector-driven rules against a degenerate selector attribute", () => {
  it("does not treat a span with no data domain as an admin write", () => {
    const graph = withAttributeEverywhere("agent.data_domain", undefined);
    const outcome = evaluate("forbidden-span", graph, "forbid-admin-write");

    expect(outcome.outcome).toBe("pass");
    expect(outcome.codes).toEqual([]);
  });

  it("still catches an admin write when the domain really is admin", () => {
    const rows = approvedRefundRows({
      add: [
        {
          name: "admin.override",
          spanId: "c9admin0",
          parentSpanId: "root0000",
          tool: "override_limit",
          operation: "execute_tool",
          sideEffect: "write",
          dataDomain: "admin",
          retry: 0,
        },
      ],
    });

    const outcome = evaluate(
      "forbidden-span",
      buildTraceGraph(rows, { rootSelector: ROOT_SELECTOR }),
      "forbid-admin-write",
    );

    expect(outcome.outcome).toBe("violation");
    expect(outcome.codes).toEqual(["FORBIDDEN_SPAN_PRESENT"]);
  });

  it("does not match a required span whose name is empty", () => {
    // #given the fraud check exported with an empty name
    const graph = withAttribute("c3fraud0", "name", "");

    // #then the required-span rule cannot find it, and the trace is complete, so it is a violation
    // rather than a silent pass on a span that no longer identifies itself
    const outcome = evaluate("required-span", graph, "require-fraud-check");
    expect(outcome.outcome).toBe("violation");
    expect(outcome.codes).toEqual(["REQUIRED_SPAN_MISSING"]);
  });

  it("keeps a zero-duration root measurable rather than unmeasured", () => {
    const outcome = evaluate(
      "run-latency-budget",
      withAttribute("root0000", "duration_nano", 0),
      "run-latency-budget",
    );

    expect(outcome.outcome).toBe("pass");
    expect(outcome.result.samples[0]?.value).toBe(0);
  });

  it("violates the latency budget on an out-of-range duration", () => {
    const outcome = evaluate(
      "run-latency-budget",
      withAttribute("root0000", "duration_nano", 9_000_000_000),
      "run-latency-budget",
    );

    expect(outcome.outcome).toBe("violation");
    expect(outcome.codes).toEqual(["NUMERIC_BUDGET_EXCEEDED"]);
  });
});

/* -------------------------------------------------------------------------- */
/* The property, stated once                                                   */
/* -------------------------------------------------------------------------- */

describe("no degenerate value produces a passing run it did not earn", () => {
  const CASES: readonly {
    readonly contract: string;
    readonly rule: string;
    readonly field: string;
    readonly span: string;
    readonly everywhere: boolean;
  }[] = [
    {
      contract: "attribute-constraint",
      rule: "refund-must-be-idempotent",
      field: "agent.idempotency.present",
      span: "c5paymnt",
      everywhere: false,
    },
    {
      contract: "allowed-values",
      rule: "approved-tools-only",
      field: "gen_ai.tool.name",
      span: "c5paymnt",
      everywhere: true,
    },
    {
      contract: "retry-budget",
      rule: "bounded-retries",
      field: "agent.retry.number",
      span: "c5paymnt",
      everywhere: true,
    },
    {
      contract: "allowed-services",
      rule: "approved-services-only",
      field: "service.name",
      span: "c5paymnt",
      everywhere: true,
    },
  ];

  for (const testCase of CASES) {
    for (const shape of ABSENT_SHAPES) {
      it(`${testCase.rule} does not pass when ${testCase.field} is ${shape.label}`, () => {
        const graph = testCase.everywhere
          ? withAttributeEverywhere(testCase.field, shape.value)
          : withAttribute(testCase.span, testCase.field, shape.value);

        const outcome = evaluate(testCase.contract, graph, testCase.rule);
        expect(outcome.outcome).not.toBe("pass");
        expect(outcome.runStatus).not.toBe("pass");
      });
    }
  }

  it("an absent value and a Query Builder null from an omitted dataType are indistinguishable", () => {
    // SL-046: a boolean tag requested without its `dataType` comes back as `null` from a call that
    // reports success. That must reach the evaluator as the same absence as a deleted key, or the
    // two failure modes would need two different sets of rules to be safe against.
    const deleted = evaluate(
      "attribute-constraint",
      withAttribute("c5paymnt", "agent.idempotency.present", undefined),
      "refund-must-be-idempotent",
    );
    const nulled = evaluate(
      "attribute-constraint",
      withAttribute("c5paymnt", "agent.idempotency.present", null),
      "refund-must-be-idempotent",
    );

    expect(nulled.outcome).toBe(deleted.outcome);
    expect(nulled.reason).toBe(deleted.reason);
    expect(nulled.result.summary).toBe(deleted.result.summary);
  });
});

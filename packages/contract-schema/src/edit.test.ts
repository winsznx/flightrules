import { describe, expect, it } from "vitest";
import {
  applyRuleControl,
  controlRuleId,
  controlStateOf,
  DATA_DOMAIN_FIELD,
  RULE_CONTROLS,
  type RuleControlRequest,
  SIDE_EFFECT_FIELD,
} from "./edit.js";
import { parseContract } from "./parse.js";

/**
 * The graph rule controls of PRD section 8.9, as transformations of one document.
 *
 * These tests are the whole safety argument for the Contract Studio's bidirectional editing: a
 * control produces a document the Phase 07 validator accepts, the same control applied twice
 * produces the same document, and the state the studio renders is read back out of the document
 * rather than remembered beside it.
 */

const BASE = `apiVersion: flightrules.dev/v1alpha1
kind: TrajectoryContract
metadata:
  id: studio-fixture
  name: Studio fixture
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
    rootSpan: refund.request
  approvedRoutes: []
  rules:
    - id: require-fraud-check
      type: required_span
      selector:
        name: fraud.check
      cardinality:
        min: 1
        max: 1
      severity: critical
  gate:
    minCompletedRuns: 1
    evaluationTimeoutSeconds: 60
    maxViolationPercent: 0
    maxUnknownRoutePercent: 0
    maxLatencyRegressionPercent: 10
    maxTokenRegressionPercent: 10
    zeroToleranceRuleIds: [require-fraud-check]
`;

/** Applies a control and fails the test with the validator's own message if it was refused. */
function apply(source: string, request: RuleControlRequest): { yaml: string; ruleId: string } {
  const result = applyRuleControl(source, request);
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  return { yaml: result.yaml, ruleId: result.ruleId };
}

describe("applyRuleControl", () => {
  it("produces a document the contract validator accepts, for every control", () => {
    // #given one request per PRD section 8.9 control, each with the arguments that control needs
    const requests: Record<string, RuleControlRequest> = {
      required: { control: "required", node: "policy.retrieve" },
      optional: { control: "optional", node: "fraud.check" },
      forbidden: { control: "forbidden", node: "debug.dump" },
      maximum_calls: { control: "maximum_calls", node: "payment.refund", limit: 1 },
      must_precede: {
        control: "must_precede",
        node: "payment.refund",
        other: "payment.refund.handler",
      },
      must_descend_from: {
        control: "must_descend_from",
        node: "fraud.check",
        other: "refund.request",
      },
      side_effect: { control: "side_effect", node: "payment.refund", value: "write" },
      sensitive_data_domain: {
        control: "sensitive_data_domain",
        node: "payment.refund",
        value: "payment",
      },
    };

    // #then every one of the eight is covered, and every result validates
    expect(Object.keys(requests).sort()).toEqual([...RULE_CONTROLS].sort());
    for (const request of Object.values(requests)) {
      const result = applyRuleControl(BASE, request);
      expect(result.ok, `${request.control} was refused`).toBe(true);
      if (!result.ok) continue;
      expect(parseContract(result.yaml).ok).toBe(true);
    }
  });

  it("maps `required` to a required_span rule on the named node", () => {
    // #when a node is marked required
    const { yaml } = apply(BASE, { control: "required", node: "policy.retrieve" });

    // #then the contract carries a required_span rule selecting exactly that canonical name
    const parsed = parseContract(yaml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const rule = parsed.value.contract.spec.rules.find(
      (entry) => entry.type === "required_span" && entry.selector.name === "policy.retrieve",
    );
    expect(rule).toBeDefined();
  });

  it("maps `maximum_calls` to a run-scoped cardinality bound", () => {
    // #when a node is capped at one call per run
    const { yaml } = apply(BASE, { control: "maximum_calls", node: "payment.refund", limit: 1 });

    // #then the bound is the cardinality rule the evaluator already understands
    const parsed = parseContract(yaml);
    if (!parsed.ok) throw new Error("the edited document did not validate");
    const rule = parsed.value.contract.spec.rules.find((entry) => entry.type === "cardinality");
    expect(rule).toMatchObject({ type: "cardinality", min: 0, max: 1, scope: "run" });
  });

  it("maps the two classification controls onto the PRD's own attribute names", () => {
    // #when both classification controls are applied
    const withSideEffect = apply(BASE, {
      control: "side_effect",
      node: "payment.refund",
      value: "write",
    }).yaml;
    const withBoth = apply(withSideEffect, {
      control: "sensitive_data_domain",
      node: "payment.refund",
      value: "payment",
    }).yaml;

    // #then they constrain `agent.side_effect` and `agent.data_domain`, PRD section 17.2's names
    const parsed = parseContract(withBoth);
    if (!parsed.ok) throw new Error("the edited document did not validate");
    const fields = parsed.value.contract.spec.rules
      .filter((entry) => entry.type === "attribute_constraint")
      .map((entry) => entry.field)
      .sort();
    expect(fields).toEqual([DATA_DOMAIN_FIELD, SIDE_EFFECT_FIELD].sort());
  });

  it("is idempotent: the same control applied twice yields the same document", () => {
    // #given a control applied once
    const once = apply(BASE, { control: "forbidden", node: "debug.dump" }).yaml;

    // #when it is applied again, as a double-clicked button would
    const twice = apply(once, { control: "forbidden", node: "debug.dump" }).yaml;

    // #then the document is unchanged, so a duplicate submission cannot duplicate a rule
    expect(twice).toBe(once);
    const parsed = parseContract(twice);
    if (!parsed.ok) throw new Error("the edited document did not validate");
    expect(
      parsed.value.contract.spec.rules.filter((r) => r.type === "forbidden_span"),
    ).toHaveLength(1);
  });

  it("makes `optional` the exact inverse of `required`", () => {
    // #given a node made required
    const required = apply(BASE, { control: "required", node: "policy.retrieve" }).yaml;
    expect(controlStateOf(required, "policy.retrieve").map((s) => s.control)).toContain("required");

    // #when the same node is marked optional
    const optional = apply(required, { control: "optional", node: "policy.retrieve" }).yaml;

    // #then nothing requires it any more
    expect(controlStateOf(optional, "policy.retrieve")).toHaveLength(0);
  });

  it("leaves an already-optional node's document byte-identical", () => {
    // #when a node nothing requires is marked optional
    const result = applyRuleControl(BASE, { control: "optional", node: "never.required" });

    // #then the content hash does not churn, so a repeated click writes no new version
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.effect).toBe("unchanged");
    expect(result.yaml).toBe(BASE);
  });

  it("preserves the comments the miner wrote", () => {
    // #given a document carrying an evidence-basis comment, as every mined contract does
    const commented = BASE.replace(
      "  rules:\n",
      "  rules:\n    #  basis  required_step (fraud.check in 34 of 34 runs)\n",
    );

    // #when a control edits a different part of the document
    const { yaml } = apply(commented, { control: "forbidden", node: "debug.dump" });

    // #then the reviewer's evidence is still there
    expect(yaml).toContain("basis  required_step");
  });

  it("refuses a relational control with no counterpart rather than guessing one", () => {
    // #when `must_precede` is applied without the node that must follow
    const result = applyRuleControl(BASE, { control: "must_precede", node: "payment.refund" });

    // #then it is refused with a typed code, and nothing is written
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CONTROL_ARGUMENT_MISSING");
  });

  it("refuses a non-integer call limit", () => {
    // #when a fractional maximum is submitted
    const result = applyRuleControl(BASE, {
      control: "maximum_calls",
      node: "payment.refund",
      limit: 1.5,
    });

    // #then the control refuses rather than rounding
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CONTROL_ARGUMENT_INVALID");
  });

  it("refuses to edit a document that does not load safely", () => {
    // #given a document using a YAML alias, which SL-047 records the loader rejects outright
    const aliased = `${BASE}\nanchored: &a 1\nalias: *a\n`;

    // #when a control is applied
    const result = applyRuleControl(aliased, { control: "forbidden", node: "debug.dump" });

    // #then it is refused, and the loader's own errors are carried for the studio to render
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DOCUMENT_UNREADABLE");
  });

  it("refuses a control that would contradict a rule already in the document", () => {
    // #given a node the fixture already requires
    // #when the reviewer also forbids it
    const result = applyRuleControl(BASE, { control: "forbidden", node: "fraud.check" });

    // #then the edit is refused with the validator's own CONTRADICTORY_RULES finding, so a button
    // cannot put the contract into a state approval would have to reject
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("EDITED_DOCUMENT_INVALID");
    expect(result.error.errors?.map((error) => error.code)).toContain("CONTRADICTORY_RULES");
  });

  it("refuses a document with no spec.rules sequence", () => {
    // #given a document whose shape FlightRules did not write
    const shapeless = "apiVersion: flightrules.dev/v1alpha1\nkind: TrajectoryContract\nspec: {}\n";

    // #when a control is applied
    const result = applyRuleControl(shapeless, { control: "forbidden", node: "x" });

    // #then it reports the shape rather than throwing
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DOCUMENT_SHAPE_UNEXPECTED");
  });

  it("escapes a hostile canonical name instead of letting it change the document", () => {
    // #given a node name carrying YAML metacharacters and a prototype-pollution key
    const hostile = "__proto__: {a: 1}\n#injected";

    // #when it is used as a control's subject
    const result = applyRuleControl(BASE, { control: "forbidden", node: hostile });

    // #then whatever the outcome, the document that results is still a valid contract with the
    // rule count the edit implies — the name was data, never structure
    if (result.ok) {
      const parsed = parseContract(result.yaml);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.contract.spec.rules).toHaveLength(2);
    } else {
      expect(result.error.code).toBe("EDITED_DOCUMENT_INVALID");
    }
  });
});

describe("controlRuleId", () => {
  it("is stable for the same control and arguments", () => {
    const request: RuleControlRequest = { control: "required", node: "fraud.check" };
    expect(controlRuleId(request)).toBe(controlRuleId({ ...request }));
  });

  it("distinguishes two nodes under the same control", () => {
    expect(controlRuleId({ control: "required", node: "a.b" })).not.toBe(
      controlRuleId({ control: "required", node: "a.c" }),
    );
  });

  it("produces an identifier the validator accepts", () => {
    // #then a generated id matches the DSL's identifier grammar
    const id = controlRuleId({ control: "must_descend_from", node: "Payment.Refund" });
    expect(id).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
    expect(id.length).toBeLessThanOrEqual(128);
  });
});

describe("controlStateOf", () => {
  it("reads control state back out of the document, not out of memory", () => {
    // #given the fixture's own required_span rule, which no control created
    const state = controlStateOf(BASE, "fraud.check");

    // #then the studio still shows the node as required, so a hand-written YAML edit is reflected
    expect(state.map((entry) => entry.control)).toEqual(["required"]);
    expect(state[0]?.ruleId).toBe("require-fraud-check");
  });

  it("returns nothing for a document that does not validate", () => {
    expect(controlStateOf("not: a contract", "fraud.check")).toEqual([]);
  });

  it("orders controls by the PRD's own list", () => {
    // #given a node carrying two controls added in reverse PRD order
    const withSideEffect = apply(BASE, {
      control: "side_effect",
      node: "x.y",
      value: "write",
    }).yaml;
    const both = apply(withSideEffect, { control: "required", node: "x.y" }).yaml;

    // #then they render in PRD section 8.9's order regardless of insertion order
    expect(controlStateOf(both, "x.y").map((entry) => entry.control)).toEqual([
      "required",
      "side_effect",
    ]);
  });
});

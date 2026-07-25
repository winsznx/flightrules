import type { TrajectoryContract } from "@flightrules/contract-schema";
import { describe, expect, it } from "vitest";
import type { Violation } from "./result.js";
import { countDuplicateSideEffects, sideEffectingRuleIds } from "./side-effects.js";

/**
 * Classifying a duplicate side effect (FR-014 panel 5, FR-015, PRD section 17.4).
 *
 * `flight_rules.duplicate_side_effects` was declared in Phase 04 and never recorded, so the panel
 * and the alert that read it would both have been empty. These tests fix the definition in place.
 */

function contract(rules: unknown[]): TrajectoryContract {
  return {
    apiVersion: "flightrules.dev/v1",
    kind: "TrajectoryContract",
    metadata: {
      name: "test",
      version: "0.1.0",
      agent: "refund-agent",
      environment: "local",
      createdAt: "2026-07-25T00:00:00Z",
    },
    spec: { selectors: {}, approvedRoutes: [], rules, gate: {} },
  } as unknown as TrajectoryContract;
}

function violation(overrides: Partial<Violation>): Violation {
  return {
    id: "v1",
    ruleId: "rule",
    ruleType: "cardinality",
    code: "CARDINALITY_ABOVE_MAX",
    severity: "critical",
    zeroTolerance: true,
    summary: "",
    expected: "",
    observed: "",
    evidence: { spanIds: [], canonicalNodes: [], labels: [] },
    ...overrides,
  } as Violation;
}

const WRITE_RULE = {
  id: "single-payment-refund",
  type: "cardinality",
  severity: "critical",
  selector: {
    name: "payment.refund",
    attributes: [{ key: "agent.side_effect", operator: "equals", value: "write" }],
  },
  min: 0,
  max: 1,
  scope: "run",
};

const READ_RULE = {
  id: "single-order-lookup",
  type: "cardinality",
  severity: "medium",
  selector: {
    name: "order.lookup",
    attributes: [{ key: "agent.side_effect", operator: "equals", value: "read" }],
  },
  min: 0,
  max: 1,
  scope: "run",
};

describe("sideEffectingRuleIds", () => {
  it("selects a rule pinned to a write or an external call", () => {
    const ids = sideEffectingRuleIds(contract([WRITE_RULE]));
    expect([...ids]).toEqual(["single-payment-refund"]);
  });

  it("accepts an `in` list containing a side-effecting value", () => {
    const ids = sideEffectingRuleIds(
      contract([
        {
          ...WRITE_RULE,
          selector: {
            name: "x",
            attributes: [{ key: "agent.side_effect", operator: "in", value: ["read", "external"] }],
          },
        },
      ]),
    );
    expect(ids.size).toBe(1);
  });

  it("ignores a read-only rule — repeating a read is wasteful, not unsafe", () => {
    expect(sideEffectingRuleIds(contract([READ_RULE])).size).toBe(0);
  });

  it("ignores a rule that only asserts the attribute exists or differs", () => {
    for (const operator of ["exists", "not_equals", "contains"]) {
      const ids = sideEffectingRuleIds(
        contract([
          {
            ...WRITE_RULE,
            selector: {
              name: "x",
              attributes: [{ key: "agent.side_effect", operator, value: "write" }],
            },
          },
        ]),
      );
      expect(ids.size).toBe(0);
    }
  });

  it("ignores a rule with no selector and a rule selecting a different attribute", () => {
    expect(
      sideEffectingRuleIds(
        contract([
          { id: "routes", type: "approved_routes", severity: "critical", fingerprints: [] },
          {
            ...WRITE_RULE,
            id: "other",
            selector: {
              name: "x",
              attributes: [{ key: "agent.data_domain", operator: "equals", value: "write" }],
            },
          },
        ]),
      ).size,
    ).toBe(0);
  });
});

describe("countDuplicateSideEffects", () => {
  const ids = sideEffectingRuleIds(contract([WRITE_RULE, READ_RULE]));

  it("counts an over-cardinality violation against a side-effecting rule", () => {
    expect(countDuplicateSideEffects(ids, [violation({ ruleId: "single-payment-refund" })])).toBe(
      1,
    );
  });

  it("counts a too-many-required-spans violation the same way", () => {
    expect(
      countDuplicateSideEffects(ids, [
        violation({ ruleId: "single-payment-refund", code: "REQUIRED_SPAN_TOO_MANY" }),
      ]),
    ).toBe(1);
  });

  it("does not count a missing span, which is the opposite finding", () => {
    expect(
      countDuplicateSideEffects(ids, [
        violation({ ruleId: "single-payment-refund", code: "CARDINALITY_BELOW_MIN" }),
        violation({ ruleId: "single-payment-refund", code: "REQUIRED_SPAN_MISSING" }),
      ]),
    ).toBe(0);
  });

  it("does not count a duplicated read", () => {
    expect(countDuplicateSideEffects(ids, [violation({ ruleId: "single-order-lookup" })])).toBe(0);
  });

  it("does not count a violation against an unknown rule", () => {
    expect(countDuplicateSideEffects(ids, [violation({ ruleId: "not-in-contract" })])).toBe(0);
  });

  it("counts each duplicated side effect once", () => {
    expect(
      countDuplicateSideEffects(ids, [
        violation({ id: "a", ruleId: "single-payment-refund" }),
        violation({ id: "b", ruleId: "single-payment-refund", code: "REQUIRED_SPAN_TOO_MANY" }),
        violation({ id: "c", ruleId: "single-order-lookup" }),
      ]),
    ).toBe(2);
  });

  it("returns zero for a run with no violations", () => {
    expect(countDuplicateSideEffects(ids, [])).toBe(0);
  });
});

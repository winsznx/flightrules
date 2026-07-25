import type { ContractRule, Selector, TrajectoryContract } from "@flightrules/contract-schema";
import { SIDE_EFFECT_ATTRIBUTE, SIDE_EFFECTING_VALUES } from "@flightrules/domain";
import type { Violation, ViolationCode } from "./result.js";

/**
 * Classifying a duplicate side effect.
 *
 * PRD FR-014 requires a duplicate-side-effect panel and FR-015 an alert on the same signal, and
 * PRD section 17.4 declares `flight_rules.duplicate_side_effects` for it. Neither can be honest
 * unless "duplicate side effect" has a single deterministic definition, so it lives here beside the
 * evaluator that produces the violations rather than in the worker that reports them.
 *
 * The definition is entirely structural. A rule is side-effecting when its selector constrains
 * `agent.side_effect` to a value that writes or leaves the system — the same attribute the baseline
 * miner uses to propose a `side_effect_cardinality` bound. A violation is a duplicate when it says
 * the observed count exceeded the permitted maximum. Nothing here inspects prose, and no model is
 * consulted.
 */

/** Codes that mean "this occurred more times than the contract permits". */
const DUPLICATION_CODES: ReadonlySet<ViolationCode> = new Set<ViolationCode>([
  "CARDINALITY_ABOVE_MAX",
  "REQUIRED_SPAN_TOO_MANY",
]);

const SIDE_EFFECTING: ReadonlySet<string> = new Set(SIDE_EFFECTING_VALUES);

function selectorIsSideEffecting(selector: Selector | undefined): boolean {
  if (!selector?.attributes) return false;
  return selector.attributes.some((condition) => {
    if (condition.key !== SIDE_EFFECT_ATTRIBUTE) return false;
    switch (condition.operator) {
      case "equals":
        return typeof condition.value === "string" && SIDE_EFFECTING.has(condition.value);
      case "in":
        return (
          Array.isArray(condition.value) &&
          condition.value.some((value) => typeof value === "string" && SIDE_EFFECTING.has(value))
        );
      default:
        // `not_equals`, `exists` and the pattern operators do not pin the rule to a side effect,
        // so a violation against them is not evidence of a duplicated write.
        return false;
    }
  });
}

function ruleSelector(rule: ContractRule): Selector | undefined {
  return "selector" in rule ? rule.selector : undefined;
}

/**
 * The rule identifiers whose violations count as duplicate side effects.
 *
 * Returned as a set rather than recomputed per violation because a release evaluation walks every
 * violation of every run against one contract.
 */
export function sideEffectingRuleIds(contract: TrajectoryContract): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const rule of contract.spec.rules) {
    if (selectorIsSideEffecting(ruleSelector(rule))) ids.add(rule.id);
  }
  return ids;
}

/** Counts the violations in one run that report a side-effecting step happening too often. */
export function countDuplicateSideEffects(
  sideEffectingRules: ReadonlySet<string>,
  violations: readonly Violation[],
): number {
  let count = 0;
  for (const violation of violations) {
    if (DUPLICATION_CODES.has(violation.code) && sideEffectingRules.has(violation.ruleId)) {
      count += 1;
    }
  }
  return count;
}

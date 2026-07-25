import type {
  AllowedValuesRule,
  ApprovedRoutesRule,
  AttributeConstraintRule,
  NumericBudgetRule,
  RetryBudgetRule,
  ScalarValue,
} from "@flightrules/contract-schema";
import type { SafeAttributeValue } from "@flightrules/normaliser";
import { describeSelector, evidenceFor, violation } from "./evidence.js";
import type { MetricSample, RuleResult, Violation } from "./result.js";
import {
  atLeastThreshold,
  deferred,
  EXACT_SIMILARITY,
  insufficient,
  passed,
  type RuleContext,
  violated,
} from "./rule-context.js";
import { scalarKey } from "./selector.js";

/**
 * Value, budget and route rules.
 *
 * These are the rules that read attributes rather than structure, which makes "the attribute is not
 * there" their central problem. The evaluator never treats a missing attribute as a satisfied
 * constraint: it either proves the constraint holds, proves it fails, or says it cannot tell.
 */

export function evaluateAllowedValues(rule: AllowedValuesRule, context: RuleContext): RuleResult {
  const candidates =
    rule.selector === undefined ? context.index.spanIds : context.select(rule.selector);
  const allowed = new Set(rule.values.map(scalarKey));

  const carrying: string[] = [];
  const offendersByValue = new Map<string, string[]>();

  for (const spanId of candidates) {
    const node = context.index.node(spanId);
    if (node === undefined) continue;
    const actual = context.index.attribute(node, rule.field);
    // A span that does not carry the field is out of scope. The rule bounds which values may appear,
    // not which spans must carry the attribute; `required_span` and `attribute_constraint` do that.
    if (actual === undefined) continue;
    carrying.push(spanId);

    for (const value of Array.isArray(actual) ? actual : [actual]) {
      const key = scalarKey(value as ScalarValue);
      if (allowed.has(key)) continue;
      const existing = offendersByValue.get(key);
      if (existing === undefined) offendersByValue.set(key, [spanId]);
      else existing.push(spanId);
    }
  }

  if (carrying.length === 0) {
    return insufficient(
      rule,
      "attribute_not_emitted",
      `No span in this trace carries ${rule.field}, so the permitted values cannot be checked.`,
    );
  }

  if (offendersByValue.size === 0) {
    return passed(
      rule,
      `All ${carrying.length} value(s) of ${rule.field} are among the ${rule.values.length} permitted.`,
      evidenceFor(carrying, context.index),
    );
  }

  const violations: Violation[] = [];
  const offending: string[] = [];

  // Sorted so the violation list does not depend on map insertion order.
  for (const key of [...offendersByValue.keys()].sort()) {
    const spanIds = offendersByValue.get(key) as string[];
    offending.push(...spanIds);
    const evidence = evidenceFor(spanIds, context.index);
    const rendered = key.slice(key.indexOf(":") + 1);
    violations.push(
      violation({
        ruleId: rule.id,
        ruleType: rule.type,
        code: "DISALLOWED_VALUE",
        severity: rule.severity,
        zeroTolerance: context.isZeroTolerance(rule.id),
        summary: `${rule.field} took the value "${rendered}", which the contract does not permit.`,
        expected: `one of: ${rule.values.map(String).join(", ")}`,
        observed: rendered,
        evidence,
        discriminator: key,
      }),
    );
  }

  return violated(
    rule,
    `${offendersByValue.size} value(s) of ${rule.field} are not permitted.`,
    violations,
    evidenceFor(offending, context.index),
  );
}

/**
 * Attribute constraint (PRD section 10.4).
 *
 * Absence is handled per operator, because "must equal true" and "must not equal admin" make
 * opposite claims about a span that does not carry the attribute:
 *
 * - `exists` — absent is a **violation**; the rule asks for the attribute itself.
 * - `equals`, `in`, `matches` — absent is **insufficient evidence**; the required value is
 *   unconfirmed, and nothing observed contradicts it either.
 * - `not_equals`, `not_in` — absent is a **pass**; the span demonstrably does not carry the
 *   forbidden value.
 *
 * Defaulting absence to a pass across the board would let an uninstrumented service satisfy
 * `refund-must-be-idempotent`, and defaulting it to a violation would punish a release for a
 * telemetry gap.
 */
export function evaluateAttributeConstraint(
  rule: AttributeConstraintRule,
  context: RuleContext,
): RuleResult {
  const matches = context.select(rule.selector);
  const description = describeSelector(rule.selector);

  if (matches.length === 0) {
    return passed(rule, `No span matched ${description}, so the constraint applies to nothing.`);
  }

  const violations: Violation[] = [];
  const unconfirmed: string[] = [];
  const satisfied: string[] = [];

  // The constraint is expressed as a selector carrying exactly one attribute condition, so the six
  // operators have a single implementation shared with selector matching. A second copy here would
  // let `matches` mean one thing in a selector and another in a constraint.
  const asCondition = context.compile({
    attributes: [
      {
        key: rule.field,
        operator: rule.operator,
        ...(rule.value === undefined ? {} : { value: rule.value }),
      },
    ],
  });

  for (const spanId of matches) {
    const node = context.index.node(spanId);
    if (node === undefined) continue;
    const actual = context.index.attribute(node, rule.field);

    if (actual === undefined) {
      if (rule.operator === "not_equals" || rule.operator === "not_in") {
        satisfied.push(spanId);
        continue;
      }
      if (rule.operator === "exists") {
        violations.push(constraintViolation(rule, context, spanId, "absent"));
        continue;
      }
      unconfirmed.push(spanId);
      continue;
    }

    if (asCondition.matchesNode(node, context.index)) {
      satisfied.push(spanId);
      continue;
    }
    violations.push(constraintViolation(rule, context, spanId, renderValue(actual)));
  }

  if (violations.length > 0) {
    return violated(
      rule,
      `${violations.length} of ${matches.length} span(s) matching ${description} fail the constraint on ${rule.field}.`,
      violations,
      evidenceFor(matches, context.index),
    );
  }

  if (unconfirmed.length > 0) {
    return insufficient(
      rule,
      "attribute_not_emitted",
      `${unconfirmed.length} of ${matches.length} span(s) matching ${description} do not carry ${rule.field}, so the constraint cannot be confirmed.`,
      evidenceFor(unconfirmed, context.index),
    );
  }

  return passed(
    rule,
    `All ${satisfied.length} span(s) matching ${description} satisfy the constraint on ${rule.field}.`,
    evidenceFor(satisfied, context.index),
  );
}

function constraintViolation(
  rule: AttributeConstraintRule,
  context: RuleContext,
  spanId: string,
  observed: string,
): Violation {
  const evidence = evidenceFor([spanId], context.index);
  const expected =
    rule.operator === "exists"
      ? `${rule.field} to be present`
      : `${rule.field} ${rule.operator.replace("_", " ")} ${renderExpected(rule.value)}`;

  return violation({
    ruleId: rule.id,
    ruleType: rule.type,
    code: "ATTRIBUTE_CONSTRAINT_FAILED",
    severity: rule.severity,
    zeroTolerance: context.isZeroTolerance(rule.id),
    summary: `${describeSelector(rule.selector)} requires ${expected}, but observed ${observed}.`,
    expected,
    observed,
    evidence,
    discriminator: String(context.index.canonicalOrderOf(spanId) ?? spanId),
  });
}

function renderValue(value: SafeAttributeValue): string {
  if (Array.isArray(value)) return `[${value.map(String).join(", ")}]`;
  return String(value);
}

function renderExpected(value: ScalarValue | readonly ScalarValue[] | undefined): string {
  if (value === undefined) return "a value";
  return Array.isArray(value) ? `one of [${value.map(String).join(", ")}]` : String(value);
}

/**
 * Retry budget (PRD section 10.4).
 *
 * Retries are counted as the highest `agent.retry.number` observed, because the attribute is a
 * zero-based attempt index: attempt 1 is the first retry. Counting spans instead would report a
 * single attempt as one retry.
 *
 * A span whose side effect is `unclassified` and which was retried produces insufficient evidence
 * rather than a pass. `sideEffectMax: 0` exists to stop a payment being retried, and a span nobody
 * classified might be exactly that payment.
 */
export function evaluateRetryBudget(rule: RetryBudgetRule, context: RuleContext): RuleResult {
  const matches = context.select(rule.selector);
  const description = describeSelector(rule.selector);

  const retriesByGroup = new Map<
    string,
    { readonly retries: number; readonly spanIds: string[] }
  >();
  const sideEffecting = new Map<string, { readonly retries: number; readonly spanIds: string[] }>();
  const unclassified: string[] = [];
  let anyRetryEvidence = false;

  for (const spanId of matches) {
    const node = context.index.node(spanId);
    if (node === undefined || node.retryNumber === null) continue;
    anyRetryEvidence = true;

    const group = node.toolName ?? node.canonicalName;
    record(retriesByGroup, group, node.retryNumber, spanId);

    if (node.sideEffect === "write" || node.sideEffect === "external") {
      record(sideEffecting, group, node.retryNumber, spanId);
    } else if (node.sideEffect === "unknown" && node.retryNumber > rule.sideEffectMax) {
      unclassified.push(spanId);
    }
  }

  if (!anyRetryEvidence) {
    return insufficient(
      rule,
      "attribute_not_emitted",
      `No span matching ${description} carries a retry number, so the retry budget cannot be checked.`,
    );
  }

  const violations: Violation[] = [];
  const offending: string[] = [];

  for (const group of [...retriesByGroup.keys()].sort()) {
    const entry = retriesByGroup.get(group) as { retries: number; spanIds: string[] };
    if (entry.retries <= rule.maxPerTool) continue;
    offending.push(...entry.spanIds);
    violations.push(
      violation({
        ruleId: rule.id,
        ruleType: rule.type,
        code: "RETRY_BUDGET_PER_TOOL_EXCEEDED",
        severity: rule.severity,
        zeroTolerance: context.isZeroTolerance(rule.id),
        summary: `${group} was retried ${entry.retries} time(s); at most ${rule.maxPerTool} are permitted per tool.`,
        expected: `at most ${rule.maxPerTool} retries of ${group}`,
        observed: String(entry.retries),
        evidence: evidenceFor(entry.spanIds, context.index),
        discriminator: group,
      }),
    );
  }

  let runTotal = 0;
  for (const entry of retriesByGroup.values()) runTotal += entry.retries;
  if (runTotal > rule.maxRunTotal) {
    const allSpans = [...retriesByGroup.values()].flatMap((entry) => entry.spanIds);
    offending.push(...allSpans);
    violations.push(
      violation({
        ruleId: rule.id,
        ruleType: rule.type,
        code: "RETRY_BUDGET_RUN_TOTAL_EXCEEDED",
        severity: rule.severity,
        zeroTolerance: context.isZeroTolerance(rule.id),
        summary: `This run performed ${runTotal} retries; at most ${rule.maxRunTotal} are permitted.`,
        expected: `at most ${rule.maxRunTotal} retries per run`,
        observed: String(runTotal),
        evidence: evidenceFor(allSpans, context.index),
      }),
    );
  }

  for (const group of [...sideEffecting.keys()].sort()) {
    const entry = sideEffecting.get(group) as { retries: number; spanIds: string[] };
    if (entry.retries <= rule.sideEffectMax) continue;
    offending.push(...entry.spanIds);
    violations.push(
      violation({
        ruleId: rule.id,
        ruleType: rule.type,
        code: "RETRY_BUDGET_SIDE_EFFECT_EXCEEDED",
        severity: rule.severity,
        zeroTolerance: context.isZeroTolerance(rule.id),
        summary: `The side-effecting step ${group} was retried ${entry.retries} time(s); at most ${rule.sideEffectMax} are permitted.`,
        expected: `at most ${rule.sideEffectMax} retries of a side-effecting step`,
        observed: String(entry.retries),
        evidence: evidenceFor(entry.spanIds, context.index),
        discriminator: `side-effect:${group}`,
      }),
    );
  }

  if (violations.length > 0) {
    return violated(
      rule,
      `The retry budget for ${description} was exceeded in ${violations.length} way(s).`,
      violations,
      evidenceFor(offending, context.index),
    );
  }

  if (unclassified.length > 0) {
    return insufficient(
      rule,
      "side_effect_unclassified",
      `${unclassified.length} retried span(s) matching ${description} have an unclassified side effect, so the side-effect retry limit cannot be applied to them.`,
      evidenceFor(unclassified, context.index),
    );
  }

  return passed(
    rule,
    `${runTotal} retry/retries across ${retriesByGroup.size} step(s), within the budget.`,
    evidenceFor(matches, context.index),
  );
}

function record(
  into: Map<string, { readonly retries: number; readonly spanIds: string[] }>,
  group: string,
  retryNumber: number,
  spanId: string,
): void {
  const existing = into.get(group);
  if (existing === undefined) {
    into.set(group, { retries: retryNumber, spanIds: [spanId] });
    return;
  }
  existing.spanIds.push(spanId);
  if (retryNumber > existing.retries) {
    into.set(group, { retries: retryNumber, spanIds: existing.spanIds });
  }
}

/**
 * Approved routes (PRD section 10.4).
 *
 * A run passes only on an **exact** fingerprint match. `minSimilarity` does not soften that: it
 * classifies the failure, distinguishing a drifted member of a known family from a materially
 * different route. Letting a similarity score decide pass or fail would put a fuzzy threshold on the
 * critical path, which is exactly what the determinism boundary excludes — and the comparison it does
 * make is an exact integer cross-multiplication, never a floating-point test.
 */
export function evaluateApprovedRoutes(rule: ApprovedRoutesRule, context: RuleContext): RuleResult {
  const approved = new Set(rule.fingerprints);

  if (approved.has(context.routeFingerprint)) {
    return passed(
      rule,
      `The route fingerprint matches an approved family (similarity ${EXACT_SIMILARITY.decimal}).`,
    );
  }

  const { score, nearest } = context.similarityTo(rule.fingerprints);
  const drifted =
    nearest !== null && atLeastThreshold(score.numerator, score.denominator, rule.minSimilarity);

  const summary =
    nearest === null
      ? `The route fingerprint matches none of the ${rule.fingerprints.length} approved family/families, and no approved graph was available to measure similarity against.`
      : `The route fingerprint matches none of the ${rule.fingerprints.length} approved family/families. Nearest similarity ${score.decimal} against ${nearest}.`;

  return violated(
    rule,
    summary,
    [
      violation({
        ruleId: rule.id,
        ruleType: rule.type,
        code: drifted ? "ROUTE_DRIFTED" : "ROUTE_NOT_APPROVED",
        severity: rule.severity,
        zeroTolerance: context.isZeroTolerance(rule.id),
        summary: drifted
          ? `The route drifted within a known family: similarity ${score.decimal} is at or above the ${rule.minSimilarity.text} threshold, but the fingerprint is not approved.`
          : `The route is not approved and is materially different: similarity ${score.decimal} is below the ${rule.minSimilarity.text} threshold.`,
        expected: `one of ${rule.fingerprints.length} approved route fingerprint(s)`,
        observed: context.routeFingerprint,
        evidence: { spanIds: [], canonicalNodes: [], labels: [] },
      }),
    ],
    { spanIds: [], canonicalNodes: [], labels: [] },
  );
}

const NANOS_PER_MILLISECOND = 1_000_000n;

/**
 * Numeric budget (PRD section 10.4).
 *
 * Release-scoped budgets are deferred: PRD section 11.11 evaluates them after run results are
 * stored, which is Phase 11. The run still measures and reports its sample, so the aggregation has
 * data to work with rather than needing to re-read every trace.
 */
export function evaluateNumericBudget(rule: NumericBudgetRule, context: RuleContext): RuleResult {
  const samples = measure(rule, context);

  if (rule.scope === "release") {
    return deferred(
      rule,
      `Release-scoped ${rule.aggregation} of ${rule.metric} is aggregated across runs; this run contributed ${samples.length} sample(s).`,
      samples,
    );
  }

  if (samples.length === 0) {
    return insufficient(
      rule,
      "metric_not_emitted",
      `No span in this trace reports ${rule.metric}, so the budget cannot be checked.`,
      { spanIds: [], canonicalNodes: [], labels: [] },
      samples,
    );
  }

  // Only `sum` and `max` reach here; validation rejects a percentile at run scope, because a
  // percentile over one observation is that observation and reads as a stronger claim than it is.
  const value =
    rule.aggregation === "max"
      ? samples.reduce((best, sample) => (sample.value > best ? sample.value : best), 0)
      : samples.reduce((total, sample) => total + sample.value, 0);

  const spanIds = samples.flatMap((sample) => sample.spanIds);
  const evidence = evidenceFor(spanIds, context.index);

  if (value > rule.max) {
    return violated(
      rule,
      `${rule.aggregation} of ${rule.metric} was ${value}, over the budget of ${rule.max}.`,
      [
        violation({
          ruleId: rule.id,
          ruleType: rule.type,
          code: "NUMERIC_BUDGET_EXCEEDED",
          severity: rule.severity,
          zeroTolerance: context.isZeroTolerance(rule.id),
          summary: `${rule.metric} (${rule.aggregation}) was ${value}, exceeding the budget of ${rule.max}.`,
          expected: `at most ${rule.max}`,
          observed: String(value),
          evidence,
        }),
      ],
      evidence,
      samples,
    );
  }

  return passed(
    rule,
    `${rule.aggregation} of ${rule.metric} was ${value}, within the budget of ${rule.max}.`,
    evidence,
    samples,
  );
}

/**
 * Measures a budget metric from the graph.
 *
 * Duration comes from the root span in integer milliseconds, computed by BigInt division so the
 * result does not depend on floating-point rounding of a nanosecond count. Token counts are summed
 * from the spans that report them; a trace where nothing reports them produces no samples, which the
 * caller turns into insufficient evidence rather than a pass.
 */
function measure(rule: NumericBudgetRule, context: RuleContext): readonly MetricSample[] {
  if (rule.metric === "run.duration_ms") {
    const root = context.index.node(context.index.rootSpanId);
    if (root === undefined) return [];
    return [
      {
        metric: rule.metric,
        value: Number(root.durationNano / NANOS_PER_MILLISECOND),
        spanIds: [root.spanId],
      },
    ];
  }

  let total = 0;
  const spanIds: string[] = [];
  for (const spanId of context.index.spanIds) {
    const node = context.index.node(spanId);
    if (node === undefined) continue;
    const value = context.index.attribute(node, rule.metric);
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    total += Math.trunc(value);
    spanIds.push(spanId);
  }

  return spanIds.length === 0
    ? []
    : [{ metric: rule.metric, value: total, spanIds: [...spanIds].sort() }];
}

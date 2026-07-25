import type {
  CardinalityRule,
  ForbiddenPathRule,
  ForbiddenSpanRule,
  RequiredAncestryRule,
  RequiredEdgeRule,
  RequiredSpanRule,
} from "@flightrules/contract-schema";
import { absentEvidence, describeSelector, evidenceFor, violation } from "./evidence.js";
import type { GraphIndex } from "./graph-index.js";
import type { RuleResult, Violation } from "./result.js";
import { combine, insufficient, passed, type RuleContext, violated } from "./rule-context.js";

/**
 * Structural rules: presence, absence, cardinality, ancestry and paths.
 *
 * Every one of these decides something about what the trace does **not** contain, which is where the
 * insufficient-evidence rules earn their keep. An absence claim is only sound over a complete trace,
 * and locally unsound beneath a span whose remote work was never exported.
 */

export function evaluateRequiredSpan(rule: RequiredSpanRule, context: RuleContext): RuleResult {
  const matches = context.select(rule.selector);
  const count = matches.length;
  const { min, max } = rule.cardinality;
  const description = describeSelector(rule.selector);

  if (count >= min && count <= max) {
    return passed(
      rule,
      `Found ${count} span(s) matching ${description}, within the required ${min}..${max}.`,
      evidenceFor(matches, context.index),
    );
  }

  if (count > max) {
    return violated(
      rule,
      `Found ${count} span(s) matching ${description}; at most ${max} are permitted.`,
      [
        violation({
          ruleId: rule.id,
          ruleType: rule.type,
          code: "REQUIRED_SPAN_TOO_MANY",
          severity: rule.severity,
          zeroTolerance: context.isZeroTolerance(rule.id),
          summary: `${description} occurred ${count} times; the contract permits at most ${max}.`,
          expected: `at most ${max}`,
          observed: String(count),
          evidence: evidenceFor(matches, context.index),
        }),
      ],
      evidenceFor(matches, context.index),
    );
  }

  // Below the minimum. Whether that is a violation depends on whether this trace can prove absence.
  const evidence =
    count === 0 ? absentEvidence(labelsOf(rule)) : evidenceFor(matches, context.index);

  if (!context.absenceDecidable) {
    return insufficient(
      rule,
      "trace_incomplete",
      `Found ${count} span(s) matching ${description}, fewer than the required ${min}, but the trace is ${context.index.graph.quality} so their absence is not proven.`,
      evidence,
    );
  }

  return violated(
    rule,
    `Found ${count} span(s) matching ${description}; at least ${min} are required.`,
    [
      violation({
        ruleId: rule.id,
        ruleType: rule.type,
        code: "REQUIRED_SPAN_MISSING",
        severity: rule.severity,
        zeroTolerance: context.isZeroTolerance(rule.id),
        summary: `${description} is required at least ${min} time(s) but occurred ${count} time(s).`,
        expected: `at least ${min}`,
        observed: String(count),
        evidence,
      }),
    ],
    evidence,
  );
}

export function evaluateCardinality(rule: CardinalityRule, context: RuleContext): RuleResult {
  if (rule.scope === "release") {
    return {
      ruleId: rule.id,
      ruleType: rule.type,
      severity: rule.severity,
      outcome: "deferred",
      insufficientReason: null,
      summary: "Release-scoped cardinality is aggregated across runs, not decided from one run.",
      evidence: evidenceFor(context.select(rule.selector), context.index),
      violations: [],
      samples: [],
    };
  }

  const matches = context.select(rule.selector);
  const count = matches.length;
  const description = describeSelector(rule.selector);
  const evidence =
    count === 0 ? absentEvidence(labelsOf(rule)) : evidenceFor(matches, context.index);

  if (count > rule.max) {
    return violated(
      rule,
      `${description} occurred ${count} times in this run; at most ${rule.max} are permitted.`,
      [
        violation({
          ruleId: rule.id,
          ruleType: rule.type,
          code: "CARDINALITY_ABOVE_MAX",
          severity: rule.severity,
          zeroTolerance: context.isZeroTolerance(rule.id),
          summary: `${description} occurred ${count} times; the contract permits at most ${rule.max} per run.`,
          expected: `at most ${rule.max} per run`,
          observed: String(count),
          evidence,
        }),
      ],
      evidence,
    );
  }

  if (count < rule.min) {
    if (!context.absenceDecidable) {
      return insufficient(
        rule,
        "trace_incomplete",
        `${description} occurred ${count} times, below the required ${rule.min}, but the trace is ${context.index.graph.quality}.`,
        evidence,
      );
    }
    return violated(
      rule,
      `${description} occurred ${count} times in this run; at least ${rule.min} are required.`,
      [
        violation({
          ruleId: rule.id,
          ruleType: rule.type,
          code: "CARDINALITY_BELOW_MIN",
          severity: rule.severity,
          zeroTolerance: context.isZeroTolerance(rule.id),
          summary: `${description} occurred ${count} times; the contract requires at least ${rule.min} per run.`,
          expected: `at least ${rule.min} per run`,
          observed: String(count),
          evidence,
        }),
      ],
      evidence,
    );
  }

  return passed(
    rule,
    `${description} occurred ${count} time(s), within the permitted ${rule.min}..${rule.max}.`,
    evidence,
  );
}

export function evaluateForbiddenSpan(rule: ForbiddenSpanRule, context: RuleContext): RuleResult {
  const matches = context.select(rule.selector);
  const description = describeSelector(rule.selector);

  if (matches.length > 0) {
    const evidence = evidenceFor(matches, context.index);
    return violated(
      rule,
      `${matches.length} span(s) matched the forbidden selector ${description}.`,
      [
        violation({
          ruleId: rule.id,
          ruleType: rule.type,
          code: "FORBIDDEN_SPAN_PRESENT",
          severity: rule.severity,
          zeroTolerance: context.isZeroTolerance(rule.id),
          summary: `${description} is forbidden but occurred ${matches.length} time(s).`,
          expected: "no matching span",
          observed: `${matches.length} matching span(s)`,
          evidence,
        }),
      ],
      evidence,
    );
  }

  // Nothing matched. Over an incomplete trace that is not proof: the forbidden span may be one of
  // the spans that were never exported.
  if (!context.absenceDecidable) {
    return insufficient(
      rule,
      "trace_incomplete",
      `No span matched the forbidden selector ${description}, but the trace is ${context.index.graph.quality} so its absence is not proven.`,
    );
  }

  return passed(rule, `No span matched the forbidden selector ${description}.`);
}

export function evaluateRequiredEdge(rule: RequiredEdgeRule, context: RuleContext): RuleResult {
  const fromSpans = context.select(rule.from);
  const toSpans = context.select(rule.to);
  const fromDescription = describeSelector(rule.from);
  const toDescription = describeSelector(rule.to);

  if (fromSpans.length === 0) {
    // Nothing anchors the rule, so it holds trivially. This is not an absence claim about the `to`
    // span: the contract only requires the relationship where the `from` span exists.
    return passed(
      rule,
      `No span matched ${fromDescription}, so this relationship is not required.`,
    );
  }

  const satisfiedBy = satisfyingAnchors(rule.relationship, fromSpans, toSpans, context.index);
  const violations: Violation[] = [];
  const undecidable: string[] = [];

  for (const fromSpan of fromSpans) {
    if (satisfiedBy.has(fromSpan)) continue;

    // The decisive local check. A client span whose server span was never exported has an
    // unobservable subtree, so the required child may well have happened. Reporting a violation here
    // would mean an aborted request looked like a skipped step.
    if (context.index.hasUnobservableSubtree(fromSpan)) {
      undecidable.push(fromSpan);
      continue;
    }

    const evidence = evidenceFor([fromSpan], context.index);
    violations.push(
      violation({
        ruleId: rule.id,
        ruleType: rule.type,
        code: "REQUIRED_EDGE_MISSING",
        severity: rule.severity,
        zeroTolerance: context.isZeroTolerance(rule.id),
        summary: `${fromDescription} has no ${rule.relationship === "direct" ? "direct child" : "descendant"} matching ${toDescription}.`,
        expected: `${toDescription} beneath ${fromDescription}`,
        observed: "no such relationship",
        evidence,
        discriminator: String(context.index.canonicalOrderOf(fromSpan) ?? fromSpan),
      }),
    );
  }

  return combine(rule, {
    violations,
    undecidable,
    undecidableReason: "unobservable_subtree",
    evidence: evidenceFor([...fromSpans], context.index),
    violationSummary: `${violations.length} of ${fromSpans.length} span(s) matching ${fromDescription} lack a required ${toDescription}.`,
    undecidableSummary: `${undecidable.length} of ${fromSpans.length} span(s) matching ${fromDescription} lack a ${toDescription}, but their remote work was never exported so the relationship cannot be decided.`,
    passSummary: `Every one of the ${fromSpans.length} span(s) matching ${fromDescription} has a ${toDescription} beneath it.`,
  });
}

export function evaluateRequiredAncestry(
  rule: RequiredAncestryRule,
  context: RuleContext,
): RuleResult {
  const descendants = context.select(rule.descendant);
  const ancestors = new Set(context.select(rule.ancestor));
  const ancestorDescription = describeSelector(rule.ancestor);
  const descendantDescription = describeSelector(rule.descendant);

  if (descendants.length === 0) {
    return passed(rule, `No span matched ${descendantDescription}, so no ancestry is required.`);
  }

  const violations: Violation[] = [];
  const undecidable: string[] = [];

  for (const descendant of descendants) {
    const path = context.index.pathFromRoot(descendant);
    const chain = rule.relationship === "direct" ? path.slice(-2, -1) : path.slice(0, -1);
    const found = chain.find((spanId) => ancestors.has(spanId));

    if (found !== undefined) continue;

    // Undecidable only when the chain was *truncated*, not merely when it ends somewhere other than
    // the chosen root. A chain whose topmost span names a parent the trace never exported has
    // unknown ancestry, so a missing required ancestor proves nothing. A chain that ends at a
    // genuinely parentless span has known ancestry — a step running under a second root in the same
    // trace really did run outside the required workflow, and reporting that as insufficient
    // evidence would let a detached side effect escape the rule entirely.
    const top = path[0];
    if (top !== undefined && context.index.isOrphan(top)) {
      undecidable.push(descendant);
      continue;
    }

    const evidence = evidenceFor([descendant], context.index);
    violations.push(
      violation({
        ruleId: rule.id,
        ruleType: rule.type,
        code: "REQUIRED_ANCESTRY_MISSING",
        severity: rule.severity,
        zeroTolerance: context.isZeroTolerance(rule.id),
        summary: `${descendantDescription} occurred without ${ancestorDescription} as ${rule.relationship === "direct" ? "its parent" : "an ancestor"}.`,
        expected: `${ancestorDescription} above ${descendantDescription}`,
        observed: "no such ancestor on the path to the root",
        evidence,
        discriminator: String(context.index.canonicalOrderOf(descendant) ?? descendant),
      }),
    );
  }

  return combine(rule, {
    violations,
    undecidable,
    undecidableReason: "trace_incomplete",
    evidence: evidenceFor([...descendants], context.index),
    violationSummary: `${violations.length} of ${descendants.length} span(s) matching ${descendantDescription} lack the required ancestor ${ancestorDescription}.`,
    undecidableSummary: `${undecidable.length} of ${descendants.length} span(s) matching ${descendantDescription} are orphaned, so their ancestry cannot be decided.`,
    passSummary: `Every one of the ${descendants.length} span(s) matching ${descendantDescription} has ${ancestorDescription} above it.`,
  });
}

/**
 * Forbidden path (PRD section 10.4).
 *
 * Walks up from each `to` span rather than down from each `from` span. The `unless` clause needs the
 * spans **on** the path, not merely the fact that one reaches the other, and the parent chain is the
 * path — so this reads it directly and costs one walk per `to` span rather than a subtree traversal
 * per `from` span.
 */
export function evaluateForbiddenPath(rule: ForbiddenPathRule, context: RuleContext): RuleResult {
  const fromSpans = new Set(context.select(rule.from));
  const toSpans = context.select(rule.to);
  const exempting =
    rule.unless === undefined ? null : new Set(context.select(rule.unless.contains));
  const fromDescription = describeSelector(rule.from);
  const toDescription = describeSelector(rule.to);

  const violations: Violation[] = [];
  const offending: string[] = [];

  for (const toSpan of toSpans) {
    const path = context.index.pathFromRoot(toSpan);

    // The nearest matching `from` on the path. Nearest rather than outermost, so the reported path
    // is the shortest one that actually violates the rule.
    let start = -1;
    for (let index = path.length - 2; index >= 0; index -= 1) {
      if (fromSpans.has(path[index] as string)) {
        start = index;
        break;
      }
    }
    if (start === -1) continue;

    const segment = path.slice(start);
    if (exempting !== null && segment.some((spanId) => exempting.has(spanId))) continue;

    const evidence = evidenceFor(segment, context.index);
    offending.push(...segment);
    violations.push(
      violation({
        ruleId: rule.id,
        ruleType: rule.type,
        code: "FORBIDDEN_PATH_PRESENT",
        severity: rule.severity,
        zeroTolerance: context.isZeroTolerance(rule.id),
        summary:
          `A path of ${segment.length} span(s) runs from ${fromDescription} to ${toDescription}` +
          (rule.unless === undefined
            ? "."
            : ` without ${describeSelector(rule.unless.contains)} on it.`),
        expected:
          rule.unless === undefined
            ? `no path from ${fromDescription} to ${toDescription}`
            : `${describeSelector(rule.unless.contains)} on any such path`,
        observed: `${segment.length}-span path with no exempting step`,
        evidence,
        discriminator: String(context.index.canonicalOrderOf(toSpan) ?? toSpan),
      }),
    );
  }

  if (violations.length > 0) {
    return violated(
      rule,
      `${violations.length} forbidden path(s) from ${fromDescription} to ${toDescription}.`,
      violations,
      evidenceFor(offending, context.index),
    );
  }

  if (!context.absenceDecidable) {
    return insufficient(
      rule,
      "trace_incomplete",
      `No forbidden path from ${fromDescription} to ${toDescription} was observed, but the trace is ${context.index.graph.quality} so its absence is not proven.`,
    );
  }

  return passed(rule, `No forbidden path from ${fromDescription} to ${toDescription}.`);
}

/**
 * The `from` spans that satisfy the relationship.
 *
 * For `direct`, a `to` span's parent. For `any_depth`, every `from` span on a `to` span's path to the
 * root. One walk per `to` span, so the cost is bounded by the number of targets times the depth
 * rather than by the graph size squared — no descendant closure is materialised, because for a deep
 * trace that closure is quadratic in memory.
 */
function satisfyingAnchors(
  relationship: "direct" | "any_depth",
  fromSpans: readonly string[],
  toSpans: readonly string[],
  index: GraphIndex,
): ReadonlySet<string> {
  const anchors = new Set(fromSpans);
  const satisfied = new Set<string>();

  for (const toSpan of toSpans) {
    if (relationship === "direct") {
      const parent = index.parentOf(toSpan);
      if (parent !== null && anchors.has(parent)) satisfied.add(parent);
      continue;
    }
    for (const spanId of index.pathFromRoot(toSpan).slice(0, -1)) {
      if (anchors.has(spanId)) satisfied.add(spanId);
    }
  }

  return satisfied;
}

/** Canonical labels a selector names, for evidence when nothing matched. */
function labelsOf(rule: RequiredSpanRule | CardinalityRule): readonly string[] {
  return rule.selector.name === undefined ? [] : [rule.selector.name];
}

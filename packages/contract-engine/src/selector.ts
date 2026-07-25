import {
  type AttributeCondition,
  type CompiledPattern,
  compilePattern,
  matchPattern,
  type ScalarValue,
  type Selector,
} from "@flightrules/contract-schema";
import type { SafeAttributeValue } from "@flightrules/normaliser";
import type { TraceNode } from "@flightrules/trace-graph";
import type { GraphIndex } from "./graph-index.js";

/**
 * Selector evaluation (PRD section 10.3).
 *
 * Two properties matter here.
 *
 * A selector is compiled once per evaluation, not once per span. A contract with fifteen rules over
 * a 10,000-span trace would otherwise recompile the same pattern 150,000 times.
 *
 * And a selector resolves through the index where it can. `name: payment.refund` becomes a map
 * lookup returning two spans rather than a scan of ten thousand, which is what keeps the evaluator
 * linear in the number of *matches* rather than in the size of the trace for the common case.
 */

/** A selector prepared for repeated matching. */
export class CompiledSelector {
  readonly source: Selector;
  readonly #namePattern: CompiledPattern | null;
  readonly #conditions: readonly CompiledCondition[];

  constructor(selector: Selector) {
    this.source = selector;

    if (selector.namePattern === undefined) {
      this.#namePattern = null;
    } else {
      const compiled = compilePattern(selector.namePattern);
      // Validation already rejected an uncompilable pattern, so reaching here means the contract
      // was not validated. Failing closed — matching nothing — is safer than throwing inside a
      // per-span loop, and the impossible case is asserted by test rather than assumed.
      this.#namePattern = compiled.ok ? compiled.pattern : null;
    }

    this.#conditions = (selector.attributes ?? []).map(
      (condition) => new CompiledCondition(condition),
    );
  }

  /**
   * The most selective index dimension this selector can use, or `null` when it must scan.
   *
   * Name first, then service, then operation: a canonical name is close to unique in a trace, a
   * service holds a handful of spans, and an operation category holds many.
   */
  #candidateSpanIds(index: GraphIndex): readonly string[] {
    if (this.source.name !== undefined) return index.byCanonicalName(this.source.name);
    if (this.source.service !== undefined) return index.byService(this.source.service);
    if (this.source.operation !== undefined) return index.byOperation(this.source.operation);

    // A single equality condition on a classified dimension is still far better than a full scan.
    for (const condition of this.#conditions) {
      if (condition.operator !== "equals" || typeof condition.value !== "string") continue;
      if (condition.key === "agent.side_effect") return index.bySideEffect(condition.value);
      if (condition.key === "agent.data_domain") return index.byDataDomain(condition.value);
      if (condition.key === "gen_ai.tool.name") return index.byTool(condition.value);
      if (condition.key === "service.name") return index.byService(condition.value);
    }

    return index.spanIds;
  }

  /** Matching spans, in canonical order where they have one. */
  match(index: GraphIndex): readonly string[] {
    const matched: string[] = [];
    for (const spanId of this.#candidateSpanIds(index)) {
      const node = index.node(spanId);
      if (node !== undefined && this.matchesNode(node, index)) matched.push(spanId);
    }
    return sortByCanonicalOrder(matched, index);
  }

  matchesNode(node: TraceNode, index: GraphIndex): boolean {
    if (this.source.name !== undefined && node.canonicalName !== this.source.name) return false;
    if (this.source.service !== undefined && node.serviceName !== this.source.service) return false;
    if (this.source.operation !== undefined && node.operationName !== this.source.operation) {
      return false;
    }
    if (this.#namePattern !== null && !matchPattern(this.#namePattern, node.canonicalName)) {
      return false;
    }
    for (const condition of this.#conditions) {
      if (!condition.matches(index.attribute(node, condition.key))) return false;
    }
    return true;
  }
}

/**
 * One attribute condition, with its pattern compiled and its value set built.
 *
 * The `in` and `not_in` sets are `Set`s keyed by a type-tagged string, so `"1"` and `1` are distinct
 * members. Comparing them loosely would let a numeric attribute satisfy a string allowlist, which is
 * exactly the sort of quiet coercion a safety rule must not do.
 */
class CompiledCondition {
  readonly key: string;
  readonly operator: AttributeCondition["operator"];
  readonly value: ScalarValue | readonly ScalarValue[] | undefined;
  readonly #members: ReadonlySet<string> | null;
  readonly #pattern: CompiledPattern | null;

  constructor(condition: AttributeCondition) {
    this.key = condition.key;
    this.operator = condition.operator;
    this.value = condition.value;

    this.#members =
      Array.isArray(condition.value) === true
        ? new Set((condition.value as readonly ScalarValue[]).map(scalarKey))
        : null;

    if (condition.operator === "matches" && typeof condition.value === "string") {
      const compiled = compilePattern(condition.value);
      this.#pattern = compiled.ok ? compiled.pattern : null;
    } else {
      this.#pattern = null;
    }
  }

  matches(actual: SafeAttributeValue | undefined): boolean {
    switch (this.operator) {
      case "exists":
        return actual !== undefined;
      case "equals":
        return actual !== undefined && scalarEquals(actual, this.value);
      // A missing attribute satisfies `not_equals`. The span does not carry the forbidden value,
      // which is what the author asked. `attribute_constraint` treats absence differently and says
      // so explicitly, because there "the value must be X" is a positive claim about the span.
      case "not_equals":
        return actual === undefined || !scalarEquals(actual, this.value);
      case "in":
        return actual !== undefined && this.#members !== null && this.#anyMember(actual);
      case "not_in":
        return actual === undefined || this.#members === null || !this.#anyMember(actual);
      case "matches":
        return (
          this.#pattern !== null &&
          typeof actual === "string" &&
          matchPattern(this.#pattern, actual)
        );
    }
  }

  /** A set-valued attribute satisfies `in` when any of its members is allowed. */
  #anyMember(actual: SafeAttributeValue): boolean {
    const members = this.#members;
    if (members === null) return false;
    if (Array.isArray(actual)) {
      return actual.some((item) => members.has(scalarKey(item as ScalarValue)));
    }
    return members.has(scalarKey(actual as ScalarValue));
  }
}

/** Type-tagged key, so a number and the string of that number are never treated as equal. */
export function scalarKey(value: ScalarValue | null): string {
  return value === null ? "null" : `${typeof value}:${String(value)}`;
}

function scalarEquals(
  actual: SafeAttributeValue,
  expected: ScalarValue | readonly ScalarValue[] | undefined,
): boolean {
  // `equals` compares against one scalar. A list value belongs to `in`, and silently treating it as
  // a membership test here would make the two operators indistinguishable.
  if (expected === undefined || Array.isArray(expected)) return false;
  const expectedKey = scalarKey(expected as ScalarValue);

  if (Array.isArray(actual)) {
    return actual.length === 1 && scalarKey(actual[0] as ScalarValue) === expectedKey;
  }
  return scalarKey(actual as ScalarValue) === expectedKey;
}

/**
 * Sorts span IDs by canonical order.
 *
 * Not by span ID: two runs of the same route have different span IDs, so span-ID order would make
 * evidence lists differ between logically identical runs. Canonical order is the same in both. A
 * span outside the rooted graph has no canonical order and sorts last by ID.
 */
export function sortByCanonicalOrder(
  spanIds: readonly string[],
  index: GraphIndex,
): readonly string[] {
  return [...spanIds].sort((a, b) => {
    const left = index.canonicalOrderOf(a);
    const right = index.canonicalOrderOf(b);
    if (left === null && right === null) return a < b ? -1 : a > b ? 1 : 0;
    if (left === null) return 1;
    if (right === null) return -1;
    if (left !== right) return left - right;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

import { createHash } from "node:crypto";
import type { RuleType } from "@flightrules/contract-schema";
import type { Severity } from "@flightrules/domain";
import type { GraphIndex } from "./graph-index.js";
import {
  EMPTY_EVIDENCE,
  type EvidenceReference,
  type Violation,
  type ViolationCode,
} from "./result.js";
import { sortByCanonicalOrder } from "./selector.js";

/**
 * Evidence references and violation identity.
 *
 * A violation is only useful if a human can open the exact spans it came from, and only countable
 * across releases if the same finding carries the same identifier each time. Those two needs pull in
 * opposite directions — span IDs give the link, and change every run — so both are carried and the
 * identifier is derived from the stable half.
 */

export function evidenceFor(spanIds: readonly string[], index: GraphIndex): EvidenceReference {
  if (spanIds.length === 0) return EMPTY_EVIDENCE;

  const ordered = sortByCanonicalOrder(spanIds, index);
  const canonicalNodes: number[] = [];
  const labels = new Set<string>();

  for (const spanId of ordered) {
    const order = index.canonicalOrderOf(spanId);
    if (order !== null) canonicalNodes.push(order);
    const node = index.node(spanId);
    if (node !== undefined) labels.add(node.canonicalName);
  }

  return {
    spanIds: ordered,
    canonicalNodes: [...canonicalNodes].sort((a, b) => a - b),
    labels: [...labels].sort(),
  };
}

/** Evidence that names canonical labels a rule expected but never observed. */
export function absentEvidence(labels: readonly string[]): EvidenceReference {
  return { spanIds: [], canonicalNodes: [], labels: [...new Set(labels)].sort() };
}

export interface ViolationInput {
  readonly ruleId: string;
  readonly ruleType: RuleType;
  readonly code: ViolationCode;
  readonly severity: Severity;
  readonly zeroTolerance: boolean;
  readonly summary: string;
  readonly expected: string;
  readonly observed: string;
  readonly evidence: EvidenceReference;
  /**
   * Extra discriminator for two violations of one rule that would otherwise be identical — the tool
   * name in a per-tool retry breach, for instance.
   */
  readonly discriminator?: string;
}

/**
 * Builds a violation with a stable identifier.
 *
 * The identifier hashes the rule, the code, the canonical node positions, the canonical labels and
 * the discriminator — and deliberately **not** the span IDs, the summary or the observed value. So
 * the same structural finding in two runs of one route shares an identifier and can be reported as
 * recurring, while two different findings from one rule stay distinct.
 */
export function violation(input: ViolationInput): Violation {
  const identity = JSON.stringify([
    input.ruleId,
    input.code,
    input.evidence.canonicalNodes,
    input.evidence.labels,
    input.discriminator ?? null,
  ]);
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16);

  return {
    id: `${input.ruleId}:${input.code}:${digest}`,
    ruleId: input.ruleId,
    ruleType: input.ruleType,
    code: input.code,
    severity: input.severity,
    zeroTolerance: input.zeroTolerance,
    summary: input.summary,
    expected: input.expected,
    observed: input.observed,
    evidence: input.evidence,
  };
}

/**
 * Describes a selector for a human-readable summary.
 *
 * The values shown come from the contract, never from telemetry, so this cannot leak a payload,
 * a customer identifier or a secret into a violation message. Selector values are exactly what the
 * author wrote, and a violation that named the rule without naming what it looked for would be
 * unreadable.
 */
export function describeSelector(selector: {
  readonly name?: string;
  readonly namePattern?: string;
  readonly service?: string;
  readonly operation?: string;
  readonly attributes?: readonly {
    readonly key: string;
    readonly operator: string;
    readonly value?: unknown;
  }[];
}): string {
  const parts: string[] = [];
  if (selector.name !== undefined) parts.push(selector.name);
  if (selector.namePattern !== undefined) parts.push(`name matching /${selector.namePattern}/`);
  if (selector.service !== undefined) parts.push(`in ${selector.service}`);
  if (selector.operation !== undefined) parts.push(`operation ${selector.operation}`);
  for (const condition of selector.attributes ?? []) {
    parts.push(describeCondition(condition.key, condition.operator, condition.value));
  }
  return parts.length === 0 ? "any span" : parts.join(", ");
}

const OPERATOR_TEXT: ReadonlyMap<string, string> = new Map([
  ["equals", "="],
  ["not_equals", "!="],
  ["in", "in"],
  ["not_in", "not in"],
  ["matches", "matches"],
]);

function describeCondition(key: string, operator: string, value: unknown): string {
  if (operator === "exists") return `${key} present`;
  const symbol = OPERATOR_TEXT.get(operator) ?? operator;
  const rendered = Array.isArray(value)
    ? `[${value.map((entry) => String(entry)).join(", ")}]`
    : String(value);
  return `${key} ${symbol} ${rendered}`;
}

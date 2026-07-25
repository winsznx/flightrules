import { createHash } from "node:crypto";
import type {
  AttributeCondition,
  ContractGate,
  ContractRule,
  RationalThreshold,
  ScalarValue,
  Selector,
  TrajectoryContract,
} from "./types.js";

/**
 * Canonical serialisation and content hashing.
 *
 * The content hash identifies *what a contract means*, not how it was typed. Two documents that
 * differ only in key order, rule declaration order, list order, comments or indentation must hash
 * identically, so a reformatted contract does not read as a policy change and force re-approval.
 * Two documents that differ in any enforceable way must hash differently.
 *
 * Every object below is built with its keys in a fixed literal order and every collection is
 * already sorted by validation, so `JSON.stringify` — which preserves insertion order — produces a
 * stable string without a custom writer.
 */

function compareStrings(a: string, b: string): number {
  // Explicit code-unit comparison rather than the default `sort()`, which is also code-unit ordered
  // but reads as though it might be locale-sensitive. Nothing here may depend on a locale.
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalThreshold(threshold: RationalThreshold): unknown {
  // The exact fraction is hashed, not the author's text. `0.9` and `0.90` mean the same bound and
  // must not produce two different contract identities.
  return { numerator: threshold.numerator, denominator: threshold.denominator };
}

function canonicalCondition(condition: AttributeCondition): unknown {
  return {
    key: condition.key,
    operator: condition.operator,
    value: condition.value === undefined ? null : canonicalScalar(condition.value),
  };
}

function canonicalScalar(value: ScalarValue | readonly ScalarValue[]): unknown {
  return Array.isArray(value) ? [...value] : value;
}

function canonicalSelector(selector: Selector): unknown {
  return {
    name: selector.name ?? null,
    namePattern: selector.namePattern ?? null,
    service: selector.service ?? null,
    operation: selector.operation ?? null,
    attributes: (selector.attributes ?? []).map(canonicalCondition),
  };
}

/**
 * One rule, with every field of every type present.
 *
 * A shape that varied by rule type would let a `required_span` and a `forbidden_span` on the same
 * selector serialise to strings that differ only in a field name, and the explicit nulls make it
 * obvious in a diff which fields a rule type does not use.
 */
function canonicalRule(rule: ContractRule): unknown {
  const base = {
    id: rule.id,
    type: rule.type,
    severity: rule.severity,
    description: rule.description ?? null,
  };

  switch (rule.type) {
    case "required_span":
      return {
        ...base,
        selector: canonicalSelector(rule.selector),
        cardinality: { min: rule.cardinality.min, max: rule.cardinality.max },
      };
    case "required_ancestry":
      return {
        ...base,
        ancestor: canonicalSelector(rule.ancestor),
        descendant: canonicalSelector(rule.descendant),
        relationship: rule.relationship,
      };
    case "required_edge":
      return {
        ...base,
        from: canonicalSelector(rule.from),
        to: canonicalSelector(rule.to),
        relationship: rule.relationship,
      };
    case "forbidden_span":
      return { ...base, selector: canonicalSelector(rule.selector) };
    case "forbidden_path":
      return {
        ...base,
        from: canonicalSelector(rule.from),
        to: canonicalSelector(rule.to),
        unless:
          rule.unless === undefined ? null : { contains: canonicalSelector(rule.unless.contains) },
      };
    case "cardinality":
      return {
        ...base,
        selector: canonicalSelector(rule.selector),
        min: rule.min,
        max: rule.max,
        scope: rule.scope,
      };
    case "allowed_values":
      return {
        ...base,
        field: rule.field,
        values: [...rule.values],
        selector: rule.selector === undefined ? null : canonicalSelector(rule.selector),
      };
    case "attribute_constraint":
      return {
        ...base,
        selector: canonicalSelector(rule.selector),
        field: rule.field,
        operator: rule.operator,
        value: rule.value === undefined ? null : canonicalScalar(rule.value),
      };
    case "retry_budget":
      return {
        ...base,
        selector: canonicalSelector(rule.selector),
        maxPerTool: rule.maxPerTool,
        maxRunTotal: rule.maxRunTotal,
        sideEffectMax: rule.sideEffectMax,
      };
    case "approved_routes":
      return {
        ...base,
        fingerprints: [...rule.fingerprints],
        minSimilarity: canonicalThreshold(rule.minSimilarity),
      };
    case "numeric_budget":
      return {
        ...base,
        metric: rule.metric,
        aggregation: rule.aggregation,
        max: rule.max,
        scope: rule.scope,
      };
  }
}

function canonicalGate(gate: ContractGate): unknown {
  return {
    minCompletedRuns: gate.minCompletedRuns,
    evaluationTimeoutSeconds: gate.evaluationTimeoutSeconds,
    maxViolationPercent: canonicalThreshold(gate.maxViolationPercent),
    maxUnknownRoutePercent: canonicalThreshold(gate.maxUnknownRoutePercent),
    maxLatencyRegressionPercent: canonicalThreshold(gate.maxLatencyRegressionPercent),
    maxTokenRegressionPercent: canonicalThreshold(gate.maxTokenRegressionPercent),
    zeroToleranceRuleIds: [...gate.zeroToleranceRuleIds].sort(compareStrings),
  };
}

/**
 * The hashed region of a contract.
 *
 * `metadata.name`, `metadata.createdAt` and `metadata.baselineRelease` are deliberately **outside**
 * it. Renaming a contract or recording when it was drafted changes nothing about what it enforces,
 * and including them would mean an editorial change invalidated an approval. `metadata.version` is
 * inside: it is how a human refers to an enforceable revision.
 *
 * Every collection is sorted **here**, not merely assumed to have been sorted by validation. The
 * validator does sort them, so for a parsed contract this is redundant — but a contract also arrives
 * from the Phase 08 proposal generator and from a Phase 09 database row, and a canonical form that
 * depended on its caller having tidied the input would hash one policy two ways depending on which
 * producer built it. That failure would look like a policy change and force a spurious re-approval.
 */
export function canonicalContract(contract: TrajectoryContract): unknown {
  return {
    apiVersion: contract.apiVersion,
    kind: contract.kind,
    metadata: {
      id: contract.metadata.id,
      version: contract.metadata.version,
      project: contract.metadata.project,
      agent: contract.metadata.agent,
      environment: contract.metadata.environment,
    },
    spec: {
      selectors: {
        workflowName: contract.spec.selectors.workflowName,
        releaseAttribute: contract.spec.selectors.releaseAttribute,
        environmentAttribute: contract.spec.selectors.environmentAttribute,
        rootSpan: contract.spec.selectors.rootSpan ?? null,
      },
      approvedRoutes: [...contract.spec.approvedRoutes].sort(compareStrings),
      rules: [...contract.spec.rules].sort((a, b) => compareStrings(a.id, b.id)).map(canonicalRule),
      gate: canonicalGate(contract.spec.gate),
    },
  };
}

export function serialiseContract(contract: TrajectoryContract): string {
  return JSON.stringify(canonicalContract(contract));
}

/** SHA-256 over the canonical serialisation, matching the `content_hash` column of PRD 14.9. */
export function contractContentHash(contract: TrajectoryContract): string {
  return createHash("sha256").update(serialiseContract(contract)).digest("hex");
}

/**
 * Full canonical JSON, including the fields excluded from the hash.
 *
 * This is what PRD section 14.9's `canonical_json` column stores: everything needed to reconstruct
 * the contract, in a stable form, without re-parsing the YAML.
 */
export function canonicalContractJson(contract: TrajectoryContract): string {
  return JSON.stringify({
    apiVersion: contract.apiVersion,
    kind: contract.kind,
    metadata: {
      id: contract.metadata.id,
      name: contract.metadata.name,
      version: contract.metadata.version,
      project: contract.metadata.project,
      agent: contract.metadata.agent,
      environment: contract.metadata.environment,
      createdAt: contract.metadata.createdAt,
      baselineRelease: contract.metadata.baselineRelease ?? null,
    },
    spec: (canonicalContract(contract) as { readonly spec: unknown }).spec,
    contentHash: contractContentHash(contract),
  });
}

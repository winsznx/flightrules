import type { ContractGate, ContractRule, Selector } from "@flightrules/contract-schema";

/**
 * The document form of a validated contract.
 *
 * `ContractRule`, `ContractGate` and `Selector` are the *validated* types: a `RationalThreshold` is
 * not a document value, optional fields are absent rather than null, and lists are already sorted.
 * Validation is what turns a document into those types, so a generated contract has to be rendered
 * back to document shape before it can go through the validator or the YAML serialiser.
 *
 * One implementation, used by both the proposal generator and the YAML emitter. Two copies would
 * agree until one gained a field, and then the emitted document and the validated document would
 * differ in a way the content-hash comparison would report as drift with no explanation.
 *
 * Every object is built with its keys in a fixed literal order, so `yaml` and `JSON.stringify` both
 * produce a stable rendering without a custom writer.
 */

export interface RuleDocumentOptions {
  /**
   * Whether route fingerprints carry the `sha256:` prefix.
   *
   * The DSL accepts both and validation strips the prefix, so the choice is presentational: the YAML a
   * human reads says `sha256:` and the value the validator returns does not.
   */
  readonly prefixFingerprints: boolean;
}

export function selectorDocument(selector: Selector): Record<string, unknown> {
  return {
    ...(selector.name === undefined ? {} : { name: selector.name }),
    ...(selector.namePattern === undefined ? {} : { namePattern: selector.namePattern }),
    ...(selector.service === undefined ? {} : { service: selector.service }),
    ...(selector.operation === undefined ? {} : { operation: selector.operation }),
    ...(selector.attributes === undefined || selector.attributes.length === 0
      ? {}
      : {
          attributes: selector.attributes.map((condition) => ({
            key: condition.key,
            operator: condition.operator,
            ...(condition.value === undefined
              ? {}
              : { value: Array.isArray(condition.value) ? [...condition.value] : condition.value }),
          })),
        }),
  };
}

export function ruleDocument(
  rule: ContractRule,
  options: RuleDocumentOptions,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: rule.id,
    type: rule.type,
    severity: rule.severity,
    ...(rule.description === undefined ? {} : { description: rule.description }),
  };

  switch (rule.type) {
    case "required_span":
      return {
        ...base,
        selector: selectorDocument(rule.selector),
        cardinality: { min: rule.cardinality.min, max: rule.cardinality.max },
      };
    case "required_ancestry":
      return {
        ...base,
        ancestor: selectorDocument(rule.ancestor),
        descendant: selectorDocument(rule.descendant),
        relationship: rule.relationship,
      };
    case "required_edge":
      return {
        ...base,
        from: selectorDocument(rule.from),
        to: selectorDocument(rule.to),
        relationship: rule.relationship,
      };
    case "forbidden_span":
      return { ...base, selector: selectorDocument(rule.selector) };
    case "forbidden_path":
      return {
        ...base,
        from: selectorDocument(rule.from),
        to: selectorDocument(rule.to),
        ...(rule.unless === undefined
          ? {}
          : { unless: { contains: selectorDocument(rule.unless.contains) } }),
      };
    case "cardinality":
      return {
        ...base,
        selector: selectorDocument(rule.selector),
        min: rule.min,
        max: rule.max,
        scope: rule.scope,
      };
    case "allowed_values":
      return {
        ...base,
        field: rule.field,
        values: [...rule.values],
        ...(rule.selector === undefined ? {} : { selector: selectorDocument(rule.selector) }),
      };
    case "attribute_constraint":
      return {
        ...base,
        selector: selectorDocument(rule.selector),
        field: rule.field,
        operator: rule.operator,
        ...(rule.value === undefined ? {} : { value: rule.value }),
      };
    case "retry_budget":
      return {
        ...base,
        selector: selectorDocument(rule.selector),
        maxPerTool: rule.maxPerTool,
        maxRunTotal: rule.maxRunTotal,
        sideEffectMax: rule.sideEffectMax,
      };
    case "approved_routes":
      return {
        ...base,
        fingerprints: rule.fingerprints.map((fingerprint) =>
          options.prefixFingerprints ? `sha256:${fingerprint}` : fingerprint,
        ),
        // The author's own decimal text, so `0.92` round-trips as `0.92` rather than as the shortest
        // decimal of the nearest double.
        minSimilarity: Number(rule.minSimilarity.text),
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

export function gateDocument(gate: ContractGate): Record<string, unknown> {
  return {
    minCompletedRuns: gate.minCompletedRuns,
    evaluationTimeoutSeconds: gate.evaluationTimeoutSeconds,
    maxViolationPercent: Number(gate.maxViolationPercent.text),
    maxUnknownRoutePercent: Number(gate.maxUnknownRoutePercent.text),
    maxLatencyRegressionPercent: Number(gate.maxLatencyRegressionPercent.text),
    maxTokenRegressionPercent: Number(gate.maxTokenRegressionPercent.text),
    zeroToleranceRuleIds: [...gate.zeroToleranceRuleIds],
  };
}

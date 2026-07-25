import { SEVERITIES, type Severity } from "@flightrules/domain";
import { childPath, ErrorBag, indexPath, type ValidationError } from "./errors.js";
import { compilePattern } from "./regex.js";
import {
  AGGREGATIONS,
  ANCESTRY_RELATIONSHIPS,
  type AttributeCondition,
  BUDGET_METRICS,
  type Cardinality,
  CONTRACT_API_VERSION,
  CONTRACT_KIND,
  CONTRACT_LIMITS,
  type ContractGate,
  type ContractMetadata,
  type ContractRule,
  type ContractSelectors,
  type ContractSpec,
  isRuleType,
  type RationalThreshold,
  RULE_SCOPES,
  RULE_TYPES,
  type ScalarValue,
  SELECTOR_OPERATORS,
  type Selector,
  type SelectorOperator,
  type TrajectoryContract,
} from "./types.js";

/**
 * Static contract validation (PRD FR-009).
 *
 * Two principles shape this file.
 *
 * Unknown fields are **rejected**, never dropped. Silently ignoring `cardinaltiy:` would leave the
 * author believing a bound was enforced when no rule constrains anything, which is the most
 * dangerous possible failure for a safety contract.
 *
 * Every value is read through explicit own-property checks. Contract documents may contain a key
 * called `constructor` or `toString`, and a validator that reached through the prototype chain
 * would see functions where it expected data.
 */

/** Objects arriving from YAML are inspected as data; nothing is read through the prototype chain. */
type Record_ = Readonly<Record<string, unknown>>;

function isPlainRecord(value: unknown): value is Record_ {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function own(record: Record_, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function hasOwn(record: Record_, key: string): boolean {
  return Object.hasOwn(record, key);
}

/** Reports every key the caller did not declare, so a typo is a rejection rather than a no-op. */
function rejectUnknownKeys(
  record: Record_,
  allowed: readonly string[],
  path: string,
  bag: ErrorBag,
) {
  const permitted = new Set(allowed);
  for (const key of Object.keys(record).sort()) {
    if (permitted.has(key)) continue;
    bag.add(
      childPath(path, key),
      "UNKNOWN_FIELD",
      `Unknown field "${key}". Permitted fields here: ${[...permitted].sort().join(", ")}.`,
    );
  }
}

const IDENTIFIER = /^[a-z0-9][a-z0-9._-]*$/;
const SEMANTIC_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$/;
const ATTRIBUTE_KEY = /^[A-Za-z][A-Za-z0-9._-]*$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const SHA256_FINGERPRINT = /^(sha256:)?[0-9a-f]{64}$/;

function requireString(
  record: Record_,
  key: string,
  path: string,
  bag: ErrorBag,
  options: { readonly required: boolean; readonly maxLength?: number } = { required: true },
): string | undefined {
  const at = childPath(path, key);
  if (!hasOwn(record, key)) {
    if (options.required) bag.add(at, "REQUIRED", `"${key}" is required.`);
    return undefined;
  }
  const value = own(record, key);
  if (typeof value !== "string") {
    bag.add(at, "INVALID_TYPE", `"${key}" must be a string.`);
    return undefined;
  }
  const limit = options.maxLength ?? CONTRACT_LIMITS.maxStringLength;
  if (value.length > limit) {
    bag.add(at, "STRING_TOO_LONG", `"${key}" may not exceed ${limit} characters.`);
    return undefined;
  }
  if (value.length === 0) {
    bag.add(at, "INVALID_FORMAT", `"${key}" may not be empty.`);
    return undefined;
  }
  return value;
}

function requireIdentifier(
  record: Record_,
  key: string,
  path: string,
  bag: ErrorBag,
  required = true,
): string | undefined {
  const value = requireString(record, key, path, bag, {
    required,
    maxLength: CONTRACT_LIMITS.maxIdentifierLength,
  });
  if (value === undefined) return undefined;
  if (!IDENTIFIER.test(value)) {
    bag.add(
      childPath(path, key),
      "INVALID_IDENTIFIER",
      `"${key}" must be lower-case and start with a letter or digit, using only letters, digits, dot, hyphen and underscore.`,
    );
    return undefined;
  }
  return value;
}

/**
 * Reads a non-negative integer.
 *
 * A float where an integer is required is rejected rather than truncated: `max: 1.5` on a span
 * count means the author misunderstood the field, and rounding it would hide that.
 */
function requireInteger(
  record: Record_,
  key: string,
  path: string,
  bag: ErrorBag,
  options: { readonly required?: boolean; readonly min?: number; readonly max?: number } = {},
): number | undefined {
  const at = childPath(path, key);
  const required = options.required ?? true;
  if (!hasOwn(record, key)) {
    if (required) bag.add(at, "REQUIRED", `"${key}" is required.`);
    return undefined;
  }
  const value = own(record, key);
  if (typeof value !== "number") {
    bag.add(at, "INVALID_TYPE", `"${key}" must be a number.`);
    return undefined;
  }
  if (!Number.isInteger(value)) {
    bag.add(at, "INVALID_NUMBER", `"${key}" must be a whole number.`);
    return undefined;
  }
  if (!Number.isSafeInteger(value)) {
    bag.add(at, "INVALID_NUMBER", `"${key}" is outside the exactly representable integer range.`);
    return undefined;
  }
  const min = options.min ?? 0;
  const max = options.max ?? CONTRACT_LIMITS.maxInteger;
  if (value < min || value > max) {
    bag.add(at, "INVALID_RANGE", `"${key}" must be between ${min} and ${max}.`);
    return undefined;
  }
  return value;
}

/** Decimal fraction digits accepted in a threshold. Enough for basis points, bounded for exactness. */
const MAX_FRACTION_DIGITS = 6;

/**
 * Reads a threshold as an exact fraction.
 *
 * `0.92` in YAML becomes the nearest binary double, which is not 92/100. Comparing a similarity
 * ratio against that double would make the outcome depend on rounding. `Number.prototype.toString`
 * returns the *shortest* decimal that round-trips — a behaviour the language specifies, not an
 * implementation detail — so it recovers exactly the digits the author wrote, and those digits
 * become an integer numerator and a power-of-ten denominator the evaluator compares by
 * cross-multiplication.
 */
function requireThreshold(
  record: Record_,
  key: string,
  path: string,
  bag: ErrorBag,
  bounds: { readonly min: number; readonly max: number },
): RationalThreshold | undefined {
  const at = childPath(path, key);
  if (!hasOwn(record, key)) {
    bag.add(at, "REQUIRED", `"${key}" is required.`);
    return undefined;
  }
  const value = own(record, key);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    bag.add(at, "INVALID_TYPE", `"${key}" must be a finite number.`);
    return undefined;
  }
  if (value < bounds.min || value > bounds.max) {
    bag.add(at, "INVALID_RANGE", `"${key}" must be between ${bounds.min} and ${bounds.max}.`);
    return undefined;
  }

  const text = value.toString();
  if (text.includes("e") || text.includes("E")) {
    bag.add(at, "INVALID_NUMBER", `"${key}" must be written in plain decimal notation.`);
    return undefined;
  }

  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > MAX_FRACTION_DIGITS) {
    bag.add(
      at,
      "INVALID_NUMBER",
      `"${key}" may not have more than ${MAX_FRACTION_DIGITS} decimal places.`,
    );
    return undefined;
  }

  const denominator = 10 ** fraction.length;
  const numerator = Number.parseInt(`${whole}${fraction}`, 10);
  if (!Number.isSafeInteger(numerator)) {
    bag.add(at, "INVALID_NUMBER", `"${key}" is too precise to represent exactly.`);
    return undefined;
  }

  return { numerator, denominator, text };
}

function requireEnum<T extends string>(
  record: Record_,
  key: string,
  allowed: readonly T[],
  path: string,
  bag: ErrorBag,
  required = true,
): T | undefined {
  const at = childPath(path, key);
  if (!hasOwn(record, key)) {
    if (required) bag.add(at, "REQUIRED", `"${key}" is required.`);
    return undefined;
  }
  const value = own(record, key);
  if (typeof value !== "string") {
    bag.add(at, "INVALID_TYPE", `"${key}" must be a string.`);
    return undefined;
  }
  if (!(allowed as readonly string[]).includes(value)) {
    bag.add(at, "INVALID_ENUM", `"${key}" must be one of: ${[...allowed].sort().join(", ")}.`);
    return undefined;
  }
  return value as T;
}

function requireRecord(
  record: Record_,
  key: string,
  path: string,
  bag: ErrorBag,
  required = true,
): Record_ | undefined {
  const at = childPath(path, key);
  if (!hasOwn(record, key)) {
    if (required) bag.add(at, "REQUIRED", `"${key}" is required.`);
    return undefined;
  }
  const value = own(record, key);
  if (!isPlainRecord(value)) {
    bag.add(at, "INVALID_TYPE", `"${key}" must be a mapping.`);
    return undefined;
  }
  return value;
}

function requireArray(
  record: Record_,
  key: string,
  path: string,
  bag: ErrorBag,
  options: {
    readonly required?: boolean;
    readonly allowEmpty?: boolean;
    readonly max?: number;
  } = {},
): readonly unknown[] | undefined {
  const at = childPath(path, key);
  const required = options.required ?? true;
  if (!hasOwn(record, key)) {
    if (required) bag.add(at, "REQUIRED", `"${key}" is required.`);
    return undefined;
  }
  const value = own(record, key);
  if (!Array.isArray(value)) {
    bag.add(at, "INVALID_TYPE", `"${key}" must be a list.`);
    return undefined;
  }
  if (value.length === 0 && options.allowEmpty !== true) {
    bag.add(at, "LIST_EMPTY", `"${key}" may not be empty.`);
    return undefined;
  }
  const max = options.max ?? CONTRACT_LIMITS.maxValueListLength;
  if (value.length > max) {
    bag.add(at, "LIST_TOO_LONG", `"${key}" may not hold more than ${max} entries.`);
    return undefined;
  }
  return value;
}

function isScalarValue(value: unknown): value is ScalarValue {
  if (typeof value === "string") return value.length <= CONTRACT_LIMITS.maxStringLength;
  if (typeof value === "boolean") return true;
  return typeof value === "number" && Number.isFinite(value);
}

/* -------------------------------------------------------------------------- */
/* Selectors                                                                  */
/* -------------------------------------------------------------------------- */

const SELECTOR_KEYS = ["name", "namePattern", "service", "operation", "attributes"] as const;

/**
 * Validates a selector.
 *
 * `allowEmpty` exists because an empty selector is meaningful in exactly one place — an
 * `allowed_values` rule that applies to every span carrying the field — and meaningless everywhere
 * else, where it would silently select the entire trace.
 */
function validateSelector(
  value: unknown,
  path: string,
  bag: ErrorBag,
  options: { readonly allowEmpty?: boolean } = {},
): Selector | undefined {
  if (!isPlainRecord(value)) {
    bag.add(path, "INVALID_TYPE", "A selector must be a mapping.");
    return undefined;
  }
  rejectUnknownKeys(value, SELECTOR_KEYS, path, bag);

  const name = requireString(value, "name", path, bag, { required: false });
  const namePattern = requireString(value, "namePattern", path, bag, {
    required: false,
    maxLength: CONTRACT_LIMITS.maxPatternLength,
  });
  const service = requireString(value, "service", path, bag, { required: false });
  const operation = requireString(value, "operation", path, bag, { required: false });

  if (hasOwn(value, "name") && hasOwn(value, "namePattern")) {
    bag.add(
      childPath(path, "namePattern"),
      "CONTRADICTORY_RULES",
      "A selector may set either name or namePattern, not both.",
    );
  }

  if (namePattern !== undefined) {
    const compiled = compilePattern(namePattern);
    if (!compiled.ok) {
      bag.add(
        childPath(path, "namePattern"),
        "INVALID_PATTERN",
        compiled.error.offset === undefined
          ? compiled.error.message
          : `${compiled.error.message} (at offset ${compiled.error.offset})`,
      );
    }
  }

  const attributes = validateAttributeConditions(value, path, bag);

  const hasAny =
    name !== undefined ||
    namePattern !== undefined ||
    service !== undefined ||
    operation !== undefined ||
    (attributes !== undefined && attributes.length > 0);

  if (!hasAny && options.allowEmpty !== true) {
    bag.add(
      path,
      "EMPTY_SELECTOR",
      "A selector must constrain at least one of name, namePattern, service, operation or attributes.",
    );
    return undefined;
  }

  return {
    ...(name === undefined ? {} : { name }),
    ...(namePattern === undefined ? {} : { namePattern }),
    ...(service === undefined ? {} : { service }),
    ...(operation === undefined ? {} : { operation }),
    ...(attributes === undefined || attributes.length === 0 ? {} : { attributes }),
  };
}

/**
 * Accepts both attribute forms.
 *
 * The PRD's shorthand `attributes: {key: value}` means equality; the explicit list form carries an
 * operator. Both are normalised to the explicit list here so the evaluator interprets one shape.
 */
function validateAttributeConditions(
  selector: Record_,
  path: string,
  bag: ErrorBag,
): readonly AttributeCondition[] | undefined {
  if (!hasOwn(selector, "attributes")) return undefined;
  const at = childPath(path, "attributes");
  const raw = own(selector, "attributes");

  if (Array.isArray(raw)) {
    if (raw.length > CONTRACT_LIMITS.maxSelectorAttributes) {
      bag.add(
        at,
        "LIST_TOO_LONG",
        `A selector may not carry more than ${CONTRACT_LIMITS.maxSelectorAttributes} attribute conditions.`,
      );
      return undefined;
    }
    const conditions: AttributeCondition[] = [];
    for (const [index, entry] of raw.entries()) {
      const condition = validateAttributeCondition(entry, indexPath(at, index), bag);
      if (condition !== undefined) conditions.push(condition);
    }
    return sortConditions(conditions, at, bag);
  }

  if (!isPlainRecord(raw)) {
    bag.add(
      at,
      "INVALID_TYPE",
      "attributes must be a mapping of key to value, or a list of conditions.",
    );
    return undefined;
  }

  const keys = Object.keys(raw);
  if (keys.length > CONTRACT_LIMITS.maxSelectorAttributes) {
    bag.add(
      at,
      "LIST_TOO_LONG",
      `A selector may not carry more than ${CONTRACT_LIMITS.maxSelectorAttributes} attribute conditions.`,
    );
    return undefined;
  }

  const conditions: AttributeCondition[] = [];
  for (const key of keys) {
    const keyAt = childPath(at, key);
    if (!ATTRIBUTE_KEY.test(key)) {
      bag.add(keyAt, "INVALID_IDENTIFIER", `"${key}" is not a valid attribute key.`);
      continue;
    }
    const value = own(raw, key);
    if (!isScalarValue(value)) {
      bag.add(
        keyAt,
        "INVALID_TYPE",
        "An attribute shorthand value must be a string, number or boolean.",
      );
      continue;
    }
    conditions.push({ key, operator: "equals", value });
  }
  return sortConditions(conditions, at, bag);
}

const CONDITION_KEYS = ["key", "operator", "value"] as const;

function validateAttributeCondition(
  value: unknown,
  path: string,
  bag: ErrorBag,
): AttributeCondition | undefined {
  if (!isPlainRecord(value)) {
    bag.add(path, "INVALID_TYPE", "An attribute condition must be a mapping.");
    return undefined;
  }
  rejectUnknownKeys(value, CONDITION_KEYS, path, bag);

  const key = requireString(value, "key", path, bag, {
    required: true,
    maxLength: CONTRACT_LIMITS.maxIdentifierLength,
  });
  if (key !== undefined && !ATTRIBUTE_KEY.test(key)) {
    bag.add(childPath(path, "key"), "INVALID_IDENTIFIER", `"${key}" is not a valid attribute key.`);
    return undefined;
  }

  const operator = requireEnum(value, "operator", SELECTOR_OPERATORS, path, bag);
  if (key === undefined || operator === undefined) return undefined;

  const conditionValue = validateOperatorValue(value, operator, path, bag);
  if (conditionValue === INVALID) return undefined;

  return conditionValue === undefined
    ? { key, operator }
    : { key, operator, value: conditionValue };
}

const INVALID = Symbol("invalid");

/**
 * Checks the value against its operator's arity.
 *
 * `exists` must carry no value, `in` and `not_in` must carry a non-empty list, `matches` must carry
 * a compilable pattern, and the rest must carry one scalar. Accepting a mismatched pair would leave
 * the evaluator guessing at intent.
 */
function validateOperatorValue(
  record: Record_,
  operator: SelectorOperator,
  path: string,
  bag: ErrorBag,
): ScalarValue | readonly ScalarValue[] | undefined | typeof INVALID {
  const at = childPath(path, "value");

  if (operator === "exists") {
    if (hasOwn(record, "value")) {
      bag.add(at, "UNKNOWN_FIELD", 'The "exists" operator takes no value.');
      return INVALID;
    }
    return undefined;
  }

  if (!hasOwn(record, "value")) {
    bag.add(at, "REQUIRED", `The "${operator}" operator requires a value.`);
    return INVALID;
  }
  const value = own(record, "value");

  if (operator === "in" || operator === "not_in") {
    if (!Array.isArray(value)) {
      bag.add(at, "INVALID_TYPE", `The "${operator}" operator requires a list of values.`);
      return INVALID;
    }
    if (value.length === 0) {
      bag.add(at, "LIST_EMPTY", `The "${operator}" operator requires at least one value.`);
      return INVALID;
    }
    if (value.length > CONTRACT_LIMITS.maxValueListLength) {
      bag.add(
        at,
        "LIST_TOO_LONG",
        `A value list may not hold more than ${CONTRACT_LIMITS.maxValueListLength} entries.`,
      );
      return INVALID;
    }
    const scalars: ScalarValue[] = [];
    for (const [index, item] of value.entries()) {
      if (!isScalarValue(item)) {
        bag.add(
          indexPath(at, index),
          "INVALID_TYPE",
          "A value must be a string, number or boolean.",
        );
        return INVALID;
      }
      scalars.push(item);
    }
    return sortScalars(scalars, at, bag);
  }

  if (!isScalarValue(value)) {
    bag.add(at, "INVALID_TYPE", `The "${operator}" operator requires a string, number or boolean.`);
    return INVALID;
  }

  if (operator === "matches") {
    if (typeof value !== "string") {
      bag.add(at, "INVALID_TYPE", 'The "matches" operator requires a string pattern.');
      return INVALID;
    }
    const compiled = compilePattern(value);
    if (!compiled.ok) {
      bag.add(
        at,
        "INVALID_PATTERN",
        compiled.error.offset === undefined
          ? compiled.error.message
          : `${compiled.error.message} (at offset ${compiled.error.offset})`,
      );
      return INVALID;
    }
  }

  return value;
}

function scalarKey(value: ScalarValue): string {
  return `${typeof value}:${String(value)}`;
}

/**
 * Sorts a value list and rejects duplicates.
 *
 * Sorting is what makes reordering a list in the YAML produce a byte-identical canonical contract
 * and content hash. Duplicates are rejected rather than deduplicated, because a repeated entry is
 * usually a merge accident and the author should see it.
 */
function sortScalars(values: readonly ScalarValue[], path: string, bag: ErrorBag): ScalarValue[] {
  const seen = new Set<string>();
  for (const value of values) {
    const key = scalarKey(value);
    if (seen.has(key)) {
      bag.add(
        path,
        "DUPLICATE_VALUE",
        `The value ${JSON.stringify(value)} appears more than once.`,
      );
    }
    seen.add(key);
  }
  return [...values].sort((a, b) => {
    const left = scalarKey(a);
    const right = scalarKey(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function sortConditions(
  conditions: readonly AttributeCondition[],
  path: string,
  bag: ErrorBag,
): readonly AttributeCondition[] {
  const seen = new Set<string>();
  for (const condition of conditions) {
    const key = `${condition.key}|${condition.operator}`;
    if (seen.has(key)) {
      bag.add(
        path,
        "DUPLICATE_VALUE",
        `The attribute "${condition.key}" has more than one "${condition.operator}" condition.`,
      );
    }
    seen.add(key);
  }
  return [...conditions].sort((a, b) =>
    a.key !== b.key ? (a.key < b.key ? -1 : 1) : a.operator < b.operator ? -1 : 1,
  );
}

/* -------------------------------------------------------------------------- */
/* Rules                                                                      */
/* -------------------------------------------------------------------------- */

const BASE_RULE_KEYS = ["id", "type", "severity", "description"] as const;

const RULE_KEYS: Readonly<Record<string, readonly string[]>> = {
  required_span: [...BASE_RULE_KEYS, "selector", "cardinality"],
  required_ancestry: [...BASE_RULE_KEYS, "ancestor", "descendant", "relationship"],
  required_edge: [...BASE_RULE_KEYS, "from", "to", "relationship"],
  forbidden_span: [...BASE_RULE_KEYS, "selector"],
  forbidden_path: [...BASE_RULE_KEYS, "from", "to", "unless"],
  cardinality: [...BASE_RULE_KEYS, "selector", "min", "max", "scope"],
  allowed_values: [...BASE_RULE_KEYS, "field", "values", "selector"],
  attribute_constraint: [...BASE_RULE_KEYS, "selector", "field", "operator", "value"],
  retry_budget: [...BASE_RULE_KEYS, "selector", "maxPerTool", "maxRunTotal", "sideEffectMax"],
  approved_routes: [...BASE_RULE_KEYS, "fingerprints", "minSimilarity"],
  numeric_budget: [...BASE_RULE_KEYS, "metric", "aggregation", "max", "scope"],
};

function validateCardinality(
  record: Record_,
  path: string,
  bag: ErrorBag,
): Cardinality | undefined {
  const block = requireRecord(record, "cardinality", path, bag);
  if (block === undefined) return undefined;
  const at = childPath(path, "cardinality");
  rejectUnknownKeys(block, ["min", "max"], at, bag);

  const min = requireInteger(block, "min", at, bag, { min: 0 });
  const max = requireInteger(block, "max", at, bag, { min: 0 });
  if (min === undefined || max === undefined) return undefined;
  if (max < min) {
    bag.add(childPath(at, "max"), "INVALID_RANGE", "max must be greater than or equal to min.");
    return undefined;
  }
  return { min, max };
}

function validateFingerprints(
  record: Record_,
  key: string,
  path: string,
  bag: ErrorBag,
  options: { readonly allowEmpty?: boolean } = {},
): readonly string[] | undefined {
  const listOptions = {
    max: CONTRACT_LIMITS.maxFingerprints,
    ...(options.allowEmpty === true ? { allowEmpty: true } : {}),
  };
  const raw = requireArray(record, key, path, bag, listOptions);
  if (raw === undefined) return undefined;

  const at = childPath(path, key);
  const fingerprints: string[] = [];
  const seen = new Set<string>();

  for (const [index, entry] of raw.entries()) {
    const entryAt = indexPath(at, index);
    if (typeof entry !== "string") {
      bag.add(entryAt, "INVALID_TYPE", "A route fingerprint must be a string.");
      continue;
    }
    if (!SHA256_FINGERPRINT.test(entry)) {
      bag.add(
        entryAt,
        "INVALID_FORMAT",
        "A route fingerprint must be 64 lower-case hexadecimal characters, optionally prefixed with sha256:.",
      );
      continue;
    }
    // Stored without the prefix so `sha256:<hex>` and `<hex>` cannot describe one route twice.
    const normalised = entry.startsWith("sha256:") ? entry.slice("sha256:".length) : entry;
    if (seen.has(normalised)) {
      bag.add(entryAt, "DUPLICATE_VALUE", "This route fingerprint appears more than once.");
      continue;
    }
    seen.add(normalised);
    fingerprints.push(normalised);
  }

  return [...fingerprints].sort();
}

function validateRule(value: unknown, path: string, bag: ErrorBag): ContractRule | undefined {
  if (!isPlainRecord(value)) {
    bag.add(path, "INVALID_TYPE", "A rule must be a mapping.");
    return undefined;
  }

  const rawType = own(value, "type");
  if (rawType === undefined) {
    bag.add(childPath(path, "type"), "REQUIRED", '"type" is required.');
    return undefined;
  }
  if (!isRuleType(rawType)) {
    bag.add(
      childPath(path, "type"),
      "UNKNOWN_RULE_TYPE",
      `Unknown rule type ${JSON.stringify(rawType)}. Supported types: ${[...RULE_TYPES].sort().join(", ")}.`,
    );
    return undefined;
  }

  rejectUnknownKeys(value, RULE_KEYS[rawType] as readonly string[], path, bag);

  const id = requireIdentifier(value, "id", path, bag);
  const severity = requireEnum<Severity>(value, "severity", SEVERITIES, path, bag);
  const description = requireString(value, "description", path, bag, { required: false });
  if (id === undefined || severity === undefined) return undefined;

  const base = { id, severity, ...(description === undefined ? {} : { description }) };

  switch (rawType) {
    case "required_span": {
      const selector = validateSelector(own(value, "selector"), childPath(path, "selector"), bag);
      const cardinality = validateCardinality(value, path, bag);
      if (selector === undefined || cardinality === undefined) return undefined;
      return { ...base, type: "required_span", selector, cardinality };
    }
    case "required_ancestry": {
      const ancestor = validateSelector(own(value, "ancestor"), childPath(path, "ancestor"), bag);
      const descendant = validateSelector(
        own(value, "descendant"),
        childPath(path, "descendant"),
        bag,
      );
      const relationship = requireEnum(value, "relationship", ANCESTRY_RELATIONSHIPS, path, bag);
      if (ancestor === undefined || descendant === undefined || relationship === undefined) {
        return undefined;
      }
      if (selectorKey(ancestor) === selectorKey(descendant)) {
        bag.add(
          childPath(path, "descendant"),
          "CONTRADICTORY_RULES",
          "A span cannot be its own ancestor; the ancestor and descendant selectors are identical.",
        );
        return undefined;
      }
      return { ...base, type: "required_ancestry", ancestor, descendant, relationship };
    }
    case "required_edge": {
      const from = validateSelector(own(value, "from"), childPath(path, "from"), bag);
      const to = validateSelector(own(value, "to"), childPath(path, "to"), bag);
      const relationship = requireEnum(value, "relationship", ANCESTRY_RELATIONSHIPS, path, bag);
      if (from === undefined || to === undefined || relationship === undefined) return undefined;
      if (selectorKey(from) === selectorKey(to)) {
        bag.add(
          childPath(path, "to"),
          "CONTRADICTORY_RULES",
          "A span cannot be its own child; the from and to selectors are identical.",
        );
        return undefined;
      }
      return { ...base, type: "required_edge", from, to, relationship };
    }
    case "forbidden_span": {
      const selector = validateSelector(own(value, "selector"), childPath(path, "selector"), bag);
      if (selector === undefined) return undefined;
      return { ...base, type: "forbidden_span", selector };
    }
    case "forbidden_path": {
      const from = validateSelector(own(value, "from"), childPath(path, "from"), bag);
      const to = validateSelector(own(value, "to"), childPath(path, "to"), bag);
      let unless: { readonly contains: Selector } | undefined;
      if (hasOwn(value, "unless")) {
        const at = childPath(path, "unless");
        const block = requireRecord(value, "unless", path, bag);
        if (block !== undefined) {
          rejectUnknownKeys(block, ["contains"], at, bag);
          const contains = validateSelector(own(block, "contains"), childPath(at, "contains"), bag);
          if (contains !== undefined) unless = { contains };
        }
      }
      if (from === undefined || to === undefined) return undefined;
      return {
        ...base,
        type: "forbidden_path",
        from,
        to,
        ...(unless === undefined ? {} : { unless }),
      };
    }
    case "cardinality": {
      const selector = validateSelector(own(value, "selector"), childPath(path, "selector"), bag);
      const min = requireInteger(value, "min", path, bag, { min: 0 });
      const max = requireInteger(value, "max", path, bag, { min: 0 });
      const scope = requireEnum(value, "scope", RULE_SCOPES, path, bag);
      if (selector === undefined || min === undefined || max === undefined || scope === undefined) {
        return undefined;
      }
      if (max < min) {
        bag.add(
          childPath(path, "max"),
          "INVALID_RANGE",
          "max must be greater than or equal to min.",
        );
        return undefined;
      }
      return { ...base, type: "cardinality", selector, min, max, scope };
    }
    case "allowed_values": {
      const field = requireString(value, "field", path, bag, {
        required: true,
        maxLength: CONTRACT_LIMITS.maxIdentifierLength,
      });
      if (field !== undefined && !ATTRIBUTE_KEY.test(field)) {
        bag.add(
          childPath(path, "field"),
          "INVALID_IDENTIFIER",
          `"${field}" is not a valid attribute key.`,
        );
        return undefined;
      }
      const raw = requireArray(value, "values", path, bag);
      const selector = hasOwn(value, "selector")
        ? validateSelector(own(value, "selector"), childPath(path, "selector"), bag)
        : undefined;
      if (field === undefined || raw === undefined) return undefined;

      const at = childPath(path, "values");
      const scalars: ScalarValue[] = [];
      for (const [index, entry] of raw.entries()) {
        if (!isScalarValue(entry)) {
          bag.add(
            indexPath(at, index),
            "INVALID_TYPE",
            "An allowed value must be a string, number or boolean.",
          );
          return undefined;
        }
        scalars.push(entry);
      }
      return {
        ...base,
        type: "allowed_values",
        field,
        values: sortScalars(scalars, at, bag),
        ...(selector === undefined ? {} : { selector }),
      };
    }
    case "attribute_constraint": {
      const selector = validateSelector(own(value, "selector"), childPath(path, "selector"), bag);
      const field = requireString(value, "field", path, bag, {
        required: true,
        maxLength: CONTRACT_LIMITS.maxIdentifierLength,
      });
      if (field !== undefined && !ATTRIBUTE_KEY.test(field)) {
        bag.add(
          childPath(path, "field"),
          "INVALID_IDENTIFIER",
          `"${field}" is not a valid attribute key.`,
        );
        return undefined;
      }
      const operator = requireEnum(value, "operator", SELECTOR_OPERATORS, path, bag);
      if (selector === undefined || field === undefined || operator === undefined) return undefined;
      const constraintValue = validateOperatorValue(value, operator, path, bag);
      if (constraintValue === INVALID) return undefined;
      return {
        ...base,
        type: "attribute_constraint",
        selector,
        field,
        operator,
        ...(constraintValue === undefined ? {} : { value: constraintValue }),
      };
    }
    case "retry_budget": {
      const selector = validateSelector(own(value, "selector"), childPath(path, "selector"), bag);
      const maxPerTool = requireInteger(value, "maxPerTool", path, bag, { min: 0 });
      const maxRunTotal = requireInteger(value, "maxRunTotal", path, bag, { min: 0 });
      const sideEffectMax = requireInteger(value, "sideEffectMax", path, bag, { min: 0 });
      if (
        selector === undefined ||
        maxPerTool === undefined ||
        maxRunTotal === undefined ||
        sideEffectMax === undefined
      ) {
        return undefined;
      }
      if (maxPerTool > maxRunTotal) {
        bag.add(
          childPath(path, "maxPerTool"),
          "INVALID_RANGE",
          "maxPerTool exceeds maxRunTotal, so the per-tool allowance can never be reached.",
        );
        return undefined;
      }
      return { ...base, type: "retry_budget", selector, maxPerTool, maxRunTotal, sideEffectMax };
    }
    case "approved_routes": {
      const fingerprints = validateFingerprints(value, "fingerprints", path, bag);
      const minSimilarity = requireThreshold(value, "minSimilarity", path, bag, { min: 0, max: 1 });
      if (fingerprints === undefined || minSimilarity === undefined) return undefined;
      return { ...base, type: "approved_routes", fingerprints, minSimilarity };
    }
    case "numeric_budget": {
      const metric = requireEnum(value, "metric", BUDGET_METRICS, path, bag);
      const aggregation = requireEnum(value, "aggregation", AGGREGATIONS, path, bag);
      const max = requireInteger(value, "max", path, bag, { min: 0 });
      const scope = requireEnum(value, "scope", RULE_SCOPES, path, bag);
      if (
        metric === undefined ||
        aggregation === undefined ||
        max === undefined ||
        scope === undefined
      ) {
        return undefined;
      }
      // A percentile over a single run is the run's own value, which reads as a stronger statement
      // than it is. Run scope therefore accepts only aggregations that mean something for one run.
      if (scope === "run" && aggregation !== "sum" && aggregation !== "max") {
        bag.add(
          childPath(path, "aggregation"),
          "INVALID_ENUM",
          'A run-scoped budget must aggregate with "sum" or "max"; percentiles and averages require release scope.',
        );
        return undefined;
      }
      return { ...base, type: "numeric_budget", metric, aggregation, max, scope };
    }
  }
}

/** Stable identity of a selector, used for contradiction detection and canonical serialisation. */
export function selectorKey(selector: Selector): string {
  return JSON.stringify([
    selector.name ?? null,
    selector.namePattern ?? null,
    selector.service ?? null,
    selector.operation ?? null,
    (selector.attributes ?? []).map((condition) => [
      condition.key,
      condition.operator,
      condition.value ?? null,
    ]),
  ]);
}

/* -------------------------------------------------------------------------- */
/* Document                                                                   */
/* -------------------------------------------------------------------------- */

const METADATA_KEYS = [
  "id",
  "name",
  "version",
  "project",
  "agent",
  "environment",
  "createdAt",
  "baselineRelease",
] as const;

function validateMetadata(document: Record_, bag: ErrorBag): ContractMetadata | undefined {
  const metadata = requireRecord(document, "metadata", "", bag);
  if (metadata === undefined) return undefined;
  rejectUnknownKeys(metadata, METADATA_KEYS, "metadata", bag);

  const id = requireIdentifier(metadata, "id", "metadata", bag);
  const name = requireString(metadata, "name", "metadata", bag, { required: true, maxLength: 200 });
  const version = requireString(metadata, "version", "metadata", bag, {
    required: true,
    maxLength: 64,
  });
  if (version !== undefined && !SEMANTIC_VERSION.test(version)) {
    bag.add(
      "metadata.version",
      "INVALID_FORMAT",
      "version must be a semantic version such as 1.0.0.",
    );
  }
  const project = requireIdentifier(metadata, "project", "metadata", bag);
  const agent = requireIdentifier(metadata, "agent", "metadata", bag);
  const environment = requireIdentifier(metadata, "environment", "metadata", bag);
  const createdAt = requireString(metadata, "createdAt", "metadata", bag, {
    required: true,
    maxLength: 40,
  });
  if (
    createdAt !== undefined &&
    (!ISO_INSTANT.test(createdAt) || Number.isNaN(Date.parse(createdAt)))
  ) {
    bag.add(
      "metadata.createdAt",
      "INVALID_FORMAT",
      "createdAt must be an ISO-8601 instant with an explicit offset, such as 2026-07-25T00:00:00Z.",
    );
  }
  const baselineRelease = requireString(metadata, "baselineRelease", "metadata", bag, {
    required: false,
    maxLength: CONTRACT_LIMITS.maxIdentifierLength,
  });

  if (
    id === undefined ||
    name === undefined ||
    version === undefined ||
    project === undefined ||
    agent === undefined ||
    environment === undefined ||
    createdAt === undefined
  ) {
    return undefined;
  }

  return {
    id,
    name,
    version,
    project,
    agent,
    environment,
    createdAt,
    ...(baselineRelease === undefined ? {} : { baselineRelease }),
  };
}

const SELECTORS_KEYS = [
  "workflowName",
  "releaseAttribute",
  "environmentAttribute",
  "rootSpan",
] as const;

function validateContractSelectors(spec: Record_, bag: ErrorBag): ContractSelectors | undefined {
  const selectors = requireRecord(spec, "selectors", "spec", bag);
  if (selectors === undefined) return undefined;
  const at = "spec.selectors";
  rejectUnknownKeys(selectors, SELECTORS_KEYS, at, bag);

  const workflowName = requireString(selectors, "workflowName", at, bag, {
    required: true,
    maxLength: CONTRACT_LIMITS.maxIdentifierLength,
  });
  const releaseAttribute = requireString(selectors, "releaseAttribute", at, bag, {
    required: true,
    maxLength: CONTRACT_LIMITS.maxIdentifierLength,
  });
  const environmentAttribute = requireString(selectors, "environmentAttribute", at, bag, {
    required: true,
    maxLength: CONTRACT_LIMITS.maxIdentifierLength,
  });
  const rootSpan = requireString(selectors, "rootSpan", at, bag, {
    required: false,
    maxLength: CONTRACT_LIMITS.maxIdentifierLength,
  });

  for (const [key, value] of [
    ["releaseAttribute", releaseAttribute],
    ["environmentAttribute", environmentAttribute],
  ] as const) {
    if (value !== undefined && !ATTRIBUTE_KEY.test(value)) {
      bag.add(childPath(at, key), "INVALID_IDENTIFIER", `"${value}" is not a valid attribute key.`);
    }
  }

  if (
    workflowName === undefined ||
    releaseAttribute === undefined ||
    environmentAttribute === undefined
  ) {
    return undefined;
  }
  return {
    workflowName,
    releaseAttribute,
    environmentAttribute,
    ...(rootSpan === undefined ? {} : { rootSpan }),
  };
}

const GATE_KEYS = [
  "minCompletedRuns",
  "evaluationTimeoutSeconds",
  "maxViolationPercent",
  "maxUnknownRoutePercent",
  "maxLatencyRegressionPercent",
  "maxTokenRegressionPercent",
  "zeroToleranceRuleIds",
] as const;

function validateGate(spec: Record_, bag: ErrorBag): ContractGate | undefined {
  const gate = requireRecord(spec, "gate", "spec", bag);
  if (gate === undefined) return undefined;
  const at = "spec.gate";
  rejectUnknownKeys(gate, GATE_KEYS, at, bag);

  const minCompletedRuns = requireInteger(gate, "minCompletedRuns", at, bag, {
    min: 1,
    max: 1_000_000,
  });
  const evaluationTimeoutSeconds = requireInteger(gate, "evaluationTimeoutSeconds", at, bag, {
    min: 1,
    max: 86_400,
  });
  const maxViolationPercent = requireThreshold(gate, "maxViolationPercent", at, bag, {
    min: 0,
    max: 100,
  });
  const maxUnknownRoutePercent = requireThreshold(gate, "maxUnknownRoutePercent", at, bag, {
    min: 0,
    max: 100,
  });
  const maxLatencyRegressionPercent = requireThreshold(
    gate,
    "maxLatencyRegressionPercent",
    at,
    bag,
    {
      min: 0,
      max: 10_000,
    },
  );
  const maxTokenRegressionPercent = requireThreshold(gate, "maxTokenRegressionPercent", at, bag, {
    min: 0,
    max: 10_000,
  });

  const rawIds = requireArray(gate, "zeroToleranceRuleIds", at, bag, {
    allowEmpty: true,
    max: CONTRACT_LIMITS.maxRules,
  });
  const zeroToleranceRuleIds: string[] = [];
  if (rawIds !== undefined) {
    const idsAt = childPath(at, "zeroToleranceRuleIds");
    const seen = new Set<string>();
    for (const [index, entry] of rawIds.entries()) {
      const entryAt = indexPath(idsAt, index);
      if (typeof entry !== "string" || !IDENTIFIER.test(entry)) {
        bag.add(entryAt, "INVALID_IDENTIFIER", "A zero-tolerance entry must be a rule identifier.");
        continue;
      }
      if (seen.has(entry)) {
        bag.add(entryAt, "DUPLICATE_VALUE", `The rule "${entry}" is listed more than once.`);
        continue;
      }
      seen.add(entry);
      zeroToleranceRuleIds.push(entry);
    }
  }

  if (
    minCompletedRuns === undefined ||
    evaluationTimeoutSeconds === undefined ||
    maxViolationPercent === undefined ||
    maxUnknownRoutePercent === undefined ||
    maxLatencyRegressionPercent === undefined ||
    maxTokenRegressionPercent === undefined ||
    rawIds === undefined
  ) {
    return undefined;
  }

  return {
    minCompletedRuns,
    evaluationTimeoutSeconds,
    maxViolationPercent,
    maxUnknownRoutePercent,
    maxLatencyRegressionPercent,
    maxTokenRegressionPercent,
    zeroToleranceRuleIds: [...zeroToleranceRuleIds].sort(),
  };
}

const SPEC_KEYS = ["selectors", "approvedRoutes", "rules", "budgets", "gate"] as const;
const DOCUMENT_KEYS = ["apiVersion", "kind", "metadata", "spec"] as const;

function validateSpec(document: Record_, bag: ErrorBag): ContractSpec | undefined {
  const spec = requireRecord(document, "spec", "", bag);
  if (spec === undefined) return undefined;
  rejectUnknownKeys(spec, SPEC_KEYS, "spec", bag);

  // PRD section 10.2 shows `budgets: {}` in the top-level shape while every budget in section 10.4
  // is expressed as a `numeric_budget` rule. An empty mapping is therefore accepted for
  // compatibility with the documented shape, and anything inside it is rejected rather than
  // silently ignored — a budget written there would otherwise never be enforced.
  if (hasOwn(spec, "budgets")) {
    const budgets = own(spec, "budgets");
    if (!isPlainRecord(budgets)) {
      bag.add("spec.budgets", "INVALID_TYPE", "budgets must be a mapping.");
    } else if (Object.keys(budgets).length > 0) {
      bag.add(
        "spec.budgets",
        "UNKNOWN_FIELD",
        "spec.budgets must be empty. Express a budget as a numeric_budget rule so it is evaluated.",
      );
    }
  }

  const selectors = validateContractSelectors(spec, bag);
  const approvedRoutes = validateFingerprints(spec, "approvedRoutes", "spec", bag, {
    allowEmpty: true,
  });
  const gate = validateGate(spec, bag);

  const rawRules = requireArray(spec, "rules", "spec", bag, {
    allowEmpty: true,
    max: CONTRACT_LIMITS.maxRules,
  });

  const rules: ContractRule[] = [];
  if (rawRules !== undefined) {
    if (rawRules.length > CONTRACT_LIMITS.maxRules) {
      bag.add(
        "spec.rules",
        "TOO_MANY_RULES",
        `A contract may not hold more than ${CONTRACT_LIMITS.maxRules} rules.`,
      );
    }
    for (const [index, entry] of rawRules.entries()) {
      const rule = validateRule(entry, indexPath("spec.rules", index), bag);
      if (rule !== undefined) rules.push(rule);
    }
    checkRuleIdUniqueness(rules, rawRules, bag);
  }

  if (
    selectors === undefined ||
    approvedRoutes === undefined ||
    gate === undefined ||
    rawRules === undefined
  ) {
    return undefined;
  }

  checkCrossRuleConsistency(rules, approvedRoutes, gate, bag);

  // Sorted by ID. Reordering rule declarations in the YAML must not change the canonical contract,
  // its content hash, or the order results are reported in.
  return {
    selectors,
    approvedRoutes,
    rules: [...rules].sort((a, b) => (a.id < b.id ? -1 : 1)),
    gate,
  };
}

/** Reported at the later declaration, so the author is pointed at the duplicate, not the original. */
function checkRuleIdUniqueness(
  rules: readonly ContractRule[],
  rawRules: readonly unknown[],
  bag: ErrorBag,
): void {
  const indexById = new Map<string, number>();
  for (const [index, entry] of rawRules.entries()) {
    if (!isPlainRecord(entry)) continue;
    const id = own(entry, "id");
    if (typeof id !== "string") continue;
    if (indexById.has(id)) {
      bag.add(
        childPath(indexPath("spec.rules", index), "id"),
        "DUPLICATE_RULE_ID",
        `The rule identifier "${id}" is already used by spec.rules[${indexById.get(id)}].`,
      );
      continue;
    }
    indexById.set(id, index);
  }
  // Referenced so the parsed list and the raw list cannot drift apart unnoticed.
  if (rules.length > rawRules.length) {
    bag.add("spec.rules", "INVALID_TYPE", "More rules were parsed than were declared.");
  }
}

/**
 * Cross-rule checks (PRD FR-009).
 *
 * Only contradictions that are decidable from the contract alone are reported. Anything requiring a
 * trace to decide belongs in the evaluator, where it produces a violation with evidence rather than
 * a validation error with a guess.
 */
function checkCrossRuleConsistency(
  rules: readonly ContractRule[],
  approvedRoutes: readonly string[],
  gate: ContractGate,
  bag: ErrorBag,
): void {
  const ruleIds = new Set(rules.map((rule) => rule.id));
  const pathOf = (rule: ContractRule): string => indexPath("spec.rules", rules.indexOf(rule));

  for (const id of gate.zeroToleranceRuleIds) {
    if (ruleIds.has(id)) continue;
    bag.add(
      "spec.gate.zeroToleranceRuleIds",
      "UNKNOWN_RULE_REFERENCE",
      `Zero-tolerance rule "${id}" is not defined in spec.rules.`,
    );
  }

  const approved = new Set(approvedRoutes);
  for (const rule of rules) {
    if (rule.type !== "approved_routes") continue;
    for (const fingerprint of rule.fingerprints) {
      if (approved.has(fingerprint)) continue;
      bag.add(
        childPath(pathOf(rule), "fingerprints"),
        "UNKNOWN_ROUTE_REFERENCE",
        `Fingerprint ${fingerprint} is not listed in spec.approvedRoutes.`,
      );
    }
  }

  // A span that must appear and must not appear.
  const forbiddenSelectors = new Map<string, string>();
  for (const rule of rules) {
    if (rule.type === "forbidden_span") forbiddenSelectors.set(selectorKey(rule.selector), rule.id);
  }
  for (const rule of rules) {
    if (rule.type === "required_span" && rule.cardinality.min >= 1) {
      const conflict = forbiddenSelectors.get(selectorKey(rule.selector));
      if (conflict !== undefined) {
        bag.add(
          childPath(pathOf(rule), "selector"),
          "CONTRADICTORY_RULES",
          `This span is required by "${rule.id}" and forbidden by "${conflict}" using an identical selector.`,
        );
      }
    }
  }

  // Cardinality windows on one selector that cannot both hold.
  const windows = new Map<
    string,
    { readonly id: string; readonly min: number; readonly max: number }[]
  >();
  for (const rule of rules) {
    const entry =
      rule.type === "cardinality"
        ? { id: rule.id, min: rule.min, max: rule.max, key: selectorKey(rule.selector) }
        : rule.type === "required_span"
          ? {
              id: rule.id,
              min: rule.cardinality.min,
              max: rule.cardinality.max,
              key: selectorKey(rule.selector),
            }
          : undefined;
    if (entry === undefined) continue;
    const list = windows.get(entry.key) ?? [];
    list.push({ id: entry.id, min: entry.min, max: entry.max });
    windows.set(entry.key, list);
  }
  for (const list of windows.values()) {
    for (let left = 0; left < list.length; left += 1) {
      for (let right = left + 1; right < list.length; right += 1) {
        const a = list[left] as { id: string; min: number; max: number };
        const b = list[right] as { id: string; min: number; max: number };
        if (a.min <= b.max && b.min <= a.max) continue;
        const later = rules.find((rule) => rule.id === b.id);
        bag.add(
          later === undefined ? "spec.rules" : pathOf(later),
          "CONTRADICTORY_RULES",
          `Rule "${b.id}" allows ${b.min}..${b.max} occurrences while "${a.id}" allows ${a.min}..${a.max} of the same selector.`,
        );
      }
    }
  }

  // An attribute constrained to a value its own allowlist excludes. Only checked against an
  // allowlist that applies to every span, because a narrower allowlist may legitimately not cover
  // the spans the constraint selects.
  const allowlists = new Map<
    string,
    { readonly id: string; readonly values: ReadonlySet<string> }
  >();
  for (const rule of rules) {
    if (rule.type !== "allowed_values" || rule.selector !== undefined) continue;
    allowlists.set(rule.field, {
      id: rule.id,
      values: new Set(rule.values.map(scalarKey)),
    });
  }
  for (const rule of rules) {
    if (rule.type !== "attribute_constraint" || rule.operator !== "equals") continue;
    const allowlist = allowlists.get(rule.field);
    if (allowlist === undefined || rule.value === undefined || Array.isArray(rule.value)) continue;
    if (allowlist.values.has(scalarKey(rule.value as ScalarValue))) continue;
    bag.add(
      childPath(pathOf(rule), "value"),
      "CONTRADICTORY_RULES",
      `"${rule.id}" requires ${rule.field} to equal ${JSON.stringify(rule.value)}, which "${allowlist.id}" does not allow.`,
    );
  }
}

export type ValidationResult =
  | { readonly ok: true; readonly contract: TrajectoryContract }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

/**
 * Validates already-parsed contract data.
 *
 * Separate from YAML loading so a contract that arrives as JSON — from the API in Phase 09, or from
 * the baseline miner's proposal in Phase 08 — goes through exactly the same checks.
 */
export function validateContractValue(value: unknown, bag = new ErrorBag()): ValidationResult {
  if (!isPlainRecord(value)) {
    bag.add("$document", "INVALID_TYPE", "A contract document must be a mapping.");
    return { ok: false, errors: bag.toList() };
  }

  rejectUnknownKeys(value, DOCUMENT_KEYS, "", bag);

  const apiVersion = own(value, "apiVersion");
  if (apiVersion === undefined) {
    bag.add("apiVersion", "REQUIRED", '"apiVersion" is required.');
  } else if (apiVersion !== CONTRACT_API_VERSION) {
    bag.add(
      "apiVersion",
      "UNKNOWN_API_VERSION",
      `Unsupported apiVersion ${JSON.stringify(apiVersion)}. This build understands ${CONTRACT_API_VERSION}.`,
    );
  }

  const kind = own(value, "kind");
  if (kind === undefined) {
    bag.add("kind", "REQUIRED", '"kind" is required.');
  } else if (kind !== CONTRACT_KIND) {
    bag.add(
      "kind",
      "UNKNOWN_KIND",
      `Unsupported kind ${JSON.stringify(kind)}. Expected ${CONTRACT_KIND}.`,
    );
  }

  const metadata = validateMetadata(value, bag);
  const spec = validateSpec(value, bag);

  if (!bag.empty || metadata === undefined || spec === undefined) {
    return { ok: false, errors: bag.toList() };
  }

  return {
    ok: true,
    contract: { apiVersion: CONTRACT_API_VERSION, kind: CONTRACT_KIND, metadata, spec },
  };
}

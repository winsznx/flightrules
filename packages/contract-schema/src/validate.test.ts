import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalContractJson, contractContentHash, serialiseContract } from "./canonical.js";
import type { ValidationCode, ValidationError } from "./errors.js";
import { ErrorBag } from "./errors.js";
import { formatValidationErrors, parseContract, parseContractOrThrow } from "./parse.js";
import { readContractJsonSchema } from "./schema.js";
import { CONTRACT_LIMITS, RULE_TYPES } from "./types.js";
import { validateContractValue } from "./validate.js";
import { loadContractDocument } from "./yaml.js";

/**
 * Contract validation (PRD FR-009).
 *
 * The rejection tests assert on the exact path and the exact code, never on wording. A test that
 * matched on prose would pass after a message reword and fail to notice a path regression, and the
 * path is the part a Contract Studio editor needs in order to point at the offending line.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const DEMO_CONTRACT = path.join(
  REPO_ROOT,
  "contracts",
  "demo-commerce",
  "refund-agent",
  "production",
  "contract.yaml",
);
const FIXTURE_DIR = path.join(REPO_ROOT, "packages", "contract-engine", "fixtures", "contracts");

/**
 * Fixture contracts, enumerated from disk.
 *
 * Listing them here instead would let a new fixture be added without ever being validated, which is
 * exactly the gap these tests exist to close.
 */
function fixtureContractPaths(): readonly string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith(".yaml"))
    .sort()
    .map((name) => path.join(FIXTURE_DIR, name));
}

/** The document as plain data, for tests that need to modify it before validation. */
function loadDocument(source: string): Record<string, unknown> {
  const loaded = loadContractDocument(source, new ErrorBag());
  if (!loaded.ok)
    throw new Error(`fixture failed to load: ${formatValidationErrors(loaded.errors)}`);
  return loaded.value as Record<string, unknown>;
}

function base(overrides: string = ""): string {
  return `apiVersion: flightrules.dev/v1alpha1
kind: TrajectoryContract
metadata:
  id: sample
  name: Sample
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
  approvedRoutes: []
  rules:
${overrides === "" ? "    []\n" : overrides}  gate:
    minCompletedRuns: 1
    evaluationTimeoutSeconds: 60
    maxViolationPercent: 0
    maxUnknownRoutePercent: 0
    maxLatencyRegressionPercent: 10
    maxTokenRegressionPercent: 10
    zeroToleranceRuleIds: []
`;
}

function errorsOf(source: string): readonly ValidationError[] {
  const result = parseContract(source);
  return result.ok ? [] : result.errors;
}

function expectError(source: string, path: string, code: ValidationCode): void {
  const errors = errorsOf(source);
  const match = errors.find((error) => error.path === path && error.code === code);
  expect(
    match,
    `expected ${code} at ${path}, got:\n${formatValidationErrors(errors)}`,
  ).toBeDefined();
}

const REQUIRED_SPAN_RULE = `    - id: require-fraud-check
      type: required_span
      selector:
        name: fraud.check
      cardinality:
        min: 1
        max: 1
      severity: critical
`;

describe("valid contracts", () => {
  it("accepts the demo contract and reports all eleven rule types", () => {
    // #given the active production contract
    const result = parseContract(readFileSync(DEMO_CONTRACT, "utf8"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // #then every rule type the PRD defines is exercised by it
    const types = new Set(result.value.contract.spec.rules.map((rule) => rule.type));
    expect([...types].sort()).toEqual([...RULE_TYPES].sort());
  });

  it("accepts every per-rule fixture contract", () => {
    const files = fixtureContractPaths();
    expect(files.length).toBeGreaterThanOrEqual(16);

    for (const file of files) {
      const result = parseContract(readFileSync(file, "utf8"));
      expect(
        result.ok,
        `${path.basename(file)}: ${result.ok ? "" : formatValidationErrors(result.errors)}`,
      ).toBe(true);
    }
  });

  it("covers every rule type across the fixture contracts", () => {
    // #given every fixture
    const types = new Set<string>();
    for (const file of fixtureContractPaths()) {
      const result = parseContract(readFileSync(file, "utf8"));
      if (!result.ok) continue;
      for (const rule of result.value.contract.spec.rules) types.add(rule.type);
    }

    // #then all eleven rule types have a dedicated fixture
    expect([...types].sort()).toEqual([...RULE_TYPES].sort());
  });

  it("accepts a contract at the maximum permitted rule count", () => {
    const rules = Array.from(
      { length: CONTRACT_LIMITS.maxRules },
      (_, index) => `    - id: rule-${index}
      type: forbidden_span
      selector:
        name: never.happens.${index}
      severity: low
`,
    ).join("");

    const result = parseContract(base(rules));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.contract.spec.rules).toHaveLength(CONTRACT_LIMITS.maxRules);
  });

  it("accepts a rule identifier that shadows an Object prototype member", () => {
    // #given rule identifiers that would resolve through Object.prototype in a plain-object index
    const rules = ["constructor", "valueof", "hasownproperty"]
      .map(
        (id) => `    - id: ${id}
      type: forbidden_span
      selector:
        name: never.${id}
      severity: low
`,
      )
      .join("");

    const result = parseContract(base(rules));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.contract.spec.rules.map((rule) => rule.id)).toEqual([
        "constructor",
        "hasownproperty",
        "valueof",
      ]);
    }
  });
});

describe("rejected documents", () => {
  it("rejects an unknown apiVersion", () => {
    expectError(
      base().replace("flightrules.dev/v1alpha1", "flightrules.dev/v2"),
      "apiVersion",
      "UNKNOWN_API_VERSION",
    );
  });

  it("rejects an unknown kind", () => {
    expectError(base().replace("kind: TrajectoryContract", "kind: Policy"), "kind", "UNKNOWN_KIND");
  });

  it("rejects an unknown top-level field", () => {
    expectError(`${base()}extra: 1\n`, "extra", "UNKNOWN_FIELD");
  });

  it("rejects an unknown field inside a rule rather than discarding it", () => {
    // #given a plausible typo in a field name
    const source = base(REQUIRED_SPAN_RULE.replace("cardinality:", "cardinaltiy:"));

    // #then it is a rejection. Dropping it would leave the author believing a bound was enforced.
    expectError(source, "spec.rules[0].cardinaltiy", "UNKNOWN_FIELD");
    expectError(source, "spec.rules[0].cardinality", "REQUIRED");
  });

  it("rejects an unknown rule type", () => {
    expectError(
      base(REQUIRED_SPAN_RULE.replace("type: required_span", "type: required_thing")),
      "spec.rules[0].type",
      "UNKNOWN_RULE_TYPE",
    );
  });

  it("rejects a missing required field", () => {
    expectError(base().replace("  version: 1.0.0\n", ""), "metadata.version", "REQUIRED");
  });

  it("rejects an invalid field type", () => {
    expectError(
      base().replace("  minCompletedRuns: 1", "  minCompletedRuns: many"),
      "spec.gate.minCompletedRuns",
      "INVALID_TYPE",
    );
  });

  it("rejects an invalid enum value", () => {
    expectError(
      base(REQUIRED_SPAN_RULE.replace("severity: critical", "severity: catastrophic")),
      "spec.rules[0].severity",
      "INVALID_ENUM",
    );
  });

  it("rejects an impossible cardinality range with the exact path", () => {
    const source = base(
      REQUIRED_SPAN_RULE.replace(
        "        min: 1\n        max: 1",
        "        min: 3\n        max: 1",
      ),
    );
    const errors = errorsOf(source);
    expect(errors).toEqual([
      {
        path: "spec.rules[0].cardinality.max",
        code: "INVALID_RANGE",
        message: "max must be greater than or equal to min.",
      },
    ]);
  });

  it("rejects an inverted cardinality rule range", () => {
    expectError(
      base(`    - id: single-write
      type: cardinality
      selector:
        name: payment.refund
      min: 5
      max: 2
      scope: run
      severity: critical
`),
      "spec.rules[0].max",
      "INVALID_RANGE",
    );
  });

  it("rejects an invalid identifier", () => {
    expectError(
      base().replace("  id: sample", "  id: Sample Contract"),
      "metadata.id",
      "INVALID_IDENTIFIER",
    );
  });

  it("rejects a rule identifier starting with an underscore", () => {
    expectError(
      base(REQUIRED_SPAN_RULE.replace("id: require-fraud-check", "id: __proto__")),
      "spec.rules[0].id",
      "INVALID_IDENTIFIER",
    );
  });

  it("rejects a malformed timestamp", () => {
    expectError(
      base().replace("2026-07-25T00:00:00Z", "25/07/2026"),
      "metadata.createdAt",
      "INVALID_FORMAT",
    );
  });

  it("rejects a non-semantic version", () => {
    expectError(
      base().replace("  version: 1.0.0", "  version: v1"),
      "metadata.version",
      "INVALID_FORMAT",
    );
  });

  it("rejects duplicate rule identifiers, pointing at the later one", () => {
    expectError(
      base(`${REQUIRED_SPAN_RULE}${REQUIRED_SPAN_RULE}`),
      "spec.rules[1].id",
      "DUPLICATE_RULE_ID",
    );
  });

  it("rejects a selector that constrains nothing", () => {
    expectError(
      base(`    - id: matches-everything
      type: forbidden_span
      selector: {}
      severity: low
`),
      "spec.rules[0].selector",
      "EMPTY_SELECTOR",
    );
  });

  it("rejects an empty rule list where rules are required by the gate", () => {
    expectError(
      base().replace("zeroToleranceRuleIds: []", "zeroToleranceRuleIds: [nonexistent]"),
      "spec.gate.zeroToleranceRuleIds",
      "UNKNOWN_RULE_REFERENCE",
    );
  });

  it("rejects an empty value list", () => {
    expectError(
      base(`    - id: no-tools
      type: allowed_values
      field: gen_ai.tool.name
      values: []
      severity: low
`),
      "spec.rules[0].values",
      "LIST_EMPTY",
    );
  });

  it("rejects a duplicate value in an allowlist", () => {
    expectError(
      base(`    - id: dup-tools
      type: allowed_values
      field: gen_ai.tool.name
      values:
        - issue_refund
        - issue_refund
      severity: low
`),
      "spec.rules[0].values",
      "DUPLICATE_VALUE",
    );
  });

  it("rejects more rules than the limit", () => {
    const rules = Array.from(
      { length: CONTRACT_LIMITS.maxRules + 1 },
      (_, index) => `    - id: rule-${index}
      type: forbidden_span
      selector:
        name: never.${index}
      severity: low
`,
    ).join("");
    expectError(base(rules), "spec.rules", "LIST_TOO_LONG");
  });

  it("rejects a route fingerprint that is not a SHA-256 digest", () => {
    expectError(
      base().replace("approvedRoutes: []", "approvedRoutes: [not-a-hash]"),
      "spec.approvedRoutes[0]",
      "INVALID_FORMAT",
    );
  });

  it("rejects a rule referencing a route family the contract does not declare", () => {
    const digest = "a".repeat(64);
    expectError(
      base(`    - id: approved-only
      type: approved_routes
      fingerprints:
        - sha256:${digest}
      minSimilarity: 0.9
      severity: high
`),
      "spec.rules[0].fingerprints",
      "UNKNOWN_ROUTE_REFERENCE",
    );
  });

  it("rejects a threshold outside its range", () => {
    expectError(
      base().replace("maxViolationPercent: 0", "maxViolationPercent: 101"),
      "spec.gate.maxViolationPercent",
      "INVALID_RANGE",
    );
  });

  it("rejects a threshold with more precision than can be held exactly", () => {
    expectError(
      base().replace("maxViolationPercent: 0", "maxViolationPercent: 0.12345678"),
      "spec.gate.maxViolationPercent",
      "INVALID_NUMBER",
    );
  });

  it("rejects an unsafe integer", () => {
    expectError(
      base().replace("minCompletedRuns: 1", "minCompletedRuns: 99999999999999999999"),
      "spec.gate.minCompletedRuns",
      "INVALID_NUMBER",
    );
  });

  it("rejects a fractional value where a whole number is required", () => {
    expectError(
      base(REQUIRED_SPAN_RULE.replace("        max: 1", "        max: 1.5")),
      "spec.rules[0].cardinality.max",
      "INVALID_NUMBER",
    );
  });

  it("rejects an uncompilable regular expression", () => {
    expectError(
      base(`    - id: bad-pattern
      type: forbidden_span
      selector:
        namePattern: "(?:a)"
      severity: low
`),
      "spec.rules[0].selector.namePattern",
      "INVALID_PATTERN",
    );
  });

  it("rejects a regular expression long enough to be an abuse vector", () => {
    expectError(
      base(`    - id: huge-pattern
      type: forbidden_span
      selector:
        namePattern: "${"a".repeat(300)}"
      severity: low
`),
      "spec.rules[0].selector.namePattern",
      "STRING_TOO_LONG",
    );
  });

  it("rejects both name and namePattern on one selector", () => {
    expectError(
      base(`    - id: two-names
      type: forbidden_span
      selector:
        name: payment.refund
        namePattern: "payment"
      severity: low
`),
      "spec.rules[0].selector.namePattern",
      "CONTRADICTORY_RULES",
    );
  });

  it("rejects an operator and value whose arities disagree", () => {
    expectError(
      base(`    - id: exists-with-value
      type: attribute_constraint
      selector:
        name: payment.refund
      field: agent.side_effect
      operator: exists
      value: write
      severity: low
`),
      "spec.rules[0].value",
      "UNKNOWN_FIELD",
    );
  });

  it("rejects an in operator without a list", () => {
    expectError(
      base(`    - id: in-without-list
      type: attribute_constraint
      selector:
        name: payment.refund
      field: agent.side_effect
      operator: in
      value: write
      severity: low
`),
      "spec.rules[0].value",
      "INVALID_TYPE",
    );
  });

  it("rejects a percentile aggregation at run scope", () => {
    expectError(
      base(`    - id: run-p95
      type: numeric_budget
      metric: run.duration_ms
      aggregation: p95
      max: 100
      scope: run
      severity: low
`),
      "spec.rules[0].aggregation",
      "INVALID_ENUM",
    );
  });

  it("rejects a metric FlightRules cannot compute", () => {
    expectError(
      base(`    - id: unknown-metric
      type: numeric_budget
      metric: cost.usd
      aggregation: sum
      max: 100
      scope: run
      severity: low
`),
      "spec.rules[0].metric",
      "INVALID_ENUM",
    );
  });

  it("rejects a budgets block that would never be enforced", () => {
    expectError(
      base().replace("  approvedRoutes: []", "  budgets:\n    latency: 100\n  approvedRoutes: []"),
      "spec.budgets",
      "UNKNOWN_FIELD",
    );
  });

  it("accepts an empty budgets block, which PRD section 10.2 shows", () => {
    const result = parseContract(
      base().replace("  approvedRoutes: []", "  budgets: {}\n  approvedRoutes: []"),
    );
    expect(result.ok).toBe(true);
  });
});

describe("statically detectable contradictions", () => {
  it("detects a span that is both required and forbidden", () => {
    expectError(
      base(`${REQUIRED_SPAN_RULE}    - id: forbid-fraud-check
      type: forbidden_span
      selector:
        name: fraud.check
      severity: critical
`),
      "spec.rules[0].selector",
      "CONTRADICTORY_RULES",
    );
  });

  it("detects two cardinality windows on one selector that cannot both hold", () => {
    expectError(
      base(`    - id: at-least-two
      type: cardinality
      selector:
        name: payment.refund
      min: 2
      max: 5
      scope: run
      severity: high
    - id: at-most-one
      type: cardinality
      selector:
        name: payment.refund
      min: 0
      max: 1
      scope: run
      severity: critical
`),
      "spec.rules[1]",
      "CONTRADICTORY_RULES",
    );
  });

  it("detects a constraint requiring a value its own allowlist excludes", () => {
    expectError(
      base(`    - id: approved-tools
      type: allowed_values
      field: gen_ai.tool.name
      values:
        - issue_refund
      severity: high
    - id: must-use-transfer
      type: attribute_constraint
      selector:
        name: payment.refund
      field: gen_ai.tool.name
      operator: equals
      value: issue_transfer
      severity: critical
`),
      "spec.rules[1].value",
      "CONTRADICTORY_RULES",
    );
  });

  it("detects a self-referential ancestry rule", () => {
    expectError(
      base(`    - id: own-ancestor
      type: required_ancestry
      ancestor:
        name: payment.refund
      descendant:
        name: payment.refund
      relationship: any_depth
      severity: high
`),
      "spec.rules[0].descendant",
      "CONTRADICTORY_RULES",
    );
  });

  it("detects a retry budget whose per-tool allowance can never be reached", () => {
    expectError(
      base(`    - id: unreachable
      type: retry_budget
      selector:
        operation: execute_tool
      maxPerTool: 5
      maxRunTotal: 2
      sideEffectMax: 0
      severity: high
`),
      "spec.rules[0].maxPerTool",
      "INVALID_RANGE",
    );
  });
});

describe("error reporting", () => {
  it("reports every error at once rather than the first", () => {
    const source = base()
      .replace("  id: sample", "  id: Bad Id")
      .replace("  version: 1.0.0", "  version: v1")
      .replace("flightrules.dev/v1alpha1", "flightrules.dev/v9");

    const errors = errorsOf(source);
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  it("sorts errors deterministically", () => {
    const source = `${base().replace("  id: sample", "  id: Bad Id")}zzz: 1\naaa: 2\n`;
    const first = errorsOf(source);
    const second = errorsOf(source);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.map((error) => error.path)).toEqual([...first.map((error) => error.path)].sort());
  });

  it("throws CONTRACT_INVALID with the errors attached when asked to throw", () => {
    expect(() => parseContractOrThrow("apiVersion: nope")).toThrowError(
      expect.objectContaining({ code: "CONTRACT_INVALID" }),
    );
  });
});

describe("canonical form and content hash", () => {
  const demo = (): string => readFileSync(DEMO_CONTRACT, "utf8");

  it("hashes identically when rules are declared in a different order", () => {
    // #given the same rules, reordered
    const original = parseContract(demo());
    expect(original.ok).toBe(true);
    if (!original.ok) return;

    const document = loadDocument(demo());
    const spec = document["spec"] as { readonly rules: readonly unknown[] };
    const reversed = validateContractValue({
      ...document,
      spec: { ...spec, rules: [...spec.rules].reverse() },
    });

    expect(reversed.ok).toBe(true);
    if (!reversed.ok) return;

    // #then the content hash is unchanged: declaration order is not policy
    expect(contractContentHash(reversed.contract)).toBe(
      contractContentHash(original.value.contract),
    );
  });

  it("hashes identically when the document is reformatted", () => {
    const original = parseContract(demo());
    // Comments stripped and blank lines collapsed: a reformat, not a policy change.
    const reformatted = parseContract(
      demo()
        .split("\n")
        .filter((line) => !line.trim().startsWith("#") && line.trim().length > 0)
        .join("\n"),
    );

    expect(original.ok && reformatted.ok).toBe(true);
    if (!original.ok || !reformatted.ok) return;
    expect(reformatted.value.contentHash).toBe(original.value.contentHash);
  });

  it("hashes identically when the name or creation time changes", () => {
    const original = parseContract(demo());
    const renamed = parseContract(
      demo()
        .replace("name: Refund Agent Production Contract", "name: Renamed Contract")
        .replace("createdAt: 2026-07-25T00:00:00Z", "createdAt: 2027-01-01T00:00:00Z"),
    );

    expect(original.ok && renamed.ok).toBe(true);
    if (!original.ok || !renamed.ok) return;
    // #then editorial metadata does not invalidate an approval
    expect(renamed.value.contentHash).toBe(original.value.contentHash);
  });

  it("hashes differently when any enforceable value changes", () => {
    const original = parseContract(demo());
    const loosened = parseContract(demo().replace("      max: 500", "      max: 5000"));

    expect(original.ok && loosened.ok).toBe(true);
    if (!original.ok || !loosened.ok) return;
    expect(loosened.value.contentHash).not.toBe(original.value.contentHash);
  });

  it("hashes differently when the semantic version changes", () => {
    const original = parseContract(demo());
    const bumped = parseContract(demo().replace("  version: 1.0.0", "  version: 1.0.1"));
    expect(original.ok && bumped.ok).toBe(true);
    if (!original.ok || !bumped.ok) return;
    expect(bumped.value.contentHash).not.toBe(original.value.contentHash);
  });

  it("produces byte-identical serialisation on repeated parses", () => {
    const first = parseContract(demo());
    const second = parseContract(demo());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(serialiseContract(second.value.contract)).toBe(serialiseContract(first.value.contract));
    expect(canonicalContractJson(second.value.contract)).toBe(
      canonicalContractJson(first.value.contract),
    );
  });
});

describe("the published JSON Schema agrees with the validator", () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile(readContractJsonSchema() as object);

  it("accepts every contract the validator accepts", () => {
    for (const file of [DEMO_CONTRACT, ...fixtureContractPaths()]) {
      const source = readFileSync(file, "utf8");
      const parsed = parseContract(source);
      if (!parsed.ok) continue;

      const loaded = loadContractDocument(source, new ErrorBag());
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) continue;

      const ok = validate(loaded.value);
      expect(ok, `${path.basename(file)}: ${ajv.errorsText(validate.errors)}`).toBe(true);
    }
  });

  it("rejects the structural cases the validator rejects", () => {
    // Only structural cases. Cross-field consistency — duplicate identifiers, impossible ranges,
    // contradictions — is out of scope for a JSON Schema by construction, and the schema says so.
    const structural: readonly string[] = [
      base().replace("flightrules.dev/v1alpha1", "flightrules.dev/v2"),
      base().replace("kind: TrajectoryContract", "kind: Policy"),
      `${base()}extra: 1\n`,
      base().replace("  version: 1.0.0\n", ""),
      base(REQUIRED_SPAN_RULE.replace("type: required_span", "type: required_thing")),
      base(REQUIRED_SPAN_RULE.replace("severity: critical", "severity: catastrophic")),
      base(REQUIRED_SPAN_RULE.replace("cardinality:", "cardinaltiy:")),
      base().replace("  id: sample", "  id: Sample Contract"),
      base().replace("approvedRoutes: []", "approvedRoutes: [not-a-hash]"),
    ];

    for (const source of structural) {
      expect(parseContract(source).ok).toBe(false);
      const loaded = loadContractDocument(source, new ErrorBag());
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) continue;
      expect(validate(loaded.value), `schema accepted: ${source.slice(0, 60)}`).toBe(false);
    }
  });
});

describe("property: validation is total and deterministic", () => {
  it("never throws on arbitrary structured input", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        validateContractValue(value as unknown, new ErrorBag());
        return true;
      }),
      { numRuns: 1_000 },
    );
  });

  it("returns an identical error list for identical input", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const first = validateContractValue(value as unknown, new ErrorBag());
        const second = validateContractValue(value as unknown, new ErrorBag());
        return JSON.stringify(first) === JSON.stringify(second);
      }),
      { numRuns: 500 },
    );
  });

  it("never accepts a document missing apiVersion", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue(), { maxKeys: 6 }), (record) => {
        if (Object.hasOwn(record, "apiVersion")) return true;
        return validateContractValue(record as unknown, new ErrorBag()).ok === false;
      }),
      { numRuns: 500 },
    );
  });
});

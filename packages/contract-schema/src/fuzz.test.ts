import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseContract } from "./index.js";
import { CONTRACT_LIMITS } from "./types.js";

/**
 * Adversarial input against the contract parser and validator (PRD Phase 16 task 3).
 *
 * The parser sits inside the determinism boundary and decides what rules a release is judged
 * against, so its failure modes are not cosmetic: a document that crashes it stops a release
 * being evaluated at all, and a document it accepts wrongly changes what "pass" means.
 *
 * Three properties are asserted over every input, hostile or not:
 *
 *   1. it never throws — an invalid contract is a typed diagnostic list, not an exception;
 *   2. it is deterministic — the same source always produces the same answer, byte for byte;
 *   3. it never leaves `Object.prototype` modified.
 *
 * The named cases below each pin a specific attack. A case that the parser already refuses is
 * still worth pinning: these are the inputs a future change would silently start accepting.
 */

const VALID = `apiVersion: flightrules.dev/v1alpha1
kind: TrajectoryContract
metadata:
  id: fuzz-baseline
  name: Fuzz baseline
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
    rootSpan: refund.request
  approvedRoutes: []
  rules:
    - id: require-fraud-check
      type: required_span
      selector:
        name: fraud.check
      cardinality:
        min: 1
        max: 1
      severity: critical
  gate:
    minCompletedRuns: 1
    evaluationTimeoutSeconds: 60
    maxViolationPercent: 0
    maxUnknownRoutePercent: 0
    maxLatencyRegressionPercent: 10
    maxTokenRegressionPercent: 10
    zeroToleranceRuleIds: [require-fraud-check]
`;

/** Replaces one line of the valid document, so each case differs from the baseline in one way. */
function withRule(ruleYaml: string): string {
  return VALID.replace(
    `    - id: require-fraud-check
      type: required_span
      selector:
        name: fraud.check
      cardinality:
        min: 1
        max: 1
      severity: critical`,
    ruleYaml,
  );
}

function codesOf(source: string): readonly string[] {
  const result = parseContract(source);
  return result.ok ? [] : [...new Set(result.errors.map((error) => error.code))].sort();
}

function rejects(source: string): boolean {
  return !parseContract(source).ok;
}

describe("the parser accepts the baseline it is fuzzed against", () => {
  it("parses the valid document", () => {
    const result = parseContract(VALID);
    expect(result.ok).toBe(true);
  });
});

describe("YAML-level attacks", () => {
  const cases: readonly [string, string][] = [
    ["unterminated flow mapping", "apiVersion: {"],
    ["tab indentation", "apiVersion:\tflightrules.dev/v1alpha1"],
    ["a bare document that is not a mapping", "- just\n- a\n- list\n"],
    ["a scalar document", "hello\n"],
    ["an empty document", "   \n\n"],
    ["an anchor", VALID.replace("metadata:", "metadata: &anchor")],
    ["an alias", `${VALID}\nextra: *anchor\n`],
    [
      "an alias bomb",
      "a: &a [x,x,x,x,x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: [*b,*b,*b,*b,*b,*b,*b,*b,*b]\n",
    ],
    ["a binary tag", VALID.replace("  id: fuzz-baseline", "  id: !!binary aGVsbG8=")],
    ["a timestamp tag", VALID.replace("  id: fuzz-baseline", "  id: !!timestamp 2026-01-01")],
    [
      "an unresolved language tag",
      VALID.replace("  id: fuzz-baseline", "  id: !!python/object:os.system"),
    ],
    [
      "a duplicate key",
      VALID.replace("kind: TrajectoryContract", "kind: TrajectoryContract\nkind: Other"),
    ],
  ];

  it.each(cases)("refuses %s without throwing", (_name, source) => {
    expect(() => parseContract(source)).not.toThrow();
    expect(rejects(source)).toBe(true);
  });

  it("refuses excessive nesting depth deterministically", () => {
    // Bounded before `toJS`, so the rejection does not depend on the available stack.
    const depth = CONTRACT_LIMITS.maxNestingDepth + 20;
    const source = `${"a:\n".repeat(0)}${"  ".repeat(0)}${buildNested(depth)}`;
    expect(rejects(source)).toBe(true);
    expect(codesOf(source)).toEqual(codesOf(source));
  });

  it("refuses a document past the byte limit before parsing it", () => {
    const source = `# ${"x".repeat(CONTRACT_LIMITS.maxSourceBytes + 1)}\n`;
    expect(codesOf(source)).toContain("SOURCE_TOO_LARGE");
  });

  it("refuses a document past the line limit", () => {
    // Non-blank lines: a document of only newlines trims to empty and is refused earlier, which
    // is correct but tests a different bound.
    const source = "# comment\n".repeat(CONTRACT_LIMITS.maxSourceLines + 2);
    expect(codesOf(source)).toContain("SOURCE_TOO_MANY_LINES");
  });

  it("refuses a scalar longer than the string limit", () => {
    const source = VALID.replace("  name: Fuzz baseline", `  name: ${"n".repeat(5_000)}`);
    expect(rejects(source)).toBe(true);
  });
});

function buildNested(depth: number): string {
  let body = "value";
  for (let level = 0; level < depth; level += 1) body = `[${body}]`;
  return `apiVersion: ${body}\n`;
}

describe("numeric hazards", () => {
  const cases: readonly [string, string][] = [
    ["infinity", VALID.replace("    maxViolationPercent: 0", "    maxViolationPercent: .inf")],
    [
      "negative infinity",
      VALID.replace("    maxViolationPercent: 0", "    maxViolationPercent: -.inf"),
    ],
    ["not-a-number", VALID.replace("    maxViolationPercent: 0", "    maxViolationPercent: .nan")],
    [
      "an integer beyond 2^53",
      VALID.replace("    minCompletedRuns: 1", "    minCompletedRuns: 99999999999999999999999"),
    ],
    ["a negative budget", VALID.replace("    minCompletedRuns: 1", "    minCompletedRuns: -5")],
    [
      "a negative cardinality",
      withRule(`    - id: require-fraud-check
      type: required_span
      selector:
        name: fraud.check
      cardinality:
        min: -1
        max: 1
      severity: critical`),
    ],
    [
      "a cardinality whose max is below its min",
      withRule(`    - id: require-fraud-check
      type: required_span
      selector:
        name: fraud.check
      cardinality:
        min: 5
        max: 2
      severity: critical`),
    ],
  ];

  it.each(cases)("refuses %s", (_name, source) => {
    expect(rejects(source)).toBe(true);
  });
});

describe("prototype-shaped keys arrive as data, never as prototype mutation", () => {
  const KEYS = ["__proto__", "constructor", "prototype", "toString"];

  it.each(KEYS)("does not let a top-level %s key change Object.prototype", (key) => {
    // #given a document carrying the key at the top level
    const source = `${VALID}${key}:\n  polluted: true\n`;

    // #when it is parsed
    expect(() => parseContract(source)).not.toThrow();

    // #then nothing was added to the prototype chain
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it.each(KEYS)("does not let a %s key inside a rule selector pollute", (key) => {
    const source = withRule(`    - id: require-fraud-check
      type: required_span
      selector:
        name: fraud.check
        attributes:
          - key: ${key}
            operator: equals
            value: polluted
      cardinality:
        min: 1
        max: 1
      severity: critical`);

    expect(() => parseContract(source)).not.toThrow();
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
});

describe("structural validation", () => {
  it("refuses an unknown apiVersion", () => {
    expect(rejects(VALID.replace("flightrules.dev/v1alpha1", "flightrules.dev/v99"))).toBe(true);
  });

  it("refuses an unknown kind", () => {
    expect(rejects(VALID.replace("kind: TrajectoryContract", "kind: SomethingElse"))).toBe(true);
  });

  it("refuses an unknown top-level field", () => {
    expect(rejects(`${VALID}unexpectedField: 1\n`)).toBe(true);
  });

  it("refuses an unknown rule type", () => {
    expect(rejects(VALID.replace("      type: required_span", "      type: made_up_rule"))).toBe(
      true,
    );
  });

  it("refuses an invalid selector operator", () => {
    const source = withRule(`    - id: require-fraud-check
      type: required_span
      selector:
        name: fraud.check
        attributes:
          - key: agent.step.category
            operator: sounds_like
            value: fraud
      cardinality:
        min: 1
        max: 1
      severity: critical`);
    expect(rejects(source)).toBe(true);
  });

  it("refuses two rules sharing an identifier", () => {
    const source = withRule(`    - id: require-fraud-check
      type: required_span
      selector:
        name: fraud.check
      cardinality:
        min: 1
        max: 1
      severity: critical
    - id: require-fraud-check
      type: required_span
      selector:
        name: policy.retrieve
      cardinality:
        min: 1
        max: 1
      severity: critical`);
    expect(rejects(source)).toBe(true);
  });

  it("refuses an identifier past the length limit", () => {
    const long = "r".repeat(CONTRACT_LIMITS.maxIdentifierLength + 1);
    expect(rejects(VALID.replace("    - id: require-fraud-check", `    - id: ${long}`))).toBe(true);
  });

  it("refuses more rules than the limit allows", () => {
    const rules = Array.from(
      { length: CONTRACT_LIMITS.maxRules + 1 },
      (_unused, index) => `    - id: rule-${String(index)}
      type: required_span
      selector:
        name: fraud.check
      cardinality:
        min: 1
        max: 1
      severity: critical`,
    ).join("\n");
    expect(rejects(withRule(rules))).toBe(true);
  });
});

describe("hostile text in a contract", () => {
  const HOSTILE = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "../../etc/passwd",
    "\u0000\u0001\u001b[31m",
    "\u202eevil",
    "`backtick`",
    '"quote"',
    "line\nbreak",
  ];

  it.each(HOSTILE)("never throws on %j as a span name", (value) => {
    const source = withRule(`    - id: require-fraud-check
      type: required_span
      selector:
        name: ${JSON.stringify(value)}
      cardinality:
        min: 1
        max: 1
      severity: critical`);
    expect(() => parseContract(source)).not.toThrow();
  });

  it("accepts or refuses hostile text consistently, never intermittently", () => {
    for (const value of HOSTILE) {
      const source = withRule(`    - id: require-fraud-check
      type: required_span
      selector:
        name: ${JSON.stringify(value)}
      cardinality:
        min: 1
        max: 1
      severity: critical`);
      expect(codesOf(source)).toEqual(codesOf(source));
    }
  });
});

describe("properties that hold for any input at all", () => {
  it("never throws, whatever the bytes are", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 4_000 }), (source) => {
        expect(() => parseContract(source)).not.toThrow();
      }),
      { numRuns: 400 },
    );
  });

  it("never throws on arbitrary Unicode, including surrogates and control characters", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 2_000 }), (source) => {
        expect(() => parseContract(source)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });

  it("answers the same way twice for the same source", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2_000 }), (source) => {
        expect(codesOf(source)).toEqual(codesOf(source));
      }),
      { numRuns: 200 },
    );
  });

  it("never leaves Object.prototype modified", () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    fc.assert(
      fc.property(
        fc.string({ maxLength: 1_000 }),
        fc.constantFrom("__proto__", "constructor", "prototype", "toString"),
        (noise, key) => {
          parseContract(`${key}:\n  x: 1\n${noise}`);
        },
      ),
      { numRuns: 200 },
    );
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
  });

  it("never throws on any prefix of a valid document", () => {
    // A truncated document is the most common malformed input in practice: a half-written file, a
    // truncated upload. Some prefixes are legitimately still valid — dropping trailing whitespace
    // changes nothing — so the invariant is that no prefix crashes and none gains a rule.
    const full = parseContract(VALID);
    const ruleCount = full.ok ? full.value.contract.spec.rules.length : 0;
    fc.assert(
      fc.property(fc.integer({ min: 1, max: VALID.length }), (cut) => {
        const result = parseContract(VALID.slice(0, cut));
        if (result.ok)
          expect(result.value.contract.spec.rules.length).toBeLessThanOrEqual(ruleCount);
      }),
      { numRuns: 300 },
    );
  });
});

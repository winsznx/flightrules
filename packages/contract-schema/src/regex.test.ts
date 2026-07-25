import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compilePattern, matchPattern, REGEX_LIMITS } from "./regex.js";

/**
 * The RE2-compatible matcher.
 *
 * Two claims have to be proven rather than asserted: that it agrees with a reference engine on the
 * subset it supports, and that no input can make it backtrack. The property test covers the first by
 * comparing against `RegExp` on generated pattern and input pairs; the timing tests cover the second
 * by running the patterns that make a backtracking engine hang.
 */

function matches(pattern: string, input: string): boolean {
  const compiled = compilePattern(pattern);
  if (!compiled.ok)
    throw new Error(`pattern rejected: ${compiled.error.code} ${compiled.error.message}`);
  return matchPattern(compiled.pattern, input);
}

describe("supported syntax", () => {
  const cases: readonly (readonly [string, string, boolean])[] = [
    ["abc", "abc", true],
    ["abc", "xabcx", true],
    ["abc", "ab", false],
    ["^abc", "xabc", false],
    ["^abc$", "abc", true],
    ["^abc$", "abcd", false],
    ["a*", "", true],
    ["a*", "aaaa", true],
    ["a+", "", false],
    ["a+", "aaa", true],
    ["a?b", "b", true],
    ["a?b", "ab", true],
    ["a|b", "b", true],
    ["a|b", "c", false],
    ["(ab)+", "abab", true],
    ["[a-c]+", "bbb", true],
    ["[^a-c]", "a", false],
    ["[^a-c]", "d", true],
    ["[.]", ".", true],
    ["[a-]", "-", true],
    ["^\\d{3}$", "123", true],
    ["^\\d{3}$", "12", false],
    ["^\\d{2,4}$", "12345", false],
    ["^\\d{2,}$", "12345", true],
    ["x{0,3}y", "y", true],
    [".", "\n", false],
    ["a.c", "abc", true],
    ["\\w+", "hello_9", true],
    ["\\s", "x y", true],
    ["\\W", "a", false],
    ["\\S", " ", false],
    ["payment\\.refund", "payment.refund", true],
    ["payment\\.refund", "paymentXrefund", false],
    ["^order\\.[a-z]+$", "order.lookup", true],
    ["^order\\.[a-z]+$", "order.lookup.handler", false],
    ["^(refund|payment)\\.[a-z]+$", "payment.refund", true],
    ["toString", "toString", true],
    ["^__proto__$", "__proto__", true],
    ["[0-9a-f]{4}", "beef", true],
  ];

  for (const [pattern, input, expected] of cases) {
    it(`${JSON.stringify(pattern)} against ${JSON.stringify(input)} is ${expected}`, () => {
      // #then the engine agrees with the expectation and with the reference implementation
      expect(matches(pattern, input)).toBe(expected);
      expect(new RegExp(pattern).test(input)).toBe(expected);
    });
  }

  it("matches over code points, not UTF-16 units", () => {
    expect(matches("^.$", "😀")).toBe(true);
  });

  it("follows RE2, not JavaScript, where the two disagree on a leading ] in a class", () => {
    // #given `[]a]`, which RE2 and POSIX read as a class containing `]` and `a`, and which
    // JavaScript reads as an empty class followed by the literals `a]`
    const pattern = "[]a]";

    // #then this engine follows RE2, because the PRD requires RE2 compatibility
    expect(matches(pattern, "]")).toBe(true);
    expect(matches(pattern, "a")).toBe(true);

    // #and the divergence from JavaScript is real, not incidental. Built through the constructor
    // from a variable, because a literal would be an empty character class that the linter — quite
    // correctly — rejects, and the point here is precisely that JavaScript reads it that way.
    expect(new RegExp(pattern).test("]")).toBe(false);
  });
});

describe("rejected syntax", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["", "PATTERN_EMPTY"],
    ["(?:a)", "PATTERN_UNSUPPORTED"],
    ["(?=a)b", "PATTERN_UNSUPPORTED"],
    ["(?<name>a)", "PATTERN_UNSUPPORTED"],
    ["a**", "PATTERN_UNSUPPORTED"],
    ["\\b", "PATTERN_UNSUPPORTED"],
    ["\\B", "PATTERN_UNSUPPORTED"],
    ["(a)\\1", "PATTERN_UNSUPPORTED"],
    ["\\p{L}", "PATTERN_UNSUPPORTED"],
    ["[\\D]", "PATTERN_UNSUPPORTED"],
    ["(a", "PATTERN_SYNTAX"],
    ["a)", "PATTERN_SYNTAX"],
    ["[a", "PATTERN_SYNTAX"],
    ["[]", "PATTERN_SYNTAX"],
    ["[z-a]", "PATTERN_SYNTAX"],
    ["*a", "PATTERN_SYNTAX"],
    ["a{5,2}", "PATTERN_SYNTAX"],
    [`a{${REGEX_LIMITS.maxRepeat + 1}}`, "PATTERN_REPEAT_TOO_LARGE"],
    ["a{99999}", "PATTERN_REPEAT_TOO_LARGE"],
  ];

  for (const [pattern, code] of cases) {
    it(`rejects ${JSON.stringify(pattern)} as ${code}`, () => {
      const result = compilePattern(pattern);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(code);
    });
  }

  it("rejects a pattern longer than the limit", () => {
    const result = compilePattern("a".repeat(REGEX_LIMITS.maxPatternLength + 1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PATTERN_TOO_LONG");
  });

  it("rejects a pattern whose bounded repetition would expand past the program limit", () => {
    // #given repetition nested inside repetition through groups, which is legal syntax
    const result = compilePattern(`(${"ab".repeat(20)}){${REGEX_LIMITS.maxRepeat}}`);

    // #then it is refused at compile time rather than expanded
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PATTERN_TOO_COMPLEX");
  });

  it("reports an offset for a positional failure", () => {
    const result = compilePattern("ab(?:c)");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.offset).toBe(2);
  });
});

describe("no backtracking is possible", () => {
  /** Patterns that make a backtracking engine take exponential time. */
  const bombs: readonly string[] = ["(a+)+$", "(a|a)*$", "(a|aa)+$", "^(a*)*b", "(x+x+)+y"];

  for (const pattern of bombs) {
    it(`${pattern} stays linear on a 5,000-character adversarial input`, () => {
      // #given the input that maximises backtracking: all matching characters, no final match
      const input = `${"a".repeat(5_000)}b`.replace(/a/g, pattern.includes("x") ? "x" : "a");
      const compiled = compilePattern(pattern);
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) return;

      // #when matched
      const started = process.hrtime.bigint();
      const result = matchPattern(compiled.pattern, input);
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

      // #then it completes in milliseconds. A backtracking engine does not return at all.
      expect(typeof result).toBe("boolean");
      expect(elapsedMs).toBeLessThan(1_000);
    });
  }

  it("refuses an input longer than the limit rather than scanning it", () => {
    const compiled = compilePattern("a+");
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(matchPattern(compiled.pattern, "a".repeat(REGEX_LIMITS.maxInputLength + 1))).toBe(false);
  });
});

/**
 * Generators over the supported subset.
 *
 * Deliberately built from safe fragments rather than from arbitrary strings: an arbitrary string is
 * almost never a valid pattern, so a naive generator would spend its budget on rejections and prove
 * nothing about matching.
 */
const literal = fc.constantFrom("a", "b", "c", "0", "1", "_", "\\.", "\\-");
const atom = fc.oneof(
  literal,
  fc.constantFrom(".", "\\d", "\\w", "\\s", "[a-c]", "[^a-c]", "[0-9]", "[abc]"),
);
const quantified = fc
  .tuple(atom, fc.constantFrom("", "*", "+", "?", "{1,2}", "{2}", "{0,3}"))
  .map(([base, quantifier]) => `${base}${quantifier}`);
const sequence = fc
  .array(quantified, { minLength: 1, maxLength: 5 })
  .map((parts) => parts.join(""));
const alternation = fc
  .array(sequence, { minLength: 1, maxLength: 3 })
  .map((parts) => (parts.length === 1 ? (parts[0] as string) : `(${parts.join("|")})`));
const anchored = fc
  .tuple(fc.boolean(), alternation, fc.boolean())
  .map(([start, body, end]) => `${start ? "^" : ""}${body}${end ? "$" : ""}`);

const input = fc.stringMatching(/^[abc019_.\- ]{0,12}$/);

describe("property: agrees with the reference engine", () => {
  it("returns the same verdict as RegExp for every generated pattern and input", () => {
    fc.assert(
      fc.property(anchored, input, (pattern, text) => {
        const compiled = compilePattern(pattern);
        // A generated pattern the engine declines is not a counterexample; the claim is about the
        // subset it accepts.
        if (!compiled.ok) return true;
        return matchPattern(compiled.pattern, text) === new RegExp(pattern).test(text);
      }),
      { numRuns: 2_000 },
    );
  });

  it("never throws, whatever it is given", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.string({ maxLength: 40 }), (pattern, text) => {
        const compiled = compilePattern(pattern);
        if (!compiled.ok) return true;
        matchPattern(compiled.pattern, text);
        return true;
      }),
      { numRuns: 2_000 },
    );
  });

  it("is deterministic: the same pattern and input always give the same answer", () => {
    fc.assert(
      fc.property(anchored, input, (pattern, text) => {
        const first = compilePattern(pattern);
        const second = compilePattern(pattern);
        if (!first.ok || !second.ok) return first.ok === second.ok;
        return matchPattern(first.pattern, text) === matchPattern(second.pattern, text);
      }),
      { numRuns: 1_000 },
    );
  });
});

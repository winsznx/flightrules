// The 2020-12 entry point, not ajv's default export, which only understands draft-07. The schema
// declares draft 2020-12, so compiling it with the wrong dialect would fail on `$defs` resolution.
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { ErrorBag, type ValidationCode } from "./errors.js";
import { readContractJsonSchema } from "./schema.js";
import { CONTRACT_LIMITS } from "./types.js";
import { loadContractDocument, YAML_PARSE_OPTIONS } from "./yaml.js";

/**
 * YAML security model.
 *
 * Every case here corresponds to an observed behaviour of `yaml@2.9.0` recorded in the source lock.
 * Three of them exist because the parser's options and diagnostics are **not** sufficient: `!!binary`
 * and `!!timestamp` are resolved silently, and an unresolved tag produces only a warning.
 */

function codesFor(source: string): readonly ValidationCode[] {
  const result = loadContractDocument(source, new ErrorBag());
  return result.ok ? [] : result.errors.map((error) => error.code);
}

const MINIMAL = `apiVersion: flightrules.dev/v1alpha1
kind: TrajectoryContract
metadata:
  id: c
`;

describe("safe YAML loading", () => {
  describe("resource exhaustion", () => {
    it("rejects an alias amplification bomb", () => {
      // #given the classic billion-laughs shape
      const source = [
        'a: &a ["x","x","x","x","x","x","x","x","x"]',
        "b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]",
        "c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]",
        "d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]",
        "e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]",
        "f: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]",
      ].join("\n");

      // #then it is refused for using anchors and aliases at all, not merely bounded
      expect(codesFor(source)).toContain("YAML_ALIAS_FORBIDDEN");
    });

    it("rejects even a single harmless alias", () => {
      // #given an alias a human might write on purpose
      // #then it is still refused: a contract must state its rules in full, and bounded alias
      // expansion is a weaker position than none
      expect(codesFor("a: &x 1\nb: *x")).toContain("YAML_ALIAS_FORBIDDEN");
    });

    it("rejects an anchor even when nothing references it", () => {
      expect(codesFor("a: &unused 1")).toContain("YAML_ANCHOR_FORBIDDEN");
    });

    it("rejects a document larger than the byte limit", () => {
      const source = `${MINIMAL}filler: "${"x".repeat(CONTRACT_LIMITS.maxSourceBytes)}"\n`;
      expect(codesFor(source)).toEqual(["SOURCE_TOO_LARGE"]);
    });

    it("rejects a document with more lines than the limit", () => {
      const source = `${"# comment\n".repeat(CONTRACT_LIMITS.maxSourceLines + 1)}${MINIMAL}`;
      expect(codesFor(source)).toEqual(["SOURCE_TOO_MANY_LINES"]);
    });

    it("rejects nesting beyond the depth limit before the parser's own stack limit is reached", () => {
      // #given flow nesting deeper than the contract limit but far short of a stack overflow
      const depth = CONTRACT_LIMITS.maxNestingDepth + 5;
      const source = `a: ${"[".repeat(depth)}1${"]".repeat(depth)}`;

      // #then the rejection is the contract's own deterministic depth bound
      expect(codesFor(source)).toContain("YAML_TOO_DEEP");
    });

    it("rejects nesting deep enough to overflow the parser without crashing", () => {
      // #given nesting far past what the parser can construct
      const source = `a: ${"[".repeat(4_000)}1${"]".repeat(4_000)}`;

      // #then the failure is reported, not thrown
      const codes = codesFor(source);
      expect(codes.length).toBeGreaterThan(0);
      expect(codes.every((code) => code.startsWith("YAML_"))).toBe(true);
    });

    it("rejects an empty document", () => {
      expect(codesFor("   \n\n")).toEqual(["SOURCE_EMPTY"]);
    });
  });

  describe("unsafe construction", () => {
    it("rejects an unresolved tag that the parser only warns about", () => {
      // #given a tag the parser cannot resolve. It parses to the plain string "x" and produces only
      // a TAG_RESOLVE_FAILED warning, so accepting the parse would accept the document.
      expect(codesFor('a: !!python/object:os.system "x"')).toContain("YAML_TAG_FORBIDDEN");
    });

    it("rejects !!binary, which the parser resolves to a Buffer with no error and no warning", () => {
      expect(codesFor("a: !!binary aGk=")).toContain("YAML_TAG_FORBIDDEN");
    });

    it("rejects !!timestamp, which the parser resolves to a Date with no error and no warning", () => {
      expect(codesFor("a: !!timestamp 2020-01-01")).toContain("YAML_TAG_FORBIDDEN");
    });

    it("rejects a local application tag", () => {
      expect(codesFor("a: !Foo {b: 1}")).toContain("YAML_TAG_FORBIDDEN");
    });

    it("rejects an explicit tag even on a safe type", () => {
      // #given `!!str 5`, which is harmless
      // #then it is still refused. The defence is "no explicit tags", which is auditable; a
      // per-tag allowlist would need to stay ahead of every tag the parser can resolve.
      expect(codesFor("a: !!str 5")).toContain("YAML_TAG_FORBIDDEN");
    });

    it("rejects duplicate map keys", () => {
      expect(codesFor("a: 1\na: 2")).toContain("YAML_DUPLICATE_KEY");
    });

    it("rejects more than one document", () => {
      expect(codesFor("a: 1\n---\nb: 2")).toContain("YAML_MALFORMED");
    });

    it("rejects tab indentation", () => {
      expect(codesFor("a:\n\tb: 1")).toContain("YAML_MALFORMED");
    });
  });

  describe("unsafe numerics", () => {
    it("rejects infinity", () => {
      expect(codesFor("a: .inf")).toContain("INVALID_NUMBER");
    });

    it("rejects not-a-number", () => {
      expect(codesFor("a: .nan")).toContain("INVALID_NUMBER");
    });

    it("rejects an integer that silently loses precision", () => {
      // #given a value the parser converts to 1e+23
      // #then it is refused rather than stored as an approximation
      expect(codesFor("a: 99999999999999999999999")).toContain("INVALID_NUMBER");
    });

    it("accepts the largest exactly representable integer", () => {
      const result = loadContractDocument(`a: ${Number.MAX_SAFE_INTEGER}`, new ErrorBag());
      expect(result.ok).toBe(true);
    });
  });

  describe("prototype-shaped keys", () => {
    it("keeps __proto__ as ordinary data without polluting any prototype", () => {
      // #given a document with a literal __proto__ key
      const result = loadContractDocument("__proto__:\n  polluted: 1\nb: 2", new ErrorBag());

      // #then the key is data, and nothing global changed
      expect(result.ok).toBe(true);
      const value = (result as { readonly value: Record<string, unknown> }).value;
      expect(Object.keys(value).sort()).toEqual(["__proto__", "b"]);
      expect(Object.getPrototypeOf({})).toBe(Object.prototype);
      expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    });

    it("accepts constructor and toString as keys", () => {
      const result = loadContractDocument(
        "constructor: 1\ntoString: 2\nvalueOf: 3",
        new ErrorBag(),
      );
      expect(result.ok).toBe(true);
    });
  });

  describe("the dialect is locked", () => {
    it("disables alias resolution outright", () => {
      expect(YAML_PARSE_OPTIONS.maxAliasCount).toBe(0);
    });

    it("requires unique keys and refuses merge keys", () => {
      expect(YAML_PARSE_OPTIONS.uniqueKeys).toBe(true);
      expect(YAML_PARSE_OPTIONS.merge).toBe(false);
    });

    it("pins the YAML version", () => {
      expect(YAML_PARSE_OPTIONS.version).toBe("1.2");
    });
  });

  it("accepts a plain document", () => {
    const result = loadContractDocument(MINIMAL, new ErrorBag());
    expect(result.ok).toBe(true);
  });
});

describe("the published JSON Schema", () => {
  it("is itself a valid JSON Schema", () => {
    // #given the published file
    const schema = readContractJsonSchema();

    // #then a real validator can compile it. A schema nobody compiles is a document, not a contract.
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    expect(() => ajv.compile(schema)).not.toThrow();
  });

  it("declares the eleven rule types and nothing else", () => {
    const schema = readContractJsonSchema() as {
      readonly $defs: { readonly rule: { readonly oneOf: readonly { readonly $ref: string }[] } };
    };
    expect(schema.$defs.rule.oneOf).toHaveLength(11);
  });
});

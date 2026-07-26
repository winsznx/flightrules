import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_NORMALISER_CONFIG, hashNormaliserConfig, identityOf } from "./config.js";
import { detokenise, isLongHex, isUlid, isUuid, tokenise } from "./identifiers.js";
import { classify, normaliseAttributes, normaliseName, toSafeAttributeValue } from "./normalise.js";

const config = DEFAULT_NORMALISER_CONFIG;

describe("normaliseName", () => {
  it("replaces a numeric path segment", () => {
    // #given the example from PRD FR-005
    expect(normaliseName("/orders/98271/refund", config)).toBe("/orders/{id}/refund");
  });

  it("replaces a prefixed identifier while keeping the prefix", () => {
    // #given a run identifier, where the prefix carries the meaning and the suffix does not
    expect(normaliseName("run_01JABCDEFGHJKMNPQRSTVWXYZ", config)).toBe("run_{id}");
  });

  it("replaces a customer identifier", () => {
    expect(normaliseName("customer-4f92c1", config)).toBe("customer-{id}");
  });

  it("replaces a UUID anywhere in a path", () => {
    expect(normaliseName("/v1/agents/6ba7b810-9dad-11d1-80b4-00c04fd430c8/runs", config)).toBe(
      "/v1/agents/{id}/runs",
    );
  });

  it("replaces a long hex token such as a trace id", () => {
    expect(normaliseName("trace/f176194973362b659a75c030fd40f028", config)).toBe("trace/{id}");
  });

  it("leaves a short hex-looking word alone", () => {
    // #given a genuine name that happens to be hexadecimal characters
    // #then it survives: rewriting it would destroy real route identity
    expect(normaliseName("/api/beef/list", config)).toBe("/api/beef/list");
  });

  it("leaves an ordinary span name untouched", () => {
    expect(normaliseName("payment.refund", config)).toBe("payment.refund");
  });

  it("trims and Unicode-normalises before anything else", () => {
    // #given the same name in decomposed and composed Unicode forms
    const decomposed = "  café.lookup  ";
    const composed = "café.lookup";

    // #then both normalise to one value, so an encoding difference is not a route difference
    expect(normaliseName(decomposed, config)).toBe(normaliseName(composed, config));
  });

  it("applies a configured alias before identifier replacement", () => {
    // #given an alias for a raw name
    const aliased = { ...config, aliases: { "legacy.refund": "payment.refund" } };

    // #then the alias wins
    expect(normaliseName("legacy.refund", aliased)).toBe("payment.refund");
  });

  it("is idempotent", () => {
    // #given any name, normalising twice must equal normalising once, or a fingerprint would
    // depend on how many times the pipeline happened to run
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (value) => {
        const once = normaliseName(value, config);
        return normaliseName(once, config) === once;
      }),
      { numRuns: 500 },
    );
  });

  it("never throws on arbitrary external input", () => {
    // #given span names are external input and a parser failure would be a denial of service
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (value) => {
        normaliseName(value, config);
        return true;
      }),
      { numRuns: 500 },
    );
  });

  it("completes quickly on a long adversarial input", () => {
    // #given the kind of input that defeats a backtracking regular expression
    const adversarial = `${"a".repeat(50_000)}!`;

    const started = performance.now();
    normaliseName(adversarial, config);

    // #then recognition is linear, so PRD section 18.1's regex denial-of-service path is closed
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("identifier recognition", () => {
  it("accepts a canonical UUID", () => {
    expect(isUuid("6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(true);
  });

  it("rejects a UUID-length string with a misplaced hyphen", () => {
    expect(isUuid("6ba7b8109-dad-11d1-80b4-00c04fd430c8")).toBe(false);
  });

  it("accepts a ULID", () => {
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
  });

  it("rejects a ULID containing an excluded letter", () => {
    // #given Crockford base32 excludes I, L, O and U
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAI")).toBe(false);
  });

  it("rejects a 26-character string whose first character exceeds the timestamp range", () => {
    expect(isUlid("81ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(false);
  });

  it("requires at least sixteen characters for a long hex token", () => {
    expect(isLongHex("abcdef0123456789")).toBe(true);
    expect(isLongHex("abcdef012345678")).toBe(false);
  });
});

describe("tokenise", () => {
  it("round-trips any string", () => {
    // #given rewriting a token must be able to put it back exactly where it was
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (value) => detokenise(tokenise(value)) === value),
      { numRuns: 500 },
    );
  });
});

describe("normaliseAttributes", () => {
  it("splits identity-bearing attributes from evidence", () => {
    // #given a span carrying both kinds
    const { fingerprint, evidence } = normaliseAttributes(
      { "agent.side_effect": "write", "agent.scenario": "approved-refund" },
      config,
    );

    // #then only the allowlisted attribute reaches identity
    expect(fingerprint).toEqual({ "agent.side_effect": "write" });
    expect(evidence["agent.scenario"]).toBe("approved-refund");
  });

  it("drops a volatile attribute from both outputs", () => {
    // #given a run identifier, which cannot affect identity and has no reason to be stored
    const { fingerprint, evidence } = normaliseAttributes({ "agent.run.id": "run_abc" }, config);

    expect(fingerprint["agent.run.id"]).toBeUndefined();
    expect(evidence["agent.run.id"]).toBeUndefined();
  });

  it("lower-cases a configured case-insensitive attribute", () => {
    const { fingerprint } = normaliseAttributes({ "agent.side_effect": "WRITE" }, config);
    expect(fingerprint["agent.side_effect"]).toBe("write");
  });

  it("sorts a set-valued attribute", () => {
    // #given an array whose order carries no meaning
    const { evidence } = normaliseAttributes({ "custom.tags": ["b", "a", "c"] }, config);

    // #then it is sorted, so arrival order cannot reach a comparison
    expect(evidence["custom.tags"]).toEqual(["a", "b", "c"]);
  });

  it("produces the same result for any key order", () => {
    // #given the same attributes declared in a different order
    const a = normaliseAttributes(
      { "agent.side_effect": "read", "agent.data_domain": "orders" },
      config,
    );
    const b = normaliseAttributes(
      { "agent.data_domain": "orders", "agent.side_effect": "read" },
      config,
    );

    // #then serialisation matches, which is what FR-006 requires of key order
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("drops an empty string rather than treating it as a value", () => {
    const { fingerprint } = normaliseAttributes({ "agent.side_effect": "" }, config);
    expect(fingerprint["agent.side_effect"]).toBeUndefined();
  });
});

describe("toSafeAttributeValue", () => {
  it("rejects an object rather than stringifying it", () => {
    // #given a nested value, whose stringification would carry key order into the fingerprint
    expect(toSafeAttributeValue({ nested: true })).toBeNull();
  });

  it("rejects a non-finite number", () => {
    expect(toSafeAttributeValue(Number.NaN)).toBeNull();
    expect(toSafeAttributeValue(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("keeps an array of scalars", () => {
    expect(toSafeAttributeValue(["a", 1, true])).toEqual(["a", 1, true]);
  });

  it("rejects a mixed array containing an object", () => {
    expect(toSafeAttributeValue(["a", {}])).toBeNull();
  });
});

describe("classify", () => {
  it("resolves an unclassified side effect to unknown, never to none", () => {
    // #given a span nobody classified
    // #then the gap is visible: "performed no write" and "nobody said" must not collapse, or an
    // uninstrumented service would silently satisfy a rule forbidding duplicate writes
    expect(classify({}, config).sideEffect).toBe("unknown");
  });

  it("reads the side effect case-insensitively", () => {
    expect(classify({ "agent.side_effect": "WRITE" }, config).sideEffect).toBe("write");
  });

  it("reads a retry number supplied as a string", () => {
    // #given SigNoz returns some numeric tags as strings depending on the selected data type
    expect(classify({ "agent.retry.number": "2" }, config).retryNumber).toBe(2);
  });

  it("normalises a tool name carrying an identifier", () => {
    expect(
      classify({ "gen_ai.tool.name": "tools/6ba7b810-9dad-11d1-80b4-00c04fd430c8" }, config)
        .toolName,
    ).toBe("tools/{id}");
  });

  it("leaves the demo's real tool names untouched", () => {
    // #given the tool names the instrumented agent actually emits
    for (const tool of ["issue_refund", "lookup_order", "check_fraud", "retrieve_policy"]) {
      // #then normalisation does not damage a genuine name
      expect(classify({ "gen_ai.tool.name": tool }, config).toolName).toBe(tool);
    }
  });

  it("does not resolve a span name through the prototype chain", () => {
    // #given a span named after a built-in, which a bare object index would resolve to a function
    expect(normaliseName("toString", config)).toBe("toString");
    expect(normaliseName("valueOf", config)).toBe("valueOf");
    expect(normaliseName("constructor", config)).toBe("constructor");
  });

  it("reports a missing retry number as null rather than zero", () => {
    // #given no retry attribute; zero would claim a first attempt was explicitly recorded
    expect(classify({}, config).retryNumber).toBeNull();
  });

  it("rejects a negative retry number rather than reading it as a retry count", () => {
    // #given a span claiming a negative attempt index, which no zero-based counter can produce
    // #then it carries no retry evidence, so it can neither add to nor subtract from a retry budget
    expect(classify({ "agent.retry.number": -1 }, config).retryNumber).toBeNull();
    expect(classify({ "agent.retry.number": -5 }, config).retryNumber).toBeNull();
  });

  it("keeps zero as an explicitly recorded first attempt", () => {
    // #given the value the instrumented demo actually emits for an unretried step
    expect(classify({ "agent.retry.number": 0 }, config).retryNumber).toBe(0);
  });
});

describe("configuration identity", () => {
  it("hashes identically regardless of declaration order", () => {
    // #given the same rules with arrays declared in a different order
    const reordered = {
      ...config,
      volatileAttributes: [...config.volatileAttributes].reverse(),
      fingerprintAttributes: [...config.fingerprintAttributes].reverse(),
    };

    // #then the hash is unchanged, so a cosmetic edit does not invalidate stored fingerprints
    expect(hashNormaliserConfig(reordered)).toBe(hashNormaliserConfig(config));
  });

  it("changes when a rule actually changes", () => {
    // #given one attribute moved out of route identity
    const changed = { ...config, fingerprintAttributes: ["agent.side_effect"] };

    // #then the hash differs, which is what proves the version should have been bumped
    expect(hashNormaliserConfig(changed)).not.toBe(hashNormaliserConfig(config));
  });

  it("reports a version and a 64-character hash", () => {
    const identity = identityOf(config);
    expect(identity.version).toBe("1.0.0");
    expect(identity.configHash).toHaveLength(64);
  });
});

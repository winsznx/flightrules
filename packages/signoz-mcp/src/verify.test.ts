import { FlightRulesError } from "@flightrules/domain";
import { describe, expect, it } from "vitest";
import { buildTraceQuery, isHexToken, toSpanRows } from "./operations.js";
import type { McpResult } from "./outcome.js";
import { identifierOf, itemsOf } from "./readers.js";
import { builderQueryPayloadSchema, listPayloadSchema } from "./schemas.js";
import { assertVerified, createAndVerify, deepEquals, readPath } from "./verify.js";

/**
 * The create-then-verify contract from PRD section 16.5. A successful write response is not proof
 * that the resource is correct, so these tests exist mainly to prove the mismatch is detected.
 */

type Created = { data: { id: string } };
type Fetched = { data: Record<string, unknown> };

function success<T>(value: T, rowCount = 1): McpResult<T> {
  return {
    tool: "test",
    notices: [],
    durationMs: 1,
    outcome: "SUCCESS_WITH_ROWS",
    value,
    rowCount,
  };
}

function emptySuccess<T>(): McpResult<T> {
  return { tool: "test", notices: [], durationMs: 1, outcome: "SUCCESS_EMPTY", rowCount: 0 };
}

function failure<T>(): McpResult<T> {
  return {
    tool: "test",
    notices: [],
    durationMs: 1,
    outcome: "MCP_ERROR",
    code: "TRACE_QUERY_FAILED",
    reason: "upstream rejected the write",
  };
}

interface PlanOverrides {
  readonly stored?: Record<string, unknown>;
  readonly existingNames?: readonly string[];
  readonly createResult?: McpResult<Created>;
  readonly fetchResult?: McpResult<Fetched>;
}

function planFor(overrides: PlanOverrides = {}) {
  const stored = overrides.stored ?? {
    name: "FlightRules / demo / refund-agent / Violating Runs",
    sourcePage: "traces",
    compositeQuery: { queries: [{ spec: { filter: { expression: "has_error = true" } } }] },
  };

  return {
    name: "FlightRules / demo / refund-agent / Violating Runs",
    materialFields: {
      name: "FlightRules / demo / refund-agent / Violating Runs",
      sourcePage: "traces",
      "compositeQuery.queries.0.spec.filter.expression": "has_error = true",
    },
    listExisting: async () =>
      success((overrides.existingNames ?? []).map((name) => ({ id: `id-${name}`, name }))),
    findExisting: (value: unknown) => {
      const rows = value as { id: string; name: string }[];
      return rows.find((row) => row.name === "FlightRules / demo / refund-agent / Violating Runs")
        ?.id;
    },
    create: async () => overrides.createResult ?? success<Created>({ data: { id: "view-1" } }),
    identifierOf: (value: Created) => value.data.id,
    fetch: async () => overrides.fetchResult ?? success<Fetched>({ data: stored }),
    resourceOf: (value: Fetched) => value.data,
  };
}

describe("createAndVerify", () => {
  it("verifies a resource whose material fields survived the round trip", async () => {
    // #given a create whose read-back matches the specification
    const result = await createAndVerify(planFor());

    // #then the write is verified and every compared field matched
    expect(result.status).toBe("VERIFIED");
    expect(result.status === "VERIFIED" && result.comparisons.every((c) => c.matches)).toBe(true);
  });

  it("detects a mismatched resource rather than trusting the create response", async () => {
    // #given a server that stored a different filter from the one submitted
    const result = await createAndVerify(
      planFor({
        stored: {
          name: "FlightRules / demo / refund-agent / Violating Runs",
          sourcePage: "traces",
          compositeQuery: { queries: [{ spec: { filter: { expression: "has_error = false" } } }] },
        },
      }),
    );

    // #then the mismatch is named, and a successful create response did not hide it
    expect(result.status).toBe("MISMATCHED");
    expect(result.status === "MISMATCHED" && result.mismatchedFields).toEqual([
      "compositeQuery.queries.0.spec.filter.expression",
    ]);
  });

  it("detects a field the server dropped entirely", async () => {
    // #given a read-back with no sourcePage
    const result = await createAndVerify(
      planFor({
        stored: {
          name: "FlightRules / demo / refund-agent / Violating Runs",
          compositeQuery: { queries: [{ spec: { filter: { expression: "has_error = true" } } }] },
        },
      }),
    );

    // #then the absent field is reported as a mismatch, not silently accepted
    expect(result.status === "MISMATCHED" && result.mismatchedFields).toContain("sourcePage");
  });

  it("refuses to create when the name is already taken", async () => {
    // #given an existing resource with the same managed name
    const result = await createAndVerify(
      planFor({ existingNames: ["FlightRules / demo / refund-agent / Violating Runs"] }),
    );

    // #then no create is attempted, closing the duplicate-artifact path
    expect(result.status).toBe("NAME_COLLISION");
  });

  it("reports a failed create without attempting a read-back", async () => {
    // #given a create the server rejected
    const result = await createAndVerify(planFor({ createResult: failure<Created>() }));

    // #then the failure is propagated
    expect(result.status).toBe("CREATE_FAILED");
  });

  it("treats a create that returned no identifier as unusable", async () => {
    // #given a create that succeeded but returned nothing
    const result = await createAndVerify(planFor({ createResult: emptySuccess<Created>() }));

    // #then it is a failure, because there is nothing to verify against
    expect(result.status).toBe("CREATE_FAILED");
    expect(result.status === "CREATE_FAILED" && result.failure.reason).toContain(
      "no resource identifier",
    );
  });

  it("reports a resource that was created but cannot be read back", async () => {
    // #given a read-back that fails
    const result = await createAndVerify(planFor({ fetchResult: failure<Fetched>() }));

    // #then the identifier is retained so the operator can find the orphan
    expect(result.status).toBe("READBACK_FAILED");
    expect(result.status === "READBACK_FAILED" && result.id).toBe("view-1");
  });
});

describe("assertVerified", () => {
  it("passes a verified write through", async () => {
    const result = await createAndVerify(planFor());
    expect(() => assertVerified(result)).not.toThrow();
  });

  it("raises ARTIFACT_VERIFY_FAILED for a mismatch", async () => {
    // #given a mismatched write
    const result = await createAndVerify(
      planFor({ stored: { name: "something else", sourcePage: "traces" } }),
    );

    // #when it is asserted
    // #then the PRD's verification error code is used
    try {
      assertVerified(result);
      expect.unreachable("a mismatched write must not pass verification");
    } catch (error) {
      expect(error).toBeInstanceOf(FlightRulesError);
      expect((error as FlightRulesError).code).toBe("ARTIFACT_VERIFY_FAILED");
    }
  });

  it("raises ARTIFACT_CREATE_FAILED for a name collision", async () => {
    const result = await createAndVerify(
      planFor({ existingNames: ["FlightRules / demo / refund-agent / Violating Runs"] }),
    );
    try {
      assertVerified(result);
      expect.unreachable("a collision must not pass verification");
    } catch (error) {
      expect((error as FlightRulesError).code).toBe("ARTIFACT_CREATE_FAILED");
    }
  });
});

describe("readPath", () => {
  it("reads a nested field by dotted path", () => {
    expect(readPath({ a: { b: { c: 1 } } }, "a.b.c")).toBe(1);
  });

  it("indexes into an array", () => {
    expect(readPath({ queries: [{ name: "A" }] }, "queries.0.name")).toBe("A");
  });

  it("returns undefined for a path that does not exist", () => {
    expect(readPath({ a: 1 }, "a.b.c")).toBeUndefined();
  });

  it("does not reach outside the resource through a prototype key", () => {
    // #given a path naming a prototype property
    // #then nothing from the prototype chain is returned as if it were resource data
    expect(readPath({ a: 1 }, "constructor.name")).not.toBe("Object");
  });
});

describe("deepEquals", () => {
  it("ignores key ordering, which SigNoz does not preserve", () => {
    expect(deepEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it("respects array ordering, which is meaningful in a query", () => {
    expect(deepEquals([1, 2], [2, 1])).toBe(false);
  });

  it("distinguishes a missing key from an undefined value", () => {
    expect(deepEquals({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  });
});

describe("buildTraceQuery", () => {
  it("always supplies a positive limit and a non-empty order", () => {
    // #given a query specification
    const query = buildTraceQuery({
      filter: "trace_id = 'abc'",
      selectFields: [{ name: "span_id", context: "span" }],
      startMs: 1000,
      endMs: 2000,
      limit: 50,
    });

    // #then both are present; omitting either makes the server substitute its own and append an
    // advisory, which means it answered a different question from the one asked
    const spec = (query["compositeQuery"] as { queries: { spec: Record<string, unknown> }[] })
      .queries[0]?.spec;
    expect(spec?.["limit"]).toBe(50);
    expect(spec?.["order"]).toEqual([{ key: { name: "timestamp" }, direction: "asc" }]);
  });

  it("uses tag as the field context for custom attributes", () => {
    // #given a custom attribute selection
    const query = buildTraceQuery({
      filter: "",
      selectFields: [{ name: "agent.side_effect", context: "tag" }],
      startMs: 1,
      endMs: 2,
      limit: 1,
    });

    // #then `tag` is used, not the `attribute` alias the discovery tools accept
    const spec = (query["compositeQuery"] as { queries: { spec: Record<string, unknown> }[] })
      .queries[0]?.spec;
    const fields = spec?.["selectFields"] as { fieldContext: string }[];
    expect(fields[0]?.fieldContext).toBe("tag");
  });

  it("sends the window as start and end rather than an inline timestamp filter", () => {
    // #given a bounded window
    const query = buildTraceQuery({
      filter: "trace_id = 'abc'",
      selectFields: [],
      startMs: 1_700_000_000_000,
      endMs: 1_700_000_060_000,
      limit: 10,
    });

    // #then the milliseconds go in start/end; the timestamp column is nanoseconds and filtering
    // on it inline compares different units
    expect(query["start"]).toBe(1_700_000_000_000);
    expect(query["end"]).toBe(1_700_000_060_000);
  });

  it("rejects a non-positive limit", () => {
    expect(() =>
      buildTraceQuery({ filter: "", selectFields: [], startMs: 1, endMs: 2, limit: 0 }),
    ).toThrow(RangeError);
  });

  it("rejects a window that ends before it starts", () => {
    expect(() =>
      buildTraceQuery({ filter: "", selectFields: [], startMs: 100, endMs: 10, limit: 1 }),
    ).toThrow(RangeError);
  });
});

describe("isHexToken", () => {
  it("accepts a real trace id", () => {
    expect(isHexToken("f176194973362b659a75c030fd40f028")).toBe(true);
  });

  it("rejects a value carrying a quote, closing the filter-injection path", () => {
    expect(isHexToken("abc' OR '1'='1")).toBe(false);
  });

  it("rejects an empty value", () => {
    expect(isHexToken("")).toBe(false);
  });
});

describe("toSpanRows", () => {
  it("rejects a row with no span id and counts it separately", () => {
    // #given a payload where one row cannot take part in graph reconstruction
    const payload = builderQueryPayloadSchema.parse({
      status: "success",
      data: {
        data: {
          results: [
            {
              queryName: "A",
              rows: [{ data: { span_id: "s1", name: "a" } }, { data: { name: "orphan" } }],
            },
          ],
        },
      },
    });

    // #when span rows are read
    const { spans, rejected } = toSpanRows(payload);

    // #then the usable row is returned and the unusable one is counted, not silently dropped
    expect(spans).toHaveLength(1);
    expect(rejected).toBe(1);
  });

  it("keeps every attribute alongside the validated fields", () => {
    // #given a row carrying custom attributes
    const payload = builderQueryPayloadSchema.parse({
      status: "success",
      data: {
        data: {
          results: [
            { queryName: "A", rows: [{ data: { span_id: "s1", "agent.side_effect": "write" } }] },
          ],
        },
      },
    });

    // #then the raw attributes remain available to the graph layer
    expect(toSpanRows(payload).spans[0]?.attributes["agent.side_effect"]).toBe("write");
  });
});

describe("list readers", () => {
  it("treats a null data array as an empty list", () => {
    expect(itemsOf(listPayloadSchema.parse({ data: null }))).toEqual([]);
  });

  it("reads an identifier returned as an object", () => {
    expect(identifierOf({ data: { id: "abc" } })).toBe("abc");
  });

  it("reads an identifier returned as a bare string", () => {
    expect(identifierOf({ data: "abc" })).toBe("abc");
  });
});

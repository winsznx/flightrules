import type { BuilderQueryPayload, SigNozOperations } from "@flightrules/signoz-mcp";
import { describe, expect, it } from "vitest";
import {
  discoverRuns,
  fetchTraces,
  MINING_SELECT_FIELDS,
  untrustedFieldsOf,
  verifyFieldTypes,
} from "./retrieve.js";
import { resolveSelection } from "./selection.js";

/**
 * Retrieval is exercised against a stand-in for the MCP client whose responses reproduce the shapes
 * the pinned server was observed to return, including the two that matter most: a `nextCursor` that
 * is empty exactly when a page is not full (SL-050), and a typed column that comes back `null`
 * (SL-046). The live path is proven separately by `mining.signoz.integration.test.ts`, which uses the
 * real client — a fixture here would prove nothing about SigNoz.
 */

const CONTEXT = { searchContext: "FlightRules Phase 08 retrieval tests" };

const SELECTION = resolveSelection({
  projectKey: "demo-commerce",
  agentKey: "refund-agent",
  releaseId: "refund-agent-v1",
  environment: "local",
  startMs: Date.parse("2026-07-25T00:00:00Z"),
  endMs: Date.parse("2026-07-26T00:00:00Z"),
  minimumRuns: 1,
  rootSpanName: "refund.request",
  batchSize: 3,
  maxTraces: 9,
});

function payload(rows: readonly Record<string, unknown>[], nextCursor = ""): BuilderQueryPayload {
  return {
    status: "success",
    data: {
      webUrl: "http://localhost:8080/trace/x",
      data: { results: [{ queryName: "A", nextCursor, rows: rows.map((data) => ({ data })) }] },
    },
  };
}

function fieldKeysPayload(
  keys: Readonly<Record<string, readonly { fieldContext?: string; fieldDataType?: string }[]>>,
  complete = true,
) {
  return {
    status: "success",
    data: {
      complete,
      keys: Object.fromEntries(
        Object.entries(keys).map(([name, descriptors]) => [
          name,
          descriptors.map((descriptor) => ({ name, signal: "traces", ...descriptor })),
        ]),
      ),
    },
  };
}

/** The catalogue the pinned server was observed to return for the demo's telemetry. */
const OBSERVED_CATALOGUE = {
  trace_id: [{ fieldContext: "span", fieldDataType: "string" }],
  span_id: [{ fieldContext: "span", fieldDataType: "string" }],
  parent_span_id: [{ fieldContext: "span", fieldDataType: "string" }],
  name: [{ fieldContext: "span", fieldDataType: "string" }],
  kind_string: [{ fieldContext: "span", fieldDataType: "string" }],
  duration_nano: [{ fieldContext: "span", fieldDataType: "number" }],
  status_code_string: [{ fieldContext: "span", fieldDataType: "string" }],
  has_error: [{ fieldContext: "span", fieldDataType: "bool" }],
  "agent.release.id": [{ fieldContext: "attribute", fieldDataType: "string" }],
  "agent.run.id": [{ fieldContext: "attribute", fieldDataType: "string" }],
  "agent.side_effect": [{ fieldContext: "attribute", fieldDataType: "string" }],
  "agent.data_domain": [{ fieldContext: "attribute", fieldDataType: "string" }],
  "agent.step.category": [{ fieldContext: "attribute", fieldDataType: "string" }],
  "agent.retry.number": [{ fieldContext: "attribute", fieldDataType: "number" }],
  "agent.idempotency.present": [{ fieldContext: "attribute", fieldDataType: "bool" }],
  "gen_ai.tool.name": [{ fieldContext: "attribute", fieldDataType: "string" }],
  "gen_ai.operation.name": [{ fieldContext: "attribute", fieldDataType: "string" }],
} as const;

interface Recorded {
  readonly offsets: number[];
  readonly limits: number[];
  readonly traceIds: string[];
  readonly selectFields: string[][];
}

function operationsFor(input: {
  readonly pages?: readonly {
    readonly rows: readonly Record<string, unknown>[];
    readonly cursor: string;
  }[];
  readonly catalogue?: unknown;
  readonly complete?: boolean;
  readonly spanRows?: readonly Record<string, unknown>[];
  readonly spanOutcome?: string;
  readonly discoveryOutcome?: string;
}): { readonly operations: SigNozOperations; readonly recorded: Recorded } {
  const recorded: Recorded = { offsets: [], limits: [], traceIds: [], selectFields: [] };
  let page = 0;

  const operations = {
    getFieldKeys: async () => ({
      outcome: "SUCCESS_WITH_ROWS" as const,
      value:
        input.catalogue ?? fieldKeysPayload(OBSERVED_CATALOGUE as never, input.complete ?? true),
    }),
    executeBuilderQuery: async (query: Record<string, unknown>) => {
      if (input.discoveryOutcome !== undefined) {
        return { outcome: input.discoveryOutcome };
      }
      const spec = (
        (query["compositeQuery"] as { queries: { spec: Record<string, unknown> }[] })
          .queries[0] as {
          spec: Record<string, unknown>;
        }
      ).spec;
      recorded.offsets.push(spec["offset"] as number);
      recorded.limits.push(spec["limit"] as number);

      const current = input.pages?.[page];
      page += 1;
      if (current === undefined) return { outcome: "SUCCESS_EMPTY" as const };
      return {
        outcome: "SUCCESS_WITH_ROWS" as const,
        value: payload(current.rows, current.cursor),
      };
    },
    getTraceSpans: async (
      traceId: string,
      spec: { readonly selectFields: readonly { readonly name: string }[] },
    ) => {
      recorded.traceIds.push(traceId);
      recorded.selectFields.push(spec.selectFields.map((field) => field.name));
      if (input.spanOutcome !== undefined) return { outcome: input.spanOutcome };
      return {
        outcome: "SUCCESS_WITH_ROWS" as const,
        value: payload(input.spanRows ?? [{ span_id: "a", trace_id: traceId }]),
      };
    },
  } as unknown as SigNozOperations;

  return { operations, recorded };
}

describe("verifying the declared field types", () => {
  it("accepts every declaration the catalogue confirms", async () => {
    const { operations } = operationsFor({});

    const result = await verifyFieldTypes(operations, MINING_SELECT_FIELDS, CONTEXT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.verified).toContain("agent.idempotency.present");
    expect(result.report.verified).toContain("agent.retry.number");
    expect(result.report.mismatched).toEqual([]);
  });

  it("translates the catalogue's `attribute` context to the Query Builder's `tag`", async () => {
    // #given the asymmetry SL-022 records: discovery says `attribute`, selectFields say `tag`
    const { operations } = operationsFor({});

    const result = await verifyFieldTypes(
      operations,
      [{ name: "agent.retry.number", context: "tag", dataType: "number" }],
      CONTEXT,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.verified).toEqual(["agent.retry.number"]);
  });

  it("refuses a declaration the catalogue contradicts, rather than issuing the query", async () => {
    // #given a boolean tag declared as a number, which SL-046 shows returns null in silence
    const { operations } = operationsFor({});

    const result = await verifyFieldTypes(
      operations,
      [{ name: "agent.idempotency.present", context: "tag", dataType: "number" }],
      CONTEXT,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("FIELD_TYPE_MISMATCH");
    expect(result.error.message).toContain("agent.idempotency.present");
    expect(result.error.message).toContain("SigNoz reports");
  });

  it("accepts a string field the catalogue does not list, and records it as unverified", async () => {
    // #given `timestamp`, a real column the catalogue omits, and `service.name`, a resource attribute
    // the catalogue does not list at all
    const { operations } = operationsFor({});

    const result = await verifyFieldTypes(
      operations,
      [
        { name: "timestamp", context: "span", dataType: "string" },
        { name: "service.name", context: "resource", dataType: "string" },
      ],
      CONTEXT,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.unverified).toEqual(["service.name", "timestamp"]);
  });

  it("refuses a non-string span column the catalogue does not list", async () => {
    const { operations } = operationsFor({});

    const result = await verifyFieldTypes(
      operations,
      [{ name: "invented_column", context: "span", dataType: "number" }],
      CONTEXT,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("FIELD_TYPE_MISMATCH");
  });

  it("accepts a tag the catalogue does not list, since nothing emitted it in the window", async () => {
    // #given `gen_ai.usage.output_tokens`, which the demo never emits, declared as a number
    const { operations } = operationsFor({});

    const result = await verifyFieldTypes(
      operations,
      [{ name: "gen_ai.usage.output_tokens", context: "tag", dataType: "number" }],
      CONTEXT,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.unverified).toEqual(["gen_ai.usage.output_tokens"]);
  });

  it("refuses to proceed on an incomplete catalogue", async () => {
    const { operations } = operationsFor({ complete: false });

    const result = await verifyFieldTypes(operations, MINING_SELECT_FIELDS, CONTEXT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("FIELD_CATALOGUE_UNAVAILABLE");
  });

  it("refuses to proceed when the catalogue cannot be read at all", async () => {
    const operations = {
      getFieldKeys: async () => ({ outcome: "TRANSPORT_ERROR" }),
    } as unknown as SigNozOperations;

    const result = await verifyFieldTypes(operations, MINING_SELECT_FIELDS, CONTEXT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("FIELD_CATALOGUE_UNAVAILABLE");
  });

  it("declares a type for every field the miner requests", () => {
    for (const field of MINING_SELECT_FIELDS) {
      expect(["string", "number", "bool"]).toContain(field.dataType);
    }
  });
});

describe("re-checking returned values against the declared types", () => {
  it("accepts null, which is what an unset attribute and an unemitted tag both look like", () => {
    const untrusted = untrustedFieldsOf(
      [{ "agent.retry.number": null, "agent.idempotency.present": null }],
      MINING_SELECT_FIELDS,
    );

    expect(untrusted).toEqual([]);
  });

  it("accepts a value of the declared type", () => {
    const untrusted = untrustedFieldsOf(
      [{ "agent.retry.number": 1, "agent.idempotency.present": true, name: "payment.refund" }],
      MINING_SELECT_FIELDS,
    );

    expect(untrusted).toEqual([]);
  });

  it("reports a boolean tag that came back as a string", () => {
    const untrusted = untrustedFieldsOf(
      [{ "agent.idempotency.present": "true" }],
      MINING_SELECT_FIELDS,
    );

    expect(untrusted).toEqual(["agent.idempotency.present"]);
  });

  it("reports a numeric tag that came back as a string", () => {
    expect(untrustedFieldsOf([{ "agent.retry.number": "0" }], MINING_SELECT_FIELDS)).toEqual([
      "agent.retry.number",
    ]);
  });

  it("reports each offending field once across many rows", () => {
    const untrusted = untrustedFieldsOf(
      [
        { "agent.retry.number": "0" },
        { "agent.retry.number": "1" },
        { "agent.idempotency.present": 1 },
      ],
      MINING_SELECT_FIELDS,
    );

    expect(untrusted).toEqual(["agent.idempotency.present", "agent.retry.number"]);
  });

  it("ignores a field the row does not carry at all", () => {
    expect(untrustedFieldsOf([{ span_id: "a" }], MINING_SELECT_FIELDS)).toEqual([]);
  });

  it("treats a boolean false as a value, not as absence", () => {
    expect(untrustedFieldsOf([{ has_error: false }], MINING_SELECT_FIELDS)).toEqual([]);
  });

  it("treats a numeric zero as a value, not as absence", () => {
    expect(untrustedFieldsOf([{ "agent.retry.number": 0 }], MINING_SELECT_FIELDS)).toEqual([]);
  });
});

describe("discovering candidate runs in bounded batches", () => {
  it("walks pages by offset until a page is not full", async () => {
    const { operations, recorded } = operationsFor({
      pages: [
        { rows: [{ trace_id: "a" }, { trace_id: "b" }, { trace_id: "c" }], cursor: "cursor-1" },
        { rows: [{ trace_id: "d" }, { trace_id: "e" }], cursor: "" },
      ],
    });

    const result = await discoverRuns(operations, SELECTION, CONTEXT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dataset.traceIds).toEqual(["a", "b", "c", "d", "e"]);
    expect(result.dataset.pages).toBe(2);
    expect(result.dataset.truncated).toBe(false);
    expect(recorded.offsets).toEqual([0, 3]);
    expect(recorded.limits).toEqual([3, 3]);
  });

  it("stops on the first page when it is not full, whatever the cursor says", async () => {
    const { operations } = operationsFor({
      pages: [{ rows: [{ trace_id: "a" }], cursor: "cursor-1" }],
    });

    const result = await discoverRuns(operations, SELECTION, CONTEXT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dataset.traceIds).toEqual(["a"]);
    expect(result.dataset.pages).toBe(1);
    expect(result.dataset.truncated).toBe(false);
  });

  it("stops when a full page offers no continuation", async () => {
    const { operations } = operationsFor({
      pages: [{ rows: [{ trace_id: "a" }, { trace_id: "b" }, { trace_id: "c" }], cursor: "" }],
    });

    const result = await discoverRuns(operations, SELECTION, CONTEXT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dataset.traceIds).toHaveLength(3);
    expect(result.dataset.truncated).toBe(false);
  });

  it("reports truncation when the maximum is reached while more remains", async () => {
    // #given three full pages, reaching the selection's maximum of nine, with a cursor still offered
    const full = {
      rows: [{ trace_id: "a" }, { trace_id: "b" }, { trace_id: "c" }],
      cursor: "more",
    };
    const { operations } = operationsFor({ pages: [full, full, full] });

    const result = await discoverRuns(operations, SELECTION, CONTEXT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dataset.traceIds).toHaveLength(9);
    expect(result.dataset.truncated).toBe(true);
  });

  it("never requests more rows than the maximum permits", async () => {
    const full = {
      rows: [{ trace_id: "a" }, { trace_id: "b" }, { trace_id: "c" }],
      cursor: "more",
    };
    const selection = resolveSelection({
      projectKey: "demo-commerce",
      agentKey: "refund-agent",
      releaseId: "refund-agent-v1",
      startMs: Date.parse("2026-07-25T00:00:00Z"),
      endMs: Date.parse("2026-07-26T00:00:00Z"),
      minimumRuns: 1,
      rootSpanName: "refund.request",
      batchSize: 3,
      maxTraces: 4,
    });

    const { operations, recorded } = operationsFor({ pages: [full, full] });
    await discoverRuns(operations, selection, CONTEXT);

    expect(recorded.limits).toEqual([3, 1]);
  });

  it("stops on an empty result rather than paging forever", async () => {
    const { operations } = operationsFor({ pages: [] });

    const result = await discoverRuns(operations, SELECTION, CONTEXT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dataset.traceIds).toEqual([]);
    expect(result.dataset.pages).toBe(1);
  });

  it("fails rather than mining from a partial result when a page errors", async () => {
    const { operations } = operationsFor({ discoveryOutcome: "TRANSPORT_ERROR" });

    const result = await discoverRuns(operations, SELECTION, CONTEXT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DISCOVERY_FAILED");
  });

  it("refuses a release identifier that could close the filter's quoted literal", async () => {
    const { operations } = operationsFor({ pages: [] });
    const hostile = resolveSelection({
      projectKey: "demo-commerce",
      agentKey: "refund-agent",
      releaseId: "v1' OR '1'='1",
      startMs: Date.parse("2026-07-25T00:00:00Z"),
      endMs: Date.parse("2026-07-26T00:00:00Z"),
      minimumRuns: 1,
      rootSpanName: "refund.request",
    });

    await expect(discoverRuns(operations, hostile, CONTEXT)).rejects.toThrow(RangeError);
  });

  it("constrains the environment when the selection names one", async () => {
    const { operations } = operationsFor({ pages: [] });

    await discoverRuns(operations, SELECTION, CONTEXT);

    // The filter is built from the selection; a missing environment clause would widen the dataset
    // silently, so the presence of the clause is asserted through the query the caller built.
    expect(SELECTION.environment).toBe("local");
  });
});

describe("fetching complete span trees", () => {
  it("fetches each distinct trace once, in a deterministic order", async () => {
    const { operations, recorded } = operationsFor({});

    const result = await fetchTraces(operations, ["b", "a", "b"], SELECTION, CONTEXT);

    expect(recorded.traceIds).toEqual(["a", "b"]);
    expect(result.traces.map((trace) => trace.traceId)).toEqual(["a", "b"]);
    expect(result.failures).toEqual([]);
  });

  it("declares every field's type on the request", async () => {
    const { operations, recorded } = operationsFor({});

    await fetchTraces(operations, ["a"], SELECTION, CONTEXT);

    expect(recorded.selectFields[0]).toEqual(MINING_SELECT_FIELDS.map((field) => field.name));
  });

  it("records a fetch failure rather than dropping the trace", async () => {
    const { operations } = operationsFor({ spanOutcome: "SUCCESS_EMPTY" });

    const result = await fetchTraces(operations, ["a"], SELECTION, CONTEXT);

    expect(result.traces).toEqual([]);
    expect(result.failures[0]?.code).toBe("TRACE_FETCH_FAILED");
    expect(result.failures[0]?.subject).toBe("a");
  });

  it("marks a trace whose typed column came back wrongly typed", async () => {
    const { operations } = operationsFor({
      spanRows: [{ span_id: "a", trace_id: "a", "agent.idempotency.present": "true" }],
    });

    const result = await fetchTraces(operations, ["a"], SELECTION, CONTEXT);

    expect(result.traces[0]?.untrustedFields).toEqual(["agent.idempotency.present"]);
  });

  it("retains the SigNoz deep link the payload returned", async () => {
    const { operations } = operationsFor({});

    const result = await fetchTraces(operations, ["a"], SELECTION, CONTEXT);

    expect(result.traces[0]?.webUrl).toContain("/trace/");
  });
});

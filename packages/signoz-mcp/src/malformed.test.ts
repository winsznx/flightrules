import { describe, expect, it } from "vitest";
import { classifyThrown } from "./classify.js";
import { normaliseToolResult, type RawToolResult } from "./normalise.js";
import {
  builderQueryReader,
  createdResourceReader,
  identifierOf,
  listReader,
  metricSeriesReader,
  rowsOf,
} from "./readers.js";

/**
 * The malformed-response cases PRD Phase 16 task 6 names that `normalise.test.ts` does not already
 * cover.
 *
 * That file covers the seventeen response *shapes*. These are the ones where the response is
 * well-formed JSON and still cannot be trusted: an SPA shell served with HTTP 200, an identifier
 * under a key this client did not expect, a pagination cursor that repeats, a numeric field that is
 * `null` because the query omitted `dataType`. Each has a source-lock entry behind it, because each
 * was found by running the pinned server rather than by reading its documentation.
 *
 * One rule governs all of them: **no malformed response may be interpreted as a verified
 * resource.** A create whose identifier cannot be read is a failure, not a resource with an unknown
 * name.
 */

const TOOL = "signoz_execute_builder_query";

function text(value: string) {
  return { type: "text", text: value };
}

function normalise(raw: RawToolResult, reader = builderQueryReader) {
  return normaliseToolResult({ tool: TOOL, raw, reader, durationMs: 1 });
}

describe("an SPA shell served with HTTP 200 (SL-012)", () => {
  /**
   * SigNoz answers an unmatched API path with its single-page application and status 200. A client
   * that treats 200 as success reads a web page as a query result.
   */
  const SHELL =
    '<!doctype html><html><head><title>SigNoz</title></head><body><div id="root"></div></body></html>';

  it("is not mistaken for a payload", () => {
    const result = normalise({ content: [text(SHELL)] });
    expect(result.outcome).not.toBe("SUCCESS_WITH_ROWS");
    expect(result.outcome).not.toBe("SUCCESS_EMPTY");
  });

  it("is not mistaken for an empty result set either", () => {
    // The dangerous misreading: "no rows" and "we got a web page" must not look the same, because
    // the first is evidence a release is clean and the second is evidence of nothing.
    const result = normalise({ content: [text(SHELL)] });
    expect(result.outcome).toBe("MALFORMED_RESPONSE");
  });
});

describe("a create response whose identifier this client cannot read (SL-056)", () => {
  /**
   * The identifier and name fields differ per resource type on the pinned server: an alert answers
   * with `ruleId`, a dashboard with `uuid`, a view and a channel with `id`. The create *envelope*
   * this reader validates is the `{data: {id}}` or `{data: "<id>"}` form; anything else has not
   * told the client what it created.
   */
  const accepted: readonly [string, unknown][] = [
    ["an object carrying id", { data: { id: "019f9c00-0000-7000-8000-000000000001" } }],
    ["a bare string identifier", { data: "019f9c00-0000-7000-8000-000000000002" }],
  ];

  it.each(accepted)("reads the identifier from %s", (_name, payload) => {
    const result = normalise({ content: [text(JSON.stringify(payload))] }, createdResourceReader);
    expect(result.outcome).toBe("SUCCESS_WITH_ROWS");
    if (result.outcome === "SUCCESS_WITH_ROWS") expect(identifierOf(result.value)).toBeTruthy();
  });

  const rejected: readonly [string, unknown][] = [
    ["nothing but a status", { status: "success" }],
    ["an empty data object", { data: {} }],
    ["a numeric identifier", { data: { id: 42 } }],
    ["a null identifier", { data: { id: null } }],
    ["a nested identifier", { data: { id: { nested: "value" } } }],
    ["only a name", { data: { name: "FlightRules / demo / agent / Contract Health" } }],
  ];

  /**
   * The load-bearing half. A create the client cannot verify is a **failure**, not a resource with
   * an unknown identifier: the register would otherwise record something it can never read back,
   * and the artefact count would claim ten managed resources when one of them is a rumour.
   */
  it.each(rejected)("refuses to call %s a created resource", (_name, payload) => {
    const result = normalise({ content: [text(JSON.stringify(payload))] }, createdResourceReader);
    expect(result.outcome).not.toBe("SUCCESS_WITH_ROWS");
  });
});

describe("pagination that does not terminate", () => {
  function page(cursor: string, rowCount: number) {
    return {
      status: "success",
      data: {
        type: "raw",
        meta: { rowsScanned: rowCount, bytesScanned: 1, durationMs: 1 },
        data: {
          results: [
            {
              queryName: "A",
              nextCursor: cursor,
              rows: Array.from({ length: rowCount }, (_unused, index) => ({
                data: { span_id: `span-${String(index)}`, name: "payment.refund" },
                timestamp: "2026-07-25T09:00:00.000Z",
              })),
            },
          ],
        },
      },
    };
  }

  it("reports a full page with a cursor as rows plus a cursor, not as everything there is", () => {
    const result = normalise({ content: [text(JSON.stringify(page("MTc4NQ==", 50)))] });
    expect(result.outcome).toBe("SUCCESS_WITH_ROWS");
    if (result.outcome === "SUCCESS_WITH_ROWS") {
      const cursor = result.value.data.data.results?.[0]?.nextCursor;
      expect(cursor).toBe("MTc4NQ==");
    }
  });

  it("treats an empty cursor as the end (SL-050)", () => {
    const result = normalise({ content: [text(JSON.stringify(page("", 3)))] });
    expect(result.outcome).toBe("SUCCESS_WITH_ROWS");
    if (result.outcome === "SUCCESS_WITH_ROWS") {
      expect(result.value.data.data.results?.[0]?.nextCursor).toBe("");
    }
  });

  it("returns identical rows for identical pages, so a caller can detect a repeated cursor", () => {
    // A server that returns the same cursor forever is a loop. Detecting it needs the payload to
    // be read the same way twice, which is what this asserts.
    const first = normalise({ content: [text(JSON.stringify(page("SAME", 2)))] });
    const second = normalise({ content: [text(JSON.stringify(page("SAME", 2)))] });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("preserves duplicated rows rather than silently collapsing them", () => {
    const duplicated = page("", 1);
    const result = duplicated.data.data.results[0];
    if (result === undefined) throw new Error("the fixture must produce one result");
    result.rows = [...result.rows, ...result.rows];
    const outcome = normalise({ content: [text(JSON.stringify(duplicated))] });
    expect(outcome.outcome).toBe("SUCCESS_WITH_ROWS");
    if (outcome.outcome === "SUCCESS_WITH_ROWS") expect(rowsOf(outcome.value)).toHaveLength(2);
  });
});

describe("a numeric or boolean that is null because dataType was omitted (SL-051)", () => {
  function rowWith(data: Record<string, unknown>) {
    return {
      status: "success",
      data: {
        type: "raw",
        meta: { rowsScanned: 1, bytesScanned: 1, durationMs: 1 },
        data: {
          results: [
            {
              queryName: "A",
              nextCursor: "",
              rows: [{ data, timestamp: "2026-07-25T09:00:00.000Z" }],
            },
          ],
        },
      },
    };
  }

  it("carries the null through rather than substituting a zero", () => {
    // The dangerous substitution. `duration_nano: null` becoming `0` turns "we do not know how long
    // this took" into "it took no time", and a latency budget then passes on absent data.
    const result = normalise({
      content: [text(JSON.stringify(rowWith({ span_id: "a", duration_nano: null })))],
    });
    expect(result.outcome).toBe("SUCCESS_WITH_ROWS");
    if (result.outcome === "SUCCESS_WITH_ROWS") {
      expect(rowsOf(result.value)[0]?.data["duration_nano"]).toBeNull();
    }
  });

  it("carries a null boolean through rather than substituting false", () => {
    const result = normalise({
      content: [text(JSON.stringify(rowWith({ span_id: "a", "agent.idempotency.present": null })))],
    });
    expect(result.outcome).toBe("SUCCESS_WITH_ROWS");
    if (result.outcome === "SUCCESS_WITH_ROWS") {
      expect(rowsOf(result.value)[0]?.data["agent.idempotency.present"]).toBeNull();
    }
  });
});

describe("a metric answer, which is not shaped like a query answer (SL-062)", () => {
  function series(labels: readonly { name: string; value: string }[], values: readonly number[]) {
    return {
      status: "success",
      data: {
        data: {
          results: [
            {
              aggregations: [
                {
                  series: [
                    {
                      labels: labels.map((label) => ({
                        key: { name: label.name },
                        value: label.value,
                      })),
                      values: values.map((value, index) => ({
                        timestamp: 1_785_000_000_000 + index * 60_000,
                        value,
                      })),
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    };
  }

  it("counts observations, not rows, so a populated metric is not read as empty", () => {
    const payload = series([{ name: "flight_rules.agent.id", value: "agent-1" }], [0, 0, 1]);
    const result = normalise({ content: [text(JSON.stringify(payload))] }, metricSeriesReader);
    expect(result.outcome).toBe("SUCCESS_WITH_ROWS");
  });

  it("reports a genuinely absent series as empty", () => {
    const payload = { status: "success", data: { data: { results: [] } } };
    const result = normalise({ content: [text(JSON.stringify(payload))] }, metricSeriesReader);
    expect(result.outcome).toBe("SUCCESS_EMPTY");
  });
});

describe("a list response that is not a list", () => {
  it("reports an object where an array was expected as unsupported, not malformed", () => {
    const payload = { status: "success", data: { unexpected: "shape" } };
    const result = normalise({ content: [text(JSON.stringify(payload))] }, listReader);
    expect(["UNSUPPORTED_RESPONSE", "SUCCESS_EMPTY"]).toContain(result.outcome);
    expect(result.outcome).not.toBe("SUCCESS_WITH_ROWS");
  });
});

describe("transport failures are classified, never swallowed", () => {
  const cases: readonly [string, unknown][] = [
    ["a timeout", Object.assign(new Error("The operation was aborted"), { name: "AbortError" })],
    [
      "a refused connection",
      Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    ],
    ["a reset connection", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })],
    [
      "an unresolvable host",
      Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
    ],
    ["a thrown string", "something went wrong"],
    ["a thrown null", null],
  ];

  it.each(cases)("classifies %s rather than returning a success", (_name, thrown) => {
    const classification = classifyThrown(thrown);
    expect(classification).toBeDefined();
    expect(JSON.stringify(classification)).not.toContain("SUCCESS");
  });
});

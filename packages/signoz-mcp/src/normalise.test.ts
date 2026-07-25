import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { PayloadReader } from "./normalise.js";
import { normaliseToolResult, type RawToolResult } from "./normalise.js";
import { extractPayloads, stripCodeFence } from "./parse.js";
import { builderQueryReader, listReader, rowsOf } from "./readers.js";
import { builderQueryPayloadSchema } from "./schemas.js";

/**
 * The seventeen response shapes the client must survive. Shapes 1, 2, 6, 7, 8, 9, 10 and 12 are
 * reproduced from responses observed against the pinned SigNoz MCP Server v0.9.0; the rest are
 * defensive cases the PRD requires be handled rather than assumed impossible.
 */

const TOOL = "signoz_execute_builder_query";

function normalise(raw: RawToolResult) {
  return normaliseToolResult({ tool: TOOL, raw, reader: builderQueryReader, durationMs: 1 });
}

function textEntry(text: string) {
  return { type: "text", text };
}

/** A builder-query payload with `n` rows, in the double-nested envelope the server returns. */
function builderPayload(rowCount: number, webUrl?: string) {
  return {
    status: "success",
    data: {
      type: "raw",
      meta: { rowsScanned: rowCount, bytesScanned: 10, durationMs: 3 },
      ...(webUrl === undefined ? {} : { webUrl }),
      data: {
        results: [
          {
            queryName: "A",
            nextCursor: "",
            rows: Array.from({ length: rowCount }, (_, index) => ({
              data: { span_id: `span-${index}`, name: "payment.refund" },
              timestamp: "2026-07-25T09:00:00.000Z",
            })),
          },
        ],
      },
    },
  };
}

describe("normaliseToolResult", () => {
  describe("shape 1: valid structuredContent", () => {
    it("reads the payload from structuredContent", () => {
      // #given a response whose payload the server already parsed for us
      const raw = { structuredContent: builderPayload(2), content: [] };

      // #when it is normalised
      const result = normalise(raw);

      // #then the rows are returned
      expect(result.outcome).toBe("SUCCESS_WITH_ROWS");
      expect(result.outcome === "SUCCESS_WITH_ROWS" && result.rowCount).toBe(2);
    });
  });

  describe("shape 2: no structuredContent, machine-readable text", () => {
    it("falls back to parsing the text entry", () => {
      // #given the exact shape signoz_execute_builder_query returns on the success path
      const raw = { content: [textEntry(JSON.stringify(builderPayload(3)))] };

      // #when it is normalised
      const result = normalise(raw);

      // #then the fallback recovers the rows
      expect(result.outcome).toBe("SUCCESS_WITH_ROWS");
      expect(result.outcome === "SUCCESS_WITH_ROWS" && result.rowCount).toBe(3);
    });
  });

  describe("shape 3: plain text containing a JSON object", () => {
    it("accepts an object payload", () => {
      // #given a list envelope delivered as text only
      const raw = { content: [textEntry(JSON.stringify({ data: [{ id: "a" }] }))] };

      // #when it is normalised with the list reader
      const result = normaliseToolResult({
        tool: "signoz_list_views",
        raw,
        reader: listReader,
        durationMs: 1,
      });

      // #then one row is reported
      expect(result.outcome === "SUCCESS_WITH_ROWS" && result.rowCount).toBe(1);
    });
  });

  describe("shape 4: plain text containing a JSON array", () => {
    it("surfaces a bare array as unsupported rather than malformed", () => {
      // #given a top-level array, which no pinned tool returns but which parses as JSON
      const raw = { content: [textEntry(JSON.stringify([{ span_id: "a" }]))] };

      // #when it is normalised against an object schema
      const result = normalise(raw);

      // #then it is understood but rejected, not reported as unparseable
      expect(result.outcome).toBe("UNSUPPORTED_RESPONSE");
    });

    it("accepts an array when that is the declared shape", () => {
      // #given a reader whose schema is an array
      const arrayReader: PayloadReader<z.ZodArray<z.ZodString>> = {
        schema: z.array(z.string()),
        countRows: (value) => value.length,
      };
      const raw = { content: [textEntry(JSON.stringify(["a", "b"]))] };

      // #when it is normalised
      const result = normaliseToolResult({ tool: TOOL, raw, reader: arrayReader, durationMs: 1 });

      // #then the array is the payload
      expect(result.outcome === "SUCCESS_WITH_ROWS" && result.rowCount).toBe(2);
    });
  });

  describe("shape 5: text wrapped in a Markdown code fence", () => {
    it("strips the fence before parsing", () => {
      // #given a fenced payload
      const fenced = `\`\`\`json\n${JSON.stringify(builderPayload(1))}\n\`\`\``;
      const raw = { content: [textEntry(fenced)] };

      // #when it is normalised
      const result = normalise(raw);

      // #then the payload inside the fence is read
      expect(result.outcome === "SUCCESS_WITH_ROWS" && result.rowCount).toBe(1);
    });

    it("leaves an unterminated fence alone rather than guessing", () => {
      // #given a fence that never closes
      const text = '```json\n{"data": 1}';

      // #when the fence stripper runs
      // #then the input is returned untouched
      expect(stripCodeFence(text)).toBe(text);
    });
  });

  describe("shape 6: several content entries where only one is the result", () => {
    it("parses entries individually instead of joining them", () => {
      // #given the real multi-entry response: the payload, then a server advisory. Joining these
      // and calling JSON.parse fails, which is how this case was originally missed.
      const raw = {
        content: [
          textEntry(JSON.stringify(builderPayload(4))),
          textEntry(
            '[Decisions applied]\n  query "A": limit=100 (request-type default), order=timestamp desc (signal-safe default)',
          ),
        ],
      };

      // #when it is normalised
      const result = normalise(raw);

      // #then the rows are recovered
      expect(result.outcome === "SUCCESS_WITH_ROWS" && result.rowCount).toBe(4);
    });

    it("keeps the advisory as a notice rather than discarding it", () => {
      // #given the same response
      const raw = {
        content: [
          textEntry(JSON.stringify(builderPayload(1))),
          textEntry('[Decisions applied]\n  query "A": limit=100 (request-type default)'),
        ],
      };

      // #when it is normalised
      const result = normalise(raw);

      // #then the server's substitution is visible to the caller
      expect(result.notices).toHaveLength(1);
      expect(result.notices[0]?.text).toContain("[Decisions applied]");
    });

    it("finds the payload when the advisory arrives first", () => {
      // #given the entries in the opposite order
      const raw = {
        content: [textEntry("[Decisions applied]"), textEntry(JSON.stringify(builderPayload(2)))],
      };

      // #when it is normalised
      const result = normalise(raw);

      // #then ordering does not matter
      expect(result.outcome === "SUCCESS_WITH_ROWS" && result.rowCount).toBe(2);
    });
  });

  describe("shape 7: empty content", () => {
    it("reports a malformed response when nothing was returned", () => {
      // #given a response with no content and no structured content
      const raw = { content: [] };

      // #when it is normalised
      const result = normalise(raw);

      // #then it is malformed, and never an empty success
      expect(result.outcome).toBe("MALFORMED_RESPONSE");
      expect(result.outcome === "MALFORMED_RESPONSE" && result.code).toBe("MCP_RESPONSE_INVALID");
    });

    it("reports a malformed response when content is absent entirely", () => {
      // #given a response object with no content key
      const result = normalise({});

      // #then it is malformed
      expect(result.outcome).toBe("MALFORMED_RESPONSE");
    });
  });

  describe("shape 8: malformed JSON", () => {
    it("does not treat truncated JSON as a payload", () => {
      // #given a payload cut off mid-object
      const raw = { content: [textEntry('{"status":"success","data":{')] };

      // #when it is normalised
      const result = normalise(raw);

      // #then it is malformed
      expect(result.outcome).toBe("MALFORMED_RESPONSE");
    });

    it("does not treat prose as a payload", () => {
      // #given a response that is only prose
      const raw = { content: [textEntry("the query could not be planned")] };

      // #when it is normalised
      const result = normalise(raw);

      // #then it is malformed and the prose is preserved as a notice
      expect(result.outcome).toBe("MALFORMED_RESPONSE");
      expect(result.notices[0]?.text).toBe("the query could not be planned");
    });
  });

  describe("shape 9: an MCP-declared error", () => {
    it("classifies an authentication envelope as an authentication failure", () => {
      // #given the envelope the server returns for a rejected API key
      const raw = {
        isError: true,
        structuredContent: {
          code: "UNAUTHORIZED",
          status: 401,
          upstreamCode: "unauthenticated",
        },
        content: [textEntry("SigNoz API error: unexpected status 401: unauthenticated")],
      };

      // #when it is normalised
      const result = normalise(raw);

      // #then it is an MCP error carrying the authentication code
      expect(result.outcome).toBe("MCP_ERROR");
      expect(result.outcome === "MCP_ERROR" && result.code).toBe("SIGNOZ_AUTH_FAILED");
      expect(result.outcome === "MCP_ERROR" && result.httpStatus).toBe(401);
    });

    it("never reads a payload out of an error response", () => {
      // #given an error response that also carries a well-formed body
      const raw = {
        isError: true,
        structuredContent: { code: "SOMETHING" },
        content: [textEntry(JSON.stringify(builderPayload(5)))],
      };

      // #when it is normalised
      const result = normalise(raw);

      // #then the failure wins; a false success here is the outcome the PRD forbids
      expect(result.outcome).toBe("MCP_ERROR");
    });

    it("classifies a prose-only argument-validation failure", () => {
      // #given the shape returned for invalid tool arguments
      const raw = {
        isError: true,
        content: [textEntry('Parameter validation failed: "signal" must be one of: "traces"')],
      };

      // #when it is normalised
      const result = normalise(raw);

      // #then it is reported as an invalid exchange rather than a query failure
      expect(result.outcome === "MCP_ERROR" && result.code).toBe("MCP_RESPONSE_INVALID");
    });
  });

  describe("shape 11: a response whose shape differs from the schema", () => {
    it("reports valid JSON in an unknown shape as unsupported", () => {
      // #given JSON that parses but is not a builder-query envelope
      const raw = { content: [textEntry(JSON.stringify({ unexpected: "envelope" }))] };

      // #when it is normalised
      const result = normalise(raw);

      // #then it is unsupported, which is what a server upgrade looks like
      expect(result.outcome).toBe("UNSUPPORTED_RESPONSE");
    });
  });

  describe("shape 12: a successful query returning zero rows", () => {
    it("treats rows: null as an empty success", () => {
      // #given the exact envelope the server returns when nothing matched
      const raw = {
        content: [
          textEntry(
            JSON.stringify({
              status: "success",
              data: { type: "raw", data: { results: [{ queryName: "A", rows: null }] } },
            }),
          ),
        ],
      };

      // #when it is normalised
      const result = normalise(raw);

      // #then it is a success with no rows, not a failure
      expect(result.outcome).toBe("SUCCESS_EMPTY");
      expect(result.outcome === "SUCCESS_EMPTY" && result.rowCount).toBe(0);
    });

    it("treats an empty results array as an empty success", () => {
      // #given a payload with no results at all
      const raw = {
        content: [
          textEntry(JSON.stringify({ status: "success", data: { data: { results: [] } } })),
        ],
      };

      // #then it is an empty success
      expect(normalise(raw).outcome).toBe("SUCCESS_EMPTY");
    });
  });

  describe("shape 13: a large result set within configured limits", () => {
    it("normalises a thousand rows without loss", () => {
      // #given a payload at the scale PRD section 20.2 targets
      const raw = { content: [textEntry(JSON.stringify(builderPayload(1000)))] };

      // #when it is normalised
      const result = normalise(raw);

      // #then every row survives
      expect(result.outcome === "SUCCESS_WITH_ROWS" && result.rowCount).toBe(1000);
    });
  });

  describe("shape 14: duplicate span rows", () => {
    it("preserves duplicates for the graph layer to deduplicate deterministically", () => {
      // #given a payload where the same span_id appears twice
      const duplicated = {
        status: "success",
        data: {
          data: {
            results: [
              {
                queryName: "A",
                rows: [
                  { data: { span_id: "dup", name: "payment.refund" } },
                  { data: { span_id: "dup", name: "payment.refund" } },
                ],
              },
            ],
          },
        },
      };
      const raw = { content: [textEntry(JSON.stringify(duplicated))] };

      // #when it is normalised
      const result = normalise(raw);

      // #then the client reports both rows; deduplication is Phase 06's deterministic concern,
      // not something this layer may silently do
      expect(result.outcome === "SUCCESS_WITH_ROWS" && result.rowCount).toBe(2);
    });
  });

  describe("shape 15: missing required span fields", () => {
    it("accepts the response but lets the row reader reject the span", () => {
      // #given a row with no span_id
      const payload = {
        status: "success",
        data: { data: { results: [{ queryName: "A", rows: [{ data: { name: "orphan" } }] }] } },
      };
      const raw = { content: [textEntry(JSON.stringify(payload))] };

      // #when it is normalised
      const result = normalise(raw);

      // #then the transport-level response is a success — the response was fine, the row was not
      expect(result.outcome).toBe("SUCCESS_WITH_ROWS");
      expect(rowsOf(builderQueryPayloadSchema.parse(payload))).toHaveLength(1);
    });
  });

  describe("shape 16: unexpected additional fields", () => {
    it("ignores fields a newer server added", () => {
      // #given a payload carrying a column this version does not know about
      const payload = builderPayload(1) as Record<string, unknown>;
      payload["experimentalTopLevelField"] = { anything: true };
      const raw = { content: [textEntry(JSON.stringify(payload))] };

      // #when it is normalised
      const result = normalise(raw);

      // #then the known fields are still read; rejecting here would break on a harmless upgrade
      expect(result.outcome === "SUCCESS_WITH_ROWS" && result.rowCount).toBe(1);
    });
  });

  describe("shape 17: redacted or unavailable custom attributes", () => {
    it("does not confuse an absent attribute with a broken response", () => {
      // #given rows whose custom attributes are empty or absent
      const payload = {
        status: "success",
        data: {
          data: {
            results: [
              {
                queryName: "A",
                rows: [
                  { data: { span_id: "s1", name: "payment.refund", "agent.side_effect": "" } },
                  { data: { span_id: "s2", name: "payment.refund" } },
                ],
              },
            ],
          },
        },
      };
      const raw = { content: [textEntry(JSON.stringify(payload))] };

      // #when it is normalised
      const result = normalise(raw);

      // #then both rows are returned and the missing attribute is the graph layer's problem
      expect(result.outcome === "SUCCESS_WITH_ROWS" && result.rowCount).toBe(2);
    });
  });

  describe("deep links", () => {
    it("preserves the SigNoz webUrl when the payload carries one", () => {
      // #given a payload with a deep link, which FR-003 requires be retained
      const raw = {
        content: [textEntry(JSON.stringify(builderPayload(1, "http://signoz/trace/x")))],
      };

      // #when it is normalised
      const result = normalise(raw);

      // #then the link survives
      expect(result.outcome === "SUCCESS_WITH_ROWS" && result.webUrl).toBe("http://signoz/trace/x");
    });
  });
});

describe("extractPayloads", () => {
  it("ignores content entries of a type this client does not read", () => {
    // #given a response mixing an image with the payload
    const raw = {
      content: [
        { type: "image", data: "..." },
        { type: "text", text: '{"data":[]}' },
      ],
    };

    // #when payloads are extracted
    const extraction = extractPayloads(raw);

    // #then only the text entry became a candidate, and the image is recorded as skipped
    expect(extraction.candidates).toHaveLength(1);
    expect(extraction.skippedEntryTypes).toEqual(["image"]);
  });

  it("tries structuredContent before content entries", () => {
    // #given both sources present
    const raw = { structuredContent: { a: 1 }, content: [{ type: "text", text: '{"b":2}' }] };

    // #when payloads are extracted
    const extraction = extractPayloads(raw);

    // #then the server's own parse is first in line
    expect(extraction.candidates[0]?.origin).toBe("structuredContent");
    expect(extraction.candidates[1]?.origin).toBe("content");
  });

  it("does not treat a bare scalar as a payload", () => {
    // #given text that JSON.parse would happily accept as a number
    const extraction = extractPayloads({ content: [{ type: "text", text: "42" }] });

    // #then it is prose, not a candidate
    expect(extraction.candidates).toHaveLength(0);
    expect(extraction.proseEntries).toEqual(["42"]);
  });
});

import { redactString } from "@flightrules/domain";
import type { z } from "zod";
import { classifyDeclaredError } from "./classify.js";
import type { McpNotice, McpResult } from "./outcome.js";
import { extractPayloads } from "./parse.js";

/** The subset of the SDK's `CallToolResult` this layer reads. Kept structural so tests need no SDK. */
export interface RawToolResult {
  readonly content?: unknown;
  readonly structuredContent?: unknown;
  readonly isError?: unknown;
}

/**
 * Turns a validated payload into the row count and deep link the outcome carries. Row counting is
 * payload-specific — a builder query nests rows two levels deeper than a list tool does — so each
 * reader supplies its own instead of the normaliser guessing.
 */
export interface PayloadReader<TSchema extends z.ZodType> {
  readonly schema: TSchema;
  readonly countRows: (value: z.infer<TSchema>) => number;
  readonly webUrlOf?: (value: z.infer<TSchema>) => string | undefined;
}

export interface NormaliseInput<TSchema extends z.ZodType> {
  readonly tool: string;
  readonly raw: RawToolResult;
  readonly reader: PayloadReader<TSchema>;
  readonly durationMs: number;
}

const MAX_NOTICE_LENGTH = 2000;

function toNotices(proseEntries: readonly string[]): readonly McpNotice[] {
  return proseEntries.map((text) => ({
    source: "content" as const,
    text: redactString(text.slice(0, MAX_NOTICE_LENGTH)),
  }));
}

function firstText(raw: RawToolResult): string {
  if (!Array.isArray(raw.content)) return "";
  for (const entry of raw.content as { type?: unknown; text?: unknown }[]) {
    if (entry !== null && typeof entry === "object" && entry.type === "text") {
      if (typeof entry.text === "string") return entry.text;
    }
  }
  return "";
}

/**
 * Converts a raw tool result into a typed outcome.
 *
 * The order matters. A server-declared error is classified before any payload is read, because an
 * error response can still carry a structured body and reading it as a result would turn a
 * failure into a false success — the outcome PRD section 20.1 forbids outright.
 *
 * Otherwise every candidate payload is validated in turn and the first that matches wins. The
 * distinction between the two rejection outcomes is deliberate and load-bearing for diagnosis:
 * `MALFORMED_RESPONSE` means nothing JSON-shaped could be recovered at all, while
 * `UNSUPPORTED_RESPONSE` means valid JSON arrived in a shape this client does not understand,
 * which is what a server upgrade looks like.
 */
export function normaliseToolResult<TSchema extends z.ZodType>(
  input: NormaliseInput<TSchema>,
): McpResult<z.infer<TSchema>> {
  const { tool, raw, reader, durationMs } = input;
  const extraction = extractPayloads(raw);
  const notices = toNotices(extraction.proseEntries);
  const base = { tool, notices, durationMs } as const;

  if (raw.isError === true) {
    const classified = classifyDeclaredError(raw.structuredContent, firstText(raw));
    return {
      ...base,
      outcome: "MCP_ERROR",
      code: classified.code,
      reason: classified.reason,
      ...(classified.envelope?.code === undefined ? {} : { serverCode: classified.envelope.code }),
      ...(classified.envelope?.status === undefined
        ? {}
        : { httpStatus: classified.envelope.status }),
    };
  }

  if (extraction.empty) {
    return {
      ...base,
      outcome: "MALFORMED_RESPONSE",
      code: "MCP_RESPONSE_INVALID",
      reason: "the response carried no content and no structured content",
    };
  }

  let schemaRejections = 0;
  for (const candidate of extraction.candidates) {
    const parsed = reader.schema.safeParse(candidate.value);
    if (!parsed.success) {
      schemaRejections += 1;
      continue;
    }

    const value = parsed.data as z.infer<TSchema>;
    const rowCount = reader.countRows(value);
    const webUrl = reader.webUrlOf?.(value);

    if (rowCount <= 0) {
      return { ...base, outcome: "SUCCESS_EMPTY", rowCount: 0, ...(webUrl ? { webUrl } : {}) };
    }
    return {
      ...base,
      outcome: "SUCCESS_WITH_ROWS",
      value,
      rowCount,
      ...(webUrl ? { webUrl } : {}),
    };
  }

  if (schemaRejections > 0) {
    return {
      ...base,
      outcome: "UNSUPPORTED_RESPONSE",
      code: "MCP_RESPONSE_INVALID",
      reason: `the response did not match the expected shape for ${tool}`,
    };
  }

  return {
    ...base,
    outcome: "MALFORMED_RESPONSE",
    code: "MCP_RESPONSE_INVALID",
    reason: `no content entry from ${tool} contained a machine-readable payload`,
  };
}

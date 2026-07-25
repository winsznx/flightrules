import type { ErrorCode } from "@flightrules/domain";
import { redactString } from "@flightrules/domain";
import { errorEnvelopeSchema, type McpErrorEnvelope } from "./schemas.js";

/**
 * Failure classification for the pinned server, derived from observed behaviour rather than from
 * documentation. An MCP failure is signalled three different ways and they must all be handled:
 *
 * | condition              | how it surfaces                                          |
 * |------------------------|----------------------------------------------------------|
 * | invalid API key        | `isError: true` with `{code:"UNAUTHORIZED", status:401}`  |
 * | missing key header     | `connect()` throws `StreamableHTTPError` with `code: 401` |
 * | host unreachable       | `connect()` throws `TypeError: fetch failed`             |
 * | wrong MCP path         | `StreamableHTTPError` with `code: 404`                   |
 * | unknown tool name      | `callTool()` throws `McpError` with code `-32602`        |
 * | invalid tool arguments | `isError: true`, prose text, no HTTP status              |
 *
 * Treating any of these as a success is the failure mode PRD section 20.1 forbids, so anything
 * unrecognised classifies as a failure, never as a pass.
 */

/** JSON-RPC method-not-found and invalid-params. The pinned server answers `-32602` for both. */
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_METHOD_NOT_FOUND = -32601;

export interface TransportClassification {
  readonly code: ErrorCode;
  readonly reason: string;
  readonly retryable: boolean;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}

function numericCodeOf(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

function isAbort(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * Classifies a value thrown by the transport or the SDK.
 *
 * `retryable` marks failures where the same request may succeed unchanged. A rejected credential
 * and an absent tool are not retryable: repeating them wastes the budget and, for writes, risks
 * the duplicate managed resources PRD section 20.1 forbids.
 */
export function classifyThrown(error: unknown, toolName?: string): TransportClassification {
  const message = redactString(messageOf(error));
  const rpcCode = numericCodeOf(error);

  if (rpcCode === JSON_RPC_INVALID_PARAMS || rpcCode === JSON_RPC_METHOD_NOT_FOUND) {
    // The pinned server answers `-32602 tool 'x' not found` for an unknown tool and reuses the
    // same code for malformed arguments, so the message decides between them.
    if (message.includes("not found")) {
      return {
        code: "MCP_TOOL_MISSING",
        reason: toolName === undefined ? message : `${toolName}: ${message}`,
        retryable: false,
      };
    }
    return { code: "MCP_RESPONSE_INVALID", reason: message, retryable: false };
  }

  if (isAbort(error)) {
    return {
      code: "MCP_UNAVAILABLE",
      reason: `the call did not complete within the configured timeout: ${message}`,
      retryable: true,
    };
  }

  // HTTP status arrives as `code` on StreamableHTTPError.
  if (rpcCode === 401 || rpcCode === 403) {
    return { code: "SIGNOZ_AUTH_FAILED", reason: message, retryable: false };
  }
  if (rpcCode === 404) {
    return {
      code: "MCP_UNAVAILABLE",
      reason: `the MCP endpoint was not found: ${message}`,
      retryable: false,
    };
  }
  if (rpcCode !== undefined && rpcCode >= 500 && rpcCode < 600) {
    return { code: "MCP_UNAVAILABLE", reason: message, retryable: true };
  }
  if (rpcCode === 429) {
    return { code: "MCP_UNAVAILABLE", reason: message, retryable: true };
  }

  // `fetch failed` is what a refused connection or DNS failure looks like from undici.
  if (message.includes("fetch failed") || message.includes("ECONNREFUSED")) {
    return {
      code: "MCP_UNAVAILABLE",
      reason: `the SigNoz MCP Server could not be reached: ${message}`,
      retryable: true,
    };
  }

  return { code: "MCP_UNAVAILABLE", reason: message, retryable: false };
}

export interface DeclaredErrorClassification {
  readonly code: ErrorCode;
  readonly reason: string;
  readonly envelope?: McpErrorEnvelope;
}

/**
 * Classifies a result the server itself marked as an error. The structured envelope is preferred
 * when present because it carries the upstream HTTP status; the text is a fallback and is prose,
 * not JSON, so it is never parsed.
 */
export function classifyDeclaredError(
  structuredContent: unknown,
  text: string,
): DeclaredErrorClassification {
  const reason = redactString(
    text.trim().length > 0 ? text.trim() : "the server declared an error",
  );
  const parsed = errorEnvelopeSchema.safeParse(structuredContent);

  if (!parsed.success) {
    // No envelope. Argument-validation failures arrive this way, as prose only.
    if (reason.includes("Parameter validation failed") || reason.includes("validation error")) {
      return { code: "MCP_RESPONSE_INVALID", reason };
    }
    return { code: "TRACE_QUERY_FAILED", reason };
  }

  const envelope = parsed.data;
  const status = envelope.status;

  if (status === 401 || status === 403 || envelope.code === "UNAUTHORIZED") {
    return { code: "SIGNOZ_AUTH_FAILED", reason, envelope };
  }
  if (status !== undefined && status >= 500) {
    return { code: "SIGNOZ_UNREACHABLE", reason, envelope };
  }
  return { code: "TRACE_QUERY_FAILED", reason, envelope };
}

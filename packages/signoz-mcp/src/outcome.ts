import type { ErrorCode } from "@flightrules/domain";

/**
 * Every MCP call resolves to one of these. The client never throws for a failure the server
 * described; it throws only for a programming error on our side. Callers branch on `outcome`,
 * which is why a zero-row success is a distinct member rather than an empty success: "the query
 * worked and found nothing" and "the query worked and found something" lead to different product
 * behaviour, and neither may be confused with "the query did not work".
 */
export const MCP_OUTCOMES = [
  "SUCCESS_WITH_ROWS",
  "SUCCESS_EMPTY",
  "UNSUPPORTED_RESPONSE",
  "MALFORMED_RESPONSE",
  "MCP_ERROR",
  "TRANSPORT_ERROR",
] as const;

export type McpOutcomeKind = (typeof MCP_OUTCOMES)[number];

/**
 * Advisory text the server returned alongside a result. SigNoz emits `[Decisions applied]` in a
 * separate content entry when it substitutes a default the request did not supply. Discarding it
 * would hide the fact that the server answered a different question from the one asked.
 */
export interface McpNotice {
  readonly source: "content";
  readonly text: string;
}

interface OutcomeBase {
  readonly tool: string;
  readonly notices: readonly McpNotice[];
  readonly durationMs: number;
}

export interface McpSuccessWithRows<T> extends OutcomeBase {
  readonly outcome: "SUCCESS_WITH_ROWS";
  readonly value: T;
  readonly rowCount: number;
  /** SigNoz deep link, preserved whenever the payload carried one (PRD FR-003). */
  readonly webUrl?: string;
}

export interface McpSuccessEmpty extends OutcomeBase {
  readonly outcome: "SUCCESS_EMPTY";
  readonly rowCount: 0;
  readonly webUrl?: string;
}

export interface McpUnsupportedResponse extends OutcomeBase {
  readonly outcome: "UNSUPPORTED_RESPONSE";
  readonly code: ErrorCode;
  readonly reason: string;
}

export interface McpMalformedResponse extends OutcomeBase {
  readonly outcome: "MALFORMED_RESPONSE";
  readonly code: ErrorCode;
  readonly reason: string;
}

export interface McpDeclaredError extends OutcomeBase {
  readonly outcome: "MCP_ERROR";
  readonly code: ErrorCode;
  readonly reason: string;
  /** Upstream envelope fields, redacted. Absent when the server sent prose only. */
  readonly serverCode?: string;
  readonly httpStatus?: number;
}

export interface McpTransportError extends OutcomeBase {
  readonly outcome: "TRANSPORT_ERROR";
  readonly code: ErrorCode;
  readonly reason: string;
  readonly retryable: boolean;
}

export type McpResult<T> =
  | McpSuccessWithRows<T>
  | McpSuccessEmpty
  | McpUnsupportedResponse
  | McpMalformedResponse
  | McpDeclaredError
  | McpTransportError;

export type McpFailure =
  | McpUnsupportedResponse
  | McpMalformedResponse
  | McpDeclaredError
  | McpTransportError;

export function isSuccess<T>(
  result: McpResult<T>,
): result is McpSuccessWithRows<T> | McpSuccessEmpty {
  return result.outcome === "SUCCESS_WITH_ROWS" || result.outcome === "SUCCESS_EMPTY";
}

export function hasRows<T>(result: McpResult<T>): result is McpSuccessWithRows<T> {
  return result.outcome === "SUCCESS_WITH_ROWS";
}

export function isFailure<T>(result: McpResult<T>): result is McpFailure {
  return !isSuccess(result);
}

import { type ErrorCode, FlightRulesError, redact, toErrorEnvelope } from "@flightrules/domain";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodType } from "zod";

/**
 * The HTTP boundary: the typed error envelope (PRD section 15), its status mapping, request
 * validation, and the redaction every response and log line passes through.
 *
 * Two rules hold everywhere below. A failed operation never returns 200 — the status is derived
 * from the error code by one table, not chosen per route. And nothing that reaches a client or a
 * log is built from a caught error's message: an unexpected failure's text may carry a connection
 * string, a header or a payload fragment, so `toErrorEnvelope` deliberately discards it.
 */

/**
 * Error code to HTTP status.
 *
 * Exhaustive by type: adding a code to `ERROR_CODES` without deciding its status is a compile
 * error rather than a silent 500.
 */
export const STATUS_BY_ERROR_CODE: Readonly<Record<ErrorCode, number>> = {
  CONFIG_INVALID: 400,
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  STATE_TRANSITION_INVALID: 409,
  CONTRACT_CONFLICT: 409,
  JOB_ALREADY_RUNNING: 409,
  DEMO_DISABLED: 403,
  CONTRACT_INVALID: 422,
  BASELINE_INSUFFICIENT_RUNS: 422,
  RELEASE_INSUFFICIENT_DATA: 422,
  TRACE_INCOMPLETE: 422,
  TRACE_INCONSISTENT: 422,
  GRAPH_INVALID: 422,
  NORMALISATION_FAILED: 422,
  TRACE_TOO_LARGE: 413,
  SIGNOZ_UNREACHABLE: 502,
  SIGNOZ_AUTH_FAILED: 502,
  MCP_UNAVAILABLE: 502,
  MCP_TOOL_MISSING: 502,
  MCP_RESPONSE_INVALID: 502,
  TRACE_QUERY_FAILED: 502,
  TRACE_FETCH_FAILED: 502,
  ARTIFACT_CREATE_FAILED: 502,
  ARTIFACT_VERIFY_FAILED: 502,
  ALERT_DID_NOT_FIRE: 502,
  EVALUATION_FAILED: 500,
};

export function statusFor(code: ErrorCode): number {
  return STATUS_BY_ERROR_CODE[code] ?? 500;
}

/** Sends the PRD section 15 envelope, redacted, with the status the code maps to. */
export function sendError(reply: FastifyReply, requestId: string, error: unknown): FastifyReply {
  const envelope = toErrorEnvelope(error, requestId);
  const status = statusFor(envelope.error.code);
  return reply.status(status).send(redact(envelope));
}

export function notFound(what: string, id: string): FlightRulesError {
  return new FlightRulesError("NOT_FOUND", {
    message: `No ${what} exists with that identifier.`,
    details: { resource: what, id },
  });
}

export function invalidTransition(what: string, from: string, to: string): FlightRulesError {
  return new FlightRulesError("STATE_TRANSITION_INVALID", {
    message: `A ${what} cannot move from ${from} to ${to}.`,
    details: { resource: what, from, to },
  });
}

/**
 * Parses a request part with a Zod schema, or throws the typed validation failure.
 *
 * Every issue is reported at once with its path, so a caller fixes one request in one pass rather
 * than discovering the fields one at a time.
 */
export function parseOrThrow<T>(schema: ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new FlightRulesError("VALIDATION_FAILED", {
    message: `The request ${what} failed validation.`,
    details: {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
        message: issue.message,
      })),
    },
  });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Validates a path identifier before it reaches a query.
 *
 * Every query is parameterised, so this is not what prevents injection; it is what stops an
 * arbitrary caller-supplied string reaching PostgreSQL's UUID parser and producing a driver error
 * where the honest answer is 404.
 */
export function requireUuid(value: string, what: string): string {
  if (!UUID_PATTERN.test(value)) throw notFound(what, value);
  return value;
}

export function requestIdOf(request: FastifyRequest): string {
  return String(request.id);
}

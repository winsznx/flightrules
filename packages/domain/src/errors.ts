/**
 * The error code set. Codes are part of the public API contract: they appear in the typed error
 * envelope, in CLI JSON output, and in evidence files.
 *
 * The first block is PRD section 19 verbatim. PRD section 19 opens with "Required error codes
 * **include**", so the list is a floor rather than a ceiling; the second block holds the three
 * additions Phase 09 needed to distinguish the outcomes PRD section 19's own guidance names —
 * "not found", "validation failure" and "illegal transition" — none of which any PRD code covers.
 * Every addition is recorded in ADR-0008. Adding a further code requires an ADR.
 */
export const ERROR_CODES = [
  "CONFIG_INVALID",
  "SIGNOZ_UNREACHABLE",
  "SIGNOZ_AUTH_FAILED",
  "MCP_UNAVAILABLE",
  "MCP_TOOL_MISSING",
  "MCP_RESPONSE_INVALID",
  "TRACE_QUERY_FAILED",
  "TRACE_FETCH_FAILED",
  "TRACE_INCOMPLETE",
  "TRACE_INCONSISTENT",
  "TRACE_TOO_LARGE",
  "GRAPH_INVALID",
  "NORMALISATION_FAILED",
  "CONTRACT_INVALID",
  "CONTRACT_CONFLICT",
  "BASELINE_INSUFFICIENT_RUNS",
  "EVALUATION_FAILED",
  "RELEASE_INSUFFICIENT_DATA",
  "ARTIFACT_CREATE_FAILED",
  "ARTIFACT_VERIFY_FAILED",
  "ALERT_DID_NOT_FIRE",
  "JOB_ALREADY_RUNNING",
  "DEMO_DISABLED",

  // Phase 09 additions. See ADR-0008.
  "NOT_FOUND",
  "VALIDATION_FAILED",
  "STATE_TRANSITION_INVALID",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && ERROR_CODE_SET.has(value);
}

/** Default operator-facing messages. Actionable, and free of any secret or payload content. */
const DEFAULT_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  CONFIG_INVALID: "FlightRules configuration is invalid. Review the reported fields and retry.",
  SIGNOZ_UNREACHABLE: "FlightRules could not reach SigNoz at the configured URL.",
  SIGNOZ_AUTH_FAILED: "SigNoz rejected the configured API key.",
  MCP_UNAVAILABLE: "The SigNoz MCP Server did not respond.",
  MCP_TOOL_MISSING: "The SigNoz MCP Server does not expose a tool FlightRules requires.",
  MCP_RESPONSE_INVALID: "The SigNoz MCP Server returned a response FlightRules could not validate.",
  TRACE_QUERY_FAILED: "FlightRules could not query traces from SigNoz.",
  TRACE_FETCH_FAILED: "FlightRules could not fetch complete trace details.",
  TRACE_INCOMPLETE: "The trace does not contain enough spans to reconstruct a complete run.",
  TRACE_INCONSISTENT: "Duplicate spans in this trace disagree on core identity fields.",
  TRACE_TOO_LARGE: "The trace exceeds the configured maximum span count.",
  GRAPH_INVALID: "The reconstructed trace graph is not valid.",
  NORMALISATION_FAILED: "FlightRules could not normalise this trace.",
  CONTRACT_INVALID: "The contract failed schema or consistency validation.",
  CONTRACT_CONFLICT: "Another active contract version conflicts with this change.",
  BASELINE_INSUFFICIENT_RUNS: "Fewer completed runs were found than the baseline requires.",
  EVALUATION_FAILED: "FlightRules could not complete the evaluation.",
  RELEASE_INSUFFICIENT_DATA: "More completed runs are required before a release decision.",
  ARTIFACT_CREATE_FAILED: "FlightRules could not create the SigNoz resource.",
  ARTIFACT_VERIFY_FAILED: "The created SigNoz resource did not match the intended specification.",
  ALERT_DID_NOT_FIRE: "The alert did not reach a firing state within the observation window.",
  JOB_ALREADY_RUNNING: "An equivalent job is already running for this entity.",
  DEMO_DISABLED: "Demo endpoints are disabled because DEMO_MODE is not enabled.",
  NOT_FOUND: "The requested resource does not exist.",
  VALIDATION_FAILED: "The request failed validation. Review the reported fields and retry.",
  STATE_TRANSITION_INVALID: "That transition is not permitted from the resource's current state.",
};

export interface ErrorEnvelope {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly requestId: string;
    readonly details: Readonly<Record<string, unknown>>;
  };
}

export interface FlightRulesErrorOptions {
  readonly message?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/**
 * The single error type crossing FlightRules boundaries. Carrying the code on the error means an
 * HTTP layer, a CLI, and a job runner all map failures the same way, which is what makes
 * "no internal error ever maps to pass" testable rather than aspirational.
 */
export class FlightRulesError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: ErrorCode, options: FlightRulesErrorOptions = {}) {
    super(options.message ?? DEFAULT_MESSAGES[code], { cause: options.cause });
    this.name = "FlightRulesError";
    this.code = code;
    this.details = options.details ?? {};
  }

  toEnvelope(requestId: string): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        requestId,
        details: this.details,
      },
    };
  }
}

/**
 * Converts any thrown value into an envelope. An unrecognised failure becomes
 * `EVALUATION_FAILED` with no detail leaked from the original error, because an unexpected
 * error's message may contain a connection string, a header, or a payload fragment.
 */
export function toErrorEnvelope(error: unknown, requestId: string): ErrorEnvelope {
  if (error instanceof FlightRulesError) return error.toEnvelope(requestId);
  return new FlightRulesError("EVALUATION_FAILED").toEnvelope(requestId);
}

export function defaultMessageFor(code: ErrorCode): string {
  return DEFAULT_MESSAGES[code];
}

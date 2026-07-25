import { describe, expect, it } from "vitest";
import { ERROR_CODES, FlightRulesError, isErrorCode, toErrorEnvelope } from "./index.js";

describe("error model", () => {
  it("defines every error code required by the PRD error model", () => {
    expect(ERROR_CODES).toEqual([
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
    ]);
  });

  it("gives every code a non-empty actionable default message", () => {
    for (const code of ERROR_CODES) {
      const error = new FlightRulesError(code);
      expect(error.message.length).toBeGreaterThan(10);
      expect(error.message).not.toBe(code);
    }
  });

  it("renders the typed envelope shape the API contract requires", () => {
    const error = new FlightRulesError("TRACE_FETCH_FAILED", {
      details: { traceId: "228cc4802f7b26ef44ac2a924841a047" },
    });

    expect(error.toEnvelope("req-1")).toEqual({
      error: {
        code: "TRACE_FETCH_FAILED",
        message: "FlightRules could not fetch complete trace details.",
        requestId: "req-1",
        details: { traceId: "228cc4802f7b26ef44ac2a924841a047" },
      },
    });
  });

  it("maps an unrecognised failure to EVALUATION_FAILED without leaking its message", () => {
    const envelope = toErrorEnvelope(
      new Error("upstream rejected header SIGNOZ-API-KEY: sensitive-value-from-config"),
      "req-2",
    );

    expect(envelope.error.code).toBe("EVALUATION_FAILED");
    expect(envelope.error.message).not.toContain("sensitive-value-from-config");
    expect(envelope.error.message).not.toContain("SIGNOZ-API-KEY");
    expect(envelope.error.details).toEqual({});
  });

  it("preserves a FlightRules error when converting an unknown value", () => {
    const envelope = toErrorEnvelope(new FlightRulesError("DEMO_DISABLED"), "req-3");
    expect(envelope.error.code).toBe("DEMO_DISABLED");
  });

  it("recognises only declared codes", () => {
    expect(isErrorCode("CONTRACT_INVALID")).toBe(true);
    expect(isErrorCode("NOT_A_REAL_CODE")).toBe(false);
    expect(isErrorCode(42)).toBe(false);
  });
});

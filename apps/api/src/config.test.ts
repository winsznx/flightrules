import { ERROR_CODES } from "@flightrules/domain";
import { describe, expect, it } from "vitest";
import { loadApiConfig } from "./config.js";
import { STATUS_BY_ERROR_CODE, statusFor } from "./http.js";

const BASE = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://flightrules:flightrules@localhost:5433/flightrules",
  SIGNOZ_URL: "http://localhost:8080",
  SIGNOZ_MCP_URL: "http://localhost:8000/mcp",
  SIGNOZ_API_KEY: "not-a-real-key",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
  IDEMPOTENCY_HASH_SALT: "0123456789abcdef0123456789abcdef",
} as const;

describe("API configuration", () => {
  it("resolves defaults for everything optional", () => {
    const config = loadApiConfig(BASE);
    expect(config).toMatchObject({
      port: 4000,
      host: "0.0.0.0",
      logLevel: "info",
      demoMode: false,
      maxRequestBodyBytes: 1_048_576,
      shutdownTimeoutMs: 10_000,
    });
  });

  it("never carries the API key value into the stored secret reference", () => {
    const config = loadApiConfig(BASE);
    expect(config.signozApiKeySecretReference).toBe("env:SIGNOZ_API_KEY");
    expect(config.signozApiKeySecretReference).not.toContain(BASE.SIGNOZ_API_KEY);
  });

  it("refuses a missing database URL", () => {
    const { DATABASE_URL, ...withoutDatabase } = BASE;
    void DATABASE_URL;
    expect(() => loadApiConfig(withoutDatabase)).toThrow(/DATABASE_URL/);
  });

  it("refuses a malformed database URL", () => {
    expect(() => loadApiConfig({ ...BASE, DATABASE_URL: "mysql://x" })).toThrow(/postgres/);
  });

  it("refuses an out-of-range port, timeout, pool size and body limit", () => {
    expect(() => loadApiConfig({ ...BASE, API_PORT: "0" })).toThrow();
    expect(() => loadApiConfig({ ...BASE, DATABASE_POOL_SIZE: "0" })).toThrow(/DATABASE_POOL_SIZE/);
    expect(() => loadApiConfig({ ...BASE, MAX_REQUEST_BODY_BYTES: "1" })).toThrow(
      /MAX_REQUEST_BODY_BYTES/,
    );
    expect(() => loadApiConfig({ ...BASE, SHUTDOWN_TIMEOUT_MS: "99" })).toThrow(
      /SHUTDOWN_TIMEOUT_MS/,
    );
  });

  it("refuses an unsupported log level", () => {
    expect(() => loadApiConfig({ ...BASE, LOG_LEVEL: "chatty" })).toThrow(/LOG_LEVEL/);
  });

  it("refuses a non-http demo agent URL", () => {
    expect(() => loadApiConfig({ ...BASE, DEMO_AGENT_URL: "file:///etc/passwd" })).toThrow(
      /DEMO_AGENT_URL/,
    );
  });

  it("rejects a loopback SigNoz URL in hosted mode (PRD section 18.2)", () => {
    expect(() => loadApiConfig({ ...BASE, DEPLOYMENT_MODE: "hosted" })).toThrow(/loopback/);
  });
});

describe("error code to HTTP status", () => {
  it("assigns a status to every declared code, so a new code cannot become a silent 500", () => {
    for (const code of ERROR_CODES) {
      expect(STATUS_BY_ERROR_CODE[code], code).toBeGreaterThanOrEqual(400);
    }
    expect(Object.keys(STATUS_BY_ERROR_CODE).sort()).toEqual([...ERROR_CODES].sort());
  });

  it("never maps a failure to a success status", () => {
    for (const code of ERROR_CODES) {
      expect(statusFor(code)).not.toBeLessThan(400);
    }
  });

  it("distinguishes the outcomes PRD section 19 asks to be distinguishable", () => {
    expect(statusFor("VALIDATION_FAILED")).toBe(400);
    expect(statusFor("NOT_FOUND")).toBe(404);
    expect(statusFor("CONTRACT_CONFLICT")).toBe(409);
    expect(statusFor("JOB_ALREADY_RUNNING")).toBe(409);
    expect(statusFor("STATE_TRANSITION_INVALID")).toBe(409);
    expect(statusFor("BASELINE_INSUFFICIENT_RUNS")).toBe(422);
    expect(statusFor("SIGNOZ_UNREACHABLE")).toBe(502);
    expect(statusFor("DEMO_DISABLED")).toBe(403);
    expect(statusFor("EVALUATION_FAILED")).toBe(500);
  });
});

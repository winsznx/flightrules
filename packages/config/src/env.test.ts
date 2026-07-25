import { describe, expect, it } from "vitest";
import { EnvValidationError, isPrivateHost, loadEnv } from "./index.js";

const validEnv = {
  DATABASE_URL: "postgres://flightrules:flightrules@localhost:5433/flightrules",
  SIGNOZ_URL: "http://localhost:8080",
  SIGNOZ_MCP_URL: "http://localhost:8000/mcp",
  SIGNOZ_API_KEY: "test-api-key",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
  IDEMPOTENCY_HASH_SALT: "0123456789abcdef",
} as const;

describe("environment validation", () => {
  it("accepts a complete self-host configuration and applies documented defaults", () => {
    const env = loadEnv({ ...validEnv });

    expect(env.NODE_ENV).toBe("development");
    expect(env.DEPLOYMENT_MODE).toBe("self-host");
    expect(env.RUNTIME_MODE).toBe("scripted-demo");
    expect(env.API_PORT).toBe(4000);
    expect(env.DEMO_MODE).toBe(false);
    expect(env.MAX_TRACES_PER_EVALUATION).toBe(500);
  });

  it("reports every missing required variable at once instead of only the first", () => {
    let error: unknown;
    try {
      loadEnv({});
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(EnvValidationError);
    const paths = (error as EnvValidationError).issues.map((issue) => issue.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "DATABASE_URL",
        "SIGNOZ_URL",
        "SIGNOZ_MCP_URL",
        "SIGNOZ_API_KEY",
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "IDEMPOTENCY_HASH_SALT",
      ]),
    );
  });

  it("rejects a database URL that is not a postgres connection string", () => {
    expect(() => loadEnv({ ...validEnv, DATABASE_URL: "mysql://localhost/flightrules" })).toThrow(
      /DATABASE_URL must be a postgres/,
    );
  });

  it("rejects a SigNoz URL that is not absolute http or https", () => {
    expect(() => loadEnv({ ...validEnv, SIGNOZ_URL: "localhost:8080" })).toThrow(
      /SIGNOZ_URL must be an absolute http or https URL/,
    );
  });

  it("rejects an idempotency salt that is too short to be useful", () => {
    expect(() => loadEnv({ ...validEnv, IDEMPOTENCY_HASH_SALT: "short" })).toThrow(
      /IDEMPOTENCY_HASH_SALT must be at least 16 characters/,
    );
  });

  it("permits loopback SigNoz addresses in self-host mode", () => {
    const env = loadEnv({ ...validEnv, DEPLOYMENT_MODE: "self-host" });
    expect(env.SIGNOZ_URL).toBe("http://localhost:8080");
  });

  it("rejects loopback and private SigNoz addresses in hosted mode", () => {
    let error: unknown;
    try {
      loadEnv({ ...validEnv, DEPLOYMENT_MODE: "hosted" });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(EnvValidationError);
    const paths = (error as EnvValidationError).issues.map((issue) => issue.path);
    expect(paths).toEqual(
      expect.arrayContaining(["SIGNOZ_URL", "SIGNOZ_MCP_URL", "OTEL_EXPORTER_OTLP_ENDPOINT"]),
    );
  });

  it("accepts public SigNoz addresses in hosted mode", () => {
    const env = loadEnv({
      ...validEnv,
      DEPLOYMENT_MODE: "hosted",
      SIGNOZ_URL: "https://signoz.example.com",
      SIGNOZ_MCP_URL: "https://mcp.example.com/mcp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://ingest.example.com",
    });
    expect(env.DEPLOYMENT_MODE).toBe("hosted");
  });

  it("coerces boolean and integer values supplied as environment strings", () => {
    const env = loadEnv({ ...validEnv, DEMO_MODE: "true", API_PORT: "4100" });
    expect(env.DEMO_MODE).toBe(true);
    expect(env.API_PORT).toBe(4100);
  });

  it("rejects a non-positive port", () => {
    expect(() => loadEnv({ ...validEnv, API_PORT: "0" })).toThrow(
      /API_PORT must be greater than zero/,
    );
  });
});

describe("private host detection", () => {
  it.each([
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "::1",
    "10.1.2.3",
    "192.168.0.5",
    "172.16.4.4",
    "169.254.169.254",
    "signoz.local",
  ])("treats %s as private", (hostname) => {
    expect(isPrivateHost(hostname)).toBe(true);
  });

  it.each(["signoz.example.com", "8.8.8.8", "172.32.0.1", "11.0.0.1"])(
    "treats %s as public",
    (hostname) => {
      expect(isPrivateHost(hostname)).toBe(false);
    },
  );
});

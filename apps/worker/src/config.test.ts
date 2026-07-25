import { describe, expect, it } from "vitest";
import { loadWorkerConfig } from "./config.js";
import { stageIndexOf, WORKER_STAGES } from "./runner.js";

const BASE = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://flightrules:flightrules@localhost:5433/flightrules",
  SIGNOZ_URL: "http://localhost:8080",
  SIGNOZ_MCP_URL: "http://localhost:8000/mcp",
  SIGNOZ_API_KEY: "not-a-real-key",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
  IDEMPOTENCY_HASH_SALT: "0123456789abcdef0123456789abcdef",
} as const;

describe("worker configuration", () => {
  it("resolves a distinct owner and sane defaults", () => {
    const config = loadWorkerConfig(BASE);
    expect(config.owner.length).toBeGreaterThan(0);
    expect(config.leaseSeconds).toBe(120);
    expect(config.heartbeatIntervalMs).toBeLessThan(config.leaseSeconds * 1000);
    expect(config.maxAttempts).toBe(3);
  });

  it("refuses a heartbeat that cannot outpace lease expiry", () => {
    // #given a heartbeat interval as long as the lease, a healthy worker would lose its own job
    expect(() =>
      loadWorkerConfig({
        ...BASE,
        WORKER_LEASE_SECONDS: "10",
        WORKER_HEARTBEAT_INTERVAL_MS: "10000",
      }),
    ).toThrow(/shorter than WORKER_LEASE_SECONDS/);
  });

  it("refuses out-of-range operational bounds", () => {
    expect(() => loadWorkerConfig({ ...BASE, WORKER_LEASE_SECONDS: "1" })).toThrow(
      /WORKER_LEASE_SECONDS/,
    );
    expect(() => loadWorkerConfig({ ...BASE, WORKER_MAX_ATTEMPTS: "0" })).toThrow(
      /WORKER_MAX_ATTEMPTS/,
    );
    expect(() => loadWorkerConfig({ ...BASE, WORKER_POLL_INTERVAL_MS: "0" })).toThrow(
      /WORKER_POLL_INTERVAL_MS/,
    );
  });

  it("derives an identity when WORKER_ID is unset or empty", () => {
    // `.env.example` ships `WORKER_ID=`, so an empty value must mean "derive one".
    expect(loadWorkerConfig({ ...BASE, WORKER_ID: "" }).owner.length).toBeGreaterThan(0);
    expect(loadWorkerConfig(BASE).owner).toBe(loadWorkerConfig({ ...BASE, WORKER_ID: "" }).owner);
  });

  it("refuses an over-long worker identity", () => {
    expect(() => loadWorkerConfig({ ...BASE, WORKER_ID: "w".repeat(201) })).toThrow(/WORKER_ID/);
  });
});

describe("progress stages", () => {
  it("indexes every declared stage from one, monotonically", () => {
    const indexes = WORKER_STAGES.map(stageIndexOf);
    expect(indexes).toEqual(WORKER_STAGES.map((_, position) => position + 1));
  });

  it("refuses a stage nobody declared", () => {
    expect(() => stageIndexOf("inventing_a_stage")).toThrow(/not a declared progress stage/);
  });
});

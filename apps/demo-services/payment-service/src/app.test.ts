import { afterEach, describe, expect, it } from "vitest";
import { buildPaymentService, type PaymentServiceApp } from "./app.js";

const SALT = "0123456789abcdef0123456789abcdef";

let app: PaymentServiceApp | undefined;

function makeApp(demoMode = true, slowResponseMs = 40) {
  app = buildPaymentService({ idempotencyHashSalt: SALT, demoMode, slowResponseMs });
  return app;
}

afterEach(async () => {
  await app?.server.close();
  app = undefined;
});

const refundBody = (overrides: Record<string, unknown> = {}) => ({
  orderId: "ord-98271",
  amountCents: 4820,
  runId: "run_test",
  ...overrides,
});

describe("payment service", () => {
  it("reports healthy", async () => {
    const { server } = makeApp();
    const response = await server.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", service: "payment-service" });
  });

  it("issues a refund and records it in the ledger", async () => {
    const { server, ledger } = makeApp();
    const response = await server.inject({
      method: "POST",
      url: "/payments/refund",
      payload: refundBody({ idempotencyKey: "key-a" }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "succeeded", deduplicated: false });
    expect(ledger.entriesForOrder("ord-98271")).toHaveLength(1);
  });

  it("deduplicates a replay of the same idempotency key", async () => {
    const { server, ledger } = makeApp();
    const first = await server.inject({
      method: "POST",
      url: "/payments/refund",
      payload: refundBody({ idempotencyKey: "key-a" }),
    });
    const replay = await server.inject({
      method: "POST",
      url: "/payments/refund",
      payload: refundBody({ idempotencyKey: "key-a", attempt: 2 }),
    });

    expect(replay.json().deduplicated).toBe(true);
    expect(replay.json().refundId).toBe(first.json().refundId);
    expect(ledger.entriesForOrder("ord-98271")).toHaveLength(1);
  });

  it("commits the write before an injected slow response, so a timed-out caller has still moved money", async () => {
    const { server, ledger } = makeApp(true, 30);
    const response = await server.inject({
      method: "POST",
      url: "/payments/refund",
      payload: refundBody({ idempotencyKey: "key-a", fault: "slow_first_attempt", attempt: 1 }),
    });

    expect(response.statusCode).toBe(200);
    expect(ledger.entriesForOrder("ord-98271")).toHaveLength(1);
  });

  it("does not delay a retry, only the first attempt", async () => {
    const { server } = makeApp(true, 5_000);
    const started = Date.now();
    const response = await server.inject({
      method: "POST",
      url: "/payments/refund",
      payload: refundBody({ idempotencyKey: "key-a2", fault: "slow_first_attempt", attempt: 2 }),
    });

    expect(response.statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("reports a duplicated order through the ledger endpoint", async () => {
    const { server } = makeApp();
    await server.inject({
      method: "POST",
      url: "/payments/refund",
      payload: refundBody({ idempotencyKey: "key-a1" }),
    });
    await server.inject({
      method: "POST",
      url: "/payments/refund",
      payload: refundBody({ idempotencyKey: "key-a2", attempt: 2 }),
    });

    const ledger = await server.inject({ method: "GET", url: "/payments/ledger/ord-98271" });
    expect(ledger.json()).toMatchObject({ refundCount: 2, duplicate: true });

    const all = await server.inject({ method: "GET", url: "/payments/ledger" });
    expect(all.json().duplicates).toHaveLength(1);
  });

  it("never exposes a raw idempotency key through the ledger endpoint", async () => {
    const { server } = makeApp();
    await server.inject({
      method: "POST",
      url: "/payments/refund",
      payload: refundBody({ idempotencyKey: "super-secret-key-value" }),
    });

    const ledger = await server.inject({ method: "GET", url: "/payments/ledger" });
    expect(ledger.body).not.toContain("super-secret-key-value");
    expect(ledger.json().entries[0]).toMatchObject({ idempotencyKeyPresent: true });
  });

  it("rejects a refund with a missing amount", async () => {
    const { server } = makeApp();
    const response = await server.inject({
      method: "POST",
      url: "/payments/refund",
      payload: { orderId: "ord-1", runId: "run_1" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
  });

  it("rejects a negative refund amount", async () => {
    const { server } = makeApp();
    const response = await server.inject({
      method: "POST",
      url: "/payments/refund",
      payload: refundBody({ amountCents: -100 }),
    });
    expect(response.statusCode).toBe(400);
  });

  it("clears the ledger on reset in demo mode", async () => {
    const { server, ledger } = makeApp(true);
    await server.inject({
      method: "POST",
      url: "/payments/refund",
      payload: refundBody({ idempotencyKey: "key-a" }),
    });

    const reset = await server.inject({ method: "POST", url: "/payments/reset" });
    expect(reset.statusCode).toBe(200);
    expect(ledger.entries()).toEqual([]);
  });

  it("refuses to reset outside demo mode", async () => {
    const { server, ledger } = makeApp(false);
    await server.inject({
      method: "POST",
      url: "/payments/refund",
      payload: refundBody({ idempotencyKey: "key-a" }),
    });

    const reset = await server.inject({ method: "POST", url: "/payments/reset" });
    expect(reset.statusCode).toBe(403);
    expect(reset.json().error.code).toBe("DEMO_DISABLED");
    expect(ledger.entries()).toHaveLength(1);
  });
});

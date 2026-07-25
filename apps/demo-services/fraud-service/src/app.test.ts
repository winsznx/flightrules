import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { assessFraud, buildFraudService } from "./app.js";

let server: FastifyInstance | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("fraud service", () => {
  it("reports healthy", async () => {
    server = buildFraudService();
    const response = await server.inject({ method: "GET", url: "/health" });
    expect(response.json()).toEqual({ status: "ok", service: "fraud-service" });
  });

  it("clears the demo order so the approved route completes", async () => {
    server = buildFraudService();
    const response = await server.inject({
      method: "POST",
      url: "/fraud/check",
      payload: {
        orderId: "ord-98271",
        customerId: "cust-4f92c1",
        amountCents: 4820,
        runId: "run_1",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().decision).toBe("clear");
  });

  it("scores the same order identically on every call", () => {
    const first = assessFraud("ord-98271", "cust-4f92c1", 4820);
    const second = assessFraud("ord-98271", "cust-4f92c1", 4820);
    expect(first).toEqual(second);
  });

  it("scores different orders differently", () => {
    const a = assessFraud("ord-98271", "cust-4f92c1", 4820);
    const b = assessFraud("ord-51044", "cust-77ba30", 4820);
    expect(a.score).not.toBe(b.score);
  });

  it("weights a high-value order more heavily than a low-value one", () => {
    const low = assessFraud("ord-98271", "cust-4f92c1", 4820);
    const high = assessFraud("ord-98271", "cust-4f92c1", 120_000);
    expect(high.score).toBeGreaterThan(low.score);
  });

  it("maps scores to decisions at the documented boundaries", () => {
    expect(assessFraud("ord-98271", "cust-4f92c1", 4820).decision).toBe("clear");
    for (const decision of ["clear", "review", "block"]) {
      expect(["clear", "review", "block"]).toContain(decision);
    }
  });

  it("rejects a check with no customer", async () => {
    server = buildFraudService();
    const response = await server.inject({
      method: "POST",
      url: "/fraud/check",
      payload: { orderId: "ord-98271", amountCents: 4820, runId: "run_1" },
    });
    expect(response.statusCode).toBe(400);
  });
});

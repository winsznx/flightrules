import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildOrderService, DEFAULT_ORDER_ID, findOrder } from "./app.js";

let server: FastifyInstance | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("order service", () => {
  it("reports healthy", async () => {
    server = buildOrderService();
    const response = await server.inject({ method: "GET", url: "/health" });
    expect(response.json()).toEqual({ status: "ok", service: "order-service" });
  });

  it("returns the demo order", async () => {
    server = buildOrderService();
    const response = await server.inject({
      method: "POST",
      url: "/orders/lookup",
      payload: { orderId: DEFAULT_ORDER_ID, runId: "run_1" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      orderId: DEFAULT_ORDER_ID,
      customerId: "cust-4f92c1",
      totalCents: 4820,
      currency: "USD",
    });
  });

  it("returns the same order every time, so repeated runs are comparable", async () => {
    server = buildOrderService();
    const first = await server.inject({
      method: "POST",
      url: "/orders/lookup",
      payload: { orderId: DEFAULT_ORDER_ID, runId: "run_1" },
    });
    const second = await server.inject({
      method: "POST",
      url: "/orders/lookup",
      payload: { orderId: DEFAULT_ORDER_ID, runId: "run_2" },
    });

    const strip = (body: Record<string, unknown>) => {
      const { runId, ...rest } = body;
      void runId;
      return rest;
    };
    expect(strip(first.json())).toEqual(strip(second.json()));
  });

  it("reports an unknown order rather than inventing one", async () => {
    server = buildOrderService();
    const response = await server.inject({
      method: "POST",
      url: "/orders/lookup",
      payload: { orderId: "ord-does-not-exist", runId: "run_1" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("ORDER_NOT_FOUND");
  });

  it("rejects a lookup with no run identifier", async () => {
    server = buildOrderService();
    const response = await server.inject({
      method: "POST",
      url: "/orders/lookup",
      payload: { orderId: DEFAULT_ORDER_ID },
    });
    expect(response.statusCode).toBe(400);
  });

  it("exposes a high-value order for the policy band", () => {
    expect(findOrder("ord-98271-hv")?.totalCents).toBe(120_000);
  });
});

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildPolicyService, policyFor } from "./app.js";

let server: FastifyInstance | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("policy service", () => {
  it("reports healthy", async () => {
    server = buildPolicyService();
    const response = await server.inject({ method: "GET", url: "/health" });
    expect(response.json()).toEqual({ status: "ok", service: "policy-service" });
  });

  it("returns a refund policy that requires a fraud check", async () => {
    server = buildPolicyService();
    const response = await server.inject({
      method: "POST",
      url: "/policy/retrieve",
      payload: { orderId: "ord-98271", runId: "run_1" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      policyId: "refund-standard",
      requiresFraudCheck: true,
      refundWindowDays: 30,
    });
  });

  it("applies the high-value policy band with a shorter refund window", () => {
    expect(policyFor(120_000)).toMatchObject({
      policyId: "refund-high-value",
      refundWindowDays: 14,
      requiresFraudCheck: true,
    });
  });

  it("returns the same policy for the same order on every call", async () => {
    server = buildPolicyService();
    const call = () =>
      server?.inject({
        method: "POST",
        url: "/policy/retrieve",
        payload: { orderId: "ord-98271", runId: "run_1" },
      });
    expect((await call())?.json()).toEqual((await call())?.json());
  });

  it("rejects a request with no order identifier", async () => {
    server = buildPolicyService();
    const response = await server.inject({
      method: "POST",
      url: "/policy/retrieve",
      payload: { runId: "run_1" },
    });
    expect(response.statusCode).toBe(400);
  });
});

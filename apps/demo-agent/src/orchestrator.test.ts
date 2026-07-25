import type { AddressInfo } from "node:net";
import { buildFraudService } from "@flightrules/fraud-service";
import { buildNotificationService } from "@flightrules/notification-service";
import { buildOrderService } from "@flightrules/order-service";
import { buildPaymentService } from "@flightrules/payment-service";
import { buildPolicyService } from "@flightrules/policy-service";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DemoClients } from "./clients.js";
import { RefundAgent } from "./orchestrator.js";
import { RELEASE_V1, RELEASE_V2, ScriptedProvider } from "./provider.js";

/**
 * The whole demo topology, running for real over HTTP on ephemeral ports.
 *
 * These are unit-project tests because they need no external service — no database, no SigNoz, no
 * network beyond loopback — but they exercise genuine HTTP calls, a genuine client-side timeout,
 * and the payment service's genuine ledger. Nothing here is stubbed.
 */
const SALT = "0123456789abcdef0123456789abcdef";
const ORDER_ID = "ord-98271";

let policy: FastifyInstance;
let order: FastifyInstance;
let fraud: FastifyInstance;
let payment: ReturnType<typeof buildPaymentService>;
let notification: ReturnType<typeof buildNotificationService>;
let agent: RefundAgent;

const listen = async (server: FastifyInstance): Promise<string> => {
  await server.listen({ port: 0, host: "127.0.0.1" });
  const address = server.server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
};

beforeAll(async () => {
  policy = buildPolicyService();
  order = buildOrderService();
  fraud = buildFraudService();
  // The injected delay must exceed the client's payment timeout for the v2 first attempt to time
  // out for real rather than by assertion.
  payment = buildPaymentService({ idempotencyHashSalt: SALT, demoMode: true, slowResponseMs: 600 });
  notification = buildNotificationService({ demoMode: true });

  const endpoints = {
    policy: await listen(policy),
    order: await listen(order),
    fraud: await listen(fraud),
    payment: await listen(payment.server),
    notification: await listen(notification.server),
  };

  agent = new RefundAgent({
    clients: new DemoClients({ endpoints, defaultTimeoutMs: 5_000, paymentTimeoutMs: 200 }),
    provider: new ScriptedProvider(),
  });
}, 30_000);

afterAll(async () => {
  await Promise.all([
    policy?.close(),
    order?.close(),
    fraud?.close(),
    payment?.server.close(),
    notification?.server.close(),
  ]);
});

const stepNames = (steps: readonly { name: string }[]) => steps.map((step) => step.name);

describe("refund-agent-v1, the approved release", () => {
  it("visits every required step exactly once, in the approved order", async () => {
    payment.ledger.reset();
    const result = await agent.runRefund({ orderId: ORDER_ID, releaseId: RELEASE_V1 });

    expect(stepNames(result.steps)).toEqual([
      "policy.retrieve",
      "order.lookup",
      "fraud.check",
      "refund.calculate",
      "payment.refund",
      "customer.notify",
    ]);
  });

  it("retrieves policy and checks fraud before writing the payment", async () => {
    payment.ledger.reset();
    const result = await agent.runRefund({ orderId: ORDER_ID, releaseId: RELEASE_V1 });
    const names = stepNames(result.steps);

    expect(names.indexOf("policy.retrieve")).toBeLessThan(names.indexOf("payment.refund"));
    expect(names.indexOf("fraud.check")).toBeLessThan(names.indexOf("payment.refund"));
  });

  it("writes the refund exactly once", async () => {
    payment.ledger.reset();
    const result = await agent.runRefund({ orderId: ORDER_ID, releaseId: RELEASE_V1 });

    expect(result.paymentAttempts).toBe(1);
    expect(payment.ledger.entriesForOrder(ORDER_ID)).toHaveLength(1);
    expect(payment.ledger.duplicatedSideEffects()).toEqual([]);
  });

  it("does not retry any step", async () => {
    payment.ledger.reset();
    const result = await agent.runRefund({ orderId: ORDER_ID, releaseId: RELEASE_V1 });

    expect(result.steps.every((step) => step.attempt === 1)).toBe(true);
    expect(result.steps.every((step) => step.outcome === "ok")).toBe(true);
  });

  it("classifies the payment write as a write side effect and the reads as reads", async () => {
    payment.ledger.reset();
    const result = await agent.runRefund({ orderId: ORDER_ID, releaseId: RELEASE_V1 });
    const byName = new Map(result.steps.map((step) => [step.name, step]));

    expect(byName.get("payment.refund")?.sideEffect).toBe("write");
    expect(byName.get("policy.retrieve")?.sideEffect).toBe("read");
    expect(byName.get("fraud.check")?.sideEffect).toBe("read");
    expect(byName.get("customer.notify")?.sideEffect).toBe("external");
  });

  it("produces the same route on repeated runs", async () => {
    payment.ledger.reset();
    const first = await agent.runRefund({ orderId: ORDER_ID, releaseId: RELEASE_V1 });
    payment.ledger.reset();
    const second = await agent.runRefund({ orderId: ORDER_ID, releaseId: RELEASE_V1 });

    expect(stepNames(first.steps)).toEqual(stepNames(second.steps));
  });
});

describe("refund-agent-v2, the unsafe release", () => {
  it("skips the policy retrieval", async () => {
    payment.ledger.reset();
    const result = await agent.runRefund({ orderId: ORDER_ID, releaseId: RELEASE_V2 });
    expect(stepNames(result.steps)).not.toContain("policy.retrieve");
  });

  it("skips the fraud check", async () => {
    payment.ledger.reset();
    const result = await agent.runRefund({ orderId: ORDER_ID, releaseId: RELEASE_V2 });
    expect(stepNames(result.steps)).not.toContain("fraud.check");
  });

  it("times out on the first payment attempt and retries", async () => {
    payment.ledger.reset();
    const result = await agent.runRefund({ orderId: ORDER_ID, releaseId: RELEASE_V2 });

    const paymentSteps = result.steps.filter((step) => step.name === "payment.refund");
    expect(paymentSteps).toHaveLength(2);
    expect(paymentSteps[0]).toMatchObject({ attempt: 1, outcome: "timeout" });
    expect(paymentSteps[1]).toMatchObject({ attempt: 2, outcome: "ok" });
    expect(result.paymentAttempts).toBe(2);
  });

  it("refunds the order twice, recorded in the payment service's own ledger", async () => {
    payment.ledger.reset();
    await agent.runRefund({ orderId: ORDER_ID, releaseId: RELEASE_V2 });

    const entries = payment.ledger.entriesForOrder(ORDER_ID);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.refundId).not.toBe(entries[1]?.refundId);
    expect(payment.ledger.duplicatedSideEffects()).toEqual([
      { runId: expect.any(String), orderId: ORDER_ID, count: 2, refundIds: expect.any(Array) },
    ]);
  });

  it("retries with a different idempotency key, which is why the write duplicates", async () => {
    payment.ledger.reset();
    await agent.runRefund({ orderId: ORDER_ID, releaseId: RELEASE_V2 });

    const hashes = payment.ledger.entriesForOrder(ORDER_ID).map((e) => e.idempotencyKeyHash);
    expect(hashes[0]).not.toBe(hashes[1]);
    expect(hashes.every((hash) => hash !== null)).toBe(true);
  });

  it("still reports success to the caller", async () => {
    payment.ledger.reset();
    const result = await agent.runRefund({ orderId: ORDER_ID, releaseId: RELEASE_V2 });
    expect(result.refundId).toMatch(/^rfnd_/);
  });
});

describe("the reveal: same answer, different route", () => {
  it("returns a materially identical customer message for both releases", async () => {
    payment.ledger.reset();
    const v1 = await agent.runRefund({ orderId: ORDER_ID, releaseId: RELEASE_V1 });
    payment.ledger.reset();
    const v2 = await agent.runRefund({ orderId: ORDER_ID, releaseId: RELEASE_V2 });

    // This is the premise of the whole product. If this assertion ever fails, output evaluation
    // would catch the regression and the demo no longer demonstrates anything.
    expect(v2.customerMessage).toBe(v1.customerMessage);
    expect(v2.amountCents).toBe(v1.amountCents);
  });

  it("takes a different execution route for the same answer", async () => {
    payment.ledger.reset();
    const v1 = await agent.runRefund({ orderId: ORDER_ID, releaseId: RELEASE_V1 });
    payment.ledger.reset();
    const v2 = await agent.runRefund({ orderId: ORDER_ID, releaseId: RELEASE_V2 });

    expect(stepNames(v2.steps)).not.toEqual(stepNames(v1.steps));
  });

  it("moves money twice in v2 and once in v1 for the same visible outcome", async () => {
    payment.ledger.reset();
    await agent.runRefund({ orderId: ORDER_ID, releaseId: RELEASE_V1 });
    const v1Writes = payment.ledger.entriesForOrder(ORDER_ID).length;

    payment.ledger.reset();
    await agent.runRefund({ orderId: ORDER_ID, releaseId: RELEASE_V2 });
    const v2Writes = payment.ledger.entriesForOrder(ORDER_ID).length;

    expect(v1Writes).toBe(1);
    expect(v2Writes).toBe(2);
  });

  it("labels each run with its scenario", async () => {
    payment.ledger.reset();
    const v1 = await agent.runRefund({ orderId: ORDER_ID, releaseId: RELEASE_V1 });
    payment.ledger.reset();
    const v2 = await agent.runRefund({ orderId: ORDER_ID, releaseId: RELEASE_V2 });

    expect(v1.scenario).toBe("approved-refund");
    expect(v2.scenario).toBe("unsafe-duplicate-refund");
  });

  it("gives every run a distinct identifier", async () => {
    payment.ledger.reset();
    const first = await agent.runRefund({ orderId: ORDER_ID, releaseId: RELEASE_V1 });
    payment.ledger.reset();
    const second = await agent.runRefund({ orderId: ORDER_ID, releaseId: RELEASE_V1 });

    expect(first.runId).not.toBe(second.runId);
    expect(first.runId).toMatch(/^run_[a-f0-9]{20}$/);
  });
});

describe("duplicate detection is scoped to a single run", () => {
  it("reports no duplicate when many approved runs refund the same order", async () => {
    // Twenty legitimate baseline runs against one order are twenty separate refunds, not a
    // duplicated side effect. Counting across the ledger's lifetime would report a false
    // violation for every seeded baseline.
    payment.ledger.reset();
    for (let index = 0; index < 5; index += 1) {
      await agent.runRefund({ orderId: ORDER_ID, releaseId: RELEASE_V1 });
    }

    expect(payment.ledger.entriesForOrder(ORDER_ID)).toHaveLength(5);
    expect(payment.ledger.duplicatedSideEffects()).toEqual([]);
  });

  it("reports exactly one duplicate for one unsafe run among approved runs", async () => {
    payment.ledger.reset();
    await agent.runRefund({ orderId: ORDER_ID, releaseId: RELEASE_V1 });
    const unsafe = await agent.runRefund({ orderId: ORDER_ID, releaseId: RELEASE_V2 });
    await agent.runRefund({ orderId: ORDER_ID, releaseId: RELEASE_V1 });

    const duplicates = payment.ledger.duplicatedSideEffects();
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.runId).toBe(unsafe.runId);
    expect(duplicates[0]?.count).toBe(2);
  });
});

describe("reset", () => {
  it("returns the payment ledger to a known empty state", async () => {
    await agent.runRefund({ orderId: ORDER_ID, releaseId: RELEASE_V2 });
    expect(payment.ledger.entries().length).toBeGreaterThan(0);

    payment.ledger.reset();
    expect(payment.ledger.entries()).toEqual([]);
    expect(payment.ledger.duplicatedSideEffects()).toEqual([]);
  });
});

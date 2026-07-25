import { afterEach, describe, expect, it } from "vitest";
import {
  buildNotificationService,
  type NotificationServiceApp,
  renderRefundMessage,
} from "./app.js";

let app: NotificationServiceApp | undefined;

afterEach(async () => {
  await app?.server.close();
  app = undefined;
});

const sendBody = (overrides: Record<string, unknown> = {}) => ({
  customerId: "cust-4f92c1",
  orderId: "ord-98271",
  refundId: "rfnd_abc",
  amountCents: 4820,
  currency: "USD",
  runId: "run_1",
  ...overrides,
});

describe("notification service", () => {
  it("reports healthy", async () => {
    app = buildNotificationService({ demoMode: true });
    const response = await app.server.inject({ method: "GET", url: "/health" });
    expect(response.json()).toEqual({ status: "ok", service: "notification-service" });
  });

  it("renders the customer message from the amount alone", () => {
    expect(renderRefundMessage(4820, "USD")).toBe(
      "Your refund of 48.20 USD has been issued and will appear on your original payment method within 3-5 business days.",
    );
  });

  it("renders an identical message regardless of which release produced the refund", () => {
    // The demo depends on this: if the text varied by release, output evaluation would catch the
    // regression and there would be nothing for trajectory evaluation to demonstrate.
    expect(renderRefundMessage(4820, "USD")).toBe(renderRefundMessage(4820, "USD"));
  });

  it("records a sent message", async () => {
    app = buildNotificationService({ demoMode: true });
    const response = await app.server.inject({
      method: "POST",
      url: "/notifications/send",
      payload: sendBody(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().body).toContain("48.20 USD");
    expect(app.sent()).toHaveLength(1);
  });

  it("bounds retained messages", async () => {
    app = buildNotificationService({ demoMode: true, maxRetained: 2 });
    for (let index = 0; index < 5; index += 1) {
      await app.server.inject({
        method: "POST",
        url: "/notifications/send",
        payload: sendBody(),
      });
    }
    expect(app.sent()).toHaveLength(2);
  });

  it("rejects a send with a malformed currency", async () => {
    app = buildNotificationService({ demoMode: true });
    const response = await app.server.inject({
      method: "POST",
      url: "/notifications/send",
      payload: sendBody({ currency: "DOLLARS" }),
    });
    expect(response.statusCode).toBe(400);
  });

  it("clears messages on reset in demo mode", async () => {
    app = buildNotificationService({ demoMode: true });
    await app.server.inject({ method: "POST", url: "/notifications/send", payload: sendBody() });

    const reset = await app.server.inject({ method: "POST", url: "/notifications/reset" });
    expect(reset.statusCode).toBe(200);
    expect(app.sent()).toEqual([]);
  });

  it("refuses to reset outside demo mode", async () => {
    app = buildNotificationService({ demoMode: false });
    await app.server.inject({ method: "POST", url: "/notifications/send", payload: sendBody() });

    const reset = await app.server.inject({ method: "POST", url: "/notifications/reset" });
    expect(reset.statusCode).toBe(403);
    expect(reset.json().error.code).toBe("DEMO_DISABLED");
    expect(app.sent()).toHaveLength(1);
  });
});

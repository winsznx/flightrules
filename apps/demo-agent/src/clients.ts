import { context as otelContext, propagation } from "@opentelemetry/api";
import { z } from "zod";

/**
 * Typed clients for the demo services.
 *
 * Every response is validated at runtime. A service that changes shape must fail here, visibly,
 * rather than producing a run whose telemetry silently misses a field the contract selects on.
 */

export class ServiceTimeoutError extends Error {
  readonly service: string;
  constructor(service: string, timeoutMs: number) {
    super(`${service} did not respond within ${timeoutMs}ms`);
    this.name = "ServiceTimeoutError";
    this.service = service;
  }
}

export class ServiceRequestError extends Error {
  readonly service: string;
  readonly status: number;
  constructor(service: string, status: number, detail: string) {
    super(`${service} returned ${status}: ${detail}`);
    this.name = "ServiceRequestError";
    this.service = service;
    this.status = status;
  }
}

export interface PostOptions {
  readonly timeoutMs: number;
  readonly headers?: Readonly<Record<string, string>>;
}

async function postJson<T>(
  service: string,
  url: string,
  body: unknown,
  schema: z.ZodType<T>,
  options: PostOptions,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  // Propagate trace context so every service call joins the run's single trace. Without this the
  // graph engine sees five disconnected traces and cannot reconstruct a trajectory at all.
  const traceHeaders: Record<string, string> = {};
  propagation.inject(otelContext.active(), traceHeaders);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...traceHeaders, ...options.headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new ServiceRequestError(
        service,
        response.status,
        (await response.text()).slice(0, 200),
      );
    }

    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) {
      throw new ServiceRequestError(
        service,
        response.status,
        `response failed validation: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      );
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ServiceTimeoutError(service, options.timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export const PolicyResponseSchema = z.object({
  policyId: z.string(),
  policyVersion: z.string(),
  maxRefundCents: z.number().int(),
  requiresFraudCheck: z.boolean(),
  refundWindowDays: z.number().int(),
});
export type PolicyResponse = z.infer<typeof PolicyResponseSchema>;

export const OrderResponseSchema = z.object({
  orderId: z.string(),
  customerId: z.string(),
  totalCents: z.number().int(),
  currency: z.string(),
  status: z.string(),
  placedAtIso: z.string(),
});
export type OrderResponse = z.infer<typeof OrderResponseSchema>;

export const FraudResponseSchema = z.object({
  decision: z.enum(["clear", "review", "block"]),
  score: z.number().int(),
  modelVersion: z.string(),
});
export type FraudResponse = z.infer<typeof FraudResponseSchema>;

export const RefundResponseSchema = z.object({
  refundId: z.string(),
  orderId: z.string(),
  amountCents: z.number().int(),
  status: z.string(),
  deduplicated: z.boolean(),
  idempotencyKeyPresent: z.boolean(),
  attempt: z.number().int(),
});
export type RefundResponse = z.infer<typeof RefundResponseSchema>;

export const NotificationResponseSchema = z.object({
  messageId: z.string(),
  customerId: z.string(),
  orderId: z.string(),
  body: z.string(),
});
export type NotificationResponse = z.infer<typeof NotificationResponseSchema>;

export interface ServiceEndpoints {
  readonly policy: string;
  readonly order: string;
  readonly fraud: string;
  readonly payment: string;
  readonly notification: string;
}

export interface DemoClientsOptions {
  readonly endpoints: ServiceEndpoints;
  readonly defaultTimeoutMs: number;
  /** Timeout for the payment write. The injected fault holds the response past this deadline. */
  readonly paymentTimeoutMs: number;
}

export class DemoClients {
  readonly #options: DemoClientsOptions;

  constructor(options: DemoClientsOptions) {
    this.#options = options;
  }

  retrievePolicy(orderId: string, runId: string): Promise<PolicyResponse> {
    return postJson(
      "policy-service",
      `${this.#options.endpoints.policy}/policy/retrieve`,
      { orderId, runId },
      PolicyResponseSchema,
      { timeoutMs: this.#options.defaultTimeoutMs },
    );
  }

  lookupOrder(orderId: string, runId: string): Promise<OrderResponse> {
    return postJson(
      "order-service",
      `${this.#options.endpoints.order}/orders/lookup`,
      { orderId, runId },
      OrderResponseSchema,
      { timeoutMs: this.#options.defaultTimeoutMs },
    );
  }

  checkFraud(
    orderId: string,
    customerId: string,
    amountCents: number,
    runId: string,
  ): Promise<FraudResponse> {
    return postJson(
      "fraud-service",
      `${this.#options.endpoints.fraud}/fraud/check`,
      { orderId, customerId, amountCents, runId },
      FraudResponseSchema,
      { timeoutMs: this.#options.defaultTimeoutMs },
    );
  }

  issueRefund(input: {
    readonly orderId: string;
    readonly amountCents: number;
    readonly idempotencyKey?: string | undefined;
    readonly attempt: number;
    readonly runId: string;
    readonly fault: "none" | "slow_first_attempt";
  }): Promise<RefundResponse> {
    return postJson(
      "payment-service",
      `${this.#options.endpoints.payment}/payments/refund`,
      input,
      RefundResponseSchema,
      { timeoutMs: this.#options.paymentTimeoutMs },
    );
  }

  notifyCustomer(input: {
    readonly customerId: string;
    readonly orderId: string;
    readonly refundId: string;
    readonly amountCents: number;
    readonly currency: string;
    readonly runId: string;
  }): Promise<NotificationResponse> {
    return postJson(
      "notification-service",
      `${this.#options.endpoints.notification}/notifications/send`,
      input,
      NotificationResponseSchema,
      { timeoutMs: this.#options.defaultTimeoutMs },
    );
  }
}

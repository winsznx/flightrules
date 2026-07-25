import { randomUUID } from "node:crypto";
import type { SideEffect } from "@flightrules/domain";
import {
  type DemoClients,
  type RefundResponse,
  ServiceRequestError,
  ServiceTimeoutError,
} from "./clients.js";
import { stepCategoryFor, withRunSpan, withStepSpan } from "./instrumentation.js";
import { type Provider, RELEASE_V1, RELEASE_V2 } from "./provider.js";

export interface StepRecord {
  readonly name: string;
  readonly toolName: string;
  readonly service: string;
  readonly sideEffect: SideEffect;
  readonly dataDomain: string;
  readonly attempt: number;
  readonly outcome: "ok" | "timeout" | "error";
  readonly durationMs: number;
}

export interface RunResult {
  readonly runId: string;
  /** The primary trace for this run, the identifier FlightRules retrieves evidence by. */
  readonly traceId: string;
  readonly releaseId: string;
  readonly orderId: string;
  readonly scenario: string;
  /** The text the customer sees. Materially identical across releases, by design. */
  readonly customerMessage: string;
  readonly refundId: string;
  readonly amountCents: number;
  readonly steps: readonly StepRecord[];
  readonly paymentAttempts: number;
  readonly durationMs: number;
}

export interface RunRefundInput {
  readonly orderId: string;
  readonly releaseId: string;
  readonly runId?: string | undefined;
}

export interface OrchestratorOptions {
  readonly clients: DemoClients;
  readonly provider: Provider;
  /** Deterministic run identifiers make repeated demo runs comparable. */
  readonly newRunId?: () => string;
  readonly now?: () => number;
}

const DATA_DOMAIN = {
  policy: "policy",
  orders: "orders",
  fraud: "risk",
  payments: "payments",
  messaging: "messaging",
} as const;

export class RefundAgent {
  readonly #clients: DemoClients;
  readonly #provider: Provider;
  readonly #newRunId: () => string;
  readonly #now: () => number;

  constructor(options: OrchestratorOptions) {
    this.#clients = options.clients;
    this.#provider = options.provider;
    this.#newRunId =
      options.newRunId ?? (() => `run_${randomUUID().replaceAll("-", "").slice(0, 20)}`);
    this.#now = options.now ?? (() => Date.now());
  }

  async runRefund(input: RunRefundInput): Promise<RunResult> {
    const runId = input.runId ?? this.#newRunId();
    const releaseId = input.releaseId;
    const scenario = releaseId === RELEASE_V2 ? "unsafe-duplicate-refund" : "approved-refund";
    const plan = await this.#provider.plan(releaseId);

    return withRunSpan(
      {
        runId,
        releaseId,
        scenario,
        orderId: input.orderId,
        providerName: plan.providerName,
        modelName: plan.modelName,
      },
      (traceId) => this.#execute({ input, runId, releaseId, scenario, traceId, plan }),
    );
  }

  async #execute(context: {
    readonly input: RunRefundInput;
    readonly runId: string;
    readonly releaseId: string;
    readonly scenario: string;
    readonly traceId: string;
    readonly plan: Awaited<ReturnType<Provider["plan"]>>;
  }): Promise<RunResult> {
    const { input, runId, releaseId, scenario, traceId, plan } = context;
    const startedAt = this.#now();
    const steps: StepRecord[] = [];

    /**
     * Records the step for the caller and emits its span. One wrapper so a step can never be
     * recorded without being traced, or traced without being recorded.
     */
    const record = async <T>(
      partial: Omit<StepRecord, "outcome" | "durationMs">,
      action: () => Promise<T>,
    ): Promise<T> => {
      const stepStart = this.#now();
      return withStepSpan(
        {
          name: partial.name,
          toolName: partial.toolName,
          service: partial.service,
          sideEffect: partial.sideEffect,
          dataDomain: partial.dataDomain,
          stepCategory: stepCategoryFor(partial),
          attempt: partial.attempt,
          releaseId,
          runId,
          idempotencyPresent: partial.sideEffect === "write" ? true : undefined,
        },
        async () => {
          try {
            const value = await action();
            steps.push({ ...partial, outcome: "ok", durationMs: this.#now() - stepStart });
            return value;
          } catch (error) {
            steps.push({
              ...partial,
              outcome: error instanceof ServiceTimeoutError ? "timeout" : "error",
              durationMs: this.#now() - stepStart,
            });
            throw error;
          }
        },
      );
    };

    const planned = new Set(plan.steps.map((step) => step.step));

    // ---- policy.retrieve -----------------------------------------------------------------
    if (planned.has("policy.retrieve")) {
      await record(
        {
          name: "policy.retrieve",
          toolName: "retrieve_policy",
          service: "policy-service",
          sideEffect: "read",
          dataDomain: DATA_DOMAIN.policy,
          attempt: 1,
        },
        () => this.#clients.retrievePolicy(input.orderId, runId),
      );
    }

    // ---- order.lookup --------------------------------------------------------------------
    const order = await record(
      {
        name: "order.lookup",
        toolName: "lookup_order",
        service: "order-service",
        sideEffect: "read",
        dataDomain: DATA_DOMAIN.orders,
        attempt: 1,
      },
      () => this.#clients.lookupOrder(input.orderId, runId),
    );

    // ---- fraud.check ---------------------------------------------------------------------
    if (planned.has("fraud.check")) {
      const assessment = await record(
        {
          name: "fraud.check",
          toolName: "check_fraud",
          service: "fraud-service",
          sideEffect: "read",
          dataDomain: DATA_DOMAIN.fraud,
          attempt: 1,
        },
        () => this.#clients.checkFraud(order.orderId, order.customerId, order.totalCents, runId),
      );

      if (assessment.decision === "block") {
        throw new ServiceRequestError("fraud-service", 200, "fraud check blocked the refund");
      }
    }

    // ---- refund.calculate ----------------------------------------------------------------
    let amountCents = order.totalCents;
    if (planned.has("refund.calculate")) {
      await record(
        {
          name: "refund.calculate",
          toolName: "calculate_refund",
          service: "demo-agent",
          sideEffect: "none",
          dataDomain: DATA_DOMAIN.payments,
          attempt: 1,
        },
        async () => {
          amountCents = order.totalCents;
          return amountCents;
        },
      );
    }

    // ---- payment.refund ------------------------------------------------------------------
    const { refund, attempts } = await this.#issueRefund({
      releaseId,
      orderId: order.orderId,
      amountCents,
      runId,
      record,
    });

    // ---- customer.notify -----------------------------------------------------------------
    const notification = await record(
      {
        name: "customer.notify",
        toolName: "notify_customer",
        service: "notification-service",
        sideEffect: "external",
        dataDomain: DATA_DOMAIN.messaging,
        attempt: 1,
      },
      () =>
        this.#clients.notifyCustomer({
          customerId: order.customerId,
          orderId: order.orderId,
          refundId: refund.refundId,
          amountCents,
          currency: order.currency,
          runId,
        }),
    );

    return {
      runId,
      traceId,
      releaseId,
      orderId: order.orderId,
      scenario,
      customerMessage: notification.body,
      refundId: refund.refundId,
      amountCents,
      steps,
      paymentAttempts: attempts,
      durationMs: this.#now() - startedAt,
    };
  }

  /**
   * The payment write, and the one place the two releases differ in more than which steps run.
   *
   * v1 sends a stable idempotency key derived from the run and order, and injects no fault. One
   * request, one ledger entry.
   *
   * v2 injects a real slow response on the first attempt. The client genuinely times out on a
   * request that genuinely committed, and then retries with a **regenerated** idempotency key.
   * The payment service cannot recognise the retry, so it writes a second ledger entry and the
   * order is refunded twice. Nothing about this is simulated: the timeout is a real
   * `AbortController` deadline and the duplicate is a real row in the service's ledger.
   */
  async #issueRefund(input: {
    readonly releaseId: string;
    readonly orderId: string;
    readonly amountCents: number;
    readonly runId: string;
    readonly record: <T>(
      partial: Omit<StepRecord, "outcome" | "durationMs">,
      action: () => Promise<T>,
    ) => Promise<T>;
  }): Promise<{ refund: RefundResponse; attempts: number }> {
    const unsafe = input.releaseId === RELEASE_V2;
    const stableKey = `idem_${input.runId}_${input.orderId}`;
    const base = {
      name: "payment.refund",
      toolName: "issue_refund",
      service: "payment-service",
      sideEffect: "write" as const,
      dataDomain: DATA_DOMAIN.payments,
    };

    if (!unsafe) {
      const refund = await input.record({ ...base, attempt: 1 }, () =>
        this.#clients.issueRefund({
          orderId: input.orderId,
          amountCents: input.amountCents,
          idempotencyKey: stableKey,
          attempt: 1,
          runId: input.runId,
          fault: "none",
        }),
      );
      return { refund, attempts: 1 };
    }

    try {
      const refund = await input.record({ ...base, attempt: 1 }, () =>
        this.#clients.issueRefund({
          orderId: input.orderId,
          amountCents: input.amountCents,
          idempotencyKey: `${stableKey}_a1`,
          attempt: 1,
          runId: input.runId,
          fault: "slow_first_attempt",
        }),
      );
      return { refund, attempts: 1 };
    } catch (error) {
      if (!(error instanceof ServiceTimeoutError)) throw error;

      // The unsafe retry: a fresh idempotency key, so the payment service has no way to
      // recognise this as the same logical operation.
      const refund = await input.record({ ...base, attempt: 2 }, () =>
        this.#clients.issueRefund({
          orderId: input.orderId,
          amountCents: input.amountCents,
          idempotencyKey: `${stableKey}_a2_${randomUUID().slice(0, 8)}`,
          attempt: 2,
          runId: input.runId,
          fault: "none",
        }),
      );
      return { refund, attempts: 2 };
    }
  }
}

export { RELEASE_V1, RELEASE_V2 };

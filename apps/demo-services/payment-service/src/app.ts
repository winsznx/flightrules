import {
  AGENT,
  activeServiceSpan,
  createStructuredLogger,
  registerServiceSpans,
  type StructuredLogger,
} from "@flightrules/telemetry";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { type LedgerEntry, RefundLedger } from "./ledger.js";

const RefundBodySchema = z.object({
  orderId: z.string().min(1).max(64),
  amountCents: z.number().int().positive().max(100_000_000),
  idempotencyKey: z.string().min(1).max(128).optional(),
  attempt: z.number().int().min(1).max(10).default(1),
  runId: z.string().min(1).max(64),
  /**
   * Deterministic fault injection. `slow_first_attempt` makes the service commit the write and
   * then hold the response past the caller's timeout, so the caller genuinely times out on a
   * request that genuinely succeeded. That is the real-world shape of a duplicate refund, and it
   * is what the demo reproduces rather than simulating.
   */
  fault: z.enum(["none", "slow_first_attempt"]).default("none"),
});

export interface PaymentServiceOptions {
  readonly idempotencyHashSalt: string;
  readonly demoMode: boolean;
  /** How long the injected fault holds the response. Must exceed the caller's timeout. */
  readonly slowResponseMs?: number;
  readonly logger?: boolean;
  /** Overridable so a test can read the ledger lines without an exporter. */
  readonly log?: StructuredLogger;
}

export interface PaymentServiceApp {
  readonly server: FastifyInstance;
  readonly ledger: RefundLedger;
}

const publicEntry = (entry: LedgerEntry) => ({
  refundId: entry.refundId,
  orderId: entry.orderId,
  runId: entry.runId,
  amountCents: entry.amountCents,
  idempotencyKeyPresent: entry.idempotencyKeyHash !== null,
  idempotencyKeyHash: entry.idempotencyKeyHash,
  attempt: entry.attempt,
  recordedAtMs: entry.recordedAtMs,
});

export function buildPaymentService(options: PaymentServiceOptions): PaymentServiceApp {
  const ledger = new RefundLedger(options.idempotencyHashSalt);
  const slowResponseMs = options.slowResponseMs ?? 2_500;
  const quiet = !(options.logger ?? false);
  const server = Fastify({ logger: options.logger ?? false });
  // `logger: false` means "print nothing", which a test relies on. The OTLP record is still
  // emitted — against a no-op provider in a test, and against the real one in the demo — so the
  // two paths do not diverge in what they record, only in what they print.
  const log =
    options.log ??
    createStructuredLogger({
      serviceName: "flightrules-payment-service",
      ...(quiet ? { write: () => {} } : {}),
    });

  registerServiceSpans(server, {
    serviceName: "flightrules-payment-service",
    tracerName: "flightrules.demo.payment-service",
    describe: (request) =>
      request.url.startsWith("/payments/refund")
        ? {
            name: "payment.refund.handler",
            sideEffect: "write",
            dataDomain: "payments",
            stepCategory: "payment",
          }
        : null,
  });

  server.get("/health", async () => ({ status: "ok", service: "payment-service" }));

  server.post("/payments/refund", async (request, reply) => {
    const parsed = RefundBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "INVALID_REQUEST", message: parsed.error.issues[0]?.message ?? "invalid" },
      });
    }
    const body = parsed.data;

    // The write is committed before any injected delay. A caller that times out here has still
    // moved money — which is exactly why a retry without a stable idempotency key duplicates it.
    const outcome = ledger.record({
      orderId: body.orderId,
      runId: body.runId,
      amountCents: body.amountCents,
      idempotencyKey: body.idempotencyKey,
      attempt: body.attempt,
    });

    const span = activeServiceSpan(request);
    if (span) {
      span.setAttribute(AGENT.idempotencyPresent, body.idempotencyKey !== undefined);
      span.setAttribute(AGENT.retryNumber, body.attempt - 1);
      if (outcome.entry.idempotencyKeyHash !== null) {
        // The salted hash only. The raw key never leaves this service.
        span.setAttribute(AGENT.idempotencyKeyHash, outcome.entry.idempotencyKeyHash);
      }
    }

    /**
     * The ledger line the demo reveal turns to after the graph diff (PRD section 24.5).
     *
     * It is written **after** the commit and **before** any injected delay, so on the timed-out
     * first attempt the log records a refund that really was written even though the caller never
     * saw a response. Two of these in one trace is the duplicate side effect, stated in the
     * service's own words rather than inferred from span shape.
     *
     * Only the salted hash of the idempotency key, never the key. The raw value does not leave
     * this service, and a log is the easiest place to lose that discipline.
     */
    log.info(
      {
        refund_id: outcome.refundId,
        order_id: body.orderId,
        run_id: body.runId,
        amount_cents: body.amountCents,
        attempt: body.attempt,
        deduplicated: outcome.deduplicated,
        idempotency_key_present: body.idempotencyKey !== undefined,
        idempotency_key_hash: outcome.entry.idempotencyKeyHash,
        refunds_for_run: ledger.entriesForRun(body.runId).length,
      },
      outcome.deduplicated
        ? "refund request deduplicated against an existing ledger entry"
        : "refund committed to the payment ledger",
    );

    if (body.fault === "slow_first_attempt" && body.attempt === 1) {
      await new Promise((resolve) => setTimeout(resolve, slowResponseMs));
    }

    return reply.status(200).send({
      refundId: outcome.refundId,
      orderId: body.orderId,
      amountCents: body.amountCents,
      status: "succeeded",
      deduplicated: outcome.deduplicated,
      idempotencyKeyPresent: body.idempotencyKey !== undefined,
      attempt: body.attempt,
      runId: body.runId,
    });
  });

  server.get("/payments/ledger", async () => ({
    entries: ledger.entries().map(publicEntry),
    duplicates: ledger.duplicatedSideEffects(),
  }));

  server.get("/payments/ledger/run/:runId", async (request) => {
    const { runId } = request.params as { runId: string };
    const entries = ledger.entriesForRun(runId);
    return {
      runId,
      entries: entries.map(publicEntry),
      refundCount: entries.length,
      duplicate: entries.length > 1,
    };
  });

  server.get("/payments/ledger/:orderId", async (request) => {
    const { orderId } = request.params as { orderId: string };
    const entries = ledger.entriesForOrder(orderId);
    return {
      orderId,
      entries: entries.map(publicEntry),
      refundCount: entries.length,
      duplicate: entries.length > 1,
    };
  });

  server.post("/payments/reset", async (_request, reply) => {
    if (!options.demoMode) {
      return reply.status(403).send({
        error: {
          code: "DEMO_DISABLED",
          message: "Demo endpoints are disabled because DEMO_MODE is not enabled.",
        },
      });
    }
    ledger.reset();
    return reply.status(200).send({ status: "reset", entries: 0 });
  });

  return { server, ledger };
}

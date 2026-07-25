import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

const RetrieveBodySchema = z.object({
  orderId: z.string().min(1).max(64),
  runId: z.string().min(1).max(64),
});

/**
 * Refund policy, keyed by order value band. Fixed data, so the same order always produces the
 * same policy and the demo stays deterministic without a database.
 */
const POLICY_VERSION = "2026.07.1";

export interface PolicyServiceOptions {
  readonly logger?: boolean;
}

export interface PolicyDecision {
  readonly policyId: string;
  readonly policyVersion: string;
  readonly maxRefundCents: number;
  readonly requiresFraudCheck: boolean;
  readonly refundWindowDays: number;
}

export function policyFor(orderTotalCents: number): PolicyDecision {
  if (orderTotalCents >= 50_000) {
    return {
      policyId: "refund-high-value",
      policyVersion: POLICY_VERSION,
      maxRefundCents: orderTotalCents,
      requiresFraudCheck: true,
      refundWindowDays: 14,
    };
  }
  return {
    policyId: "refund-standard",
    policyVersion: POLICY_VERSION,
    maxRefundCents: orderTotalCents,
    requiresFraudCheck: true,
    refundWindowDays: 30,
  };
}

export function buildPolicyService(options: PolicyServiceOptions = {}): FastifyInstance {
  const server = Fastify({ logger: options.logger ?? false });

  server.get("/health", async () => ({ status: "ok", service: "policy-service" }));

  server.post("/policy/retrieve", async (request, reply) => {
    const parsed = RetrieveBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "INVALID_REQUEST", message: parsed.error.issues[0]?.message ?? "invalid" },
      });
    }

    // Policy is resolved from the order identifier's value band. The order service is the source
    // of truth for the amount; policy only needs the band, which is encoded in the demo dataset.
    const highValue = parsed.data.orderId.endsWith("-hv");
    const decision = policyFor(highValue ? 120_000 : 4_820);

    return reply
      .status(200)
      .send({ ...decision, orderId: parsed.data.orderId, runId: parsed.data.runId });
  });

  return server;
}

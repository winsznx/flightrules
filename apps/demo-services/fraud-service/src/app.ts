import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

const CheckBodySchema = z.object({
  orderId: z.string().min(1).max(64),
  customerId: z.string().min(1).max(64),
  amountCents: z.number().int().positive().max(100_000_000),
  runId: z.string().min(1).max(64),
});

export type FraudDecision = "clear" | "review" | "block";

export interface FraudAssessment {
  readonly decision: FraudDecision;
  /** 0-999. Derived deterministically so the same order always scores the same. */
  readonly score: number;
  readonly modelVersion: string;
}

const MODEL_VERSION = "fraud-heuristic-3";

/**
 * Deterministic scoring. A hash of the order and customer gives a stable pseudo-random score, so
 * repeated runs of the same refund produce byte-identical decisions and the baseline does not
 * drift between captures.
 */
export function assessFraud(
  orderId: string,
  customerId: string,
  amountCents: number,
): FraudAssessment {
  const digest = createHash("sha256").update(`${orderId}:${customerId}`).digest();
  const base = (((digest[0] ?? 0) << 8) | (digest[1] ?? 0)) % 1000;
  // High-value orders carry more risk weight, bounded so the demo order stays clear.
  const score = amountCents >= 50_000 ? Math.min(999, base + 250) : Math.floor(base / 4);

  const decision: FraudDecision = score >= 900 ? "block" : score >= 600 ? "review" : "clear";
  return { decision, score, modelVersion: MODEL_VERSION };
}

export function buildFraudService(options: { readonly logger?: boolean } = {}): FastifyInstance {
  const server = Fastify({ logger: options.logger ?? false });

  server.get("/health", async () => ({ status: "ok", service: "fraud-service" }));

  server.post("/fraud/check", async (request, reply) => {
    const parsed = CheckBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "INVALID_REQUEST", message: parsed.error.issues[0]?.message ?? "invalid" },
      });
    }

    const { orderId, customerId, amountCents, runId } = parsed.data;
    const assessment = assessFraud(orderId, customerId, amountCents);

    return reply.status(200).send({ ...assessment, orderId, runId });
  });

  return server;
}

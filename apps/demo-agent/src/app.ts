import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { z } from "zod";
import { DemoClients, type ServiceEndpoints } from "./clients.js";
import { RefundAgent } from "./orchestrator.js";
import { RELEASE_V1, RELEASE_V2, ScriptedProvider } from "./provider.js";

const RunBodySchema = z.object({
  orderId: z.string().min(1).max(64).default("ord-98271"),
  releaseId: z.enum([RELEASE_V1, RELEASE_V2]).default(RELEASE_V1),
  runId: z.string().min(1).max(64).optional(),
});

const SeedBodySchema = z.object({
  releaseId: z.enum([RELEASE_V1, RELEASE_V2]).default(RELEASE_V1),
  orderId: z.string().min(1).max(64).default("ord-98271"),
  runs: z.number().int().min(1).max(200).default(20),
});

export interface DemoAgentOptions {
  readonly endpoints: ServiceEndpoints;
  readonly demoMode: boolean;
  readonly defaultTimeoutMs?: number;
  readonly paymentTimeoutMs?: number;
  readonly logger?: boolean;
}

export function buildDemoAgent(options: DemoAgentOptions): FastifyInstance {
  const clients = new DemoClients({
    endpoints: options.endpoints,
    defaultTimeoutMs: options.defaultTimeoutMs ?? 5_000,
    // Shorter than the payment service's injected delay, so the v2 first attempt genuinely times
    // out on a request that genuinely committed.
    paymentTimeoutMs: options.paymentTimeoutMs ?? 800,
  });
  const agent = new RefundAgent({ clients, provider: new ScriptedProvider() });
  const server = Fastify({ logger: options.logger ?? false });

  /** Demo mutation routes must be unreachable outside demo mode (PRD section 15.9). */
  const denyOutsideDemoMode = (reply: FastifyReply): FastifyReply | null => {
    if (options.demoMode) return null;
    return reply.status(403).send({
      error: {
        code: "DEMO_DISABLED",
        message: "Demo endpoints are disabled because DEMO_MODE is not enabled.",
      },
    });
  };

  server.get("/health", async () => ({ status: "ok", service: "demo-agent" }));

  server.post("/agent/refund", async (request, reply) => {
    const parsed = RunBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "INVALID_REQUEST", message: parsed.error.issues[0]?.message ?? "invalid" },
      });
    }
    const denied = denyOutsideDemoMode(reply);
    if (denied) return denied;

    const result = await agent.runRefund(parsed.data);
    return reply.status(200).send(result);
  });

  /**
   * Produces the minimum completed-run count a baseline capture needs. Runs are sequential so the
   * payment service's ledger and the emitted traces stay in a deterministic order.
   */
  server.post("/agent/seed", async (request, reply) => {
    const parsed = SeedBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "INVALID_REQUEST", message: parsed.error.issues[0]?.message ?? "invalid" },
      });
    }
    const denied = denyOutsideDemoMode(reply);
    if (denied) return denied;

    const { releaseId, orderId, runs } = parsed.data;
    const runIds: string[] = [];
    for (let index = 0; index < runs; index += 1) {
      const result = await agent.runRefund({ orderId, releaseId });
      runIds.push(result.runId);
    }

    return reply.status(200).send({ releaseId, orderId, completedRuns: runIds.length, runIds });
  });

  return server;
}

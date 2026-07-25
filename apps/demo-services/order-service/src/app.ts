import { registerServiceSpans } from "@flightrules/telemetry";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

const LookupBodySchema = z.object({
  orderId: z.string().min(1).max(64),
  runId: z.string().min(1).max(64),
});

export interface Order {
  readonly orderId: string;
  readonly customerId: string;
  readonly totalCents: number;
  readonly currency: string;
  readonly status: "delivered" | "shipped" | "cancelled";
  readonly placedAtIso: string;
}

/**
 * Fixed order dataset. Deterministic by construction: the same order identifier always yields the
 * same order, so v1 and v2 runs are comparable and the demo does not depend on seeded randomness.
 */
const ORDERS: ReadonlyMap<string, Order> = new Map(
  (
    [
      {
        orderId: "ord-98271",
        customerId: "cust-4f92c1",
        totalCents: 4_820,
        currency: "USD",
        status: "delivered",
        placedAtIso: "2026-07-11T09:14:02Z",
      },
      {
        orderId: "ord-98271-hv",
        customerId: "cust-4f92c1",
        totalCents: 120_000,
        currency: "USD",
        status: "delivered",
        placedAtIso: "2026-07-09T16:02:41Z",
      },
      {
        orderId: "ord-51044",
        customerId: "cust-77ba30",
        totalCents: 12_650,
        currency: "USD",
        status: "shipped",
        placedAtIso: "2026-07-18T11:38:55Z",
      },
    ] satisfies readonly Order[]
  ).map((order) => [order.orderId, order]),
);

export const DEFAULT_ORDER_ID = "ord-98271";

export function findOrder(orderId: string): Order | undefined {
  return ORDERS.get(orderId);
}

export function buildOrderService(options: { readonly logger?: boolean } = {}): FastifyInstance {
  const server = Fastify({ logger: options.logger ?? false });

  registerServiceSpans(server, {
    serviceName: "flightrules-order-service",
    tracerName: "flightrules.demo.order-service",
    describe: (request) =>
      request.url.startsWith("/orders/lookup")
        ? {
            name: "order.lookup.handler",
            sideEffect: "read",
            dataDomain: "orders",
            stepCategory: "order",
          }
        : null,
  });

  server.get("/health", async () => ({ status: "ok", service: "order-service" }));

  server.post("/orders/lookup", async (request, reply) => {
    const parsed = LookupBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "INVALID_REQUEST", message: parsed.error.issues[0]?.message ?? "invalid" },
      });
    }

    const order = findOrder(parsed.data.orderId);
    if (!order) {
      return reply
        .status(404)
        .send({ error: { code: "ORDER_NOT_FOUND", message: "No such order." } });
    }

    return reply.status(200).send({ ...order, runId: parsed.data.runId });
  });

  return server;
}

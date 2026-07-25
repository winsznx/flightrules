import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

const SendBodySchema = z.object({
  customerId: z.string().min(1).max(64),
  orderId: z.string().min(1).max(64),
  refundId: z.string().min(1).max(64),
  amountCents: z.number().int().positive().max(100_000_000),
  currency: z.string().length(3),
  runId: z.string().min(1).max(64),
});

export interface SentMessage {
  readonly messageId: string;
  readonly customerId: string;
  readonly orderId: string;
  readonly body: string;
  readonly sentAtMs: number;
}

/**
 * The customer-facing message. Deliberately a pure function of the refund amount and currency and
 * nothing else, because the demo's whole point is that this text is identical for the approved and
 * the unsafe release. If it varied by release, output evaluation would catch the regression and
 * there would be nothing to demonstrate.
 */
export function renderRefundMessage(amountCents: number, currency: string): string {
  const amount = (amountCents / 100).toFixed(2);
  return `Your refund of ${amount} ${currency} has been issued and will appear on your original payment method within 3-5 business days.`;
}

export interface NotificationServiceOptions {
  readonly demoMode: boolean;
  readonly logger?: boolean;
  readonly maxRetained?: number;
}

export interface NotificationServiceApp {
  readonly server: FastifyInstance;
  readonly sent: () => readonly SentMessage[];
}

export function buildNotificationService(
  options: NotificationServiceOptions,
): NotificationServiceApp {
  const maxRetained = options.maxRetained ?? 200;
  let messages: SentMessage[] = [];
  const server = Fastify({ logger: options.logger ?? false });

  server.get("/health", async () => ({ status: "ok", service: "notification-service" }));

  server.post("/notifications/send", async (request, reply) => {
    const parsed = SendBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: "INVALID_REQUEST", message: parsed.error.issues[0]?.message ?? "invalid" },
      });
    }

    const { customerId, orderId, amountCents, currency, runId } = parsed.data;
    const message: SentMessage = {
      messageId: `msg_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
      customerId,
      orderId,
      body: renderRefundMessage(amountCents, currency),
      sentAtMs: Date.now(),
    };

    messages.push(message);
    if (messages.length > maxRetained) messages = messages.slice(-maxRetained);

    return reply.status(200).send({ ...message, runId });
  });

  server.get("/notifications", async () => ({ messages }));

  server.post("/notifications/reset", async (_request, reply) => {
    if (!options.demoMode) {
      return reply.status(403).send({
        error: {
          code: "DEMO_DISABLED",
          message: "Demo endpoints are disabled because DEMO_MODE is not enabled.",
        },
      });
    }
    messages = [];
    return reply.status(200).send({ status: "reset", messages: 0 });
  });

  return { server, sent: () => messages };
}

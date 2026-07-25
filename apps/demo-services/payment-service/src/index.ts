// Telemetry must start before anything issues HTTP, so the instrumentation can patch it.
import { bootstrapFromEnv } from "@flightrules/telemetry";

bootstrapFromEnv("flightrules-payment-service");

import process from "node:process";
import { buildPaymentService } from "./app.js";

const port = Number.parseInt(process.env["PORT"] ?? "4104", 10);
const salt = process.env["IDEMPOTENCY_HASH_SALT"];
if (!salt || salt.length < 16) {
  process.stderr.write("IDEMPOTENCY_HASH_SALT must be set to at least 16 characters.\n");
  process.exit(5);
}

const { server } = buildPaymentService({
  idempotencyHashSalt: salt,
  demoMode: process.env["DEMO_MODE"] === "true",
  slowResponseMs: Number.parseInt(process.env["PAYMENT_SLOW_RESPONSE_MS"] ?? "2500", 10),
  logger: process.env["NODE_ENV"] !== "test",
});

server.listen({ port, host: "0.0.0.0" }).catch((error: unknown) => {
  server.log.error(error);
  process.exit(1);
});

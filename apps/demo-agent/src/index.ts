// Telemetry must start before anything issues HTTP, so the instrumentation can patch it.
import { bootstrapFromEnv } from "@flightrules/telemetry";

bootstrapFromEnv("flightrules-demo-agent");

import process from "node:process";
import { buildDemoAgent } from "./app.js";

const port = Number.parseInt(process.env["PORT"] ?? "4100", 10);
const server = buildDemoAgent({
  endpoints: {
    policy: process.env["POLICY_SERVICE_URL"] ?? "http://localhost:4101",
    order: process.env["ORDER_SERVICE_URL"] ?? "http://localhost:4102",
    fraud: process.env["FRAUD_SERVICE_URL"] ?? "http://localhost:4103",
    payment: process.env["PAYMENT_SERVICE_URL"] ?? "http://localhost:4104",
    notification: process.env["NOTIFICATION_SERVICE_URL"] ?? "http://localhost:4105",
  },
  demoMode: process.env["DEMO_MODE"] === "true",
  paymentTimeoutMs: Number.parseInt(process.env["PAYMENT_TIMEOUT_MS"] ?? "800", 10),
  logger: process.env["NODE_ENV"] !== "test",
});

server.listen({ port, host: "0.0.0.0" }).catch((error: unknown) => {
  server.log.error(error);
  process.exit(1);
});

// Telemetry must start before anything issues HTTP, so the instrumentation can patch it.
import { bootstrapFromEnv } from "@flightrules/telemetry";

bootstrapFromEnv("flightrules-order-service");

import process from "node:process";
import { buildOrderService } from "./app.js";

const port = Number.parseInt(process.env["PORT"] ?? "4102", 10);
const server = buildOrderService({ logger: process.env["NODE_ENV"] !== "test" });

server.listen({ port, host: "0.0.0.0" }).catch((error: unknown) => {
  server.log.error(error);
  process.exit(1);
});

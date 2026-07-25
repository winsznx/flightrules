// Telemetry must start before anything issues HTTP, so the instrumentation can patch it.
import { bootstrapFromEnv } from "@flightrules/telemetry";

bootstrapFromEnv("flightrules-fraud-service");

import process from "node:process";
import { buildFraudService } from "./app.js";

const port = Number.parseInt(process.env["PORT"] ?? "4103", 10);
const server = buildFraudService({ logger: process.env["NODE_ENV"] !== "test" });

server.listen({ port, host: "0.0.0.0" }).catch((error: unknown) => {
  server.log.error(error);
  process.exit(1);
});

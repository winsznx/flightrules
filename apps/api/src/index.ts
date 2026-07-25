// Telemetry starts before anything issues HTTP, so the instrumentation can patch it.
import { bootstrapFromEnv } from "@flightrules/telemetry";

const telemetry = bootstrapFromEnv(process.env["OTEL_SERVICE_NAME"] ?? "flightrules-api");

import process from "node:process";
import { assertSchemaCompatible, connect, MIGRATIONS_DIR } from "@flightrules/db";
import { FlightRulesMetrics, protectSecret } from "@flightrules/telemetry";
import { buildApi } from "./app.js";
import { loadApiConfig } from "./config.js";
import { liveSignozGateway } from "./signoz.js";

/**
 * The API entrypoint.
 *
 * Order matters. Configuration is validated first, so a bad `.env` fails before a port is bound.
 * The secret is registered with the redactor before any code path can log it. The schema is
 * checked before the listener opens, so the process never accepts a request it cannot serve —
 * PRD section 15.1's readiness contract, enforced at startup as well as reported per request.
 */

const config = loadApiConfig();
protectSecret(config.signozApiKey);

const sql = connect(config.databaseUrl, {
  max: config.databasePoolSize,
  applicationName: config.serviceName,
});

const { server } = buildApi({
  context: {
    sql,
    config,
    migrationsDir: MIGRATIONS_DIR,
    now: () => new Date(),
    gateway: () => liveSignozGateway(config),
    metrics: new FlightRulesMetrics(),
  },
});

let shuttingDown = false;

/**
 * Graceful shutdown.
 *
 * `server.close()` stops accepting new connections and waits for in-flight requests, then the pool
 * is drained. The timeout is a backstop: a request that will not finish must not keep the process
 * alive for ever, and exiting late is worse than exiting with one request cut short.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  server.log.info({ signal }, "shutting down");

  const timer = setTimeout(() => {
    server.log.error({ signal }, "shutdown timed out; exiting");
    process.exit(1);
  }, config.shutdownTimeoutMs);
  timer.unref();

  try {
    await server.close();
    await sql.end({ timeout: 5 });
    await telemetry.shutdown();
  } catch (error) {
    server.log.error({ err: error }, "shutdown failed");
    process.exit(1);
  }
  clearTimeout(timer);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  await assertSchemaCompatible(sql, MIGRATIONS_DIR);
  await server.listen({ port: config.port, host: config.host });
} catch (error) {
  server.log.error({ err: error }, "the API could not start");
  await sql.end({ timeout: 1 }).catch(() => {});
  process.exit(1);
}

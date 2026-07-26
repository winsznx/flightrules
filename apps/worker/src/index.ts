// Telemetry starts before anything issues HTTP, so the instrumentation can patch it.
import { bootstrapFromEnv } from "@flightrules/telemetry";

const telemetry = bootstrapFromEnv(process.env["OTEL_SERVICE_NAME"] ?? "flightrules-worker", {
  metrics: true,
});

import process from "node:process";
import { assertSchemaCompatible, connect, MIGRATIONS_DIR } from "@flightrules/db";
import { createStructuredLogger, FlightRulesMetrics, protectSecret } from "@flightrules/telemetry";
import { loadWorkerConfig } from "./config.js";
import { createHandlers } from "./handlers.js";
import { JobRunner } from "./runner.js";
import { liveSignozFactory } from "./signoz.js";

/**
 * The worker entrypoint.
 *
 * Readiness for a worker is not a port. It is: the configuration validated, the secret registered
 * with the redactor, the database reachable, and the schema holding every migration this build was
 * written against. Only then does it start claiming, because a worker that claims a job it cannot
 * finish has made the job's state worse than not claiming it at all.
 */

const config = loadWorkerConfig();
protectSecret(config.signozApiKey);

const sql = connect(config.databaseUrl, {
  max: config.databasePoolSize,
  applicationName: config.serviceName,
});

/**
 * One JSON line to stdout **and** one correlated OTLP log record (PRD section 17.5).
 *
 * The worker is where a violation is actually produced, so its lines are the ones the Violation
 * Inspector's correlated-log panel most needs. `createStructuredLogger` reads the active span
 * context, so a line written while evaluating a run carries that run's trace ID without this file
 * knowing anything about tracing.
 */
const log = createStructuredLogger({ serviceName: config.serviceName });

const runner = new JobRunner({
  sql,
  config,
  log,
  handlers: createHandlers({
    signoz: liveSignozFactory(config),
    metrics: new FlightRulesMetrics(),
  }),
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down; no further jobs will be claimed");

  const timer = setTimeout(() => {
    log.error({ signal }, "shutdown timed out; the active job will be recovered by lease expiry");
    process.exit(1);
  }, config.shutdownTimeoutMs);
  timer.unref();

  try {
    await runner.stop();
    await sql.end({ timeout: 5 });
    await telemetry.shutdown();
  } catch (error) {
    log.error({ err: String(error) }, "shutdown failed");
    process.exit(1);
  }
  clearTimeout(timer);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  await assertSchemaCompatible(sql, MIGRATIONS_DIR);
  log.info({ worker_id: config.owner, lease_seconds: config.leaseSeconds }, "worker ready");
  await runner.loop();
} catch (error) {
  log.error({ err: String(error) }, "the worker could not start");
  await sql.end({ timeout: 1 }).catch(() => {});
  process.exit(1);
}

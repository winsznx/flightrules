import { hostname } from "node:os";
import { loadEnv } from "@flightrules/config";
import { FlightRulesError } from "@flightrules/domain";

/**
 * The worker's one configuration boundary (PRD section 12.3).
 *
 * The lease is the setting that matters most. It must be comfortably longer than the slowest stage
 * a handler runs between heartbeats, or a healthy worker's job is reclaimed underneath it; and
 * short enough that a killed worker's job is recovered in a useful time. The heartbeat interval is
 * validated to be shorter than the lease, because a heartbeat that cannot outpace expiry is not a
 * heartbeat.
 */

export interface WorkerConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly databaseUrl: string;
  readonly databasePoolSize: number;
  readonly signozUrl: string;
  readonly signozMcpUrl: string;
  readonly signozApiKey: string;
  readonly mcpRequestTimeoutMs: number;
  /**
   * Where SigNoz posts a fired alert (Phase 10, FR-015).
   *
   * The default points at a local sink that does not exist. That is deliberate: SigNoz sends a
   * real test notification when the channel is created, so the default configuration produces a
   * recorded delivery *failure* rather than a silent assumption of success. FlightRules never
   * reports delivery as verified unless the server's own test said so. Set this to a routable
   * destination to make delivery real. Alert *firing* is proven from alert history and does not
   * depend on the destination at all.
   */
  readonly alertWebhookUrl: string;
  /** Violations in one evaluation window above which the managed rate alert fires. */
  readonly violationAlertThreshold: number;
  readonly maxTracesPerEvaluation: number;
  readonly maxSpansPerTrace: number;
  readonly demoMode: boolean;
  readonly demoAgentUrl: string;
  readonly environmentName: string;
  readonly serviceName: string;
  readonly logLevel: string;
  readonly owner: string;
  readonly pollIntervalMs: number;
  readonly leaseSeconds: number;
  readonly heartbeatIntervalMs: number;
  readonly maxAttempts: number;
  readonly retryDelaySeconds: number;
  readonly shutdownTimeoutMs: number;
  readonly reclaimIntervalMs: number;
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  field: string,
  bounds: { min: number; max: number },
): number {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < bounds.min || parsed > bounds.max) {
    throw new FlightRulesError("CONFIG_INVALID", {
      message: `${field} must be an integer between ${bounds.min} and ${bounds.max}.`,
      details: { field },
    });
  }
  return parsed;
}

export function loadWorkerConfig(
  source: Record<string, string | undefined> = process.env,
): WorkerConfig {
  const env = loadEnv(source);

  const leaseSeconds = boundedInteger(source["WORKER_LEASE_SECONDS"], 120, "WORKER_LEASE_SECONDS", {
    min: 5,
    max: 3_600,
  });
  const heartbeatIntervalMs = boundedInteger(
    source["WORKER_HEARTBEAT_INTERVAL_MS"],
    15_000,
    "WORKER_HEARTBEAT_INTERVAL_MS",
    { min: 250, max: 600_000 },
  );
  if (heartbeatIntervalMs >= leaseSeconds * 1000) {
    throw new FlightRulesError("CONFIG_INVALID", {
      message:
        "WORKER_HEARTBEAT_INTERVAL_MS must be shorter than WORKER_LEASE_SECONDS, or a running job's lease expires while it is healthy.",
      details: { field: "WORKER_HEARTBEAT_INTERVAL_MS" },
    });
  }

  // An empty value is treated as unset: `.env.example` ships `WORKER_ID=` so an operator can
  // fill it in, and an empty string must mean "derive one" rather than "no identity".
  const supplied = source["WORKER_ID"];
  const owner =
    supplied === undefined || supplied === "" ? `${hostname()}-${process.pid}` : supplied;
  if (owner.length > 200) {
    throw new FlightRulesError("CONFIG_INVALID", {
      message: "WORKER_ID must be at most 200 characters.",
      details: { field: "WORKER_ID" },
    });
  }

  return {
    nodeEnv: env.NODE_ENV,
    databaseUrl: env.DATABASE_URL,
    databasePoolSize: boundedInteger(source["DATABASE_POOL_SIZE"], 5, "DATABASE_POOL_SIZE", {
      min: 1,
      max: 100,
    }),
    signozUrl: env.SIGNOZ_URL,
    signozMcpUrl: env.SIGNOZ_MCP_URL,
    signozApiKey: env.SIGNOZ_API_KEY,
    mcpRequestTimeoutMs: env.MCP_REQUEST_TIMEOUT_MS,
    alertWebhookUrl:
      source["FLIGHTRULES_ALERT_WEBHOOK_URL"] ??
      "http://host.docker.internal:4000/internal/alert-sink",
    violationAlertThreshold: boundedInteger(
      source["FLIGHTRULES_VIOLATION_ALERT_THRESHOLD"],
      0,
      "FLIGHTRULES_VIOLATION_ALERT_THRESHOLD",
      { min: 0, max: 1_000_000 },
    ),
    maxTracesPerEvaluation: env.MAX_TRACES_PER_EVALUATION,
    maxSpansPerTrace: env.MAX_SPANS_PER_TRACE,
    demoMode: env.DEMO_MODE,
    demoAgentUrl: source["DEMO_AGENT_URL"] ?? "http://localhost:4100",
    environmentName: env.DEPLOYMENT_ENVIRONMENT_NAME,
    serviceName: source["OTEL_SERVICE_NAME"] ?? "flightrules-worker",
    logLevel: source["LOG_LEVEL"] ?? "info",
    owner,
    pollIntervalMs: boundedInteger(
      source["WORKER_POLL_INTERVAL_MS"],
      1_000,
      "WORKER_POLL_INTERVAL_MS",
      {
        min: 10,
        max: 60_000,
      },
    ),
    leaseSeconds,
    heartbeatIntervalMs,
    maxAttempts: boundedInteger(source["WORKER_MAX_ATTEMPTS"], 3, "WORKER_MAX_ATTEMPTS", {
      min: 1,
      max: 20,
    }),
    retryDelaySeconds: boundedInteger(
      source["WORKER_RETRY_DELAY_SECONDS"],
      5,
      "WORKER_RETRY_DELAY_SECONDS",
      { min: 0, max: 3_600 },
    ),
    shutdownTimeoutMs: boundedInteger(
      source["SHUTDOWN_TIMEOUT_MS"],
      30_000,
      "SHUTDOWN_TIMEOUT_MS",
      {
        min: 100,
        max: 300_000,
      },
    ),
    reclaimIntervalMs: boundedInteger(
      source["WORKER_RECLAIM_INTERVAL_MS"],
      30_000,
      "WORKER_RECLAIM_INTERVAL_MS",
      { min: 500, max: 600_000 },
    ),
  };
}

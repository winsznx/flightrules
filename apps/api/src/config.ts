import { loadEnv } from "@flightrules/config";
import { FlightRulesError } from "@flightrules/domain";

/**
 * The API's one configuration boundary (PRD section 12.3).
 *
 * Everything the process needs is resolved here, once, and validated. No module below reads
 * `process.env`: a setting read at a call site is a setting that cannot be validated at startup,
 * and an application that starts and then fails on the first request that happens to need a
 * missing variable is worse than one that refuses to start.
 */

export interface ApiConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly deploymentMode: "self-host" | "hosted";
  readonly port: number;
  readonly host: string;
  readonly databaseUrl: string;
  readonly databasePoolSize: number;
  readonly signozUrl: string;
  readonly signozMcpUrl: string;
  readonly signozApiKey: string;
  readonly signozApiKeySecretReference: string;
  readonly mcpRequestTimeoutMs: number;
  readonly maxTracesPerEvaluation: number;
  readonly maxSpansPerTrace: number;
  readonly demoMode: boolean;
  readonly demoAgentUrl: string;
  readonly logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  readonly serviceName: string;
  readonly environmentName: string;
  readonly maxRequestBodyBytes: number;
  readonly shutdownTimeoutMs: number;
}

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;

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

function httpUrl(raw: string | undefined, fallback: string, field: string): string {
  const value = raw === undefined || raw === "" ? fallback : raw;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new FlightRulesError("CONFIG_INVALID", {
      message: `${field} must be an absolute http or https URL.`,
      details: { field },
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new FlightRulesError("CONFIG_INVALID", {
      message: `${field} must be an absolute http or https URL.`,
      details: { field },
    });
  }
  return value;
}

/**
 * Loads and validates the API configuration.
 *
 * Delegates the shared surface to `@flightrules/config`, which already enforces the SigNoz URL
 * policy PRD section 18.2 requires in hosted mode, and adds the settings only this process has.
 */
export function loadApiConfig(source: Record<string, string | undefined> = process.env): ApiConfig {
  const env = loadEnv(source);

  const logLevel = source["LOG_LEVEL"] ?? (env.NODE_ENV === "development" ? "info" : "info");
  if (!LOG_LEVELS.includes(logLevel as (typeof LOG_LEVELS)[number])) {
    throw new FlightRulesError("CONFIG_INVALID", {
      message: `LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}.`,
      details: { field: "LOG_LEVEL" },
    });
  }

  return {
    nodeEnv: env.NODE_ENV,
    deploymentMode: env.DEPLOYMENT_MODE,
    port: env.API_PORT,
    host: source["API_HOST"] ?? "0.0.0.0",
    databaseUrl: env.DATABASE_URL,
    databasePoolSize: boundedInteger(source["DATABASE_POOL_SIZE"], 10, "DATABASE_POOL_SIZE", {
      min: 1,
      max: 100,
    }),
    signozUrl: env.SIGNOZ_URL,
    signozMcpUrl: env.SIGNOZ_MCP_URL,
    signozApiKey: env.SIGNOZ_API_KEY,
    // PRD section 14.2: the database stores the *name* of the variable, never its value.
    signozApiKeySecretReference: "env:SIGNOZ_API_KEY",
    mcpRequestTimeoutMs: env.MCP_REQUEST_TIMEOUT_MS,
    maxTracesPerEvaluation: env.MAX_TRACES_PER_EVALUATION,
    maxSpansPerTrace: env.MAX_SPANS_PER_TRACE,
    demoMode: env.DEMO_MODE,
    demoAgentUrl: httpUrl(source["DEMO_AGENT_URL"], "http://localhost:4100", "DEMO_AGENT_URL"),
    logLevel: logLevel as ApiConfig["logLevel"],
    serviceName: source["OTEL_SERVICE_NAME"] ?? "flightrules-api",
    environmentName: env.DEPLOYMENT_ENVIRONMENT_NAME,
    maxRequestBodyBytes: boundedInteger(
      source["MAX_REQUEST_BODY_BYTES"],
      1_048_576,
      "MAX_REQUEST_BODY_BYTES",
      { min: 1_024, max: 16_777_216 },
    ),
    shutdownTimeoutMs: boundedInteger(
      source["SHUTDOWN_TIMEOUT_MS"],
      10_000,
      "SHUTDOWN_TIMEOUT_MS",
      {
        min: 100,
        max: 120_000,
      },
    ),
  };
}

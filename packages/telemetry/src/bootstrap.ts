import process from "node:process";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { startTelemetry, type TelemetryHandle } from "./sdk.js";

/**
 * Starts telemetry for a demo service or the agent from the environment.
 *
 * Must be imported before anything that issues HTTP, so the HTTP instrumentation can patch the
 * module. The service entrypoints do this with a bare side-effect import on the first line.
 */
export function bootstrapFromEnv(serviceName: string): TelemetryHandle {
  const handle = startTelemetry({
    serviceName,
    serviceVersion: process.env["SERVICE_VERSION"] ?? "0.1.0",
    environmentName: process.env["DEPLOYMENT_ENVIRONMENT_NAME"] ?? "local",
    otlpEndpoint: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ?? "http://localhost:4318",
    commitSha: process.env["VCS_COMMIT_SHA"],
    serviceInstanceId: process.env["SERVICE_INSTANCE_ID"],
  });

  registerInstrumentations({
    instrumentations: [
      new HttpInstrumentation({
        // The health endpoint is polled every few seconds by Compose. Tracing it would bury the
        // agent runs in noise and inflate the route families the baseline miner sees.
        ignoreIncomingRequestHook: (request) => (request.url ?? "").startsWith("/health"),
        ignoreOutgoingRequestHook: (options) => {
          const path = typeof options.path === "string" ? options.path : "";
          return path.startsWith("/health") || path.startsWith("/v1/traces");
        },
      }),
    ],
  });

  const shutdown = () => {
    void handle.shutdown().finally(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  return handle;
}

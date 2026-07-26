import { randomUUID } from "node:crypto";
import { FlightRulesError, isSecretKey, REDACTED } from "@flightrules/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "./context.js";
import { sendError } from "./http.js";
import { openApiDocument, RouteRegistry } from "./registry.js";
import { registerArtifactRoutes } from "./routes/artifacts.js";
import { registerCoreRoutes } from "./routes/core.js";
import { registerDemoRoutes } from "./routes/demo.js";
import { registerDiffRoutes } from "./routes/diff.js";
import { registerGateRoutes } from "./routes/gate.js";
import { registerLifecycleRoutes } from "./routes/lifecycle.js";
import { registerViolationEvidenceRoutes } from "./routes/violation-evidence.js";

/**
 * The FlightRules API server.
 *
 * Built from an explicit context rather than module state, so an integration test runs a real
 * server over a disposable database. Everything that is a policy rather than a route lives here:
 * the request identifier, the structured log shape (PRD section 17.5), the body-size limit
 * (PRD section 18.2) and the one error handler every failure passes through.
 */

export interface BuildApiOptions {
  readonly context: AppContext;
  /** Off in tests, where Fastify's own logger would flood the reporter. */
  readonly logger?: boolean;
  /**
   * Where pino's output goes (PRD section 17.5).
   *
   * The entrypoint passes a destination that writes the line to stdout **and** emits a correlated
   * OTLP log record. It is an option rather than a hard-wired dependency so a test can capture the
   * lines, and so `buildApi` stays constructible without a telemetry pipeline behind it.
   */
  readonly logStream?: { write(line: string): void };
}

export interface BuiltApi {
  readonly server: FastifyInstance;
  readonly registry: RouteRegistry;
}

export function buildApi(options: BuildApiOptions): BuiltApi {
  const { context } = options;

  const server = Fastify({
    // PRD section 18.2: input size limits. A body larger than this is rejected by Fastify before a
    // handler sees it, so an oversized payload cannot reach a JSON parser.
    bodyLimit: context.config.maxRequestBodyBytes,
    // PRD Phase 09 task 12. A caller-supplied identifier is accepted so a request can be correlated
    // across the CLI, the API and SigNoz, but it is bounded and sanitised: it reaches log lines and
    // error envelopes, so an unbounded value would be a log-injection vector.
    genReqId: (request) => {
      const supplied = request.headers["x-request-id"];
      const candidate = Array.isArray(supplied) ? supplied[0] : supplied;
      if (typeof candidate === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(candidate)) {
        return candidate;
      }
      return randomUUID();
    },
    logger: {
      // A disabled logger is a silent level rather than `false`: the union of `false` and an
      // options object makes Fastify pick its HTTP/2 overload and the whole server type changes.
      level: (options.logger ?? true) ? context.config.logLevel : "silent",
      base: { "service.name": context.config.serviceName },
      timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
      messageKey: "message",
      formatters: {
        level: (label) => ({ level: label }),
      },
      // PRD section 17.5 and section 18.2: nothing secret is ever logged. Redaction is declared
      // here rather than left to call sites, because a call site that forgets is a leak that no
      // test of that call site would catch.
      redact: {
        paths: [
          "req.headers.authorization",
          'req.headers["signoz-api-key"]',
          'req.headers["x-api-key"]',
          "req.headers.cookie",
          "res.headers['set-cookie']",
          "*.apiKey",
          "*.password",
          "*.databaseUrl",
          "*.DATABASE_URL",
          "*.SIGNOZ_API_KEY",
        ],
        censor: REDACTED,
      },
      serializers: {
        req: (request) => ({
          request_id: String(request.id ?? ""),
          method: String(request.method ?? ""),
          url: String(request.url ?? ""),
        }),
        res: (reply) => ({ statusCode: reply.statusCode }),
      },
      // Declared after `redact`, so what reaches the destination — and therefore what reaches
      // SigNoz — is already censored. A destination that received the uncensored line and censored
      // it again would be two rules that could drift apart.
      ...(options.logStream === undefined ? {} : { stream: options.logStream }),
    },
  });

  server.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-request-id", String(request.id));
    return payload;
  });

  /**
   * The single error path.
   *
   * Fastify's own failures — an unparseable body, a payload over the limit — arrive here too, and
   * are translated into the same typed envelope rather than Fastify's default shape, so a client
   * never has to parse two error formats.
   */
  server.setErrorHandler((error, request, reply) => {
    const requestId = String(request.id);
    const fastifyCode = (error as { code?: string }).code;
    const statusCode = (error as { statusCode?: number }).statusCode;

    let translated: unknown = error;
    if (!(error instanceof FlightRulesError)) {
      if (fastifyCode === "FST_ERR_CTP_BODY_TOO_LARGE" || statusCode === 413) {
        translated = new FlightRulesError("TRACE_TOO_LARGE", {
          message: "The request body exceeds the configured maximum size.",
          details: { maximumBytes: context.config.maxRequestBodyBytes },
        });
      } else if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
        translated = new FlightRulesError("VALIDATION_FAILED", {
          message: "The request could not be understood.",
        });
      }
    }

    if (!(translated instanceof FlightRulesError)) {
      request.log.error(
        { request_id: requestId, "error.code": "EVALUATION_FAILED" },
        "unhandled error",
      );
    } else if (translated.code === "EVALUATION_FAILED") {
      request.log.error(
        { request_id: requestId, "error.code": translated.code },
        translated.message,
      );
    } else {
      request.log.warn(
        { request_id: requestId, "error.code": translated.code },
        translated.message,
      );
    }

    return sendError(reply, requestId, translated);
  });

  server.setNotFoundHandler((request, reply) =>
    sendError(
      reply,
      String(request.id),
      new FlightRulesError("NOT_FOUND", { message: "No route matches that path." }),
    ),
  );

  const registry = new RouteRegistry();
  registerCoreRoutes(server, registry, context);
  registerLifecycleRoutes(server, registry, context);
  registerArtifactRoutes(server, registry, context);
  registerGateRoutes(server, registry, context);
  registerDiffRoutes(server, registry, context);
  registerViolationEvidenceRoutes(server, registry, context);
  registerDemoRoutes(server, registry, context);

  // PRD Phase 09 task 11: documentation generated from the same declarations that serve traffic.
  registry.add(
    server,
    {
      method: "GET",
      url: "/api/openapi.json",
      summary: "The OpenAPI document, generated from this server's own route declarations.",
      tag: "meta",
      response: z.object({ openapi: z.string(), info: z.unknown(), paths: z.unknown() }),
      errors: [],
    },
    async () =>
      openApiDocument(registry, "0.1.0") as { openapi: string; info: unknown; paths: unknown },
  );

  return { server, registry };
}

/** Exported for the redaction test: proves a secret-looking key never survives serialisation. */
export function isSecretLogKey(key: string): boolean {
  return isSecretKey(key);
}

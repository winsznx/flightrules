import type { ErrorCode } from "@flightrules/domain";
import { FlightRulesError, redact } from "@flightrules/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type ZodType, z } from "zod";
import { parseOrThrow, requestIdOf, statusFor } from "./http.js";

/**
 * One declaration per route, used for three things at once: registration with Fastify, request and
 * response validation, and the OpenAPI document PRD Phase 09 task 11 requires be generated from
 * source.
 *
 * Generating the document from the same declarations that serve the traffic is the point. A
 * hand-maintained specification drifts from the implementation silently, and a specification that
 * disagrees with the server is worse than none — it is a contract the product does not honour.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteSpec<TBody, TQuery, TResponse> {
  readonly method: HttpMethod;
  readonly url: string;
  readonly summary: string;
  readonly tag: string;
  readonly body?: ZodType<TBody>;
  readonly query?: ZodType<TQuery>;
  readonly response: ZodType<TResponse>;
  readonly successStatus?: number;
  /** Codes this route can produce, beyond the ones every route can. */
  readonly errors: readonly ErrorCode[];
}

export interface RouteHandlerArgs<TBody, TQuery> {
  readonly params: Record<string, string>;
  readonly body: TBody;
  readonly query: TQuery;
  readonly requestId: string;
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
}

export type RouteHandler<TBody, TQuery, TResponse> = (
  args: RouteHandlerArgs<TBody, TQuery>,
) => Promise<TResponse>;

export interface RegisteredRoute {
  readonly method: HttpMethod;
  readonly url: string;
  readonly summary: string;
  readonly tag: string;
  readonly bodySchema: unknown;
  readonly querySchema: unknown;
  readonly responseSchema: unknown;
  readonly successStatus: number;
  readonly errors: readonly ErrorCode[];
}

/** Codes any route may return: a malformed request, an unknown path parameter, a database outage. */
const UNIVERSAL_ERRORS: readonly ErrorCode[] = [
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "EVALUATION_FAILED",
];

export class RouteRegistry {
  readonly #routes: RegisteredRoute[] = [];

  routes(): readonly RegisteredRoute[] {
    return [...this.#routes].sort((a, b) =>
      a.url === b.url ? a.method.localeCompare(b.method) : a.url.localeCompare(b.url),
    );
  }

  add<TBody, TQuery, TResponse>(
    server: FastifyInstance,
    spec: RouteSpec<TBody, TQuery, TResponse>,
    handler: RouteHandler<TBody, TQuery, TResponse>,
  ): void {
    const successStatus = spec.successStatus ?? 200;

    this.#routes.push({
      method: spec.method,
      url: spec.url,
      summary: spec.summary,
      tag: spec.tag,
      bodySchema: spec.body ? z.toJSONSchema(spec.body, { io: "input" }) : null,
      querySchema: spec.query ? z.toJSONSchema(spec.query, { io: "input" }) : null,
      responseSchema: z.toJSONSchema(spec.response, { io: "output" }),
      successStatus,
      errors: [...new Set([...UNIVERSAL_ERRORS, ...spec.errors])].sort(),
    });

    server.route({
      method: spec.method,
      url: spec.url,
      handler: async (request, reply) => {
        const requestId = requestIdOf(request);
        const body = spec.body
          ? parseOrThrow(spec.body, request.body ?? {}, "body")
          : (undefined as TBody);
        const query = spec.query
          ? parseOrThrow(spec.query, request.query ?? {}, "query")
          : (undefined as TQuery);

        const result = await handler({
          params: request.params as Record<string, string>,
          body,
          query,
          requestId,
          request,
          reply,
        });

        // Validating the response against the declared schema is what makes the generated
        // document a contract rather than documentation: a handler that returns a shape the
        // specification does not describe fails here rather than in a consumer.
        const validated = spec.response.safeParse(result);
        if (!validated.success) {
          request.log.error(
            {
              "error.code": "EVALUATION_FAILED",
              route: spec.url,
              issues: validated.error.issues.length,
            },
            "response did not match its declared schema",
          );
          throw new FlightRulesError("EVALUATION_FAILED", {
            message: "The response did not match its declared schema.",
          });
        }
        return reply.status(successStatus).send(redact(validated.data));
      },
    });
  }
}

/** The error envelope as a schema, so it appears in the generated document like any other. */
export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    details: z.record(z.string(), z.unknown()),
  }),
});

export function openApiDocument(registry: RouteRegistry, version: string): unknown {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of registry.routes()) {
    const openApiPath = route.url.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    const parameters = [...route.url.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => ({
      name: match[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    }));

    const responses: Record<string, unknown> = {
      [String(route.successStatus)]: {
        description: "Success",
        content: { "application/json": { schema: route.responseSchema } },
      },
    };
    for (const code of route.errors) {
      const status = String(statusFor(code));
      const existing = responses[status] as { description: string } | undefined;
      responses[status] = {
        description: existing ? `${existing.description}, ${code}` : code,
        content: {
          "application/json": { schema: z.toJSONSchema(ErrorEnvelopeSchema, { io: "output" }) },
        },
      };
    }

    const operation: Record<string, unknown> = {
      summary: route.summary,
      tags: [route.tag],
      operationId: `${route.method.toLowerCase()}${openApiPath.replace(/[^A-Za-z0-9]/g, "_")}`,
      responses,
    };
    if (parameters.length > 0) operation["parameters"] = parameters;
    if (route.querySchema !== null) {
      operation["x-query-schema"] = route.querySchema;
    }
    if (route.bodySchema !== null) {
      operation["requestBody"] = {
        required: true,
        content: { "application/json": { schema: route.bodySchema } },
      };
    }

    paths[openApiPath] = { ...(paths[openApiPath] ?? {}), [route.method.toLowerCase()]: operation };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "FlightRules API",
      version,
      description:
        "Generated from the route declarations this server registers. " +
        "Every error response uses the typed envelope of PRD section 15.",
    },
    paths,
  };
}

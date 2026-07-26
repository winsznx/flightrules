import {
  type Attributes,
  context as otelContext,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AGENT, STABLE } from "./attributes.js";

/**
 * Explicit server-span instrumentation for a demo service.
 *
 * HTTP auto-instrumentation is deliberately not used here. Under ESM, every static import in a
 * module is evaluated before any statement in that module's body, so by the time a bootstrap call
 * runs, Fastify has already loaded `node:http` and the patch has nothing left to patch. Working
 * around that needs a `--import` preload or loader hooks, which adds a moving part to the
 * reproducibility path for no benefit: these are our services, so an explicit span is both
 * deterministic and able to carry the contract-relevant attributes auto-instrumentation would
 * never know to add.
 *
 * Incoming trace context is extracted from the request headers, so each service span joins the
 * agent's run trace rather than starting a new one.
 */

export interface ServiceSpanOptions {
  readonly serviceName: string;
  readonly tracerName: string;
  /** Maps a request to the span name and its contract-relevant attributes. */
  readonly describe: (request: FastifyRequest) => ServiceSpanDescription | null;
}

export interface ServiceSpanDescription {
  readonly name: string;
  readonly sideEffect: string;
  readonly dataDomain: string;
  readonly stepCategory: string;
  readonly extraAttributes?: Attributes | undefined;
}

interface SpanState {
  readonly span: Span;
  readonly description: ServiceSpanDescription;
  readonly startedAtMs: number;
  readonly endContext: () => void;
}

const STATE = new WeakMap<FastifyRequest, SpanState>();

export function registerServiceSpans(server: FastifyInstance, options: ServiceSpanOptions): void {
  const tracer = trace.getTracer(options.tracerName);
  const logger = logs.getLogger(options.serviceName);

  /**
   * One correlated log record per instrumented request (PRD sections 17.5 and 24.5).
   *
   * The Violation Inspector correlates logs strictly by the **trace identifier of the failing run**,
   * which is a demo trace, not a FlightRules one. So exporting the API's and the worker's logs
   * alone would leave the panel empty for every real violation: the only processes inside that
   * trace are these services. This is where the demo's "show correlated payment logs" step gets
   * something to show.
   *
   * The record is emitted with the request's own span context rather than the ambient one, because
   * `onResponse` runs outside the context `onRequest` established.
   *
   * Only fields the product already publishes as span attributes: the route template rather than
   * the URL, so an identifier in a path cannot reach a log; no body, no headers, no query.
   */
  const emitRequestLog = (request: FastifyRequest, state: SpanState, status: number): void => {
    const routeUrl = request.routeOptions?.url ?? "";
    const failed = status >= 400;
    logger.emit({
      severityNumber: failed ? SeverityNumber.WARN : SeverityNumber.INFO,
      severityText: failed ? "WARN" : "INFO",
      body: `${state.description.stepCategory} step ${state.description.name} completed with ${String(status)}`,
      context: trace.setSpan(otelContext.active(), state.span),
      attributes: {
        "service.name": options.serviceName,
        "http.request.method": String(request.method ?? ""),
        "http.route": routeUrl,
        "http.response.status_code": status,
        [AGENT.stepCategory]: state.description.stepCategory,
        [AGENT.sideEffect]: state.description.sideEffect,
        [AGENT.dataDomain]: state.description.dataDomain,
        duration_ms: Math.round(performance.now() - state.startedAtMs),
      },
    });
  };

  server.addHook("onRequest", (request, _reply, done) => {
    const description = options.describe(request);
    if (!description) {
      done();
      return;
    }

    const parent = propagation.extract(otelContext.active(), request.headers);
    const body = (request.body ?? {}) as Record<string, unknown>;

    const attributes: Attributes = {
      [AGENT.sideEffect]: description.sideEffect,
      [AGENT.dataDomain]: description.dataDomain,
      [AGENT.stepCategory]: description.stepCategory,
      ...(description.extraAttributes ?? {}),
    };
    if (typeof body["runId"] === "string") attributes[AGENT.runId] = body["runId"];

    const span = tracer.startSpan(description.name, { kind: SpanKind.SERVER, attributes }, parent);
    const active = trace.setSpan(parent, span);
    const restore = otelContext.bind(active, () => {});
    void restore;

    STATE.set(request, {
      span,
      description,
      startedAtMs: performance.now(),
      endContext: () => {},
    });
    otelContext.with(active, () => done());
  });

  /**
   * A client that aborts mid-request never receives a response, so `onResponse` never fires and
   * the span would be started and never ended — meaning it is never exported.
   *
   * That is exactly what happens on the demo's timed-out payment attempt, and it matters: without
   * this hook the payment service's own record of the attempt vanishes from the trace, even though
   * the service processed it and committed the write. The span is ended here with an explicit
   * `error.type` so the evidence stays honest about what the server actually did.
   */
  server.addHook("onRequestAbort", (request, done) => {
    const state = STATE.get(request);
    if (state) {
      state.span.setStatus({ code: SpanStatusCode.ERROR });
      state.span.setAttribute(STABLE.errorType, "client_disconnected");
      // 499 is not an HTTP status the server sent — nothing was sent. It is the conventional
      // marker for a client that went away, and the record says so in its body.
      emitRequestLog(request, state, 499);
      state.span.end();
      STATE.delete(request);
    }
    done();
  });

  server.addHook("onResponse", (request, reply: FastifyReply, done) => {
    const state = STATE.get(request);
    if (state) {
      const status = reply.statusCode;
      if (status >= 500) {
        state.span.setStatus({ code: SpanStatusCode.ERROR });
        state.span.setAttribute(STABLE.errorType, "server_error");
      } else if (status >= 400) {
        state.span.setStatus({ code: SpanStatusCode.ERROR });
        state.span.setAttribute(STABLE.errorType, "client_error");
      } else {
        state.span.setStatus({ code: SpanStatusCode.OK });
      }
      emitRequestLog(request, state, status);
      state.span.end();
      STATE.delete(request);
    }
    done();
  });
}

/** The active span for a request, so a handler can add attributes it only learns at runtime. */
export function activeServiceSpan(request: FastifyRequest): Span | undefined {
  return STATE.get(request)?.span;
}

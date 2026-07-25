import { type Attributes, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import type { SPAN_NAMES } from "./attributes.js";

/**
 * The FlightRules evaluator spans of PRD section 17.3.
 *
 * `SPAN_NAMES` has declared these since Phase 04, but nothing created them, so the evaluator's own
 * work was invisible in SigNoz and the Phase 10 "violating runs" view had nothing to select on.
 * This is the single creation path, so a span name that is not in the declaration cannot be emitted
 * and an attribute cannot drift between the two call sites.
 *
 * Attributes are span attributes, not metric dimensions: a trace ID or a route fingerprint is
 * welcome here and forbidden on an instrument (PRD section 17.4).
 */

export type FlightRulesSpanName = (typeof SPAN_NAMES)[keyof typeof SPAN_NAMES];

function tracer() {
  return trace.getTracer("flightrules");
}

/** Drops undefined values so an absent identifier does not become the string "undefined". */
export function definedAttributes(attributes: Record<string, unknown>): Attributes {
  const result: Attributes = {};
  for (const key of Object.keys(attributes).sort()) {
    const value = attributes[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Runs `body` inside a FlightRules span, recording a thrown error and re-raising it.
 *
 * The span is ended in every path. A failure is recorded with `SpanStatusCode.ERROR` rather than
 * swallowed, because an evaluation that threw must not look like one that passed.
 */
export async function withFlightRulesSpan<T>(
  name: FlightRulesSpanName,
  attributes: Record<string, unknown>,
  body: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(
    name,
    { attributes: definedAttributes(attributes) },
    async (span) => {
      try {
        const result = await body(span);
        return result;
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.name : "error",
        });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/** Emits a completed FlightRules span with no body. Used for per-run records inside a loop. */
export function recordFlightRulesSpan(
  name: FlightRulesSpanName,
  attributes: Record<string, unknown>,
): void {
  tracer()
    .startSpan(name, { attributes: definedAttributes(attributes) })
    .end();
}

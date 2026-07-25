export {
  AGENT,
  EXPERIMENTAL,
  FLIGHT_RULES,
  HIGH_CARDINALITY_ATTRIBUTES,
  isHighCardinality,
  METRIC_NAMES,
  SPAN_NAMES,
  STABLE,
} from "./attributes.js";
export { bootstrapFromEnv } from "./bootstrap.js";
export type { ServiceSpanDescription, ServiceSpanOptions } from "./fastify.js";
export { activeServiceSpan, registerServiceSpans } from "./fastify.js";
export type { MetricSpec } from "./metrics.js";
export { highCardinalityDimensions, METRIC_SPECS } from "./metrics.js";
export type { TelemetryHandle, TelemetryOptions } from "./sdk.js";
export {
  buildResourceAttributes,
  ForbiddenAttributeRedactor,
  protectSecret,
  startTelemetry,
} from "./sdk.js";

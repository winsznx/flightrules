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
export type { BootstrapOptions } from "./bootstrap.js";
export { bootstrapFromEnv } from "./bootstrap.js";
export type { ServiceSpanDescription, ServiceSpanOptions } from "./fastify.js";
export { activeServiceSpan, registerServiceSpans } from "./fastify.js";
export type { AgentIdentity, EvaluationDimensions } from "./instruments.js";
export { FlightRulesMetrics, filterDimensions } from "./instruments.js";
export type {
  LogPipeline,
  LogPipelineOptions,
  StructuredLogger,
  StructuredLoggerOptions,
} from "./logs.js";
export {
  createOtlpLogStream,
  createStructuredLogger,
  safeLogAttributes,
  severityNumberOf,
  startLogPipeline,
} from "./logs.js";
export type { MetricSpec } from "./metrics.js";
export {
  AGENT_IDENTITY,
  highCardinalityDimensions,
  METRIC_SPECS,
  metricDimensionDisagreement,
  QUERYABLE_IDENTITY_DIMENSIONS,
  RELEASE_IDENTITY,
} from "./metrics.js";
export type { TelemetryHandle, TelemetryOptions } from "./sdk.js";
export {
  buildResourceAttributes,
  ForbiddenAttributeRedactor,
  protectSecret,
  startTelemetry,
} from "./sdk.js";
export type { FlightRulesSpanName } from "./spans.js";
export { definedAttributes, recordFlightRulesSpan, withFlightRulesSpan } from "./spans.js";

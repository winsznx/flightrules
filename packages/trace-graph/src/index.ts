export type { BuildOptions, SpanRowData } from "./build.js";
export { buildTraceGraph, SYNTHETIC_ROOT_SPAN_ID } from "./build.js";
export type {
  CanonicalGraph,
  CanonicalNode,
  CanonicalOrdering,
  RouteFingerprint,
} from "./canonical.js";
export {
  canonicaliseGraph,
  canonicalOrdering,
  fingerprintGraph,
  serialiseCanonicalGraph,
} from "./canonical.js";
export type { GraphChange, GraphChangeKind, GraphDiff } from "./diff.js";
export {
  diffCanonicalGraphs,
  diffGraphs,
  GRAPH_CHANGE_KINDS,
  unknownRouteChange,
} from "./diff.js";
export type { ExportedGraph, GraphExportOptions } from "./export.js";
export { exportGraph, exportGraphJson } from "./export.js";
export type { Feature, FeatureKind, FeatureOptions, FeatureSet } from "./features.js";
export {
  FEATURE_WEIGHTS,
  featuresOf,
  featuresOfGraph,
  similarity,
  weightedJaccard,
} from "./features.js";
export { retryCountOf } from "./measure.js";
export type {
  TraceEdge,
  TraceGraph,
  TraceNode,
  TraceQualityWarning,
  TraceQualityWarningKind,
} from "./model.js";
export {
  childrenOf,
  isBaselineEligible,
  nodeById,
  TRACE_QUALITY_WARNINGS,
} from "./model.js";

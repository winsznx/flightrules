import { FlightRulesError } from "@flightrules/domain";
import type { NormaliserConfig } from "@flightrules/normaliser";
import {
  buildTraceGraph,
  canonicaliseGraph,
  fingerprintGraph,
  isBaselineEligible,
  type SpanRowData,
  type TraceGraph,
} from "@flightrules/trace-graph";
import type { EligibleRun, ExclusionReason } from "./model.js";
import { sanitiseText } from "./safety.js";
import type { MiningSelection } from "./selection.js";

/**
 * Whether one retrieved trace may contribute to a baseline, and why not when it may not.
 *
 * PRD section 16.6 step 8 excludes incomplete and inconsistent traces from baseline mining, and
 * `isBaselineEligible` in `@flightrules/trace-graph` already encodes that. The work here is
 * everything around it: attributing the trace to the right release and run, honouring the selection's
 * toggles, and refusing a trace whose typed evidence cannot be trusted.
 *
 * Every rejection is a typed reason with a detail written from observed facts. Nothing is dropped
 * silently, because a run count smaller than the window actually contained is indistinguishable from
 * a query that missed data.
 */

/** Attributes read directly from the rows rather than from the graph. */
const RELEASE_ATTRIBUTE = "agent.release.id";
const RUN_ATTRIBUTE = "agent.run.id";
const ENVIRONMENT_ATTRIBUTE = "deployment.environment.name";

const NANOS_PER_MILLISECOND = 1_000_000n;

export type EligibilityOutcome =
  | { readonly eligible: true; readonly run: EligibleRun }
  | {
      readonly eligible: false;
      readonly reason: ExclusionReason;
      readonly detail: string;
      readonly spanCount: number;
      readonly graph: TraceGraph | null;
    };

export interface RetrievedTrace {
  readonly traceId: string;
  readonly rows: readonly SpanRowData[];
  readonly webUrl: string | null;
  /**
   * Fields whose returned values did not match the type declared for them.
   *
   * SL-046: a non-string tag requested without `dataType` comes back `null` on a **successful** call,
   * with no error and no warning. Retrieval declares the type and re-checks what came back; a
   * mismatch means this trace's evidence is not what it appears to be, so it is excluded rather than
   * mined from.
   */
  readonly untrustedFields: readonly string[];
  /**
   * A graph the caller already built.
   *
   * Present when the trace comes from somewhere other than a live query — a stored canonical graph,
   * or a fixture built under a specific normaliser configuration. Supplied graphs are the reason the
   * normaliser-identity check below is load-bearing rather than decorative: a dataset assembled from
   * two normaliser versions has fingerprints that cannot be compared, and nothing else would notice.
   */
  readonly graph?: TraceGraph;
}

export interface EligibilityContext {
  readonly selection: MiningSelection;
  readonly config: NormaliserConfig;
  /** The normaliser identity every eligible run must share. */
  readonly normaliserVersion: string;
  readonly normaliserConfigHash: string;
}

/**
 * Reads one string attribute from whichever row carries it.
 *
 * A trace's release and run identifiers are resource-level facts repeated on every span, but a
 * partially-instrumented service may omit them, so the first non-empty value across the rows is
 * taken. Disagreement is not a merge problem: it is reported, because two releases inside one trace
 * is a real anomaly rather than a value to pick between.
 */
function readSharedAttribute(
  rows: readonly SpanRowData[],
  key: string,
): { readonly values: readonly string[] } {
  const values = new Set<string>();
  for (const row of rows) {
    const value = row[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) values.add(trimmed);
  }
  return { values: [...values].sort() };
}

function hasErrorSpan(rows: readonly SpanRowData[]): boolean {
  for (const row of rows) {
    if (row["has_error"] === true) return true;
    const status = row["status_code_string"];
    if (typeof status === "string" && status.trim().toLowerCase() === "error") return true;
  }
  return false;
}

/** Root span start time in whole milliseconds, and the run duration measured from the root. */
function timingOf(graph: TraceGraph): {
  readonly startedAtMs: number;
  readonly durationMs: number;
} {
  const root = graph.nodes.find((node) => node.spanId === graph.rootSpanId);
  if (root === undefined) return { startedAtMs: 0, durationMs: 0 };
  return {
    startedAtMs: Number(root.startTimeUnixNano / NANOS_PER_MILLISECOND),
    durationMs: Number(root.durationNano / NANOS_PER_MILLISECOND),
  };
}

/**
 * Classifies one retrieved trace.
 *
 * Ordered so the cheapest and most fundamental objections come first: a trace that cannot be built
 * into a graph has no quality, no release and no run to check. Deduplication is **not** decided here
 * — it needs the rest of the dataset, so `assembleDataset` owns it.
 */
export function classifyTrace(
  trace: RetrievedTrace,
  context: EligibilityContext,
): EligibilityOutcome {
  const spanCount = trace.rows.length;

  if (trace.untrustedFields.length > 0) {
    return {
      eligible: false,
      reason: "UNTRUSTED_TYPED_ATTRIBUTE",
      detail: `The retrieved values for ${trace.untrustedFields.join(", ")} did not match their declared SigNoz field types, so this trace's evidence cannot be trusted.`,
      spanCount,
      graph: null,
    };
  }

  let graph: TraceGraph;
  try {
    graph =
      trace.graph ??
      buildTraceGraph(trace.rows, {
        config: context.config,
        rootSelector: context.selection.rootSpanName,
        maxSpans: context.selection.maxSpansPerTrace,
      });
  } catch (error: unknown) {
    const code = error instanceof FlightRulesError ? error.code : "GRAPH_INVALID";
    return {
      eligible: false,
      reason: code === "TRACE_TOO_LARGE" ? "TRACE_TOO_LARGE" : "TRACE_MALFORMED",
      detail:
        code === "TRACE_TOO_LARGE"
          ? `The trace carries ${spanCount} span(s), above the configured maximum of ${context.selection.maxSpansPerTrace}.`
          : `The span rows could not be reconstructed into a graph (${code}).`,
      spanCount,
      graph: null,
    };
  }

  const warnings = graph.warnings.map((warning) => warning.kind);

  if (graph.quality === "inconsistent") {
    return {
      eligible: false,
      reason: "TRACE_INCONSISTENT",
      detail:
        "Duplicate records for at least one span disagree on core identity fields, or the parent relation contains a cycle.",
      spanCount,
      graph,
    };
  }

  if (!isBaselineEligible(graph)) {
    return {
      eligible: false,
      reason: "TRACE_INCOMPLETE",
      detail: `Trace quality is ${graph.quality} (${warnings.join(", ") || "no warning recorded"}), so an absence observed in it would not be sound evidence.`,
      spanCount,
      graph,
    };
  }

  if (
    context.selection.excludeMissingRootSpan &&
    warnings.includes("missing_root_selector_match")
  ) {
    return {
      eligible: false,
      reason: "ROOT_SPAN_MISSING",
      detail: `No parentless span was named ${context.selection.rootSpanName}.`,
      spanCount,
      graph,
    };
  }

  if (
    graph.normaliserVersion !== context.normaliserVersion ||
    graph.normaliserConfigHash !== context.normaliserConfigHash
  ) {
    return {
      eligible: false,
      reason: "NORMALISER_VERSION_MISMATCH",
      detail: `The trace was normalised by ${graph.normaliserVersion}/${graph.normaliserConfigHash.slice(0, 12)}, not ${context.normaliserVersion}/${context.normaliserConfigHash.slice(0, 12)}, so its fingerprint is not comparable.`,
      spanCount,
      graph,
    };
  }

  const releases = readSharedAttribute(trace.rows, RELEASE_ATTRIBUTE);
  if (releases.values.length === 0) {
    return {
      eligible: false,
      reason: "RELEASE_ID_MISSING",
      detail: `No span carried ${RELEASE_ATTRIBUTE}, so the trace cannot be attributed to a release.`,
      spanCount,
      graph,
    };
  }
  if (releases.values.length > 1 || releases.values[0] !== context.selection.releaseId) {
    return {
      eligible: false,
      reason: "RELEASE_MISMATCH",
      detail: `The trace reports release(s) ${releases.values.map((value) => sanitiseText(value, 64).value).join(", ")}; the baseline is for ${context.selection.releaseId}.`,
      spanCount,
      graph,
    };
  }

  const environments = readSharedAttribute(trace.rows, ENVIRONMENT_ATTRIBUTE);
  if (context.selection.environment !== null) {
    if (
      environments.values.length !== 1 ||
      environments.values[0] !== context.selection.environment
    ) {
      return {
        eligible: false,
        reason: "ENVIRONMENT_MISMATCH",
        detail: `The trace reports environment(s) ${environments.values.map((value) => sanitiseText(value, 64).value).join(", ") || "none"}; the baseline is for ${context.selection.environment}.`,
        spanCount,
        graph,
      };
    }
  }

  const runs = readSharedAttribute(trace.rows, RUN_ATTRIBUTE);
  if (runs.values.length !== 1) {
    return {
      eligible: false,
      reason: "RUN_ID_MISSING",
      detail:
        runs.values.length === 0
          ? `No span carried ${RUN_ATTRIBUTE}, so this run cannot be distinguished from another.`
          : `The trace carries ${runs.values.length} distinct ${RUN_ATTRIBUTE} values, so it does not describe one run.`,
      spanCount,
      graph,
    };
  }

  if (context.selection.successfulRunsOnly && hasErrorSpan(trace.rows)) {
    return {
      eligible: false,
      reason: "RUN_NOT_SUCCESSFUL",
      detail:
        "At least one span reported an error status and the selection asked for successful runs only.",
      spanCount,
      graph,
    };
  }

  const timing = timingOf(graph);

  return {
    eligible: true,
    run: {
      traceId: trace.traceId,
      runId: runs.values[0] as string,
      releaseId: context.selection.releaseId,
      environment: environments.values[0] ?? null,
      fingerprint: fingerprintGraph(graph).fingerprint,
      canonical: canonicaliseGraph(graph),
      graph,
      startedAtMs: timing.startedAtMs,
      durationMs: timing.durationMs,
      warnings,
      webUrl: trace.webUrl,
    },
  };
}

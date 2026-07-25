import { FlightRulesError, type TraceQuality } from "@flightrules/domain";
import {
  classify,
  DEFAULT_NORMALISER_CONFIG,
  identityOf,
  type NormaliserConfig,
  normaliseAttributes,
  normaliseName,
} from "@flightrules/normaliser";
import type {
  TraceEdge,
  TraceGraph,
  TraceNode,
  TraceQualityWarning,
  TraceQualityWarningKind,
} from "./model.js";

/**
 * Graph construction from SigNoz span rows.
 *
 * Every step is deterministic and order-independent. Rows arrive from the Query Builder in an
 * order that is not stable across requests — Phase 05 observed the same trace returning its spans
 * in different orders for ascending and descending queries — so nothing here may depend on
 * arrival order. Property tests permute the input and assert one fingerprint.
 */

/** The raw `data` object of one Query Builder row. */
export type SpanRowData = Readonly<Record<string, unknown>>;

export interface BuildOptions {
  readonly config?: NormaliserConfig;
  /**
   * Span name that identifies the run root when several spans have no parent. PRD section 11.4
   * step 1.
   */
  readonly rootSelector?: string;
  /** PRD section 18.2 requires an explicit maximum with its own error state. */
  readonly maxSpans?: number;
}

const DEFAULT_MAX_SPANS = 10_000;

interface WarningAccumulator {
  readonly kind: TraceQualityWarningKind;
  readonly message: string;
  readonly spanIds: Set<string>;
}

class Warnings {
  readonly #byKind = new Map<TraceQualityWarningKind, WarningAccumulator>();

  add(kind: TraceQualityWarningKind, message: string, spanIds: readonly string[]): void {
    const existing = this.#byKind.get(kind);
    if (existing === undefined) {
      this.#byKind.set(kind, { kind, message, spanIds: new Set(spanIds) });
      return;
    }
    for (const id of spanIds) existing.spanIds.add(id);
  }

  has(kind: TraceQualityWarningKind): boolean {
    return this.#byKind.has(kind);
  }

  /** Sorted by kind then span ID, so an equivalent trace produces an identical warning list. */
  toList(): readonly TraceQualityWarning[] {
    return [...this.#byKind.values()]
      .map((accumulator) => ({
        kind: accumulator.kind,
        message: accumulator.message,
        spanIds: [...accumulator.spanIds].sort(),
      }))
      .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  }
}

function readString(row: SpanRowData, key: string): string | null {
  const value = row[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function readBigInt(row: SpanRowData, key: string): bigint {
  const value = row[key];
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && value.length > 0) {
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

const NANOS_PER_MILLISECOND = 1_000_000n;

/**
 * Converts SigNoz's ISO-8601 `timestamp` column to nanoseconds. The column holds nanoseconds in
 * ClickHouse, but the Query Builder serialises it as an ISO string at millisecond precision, so
 * this is the best available reconstruction. Timestamps are excluded from the fingerprint, which
 * is why the lost precision cannot affect determinism.
 */
function readStartNano(row: SpanRowData): bigint {
  const value = row["timestamp"];
  if (typeof value !== "string") return 0n;
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? 0n : BigInt(millis) * NANOS_PER_MILLISECOND;
}

/** Core identity fields. Duplicates that disagree on any of these make the trace inconsistent. */
function identityFingerprintOf(row: SpanRowData): string {
  return JSON.stringify([
    readString(row, "name"),
    readString(row, "service.name"),
    readString(row, "parent_span_id"),
    readString(row, "kind_string"),
  ]);
}

/**
 * Deduplicates by `(trace_id, span_id)` per PRD section 11.5.
 *
 * When duplicates agree on the core identity fields, the record with the most populated
 * attributes wins — a partial write and a complete one describe the same span, and the complete
 * one is strictly better evidence. When they disagree, no merge is attempted: the trace is marked
 * inconsistent and excluded from baseline mining, because silently choosing one of two
 * contradictory records is how a wrong baseline gets built.
 */
function deduplicate(
  rows: readonly SpanRowData[],
  warnings: Warnings,
): { readonly rows: readonly SpanRowData[]; readonly inconsistent: boolean } {
  const bySpanId = new Map<string, SpanRowData>();
  const identityBySpanId = new Map<string, string>();
  let inconsistent = false;

  for (const row of rows) {
    const spanId = readString(row, "span_id");
    if (spanId === null) continue;

    const existing = bySpanId.get(spanId);
    if (existing === undefined) {
      bySpanId.set(spanId, row);
      identityBySpanId.set(spanId, identityFingerprintOf(row));
      continue;
    }

    if (identityBySpanId.get(spanId) !== identityFingerprintOf(row)) {
      inconsistent = true;
      warnings.add(
        "conflicting_duplicate_spans",
        "Duplicate records for this span disagree on name, service, parent or kind. " +
          "The trace is excluded from baseline mining.",
        [spanId],
      );
      continue;
    }

    warnings.add(
      "duplicate_spans_merged",
      "Duplicate records for this span agreed on identity and were merged by attribute completeness.",
      [spanId],
    );
    if (Object.keys(row).length > Object.keys(existing).length) bySpanId.set(spanId, row);
  }

  // Sorted by span ID so deduplication output does not depend on input order.
  return {
    rows: [...bySpanId.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, row]) => row),
    inconsistent,
  };
}

function toNode(row: SpanRowData, traceId: string, config: NormaliserConfig): TraceNode {
  const spanId = readString(row, "span_id") as string;
  const name = readString(row, "name") ?? "";
  const { fingerprint, evidence } = normaliseAttributes(row, config);
  const classification = classify(row, config);
  const startTimeUnixNano = readStartNano(row);
  const durationNano = readBigInt(row, "duration_nano");

  return {
    spanId,
    traceId,
    parentSpanId: readString(row, "parent_span_id"),
    name,
    canonicalName: normaliseName(name, config),
    serviceName: readString(row, "service.name") ?? "unknown",
    operationName: readString(row, "gen_ai.operation.name"),
    spanKind: readString(row, "kind_string"),
    statusCode: readString(row, "status_code_string"),
    startTimeUnixNano,
    endTimeUnixNano: startTimeUnixNano + durationNano,
    durationNano,
    attributes: fingerprint,
    evidence,
    ...classification,
    synthetic: false,
  };
}

const SYNTHETIC_ROOT_SPAN_ID = "synthetic-root";

function syntheticRoot(traceId: string): TraceNode {
  return {
    spanId: SYNTHETIC_ROOT_SPAN_ID,
    traceId,
    parentSpanId: null,
    name: "synthetic.root",
    canonicalName: "synthetic.root",
    serviceName: "flightrules",
    operationName: null,
    spanKind: null,
    statusCode: null,
    startTimeUnixNano: 0n,
    endTimeUnixNano: 0n,
    durationNano: 0n,
    attributes: {},
    evidence: {},
    toolName: null,
    toolType: null,
    sideEffect: "none",
    dataDomain: null,
    retryNumber: null,
    releaseId: null,
    environment: null,
    synthetic: true,
  };
}

/**
 * Selects the root per PRD section 11.4, in order: a parentless span matching the configured
 * selector, then the earliest-starting parentless span, then a synthetic root over all orphans.
 *
 * "Parentless" includes a span whose parent is not present in the trace. That is the common case
 * for a partially exported trace, and treating such a span as rooted rather than dangling is what
 * lets an incomplete trace still be analysed.
 */
function selectRoot(
  nodes: readonly TraceNode[],
  options: BuildOptions,
  warnings: Warnings,
): { readonly rootSpanId: string; readonly syntheticNode: TraceNode | undefined } {
  const present = new Set(nodes.map((node) => node.spanId));
  const parentless = nodes.filter(
    (node) => node.parentSpanId === null || !present.has(node.parentSpanId),
  );

  for (const node of nodes) {
    if (node.parentSpanId !== null && !present.has(node.parentSpanId)) {
      warnings.add("orphan_span", "This span's parent is not present in the trace.", [node.spanId]);
    }
  }

  if (parentless.length === 0) {
    // Every span claims a parent inside the trace, so the parent relation must contain a cycle.
    return { rootSpanId: "", syntheticNode: undefined };
  }

  if (parentless.length > 1) {
    warnings.add(
      "multiple_roots",
      "The trace has more than one span without a parent inside it.",
      parentless.map((node) => node.spanId),
    );
  }

  if (options.rootSelector !== undefined) {
    const matches = parentless
      .filter((node) => node.canonicalName === options.rootSelector)
      .sort((a, b) => (a.spanId < b.spanId ? -1 : 1));
    const match = matches[0];
    if (match !== undefined) return { rootSpanId: match.spanId, syntheticNode: undefined };

    warnings.add(
      "missing_root_selector_match",
      `No parentless span matched the configured root selector ${options.rootSelector}.`,
      [],
    );
  }

  if (parentless.length === 1) {
    return { rootSpanId: (parentless[0] as TraceNode).spanId, syntheticNode: undefined };
  }

  // Earliest start wins, with the span ID breaking a tie so equal timestamps stay deterministic.
  const earliest = [...parentless].sort((a, b) => {
    if (a.startTimeUnixNano !== b.startTimeUnixNano) {
      return a.startTimeUnixNano < b.startTimeUnixNano ? -1 : 1;
    }
    return a.spanId < b.spanId ? -1 : 1;
  })[0] as TraceNode;

  // A synthetic root is only worth creating when the parentless spans are genuinely siblings.
  // Attaching them all to the earliest one would invent a causal relationship that was never
  // observed, which PRD section 11.1 forbids.
  warnings.add("synthetic_root", "Orphan roots were attached to a synthetic root.", [
    earliest.spanId,
  ]);
  return { rootSpanId: SYNTHETIC_ROOT_SPAN_ID, syntheticNode: syntheticRoot(earliest.traceId) };
}

/**
 * Detects a cycle in the parent relation.
 *
 * Iterative, with an explicit stack. A recursive walk overflows on a deep trace, and PRD Phase 06
 * requires no stack overflow on deep traces — a 10,000-span chain is a legitimate agent trace.
 */
function findCycleMembers(nodes: readonly TraceNode[]): readonly string[] {
  const parentOf = new Map<string, string | null>();
  for (const node of nodes) parentOf.set(node.spanId, node.parentSpanId);

  const state = new Map<string, "visiting" | "done">();
  const cycleMembers = new Set<string>();

  for (const node of nodes) {
    if (state.get(node.spanId) === "done") continue;

    const path: string[] = [];
    let current: string | null = node.spanId;

    while (current !== null && parentOf.has(current)) {
      const seen = state.get(current);
      if (seen === "done") break;
      if (seen === "visiting") {
        // Everything from the first sighting of `current` onwards is on the cycle.
        const start = path.indexOf(current);
        for (const member of path.slice(start === -1 ? 0 : start)) cycleMembers.add(member);
        break;
      }
      state.set(current, "visiting");
      path.push(current);
      current = parentOf.get(current) ?? null;
    }

    for (const member of path) state.set(member, "done");
  }

  return [...cycleMembers].sort();
}

/**
 * A client span with no server span beneath it.
 *
 * Phase 04 established that the v2 trace's first payment attempt has no exported server span: the
 * client aborts while the handler is still running, and Fastify 5.10.0's `onRequestAbort` does not
 * fire for a request already in flight. That is a real property of an aborted request, not a
 * defect to paper over.
 *
 * It is reported as a trace-quality warning and deliberately does **not** make the trace
 * incomplete. The duplicate-side-effect evidence lives entirely in the two exported client spans,
 * so the contract remains decidable; treating the missing server span as absence of the call
 * would turn a correctly-detected duplicate refund into a false negative.
 */
function findClientSpansWithoutServerSpan(
  nodes: readonly TraceNode[],
  edges: readonly TraceEdge[],
): readonly string[] {
  const childrenOfSpan = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.type !== "parent") continue;
    const list = childrenOfSpan.get(edge.from);
    if (list === undefined) childrenOfSpan.set(edge.from, [edge.to]);
    else list.push(edge.to);
  }
  const byId = new Map(nodes.map((node) => [node.spanId, node]));

  return nodes
    .filter((node) => {
      if (node.spanKind !== "Client") return false;
      // Only remote calls are expected to produce a server span. A client span with no side
      // effect at all is local work and proves nothing by its childlessness.
      if (node.sideEffect === "none" || node.sideEffect === "unknown") return false;
      const children = childrenOfSpan.get(node.spanId) ?? [];
      return !children.some((childId) => byId.get(childId)?.spanKind === "Server");
    })
    .map((node) => node.spanId)
    .sort();
}

/**
 * Builds a canonical trace graph from Query Builder rows.
 *
 * Throws only for a condition no caller can act on generically: an empty row set, or a span count
 * beyond the configured maximum. Everything else — orphans, cycles, duplicates, missing server
 * spans — is reported through `quality` and `warnings`, because a degraded trace still carries
 * evidence and the PRD requires incomplete evidence to be visible rather than fatal.
 */
export function buildTraceGraph(
  rows: readonly SpanRowData[],
  options: BuildOptions = {},
): TraceGraph {
  const config = options.config ?? DEFAULT_NORMALISER_CONFIG;
  const maxSpans = options.maxSpans ?? DEFAULT_MAX_SPANS;
  const warnings = new Warnings();

  if (rows.length === 0) {
    throw new FlightRulesError("TRACE_INCOMPLETE", {
      message: "The trace contains no spans.",
      details: { rowCount: 0 },
    });
  }
  if (rows.length > maxSpans) {
    throw new FlightRulesError("TRACE_TOO_LARGE", {
      details: { rowCount: rows.length, maxSpans },
    });
  }

  const usable = rows.filter((row) => readString(row, "span_id") !== null);
  const rejectedRowCount = rows.length - usable.length;
  if (usable.length === 0) {
    throw new FlightRulesError("TRACE_INCOMPLETE", {
      message: "No row in the response carried a span identifier.",
      details: { rowCount: rows.length },
    });
  }

  const traceIds = new Set(
    usable.map((row) => readString(row, "trace_id")).filter((id): id is string => id !== null),
  );
  if (traceIds.size > 1) {
    throw new FlightRulesError("TRACE_INCONSISTENT", {
      message: "The rows span more than one trace.",
      details: { traceIdCount: traceIds.size },
    });
  }
  const traceId = [...traceIds][0] ?? "";

  const { rows: deduplicated, inconsistent } = deduplicate(usable, warnings);
  const nodes = deduplicated.map((row) => toNode(row, traceId, config));

  const cycleMembers = findCycleMembers(nodes);
  if (cycleMembers.length > 0) {
    warnings.add(
      "cycle_detected",
      "The parent relation contains a cycle. The affected edges are dropped.",
      cycleMembers,
    );
  }
  const onCycle = new Set(cycleMembers);

  const { rootSpanId, syntheticNode } = selectRoot(nodes, options, warnings);
  const allNodes = syntheticNode === undefined ? nodes : [...nodes, syntheticNode];
  const present = new Set(allNodes.map((node) => node.spanId));

  const edges: TraceEdge[] = [];
  for (const node of allNodes) {
    if (node.spanId === rootSpanId) continue;

    const parentId = node.parentSpanId;
    const parentIsUsable = parentId !== null && present.has(parentId) && !onCycle.has(node.spanId);

    if (parentIsUsable) {
      edges.push({ from: parentId, to: node.spanId, type: "parent" });
    } else if (syntheticNode !== undefined) {
      edges.push({ from: SYNTHETIC_ROOT_SPAN_ID, to: node.spanId, type: "parent" });
    }
  }
  edges.sort((a, b) =>
    a.from !== b.from
      ? a.from < b.from
        ? -1
        : 1
      : a.to !== b.to
        ? a.to < b.to
          ? -1
          : 1
        : a.type < b.type
          ? -1
          : 1,
  );

  const danglingClients = findClientSpansWithoutServerSpan(allNodes, edges);
  if (danglingClients.length > 0) {
    warnings.add(
      "client_span_without_server_span",
      "A remote call has no server span beneath it. The call is still evidence; its absence " +
        "is a trace-quality limitation, not proof the call did not happen.",
      danglingClients,
    );
  }

  const quality = resolveQuality({ inconsistent, hasCycle: cycleMembers.length > 0, warnings });
  const identity = identityOf(config);

  return {
    traceId,
    rootSpanId: rootSpanId === "" ? ((allNodes[0] as TraceNode).spanId ?? "") : rootSpanId,
    nodes: [...allNodes].sort((a, b) => (a.spanId < b.spanId ? -1 : 1)),
    edges,
    quality,
    warnings: warnings.toList(),
    normaliserVersion: identity.version,
    normaliserConfigHash: identity.configHash,
    rejectedRowCount,
  };
}

/**
 * Maps warnings onto the trace-quality verdict.
 *
 * Only contradiction makes a trace `inconsistent`, and only a structural defect that changes what
 * the graph means makes it `incomplete`. A missing server span does neither: the route it
 * evidences is still fully determined by the client span, so downgrading the whole trace for it
 * would discard usable baseline data for no gain.
 */
function resolveQuality(input: {
  readonly inconsistent: boolean;
  readonly hasCycle: boolean;
  readonly warnings: Warnings;
}): TraceQuality {
  if (input.inconsistent) return "inconsistent";
  if (input.hasCycle) return "inconsistent";
  if (input.warnings.has("orphan_span") || input.warnings.has("synthetic_root")) {
    return "incomplete";
  }
  return "complete";
}

export { SYNTHETIC_ROOT_SPAN_ID };

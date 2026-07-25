import type { TraceQuality } from "@flightrules/domain";
import type { CanonicalGraph } from "@flightrules/trace-graph";
import { canonicalObject } from "../canonical.js";
import { readCanonicalGraph } from "../read-canonical.js";
import type { Db } from "../sql.js";

/**
 * Observed runs and their canonical graphs (PRD sections 14.5 and 14.6).
 *
 * PRD section 14.5 is explicit that raw traces are not stored: "Store safe canonical evidence and
 * refetch through SigNoz when required." So a `trace_run` holds identity, timing and quality, and a
 * `trace_graph` holds the canonical projection and the fingerprint — enough to link a violation to
 * its evidence (FR-017) and to compare two releases, and not enough to leak a payload.
 *
 * Both writes are idempotent on their natural keys, because a run may be seen by a mining job and
 * again by an evaluation, and neither should create a second row for the same trace.
 */

/**
 * The version of the *stored* projection, not of the graph algorithm.
 *
 * A canonical graph's own version lives in `normaliser_version`. This one changes when the shape
 * FlightRules persists changes, so a reader can tell an old row from a new one without inferring it
 * from the columns present.
 */
export const GRAPH_SCHEMA_VERSION = "1.0.0";

export interface TraceRunRow {
  readonly id: string;
  readonly agent_id: string;
  readonly release_id: string | null;
  readonly trace_id: string;
  readonly run_id: string | null;
  readonly signoz_web_url: string | null;
  readonly root_span_id: string | null;
  readonly started_at: Date;
  readonly completed_at: Date | null;
  readonly duration_ms: number | null;
  readonly status: "ok" | "error" | "unknown";
  readonly quality_status: TraceQuality;
  readonly raw_summary_json: unknown;
  readonly created_at: Date;
}

export interface TraceRun {
  readonly id: string;
  readonly agentId: string;
  readonly releaseId: string | null;
  readonly traceId: string;
  readonly runId: string | null;
  readonly signozWebUrl: string | null;
  readonly rootSpanId: string | null;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
  readonly durationMs: number | null;
  readonly status: "ok" | "error" | "unknown";
  readonly qualityStatus: TraceQuality;
  readonly summary: unknown;
  readonly createdAt: Date;
}

const TRACE_RUN_COLUMNS = [
  "id",
  "agent_id",
  "release_id",
  "trace_id",
  "run_id",
  "signoz_web_url",
  "root_span_id",
  "started_at",
  "completed_at",
  "duration_ms",
  "status",
  "quality_status",
  "raw_summary_json",
  "created_at",
] as const;

export function toTraceRun(row: TraceRunRow): TraceRun {
  return {
    id: row.id,
    agentId: row.agent_id,
    releaseId: row.release_id,
    traceId: row.trace_id,
    runId: row.run_id,
    signozWebUrl: row.signoz_web_url,
    rootSpanId: row.root_span_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
    status: row.status,
    qualityStatus: row.quality_status,
    summary: row.raw_summary_json,
    createdAt: row.created_at,
  };
}

export interface UpsertTraceRunInput {
  readonly agentId: string;
  readonly releaseId: string | null;
  readonly traceId: string;
  readonly runId: string | null;
  readonly signozWebUrl: string | null;
  readonly rootSpanId: string | null;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
  readonly durationMs: number | null;
  readonly status: "ok" | "error" | "unknown";
  readonly qualityStatus: TraceQuality;
  readonly summary: Readonly<Record<string, unknown>>;
}

export async function upsertTraceRun(sql: Db, input: UpsertTraceRunInput): Promise<TraceRun> {
  const rows = await sql<TraceRunRow[]>`
    insert into trace_runs (
      agent_id, release_id, trace_id, run_id, signoz_web_url, root_span_id,
      started_at, completed_at, duration_ms, status, quality_status, raw_summary_json
    ) values (
      ${input.agentId}, ${input.releaseId}, ${input.traceId}, ${input.runId},
      ${input.signozWebUrl}, ${input.rootSpanId}, ${input.startedAt}, ${input.completedAt},
      ${input.durationMs}, ${input.status}, ${input.qualityStatus},
      ${sql.json(canonicalObject(input.summary))}::jsonb
    )
    on conflict (agent_id, trace_id) do update set
      release_id = coalesce(excluded.release_id, trace_runs.release_id),
      run_id = coalesce(excluded.run_id, trace_runs.run_id),
      signoz_web_url = coalesce(excluded.signoz_web_url, trace_runs.signoz_web_url),
      root_span_id = coalesce(excluded.root_span_id, trace_runs.root_span_id),
      completed_at = coalesce(excluded.completed_at, trace_runs.completed_at),
      duration_ms = coalesce(excluded.duration_ms, trace_runs.duration_ms),
      status = excluded.status,
      quality_status = excluded.quality_status,
      raw_summary_json = excluded.raw_summary_json
    returning ${sql(TRACE_RUN_COLUMNS)}`;
  const row = rows[0];
  if (!row) throw new Error("trace_runs returned no row");
  return toTraceRun(row);
}

export async function findTraceRunByTraceId(
  sql: Db,
  agentId: string,
  traceId: string,
): Promise<TraceRun | null> {
  const rows = await sql<TraceRunRow[]>`
    select ${sql(TRACE_RUN_COLUMNS)} from trace_runs
    where agent_id = ${agentId} and trace_id = ${traceId}`;
  const row = rows[0];
  return row ? toTraceRun(row) : null;
}

export async function findTraceRun(sql: Db, id: string): Promise<TraceRun | null> {
  const rows = await sql<TraceRunRow[]>`
    select ${sql(TRACE_RUN_COLUMNS)} from trace_runs where id = ${id}`;
  const row = rows[0];
  return row ? toTraceRun(row) : null;
}

// ---------------------------------------------------------------------------
// 14.6 trace_graphs
// ---------------------------------------------------------------------------

interface TraceGraphRow {
  readonly id: string;
  readonly trace_run_id: string;
  readonly normaliser_version: string;
  readonly normaliser_config_hash: string;
  readonly graph_schema_version: string;
  readonly fingerprint: string;
  readonly canonical_graph_json: unknown;
  readonly feature_set_json: unknown;
  readonly quality_warnings_json: unknown;
  readonly created_at: Date;
}

export interface StoredTraceGraph {
  readonly id: string;
  readonly traceRunId: string;
  readonly normaliserVersion: string;
  readonly normaliserConfigHash: string;
  readonly graphSchemaVersion: string;
  readonly fingerprint: string;
  readonly canonical: CanonicalGraph;
  readonly featureSet: unknown;
  readonly qualityWarnings: unknown;
  readonly createdAt: Date;
}

const TRACE_GRAPH_COLUMNS = [
  "id",
  "trace_run_id",
  "normaliser_version",
  "normaliser_config_hash",
  "graph_schema_version",
  "fingerprint",
  "canonical_graph_json",
  "feature_set_json",
  "quality_warnings_json",
  "created_at",
] as const;

function toStoredGraph(row: TraceGraphRow): StoredTraceGraph {
  return {
    id: row.id,
    traceRunId: row.trace_run_id,
    normaliserVersion: row.normaliser_version,
    normaliserConfigHash: row.normaliser_config_hash,
    graphSchemaVersion: row.graph_schema_version,
    fingerprint: row.fingerprint,
    canonical: readCanonicalGraph(row.canonical_graph_json),
    featureSet: row.feature_set_json,
    qualityWarnings: row.quality_warnings_json,
    createdAt: row.created_at,
  };
}

export interface UpsertTraceGraphInput {
  readonly traceRunId: string;
  readonly normaliserVersion: string;
  readonly normaliserConfigHash: string;
  readonly graphSchemaVersion: string;
  readonly fingerprint: string;
  readonly canonical: CanonicalGraph;
  readonly featureSet: unknown;
  readonly qualityWarnings: readonly unknown[];
}

export async function upsertTraceGraph(
  sql: Db,
  input: UpsertTraceGraphInput,
): Promise<StoredTraceGraph> {
  const rows = await sql<TraceGraphRow[]>`
    insert into trace_graphs (
      trace_run_id, normaliser_version, normaliser_config_hash, graph_schema_version,
      fingerprint, canonical_graph_json, feature_set_json, quality_warnings_json
    ) values (
      ${input.traceRunId}, ${input.normaliserVersion}, ${input.normaliserConfigHash},
      ${input.graphSchemaVersion}, ${input.fingerprint},
      ${sql.json(canonicalObject(input.canonical))}::jsonb,
      ${sql.json(canonicalObject(input.featureSet))}::jsonb,
      ${sql.json(canonicalObject(input.qualityWarnings))}::jsonb
    )
    on conflict (trace_run_id, normaliser_version) do update set
      fingerprint = excluded.fingerprint,
      normaliser_config_hash = excluded.normaliser_config_hash,
      canonical_graph_json = excluded.canonical_graph_json,
      feature_set_json = excluded.feature_set_json,
      quality_warnings_json = excluded.quality_warnings_json
    returning ${sql(TRACE_GRAPH_COLUMNS)}`;
  const row = rows[0];
  if (!row) throw new Error("trace_graphs returned no row");
  return toStoredGraph(row);
}

export async function findTraceGraph(
  sql: Db,
  traceRunId: string,
  normaliserVersion: string,
): Promise<StoredTraceGraph | null> {
  const rows = await sql<TraceGraphRow[]>`
    select ${sql(TRACE_GRAPH_COLUMNS)} from trace_graphs
    where trace_run_id = ${traceRunId} and normaliser_version = ${normaliserVersion}`;
  const row = rows[0];
  return row ? toStoredGraph(row) : null;
}

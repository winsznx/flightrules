import type {
  ReleaseBaselineReference,
  ReleaseRunRecord,
  RunEvaluation,
} from "@flightrules/contract-engine";
import { retryCountOf } from "@flightrules/trace-graph";
import { readCanonicalGraph } from "../read-canonical.js";
import type { Db } from "../sql.js";

/**
 * Reads the release gate needs (PRD FR-011, FR-012, section 15.7).
 *
 * Nothing here decides anything. The gate decision is computed by `aggregateRelease` in
 * `@flightrules/contract-engine`, which is pure; this module's only job is to hand it verified
 * persisted evidence, in a stable order, without letting a raw row escape.
 *
 * Every run record is assembled from three tables that were written by one transaction: the
 * evaluator's own canonical result, the trace run it judged, and the canonical graph that result was
 * computed over. A record missing its graph is returned with a `null` retry count rather than
 * dropped, so "we did not measure this" stays distinguishable from "this run had no retries".
 */

export interface ReleaseEvaluationHeader {
  readonly id: string;
  readonly agentId: string;
  readonly contractId: string;
  readonly releaseId: string | null;
  readonly status: string;
  readonly contractContentHash: string;
  readonly evaluatorVersion: string;
  readonly windowStart: Date | null;
  readonly windowEnd: Date | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly summary: unknown;
  readonly createdAt: Date;
}

interface HeaderRow {
  readonly id: string;
  readonly agent_id: string;
  readonly contract_id: string;
  readonly release_id: string | null;
  readonly status: string;
  readonly contract_content_hash: string;
  readonly evaluator_version: string;
  readonly window_start: Date | null;
  readonly window_end: Date | null;
  readonly started_at: Date | null;
  readonly completed_at: Date | null;
  readonly summary_json: unknown;
  readonly created_at: Date;
}

function toHeader(row: HeaderRow): ReleaseEvaluationHeader {
  return {
    id: row.id,
    agentId: row.agent_id,
    contractId: row.contract_id,
    releaseId: row.release_id,
    status: row.status,
    contractContentHash: row.contract_content_hash,
    evaluatorVersion: row.evaluator_version,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    summary: row.summary_json,
    createdAt: row.created_at,
  };
}

const HEADER_SELECT = `
  id, agent_id, contract_id, release_id, status, contract_content_hash, evaluator_version,
  window_start, window_end, started_at, completed_at, summary_json, created_at`;

/**
 * The evaluation a gate decision is read from.
 *
 * The newest **completed** release-scoped evaluation of the release, so a re-evaluation that is
 * still running never replaces a decision that already exists, and a queued one never becomes the
 * answer. Ordering is by `id`, which is UUIDv7 and therefore sortable by creation time to one
 * microsecond, so two evaluations created in the same millisecond still have a total order.
 */
export async function findLatestReleaseEvaluation(
  sql: Db,
  releaseId: string,
  options: { readonly contractId?: string | undefined } = {},
): Promise<ReleaseEvaluationHeader | null> {
  const rows = await sql<HeaderRow[]>`
    select ${sql.unsafe(HEADER_SELECT)} from evaluations
    where release_id = ${releaseId}
      and status in ('pass', 'fail', 'error', 'insufficient_data')
      and ${options.contractId === undefined ? sql`true` : sql`contract_id = ${options.contractId}`}
    order by id desc
    limit 1`;
  const row = rows[0];
  return row ? toHeader(row) : null;
}

/** Every evaluation of a release, newest first. Used by the gate route's history block. */
export async function listReleaseEvaluations(
  sql: Db,
  releaseId: string,
  limit: number,
): Promise<readonly ReleaseEvaluationHeader[]> {
  const rows = await sql<HeaderRow[]>`
    select ${sql.unsafe(HEADER_SELECT)} from evaluations
    where release_id = ${releaseId}
    order by id desc
    limit ${limit}`;
  return rows.map(toHeader);
}

interface RunRecordRow {
  readonly trace_id: string;
  readonly duration_ms: number | null;
  readonly result_json: unknown;
  readonly canonical_graph_json: unknown;
}

/**
 * The per-run evidence one release evaluation produced.
 *
 * Ordered by trace ID rather than by insertion, because the aggregation must not be able to observe
 * the order rows happened to be written in. `aggregateRelease` sorts again for the same reason; both
 * are cheap and the redundancy is the point.
 */
export async function listReleaseRunRecords(
  sql: Db,
  evaluationId: string,
): Promise<readonly ReleaseRunRecord[]> {
  const rows = await sql<RunRecordRow[]>`
    select tr.trace_id, tr.duration_ms, re.result_json, tg.canonical_graph_json
    from run_evaluations re
    join trace_runs tr on tr.id = re.trace_run_id
    left join lateral (
      select canonical_graph_json from trace_graphs
      where trace_run_id = re.trace_run_id
      order by id desc limit 1
    ) tg on true
    where re.evaluation_id = ${evaluationId}
    order by tr.trace_id asc`;

  return rows.map((row) => ({
    traceId: row.trace_id,
    durationMs: row.duration_ms,
    retryCount:
      row.canonical_graph_json === null || row.canonical_graph_json === undefined
        ? null
        : retryCountOf(readCanonicalGraph(row.canonical_graph_json)),
    evaluation: row.result_json as RunEvaluation,
  }));
}

interface BaselineStatisticsRow {
  readonly release_key: string | null;
  readonly occurrence_count: number;
  readonly statistics_json: unknown;
}

interface DistributionShape {
  readonly count?: number;
  readonly p95?: number;
}

function distributionP95(value: unknown): number | null {
  if (typeof value !== "object" || value === null) return null;
  const distribution = value as DistributionShape;
  return typeof distribution.p95 === "number" ? distribution.p95 : null;
}

/**
 * The approved baseline a regression is measured against (FR-011).
 *
 * Only `approved` route families count: a family a reviewer rejected or excluded as a fixture error
 * is not part of the sanctioned behaviour, so measuring drift against it would compare the release
 * to something nobody approved.
 *
 * Each family carries its own percentile, so the baseline figure is the **count-weighted mean** of
 * the family percentiles, truncated to an integer. Weighting by occurrence keeps a rare family from
 * dominating; the maximum would understate every regression and the unweighted mean would overstate
 * the influence of a family seen twice. Returns `null` when nothing was approved, which the
 * aggregation discloses rather than treating as a pass.
 */
export async function findReleaseBaselineReference(
  sql: Db,
  contractId: string,
): Promise<ReleaseBaselineReference | null> {
  const rows = await sql<BaselineStatisticsRow[]>`
    select r.release_key, rf.occurrence_count, rf.statistics_json
    from contracts c
    join baseline_versions bv on bv.id = c.baseline_version_id
    join route_families rf on rf.baseline_version_id = bv.id
    left join releases r on r.id = bv.release_id
    where c.id = ${contractId} and rf.status = 'approved'
    order by rf.fingerprint asc`;

  if (rows.length === 0) return null;

  let runs = 0;
  let latencyWeighted = 0;
  let latencyRuns = 0;
  let inputWeighted = 0;
  let inputRuns = 0;
  let outputWeighted = 0;
  let outputRuns = 0;
  let retryWeighted = 0;
  let retryRuns = 0;
  let releaseKey: string | null = null;

  for (const row of rows) {
    const weight = row.occurrence_count;
    runs += weight;
    releaseKey ??= row.release_key;
    const statistics = (row.statistics_json ?? {}) as Record<string, unknown>;

    const latency = distributionP95(statistics["duration"]);
    if (latency !== null) {
      latencyWeighted += latency * weight;
      latencyRuns += weight;
    }
    const input = distributionP95(statistics["inputTokens"]);
    if (input !== null) {
      inputWeighted += input * weight;
      inputRuns += weight;
    }
    const output = distributionP95(statistics["outputTokens"]);
    if (output !== null) {
      outputWeighted += output * weight;
      outputRuns += weight;
    }
    const retries = statistics["retries"];
    if (Array.isArray(retries)) {
      let familyRetries = 0;
      for (const entry of retries) {
        const record = entry as { readonly maxRetry?: unknown };
        if (typeof record.maxRetry === "number" && record.maxRetry > 0) {
          familyRetries += record.maxRetry;
        }
      }
      retryWeighted += familyRetries * weight;
      retryRuns += weight;
    }
  }

  const mean = (weighted: number, denominator: number): number | null =>
    denominator === 0 ? null : Math.floor(weighted / denominator);

  return {
    releaseKey,
    runCount: runs,
    latencyP95Ms: mean(latencyWeighted, latencyRuns),
    inputTokensP95: mean(inputWeighted, inputRuns),
    outputTokensP95: mean(outputWeighted, outputRuns),
    retriesPerRun: mean(retryWeighted, retryRuns),
  };
}

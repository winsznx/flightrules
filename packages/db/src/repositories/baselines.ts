import type {
  BaselineStatus,
  BaselineVersion,
  RouteFamily,
  RouteFamilyStatus,
} from "@flightrules/baseline-miner";
import type { CanonicalGraph } from "@flightrules/trace-graph";
import { canonicalObject } from "../canonical.js";
import { type Page, type PageRequest, toPage } from "../pagination.js";
import { readCanonicalGraph } from "../read-canonical.js";
import type { Db } from "../sql.js";

/**
 * Baseline versions and route families (PRD sections 14.7 and 14.8, FR-007).
 *
 * The miner is storage-independent by design (ADR-0007 decision 1), so this module is the only
 * place that knows how a `BaselineVersion` becomes rows. Nothing is recomputed on the way in: the
 * baseline identifier, the family identifiers, the selection hash and every statistic are the
 * miner's own values, written verbatim, because deriving them again here would create a second
 * implementation that could disagree with the first.
 *
 * A canonical graph is re-canonicalised on read (`readCanonicalGraph`) because `jsonb` reorders
 * object keys. Without that, a graph loaded from a row would serialise to different bytes from the
 * one that produced the fingerprint stored beside it.
 */

export interface StoredRouteFamily {
  readonly id: string;
  readonly baselineVersionId: string;
  readonly familyIdentifier: string;
  readonly fingerprint: string;
  readonly canonical: CanonicalGraph;
  readonly occurrenceCount: number;
  readonly occurrencePercent: {
    readonly numerator: number;
    readonly denominator: number;
    readonly decimal: string;
  };
  readonly rare: boolean;
  readonly status: RouteFamilyStatus;
  readonly representativeTraceIds: readonly string[];
  readonly statistics: unknown;
  readonly normaliserVersion: string;
  readonly normaliserConfigHash: string;
  readonly decidedAt: Date | null;
  readonly createdAt: Date;
}

export interface StoredBaseline {
  readonly id: string;
  readonly agentId: string;
  readonly releaseId: string | null;
  readonly environment: string | null;
  readonly status: BaselineStatus;
  readonly sourceTimeStart: Date;
  readonly sourceTimeEnd: Date;
  readonly minimumRuns: number;
  readonly baselineIdentifier: string;
  readonly selectionHash: string;
  readonly selection: unknown;
  readonly normaliserVersion: string;
  readonly normaliserConfigHash: string;
  readonly counts: unknown;
  readonly retrieval: unknown;
  readonly excluded: unknown;
  readonly disclosures: unknown;
  readonly jobId: string | null;
  readonly approvedAt: Date | null;
  readonly createdAt: Date;
  readonly families: readonly StoredRouteFamily[];
}

interface BaselineRow {
  readonly id: string;
  readonly agent_id: string;
  readonly release_id: string | null;
  readonly environment: string | null;
  readonly status: BaselineStatus;
  readonly source_time_start: Date;
  readonly source_time_end: Date;
  readonly minimum_runs: number;
  readonly rare_threshold_numerator: string;
  readonly rare_threshold_denominator: string;
  readonly baseline_identifier: string;
  readonly selection_hash: string;
  readonly selection_json: unknown;
  readonly normaliser_version: string;
  readonly normaliser_config_hash: string;
  readonly counts_json: unknown;
  readonly retrieval_json: unknown;
  readonly excluded_json: unknown;
  readonly disclosures_json: unknown;
  readonly job_id: string | null;
  readonly approved_at: Date | null;
  readonly created_at: Date;
}

interface RouteFamilyRow {
  readonly id: string;
  readonly baseline_version_id: string;
  readonly family_identifier: string;
  readonly fingerprint: string;
  readonly canonical_graph_json: unknown;
  readonly occurrence_count: number;
  readonly occurrence_numerator: string;
  readonly occurrence_denominator: string;
  readonly occurrence_percent: string;
  readonly rare: boolean;
  readonly status: RouteFamilyStatus;
  readonly representative_trace_ids_json: unknown;
  readonly statistics_json: unknown;
  readonly normaliser_version: string;
  readonly normaliser_config_hash: string;
  readonly decided_at: Date | null;
  readonly created_at: Date;
}

const BASELINE_COLUMNS = [
  "id",
  "agent_id",
  "release_id",
  "environment",
  "status",
  "source_time_start",
  "source_time_end",
  "minimum_runs",
  "rare_threshold_numerator",
  "rare_threshold_denominator",
  "baseline_identifier",
  "selection_hash",
  "selection_json",
  "normaliser_version",
  "normaliser_config_hash",
  "counts_json",
  "retrieval_json",
  "excluded_json",
  "disclosures_json",
  "job_id",
  "approved_at",
  "created_at",
] as const;

const FAMILY_COLUMNS = [
  "id",
  "baseline_version_id",
  "family_identifier",
  "fingerprint",
  "canonical_graph_json",
  "occurrence_count",
  "occurrence_numerator",
  "occurrence_denominator",
  "occurrence_percent",
  "rare",
  "status",
  "representative_trace_ids_json",
  "statistics_json",
  "normaliser_version",
  "normaliser_config_hash",
  "decided_at",
  "created_at",
] as const;

function toStoredFamily(row: RouteFamilyRow): StoredRouteFamily {
  return {
    id: row.id,
    baselineVersionId: row.baseline_version_id,
    familyIdentifier: row.family_identifier,
    fingerprint: row.fingerprint,
    canonical: readCanonicalGraph(row.canonical_graph_json),
    occurrenceCount: row.occurrence_count,
    occurrencePercent: {
      numerator: Number.parseInt(row.occurrence_numerator, 10),
      denominator: Number.parseInt(row.occurrence_denominator, 10),
      decimal: row.occurrence_percent,
    },
    rare: row.rare,
    status: row.status,
    representativeTraceIds: Array.isArray(row.representative_trace_ids_json)
      ? (row.representative_trace_ids_json as string[])
      : [],
    statistics: row.statistics_json,
    normaliserVersion: row.normaliser_version,
    normaliserConfigHash: row.normaliser_config_hash,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
  };
}

function toStoredBaseline(
  row: BaselineRow,
  families: readonly StoredRouteFamily[],
): StoredBaseline {
  return {
    id: row.id,
    agentId: row.agent_id,
    releaseId: row.release_id,
    environment: row.environment,
    status: row.status,
    sourceTimeStart: row.source_time_start,
    sourceTimeEnd: row.source_time_end,
    minimumRuns: row.minimum_runs,
    baselineIdentifier: row.baseline_identifier,
    selectionHash: row.selection_hash,
    selection: row.selection_json,
    normaliserVersion: row.normaliser_version,
    normaliserConfigHash: row.normaliser_config_hash,
    counts: row.counts_json,
    retrieval: row.retrieval_json,
    excluded: row.excluded_json,
    disclosures: row.disclosures_json,
    jobId: row.job_id,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    families,
  };
}

export interface PersistBaselineInput {
  readonly agentId: string;
  readonly releaseId: string | null;
  readonly jobId: string | null;
  readonly baseline: BaselineVersion;
  readonly selection: unknown;
}

/**
 * Writes a mined baseline and all of its families.
 *
 * Call inside a transaction: a baseline whose families were half written would report a route set
 * nobody mined, and every support ratio derived from it would be wrong. `on conflict do nothing`
 * on the selection makes a replayed mining job return the row it already produced rather than
 * failing, which is what makes the job safely retryable after a crash between commit and
 * acknowledgement.
 */
export async function persistBaseline(
  sql: Db,
  input: PersistBaselineInput,
): Promise<StoredBaseline> {
  const baseline = input.baseline;
  const inserted = await sql<BaselineRow[]>`
    insert into baseline_versions (
      agent_id, release_id, environment, status, source_time_start, source_time_end,
      minimum_runs, rare_threshold_numerator, rare_threshold_denominator, baseline_identifier,
      selection_hash, selection_json, normaliser_version, normaliser_config_hash,
      counts_json, retrieval_json, excluded_json, disclosures_json, job_id, approved_at
    ) values (
      ${input.agentId}, ${input.releaseId}, ${baseline.environment}, ${baseline.status},
      ${new Date(baseline.sourceTimeStartMs)}, ${new Date(baseline.sourceTimeEndMs)},
      ${baseline.minimumRuns},
      ${baseline.rareThreshold.numerator}, ${baseline.rareThreshold.denominator},
      ${baseline.id}, ${baseline.selectionHash},
      ${sql.json(canonicalObject(input.selection))}::jsonb,
      ${baseline.normaliserVersion}, ${baseline.normaliserConfigHash},
      ${sql.json(canonicalObject(baseline.counts))}::jsonb,
      ${sql.json(canonicalObject(baseline.retrieval))}::jsonb,
      ${sql.json(canonicalObject(baseline.excluded))}::jsonb,
      ${sql.json(canonicalObject(baseline.disclosures))}::jsonb,
      ${input.jobId},
      ${baseline.status === "approved" ? new Date() : null}
    )
    on conflict (agent_id, selection_hash) do nothing
    returning ${sql(BASELINE_COLUMNS)}`;

  const row = inserted[0] ?? (await selectBaselineRow(sql, input.agentId, baseline.selectionHash));
  if (!row) throw new Error("baseline_versions returned no row");

  if (inserted[0]) {
    for (const family of baseline.families) {
      await insertRouteFamily(sql, row.id, family);
    }
  }

  return toStoredBaseline(row, await selectFamilies(sql, row.id));
}

async function insertRouteFamily(
  sql: Db,
  baselineVersionId: string,
  family: RouteFamily,
): Promise<void> {
  await sql`
    insert into route_families (
      baseline_version_id, family_identifier, fingerprint, canonical_graph_json,
      occurrence_count, occurrence_numerator, occurrence_denominator, occurrence_percent,
      rare, status, representative_trace_ids_json, statistics_json,
      normaliser_version, normaliser_config_hash, decided_at
    ) values (
      ${baselineVersionId}, ${family.id}, ${family.fingerprint},
      ${sql.json(canonicalObject(family.canonical))}::jsonb,
      ${family.occurrenceCount},
      ${family.occurrencePercent.numerator}, ${family.occurrencePercent.denominator},
      ${family.occurrencePercent.decimal},
      ${family.rare}, ${family.status},
      ${sql.json(canonicalObject(family.representativeTraceIds))}::jsonb,
      ${sql.json(canonicalObject(family.statistics))}::jsonb,
      ${family.normaliserVersion}, ${family.normaliserConfigHash},
      ${family.status === "pending" ? null : new Date()}
    )`;
}

async function selectBaselineRow(
  sql: Db,
  agentId: string,
  selectionHash: string,
): Promise<BaselineRow | undefined> {
  const rows = await sql<BaselineRow[]>`
    select ${sql(BASELINE_COLUMNS)} from baseline_versions
    where agent_id = ${agentId} and selection_hash = ${selectionHash}`;
  return rows[0];
}

async function selectFamilies(
  sql: Db,
  baselineVersionId: string,
): Promise<readonly StoredRouteFamily[]> {
  const rows = await sql<RouteFamilyRow[]>`
    select ${sql(FAMILY_COLUMNS)} from route_families
    where baseline_version_id = ${baselineVersionId}
    order by fingerprint asc`;
  return rows.map(toStoredFamily);
}

export async function findBaseline(sql: Db, id: string): Promise<StoredBaseline | null> {
  const rows = await sql<BaselineRow[]>`
    select ${sql(BASELINE_COLUMNS)} from baseline_versions where id = ${id}`;
  const row = rows[0];
  if (!row) return null;
  return toStoredBaseline(row, await selectFamilies(sql, row.id));
}

export async function findBaselineBySelection(
  sql: Db,
  agentId: string,
  selectionHash: string,
): Promise<StoredBaseline | null> {
  const row = await selectBaselineRow(sql, agentId, selectionHash);
  if (!row) return null;
  return toStoredBaseline(row, await selectFamilies(sql, row.id));
}

export interface BaselineSummary {
  readonly id: string;
  readonly agentId: string;
  readonly status: BaselineStatus;
  readonly baselineIdentifier: string;
  readonly selectionHash: string;
  readonly sourceTimeStart: Date;
  readonly sourceTimeEnd: Date;
  readonly familyCount: number;
  readonly approvedAt: Date | null;
  readonly createdAt: Date;
}

export async function listBaselines(
  sql: Db,
  agentId: string,
  request: PageRequest,
): Promise<Page<BaselineSummary>> {
  const rows = await sql<
    {
      id: string;
      agent_id: string;
      status: BaselineStatus;
      baseline_identifier: string;
      selection_hash: string;
      source_time_start: Date;
      source_time_end: Date;
      family_count: string;
      approved_at: Date | null;
      created_at: Date;
    }[]
  >`
    select b.id, b.agent_id, b.status, b.baseline_identifier, b.selection_hash,
           b.source_time_start, b.source_time_end, b.approved_at, b.created_at,
           (select count(*)::text from route_families f where f.baseline_version_id = b.id)
             as family_count
    from baseline_versions b
    where b.agent_id = ${agentId}
      and ${request.after === null ? sql`true` : sql`b.id < ${request.after}`}
    order by b.id desc
    limit ${request.limit + 1}`;
  return toPage(
    rows.map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      status: row.status,
      baselineIdentifier: row.baseline_identifier,
      selectionHash: row.selection_hash,
      sourceTimeStart: row.source_time_start,
      sourceTimeEnd: row.source_time_end,
      familyCount: Number.parseInt(row.family_count, 10),
      approvedAt: row.approved_at,
      createdAt: row.created_at,
    })),
    request,
  );
}

/**
 * Records one route-family review decision (PRD section 8.8's four actions).
 *
 * Guarded on the current status so an out-of-order duplicate request cannot silently flip an
 * already-decided family: the caller is told the transition was refused instead. A family may be
 * re-decided from any decided state, which is the reviewer changing their mind; it may not be
 * returned to `pending`, because the review is what the proposal is founded on.
 */
export async function decideRouteFamily(
  sql: Db,
  familyId: string,
  status: Exclude<RouteFamilyStatus, "pending">,
): Promise<StoredRouteFamily | null> {
  const rows = await sql<RouteFamilyRow[]>`
    update route_families set status = ${status}, decided_at = now()
    where id = ${familyId}
    returning ${sql(FAMILY_COLUMNS)}`;
  const row = rows[0];
  return row ? toStoredFamily(row) : null;
}

/**
 * Moves a baseline to `approved` once at least one family is approved.
 *
 * Mirrors `applyRouteDecisions` in the miner, which is the authority on the rule; this is the
 * persistence of the same decision, guarded so a truncated or under-populated dataset can never
 * become an approved baseline (ADR-0007 decisions 11 and 12).
 */
export async function approveBaseline(sql: Db, baselineId: string): Promise<StoredBaseline | null> {
  const rows = await sql<BaselineRow[]>`
    update baseline_versions set status = 'approved', approved_at = now()
    where id = ${baselineId}
      and status = 'pending_review'
      and exists (
        select 1 from route_families f
        where f.baseline_version_id = baseline_versions.id and f.status = 'approved'
      )
    returning ${sql(BASELINE_COLUMNS)}`;
  const row = rows[0];
  if (!row) return null;
  return toStoredBaseline(row, await selectFamilies(sql, row.id));
}

export async function findRouteFamily(
  sql: Db,
  baselineId: string,
  familyId: string,
): Promise<StoredRouteFamily | null> {
  const rows = await sql<RouteFamilyRow[]>`
    select ${sql(FAMILY_COLUMNS)} from route_families
    where id = ${familyId} and baseline_version_id = ${baselineId}`;
  const row = rows[0];
  return row ? toStoredFamily(row) : null;
}

export async function findRouteFamilyByFingerprint(
  sql: Db,
  baselineId: string,
  fingerprint: string,
): Promise<StoredRouteFamily | null> {
  const rows = await sql<RouteFamilyRow[]>`
    select ${sql(FAMILY_COLUMNS)} from route_families
    where baseline_version_id = ${baselineId} and fingerprint = ${fingerprint}`;
  const row = rows[0];
  return row ? toStoredFamily(row) : null;
}

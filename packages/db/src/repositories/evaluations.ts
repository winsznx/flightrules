import type { EvaluatedRun, Violation } from "@flightrules/contract-engine";
import type { EvaluationStatus, Severity } from "@flightrules/domain";
import { canonicalObject } from "../canonical.js";
import { type Page, type PageRequest, toPage } from "../pagination.js";
import type { Db } from "../sql.js";

/**
 * Evaluations, per-run results and violations (PRD sections 14.11 to 14.13, FR-010 and FR-017).
 *
 * The evaluator is storage-independent by design (ADR-0006), so nothing here recomputes an outcome:
 * the status, the similarity, the evaluation hash and every violation are its values, written
 * verbatim. The similarity is stored as its exact numerator and denominator plus the truncated
 * decimal, and a check constraint ties the two together, so a percentage in the UI can never drift
 * from the ratio the evaluator computed.
 *
 * A violation carries the evaluator's stable identity, which is derived from the rule, the code and
 * the canonical evidence rather than from span IDs — so the same finding across two runs of one
 * route has one key, and `unique (run_evaluation_id, violation_key)` makes a replayed commit a
 * no-op instead of a duplicate row.
 */

/** The evaluation header's own states: two operational ones, then PRD FR-010's four outcomes. */
export const EVALUATION_LIFECYCLE = [
  "queued",
  "running",
  "pass",
  "fail",
  "error",
  "insufficient_data",
] as const;
export type EvaluationLifecycle = "queued" | "running" | EvaluationStatus;

interface EvaluationRow {
  readonly id: string;
  readonly agent_id: string;
  readonly contract_id: string;
  readonly release_id: string | null;
  readonly scope: "run" | "release";
  readonly status: EvaluationLifecycle;
  readonly evaluator_version: string;
  readonly normaliser_version: string;
  readonly normaliser_config_hash: string;
  readonly contract_content_hash: string;
  readonly idempotency_key: string;
  readonly window_start: Date | null;
  readonly window_end: Date | null;
  readonly started_at: Date | null;
  readonly completed_at: Date | null;
  readonly summary_json: unknown;
  readonly job_id: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface StoredEvaluation {
  readonly id: string;
  readonly agentId: string;
  readonly contractId: string;
  readonly releaseId: string | null;
  readonly scope: "run" | "release";
  readonly status: EvaluationLifecycle;
  readonly evaluatorVersion: string;
  readonly normaliserVersion: string;
  readonly normaliserConfigHash: string;
  readonly contractContentHash: string;
  readonly idempotencyKey: string;
  readonly windowStart: Date | null;
  readonly windowEnd: Date | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly summary: unknown;
  readonly jobId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const EVALUATION_COLUMNS = [
  "id",
  "agent_id",
  "contract_id",
  "release_id",
  "scope",
  "status",
  "evaluator_version",
  "normaliser_version",
  "normaliser_config_hash",
  "contract_content_hash",
  "idempotency_key",
  "window_start",
  "window_end",
  "started_at",
  "completed_at",
  "summary_json",
  "job_id",
  "created_at",
  "updated_at",
] as const;

function toStoredEvaluation(row: EvaluationRow): StoredEvaluation {
  return {
    id: row.id,
    agentId: row.agent_id,
    contractId: row.contract_id,
    releaseId: row.release_id,
    scope: row.scope,
    status: row.status,
    evaluatorVersion: row.evaluator_version,
    normaliserVersion: row.normaliser_version,
    normaliserConfigHash: row.normaliser_config_hash,
    contractContentHash: row.contract_content_hash,
    idempotencyKey: row.idempotency_key,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    summary: row.summary_json,
    jobId: row.job_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateEvaluationInput {
  readonly agentId: string;
  readonly contractId: string;
  readonly releaseId: string | null;
  readonly scope: "run" | "release";
  readonly evaluatorVersion: string;
  readonly normaliserVersion: string;
  readonly normaliserConfigHash: string;
  readonly contractContentHash: string;
  readonly idempotencyKey: string;
  readonly windowStart: Date | null;
  readonly windowEnd: Date | null;
  readonly jobId: string | null;
}

/** Idempotent on `(contract_id, scope, idempotency_key)`: a repeated request reuses the header. */
export async function createEvaluation(
  sql: Db,
  input: CreateEvaluationInput,
): Promise<{ evaluation: StoredEvaluation; created: boolean }> {
  const inserted = await sql<EvaluationRow[]>`
    insert into evaluations (
      agent_id, contract_id, release_id, scope, status, evaluator_version, normaliser_version,
      normaliser_config_hash, contract_content_hash, idempotency_key, window_start, window_end,
      job_id
    ) values (
      ${input.agentId}, ${input.contractId}, ${input.releaseId}, ${input.scope}, 'queued',
      ${input.evaluatorVersion}, ${input.normaliserVersion}, ${input.normaliserConfigHash},
      ${input.contractContentHash}, ${input.idempotencyKey}, ${input.windowStart},
      ${input.windowEnd}, ${input.jobId}
    )
    on conflict (contract_id, scope, idempotency_key) do nothing
    returning ${sql(EVALUATION_COLUMNS)}`;
  const row = inserted[0];
  if (row) return { evaluation: toStoredEvaluation(row), created: true };

  const existing = await sql<EvaluationRow[]>`
    select ${sql(EVALUATION_COLUMNS)} from evaluations
    where contract_id = ${input.contractId}
      and scope = ${input.scope}
      and idempotency_key = ${input.idempotencyKey}`;
  const found = existing[0];
  if (!found) throw new Error("evaluations conflict resolved to no row");
  return { evaluation: toStoredEvaluation(found), created: false };
}

export async function startEvaluation(
  sql: Db,
  evaluationId: string,
): Promise<StoredEvaluation | null> {
  const rows = await sql<EvaluationRow[]>`
    update evaluations set status = 'running', started_at = coalesce(started_at, now())
    where id = ${evaluationId} and status in ('queued', 'running')
    returning ${sql(EVALUATION_COLUMNS)}`;
  const row = rows[0];
  return row ? toStoredEvaluation(row) : null;
}

export interface RunEvaluationInput {
  readonly traceRunId: string;
  readonly nearestRouteFamilyId: string | null;
  readonly evaluated: EvaluatedRun;
  readonly signozWebUrl: string | null;
}

export interface StoredRunEvaluation {
  readonly id: string;
  readonly evaluationId: string;
  readonly traceRunId: string;
  readonly status: EvaluationStatus;
  readonly nearestRouteFamilyId: string | null;
  readonly similarity: {
    readonly numerator: number;
    readonly denominator: number;
    readonly decimal: string;
  };
  readonly routeFingerprint: string;
  readonly routeApproved: boolean;
  readonly evaluationHash: string;
  readonly result: unknown;
  readonly createdAt: Date;
}

interface RunEvaluationRow {
  readonly id: string;
  readonly evaluation_id: string;
  readonly trace_run_id: string;
  readonly status: EvaluationStatus;
  readonly nearest_route_family_id: string | null;
  readonly similarity_numerator: string;
  readonly similarity_denominator: string;
  readonly similarity_score: string;
  readonly route_fingerprint: string;
  readonly route_approved: boolean;
  readonly evaluation_hash: string;
  readonly result_json: unknown;
  readonly created_at: Date;
}

const RUN_EVALUATION_COLUMNS = [
  "id",
  "evaluation_id",
  "trace_run_id",
  "status",
  "nearest_route_family_id",
  "similarity_numerator",
  "similarity_denominator",
  "similarity_score",
  "route_fingerprint",
  "route_approved",
  "evaluation_hash",
  "result_json",
  "created_at",
] as const;

function toStoredRunEvaluation(row: RunEvaluationRow): StoredRunEvaluation {
  return {
    id: row.id,
    evaluationId: row.evaluation_id,
    traceRunId: row.trace_run_id,
    status: row.status,
    nearestRouteFamilyId: row.nearest_route_family_id,
    similarity: {
      numerator: Number.parseInt(row.similarity_numerator, 10),
      denominator: Number.parseInt(row.similarity_denominator, 10),
      decimal: row.similarity_score,
    },
    routeFingerprint: row.route_fingerprint,
    routeApproved: row.route_approved,
    evaluationHash: row.evaluation_hash,
    result: row.result_json,
    createdAt: row.created_at,
  };
}

/**
 * Persists one run result and every violation it produced.
 *
 * Call inside the transaction that completes the evaluation. A run result stored without its
 * violations would report a failing run with nothing to show for it, which is exactly the shape of
 * a false pass once a gate reads the counts.
 */
export async function persistRunEvaluation(
  sql: Db,
  evaluationId: string,
  input: RunEvaluationInput,
): Promise<StoredRunEvaluation> {
  const evaluation = input.evaluated.evaluation;
  const rows = await sql<RunEvaluationRow[]>`
    insert into run_evaluations (
      evaluation_id, trace_run_id, status, nearest_route_family_id,
      similarity_numerator, similarity_denominator, similarity_score,
      route_fingerprint, route_approved, evaluation_hash, result_json
    ) values (
      ${evaluationId}, ${input.traceRunId}, ${evaluation.status}, ${input.nearestRouteFamilyId},
      ${evaluation.similarity.numerator}, ${evaluation.similarity.denominator},
      ${evaluation.similarity.decimal}, ${evaluation.routeFingerprint},
      ${evaluation.routeApproved}, ${input.evaluated.evaluationHash},
      ${sql.json(canonicalObject(evaluation))}::jsonb
    )
    on conflict (evaluation_id, trace_run_id) do update set
      status = excluded.status,
      nearest_route_family_id = excluded.nearest_route_family_id,
      similarity_numerator = excluded.similarity_numerator,
      similarity_denominator = excluded.similarity_denominator,
      similarity_score = excluded.similarity_score,
      route_fingerprint = excluded.route_fingerprint,
      route_approved = excluded.route_approved,
      evaluation_hash = excluded.evaluation_hash,
      result_json = excluded.result_json
    returning ${sql(RUN_EVALUATION_COLUMNS)}`;
  const row = rows[0];
  if (!row) throw new Error("run_evaluations returned no row");

  for (const violation of evaluation.violations) {
    await insertViolation(sql, row.id, violation, input.signozWebUrl);
  }
  return toStoredRunEvaluation(row);
}

async function insertViolation(
  sql: Db,
  runEvaluationId: string,
  violation: Violation,
  signozWebUrl: string | null,
): Promise<void> {
  await sql`
    insert into violations (
      run_evaluation_id, violation_key, rule_key, rule_type, violation_type, severity,
      zero_tolerance, message, expected, observed, evidence_json, signoz_web_url
    ) values (
      ${runEvaluationId}, ${violation.id}, ${violation.ruleId}, ${violation.ruleType},
      ${violation.code}, ${violation.severity}, ${violation.zeroTolerance}, ${violation.summary},
      ${violation.expected}, ${violation.observed},
      ${sql.json(canonicalObject(violation.evidence))}::jsonb, ${signozWebUrl}
    )
    on conflict (run_evaluation_id, violation_key) do nothing`;
}

export async function completeEvaluation(
  sql: Db,
  evaluationId: string,
  status: EvaluationStatus,
  summary: unknown,
): Promise<StoredEvaluation | null> {
  const rows = await sql<EvaluationRow[]>`
    update evaluations set
      status = ${status},
      summary_json = ${sql.json(canonicalObject(summary))}::jsonb,
      completed_at = now()
    where id = ${evaluationId} and status in ('queued', 'running')
    returning ${sql(EVALUATION_COLUMNS)}`;
  const row = rows[0];
  return row ? toStoredEvaluation(row) : null;
}

export async function findEvaluation(sql: Db, id: string): Promise<StoredEvaluation | null> {
  const rows = await sql<EvaluationRow[]>`
    select ${sql(EVALUATION_COLUMNS)} from evaluations where id = ${id}`;
  const row = rows[0];
  return row ? toStoredEvaluation(row) : null;
}

export async function listRunEvaluations(
  sql: Db,
  evaluationId: string,
): Promise<readonly StoredRunEvaluation[]> {
  const rows = await sql<RunEvaluationRow[]>`
    select ${sql(RUN_EVALUATION_COLUMNS)} from run_evaluations
    where evaluation_id = ${evaluationId} order by id asc`;
  return rows.map(toStoredRunEvaluation);
}

export async function listEvaluations(
  sql: Db,
  filter: { readonly agentId?: string | undefined; readonly releaseId?: string | undefined },
  request: PageRequest,
): Promise<Page<StoredEvaluation>> {
  const rows = await sql<EvaluationRow[]>`
    select ${sql(EVALUATION_COLUMNS)} from evaluations
    where ${filter.agentId === undefined ? sql`true` : sql`agent_id = ${filter.agentId}`}
      and ${filter.releaseId === undefined ? sql`true` : sql`release_id = ${filter.releaseId}`}
      and ${request.after === null ? sql`true` : sql`id < ${request.after}`}
    order by id desc
    limit ${request.limit + 1}`;
  return toPage(rows.map(toStoredEvaluation), request);
}

// ---------------------------------------------------------------------------
// 14.13 violations
// ---------------------------------------------------------------------------

export interface StoredViolation {
  readonly id: string;
  readonly runEvaluationId: string;
  readonly violationKey: string;
  readonly ruleKey: string;
  readonly ruleType: string;
  readonly violationType: string;
  readonly severity: Severity;
  readonly zeroTolerance: boolean;
  readonly message: string;
  readonly expected: string;
  readonly observed: string;
  readonly evidence: unknown;
  readonly signozWebUrl: string | null;
  readonly createdAt: Date;
}

/** FR-017's evidence bundle: everything a violation must retain, resolved by one join. */
export interface ViolationEvidence extends StoredViolation {
  readonly evaluationId: string;
  readonly contractId: string;
  readonly contractVersion: string;
  readonly contractContentHash: string;
  readonly evaluatorVersion: string;
  readonly releaseId: string | null;
  readonly releaseKey: string | null;
  readonly agentId: string;
  readonly projectId: string;
  readonly traceId: string;
  readonly traceRunId: string;
  readonly evaluatedAt: Date | null;
}

interface ViolationRow {
  readonly id: string;
  readonly run_evaluation_id: string;
  readonly violation_key: string;
  readonly rule_key: string;
  readonly rule_type: string;
  readonly violation_type: string;
  readonly severity: Severity;
  readonly zero_tolerance: boolean;
  readonly message: string;
  readonly expected: string;
  readonly observed: string;
  readonly evidence_json: unknown;
  readonly signoz_web_url: string | null;
  readonly created_at: Date;
}

interface ViolationEvidenceRow extends ViolationRow {
  readonly evaluation_id: string;
  readonly contract_id: string;
  readonly contract_version: string;
  readonly contract_content_hash: string;
  readonly evaluator_version: string;
  readonly release_id: string | null;
  readonly release_key: string | null;
  readonly agent_id: string;
  readonly project_id: string;
  readonly trace_id: string;
  readonly trace_run_id: string;
  readonly evaluated_at: Date | null;
}

function toViolationEvidence(row: ViolationEvidenceRow): ViolationEvidence {
  return {
    id: row.id,
    runEvaluationId: row.run_evaluation_id,
    violationKey: row.violation_key,
    ruleKey: row.rule_key,
    ruleType: row.rule_type,
    violationType: row.violation_type,
    severity: row.severity,
    zeroTolerance: row.zero_tolerance,
    message: row.message,
    expected: row.expected,
    observed: row.observed,
    evidence: row.evidence_json,
    signozWebUrl: row.signoz_web_url,
    createdAt: row.created_at,
    evaluationId: row.evaluation_id,
    contractId: row.contract_id,
    contractVersion: row.contract_version,
    contractContentHash: row.contract_content_hash,
    evaluatorVersion: row.evaluator_version,
    releaseId: row.release_id,
    releaseKey: row.release_key,
    agentId: row.agent_id,
    projectId: row.project_id,
    traceId: row.trace_id,
    traceRunId: row.trace_run_id,
    evaluatedAt: row.evaluated_at,
  };
}

const VIOLATION_JOIN = (sql: Db) => sql`
  from violations v
  join run_evaluations re on re.id = v.run_evaluation_id
  join evaluations e on e.id = re.evaluation_id
  join contracts c on c.id = e.contract_id
  join agents a on a.id = e.agent_id
  join trace_runs tr on tr.id = re.trace_run_id
  left join releases r on r.id = e.release_id`;

const VIOLATION_SELECT = (sql: Db) => sql`
  select v.id, v.run_evaluation_id, v.violation_key, v.rule_key, v.rule_type, v.violation_type,
         v.severity, v.zero_tolerance, v.message, v.expected, v.observed, v.evidence_json,
         v.signoz_web_url, v.created_at,
         e.id as evaluation_id, e.evaluator_version, e.completed_at as evaluated_at,
         c.id as contract_id, c.semantic_version as contract_version,
         c.content_hash as contract_content_hash,
         e.release_id, r.release_key, a.id as agent_id, a.project_id,
         tr.trace_id, tr.id as trace_run_id`;

export async function findViolation(sql: Db, id: string): Promise<ViolationEvidence | null> {
  const rows = await sql<ViolationEvidenceRow[]>`
    ${VIOLATION_SELECT(sql)} ${VIOLATION_JOIN(sql)} where v.id = ${id}`;
  const row = rows[0];
  return row ? toViolationEvidence(row) : null;
}

export async function listProjectViolations(
  sql: Db,
  projectId: string,
  filter: { readonly severity?: Severity | undefined; readonly releaseId?: string | undefined },
  request: PageRequest,
): Promise<Page<ViolationEvidence>> {
  const rows = await sql<ViolationEvidenceRow[]>`
    ${VIOLATION_SELECT(sql)} ${VIOLATION_JOIN(sql)}
    where a.project_id = ${projectId}
      and ${filter.severity === undefined ? sql`true` : sql`v.severity = ${filter.severity}`}
      and ${filter.releaseId === undefined ? sql`true` : sql`e.release_id = ${filter.releaseId}`}
      and ${request.after === null ? sql`true` : sql`v.id < ${request.after}`}
    order by v.id desc
    limit ${request.limit + 1}`;
  return toPage(rows.map(toViolationEvidence), request);
}

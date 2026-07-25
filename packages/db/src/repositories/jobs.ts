import { type ErrorCode, FlightRulesError } from "@flightrules/domain";
import { canonicalHash, canonicalObject } from "../canonical.js";
import { type Page, type PageRequest, toPage } from "../pagination.js";
import type { Db } from "../sql.js";

/**
 * The job system (PRD section 14.15, PRD section 18.2 "idempotency keys on long-running jobs",
 * PRD section 20.1 "jobs are idempotent" and "worker restarts resume or safely fail jobs").
 *
 * Three properties are enforced by the database rather than by application care:
 *
 * 1. **Identity.** `unique (job_type, idempotency_key)`. Two concurrent submissions of the same
 *    work cannot both insert; the loser reads the winner's row. For a baseline that key is the
 *    miner's `selectionHash`, so the same mining selection can never produce two jobs.
 * 2. **Exclusivity.** A claim is one `update ... where id = (select ... for update skip locked)`.
 *    Two workers polling simultaneously take different rows or one takes none; neither waits.
 * 3. **Monotonic progress.** A progress write carries the stage index and updates only when it is
 *    greater than the stored one, so a replayed or out-of-order event is a no-op rather than a
 *    regression.
 *
 * The result is committed in the same transaction as the transition to `succeeded`, so a worker
 * that dies after producing output but before marking success leaves nothing behind at all.
 */

export const JOB_TYPES = [
  "baseline_mining",
  "contract_proposal",
  "evaluation",
  "demo_run",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_ENTITY_TYPES = [
  "agent",
  "baseline_version",
  "contract",
  "release",
  "project",
] as const;
export type JobEntityType = (typeof JOB_ENTITY_TYPES)[number];

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ["succeeded", "failed", "cancelled"];

/** Bounded so a pathological handler cannot grow one row without limit (PRD section 18.2). */
export const MAX_PROGRESS_EVENTS = 200;

export interface JobProgressEvent {
  readonly index: number;
  readonly stage: string;
  readonly detail: string;
  readonly at: string;
}

export interface JobFailure {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly attempt: number;
}

export interface JobRow {
  readonly id: string;
  readonly job_type: JobType;
  readonly entity_type: JobEntityType;
  readonly entity_id: string | null;
  readonly project_id: string | null;
  readonly status: JobStatus;
  readonly attempt: number;
  readonly max_attempts: number;
  readonly idempotency_key: string;
  readonly input_hash: string;
  readonly input_json: unknown;
  readonly result_json: unknown;
  readonly error_json: unknown;
  readonly progress_index: number;
  readonly progress_stage: string | null;
  readonly progress_json: unknown;
  readonly lease_owner: string | null;
  readonly lease_expires_at: Date | null;
  readonly heartbeat_at: Date | null;
  readonly available_at: Date;
  readonly cancel_requested: boolean;
  readonly started_at: Date | null;
  readonly completed_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface Job {
  readonly id: string;
  readonly jobType: JobType;
  readonly entityType: JobEntityType;
  readonly entityId: string | null;
  readonly projectId: string | null;
  readonly status: JobStatus;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly idempotencyKey: string;
  readonly inputHash: string;
  readonly input: unknown;
  readonly result: unknown;
  readonly failure: JobFailure | null;
  readonly progressIndex: number;
  readonly progressStage: string | null;
  readonly progressEvents: readonly JobProgressEvent[];
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly heartbeatAt: Date | null;
  readonly availableAt: Date;
  readonly cancelRequested: boolean;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const JOB_COLUMNS = [
  "id",
  "job_type",
  "entity_type",
  "entity_id",
  "project_id",
  "status",
  "attempt",
  "max_attempts",
  "idempotency_key",
  "input_hash",
  "input_json",
  "result_json",
  "error_json",
  "progress_index",
  "progress_stage",
  "progress_json",
  "lease_owner",
  "lease_expires_at",
  "heartbeat_at",
  "available_at",
  "cancel_requested",
  "started_at",
  "completed_at",
  "created_at",
  "updated_at",
] as const;

function toProgressEvents(value: unknown): readonly JobProgressEvent[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is JobProgressEvent => {
    if (typeof entry !== "object" || entry === null) return false;
    const candidate = entry as Partial<JobProgressEvent>;
    return (
      typeof candidate.index === "number" &&
      typeof candidate.stage === "string" &&
      typeof candidate.detail === "string" &&
      typeof candidate.at === "string"
    );
  });
}

function toFailure(value: unknown): JobFailure | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<JobFailure>;
  if (typeof candidate.code !== "string" || typeof candidate.message !== "string") return null;
  return {
    code: candidate.code as ErrorCode,
    message: candidate.message,
    retryable: candidate.retryable === true,
    attempt: typeof candidate.attempt === "number" ? candidate.attempt : 0,
  };
}

export function toJob(row: JobRow): Job {
  return {
    id: row.id,
    jobType: row.job_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    projectId: row.project_id,
    status: row.status,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    idempotencyKey: row.idempotency_key,
    inputHash: row.input_hash,
    input: row.input_json,
    result: row.result_json,
    failure: toFailure(row.error_json),
    progressIndex: row.progress_index,
    progressStage: row.progress_stage,
    progressEvents: toProgressEvents(row.progress_json),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at,
    availableAt: row.available_at,
    cancelRequested: row.cancel_requested,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface SubmitJobInput {
  readonly jobType: JobType;
  readonly entityType: JobEntityType;
  readonly entityId: string | null;
  readonly projectId: string | null;
  readonly idempotencyKey: string;
  readonly input: unknown;
  readonly maxAttempts?: number | undefined;
}

export interface SubmitJobResult {
  readonly job: Job;
  /** False when an equivalent job already existed, which is the idempotent path. */
  readonly created: boolean;
}

/**
 * Submits a job, or returns the equivalent one that already exists.
 *
 * `on conflict do nothing` followed by a read, rather than `do update`: an update would touch the
 * row of a job another worker is running. The read is inside the same statement sequence, so a
 * concurrent duplicate submission still resolves to exactly one row.
 *
 * A repeat under the same key whose canonical input differs is a conflict rather than a silent
 * reuse — the caller asked for something else and would otherwise be handed the wrong result.
 */
export async function submitJob(sql: Db, input: SubmitJobInput): Promise<SubmitJobResult> {
  const canonicalInput = canonicalObject(input.input);
  const inputHash = canonicalHash(canonicalInput);

  const inserted = await sql<JobRow[]>`
    insert into jobs (
      job_type, entity_type, entity_id, project_id, idempotency_key,
      input_hash, input_json, max_attempts
    ) values (
      ${input.jobType}, ${input.entityType}, ${input.entityId}, ${input.projectId},
      ${input.idempotencyKey}, ${inputHash}, ${sql.json(canonicalInput)}::jsonb, ${input.maxAttempts ?? 3}
    )
    on conflict (job_type, idempotency_key) do nothing
    returning ${sql(JOB_COLUMNS)}`;

  const first = inserted[0];
  if (first) return { job: toJob(first), created: true };

  const existing = await sql<JobRow[]>`
    select ${sql(JOB_COLUMNS)} from jobs
    where job_type = ${input.jobType} and idempotency_key = ${input.idempotencyKey}`;
  const row = existing[0];
  if (!row) throw new Error("jobs conflict resolved to no row");
  if (row.input_hash !== inputHash) {
    throw new FlightRulesError("JOB_ALREADY_RUNNING", {
      message:
        "A job with this idempotency key already exists and was submitted with different input.",
      details: { jobId: row.id, jobType: row.job_type, status: row.status },
    });
  }
  return { job: toJob(row), created: false };
}

export interface ClaimJobInput {
  readonly jobTypes: readonly JobType[];
  readonly owner: string;
  readonly leaseSeconds: number;
}

/**
 * Claims the oldest available job of one of the given types.
 *
 * `for update skip locked` is PostgreSQL's documented queue primitive: the row selected by the
 * sub-select is locked for the duration of the statement, and any concurrent claimer skips it
 * rather than blocking. Verified against the running PostgreSQL 16 by a two-connection test.
 */
export async function claimJob(sql: Db, input: ClaimJobInput): Promise<Job | null> {
  if (input.jobTypes.length === 0) return null;
  const rows = await sql<JobRow[]>`
    update jobs set
      status = 'running',
      attempt = attempt + 1,
      lease_owner = ${input.owner},
      lease_expires_at = now() + make_interval(secs => ${input.leaseSeconds}),
      heartbeat_at = now(),
      started_at = coalesce(started_at, now())
    where id = (
      select id from jobs
      where status = 'queued'
        and cancel_requested = false
        and available_at <= now()
        and attempt < max_attempts
        and job_type in ${sql(input.jobTypes)}
      order by available_at asc, created_at asc
      for update skip locked
      limit 1
    )
    returning ${sql(JOB_COLUMNS)}`;
  const row = rows[0];
  return row ? toJob(row) : null;
}

/** Extends the lease of a job this worker still holds. False means the lease was lost. */
export async function renewLease(
  sql: Db,
  jobId: string,
  owner: string,
  leaseSeconds: number,
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    update jobs set
      lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
      heartbeat_at = now()
    where id = ${jobId} and lease_owner = ${owner} and status = 'running'
    returning id`;
  return rows.length === 1;
}

export interface RecordProgressInput {
  readonly jobId: string;
  readonly owner: string;
  readonly index: number;
  readonly stage: string;
  readonly detail: string;
  readonly at: Date;
}

/**
 * Appends one progress event.
 *
 * Guarded by `progress_index < :index`, so a duplicate delivery and an out-of-order event are both
 * no-ops. Returns false in that case rather than throwing: a replayed event is not an error, and a
 * handler that failed on one would turn an at-least-once delivery into a job failure.
 */
export async function recordProgress(sql: Db, input: RecordProgressInput): Promise<boolean> {
  if (!Number.isSafeInteger(input.index) || input.index < 1) {
    throw new RangeError("a progress index must be a positive integer");
  }
  const event: JobProgressEvent = {
    index: input.index,
    stage: input.stage,
    detail: input.detail,
    at: input.at.toISOString(),
  };
  const rows = await sql<{ id: string }[]>`
    update jobs set
      progress_index = ${input.index},
      progress_stage = ${input.stage},
      progress_json = case
        when jsonb_array_length(progress_json) >= ${MAX_PROGRESS_EVENTS} then progress_json
        else progress_json || ${sql.json([canonicalObject(event)])}::jsonb
      end
    where id = ${input.jobId}
      and lease_owner = ${input.owner}
      and status = 'running'
      and progress_index < ${input.index}
    returning id`;
  return rows.length === 1;
}

/**
 * Marks a job succeeded.
 *
 * Call inside the transaction that wrote the job's output. The `lease_owner` predicate means a
 * worker whose lease was reclaimed cannot complete a job another worker now owns.
 */
export async function completeJob(
  sql: Db,
  jobId: string,
  owner: string,
  result: unknown,
): Promise<Job | null> {
  const rows = await sql<JobRow[]>`
    update jobs set
      status = 'succeeded',
      result_json = ${sql.json(canonicalObject(result))}::jsonb,
      error_json = null,
      completed_at = now(),
      lease_owner = null,
      lease_expires_at = null
    where id = ${jobId} and lease_owner = ${owner} and status = 'running'
    returning ${sql(JOB_COLUMNS)}`;
  const row = rows[0];
  return row ? toJob(row) : null;
}

export interface FailJobInput {
  readonly jobId: string;
  readonly owner: string;
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryDelaySeconds?: number | undefined;
}

/**
 * Records a failure.
 *
 * A retryable failure below the attempt ceiling returns the job to `queued` with a delay; anything
 * else is terminal. The attempt ceiling is checked in SQL against the row's own `attempt`, so two
 * concurrent recoveries cannot both decide there is one attempt left.
 */
export async function failJob(sql: Db, input: FailJobInput): Promise<Job | null> {
  const failure = {
    code: input.code,
    message: input.message,
    retryable: input.retryable,
  };
  const rows = await sql<JobRow[]>`
    update jobs set
      status = case
        when ${input.retryable} and attempt < max_attempts then 'queued'
        else 'failed'
      end,
      error_json = ${sql.json(canonicalObject(failure))}::jsonb || jsonb_build_object('attempt', attempt),
      available_at = case
        when ${input.retryable} and attempt < max_attempts
          then now() + make_interval(secs => ${input.retryDelaySeconds ?? 5})
        else available_at
      end,
      completed_at = case
        when ${input.retryable} and attempt < max_attempts then null
        else now()
      end,
      lease_owner = null,
      lease_expires_at = null
    where id = ${input.jobId} and lease_owner = ${input.owner} and status = 'running'
    returning ${sql(JOB_COLUMNS)}`;
  const row = rows[0];
  return row ? toJob(row) : null;
}

/** Requests cancellation. A queued job is cancelled immediately; a running one at its next stage. */
export async function requestCancellation(sql: Db, jobId: string): Promise<Job | null> {
  const rows = await sql<JobRow[]>`
    update jobs set
      cancel_requested = true,
      status = case when status = 'queued' then 'cancelled' else status end,
      completed_at = case when status = 'queued' then now() else completed_at end
    where id = ${jobId} and status in ('queued', 'running')
    returning ${sql(JOB_COLUMNS)}`;
  const row = rows[0];
  return row ? toJob(row) : null;
}

/** Transitions a running job this worker owns to `cancelled`, after a cancellation request. */
export async function cancelClaimedJob(sql: Db, jobId: string, owner: string): Promise<Job | null> {
  const rows = await sql<JobRow[]>`
    update jobs set
      status = 'cancelled',
      completed_at = now(),
      lease_owner = null,
      lease_expires_at = null
    where id = ${jobId} and lease_owner = ${owner} and status = 'running'
    returning ${sql(JOB_COLUMNS)}`;
  const row = rows[0];
  return row ? toJob(row) : null;
}

export interface ReclaimResult {
  readonly requeued: readonly string[];
  readonly abandoned: readonly string[];
}

/**
 * Recovers jobs whose worker died.
 *
 * A job whose lease expired is returned to the queue while attempts remain, and failed terminally
 * otherwise. Without this a `kill -9` would leave a job in `running` for ever, which PRD section
 * 20.1 forbids ("worker restarts resume or safely fail jobs").
 */
export async function reclaimExpiredLeases(sql: Db): Promise<ReclaimResult> {
  const abandoned = await sql<{ id: string }[]>`
    update jobs set
      status = 'failed',
      error_json = jsonb_build_object(
        'code', 'EVALUATION_FAILED',
        'message', 'The worker holding this job stopped responding and no attempts remain.',
        'retryable', false,
        'attempt', attempt
      ),
      completed_at = now(),
      lease_owner = null,
      lease_expires_at = null
    where status = 'running' and lease_expires_at < now() and attempt >= max_attempts
    returning id`;

  const requeued = await sql<{ id: string }[]>`
    update jobs set
      status = 'queued',
      error_json = jsonb_build_object(
        'code', 'EVALUATION_FAILED',
        'message', 'The worker holding this job stopped responding; it was returned to the queue.',
        'retryable', true,
        'attempt', attempt
      ),
      available_at = now(),
      lease_owner = null,
      lease_expires_at = null
    where status = 'running' and lease_expires_at < now()
    returning id`;

  return {
    requeued: requeued.map((row) => row.id),
    abandoned: abandoned.map((row) => row.id),
  };
}

export async function findJob(sql: Db, id: string): Promise<Job | null> {
  const rows = await sql<JobRow[]>`select ${sql(JOB_COLUMNS)} from jobs where id = ${id}`;
  const row = rows[0];
  return row ? toJob(row) : null;
}

export async function findJobByKey(
  sql: Db,
  jobType: JobType,
  idempotencyKey: string,
): Promise<Job | null> {
  const rows = await sql<JobRow[]>`
    select ${sql(JOB_COLUMNS)} from jobs
    where job_type = ${jobType} and idempotency_key = ${idempotencyKey}`;
  const row = rows[0];
  return row ? toJob(row) : null;
}

export async function listJobs(
  sql: Db,
  filter: {
    readonly projectId?: string;
    readonly entityId?: string;
    readonly status?: JobStatus;
  },
  request: PageRequest,
): Promise<Page<Job>> {
  const rows = await sql<JobRow[]>`
    select ${sql(JOB_COLUMNS)} from jobs
    where ${filter.projectId === undefined ? sql`true` : sql`project_id = ${filter.projectId}`}
      and ${filter.entityId === undefined ? sql`true` : sql`entity_id = ${filter.entityId}`}
      and ${filter.status === undefined ? sql`true` : sql`status = ${filter.status}`}
      and ${request.after === null ? sql`true` : sql`id < ${request.after}`}
    order by id desc
    limit ${request.limit + 1}`;
  return toPage(rows.map(toJob), request);
}

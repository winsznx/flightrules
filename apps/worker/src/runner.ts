import { MINING_STAGES } from "@flightrules/baseline-miner";
import {
  cancelClaimedJob,
  claimJob,
  completeJob,
  type Db,
  failJob,
  isTransientFailure,
  type Job,
  type JobType,
  reclaimExpiredLeases,
  recordProgress,
  renewLease,
  type Sql,
} from "@flightrules/db";
import { type ErrorCode, FlightRulesError } from "@flightrules/domain";
import type { WorkerConfig } from "./config.js";

/**
 * The job runner (PRD sections 12.3 and 20.1).
 *
 * One loop: claim, run, commit. The properties that make it safe are all in the shape rather than
 * in care taken by each handler.
 *
 * - A handler never writes the job's outcome. It returns a *commit* function, which the runner
 *   executes inside the same transaction that marks the job succeeded. A crash between producing
 *   output and recording success therefore leaves nothing at all, rather than a result nobody will
 *   ever look at again.
 * - A handler never touches the lease. The runner renews it on a timer while the handler runs, and
 *   a handler that outlives its lease loses the job to recovery — which is the correct outcome,
 *   because a worker that cannot heartbeat cannot be trusted to still be working.
 * - A failure is classified once, here, into retryable and terminal. A transient database failure
 *   or an unreachable SigNoz is retryable; a malformed input or a refused contract is not, because
 *   retrying it would produce the same refusal three times and delay the honest answer.
 */

/**
 * The progress vocabulary.
 *
 * PRD section 8.7's five states are imported from the miner, which is where they are defined, and
 * the two states a job has that mining does not are added here. Copying the five by hand would let
 * the two lists drift, and a UI keyed on stage names would silently stop matching.
 */
export const WORKER_STAGES = [...MINING_STAGES, "evaluating_runs", "running_demo"] as const;
export type WorkerStage = (typeof WORKER_STAGES)[number];

const STAGE_INDEX = new Map<string, number>(
  WORKER_STAGES.map((stage, index) => [stage, index + 1]),
);

export function stageIndexOf(stage: string): number {
  const index = STAGE_INDEX.get(stage);
  if (index === undefined) throw new RangeError(`${stage} is not a declared progress stage`);
  return index;
}

export interface JobLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

/** What a handler is given. Deliberately small: a handler cannot claim, complete or fail a job. */
export interface JobContext {
  readonly sql: Sql;
  readonly config: WorkerConfig;
  readonly job: Job;
  readonly log: JobLogger;
  readonly now: () => Date;
  /** Records one progress event. Out-of-order and duplicate stages are no-ops, not errors. */
  progress(stage: WorkerStage, detail: string): Promise<void>;
  /** True once cancellation has been requested. Handlers check it between stages. */
  cancelled(): Promise<boolean>;
}

/** Runs inside the transaction that marks the job succeeded. Returns the job's stored result. */
export type CommitFn = (tx: Db) => Promise<unknown>;

export type JobHandler = (context: JobContext) => Promise<CommitFn>;

export class CancelledError extends Error {
  constructor() {
    super("the job was cancelled");
    this.name = "CancelledError";
  }
}

/** A failure a handler declares terminal: retrying it cannot change the answer. */
export class TerminalJobError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "TerminalJobError";
    this.code = code;
  }
}

export interface RunnerOptions {
  readonly sql: Sql;
  readonly config: WorkerConfig;
  readonly handlers: Readonly<Record<JobType, JobHandler>>;
  readonly log: JobLogger;
  readonly now?: () => Date;
}

export interface RunOnceResult {
  readonly claimed: boolean;
  readonly jobId: string | null;
  readonly outcome: "succeeded" | "failed" | "cancelled" | "idle";
}

/**
 * Classifies a thrown value.
 *
 * Retryable is the narrow case, not the default: an unknown failure is retried because it may be
 * environmental, but anything the product itself declared — an invalid contract, an insufficient
 * baseline, a malformed job input — is terminal.
 */
function classify(error: unknown): { code: ErrorCode; message: string; retryable: boolean } {
  if (error instanceof TerminalJobError) {
    return { code: error.code, message: error.message, retryable: false };
  }
  if (error instanceof FlightRulesError) {
    const retryable =
      error.code === "SIGNOZ_UNREACHABLE" ||
      error.code === "MCP_UNAVAILABLE" ||
      error.code === "TRACE_QUERY_FAILED" ||
      error.code === "TRACE_FETCH_FAILED";
    return { code: error.code, message: error.message, retryable };
  }
  if (isTransientFailure(error)) {
    return {
      code: "EVALUATION_FAILED",
      message: "A transient database failure interrupted the job.",
      retryable: true,
    };
  }
  // No detail from an unknown error reaches the stored failure: its message may carry a connection
  // string, a header or a payload fragment.
  return {
    code: "EVALUATION_FAILED",
    message: "The job failed with an unexpected error.",
    retryable: true,
  };
}

export class JobRunner {
  readonly #sql: Sql;
  readonly #config: WorkerConfig;
  readonly #handlers: Readonly<Record<JobType, JobHandler>>;
  readonly #log: JobLogger;
  readonly #now: () => Date;
  #stopping = false;
  #active: Promise<void> | null = null;

  constructor(options: RunnerOptions) {
    this.#sql = options.sql;
    this.#config = options.config;
    this.#handlers = options.handlers;
    this.#log = options.log;
    this.#now = options.now ?? (() => new Date());
  }

  get stopping(): boolean {
    return this.#stopping;
  }

  /** Claims and runs at most one job. Returns immediately when the queue is empty. */
  async runOnce(
    jobTypes: readonly JobType[] = Object.keys(this.#handlers) as JobType[],
  ): Promise<RunOnceResult> {
    if (this.#stopping) return { claimed: false, jobId: null, outcome: "idle" };

    const job = await claimJob(this.#sql, {
      jobTypes,
      owner: this.#config.owner,
      leaseSeconds: this.#config.leaseSeconds,
    });
    if (!job) return { claimed: false, jobId: null, outcome: "idle" };

    const execution = this.#execute(job);
    this.#active = execution.then(() => undefined);
    try {
      return await execution;
    } finally {
      this.#active = null;
    }
  }

  async #execute(job: Job): Promise<RunOnceResult> {
    const owner = this.#config.owner;
    const handler = this.#handlers[job.jobType];
    this.#log.info({ job_id: job.id, job_type: job.jobType, attempt: job.attempt }, "job claimed");

    const heartbeat = setInterval(() => {
      void renewLease(this.#sql, job.id, owner, this.#config.leaseSeconds).catch(() => {});
    }, this.#config.heartbeatIntervalMs);
    heartbeat.unref();

    const context: JobContext = {
      sql: this.#sql,
      config: this.#config,
      job,
      log: this.#log,
      now: this.#now,
      progress: async (stage, detail) => {
        await recordProgress(this.#sql, {
          jobId: job.id,
          owner,
          index: stageIndexOf(stage),
          stage,
          detail,
          at: this.#now(),
        });
      },
      cancelled: async () => {
        const rows = await this.#sql<{ cancel_requested: boolean }[]>`
          select cancel_requested from jobs where id = ${job.id}`;
        return rows[0]?.cancel_requested === true;
      },
    };

    try {
      if (!handler) {
        throw new TerminalJobError(
          "CONFIG_INVALID",
          `This worker has no handler for job type ${job.jobType}.`,
        );
      }
      const commit = await handler(context);

      // The result and the transition to `succeeded` are one transaction. `completeJob` is guarded
      // on the lease, so a worker whose lease was reclaimed mid-run cannot overwrite the outcome of
      // the worker that now owns the job — the transaction rolls back instead.
      await this.#sql.begin(async (tx) => {
        const result = await commit(tx);
        const completed = await completeJob(tx, job.id, owner, result ?? {});
        if (!completed) {
          throw new FlightRulesError("JOB_ALREADY_RUNNING", {
            message: "The lease for this job was lost before its result could be committed.",
            details: { jobId: job.id },
          });
        }
      });

      this.#log.info({ job_id: job.id, job_type: job.jobType }, "job succeeded");
      return { claimed: true, jobId: job.id, outcome: "succeeded" };
    } catch (error) {
      if (error instanceof CancelledError) {
        await cancelClaimedJob(this.#sql, job.id, owner);
        this.#log.warn({ job_id: job.id }, "job cancelled");
        return { claimed: true, jobId: job.id, outcome: "cancelled" };
      }
      const failure = classify(error);
      await failJob(this.#sql, {
        jobId: job.id,
        owner,
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
        retryDelaySeconds: this.#config.retryDelaySeconds,
      });
      this.#log.error(
        {
          job_id: job.id,
          job_type: job.jobType,
          "error.code": failure.code,
          retryable: failure.retryable,
        },
        failure.message,
      );
      return { claimed: true, jobId: job.id, outcome: "failed" };
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** The polling loop. Returns when {@link stop} has been called and the active job has finished. */
  async loop(): Promise<void> {
    let nextReclaim = 0;
    while (!this.#stopping) {
      const now = Date.now();
      if (now >= nextReclaim) {
        nextReclaim = now + this.#config.reclaimIntervalMs;
        try {
          const reclaimed = await reclaimExpiredLeases(this.#sql);
          if (reclaimed.requeued.length > 0 || reclaimed.abandoned.length > 0) {
            this.#log.warn(
              { requeued: reclaimed.requeued.length, abandoned: reclaimed.abandoned.length },
              "recovered jobs from expired leases",
            );
          }
        } catch (error) {
          this.#log.error({ err: String(error) }, "lease recovery failed");
        }
      }

      let result: RunOnceResult;
      try {
        result = await this.runOnce();
      } catch (error) {
        this.#log.error({ err: String(error) }, "the runner loop failed to claim");
        result = { claimed: false, jobId: null, outcome: "idle" };
      }

      if (!result.claimed && !this.#stopping) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, this.#config.pollIntervalMs);
          timer.unref();
        });
      }
    }
  }

  /**
   * Stops claiming and waits for the active job.
   *
   * The active job is not abandoned: it finishes and commits, or it fails and is recorded. A worker
   * that exited mid-job would leave it in `running` until its lease expired, which is recoverable
   * but slow — and a normal termination should never need recovery.
   */
  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#active) await this.#active.catch(() => {});
  }
}

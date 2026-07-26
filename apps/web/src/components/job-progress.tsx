import { KeyValues, Section, Status } from "@flightrules/ui";
import type { ReactNode } from "react";
import { z } from "zod";
import { apiGet, isFailure } from "@/lib/api";
import { instant } from "@/lib/view";
import { AutoRefresh } from "./auto-refresh";

/**
 * Real, persisted job progress (PRD Phase 13 task 2, PRD section 15.10).
 *
 * Everything shown here is read on the server from the job row. Nothing is inferred, estimated or
 * animated. A stage appears because the worker wrote it, which is why this survives a reload, an
 * API restart, a worker restart, and the page being closed while the job runs.
 *
 * PRD section 8.7 fixes five progress sentences. `MINING_STAGES` in `@flightrules/baseline-miner`
 * is the vocabulary the worker actually reports, and the two are one list under two spellings —
 * `STAGE_LABELS` is the only place they meet, so there is no second progress vocabulary.
 */

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

/** `MINING_STAGES` to PRD section 8.7's sentences, one to one. */
const STAGE_LABELS: Readonly<Record<string, string>> = {
  discovering_traces: "Discovering traces",
  fetching_span_trees: "Fetching complete span trees",
  normalising_routes: "Normalising routes",
  grouping_route_families: "Grouping route families",
  proposing_contract_rules: "Proposing contract rules",
  // Stages the other job types report. Named rather than hidden: a sync that is running should say
  // so, not show an empty progress panel.
  compiling: "Compiling artifacts",
  syncing: "Writing to SigNoz",
  verifying: "Reading artifacts back",
  evaluating: "Evaluating runs",
};

export const MINING_STAGE_ORDER = [
  "discovering_traces",
  "fetching_span_trees",
  "normalising_routes",
  "grouping_route_families",
  "proposing_contract_rules",
] as const;

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage.replace(/_/g, " ");
}

const JobSchema = z.object({
  id: z.string(),
  jobType: z.string(),
  entityId: z.string().nullable(),
  status: z.string(),
  attempt: z.number(),
  maxAttempts: z.number(),
  progressStage: z.string().nullable(),
  result: z.unknown(),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
});

const EventsSchema = z.object({
  jobId: z.string(),
  status: z.string(),
  stage: z.string().nullable(),
  events: z.array(
    z.object({ index: z.number(), stage: z.string(), detail: z.string(), at: z.string() }),
  ),
});

export type Job = z.infer<typeof JobSchema>;
export type JobEvent = z.infer<typeof EventsSchema>["events"][number];

export const findJob = (jobId: string) => apiGet(`/api/jobs/${jobId}`, JobSchema);

/**
 * The job's persisted progress events.
 *
 * A separate read because PRD section 15.10 makes it a separate endpoint. A failure here degrades
 * to an empty list rather than hiding the job: knowing a job is running matters more than knowing
 * which sentence it is on.
 */
export async function findJobEvents(jobId: string): Promise<readonly JobEvent[]> {
  const result = await apiGet(`/api/jobs/${jobId}/events`, EventsSchema);
  return isFailure(result) ? [] : result.data.events;
}

export function isTerminal(job: Job): boolean {
  return TERMINAL.has(job.status);
}

/**
 * Renders a job's persisted progress.
 *
 * `showStages` lists PRD section 8.7's five sentences with each one's state, which is what the
 * baseline capture page needs. Other job types show their event list only, because inventing a
 * five-step shape for a two-step job would be a fabricated progress bar.
 */
export function JobProgress(props: {
  readonly job: Job;
  readonly events: readonly JobEvent[];
  readonly title: string;
  readonly showStages?: boolean;
  readonly testId?: string;
}): ReactNode {
  const { job } = props;
  const running = !isTerminal(job);
  const reached = new Set(props.events.map((event) => event.stage));
  if (job.progressStage !== null) reached.add(job.progressStage);
  if (job.status === "succeeded") for (const stage of MINING_STAGE_ORDER) reached.add(stage);

  return (
    <Section title={props.title} testId={props.testId ?? "job-progress"}>
      <AutoRefresh active={running} />

      <KeyValues
        testId="job-summary"
        entries={[
          [
            "Job",
            <span key="id" className="fr-mono">
              {job.id}
            </span>,
          ],
          [
            "State",
            <Status
              key="status"
              label={job.status}
              emphasis={job.status === "failed" || job.status === "cancelled"}
              testId="job-status"
            />,
          ],
          ["Stage", job.progressStage === null ? "—" : stageLabel(job.progressStage)],
          ["Attempt", `${String(job.attempt)} of ${String(job.maxAttempts)}`],
          ["Started", instant(job.startedAt)],
          ["Finished", instant(job.completedAt)],
        ]}
      />

      {props.showStages === true ? (
        <ol className="fr-steps" data-testid="baseline-progress-states">
          {MINING_STAGE_ORDER.map((stage) => {
            const state =
              job.progressStage === stage && running
                ? "in progress"
                : reached.has(stage)
                  ? "done"
                  : "waiting";
            return (
              <li key={stage} data-stage={stage} data-state={state}>
                {stageLabel(stage)} <Status label={state} emphasis={state === "in progress"} />
              </li>
            );
          })}
        </ol>
      ) : null}

      {props.events.length > 0 ? (
        <ol
          className="fr-stack"
          data-testid="job-events"
          style={{ marginTop: "var(--spacing-22)" }}
        >
          {props.events.map((event) => (
            <li key={`${String(event.index)}-${event.stage}`}>
              <span className="fr-mono fr-muted">{instant(event.at)}</span>{" "}
              <strong>{stageLabel(event.stage)}</strong> — {event.detail}
            </li>
          ))}
        </ol>
      ) : null}

      {job.error === null ? null : (
        <div
          className="fr-state fr-state--error"
          data-testid="job-error"
          role="alert"
          style={{ marginTop: "var(--spacing-22)" }}
        >
          <p className="fr-state__title">This job failed. Nothing was written.</p>
          <p className="fr-state__body">{job.error.message}</p>
          <p className="fr-mono fr-muted" style={{ marginTop: "var(--spacing-11)" }}>
            {job.error.code}
          </p>
        </div>
      )}
    </Section>
  );
}

/** Renders the panel for a job identifier taken from the URL, or nothing when there is none. */
export async function JobPanel(props: {
  readonly jobId: string | undefined;
  readonly title: string;
  readonly showStages?: boolean;
}): Promise<ReactNode> {
  if (props.jobId === undefined) return null;
  const job = await findJob(props.jobId);
  if (isFailure(job)) {
    return (
      <Section title={props.title} testId="job-progress">
        <div className="fr-state fr-state--error" role="alert" data-testid="job-unreadable">
          <p className="fr-state__title">That job could not be read.</p>
          <p className="fr-state__body">{job.message}</p>
          <p className="fr-mono fr-muted">{job.code}</p>
        </div>
      </Section>
    );
  }
  const events = await findJobEvents(props.jobId);
  return (
    <JobProgress
      job={job.data}
      events={events}
      title={props.title}
      {...(props.showStages === undefined ? {} : { showStages: props.showStages })}
    />
  );
}

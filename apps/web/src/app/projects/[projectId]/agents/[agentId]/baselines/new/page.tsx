import { EmptyState, Field, PageHeader, Section, Status, Table } from "@flightrules/ui";
import Link from "next/link";
import type { ReactNode } from "react";
import { findJob, findJobEvents, JobProgress } from "@/components/job-progress";
import { OutcomeBanner } from "@/components/outcome-banner";
import { RejectedTraces } from "@/components/rejected-traces";
import { ReviewActions } from "@/components/review-actions";
import { SubmitButton } from "@/components/submit-button";
import { isFailure } from "@/lib/api";
import { BASELINE } from "@/lib/copy";
import { findAgent, findBaseline, listBaselines } from "@/lib/load";
import { readOutcome } from "@/lib/outcome";
import { proposeContract } from "@/lib/review-actions";
import { failureState, instant, percent, shortHash } from "@/lib/view";
import { analyseBaseline } from "./actions";

/**
 * PRD section 8.7 — capture a known-good baseline, and review what it found.
 *
 * This is one page rather than three because it is one task: choose a window, watch the miner work,
 * then decide what it found. The page's state lives entirely in its address —
 * `?job=<uuid>&baseline=<uuid>` — which is what makes every persistence requirement in PRD Phase 13
 * fall out for free: reload, API restart, worker restart, a job that finished while the tab was
 * closed, and a link a reviewer can send to someone else.
 *
 * Nothing here is computed in the browser. The progress comes from the job row, the counts come
 * from the persisted baseline, and every review decision is re-read after it is written.
 */

export const dynamic = "force-dynamic";

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export default async function BaselineCapturePage(props: {
  params: Promise<{ projectId: string; agentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { projectId, agentId } = await props.params;
  const search = await props.searchParams;
  const jobId = first(search["job"]);
  const outcome = readOutcome(search);

  const [agent, baselines] = await Promise.all([findAgent(agentId), listBaselines(agentId)]);

  if (isFailure(agent)) {
    return (
      <div className="fr-shell" data-testid="route-baseline-new">
        <PageHeader title={BASELINE.title} />
        <Section>{failureState(agent)}</Section>
      </div>
    );
  }

  const base = `/projects/${projectId}/agents/${agentId}`;
  const here = `${base}/baselines/new`;
  const existing = isFailure(baselines) ? [] : baselines.data.items;

  // The job identifier in the address is the only source of the job. When it has succeeded, its
  // result names the baseline it wrote, and that baseline is read from the database — never from
  // the job's result payload, which is a report rather than the record.
  const job = jobId === undefined ? null : await findJob(jobId);
  const jobEvents = jobId === undefined ? [] : await findJobEvents(jobId);
  const liveJob = job !== null && !isFailure(job) ? job.data : null;
  const jobResult = (liveJob?.result ?? {}) as { baselineId?: unknown; contractId?: unknown };

  const baselineId =
    first(search["baseline"]) ??
    (typeof jobResult.baselineId === "string" ? jobResult.baselineId : undefined);
  const baseline = baselineId === undefined ? null : await findBaseline(baselineId);
  const found = baseline !== null && !isFailure(baseline) ? baseline.data : null;

  const proposedContractId =
    typeof jobResult.contractId === "string" ? jobResult.contractId : undefined;

  const reviewable =
    found !== null && found.status !== "dataset_truncated" && found.status !== "insufficient_runs";

  return (
    <div className="fr-shell" data-testid="route-baseline-new">
      <PageHeader
        eyebrow={agent.data.name}
        title={BASELINE.title}
        description={BASELINE.description}
      />

      <OutcomeBanner outcome={outcome} />

      {proposedContractId === undefined ? null : (
        <Section testId="baseline-proposed-contract">
          <p>
            A draft contract was proposed from this baseline.{" "}
            <Link className="fr-button" href={`${base}/contracts/${proposedContractId}`}>
              Open the Contract Studio
            </Link>
          </p>
        </Section>
      )}

      <Section title="Selection" testId="baseline-form">
        <form action={analyseBaseline} className="fr-stack" data-testid="baseline-selection">
          <input name="projectId" type="hidden" value={projectId} />
          <input name="agentId" type="hidden" value={agentId} />

          <div className="fr-grid fr-grid--tight">
            <Field
              id="release-id"
              label="Release ID"
              hint="The value of this agent's release discriminator."
            >
              {(attributes) => (
                <input
                  {...attributes}
                  className="fr-input"
                  name="releaseKey"
                  type="text"
                  defaultValue="refund-agent-v1"
                />
              )}
            </Field>

            <Field id="environment" label="Environment">
              {(attributes) => (
                <input
                  {...attributes}
                  className="fr-input"
                  name="environment"
                  type="text"
                  defaultValue="local"
                />
              )}
            </Field>

            <Field
              id="time-range"
              label="Time range"
              hint="Minutes of history to search, ending now."
            >
              {(attributes) => (
                <select
                  {...attributes}
                  className="fr-select"
                  name="lookbackMinutes"
                  defaultValue="360"
                >
                  <option value="60">Last hour</option>
                  <option value="360">Last 6 hours</option>
                  <option value="1440">Last 24 hours</option>
                  <option value="10080">Last 7 days</option>
                </select>
              )}
            </Field>

            <Field
              id="minimum-runs"
              label="Minimum completed runs"
              hint="Below this, mining is blocked rather than producing a thin baseline."
            >
              {(attributes) => (
                <input
                  {...attributes}
                  className="fr-input"
                  name="minimumRuns"
                  type="number"
                  min={1}
                  max={5000}
                  defaultValue={20}
                />
              )}
            </Field>

            <Field
              id="rare-threshold"
              label="Rare route threshold"
              hint="A family below this share of runs is marked rare for review."
            >
              {(attributes) => (
                <input
                  {...attributes}
                  className="fr-input"
                  name="rareThreshold"
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  defaultValue={0.05}
                />
              )}
            </Field>

            <Field id="max-traces" label="Maximum traces to fetch">
              {(attributes) => (
                <input
                  {...attributes}
                  className="fr-input"
                  name="maxTraces"
                  type="number"
                  min={1}
                  max={5000}
                  defaultValue={500}
                />
              )}
            </Field>
          </div>

          <div className="fr-checkbox">
            <input id="successful-only" name="successfulRunsOnly" type="checkbox" defaultChecked />
            <label htmlFor="successful-only">Include successful runs only</label>
          </div>

          <div className="fr-checkbox">
            <input
              id="exclude-missing-root"
              name="excludeMissingRootSpan"
              type="checkbox"
              defaultChecked
            />
            <label htmlFor="exclude-missing-root">Exclude traces with missing root span</label>
          </div>

          <div>
            <SubmitButton pendingLabel="Submitting…" testId="baseline-submit">
              {BASELINE.primaryCta}
            </SubmitButton>
          </div>
        </form>
      </Section>

      {liveJob === null ? (
        <Section title="Progress" testId="baseline-progress">
          <ol className="fr-steps" data-testid="baseline-progress-states">
            {BASELINE.progressStates.map((state) => (
              <li key={state}>{state}</li>
            ))}
          </ol>
          <p className="fr-muted" style={{ marginTop: "var(--spacing-22)", maxWidth: "62ch" }}>
            Mining runs as a job. These are the stages it reports; the job&rsquo;s current stage
            appears here while it runs.
          </p>
        </Section>
      ) : (
        <JobProgress job={liveJob} events={jobEvents} title="Progress" showStages />
      )}

      {job !== null && isFailure(job) ? (
        <Section title="Progress" testId="baseline-progress">
          {failureState(job)}
        </Section>
      ) : null}

      {found === null ? null : (
        <>
          <Section title="Baseline" testId="baseline-result">
            <p>
              <span className="fr-mono">{found.baselineIdentifier}</span>{" "}
              <Status
                label={found.status.replace(/_/g, " ")}
                emphasis={!reviewable}
                testId="baseline-status"
              />
            </p>
            <p className="fr-muted" style={{ marginTop: "var(--spacing-13)" }}>
              Window {instant(found.sourceTimeStart)} to {instant(found.sourceTimeEnd)}, minimum{" "}
              {String(found.minimumRuns)} completed run(s).
            </p>
          </Section>

          <RejectedTraces
            counts={found.counts}
            retrieval={found.retrieval}
            excluded={found.excluded}
            disclosures={found.disclosures}
          />

          <Section title="Route families" testId="baseline-families">
            <Table
              caption="Every route family this baseline mined, with the decision recorded for it"
              rows={found.families}
              rowKey={(family) => family.id}
              empty={
                <EmptyState
                  title="This baseline mined no route family."
                  body="No eligible trace produced a route. Widen the window or lower the minimum run count."
                />
              }
              columns={[
                {
                  key: "fingerprint",
                  header: "Family",
                  render: (family) => (
                    <Link href={`${base}/routes/${family.id}`}>
                      {shortHash(family.fingerprint.replace("sha256:", ""), 16)}
                    </Link>
                  ),
                },
                {
                  key: "status",
                  header: "Decision",
                  render: (family) => (
                    <Status
                      label={family.status.replace(/_/g, " ")}
                      emphasis={family.status === "approved"}
                    />
                  ),
                },
                {
                  key: "count",
                  header: "Runs",
                  numeric: true,
                  render: (family) => String(family.occurrenceCount),
                },
                {
                  key: "share",
                  header: "Share",
                  numeric: true,
                  render: (family) => percent(String(Number(family.occurrencePercent) * 100)),
                },
                {
                  key: "rare",
                  header: "Rare",
                  render: (family) => (family.rare ? <Status label="rare" /> : "—"),
                },
                {
                  key: "actions",
                  header: "Review",
                  render: (family) => (
                    <ReviewActions
                      baselineId={found.id}
                      familyId={family.id}
                      returnTo={`${here}?baseline=${found.id}`}
                      disabled={!reviewable}
                      disabledReason={`This baseline is ${found.status.replace(/_/g, " ")} and cannot be reviewed.`}
                    />
                  ),
                },
              ]}
            />
          </Section>

          <Section
            title="Propose a contract"
            testId="baseline-propose"
            description="A contract can be proposed once at least one route family is approved. Nothing is enforced until the contract is validated, approved and activated."
          >
            <form action={proposeContract} className="fr-stack">
              <input name="baselineId" type="hidden" value={found.id} />
              <input name="returnTo" type="hidden" value={`${here}?baseline=${found.id}`} />
              <input name="workflowName" type="hidden" value={agent.data.workflowNameMatcher} />
              <input name="environment" type="hidden" value={found.environment ?? ""} />
              <div>
                <SubmitButton pendingLabel="Proposing…" testId="baseline-propose-submit">
                  Propose contract
                </SubmitButton>
              </div>
            </form>
          </Section>
        </>
      )}

      <Section title="Captured baselines" testId="baseline-existing">
        <Table
          caption="Baselines already captured for this agent"
          rows={existing}
          rowKey={(entry) => entry.id}
          empty={<EmptyState title="No baseline has been captured for this agent yet." />}
          columns={[
            {
              key: "identifier",
              header: "Baseline",
              render: (entry) => (
                <Link href={`${here}?baseline=${entry.id}`}>{entry.baselineIdentifier}</Link>
              ),
            },
            {
              key: "status",
              header: "Status",
              render: (entry) => <Status label={entry.status.replace(/_/g, " ")} />,
            },
            {
              key: "created",
              header: "Captured",
              render: (entry) => instant(entry.createdAt),
            },
          ]}
        />
      </Section>
    </div>
  );
}

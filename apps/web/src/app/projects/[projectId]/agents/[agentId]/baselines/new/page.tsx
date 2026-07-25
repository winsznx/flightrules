import { EmptyState, Field, PageHeader, Section, Status, Table } from "@flightrules/ui";
import Link from "next/link";
import type { ReactNode } from "react";
import { isFailure } from "@/lib/api";
import { BASELINE } from "@/lib/copy";
import { findAgent, listBaselines } from "@/lib/load";
import { failureState, instant } from "@/lib/view";

/**
 * PRD section 8.7 — capture a known-good baseline.
 *
 * Phase 12 lays the form, its eight required controls, its labelling and its progress vocabulary.
 * Phase 13 makes it submit and wires the job progress to a live job. The controls are real inputs
 * with real labels and real defaults now, so the accessibility and copy assertions run against the
 * shipped markup rather than a sketch of it.
 */

export const dynamic = "force-dynamic";

export default async function BaselineCapturePage(props: {
  params: Promise<{ projectId: string; agentId: string }>;
}): Promise<ReactNode> {
  const { projectId, agentId } = await props.params;
  const [agent, baselines] = await Promise.all([findAgent(agentId), listBaselines(agentId)]);

  if (isFailure(agent)) {
    return (
      <div className="fr-shell" data-testid="route-baseline-new">
        <PageHeader title={BASELINE.title} />
        <Section>{failureState(agent)}</Section>
      </div>
    );
  }

  const existing = isFailure(baselines) ? [] : baselines.data.items;
  const base = `/projects/${projectId}/agents/${agentId}`;

  return (
    <div className="fr-shell" data-testid="route-baseline-new">
      <PageHeader
        eyebrow={agent.data.name}
        title={BASELINE.title}
        description={BASELINE.description}
      />

      <Section title="Selection" testId="baseline-form">
        <form className="fr-stack" data-testid="baseline-selection" action={base} method="get">
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
            <button className="fr-button" type="submit">
              {BASELINE.primaryCta}
            </button>
          </div>
        </form>
      </Section>

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

      <Section title="Captured baselines" testId="baseline-existing">
        <Table
          caption="Baselines already captured for this agent"
          rows={existing}
          rowKey={(baseline) => baseline.id}
          empty={<EmptyState title="No baseline has been captured for this agent yet." />}
          columns={[
            {
              key: "identifier",
              header: "Baseline",
              render: (baseline) => (
                <Link href={`${base}?tab=routes`}>{baseline.baselineIdentifier}</Link>
              ),
            },
            {
              key: "status",
              header: "Status",
              render: (baseline) => <Status label={baseline.status.replace(/_/g, " ")} />,
            },
            {
              key: "created",
              header: "Captured",
              render: (baseline) => instant(baseline.createdAt),
            },
          ]}
        />
      </Section>
    </div>
  );
}

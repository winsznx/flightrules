import {
  EmptyState,
  Featured,
  KeyValues,
  PageHeader,
  Section,
  Status,
  Table,
} from "@flightrules/ui";
import Link from "next/link";
import type { ReactNode } from "react";
import { isFailure } from "@/lib/api";
import { RELEASE_DIFF } from "@/lib/copy";
import { findGate, findRelease, listViolations } from "@/lib/load";
import { failureState, instant, percent, signedPercent } from "@/lib/view";

/**
 * PRD section 8.11 — Release Diff.
 *
 * Phase 12 delivers the decision, its findings, its measurements and its evidence. Phase 14 adds the
 * typed topology diff against the nearest approved family.
 *
 * The decision sentence is PRD section 8.11's copy verbatim, and it is the page's one clay block:
 * `design.md` permits a single `#bc7155` element per page, and the release decision is what this
 * page exists to say.
 */

export const dynamic = "force-dynamic";

export default async function ReleaseDiffPage(props: {
  params: Promise<{ projectId: string; agentId: string; releaseId: string }>;
}): Promise<ReactNode> {
  const { projectId, agentId, releaseId } = await props.params;
  const [release, gate] = await Promise.all([findRelease(releaseId), findGate(releaseId)]);

  if (isFailure(release)) {
    return (
      <div className="fr-shell" data-testid="route-release-diff">
        <PageHeader title="Release" />
        <Section>{failureState(release)}</Section>
      </div>
    );
  }

  if (isFailure(gate)) {
    return (
      <div className="fr-shell" data-testid="route-release-diff">
        <PageHeader eyebrow={release.data.environment} title={release.data.releaseKey} />
        <Section>
          {gate.code === "RELEASE_INSUFFICIENT_DATA" ? (
            <EmptyState
              title={RELEASE_DIFF.decision.insufficient_data}
              body="Evaluate this release against its active contract to produce a decision."
              testId="release-not-evaluated"
            />
          ) : (
            failureState(gate)
          )}
        </Section>
      </div>
    );
  }

  const decision = gate.data;
  const violations = await listViolations(projectId);
  const releaseViolations = isFailure(violations)
    ? []
    : violations.data.items.filter((violation) => violation.releaseKey === decision.releaseKey);
  const representative = releaseViolations[0];

  return (
    <div className="fr-shell" data-testid="route-release-diff">
      <PageHeader
        eyebrow={decision.environment}
        title={`${decision.releaseKey} vs ${decision.baselineReleaseKey ?? "no baseline"}`}
      />

      <Section testId="release-decision">
        <Featured title={RELEASE_DIFF.decision[decision.decision]} testId="decision-banner">
          <KeyValues
            entries={[
              [
                "Evaluated runs",
                `${decision.counts.evaluatedRuns} (minimum ${decision.gate.minCompletedRuns})`,
              ],
              ["Failed runs", String(decision.counts.failedRuns)],
              ["Zero-tolerance violations", String(decision.counts.zeroToleranceViolations)],
              ["Contract", `${decision.contractKey} ${decision.contractVersion}`],
              ["Decision hash", decision.decisionHash],
            ]}
          />
        </Featured>
      </Section>

      <Section title="Thresholds" testId="release-thresholds">
        <Table
          caption="What the contract permits, and what this release did"
          rows={[
            {
              name: "Violation rate",
              limit: `${decision.gate.maxViolationPercent}%`,
              observed: percent(decision.rates.violation.percent),
            },
            {
              name: "Unknown route rate",
              limit: `${decision.gate.maxUnknownRoutePercent}%`,
              observed: percent(decision.rates.unknownRoute.percent),
            },
            {
              name: "Latency change",
              limit: `${decision.gate.maxLatencyRegressionPercent}%`,
              observed: signedPercent(decision.changes.latency.changePercent),
            },
            {
              name: "Token change",
              limit: `${decision.gate.maxTokenRegressionPercent}%`,
              observed: signedPercent(decision.changes.tokens.changePercent),
            },
            {
              name: "Duplicate side effects",
              limit: "reported",
              observed: percent(decision.rates.duplicateSideEffect.percent),
            },
            {
              name: "Missing prerequisites",
              limit: "reported",
              observed: percent(decision.rates.missingPrerequisite.percent),
            },
          ]}
          rowKey={(row) => row.name}
          empty={<EmptyState title="No threshold was evaluated." />}
          columns={[
            { key: "name", header: "Threshold", render: (row) => row.name },
            { key: "limit", header: "Permitted", numeric: true, render: (row) => row.limit },
            { key: "observed", header: "Observed", numeric: true, render: (row) => row.observed },
          ]}
        />
      </Section>

      <Section title="Findings" testId="release-findings">
        <Table
          caption="Why the gate decided what it decided"
          rows={decision.findings}
          rowKey={(finding) => `${finding.code}-${finding.ruleId ?? ""}`}
          empty={
            <EmptyState title="No finding. Every threshold this contract sets was satisfied." />
          }
          columns={[
            {
              key: "code",
              header: "Finding",
              render: (finding) => <Status label={finding.code.replace(/_/g, " ")} emphasis />,
            },
            { key: "implies", header: "Implies", render: (finding) => finding.implies },
            { key: "summary", header: "Summary", render: (finding) => finding.summary },
            { key: "expected", header: "Expected", render: (finding) => finding.expected },
            { key: "observed", header: "Observed", render: (finding) => finding.observed },
          ]}
        />
      </Section>

      {decision.disclosures.length > 0 ? (
        <Section title="Disclosures" testId="release-disclosures">
          <Table
            caption="Checks whose evidence is structurally absent. These are neither passes nor failures."
            rows={decision.disclosures}
            rowKey={(entry) => `${entry.code}-${entry.ruleId ?? ""}`}
            empty={<EmptyState title="Nothing was left unmeasured." />}
            columns={[
              {
                key: "code",
                header: "Disclosure",
                render: (entry) => entry.code.replace(/_/g, " "),
              },
              { key: "summary", header: "Detail", render: (entry) => entry.summary },
            ]}
          />
        </Section>
      ) : null}

      <Section title="Change from baseline" testId="release-changes">
        <KeyValues
          entries={[
            [
              decision.changes.latency.metric,
              decision.changes.latency.measured
                ? `${signedPercent(decision.changes.latency.changePercent)} (${String(decision.changes.latency.baseline)} → ${String(decision.changes.latency.candidate)})`
                : "not measured",
            ],
            [
              decision.changes.tokens.metric,
              decision.changes.tokens.measured
                ? signedPercent(decision.changes.tokens.changePercent)
                : "not measured",
            ],
            [
              decision.changes.retries.metric,
              decision.changes.retries.measured
                ? signedPercent(decision.changes.retries.changePercent)
                : "not measured",
            ],
            ["Evaluated at", instant(decision.retrievedAt)],
            ["Evaluator version", decision.evaluatorVersion],
          ]}
        />
      </Section>

      <Section title="Evidence" testId="release-evidence">
        <Table
          caption="Representative traces this decision was taken over"
          rows={[
            ...decision.evidence.representativeFailingTraceIds.map((traceId) => ({
              traceId,
              outcome: "failing",
            })),
            ...decision.evidence.representativePassingTraceIds.map((traceId) => ({
              traceId,
              outcome: "passing",
            })),
          ]}
          rowKey={(row) => row.traceId}
          empty={<EmptyState title="No representative trace was recorded." />}
          columns={[
            {
              key: "traceId",
              header: "Trace",
              render: (row) => <span className="fr-mono">{row.traceId}</span>,
            },
            { key: "outcome", header: "Outcome", render: (row) => row.outcome },
          ]}
        />
      </Section>

      <Section title="Actions" testId="release-actions">
        <div className="fr-row">
          {representative === undefined ? (
            <span className="fr-button fr-button--ghost" aria-disabled="true">
              {RELEASE_DIFF.actions[0]}
            </span>
          ) : (
            <Link
              className="fr-button"
              href={`/projects/${projectId}/violations/${representative.id}`}
            >
              {RELEASE_DIFF.actions[0]}
            </Link>
          )}
          <Link
            className="fr-button fr-button--ghost"
            href={`/projects/${projectId}/agents/${agentId}/releases`}
          >
            {RELEASE_DIFF.actions[1]}
          </Link>
          <span className="fr-button fr-button--ghost" aria-disabled="true">
            {RELEASE_DIFF.actions[2]}
          </span>
          <span className="fr-button fr-button--ghost" aria-disabled="true">
            {RELEASE_DIFF.actions[3]}
          </span>
        </div>
        <p className="fr-muted" style={{ marginTop: "var(--spacing-15)", maxWidth: "62ch" }}>
          Evidence download and the SigNoz deep link are produced by
          <span className="fr-mono"> flightrules evidence export</span> today; both become buttons
          here in the Release Diff phase.
        </p>
      </Section>
    </div>
  );
}

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
import { GraphDiffView } from "@/components/graph-diff";
import { JobPanel } from "@/components/job-progress";
import { OutcomeBanner } from "@/components/outcome-banner";
import { SubmitButton } from "@/components/submit-button";
import { isFailure } from "@/lib/api";
import { RELEASE_DIFF } from "@/lib/copy";
import { findGate, findRelease, findReleaseDiff, listViolations } from "@/lib/load";
import { readOutcome } from "@/lib/outcome";
import { failureState, instant, percent, signedPercent } from "@/lib/view";
import { reEvaluateRelease } from "./actions";

/**
 * PRD section 8.11 — Release Diff.
 *
 * The page a judge reads. It has to make one thing obvious without any knowledge of the source: what
 * this release did that the approved route does not.
 *
 * Everything below the decision comes from `GET /api/releases/:releaseId/diff`, which compares two
 * stored canonical graphs on the server using the same deterministic engine the evaluator uses.
 * Nothing on this page compares anything: PRD Phase 14's last test is "no graph data is fabricated
 * client-side", and this page has no code that could.
 *
 * The decision sentence is PRD section 8.11's copy verbatim, and it is the page's one clay block:
 * `design.md` permits a single `#bc7155` element per page, and the release decision is what this
 * page exists to say.
 */

export const dynamic = "force-dynamic";

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export default async function ReleaseDiffPage(props: {
  params: Promise<{ projectId: string; agentId: string; releaseId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { projectId, agentId, releaseId } = await props.params;
  const search = await props.searchParams;
  const outcome = readOutcome(search);
  const jobId = first(search["job"]);
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
  const [violations, diff] = await Promise.all([
    listViolations(projectId),
    findReleaseDiff(releaseId),
  ]);
  const topology = isFailure(diff) ? null : diff.data;
  const releaseViolations = isFailure(violations)
    ? []
    : violations.data.items.filter((violation) => violation.releaseKey === decision.releaseKey);
  const representative = releaseViolations[0];

  // PRD Phase 14: "Generate links from verified identifiers. Do not build links from guessed URL
  // patterns." The only trace URL this product has is the one SigNoz itself returned when the trace
  // was retrieved, stored on the run. When there is none, the action says so rather than guessing.
  const signozLink =
    topology?.representativeFailingTraces.find((trace) => trace.signozWebUrl !== null)
      ?.signozWebUrl ??
    topology?.representativePassingTraces.find((trace) => trace.signozWebUrl !== null)
      ?.signozWebUrl ??
    representative?.signozWebUrl ??
    null;

  return (
    <div className="fr-shell" data-testid="route-release-diff">
      <PageHeader
        eyebrow={decision.environment}
        title={`${decision.releaseKey} vs ${decision.baselineReleaseKey ?? "no baseline"}`}
      />

      <OutcomeBanner outcome={outcome} />

      <JobPanel jobId={jobId} title="Re-evaluation" />

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

      {topology === null ? (
        <Section title="Behaviour change" testId="release-graph-diff">
          <EmptyState
            title="The topology comparison is unavailable."
            body={
              isFailure(diff)
                ? `FlightRules could not read this release's diff (${diff.code}). The decision above is unaffected: it was taken from persisted evidence and does not depend on this comparison.`
                : "No comparison was produced."
            }
            testId="diff-unavailable"
          />
        </Section>
      ) : (
        <GraphDiffView
          baseline={topology.baseline?.graph ?? null}
          candidate={topology.candidate?.graph ?? null}
          changes={topology.changes}
          nearestRouteFamilyId={topology.nearestApprovedRouteFamilyId}
          nearestRouteHref={
            topology.nearestApprovedRouteFamilyId === null
              ? null
              : `/projects/${projectId}/agents/${agentId}/routes/${topology.nearestApprovedRouteFamilyId}`
          }
          baselineFingerprint={topology.baseline?.fingerprint ?? null}
          candidateFingerprint={topology.candidate?.trace.routeFingerprint ?? null}
        />
      )}

      {topology !== null && topology.disclosures.length > 0 ? (
        <Section title="Comparison disclosures" testId="diff-disclosures">
          <Table
            caption="Why this comparison is partial"
            rows={topology.disclosures}
            rowKey={(entry) => entry.code}
            empty={<EmptyState title="Nothing was left uncompared." />}
            columns={[
              {
                key: "code",
                header: "Disclosure",
                render: (entry) => <span className="fr-mono">{entry.code}</span>,
              },
              { key: "summary", header: "Detail", render: (entry) => entry.summary },
            ]}
          />
        </Section>
      ) : null}

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

      <Section
        title="Evidence"
        testId="release-evidence"
        description="Representative runs this decision was taken over. Each SigNoz link is the URL SigNoz itself returned for that trace when FlightRules retrieved it, not a pattern this page assembled."
      >
        <Table
          caption="Representative traces this decision was taken over"
          testId="release-evidence-table"
          rows={[
            ...(topology?.representativeFailingTraces ?? []).map((trace) => ({
              traceId: trace.traceId,
              outcome: "failing",
              signozWebUrl: trace.signozWebUrl,
              similarity: trace.similarity,
              routeApproved: trace.routeApproved,
            })),
            ...(topology?.representativePassingTraces ?? []).map((trace) => ({
              traceId: trace.traceId,
              outcome: "passing",
              signozWebUrl: trace.signozWebUrl,
              similarity: trace.similarity,
              routeApproved: trace.routeApproved,
            })),
            ...(topology === null
              ? [
                  ...decision.evidence.representativeFailingTraceIds.map((traceId) => ({
                    traceId,
                    outcome: "failing",
                    signozWebUrl: null,
                    similarity: "—",
                    routeApproved: false,
                  })),
                  ...decision.evidence.representativePassingTraceIds.map((traceId) => ({
                    traceId,
                    outcome: "passing",
                    signozWebUrl: null,
                    similarity: "—",
                    routeApproved: true,
                  })),
                ]
              : []),
          ]}
          rowKey={(row) => `${row.outcome}-${row.traceId}`}
          empty={<EmptyState title="No representative trace was recorded." />}
          columns={[
            {
              key: "traceId",
              header: "Trace",
              render: (row) => <span className="fr-mono">{row.traceId}</span>,
            },
            {
              key: "outcome",
              header: "Outcome",
              render: (row) => <Status label={row.outcome} emphasis={row.outcome === "failing"} />,
            },
            {
              key: "route",
              header: "Route",
              render: (row) => (row.routeApproved ? "approved" : "not approved"),
            },
            {
              key: "similarity",
              header: "Similarity",
              numeric: true,
              render: (row) => row.similarity,
            },
            {
              key: "signoz",
              header: "In SigNoz",
              render: (row) =>
                row.signozWebUrl === null ? (
                  <span className="fr-muted">no link recorded</span>
                ) : (
                  <a
                    data-testid="signoz-trace-link"
                    href={row.signozWebUrl}
                    rel="noreferrer noopener"
                    target="_blank"
                  >
                    Open trace
                  </a>
                ),
            },
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
              data-testid="open-representative-violation"
              href={`/projects/${projectId}/violations/${representative.id}`}
            >
              {RELEASE_DIFF.actions[0]}
            </Link>
          )}

          <form action={reEvaluateRelease}>
            <input name="projectId" type="hidden" value={projectId} />
            <input name="agentId" type="hidden" value={agentId} />
            <input name="releaseId" type="hidden" value={releaseId} />
            <SubmitButton ghost pendingLabel="Submitting…" testId="release-re-evaluate">
              {RELEASE_DIFF.actions[1]}
            </SubmitButton>
          </form>

          <a
            className="fr-button fr-button--ghost"
            data-testid="release-evidence-download"
            download={`release-evidence-${decision.releaseKey}.json`}
            href={`/projects/${projectId}/agents/${agentId}/releases/${releaseId}/evidence`}
          >
            {RELEASE_DIFF.actions[2]}
          </a>

          {signozLink === null ? (
            <span className="fr-button fr-button--ghost" aria-disabled="true">
              {RELEASE_DIFF.actions[3]}
            </span>
          ) : (
            <a
              className="fr-button fr-button--ghost"
              data-testid="release-open-in-signoz"
              href={signozLink}
              rel="noreferrer noopener"
              target="_blank"
            >
              {RELEASE_DIFF.actions[3]}
            </a>
          )}
        </div>
        <p className="fr-muted" style={{ marginTop: "var(--spacing-15)", maxWidth: "62ch" }}>
          Re-running the evaluation creates a new evaluation and a job. The decision above is read
          from the most recent <em>completed</em> evaluation, so it does not change until the new
          one finishes — and the evidence behind it is preserved either way.
        </p>
      </Section>
    </div>
  );
}

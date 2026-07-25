import { EmptyState, KeyValues, PageHeader, Section, Status, Table } from "@flightrules/ui";
import Link from "next/link";
import type { ReactNode } from "react";
import { apiGet, isFailure, ViolationEvidenceSchema, ViolationSchema } from "@/lib/api";
import { VIOLATION } from "@/lib/copy";
import { failureState, instant } from "@/lib/view";

/**
 * PRD section 8.12 — Violation Inspector.
 *
 * Phase 12 delivers the nine required sections and the deep link to the trace in SigNoz. Phase 15
 * adds the observed-versus-approved route comparison and the correlated log and metric panels.
 *
 * PRD section 8.12 forbids the product from ever offering "Ignore and pass release". That string
 * appears nowhere in this application, and a route test asserts its absence across every page.
 */

export const dynamic = "force-dynamic";

export default async function ViolationInspectorPage(props: {
  params: Promise<{ projectId: string; violationId: string }>;
}): Promise<ReactNode> {
  const { projectId, violationId } = await props.params;
  const [violation, evidence] = await Promise.all([
    apiGet(`/api/violations/${violationId}`, ViolationSchema),
    apiGet(`/api/violations/${violationId}/evidence`, ViolationEvidenceSchema),
  ]);

  if (isFailure(violation)) {
    return (
      <div className="fr-shell" data-testid="route-violation">
        <PageHeader title="Violation" />
        <Section>{failureState(violation)}</Section>
      </div>
    );
  }

  const found = violation.data;
  const bundle = isFailure(evidence) ? null : evidence.data;

  return (
    <div className="fr-shell" data-testid="route-violation">
      <PageHeader
        eyebrow={found.releaseKey ?? "release unknown"}
        title={`${found.ruleKey} ${VIOLATION.titleSuffix}`}
        actions={
          found.signozWebUrl === null ? (
            <span className="fr-button fr-button--ghost" aria-disabled="true">
              {VIOLATION.primaryCta}
            </span>
          ) : (
            <a className="fr-button" href={found.signozWebUrl} rel="noreferrer noopener">
              {VIOLATION.primaryCta}
            </a>
          )
        }
      />

      <Section title={VIOLATION.sections[0]} testId="violation-what-failed">
        <KeyValues
          entries={[
            [
              "Severity",
              <Status key="sev" label={found.severity} emphasis={found.zeroTolerance} />,
            ],
            ["Zero tolerance", found.zeroTolerance ? "yes" : "no"],
            ["Violation type", found.violationType.replace(/_/g, " ")],
            ["Summary", found.message],
            ["Expected", found.expected],
            ["Observed", found.observed],
          ]}
        />
      </Section>

      <Section title={VIOLATION.sections[1]} testId="violation-observed-route">
        {bundle === null || bundle.labels.length === 0 ? (
          <EmptyState
            title="No route labels were recorded for this violation."
            body="A violation with no positional evidence names an absence rather than a step."
          />
        ) : (
          <Table
            caption="Canonical labels this violation was anchored on"
            rows={bundle.labels.map((label, index) => ({
              label,
              node: bundle.canonicalNodes[index] ?? null,
            }))}
            rowKey={(row) => row.label}
            empty={<EmptyState title="No labels." />}
            columns={[
              { key: "label", header: "Step", render: (row) => row.label },
              {
                key: "node",
                header: "Canonical node",
                numeric: true,
                render: (row) => (row.node === null ? "—" : String(row.node)),
              },
            ]}
          />
        )}
      </Section>

      <Section title={VIOLATION.sections[2]} testId="violation-approved-route">
        <p className="fr-muted" style={{ maxWidth: "62ch" }}>
          The approved route is the contract&rsquo;s route family. The topology comparison between
          it and the observed run is the Release Diff&rsquo;s work.
        </p>
        <p style={{ marginTop: "var(--spacing-15)" }}>
          <Link
            className="fr-button fr-button--ghost"
            href={
              bundle?.releaseId == null
                ? `/projects/${projectId}/overview`
                : `/projects/${projectId}/agents/${found.contractId}/releases/${bundle.releaseId}`
            }
          >
            {VIOLATION.secondaryActions[1]}
          </Link>
        </p>
      </Section>

      <Section title={VIOLATION.sections[3]} testId="violation-trace-evidence">
        <KeyValues
          entries={[
            [
              "Trace",
              <span key="t" className="fr-mono">
                {found.traceId}
              </span>,
            ],
            [
              "Spans",
              bundle === null || bundle.spanIds.length === 0 ? (
                "none recorded"
              ) : (
                <span key="spans" className="fr-mono">
                  {bundle.spanIds.join(", ")}
                </span>
              ),
            ],
            [
              "SigNoz",
              found.signozWebUrl === null ? (
                "no deep link was recorded"
              ) : (
                <a key="signoz" href={found.signozWebUrl} rel="noreferrer noopener">
                  {found.signozWebUrl}
                </a>
              ),
            ],
          ]}
        />
      </Section>

      <Section title={VIOLATION.sections[4]} testId="violation-logs">
        <p className="fr-muted" style={{ maxWidth: "62ch" }}>
          FlightRules writes structured logs correlated by trace identifier. Log export over OTLP is
          not yet enabled, so correlated logs are read in SigNoz using the trace above rather than
          shown here.
        </p>
      </Section>

      <Section title={VIOLATION.sections[5]} testId="violation-metrics">
        <p className="fr-muted" style={{ maxWidth: "62ch" }}>
          The managed dashboard compiled from this contract carries the violation, duplicate
          side-effect and unknown-route series this rule contributes to.
        </p>
        <p style={{ marginTop: "var(--spacing-15)" }}>
          <Link
            className="fr-button fr-button--ghost"
            href={`/projects/${projectId}/integrations/signoz`}
          >
            SigNoz integration
          </Link>
        </p>
      </Section>

      <Section title={VIOLATION.sections[6]} testId="violation-release-context">
        <KeyValues
          entries={[
            ["Release", found.releaseKey ?? "—"],
            ["Contract", `${found.contractId} ${found.contractVersion}`],
            ["Contract hash", bundle?.contractContentHash ?? "—"],
          ]}
        />
      </Section>

      <Section title={VIOLATION.sections[7]} testId="violation-rule">
        <KeyValues
          entries={[
            ["Rule", found.ruleKey],
            ["Rule type", found.ruleType.replace(/_/g, " ")],
            ["Violation key", found.violationKey],
          ]}
        />
      </Section>

      <Section title={VIOLATION.sections[8]} testId="violation-evaluation">
        <KeyValues
          entries={[
            ["Run evaluation", found.runEvaluationId],
            ["Evaluator version", bundle?.evaluatorVersion ?? "—"],
            ["Evaluated at", instant(bundle?.evaluatedAt ?? null)],
            ["Recorded at", instant(found.createdAt)],
          ]}
        />
      </Section>

      <Section title="Actions" testId="violation-actions">
        <div className="fr-row">
          <span className="fr-button fr-button--ghost" aria-disabled="true">
            {VIOLATION.secondaryActions[0]}
          </span>
          <span className="fr-button fr-button--ghost" aria-disabled="true">
            {VIOLATION.secondaryActions[2]}
          </span>
        </div>
        <p className="fr-muted" style={{ marginTop: "var(--spacing-15)", maxWidth: "62ch" }}>
          A violation is never dismissed. A new contract version, or an explicit fixture exclusion,
          is the only way to change this outcome, and both write an audit record.
        </p>
      </Section>
    </div>
  );
}

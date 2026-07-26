import {
  EmptyState,
  GraphTable,
  KeyValues,
  PageHeader,
  Section,
  Status,
  Table,
} from "@flightrules/ui";
import Link from "next/link";
import type { ReactNode } from "react";
import { z } from "zod";
import { CopyButton } from "@/components/copy-button";
import {
  apiGet,
  CanonicalGraphSchema,
  isFailure,
  ViolationEvidenceSchema,
  ViolationSchema,
} from "@/lib/api";
import { VIOLATION } from "@/lib/copy";
import { evidenceSummary } from "@/lib/evidence-summary";
import { findGate, findReleaseDiff } from "@/lib/load";
import { failureState, instant } from "@/lib/view";

/**
 * PRD section 8.12 — Violation Inspector.
 *
 * The page a failure is audited from: rule, to trace evidence, to downstream effect.
 *
 * Two things here are load-bearing and easy to lose:
 *
 * 1. **Highlighting is restricted to what the evaluator named.** The observed-route table marks a
 *    node only when the violation's own evidence lists its canonical index. Nothing searches for a
 *    visually similar step, because a highlight the evaluator did not produce is an assertion the
 *    product cannot defend.
 * 2. **Logs and metrics are fetched on request and can never hide the violation.** They are
 *    separate reads behind `?logs=1` and `?metrics=1`; every failure mode is a typed state on the
 *    panel, and the sections above it do not depend on either.
 *
 * Trace-quality warnings — `client_span_without_server_span`, `unobservable_subtree`,
 * `insufficient_evidence` — are rendered as local context and never as violations of their own. The
 * aborted server span the unsafe canary omits is a fact about what this trace could show, not a
 * separate finding.
 *
 * PRD section 8.12 forbids the product from ever offering "Ignore and pass release". That string
 * appears nowhere in this application, and a route test asserts its absence across every page.
 */

export const dynamic = "force-dynamic";

const LogsSchema = z.object({
  violationId: z.string(),
  traceId: z.string(),
  state: z.string(),
  detail: z.string().nullable(),
  requestedLimit: z.number(),
  logs: z.array(
    z.object({
      timestamp: z.string().nullable(),
      severity: z.string().nullable(),
      service: z.string().nullable(),
      body: z.string(),
    }),
  ),
});

const MetricsSchema = z.object({
  violationId: z.string(),
  state: z.string(),
  detail: z.string().nullable(),
  series: z.array(
    z.object({
      metric: z.string(),
      kind: z.string(),
      summary: z.string(),
      points: z.array(
        z.object({
          value: z.number().nullable(),
          timestamp: z.string().nullable(),
          labels: z.record(z.string(), z.string()),
        }),
      ),
    }),
  ),
});

/** What each metric `kind` means, in the product's own words. PRD Phase 15 requires the distinction. */
const METRIC_KIND_TEXT: Readonly<Record<string, string>> = {
  measured: "Measured. FlightRules recorded this number itself.",
  observed_side_effect:
    "Observed side effect. The evaluator counted this in the trace. It is a count of repetitions, not a measure of their cost.",
  inferred_risk: "Inferred risk. The telemetry makes this plausible and does not prove it.",
  unavailable: "Unavailable. No series exists for this window.",
};

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export default async function ViolationInspectorPage(props: {
  params: Promise<{ projectId: string; violationId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { projectId, violationId } = await props.params;
  const search = await props.searchParams;
  const wantLogs = first(search["logs"]) === "1";
  const wantMetrics = first(search["metrics"]) === "1";

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

  // Everything below is optional context. Not one of these reads can prevent the sections above
  // from rendering, which is what "degrades without hiding the core violation" means in practice.
  const [logs, metrics, gate, diff] = await Promise.all([
    wantLogs ? apiGet(`/api/violations/${violationId}/logs`, LogsSchema) : null,
    wantMetrics ? apiGet(`/api/violations/${violationId}/metrics`, MetricsSchema) : null,
    bundle?.releaseId == null ? null : findGate(bundle.releaseId),
    bundle?.releaseId == null ? null : findReleaseDiff(bundle.releaseId),
  ]);

  const decision = gate === null || isFailure(gate) ? null : gate.data;
  const topology = diff === null || isFailure(diff) ? null : diff.data;
  const observedGraph = CanonicalGraphSchema.safeParse(topology?.candidate?.graph ?? null);
  const approvedGraph = CanonicalGraphSchema.safeParse(topology?.baseline?.graph ?? null);

  // Only the canonical indices the evaluator itself named. Never a search for a similar-looking node.
  const highlighted = new Set(bundle?.canonicalNodes ?? []);
  const highlightedLabels = new Set(bundle?.labels ?? []);

  const traceUrl =
    topology?.representativeFailingTraces.find((trace) => trace.traceId === found.traceId)
      ?.signozWebUrl ??
    topology?.representativePassingTraces.find((trace) => trace.traceId === found.traceId)
      ?.signozWebUrl ??
    found.signozWebUrl;

  // PRD Phase 15: these stay local trace-quality context and never become violations of their own.
  const qualityWarnings = (bundle?.labels ?? []).filter((label) =>
    ["client_span_without_server_span", "unobservable_subtree", "insufficient_evidence"].includes(
      label,
    ),
  );

  const summary = evidenceSummary({
    violation: found,
    evidence: bundle,
    decisionHash: decision?.decisionHash ?? null,
    signozTraceUrl: traceUrl,
    traceQualityWarnings: qualityWarnings,
  });

  const here = `/projects/${projectId}/violations/${violationId}`;

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

      <Section
        title={VIOLATION.sections[1]}
        testId="violation-observed-route"
        description="The route this run actually took. A step is marked as evidence only when the deterministic evaluator named its canonical index — nothing here searches for a step that merely looks similar."
      >
        {bundle === null || (bundle.labels.length === 0 && bundle.canonicalNodes.length === 0) ? (
          <EmptyState
            title="No route evidence was recorded for this violation."
            body="A violation with no positional evidence names an absence rather than a step."
            testId="violation-no-labels"
          />
        ) : (
          <Table
            caption="Every piece of positional evidence the evaluator recorded for this violation"
            testId="violation-evidence-labels"
            // Labels and canonical node indices are **independent** lists: a duplicate side effect
            // names one label and two nodes. Pairing them by position would silently drop the
            // second node, which is half the evidence for the finding this page exists to explain.
            rows={[
              ...bundle.labels.map((label) => ({
                key: `label:${label}`,
                kind: "canonical step",
                value: label,
              })),
              ...bundle.canonicalNodes.map((node) => ({
                key: `node:${String(node)}`,
                kind: "canonical node",
                value: String(node),
              })),
              ...bundle.spanIds.map((spanId) => ({
                key: `span:${spanId}`,
                kind: "span",
                value: spanId,
              })),
            ]}
            rowKey={(row) => row.key}
            empty={<EmptyState title="No evidence." />}
            columns={[
              { key: "kind", header: "Evidence", render: (row) => row.kind },
              {
                key: "value",
                header: "Value",
                render: (row) => <span className="fr-mono">{row.value}</span>,
              },
              {
                key: "role",
                header: "Role",
                render: () => <Status label="proves this violation" emphasis />,
              },
            ]}
          />
        )}

        {observedGraph.success ? (
          <div style={{ marginTop: "var(--spacing-31)" }}>
            <Table
              caption="Every step of the observed run, with the evaluator's evidence marked"
              testId="violation-observed-graph"
              rows={[...observedGraph.data.nodes].sort((a, b) => a.order - b.order)}
              rowKey={(node) => String(node.order)}
              empty={<EmptyState title="No observed topology is stored." />}
              columns={[
                { key: "step", header: "Step", render: (node) => node.label },
                { key: "service", header: "Service", render: (node) => node.service },
                { key: "sideEffect", header: "Side effect", render: (node) => node.sideEffect },
                {
                  key: "evidence",
                  header: "Evidence",
                  render: (node) =>
                    highlighted.has(node.order) || highlightedLabels.has(node.label) ? (
                      <Status label="named by the evaluator" emphasis testId="evidence-node" />
                    ) : (
                      <span className="fr-muted">—</span>
                    ),
                },
              ]}
            />
          </div>
        ) : (
          <p className="fr-muted" style={{ marginTop: "var(--spacing-22)" }}>
            No observed topology is stored for this run, so only the evidence labels above are
            available. This is an absence of context, not of the finding.
          </p>
        )}

        {qualityWarnings.length === 0 ? null : (
          <div
            className="fr-state"
            data-testid="violation-trace-quality"
            role="status"
            style={{ marginTop: "var(--spacing-22)" }}
          >
            <p className="fr-state__title">Trace-quality context</p>
            <p className="fr-state__body">
              {qualityWarnings.join(", ")} — these describe what this trace could not show. They are
              context, not violations, and none of them changes the finding above.
            </p>
          </div>
        )}
      </Section>

      <Section
        title={VIOLATION.sections[2]}
        testId="violation-approved-route"
        description="The approved route family this run was judged against, as the contract's baseline recorded it."
      >
        <GraphTable
          data={approvedGraph.success ? approvedGraph.data : null}
          caption="The approved route, node by node, in canonical order"
          emptyTitle="No approved route is available for comparison."
          emptyBody="This violation's release has no diff, or its contract's baseline approves no route family."
          testId="violation-approved-graph"
        />
        <p style={{ marginTop: "var(--spacing-22)" }}>
          <Link
            className="fr-button fr-button--ghost"
            data-testid="violation-inspect-diff"
            href={
              bundle?.releaseId == null || topology === null
                ? `/projects/${projectId}/overview`
                : `/projects/${projectId}/agents/${topology.agentId}/releases/${bundle.releaseId}`
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

      <Section
        title={VIOLATION.sections[4]}
        testId="violation-logs"
        description="Fetched from SigNoz on request, correlated strictly by this violation's trace identifier — never by a time window or a service name, either of which would attach another run's logs to this finding."
      >
        {logs === null ? (
          <p>
            <Link
              className="fr-button fr-button--ghost"
              data-testid="violation-fetch-logs"
              href={`${here}?logs=1`}
            >
              {VIOLATION.secondaryActions[0]}
            </Link>
          </p>
        ) : isFailure(logs) ? (
          <div className="fr-state" data-testid="violation-logs-degraded" role="status">
            <p className="fr-state__title">Correlated logs could not be fetched.</p>
            <p className="fr-state__body">
              {logs.message} Every section above is unaffected: it is persisted evidence and does
              not depend on SigNoz being reachable.
            </p>
            <p className="fr-mono fr-muted">{logs.code}</p>
          </div>
        ) : (
          <>
            <KeyValues
              testId="violation-logs-state"
              entries={[
                [
                  "Result",
                  <Status key="s" label={logs.data.state} emphasis={logs.data.state !== "ok"} />,
                ],
                [
                  "Correlated by",
                  <span key="t" className="fr-mono">
                    trace_id = {logs.data.traceId}
                  </span>,
                ],
                ["Requested limit", String(logs.data.requestedLimit)],
              ]}
            />
            {logs.data.detail === null ? null : (
              <p className="fr-muted" style={{ marginTop: "var(--spacing-15)", maxWidth: "62ch" }}>
                {logs.data.detail}
              </p>
            )}
            <div style={{ marginTop: "var(--spacing-22)" }}>
              <Table
                caption="Log lines SigNoz holds for this trace"
                testId="violation-logs-table"
                rows={logs.data.logs}
                rowKey={(row) => `${row.timestamp ?? ""}-${row.body.slice(0, 40)}`}
                empty={
                  <EmptyState
                    title="SigNoz holds no log correlated to this trace."
                    body="FlightRules writes structured logs to stdout; exporting them over OTLP is not yet enabled, so this is expected rather than surprising."
                    testId="violation-logs-empty"
                  />
                }
                columns={[
                  { key: "ts", header: "Time", render: (row) => instant(row.timestamp) },
                  { key: "sev", header: "Severity", render: (row) => row.severity ?? "—" },
                  { key: "svc", header: "Service", render: (row) => row.service ?? "—" },
                  { key: "body", header: "Message", render: (row) => row.body },
                ]}
              />
            </div>
          </>
        )}
      </Section>

      <Section
        title={VIOLATION.sections[5]}
        testId="violation-metrics"
        description="What this violation actually caused, and — just as importantly — what kind of claim each number is. FlightRules reports what it measured and what the evaluator observed. It does not estimate a financial loss, because the telemetry does not show one."
      >
        {metrics === null ? (
          <p>
            <Link
              className="fr-button fr-button--ghost"
              data-testid="violation-fetch-metrics"
              href={`${here}?metrics=1`}
            >
              Fetch downstream metrics
            </Link>
          </p>
        ) : isFailure(metrics) ? (
          <div className="fr-state" data-testid="violation-metrics-degraded" role="status">
            <p className="fr-state__title">Downstream metrics could not be fetched.</p>
            <p className="fr-state__body">
              {metrics.message} The violation evidence above is unaffected.
            </p>
            <p className="fr-mono fr-muted">{metrics.code}</p>
          </div>
        ) : (
          <>
            <KeyValues
              testId="violation-metrics-state"
              entries={[
                [
                  "Result",
                  <Status
                    key="s"
                    label={metrics.data.state}
                    emphasis={metrics.data.state !== "ok"}
                  />,
                ],
              ]}
            />
            {metrics.data.detail === null ? null : (
              <p className="fr-muted" style={{ marginTop: "var(--spacing-15)", maxWidth: "62ch" }}>
                {metrics.data.detail}
              </p>
            )}
            <div style={{ marginTop: "var(--spacing-22)" }}>
              <Table
                caption="Metric series associated with this violation, and what kind of claim each one is"
                testId="violation-metrics-table"
                rows={metrics.data.series}
                rowKey={(row) => row.metric}
                empty={<EmptyState title="No metric series is associated with this violation." />}
                columns={[
                  {
                    key: "metric",
                    header: "Metric",
                    render: (row) => <span className="fr-mono">{row.metric}</span>,
                  },
                  {
                    key: "kind",
                    header: "Kind of claim",
                    render: (row) => (
                      <Status
                        label={row.kind.replace(/_/g, " ")}
                        emphasis={row.kind === "observed_side_effect"}
                        testId={`metric-kind-${row.kind}`}
                      />
                    ),
                  },
                  {
                    key: "meaning",
                    header: "Meaning",
                    render: (row) => METRIC_KIND_TEXT[row.kind] ?? row.summary,
                  },
                  {
                    key: "points",
                    header: "Observations",
                    numeric: true,
                    render: (row) => String(row.points.length),
                  },
                  {
                    key: "latest",
                    header: "Latest value",
                    numeric: true,
                    render: (row) => {
                      const last = row.points.at(-1);
                      return last?.value === null || last === undefined ? "—" : String(last.value);
                    },
                  },
                ]}
              />
            </div>
          </>
        )}
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

      <Section
        title="Evidence summary"
        testId="violation-summary"
        description="A deterministic, safe summary for an issue or a review. It carries identifiers, hashes and the evaluator's own expected-versus-observed statement, and no prompt, tool argument, tool result or customer field — because it is assembled from fields that carry none."
      >
        <div className="fr-row">
          <CopyButton
            label={VIOLATION.secondaryActions[2]}
            testId="violation-copy-summary"
            text={summary}
          />
          {traceUrl === null ? (
            <span className="fr-button fr-button--ghost" aria-disabled="true">
              {VIOLATION.primaryCta}
            </span>
          ) : (
            <a
              className="fr-button fr-button--ghost"
              data-testid="violation-signoz-link"
              href={traceUrl}
              rel="noreferrer noopener"
              target="_blank"
            >
              {VIOLATION.primaryCta}
            </a>
          )}
        </div>
        <label
          className="fr-field__label"
          htmlFor="evidence-summary"
          style={{ marginTop: "var(--spacing-22)" }}
        >
          Evidence summary
        </label>
        <textarea
          className="fr-textarea"
          data-testid="violation-summary-text"
          id="evidence-summary"
          readOnly
          spellCheck={false}
          value={summary}
          wrap="off"
        />
        <p className="fr-muted" style={{ marginTop: "var(--spacing-15)", maxWidth: "62ch" }}>
          A violation is never dismissed. A new contract version, or an explicit fixture exclusion,
          is the only way to change this outcome, and both write an audit record.
        </p>
      </Section>
    </div>
  );
}

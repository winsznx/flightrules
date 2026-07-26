import { KeyValues, Section, Status, Table } from "@flightrules/ui";
import type { ReactNode } from "react";
import { z } from "zod";

/**
 * The rejected-trace summary (PRD Phase 13 task 3).
 *
 * A baseline is an absence claim — "no approved run ever did this" — so a reviewer has to be able
 * to see what the miner threw away before believing it. Every number here is the miner's own count,
 * read from the persisted baseline, and the reconciliation line below states explicitly whether
 * `eligible + excluded + duplicates` accounts for everything retrieved.
 *
 * No raw telemetry appears. `ExcludedTrace.detail` is written by the miner from observed facts and
 * never contains payload content, and the trace identifier is an identifier, not a payload.
 */

const CountsSchema = z
  .object({
    tracesDiscovered: z.number(),
    tracesRetrieved: z.number(),
    eligibleRuns: z.number(),
    excludedTraces: z.number(),
    duplicateTraces: z.number(),
    duplicateRuns: z.number(),
    routeFamilies: z.number(),
    rareFamilies: z.number(),
    excludedByReason: z.array(z.object({ reason: z.string(), count: z.number() })),
  })
  .partial();

const RetrievalSchema = z
  .object({
    pages: z.number(),
    batchSize: z.number(),
    maxTraces: z.number(),
    truncated: z.boolean(),
    fieldTypesVerified: z.array(z.string()),
    fieldTypesUnverified: z.array(z.string()),
  })
  .partial();

const ExcludedSchema = z.array(
  z.object({
    traceId: z.string(),
    reason: z.string(),
    detail: z.string(),
    spanCount: z.number().optional(),
    warnings: z.array(z.string()).optional(),
  }),
);

const DisclosuresSchema = z.array(
  z.object({
    code: z.string(),
    subject: z.string(),
    detail: z.string(),
    count: z.number().optional(),
  }),
);

/** Reasons whose meaning a reviewer needs, spelled out. Unknown reasons render their own code. */
const REASON_TEXT: Readonly<Record<string, string>> = {
  TRACE_MALFORMED: "The span rows could not be turned into a graph.",
  TRACE_TOO_LARGE: "More spans than the configured maximum.",
  TRACE_INCOMPLETE: "Orphan spans or a synthetic root, so an absence claim would be unsound.",
  TRACE_INCONSISTENT: "Duplicate records that contradict each other.",
  ROOT_SPAN_MISSING: "No parentless span matched the configured root.",
  RELEASE_ID_MISSING: "No span carried the release attribute.",
  RELEASE_MISMATCH: "The trace carries a different release.",
  ENVIRONMENT_MISMATCH: "The trace carries a different environment.",
  RUN_ID_MISSING: "No span carried the run attribute, so the run cannot be deduplicated.",
  RUN_NOT_SUCCESSFUL: "A span reported an error and the selection asked for successful runs only.",
};

export function RejectedTraces(props: {
  readonly counts: unknown;
  readonly retrieval: unknown;
  readonly excluded: unknown;
  readonly disclosures: unknown;
}): ReactNode {
  const counts = CountsSchema.safeParse(props.counts).data ?? {};
  const retrieval = RetrievalSchema.safeParse(props.retrieval).data ?? {};
  const excluded = ExcludedSchema.safeParse(props.excluded).data ?? [];
  const disclosures = DisclosuresSchema.safeParse(props.disclosures).data ?? [];

  const retrieved = counts.tracesRetrieved ?? 0;
  const eligible = counts.eligibleRuns ?? 0;
  const rejected = counts.excludedTraces ?? 0;
  const duplicates = counts.duplicateTraces ?? 0;
  // PRD Phase 13: "Each count must reconcile with the baseline result." Stated, not assumed.
  const accountedFor = eligible + rejected + duplicates;
  const reconciles = accountedFor === retrieved;

  const number = (value: number | undefined): string => (value === undefined ? "—" : String(value));

  return (
    <>
      <Section title="Retrieved traces" testId="baseline-counts">
        <KeyValues
          testId="baseline-count-values"
          entries={[
            ["Total traces discovered", number(counts.tracesDiscovered)],
            ["Total traces retrieved", number(counts.tracesRetrieved)],
            ["Eligible traces", number(counts.eligibleRuns)],
            ["Excluded traces", number(counts.excludedTraces)],
            ["Duplicate traces", number(counts.duplicateTraces)],
            ["Duplicate runs", number(counts.duplicateRuns)],
            ["Route families", number(counts.routeFamilies)],
            ["Rare families", number(counts.rareFamilies)],
            [
              "Dataset truncated",
              retrieval.truncated === undefined ? (
                "—"
              ) : (
                <Status
                  key="truncated"
                  label={retrieval.truncated ? "truncated" : "complete"}
                  emphasis={retrieval.truncated === true}
                  testId="baseline-truncated"
                />
              ),
            ],
            [
              "Pages walked",
              retrieval.pages === undefined
                ? "—"
                : `${String(retrieval.pages)} of at most ${String(retrieval.maxTraces ?? 0)} trace(s)`,
            ],
            [
              "Untrusted typed attributes",
              (retrieval.fieldTypesUnverified ?? []).join(", ") || "none",
            ],
          ]}
        />
        <p
          className="fr-muted"
          data-testid="baseline-reconciliation"
          style={{ marginTop: "var(--spacing-22)" }}
        >
          {reconciles
            ? `Reconciled: ${String(eligible)} eligible + ${String(rejected)} excluded + ${String(duplicates)} duplicate = ${String(retrieved)} retrieved.`
            : `Not reconciled: ${String(eligible)} eligible + ${String(rejected)} excluded + ${String(duplicates)} duplicate = ${String(accountedFor)}, against ${String(retrieved)} retrieved. Treat this baseline as unexplained.`}
        </p>
      </Section>

      <Section title="Exclusions by reason" testId="baseline-exclusions">
        <Table
          caption="Why the miner refused a trace, grouped by its stable reason code"
          rows={counts.excludedByReason ?? []}
          rowKey={(row) => row.reason}
          empty={<p className="fr-muted">No trace was excluded from this baseline.</p>}
          columns={[
            {
              key: "reason",
              header: "Reason",
              render: (row) => <span className="fr-mono">{row.reason}</span>,
            },
            {
              key: "meaning",
              header: "Meaning",
              render: (row) => REASON_TEXT[row.reason] ?? "—",
            },
            { key: "count", header: "Traces", numeric: true, render: (row) => String(row.count) },
          ]}
        />
      </Section>

      <Section title="Excluded traces" testId="baseline-excluded-traces">
        <Table
          caption="Every trace the miner excluded, with the reason it recorded"
          rows={excluded}
          rowKey={(row) => `${row.traceId}-${row.reason}`}
          empty={<p className="fr-muted">No individual trace exclusion was recorded.</p>}
          columns={[
            {
              key: "trace",
              header: "Trace",
              render: (row) => <span className="fr-mono">{row.traceId}</span>,
            },
            {
              key: "reason",
              header: "Reason",
              render: (row) => <span className="fr-mono">{row.reason}</span>,
            },
            { key: "detail", header: "Detail", render: (row) => row.detail },
            {
              key: "warnings",
              header: "Quality warnings",
              render: (row) => (row.warnings ?? []).join(", ") || "—",
            },
          ]}
        />
      </Section>

      <Section title="Disclosures" testId="baseline-disclosures">
        <Table
          caption="What this baseline is not certain about"
          rows={disclosures}
          rowKey={(row) => `${row.code}-${row.subject}`}
          empty={<p className="fr-muted">The miner recorded no disclosure for this baseline.</p>}
          columns={[
            {
              key: "code",
              header: "Code",
              render: (row) => <span className="fr-mono">{row.code}</span>,
            },
            { key: "subject", header: "Subject", render: (row) => row.subject || "—" },
            { key: "detail", header: "Detail", render: (row) => row.detail },
          ]}
        />
      </Section>
    </>
  );
}

import { GraphTable, KeyValues, PageHeader, Section, Status, Table } from "@flightrules/ui";
import type { ReactNode } from "react";
import { z } from "zod";
import { apiGet, CanonicalGraphSchema, isFailure } from "@/lib/api";
import { ROUTE_FAMILY } from "@/lib/copy";
import { failureState, instant, percent, shortHash } from "@/lib/view";

/**
 * PRD section 8.8 — route family detail.
 *
 * The canonical graph is rendered as the ordered table PRD section 20.3 requires, from the stored
 * canonical form. Nothing on this page is drawn from a template: a family with no stored graph shows
 * the graph empty state, because PRD Phase 12 forbids a fake trace graph in an authenticated route.
 */

export const dynamic = "force-dynamic";

const DistributionSchema = z
  .object({
    count: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    mean: z.number().optional(),
    p50: z.number().optional(),
    p95: z.number().optional(),
    p99: z.number().optional(),
  })
  .nullable();

const StatisticsSchema = z
  .object({
    traceCount: z.number().optional(),
    firstObservedMs: z.number().optional(),
    lastObservedMs: z.number().optional(),
    duration: DistributionSchema.optional(),
    inputTokens: DistributionSchema.optional(),
    outputTokens: DistributionSchema.optional(),
    tools: z.array(z.string()).optional(),
    services: z.array(z.string()).optional(),
    sideEffects: z.array(z.string()).optional(),
    dataDomains: z.array(z.string()).optional(),
    retries: z
      .array(z.object({ group: z.string(), sideEffect: z.string(), maxRetry: z.number() }))
      .optional(),
  })
  .partial();

const FamilySchema = z.object({
  id: z.string(),
  familyIdentifier: z.string(),
  fingerprint: z.string(),
  status: z.string(),
  rare: z.boolean(),
  occurrenceCount: z.number(),
  occurrencePercent: z.string(),
  representativeTraceIds: z.array(z.string()),
  statistics: z.unknown(),
  canonicalGraph: z.unknown(),
  decidedAt: z.string().nullable(),
});

function millis(value: number | undefined): string {
  return value === undefined ? "—" : instant(new Date(value).toISOString());
}

function distribution(
  name: string,
  value: z.infer<typeof DistributionSchema> | undefined,
): ReactNode {
  if (value === undefined || value === null) {
    return <span className="fr-muted">{name} was not observed on this family&rsquo;s runs.</span>;
  }
  return (
    <span>
      p50 {value.p50 ?? "—"} · p95 {value.p95 ?? "—"} · p99 {value.p99 ?? "—"} · max{" "}
      {value.max ?? "—"}
    </span>
  );
}

export default async function RouteFamilyPage(props: {
  params: Promise<{ projectId: string; agentId: string; routeFamilyId: string }>;
}): Promise<ReactNode> {
  const { routeFamilyId } = await props.params;
  const family = await apiGet(`/api/route-families/${routeFamilyId}`, FamilySchema);

  if (isFailure(family)) {
    return (
      <div className="fr-shell" data-testid="route-route-family">
        <PageHeader title={ROUTE_FAMILY.titlePrefix} />
        <Section>{failureState(family)}</Section>
      </div>
    );
  }

  const statistics = StatisticsSchema.safeParse(family.data.statistics);
  const stats = statistics.success ? statistics.data : {};
  const graph = CanonicalGraphSchema.safeParse(family.data.canonicalGraph);

  return (
    <div className="fr-shell" data-testid="route-route-family">
      <PageHeader
        eyebrow={family.data.familyIdentifier}
        title={`${ROUTE_FAMILY.titlePrefix} ${shortHash(family.data.fingerprint.replace("sha256:", ""), 12)}`}
        actions={
          <>
            <Status label={family.data.status.replace(/_/g, " ")} emphasis />
            {family.data.rare ? <Status label="rare" /> : null}
          </>
        }
      />

      <Section title="Observation" testId="family-observation">
        <KeyValues
          entries={[
            ["Occurrence count", String(family.data.occurrenceCount)],
            [
              "Share of baseline runs",
              percent(String(Number(family.data.occurrencePercent) * 100)),
            ],
            ["First observed", millis(stats.firstObservedMs)],
            ["Last observed", millis(stats.lastObservedMs)],
            [
              "Fingerprint",
              <span key="fp" className="fr-mono">
                {family.data.fingerprint}
              </span>,
            ],
            ["Decided", instant(family.data.decidedAt)],
          ]}
        />
      </Section>

      <Section title="Canonical graph" testId="family-graph">
        <GraphTable
          data={graph.success ? graph.data : null}
          caption="The approved route, node by node, in canonical order"
          emptyTitle="No canonical graph is stored for this route family."
          emptyBody="A route family carries the graph its fingerprint was taken over. Re-mine the baseline if this is unexpected."
        />
      </Section>

      <Section title="Surface" testId="family-surface">
        <KeyValues
          entries={[
            ["Tools used", (stats.tools ?? []).join(", ") || "—"],
            ["Services used", (stats.services ?? []).join(", ") || "—"],
            ["Side-effecting operations", (stats.sideEffects ?? []).join(", ") || "—"],
            ["Data domains", (stats.dataDomains ?? []).join(", ") || "—"],
            ["Latency distribution", distribution("Latency", stats.duration ?? null)],
            ["Input token distribution", distribution("Input tokens", stats.inputTokens ?? null)],
            [
              "Output token distribution",
              distribution("Output tokens", stats.outputTokens ?? null),
            ],
          ]}
        />
      </Section>

      <Section title="Retries" testId="family-retries">
        <Table
          caption="Highest attempt index observed per group. Zero means one attempt and no retry."
          rows={stats.retries ?? []}
          rowKey={(entry) => entry.group}
          empty={<p className="fr-muted">No run of this family retried anything.</p>}
          columns={[
            { key: "group", header: "Group", render: (entry) => entry.group },
            { key: "sideEffect", header: "Side effect", render: (entry) => entry.sideEffect },
            {
              key: "maxRetry",
              header: "Highest attempt index",
              numeric: true,
              render: (entry) => String(entry.maxRetry),
            },
          ]}
        />
      </Section>

      <Section title="Representative traces" testId="family-traces">
        <Table
          caption="Traces this family was mined from"
          rows={family.data.representativeTraceIds.map((traceId) => ({ traceId }))}
          rowKey={(row) => row.traceId}
          empty={<p className="fr-muted">No representative trace was recorded.</p>}
          columns={[
            {
              key: "traceId",
              header: "Trace",
              render: (row) => <span className="fr-mono">{row.traceId}</span>,
            },
          ]}
        />
      </Section>

      <Section title="Review actions" testId="family-actions">
        <div className="fr-row">
          {ROUTE_FAMILY.actions.map((action) => (
            <span className="fr-button fr-button--ghost" key={action} aria-disabled="true">
              {action}
            </span>
          ))}
        </div>
        <p className="fr-muted" style={{ marginTop: "var(--spacing-15)" }}>
          Review actions become live in the baseline workflow. Each one writes an audit record.
        </p>
      </Section>
    </div>
  );
}

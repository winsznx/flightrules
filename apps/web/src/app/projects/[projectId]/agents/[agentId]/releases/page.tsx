import { EmptyState, PageHeader, Section, Status, Table } from "@flightrules/ui";
import Link from "next/link";
import type { ReactNode } from "react";
import { type Gate, isFailure } from "@/lib/api";
import { RELEASES } from "@/lib/copy";
import { findAgent, gatesForReleases, listReleases } from "@/lib/load";
import { failureState, instant, percent, signedPercent } from "@/lib/view";

/**
 * PRD section 8.10 — releases list, with the ten columns the PRD names.
 *
 * A release with no completed evaluation shows "not evaluated" rather than a blank or a zero. The
 * difference matters: zero violations and no evaluation look identical in a table that does not say
 * which it is, and the second is not a pass.
 *
 * The status filter is a link, not client state, so every filtered view is a URL a reviewer can send
 * and a test can visit — and the filter still works with JavaScript disabled.
 */

/** PRD section 8.10's decisions, plus the two states a release can be in without one. */
const FILTERS = [
  { key: "all", label: "All" },
  { key: "pass", label: "Pass" },
  { key: "fail", label: "Fail" },
  { key: "insufficient_data", label: "Insufficient data" },
  { key: "error", label: "Error" },
  { key: "not_evaluated", label: "Not evaluated" },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

function filterKeyOf(value: string | string[] | undefined): FilterKey {
  const raw = Array.isArray(value) ? value[0] : value;
  return FILTERS.some((entry) => entry.key === raw) ? (raw as FilterKey) : "all";
}

export const dynamic = "force-dynamic";

export default async function ReleasesPage(props: {
  params: Promise<{ projectId: string; agentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { projectId, agentId } = await props.params;
  const filter = filterKeyOf((await props.searchParams)["decision"]);
  const [agent, releases] = await Promise.all([findAgent(agentId), listReleases(agentId)]);

  if (isFailure(releases)) {
    return (
      <div className="fr-shell" data-testid="route-releases">
        <PageHeader title={RELEASES.title} />
        <Section>{failureState(releases)}</Section>
      </div>
    );
  }

  const gates = await gatesForReleases(releases.data.items);
  const all = releases.data.items.map((release) => {
    const result = gates.get(release.id);
    const gate: Gate | null = result === undefined || isFailure(result) ? null : result.data;
    return { release, gate };
  });
  const rows = all.filter((row) =>
    filter === "all"
      ? true
      : filter === "not_evaluated"
        ? row.gate === null
        : row.gate?.decision === filter,
  );
  const counts = new Map<FilterKey, number>(
    FILTERS.map((entry) => [
      entry.key,
      entry.key === "all"
        ? all.length
        : entry.key === "not_evaluated"
          ? all.filter((row) => row.gate === null).length
          : all.filter((row) => row.gate?.decision === entry.key).length,
    ]),
  );
  const here = `/projects/${projectId}/agents/${agentId}/releases`;

  return (
    <div className="fr-shell" data-testid="route-releases">
      <PageHeader eyebrow={isFailure(agent) ? undefined : agent.data.name} title={RELEASES.title} />

      <Section title="Filter by decision" testId="release-filters">
        <ul className="fr-tabs" data-testid="release-filter-list">
          {FILTERS.map((entry) => (
            <li key={entry.key}>
              <Link
                aria-current={filter === entry.key ? "page" : undefined}
                data-testid={`release-filter-${entry.key}`}
                href={entry.key === "all" ? here : `${here}?decision=${entry.key}`}
              >
                {entry.label} ({counts.get(entry.key) ?? 0})
              </Link>
            </li>
          ))}
        </ul>
      </Section>

      <Section>
        <Table
          caption="Releases observed for this agent, with the decision each one's evidence produced"
          testId="releases-table"
          rows={rows}
          rowKey={(row) => row.release.id}
          empty={
            filter === "all" ? (
              <EmptyState
                title="No release has been observed yet."
                body="A release appears once telemetry carrying its discriminator has been evaluated."
                testId="releases-empty"
              />
            ) : (
              <EmptyState
                title={`No release has that decision.`}
                body={`${String(all.length)} release(s) exist for this agent. Clear the filter to see them.`}
                testId="releases-filtered-empty"
              />
            )
          }
          columns={[
            {
              key: "releaseId",
              header: "Release ID",
              render: (row) => (
                <Link href={`/projects/${projectId}/agents/${agentId}/releases/${row.release.id}`}>
                  {row.release.releaseKey}
                </Link>
              ),
            },
            {
              key: "commit",
              header: "Commit SHA",
              render: (row) =>
                row.release.commitSha === null ? (
                  "—"
                ) : (
                  <span className="fr-mono">{row.release.commitSha.slice(0, 12)}</span>
                ),
            },
            { key: "environment", header: "Environment", render: (row) => row.release.environment },
            {
              key: "firstObserved",
              header: "First observed",
              render: (row) => instant(row.release.firstObservedAt),
            },
            {
              key: "runs",
              header: "Evaluated runs",
              numeric: true,
              render: (row) => (row.gate === null ? "—" : String(row.gate.counts.evaluatedRuns)),
            },
            {
              key: "decision",
              header: "Gate decision",
              render: (row) =>
                row.gate === null ? (
                  <Status label="not evaluated" />
                ) : (
                  <Status label={row.gate.decision.replace("_", " ")} emphasis />
                ),
            },
            {
              key: "violationRate",
              header: "Violation rate",
              numeric: true,
              render: (row) =>
                row.gate === null ? "—" : percent(row.gate.rates.violation.percent),
            },
            {
              key: "unknownRate",
              header: "Unknown route rate",
              numeric: true,
              render: (row) =>
                row.gate === null ? "—" : percent(row.gate.rates.unknownRoute.percent),
            },
            {
              key: "latency",
              header: "Latency change",
              numeric: true,
              render: (row) =>
                row.gate === null ? "—" : signedPercent(row.gate.changes.latency.changePercent),
            },
            {
              key: "tokens",
              header: "Token change",
              numeric: true,
              render: (row) =>
                row.gate === null ? "—" : signedPercent(row.gate.changes.tokens.changePercent),
            },
          ]}
        />
      </Section>
    </div>
  );
}

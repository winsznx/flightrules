import { EmptyState, PageHeader, Section, Stat, Status, Table } from "@flightrules/ui";
import Link from "next/link";
import type { ReactNode } from "react";
import { type Gate, isFailure, type Release } from "@/lib/api";
import { OVERVIEW } from "@/lib/copy";
import {
  findProject,
  gatesForReleases,
  listAgents,
  listArtifacts,
  listReleases,
  listViolations,
} from "@/lib/load";
import { failureState, instant, percent } from "@/lib/view";

/**
 * PRD section 8.4 — project overview, "<Project name> trajectory health".
 *
 * The eight required cards, the "Release decisions" panel and the "Violations by rule" panel.
 *
 * Every figure is computed from a response this page fetched. There is no cached aggregate and no
 * placeholder: a project with no releases shows zeroes and an empty decisions table, which is the
 * truth, rather than a sample chart.
 */

export const dynamic = "force-dynamic";

export default async function OverviewPage(props: {
  params: Promise<{ projectId: string }>;
}): Promise<ReactNode> {
  const { projectId } = await props.params;
  const project = await findProject(projectId);
  if (isFailure(project)) {
    return (
      <div className="fr-shell" data-testid="route-overview">
        <PageHeader title="Project" />
        <Section>{failureState(project)}</Section>
      </div>
    );
  }

  const [agents, violations, artifacts] = await Promise.all([
    listAgents(projectId),
    listViolations(projectId),
    listArtifacts(projectId),
  ]);

  const agentList = isFailure(agents) ? [] : agents.data.items;
  const releaseLists = await Promise.all(agentList.map((agent) => listReleases(agent.id)));
  const releases = releaseLists.flatMap((result) => (isFailure(result) ? [] : result.data.items));
  const gates = await gatesForReleases(releases);

  // Narrowed once, into a plain typed list. A release whose gate answered
  // `RELEASE_INSUFFICIENT_DATA` has not been evaluated, which is a fact about the release rather
  // than a failure of this page, so it is simply absent from the decisions rather than counted.
  const decisions: { readonly release: Release; readonly gate: Gate }[] = [];
  for (const release of releases) {
    const result = gates.get(release.id);
    if (result === undefined || isFailure(result)) continue;
    decisions.push({ release, gate: result.data });
  }

  const evaluated = decisions.length;
  const passed = decisions.filter((entry) => entry.gate.decision === "pass").length;
  const total = (pick: (gate: Gate) => number): number =>
    decisions.reduce((sum, entry) => sum + pick(entry.gate), 0);

  const violatingRuns = total((gate) => gate.counts.failedRuns);
  const unknownRoutes = total((gate) => gate.counts.unknownRouteRuns);
  const duplicates = total((gate) => gate.counts.duplicateSideEffectRuns);

  const artifactRows = isFailure(artifacts) ? [] : artifacts.data.items;
  const lastSync = artifactRows
    .map((artifact) => artifact.lastSyncedAt)
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1);

  const violationRows = isFailure(violations) ? [] : violations.data.items;
  const byRule = new Map<string, number>();
  for (const violation of violationRows) {
    byRule.set(violation.ruleKey, (byRule.get(violation.ruleKey) ?? 0) + 1);
  }
  const ruleRows = [...byRule.entries()]
    .map(([ruleKey, count]) => ({ ruleKey, count }))
    .sort((a, b) => b.count - a.count || (a.ruleKey < b.ruleKey ? -1 : 1));

  return (
    <div className="fr-shell" data-testid="route-overview">
      <PageHeader
        eyebrow={project.data.slug}
        title={`${project.data.name} ${OVERVIEW.titleSuffix}`}
        actions={
          <>
            <Link className="fr-button" href={`/projects/${projectId}/agents`}>
              Agents
            </Link>
            <Link
              className="fr-button fr-button--ghost"
              href={`/projects/${projectId}/integrations/signoz`}
            >
              SigNoz integration
            </Link>
          </>
        }
      />

      <Section testId="overview-cards">
        <div className="fr-grid fr-grid--tight">
          <Stat label={OVERVIEW.cards[0]} value={String(agentList.length)} testId="stat-agents" />
          <Stat label={OVERVIEW.cards[1]} value={String(evaluated)} testId="stat-releases" />
          <Stat
            label={OVERVIEW.cards[2]}
            value={evaluated === 0 ? "—" : `${((passed / evaluated) * 100).toFixed(0)}%`}
            testId="stat-pass-rate"
          />
          <Stat label={OVERVIEW.cards[3]} value={String(violatingRuns)} testId="stat-violating" />
          <Stat label={OVERVIEW.cards[4]} value={String(unknownRoutes)} testId="stat-unknown" />
          <Stat label={OVERVIEW.cards[5]} value={String(duplicates)} testId="stat-duplicates" />
          <Stat
            label={OVERVIEW.cards[6]}
            value={lastSync === undefined ? "never" : instant(lastSync)}
            testId="stat-sync"
          />
          <Stat
            label={OVERVIEW.cards[7]}
            value={isFailure(artifacts) ? "unknown" : `${artifactRows.length} artefacts`}
            testId="stat-signoz"
          />
        </div>
      </Section>

      <Section title={OVERVIEW.mainPanelTitle} testId="overview-decisions">
        <Table
          caption="Every release with a completed evaluation, and the decision its evidence produced"
          rows={decisions}
          rowKey={(entry) => entry.release.id}
          empty={
            <EmptyState
              title="No release has been evaluated yet."
              body="Evaluate a release against its active contract to produce a decision."
            />
          }
          columns={[
            {
              key: "release",
              header: "Release",
              render: (entry) => (
                <Link
                  href={`/projects/${projectId}/agents/${entry.release.agentId}/releases/${entry.release.id}`}
                >
                  {entry.release.releaseKey}
                </Link>
              ),
            },
            {
              key: "environment",
              header: "Environment",
              render: (entry) => entry.release.environment,
            },
            {
              key: "decision",
              header: "Gate decision",
              render: (entry) => <Status label={entry.gate.decision.replace("_", " ")} emphasis />,
            },
            {
              key: "runs",
              header: "Evaluated runs",
              numeric: true,
              render: (entry) => String(entry.gate.counts.evaluatedRuns),
            },
            {
              key: "violation",
              header: "Violation rate",
              numeric: true,
              render: (entry) => percent(entry.gate.rates.violation.percent),
            },
          ]}
        />
      </Section>

      <Section title={OVERVIEW.secondaryPanelTitle} testId="overview-violations">
        <Table
          caption="Violations across this project, grouped by the rule that produced them"
          rows={ruleRows}
          rowKey={(row) => row.ruleKey}
          empty={<EmptyState title="No violations have been recorded in this project." />}
          columns={[
            { key: "rule", header: "Rule", render: (row) => row.ruleKey },
            {
              key: "count",
              header: "Violations",
              numeric: true,
              render: (row) => String(row.count),
            },
          ]}
        />
      </Section>
    </div>
  );
}

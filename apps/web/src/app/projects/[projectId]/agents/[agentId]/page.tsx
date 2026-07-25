import { EmptyState, KeyValues, PageHeader, Section, Status, Table } from "@flightrules/ui";
import Link from "next/link";
import type { ReactNode } from "react";
import { isFailure } from "@/lib/api";
import { AGENT_DETAIL } from "@/lib/copy";
import {
  findAgent,
  findProject,
  listBaselines,
  listContracts,
  listReleases,
  listViolations,
} from "@/lib/load";
import { failureState, instant } from "@/lib/view";

/**
 * PRD section 8.6 — agent detail, with the six tabs the PRD names.
 *
 * The tabs are query-parameter sections rather than client state, so every one of them is a real
 * URL a reviewer can link to and a test can visit, and none of them needs JavaScript to render.
 *
 * The primary call to action follows the PRD exactly: "Capture baseline" when no baseline exists,
 * "Evaluate release" once one does.
 */

export const dynamic = "force-dynamic";

const TAB_KEYS = [
  "overview",
  "routes",
  "contracts",
  "releases",
  "violations",
  "telemetry",
] as const;
type TabKey = (typeof TAB_KEYS)[number];

function tabKeyOf(value: string | undefined): TabKey {
  const found = TAB_KEYS.find((key) => key === value);
  return found ?? "overview";
}

export default async function AgentDetailPage(props: {
  params: Promise<{ projectId: string; agentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { projectId, agentId } = await props.params;
  const search = await props.searchParams;
  const rawTab = search["tab"];
  const tab = tabKeyOf(Array.isArray(rawTab) ? rawTab[0] : rawTab);

  const agent = await findAgent(agentId);
  if (isFailure(agent)) {
    return (
      <div className="fr-shell" data-testid="route-agent">
        <PageHeader title="Agent" />
        <Section>{failureState(agent)}</Section>
      </div>
    );
  }

  const [project, baselines, contracts, releases, violations] = await Promise.all([
    findProject(projectId),
    listBaselines(agentId),
    listContracts(agentId),
    listReleases(agentId),
    listViolations(projectId),
  ]);

  const baselineRows = isFailure(baselines) ? [] : baselines.data.items;
  const contractRows = isFailure(contracts) ? [] : contracts.data.items;
  const releaseRows = isFailure(releases) ? [] : releases.data.items;
  const violationRows = isFailure(violations)
    ? []
    : violations.data.items.filter((violation) =>
        contractRows.some((contract) => contract.id === violation.contractId),
      );
  const activeContract = contractRows.find((contract) => contract.status === "active");
  const hasBaseline = baselineRows.length > 0;

  const base = `/projects/${projectId}/agents/${agentId}`;

  return (
    <div className="fr-shell" data-testid="route-agent">
      <PageHeader
        eyebrow={isFailure(project) ? agent.data.agentKey : project.data.name}
        title={agent.data.name}
        actions={
          hasBaseline ? (
            <Link className="fr-button" href={`${base}/releases`}>
              {AGENT_DETAIL.ctaWithBaseline}
            </Link>
          ) : (
            <Link className="fr-button" href={`${base}/baselines/new`}>
              {AGENT_DETAIL.ctaNoBaseline}
            </Link>
          )
        }
      />

      <ul className="fr-tabs" data-testid="agent-tabs">
        {AGENT_DETAIL.tabs.map((label, index) => {
          const key = TAB_KEYS[index] as TabKey;
          return (
            <li key={label}>
              <Link
                href={key === "overview" ? base : `${base}?tab=${key}`}
                aria-current={tab === key ? "page" : undefined}
              >
                {label}
              </Link>
            </li>
          );
        })}
      </ul>

      {tab === "overview" ? (
        <Section title="Overview" testId="tab-overview">
          <KeyValues
            entries={[
              ["Agent key", agent.data.agentKey],
              ["Workflow matcher", agent.data.workflowNameMatcher],
              ["Release attribute", agent.data.releaseAttributeKey],
              ["Environment attribute", agent.data.environmentAttributeKey],
              ["Normaliser configuration", agent.data.normaliserConfigId],
              ["Baselines", String(baselineRows.length)],
              [
                "Active contract",
                activeContract === undefined ? (
                  "none"
                ) : (
                  <Link key="active-contract" href={`${base}/contracts/${activeContract.id}`}>
                    {activeContract.contractKey} {activeContract.semanticVersion}
                  </Link>
                ),
              ],
            ]}
          />
        </Section>
      ) : null}

      {tab === "routes" ? (
        <Section title="Routes" testId="tab-routes">
          <Table
            caption="Baselines captured for this agent, and the route families they contain"
            rows={baselineRows}
            rowKey={(baseline) => baseline.id}
            empty={
              <EmptyState
                title="No baseline has been captured yet."
                body="Capture a known-good baseline to mine this agent's route families."
                action={
                  <Link className="fr-button" href={`${base}/baselines/new`}>
                    {AGENT_DETAIL.ctaNoBaseline}
                  </Link>
                }
              />
            }
            columns={[
              {
                key: "identifier",
                header: "Baseline",
                render: (baseline) => baseline.baselineIdentifier,
              },
              {
                key: "status",
                header: "Status",
                render: (baseline) => <Status label={baseline.status.replace(/_/g, " ")} />,
              },
              {
                key: "environment",
                header: "Environment",
                render: (baseline) => baseline.environment ?? "—",
              },
              {
                key: "created",
                header: "Captured",
                render: (baseline) => instant(baseline.createdAt),
              },
            ]}
          />
        </Section>
      ) : null}

      {tab === "contracts" ? (
        <Section title="Contracts" testId="tab-contracts">
          <Table
            caption="Contract versions for this agent, newest first"
            rows={contractRows}
            rowKey={(contract) => contract.id}
            empty={
              <EmptyState
                title="No contract has been proposed yet."
                body="Approve a route family on a captured baseline, then propose a contract from it."
              />
            }
            columns={[
              {
                key: "version",
                header: "Version",
                render: (contract) => (
                  <Link href={`${base}/contracts/${contract.id}`}>{contract.semanticVersion}</Link>
                ),
              },
              {
                key: "status",
                header: "Status",
                render: (contract) => (
                  <Status label={contract.status} emphasis={contract.status === "active"} />
                ),
              },
              {
                key: "environment",
                header: "Environment",
                render: (contract) => contract.environment,
              },
              {
                key: "hash",
                header: "Content hash",
                render: (contract) => <span className="fr-mono">{contract.contentHash}</span>,
              },
            ]}
          />
        </Section>
      ) : null}

      {tab === "releases" ? (
        <Section title="Releases" testId="tab-releases">
          <Table
            caption="Releases observed for this agent"
            rows={releaseRows}
            rowKey={(release) => release.id}
            empty={
              <EmptyState
                title="No release has been observed yet."
                body="A release appears once telemetry carrying its discriminator has been evaluated."
              />
            }
            columns={[
              {
                key: "release",
                header: "Release",
                render: (release) => (
                  <Link href={`${base}/releases/${release.id}`}>{release.releaseKey}</Link>
                ),
              },
              {
                key: "environment",
                header: "Environment",
                render: (release) => release.environment,
              },
              {
                key: "observed",
                header: "Last observed",
                render: (release) => instant(release.lastObservedAt),
              },
            ]}
          />
        </Section>
      ) : null}

      {tab === "violations" ? (
        <Section title="Violations" testId="tab-violations">
          <Table
            caption="Violations recorded against this agent's contracts"
            rows={violationRows}
            rowKey={(violation) => violation.id}
            empty={<EmptyState title="No violation has been recorded for this agent." />}
            columns={[
              {
                key: "rule",
                header: "Rule",
                render: (violation) => (
                  <Link href={`/projects/${projectId}/violations/${violation.id}`}>
                    {violation.ruleKey}
                  </Link>
                ),
              },
              {
                key: "severity",
                header: "Severity",
                render: (violation) => (
                  <Status label={violation.severity} emphasis={violation.zeroTolerance} />
                ),
              },
              {
                key: "release",
                header: "Release",
                render: (violation) => violation.releaseKey ?? "—",
              },
              {
                key: "observed",
                header: "Observed",
                render: (violation) => instant(violation.createdAt),
              },
            ]}
          />
        </Section>
      ) : null}

      {tab === "telemetry" ? (
        <Section title="Telemetry" testId="tab-telemetry">
          <KeyValues
            entries={[
              ["Release discriminator", agent.data.releaseAttributeKey],
              ["Environment discriminator", agent.data.environmentAttributeKey],
              ["Service matchers", agent.data.serviceMatchers.join(", ") || "—"],
              ["Workflow name matcher", agent.data.workflowNameMatcher],
            ]}
          />
          <p className="fr-muted" style={{ marginTop: "var(--spacing-22)", maxWidth: "62ch" }}>
            FlightRules reads this agent&rsquo;s telemetry through the SigNoz MCP Server. The
            managed dashboards, views and alerts compiled from its active contract are listed on the
            SigNoz integration page.
          </p>
          <p style={{ marginTop: "var(--spacing-22)" }}>
            <Link
              className="fr-button fr-button--ghost"
              href={`/projects/${projectId}/integrations/signoz`}
            >
              SigNoz integration
            </Link>
          </p>
        </Section>
      ) : null}
    </div>
  );
}

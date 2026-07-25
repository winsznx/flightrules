import { EmptyState, PageHeader, Section, Table } from "@flightrules/ui";
import Link from "next/link";
import type { ReactNode } from "react";
import { isFailure } from "@/lib/api";
import { AGENTS } from "@/lib/copy";
import { findProject, listAgents } from "@/lib/load";
import { failureState } from "@/lib/view";

/** PRD section 8.5 — agents list. */

export const dynamic = "force-dynamic";

export default async function AgentsPage(props: {
  params: Promise<{ projectId: string }>;
}): Promise<ReactNode> {
  const { projectId } = await props.params;
  const [project, agents] = await Promise.all([findProject(projectId), listAgents(projectId)]);

  return (
    <div className="fr-shell" data-testid="route-agents">
      <PageHeader
        eyebrow={isFailure(project) ? undefined : project.data.name}
        title={AGENTS.title}
      />

      <Section>
        {isFailure(agents) ? (
          failureState(agents)
        ) : (
          <Table
            caption="Instrumented agents registered in this project"
            testId="agents-table"
            rows={agents.data.items}
            rowKey={(agent) => agent.id}
            empty={
              <EmptyState
                title={AGENTS.empty}
                body={`${AGENTS.cta} through the API; registration requires a release discriminator, so it is a server-side operation.`}
              />
            }
            columns={[
              {
                key: "name",
                header: "Agent",
                render: (agent) => (
                  <Link href={`/projects/${projectId}/agents/${agent.id}`}>{agent.name}</Link>
                ),
              },
              { key: "key", header: "Key", render: (agent) => agent.agentKey },
              {
                key: "workflow",
                header: "Workflow matcher",
                render: (agent) => agent.workflowNameMatcher,
              },
              {
                key: "release",
                header: "Release attribute",
                render: (agent) => agent.releaseAttributeKey,
              },
            ]}
          />
        )}
      </Section>
    </div>
  );
}

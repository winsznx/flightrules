import { EmptyState, PageHeader, Section, Table } from "@flightrules/ui";
import Link from "next/link";
import type { ReactNode } from "react";
import { apiGet, isFailure, ProjectSchema, page } from "@/lib/api";
import { PROJECTS } from "@/lib/copy";
import { failureState, instant } from "@/lib/view";

/** PRD section 8.3 — projects route. */

export const dynamic = "force-dynamic";

export default async function ProjectsPage(): Promise<ReactNode> {
  const result = await apiGet("/api/projects?limit=100", page(ProjectSchema));

  return (
    <div className="fr-shell" data-testid="route-projects">
      <PageHeader title={PROJECTS.title} />

      <Section>
        {isFailure(result) ? (
          failureState(result)
        ) : (
          <Table
            caption="Projects grouping agents, contracts, releases and SigNoz artifacts"
            testId="projects-table"
            rows={result.data.items}
            rowKey={(project) => project.id}
            empty={
              <EmptyState
                title={PROJECTS.empty}
                body={`${PROJECTS.cta} through the API or the demo route; project creation is a server-side operation.`}
              />
            }
            columns={[
              {
                key: "name",
                header: "Project",
                render: (project) => (
                  <Link href={`/projects/${project.id}/overview`}>{project.name}</Link>
                ),
              },
              { key: "slug", header: "Slug", render: (project) => project.slug },
              {
                key: "environment",
                header: "Default environment",
                render: (project) => project.defaultEnvironment,
              },
              {
                key: "created",
                header: "Created",
                render: (project) => instant(project.createdAt),
              },
            ]}
          />
        )}
      </Section>
    </div>
  );
}

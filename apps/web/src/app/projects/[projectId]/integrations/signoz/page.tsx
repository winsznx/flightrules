import {
  DegradedState,
  EmptyState,
  KeyValues,
  PageHeader,
  Section,
  Status,
  Table,
} from "@flightrules/ui";
import type { ReactNode } from "react";
import {
  type Artifact,
  apiGet,
  CapabilitiesSchema,
  DependenciesSchema,
  isFailure,
} from "@/lib/api";
import { INTEGRATION, STATES } from "@/lib/copy";
import { findProject, listArtifacts } from "@/lib/load";
import { failureState, instant } from "@/lib/view";

/** PRD section 8.13 — SigNoz integration, with the eight required sections. */

export const dynamic = "force-dynamic";

const SIGNOZ_UI_URL = process.env["SIGNOZ_PUBLIC_URL"] ?? "http://localhost:8080";

function byType(artifacts: readonly Artifact[], type: string): readonly Artifact[] {
  return artifacts.filter((artifact) => artifact.artifactType === type);
}

function artifactTable(caption: string, rows: readonly Artifact[], testId: string): ReactNode {
  return (
    <Table
      caption={caption}
      testId={testId}
      rows={rows}
      rowKey={(artifact) => artifact.id}
      empty={
        <EmptyState
          title="None is managed yet."
          body="Synchronise an active contract to compile this artefact type into SigNoz."
        />
      }
      columns={[
        { key: "name", header: "Managed name", render: (artifact) => artifact.managedName },
        {
          key: "status",
          header: "Status",
          render: (artifact) => (
            <Status label={artifact.status} emphasis={artifact.status !== "synced"} />
          ),
        },
        {
          key: "verified",
          header: "Read-back verified",
          render: (artifact) => instant(artifact.lastVerifiedAt),
        },
        {
          key: "resource",
          header: "SigNoz resource",
          render: (artifact) =>
            artifact.signozResourceId === null ? (
              "—"
            ) : (
              <span className="fr-mono">{artifact.signozResourceId}</span>
            ),
        },
      ]}
    />
  );
}

export default async function SignozIntegrationPage(props: {
  params: Promise<{ projectId: string }>;
}): Promise<ReactNode> {
  const { projectId } = await props.params;
  const [project, dependencies, capabilities, artifacts] = await Promise.all([
    findProject(projectId),
    apiGet("/health/dependencies", DependenciesSchema),
    apiGet("/api/setup/signoz/capabilities", CapabilitiesSchema),
    listArtifacts(projectId),
  ]);

  const rows = isFailure(artifacts) ? [] : artifacts.data.items;
  const summary = isFailure(artifacts) ? {} : artifacts.data.summary;
  const signoz = isFailure(dependencies) ? null : dependencies.data.signoz;
  const discovered = isFailure(capabilities) ? null : capabilities.data;

  return (
    <div className="fr-shell" data-testid="route-integration">
      <PageHeader
        eyebrow={isFailure(project) ? undefined : project.data.name}
        title={INTEGRATION.title}
        actions={
          <a className="fr-button fr-button--ghost" href={SIGNOZ_UI_URL} rel="noreferrer noopener">
            {INTEGRATION.actions[3]}
          </a>
        }
      />

      <Section title={INTEGRATION.sections[0]} testId="integration-connection">
        {signoz === null ? (
          failureState({
            kind: "failure",
            code: "SIGNOZ_UNREACHABLE",
            message: "FlightRules could not read its dependency report.",
            status: null,
          })
        ) : signoz.status === "degraded" ? (
          <DegradedState title={STATES.degradedTitle} detail={STATES.degradedBody} />
        ) : (
          <KeyValues
            entries={[
              ["SigNoz", <Status key="s" label={signoz.status} emphasis />],
              ["Missing required tools", signoz.missingTools.join(", ") || "none"],
              ["Connection profile", discovered?.status ?? "unverified"],
              ["Last verified", instant(discovered?.lastVerifiedAt ?? null)],
            ]}
          />
        )}
      </Section>

      <Section title={INTEGRATION.sections[1]} testId="integration-capabilities">
        <Table
          caption="Tools the connected SigNoz MCP Server exposes"
          rows={(discovered?.capabilities?.toolNames ?? []).map((name) => ({ name }))}
          rowKey={(row) => row.name}
          empty={
            <EmptyState
              title="No capability snapshot has been taken."
              body={`Run ${INTEGRATION.actions[0]} on the setup page to discover this deployment's tools.`}
            />
          }
          columns={[{ key: "name", header: "Tool", render: (row) => row.name }]}
        />
      </Section>

      <Section title={INTEGRATION.sections[2]} testId="integration-fields">
        <p className="fr-muted" style={{ maxWidth: "62ch" }}>
          Telemetry field discovery runs against the connected tenant when an agent is registered,
          so a release or environment discriminator is checked against the fields SigNoz actually
          holds rather than assumed.
        </p>
      </Section>

      <Section title={INTEGRATION.sections[3]} testId="integration-dashboards">
        {artifactTable(
          "Managed dashboards compiled from an active contract",
          byType(rows, "dashboard"),
          "artifacts-dashboards",
        )}
      </Section>

      <Section title={INTEGRATION.sections[4]} testId="integration-alerts">
        {artifactTable("Managed alerts", byType(rows, "alert"), "artifacts-alerts")}
      </Section>

      <Section title={INTEGRATION.sections[5]} testId="integration-views">
        {artifactTable("Managed saved views", byType(rows, "saved_view"), "artifacts-views")}
      </Section>

      <Section title={INTEGRATION.sections[6]} testId="integration-channels">
        {artifactTable(
          "Managed notification channels",
          byType(rows, "notification_channel"),
          "artifacts-channels",
        )}
      </Section>

      <Section title={INTEGRATION.sections[7]} testId="integration-sync">
        <KeyValues
          entries={Object.keys(summary)
            .sort()
            .map((key) => [key, String(summary[key] ?? 0)] as const)}
        />
        <p className="fr-muted" style={{ marginTop: "var(--spacing-22)", maxWidth: "62ch" }}>
          Every managed resource is written and then read back by identifier, and the fields that
          matter are compared. A mismatch fails the synchronisation and is recorded against the
          artefact, so the register always says which one disagreed.
        </p>
      </Section>
    </div>
  );
}

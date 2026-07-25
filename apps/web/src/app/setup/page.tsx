import {
  Card,
  DegradedState,
  KeyValues,
  PageHeader,
  Section,
  Status,
  SuccessState,
  Table,
} from "@flightrules/ui";
import type { ReactNode } from "react";
import { apiGet, CapabilitiesSchema, DependenciesSchema, isFailure } from "@/lib/api";
import { SETUP, STATES } from "@/lib/copy";
import { failureState, instant } from "@/lib/view";

/**
 * PRD section 8.2 — connect FlightRules to SigNoz.
 *
 * The six steps are the PRD's, and each reports what the API actually observed rather than a
 * checkbox somebody ticked. Nothing on this page can reach SigNoz: the browser talks to the
 * FlightRules API and the API talks to SigNoz, which is the reason the page can promise that
 * "credentials stay on the server and are never exposed to the browser".
 */

export const dynamic = "force-dynamic";

export default async function SetupPage(): Promise<ReactNode> {
  const [dependencies, capabilities] = await Promise.all([
    apiGet("/health/dependencies", DependenciesSchema),
    apiGet("/api/setup/signoz/capabilities", CapabilitiesSchema),
  ]);

  if (isFailure(dependencies)) {
    return (
      <div className="fr-shell" data-testid="route-setup">
        <PageHeader title={SETUP.title} description={SETUP.description} />
        <Section>{failureState(dependencies)}</Section>
      </div>
    );
  }

  const signoz = dependencies.data.signoz;
  const discovered = isFailure(capabilities) ? null : capabilities.data;
  const tools = discovered?.capabilities?.toolNames ?? [];
  const missing = discovered?.capabilities?.requiredMissing ?? [];

  return (
    <div className="fr-shell" data-testid="route-setup">
      <PageHeader
        eyebrow="Setup"
        title={SETUP.title}
        description={SETUP.description}
        actions={
          <form action="/setup" method="get">
            <button className="fr-button" type="submit">
              {SETUP.primaryCta}
            </button>
          </form>
        }
      />

      <Section title="Connection" testId="setup-connection">
        {signoz.status === "up" ? (
          <SuccessState message={SETUP.success} />
        ) : signoz.status === "degraded" ? (
          <DegradedState title={STATES.degradedTitle} detail={STATES.degradedBody} />
        ) : (
          <div className="fr-state fr-state--error" role="alert" data-testid="setup-failure">
            <p className="fr-state__title">{SETUP.failure}</p>
          </div>
        )}

        <div style={{ marginTop: "var(--spacing-31)" }}>
          <KeyValues
            testId="setup-summary"
            entries={[
              ["Database", <Status key="db" label={dependencies.data.database.status} />],
              ["SigNoz", <Status key="sz" label={signoz.status} emphasis />],
              ["Connection profile", discovered?.status ?? "unverified"],
              ["Last verified", instant(discovered?.lastVerifiedAt ?? null)],
              ["Required tools missing", missing.length === 0 ? "none" : missing.join(", ")],
            ]}
          />
        </div>
      </Section>

      <Section title="Verification steps" testId="setup-steps">
        <ol className="fr-steps">
          {SETUP.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </Section>

      <Section title="Discovered tool capabilities" testId="setup-tools">
        <Table
          caption="MCP tools the connected SigNoz server exposes"
          rows={tools.map((name) => ({ name }))}
          rowKey={(row) => row.name}
          columns={[{ key: "name", header: "Tool", render: (row) => row.name }]}
          empty={
            <Card title="No capability snapshot yet">
              <p className="fr-muted">
                Run {SETUP.primaryCta} to discover the tools this SigNoz deployment exposes.
              </p>
            </Card>
          }
        />
      </Section>
    </div>
  );
}

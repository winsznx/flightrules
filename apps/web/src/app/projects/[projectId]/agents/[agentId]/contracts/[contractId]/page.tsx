import { EmptyState, KeyValues, PageHeader, Section, Status, Table } from "@flightrules/ui";
import type { ReactNode } from "react";
import { z } from "zod";
import { apiGet, isFailure } from "@/lib/api";
import { CONTRACT_STUDIO } from "@/lib/copy";
import { findContract } from "@/lib/load";
import { failureState, instant } from "@/lib/view";

/**
 * PRD section 8.9 — Contract Studio.
 *
 * Phase 12 lays the studio: the contract's identity and lifecycle status, its rules, its gate
 * thresholds, the exported YAML, and the five actions the PRD names. Phase 13 makes the YAML
 * editable, adds the graph rule controls and wires validate, approve, activate, export and sync.
 *
 * The unsaved warning is rendered from the PRD's own sentence whenever the stored document does not
 * validate, so the studio never presents an approvable state it should refuse.
 */

export const dynamic = "force-dynamic";

const ExportSchema = z.object({ yaml: z.string(), contentHash: z.string() });

const GateSpecSchema = z
  .object({
    minCompletedRuns: z.number(),
    evaluationTimeoutSeconds: z.number(),
    maxViolationPercent: z.object({ text: z.string() }),
    maxUnknownRoutePercent: z.object({ text: z.string() }),
    maxLatencyRegressionPercent: z.object({ text: z.string() }),
    maxTokenRegressionPercent: z.object({ text: z.string() }),
    zeroToleranceRuleIds: z.array(z.string()),
  })
  .partial();

export default async function ContractStudioPage(props: {
  params: Promise<{ projectId: string; agentId: string; contractId: string }>;
}): Promise<ReactNode> {
  const { contractId } = await props.params;
  const contract = await findContract(contractId);

  if (isFailure(contract)) {
    return (
      <div className="fr-shell" data-testid="route-contract-studio">
        <PageHeader title={CONTRACT_STUDIO.title} />
        <Section>{failureState(contract)}</Section>
      </div>
    );
  }

  const exported = await apiGet(`/api/contracts/${contractId}/export`, ExportSchema);
  const rules = contract.data.rules ?? [];
  const canonical = contract.data.canonical as { spec?: { gate?: unknown } } | undefined;
  const gate = GateSpecSchema.safeParse(canonical?.spec?.gate ?? {});
  const gateSpec = gate.success ? gate.data : {};
  const invalid = contract.data.validationErrors.length > 0 || contract.data.status === "invalid";

  return (
    <div className="fr-shell" data-testid="route-contract-studio">
      <PageHeader
        eyebrow={`${contract.data.contractKey} ${contract.data.semanticVersion}`}
        title={CONTRACT_STUDIO.title}
        actions={
          <Status
            label={contract.data.status}
            emphasis={contract.data.status === "active"}
            testId="contract-status"
          />
        }
      />

      {invalid ? (
        <Section testId="contract-unsaved">
          <div className="fr-state fr-state--error" role="alert">
            <p className="fr-state__title">{CONTRACT_STUDIO.unsavedWarning}</p>
          </div>
        </Section>
      ) : null}

      <Section title="Identity" testId="contract-identity">
        <KeyValues
          entries={[
            ["Name", contract.data.name],
            ["Environment", contract.data.environment],
            ["Schema version", contract.data.schemaVersion],
            ["Source", contract.data.source],
            [
              "Content hash",
              <span key="hash" className="fr-mono">
                {contract.data.contentHash}
              </span>,
            ],
            ["Approved", instant(contract.data.approvedAt)],
            ["Activated", instant(contract.data.activatedAt)],
            ["Superseded", instant(contract.data.supersededAt)],
          ]}
        />
      </Section>

      <Section title="Gate" testId="contract-gate">
        <KeyValues
          entries={[
            ["Minimum completed runs", String(gateSpec.minCompletedRuns ?? "—")],
            ["Evaluation timeout", `${String(gateSpec.evaluationTimeoutSeconds ?? "—")} s`],
            ["Maximum violation percent", gateSpec.maxViolationPercent?.text ?? "—"],
            ["Maximum unknown route percent", gateSpec.maxUnknownRoutePercent?.text ?? "—"],
            ["Maximum latency regression", gateSpec.maxLatencyRegressionPercent?.text ?? "—"],
            ["Maximum token regression", gateSpec.maxTokenRegressionPercent?.text ?? "—"],
            ["Zero-tolerance rules", (gateSpec.zeroToleranceRuleIds ?? []).join(", ") || "none"],
          ]}
        />
      </Section>

      <Section title="Rules" testId="contract-rules">
        <Table
          caption="Every rule this contract version enforces"
          rows={rules}
          rowKey={(rule) => rule.ruleKey}
          empty={<EmptyState title="This contract declares no rules." />}
          columns={[
            { key: "id", header: "Rule", render: (rule) => rule.ruleKey },
            { key: "type", header: "Type", render: (rule) => rule.ruleType.replace(/_/g, " ") },
            {
              key: "severity",
              header: "Severity",
              render: (rule) => <Status label={rule.severity} emphasis={rule.zeroTolerance} />,
            },
            {
              key: "zeroTolerance",
              header: "Zero tolerance",
              render: (rule) => (rule.zeroTolerance ? "yes" : "no"),
            },
            {
              key: "basis",
              header: "Evidence basis",
              render: (rule) =>
                rule.evidenceBasis === null ? "authored" : "mined from the approved baseline",
            },
          ]}
        />
      </Section>

      <Section title="Graph node rule controls" testId="contract-graph-controls">
        <div className="fr-row">
          {CONTRACT_STUDIO.graphNodeRuleControls.map((control) => (
            <span className="fr-status" key={control}>
              {control}
            </span>
          ))}
        </div>
        <p className="fr-muted" style={{ marginTop: "var(--spacing-15)", maxWidth: "62ch" }}>
          These are the constraints a reviewer can place on a node of the approved route. They
          become interactive alongside the YAML editor.
        </p>
      </Section>

      <Section title="Document" testId="contract-yaml">
        {isFailure(exported) ? (
          failureState(exported)
        ) : (
          <>
            <label className="fr-field__label" htmlFor="contract-yaml-document">
              Contract YAML
            </label>
            <textarea
              className="fr-textarea"
              id="contract-yaml-document"
              readOnly
              spellCheck={false}
              defaultValue={exported.data.yaml}
              style={{ marginTop: "var(--spacing-11)" }}
            />
            <p className="fr-muted fr-mono" style={{ marginTop: "var(--spacing-11)" }}>
              {exported.data.contentHash}
            </p>
          </>
        )}
      </Section>

      <Section title="Actions" testId="contract-actions">
        <div className="fr-row">
          {CONTRACT_STUDIO.actions.map((action) => (
            <span className="fr-button fr-button--ghost" key={action} aria-disabled="true">
              {action}
            </span>
          ))}
        </div>
        <p className="fr-muted" style={{ marginTop: "var(--spacing-15)", maxWidth: "62ch" }}>
          Each action is a server-side lifecycle transition that writes an audit record. They are
          available through the API and the CLI today, and become buttons here in the Contract
          Studio phase.
        </p>
      </Section>
    </div>
  );
}

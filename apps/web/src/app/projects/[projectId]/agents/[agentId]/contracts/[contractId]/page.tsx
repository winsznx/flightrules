import { EmptyState, Field, KeyValues, PageHeader, Section, Status, Table } from "@flightrules/ui";
import Link from "next/link";
import type { ReactNode } from "react";
import { z } from "zod";
import { JobPanel } from "@/components/job-progress";
import { OutcomeBanner } from "@/components/outcome-banner";
import { SubmitButton } from "@/components/submit-button";
import { type EditorError, YamlEditor } from "@/components/yaml-editor";
import { apiGet, isFailure } from "@/lib/api";
import { CONTRACT_STUDIO } from "@/lib/copy";
import { findContract, listArtifacts } from "@/lib/load";
import { readOutcome } from "@/lib/outcome";
import { failureState, instant } from "@/lib/view";
import {
  activateContract,
  applyControl,
  approveContract,
  saveContract,
  syncSignoz,
  validateContract,
} from "./actions";

/**
 * PRD section 8.9 — Contract Studio.
 *
 * The studio has two editing surfaces over **one** document. The YAML editor writes the text; the
 * graph rule controls write a named transformation of the same text through
 * `applyRuleControl`. Both go through the same `PUT`, and the control state below is read back out
 * of the stored document by `controlStateOf` rather than remembered — so a hand edit that deletes a
 * rule turns its control off on the next render without a second update path, which is PRD Phase
 * 13's "YAML edit changes graph rule state predictably" direction.
 *
 * `Sync to SigNoz` reports the artifact register's read-back verified state, never the MCP write's
 * own answer (ADR-0009, PRD Phase 10).
 */

export const dynamic = "force-dynamic";

const ExportSchema = z.object({
  contractId: z.string(),
  contentHash: z.string(),
  yaml: z.string(),
});

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

const ValidationErrorSchema = z.object({
  path: z.string(),
  code: z.string(),
  message: z.string(),
  line: z.number().nullable().optional(),
});

/**
 * Fields PRD Phase 13 requires for every proposed rule, read from the rule's evidence basis.
 *
 * `unknown` rather than a strict shape because the basis is the miner's, and a rule authored by
 * hand has none at all. Every field is rendered as "not recorded" when absent rather than omitted,
 * so a reviewer can tell the difference between a rule with no evidence and a rule whose evidence
 * this page forgot to show.
 */
const EvidenceBasisSchema = z
  .object({
    basis: z.string(),
    observed: z.string(),
    recommended: z.string(),
    support: z.union([z.string(), z.number()]),
    sampleSize: z.number(),
    familyFingerprints: z.array(z.string()),
    traceIds: z.array(z.string()),
    observedMin: z.union([z.string(), z.number()]).nullable(),
    observedMax: z.union([z.string(), z.number()]).nullable(),
    recommendedMax: z.union([z.string(), z.number()]).nullable(),
    outlierDisclosed: z.boolean(),
    requiresConfirmation: z.boolean(),
  })
  .partial();

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const text = (value: string | number | null | undefined): string =>
  value === null || value === undefined ? "not recorded" : String(value);

export default async function ContractStudioPage(props: {
  params: Promise<{ projectId: string; agentId: string; contractId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { projectId, agentId, contractId } = await props.params;
  const search = await props.searchParams;
  const outcome = readOutcome(search);
  const jobId = first(search["job"]);

  const contract = await findContract(contractId);

  if (isFailure(contract)) {
    return (
      <div className="fr-shell" data-testid="route-contract-studio">
        <PageHeader title={CONTRACT_STUDIO.title} />
        <Section>{failureState(contract)}</Section>
      </div>
    );
  }

  const [exported, artifacts] = await Promise.all([
    apiGet(`/api/contracts/${contractId}/export`, ExportSchema),
    listArtifacts(projectId),
  ]);

  const rules = contract.data.rules ?? [];
  const canonical = contract.data.canonical as { spec?: { gate?: unknown } } | undefined;
  const gateSpec = GateSpecSchema.safeParse(canonical?.spec?.gate ?? {}).data ?? {};

  const validationErrors: EditorError[] =
    z
      .array(ValidationErrorSchema)
      .safeParse(contract.data.validationErrors)
      .data?.map((error) => ({
        path: error.path,
        code: error.code,
        message: error.message,
        line: error.line ?? null,
      })) ?? [];

  const status = contract.data.status;
  const invalid = validationErrors.length > 0 || status === "invalid";
  const editable = status === "draft";
  const validatedNow = first(search["validated"]) === "1";
  const savedNow = first(search["saved"]) === "1";

  // The PRD's own sentence, shown whenever the studio is in a state approval must refuse. It is a
  // statement about the document, not about the browser's copy of it: the server-side approve guard
  // re-derives exactly the same fact before it will transition anything.
  const unvalidated = editable && (invalid || (savedNow && !validatedNow));

  // Every step the canonical graph names, so the rule controls address real nodes rather than a
  // free-text box. The names come from the contract's own selectors, which came from the baseline.
  const nodes = [
    ...new Set(
      rules.flatMap((rule) => {
        const shape = rule.rule as {
          selector?: { name?: unknown };
          from?: { name?: unknown };
          to?: { name?: unknown };
          ancestor?: { name?: unknown };
          descendant?: { name?: unknown };
        };
        return [
          shape.selector?.name,
          shape.from?.name,
          shape.to?.name,
          shape.ancestor?.name,
          shape.descendant?.name,
        ].filter((name): name is string => typeof name === "string");
      }),
    ),
  ].sort();

  const managed = isFailure(artifacts) ? null : artifacts.data;
  const verified = managed?.items.filter((entry) => entry.lastVerifiedAt !== null).length ?? 0;

  const base = `/projects/${projectId}/agents/${agentId}`;
  const here = `${base}/contracts/${contractId}`;

  /** The hidden identifiers every action form on this page needs. */
  const identity = (
    <>
      <input name="projectId" type="hidden" value={projectId} />
      <input name="agentId" type="hidden" value={agentId} />
      <input name="contractId" type="hidden" value={contractId} />
    </>
  );

  return (
    <div className="fr-shell" data-testid="route-contract-studio">
      <PageHeader
        eyebrow={`${contract.data.contractKey} ${contract.data.semanticVersion}`}
        title={CONTRACT_STUDIO.title}
        actions={<Status label={status} emphasis={status === "active"} testId="contract-status" />}
      />

      <OutcomeBanner outcome={outcome} />

      {unvalidated ? (
        <Section testId="contract-unsaved">
          <div className="fr-state fr-state--error" role="alert" data-testid="contract-unvalidated">
            <p className="fr-state__title">{CONTRACT_STUDIO.unsavedWarning}</p>
          </div>
        </Section>
      ) : null}

      <Section title="Actions" testId="contract-actions">
        <div className="fr-row">
          <form action={validateContract}>
            {identity}
            <SubmitButton pendingLabel="Validating…" testId="contract-validate">
              {CONTRACT_STUDIO.actions[0]}
            </SubmitButton>
          </form>

          <form action={approveContract}>
            {identity}
            <SubmitButton ghost pendingLabel="Approving…" testId="contract-approve">
              {CONTRACT_STUDIO.actions[1]}
            </SubmitButton>
          </form>

          <form action={activateContract}>
            {identity}
            <SubmitButton ghost pendingLabel="Activating…" testId="contract-activate">
              Activate version
            </SubmitButton>
          </form>

          <form action={syncSignoz}>
            {identity}
            <SubmitButton ghost pendingLabel="Syncing…" testId="contract-sync">
              {CONTRACT_STUDIO.actions[2]}
            </SubmitButton>
          </form>

          <a
            className="fr-button fr-button--ghost"
            data-testid="contract-export"
            download={`${contract.data.contractKey}-${contract.data.semanticVersion}.yaml`}
            href={`${here}/export`}
          >
            {CONTRACT_STUDIO.actions[3]}
          </a>

          <Link className="fr-button fr-button--ghost" href={`${base}/releases`}>
            {CONTRACT_STUDIO.actions[4]}
          </Link>
        </div>
        <p className="fr-muted" style={{ marginTop: "var(--spacing-15)", maxWidth: "62ch" }}>
          Each lifecycle action is a server-side transition that writes an audit record. Approval is
          refused while the stored document has unvalidated changes, and activation is refused for
          anything that is not already approved — both checks are made on the server, against the
          stored document, not against this page.
        </p>
      </Section>

      <JobPanel jobId={jobId} title="Artifact sync" />

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

      <Section
        title="SigNoz artifacts"
        testId="contract-artifacts"
        description="Read-back verified state from the FlightRules artifact register. A successful MCP write is not evidence on its own."
      >
        {managed === null ? (
          <p className="fr-muted">The artifact register could not be read.</p>
        ) : (
          <>
            <KeyValues
              testId="contract-artifact-summary"
              entries={[
                ["Managed artifacts", String(managed.items.length)],
                ["Read-back verified", String(verified)],
                ["Drifted", String(managed.summary["drifted"] ?? 0)],
                ["Conflicts", String(managed.summary["conflict"] ?? 0)],
                ["Failed", String(managed.summary["failed"] ?? 0)],
              ]}
            />
            <Table
              caption="Every SigNoz resource FlightRules manages for this project"
              rows={managed.items}
              rowKey={(entry) => entry.id}
              empty={<EmptyState title="No SigNoz artifact has been compiled yet." />}
              columns={[
                { key: "name", header: "Artifact", render: (entry) => entry.managedName },
                { key: "type", header: "Type", render: (entry) => entry.artifactType },
                {
                  key: "status",
                  header: "Status",
                  render: (entry) => (
                    <Status label={entry.status} emphasis={entry.status !== "synced"} />
                  ),
                },
                {
                  key: "verified",
                  header: "Verified",
                  render: (entry) => instant(entry.lastVerifiedAt),
                },
                {
                  key: "link",
                  header: "In SigNoz",
                  render: (entry) =>
                    entry.signozWebUrl === null ? (
                      "—"
                    ) : (
                      <a href={entry.signozWebUrl} rel="noreferrer noopener" target="_blank">
                        Open
                      </a>
                    ),
                },
              ]}
            />
          </>
        )}
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

      <Section
        title="Proposed rules"
        testId="contract-rules"
        description="Every rule, with the evidence the miner recorded for it. A recommended bound is not the observed maximum; where they differ, the outlier is disclosed and a human decision is required."
      >
        <Table
          caption="Every rule this contract version enforces, and the evidence behind it"
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
              key: "selector",
              header: "Selector",
              render: (rule) => {
                const shape = rule.rule as { selector?: { name?: unknown } };
                return typeof shape.selector?.name === "string" ? shape.selector.name : "—";
              },
            },
            {
              key: "basis",
              header: "Evidence basis",
              render: (rule) => {
                const basis = EvidenceBasisSchema.safeParse(rule.evidenceBasis).data;
                if (basis === undefined || rule.evidenceBasis === null) {
                  return "authored by hand — no mined evidence";
                }
                return basis.basis ?? "mined";
              },
            },
            {
              key: "support",
              header: "Support",
              render: (rule) => {
                const basis = EvidenceBasisSchema.safeParse(rule.evidenceBasis).data;
                if (basis === undefined) return "—";
                return `${text(basis.support)} over ${text(basis.sampleSize)} run(s)`;
              },
            },
            {
              key: "range",
              header: "Observed range",
              render: (rule) => {
                const basis = EvidenceBasisSchema.safeParse(rule.evidenceBasis).data;
                if (basis === undefined) return "—";
                return `${text(basis.observedMin)} to ${text(basis.observedMax)}`;
              },
            },
            {
              key: "recommended",
              header: "Recommended bound",
              render: (rule) => {
                const basis = EvidenceBasisSchema.safeParse(rule.evidenceBasis).data;
                if (basis === undefined) return "—";
                return text(basis.recommendedMax);
              },
            },
            {
              key: "outlier",
              header: "Outlier disclosed",
              render: (rule) => {
                const basis = EvidenceBasisSchema.safeParse(rule.evidenceBasis).data;
                if (basis?.outlierDisclosed === true) {
                  return (
                    <Status label="outlier disclosed" emphasis testId="rule-outlier-disclosed" />
                  );
                }
                return "no";
              },
            },
            {
              key: "confirm",
              header: "Needs confirmation",
              render: (rule) => {
                const basis = EvidenceBasisSchema.safeParse(rule.evidenceBasis).data;
                return basis?.requiresConfirmation === true ? (
                  <Status label="confirm before approval" emphasis />
                ) : (
                  "no"
                );
              },
            },
            {
              key: "validation",
              header: "Validation",
              render: () => (invalid ? <Status label="invalid" emphasis /> : "valid"),
            },
          ]}
        />
      </Section>

      <Section
        title="Graph node rule controls"
        testId="contract-graph-controls"
        description="Each control is a deterministic change to the contract document. It is applied by the shared contract editor, re-validated by the same parser that validates a hand edit, and saved by the same write — so the graph and the YAML cannot disagree."
      >
        {nodes.length === 0 ? (
          <EmptyState
            title="This contract names no step yet."
            body="Propose a contract from an approved baseline, or add a rule in the document below."
          />
        ) : (
          <form action={applyControl} className="fr-stack" data-testid="rule-control-form">
            {identity}
            <div className="fr-grid fr-grid--tight">
              <Field id="control-node" label="Step">
                {(attributes) => (
                  <select {...attributes} className="fr-select" name="node">
                    {nodes.map((node) => (
                      <option key={node} value={node}>
                        {node}
                      </option>
                    ))}
                  </select>
                )}
              </Field>

              <Field id="control-kind" label="Constraint">
                {(attributes) => (
                  <select {...attributes} className="fr-select" name="control">
                    {CONTRACT_STUDIO.graphNodeRuleControls.map((label, index) => (
                      <option
                        key={label}
                        value={
                          [
                            "required",
                            "optional",
                            "forbidden",
                            "maximum_calls",
                            "must_precede",
                            "must_descend_from",
                            "side_effect",
                            "sensitive_data_domain",
                          ][index]
                        }
                      >
                        {label}
                      </option>
                    ))}
                  </select>
                )}
              </Field>

              <Field
                id="control-other"
                label="Related step"
                hint="Required by Must precede and Must descend from."
              >
                {(attributes) => (
                  <select {...attributes} className="fr-select" name="other" defaultValue="">
                    <option value="">—</option>
                    {nodes.map((node) => (
                      <option key={node} value={node}>
                        {node}
                      </option>
                    ))}
                  </select>
                )}
              </Field>

              <Field id="control-limit" label="Maximum calls" hint="Required by Maximum calls.">
                {(attributes) => (
                  <input
                    {...attributes}
                    className="fr-input"
                    max={1000}
                    min={0}
                    name="limit"
                    type="number"
                  />
                )}
              </Field>

              <Field
                id="control-value"
                label="Required value"
                hint="Required by Side effect and Sensitive data domain."
              >
                {(attributes) => (
                  <input {...attributes} className="fr-input" name="value" type="text" />
                )}
              </Field>
            </div>
            <div>
              <SubmitButton pendingLabel="Applying…" testId="rule-control-apply" ghost={!editable}>
                Apply constraint
              </SubmitButton>
            </div>
            {editable ? null : (
              <p className="fr-muted">
                This version is immutable, so a control here will be refused. Create a new draft to
                change the contract.
              </p>
            )}
          </form>
        )}
      </Section>

      <Section title="Document" testId="contract-yaml">
        {isFailure(exported) ? (
          failureState(exported)
        ) : (
          <YamlEditor
            contentHash={exported.data.contentHash}
            editable={editable}
            errors={validationErrors}
            saveAction={saveContract.bind(null, { projectId, agentId, contractId })}
            unsavedWarning={CONTRACT_STUDIO.unsavedWarning}
            value={exported.data.yaml}
          />
        )}
      </Section>
    </div>
  );
}

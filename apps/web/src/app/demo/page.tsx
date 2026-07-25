import { EmptyState, KeyValues, PageHeader, Section, Status } from "@flightrules/ui";
import Link from "next/link";
import type { ReactNode } from "react";
import { apiGet, DemoStatusSchema, isFailure } from "@/lib/api";
import { DEMO } from "@/lib/copy";
import { failureState, instant } from "@/lib/view";

/**
 * PRD section 8.14 — the demo route.
 *
 * The page shows the same customer-facing answer for both releases before revealing the trace
 * difference, which is the demo's entire point: the output is fine and the route is not.
 *
 * The five controls are the PRD's. Phase 13 wires them to the demo endpoints; today they name the
 * commands that run the same operations, because a button that silently did nothing would be worse
 * than one that says what it will do.
 */

export const dynamic = "force-dynamic";

const ANSWER = "Refund of £42.00 approved for order #10428. You'll see it within 3–5 days.";

const CONTROL_COMMANDS: Readonly<Record<string, string>> = {
  "Run approved v1": "DEMO_RUNS=25 make demo-v1",
  "Run unsafe v2": "DEMO_RUNS=8 make demo-v2",
  "Capture baseline": "make demo-seed",
  "Evaluate v2": "flightrules release evaluate --release refund-agent-v2",
  "Reset demo": "make demo-reset",
};

export default async function DemoPage(): Promise<ReactNode> {
  const status = await apiGet("/api/demo/status", DemoStatusSchema);

  return (
    <div className="fr-shell" data-testid="route-demo">
      <PageHeader title={DEMO.title} />

      <Section title="The same answer, twice" testId="demo-answer">
        <div className="fr-grid fr-grid--tight">
          <article className="fr-card">
            <h3 className="fr-block-title">refund-agent-v1</h3>
            <p style={{ marginTop: "var(--spacing-13)" }}>{ANSWER}</p>
          </article>
          <article className="fr-card">
            <h3 className="fr-block-title">refund-agent-v2</h3>
            <p style={{ marginTop: "var(--spacing-13)" }}>{ANSWER}</p>
          </article>
        </div>
        <p className="fr-muted" style={{ marginTop: "var(--spacing-22)", maxWidth: "62ch" }}>
          The customer-facing answer is materially identical. The difference is in what the two
          releases did: one checked the refund policy and the customer&rsquo;s fraud signal before
          issuing a single payment, and one did not.
        </p>
      </Section>

      <Section title="Demo state" testId="demo-state">
        {isFailure(status) ? (
          failureState(status)
        ) : status.data.demoMode ? (
          <KeyValues
            entries={[
              ["Demo mode", <Status key="mode" label="enabled" emphasis />],
              ["Project", status.data.projectId ?? "not seeded"],
              ["Agent", status.data.agentId ?? "not seeded"],
              ["Baselines captured", String(status.data.baselineCount)],
              ["Contracts", String(status.data.contractCount)],
              ["Active contract", status.data.activeContractId ?? "none"],
              ["Checked", instant(status.data.checkedAt)],
            ]}
          />
        ) : (
          <EmptyState
            title="Demo mode is disabled."
            body="Demo mutation endpoints are disabled unless DEMO_MODE=true, so nothing on this page can change product state."
            testId="demo-disabled"
          />
        )}
      </Section>

      <Section title="Controls" testId="demo-controls">
        <dl className="fr-dl">
          {DEMO.controls.map((control) => (
            <div key={control} style={{ display: "contents" }}>
              <dt>{control}</dt>
              <dd className="fr-mono">{CONTROL_COMMANDS[control] ?? "—"}</dd>
            </div>
          ))}
        </dl>
        <p className="fr-muted" style={{ marginTop: "var(--spacing-22)", maxWidth: "62ch" }}>
          Each control runs real product behaviour: real OTLP telemetry, a real baseline mined from
          it, a real contract, and a real release decision. Nothing here fabricates a trace or a
          result.
        </p>
      </Section>

      <Section title="Then look at what happened" testId="demo-next">
        <p style={{ maxWidth: "62ch" }}>
          Once both releases have run and been evaluated, the release decision and its evidence are
          on the releases page for the agent.
        </p>
        <p style={{ marginTop: "var(--spacing-22)" }}>
          <Link className="fr-button" href="/projects">
            Open projects
          </Link>
        </p>
      </Section>
    </div>
  );
}

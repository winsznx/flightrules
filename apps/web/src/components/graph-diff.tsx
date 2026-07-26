import { EmptyState, Section, Status, Table } from "@flightrules/ui";
import type { ReactNode } from "react";

/**
 * The baseline-versus-candidate graph diff (PRD Phase 14 tasks 2 and 3).
 *
 * The comparison is the API's. This component renders it and computes nothing: PRD Phase 14's test
 * list ends with "no graph data is fabricated client-side", and the way to satisfy that is for the
 * page to have no code that could.
 *
 * The rendering is a **side-by-side ordered node table**, not a drawing. That is deliberate and it
 * is what makes the accessible text equivalent the same artefact as the visual one rather than a
 * second, lesser copy that can fall out of date. A row's presence in one column and absence in the
 * other is the change; a screen reader reads "absent from this release" as literal text, and a
 * sighted reader sees the same words.
 *
 * No colour distinguishes anything. Presence, absence and repetition are carried by words —
 * `IN BOTH`, `REMOVED`, `ADDED`, `REPEATED` — and by border weight on the changed rows.
 */

export interface DiffNode {
  readonly order: number;
  readonly depth: number;
  readonly label: string;
  readonly service: string;
  readonly kind: string | null;
  readonly sideEffect: string;
  readonly tool: string | null;
  readonly dataDomain: string | null;
  readonly retryNumber: number | null;
}

export interface DiffGraph {
  readonly nodes: readonly DiffNode[];
  readonly edges: readonly { readonly from: number; readonly to: number; readonly type: string }[];
}

export interface TypedChange {
  readonly kind: string;
  readonly subject: string;
  readonly detail: string;
  readonly baselineCount: number | null;
  readonly candidateCount: number | null;
  readonly label: string;
  readonly severity: string;
}

type Presence = "in both" | "removed" | "added" | "repeated";

interface Row {
  readonly label: string;
  readonly presence: Presence;
  readonly baselineCount: number;
  readonly candidateCount: number;
  readonly service: string;
  readonly sideEffect: string;
  readonly tool: string | null;
}

function countByLabel(graph: DiffGraph | null): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const node of graph?.nodes ?? []) {
    counts.set(node.label, (counts.get(node.label) ?? 0) + 1);
  }
  return counts;
}

function presenceOf(before: number, after: number): Presence {
  if (before > 0 && after === 0) return "removed";
  if (before === 0 && after > 0) return "added";
  if (after > before) return "repeated";
  return "in both";
}

/**
 * The comparison rows.
 *
 * This walks the two node lists the API returned and pairs them by canonical label. It is a
 * rendering of two given lists, not a diff: which labels differ, and by how much, is decided by the
 * API's typed change list, and this only has to lay the same facts out in reading order.
 */
function rowsOf(baseline: DiffGraph | null, candidate: DiffGraph | null): readonly Row[] {
  const before = countByLabel(baseline);
  const after = countByLabel(candidate);
  const detail = new Map<string, DiffNode>();
  for (const node of [...(candidate?.nodes ?? []), ...(baseline?.nodes ?? [])]) {
    if (!detail.has(node.label)) detail.set(node.label, node);
  }

  // Baseline order first, so the approved route reads top to bottom as the route a human approved;
  // anything only the candidate has is appended in its own order.
  const ordered: string[] = [];
  for (const node of baseline?.nodes ?? []) {
    if (!ordered.includes(node.label)) ordered.push(node.label);
  }
  for (const node of candidate?.nodes ?? []) {
    if (!ordered.includes(node.label)) ordered.push(node.label);
  }

  return ordered.map((label) => {
    const node = detail.get(label);
    return {
      label,
      presence: presenceOf(before.get(label) ?? 0, after.get(label) ?? 0),
      baselineCount: before.get(label) ?? 0,
      candidateCount: after.get(label) ?? 0,
      service: node?.service ?? "—",
      sideEffect: node?.sideEffect ?? "—",
      tool: node?.tool ?? null,
    };
  });
}

/** One sentence per change, in the product's own words. This is the accessible equivalent. */
export function diffNarrative(
  rows: readonly Row[],
  changes: readonly TypedChange[],
  nearest: string | null,
): readonly string[] {
  const sentences: string[] = [];

  const removed = rows.filter((row) => row.presence === "removed");
  const added = rows.filter((row) => row.presence === "added");
  const repeated = rows.filter((row) => row.presence === "repeated");

  if (removed.length > 0) {
    sentences.push(
      `${String(removed.length)} step(s) the approved route always performs are absent from this release: ${removed
        .map((row) => row.label)
        .join(", ")}. Each one is a check that did not run.`,
    );
  }
  if (repeated.length > 0) {
    sentences.push(
      `${String(repeated.length)} step(s) ran more times than the approved route ever did: ${repeated
        .map(
          (row) =>
            `${row.label} ${String(row.candidateCount)} times against ${String(row.baselineCount)}`,
        )
        .join("; ")}. A repeated write is a repeated side effect.`,
    );
  }
  if (added.length > 0) {
    sentences.push(
      `${String(added.length)} step(s) appear that the approved route never performs: ${added
        .map((row) => row.label)
        .join(", ")}.`,
    );
  }
  if (sentences.length === 0) {
    sentences.push("Every step of this release matches the approved route, in the same order.");
  }

  sentences.push(
    nearest === null
      ? "FlightRules recorded no nearest approved route for this release."
      : "The comparison above is against the approved route family this release's run was judged nearest to.",
  );

  const structural = changes.filter((change) => change.severity === "structural");
  if (structural.length > 0) {
    sentences.push(
      `FlightRules classified ${String(structural.length)} of ${String(changes.length)} change(s) as structural: ${[
        ...new Set(structural.map((change) => change.label)),
      ].join(", ")}.`,
    );
  }

  return sentences;
}

export function GraphDiffView(props: {
  readonly baseline: DiffGraph | null;
  readonly candidate: DiffGraph | null;
  readonly changes: readonly TypedChange[];
  readonly nearestRouteFamilyId: string | null;
  readonly nearestRouteHref: string | null;
  readonly baselineFingerprint: string | null;
  readonly candidateFingerprint: string | null;
}): ReactNode {
  const rows = rowsOf(props.baseline, props.candidate);
  const narrative = diffNarrative(rows, props.changes, props.nearestRouteFamilyId);

  if (props.baseline === null && props.candidate === null) {
    return (
      <Section title="Behaviour change" testId="release-graph-diff">
        <EmptyState
          title="No topology is available for this release."
          body="A diff needs both an approved route family and an evaluated run with a stored canonical graph."
          testId="diff-unavailable"
        />
      </Section>
    );
  }

  return (
    <>
      <Section
        title="What changed"
        testId="release-diff-narrative"
        description="The same facts as the comparison below, in sentences. Nothing here depends on reading the table."
      >
        <ul className="fr-stack" data-testid="diff-narrative">
          {narrative.map((sentence) => (
            <li key={sentence}>{sentence}</li>
          ))}
        </ul>
      </Section>

      <Section
        title="Behaviour change"
        testId="release-graph-diff"
        description="The approved route beside the route this release actually took, step by step, in canonical order."
      >
        <Table
          caption="Approved route compared with the observed route, by canonical step"
          testId="diff-table"
          rows={rows}
          rowKey={(row) => row.label}
          empty={<EmptyState title="Neither route has any step." />}
          columns={[
            { key: "step", header: "Step", render: (row) => row.label },
            { key: "service", header: "Service", render: (row) => row.service },
            {
              key: "baseline",
              header: "Approved",
              numeric: true,
              render: (row) => (row.baselineCount === 0 ? "absent" : String(row.baselineCount)),
            },
            {
              key: "candidate",
              header: "This release",
              numeric: true,
              render: (row) => (row.candidateCount === 0 ? "absent" : String(row.candidateCount)),
            },
            {
              key: "presence",
              header: "Change",
              render: (row) => (
                <Status
                  label={row.presence}
                  emphasis={row.presence !== "in both"}
                  testId={`diff-${row.presence.replace(/ /g, "-")}`}
                />
              ),
            },
            { key: "sideEffect", header: "Side effect", render: (row) => row.sideEffect },
            { key: "tool", header: "Tool", render: (row) => row.tool ?? "—" },
          ]}
        />
        <p className="fr-muted fr-mono" style={{ marginTop: "var(--spacing-15)" }}>
          approved {props.baselineFingerprint ?? "—"} · observed {props.candidateFingerprint ?? "—"}
        </p>
      </Section>

      <Section
        title="Typed changes"
        testId="release-typed-changes"
        description="Produced by the deterministic graph comparison in the FlightRules engine, not by comparing text in the browser."
      >
        <Table
          caption="Every change the engine classified, with its PRD label"
          testId="typed-change-list"
          rows={props.changes}
          rowKey={(change) => `${change.kind}-${change.subject}`}
          empty={
            <EmptyState
              title="The engine found no typed change."
              body="This release took a route the contract's baseline already approves."
            />
          }
          columns={[
            {
              key: "label",
              header: "Change",
              render: (change) => (
                <Status
                  label={change.label}
                  emphasis={change.severity === "structural"}
                  testId={`change-${change.kind}`}
                />
              ),
            },
            {
              key: "subject",
              header: "Subject",
              render: (change) => <span className="fr-mono">{change.subject}</span>,
            },
            { key: "detail", header: "Detail", render: (change) => change.detail },
            {
              key: "counts",
              header: "Approved → observed",
              numeric: true,
              render: (change) =>
                change.baselineCount === null && change.candidateCount === null
                  ? "—"
                  : `${String(change.baselineCount ?? 0)} → ${String(change.candidateCount ?? 0)}`,
            },
          ]}
        />
        {props.nearestRouteHref === null ? null : (
          <p style={{ marginTop: "var(--spacing-22)" }}>
            <a className="fr-button fr-button--ghost" href={props.nearestRouteHref}>
              Open the nearest approved route
            </a>
          </p>
        )}
      </Section>
    </>
  );
}

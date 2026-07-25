import type { ReactNode } from "react";
import { EmptyState, Table } from "./components.js";

/**
 * The graph table fallback (PRD Phase 12 task 8, PRD section 20.3: "graph has a table or list
 * alternative").
 *
 * This is not a degraded view that appears when something fails. It is the canonical rendering of a
 * route: the same ordered node list the fingerprint is taken over, readable by a screen reader,
 * copyable, and diffable between two releases. A visual graph, when one exists, is an addition to
 * it.
 *
 * It renders only what the stored canonical graph contains. PRD Phase 12 forbids a fake trace graph
 * in an authenticated route, so an absent graph is the empty state, never a placeholder shape.
 */

export interface GraphTableNode {
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

export interface GraphTableEdge {
  readonly from: number;
  readonly to: number;
  readonly type: string;
}

export interface GraphTableData {
  readonly nodes: readonly GraphTableNode[];
  readonly edges: readonly GraphTableEdge[];
}

/** Indentation carries depth for a sighted reader; the depth column carries it for everyone else. */
function indent(depth: number): string {
  return depth === 0 ? "" : `${"  ".repeat(depth)}`;
}

export function GraphTable(props: {
  readonly data: GraphTableData | null;
  readonly caption: string;
  readonly emptyTitle: string;
  readonly emptyBody: string;
  readonly testId?: string | undefined;
}): ReactNode {
  if (props.data === null || props.data.nodes.length === 0) {
    return <EmptyState title={props.emptyTitle} body={props.emptyBody} testId="graph-empty" />;
  }

  const byOrder = new Map(props.data.nodes.map((node) => [node.order, node]));
  const parents = new Map<number, string[]>();
  for (const edge of props.data.edges) {
    const from = byOrder.get(edge.from);
    const existing = parents.get(edge.to) ?? [];
    existing.push(from === undefined ? String(edge.from) : from.label);
    parents.set(edge.to, existing);
  }

  return (
    <Table
      caption={props.caption}
      testId={props.testId ?? "graph-table"}
      rows={[...props.data.nodes].sort((a, b) => a.order - b.order)}
      rowKey={(node) => String(node.order)}
      empty={<EmptyState title={props.emptyTitle} body={props.emptyBody} />}
      columns={[
        {
          key: "step",
          header: "Step",
          render: (node) => (
            <span>
              {indent(node.depth)}
              {node.label}
            </span>
          ),
        },
        { key: "service", header: "Service", render: (node) => node.service },
        { key: "kind", header: "Kind", render: (node) => node.kind ?? "—" },
        { key: "tool", header: "Tool", render: (node) => node.tool ?? "—" },
        { key: "sideEffect", header: "Side effect", render: (node) => node.sideEffect },
        { key: "dataDomain", header: "Data domain", render: (node) => node.dataDomain ?? "—" },
        {
          key: "retry",
          header: "Attempt",
          numeric: true,
          // `retryNumber` is an attempt index: 0 or absent is the first attempt.
          render: (node) => String((node.retryNumber ?? 0) + 1),
        },
        {
          key: "after",
          header: "Follows",
          render: (node) => (parents.get(node.order) ?? []).join(", ") || "—",
        },
      ]}
    />
  );
}

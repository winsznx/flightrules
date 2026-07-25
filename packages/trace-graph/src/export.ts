import { redact } from "@flightrules/domain";
import { canonicaliseGraph } from "./canonical.js";
import type { TraceGraph } from "./model.js";

/**
 * Safe graph export (PRD Phase 06 task 12).
 *
 * "Safe" means two things. Every value passes through the domain redactor, so a secret that
 * reached a span attribute cannot reach an exported file. And the export is deterministic, so two
 * exports of the same graph are byte-identical and can be diffed or checked into evidence.
 */

export interface GraphExportOptions {
  /**
   * Include per-span evidence attributes and span IDs. Off by default: the canonical form is what
   * a reviewer needs, and the identifiers are only useful when linking back to SigNoz.
   */
  readonly includeEvidence?: boolean;
}

export interface ExportedGraph {
  readonly traceId: string;
  readonly quality: string;
  readonly warnings: readonly { readonly kind: string; readonly message: string }[];
  readonly normaliserVersion: string;
  readonly normaliserConfigHash: string;
  readonly canonical: unknown;
  readonly evidence?: unknown;
}

export function exportGraph(graph: TraceGraph, options: GraphExportOptions = {}): ExportedGraph {
  const canonical = canonicaliseGraph(graph);

  const base: ExportedGraph = {
    traceId: graph.traceId,
    quality: graph.quality,
    // Span IDs are omitted from the warning list here; they belong with the evidence block.
    warnings: graph.warnings.map((warning) => ({ kind: warning.kind, message: warning.message })),
    normaliserVersion: graph.normaliserVersion,
    normaliserConfigHash: graph.normaliserConfigHash,
    canonical: redact(canonical),
  };

  if (options.includeEvidence !== true) return base;

  return {
    ...base,
    evidence: redact(
      graph.nodes.map((node) => ({
        spanId: node.spanId,
        canonicalName: node.canonicalName,
        service: node.serviceName,
        sideEffect: node.sideEffect,
        retryNumber: node.retryNumber,
        attributes: node.evidence,
      })),
    ),
  };
}

/** Stable JSON, suitable for an evidence file or a golden test. */
export function exportGraphJson(graph: TraceGraph, options: GraphExportOptions = {}): string {
  return `${JSON.stringify(exportGraph(graph, options), null, 2)}\n`;
}

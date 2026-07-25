import type { CanonicalGraph } from "./canonical.js";

/**
 * Measurements taken from a stored canonical graph, for release-level aggregation (PRD FR-011).
 *
 * These read persisted evidence rather than re-fetching traces from SigNoz, so a release decision
 * can be recomputed from the database alone and a CI run can be replayed from an evidence file.
 * Pure: no clock, no I/O, no dependence on the order a row arrived in.
 */

/**
 * Retries observed in one run.
 *
 * `retryNumber` is the attempt index the agent emitted: `0` or absent is the first attempt, `1` is
 * the first retry. The run's retry count is therefore the sum of the positive attempt indices, which
 * is the number of extra attempts the run made. Counting spans instead would count every first
 * attempt as a retry.
 */
export function retryCountOf(graph: CanonicalGraph): number {
  let total = 0;
  for (const node of graph.nodes) {
    if (node.retryNumber !== null && node.retryNumber > 0) total += node.retryNumber;
  }
  return total;
}

import { classifyTrace, type EligibilityContext, type RetrievedTrace } from "./eligibility.js";
import type { EligibleRun, ExcludedTrace, ExclusionReason } from "./model.js";
import { EXCLUSION_REASONS } from "./model.js";
import { compareStrings } from "./safety.js";

/**
 * The eligible and excluded halves of one mining dataset, with counts that close.
 *
 * Deduplication lives here rather than in `classifyTrace` because it is the one judgement that needs
 * the whole dataset: whether a trace is a repeat depends on what else was retrieved.
 */

export interface MiningDataset {
  /** Sorted by trace identifier, so the dataset does not depend on retrieval order. */
  readonly eligible: readonly EligibleRun[];
  /** Sorted by reason then trace identifier. */
  readonly excluded: readonly ExcludedTrace[];
  readonly tracesDiscovered: number;
  readonly tracesRetrieved: number;
  readonly duplicateTraces: number;
  readonly duplicateRuns: number;
  readonly excludedByReason: readonly {
    readonly reason: ExclusionReason;
    readonly count: number;
  }[];
}

export interface DatasetInput {
  /**
   * Every candidate trace identifier discovery yielded, **including repeats**.
   *
   * Repeats are a real outcome of paging: SL-050 records that a full page always offers a
   * continuation cursor, so a page boundary landing on a duplicate timestamp can return a row twice.
   * Counting them is how the arithmetic closes and how a paging defect becomes visible instead of
   * silently inflating a support ratio.
   */
  readonly discoveredTraceIds: readonly string[];
  /** One entry per distinct trace identifier whose spans were fetched. */
  readonly traces: readonly RetrievedTrace[];
  readonly context: EligibilityContext;
}

/**
 * Assembles the dataset.
 *
 * The order of operations is fixed and input-order-independent:
 *
 * 1. Repeats in `discoveredTraceIds` become `DUPLICATE_TRACE` exclusions.
 * 2. Every distinct trace is classified on its own merits.
 * 3. Among the eligible, two traces reporting one run identifier are collapsed, keeping the
 *    lexicographically smaller trace identifier so the choice does not depend on arrival order.
 *
 * Step 3 deliberately deduplicates on the **run** identifier, never on an order identifier, a
 * customer identifier or a fingerprint. Many valid runs legitimately operate on one order, and
 * collapsing them would understate the run count and hide a duplicate side effect that spanned two
 * runs.
 */
export function assembleDataset(input: DatasetInput): MiningDataset {
  const excluded: ExcludedTrace[] = [];

  const byTraceId = new Map<string, RetrievedTrace>();
  for (const trace of input.traces) {
    if (byTraceId.has(trace.traceId)) continue;
    byTraceId.set(trace.traceId, trace);
  }

  const seenTraceIds = new Set<string>();
  let duplicateTraces = 0;
  for (const traceId of input.discoveredTraceIds) {
    if (seenTraceIds.has(traceId)) {
      duplicateTraces += 1;
      excluded.push({
        traceId,
        reason: "DUPLICATE_TRACE",
        detail: "This trace identifier was returned more than once by discovery.",
        spanCount: 0,
        quality: null,
        warnings: [],
      });
      continue;
    }
    seenTraceIds.add(traceId);

    // Discovered but never fetched. Counting it keeps the arithmetic closed, and a fetch failure is a
    // materially different fact from an ineligible trace — the run may have been perfectly valid.
    if (!byTraceId.has(traceId)) {
      excluded.push({
        traceId,
        reason: "TRACE_FETCH_FAILED",
        detail: "Discovery named this trace but its spans could not be fetched.",
        spanCount: 0,
        quality: null,
        warnings: [],
      });
    }
  }

  // Only the distinct discovered identifiers are classified. Restricting the loop to them rather than
  // to whatever was handed over makes `eligible + excluded === discovered` structural: a trace nobody
  // discovered cannot slip into the denominator of a support ratio.
  const fetched = [...seenTraceIds]
    .filter((traceId) => byTraceId.has(traceId))
    .sort(compareStrings);

  const candidates: EligibleRun[] = [];
  for (const traceId of fetched) {
    const trace = byTraceId.get(traceId) as RetrievedTrace;
    const outcome = classifyTrace(trace, input.context);
    if (outcome.eligible) {
      candidates.push(outcome.run);
      continue;
    }
    excluded.push({
      traceId,
      reason: outcome.reason,
      detail: outcome.detail,
      spanCount: outcome.spanCount,
      quality: outcome.graph?.quality ?? null,
      warnings: outcome.graph?.warnings.map((warning) => warning.kind) ?? [],
    });
  }

  const keptByRunId = new Map<string, EligibleRun>();
  let duplicateRuns = 0;
  // Candidates arrive sorted by trace identifier, so the first sighting of a run identifier is
  // already the smallest trace identifier reporting it.
  for (const run of candidates) {
    const existing = keptByRunId.get(run.runId);
    if (existing === undefined) {
      keptByRunId.set(run.runId, run);
      continue;
    }
    duplicateRuns += 1;
    excluded.push({
      traceId: run.traceId,
      reason: "DUPLICATE_RUN",
      detail: `Run ${run.runId} is already counted from trace ${existing.traceId}.`,
      spanCount: run.graph.nodes.length,
      quality: run.graph.quality,
      warnings: run.warnings,
    });
  }

  const eligible = [...keptByRunId.values()].sort((a, b) => compareStrings(a.traceId, b.traceId));

  excluded.sort(
    (a, b) => compareStrings(a.reason, b.reason) || compareStrings(a.traceId, b.traceId),
  );

  const dataset: MiningDataset = {
    eligible,
    excluded,
    tracesDiscovered: input.discoveredTraceIds.length,
    tracesRetrieved: fetched.length,
    duplicateTraces,
    duplicateRuns,
    excludedByReason: tallyReasons(excluded),
  };

  assertCountsReconcile(dataset);
  return dataset;
}

/** Only reasons that actually occurred, in the order `EXCLUSION_REASONS` declares them. */
function tallyReasons(
  excluded: readonly ExcludedTrace[],
): readonly { readonly reason: ExclusionReason; readonly count: number }[] {
  const counts = new Map<ExclusionReason, number>();
  for (const entry of excluded) counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  return EXCLUSION_REASONS.filter((reason) => counts.has(reason)).map((reason) => ({
    reason,
    count: counts.get(reason) as number,
  }));
}

/**
 * Refuses a dataset whose arithmetic does not close.
 *
 * A mining run that has lost a trace has lost it from the denominator of every support ratio, which
 * changes which rules are proposed as required. Failing loudly is the only response that cannot
 * produce a confidently wrong contract.
 */
function assertCountsReconcile(dataset: MiningDataset): void {
  const total = dataset.eligible.length + dataset.excluded.length;
  if (total !== dataset.tracesDiscovered) {
    throw new RangeError(
      `mining counts do not reconcile: ${dataset.tracesDiscovered} discovered but ${dataset.eligible.length} eligible plus ${dataset.excluded.length} excluded`,
    );
  }
  const tallied = dataset.excludedByReason.reduce((sum, entry) => sum + entry.count, 0);
  if (tallied !== dataset.excluded.length) {
    throw new RangeError(
      `exclusion reasons do not reconcile: ${tallied} tallied against ${dataset.excluded.length} excluded`,
    );
  }
  const fetchFailures =
    dataset.excludedByReason.find((entry) => entry.reason === "TRACE_FETCH_FAILED")?.count ?? 0;
  if (
    dataset.tracesRetrieved + fetchFailures + dataset.duplicateTraces !==
    dataset.tracesDiscovered
  ) {
    throw new RangeError(
      `retrieval counts do not reconcile: ${dataset.tracesRetrieved} retrieved plus ${fetchFailures} unfetchable plus ${dataset.duplicateTraces} duplicate(s) against ${dataset.tracesDiscovered} discovered`,
    );
  }
}

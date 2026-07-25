import {
  DEFAULT_NORMALISER_CONFIG,
  identityOf,
  type NormaliserConfig,
} from "@flightrules/normaliser";
import type { OperationContext, SigNozOperations } from "@flightrules/signoz-mcp";
import { assembleDataset, type MiningDataset } from "./dataset.js";
import type { EligibilityContext, RetrievedTrace } from "./eligibility.js";
import { mineRouteFamilies } from "./families.js";
import type {
  BaselineStatus,
  BaselineVersion,
  Disclosure,
  EligibleRun,
  MiningCounts,
} from "./model.js";
import {
  type DiscoveredDataset,
  discoverRuns,
  type FieldTypeReport,
  fetchTraces,
  MINING_SELECT_FIELDS,
  type RetrievalError,
  retrievalSummary,
  verifyFieldTypes,
} from "./retrieve.js";
import { compareStrings } from "./safety.js";
import {
  baselineIdentifier,
  type MiningSelection,
  type MiningSelectionInput,
  resolveSelection,
  selectionHash,
} from "./selection.js";

/**
 * The trace selection job (PRD Phase 08 tasks 1 and 12).
 *
 * Composes retrieval, eligibility, grouping and statistics into one baseline. Storage-independent:
 * PRD Phase 09 owns `baseline_versions` and `route_families`, and this returns the values those rows
 * will hold.
 *
 * Nothing here reads a clock, a random source or a model. `createdAt` for a proposal is supplied by
 * the caller, the baseline identifier is derived from the selection, and every collection is sorted.
 * The one wall-clock fact a baseline carries is the mining window, which the caller chose.
 */

/** PRD section 8.7's progress states, verbatim in meaning and order. */
export const MINING_STAGES = [
  "discovering_traces",
  "fetching_span_trees",
  "normalising_routes",
  "grouping_route_families",
  "proposing_contract_rules",
] as const;

export type MiningStage = (typeof MINING_STAGES)[number];

export interface MiningProgress {
  readonly stage: MiningStage;
  readonly detail: string;
}

/**
 * Where a mining run gets its traces.
 *
 * An interface, so the miner can be exercised against captured fixtures without a live SigNoz — and
 * so the live path is a real implementation of the same contract rather than a separate code path.
 * `signozTraceSource` below is the only implementation the product ships; a test source proves the
 * algorithms, and the integration tests prove the MCP path.
 */
export interface TraceSource {
  verifyFieldTypes(): Promise<
    | { readonly ok: true; readonly report: FieldTypeReport }
    | { readonly ok: false; readonly error: RetrievalError }
  >;
  discover(
    selection: MiningSelection,
  ): Promise<
    | { readonly ok: true; readonly dataset: DiscoveredDataset }
    | { readonly ok: false; readonly error: RetrievalError }
  >;
  fetch(
    traceIds: readonly string[],
    selection: MiningSelection,
  ): Promise<{
    readonly traces: readonly RetrievedTrace[];
    readonly failures: readonly RetrievalError[];
  }>;
}

/** The live source: the Phase 05 MCP client through the supported Query Builder path. */
export function signozTraceSource(
  operations: SigNozOperations,
  context: OperationContext,
): TraceSource {
  return {
    verifyFieldTypes: () => verifyFieldTypes(operations, MINING_SELECT_FIELDS, context),
    discover: (selection) => discoverRuns(operations, selection, context),
    fetch: (traceIds, selection) => fetchTraces(operations, traceIds, selection, context),
  };
}

export const MINING_ERROR_CODES = [
  "SELECTION_INVALID",
  "FIELD_TYPES_UNTRUSTED",
  "DISCOVERY_FAILED",
] as const;

export type MiningErrorCode = (typeof MINING_ERROR_CODES)[number];

export interface MiningError {
  readonly code: MiningErrorCode;
  readonly subject: string;
  readonly message: string;
}

export interface MinedBaseline {
  readonly baseline: BaselineVersion;
  /** Eligible runs grouped by family fingerprint, the input rule proposal needs. */
  readonly runsByFingerprint: ReadonlyMap<string, readonly EligibleRun[]>;
  readonly dataset: MiningDataset;
  /** Traces discovery named but could not fetch, retained so a failure is visible not merely counted. */
  readonly retrievalFailures: readonly RetrievalError[];
}

export type MiningResult =
  | { readonly ok: true; readonly value: MinedBaseline }
  | { readonly ok: false; readonly errors: readonly MiningError[] };

export interface MineInput {
  readonly selection: MiningSelectionInput;
  readonly source: TraceSource;
  readonly config?: NormaliserConfig;
  readonly onProgress?: (progress: MiningProgress) => void;
}

/**
 * Mines a baseline.
 *
 * Field types are confirmed **before** any mining query runs. SL-046 records that a non-string tag
 * requested without its `dataType` returns `null` on a successful call, per column, with no
 * diagnostic — so a mining run whose typing is not understood is refused rather than performed on
 * evidence that may silently be missing.
 */
export async function mineBaseline(input: MineInput): Promise<MiningResult> {
  let selection: MiningSelection;
  try {
    selection = resolveSelection(input.selection);
  } catch (error: unknown) {
    return {
      ok: false,
      errors: [
        {
          code: "SELECTION_INVALID",
          subject: "selection",
          message: error instanceof Error ? error.message : "The selection is invalid.",
        },
      ],
    };
  }

  const report = (stage: MiningStage, detail: string): void => {
    input.onProgress?.({ stage, detail });
  };

  const fieldTypes = await input.source.verifyFieldTypes();
  if (!fieldTypes.ok) {
    return {
      ok: false,
      errors: [
        {
          code: "FIELD_TYPES_UNTRUSTED",
          subject: fieldTypes.error.subject,
          message: fieldTypes.error.message,
        },
      ],
    };
  }

  report(
    "discovering_traces",
    `Searching for ${selection.rootSpanName} spans of ${selection.releaseId}.`,
  );
  const discovered = await input.source.discover(selection);
  if (!discovered.ok) {
    return {
      ok: false,
      errors: [
        {
          code: "DISCOVERY_FAILED",
          subject: discovered.error.subject,
          message: discovered.error.message,
        },
      ],
    };
  }

  report(
    "fetching_span_trees",
    `Fetching the complete span tree of ${new Set(discovered.dataset.traceIds).size} trace(s).`,
  );
  const fetched = await input.source.fetch(discovered.dataset.traceIds, selection);

  report("normalising_routes", "Normalising span names and attributes, and reconstructing graphs.");
  const config = input.config ?? DEFAULT_NORMALISER_CONFIG;
  const identity = identityOf(config);
  const context: EligibilityContext = {
    selection,
    config,
    normaliserVersion: identity.version,
    normaliserConfigHash: identity.configHash,
  };

  const dataset = assembleDataset({
    discoveredTraceIds: discovered.dataset.traceIds,
    traces: fetched.traces,
    context,
  });

  report(
    "grouping_route_families",
    `Grouping ${dataset.eligible.length} eligible run(s) by route fingerprint.`,
  );
  const baselineId = baselineIdentifier(selection);
  const mined = mineRouteFamilies(dataset, selection, baselineId);

  const status = resolveStatus(discovered.dataset, dataset, selection);
  const counts: MiningCounts = {
    tracesDiscovered: dataset.tracesDiscovered,
    tracesRetrieved: dataset.tracesRetrieved,
    eligibleRuns: dataset.eligible.length,
    excludedTraces: dataset.excluded.length,
    duplicateTraces: dataset.duplicateTraces,
    duplicateRuns: dataset.duplicateRuns,
    routeFamilies: mined.families.length,
    rareFamilies: mined.rareFamilies,
    excludedByReason: dataset.excludedByReason,
  };

  const baseline: BaselineVersion = {
    id: baselineId,
    projectKey: selection.projectKey,
    agentKey: selection.agentKey,
    releaseId: selection.releaseId,
    environment: selection.environment,
    status,
    sourceTimeStartMs: selection.startMs,
    sourceTimeEndMs: selection.endMs,
    minimumRuns: selection.minimumRuns,
    rareThreshold: selection.rareThreshold,
    normaliserVersion: identity.version,
    normaliserConfigHash: identity.configHash,
    selectionHash: selectionHash(selection),
    counts,
    retrieval: retrievalSummary({
      selection,
      discovered: discovered.dataset,
      fieldTypes: fieldTypes.report,
    }),
    families: mined.families,
    excluded: dataset.excluded,
    disclosures: baselineDisclosures({
      status,
      counts,
      selection,
      fieldTypes: fieldTypes.report,
    }),
  };

  report(
    "proposing_contract_rules",
    `Found ${mined.families.length} route family/families across ${dataset.eligible.length} eligible run(s).`,
  );

  return {
    ok: true,
    value: {
      baseline,
      runsByFingerprint: mined.runsByFingerprint,
      dataset,
      retrievalFailures: [...fetched.failures].sort(
        (a, b) => compareStrings(a.code, b.code) || compareStrings(a.subject, b.subject),
      ),
    },
  };
}

/**
 * The baseline's status.
 *
 * Truncation outranks the run count. A dataset that stopped at its own limit while SigNoz still had
 * more to give may contain enough runs *and* still misrepresent the release, because the runs it
 * omitted are exactly the ones nobody looked at.
 */
function resolveStatus(
  discovered: DiscoveredDataset,
  dataset: MiningDataset,
  selection: MiningSelection,
): BaselineStatus {
  if (discovered.truncated) return "dataset_truncated";
  if (dataset.eligible.length < selection.minimumRuns) return "insufficient_runs";
  return "pending_review";
}

function baselineDisclosures(input: {
  readonly status: BaselineStatus;
  readonly counts: MiningCounts;
  readonly selection: MiningSelection;
  readonly fieldTypes: FieldTypeReport;
}): readonly Disclosure[] {
  const disclosures: Disclosure[] = [];

  if (input.status === "dataset_truncated") {
    disclosures.push({
      code: "DATASET_TRUNCATED",
      subject: "",
      detail: `Discovery stopped at the maximum of ${input.selection.maxTraces} trace(s) while SigNoz still offered more, so this dataset does not describe the whole window.`,
      count: input.counts.tracesDiscovered,
    });
  }

  if (input.status === "insufficient_runs") {
    disclosures.push({
      code: "INSUFFICIENT_RUNS",
      subject: "",
      detail: `${input.counts.eligibleRuns} eligible run(s) were found; the selection requires at least ${input.selection.minimumRuns}.`,
      count: input.counts.eligibleRuns,
    });
  }

  if (input.counts.excludedTraces > 0) {
    disclosures.push({
      code: "TRACES_EXCLUDED",
      subject: "",
      detail: `${input.counts.excludedTraces} of ${input.counts.tracesDiscovered} discovered trace(s) were excluded: ${input.counts.excludedByReason
        .map((entry) => `${entry.reason} ${entry.count}`)
        .join(", ")}.`,
      count: input.counts.excludedTraces,
    });
  }

  if (input.counts.rareFamilies > 0) {
    disclosures.push({
      code: "RARE_FAMILY_PRESENT",
      subject: "",
      detail: `${input.counts.rareFamilies} route family/families occurred in fewer than ${input.selection.rareThreshold.decimal} of the eligible runs.`,
      count: input.counts.rareFamilies,
    });
  }

  if (input.fieldTypes.unverified.length > 0) {
    disclosures.push({
      code: "FIELD_TYPE_UNVERIFIED",
      subject: "",
      detail: `The SigNoz field catalogue does not list ${input.fieldTypes.unverified.join(", ")}. Each is declared as a string, which is the server's own default resolution, so a null return means the value was not emitted rather than wrongly typed.`,
      count: input.fieldTypes.unverified.length,
    });
  }

  return disclosures.sort(
    (a, b) => compareStrings(a.code, b.code) || compareStrings(a.subject, b.subject),
  );
}

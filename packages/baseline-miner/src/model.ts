import type { TraceQuality } from "@flightrules/domain";
import type { CanonicalGraph, TraceGraph, TraceQualityWarningKind } from "@flightrules/trace-graph";
import type { Distribution, Ratio } from "./statistics.js";

/**
 * The vocabulary of a mining run.
 *
 * Every closed set here is part of the product's API: an exclusion reason reaches the Baseline
 * Capture screen (PRD section 8.7), a family status reaches Route Family Detail (8.8), and a
 * disclosure reaches Contract Studio (8.9) and the generated document. None is ever produced from
 * free text, and none is inferred by a model.
 */

/**
 * Why a retrieved trace did not contribute to the baseline.
 *
 * PRD Phase 08 task 3 requires incomplete traces to be excluded **with reasons**, and PRD section
 * 8.7 shows those reasons to the user. A trace silently dropped would make the run count look
 * smaller than the window actually contained, which is indistinguishable from a query that missed
 * data.
 */
export const EXCLUSION_REASONS = [
  /** The span rows could not be turned into a graph at all. */
  "TRACE_MALFORMED",
  /** More spans than the configured maximum (PRD section 18.2). */
  "TRACE_TOO_LARGE",
  /** Orphan spans or a synthetic root: an absence claim over this trace cannot be sound. */
  "TRACE_INCOMPLETE",
  /** Duplicate records that contradict each other (PRD section 11.5). */
  "TRACE_INCONSISTENT",
  /** No parentless span matched the configured root selector. */
  "ROOT_SPAN_MISSING",
  /** No span carried the release attribute, so the trace cannot be attributed to a release. */
  "RELEASE_ID_MISSING",
  /** The trace carries a release other than the one being mined. */
  "RELEASE_MISMATCH",
  /** The trace carries an environment other than the one being mined. */
  "ENVIRONMENT_MISMATCH",
  /** No span carried the run attribute, so the run cannot be deduplicated. */
  "RUN_ID_MISSING",
  /** A span reported an error status and the selection asked for successful runs only. */
  "RUN_NOT_SUCCESSFUL",
  /** Discovery named the trace but its spans could not be fetched. */
  "TRACE_FETCH_FAILED",
  /** The same trace identifier was retrieved more than once. */
  "DUPLICATE_TRACE",
  /** A different trace identifier reporting a run already counted. */
  "DUPLICATE_RUN",
  /** Fingerprinted under a different normaliser, so it is not comparable with the rest. */
  "NORMALISER_VERSION_MISMATCH",
  /** A typed attribute could not be trusted, so this trace's evidence is not usable (SL-046). */
  "UNTRUSTED_TYPED_ATTRIBUTE",
] as const;

export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export interface ExcludedTrace {
  readonly traceId: string;
  readonly reason: ExclusionReason;
  /** Written by the miner from the observed facts. Never contains telemetry payload content. */
  readonly detail: string;
  readonly spanCount: number;
  readonly quality: TraceQuality | null;
  /** Warning kinds only, sorted. Span identifiers stay with the graph, not with the summary. */
  readonly warnings: readonly TraceQualityWarningKind[];
}

/**
 * One eligible run.
 *
 * The graph is retained because family statistics and the unobservable-subtree scoping both need it;
 * it is never serialised into a proposal or an evidence file, which carry the canonical projection
 * and the allowlisted summary instead.
 */
export interface EligibleRun {
  readonly traceId: string;
  readonly runId: string;
  readonly releaseId: string;
  readonly environment: string | null;
  readonly fingerprint: string;
  readonly canonical: CanonicalGraph;
  readonly graph: TraceGraph;
  readonly startedAtMs: number;
  readonly durationMs: number;
  readonly warnings: readonly TraceQualityWarningKind[];
  /** SigNoz deep link when the payload returned one (PRD FR-003). */
  readonly webUrl: string | null;
}

/** PRD section 8.8's route-family actions, as a closed set of resulting states. */
export const ROUTE_FAMILY_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "optional",
  "excluded_fixture_error",
] as const;

export type RouteFamilyStatus = (typeof ROUTE_FAMILY_STATUSES)[number];

/**
 * One canonical label inside a family's topology.
 *
 * Exact fingerprint grouping (PRD section 11.8) means every run in a family has a byte-identical
 * canonical graph, so `occurrencesPerRun` is a constant of the family rather than a distribution.
 * Variation across runs of one family exists only in the dimensions the fingerprint excludes —
 * duration, tokens, timestamps — and those are reported as distributions below.
 */
export interface FamilyNode {
  readonly label: string;
  readonly sideEffect: string;
  readonly service: string;
  /** Span kind, which decides whether a label is a remote handler. `null` when unreported. */
  readonly kind: string | null;
  readonly tool: string | null;
  readonly dataDomain: string | null;
  readonly retryNumber: number | null;
  readonly occurrencesPerRun: number;
  /** Parent labels this label appeared under, sorted. Empty for the family's root. */
  readonly parentLabels: readonly string[];
  /** Operation names observed on this label's spans, sorted. */
  readonly operations: readonly string[];
}

export interface FamilyEdge {
  readonly fromLabel: string;
  readonly toLabel: string;
  readonly type: string;
  readonly occurrencesPerRun: number;
}

export interface RetryStatistics {
  /** The tool name where one exists, otherwise the canonical label — the evaluator's grouping. */
  readonly group: string;
  readonly sideEffect: string;
  /** Highest `agent.retry.number` observed for this group. Zero means one attempt, no retry. */
  readonly maxRetry: number;
}

export interface QualityWarningCount {
  readonly kind: TraceQualityWarningKind;
  readonly runs: number;
}

export interface RouteFamilyStatistics {
  readonly traceCount: number;
  readonly firstObservedMs: number;
  readonly lastObservedMs: number;
  readonly duration: Distribution;
  readonly inputTokens: Distribution | null;
  readonly outputTokens: Distribution | null;
  readonly tools: readonly string[];
  readonly services: readonly string[];
  readonly sideEffects: readonly string[];
  readonly dataDomains: readonly string[];
  readonly qualityWarnings: readonly QualityWarningCount[];
  readonly nodes: readonly FamilyNode[];
  readonly edges: readonly FamilyEdge[];
  readonly retries: readonly RetryStatistics[];
}

/**
 * How often a canonical label appeared across the runs of every approved family.
 *
 * `unobservable` is separate from `optional` on purpose. A step absent from a run whose graph flagged
 * the span it would have run under as unobservable was not observed to be absent — the evidence is
 * missing, not negative — so it may neither be proposed as required nor demoted to optional.
 */
export const NODE_PRESENCE_CLASSES = [
  "always",
  "required",
  "optional",
  "rare",
  "unobservable",
] as const;

export type NodePresenceClass = (typeof NODE_PRESENCE_CLASSES)[number];

/** Whether an attribute held one value on every span of a label that carried it at all. */
export interface AttributeSupport {
  readonly key: string;
  readonly value: string | number | boolean;
  readonly carryingSpans: number;
  readonly totalSpans: number;
  readonly support: Ratio;
}

/**
 * A canonical label aggregated across the approved families.
 *
 * This, not the per-family topology, is what rule proposal reads: "present in all approved families"
 * (PRD FR-008) is a statement about the union, and a cardinality bound has to account for a rare
 * family that did the step twice.
 */
export interface LabelAggregate {
  readonly label: string;
  readonly sideEffects: readonly string[];
  readonly services: readonly string[];
  readonly kinds: readonly string[];
  readonly tools: readonly string[];
  readonly dataDomains: readonly string[];
  readonly operations: readonly string[];
  readonly parentLabels: readonly string[];
  /** True when every occurrence is a `Server` span whose parent is a `Client` span. */
  readonly remoteHandler: boolean;
  /** Families containing the label, by fingerprint, sorted. */
  readonly families: readonly string[];
  /** Runs containing at least one occurrence, over runs where the label was observable. */
  readonly presence: Ratio;
  readonly presenceClass: NodePresenceClass;
  /** Per-run occurrence counts across observable runs, including the zeros. */
  readonly cardinality: Distribution;
  readonly observableRuns: number;
  readonly unobservableRuns: number;
  /** Attribute agreements observed on this label's spans, sorted by key then value. */
  readonly attributes: readonly AttributeSupport[];
}

/** A parent-to-child label pair aggregated across the approved families. */
export interface EdgeAggregate {
  readonly fromLabel: string;
  readonly toLabel: string;
  readonly type: string;
  readonly presence: Ratio;
  readonly families: readonly string[];
}

/** A retry group aggregated across the approved families. */
export interface RetryAggregate {
  readonly group: string;
  readonly sideEffects: readonly string[];
  /** Operation names observed on this group's spans, sorted. */
  readonly operations: readonly string[];
  /** Per-run maximum retry number, one sample per run. */
  readonly maxRetry: Distribution;
}

/**
 * One route family (PRD sections 11.8 and 14.8).
 *
 * `fingerprint` and `canonical` together are structurally the `ApprovedRoute` the Phase 07 evaluator
 * consumes, which is asserted by a test rather than by a comment. The identifier is derived from the
 * baseline identity and the fingerprint, never from the order the family was first seen in, so
 * shuffling the input cannot renumber the families.
 */
export interface RouteFamily {
  readonly id: string;
  /** 64 lower-case hex characters, without the `sha256:` prefix the DSL adds. */
  readonly fingerprint: string;
  readonly canonical: CanonicalGraph;
  readonly status: RouteFamilyStatus;
  readonly rare: boolean;
  readonly occurrenceCount: number;
  readonly occurrencePercent: Ratio;
  readonly representativeTraceIds: readonly string[];
  readonly statistics: RouteFamilyStatistics;
  readonly normaliserVersion: string;
  readonly normaliserConfigHash: string;
}

/** PRD section 14.7's baseline lifecycle, plus the two states that block a proposal outright. */
export const BASELINE_STATUSES = [
  "dataset_truncated",
  "insufficient_runs",
  "pending_review",
  "approved",
] as const;

export type BaselineStatus = (typeof BASELINE_STATUSES)[number];

/**
 * Counts that must reconcile exactly.
 *
 * `tracesRetrieved === eligibleRuns + excludedTraces`, and the per-reason totals must sum to
 * `excludedTraces`. Both are asserted in code, not only in tests: a mining run whose arithmetic does
 * not close has lost a trace somewhere, and the honest response is to fail rather than to report a
 * baseline built from an unknown subset.
 */
export interface MiningCounts {
  readonly tracesDiscovered: number;
  readonly tracesRetrieved: number;
  readonly eligibleRuns: number;
  readonly excludedTraces: number;
  readonly duplicateTraces: number;
  readonly duplicateRuns: number;
  readonly routeFamilies: number;
  readonly rareFamilies: number;
  /** Sorted by reason, and only reasons that actually occurred. */
  readonly excludedByReason: readonly {
    readonly reason: ExclusionReason;
    readonly count: number;
  }[];
}

/** How the dataset was obtained, so a proposal can state what it is founded on. */
export interface RetrievalSummary {
  readonly pages: number;
  readonly batchSize: number;
  readonly maxTraces: number;
  /** True when the walk stopped at `maxTraces` while SigNoz still offered a continuation. */
  readonly truncated: boolean;
  readonly startMs: number;
  readonly endMs: number;
  readonly fieldTypesVerified: readonly string[];
  /** Fields the catalogue does not list. Permitted only for built-in span columns. */
  readonly fieldTypesUnverified: readonly string[];
}

/**
 * Statements a reviewer must see.
 *
 * Kept as codes rather than prose so "what is this proposal not sure about" is queryable, and so the
 * UI can render each one without parsing a sentence. Every disclosure carries a count, because
 * "three traces were excluded" and "three hundred were" are different facts.
 */
export const DISCLOSURE_CODES = [
  "DATASET_TRUNCATED",
  "INSUFFICIENT_RUNS",
  "TRACES_EXCLUDED",
  "RARE_FAMILY_PRESENT",
  "MULTIPLE_FAMILIES_APPROVED",
  "UNAPPROVED_FAMILY_PRESENT",
  "LABEL_UNOBSERVABLE",
  "LABEL_OPTIONAL",
  "LABEL_NOT_EXPRESSIBLE",
  "CARDINALITY_OUTLIER",
  "BUDGET_NOT_PROPOSED",
  "FIELD_TYPE_UNVERIFIED",
] as const;

export type DisclosureCode = (typeof DISCLOSURE_CODES)[number];

export interface Disclosure {
  readonly code: DisclosureCode;
  /** The label, field, family fingerprint or reason the disclosure concerns; `""` when general. */
  readonly subject: string;
  readonly detail: string;
  readonly count: number;
}

/**
 * A mined baseline (PRD section 14.7).
 *
 * Storage-independent: these are the values the Phase 09 rows will hold. `selectionHash` exists so a
 * repeated request with an identical selection is recognisable as the same job, which PRD section
 * 20.1 requires of every long-running operation.
 */
export interface BaselineVersion {
  readonly id: string;
  readonly projectKey: string;
  readonly agentKey: string;
  readonly releaseId: string;
  readonly environment: string | null;
  readonly status: BaselineStatus;
  readonly sourceTimeStartMs: number;
  readonly sourceTimeEndMs: number;
  readonly minimumRuns: number;
  /** The share below which a family was marked rare, carried so a proposal can restate it. */
  readonly rareThreshold: Ratio;
  readonly normaliserVersion: string;
  readonly normaliserConfigHash: string;
  readonly selectionHash: string;
  readonly counts: MiningCounts;
  readonly retrieval: RetrievalSummary;
  readonly families: readonly RouteFamily[];
  readonly excluded: readonly ExcludedTrace[];
  readonly disclosures: readonly Disclosure[];
}

/** The subset of a family the Phase 07 evaluator needs. Structurally its `ApprovedRoute`. */
export interface ApprovedRouteInput {
  readonly fingerprint: string;
  readonly canonical: CanonicalGraph;
}

/**
 * The approved families as the evaluator's `approved_routes` input.
 *
 * Bare hexadecimal, with no `sha256:` prefix. A contract document may write either form, but
 * validation strips the prefix so one route cannot be listed twice, and the evaluator compares
 * against the bare fingerprint `fingerprintGraph` produces. Adding the prefix here would make every
 * approved route silently unmatched.
 */
export function approvedRouteInputs(baseline: BaselineVersion): readonly ApprovedRouteInput[] {
  return baseline.families
    .filter((family) => family.status === "approved")
    .map((family) => ({ fingerprint: family.fingerprint, canonical: family.canonical }));
}

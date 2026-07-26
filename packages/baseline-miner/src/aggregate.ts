import type { TraceNode } from "@flightrules/trace-graph";
import { nodeAttribute } from "./families.js";
import type {
  AttributeSupport,
  EdgeAggregate,
  EligibleRun,
  LabelAggregate,
  NodePresenceClass,
  RetryAggregate,
  RouteFamily,
} from "./model.js";
import { compareStrings, sortedUnique } from "./safety.js";
import {
  atLeastRatio,
  belowRatio,
  type Distribution,
  distributionOf,
  ONE_RATIO,
  type Ratio,
  ratio,
} from "./statistics.js";

/**
 * Aggregation across the approved families.
 *
 * PRD FR-008 proposes rules from "steps present in all approved families", so the questions rule
 * proposal asks — is this step required, how many times may it happen, how often was it retried, what
 * did it cost — are all questions about the **union** of the approved families' runs, not about any
 * one family. Exact grouping makes each family's topology a constant, so the variation that matters
 * lives exactly here.
 *
 * Every index is a `Map` and every key that came from telemetry is used only as a `Map` key, never as
 * a property name on an ordinary object.
 */

/**
 * Evidence attributes the proposal path may read.
 *
 * An allowlist, not a denylist. Everything else a span carries — order identifiers, idempotency key
 * hashes, anything a future service adds — stays out of proposals and out of evidence files by
 * construction rather than by a redaction pass that has to know every dangerous key in advance.
 */
export const PROPOSAL_ATTRIBUTES = ["agent.idempotency.present"] as const;

const DURATION_METRIC = "run.duration_ms";
const INPUT_TOKENS = "gen_ai.usage.input_tokens";
const OUTPUT_TOKENS = "gen_ai.usage.output_tokens";

export interface AggregateOptions {
  /** Presence at or above which a step is proposed as required. Default 1/1: every observable run. */
  readonly requiredSupport: Ratio;
  /** Presence below which a step is reported as rare. */
  readonly rareThreshold: Ratio;
}

/** Why a budget could not be proposed. Typed, because "we did not propose one" needs a reason. */
export const BUDGET_UNAVAILABLE_REASONS = [
  "ATTRIBUTE_NOT_EMITTED",
  "INSUFFICIENT_OBSERVATIONS",
  "SAMPLE_SIZE_TOO_SMALL",
  "ATTRIBUTE_QUERY_UNTRUSTED",
] as const;

export type BudgetUnavailableReason = (typeof BUDGET_UNAVAILABLE_REASONS)[number];

export type BudgetObservation =
  | {
      readonly metric: string;
      readonly available: true;
      readonly distribution: Distribution;
      /** Runs that reported the metric, over runs considered. */
      readonly coverage: Ratio;
    }
  | {
      readonly metric: string;
      readonly available: false;
      readonly reason: BudgetUnavailableReason;
      readonly observedRuns: number;
      readonly totalRuns: number;
    };

export interface BaselineAggregate {
  readonly approvedRuns: number;
  readonly approvedFingerprints: readonly string[];
  readonly labels: readonly LabelAggregate[];
  readonly edges: readonly EdgeAggregate[];
  readonly retries: readonly RetryAggregate[];
  /** Per-run total of the per-group maximum retry numbers. */
  readonly retryRunTotal: Distribution | null;
  /** Per-run maximum retry number observed on a `write` or `external` step. */
  readonly retrySideEffectMax: Distribution | null;
  readonly duration: BudgetObservation;
  readonly inputTokens: BudgetObservation;
  readonly outputTokens: BudgetObservation;
  readonly tools: readonly string[];
  readonly services: readonly string[];
  readonly dataDomains: readonly string[];
}

/**
 * The canonical labels a run could not observe.
 *
 * A `client_span_without_server_span` warning names the client spans whose remote work was never
 * exported, so anything that would have happened beneath one of them is unobservable. This returns
 * those spans' canonical labels; a step whose observed parents include one of them cannot be proven
 * absent from this run.
 */
function unobservableParentLabels(run: EligibleRun): ReadonlySet<string> {
  const flagged = new Set<string>();
  for (const warning of run.graph.warnings) {
    if (warning.kind !== "client_span_without_server_span") continue;
    for (const spanId of warning.spanIds) flagged.add(spanId);
  }
  if (flagged.size === 0) return flagged;

  const labels = new Set<string>();
  for (const node of run.graph.nodes) {
    if (flagged.has(node.spanId)) labels.add(node.canonicalName);
  }
  return labels;
}

function classifyPresence(
  presence: Ratio,
  observableRuns: number,
  options: AggregateOptions,
): NodePresenceClass {
  if (observableRuns === 0) return "unobservable";
  if (presence.numerator === presence.denominator) return "always";
  if (atLeastRatio(presence, options.requiredSupport)) return "required";
  if (belowRatio(presence, options.rareThreshold)) return "rare";
  return "optional";
}

/** Attribute agreements on one label's spans, restricted to the proposal allowlist. */
function attributeSupportOf(spans: readonly TraceNode[]): readonly AttributeSupport[] {
  const results: AttributeSupport[] = [];

  for (const key of PROPOSAL_ATTRIBUTES) {
    const byValue = new Map<string, { readonly value: string | number | boolean; count: number }>();
    let carrying = 0;

    for (const span of spans) {
      const value = nodeAttribute(span, key);
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        continue;
      }
      carrying += 1;
      const valueKey = `${typeof value}:${String(value)}`;
      const existing = byValue.get(valueKey);
      if (existing === undefined) byValue.set(valueKey, { value, count: 1 });
      else existing.count += 1;
    }

    if (carrying === 0) continue;

    // One entry per observed value, so "every span said true" and "most said true" are different
    // facts a reviewer can see rather than one collapsed claim.
    for (const valueKey of [...byValue.keys()].sort(compareStrings)) {
      const entry = byValue.get(valueKey) as { value: string | number | boolean; count: number };
      results.push({
        key,
        value: entry.value,
        carryingSpans: entry.count,
        totalSpans: spans.length,
        support: ratio(entry.count, spans.length),
      });
    }
  }

  return results;
}

function budgetOf(
  metric: string,
  samples: readonly number[],
  totalRuns: number,
  minimumObservations: number,
): BudgetObservation {
  if (samples.length === 0) {
    return {
      metric,
      available: false,
      reason: "ATTRIBUTE_NOT_EMITTED",
      observedRuns: 0,
      totalRuns,
    };
  }
  if (samples.length < minimumObservations) {
    return {
      metric,
      available: false,
      reason: "INSUFFICIENT_OBSERVATIONS",
      observedRuns: samples.length,
      totalRuns,
    };
  }
  return {
    metric,
    available: true,
    distribution: distributionOf(samples) as Distribution,
    coverage: ratio(samples.length, totalRuns),
  };
}

/** Sums an integer attribute across a run's spans, or `null` when nothing reported it. */
function sumIntegerAttribute(run: EligibleRun, key: string): number | null {
  let total = 0;
  let reported = false;
  for (const node of run.graph.nodes) {
    const value = nodeAttribute(node, key);
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    reported = true;
    total += Math.trunc(value);
  }
  return reported ? total : null;
}

export interface AggregateInput {
  readonly approved: readonly RouteFamily[];
  readonly runsByFingerprint: ReadonlyMap<string, readonly EligibleRun[]>;
  readonly options: AggregateOptions;
  /** Fewest runs that must report a metric before a budget may be proposed from it. */
  readonly minimumBudgetObservations: number;
}

/**
 * Aggregates the approved families.
 *
 * Nothing here consults a model, a random source or a clock. Every number is derived from the
 * canonical graphs and the allowlisted attributes of the eligible runs, and every collection is
 * sorted before it is returned.
 */
export function aggregateApproved(input: AggregateInput): BaselineAggregate {
  const fingerprints = input.approved.map((family) => family.fingerprint).sort(compareStrings);

  // Every label any approved family contains, with the per-family occurrence count and the parent
  // labels observed for it. Parent labels drive the unobservability scoping below.
  const occurrencesByLabel = new Map<string, Map<string, number>>();
  const parentsByLabel = new Map<string, Set<string>>();
  const familiesByLabel = new Map<string, Set<string>>();
  const sideEffectsByLabel = new Map<string, Set<string>>();
  const servicesByLabel = new Map<string, Set<string>>();
  const kindsByLabel = new Map<string, Set<string>>();
  const toolsByLabel = new Map<string, Set<string>>();
  const domainsByLabel = new Map<string, Set<string>>();
  const operationsByLabel = new Map<string, Set<string>>();

  for (const family of input.approved) {
    for (const node of family.statistics.nodes) {
      const byFamily = occurrencesByLabel.get(node.label) ?? new Map<string, number>();
      byFamily.set(family.fingerprint, node.occurrencesPerRun);
      occurrencesByLabel.set(node.label, byFamily);

      addAll(parentsByLabel, node.label, node.parentLabels);
      addAll(familiesByLabel, node.label, [family.fingerprint]);
      addAll(sideEffectsByLabel, node.label, [node.sideEffect]);
      addAll(servicesByLabel, node.label, [node.service]);
      if (node.kind !== null) addAll(kindsByLabel, node.label, [node.kind]);
      if (node.tool !== null) addAll(toolsByLabel, node.label, [node.tool]);
      if (node.dataDomain !== null) addAll(domainsByLabel, node.label, [node.dataDomain]);
      addAll(operationsByLabel, node.label, node.operations);
    }
  }

  const runs: { readonly run: EligibleRun; readonly fingerprint: string }[] = [];
  for (const family of input.approved) {
    for (const run of input.runsByFingerprint.get(family.fingerprint) ?? []) {
      runs.push({ run, fingerprint: family.fingerprint });
    }
  }
  runs.sort((a, b) => compareStrings(a.run.traceId, b.run.traceId));

  const unobservableByRun = new Map<string, ReadonlySet<string>>();
  for (const entry of runs) {
    unobservableByRun.set(entry.run.traceId, unobservableParentLabels(entry.run));
  }

  const labels: LabelAggregate[] = [];
  for (const label of [...occurrencesByLabel.keys()].sort(compareStrings)) {
    const byFamily = occurrencesByLabel.get(label) as Map<string, number>;
    const parents = parentsByLabel.get(label) ?? new Set<string>();

    const counts: number[] = [];
    let containing = 0;
    let unobservable = 0;

    for (const entry of runs) {
      const count = byFamily.get(entry.fingerprint) ?? 0;
      if (count > 0) {
        counts.push(count);
        containing += 1;
        continue;
      }
      // Absent from this run. Only an absence inside a subtree the trace could not observe is
      // undecidable; an absence anywhere the trace did observe is real evidence.
      const flagged = unobservableByRun.get(entry.run.traceId) ?? new Set<string>();
      const hidden = [...parents].some((parent) => flagged.has(parent));
      if (hidden) {
        unobservable += 1;
        continue;
      }
      counts.push(0);
    }

    const observableRuns = counts.length;
    const presence = observableRuns === 0 ? ONE_RATIO : ratio(containing, observableRuns);
    const spans = spansOfLabel(runs, label);

    const kinds = sortedUnique(kindsByLabel.get(label) ?? []);

    labels.push({
      label,
      sideEffects: sortedUnique(sideEffectsByLabel.get(label) ?? []),
      services: sortedUnique(servicesByLabel.get(label) ?? []),
      kinds,
      tools: sortedUnique(toolsByLabel.get(label) ?? []),
      dataDomains: sortedUnique(domainsByLabel.get(label) ?? []),
      operations: sortedUnique(operationsByLabel.get(label) ?? []),
      parentLabels: sortedUnique(parents),
      remoteHandler: isRemoteHandler(kinds, parents, kindsByLabel),
      families: sortedUnique(familiesByLabel.get(label) ?? []),
      presence,
      presenceClass: classifyPresence(presence, observableRuns, input.options),
      cardinality: distributionOf(counts) ?? zeroDistribution(),
      observableRuns,
      unobservableRuns: unobservable,
      attributes: attributeSupportOf(spans),
    });
  }

  const edges = aggregateEdges(input.approved, runs.length, input.runsByFingerprint);
  const retryData = aggregateRetries(input.approved, input.runsByFingerprint);

  const durationSamples = runs.map((entry) => entry.run.durationMs);
  const inputSamples: number[] = [];
  const outputSamples: number[] = [];
  for (const entry of runs) {
    const input_ = sumIntegerAttribute(entry.run, INPUT_TOKENS);
    if (input_ !== null) inputSamples.push(input_);
    const output = sumIntegerAttribute(entry.run, OUTPUT_TOKENS);
    if (output !== null) outputSamples.push(output);
  }

  return {
    approvedRuns: runs.length,
    approvedFingerprints: fingerprints,
    labels,
    edges,
    retries: retryData.groups,
    retryRunTotal: retryData.runTotal,
    retrySideEffectMax: retryData.sideEffectMax,
    duration: budgetOf(
      DURATION_METRIC,
      durationSamples,
      runs.length,
      input.minimumBudgetObservations,
    ),
    inputTokens: budgetOf(INPUT_TOKENS, inputSamples, runs.length, input.minimumBudgetObservations),
    outputTokens: budgetOf(
      OUTPUT_TOKENS,
      outputSamples,
      runs.length,
      input.minimumBudgetObservations,
    ),
    tools: sortedUnique(labels.flatMap((label) => label.tools)),
    services: sortedUnique(labels.flatMap((label) => label.services)),
    dataDomains: sortedUnique(labels.flatMap((label) => label.dataDomains)),
  };
}

/**
 * Whether a label is the server side of a remote call.
 *
 * A label every one of whose occurrences is a `Server` span sitting under a `Client` span is a
 * handler: it exists because the caller made a request, and its absence is evidence about the
 * transport rather than about the agent's decisions. Phase 08 proposes a `required_edge` from the
 * caller for such a label instead of a `required_span` on it, because Phase 04's aborted payment
 * attempt is a real case where the client span exists and the handler span was never exported — and a
 * `required_span` there would report a skipped step for what is a telemetry gap. PRD section 11.3 and
 * ADR-0006 decision 8 already treat that case as undecidable rather than absent.
 */
function isRemoteHandler(
  kinds: readonly string[],
  parents: ReadonlySet<string>,
  kindsByLabel: ReadonlyMap<string, Set<string>>,
): boolean {
  if (kinds.length !== 1 || kinds[0] !== "Server") return false;
  if (parents.size === 0) return false;
  for (const parent of parents) {
    const parentKinds = kindsByLabel.get(parent);
    if (parentKinds === undefined || !parentKinds.has("Client")) return false;
  }
  return true;
}

function addAll(into: Map<string, Set<string>>, key: string, values: Iterable<string>): void {
  const existing = into.get(key);
  if (existing === undefined) into.set(key, new Set(values));
  else for (const value of values) existing.add(value);
}

function zeroDistribution(): Distribution {
  return distributionOf([0]) as Distribution;
}

/** Every span carrying a canonical label, across the approved runs, in a deterministic order. */
function spansOfLabel(
  runs: readonly { readonly run: EligibleRun }[],
  label: string,
): readonly TraceNode[] {
  const spans: TraceNode[] = [];
  for (const entry of runs) {
    for (const node of entry.run.graph.nodes) {
      if (node.canonicalName === label) spans.push(node);
    }
  }
  return spans.sort((a, b) => compareStrings(a.spanId, b.spanId));
}

function aggregateEdges(
  approved: readonly RouteFamily[],
  totalRuns: number,
  runsByFingerprint: ReadonlyMap<string, readonly EligibleRun[]>,
): readonly EdgeAggregate[] {
  const byKey = new Map<
    string,
    {
      readonly fromLabel: string;
      readonly toLabel: string;
      readonly type: string;
      readonly families: Set<string>;
      runs: number;
    }
  >();

  for (const family of approved) {
    const familyRuns = (runsByFingerprint.get(family.fingerprint) ?? []).length;
    for (const edge of family.statistics.edges) {
      const key = `${edge.fromLabel}\u0000${edge.toLabel}\u0000${edge.type}`;
      const existing = byKey.get(key);
      if (existing === undefined) {
        byKey.set(key, {
          fromLabel: edge.fromLabel,
          toLabel: edge.toLabel,
          type: edge.type,
          families: new Set([family.fingerprint]),
          runs: familyRuns,
        });
        continue;
      }
      existing.families.add(family.fingerprint);
      existing.runs += familyRuns;
    }
  }

  return [...byKey.values()]
    .map((entry) => ({
      fromLabel: entry.fromLabel,
      toLabel: entry.toLabel,
      type: entry.type,
      presence: totalRuns === 0 ? ONE_RATIO : ratio(entry.runs, totalRuns),
      families: sortedUnique(entry.families),
    }))
    .sort(
      (a, b) =>
        compareStrings(a.fromLabel, b.fromLabel) ||
        compareStrings(a.toLabel, b.toLabel) ||
        compareStrings(a.type, b.type),
    );
}

/**
 * Retry statistics across the approved runs.
 *
 * Retry numbers are part of a canonical label, so they are constant within a family; the distribution
 * is over runs, weighting each family by how many runs it has. `runTotal` sums the per-group maxima the
 * way the evaluator's retry budget does, so a proposed `maxRunTotal` bounds the quantity the evaluator
 * will actually compute.
 */
function aggregateRetries(
  approved: readonly RouteFamily[],
  runsByFingerprint: ReadonlyMap<string, readonly EligibleRun[]>,
): {
  readonly groups: readonly RetryAggregate[];
  readonly runTotal: Distribution | null;
  readonly sideEffectMax: Distribution | null;
} {
  const samplesByGroup = new Map<string, number[]>();
  const sideEffectsByGroup = new Map<string, Set<string>>();
  const operationsByGroup = new Map<string, Set<string>>();
  const runTotals: number[] = [];
  const sideEffectMaxima: number[] = [];

  for (const family of approved) {
    const familyRuns = (runsByFingerprint.get(family.fingerprint) ?? []).length;
    if (familyRuns === 0) continue;

    // Operations are recorded per label; a retry group is a tool name where one exists and a label
    // otherwise, so both spellings are indexed and looked up by group below.
    const operationsByLabelOrTool = new Map<string, Set<string>>();
    for (const node of family.statistics.nodes) {
      addAll(operationsByLabelOrTool, node.label, node.operations);
      if (node.tool !== null) addAll(operationsByLabelOrTool, node.tool, node.operations);
    }

    let total = 0;
    let sideEffectMax = 0;
    let anyRetryEvidence = false;

    for (const entry of family.statistics.retries) {
      anyRetryEvidence = true;
      const samples = samplesByGroup.get(entry.group) ?? [];
      for (let index = 0; index < familyRuns; index += 1) samples.push(entry.maxRetry);
      samplesByGroup.set(entry.group, samples);
      addAll(sideEffectsByGroup, entry.group, [entry.sideEffect]);
      addAll(operationsByGroup, entry.group, operationsByLabelOrTool.get(entry.group) ?? []);

      total += entry.maxRetry;
      if (entry.sideEffect.includes("write") || entry.sideEffect.includes("external")) {
        sideEffectMax = Math.max(sideEffectMax, entry.maxRetry);
      }
    }

    if (!anyRetryEvidence) continue;
    for (let index = 0; index < familyRuns; index += 1) {
      runTotals.push(total);
      sideEffectMaxima.push(sideEffectMax);
    }
  }

  // A group missing from one family contributed no sample for that family's runs. Padding with zero
  // would assert "this step ran once with no retry" for a run in which the step never ran at all.
  const groups: RetryAggregate[] = [...samplesByGroup.keys()].sort(compareStrings).map((group) => ({
    group,
    sideEffects: sortedUnique(sideEffectsByGroup.get(group) ?? []),
    operations: sortedUnique(operationsByGroup.get(group) ?? []),
    maxRetry: distributionOf(samplesByGroup.get(group) as number[]) as Distribution,
  }));

  return {
    groups,
    runTotal: distributionOf(runTotals),
    sideEffectMax: distributionOf(sideEffectMaxima),
  };
}

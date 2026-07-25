import type {
  AllowedValuesRule,
  ContractGate,
  ContractRule,
  RationalThreshold,
  ScalarValue,
  Selector,
  TrajectoryContract,
} from "@flightrules/contract-schema";
import {
  CONTRACT_API_VERSION,
  CONTRACT_KIND,
  contractContentHash,
  formatValidationErrors,
  validateContractValue,
} from "@flightrules/contract-schema";
import type { Severity } from "@flightrules/domain";
import { aggregateApproved, type BaselineAggregate } from "./aggregate.js";
import { gateDocument, ruleDocument } from "./document.js";
import type {
  BaselineVersion,
  Disclosure,
  DisclosureCode,
  EligibleRun,
  LabelAggregate,
  RouteFamily,
} from "./model.js";
import {
  compareStrings,
  isContractIdentifier,
  ruleIdentifier,
  sanitiseText,
  TEXT_LIMITS,
} from "./safety.js";
import {
  atLeastRatio,
  type Distribution,
  ONE_RATIO,
  type Ratio,
  ratioFromDecimal,
  withMargin,
} from "./statistics.js";

/** The DSL's own bound on a value list, so a proposal cannot exceed it (`CONTRACT_LIMITS`). */
const MAX_VALUE_LIST = 256;

/**
 * Rule proposal from approved route families (PRD Phase 08 tasks 9 to 11, FR-008).
 *
 * Every rule is derived from a counted observation and carries the observation with it. No model
 * participates: the classification of a step as required, the bound on a side effect, the retry
 * allowance, the route allowlist and every budget are all decided by the code below from the
 * aggregate of the approved families.
 *
 * The proposal is a `draft`. PRD FR-018 puts approval and activation behind a human, and PRD Phase
 * 08's test list requires that no rule is activated automatically, so there is no code path here that
 * produces any other state.
 */

/** Where a proposed rule's evidence came from. Each kind maps to one bullet of PRD FR-008. */
export const EVIDENCE_BASES = [
  "node_presence",
  "node_cardinality",
  "side_effect_cardinality",
  "side_effect_ancestry",
  "remote_handler_edge",
  "attribute_agreement",
  "observed_tools",
  "observed_services",
  "observed_data_domains",
  "observed_retries",
  "approved_route_family",
  "duration_percentile",
  "duration_maximum",
  "token_percentile",
] as const;

export type EvidenceBasis = (typeof EVIDENCE_BASES)[number];

/**
 * Why a rule is proposed, in a form a reviewer can check.
 *
 * `observed` and `recommended` are written by the code from the numbers, never generated as prose.
 * `requiresHumanConfirmation` is set whenever the recommendation is not simply the observation — which
 * is the case exactly when an outlier was excluded or a margin was applied.
 */
export interface RuleEvidenceBasis {
  readonly basis: EvidenceBasis;
  readonly subject: string;
  readonly sampleSize: number;
  readonly support: Ratio;
  readonly observed: string;
  readonly recommended: string;
  /** Approved family fingerprints the observation came from, sorted. */
  readonly families: readonly string[];
  readonly representativeTraceIds: readonly string[];
  /** Observed values the recommendation deliberately does not permit. */
  readonly outliers: readonly number[];
  readonly requiresHumanConfirmation: boolean;
}

export interface ProposedRule {
  readonly rule: ContractRule;
  readonly evidence: RuleEvidenceBasis;
}

export interface ContractProposal {
  /** The only state Phase 08 produces. PRD FR-018 owns every transition out of it. */
  readonly status: "draft";
  readonly baselineVersionId: string;
  readonly contract: TrajectoryContract;
  readonly contentHash: string;
  readonly rules: readonly ProposedRule[];
  readonly approvedFamilyFingerprints: readonly string[];
  readonly disclosures: readonly Disclosure[];
  /** Statements the reviewer is being asked to accept, written by the code. */
  readonly assumptions: readonly string[];
  readonly sampleSize: number;
  readonly normaliserVersion: string;
  readonly normaliserConfigHash: string;
  readonly aggregate: BaselineAggregate;
}

export const PROPOSAL_ERROR_CODES = [
  "NO_APPROVED_FAMILY",
  "BASELINE_NOT_REVIEWABLE",
  "NORMALISER_MISMATCH",
  "TOO_MANY_RULES",
  "GENERATED_CONTRACT_INVALID",
  "OPTION_INVALID",
] as const;

export type ProposalErrorCode = (typeof PROPOSAL_ERROR_CODES)[number];

export interface ProposalError {
  readonly code: ProposalErrorCode;
  readonly subject: string;
  readonly message: string;
}

export type ProposalResult =
  | { readonly ok: true; readonly proposal: ContractProposal }
  | { readonly ok: false; readonly errors: readonly ProposalError[] };

export interface ProposalOptionsInput {
  /** Human-readable contract name. Bounded, sanitised, never interpreted. */
  readonly contractName?: string;
  readonly contractVersion?: string;
  /** ISO-8601 instant with an explicit offset. Supplied, never read from the clock. */
  readonly createdAt: string;
  /** Contract environment. Must satisfy the DSL's identifier grammar. */
  readonly environment: string;
  readonly workflowName: string;
  readonly releaseAttribute?: string;
  readonly environmentAttribute?: string;
  /** Presence at or above which a step is *reported* as required. Default 1. */
  readonly requiredSupport?: number;
  /** Extra occurrences permitted above the recommended cardinality. Default 0. */
  readonly cardinalitySafetyMargin?: number;
  /** Extra retries permitted above the observed maximum. Never applied to a side effect. */
  readonly retrySafetyMargin?: number;
  /** Percentile used for the release-scoped latency budget. Default 95. */
  readonly latencyPercentile?: number;
  readonly latencyMarginPercent?: number;
  readonly runLatencyMarginPercent?: number;
  readonly tokenPercentile?: number;
  readonly tokenMarginPercent?: number;
  readonly minimumBudgetObservations?: number;
  readonly approvedRouteMinSimilarity?: number;
  readonly gate?: {
    readonly evaluationTimeoutSeconds?: number;
    readonly maxViolationPercent?: number;
    readonly maxUnknownRoutePercent?: number;
    readonly maxLatencyRegressionPercent?: number;
    readonly maxTokenRegressionPercent?: number;
  };
}

const OPTION_DEFAULTS = {
  contractVersion: "0.1.0",
  releaseAttribute: "agent.release.id",
  environmentAttribute: "deployment.environment.name",
  requiredSupport: 1,
  cardinalitySafetyMargin: 0,
  retrySafetyMargin: 0,
  latencyPercentile: 95,
  latencyMarginPercent: 20,
  runLatencyMarginPercent: 50,
  tokenPercentile: 95,
  tokenMarginPercent: 25,
  minimumBudgetObservations: 1,
  approvedRouteMinSimilarity: 0.92,
  gate: {
    evaluationTimeoutSeconds: 600,
    maxViolationPercent: 0.5,
    maxUnknownRoutePercent: 1,
    maxLatencyRegressionPercent: 20,
    maxTokenRegressionPercent: 25,
  },
} as const;

/**
 * Severity policy, as data.
 *
 * A read step is a *check*: skipping it is the fault the product exists to catch, so its absence is
 * critical. A write or external step is bounded by its own cardinality and attribute rules, which
 * carry the critical weight, so requiring its presence is high rather than critical — a refund that
 * did not happen is a different and less dangerous failure than a refund that happened twice.
 */
const PRESENCE_SEVERITY: Readonly<Record<string, Severity>> = {
  read: "critical",
  write: "high",
  external: "high",
  none: "high",
  unknown: "high",
};

function severityForPresence(sideEffects: readonly string[]): Severity {
  if (sideEffects.length !== 1) return "high";
  return PRESENCE_SEVERITY[sideEffects[0] as string] ?? "high";
}

function threshold(value: number): RationalThreshold {
  const exact = ratioFromDecimal(value);
  return { numerator: exact.numerator, denominator: exact.denominator, text: value.toString() };
}

interface ResolvedOptions {
  readonly contractName: string;
  readonly contractVersion: string;
  readonly createdAt: string;
  readonly environment: string;
  readonly workflowName: string;
  readonly releaseAttribute: string;
  readonly environmentAttribute: string;
  readonly requiredSupport: Ratio;
  readonly cardinalitySafetyMargin: number;
  readonly retrySafetyMargin: number;
  readonly latencyPercentile: number;
  readonly latencyMarginPercent: number;
  readonly runLatencyMarginPercent: number;
  readonly tokenPercentile: number;
  readonly tokenMarginPercent: number;
  readonly minimumBudgetObservations: number;
  readonly approvedRouteMinSimilarity: number;
  readonly gate: {
    readonly evaluationTimeoutSeconds: number;
    readonly maxViolationPercent: number;
    readonly maxUnknownRoutePercent: number;
    readonly maxLatencyRegressionPercent: number;
    readonly maxTokenRegressionPercent: number;
  };
}

type OptionResult =
  | { readonly ok: true; readonly options: ResolvedOptions }
  | { readonly ok: false; readonly error: ProposalError };

function resolveOptions(baseline: BaselineVersion, input: ProposalOptionsInput): OptionResult {
  if (!isContractIdentifier(input.environment)) {
    return {
      ok: false,
      error: {
        code: "OPTION_INVALID",
        subject: "environment",
        message: "The contract environment must satisfy the contract identifier grammar.",
      },
    };
  }
  const workflowName = sanitiseText(input.workflowName, TEXT_LIMITS.maxIdentifierLength);
  if (workflowName.value.length === 0) {
    return {
      ok: false,
      error: {
        code: "OPTION_INVALID",
        subject: "workflowName",
        message: "The workflow name must be non-empty after sanitisation.",
      },
    };
  }

  const gate = { ...OPTION_DEFAULTS.gate, ...(input.gate ?? {}) };

  const options: ResolvedOptions = {
    contractName: sanitiseText(
      input.contractName ?? `${baseline.agentKey} ${input.environment} contract`,
      200,
    ).value,
    contractVersion: input.contractVersion ?? OPTION_DEFAULTS.contractVersion,
    createdAt: input.createdAt,
    environment: input.environment,
    workflowName: workflowName.value,
    releaseAttribute: input.releaseAttribute ?? OPTION_DEFAULTS.releaseAttribute,
    environmentAttribute: input.environmentAttribute ?? OPTION_DEFAULTS.environmentAttribute,
    requiredSupport: ratioFromDecimal(input.requiredSupport ?? OPTION_DEFAULTS.requiredSupport),
    cardinalitySafetyMargin:
      input.cardinalitySafetyMargin ?? OPTION_DEFAULTS.cardinalitySafetyMargin,
    retrySafetyMargin: input.retrySafetyMargin ?? OPTION_DEFAULTS.retrySafetyMargin,
    latencyPercentile: input.latencyPercentile ?? OPTION_DEFAULTS.latencyPercentile,
    latencyMarginPercent: input.latencyMarginPercent ?? OPTION_DEFAULTS.latencyMarginPercent,
    runLatencyMarginPercent:
      input.runLatencyMarginPercent ?? OPTION_DEFAULTS.runLatencyMarginPercent,
    tokenPercentile: input.tokenPercentile ?? OPTION_DEFAULTS.tokenPercentile,
    tokenMarginPercent: input.tokenMarginPercent ?? OPTION_DEFAULTS.tokenMarginPercent,
    minimumBudgetObservations:
      input.minimumBudgetObservations ?? OPTION_DEFAULTS.minimumBudgetObservations,
    approvedRouteMinSimilarity:
      input.approvedRouteMinSimilarity ?? OPTION_DEFAULTS.approvedRouteMinSimilarity,
    gate,
  };

  return { ok: true, options };
}

/**
 * The recommended cardinality bound for a label.
 *
 * PRD FR-008 asks for "maximum observed cardinality with configurable safety margin". Read literally
 * that encodes an accidental duplicate side effect as permitted, which is the exact fault FlightRules
 * exists to catch. So the p95 of the per-run counts is the base: when the observed maximum exceeds it,
 * the maximum is an outlier and the recommendation stays at the p95 with the outlier disclosed and
 * flagged for confirmation. Otherwise the margin is applied to the observed maximum.
 */
export function recommendCardinality(
  cardinality: Distribution,
  safetyMargin: number,
): {
  readonly recommendedMax: number;
  readonly outliers: readonly number[];
  readonly requiresHumanConfirmation: boolean;
} {
  const base = cardinality.p95;
  if (cardinality.max > base) {
    return { recommendedMax: base, outliers: [cardinality.max], requiresHumanConfirmation: true };
  }
  const recommendedMax = withMargin(cardinality.max, 0) + safetyMargin;
  return {
    recommendedMax,
    outliers: [],
    requiresHumanConfirmation: safetyMargin > 0,
  };
}

interface Builder {
  readonly rules: ProposedRule[];
  readonly disclosures: Disclosure[];
  readonly zeroTolerance: Set<string>;
}

function disclose(
  builder: Builder,
  code: DisclosureCode,
  subject: string,
  detail: string,
  count: number,
): void {
  builder.disclosures.push({ code, subject, detail, count });
}

function representativesOf(
  families: readonly RouteFamily[],
  fingerprints: readonly string[],
): readonly string[] {
  const wanted = new Set(fingerprints);
  return families
    .filter((family) => wanted.has(family.fingerprint))
    .flatMap((family) => family.representativeTraceIds)
    .sort(compareStrings)
    .slice(0, 10);
}

function push(builder: Builder, rule: ContractRule, evidence: RuleEvidenceBasis): void {
  builder.rules.push({ rule, evidence });
  if (rule.severity === "critical") builder.zeroTolerance.add(rule.id);
}

/**
 * The contract-safe name of every canonical label, and the labels that have none.
 *
 * A selector can only say `name: X`, so two canonical labels that sanitise to the same text are
 * indistinguishable to the DSL — which is reachable from a hostile span name carrying a control
 * character, or from two names differing only past the length limit. Proposing a rule for either one
 * would produce a rule that also governs the other, so both are refused and disclosed instead. Rule
 * identifiers are derived from the same sanitised name as the selector, so an identifier always
 * describes the spans its rule actually selects.
 */
interface LabelNames {
  readonly byLabel: ReadonlyMap<string, string>;
  readonly ambiguous: readonly string[];
}

function resolveLabelNames(labels: readonly LabelAggregate[]): LabelNames {
  const labelsByName = new Map<string, string[]>();
  for (const label of labels) {
    const name = sanitiseText(label.label).value;
    const existing = labelsByName.get(name);
    if (existing === undefined) labelsByName.set(name, [label.label]);
    else existing.push(label.label);
  }

  const byLabel = new Map<string, string>();
  const ambiguous: string[] = [];
  for (const [name, owners] of labelsByName) {
    if (name.length === 0 || owners.length > 1) {
      ambiguous.push(...owners);
      continue;
    }
    byLabel.set(owners[0] as string, name);
  }

  return { byLabel, ambiguous: ambiguous.sort(compareStrings) };
}

function labelSelector(name: string): Selector {
  return { name };
}

function proposePresenceRules(
  builder: Builder,
  aggregate: BaselineAggregate,
  approved: readonly RouteFamily[],
  options: ResolvedOptions,
  rootLabels: readonly string[],
  names: LabelNames,
): void {
  for (const label of names.ambiguous) {
    disclose(
      builder,
      "LABEL_NOT_EXPRESSIBLE",
      label,
      "No contract selector can name this step without also naming another, so no rule is proposed for it.",
      1,
    );
  }

  for (const label of aggregate.labels) {
    // The run root is identified by `spec.selectors.rootSpan`; a rule requiring it would restate the
    // selector and would fail every trace the selector already rejected.
    if (rootLabels.includes(label.label)) continue;
    const name = names.byLabel.get(label.label);
    if (name === undefined) continue;

    if (label.presenceClass === "unobservable") {
      disclose(
        builder,
        "LABEL_UNOBSERVABLE",
        label.label,
        `Every run in which ${label.label} was absent could not observe the subtree it would have run under, so no presence rule is proposed.`,
        label.unobservableRuns,
      );
      continue;
    }

    if (label.remoteHandler) {
      proposeHandlerEdge(builder, label, approved, name, names);
      continue;
    }

    const recommendation = recommendCardinality(label.cardinality, options.cardinalitySafetyMargin);
    if (recommendation.outliers.length > 0) {
      disclose(
        builder,
        "CARDINALITY_OUTLIER",
        label.label,
        `${label.label} occurred up to ${label.cardinality.max} time(s) in one run while the 95th percentile is ${label.cardinality.p95}; the proposal permits ${recommendation.recommendedMax} and the outlier needs human confirmation.`,
        recommendation.outliers.length,
      );
    }

    const evidence: RuleEvidenceBasis = {
      basis: label.cardinality.min >= 1 ? "node_presence" : "node_cardinality",
      subject: label.label,
      sampleSize: label.observableRuns,
      support: label.presence,
      observed: `present in ${label.presence.numerator} of ${label.observableRuns} observable run(s); ${label.cardinality.min}..${label.cardinality.max} occurrence(s) per run, p95 ${label.cardinality.p95}`,
      recommended:
        label.cardinality.min >= 1
          ? `required, ${label.cardinality.min}..${recommendation.recommendedMax} per run`
          : `optional, at most ${recommendation.recommendedMax} per run`,
      families: label.families,
      representativeTraceIds: representativesOf(approved, label.families),
      outliers: recommendation.outliers,
      requiresHumanConfirmation: recommendation.requiresHumanConfirmation,
    };

    if (label.cardinality.min >= 1) {
      push(
        builder,
        {
          id: ruleIdentifier("require", name),
          type: "required_span",
          severity: severityForPresence(label.sideEffects),
          description: `Observed in every one of ${label.observableRuns} approved run(s).`,
          selector: labelSelector(name),
          cardinality: { min: label.cardinality.min, max: recommendation.recommendedMax },
        },
        evidence,
      );
      continue;
    }

    // Present in some runs and provably absent in others. Bounding it is evidence-exact; requiring it
    // would propose a rule the baseline itself violates.
    disclose(
      builder,
      "LABEL_OPTIONAL",
      label.label,
      atLeastRatio(label.presence, options.requiredSupport)
        ? `${label.label} appeared in ${label.presence.decimal} of the approved runs, at or above the required-support threshold, but not in all of them. It is proposed as bounded rather than required; promoting it is a review decision.`
        : `${label.label} appeared in ${label.presence.decimal} of the approved runs, so it is proposed as bounded rather than required.`,
      label.presence.numerator,
    );

    push(
      builder,
      {
        id: ruleIdentifier("bound", name),
        type: "cardinality",
        severity: "medium",
        description: `Observed in ${label.presence.numerator} of ${label.observableRuns} approved run(s).`,
        selector: labelSelector(name),
        min: 0,
        max: recommendation.recommendedMax,
        scope: "run",
      },
      evidence,
    );
  }
}

/**
 * A remote handler is required through the edge from its caller, not by its own presence.
 *
 * Phase 04's aborted payment attempt is the reason: the client span exists and the handler span was
 * never exported, so a `required_span` on the handler label would report a skipped step for a
 * telemetry gap. `required_edge` is the rule Phase 07 already reports as `insufficient_evidence` in
 * exactly that case, which is the honest answer.
 */
function proposeHandlerEdge(
  builder: Builder,
  label: LabelAggregate,
  approved: readonly RouteFamily[],
  name: string,
  names: LabelNames,
): void {
  for (const parent of label.parentLabels) {
    const parentName = names.byLabel.get(parent);
    if (parentName === undefined) continue;
    push(
      builder,
      {
        id: ruleIdentifier("answered", `${parentName}->${name}`),
        type: "required_edge",
        severity: "high",
        description: `${name} answered ${parentName} in every approved run.`,
        from: labelSelector(parentName),
        to: labelSelector(name),
        relationship: "direct",
      },
      {
        basis: "remote_handler_edge",
        subject: `${parentName} -> ${name}`,
        sampleSize: label.observableRuns,
        support: label.presence,
        observed: `${label.label} is a Server span under the Client span ${parent} in ${label.presence.numerator} of ${label.observableRuns} observable run(s)`,
        recommended: `${parent} must be answered directly by ${label.label}`,
        families: label.families,
        representativeTraceIds: representativesOf(approved, label.families),
        outliers: [],
        requiresHumanConfirmation: false,
      },
    );
  }
}

function proposeSideEffectRules(
  builder: Builder,
  aggregate: BaselineAggregate,
  approved: readonly RouteFamily[],
  rootLabels: readonly string[],
  names: LabelNames,
): void {
  for (const label of aggregate.labels) {
    if (label.presenceClass === "unobservable") continue;
    const name = names.byLabel.get(label.label);
    if (name === undefined) continue;
    if (label.sideEffects.length !== 1) continue;
    const sideEffect = label.sideEffects[0] as string;
    if (sideEffect !== "write" && sideEffect !== "external") continue;

    const recommendation = recommendCardinality(label.cardinality, 0);

    // Narrowed by the side-effect attribute as well as the name, so this bound and the presence rule
    // above select on different keys and cannot be read as contradicting each other.
    push(
      builder,
      {
        id: ruleIdentifier("single", `${name}|${sideEffect}`),
        type: "cardinality",
        severity: "critical",
        description: `A ${sideEffect} on ${label.label} occurred at most ${recommendation.recommendedMax} time(s) per approved run.`,
        selector: {
          name,
          attributes: [{ key: "agent.side_effect", operator: "equals", value: sideEffect }],
        },
        min: 0,
        max: recommendation.recommendedMax,
        scope: "run",
      },
      {
        basis: "side_effect_cardinality",
        subject: label.label,
        sampleSize: label.observableRuns,
        support: label.presence,
        observed: `${label.cardinality.min}..${label.cardinality.max} ${sideEffect} occurrence(s) per run, p95 ${label.cardinality.p95}`,
        recommended: `at most ${recommendation.recommendedMax} per run`,
        families: label.families,
        representativeTraceIds: representativesOf(approved, label.families),
        outliers: recommendation.outliers,
        requiresHumanConfirmation: recommendation.requiresHumanConfirmation,
      },
    );

    // A side effect must have happened inside the workflow, never standalone. Only proposed when
    // every approved family agrees on one root label, so the ancestor is a fact rather than a guess.
    const rootName =
      rootLabels.length === 1 ? sanitiseText(rootLabels[0] as string).value : undefined;
    if (rootName !== undefined && label.presence.numerator === label.observableRuns) {
      push(
        builder,
        {
          id: ruleIdentifier("within", `${rootName}->${name}`),
          type: "required_ancestry",
          severity: "high",
          description: `${name} ran inside ${rootName} in every approved run.`,
          ancestor: labelSelector(rootName),
          descendant: labelSelector(name),
          relationship: "any_depth",
        },
        {
          basis: "side_effect_ancestry",
          subject: `${rootName} -> ${name}`,
          sampleSize: label.observableRuns,
          support: ONE_RATIO,
          observed: `every ${name} span descended from ${rootName} in ${label.observableRuns} approved run(s)`,
          recommended: `${name} must descend from ${rootName}`,
          families: label.families,
          representativeTraceIds: representativesOf(approved, label.families),
          outliers: [],
          requiresHumanConfirmation: false,
        },
      );
    }

    for (const attribute of label.attributes) {
      // Only an attribute every span of the label carried, with one value, is a rule. Anything less is
      // a coincidence, and asserting it would fail a release for a run that was always permitted.
      if (attribute.support.numerator !== attribute.support.denominator) {
        continue;
      }
      push(
        builder,
        {
          id: ruleIdentifier("attribute", `${name}|${attribute.key}`),
          type: "attribute_constraint",
          severity: "critical",
          description: `Every ${name} span reported ${attribute.key} = ${String(attribute.value)}.`,
          selector: labelSelector(name),
          field: attribute.key,
          operator: "equals",
          value: attribute.value as ScalarValue,
        },
        {
          basis: "attribute_agreement",
          subject: `${label.label}.${attribute.key}`,
          sampleSize: attribute.totalSpans,
          support: attribute.support,
          observed: `${attribute.carryingSpans} of ${attribute.totalSpans} span(s) reported ${attribute.key} = ${String(attribute.value)}`,
          recommended: `${attribute.key} must equal ${String(attribute.value)}`,
          families: label.families,
          representativeTraceIds: representativesOf(approved, label.families),
          outliers: [],
          requiresHumanConfirmation: false,
        },
      );
    }
  }
}

function proposeAllowedValues(
  builder: Builder,
  aggregate: BaselineAggregate,
  approved: readonly RouteFamily[],
): void {
  const surfaces: readonly {
    readonly field: string;
    readonly values: readonly string[];
    readonly basis: EvidenceBasis;
    readonly prefix: string;
    readonly what: string;
  }[] = [
    {
      field: "gen_ai.tool.name",
      values: aggregate.tools,
      basis: "observed_tools",
      prefix: "tools",
      what: "tool",
    },
    {
      field: "service.name",
      values: aggregate.services,
      basis: "observed_services",
      prefix: "services",
      what: "service",
    },
    {
      field: "agent.data_domain",
      values: aggregate.dataDomains,
      basis: "observed_data_domains",
      prefix: "domains",
      what: "data domain",
    },
  ];

  for (const surface of surfaces) {
    if (surface.values.length === 0) continue;
    if (surface.values.length > MAX_VALUE_LIST) {
      // An allowlist longer than the DSL permits cannot be written, and truncating one would forbid
      // values the baseline actually observed — the opposite of what the rule is for.
      disclose(
        builder,
        "BUDGET_NOT_PROPOSED",
        surface.field,
        `The approved baseline used ${surface.values.length} distinct ${surface.what}(s), above the ${MAX_VALUE_LIST}-value maximum a contract allowlist may carry, so no allowlist is proposed for ${surface.field}.`,
        surface.values.length,
      );
      continue;
    }
    const values = surface.values.map((value) => sanitiseText(value).value).sort(compareStrings);

    const rule: AllowedValuesRule = {
      id: ruleIdentifier("approved", surface.prefix),
      type: "allowed_values",
      severity: "high",
      description: `The approved baseline used exactly these ${surface.values.length} ${surface.what}(s).`,
      field: surface.field,
      values,
    };

    push(builder, rule, {
      basis: surface.basis,
      subject: surface.field,
      sampleSize: aggregate.approvedRuns,
      support: ONE_RATIO,
      observed: `${surface.values.length} distinct value(s): ${values.join(", ")}`,
      recommended: `only these ${surface.values.length} value(s)`,
      families: aggregate.approvedFingerprints,
      representativeTraceIds: representativesOf(approved, aggregate.approvedFingerprints),
      outliers: [],
      requiresHumanConfirmation: false,
    });
  }
}

/**
 * Retry budget from observed retries.
 *
 * The side-effect allowance is never margined. A retried write is the duplicate side effect the
 * product exists to catch, so a proposal that permitted one because a margin was configured would
 * defeat its own purpose.
 */
function proposeRetryBudget(
  builder: Builder,
  aggregate: BaselineAggregate,
  approved: readonly RouteFamily[],
  options: ResolvedOptions,
): void {
  if (aggregate.retries.length === 0 || aggregate.retryRunTotal === null) {
    disclose(
      builder,
      "BUDGET_NOT_PROPOSED",
      "retries",
      "No approved run carried a retry number, so no retry budget is proposed. An absent retry attribute is not evidence that nothing was retried.",
      0,
    );
    return;
  }

  const operations = new Set<string>();
  for (const entry of aggregate.retries) {
    for (const operation of entry.operations) operations.add(operation);
  }

  const selector = selectorForOperations([...operations].sort(compareStrings));
  if (selector === null) {
    disclose(
      builder,
      "BUDGET_NOT_PROPOSED",
      "retries",
      "No retried step reported an operation name, so a retry budget could not be scoped to a selector.",
      0,
    );
    return;
  }

  const perTool = Math.max(...aggregate.retries.map((entry) => entry.maxRetry.max));
  const maxPerTool = perTool + options.retrySafetyMargin;
  const maxRunTotal = aggregate.retryRunTotal.max + options.retrySafetyMargin;
  const sideEffectMax = aggregate.retrySideEffectMax?.max ?? 0;

  push(
    builder,
    {
      id: ruleIdentifier("retries", "bounded"),
      type: "retry_budget",
      severity: "high",
      description: `Approved runs retried at most ${perTool} time(s) per step and ${aggregate.retryRunTotal.max} time(s) in total.`,
      selector,
      maxPerTool,
      maxRunTotal: Math.max(maxRunTotal, maxPerTool),
      sideEffectMax,
    },
    {
      basis: "observed_retries",
      subject: "retry budget",
      sampleSize: aggregate.approvedRuns,
      support: ONE_RATIO,
      observed: `per step 0..${perTool}, per run 0..${aggregate.retryRunTotal.max}, on a side effect 0..${sideEffectMax}`,
      recommended: `per step at most ${maxPerTool}, per run at most ${Math.max(maxRunTotal, maxPerTool)}, on a side effect at most ${sideEffectMax}`,
      families: aggregate.approvedFingerprints,
      representativeTraceIds: representativesOf(approved, aggregate.approvedFingerprints),
      outliers: [],
      requiresHumanConfirmation: options.retrySafetyMargin > 0,
    },
  );
}

/**
 * A selector covering the operations that carried retries.
 *
 * One operation becomes `operation: X`, which is what a hand-written contract would say. Several
 * become an `in` condition on the operation attribute, because the DSL's `operation` field holds one
 * string and silently picking one of several would leave the rest unbounded.
 */
function selectorForOperations(operations: readonly string[]): Selector | null {
  if (operations.length === 0) return null;
  if (operations.length === 1) {
    return {
      operation: sanitiseText(operations[0] as string, TEXT_LIMITS.maxIdentifierLength).value,
    };
  }
  return {
    attributes: [
      {
        key: "gen_ai.operation.name",
        operator: "in",
        value: operations.slice(0, MAX_VALUE_LIST).map((value) => sanitiseText(value).value),
      },
    ],
  };
}

function proposeApprovedRoutes(
  builder: Builder,
  aggregate: BaselineAggregate,
  approved: readonly RouteFamily[],
  options: ResolvedOptions,
): void {
  push(
    builder,
    {
      id: ruleIdentifier("route", "approved-family"),
      type: "approved_routes",
      severity: "high",
      description: `${aggregate.approvedFingerprints.length} approved route family/families.`,
      // Bare hexadecimal, matching the validated form. `ruleDocument` adds the `sha256:` prefix when
      // it renders the document, and validation strips it again.
      fingerprints: [...aggregate.approvedFingerprints],
      minSimilarity: threshold(options.approvedRouteMinSimilarity),
    },
    {
      basis: "approved_route_family",
      subject: "route identity",
      sampleSize: aggregate.approvedRuns,
      support: ONE_RATIO,
      observed: `${aggregate.approvedRuns} run(s) across ${aggregate.approvedFingerprints.length} approved family/families`,
      recommended: `only these ${aggregate.approvedFingerprints.length} fingerprint(s)`,
      families: aggregate.approvedFingerprints,
      representativeTraceIds: representativesOf(approved, aggregate.approvedFingerprints),
      outliers: [],
      requiresHumanConfirmation: false,
    },
  );
}

function proposeBudgets(
  builder: Builder,
  aggregate: BaselineAggregate,
  approved: readonly RouteFamily[],
  options: ResolvedOptions,
): void {
  if (aggregate.duration.available) {
    const distribution = aggregate.duration.distribution;
    const runMax = withMargin(distribution.max, options.runLatencyMarginPercent);
    push(
      builder,
      {
        id: ruleIdentifier("budget", "run.duration_ms"),
        type: "numeric_budget",
        severity: "medium",
        description: `Approved runs completed within ${distribution.max} ms.`,
        metric: "run.duration_ms",
        aggregation: "max",
        max: runMax,
        scope: "run",
      },
      {
        basis: "duration_maximum",
        subject: "run.duration_ms",
        sampleSize: distribution.count,
        support: aggregate.duration.coverage,
        observed: `${distribution.min}..${distribution.max} ms, median ${distribution.median} ms`,
        recommended: `at most ${runMax} ms per run (${options.runLatencyMarginPercent}% above the observed maximum)`,
        families: aggregate.approvedFingerprints,
        representativeTraceIds: representativesOf(approved, aggregate.approvedFingerprints),
        outliers: [],
        requiresHumanConfirmation: options.runLatencyMarginPercent > 0,
      },
    );

    const percentileValue = percentileFrom(distribution, options.latencyPercentile);
    const releaseMax = withMargin(percentileValue, options.latencyMarginPercent);
    push(
      builder,
      {
        id: ruleIdentifier("budget", "release.duration_ms"),
        type: "numeric_budget",
        severity: "medium",
        description: `Release-wide p${options.latencyPercentile} latency across the approved runs was ${percentileValue} ms.`,
        metric: "run.duration_ms",
        aggregation: aggregationFor(options.latencyPercentile),
        max: releaseMax,
        scope: "release",
      },
      {
        basis: "duration_percentile",
        subject: "run.duration_ms",
        sampleSize: distribution.count,
        support: aggregate.duration.coverage,
        observed: `p${options.latencyPercentile} ${percentileValue} ms over ${distribution.count} run(s)`,
        recommended: `at most ${releaseMax} ms (${options.latencyMarginPercent}% above the observed percentile)`,
        families: aggregate.approvedFingerprints,
        representativeTraceIds: representativesOf(approved, aggregate.approvedFingerprints),
        outliers: [],
        requiresHumanConfirmation: options.latencyMarginPercent > 0,
      },
    );
  } else {
    disclose(
      builder,
      "BUDGET_NOT_PROPOSED",
      "run.duration_ms",
      `No latency budget is proposed: ${aggregate.duration.reason} (${aggregate.duration.observedRuns} of ${aggregate.duration.totalRuns} run(s) reported it).`,
      aggregate.duration.observedRuns,
    );
  }

  for (const observation of [aggregate.inputTokens, aggregate.outputTokens] as const) {
    if (!observation.available) {
      // Absent token telemetry is never converted into a bound of zero. A run-scoped budget on a
      // metric nothing emits would report insufficient evidence on every run, which makes the whole
      // run insufficient_data and the contract unable to pass its own baseline.
      disclose(
        builder,
        "BUDGET_NOT_PROPOSED",
        observation.metric,
        `No ${observation.metric} budget is proposed: ${observation.reason} (${observation.observedRuns} of ${observation.totalRuns} run(s) reported it).`,
        observation.observedRuns,
      );
      continue;
    }

    const metric =
      observation.metric === "gen_ai.usage.input_tokens"
        ? "gen_ai.usage.input_tokens"
        : "gen_ai.usage.output_tokens";
    const percentileValue = percentileFrom(observation.distribution, options.tokenPercentile);
    const max = withMargin(percentileValue, options.tokenMarginPercent);

    push(
      builder,
      {
        id: ruleIdentifier("budget", metric),
        type: "numeric_budget",
        severity: "medium",
        description: `Release-wide p${options.tokenPercentile} ${metric} across the approved runs was ${percentileValue}.`,
        metric,
        aggregation: aggregationFor(options.tokenPercentile),
        max,
        scope: "release",
      },
      {
        basis: "token_percentile",
        subject: metric,
        sampleSize: observation.distribution.count,
        support: observation.coverage,
        observed: `p${options.tokenPercentile} ${percentileValue} over ${observation.distribution.count} run(s)`,
        recommended: `at most ${max} (${options.tokenMarginPercent}% above the observed percentile)`,
        families: aggregate.approvedFingerprints,
        representativeTraceIds: representativesOf(approved, aggregate.approvedFingerprints),
        outliers: [],
        requiresHumanConfirmation: options.tokenMarginPercent > 0,
      },
    );
  }
}

/**
 * Reads a percentile the distribution already carries, or recomputes it for an unusual one.
 *
 * The DSL's aggregations are `p95` and `p99`, so a configured percentile outside that set is a
 * reporting choice rather than a rule: the value is still computed from the samples, and
 * `aggregationFor` chooses the nearest expressible aggregation for the rule itself.
 */
function percentileFrom(distribution: Distribution, percentile: number): number {
  if (percentile === 50) return distribution.p50;
  if (percentile === 75) return distribution.p75;
  if (percentile === 90) return distribution.p90;
  if (percentile === 95) return distribution.p95;
  if (percentile === 99) return distribution.p99;
  // Only reachable for a percentile the distribution does not precompute; the samples are gone by
  // then, so the closest precomputed value is used and `aggregationFor` reports what the rule means.
  return percentile > 95 ? distribution.p99 : distribution.p95;
}

function aggregationFor(percentile: number): "p95" | "p99" {
  return percentile > 95 ? "p99" : "p95";
}

function buildGate(
  baseline: BaselineVersion,
  builder: Builder,
  options: ResolvedOptions,
): ContractGate {
  return {
    minCompletedRuns: baseline.minimumRuns,
    evaluationTimeoutSeconds: options.gate.evaluationTimeoutSeconds,
    maxViolationPercent: threshold(options.gate.maxViolationPercent),
    maxUnknownRoutePercent: threshold(options.gate.maxUnknownRoutePercent),
    maxLatencyRegressionPercent: threshold(options.gate.maxLatencyRegressionPercent),
    maxTokenRegressionPercent: threshold(options.gate.maxTokenRegressionPercent),
    zeroToleranceRuleIds: [...builder.zeroTolerance].sort(compareStrings),
  };
}

function assumptionsOf(
  aggregate: BaselineAggregate,
  baseline: BaselineVersion,
  options: ResolvedOptions,
): readonly string[] {
  return [
    `Every rule was derived from ${aggregate.approvedRuns} approved run(s) of release ${baseline.releaseId} between ${new Date(baseline.sourceTimeStartMs).toISOString()} and ${new Date(baseline.sourceTimeEndMs).toISOString()}.`,
    `A step is proposed as required only when it occurred in every observable approved run; the required-support threshold of ${options.requiredSupport.decimal} classifies the rest for review but never proposes a rule the baseline itself violates.`,
    `A cardinality bound is the 95th percentile of the observed per-run counts when the maximum exceeds it, so an outlying duplicate is disclosed rather than permitted.`,
    `Retry allowances on a side-effecting step are never widened by a safety margin.`,
    `Absent telemetry is never treated as zero: a metric no approved run reported is disclosed and no budget is proposed for it.`,
    `Route identity is exact by fingerprint under normaliser ${baseline.normaliserVersion} (${baseline.normaliserConfigHash.slice(0, 12)}); a similarity score only classifies a failure and never decides one.`,
    `This proposal is a draft. No rule is active until a human approves and activates the contract.`,
  ];
}

export interface ProposeInput {
  readonly baseline: BaselineVersion;
  readonly runsByFingerprint: ReadonlyMap<string, readonly EligibleRun[]>;
  readonly options: ProposalOptionsInput;
}

/**
 * Builds the draft contract proposal.
 *
 * The generated document goes through `validateContractValue` — the same validator a hand-written
 * contract goes through — before it is returned. A proposal that the validator would reject is a
 * defect in this file, not something to hand to a reviewer, and building the `TrajectoryContract`
 * object directly without validating it would let the miner produce a value the DSL cannot express.
 */
export function proposeContract(input: ProposeInput): ProposalResult {
  const errors: ProposalError[] = [];
  const { baseline } = input;

  if (baseline.status === "dataset_truncated" || baseline.status === "insufficient_runs") {
    errors.push({
      code: "BASELINE_NOT_REVIEWABLE",
      subject: baseline.id,
      message: `A baseline whose status is ${baseline.status} cannot found a contract proposal.`,
    });
  }

  const approved = baseline.families.filter((family) => family.status === "approved");
  if (approved.length === 0) {
    errors.push({
      code: "NO_APPROVED_FAMILY",
      subject: baseline.id,
      message: "No route family has been approved, so there is nothing to propose rules from.",
    });
  }

  for (const family of approved) {
    if (
      family.normaliserVersion !== baseline.normaliserVersion ||
      family.normaliserConfigHash !== baseline.normaliserConfigHash
    ) {
      errors.push({
        code: "NORMALISER_MISMATCH",
        subject: family.fingerprint,
        message: "This family was fingerprinted under a different normaliser than the baseline.",
      });
    }
  }

  const resolved = resolveOptions(baseline, input.options);
  if (!resolved.ok) errors.push(resolved.error);

  if (errors.length > 0 || !resolved.ok) {
    return { ok: false, errors: sortErrors(errors) };
  }
  const options = resolved.options;

  const aggregate = aggregateApproved({
    approved,
    runsByFingerprint: input.runsByFingerprint,
    options: {
      requiredSupport: options.requiredSupport,
      rareThreshold: baseline.rareThreshold,
    },
    minimumBudgetObservations: options.minimumBudgetObservations,
  });

  const rootLabels = rootLabelsOf(approved);
  const builder: Builder = { rules: [], disclosures: [], zeroTolerance: new Set() };

  const names = resolveLabelNames(aggregate.labels);
  proposePresenceRules(builder, aggregate, approved, options, rootLabels, names);
  proposeSideEffectRules(builder, aggregate, approved, rootLabels, names);
  proposeAllowedValues(builder, aggregate, approved);
  proposeRetryBudget(builder, aggregate, approved, options);
  proposeApprovedRoutes(builder, aggregate, approved, options);
  proposeBudgets(builder, aggregate, approved, options);

  if (builder.rules.length > TEXT_LIMITS.maxProposedRules) {
    return {
      ok: false,
      errors: [
        {
          code: "TOO_MANY_RULES",
          subject: baseline.id,
          message: `The baseline would produce ${builder.rules.length} rules, above the proposal maximum of ${TEXT_LIMITS.maxProposedRules}. Narrow the selection or approve fewer families.`,
        },
      ],
    };
  }

  const rootSpan =
    rootLabels.length === 1
      ? sanitiseText(rootLabels[0] as string, TEXT_LIMITS.maxIdentifierLength).value
      : "";

  const document = {
    apiVersion: CONTRACT_API_VERSION,
    kind: CONTRACT_KIND,
    metadata: {
      id: `${baseline.agentKey}-${options.environment}`.slice(0, TEXT_LIMITS.maxIdentifierLength),
      name: options.contractName,
      version: options.contractVersion,
      project: baseline.projectKey,
      agent: baseline.agentKey,
      environment: options.environment,
      createdAt: options.createdAt,
      baselineRelease: baseline.releaseId,
    },
    spec: {
      selectors: {
        workflowName: options.workflowName,
        releaseAttribute: options.releaseAttribute,
        environmentAttribute: options.environmentAttribute,
        ...(rootSpan.length === 0 ? {} : { rootSpan }),
      },
      approvedRoutes: aggregate.approvedFingerprints.map((fingerprint) => `sha256:${fingerprint}`),
      rules: builder.rules.map((entry) => ruleDocument(entry.rule, { prefixFingerprints: true })),
      gate: gateDocument(buildGate(baseline, builder, options)),
    },
  };

  const validated = validateContractValue(document);
  if (!validated.ok) {
    return {
      ok: false,
      errors: [
        {
          code: "GENERATED_CONTRACT_INVALID",
          subject: baseline.id,
          message: formatValidationErrors(validated.errors),
        },
      ],
    };
  }

  const disclosures = collectDisclosures(baseline, builder, aggregate);

  // The evidence is re-attached to the **validated** rules rather than to the ones this file built.
  // Validation normalises a selector, sorts a value list and strips a fingerprint prefix, so keeping
  // the pre-validation values would leave two descriptions of one rule that could quietly disagree.
  const evidenceByRuleId = new Map(builder.rules.map((entry) => [entry.rule.id, entry.evidence]));
  const rules: ProposedRule[] = validated.contract.spec.rules.map((rule) => ({
    rule,
    evidence: evidenceByRuleId.get(rule.id) as RuleEvidenceBasis,
  }));

  return {
    ok: true,
    proposal: {
      status: "draft",
      baselineVersionId: baseline.id,
      contract: validated.contract,
      contentHash: contractContentHash(validated.contract),
      rules: [...rules].sort((a, b) => compareStrings(a.rule.id, b.rule.id)),
      approvedFamilyFingerprints: aggregate.approvedFingerprints,
      disclosures,
      assumptions: assumptionsOf(aggregate, baseline, options),
      sampleSize: aggregate.approvedRuns,
      normaliserVersion: baseline.normaliserVersion,
      normaliserConfigHash: baseline.normaliserConfigHash,
      aggregate,
    },
  };
}

function sortErrors(errors: readonly ProposalError[]): readonly ProposalError[] {
  return [...errors].sort(
    (a, b) => compareStrings(a.code, b.code) || compareStrings(a.subject, b.subject),
  );
}

/** The canonical label at canonical order 0 in each approved family, deduplicated. */
function rootLabelsOf(approved: readonly RouteFamily[]): readonly string[] {
  const labels = new Set<string>();
  for (const family of approved) {
    const root = family.canonical.nodes.find((node) => node.order === 0);
    if (root !== undefined) labels.add(root.label);
  }
  return [...labels].sort(compareStrings);
}

function collectDisclosures(
  baseline: BaselineVersion,
  builder: Builder,
  aggregate: BaselineAggregate,
): readonly Disclosure[] {
  const disclosures: Disclosure[] = [...baseline.disclosures, ...builder.disclosures];

  if (aggregate.approvedFingerprints.length > 1) {
    disclosures.push({
      code: "MULTIPLE_FAMILIES_APPROVED",
      subject: "",
      detail: `${aggregate.approvedFingerprints.length} route families were approved, so a run matching any of them is on an approved route.`,
      count: aggregate.approvedFingerprints.length,
    });
  }

  const unapproved = baseline.families.filter((family) => family.status !== "approved");
  if (unapproved.length > 0) {
    disclosures.push({
      code: "UNAPPROVED_FAMILY_PRESENT",
      subject: "",
      detail: `${unapproved.length} route family/families in this baseline were not approved and contributed no evidence to any rule.`,
      count: unapproved.length,
    });
  }

  return dedupeDisclosures(disclosures);
}

/** Deduplicated and sorted, so a repeated proposal produces one identical list. */
function dedupeDisclosures(disclosures: readonly Disclosure[]): readonly Disclosure[] {
  const byKey = new Map<string, Disclosure>();
  for (const disclosure of disclosures) {
    byKey.set(`${disclosure.code}|${disclosure.subject}|${disclosure.detail}`, disclosure);
  }
  return [...byKey.values()].sort(
    (a, b) =>
      compareStrings(a.code, b.code) ||
      compareStrings(a.subject, b.subject) ||
      compareStrings(a.detail, b.detail),
  );
}

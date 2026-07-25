import { METRIC_NAMES } from "@flightrules/telemetry";
import { ARTIFACT_LABELS, type ArtifactLabel, managedName, type NameScope } from "./names.js";

/**
 * FR-015's four alerts.
 *
 * Shape taken from `signoz://alert/instructions` on the pinned server: `schemaVersion` `v2alpha1`,
 * a `threshold_rule`, `condition.thresholds.spec[]` tiers, and `evaluation.{kind, spec}`. Three
 * details from that document decide the payloads:
 *
 *   * the server **requires at least one existing notification channel name** in the payload even
 *     when `usePolicy` is true, so the channel is compiled and created before any alert;
 *   * `labels.severity` must be one of critical, error, warning, info and should match the highest
 *     threshold tier; and
 *   * `condition.alertOnAbsent` with `absentFor` in **minutes** is how "no data during an active
 *     canary window" is expressed. There is no separate absent-data rule type.
 *
 * A `recoveryTarget` is set on the rate alert so the recovery transition PRD Phase 10 asks to
 * observe is a real state change rather than a flap across the threshold.
 */

export type AlertSeverity = "critical" | "error" | "warning" | "info";

export interface AlertSpec {
  readonly alert: string;
  readonly alertType: "METRIC_BASED_ALERT";
  readonly ruleType: "threshold_rule";
  readonly schemaVersion: "v2alpha1";
  readonly description: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly annotations: Readonly<Record<string, string>>;
  readonly condition: Record<string, unknown>;
  readonly evaluation: Record<string, unknown>;
  readonly notificationSettings: Record<string, unknown>;
  readonly preferredChannels: readonly string[];
  readonly disabled: false;
}

interface AlertDefinition {
  readonly label: ArtifactLabel;
  readonly description: string;
  readonly severity: AlertSeverity;
  readonly metricName: string;
  readonly timeAggregation: "increase" | "rate" | "avg" | "max";
  readonly spaceAggregation: "sum" | "avg" | "max" | "p95";
  readonly op: "above" | "below";
  readonly target: number;
  readonly recoveryTarget: number | null;
  readonly matchType: "at_least_once" | "all_the_times" | "on_average" | "in_total";
  readonly unit: string;
  readonly alertOnAbsent: boolean;
  readonly absentForMinutes: number | null;
  readonly evalWindow: string;
  readonly summary: string;
}

/**
 * Thresholds.
 *
 * A duplicate side effect and a release-evaluation error are both "greater than zero" findings:
 * one occurrence is the incident. The violation rate carries a real threshold because a single
 * violation in a long window is a finding to read, not a page to send.
 */
function definitions(violationThreshold: number): readonly AlertDefinition[] {
  return [
    {
      label: ARTIFACT_LABELS.violationRateAlert,
      description: "Trajectory violations exceeded the permitted rate for this agent.",
      severity: "critical",
      metricName: METRIC_NAMES.violations,
      timeAggregation: "increase",
      spaceAggregation: "sum",
      op: "above",
      target: violationThreshold,
      // Hysteresis, so the recovery transition is a genuine state change.
      recoveryTarget: Math.max(0, Math.floor(violationThreshold / 2)),
      matchType: "at_least_once",
      unit: "none",
      alertOnAbsent: false,
      absentForMinutes: null,
      evalWindow: "5m0s",
      summary:
        "FlightRules recorded {{$value}} contract violations, above the threshold of {{$threshold}}.",
    },
    {
      label: ARTIFACT_LABELS.duplicateSideEffectAlert,
      description: "A write or external step ran more often than the active contract permits.",
      severity: "critical",
      metricName: METRIC_NAMES.duplicateSideEffects,
      timeAggregation: "increase",
      spaceAggregation: "sum",
      op: "above",
      target: 0,
      recoveryTarget: null,
      matchType: "at_least_once",
      unit: "none",
      alertOnAbsent: false,
      absentForMinutes: null,
      evalWindow: "5m0s",
      summary: "FlightRules recorded {{$value}} duplicate side effects.",
    },
    {
      label: ARTIFACT_LABELS.releaseEvaluationErrorAlert,
      description: "A contract evaluation could not complete.",
      severity: "error",
      metricName: METRIC_NAMES.evaluations,
      timeAggregation: "increase",
      spaceAggregation: "sum",
      op: "above",
      target: 0,
      recoveryTarget: null,
      matchType: "at_least_once",
      unit: "none",
      alertOnAbsent: false,
      absentForMinutes: null,
      evalWindow: "5m0s",
      summary: "{{$value}} contract evaluations ended in an error.",
    },
    {
      label: ARTIFACT_LABELS.noEvaluationDataAlert,
      description: "No contract evaluation was recorded during an active canary window.",
      severity: "warning",
      metricName: METRIC_NAMES.evaluations,
      timeAggregation: "increase",
      spaceAggregation: "sum",
      op: "below",
      target: 1,
      recoveryTarget: null,
      matchType: "all_the_times",
      unit: "none",
      alertOnAbsent: true,
      absentForMinutes: 15,
      evalWindow: "15m0s",
      summary: "FlightRules has evaluated no runs for this agent in the last 15 minutes.",
    },
  ];
}

/** The evaluation-error alert is the only one that filters on the outcome dimension. */
function filterFor(definition: AlertDefinition, scope: NameScope): string {
  const base = `project.slug = '${scope.projectSlug}' AND agent.key = '${scope.agentKey}'`;
  if (definition.label === ARTIFACT_LABELS.releaseEvaluationErrorAlert) {
    return `${base} AND status = 'error'`;
  }
  return base;
}

export function compileAlerts(
  scope: NameScope,
  channelName: string,
  violationThreshold: number,
  contractVersion: string,
): readonly AlertSpec[] {
  return definitions(violationThreshold).map((definition) => ({
    alert: managedName(scope, definition.label),
    alertType: "METRIC_BASED_ALERT" as const,
    ruleType: "threshold_rule" as const,
    schemaVersion: "v2alpha1" as const,
    description: definition.description,
    labels: {
      severity: definition.severity,
      managed_by: "flightrules",
      flightrules_project: scope.projectSlug,
      flightrules_agent: scope.agentKey,
      flightrules_contract_version: contractVersion,
    },
    annotations: {
      description: definition.description,
      summary: definition.summary,
    },
    condition: {
      alertOnAbsent: definition.alertOnAbsent,
      ...(definition.absentForMinutes === null ? {} : { absentFor: definition.absentForMinutes }),
      selectedQueryName: "A",
      compositeQuery: {
        queryType: "builder",
        panelType: "graph",
        unit: definition.unit,
        queries: [
          {
            type: "builder_query",
            spec: {
              name: "A",
              signal: "metrics",
              stepInterval: 60,
              disabled: false,
              aggregations: [
                {
                  metricName: definition.metricName,
                  timeAggregation: definition.timeAggregation,
                  spaceAggregation: definition.spaceAggregation,
                },
              ],
              filter: { expression: filterFor(definition, scope) },
              groupBy: [],
              limit: 100,
              order: [{ key: { name: "__result" }, direction: "desc" }],
            },
          },
        ],
      },
      thresholds: {
        kind: "basic",
        spec: [
          {
            name: definition.severity,
            target: definition.target,
            recoveryTarget: definition.recoveryTarget,
            op: definition.op,
            matchType: definition.matchType,
            channels: [channelName],
          },
        ],
      },
    },
    evaluation: {
      kind: "rolling",
      spec: { evalWindow: definition.evalWindow, frequency: "1m0s" },
    },
    notificationSettings: {
      groupBy: [],
      renotify: { enabled: false, interval: "30m" },
      usePolicy: false,
    },
    preferredChannels: [channelName],
    disabled: false as const,
  }));
}

/**
 * What a read-back must agree on.
 *
 * The name, the query the alert evaluates, and the threshold it evaluates against. A read-back that
 * agreed on the name and disagreed on the target would be an alert that cannot fire when the
 * product says it will, which is the failure this verification exists to catch.
 */
export function alertMaterialFields(spec: AlertSpec): Readonly<Record<string, unknown>> {
  const threshold = (spec.condition["thresholds"] as { spec: Record<string, unknown>[] }).spec[0];
  const query = (
    spec.condition["compositeQuery"] as {
      queries: { spec: Record<string, unknown> }[];
    }
  ).queries[0]?.spec;
  return {
    alert: spec.alert,
    alertType: spec.alertType,
    ruleType: spec.ruleType,
    "labels.severity": spec.labels["severity"],
    "condition.thresholds.spec.0.target": threshold?.["target"],
    "condition.thresholds.spec.0.op": threshold?.["op"],
    "condition.thresholds.spec.0.matchType": threshold?.["matchType"],
    "condition.thresholds.spec.0.channels": threshold?.["channels"],
    "condition.compositeQuery.queries.0.spec.aggregations.0.metricName": (
      query?.["aggregations"] as { metricName: string }[] | undefined
    )?.[0]?.metricName,
    "condition.compositeQuery.queries.0.spec.filter.expression": (
      query?.["filter"] as { expression: string } | undefined
    )?.expression,
  };
}

export const REQUIRED_ALERT_LABELS: readonly ArtifactLabel[] = [
  ARTIFACT_LABELS.violationRateAlert,
  ARTIFACT_LABELS.duplicateSideEffectAlert,
  ARTIFACT_LABELS.releaseEvaluationErrorAlert,
  ARTIFACT_LABELS.noEvaluationDataAlert,
];

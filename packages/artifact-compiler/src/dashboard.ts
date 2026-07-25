import { METRIC_NAMES } from "@flightrules/telemetry";
import { ARTIFACT_LABELS, managedName, type NameScope } from "./names.js";
import { FIELDS, FILTERS, type TypedField } from "./queries.js";

/**
 * FR-014's managed dashboard.
 *
 * The ten panel titles are the PRD's, verbatim and in its order. Shape taken from
 * `signoz://dashboard/instructions` and `signoz://dashboard/widgets-instructions` on the pinned
 * server, which differ from the saved-view shape in three ways that each cause a rejection or a
 * silently empty panel if ignored:
 *
 *   * ordering is the editor model `orderBy: [{columnName, order}]`, not the wire `order`;
 *   * `having` is an array on write — the object form is the GET response shape and is rejected;
 *   * `groupBy` entries use `key`, while `selectColumns` entries use `name`. Using the wrong one
 *     crashes the frontend rather than failing the write.
 *
 * The FlightRules counters arrive **cumulative**, which the live metric catalogue confirms. A
 * cumulative counter charted with `sum` draws a monotonically rising line that says nothing about
 * the window; `increase` is what "how many in this window" means, so every counter panel uses it.
 */

export type PanelType = "graph" | "table" | "value" | "list" | "bar" | "pie";

export interface DashboardWidget {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly panelTypes: PanelType;
  readonly query: Record<string, unknown>;
  readonly yAxisUnit?: string;
  /**
   * Fields the server's input schema requires on every widget.
   *
   * Omitting them does not fail the call — the server accepts it "best-effort" and appends an
   * input-validation notice — but a best-effort write is exactly the silently-wrong artefact this
   * phase exists to prevent, so they are always supplied.
   */
  readonly thresholds: readonly unknown[];
  readonly contextLinks: Readonly<Record<string, unknown>>;
  readonly selectedLogFields: readonly unknown[];
  readonly selectedTracesFields: readonly unknown[];
}

export interface DashboardLayoutItem {
  readonly i: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface DashboardSpec {
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly widgets: readonly DashboardWidget[];
  readonly layout: readonly DashboardLayoutItem[];
  readonly variables: Record<string, never>;
}

/**
 * A widget identifier must be stable across syncs, or every sync would replace every panel and the
 * layout would be rewritten each time. It is derived from the panel's position in the declaration,
 * never from a random UUID or a creation timestamp.
 */
function widgetId(index: number): string {
  return `flightrules-panel-${String(index + 1).padStart(2, "0")}`;
}

interface MetricQueryOptions {
  readonly metricName: string;
  readonly timeAggregation: "increase" | "rate" | "avg" | "max" | "sum" | "latest";
  readonly spaceAggregation: "sum" | "avg" | "max" | "min" | "p95";
  readonly filter: string;
  readonly groupBy: readonly { readonly key: string; readonly dataType: string }[];
  readonly legend: string;
  readonly panelType: PanelType;
}

function metricQuery(options: MetricQueryOptions): Record<string, unknown> {
  return {
    queryType: "builder",
    panelType: options.panelType,
    builder: {
      queryData: [
        {
          queryName: "A",
          dataSource: "metrics",
          expression: "A",
          disabled: false,
          stepInterval: 60,
          aggregations: [
            {
              metricName: options.metricName,
              timeAggregation: options.timeAggregation,
              spaceAggregation: options.spaceAggregation,
            },
          ],
          filter: { expression: options.filter },
          filters: { op: "AND", items: [] },
          groupBy: options.groupBy.map((entry) => ({
            key: entry.key,
            dataType: entry.dataType,
            type: "tag",
          })),
          having: [],
          legend: options.legend,
          limit: 100,
          orderBy: [{ columnName: "#SIGNOZ_VALUE", order: "desc" }],
          reduceTo: "sum",
          selectColumns: [],
          functions: [],
        },
      ],
      queryFormulas: [],
    },
    promql: [],
    clickhouse_sql: [],
  };
}

interface TraceQueryOptions {
  readonly aggregation: string;
  readonly filter: string;
  readonly groupBy: readonly TypedField[];
  readonly legend: string;
  readonly panelType: PanelType;
}

function traceQuery(options: TraceQueryOptions): Record<string, unknown> {
  return {
    queryType: "builder",
    panelType: options.panelType,
    builder: {
      queryData: [
        {
          queryName: "A",
          dataSource: "traces",
          expression: "A",
          disabled: false,
          stepInterval: 60,
          aggregations: [{ expression: options.aggregation }],
          filter: { expression: options.filter },
          filters: { op: "AND", items: [] },
          groupBy: options.groupBy.map((field) => ({
            key: field.name,
            dataType: field.dataType,
            type: field.context === "resource" ? "resource" : "tag",
          })),
          having: [],
          legend: options.legend,
          limit: 100,
          orderBy: [{ columnName: options.aggregation, order: "desc" }],
          reduceTo: "sum",
          selectColumns: [],
          functions: [],
        },
      ],
      queryFormulas: [],
    },
    promql: [],
    clickhouse_sql: [],
  };
}

function traceListQuery(filter: string, columns: readonly TypedField[]): Record<string, unknown> {
  return {
    queryType: "builder",
    panelType: "list",
    builder: {
      queryData: [
        {
          queryName: "A",
          dataSource: "traces",
          expression: "A",
          disabled: false,
          stepInterval: 0,
          aggregations: [{ expression: "count()" }],
          filter: { expression: filter },
          filters: { op: "AND", items: [] },
          groupBy: [],
          having: [],
          limit: 100,
          pageSize: 100,
          orderBy: [{ columnName: "timestamp", order: "desc" }],
          selectColumns: columns.map((field) => ({
            name: field.name,
            fieldContext: field.context,
            fieldDataType: field.dataType,
            signal: "traces",
          })),
          functions: [],
        },
      ],
      queryFormulas: [],
    },
    promql: [],
    clickhouse_sql: [],
  };
}

const AGENT_DIMENSIONS = (scope: NameScope): string =>
  `project.slug = '${scope.projectSlug}' AND agent.key = '${scope.agentKey}'`;

/**
 * The ten panels, in PRD FR-014 order. Titles are the PRD's exact wording.
 *
 * Panels 1–6 read the FlightRules metric pipeline. Panels 7–9 read the agent's own traces, which
 * is the only honest source for a baseline-versus-canary comparison of latency, tokens and
 * retries: those are properties of the agent, not of the evaluator. Panel 10 is the trace list.
 */
type DeclaredPanel = Omit<
  DashboardWidget,
  "id" | "thresholds" | "contextLinks" | "selectedLogFields" | "selectedTracesFields"
>;

function panels(scope: NameScope, rootSpanName: string): readonly DeclaredPanel[] {
  const dims = AGENT_DIMENSIONS(scope);
  return [
    {
      title: "Release decisions over time",
      description: "Contract evaluations completed, split by outcome.",
      panelTypes: "graph",
      yAxisUnit: "none",
      query: metricQuery({
        metricName: METRIC_NAMES.evaluations,
        timeAggregation: "increase",
        spaceAggregation: "sum",
        filter: dims,
        groupBy: [{ key: "status", dataType: "string" }],
        legend: "{{status}}",
        panelType: "graph",
      }),
    },
    {
      title: "Violation rate by release",
      description: "Violations recorded per release key over the selected window.",
      panelTypes: "graph",
      yAxisUnit: "none",
      query: metricQuery({
        metricName: METRIC_NAMES.violations,
        timeAggregation: "increase",
        spaceAggregation: "sum",
        filter: dims,
        groupBy: [{ key: "release.key", dataType: "string" }],
        legend: "{{release.key}}",
        panelType: "graph",
      }),
    },
    {
      title: "Violations by rule",
      description: "Violations grouped by the rule type that produced them, and by severity.",
      panelTypes: "table",
      query: metricQuery({
        metricName: METRIC_NAMES.violations,
        timeAggregation: "increase",
        spaceAggregation: "sum",
        filter: dims,
        groupBy: [
          { key: "rule.type", dataType: "string" },
          { key: "severity", dataType: "string" },
        ],
        legend: "{{rule.type}} - {{severity}}",
        panelType: "table",
      }),
    },
    {
      title: "Unknown route rate",
      description: "Runs whose route fingerprint the active contract does not approve.",
      panelTypes: "graph",
      yAxisUnit: "none",
      query: metricQuery({
        metricName: METRIC_NAMES.unknownRoutes,
        timeAggregation: "increase",
        spaceAggregation: "sum",
        filter: dims,
        groupBy: [{ key: "release.key", dataType: "string" }],
        legend: "{{release.key}}",
        panelType: "graph",
      }),
    },
    {
      title: "Duplicate side effects",
      description: "Write or external steps that occurred more often than the contract permits.",
      panelTypes: "graph",
      yAxisUnit: "none",
      query: metricQuery({
        metricName: METRIC_NAMES.duplicateSideEffects,
        timeAggregation: "increase",
        spaceAggregation: "sum",
        filter: dims,
        groupBy: [{ key: "release.key", dataType: "string" }],
        legend: "{{release.key}}",
        panelType: "graph",
      }),
    },
    {
      title: "Evaluation duration p95",
      description: "95th percentile wall-clock duration of a contract evaluation.",
      panelTypes: "graph",
      yAxisUnit: "ms",
      query: metricQuery({
        // A histogram lands in SigNoz as `.bucket`, `.count`, `.sum`, `.min` and `.max`. The
        // percentile is a spatial aggregation over the bucket series.
        metricName: `${METRIC_NAMES.evaluationDuration}.bucket`,
        timeAggregation: "rate",
        spaceAggregation: "p95",
        filter: dims,
        groupBy: [{ key: "scope", dataType: "string" }],
        legend: "{{scope}}",
        panelType: "graph",
      }),
    },
    {
      title: "Agent run latency baseline versus canary",
      description: "p95 root-span duration of the agent, split by release.",
      panelTypes: "graph",
      yAxisUnit: "ns",
      query: traceQuery({
        aggregation: "p95(duration_nano)",
        filter: FILTERS.allRuns(rootSpanName),
        groupBy: [FIELDS.releaseId],
        legend: "{{agent.release.id}}",
        panelType: "graph",
      }),
    },
    {
      title: "Token usage baseline versus canary",
      description:
        "Total generative-AI token usage per release. Empty when the agent emits no token attribute, which is a disclosure rather than a zero.",
      panelTypes: "graph",
      yAxisUnit: "none",
      query: traceQuery({
        aggregation: "sum(gen_ai.usage.input_tokens)",
        filter: `${FILTERS.allRuns(rootSpanName)} AND gen_ai.usage.input_tokens EXISTS`,
        groupBy: [FIELDS.releaseId],
        legend: "{{agent.release.id}}",
        panelType: "graph",
      }),
    },
    {
      title: "Retry count baseline versus canary",
      description: "Steps carrying a retry number above zero, split by release.",
      panelTypes: "graph",
      yAxisUnit: "none",
      query: traceQuery({
        aggregation: "count()",
        filter: `${FIELDS.retryNumber.name} > 0 AND ${FIELDS.releaseId.name} EXISTS`,
        groupBy: [FIELDS.releaseId],
        legend: "{{agent.release.id}}",
        panelType: "graph",
      }),
    },
    {
      title: "Latest violating traces",
      description: "The most recent runs the evaluator judged violating, newest first.",
      panelTypes: "list",
      query: traceListQuery(FILTERS.violatingRuns(), [
        FIELDS.evaluatedTraceId,
        FIELDS.releaseId,
        FIELDS.violationCount,
        FIELDS.zeroToleranceCount,
        FIELDS.evaluationStatus,
      ]),
    },
  ];
}

/** Two panels per row on a 12-column grid, six rows high, in declaration order. */
function layoutFor(count: number): readonly DashboardLayoutItem[] {
  return Array.from({ length: count }, (_unused, index) => ({
    i: widgetId(index),
    x: index % 2 === 0 ? 0 : 6,
    y: Math.floor(index / 2) * 6,
    w: 6,
    h: 6,
  }));
}

export function compileDashboard(
  scope: NameScope,
  rootSpanName: string,
  description: string,
  tags: readonly string[],
): DashboardSpec {
  const declared = panels(scope, rootSpanName);
  return {
    title: managedName(scope, ARTIFACT_LABELS.contractHealth),
    description,
    tags: [...tags],
    widgets: declared.map((panel, index) => ({
      ...panel,
      id: widgetId(index),
      thresholds: [],
      contextLinks: { linksData: [] },
      selectedLogFields: [],
      selectedTracesFields: [],
    })),
    layout: layoutFor(declared.length),
    variables: {},
  };
}

/** PRD FR-014's required panel titles, for the test that asserts none was dropped or renamed. */
export const REQUIRED_PANEL_TITLES: readonly string[] = [
  "Release decisions over time",
  "Violation rate by release",
  "Violations by rule",
  "Unknown route rate",
  "Duplicate side effects",
  "Evaluation duration p95",
  "Agent run latency baseline versus canary",
  "Token usage baseline versus canary",
  "Retry count baseline versus canary",
  "Latest violating traces",
];

/**
 * What a read-back must agree on.
 *
 * Every panel title and every panel's filter expression, because a dashboard that came back with
 * nine panels, or with one panel quietly rewritten, is not the dashboard the product promised.
 */
export function dashboardMaterialFields(spec: DashboardSpec): Readonly<Record<string, unknown>> {
  // A dashboard read-back nests the body one level down: `{id, webUrl, data: {title, widgets…}}`.
  // The paths are therefore prefixed, which is why the dashboard cannot share the view's helper.
  const fields: Record<string, unknown> = {
    "data.title": spec.title,
    "data.widgets.length": spec.widgets.length,
  };
  spec.widgets.forEach((widget, index) => {
    fields[`data.widgets.${index}.title`] = widget.title;
    fields[`data.widgets.${index}.id`] = widget.id;
    fields[`data.widgets.${index}.panelTypes`] = widget.panelTypes;
  });
  return fields;
}

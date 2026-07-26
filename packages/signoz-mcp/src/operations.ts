import type { z } from "zod";
import type { SigNozMcpClient } from "./client.js";
import type { McpResult } from "./outcome.js";
import {
  builderQueryReader,
  createdChannelReader,
  createdResourceReader,
  deletedResourceReader,
  fieldKeysReader,
  fieldValuesReader,
  listReader,
  metricSeriesReader,
  rowsOf,
  singleResourceReader,
} from "./readers.js";
import type {
  BuilderQueryPayload,
  CreatedChannelPayload,
  createdResourceSchema,
  DeletedResourcePayload,
  FieldKeysPayload,
  FieldValuesPayload,
  ListPayload,
  MetricSeriesPayload,
  SpanRow,
  singleResourceSchema,
} from "./schemas.js";
import { spanRowSchema } from "./schemas.js";

/**
 * Typed operations over the pinned tool surface. This is the interface later phases use; none of
 * them constructs a Query Builder request or reads an MCP envelope directly.
 *
 * Only operations the pinned v0.9.0 server actually exposes appear here. Nothing is stubbed: an
 * operation that does not exist is absent rather than present and faked.
 */

/** A field selection in a Query Builder request. */
export interface SelectField {
  readonly name: string;
  /**
   * `span` for built-in columns, `resource` for resource attributes, `tag` for custom span
   * attributes. Note the asymmetry: discovery tools accept `attribute` as an alias for `tag`, but
   * `selectFields` and `groupBy` require `tag` (SL-022).
   */
  readonly context: "span" | "resource" | "tag";
  readonly dataType?: "string" | "number" | "bool";
}

export interface TraceQuerySpec {
  /** Filter expression. SigNoz takes a string here, not a structured object (SL-021). */
  readonly filter: string;
  readonly selectFields: readonly SelectField[];
  /** Unix milliseconds. The `timestamp` column is nanoseconds; never filter on it inline. */
  readonly startMs: number;
  readonly endMs: number;
  readonly limit: number;
  readonly offset?: number;
  readonly orderDirection?: "asc" | "desc";
}

/**
 * Builds a Query Builder v5 raw request.
 *
 * Every `builder_query` needs a positive `limit` and a non-empty `order`; omitting either makes
 * the server substitute its own defaults and append a `[Decisions applied]` advisory, so both are
 * always supplied explicitly.
 */
export function buildTraceQuery(spec: TraceQuerySpec): Record<string, unknown> {
  if (!Number.isInteger(spec.limit) || spec.limit <= 0) {
    throw new RangeError(`limit must be a positive integer, received ${String(spec.limit)}`);
  }
  if (
    !Number.isFinite(spec.startMs) ||
    !Number.isFinite(spec.endMs) ||
    spec.endMs <= spec.startMs
  ) {
    throw new RangeError("endMs must be a finite value greater than startMs");
  }

  return {
    schemaVersion: "v1",
    start: spec.startMs,
    end: spec.endMs,
    requestType: "raw",
    compositeQuery: {
      queries: [
        {
          type: "builder_query",
          spec: {
            name: "A",
            signal: "traces",
            disabled: false,
            limit: spec.limit,
            offset: spec.offset ?? 0,
            order: [{ key: { name: "timestamp" }, direction: spec.orderDirection ?? "asc" }],
            having: { expression: "" },
            filter: { expression: spec.filter },
            selectFields: spec.selectFields.map((field) => ({
              name: field.name,
              fieldDataType: field.dataType ?? "string",
              signal: "traces",
              fieldContext: field.context,
            })),
          },
        },
      ],
    },
    formatOptions: { formatTableResultForUI: false, fillGaps: false },
    variables: {},
  };
}

export interface OperationContext {
  /** Verbatim intent, sent as `searchContext`. Required by the pinned server's tool schemas. */
  readonly searchContext: string;
}

export class SigNozOperations {
  readonly #client: SigNozMcpClient;

  constructor(client: SigNozMcpClient) {
    this.#client = client;
  }

  get client(): SigNozMcpClient {
    return this.#client;
  }

  // ---------------------------------------------------------------- traces

  /**
   * Runs a raw Query Builder request. This is the primary trace-evidence path:
   * `signoz_get_trace_details` cannot return custom span attributes (SL-020), so every attribute
   * a contract rule reads must come through here (SL-021).
   */
  async executeBuilderQuery(
    query: Record<string, unknown>,
    context: OperationContext,
  ): Promise<McpResult<BuilderQueryPayload>> {
    return this.#client.call({
      tool: "signoz_execute_builder_query",
      arguments: { query },
      reader: builderQueryReader,
      searchContext: context.searchContext,
    });
  }

  /** Fetches every span of one trace with the requested attributes selected. */
  async getTraceSpans(
    traceId: string,
    spec: Omit<TraceQuerySpec, "filter">,
    context: OperationContext,
  ): Promise<McpResult<BuilderQueryPayload>> {
    if (!isHexToken(traceId)) {
      throw new RangeError("traceId must be a hexadecimal token");
    }
    return this.executeBuilderQuery(
      buildTraceQuery({ ...spec, filter: `trace_id = '${traceId}'` }),
      context,
    );
  }

  async searchTraces(
    args: Readonly<Record<string, unknown>>,
    context: OperationContext,
  ): Promise<McpResult<BuilderQueryPayload>> {
    return this.#client.call({
      tool: "signoz_search_traces",
      arguments: args,
      reader: builderQueryReader,
      searchContext: context.searchContext,
    });
  }

  /**
   * Corroborating fetch used for hierarchy and trace-quality checks only. Its column set is fixed
   * and excludes custom attributes, so it is never the source of contract evidence (SL-020).
   */
  async getTraceDetails(
    traceId: string,
    args: Readonly<Record<string, unknown>>,
    context: OperationContext,
  ): Promise<McpResult<BuilderQueryPayload>> {
    return this.#client.call({
      tool: "signoz_get_trace_details",
      arguments: { traceId, ...args },
      reader: builderQueryReader,
      searchContext: context.searchContext,
    });
  }

  async aggregateTraces(
    args: Readonly<Record<string, unknown>>,
    context: OperationContext,
  ): Promise<McpResult<BuilderQueryPayload>> {
    return this.#client.call({
      tool: "signoz_aggregate_traces",
      arguments: args,
      reader: builderQueryReader,
      searchContext: context.searchContext,
    });
  }

  // ------------------------------------------------------------ discovery

  /**
   * Discovers field keys. Note that this tool accepts `attribute` where the Query Builder needs
   * `tag` for the same field context, so the alias is translated here rather than at every call
   * site (SL-022).
   */
  async getFieldKeys(
    args: { readonly signal: "traces" | "logs" | "metrics"; readonly searchText?: string },
    context: OperationContext,
  ): Promise<McpResult<FieldKeysPayload>> {
    return this.#client.call({
      tool: "signoz_get_field_keys",
      arguments: { ...args, fieldContext: "attribute" },
      reader: fieldKeysReader,
      searchContext: context.searchContext,
    });
  }

  /** The value parameter is `name`, not `key`; the server rejects `key` outright. */
  async getFieldValues(
    args: { readonly signal: "traces" | "logs" | "metrics"; readonly name: string },
    context: OperationContext,
  ): Promise<McpResult<FieldValuesPayload>> {
    return this.#client.call({
      tool: "signoz_get_field_values",
      arguments: { ...args },
      reader: fieldValuesReader,
      searchContext: context.searchContext,
    });
  }

  async listServices(
    args: Readonly<Record<string, unknown>>,
    context: OperationContext,
  ): Promise<McpResult<ListPayload>> {
    return this.#client.call({
      tool: "signoz_list_services",
      arguments: args,
      reader: listReader,
      searchContext: context.searchContext,
    });
  }

  async searchLogs(
    args: Readonly<Record<string, unknown>>,
    context: OperationContext,
  ): Promise<McpResult<BuilderQueryPayload>> {
    return this.#client.call({
      tool: "signoz_search_logs",
      arguments: args,
      reader: builderQueryReader,
      searchContext: context.searchContext,
    });
  }

  /**
   * Metric time series (PRD section 17.4, PRD Phase 15 task 6).
   *
   * The downstream-effect evidence a violation carries. `signoz_query_metrics` is listed in the
   * pinned server's capability snapshot; the arguments are passed through unchanged so this method
   * cannot become a second, divergent copy of the tool's own schema.
   */
  async queryMetrics(
    args: Readonly<Record<string, unknown>>,
    context: OperationContext,
  ): Promise<McpResult<MetricSeriesPayload>> {
    return this.#client.call({
      tool: "signoz_query_metrics",
      arguments: args,
      reader: metricSeriesReader,
      searchContext: context.searchContext,
    });
  }

  // -------------------------------------------------------------- views

  async listViews(sourcePage: string, context: OperationContext): Promise<McpResult<ListPayload>> {
    return this.#client.call({
      tool: "signoz_list_views",
      arguments: { sourcePage },
      reader: listReader,
      searchContext: context.searchContext,
    });
  }

  async getView(
    id: string,
    context: OperationContext,
  ): Promise<McpResult<z.infer<typeof singleResourceSchema>>> {
    return this.#client.call({
      tool: "signoz_get_view",
      arguments: { id },
      reader: singleResourceReader,
      searchContext: context.searchContext,
    });
  }

  /** Create tools take flat arguments, never a nested resource object (SL-023). */
  async createView(
    spec: Readonly<Record<string, unknown>>,
    context: OperationContext,
  ): Promise<McpResult<z.infer<typeof createdResourceSchema>>> {
    return this.#client.call({
      tool: "signoz_create_view",
      arguments: { ...spec },
      reader: createdResourceReader,
      searchContext: context.searchContext,
    });
  }

  /**
   * Replaces a saved view.
   *
   * The discovered schema takes `{id, view}` — a **nested** body, unlike every create tool and
   * unlike `signoz_update_alert`, which is flat. The asymmetry is real and is why each update has
   * its own wrapper rather than one generic one. `view` must be the complete resource: this is an
   * HTTP PUT upstream, so an omitted field is an erased field.
   */
  async updateView(
    id: string,
    view: Readonly<Record<string, unknown>>,
    context: OperationContext,
  ): Promise<McpResult<z.infer<typeof singleResourceSchema>>> {
    return this.#client.call({
      tool: "signoz_update_view",
      arguments: { id, view: { ...view } },
      reader: singleResourceReader,
      searchContext: context.searchContext,
    });
  }

  async deleteView(
    id: string,
    context: OperationContext,
  ): Promise<McpResult<DeletedResourcePayload>> {
    return this.#client.call({
      tool: "signoz_delete_view",
      arguments: { id },
      reader: deletedResourceReader,
      searchContext: context.searchContext,
    });
  }

  // --------------------------------------------------------- dashboards

  async listDashboards(context: OperationContext): Promise<McpResult<ListPayload>> {
    return this.#client.call({
      tool: "signoz_list_dashboards",
      arguments: {},
      reader: listReader,
      searchContext: context.searchContext,
    });
  }

  async getDashboard(
    id: string,
    context: OperationContext,
  ): Promise<McpResult<z.infer<typeof singleResourceSchema>>> {
    return this.#client.call({
      tool: "signoz_get_dashboard",
      arguments: { id },
      reader: singleResourceReader,
      searchContext: context.searchContext,
    });
  }

  async createDashboard(
    spec: Readonly<Record<string, unknown>>,
    context: OperationContext,
  ): Promise<McpResult<z.infer<typeof createdResourceSchema>>> {
    return this.#client.call({
      tool: "signoz_create_dashboard",
      arguments: { ...spec },
      reader: createdResourceReader,
      searchContext: context.searchContext,
    });
  }

  /** Nested, like `signoz_update_view`. Full replacement: send the complete dashboard. */
  async updateDashboard(
    id: string,
    dashboard: Readonly<Record<string, unknown>>,
    context: OperationContext,
  ): Promise<McpResult<z.infer<typeof singleResourceSchema>>> {
    return this.#client.call({
      tool: "signoz_update_dashboard",
      arguments: { id, dashboard: { ...dashboard } },
      reader: singleResourceReader,
      searchContext: context.searchContext,
    });
  }

  async deleteDashboard(
    id: string,
    context: OperationContext,
  ): Promise<McpResult<DeletedResourcePayload>> {
    return this.#client.call({
      tool: "signoz_delete_dashboard",
      arguments: { id },
      reader: deletedResourceReader,
      searchContext: context.searchContext,
    });
  }

  // ------------------------------------------------------------- alerts

  async listAlertRules(context: OperationContext): Promise<McpResult<ListPayload>> {
    return this.#client.call({
      tool: "signoz_list_alert_rules",
      arguments: {},
      reader: listReader,
      searchContext: context.searchContext,
    });
  }

  async getAlert(
    id: string,
    context: OperationContext,
  ): Promise<McpResult<z.infer<typeof singleResourceSchema>>> {
    return this.#client.call({
      tool: "signoz_get_alert",
      arguments: { id },
      reader: singleResourceReader,
      searchContext: context.searchContext,
    });
  }

  async createAlert(
    spec: Readonly<Record<string, unknown>>,
    context: OperationContext,
  ): Promise<McpResult<z.infer<typeof createdResourceSchema>>> {
    return this.#client.call({
      tool: "signoz_create_alert",
      arguments: { ...spec },
      reader: createdResourceReader,
      searchContext: context.searchContext,
    });
  }

  /**
   * Replaces an alert rule.
   *
   * Flat, with `id` alongside the fields — the opposite of `signoz_update_view` and
   * `signoz_update_dashboard`. Still a full replacement, so the complete rule is submitted.
   */
  async updateAlert(
    id: string,
    spec: Readonly<Record<string, unknown>>,
    context: OperationContext,
  ): Promise<McpResult<z.infer<typeof singleResourceSchema>>> {
    return this.#client.call({
      tool: "signoz_update_alert",
      arguments: { id, ...spec },
      reader: singleResourceReader,
      searchContext: context.searchContext,
    });
  }

  async deleteAlert(
    id: string,
    context: OperationContext,
  ): Promise<McpResult<DeletedResourcePayload>> {
    return this.#client.call({
      tool: "signoz_delete_alert",
      arguments: { id },
      reader: deletedResourceReader,
      searchContext: context.searchContext,
    });
  }

  /**
   * Alert history carries the firing and recovery states PRD section 16 requires proving. The
   * alert `id` is mandatory; the server rejects a call that omits it.
   */
  async getAlertHistory(
    id: string,
    args: Readonly<Record<string, unknown>>,
    context: OperationContext,
  ): Promise<McpResult<ListPayload>> {
    return this.#client.call({
      tool: "signoz_get_alert_history",
      arguments: { id, ...args },
      reader: listReader,
      searchContext: context.searchContext,
    });
  }

  // ---------------------------------------------- notification channels

  async listNotificationChannels(context: OperationContext): Promise<McpResult<ListPayload>> {
    return this.#client.call({
      tool: "signoz_list_notification_channels",
      arguments: {},
      reader: listReader,
      searchContext: context.searchContext,
    });
  }

  async getNotificationChannel(
    id: string,
    context: OperationContext,
  ): Promise<McpResult<z.infer<typeof singleResourceSchema>>> {
    return this.#client.call({
      tool: "signoz_get_notification_channel",
      arguments: { id },
      reader: singleResourceReader,
      searchContext: context.searchContext,
    });
  }

  /**
   * Flat, like every create tool. `type` and `name` are the only universally required fields.
   *
   * The response is *not* the create envelope: the server sends a real test notification during
   * creation and returns its outcome alongside the channel, so this call has its own reader.
   */
  async createNotificationChannel(
    spec: Readonly<Record<string, unknown>>,
    context: OperationContext,
  ): Promise<McpResult<CreatedChannelPayload>> {
    return this.#client.call({
      tool: "signoz_create_notification_channel",
      arguments: { ...spec },
      reader: createdChannelReader,
      searchContext: context.searchContext,
    });
  }

  async deleteNotificationChannel(
    id: string,
    context: OperationContext,
  ): Promise<McpResult<DeletedResourcePayload>> {
    return this.#client.call({
      tool: "signoz_delete_notification_channel",
      arguments: { id },
      reader: deletedResourceReader,
      searchContext: context.searchContext,
    });
  }

  /** Flat with `id`, and a full replacement: `type` and `name` are required on every update. */
  async updateNotificationChannel(
    id: string,
    spec: Readonly<Record<string, unknown>>,
    context: OperationContext,
  ): Promise<McpResult<z.infer<typeof singleResourceSchema>>> {
    return this.#client.call({
      tool: "signoz_update_notification_channel",
      arguments: { id, ...spec },
      reader: singleResourceReader,
      searchContext: context.searchContext,
    });
  }
}

/** Rejects anything that is not a hex token, closing the filter-injection path on trace IDs. */
export function isHexToken(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false;
  for (const character of value) {
    const isDigit = character >= "0" && character <= "9";
    const isLower = character >= "a" && character <= "f";
    const isUpper = character >= "A" && character <= "F";
    if (!isDigit && !isLower && !isUpper) return false;
  }
  return true;
}

/** Extracts span rows from a builder-query payload, validating the fields graph work requires. */
export function toSpanRows(payload: BuilderQueryPayload): {
  readonly spans: readonly (SpanRow & { readonly attributes: Record<string, unknown> })[];
  readonly rejected: number;
} {
  const spans: (SpanRow & { attributes: Record<string, unknown> })[] = [];
  let rejected = 0;

  for (const row of rowsOf(payload)) {
    const parsed = spanRowSchema.safeParse(row.data);
    if (!parsed.success) {
      rejected += 1;
      continue;
    }
    spans.push({ ...parsed.data, attributes: row.data });
  }

  return { spans, rejected };
}

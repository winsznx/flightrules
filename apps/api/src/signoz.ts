import { FlightRulesError } from "@flightrules/domain";
import {
  buildTraceQuery,
  type CapabilitySnapshot,
  metricPointsOf,
  type OperationContext,
  rowsOf,
  SigNozMcpClient,
  SigNozOperations,
  StreamableToolCaller,
} from "@flightrules/signoz-mcp";
import type { ApiConfig } from "./config.js";

/**
 * The API's SigNoz boundary.
 *
 * A narrow interface rather than the MCP client itself, for two reasons. The route handlers must
 * not hold a raw MCP payload — PRD section 12.3 puts validation at the API edge, and a handler that
 * reshapes an MCP response is a second, untested copy of `packages/signoz-mcp`. And a test needs to
 * drive dependency failure without a live SigNoz, which an interface makes ordinary.
 *
 * Only three operations belong to the API. Everything heavier — trace retrieval for mining and for
 * evaluation — is the worker's, because it is long-running and PRD section 12.3 assigns it there.
 */

export interface FieldDescriptor {
  readonly name: string;
  readonly fieldContext: string;
  readonly fieldDataType: string;
}

/** One correlated log line, already reduced to the fields PRD section 8.12 shows. */
export interface CorrelatedLogRow {
  readonly timestamp: string | null;
  readonly severity: string | null;
  readonly service: string | null;
  readonly body: string;
}

/** One metric observation, with the series it came from. */
export interface MetricPoint {
  readonly metric: string;
  readonly value: number | null;
  readonly timestamp: string | null;
  readonly labels: Readonly<Record<string, string>>;
}

export interface TracePreviewRow {
  readonly traceId: string;
  readonly name: string;
  readonly serviceName: string | null;
  readonly releaseId: string | null;
  readonly timestamp: string | null;
}

export interface SignozGateway {
  /** PRD section 16.4: discover the tool list and record it. Absence is a capability failure. */
  verify(): Promise<CapabilitySnapshot>;
  discoverFields(searchText: string | null): Promise<readonly FieldDescriptor[]>;
  previewTraces(input: {
    readonly filter: string;
    readonly startMs: number;
    readonly endMs: number;
    readonly limit: number;
  }): Promise<readonly TracePreviewRow[]>;
  /** PRD Phase 15 task 5: correlated logs, fetched on request, by verified trace identifier. */
  searchLogs(input: {
    readonly traceId: string;
    readonly startMs: number;
    readonly endMs: number;
    readonly limit: number;
  }): Promise<readonly CorrelatedLogRow[]>;
  /** PRD Phase 15 task 6: the downstream metric series a violation is associated with. */
  queryMetrics(input: {
    readonly metricName: string;
    readonly startMs: number;
    readonly endMs: number;
    readonly groupBy: readonly string[];
  }): Promise<readonly MetricPoint[]>;
  close(): Promise<void>;
}

const CONTEXT: OperationContext = {
  searchContext: "FlightRules API: verify the SigNoz connection and preview an agent's traces",
};

function failureToError(outcome: string): FlightRulesError {
  switch (outcome) {
    case "TRANSPORT_ERROR":
      return new FlightRulesError("SIGNOZ_UNREACHABLE");
    case "DECLARED_ERROR":
      return new FlightRulesError("TRACE_QUERY_FAILED");
    case "MALFORMED_RESPONSE":
    case "UNSUPPORTED_RESPONSE":
      return new FlightRulesError("MCP_RESPONSE_INVALID");
    default:
      return new FlightRulesError("MCP_UNAVAILABLE");
  }
}

/** The live gateway. One MCP connection per call site, closed by `close`. */
export function liveSignozGateway(config: ApiConfig): SignozGateway {
  const caller = new StreamableToolCaller({
    url: config.signozMcpUrl,
    apiKey: config.signozApiKey,
    clientName: "flightrules-api",
  });
  const client = new SigNozMcpClient({ caller, timeoutMs: config.mcpRequestTimeoutMs });
  const operations = new SigNozOperations(client);

  return {
    async verify() {
      return client.discoverCapabilities();
    },

    async discoverFields(searchText) {
      const result = await operations.getFieldKeys(
        { signal: "traces", ...(searchText === null ? {} : { searchText }) },
        CONTEXT,
      );
      if (result.outcome !== "SUCCESS_WITH_ROWS" && result.outcome !== "SUCCESS_EMPTY") {
        throw failureToError(result.outcome);
      }
      if (result.outcome === "SUCCESS_EMPTY") return [];
      const keys = result.value.data.keys ?? {};
      // SL-051: the catalogue reports a `fieldDataType` per field, which is what closes SL-046 by
      // discovery. An absent type is reported as such rather than defaulted, so a caller can see
      // exactly which fields the server declined to type.
      return Object.keys(keys)
        .sort()
        .flatMap((name) =>
          (keys[name] ?? []).map((descriptor) => ({
            name: descriptor.name,
            fieldContext: descriptor.fieldContext ?? "",
            fieldDataType: descriptor.fieldDataType ?? "",
          })),
        );
    },

    async previewTraces(input) {
      const result = await operations.executeBuilderQuery(
        buildTraceQuery({
          filter: input.filter,
          selectFields: [
            { name: "trace_id", context: "span", dataType: "string" },
            { name: "name", context: "span", dataType: "string" },
            { name: "service.name", context: "resource", dataType: "string" },
            { name: "agent.release.id", context: "tag", dataType: "string" },
          ],
          startMs: input.startMs,
          endMs: input.endMs,
          limit: input.limit,
          orderDirection: "desc",
        }),
        CONTEXT,
      );
      if (result.outcome === "SUCCESS_EMPTY") return [];
      if (result.outcome !== "SUCCESS_WITH_ROWS") throw failureToError(result.outcome);
      return rowsOf(result.value).map((row) => {
        const data = row.data as Record<string, unknown>;
        const asString = (key: string): string | null =>
          typeof data[key] === "string" ? (data[key] as string) : null;
        return {
          traceId: asString("trace_id") ?? "",
          name: asString("name") ?? "",
          serviceName: asString("service.name"),
          releaseId: asString("agent.release.id"),
          timestamp: asString("timestamp"),
        };
      });
    },

    async searchLogs(input) {
      // Correlated strictly by the trace identifier the evaluator recorded. Never by a time window
      // alone, and never by a service name, either of which would attach another run's logs to this
      // violation. The identifier is validated by the route before it reaches here.
      const result = await operations.searchLogs(
        {
          filter: `trace_id = '${input.traceId}'`,
          start: input.startMs,
          end: input.endMs,
          limit: input.limit,
        },
        CONTEXT,
      );
      if (result.outcome === "SUCCESS_EMPTY") return [];
      if (result.outcome !== "SUCCESS_WITH_ROWS") throw failureToError(result.outcome);

      return rowsOf(result.value).map((row) => {
        const data = row.data as Record<string, unknown>;
        const asString = (key: string): string | null =>
          typeof data[key] === "string" ? (data[key] as string) : null;
        /**
         * A log row is not shaped like a span row, and reading it as one produced a panel that
         * showed every body with no time and no service.
         *
         * `data.timestamp` on a log row is **nanoseconds as a number**, not the ISO string the row
         * itself carries alongside `data`. And `service.name` is a *resource* attribute, so it sits
         * under `resources_string` — the flat lookup that works for a span row finds nothing here.
         */
        const nested = (bag: string, key: string): string | null => {
          const container = data[bag];
          if (container === null || typeof container !== "object") return null;
          const value = (container as Record<string, unknown>)[key];
          return typeof value === "string" && value.length > 0 ? value : null;
        };
        return {
          timestamp: row.timestamp ?? asString("timestamp") ?? null,
          severity: asString("severity_text"),
          service:
            nested("resources_string", "service.name") ??
            nested("attributes_string", "service.name"),
          // Bounded here rather than at the page: a log body is the one field in this response whose
          // length is not under FlightRules' control.
          body: (asString("body") ?? "").slice(0, 2_000),
        };
      });
    },

    async queryMetrics(input) {
      const result = await operations.queryMetrics(
        {
          metricName: input.metricName,
          start: input.startMs,
          end: input.endMs,
          ...(input.groupBy.length === 0 ? {} : { groupBy: input.groupBy.join(",") }),
        },
        CONTEXT,
      );
      // The metric reader counts observations rather than rows (SL-062), so a populated time series
      // arrives as `SUCCESS_WITH_ROWS` and a genuinely absent series as `SUCCESS_EMPTY`.
      if (result.outcome === "SUCCESS_EMPTY") return [];
      if (result.outcome !== "SUCCESS_WITH_ROWS") throw failureToError(result.outcome);

      return metricPointsOf(result.value).map((point) => ({
        metric: input.metricName,
        value: point.value,
        timestamp: point.timestamp === null ? null : new Date(point.timestamp).toISOString(),
        labels: point.labels,
      }));
    },

    async close() {
      await client.close();
    },
  };
}

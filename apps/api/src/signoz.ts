import { FlightRulesError } from "@flightrules/domain";
import {
  buildTraceQuery,
  type CapabilitySnapshot,
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

    async close() {
      await client.close();
    },
  };
}

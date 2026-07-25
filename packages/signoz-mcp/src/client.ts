import { FlightRulesError } from "@flightrules/domain";
import type { z } from "zod";
import { classifyThrown } from "./classify.js";
import { normaliseToolResult, type PayloadReader } from "./normalise.js";
import type { McpResult } from "./outcome.js";
import { type Logger, silentLogger, type ToolCall, type ToolCaller } from "./transport.js";

/**
 * The 22 tools PRD section 16.4 requires. Absence of any one is a capability failure that must be
 * reported, not worked around: a client that silently degrades produces a release decision based
 * on less evidence than the contract assumes.
 */
export const REQUIRED_TOOLS = [
  "signoz_aggregate_traces",
  "signoz_create_alert",
  "signoz_create_dashboard",
  "signoz_create_view",
  "signoz_execute_builder_query",
  "signoz_get_alert",
  "signoz_get_alert_history",
  "signoz_get_dashboard",
  "signoz_get_field_keys",
  "signoz_get_field_values",
  "signoz_get_trace_details",
  "signoz_get_view",
  "signoz_list_alert_rules",
  "signoz_list_dashboards",
  "signoz_list_notification_channels",
  "signoz_list_services",
  "signoz_list_views",
  "signoz_search_logs",
  "signoz_search_traces",
  "signoz_update_alert",
  "signoz_update_dashboard",
  "signoz_update_view",
] as const;

export interface CapabilitySnapshot {
  readonly capturedAtUtc: string;
  readonly server: { readonly name: string; readonly version: string } | undefined;
  readonly toolNames: readonly string[];
  readonly resourceUris: readonly string[];
  readonly requiredPresent: readonly string[];
  readonly requiredMissing: readonly string[];
  readonly satisfied: boolean;
}

export interface RetryPolicy {
  /** Total attempts including the first. 1 disables retrying. */
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
}

export interface SigNozMcpClientOptions {
  readonly caller: ToolCaller;
  readonly logger?: Logger;
  readonly timeoutMs?: number;
  readonly retry?: Partial<RetryPolicy>;
  /** Consecutive transport failures before calls short-circuit. */
  readonly circuitBreakerThreshold?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, initialDelayMs: 200, maxDelayMs: 2_000 };
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_BREAKER_THRESHOLD = 5;

export interface CallOptions<TSchema extends z.ZodType> {
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly reader: PayloadReader<TSchema>;
  /** Verbatim user or job intent. The pinned server's schema asks for it on every tool. */
  readonly searchContext: string;
}

/**
 * The single point through which FlightRules talks to SigNoz.
 *
 * Nothing downstream sees a raw MCP object: callers receive a discriminated `McpResult`, so
 * "the query failed" cannot be mistaken for "the query found nothing". The client never throws
 * for a failure the server described — it throws only when the caller asked for something
 * impossible, such as a tool the server does not expose.
 */
export class SigNozMcpClient {
  readonly #caller: ToolCaller;
  readonly #log: Logger;
  readonly #timeoutMs: number;
  readonly #retry: RetryPolicy;
  readonly #breakerThreshold: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;

  #snapshot: CapabilitySnapshot | undefined;
  #consecutiveTransportFailures = 0;

  constructor(options: SigNozMcpClientOptions) {
    this.#caller = options.caller;
    this.#log = options.logger ?? silentLogger;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#retry = { ...DEFAULT_RETRY, ...options.retry };
    this.#breakerThreshold = options.circuitBreakerThreshold ?? DEFAULT_BREAKER_THRESHOLD;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? (() => Date.now());
  }

  /**
   * Discovers the live tool and resource surface and compares it with the required set. This is
   * the only place tool availability is decided; every call afterwards consults the snapshot
   * rather than the server.
   */
  async discoverCapabilities(): Promise<CapabilitySnapshot> {
    const [toolNames, resourceUris] = await Promise.all([
      this.#caller.listToolNames(),
      this.#caller.listResourceUris(),
    ]);

    const available = new Set(toolNames);
    const requiredPresent = REQUIRED_TOOLS.filter((tool) => available.has(tool));
    const requiredMissing = REQUIRED_TOOLS.filter((tool) => !available.has(tool));

    const snapshot: CapabilitySnapshot = {
      capturedAtUtc: new Date(this.#now()).toISOString(),
      server: this.#caller.serverInfo(),
      toolNames: [...toolNames].sort(),
      resourceUris: [...resourceUris].sort(),
      requiredPresent,
      requiredMissing,
      satisfied: requiredMissing.length === 0,
    };

    this.#snapshot = snapshot;
    this.#log({
      level: snapshot.satisfied ? "info" : "error",
      event: "mcp.capabilities.discovered",
      fields: {
        toolCount: snapshot.toolNames.length,
        requiredMissing: snapshot.requiredMissing,
        serverVersion: snapshot.server?.version,
      },
    });
    return snapshot;
  }

  get capabilities(): CapabilitySnapshot | undefined {
    return this.#snapshot;
  }

  /**
   * Reports whether a tool can be called. Returns a result rather than throwing so a caller can
   * degrade an optional feature deliberately, which is the PRD's requirement that an unsupported
   * operation produce an explicit capability result instead of a faked success.
   */
  supports(tool: string): boolean {
    return this.#snapshot === undefined ? false : this.#snapshot.toolNames.includes(tool);
  }

  #assertSupported(tool: string): void {
    if (this.#snapshot === undefined) return; // Discovery is optional; the server rejects unknown tools anyway.
    if (this.#snapshot.toolNames.includes(tool)) return;
    throw new FlightRulesError("MCP_TOOL_MISSING", {
      message: `The SigNoz MCP Server does not expose ${tool}, which FlightRules requires.`,
      details: { tool, serverVersion: this.#snapshot.server?.version },
    });
  }

  #backoffFor(attempt: number): number {
    const exponential = this.#retry.initialDelayMs * 2 ** (attempt - 1);
    const capped = Math.min(exponential, this.#retry.maxDelayMs);
    // Deterministic jitter derived from the attempt number. Randomness would make a failing test
    // irreproducible, and the goal here is only to avoid synchronised retries.
    return capped + (attempt % 2 === 0 ? Math.floor(capped / 4) : 0);
  }

  /**
   * Calls a tool and normalises the response.
   *
   * Retries are bounded and apply only to failures where the identical request may succeed. A
   * rejected credential, an absent tool and a malformed response are never retried: repeating a
   * write that already reached SigNoz is how duplicate managed resources appear.
   */
  async call<TSchema extends z.ZodType>(
    options: CallOptions<TSchema>,
  ): Promise<McpResult<z.infer<TSchema>>> {
    this.#assertSupported(options.tool);

    if (this.#consecutiveTransportFailures >= this.#breakerThreshold) {
      return {
        tool: options.tool,
        notices: [],
        durationMs: 0,
        outcome: "TRANSPORT_ERROR",
        code: "MCP_UNAVAILABLE",
        reason:
          `the circuit breaker is open after ${this.#consecutiveTransportFailures} consecutive ` +
          "transport failures; no call was attempted",
        retryable: false,
      };
    }

    const request: ToolCall = {
      name: options.tool,
      arguments: { searchContext: options.searchContext, ...options.arguments },
    };

    let lastFailure: McpResult<z.infer<TSchema>> | undefined;

    for (let attempt = 1; attempt <= this.#retry.maxAttempts; attempt += 1) {
      const startedAt = this.#now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

      try {
        const raw = await this.#caller.call(request, controller.signal);
        const result = normaliseToolResult({
          tool: options.tool,
          raw,
          reader: options.reader,
          durationMs: this.#now() - startedAt,
        });

        this.#consecutiveTransportFailures = 0;
        this.#logResult(options.tool, attempt, result);

        // A response that arrived is a response. Only transport failures are worth repeating;
        // re-sending a request the server already answered would not change the answer.
        return result;
      } catch (error) {
        const classified = classifyThrown(error, options.tool);
        const failure: McpResult<z.infer<TSchema>> = {
          tool: options.tool,
          notices: [],
          durationMs: this.#now() - startedAt,
          outcome: "TRANSPORT_ERROR",
          code: classified.code,
          reason: classified.reason,
          retryable: classified.retryable,
        };
        lastFailure = failure;

        this.#log({
          level: "warn",
          event: "mcp.call.failed",
          fields: {
            tool: options.tool,
            attempt,
            code: classified.code,
            retryable: classified.retryable,
            reason: classified.reason,
          },
        });

        if (!classified.retryable || attempt === this.#retry.maxAttempts) {
          this.#consecutiveTransportFailures += 1;
          return failure;
        }
        await this.#sleep(this.#backoffFor(attempt));
      } finally {
        clearTimeout(timer);
      }
    }

    /* c8 ignore next 2 -- the loop always returns; this satisfies the compiler's exhaustiveness. */
    this.#consecutiveTransportFailures += 1;
    return lastFailure as McpResult<z.infer<TSchema>>;
  }

  #logResult(tool: string, attempt: number, result: McpResult<unknown>): void {
    const level = result.outcome.startsWith("SUCCESS") ? "debug" : "warn";
    this.#log({
      level,
      event: "mcp.call.completed",
      fields: {
        tool,
        attempt,
        outcome: result.outcome,
        durationMs: result.durationMs,
        rowCount: "rowCount" in result ? result.rowCount : undefined,
        noticeCount: result.notices.length,
        // Arguments are deliberately absent: PRD section 17.6 forbids persisting tool arguments.
      },
    });
  }

  async close(): Promise<void> {
    await this.#caller.close();
  }
}

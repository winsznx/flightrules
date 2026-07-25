import { redact, registerSecretValue } from "@flightrules/domain";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RawToolResult } from "./normalise.js";

/**
 * The transport boundary. Everything above it is pure and unit-testable; everything below it
 * needs a running SigNoz MCP Server. Unit tests inject a `ToolCaller` and never open a socket,
 * while integration tests use `StreamableToolCaller` against the real pinned server.
 */

export interface ToolCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface ToolCaller {
  call(request: ToolCall, signal: AbortSignal): Promise<RawToolResult>;
  listToolNames(): Promise<readonly string[]>;
  listResourceUris(): Promise<readonly string[]>;
  serverInfo(): { readonly name: string; readonly version: string } | undefined;
  close(): Promise<void>;
}

export interface StreamableTransportOptions {
  readonly url: string;
  readonly apiKey: string;
  readonly clientName?: string;
  readonly clientVersion?: string;
}

/**
 * The real transport. The API key is registered as a secret value at construction so that even an
 * interpolated error message containing it is redacted before it reaches a log or an evidence
 * file (PRD section 18.2: secrets remain server-side).
 */
export class StreamableToolCaller implements ToolCaller {
  readonly #client: Client;
  readonly #transport: StreamableHTTPClientTransport;
  /**
   * The in-flight or completed handshake. A boolean flag is not enough: capability discovery
   * lists tools and resources concurrently, and with a flag set only after the await both callers
   * enter the handshake and the SDK rejects the second with "Already connected to a transport".
   */
  #connecting: Promise<void> | undefined;

  constructor(options: StreamableTransportOptions) {
    registerSecretValue(options.apiKey);
    this.#transport = new StreamableHTTPClientTransport(new URL(options.url), {
      requestInit: { headers: { "SIGNOZ-API-KEY": options.apiKey } },
    });
    this.#client = new Client(
      {
        name: options.clientName ?? "flightrules",
        version: options.clientVersion ?? "0.1.0",
      },
      { capabilities: {} },
    );
  }

  connect(): Promise<void> {
    if (this.#connecting !== undefined) return this.#connecting;
    // The SDK's own declarations disagree at v1.29.0: `Transport` declares `sessionId?: string`
    // while `StreamableHTTPClientTransport` exposes a getter returning `string | undefined`. Under
    // `exactOptionalPropertyTypes` those are not assignable, though they are behaviourally the
    // same. Asserting to the SDK's real `Transport` type bridges the defect without weakening any
    // member FlightRules uses, and without suppressing the checker. Recorded as SL-041.
    const attempt = this.#client.connect(this.#transport as Transport);
    // A failed handshake must not be cached, or every later call reports the first failure.
    this.#connecting = attempt.catch((error: unknown) => {
      this.#connecting = undefined;
      throw error;
    });
    return this.#connecting;
  }

  async call(request: ToolCall, signal: AbortSignal): Promise<RawToolResult> {
    await this.connect();
    const result = await this.#client.callTool(
      { name: request.name, arguments: { ...request.arguments } },
      undefined,
      { signal },
    );
    return result as RawToolResult;
  }

  async listToolNames(): Promise<readonly string[]> {
    await this.connect();
    const { tools } = await this.#client.listTools();
    return tools.map((tool) => tool.name);
  }

  async listResourceUris(): Promise<readonly string[]> {
    await this.connect();
    const { resources } = await this.#client.listResources();
    return resources.map((resource) => resource.uri);
  }

  serverInfo(): { readonly name: string; readonly version: string } | undefined {
    const info = this.#client.getServerVersion();
    if (info === undefined) return undefined;
    return { name: info.name, version: info.version };
  }

  async close(): Promise<void> {
    if (this.#connecting === undefined) return;
    this.#connecting = undefined;
    await this.#client.close();
  }
}

export interface LogRecord {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export type Logger = (record: LogRecord) => void;

export const silentLogger: Logger = () => {};

/**
 * Wraps a logger so every field passes through the domain redactor. Tool arguments are never
 * logged in full: PRD section 17.6 forbids persisting tool arguments, and a trace filter
 * expression can contain customer identifiers.
 */
export function redactingLogger(sink: Logger): Logger {
  return (record) => {
    sink({
      level: record.level,
      event: record.event,
      fields: redact(record.fields) as Readonly<Record<string, unknown>>,
    });
  };
}

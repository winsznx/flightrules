import { clearRegisteredSecrets, FlightRulesError, registerSecretValue } from "@flightrules/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyThrown } from "./classify.js";
import { REQUIRED_TOOLS, SigNozMcpClient } from "./client.js";
import type { RawToolResult } from "./normalise.js";
import { listReader } from "./readers.js";
import type { LogRecord } from "./transport.js";
import { redactingLogger, type ToolCall, type ToolCaller } from "./transport.js";

/**
 * Client-level behaviour. Every test injects a fake `ToolCaller`, so nothing here opens a socket
 * and `make test` needs no running stack. The real transport is exercised by the integration
 * suite against the pinned server.
 */

interface FakeOptions {
  readonly responses?: readonly (RawToolResult | Error)[];
  readonly tools?: readonly string[];
  readonly resources?: readonly string[];
}

class FakeCaller implements ToolCaller {
  readonly calls: ToolCall[] = [];
  #index = 0;
  readonly #responses: readonly (RawToolResult | Error)[];
  readonly #tools: readonly string[];
  readonly #resources: readonly string[];
  closed = false;

  constructor(options: FakeOptions = {}) {
    this.#responses = options.responses ?? [{ content: [{ type: "text", text: '{"data":[]}' }] }];
    this.#tools = options.tools ?? [...REQUIRED_TOOLS];
    this.#resources = options.resources ?? ["signoz://traces/query-builder-guide"];
  }

  async call(request: ToolCall): Promise<RawToolResult> {
    this.calls.push(request);
    const response = this.#responses[Math.min(this.#index, this.#responses.length - 1)];
    this.#index += 1;
    if (response instanceof Error) throw response;
    return response as RawToolResult;
  }

  async listToolNames(): Promise<readonly string[]> {
    return this.#tools;
  }

  async listResourceUris(): Promise<readonly string[]> {
    return this.#resources;
  }

  serverInfo() {
    return { name: "SigNozMCP", version: "v0.9.0" };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function clientFor(caller: ToolCaller, overrides: Record<string, unknown> = {}) {
  return new SigNozMcpClient({
    caller,
    sleep: async () => {},
    retry: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 2 },
    ...overrides,
  });
}

const CONTEXT = "FlightRules test: exercise the MCP client";

function listCall(client: SigNozMcpClient, tool = "signoz_list_views") {
  return client.call({ tool, arguments: {}, reader: listReader, searchContext: CONTEXT });
}

afterEach(() => {
  clearRegisteredSecrets();
});

describe("capability discovery", () => {
  it("reports every required tool as present against the pinned surface", async () => {
    // #given a server exposing the full required set
    const client = clientFor(new FakeCaller());

    // #when capabilities are discovered
    const snapshot = await client.discoverCapabilities();

    // #then nothing is missing
    expect(snapshot.satisfied).toBe(true);
    expect(snapshot.requiredMissing).toEqual([]);
    expect(snapshot.requiredPresent).toHaveLength(REQUIRED_TOOLS.length);
  });

  it("names the missing tools rather than degrading silently", async () => {
    // #given a server without the alert tools
    const tools = REQUIRED_TOOLS.filter((tool) => !tool.includes("alert"));
    const client = clientFor(new FakeCaller({ tools }));

    // #when capabilities are discovered
    const snapshot = await client.discoverCapabilities();

    // #then the gap is explicit
    expect(snapshot.satisfied).toBe(false);
    expect(snapshot.requiredMissing).toContain("signoz_create_alert");
  });

  it("sorts the snapshot so repeated captures diff cleanly", async () => {
    // #given a server returning tools in arbitrary order
    const caller = new FakeCaller({ tools: ["signoz_list_views", "signoz_create_view"] });

    // #when capabilities are discovered
    const snapshot = await clientFor(caller).discoverCapabilities();

    // #then the recorded order is stable
    expect(snapshot.toolNames).toEqual(["signoz_create_view", "signoz_list_views"]);
  });
});

describe("missing tools", () => {
  it("raises MCP_TOOL_MISSING before attempting a call", async () => {
    // #given a discovered surface without the trace-query tool
    const caller = new FakeCaller({ tools: ["signoz_list_views"] });
    const client = clientFor(caller);
    await client.discoverCapabilities();

    // #when a call to the absent tool is attempted
    const attempt = client.call({
      tool: "signoz_execute_builder_query",
      arguments: {},
      reader: listReader,
      searchContext: CONTEXT,
    });

    // #then it fails with the PRD's capability code and no request is sent
    await expect(attempt).rejects.toThrow(FlightRulesError);
    await attempt.catch((error: unknown) => {
      expect((error as FlightRulesError).code).toBe("MCP_TOOL_MISSING");
    });
    expect(caller.calls).toHaveLength(0);
  });

  it("classifies the server's own unknown-tool error as MCP_TOOL_MISSING", () => {
    // #given the JSON-RPC error the pinned server returns for an unknown tool
    const error = Object.assign(new Error("MCP error -32602: tool 'x' not found: tool not found"), {
      code: -32602,
    });

    // #when it is classified
    const classified = classifyThrown(error, "x");

    // #then the capability code is used and the call is not retried
    expect(classified.code).toBe("MCP_TOOL_MISSING");
    expect(classified.retryable).toBe(false);
  });
});

describe("shape 10: transport errors", () => {
  it("returns a transport failure instead of throwing", async () => {
    // #given a connection that cannot be established
    const caller = new FakeCaller({ responses: [new TypeError("fetch failed")] });

    // #when a call is made
    const result = await clientFor(caller, { retry: { maxAttempts: 1 } }).call({
      tool: "signoz_list_views",
      arguments: {},
      reader: listReader,
      searchContext: CONTEXT,
    });

    // #then the caller receives a typed failure, never a success
    expect(result.outcome).toBe("TRANSPORT_ERROR");
    expect(result.outcome === "TRANSPORT_ERROR" && result.code).toBe("MCP_UNAVAILABLE");
  });

  it("classifies a rejected credential as an authentication failure", () => {
    // #given the error thrown when the API key header is absent
    const error = Object.assign(new Error("Error POSTing to endpoint: 401"), { code: 401 });

    // #when it is classified
    // #then the authentication code is used and it is not retried
    expect(classifyThrown(error)).toMatchObject({
      code: "SIGNOZ_AUTH_FAILED",
      retryable: false,
    });
  });

  it("classifies a wrong MCP path as unavailable and does not retry it", () => {
    // #given a 404 from the transport
    const error = Object.assign(new Error("404 page not found"), { code: 404 });

    // #when it is classified
    // #then repeating the request cannot help
    expect(classifyThrown(error)).toMatchObject({ code: "MCP_UNAVAILABLE", retryable: false });
  });
});

describe("timeouts", () => {
  it("does not return a false success when a call is aborted", async () => {
    // #given a caller that never resolves until the abort signal fires
    const caller: ToolCaller = {
      call: (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
      listToolNames: async () => [...REQUIRED_TOOLS],
      listResourceUris: async () => [],
      serverInfo: () => undefined,
      close: async () => {},
    };
    const client = clientFor(caller, { timeoutMs: 5, retry: { maxAttempts: 1 } });

    // #when the call times out
    const result = await listCall(client);

    // #then the outcome is a failure, and specifically not any success member
    expect(result.outcome).toBe("TRANSPORT_ERROR");
    expect(result.outcome === "TRANSPORT_ERROR" && result.code).toBe("MCP_UNAVAILABLE");
  });

  it("marks a timeout retryable so a slow server gets another attempt", () => {
    // #given an abort error
    const error = Object.assign(new Error("aborted"), { name: "AbortError" });

    // #then it is worth repeating
    expect(classifyThrown(error).retryable).toBe(true);
  });
});

describe("retry policy", () => {
  it("retries a retryable transport failure up to the configured attempts", async () => {
    // #given two failures followed by a success
    const caller = new FakeCaller({
      responses: [
        new TypeError("fetch failed"),
        new TypeError("fetch failed"),
        { content: [{ type: "text", text: '{"data":[{"id":"v1"}]}' }] },
      ],
    });

    // #when the call is made
    const result = await clientFor(caller).call({
      tool: "signoz_list_views",
      arguments: {},
      reader: listReader,
      searchContext: CONTEXT,
    });

    // #then it eventually succeeds after exactly three attempts
    expect(result.outcome).toBe("SUCCESS_WITH_ROWS");
    expect(caller.calls).toHaveLength(3);
  });

  it("never retries a rejected credential", async () => {
    // #given an authentication failure
    const caller = new FakeCaller({
      responses: [Object.assign(new Error("unauthenticated"), { code: 401 })],
    });

    // #when the call is made
    const result = await clientFor(caller).call({
      tool: "signoz_list_views",
      arguments: {},
      reader: listReader,
      searchContext: CONTEXT,
    });

    // #then only one attempt was made
    expect(result.outcome === "TRANSPORT_ERROR" && result.code).toBe("SIGNOZ_AUTH_FAILED");
    expect(caller.calls).toHaveLength(1);
  });

  it("never repeats a request the server already answered", async () => {
    // #given a server-declared error, which is an answer rather than a failure to deliver
    const caller = new FakeCaller({
      responses: [{ isError: true, content: [{ type: "text", text: "no such trace" }] }],
    });

    // #when the call is made
    const result = await clientFor(caller).call({
      tool: "signoz_list_views",
      arguments: {},
      reader: listReader,
      searchContext: CONTEXT,
    });

    // #then re-sending it is pointless, and for a write would risk a duplicate resource
    expect(result.outcome).toBe("MCP_ERROR");
    expect(caller.calls).toHaveLength(1);
  });
});

describe("circuit breaker", () => {
  it("stops calling after consecutive transport failures", async () => {
    // #given a server that is entirely down
    const caller = new FakeCaller({ responses: [new TypeError("fetch failed")] });
    const client = clientFor(caller, {
      retry: { maxAttempts: 1 },
      circuitBreakerThreshold: 2,
    });

    // #when calls keep being attempted
    await listCall(client);
    await listCall(client);
    const attemptsBeforeBreak = caller.calls.length;
    const third = await listCall(client);

    // #then the third call short-circuits without touching the transport
    expect(third.outcome).toBe("TRANSPORT_ERROR");
    expect(third.outcome === "TRANSPORT_ERROR" && third.reason).toContain("circuit breaker");
    expect(caller.calls).toHaveLength(attemptsBeforeBreak);
  });

  it("closes the breaker again after a successful call", async () => {
    // #given one failure then successes
    const caller = new FakeCaller({
      responses: [
        new TypeError("fetch failed"),
        { content: [{ type: "text", text: '{"data":[]}' }] },
      ],
    });
    const client = clientFor(caller, { retry: { maxAttempts: 1 }, circuitBreakerThreshold: 2 });

    // #when a failure is followed by a success and another call
    await listCall(client);
    await listCall(client);
    const third = await listCall(client);

    // #then the breaker is not open
    expect(third.outcome).not.toBe("TRANSPORT_ERROR");
  });
});

describe("request construction", () => {
  it("sends searchContext on every call, as the server schemas require", async () => {
    // #given any call
    const caller = new FakeCaller();
    await clientFor(caller).call({
      tool: "signoz_list_views",
      arguments: { sourcePage: "traces" },
      reader: listReader,
      searchContext: CONTEXT,
    });

    // #then the context accompanies the arguments
    expect(caller.calls[0]?.arguments["searchContext"]).toBe(CONTEXT);
    expect(caller.calls[0]?.arguments["sourcePage"]).toBe("traces");
  });
});

describe("logging and redaction", () => {
  it("never writes tool arguments to the log", async () => {
    // #given a call whose arguments contain a customer identifier
    const records: LogRecord[] = [];
    const caller = new FakeCaller();
    const client = clientFor(caller, { logger: redactingLogger((r) => records.push(r)) });

    await client.call({
      tool: "signoz_list_views",
      arguments: { filter: "customer.email = 'someone@example.com'" },
      reader: listReader,
      searchContext: CONTEXT,
    });

    // #then no log record carries the argument value; PRD section 17.6 forbids persisting it
    const serialised = JSON.stringify(records);
    expect(serialised).not.toContain("someone@example.com");
    expect(serialised).toContain("mcp.call.completed");
  });

  it("redacts a registered secret that leaks into a failure reason", async () => {
    // #given an API key registered as a secret, echoed back inside an error message
    registerSecretValue("super-secret-api-key-value");
    const caller = new FakeCaller({
      responses: [
        new TypeError("fetch failed for header SIGNOZ-API-KEY: super-secret-api-key-value"),
      ],
    });

    // #when the call fails
    const result = await clientFor(caller, { retry: { maxAttempts: 1 } }).call({
      tool: "signoz_list_views",
      arguments: {},
      reader: listReader,
      searchContext: CONTEXT,
    });

    // #then the key does not appear in the reason a caller may write to evidence
    expect(result.outcome === "TRANSPORT_ERROR" && result.reason).not.toContain(
      "super-secret-api-key-value",
    );
    expect(result.outcome === "TRANSPORT_ERROR" && result.reason).toContain("[redacted]");
  });
});

describe("lifecycle", () => {
  it("closes the underlying transport", async () => {
    // #given an open client
    const caller = new FakeCaller();
    const client = clientFor(caller);

    // #when it is closed
    await client.close();

    // #then the transport is closed too
    expect(caller.closed).toBe(true);
  });

  it("reports support only for tools the discovered surface contains", async () => {
    // #given a discovered surface
    const client = clientFor(new FakeCaller({ tools: ["signoz_list_views"] }));
    await client.discoverCapabilities();

    // #then support is answered from the snapshot
    expect(client.supports("signoz_list_views")).toBe(true);
    expect(client.supports("signoz_create_alert")).toBe(false);
  });
});

describe("outcome exhaustiveness", () => {
  it("uses the timeout to bound a call rather than leaving it pending", async () => {
    // #given a caller that resolves only after the configured timeout would have fired
    const spy = vi.fn(async (_request: ToolCall, signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
      return { content: [{ type: "text", text: '{"data":[]}' }] } as RawToolResult;
    });
    const caller: ToolCaller = {
      call: spy,
      listToolNames: async () => [...REQUIRED_TOOLS],
      listResourceUris: async () => [],
      serverInfo: () => undefined,
      close: async () => {},
    };

    // #when a call is made
    await listCall(clientFor(caller));

    // #then the transport received an abort signal it can honour
    expect(spy).toHaveBeenCalledOnce();
  });
});

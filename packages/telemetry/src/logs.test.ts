import { clearRegisteredSecrets, registerSecretValue } from "@flightrules/domain";
import { context, trace } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOtlpLogStream,
  createStructuredLogger,
  safeLogAttributes,
  severityNumberOf,
} from "./logs.js";

/**
 * Log export and its two hard rules (PRD sections 17.5 and 17.6).
 *
 * These run against a real `LoggerProvider` with a real in-memory exporter rather than a spy, so
 * what is asserted is what an exporter would actually receive. Correlation is tested inside a real
 * active span, because the whole value of the feature is that a call site does not have to pass a
 * trace ID and therefore cannot forget to.
 */

function harness() {
  const exporter = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({ "service.name": "flightrules-test" }),
    processors: [new SimpleLogRecordProcessor({ exporter })],
  });
  return { exporter, provider, logger: provider.getLogger("flightrules-test") };
}

const swallow = (): void => {};

afterEach(() => {
  clearRegisteredSecrets();
});

describe("severity mapping", () => {
  it("maps every level FlightRules writes to its OpenTelemetry number", () => {
    expect(severityNumberOf("info")).toBe(SeverityNumber.INFO);
    expect(severityNumberOf("warn")).toBe(SeverityNumber.WARN);
    expect(severityNumberOf("error")).toBe(SeverityNumber.ERROR);
    expect(severityNumberOf("debug")).toBe(SeverityNumber.DEBUG);
  });

  it("treats an unknown level as informational rather than dropping the record", () => {
    expect(severityNumberOf("chatty")).toBe(SeverityNumber.INFO);
  });
});

describe("a structured log line reaches an exporter", () => {
  it("exports the message as the record body", () => {
    // #given a logger backed by a real provider
    const { exporter, logger } = harness();
    const log = createStructuredLogger({
      serviceName: "flightrules-test",
      logger,
      write: swallow,
    });

    // #when a line is written
    log.info({ job_id: "job-1" }, "claimed a job");

    // #then the exporter received it
    const records = exporter.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.body).toBe("claimed a job");
    expect(records[0]?.attributes["job_id"]).toBe("job-1");
  });

  it("still writes the human-readable copy to the process stream", () => {
    // #given a logger whose destination is captured
    const { logger } = harness();
    const lines: string[] = [];
    const log = createStructuredLogger({
      serviceName: "flightrules-worker",
      logger,
      write: (_level, line) => lines.push(line),
    });

    // #when a line is written
    log.warn({ attempt: 2 }, "retrying");

    // #then it is valid JSON carrying the service, level and message
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(parsed["service.name"]).toBe("flightrules-worker");
    expect(parsed["level"]).toBe("warn");
    expect(parsed["message"]).toBe("retrying");
    expect(parsed["attempt"]).toBe(2);
  });
});

describe("correlation, which the Violation Inspector depends on", () => {
  it("carries the trace and span of the work that emitted the line", async () => {
    // #given a real tracer and a real logger
    const spans = new InMemorySpanExporter();
    const tracerProvider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spans)],
    });
    const { exporter, logger } = harness();
    const log = createStructuredLogger({
      serviceName: "flightrules-test",
      logger,
      write: swallow,
    });

    // Correlation depends on a real context manager. `provider.register()` installs the
    // AsyncLocalStorage one, exactly as `startTelemetry` does in every process; without it the API's
    // default context manager is a no-op and `context.with` never propagates.
    tracerProvider.register();

    // #when a line is written inside an active span
    const tracer = tracerProvider.getTracer("test");
    const span = tracer.startSpan("flight_rules.evaluate_run");
    context.with(trace.setSpan(context.active(), span), () => {
      log.info({ release: "refund-agent-v2" }, "recorded a violation");
    });
    span.end();

    // #then the record carries that span's identifiers, with no call site having passed them
    const records = exporter.getFinishedLogRecords();
    const finished = spans.getFinishedSpans();
    expect(records).toHaveLength(1);
    expect(records[0]?.spanContext?.traceId).toBe(finished[0]?.spanContext().traceId);
    expect(records[0]?.spanContext?.spanId).toBe(finished[0]?.spanContext().spanId);

    await tracerProvider.shutdown();
    trace.disable();
    context.disable();
  });

  it("emits a record with no span context when there is no active span", () => {
    const { exporter, logger } = harness();
    const log = createStructuredLogger({
      serviceName: "flightrules-test",
      logger,
      write: swallow,
    });

    log.info({}, "worker ready");

    const records = exporter.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.spanContext).toBeUndefined();
  });
});

describe("what a log record may never carry", () => {
  it("drops a forbidden GenAI payload key outright rather than redacting it", () => {
    // #given fields that include a tool-call payload
    // #when they are turned into attributes
    const attributes = safeLogAttributes({
      "gen_ai.tool.call.arguments": '{"orderId":"ord-1"}',
      "gen_ai.input.messages": "refund my order",
      "gen_ai.tool.name": "payment.refund",
    });

    // #then the payload keys are absent entirely; the safe metadata survives
    expect(attributes).not.toHaveProperty("gen_ai.tool.call.arguments");
    expect(attributes).not.toHaveProperty("gen_ai.input.messages");
    expect(attributes["gen_ai.tool.name"]).toBe("payment.refund");
  });

  it("keeps a secret-shaped key's name and loses its value", () => {
    const attributes = safeLogAttributes({ apiKey: "sk-live-abcdef123456", attempt: 1 });
    expect(attributes["apiKey"]).toBe("[redacted]");
    expect(attributes["attempt"]).toBe(1);
  });

  it("replaces a registered secret wherever it appears inside a message", () => {
    // #given the SigNoz key has been registered, as it is at startup
    registerSecretValue("signoz-key-0123456789");
    const { exporter, logger } = harness();
    const log = createStructuredLogger({
      serviceName: "flightrules-test",
      logger,
      write: swallow,
    });

    // #when it is interpolated into a message rather than passed as a field
    log.error({}, "call failed with SIGNOZ-API-KEY: signoz-key-0123456789");

    // #then the exported body no longer contains it
    const body = String(exporter.getFinishedLogRecords()[0]?.body ?? "");
    expect(body).not.toContain("signoz-key-0123456789");
    expect(body).toContain("[redacted]");
  });

  it("keeps token *measurements*, which a release decision needs", () => {
    const attributes = safeLogAttributes({ totalTokens: 1_204, refreshToken: "abcdef123456" });
    expect(attributes["totalTokens"]).toBe(1_204);
    expect(attributes["refreshToken"]).toBe("[redacted]");
  });
});

describe("the API's pino destination", () => {
  it("turns a pino line into a correlated record without losing the stdout copy", () => {
    // #given a destination backed by a real logger
    const { exporter, logger } = harness();
    const stream = createOtlpLogStream("flightrules-api", logger);

    // #when pino writes a line
    stream.write(
      `${JSON.stringify({
        level: "info",
        timestamp: "2026-07-26T05:00:00.000Z",
        "service.name": "flightrules-api",
        message: "request completed",
        reqId: "abc",
      })}\n`,
    );

    // #then the record carries the message as its body and the rest as attributes
    const records = exporter.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.body).toBe("request completed");
    expect(records[0]?.severityNumber).toBe(SeverityNumber.INFO);
    expect(records[0]?.attributes["reqId"]).toBe("abc");
  });

  it("does not throw on a line that is not JSON", () => {
    // A destination that throws takes the API's logging down with it.
    const { exporter, logger } = harness();
    const stream = createOtlpLogStream("flightrules-api", logger);

    expect(() => stream.write("not json at all\n")).not.toThrow();
    expect(exporter.getFinishedLogRecords()[0]?.body).toBe("not json at all");
  });
});

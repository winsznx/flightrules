import { isForbiddenTelemetryKey, isSecretKey, REDACTED, redact } from "@flightrules/domain";
import {
  type AnyValue,
  type Logger,
  type LogRecord,
  logs,
  SeverityNumber,
} from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import type { Resource } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  InMemoryLogRecordExporter,
  LoggerProvider,
  type LogRecordProcessor,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";

/**
 * OTLP log export (PRD section 17.5).
 *
 * Until Phase 16 FlightRules wrote structured JSON to stdout and nothing else. SigNoz therefore
 * held no log at all, and the Violation Inspector's correlated-log panel was permanently `empty` —
 * the single largest hole in the evidence chain, because a violation could show the trace that
 * caused it but never the line the payment service wrote while causing it.
 *
 * Two rules shape this module.
 *
 * **Correlation is free or it is worthless.** A log line is only useful to the inspector if it
 * carries the trace and span identifiers of the work that emitted it, and the inspector correlates
 * strictly by trace ID. `Logger.emit` reads the active context, so a line written inside a span is
 * correlated without the call site knowing anything about tracing. Nothing here takes a trace ID
 * as an argument; a call site that had to pass one would eventually forget.
 *
 * **A log is the easiest place to leak.** PRD section 17.6 forbids prompts, tool arguments and tool
 * results, and PRD section 18.2 forbids secrets. Span attributes are already stripped by
 * `ForbiddenAttributeRedactor`; log attributes and bodies go through the same register here, plus
 * `redact`, which replaces registered secret values wherever they appear inside a string. Both run
 * before the record reaches a processor, so no exporter can see an unredacted record.
 */

export interface LogPipelineOptions {
  readonly resource: Resource;
  readonly otlpEndpoint: string;
  /** Adds an in-memory exporter alongside OTLP so tests can assert on real exported records. */
  readonly captureInMemory?: boolean;
}

export interface LogPipeline {
  readonly provider: LoggerProvider;
  readonly memory: InMemoryLogRecordExporter | undefined;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

export function startLogPipeline(options: LogPipelineOptions): LogPipeline {
  const memory = options.captureInMemory ? new InMemoryLogRecordExporter() : undefined;

  const processors: LogRecordProcessor[] = [
    new BatchLogRecordProcessor({
      exporter: new OTLPLogExporter({ url: `${options.otlpEndpoint}/v1/logs` }),
    }),
  ];
  if (memory) processors.push(new SimpleLogRecordProcessor({ exporter: memory }));

  const provider = new LoggerProvider({ resource: options.resource, processors });
  logs.setGlobalLoggerProvider(provider);

  return {
    provider,
    memory,
    forceFlush: () => provider.forceFlush(),
    shutdown: async () => {
      await provider.forceFlush();
      await provider.shutdown();
    },
  };
}

/** The levels FlightRules writes, and their OpenTelemetry severity numbers. */
const SEVERITY: Readonly<Record<string, SeverityNumber>> = {
  trace: SeverityNumber.TRACE,
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
  fatal: SeverityNumber.FATAL,
};

export function severityNumberOf(level: string): SeverityNumber {
  return SEVERITY[level.toLowerCase()] ?? SeverityNumber.INFO;
}

/**
 * Flattens a log's fields into log-record attributes, dropping what must never be exported.
 *
 * A forbidden GenAI key is removed outright rather than redacted: PRD section 17.6's position is
 * that the product does not collect prompts or tool payloads, and a `[redacted]` value would still
 * be a record that the product collected one. A secret-shaped key keeps its name and loses its
 * value, because knowing that an `apiKey` field was present is useful and knowing its contents is
 * a leak.
 */
export function safeLogAttributes(
  fields: Readonly<Record<string, unknown>>,
): Record<string, AnyValue> {
  const attributes: Record<string, AnyValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (isForbiddenTelemetryKey(key)) continue;
    if (isSecretKey(key)) {
      attributes[key] = REDACTED;
      continue;
    }
    const cleaned = redact(value);
    if (cleaned === null) continue;
    attributes[key] =
      typeof cleaned === "object" ? (JSON.stringify(cleaned) as AnyValue) : (cleaned as AnyValue);
  }
  return attributes;
}

export interface StructuredLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface StructuredLoggerOptions {
  readonly serviceName: string;
  /** Where the human-readable copy goes. Defaults to the process streams. */
  readonly write?: (level: string, line: string) => void;
  /** Overridable so a test can supply a logger backed by an in-memory provider. */
  readonly logger?: Logger;
}

/**
 * A logger that writes one JSON line to stdout **and** emits one correlated OTLP log record.
 *
 * Both, not one or the other: the stdout copy is what a developer reads while running
 * `make worker`, and the exported copy is what the Violation Inspector retrieves. Dropping either
 * would remove a real capability.
 */
export function createStructuredLogger(options: StructuredLoggerOptions): StructuredLogger {
  const emitter = options.logger ?? logs.getLogger(options.serviceName);
  const write =
    options.write ??
    ((level: string, line: string) => {
      if (level === "error") process.stderr.write(`${line}\n`);
      else process.stdout.write(`${line}\n`);
    });

  const at = (level: string, fields: Record<string, unknown>, message: string): void => {
    const safeMessage = redact(message);
    const body = typeof safeMessage === "string" ? safeMessage : message;
    const attributes = safeLogAttributes(fields);

    write(
      level,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        "service.name": options.serviceName,
        message: body,
        ...attributes,
      }),
    );

    const record: LogRecord = {
      severityNumber: severityNumberOf(level),
      severityText: level.toUpperCase(),
      body,
      attributes,
    };
    emitter.emit(record);
  };

  return {
    info: (fields, message) => {
      at("info", fields, message);
    },
    warn: (fields, message) => {
      at("warn", fields, message);
    },
    error: (fields, message) => {
      at("error", fields, message);
    },
  };
}

/**
 * A pino destination that forwards the API's own request log to OTLP.
 *
 * Fastify's logger is pino, and replacing it would throw away the request serialisers, the redact
 * paths and the request-identifier plumbing that PRD Phase 09 established. A destination stream is
 * the documented extension point and leaves all of that intact: pino still writes its line to
 * stdout, and each line is additionally parsed back into a log record. The parse is defensive —
 * a stream that throws would take the API's logging down with it, so an unparseable line is passed
 * through as an unstructured body rather than dropped or raised.
 */
export function createOtlpLogStream(
  serviceName: string,
  logger?: Logger,
): { write(line: string): void } {
  const emitter = logger ?? logs.getLogger(serviceName);
  return {
    write(line: string): void {
      process.stdout.write(line);

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        emitter.emit({
          severityNumber: SeverityNumber.INFO,
          severityText: "INFO",
          body: redact(line.trimEnd()) as string,
        });
        return;
      }

      const record = parsed as Record<string, unknown>;
      const level = typeof record["level"] === "string" ? record["level"] : "info";
      const message = typeof record["message"] === "string" ? record["message"] : "";
      const { level: _level, message: _message, time: _time, ...fields } = record;

      emitter.emit({
        severityNumber: severityNumberOf(level),
        severityText: level.toUpperCase(),
        body: redact(message) as string,
        attributes: safeLogAttributes(fields),
      });
    },
  };
}

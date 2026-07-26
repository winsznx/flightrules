import { FORBIDDEN_TELEMETRY_KEYS, registerSecretValue } from "@flightrules/domain";
import {
  type Attributes,
  DiagConsoleLogger,
  DiagLogLevel,
  diag,
  metrics,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { AGENT, EXPERIMENTAL, STABLE } from "./attributes.js";
import { type LogPipeline, startLogPipeline } from "./logs.js";

/**
 * Strips any attribute the PRD forbids on the default product path, at the point a span starts
 * and again when it ends.
 *
 * These keys all exist in the released GenAI registry and are trivially available to an
 * instrumentation author, so "we do not emit them" has to be enforced rather than asserted. This
 * processor is the enforcement; the redaction test is the proof.
 */
export class ForbiddenAttributeRedactor implements SpanProcessor {
  readonly #removed: string[] = [];

  onStart(span: Span): void {
    this.#strip(span);
  }

  onEnd(span: ReadableSpan): void {
    for (const key of FORBIDDEN_TELEMETRY_KEYS) {
      if (key in span.attributes) {
        this.#removed.push(key);
        delete (span.attributes as Record<string, unknown>)[key];
      }
    }
  }

  #strip(span: Span): void {
    for (const key of FORBIDDEN_TELEMETRY_KEYS) {
      const attributes = (span as unknown as { attributes: Record<string, unknown> }).attributes;
      if (attributes && key in attributes) {
        this.#removed.push(key);
        delete attributes[key];
      }
    }
  }

  /** Keys this processor has removed. A non-empty list means instrumentation tried to emit one. */
  removedKeys(): readonly string[] {
    return [...this.#removed];
  }

  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

export interface TelemetryOptions {
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly environmentName: string;
  readonly otlpEndpoint: string;
  readonly commitSha?: string | undefined;
  readonly serviceInstanceId?: string | undefined;
  /** Adds an in-memory exporter alongside OTLP so tests can assert on real exported spans. */
  readonly captureInMemory?: boolean;
  readonly diagnostics?: boolean;
  /**
   * Emit metrics as well as traces (PRD section 17.4, FR-016).
   *
   * Off by default so a demo service that only produces traces does not open a second exporter.
   * The API and the worker both enable it.
   */
  readonly metrics?: boolean;
  /** Export interval for metrics. Short in tests, so an assertion does not wait a minute. */
  readonly metricIntervalMs?: number;
  /**
   * Export logs over OTLP as well as traces (PRD section 17.5).
   *
   * Off by default for the same reason as metrics: a process that has nothing to correlate does not
   * need a third exporter. The API, the worker and every demo service turn it on, because the
   * Violation Inspector's correlated-log panel retrieves exactly what they emit.
   */
  readonly logs?: boolean;
}

export interface TelemetryHandle {
  readonly provider: NodeTracerProvider;
  readonly meterProvider: MeterProvider | undefined;
  readonly logPipeline: LogPipeline | undefined;
  readonly redactor: ForbiddenAttributeRedactor;
  readonly memory: InMemorySpanExporter | undefined;
  readonly metricMemory: InMemoryMetricExporter | undefined;
  /** Collected metrics from the in-memory reader. Empty unless `captureInMemory` was set. */
  collectedMetrics(): readonly ResourceMetrics[];
  /** Reads finished spans. Must be called before {@link shutdown}, which clears the exporter. */
  finishedSpans(): readonly ReadableSpan[];
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Resource attributes. `vcs.ref.head.revision` is the released convention; `vcs.commit.sha` is the
 * name PRD section 17.2 requires. Both carry the same value — see ADR-0004.
 */
export function buildResourceAttributes(options: TelemetryOptions): Attributes {
  const attributes: Record<string, string> = {
    [STABLE.serviceName]: options.serviceName,
    [STABLE.serviceVersion]: options.serviceVersion,
    [EXPERIMENTAL.deploymentEnvironmentName]: options.environmentName,
  };
  if (options.serviceInstanceId) {
    attributes[EXPERIMENTAL.serviceInstanceId] = options.serviceInstanceId;
  }
  if (options.commitSha) {
    attributes[EXPERIMENTAL.vcsRefHeadRevision] = options.commitSha;
    attributes[AGENT.vcsCommitSha] = options.commitSha;
  }
  return attributes;
}

export function startTelemetry(options: TelemetryOptions): TelemetryHandle {
  if (options.diagnostics) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
  }

  const redactor = new ForbiddenAttributeRedactor();
  const memory = options.captureInMemory ? new InMemorySpanExporter() : undefined;

  const processors: SpanProcessor[] = [
    // First, so nothing forbidden reaches an exporter.
    redactor,
    new BatchSpanProcessor(new OTLPTraceExporter({ url: `${options.otlpEndpoint}/v1/traces` })),
  ];
  if (memory) processors.push(new SimpleSpanProcessor(memory));

  const resource = resourceFromAttributes(buildResourceAttributes(options));

  const provider = new NodeTracerProvider({ resource, spanProcessors: processors });
  provider.register();

  let meterProvider: MeterProvider | undefined;
  let metricMemory: InMemoryMetricExporter | undefined;
  if (options.metrics) {
    const readers = [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: `${options.otlpEndpoint}/v1/metrics`,
        }) as PushMetricExporter,
        exportIntervalMillis: options.metricIntervalMs ?? 15_000,
      }),
    ];
    if (options.captureInMemory) {
      // AggregationTemporality.DELTA is 1; importing the enum here would pull a value-only import
      // into a module that otherwise only needs types, so the reader is constructed with the
      // exporter's own default temporality instead.
      metricMemory = new InMemoryMetricExporter(0);
      readers.push(
        new PeriodicExportingMetricReader({
          exporter: metricMemory,
          exportIntervalMillis: options.metricIntervalMs ?? 100,
        }),
      );
    }
    meterProvider = new MeterProvider({ resource, readers });
    metrics.setGlobalMeterProvider(meterProvider);
  }

  const logPipeline = options.logs
    ? startLogPipeline({
        resource,
        otlpEndpoint: options.otlpEndpoint,
        ...(options.captureInMemory === undefined
          ? {}
          : { captureInMemory: options.captureInMemory }),
      })
    : undefined;

  return {
    provider,
    meterProvider,
    logPipeline,
    redactor,
    memory,
    metricMemory,
    collectedMetrics: () => metricMemory?.getMetrics() ?? [],
    finishedSpans: () => memory?.getFinishedSpans() ?? [],
    forceFlush: async () => {
      await provider.forceFlush();
      await meterProvider?.forceFlush();
      await logPipeline?.forceFlush();
    },
    shutdown: async () => {
      await provider.forceFlush();
      await meterProvider?.forceFlush();
      await logPipeline?.forceFlush();
      await meterProvider?.shutdown();
      await logPipeline?.shutdown();
      await provider.shutdown();
    },
  };
}

/** Registers a secret so it is redacted wherever it appears in a log line or evidence file. */
export function protectSecret(value: string | undefined): void {
  if (value) registerSecretValue(value);
}

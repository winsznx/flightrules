import { FORBIDDEN_TELEMETRY_KEYS, registerSecretValue } from "@flightrules/domain";
import { type Attributes, DiagConsoleLogger, DiagLogLevel, diag } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
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
}

export interface TelemetryHandle {
  readonly provider: NodeTracerProvider;
  readonly redactor: ForbiddenAttributeRedactor;
  readonly memory: InMemorySpanExporter | undefined;
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

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes(buildResourceAttributes(options)),
    spanProcessors: processors,
  });
  provider.register();

  return {
    provider,
    redactor,
    memory,
    finishedSpans: () => memory?.getFinishedSpans() ?? [],
    forceFlush: () => provider.forceFlush(),
    shutdown: async () => {
      await provider.forceFlush();
      await provider.shutdown();
    },
  };
}

/** Registers a secret so it is redacted wherever it appears in a log line or evidence file. */
export function protectSecret(value: string | undefined): void {
  if (value) registerSecretValue(value);
}

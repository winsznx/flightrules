import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { SpanKind, trace, context } from "@opentelemetry/api";

const endpoint = process.env.OTLP_HTTP ?? "http://127.0.0.1:4318";
const releaseId = process.env.RELEASE_ID ?? "phase00-probe-v1";

const memory = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "flightrules-phase00-probe",
    [ATTR_SERVICE_VERSION]: "0.0.0",
    "deployment.environment.name": "phase00",
  }),
  spanProcessors: [
    new SimpleSpanProcessor(memory),
    new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` })),
  ],
});
provider.register();

const tracer = trace.getTracer("flightrules.phase00");

const root = tracer.startSpan("refund.request", {
  kind: SpanKind.SERVER,
  attributes: { "agent.release.id": releaseId, "agent.run.id": "phase00-run-1" },
});
const traceId = root.spanContext().traceId;

await context.with(trace.setSpan(context.active(), root), async () => {
  for (const [name, sideEffect] of [
    ["policy.retrieve", "read"],
    ["order.lookup", "read"],
    ["fraud.check", "read"],
    ["payment.refund", "write"],
  ]) {
    const child = tracer.startSpan(name, {
      kind: SpanKind.CLIENT,
      attributes: { "agent.side_effect": sideEffect, "agent.release.id": releaseId },
    });
    await new Promise((r) => setTimeout(r, 5));
    child.end();
  }
});
root.end();

await provider.forceFlush();
const spans = memory.getFinishedSpans().slice();
const captured = {
  traceId,
  inMemorySpanCount: spans.length,
  inMemorySpanNames: spans.map((s) => s.name),
  parentLinkage: spans.map((s) => ({ name: s.name, parentSpanId: s.parentSpanContext?.spanId ?? null })),
};
await provider.shutdown();
console.log(JSON.stringify(captured, null, 2));

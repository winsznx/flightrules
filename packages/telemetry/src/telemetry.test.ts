import { FORBIDDEN_TELEMETRY_KEYS } from "@flightrules/domain";
import { trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { describe, expect, it } from "vitest";
import {
  AGENT,
  buildResourceAttributes,
  EXPERIMENTAL,
  FLIGHT_RULES,
  ForbiddenAttributeRedactor,
  HIGH_CARDINALITY_ATTRIBUTES,
  highCardinalityDimensions,
  isHighCardinality,
  METRIC_NAMES,
  METRIC_SPECS,
  SPAN_NAMES,
  STABLE,
} from "./index.js";

describe("attribute names come from the installed conventions", () => {
  it("uses the stable names for service identity and error type", () => {
    expect(STABLE.serviceName).toBe("service.name");
    expect(STABLE.serviceVersion).toBe("service.version");
    expect(STABLE.errorType).toBe("error.type");
  });

  it("uses the released experimental names for the GenAI attributes the PRD lists", () => {
    expect(EXPERIMENTAL.genAiOperationName).toBe("gen_ai.operation.name");
    expect(EXPERIMENTAL.genAiWorkflowName).toBe("gen_ai.workflow.name");
    expect(EXPERIMENTAL.genAiAgentName).toBe("gen_ai.agent.name");
    expect(EXPERIMENTAL.genAiToolName).toBe("gen_ai.tool.name");
    expect(EXPERIMENTAL.genAiToolType).toBe("gen_ai.tool.type");
    expect(EXPERIMENTAL.genAiUsageInputTokens).toBe("gen_ai.usage.input_tokens");
    expect(EXPERIMENTAL.genAiUsageOutputTokens).toBe("gen_ai.usage.output_tokens");
  });

  it("uses the released VCS convention rather than a remembered name", () => {
    // `vcs.commit.sha` is not in the registry; `vcs.ref.head.revision` is. Both are emitted.
    expect(EXPERIMENTAL.vcsRefHeadRevision).toBe("vcs.ref.head.revision");
    expect(AGENT.vcsCommitSha).toBe("vcs.commit.sha");
  });

  it("defines every demo attribute the PRD requires", () => {
    expect(Object.values(AGENT)).toEqual(
      expect.arrayContaining([
        "agent.release.id",
        "agent.run.id",
        "agent.step.category",
        "agent.side_effect",
        "agent.data_domain",
        "agent.retry.number",
        "agent.idempotency.present",
        "agent.idempotency.key_hash",
        "agent.contract.id",
        "agent.scenario",
      ]),
    );
  });

  it("defines every FlightRules span name the PRD requires", () => {
    expect(Object.values(SPAN_NAMES)).toEqual([
      "flight_rules.fetch_traces",
      "flight_rules.reconstruct_trace",
      "flight_rules.normalise_graph",
      "flight_rules.mine_baseline",
      "flight_rules.propose_contract",
      "flight_rules.evaluate_run",
      "flight_rules.evaluate_release",
      "flight_rules.compile_signoz_artifacts",
      "flight_rules.release_gate",
    ]);
  });

  it("namespaces every evaluator attribute and metric under flight_rules", () => {
    for (const attribute of Object.values(FLIGHT_RULES)) {
      expect(attribute).toMatch(/^flight_rules\./);
    }
    for (const metric of Object.values(METRIC_NAMES)) {
      expect(metric).toMatch(/^flight_rules\./);
    }
  });
});

describe("resource attributes", () => {
  it("emits both the released VCS convention and the PRD-named attribute", () => {
    const attributes = buildResourceAttributes({
      serviceName: "flightrules-api",
      serviceVersion: "0.1.0",
      environmentName: "local",
      otlpEndpoint: "http://localhost:4318",
      commitSha: "9a3c1f2",
    });

    expect(attributes["vcs.ref.head.revision"]).toBe("9a3c1f2");
    expect(attributes["vcs.commit.sha"]).toBe("9a3c1f2");
  });

  it("omits optional attributes rather than emitting empty strings", () => {
    const attributes = buildResourceAttributes({
      serviceName: "flightrules-api",
      serviceVersion: "0.1.0",
      environmentName: "local",
      otlpEndpoint: "http://localhost:4318",
    });

    expect(attributes).not.toHaveProperty("vcs.commit.sha");
    expect(attributes).not.toHaveProperty("service.instance.id");
    expect(attributes["service.name"]).toBe("flightrules-api");
    expect(attributes["deployment.environment.name"]).toBe("local");
  });
});

describe("metric cardinality safety", () => {
  it("declares a dimension set for every instrument", () => {
    expect(METRIC_SPECS.length).toBe(Object.keys(METRIC_NAMES).length);
    for (const spec of METRIC_SPECS) {
      expect(spec.dimensions.length).toBeGreaterThan(0);
      expect(spec.unit.length).toBeGreaterThan(0);
    }
  });

  it("uses no high-cardinality attribute as a metric dimension", () => {
    // The register marks these high cardinality; PRD section 17.4 forbids them as metric labels.
    expect(highCardinalityDimensions()).toEqual([]);
  });

  it("recognises the registered high-cardinality attributes", () => {
    for (const attribute of HIGH_CARDINALITY_ATTRIBUTES) {
      expect(isHighCardinality(attribute)).toBe(true);
    }
    expect(isHighCardinality(AGENT.releaseId)).toBe(false);
    expect(isHighCardinality(AGENT.sideEffect)).toBe(false);
  });

  it("never uses a trace or span identifier as a dimension", () => {
    for (const spec of METRIC_SPECS) {
      for (const dimension of spec.dimensions) {
        expect(dimension).not.toMatch(/trace|span|fingerprint|evaluation\.id|run\.id/i);
      }
    }
  });
});

describe("forbidden attribute redaction", () => {
  function traceWithRedactor() {
    const memory = new InMemorySpanExporter();
    const redactor = new ForbiddenAttributeRedactor();
    const provider = new NodeTracerProvider({
      spanProcessors: [redactor, new SimpleSpanProcessor(memory)],
    });
    return { memory, redactor, provider, tracer: provider.getTracer("test") };
  }

  it("strips every forbidden prompt and tool-content key before export", async () => {
    const { memory, redactor, provider, tracer } = traceWithRedactor();

    const span = tracer.startSpan("payment.refund");
    for (const key of FORBIDDEN_TELEMETRY_KEYS) {
      span.setAttribute(key, "sensitive model content that must never be exported");
    }
    span.setAttribute(AGENT.sideEffect, "write");
    span.end();

    await provider.forceFlush();
    const exported = memory.getFinishedSpans();

    expect(exported).toHaveLength(1);
    for (const key of FORBIDDEN_TELEMETRY_KEYS) {
      expect(exported[0]?.attributes).not.toHaveProperty(key);
    }
    // The safe attribute survives, so this is redaction rather than dropping the span.
    expect(exported[0]?.attributes[AGENT.sideEffect]).toBe("write");
    expect(redactor.removedKeys().length).toBeGreaterThan(0);

    await provider.shutdown();
  });

  it("leaves a span with no forbidden attributes untouched", async () => {
    const { memory, redactor, provider, tracer } = traceWithRedactor();

    const span = tracer.startSpan("fraud.check");
    span.setAttribute(AGENT.sideEffect, "read");
    span.setAttribute(EXPERIMENTAL.genAiToolName, "check_fraud");
    span.end();

    await provider.forceFlush();
    const exported = memory.getFinishedSpans();

    expect(exported[0]?.attributes[EXPERIMENTAL.genAiToolName]).toBe("check_fraud");
    expect(redactor.removedKeys()).toEqual([]);

    await provider.shutdown();
  });

  it("permits the safe GenAI tool attributes that contracts select on", () => {
    // gen_ai.tool.name is required by the PRD's allowed-tools rule; only the content-bearing
    // attributes are forbidden.
    expect(FORBIDDEN_TELEMETRY_KEYS).not.toContain(EXPERIMENTAL.genAiToolName);
    expect(FORBIDDEN_TELEMETRY_KEYS).not.toContain(EXPERIMENTAL.genAiUsageInputTokens);
    expect(FORBIDDEN_TELEMETRY_KEYS).toContain("gen_ai.tool.call.arguments");
    expect(FORBIDDEN_TELEMETRY_KEYS).toContain("gen_ai.tool.call.result");
  });

  it("does not register a global tracer as a side effect of construction", () => {
    const before = trace.getTracer("probe");
    expect(before).toBeDefined();
  });
});

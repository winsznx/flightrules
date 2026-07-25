import { AGENT, EXPERIMENTAL, STABLE } from "@flightrules/telemetry";
import {
  type Attributes,
  context,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import type { StepRecord } from "./orchestrator.js";

export const WORKFLOW_NAME = "refund-workflow";
export const AGENT_NAME = "refund-agent";
export const TRACER_NAME = "flightrules.demo.refund-agent";

export function tracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/** Trace context headers for an outbound service call, so the whole run is one trace. */
export function outboundHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  propagation.inject(context.active(), headers);
  return headers;
}

export interface StepSpanInput {
  readonly name: string;
  readonly toolName: string;
  readonly service: string;
  readonly sideEffect: string;
  readonly dataDomain: string;
  readonly stepCategory: string;
  readonly attempt: number;
  readonly releaseId: string;
  readonly runId: string;
  readonly idempotencyKeyHash?: string | undefined;
  readonly idempotencyPresent?: boolean | undefined;
}

/**
 * Attributes for one agent step.
 *
 * `agent.retry.number` is the zero-based retry count, not the attempt number: attempt 1 is retry
 * 0. A contract rule that bounds retries reads this, so the off-by-one matters.
 */
export function stepAttributes(input: StepSpanInput): Attributes {
  const attributes: Attributes = {
    [EXPERIMENTAL.genAiOperationName]: "execute_tool",
    [EXPERIMENTAL.genAiWorkflowName]: WORKFLOW_NAME,
    [EXPERIMENTAL.genAiAgentName]: AGENT_NAME,
    [EXPERIMENTAL.genAiToolName]: input.toolName,
    [EXPERIMENTAL.genAiToolType]: "function",
    [AGENT.releaseId]: input.releaseId,
    [AGENT.runId]: input.runId,
    [AGENT.stepCategory]: input.stepCategory,
    [AGENT.sideEffect]: input.sideEffect,
    [AGENT.dataDomain]: input.dataDomain,
    [AGENT.retryNumber]: input.attempt - 1,
  };
  if (input.idempotencyPresent !== undefined) {
    attributes[AGENT.idempotencyPresent] = input.idempotencyPresent;
  }
  if (input.idempotencyKeyHash !== undefined) {
    // Only ever the salted hash. The raw key never leaves the payment service.
    attributes[AGENT.idempotencyKeyHash] = input.idempotencyKeyHash;
  }
  return attributes;
}

/** Runs `action` inside a child span carrying the step's contract-relevant attributes. */
export async function withStepSpan<T>(input: StepSpanInput, action: () => Promise<T>): Promise<T> {
  return tracer().startActiveSpan(
    input.name,
    { kind: SpanKind.CLIENT, attributes: stepAttributes(input) },
    async (span: Span) => {
      try {
        const value = await action();
        span.setStatus({ code: SpanStatusCode.OK });
        return value;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.setAttribute(
          STABLE.errorType,
          error instanceof Error
            ? error.name === "ServiceTimeoutError"
              ? "timeout"
              : error.name
            : "unknown",
        );
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

export interface RunSpanInput {
  readonly runId: string;
  readonly releaseId: string;
  readonly scenario: string;
  readonly orderId: string;
  readonly providerName: string;
  readonly modelName: string;
}

export function runAttributes(input: RunSpanInput): Attributes {
  return {
    [EXPERIMENTAL.genAiOperationName]: "invoke_agent",
    [EXPERIMENTAL.genAiWorkflowName]: WORKFLOW_NAME,
    [EXPERIMENTAL.genAiAgentName]: AGENT_NAME,
    [EXPERIMENTAL.genAiProviderName]: input.providerName,
    [EXPERIMENTAL.genAiRequestModel]: input.modelName,
    [AGENT.releaseId]: input.releaseId,
    [AGENT.runId]: input.runId,
    [AGENT.scenario]: input.scenario,
    [AGENT.stepCategory]: "workflow",
    [AGENT.sideEffect]: "none",
  };
}

/** Runs the whole refund workflow inside one root span, the run's primary trace. */
export async function withRunSpan<T>(
  input: RunSpanInput,
  action: (traceId: string) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(
    "refund.request",
    { kind: SpanKind.SERVER, attributes: runAttributes(input) },
    async (span: Span) => {
      try {
        const value = await action(span.spanContext().traceId);
        span.setStatus({ code: SpanStatusCode.OK });
        return value;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.setAttribute(STABLE.errorType, error instanceof Error ? error.name : "unknown");
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/** Maps a recorded step to the category a contract selector uses. */
export function stepCategoryFor(step: Pick<StepRecord, "name">): string {
  const [category] = step.name.split(".");
  return category ?? "unknown";
}

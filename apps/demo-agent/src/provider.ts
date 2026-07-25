/**
 * The agent's model provider.
 *
 * FlightRules evaluates execution structure, not model output, so the canonical automated demo
 * runs a scripted provider that needs no API key and produces byte-identical decisions every
 * time. The live provider adapters exist to show the same instrumentation works against a real
 * model; the product's correctness never depends on them.
 */

export interface PlanStep {
  readonly step:
    | "policy.retrieve"
    | "order.lookup"
    | "fraud.check"
    | "refund.calculate"
    | "payment.refund"
    | "customer.notify";
  readonly toolName: string;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface PlanResult {
  readonly steps: readonly PlanStep[];
  readonly providerName: string;
  readonly modelName: string;
  /**
   * Absent in scripted mode unless explicitly configured. PRD section 4 of the telemetry
   * requirements: scripted mode either uses bounded deterministic fixture values or leaves token
   * fields absent, clearly labelled. Inventing plausible token counts would be fabricated data.
   */
  readonly usage?: TokenUsage | undefined;
}

export interface Provider {
  readonly name: string;
  plan(releaseId: string): Promise<PlanResult>;
}

const V1_STEPS: readonly PlanStep[] = [
  { step: "policy.retrieve", toolName: "retrieve_policy" },
  { step: "order.lookup", toolName: "lookup_order" },
  { step: "fraud.check", toolName: "check_fraud" },
  { step: "refund.calculate", toolName: "calculate_refund" },
  { step: "payment.refund", toolName: "issue_refund" },
  { step: "customer.notify", toolName: "notify_customer" },
];

/**
 * The v2 plan. Policy retrieval and the fraud check are gone, and the refund is issued straight
 * after the order lookup. This is the behavioural regression the demo exists to catch: the
 * customer-facing answer is unchanged, so output evaluation sees nothing wrong.
 */
const V2_STEPS: readonly PlanStep[] = [
  { step: "order.lookup", toolName: "lookup_order" },
  { step: "payment.refund", toolName: "issue_refund" },
  { step: "customer.notify", toolName: "notify_customer" },
];

export const RELEASE_V1 = "refund-agent-v1";
export const RELEASE_V2 = "refund-agent-v2";

export function stepsForRelease(releaseId: string): readonly PlanStep[] {
  return releaseId === RELEASE_V2 ? V2_STEPS : V1_STEPS;
}

export class ScriptedProvider implements Provider {
  readonly name = "scripted";

  async plan(releaseId: string): Promise<PlanResult> {
    return {
      steps: stepsForRelease(releaseId),
      providerName: "scripted",
      modelName: "scripted-refund-planner-1",
      // Deliberately absent. See the doc comment on TokenUsage.
      usage: undefined,
    };
  }
}

export type ProviderKind = "scripted" | "anthropic" | "openai";

/**
 * Live provider adapters are not implemented in the scripted build. Returning a plausible-looking
 * plan without calling the provider would be a fabricated integration, so the factory fails
 * loudly and the caller falls back to scripted mode explicitly.
 */
export function createProvider(kind: ProviderKind): Provider {
  switch (kind) {
    case "scripted":
      return new ScriptedProvider();
    case "anthropic":
    case "openai":
      throw new Error(
        `Provider "${kind}" requires RUNTIME_MODE=live-provider-demo and a configured API key. ` +
          "The scripted provider is the canonical automated demo and needs neither.",
      );
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unknown provider ${String(exhaustive)}`);
    }
  }
}

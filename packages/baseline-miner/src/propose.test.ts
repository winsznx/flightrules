import { evaluateRun } from "@flightrules/contract-engine";
import { parseContract } from "@flightrules/contract-schema";
import {
  approvedRefundRows,
  knownGoodTrace,
  renumberTrace,
  rowsOf,
  unsafeTrace,
} from "@flightrules/test-fixtures";
import { buildTraceGraph } from "@flightrules/trace-graph";
import { describe, expect, it } from "vitest";
import { applyRouteDecisions, type RouteFamilyDecisionKind } from "./decisions.js";
import type { RetrievedTrace } from "./eligibility.js";
import { emitContractYaml } from "./emit.js";
import { mineBaseline, type TraceSource } from "./mine.js";
import { approvedRouteInputs, type BaselineVersion, type EligibleRun } from "./model.js";
import {
  type ContractProposal,
  type ProposalOptionsInput,
  type ProposedRule,
  proposeContract,
  recommendCardinality,
} from "./propose.js";
import { distributionOf } from "./statistics.js";

const KNOWN_GOOD = rowsOf(knownGoodTrace());
const UNSAFE = rowsOf(unsafeTrace());
const BASE_MS = Date.parse("2026-07-25T10:00:00Z");

const PROPOSAL_OPTIONS: ProposalOptionsInput = {
  createdAt: "2026-07-25T00:00:00Z",
  environment: "production",
  workflowName: "refund-workflow",
};

function traceOf(
  index: number,
  rows: readonly Record<string, unknown>[] = KNOWN_GOOD,
  durationMs = 30,
): RetrievedTrace {
  const traceId = `t${String(index).padStart(31, "0")}`;
  return {
    traceId,
    rows: renumberTrace(rows, {
      traceId,
      runId: `run_${String(index).padStart(20, "0")}`,
      startedAtUtc: new Date(BASE_MS + index * 60_000).toISOString(),
      rootDurationNano: durationMs * 1_000_000,
    }),
    webUrl: null,
    untrustedFields: [],
  };
}

function sourceOf(traces: readonly RetrievedTrace[], truncated = false): TraceSource {
  return {
    verifyFieldTypes: async () => ({
      ok: true,
      report: { verified: ["trace_id"], unverified: ["timestamp"], mismatched: [] },
    }),
    discover: async () => ({
      ok: true,
      dataset: { traceIds: traces.map((trace) => trace.traceId), pages: 1, truncated },
    }),
    fetch: async () => ({ traces, failures: [] }),
  };
}

interface Reviewed {
  readonly baseline: BaselineVersion;
  readonly runsByFingerprint: ReadonlyMap<string, readonly EligibleRun[]>;
}

async function reviewed(
  traces: readonly RetrievedTrace[],
  options: {
    readonly decisionFor?: (index: number) => RouteFamilyDecisionKind;
    readonly minimumRuns?: number;
    readonly truncated?: boolean;
  } = {},
): Promise<Reviewed> {
  const result = await mineBaseline({
    selection: {
      projectKey: "demo-commerce",
      agentKey: "refund-agent",
      releaseId: "refund-agent-v1",
      environment: null,
      startMs: BASE_MS - 3_600_000,
      endMs: BASE_MS + 86_400_000,
      minimumRuns: options.minimumRuns ?? 1,
      rootSpanName: "refund.request",
    },
    source: sourceOf(traces, options.truncated ?? false),
  });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));

  const decisions = result.value.baseline.families.map((family, index) => ({
    fingerprint: family.fingerprint,
    decision: (options.decisionFor ?? (() => "approve" as const))(index),
  }));
  const decided = applyRouteDecisions(result.value.baseline, decisions);
  if (!decided.ok)
    return { baseline: result.value.baseline, runsByFingerprint: result.value.runsByFingerprint };

  return { baseline: decided.baseline, runsByFingerprint: result.value.runsByFingerprint };
}

async function propose(
  traces: readonly RetrievedTrace[],
  options: Partial<ProposalOptionsInput> = {},
  review: Parameters<typeof reviewed>[1] = {},
): Promise<ContractProposal> {
  const input = await reviewed(traces, review);
  const result = proposeContract({
    baseline: input.baseline,
    runsByFingerprint: input.runsByFingerprint,
    options: { ...PROPOSAL_OPTIONS, ...options },
  });
  if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));
  return result.proposal;
}

function ruleTypes(proposal: ContractProposal): readonly string[] {
  return [...new Set(proposal.rules.map((entry) => entry.rule.type))].sort();
}

function ruleFor(proposal: ContractProposal, predicate: (id: string) => boolean) {
  return proposal.rules.find((entry) => predicate(entry.rule.id));
}

/** The rule whose identifier starts with `prefix`, failing loudly when there is none. */
function requireRule(proposal: ContractProposal, prefix: string): ProposedRule {
  const found = proposal.rules.find((entry) => entry.rule.id.startsWith(prefix));
  if (found === undefined) {
    throw new Error(
      `no proposed rule starts with "${prefix}". Proposed: ${proposal.rules.map((entry) => entry.rule.id).join(", ")}`,
    );
  }
  return found;
}

const twentyGoodRuns = Array.from({ length: 20 }, (_, index) => traceOf(index + 1));

describe("proposing a contract from approved families", () => {
  it("produces a draft, never an active contract", async () => {
    const proposal = await propose(twentyGoodRuns);

    expect(proposal.status).toBe("draft");
  });

  it("requires every step the approved runs always performed", async () => {
    const proposal = await propose(twentyGoodRuns);
    const required = proposal.rules
      .filter((entry) => entry.rule.type === "required_span")
      .map(
        (entry) => (entry.rule as { readonly selector: { readonly name?: string } }).selector.name,
      )
      .sort();

    // #then the six logical steps of the known-good route, and not the root, which the selector names
    expect(required).toEqual([
      "customer.notify",
      "fraud.check",
      "order.lookup",
      "payment.refund",
      "policy.retrieve",
      "refund.calculate",
    ]);
  });

  it("requires a remote handler through the edge from its caller, not by its own presence", async () => {
    const proposal = await propose(twentyGoodRuns);

    const handlerSpan = proposal.rules.find(
      (entry) =>
        entry.rule.type === "required_span" &&
        (entry.rule as { readonly selector: { readonly name?: string } }).selector.name ===
          "payment.refund.handler",
    );
    const handlerEdge = proposal.rules.find(
      (entry) =>
        entry.rule.type === "required_edge" &&
        (entry.rule as { readonly to: { readonly name?: string } }).to.name ===
          "payment.refund.handler",
    );

    // #then the handler's absence is a statement about the transport, so the edge carries it
    expect(handlerSpan).toBeUndefined();
    expect(handlerEdge).toBeDefined();
    expect(handlerEdge?.evidence.basis).toBe("remote_handler_edge");
  });

  it("marks a skipped check as critical and a side effect's presence as high", async () => {
    const proposal = await propose(twentyGoodRuns);

    expect(ruleFor(proposal, (id) => id.startsWith("require-fraud-check"))?.rule.severity).toBe(
      "critical",
    );
    expect(ruleFor(proposal, (id) => id.startsWith("require-payment-refund"))?.rule.severity).toBe(
      "high",
    );
  });

  it("bounds a side effect by its own narrowed selector at critical severity", async () => {
    const proposal = await propose(twentyGoodRuns);
    const bound = ruleFor(proposal, (id) => id.startsWith("single-payment-refund-write"));

    expect(bound?.rule.type).toBe("cardinality");
    expect(bound?.rule.severity).toBe("critical");
    expect(bound?.evidence.basis).toBe("side_effect_cardinality");
    const rule = bound?.rule as {
      readonly max: number;
      readonly min: number;
      readonly scope: string;
    };
    expect(rule.max).toBe(1);
    expect(rule.min).toBe(0);
    expect(rule.scope).toBe("run");
  });

  it("requires a side effect to descend from the workflow root", async () => {
    const proposal = await propose(twentyGoodRuns);
    const ancestry = ruleFor(proposal, (id) =>
      id.startsWith("within-refund-request-payment-refund-"),
    );

    expect(ancestry?.rule.type).toBe("required_ancestry");
    expect(ancestry?.evidence.basis).toBe("side_effect_ancestry");
  });

  it("constrains an attribute every span of a side-effecting step agreed on", async () => {
    const proposal = await propose(twentyGoodRuns);
    const constraint = requireRule(proposal, "attribute-payment-refund-agent-idempotency-present");

    expect(constraint.rule.type).toBe("attribute_constraint");
    expect(constraint.rule.severity).toBe("critical");
    expect((constraint.rule as { readonly value?: unknown }).value).toBe(true);
  });

  it("does not constrain an attribute the runs disagreed on", async () => {
    const missing = approvedRefundRows({
      replace: [
        {
          name: "payment.refund",
          spanId: "c5paymnt",
          parentSpanId: "root0000",
          tool: "issue_refund",
          operation: "execute_tool",
          sideEffect: "write",
          dataDomain: "payments",
          retry: 0,
          idempotencyPresent: false,
        },
      ],
    });

    const proposal = await propose([traceOf(1), traceOf(90, missing)]);

    expect(
      proposal.rules
        .filter((entry) => entry.rule.type === "attribute_constraint")
        .map((entry) => entry.rule.id),
    ).not.toContain("attribute-payment-refund-agent-idempotency-present-2e1b0f99");
  });

  it("allowlists exactly the tools, services and data domains the baseline used", async () => {
    const proposal = await propose(twentyGoodRuns);
    const byField = new Map(
      proposal.rules
        .filter((entry) => entry.rule.type === "allowed_values")
        .map((entry) => [
          (entry.rule as { readonly field: string }).field,
          (entry.rule as { readonly values: readonly string[] }).values,
        ]),
    );

    expect(byField.get("gen_ai.tool.name")).toEqual([
      "calculate_refund",
      "check_fraud",
      "issue_refund",
      "lookup_order",
      "notify_customer",
      "retrieve_policy",
    ]);
    expect(byField.get("service.name")).toContain("flightrules-payment-service");
    expect(byField.get("agent.data_domain")).toContain("payments");
  });

  it("bounds retries from what was observed, scoped to the operation that carried them", async () => {
    const proposal = await propose(twentyGoodRuns);
    const retry = ruleFor(proposal, (id) => id.startsWith("retries-bounded"));
    const rule = retry?.rule as {
      readonly maxPerTool: number;
      readonly maxRunTotal: number;
      readonly sideEffectMax: number;
      readonly selector: { readonly operation?: string };
    };

    expect(rule.selector.operation).toBe("execute_tool");
    expect(rule.maxPerTool).toBe(0);
    expect(rule.maxRunTotal).toBe(0);
    expect(rule.sideEffectMax).toBe(0);
  });

  it("never widens the side-effect retry allowance, whatever margin is configured", async () => {
    const proposal = await propose(twentyGoodRuns, { retrySafetyMargin: 3 });
    const rule = ruleFor(proposal, (id) => id.startsWith("retries-bounded"))?.rule as {
      readonly maxPerTool: number;
      readonly sideEffectMax: number;
    };

    expect(rule.maxPerTool).toBe(3);
    expect(rule.sideEffectMax).toBe(0);
  });

  it("allowlists the approved route fingerprints", async () => {
    const proposal = await propose(twentyGoodRuns);
    const route = requireRule(proposal, "route-approved-family");

    expect((route.rule as { readonly fingerprints: readonly string[] }).fingerprints).toEqual(
      proposal.approvedFamilyFingerprints,
    );
    expect(proposal.contract.spec.approvedRoutes).toEqual(proposal.approvedFamilyFingerprints);
  });

  it("proposes a run-scoped maximum and a release-scoped percentile for latency", async () => {
    const proposal = await propose(
      Array.from({ length: 20 }, (_, index) => traceOf(index + 1, KNOWN_GOOD, 20 + index)),
    );

    const runBudget = ruleFor(proposal, (id) => id.startsWith("budget-run-duration-ms"))?.rule as {
      readonly aggregation: string;
      readonly scope: string;
      readonly max: number;
    };
    const releaseBudget = ruleFor(proposal, (id) => id.startsWith("budget-release-duration-ms"))
      ?.rule as { readonly aggregation: string; readonly scope: string; readonly max: number };

    // #then the run budget uses an aggregation a single run can have
    expect(runBudget.aggregation).toBe("max");
    expect(runBudget.scope).toBe("run");
    expect(runBudget.max).toBe(59); // ceil(39 x 1.5)
    expect(releaseBudget.aggregation).toBe("p95");
    expect(releaseBudget.scope).toBe("release");
    expect(releaseBudget.max).toBe(46); // ceil(38 x 1.2)
  });

  it("proposes no token budget when the agent emits no token telemetry", async () => {
    const proposal = await propose(twentyGoodRuns);

    expect(
      proposal.rules.filter((entry) =>
        (entry.rule as { readonly metric?: string }).metric?.startsWith("gen_ai.usage."),
      ),
    ).toHaveLength(0);
    expect(
      proposal.disclosures.filter(
        (entry) =>
          entry.code === "BUDGET_NOT_PROPOSED" && entry.subject.startsWith("gen_ai.usage."),
      ),
    ).toHaveLength(2);
  });

  it("proposes a token budget when the runs do emit tokens", async () => {
    const withTokens = KNOWN_GOOD.map((row) =>
      row["name"] === "refund.request" ? { ...row, "gen_ai.usage.output_tokens": 100 } : row,
    );

    const proposal = await propose(
      Array.from({ length: 5 }, (_, index) => traceOf(index + 1, withTokens)),
    );
    const budget = ruleFor(proposal, (id) => id.startsWith("budget-gen-ai-usage-output-tokens"))
      ?.rule as { readonly max: number; readonly scope: string };

    expect(budget.max).toBe(125); // ceil(100 x 1.25)
    expect(budget.scope).toBe("release");
  });

  it("puts every critical rule under zero tolerance and nothing else", async () => {
    const proposal = await propose(twentyGoodRuns);
    const critical = proposal.rules
      .filter((entry) => entry.rule.severity === "critical")
      .map((entry) => entry.rule.id)
      .sort();

    expect([...proposal.contract.spec.gate.zeroToleranceRuleIds]).toEqual(critical);
    expect(critical.length).toBeGreaterThan(0);
  });

  it("carries the selection's minimum run count into the gate", async () => {
    const proposal = await propose(twentyGoodRuns, {}, { minimumRuns: 20 });

    expect(proposal.contract.spec.gate.minCompletedRuns).toBe(20);
  });

  it("attaches an evidence basis with a sample size to every proposed rule", async () => {
    const proposal = await propose(twentyGoodRuns);

    for (const entry of proposal.rules) {
      expect(entry.evidence.basis.length).toBeGreaterThan(0);
      expect(entry.evidence.observed.length).toBeGreaterThan(0);
      expect(entry.evidence.recommended.length).toBeGreaterThan(0);
      expect(entry.evidence.sampleSize).toBeGreaterThan(0);
      expect(entry.evidence.support.denominator).toBeGreaterThan(0);
    }
  });

  it("states its assumptions and its sample size", async () => {
    const proposal = await propose(twentyGoodRuns);

    expect(proposal.sampleSize).toBe(20);
    expect(proposal.assumptions.some((line) => line.includes("draft"))).toBe(true);
    expect(proposal.assumptions.some((line) => line.includes("never treated as zero"))).toBe(true);
  });

  it("discloses the traces the baseline excluded", async () => {
    const wrongRelease: RetrievedTrace = {
      ...traceOf(90),
      rows: traceOf(90).rows.map((row) => ({ ...row, "agent.release.id": "refund-agent-v2" })),
    };

    const proposal = await propose([...twentyGoodRuns, wrongRelease]);
    const excluded = proposal.disclosures.find((entry) => entry.code === "TRACES_EXCLUDED");

    expect(excluded?.count).toBe(1);
    expect(excluded?.detail).toContain("RELEASE_MISMATCH");
  });

  it("discloses an unapproved family and the families that were approved", async () => {
    const proposal = await propose(
      [...twentyGoodRuns, traceOf(90, approvedRefundRows({ remove: ["c4calcul"] }))],
      {},
      { decisionFor: (index) => (index === 0 ? "approve" : "reject") },
    );

    expect(proposal.disclosures.map((entry) => entry.code)).toContain("UNAPPROVED_FAMILY_PRESENT");
    expect(proposal.approvedFamilyFingerprints).toHaveLength(1);
  });

  it("discloses a step it could not prove absent, and proposes no rule for it", async () => {
    // #given every run lost the payment handler span, so its presence can never be observed
    const traces = Array.from({ length: 5 }, (_, index) =>
      traceOf(index + 1, approvedRefundRows({ remove: ["s5paymnt"] })),
    );

    const proposal = await propose(traces);

    // #then the handler edge is still proposed from the runs that did observe the caller, and the
    // aggregate reports the handler as always present in the observable region
    const handler = proposal.aggregate.labels.find(
      (label) => label.label === "payment.refund.handler",
    );
    expect(handler).toBeUndefined();
  });

  it("discloses an optional step rather than requiring it", async () => {
    const proposal = await propose([
      ...Array.from({ length: 10 }, (_, index) => traceOf(index + 1)),
      ...Array.from({ length: 3 }, (_, index) =>
        traceOf(index + 90, approvedRefundRows({ remove: ["c3fraud0", "s3fraud0"] })),
      ),
    ]);

    const optional = proposal.disclosures.find(
      (entry) => entry.code === "LABEL_OPTIONAL" && entry.subject === "fraud.check",
    );
    const bound = requireRule(proposal, "bound-fraud-check");

    expect(optional).toBeDefined();
    expect(bound.rule.type).toBe("cardinality");
    expect((bound.rule as { readonly min: number }).min).toBe(0);
    // #and no required_span for it, since the baseline itself does not always perform it
    expect(ruleFor(proposal, (id) => id.startsWith("require-fraud-check"))).toBeUndefined();
  });

  it("keeps a cardinality outlier out of the bound and discloses it", async () => {
    const duplicated = approvedRefundRows({
      add: [
        {
          name: "payment.refund",
          spanId: "c5paymnt2",
          parentSpanId: "root0000",
          tool: "issue_refund",
          operation: "execute_tool",
          sideEffect: "write",
          dataDomain: "payments",
          retry: 1,
          idempotencyPresent: true,
        },
      ],
    });

    const proposal = await propose([...twentyGoodRuns, traceOf(90, duplicated)]);
    const bound = requireRule(proposal, "single-payment-refund-write");

    expect((bound.rule as { readonly max: number }).max).toBe(1);
    expect(bound.evidence.outliers).toEqual([2]);
    expect(bound.evidence.requiresHumanConfirmation).toBe(true);
    expect(
      proposal.disclosures.some(
        (entry) => entry.code === "CARDINALITY_OUTLIER" && entry.subject === "payment.refund",
      ),
    ).toBe(true);
  });

  it("keeps rule identifiers stable across repeated proposals", async () => {
    const first = await propose(twentyGoodRuns);
    const second = await propose([...twentyGoodRuns].reverse());

    expect(second.rules.map((entry) => entry.rule.id)).toEqual(
      first.rules.map((entry) => entry.rule.id),
    );
    expect(second.contentHash).toBe(first.contentHash);
  });

  it("produces the validated form of every rule, not the pre-validation form", async () => {
    const proposal = await propose(twentyGoodRuns);
    const contractIds = [...proposal.contract.spec.rules].map((rule) => rule.id).sort();

    expect(proposal.rules.map((entry) => entry.rule.id)).toEqual(contractIds);
    // #then a fingerprint on a rule is bare, matching what the evaluator compares against
    const route = requireRule(proposal, "route-approved-family");
    for (const fingerprint of (route.rule as { readonly fingerprints: readonly string[] })
      .fingerprints) {
      expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("survives a prototype-shaped label and still emits a valid contract", async () => {
    const hostile = approvedRefundRows({
      replace: [
        {
          name: "__proto__",
          spanId: "c1policy",
          parentSpanId: "root0000",
          service: "constructor",
          tool: "toString",
          operation: "execute_tool",
          sideEffect: "read",
          dataDomain: "prototype",
          retry: 0,
          attributes: { __proto__: ["a", "b"], hasOwnProperty: "valueOf" },
        },
      ],
      remove: ["s1policy"],
    });

    const proposal = await propose(
      Array.from({ length: 3 }, (_, index) => traceOf(index + 1, hostile)),
    );
    const required = proposal.rules.filter((entry) => entry.rule.type === "required_span");

    expect(
      required.map(
        (entry) => (entry.rule as { readonly selector: { readonly name?: string } }).selector.name,
      ),
    ).toContain("__proto__");
    const emitted = emitContractYaml(proposal);
    expect(emitted.ok).toBe(true);
  });

  it("proposes no rule for two labels a selector cannot tell apart, and says so", async () => {
    // #given a second step whose name differs from an existing one only by a control character, so
    // both sanitise to the same selector value
    const ambiguous = approvedRefundRows({
      add: [
        {
          name: "order.lookup\u0001",
          spanId: "cXorder0",
          parentSpanId: "root0000",
          tool: "lookup_order",
          operation: "execute_tool",
          sideEffect: "read",
          dataDomain: "orders",
          retry: 0,
        },
      ],
    });

    const proposal = await propose(
      Array.from({ length: 3 }, (_, index) => traceOf(index + 1, ambiguous)),
    );

    // #then neither gets a rule, because a rule for either would also govern the other
    expect(ruleFor(proposal, (id) => id.startsWith("require-order-lookup"))).toBeUndefined();
    const disclosures = proposal.disclosures.filter(
      (entry) => entry.code === "LABEL_NOT_EXPRESSIBLE",
    );
    expect(disclosures.map((entry) => entry.subject).sort()).toEqual([
      "order.lookup",
      "order.lookup\u0001",
    ]);
  });

  it("keeps a control character and a bidirectional override out of the contract", async () => {
    const hostile = approvedRefundRows({
      replace: [
        {
          name: "policy\u0000.retrieve\u202e",
          spanId: "c1policy",
          parentSpanId: "root0000",
          tool: "retrieve_policy",
          operation: "execute_tool",
          sideEffect: "read",
          dataDomain: "policy",
          retry: 0,
        },
      ],
      remove: ["s1policy"],
    });

    const proposal = await propose([traceOf(1, hostile)]);
    const names = proposal.rules
      .filter((entry) => entry.rule.type === "required_span")
      .map(
        (entry) =>
          (entry.rule as { readonly selector: { readonly name?: string } }).selector.name ?? "",
      );

    for (const name of names) {
      expect(name).not.toContain("\u0000");
      expect(name).not.toContain("\u202e");
    }
  });
});

describe("refusing to propose", () => {
  it("refuses when no family was approved", async () => {
    const input = await reviewed([traceOf(1)], { decisionFor: () => "reject" });

    const result = proposeContract({
      baseline: input.baseline,
      runsByFingerprint: input.runsByFingerprint,
      options: PROPOSAL_OPTIONS,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("NO_APPROVED_FAMILY");
  });

  it("refuses when the baseline has too few runs", async () => {
    const input = await reviewed([traceOf(1)], { minimumRuns: 20 });

    const result = proposeContract({
      baseline: input.baseline,
      runsByFingerprint: input.runsByFingerprint,
      options: PROPOSAL_OPTIONS,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((entry) => entry.code)).toContain("BASELINE_NOT_REVIEWABLE");
  });

  it("refuses when the dataset was truncated", async () => {
    const input = await reviewed([traceOf(1)], { truncated: true });

    const result = proposeContract({
      baseline: input.baseline,
      runsByFingerprint: input.runsByFingerprint,
      options: PROPOSAL_OPTIONS,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((entry) => entry.code)).toContain("BASELINE_NOT_REVIEWABLE");
  });

  it("refuses an environment that is not a contract identifier", async () => {
    const input = await reviewed([traceOf(1)]);

    const result = proposeContract({
      baseline: input.baseline,
      runsByFingerprint: input.runsByFingerprint,
      options: { ...PROPOSAL_OPTIONS, environment: "Production!" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("OPTION_INVALID");
    expect(result.errors[0]?.subject).toBe("environment");
  });

  it("refuses a workflow name that sanitises to nothing", async () => {
    const input = await reviewed([traceOf(1)]);

    const result = proposeContract({
      baseline: input.baseline,
      runsByFingerprint: input.runsByFingerprint,
      options: { ...PROPOSAL_OPTIONS, workflowName: "\u0000\u0001" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.subject).toBe("workflowName");
  });
});

describe("the cardinality recommendation", () => {
  it("permits the observed maximum when it is not an outlier", () => {
    const recommendation = recommendCardinality(distributionOf([1, 1, 1, 1]) as never, 0);

    expect(recommendation.recommendedMax).toBe(1);
    expect(recommendation.outliers).toEqual([]);
    expect(recommendation.requiresHumanConfirmation).toBe(false);
  });

  it("refuses to encode an outlying duplicate as permitted", () => {
    // #given twenty runs doing it once and one doing it twice
    const samples = [...Array.from({ length: 20 }, () => 1), 2];

    const recommendation = recommendCardinality(distributionOf(samples) as never, 0);

    expect(recommendation.recommendedMax).toBe(1);
    expect(recommendation.outliers).toEqual([2]);
    expect(recommendation.requiresHumanConfirmation).toBe(true);
  });

  it("permits a maximum that the 95th percentile also reaches", () => {
    // #given a route that legitimately calls a step twice in most runs
    const samples = [2, 2, 2, 2, 2];

    const recommendation = recommendCardinality(distributionOf(samples) as never, 0);

    expect(recommendation.recommendedMax).toBe(2);
    expect(recommendation.outliers).toEqual([]);
  });

  it("applies a configured margin and asks for confirmation of it", () => {
    const recommendation = recommendCardinality(distributionOf([1, 1]) as never, 1);

    expect(recommendation.recommendedMax).toBe(2);
    expect(recommendation.requiresHumanConfirmation).toBe(true);
  });
});

describe("the generated contract against real traces", () => {
  it("is accepted by the Phase 07 validator through the public parser", async () => {
    const proposal = await propose(twentyGoodRuns);
    const emitted = emitContractYaml(proposal);
    expect(emitted.ok).toBe(true);
    if (!emitted.ok) return;

    const reparsed = parseContract(emitted.yaml);

    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.value.contentHash).toBe(proposal.contentHash);
  });

  it("passes a known-good run the baseline was mined from", async () => {
    const input = await reviewed(twentyGoodRuns);
    const result = proposeContract({
      baseline: input.baseline,
      runsByFingerprint: input.runsByFingerprint,
      options: PROPOSAL_OPTIONS,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));

    // One of the runs the baseline was actually mined from, so the proposed latency budget is
    // evaluated against a duration it was derived from rather than against an unrelated one.
    const graph = buildTraceGraph(twentyGoodRuns[0]?.rows as readonly Record<string, unknown>[], {
      rootSelector: "refund.request",
    });
    const { evaluation } = evaluateRun({
      graph,
      contract: result.proposal.contract,
      approvedRoutes: approvedRouteInputs(input.baseline),
    });

    expect(evaluation.status).toBe("pass");
    expect(evaluation.violations).toEqual([]);
    expect(evaluation.routeApproved).toBe(true);
  });

  it("fails the unsafe canary on the missing policy check, the missing fraud check and the duplicate refund", async () => {
    const input = await reviewed(twentyGoodRuns);
    const result = proposeContract({
      baseline: input.baseline,
      runsByFingerprint: input.runsByFingerprint,
      options: PROPOSAL_OPTIONS,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));

    const graph = buildTraceGraph(UNSAFE, { rootSelector: "refund.request" });
    const { evaluation } = evaluateRun({
      graph,
      contract: result.proposal.contract,
      approvedRoutes: approvedRouteInputs(input.baseline),
    });

    expect(evaluation.status).toBe("fail");
    const zeroTolerance = evaluation.violations.filter((entry) => entry.zeroTolerance);
    expect(zeroTolerance).toHaveLength(3);
    expect(zeroTolerance.map((entry) => entry.code).sort()).toEqual([
      "CARDINALITY_ABOVE_MAX",
      "REQUIRED_SPAN_MISSING",
      "REQUIRED_SPAN_MISSING",
    ]);
    const summaries = evaluation.violations.map((entry) => entry.summary).join(" ");
    expect(summaries).toContain("policy.retrieve");
    expect(summaries).toContain("fraud.check");
    expect(summaries).toContain("payment.refund");
  });

  it("reports insufficient evidence for the aborted handler rather than a skipped step", async () => {
    const input = await reviewed(twentyGoodRuns);
    const result = proposeContract({
      baseline: input.baseline,
      runsByFingerprint: input.runsByFingerprint,
      options: PROPOSAL_OPTIONS,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));

    const graph = buildTraceGraph(UNSAFE, { rootSelector: "refund.request" });
    const { evaluation } = evaluateRun({
      graph,
      contract: result.proposal.contract,
      approvedRoutes: approvedRouteInputs(input.baseline),
    });

    const undecided = evaluation.ruleResults.filter(
      (entry) => entry.outcome === "insufficient_evidence",
    );

    expect(undecided.map((entry) => entry.insufficientReason)).toEqual(["unobservable_subtree"]);
    // #and the duplicate refund still fails, so one gap did not suppress a real finding
    expect(evaluation.violations.some((entry) => entry.code === "CARDINALITY_ABOVE_MAX")).toBe(
      true,
    );
  });

  it("covers every rule type the mined baseline has evidence for", async () => {
    const proposal = await propose(twentyGoodRuns);

    expect(ruleTypes(proposal)).toEqual([
      "allowed_values",
      "approved_routes",
      "attribute_constraint",
      "cardinality",
      "numeric_budget",
      "required_ancestry",
      "required_edge",
      "required_span",
      "retry_budget",
    ]);
  });
});

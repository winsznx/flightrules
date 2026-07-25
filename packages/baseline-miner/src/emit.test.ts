import { CONTRACT_LIMITS, parseContract } from "@flightrules/contract-schema";
import {
  approvedRefundRows,
  knownGoodTrace,
  renumberTrace,
  rowsOf,
} from "@flightrules/test-fixtures";
import { describe, expect, it } from "vitest";
import { applyRouteDecisions } from "./decisions.js";
import type { RetrievedTrace } from "./eligibility.js";
import { emitContractYaml } from "./emit.js";
import { mineBaseline, type TraceSource } from "./mine.js";
import { type ContractProposal, proposeContract } from "./propose.js";

const KNOWN_GOOD = rowsOf(knownGoodTrace());
const BASE_MS = Date.parse("2026-07-25T10:00:00Z");

function traceOf(
  index: number,
  rows: readonly Record<string, unknown>[] = KNOWN_GOOD,
): RetrievedTrace {
  const traceId = `t${String(index).padStart(31, "0")}`;
  return {
    traceId,
    rows: renumberTrace(rows, {
      traceId,
      runId: `run_${String(index).padStart(20, "0")}`,
      startedAtUtc: new Date(BASE_MS + index * 60_000).toISOString(),
      rootDurationNano: 30_000_000,
    }),
    webUrl: null,
    untrustedFields: [],
  };
}

function sourceOf(traces: readonly RetrievedTrace[]): TraceSource {
  return {
    verifyFieldTypes: async () => ({
      ok: true,
      report: { verified: ["trace_id"], unverified: ["timestamp"], mismatched: [] },
    }),
    discover: async () => ({
      ok: true,
      dataset: { traceIds: traces.map((trace) => trace.traceId), pages: 1, truncated: false },
    }),
    fetch: async () => ({ traces, failures: [] }),
  };
}

async function proposalFor(traces: readonly RetrievedTrace[]): Promise<ContractProposal> {
  const mined = await mineBaseline({
    selection: {
      projectKey: "demo-commerce",
      agentKey: "refund-agent",
      releaseId: "refund-agent-v1",
      environment: null,
      startMs: BASE_MS - 3_600_000,
      endMs: BASE_MS + 86_400_000,
      minimumRuns: 1,
      rootSpanName: "refund.request",
    },
    source: sourceOf(traces),
  });
  if (!mined.ok) throw new Error(JSON.stringify(mined.errors));

  const decided = applyRouteDecisions(
    mined.value.baseline,
    mined.value.baseline.families.map((family) => ({
      fingerprint: family.fingerprint,
      decision: "approve" as const,
    })),
  );
  if (!decided.ok) throw new Error(JSON.stringify(decided.errors));

  const proposal = proposeContract({
    baseline: decided.baseline,
    runsByFingerprint: mined.value.runsByFingerprint,
    options: {
      createdAt: "2026-07-25T00:00:00Z",
      environment: "production",
      workflowName: "refund-workflow",
    },
  });
  if (!proposal.ok) throw new Error(JSON.stringify(proposal.errors));
  return proposal.proposal;
}

const runs = Array.from({ length: 20 }, (_, index) => traceOf(index + 1));

describe("emitting the draft contract", () => {
  it("produces a document the public parser accepts", async () => {
    const emitted = emitContractYaml(await proposalFor(runs));

    expect(emitted.ok).toBe(true);
    if (!emitted.ok) return;
    expect(parseContract(emitted.yaml).ok).toBe(true);
  });

  it("round-trips to the same content hash, so serialisation did not change the meaning", async () => {
    const proposal = await proposalFor(runs);
    const emitted = emitContractYaml(proposal);

    expect(emitted.ok).toBe(true);
    if (!emitted.ok) return;
    expect(emitted.contentHash).toBe(proposal.contentHash);
  });

  it("produces byte-identical text for the same proposal", async () => {
    const proposal = await proposalFor(runs);

    const first = emitContractYaml(proposal);
    const second = emitContractYaml(proposal);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.yaml).toBe(first.yaml);
  });

  it("produces byte-identical text for the same runs in a different order", async () => {
    const forward = emitContractYaml(await proposalFor(runs));
    const reversed = emitContractYaml(await proposalFor([...runs].reverse()));

    expect(forward.ok && reversed.ok).toBe(true);
    if (!forward.ok || !reversed.ok) return;
    expect(reversed.yaml).toBe(forward.yaml);
  });

  it("states in the document that it is a draft and that nothing is enforced yet", async () => {
    const emitted = emitContractYaml(await proposalFor(runs));

    expect(emitted.ok).toBe(true);
    if (!emitted.ok) return;
    expect(emitted.yaml).toContain("It is a DRAFT");
    expect(emitted.yaml).toContain("Nothing here is enforced until a human approves");
  });

  it("carries the evidence basis of every rule as a comment beside it", async () => {
    const proposal = await proposalFor(runs);
    const emitted = emitContractYaml(proposal);

    expect(emitted.ok).toBe(true);
    if (!emitted.ok) return;
    for (const entry of proposal.rules) {
      expect(emitted.yaml).toContain(`#  ${entry.rule.id}`);
      expect(emitted.yaml).toContain(entry.evidence.observed);
    }
  });

  it("carries every disclosure into the document header", async () => {
    const proposal = await proposalFor(runs);
    const emitted = emitContractYaml(proposal);

    expect(emitted.ok).toBe(true);
    if (!emitted.ok) return;
    for (const disclosure of proposal.disclosures) {
      expect(emitted.yaml).toContain(disclosure.code);
    }
  });

  it("writes route fingerprints with the sha256 prefix a reader expects", async () => {
    const proposal = await proposalFor(runs);
    const emitted = emitContractYaml(proposal);

    expect(emitted.ok).toBe(true);
    if (!emitted.ok) return;
    expect(emitted.yaml).toContain(`sha256:${proposal.approvedFamilyFingerprints[0] as string}`);
  });

  it("emits no YAML anchor or alias, whatever selectors two rules share", async () => {
    // #given a route where several steps share a structurally identical selector shape
    const emitted = emitContractYaml(await proposalFor(runs));

    expect(emitted.ok).toBe(true);
    if (!emitted.ok) return;
    expect(emitted.yaml).not.toMatch(/^\s*[^#]*&[A-Za-z]/m);
    expect(emitted.yaml).not.toMatch(/:\s*\*[A-Za-z]/);
  });

  it("emits no explicit YAML tag", async () => {
    const emitted = emitContractYaml(await proposalFor(runs));

    expect(emitted.ok).toBe(true);
    if (!emitted.ok) return;
    expect(emitted.yaml).not.toContain("!!");
  });

  it("keeps the document inside the DSL's own size and line bounds", async () => {
    const emitted = emitContractYaml(await proposalFor(runs));

    expect(emitted.ok).toBe(true);
    if (!emitted.ok) return;
    expect(Buffer.byteLength(emitted.yaml, "utf8")).toBeLessThan(CONTRACT_LIMITS.maxSourceBytes);
    expect(emitted.yaml.split("\n").length).toBeLessThan(CONTRACT_LIMITS.maxSourceLines);
  });

  it("does not let a telemetry-derived name escape a comment into the document body", async () => {
    // #given a span name that would end a comment and start a new key if it were copied verbatim
    const hostile = approvedRefundRows({
      replace: [
        {
          name: "policy.retrieve\napiVersion: evil",
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

    const emitted = emitContractYaml(await proposalFor([traceOf(1, hostile)]));

    expect(emitted.ok).toBe(true);
    if (!emitted.ok) return;
    const reparsed = parseContract(emitted.yaml);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    // #then the newline never survives into the document: it appears only inside a quoted value and
    // inside a comment, never as a second top-level key
    expect(reparsed.value.contract.apiVersion).toBe("flightrules.dev/v1alpha1");
    const topLevelKeys = emitted.yaml
      .split("\n")
      .filter((line) => /^[A-Za-z]/.test(line))
      .map((line) => line.split(":")[0]);
    expect(topLevelKeys).toEqual(["apiVersion", "kind", "metadata", "spec"]);
    expect(
      reparsed.value.contract.spec.rules.some((rule) =>
        rule.id.startsWith("require-policy-retrieveapiversion"),
      ),
    ).toBe(true);
  });

  it("does not carry an idempotency key hash or an order identifier into the document", async () => {
    // #given spans carrying exactly the values PRD section 18.3 keeps out of local storage
    const withSecrets = KNOWN_GOOD.map((row) => ({
      ...row,
      "agent.idempotency.key_hash": "9f8e7d6c5b4a39281706",
      "agent.order.id": "ord-98271",
      "http.request.header.authorization": "Bearer super-secret-token",
    }));

    const emitted = emitContractYaml(
      await proposalFor([traceOf(1, withSecrets), traceOf(2, withSecrets)]),
    );

    expect(emitted.ok).toBe(true);
    if (!emitted.ok) return;
    expect(emitted.yaml).not.toContain("9f8e7d6c5b4a39281706");
    expect(emitted.yaml).not.toContain("ord-98271");
    expect(emitted.yaml).not.toContain("super-secret-token");
  });

  it("emits the rules in identifier order, so a diff shows only real changes", async () => {
    const proposal = await proposalFor(runs);
    const emitted = emitContractYaml(proposal);

    expect(emitted.ok).toBe(true);
    if (!emitted.ok) return;
    const positions = proposal.rules.map((entry) => emitted.yaml.indexOf(`- id: ${entry.rule.id}`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

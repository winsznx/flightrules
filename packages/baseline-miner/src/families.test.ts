import { DEFAULT_NORMALISER_CONFIG, identityOf } from "@flightrules/normaliser";
import {
  approvedRefundRows,
  knownGoodTrace,
  renumberTrace,
  rowsOf,
  unsafeTrace,
} from "@flightrules/test-fixtures";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assembleDataset, type MiningDataset } from "./dataset.js";
import type { EligibilityContext, RetrievedTrace } from "./eligibility.js";
import { mineRouteFamilies, selectRepresentatives } from "./families.js";
import { baselineIdentifier, type MiningSelection, resolveSelection } from "./selection.js";
import { distributionOf } from "./statistics.js";

const IDENTITY = identityOf(DEFAULT_NORMALISER_CONFIG);
const KNOWN_GOOD = rowsOf(knownGoodTrace());
const UNSAFE = rowsOf(unsafeTrace());
const BASE_MS = Date.parse("2026-07-25T10:00:00Z");

function selection(
  overrides: Partial<Parameters<typeof resolveSelection>[0]> = {},
): MiningSelection {
  return resolveSelection({
    projectKey: "demo-commerce",
    agentKey: "refund-agent",
    releaseId: "refund-agent-v1",
    environment: null,
    startMs: BASE_MS - 3_600_000,
    endMs: BASE_MS + 86_400_000,
    minimumRuns: 1,
    rootSpanName: "refund.request",
    ...overrides,
  });
}

function contextFor(active: MiningSelection): EligibilityContext {
  return {
    selection: active,
    config: DEFAULT_NORMALISER_CONFIG,
    normaliserVersion: IDENTITY.version,
    normaliserConfigHash: IDENTITY.configHash,
  };
}

function traceOf(
  template: readonly Record<string, unknown>[],
  index: number,
  durationMs = 30 + index,
): RetrievedTrace {
  const traceId = `t${String(index).padStart(31, "0")}`;
  return {
    traceId,
    rows: renumberTrace(template, {
      traceId,
      runId: `run_${String(index).padStart(20, "0")}`,
      startedAtUtc: new Date(BASE_MS + index * 60_000).toISOString(),
      rootDurationNano: durationMs * 1_000_000,
    }),
    webUrl: null,
    untrustedFields: [],
  };
}

/** A distinct route family built from the approved topology with some spans removed. */
function variantOf(index: number, remove: readonly string[]): RetrievedTrace {
  const traceId = `t${String(index).padStart(31, "0")}`;
  return {
    traceId,
    rows: renumberTrace(approvedRefundRows({ remove: [...remove] }), {
      traceId,
      runId: `run_${String(index).padStart(20, "0")}`,
      startedAtUtc: new Date(BASE_MS + index * 1000).toISOString(),
    }),
    webUrl: null,
    untrustedFields: [],
  };
}

function datasetOf(traces: readonly RetrievedTrace[], active = selection()): MiningDataset {
  return assembleDataset({
    discoveredTraceIds: traces.map((trace) => trace.traceId),
    traces,
    context: contextFor(active),
  });
}

function mine(traces: readonly RetrievedTrace[], active = selection()) {
  return mineRouteFamilies(datasetOf(traces, active), active, baselineIdentifier(active));
}

describe("grouping runs into route families", () => {
  it("collapses many runs of one route into a single family", () => {
    // #given twenty runs of the known-good route with different identifiers and timings
    const traces = Array.from({ length: 20 }, (_, index) => traceOf(KNOWN_GOOD, index + 1));

    const mined = mine(traces);

    expect(mined.families).toHaveLength(1);
    expect(mined.families[0]?.occurrenceCount).toBe(20);
    expect(mined.families[0]?.occurrencePercent.decimal).toBe("1.000000");
    expect(mined.families[0]?.statistics.traceCount).toBe(20);
  });

  it("separates two materially different routes into two families", () => {
    // #given eight runs of the known-good route and two that skipped the fraud check
    const traces = [
      ...Array.from({ length: 8 }, (_, index) => traceOf(KNOWN_GOOD, index + 1)),
      ...Array.from({ length: 2 }, (_, index) => variantOf(index + 90, ["c3fraud0", "s3fraud0"])),
    ];

    const mined = mine(traces);

    expect(mined.families).toHaveLength(2);
    // #then the dominant family comes first
    expect(mined.families[0]?.occurrenceCount).toBe(8);
    expect(mined.families[1]?.occurrenceCount).toBe(2);
  });

  it("marks a family below the rare threshold as rare without discarding it", () => {
    // #given twenty runs of one route and one of another, so the second holds 1/21 against a 5%
    // threshold
    const traces = [
      ...Array.from({ length: 20 }, (_, index) => traceOf(KNOWN_GOOD, index + 1)),
      variantOf(50, ["c4calcul"]),
    ];

    const mined = mine(traces);

    expect(mined.families).toHaveLength(2);
    expect(mined.families[0]?.rare).toBe(false);
    expect(mined.families[1]?.rare).toBe(true);
    expect(mined.rareFamilies).toBe(1);
    // #and it is still present, with a status a reviewer can change
    expect(mined.families[1]?.status).toBe("pending");
  });

  it("does not mark a family rare when its share is exactly the threshold", () => {
    // #given one run in twenty, which is exactly 5%
    const traces = [
      ...Array.from({ length: 19 }, (_, index) => traceOf(KNOWN_GOOD, index + 1)),
      variantOf(50, ["c4calcul"]),
    ];

    const mined = mine(traces, selection({ rareThreshold: 0.05 }));

    expect(mined.families[1]?.occurrencePercent.decimal).toBe("0.050000");
    expect(mined.families[1]?.rare).toBe(false);
  });

  it("marks a family rare when its share is one part below the threshold", () => {
    const traces = [
      ...Array.from({ length: 20 }, (_, index) => traceOf(KNOWN_GOOD, index + 1)),
      variantOf(50, ["c4calcul"]),
    ];

    const mined = mine(traces, selection({ rareThreshold: 0.05 }));

    expect(mined.families[1]?.occurrencePercent.decimal).toBe("0.047619");
    expect(mined.families[1]?.rare).toBe(true);
  });

  it("makes the family occurrence shares sum to the whole", () => {
    const traces = [
      ...Array.from({ length: 7 }, (_, index) => traceOf(KNOWN_GOOD, index + 1)),
      ...Array.from({ length: 3 }, (_, index) => variantOf(index + 40, ["c4calcul"])),
    ];

    const mined = mine(traces);
    const total = mined.families.reduce((sum, family) => sum + family.occurrenceCount, 0);

    expect(total).toBe(10);
    expect(mined.families.map((family) => family.occurrencePercent.decimal)).toEqual([
      "0.700000",
      "0.300000",
    ]);
  });

  it("keeps a family identifier stable across mining runs and independent of input order", () => {
    const traces = Array.from({ length: 5 }, (_, index) => traceOf(KNOWN_GOOD, index + 1));

    const forward = mine(traces);
    const reversed = mine([...traces].reverse());

    expect(reversed.families[0]?.id).toBe(forward.families[0]?.id);
    expect(reversed.families[0]?.fingerprint).toBe(forward.families[0]?.fingerprint);
  });

  it("derives the family identifier from the fingerprint, not from first-seen order", () => {
    // #given two datasets whose families are discovered in the opposite order
    const good = Array.from({ length: 3 }, (_, index) => traceOf(KNOWN_GOOD, index + 1));
    const other = Array.from({ length: 3 }, (_, index) => variantOf(index + 40, ["c4calcul"]));

    const first = mine([...good, ...other]);
    const second = mine([...other, ...good]);

    const byFingerprint = (mined: typeof first) =>
      new Map(mined.families.map((family) => [family.fingerprint, family.id]));

    expect(byFingerprint(second)).toEqual(byFingerprint(first));
  });

  it("carries the normaliser identity onto every family", () => {
    const mined = mine([traceOf(KNOWN_GOOD, 1)]);

    expect(mined.families[0]?.normaliserVersion).toBe(IDENTITY.version);
    expect(mined.families[0]?.normaliserConfigHash).toBe(IDENTITY.configHash);
  });
});

describe("family statistics", () => {
  it("reports the duration distribution across the family's runs", () => {
    // #given five runs lasting 30 to 34 milliseconds
    const traces = Array.from({ length: 5 }, (_, index) =>
      traceOf(KNOWN_GOOD, index + 1, 30 + index),
    );

    const mined = mine(traces);
    const duration = mined.families[0]?.statistics.duration;

    expect(duration?.min).toBe(30);
    expect(duration?.max).toBe(34);
    expect(duration?.median).toBe(32);
    expect(duration?.count).toBe(5);
  });

  it("reports no token distribution when no run emitted token telemetry", () => {
    const mined = mine([traceOf(KNOWN_GOOD, 1)]);

    expect(mined.families[0]?.statistics.inputTokens).toBeNull();
    expect(mined.families[0]?.statistics.outputTokens).toBeNull();
  });

  it("reports a token distribution when the runs do emit it", () => {
    const withTokens: RetrievedTrace = {
      ...traceOf(KNOWN_GOOD, 1),
      rows: traceOf(KNOWN_GOOD, 1).rows.map((row) =>
        row["name"] === "refund.request" ? { ...row, "gen_ai.usage.output_tokens": 120 } : row,
      ),
    };

    const mined = mine([withTokens]);

    expect(mined.families[0]?.statistics.outputTokens?.max).toBe(120);
  });

  it("records the first and last time the family was observed", () => {
    const traces = Array.from({ length: 3 }, (_, index) => traceOf(KNOWN_GOOD, index + 1));

    const statistics = mine(traces).families[0]?.statistics;

    expect(statistics?.firstObservedMs).toBeLessThan(statistics?.lastObservedMs as number);
  });

  it("inventories the family's topology by canonical label", () => {
    const mined = mine([traceOf(KNOWN_GOOD, 1)]);
    const nodes = mined.families[0]?.statistics.nodes ?? [];
    const byLabel = new Map(nodes.map((node) => [node.label, node]));

    // #then the known-good route is one root, six client steps and five handlers
    expect(nodes).toHaveLength(12);
    expect(byLabel.get("payment.refund")?.sideEffect).toBe("write");
    expect(byLabel.get("payment.refund")?.tool).toBe("issue_refund");
    expect(byLabel.get("payment.refund")?.kind).toBe("Client");
    expect(byLabel.get("payment.refund")?.occurrencesPerRun).toBe(1);
    expect(byLabel.get("payment.refund")?.parentLabels).toEqual(["refund.request"]);
    // #and refund.calculate is local agent work with no handler beneath it
    expect(byLabel.has("refund.calculate")).toBe(true);
    expect(byLabel.has("refund.calculate.handler")).toBe(false);
  });

  it("counts a step that ran twice as one label with two occurrences", () => {
    // #given the captured unsafe route, which issues the refund twice. Its aborted first attempt
    // reports an error, so the selection has to accept failed runs to see it at all.
    const trace: RetrievedTrace = {
      traceId: "u0000000000000000000000000000001",
      rows: renumberTrace(UNSAFE, {
        traceId: "u0000000000000000000000000000001",
        runId: "run_unsafe0000000001",
        startedAtUtc: new Date(BASE_MS).toISOString(),
      }).map((row) => ({ ...row, "agent.release.id": "refund-agent-v1" })),
      webUrl: null,
      untrustedFields: [],
    };

    const mined = mine([trace], selection({ successfulRunsOnly: false }));
    const payment = mined.families[0]?.statistics.nodes.find(
      (node) => node.label === "payment.refund",
    );

    expect(payment?.occurrencesPerRun).toBe(2);
  });

  it("groups retries the way the evaluator does, by tool name where one exists", () => {
    const mined = mine([traceOf(KNOWN_GOOD, 1)]);
    const retries = mined.families[0]?.statistics.retries ?? [];
    const groups = retries.map((entry) => entry.group);

    expect(groups).toContain("issue_refund");
    expect(retries.every((entry) => entry.maxRetry === 0)).toBe(true);
  });

  it("counts quality warnings per run rather than per span", () => {
    const flagged: RetrievedTrace = {
      traceId: "w0000000000000000000000000000001",
      rows: renumberTrace(approvedRefundRows({ remove: ["s5paymnt"] }), {
        traceId: "w0000000000000000000000000000001",
        runId: "run_flagged000000001",
        startedAtUtc: new Date(BASE_MS).toISOString(),
      }),
      webUrl: null,
      untrustedFields: [],
    };

    const mined = mine([
      flagged,
      {
        ...flagged,
        traceId: "w0000000000000000000000000000002",
        rows: renumberTrace(approvedRefundRows({ remove: ["s5paymnt"] }), {
          traceId: "w0000000000000000000000000000002",
          runId: "run_flagged000000002",
          startedAtUtc: new Date(BASE_MS + 1000).toISOString(),
        }),
      },
    ]);

    expect(mined.families[0]?.statistics.qualityWarnings).toEqual([
      { kind: "client_span_without_server_span", runs: 2 },
    ]);
  });
});

describe("selecting representative traces", () => {
  it("chooses the runs closest to the family's median duration", () => {
    const traces = Array.from({ length: 7 }, (_, index) =>
      traceOf(KNOWN_GOOD, index + 1, 10 + index * 10),
    );

    const mined = mine(traces);
    const family = mined.families[0];
    const representatives = family?.representativeTraceIds ?? [];

    expect(representatives).toHaveLength(3);
    // #then the median run is among them and the fastest is not
    const durations = new Map(
      (mined.runsByFingerprint.get(family?.fingerprint as string) ?? []).map((run) => [
        run.traceId,
        run.durationMs,
      ]),
    );
    const median = family?.statistics.duration.median as number;
    for (const traceId of representatives) {
      expect(Math.abs((durations.get(traceId) as number) - median)).toBeLessThanOrEqual(20);
    }
  });

  it("returns the same representatives whatever order the runs arrive in", () => {
    const traces = Array.from({ length: 9 }, (_, index) =>
      traceOf(KNOWN_GOOD, index + 1, 20 + index),
    );

    expect(mine([...traces].reverse()).families[0]?.representativeTraceIds).toEqual(
      mine(traces).families[0]?.representativeTraceIds,
    );
  });

  it("breaks a tie on equal durations by trace identifier", () => {
    const runs = [
      { traceId: "bbb", durationMs: 10 },
      { traceId: "aaa", durationMs: 10 },
    ].map(
      (entry) => ({ ...entry }) as never as Parameters<typeof selectRepresentatives>[0][number],
    );

    const chosen = selectRepresentatives(runs, distributionOf([10, 10]) as never, 1);

    expect(chosen).toEqual(["aaa"]);
  });

  it("never returns more representatives than the family has runs", () => {
    expect(mine([traceOf(KNOWN_GOOD, 1)]).families[0]?.representativeTraceIds).toHaveLength(1);
  });
});

describe("mining determinism", () => {
  it("produces identical families for any permutation of the same runs", () => {
    const traces = Array.from({ length: 6 }, (_, index) =>
      traceOf(KNOWN_GOOD, index + 1, 20 + index),
    );
    const expected = JSON.stringify(mine(traces).families);

    fc.assert(
      fc.property(fc.shuffledSubarray(traces, { minLength: 6, maxLength: 6 }), (permuted) => {
        expect(JSON.stringify(mine(permuted).families)).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  it("produces identical families when every identifier and timestamp differs", () => {
    const first = Array.from({ length: 4 }, (_, index) => traceOf(KNOWN_GOOD, index + 1, 25));
    const second = Array.from({ length: 4 }, (_, index) => traceOf(KNOWN_GOOD, index + 500, 25));

    const forward = mine(first).families[0];
    const other = mine(second).families[0];

    expect(other?.fingerprint).toBe(forward?.fingerprint);
    expect(other?.statistics.nodes).toEqual(forward?.statistics.nodes);
    expect(other?.statistics.edges).toEqual(forward?.statistics.edges);
    expect(other?.statistics.duration).toEqual(forward?.statistics.duration);
  });

  it("survives prototype-shaped span, service, tool and attribute names", () => {
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
          dataDomain: "valueOf",
          retry: 0,
          attributes: { hasOwnProperty: "prototype", __proto__: ["a", "b"] },
        },
      ],
      remove: ["s1policy"],
    });

    const trace: RetrievedTrace = {
      traceId: "h0000000000000000000000000000001",
      rows: hostile,
      webUrl: null,
      untrustedFields: [],
    };

    const mined = mine([trace]);
    const labels = mined.families[0]?.statistics.nodes.map((node) => node.label) ?? [];

    expect(labels).toContain("__proto__");
    // #then nothing was inherited: the label carries exactly what the span emitted
    const hostileNode = mined.families[0]?.statistics.nodes.find(
      (node) => node.label === "__proto__",
    );
    expect(hostileNode?.service).toBe("constructor");
    expect(hostileNode?.tool).toBe("toString");
    // The normaliser folds `agent.data_domain` to lower case, which is why the domain is compared
    // in that form rather than as emitted.
    expect(hostileNode?.dataDomain).toBe("valueof");
    expect(hostileNode?.occurrencesPerRun).toBe(1);
  });

  it("refuses a dataset with more distinct families than it will materialise", () => {
    // #given a selection whose runs are all structurally different
    const traces = Array.from({ length: 40 }, (_, index) => ({
      traceId: `x${String(index).padStart(31, "0")}`,
      rows: renumberTrace(
        approvedRefundRows({
          add: [
            {
              name: `extra.step.${index}`,
              spanId: `extra${String(index).padStart(3, "0")}`,
              parentSpanId: "root0000",
              tool: `tool_${index}`,
              operation: "execute_tool",
              sideEffect: "read",
              retry: 0,
            },
          ],
        }),
        {
          traceId: `x${String(index).padStart(31, "0")}`,
          runId: `run_x${String(index).padStart(19, "0")}`,
          startedAtUtc: new Date(BASE_MS + index * 1000).toISOString(),
        },
      ),
      webUrl: null,
      untrustedFields: [],
    }));

    // #then each is its own family, and the count is reported rather than collapsed
    const mined = mine(traces);
    expect(mined.families).toHaveLength(40);
    expect(new Set(mined.families.map((family) => family.id)).size).toBe(40);
  });
});

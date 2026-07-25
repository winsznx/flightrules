import { DEFAULT_NORMALISER_CONFIG, identityOf } from "@flightrules/normaliser";
import {
  approvedRefundRows,
  knownGoodTrace,
  renumberTrace,
  rowsOf,
} from "@flightrules/test-fixtures";
import { describe, expect, it } from "vitest";
import type { RetrievedTrace } from "./eligibility.js";
import { MINING_STAGES, type MiningProgress, mineBaseline, type TraceSource } from "./mine.js";

const KNOWN_GOOD = rowsOf(knownGoodTrace());
const BASE_MS = Date.parse("2026-07-25T10:00:00Z");
const IDENTITY = identityOf(DEFAULT_NORMALISER_CONFIG);

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

interface SourceOptions {
  readonly traces?: readonly RetrievedTrace[];
  readonly discoveredTraceIds?: readonly string[];
  readonly truncated?: boolean;
  readonly pages?: number;
  readonly unverified?: readonly string[];
  readonly fieldTypeError?: string;
  readonly discoveryError?: string;
  readonly failures?: readonly {
    readonly code: "TRACE_FETCH_FAILED";
    readonly subject: string;
    readonly message: string;
  }[];
}

function sourceOf(options: SourceOptions = {}): TraceSource {
  const traces = options.traces ?? [];
  return {
    verifyFieldTypes: async () =>
      options.fieldTypeError === undefined
        ? {
            ok: true,
            report: {
              verified: ["trace_id"],
              unverified: options.unverified ?? [],
              mismatched: [],
            },
          }
        : {
            ok: false,
            error: {
              code: "FIELD_TYPE_MISMATCH",
              subject: "agent.idempotency.present",
              message: options.fieldTypeError,
            },
          },
    discover: async () =>
      options.discoveryError === undefined
        ? {
            ok: true,
            dataset: {
              traceIds: options.discoveredTraceIds ?? traces.map((trace) => trace.traceId),
              pages: options.pages ?? 1,
              truncated: options.truncated ?? false,
            },
          }
        : {
            ok: false,
            error: {
              code: "DISCOVERY_FAILED",
              subject: "refund-agent-v1",
              message: options.discoveryError,
            },
          },
    fetch: async () => ({ traces, failures: options.failures ?? [] }),
  };
}

async function mine(source: TraceSource, overrides: Record<string, unknown> = {}) {
  const progress: MiningProgress[] = [];
  const result = await mineBaseline({
    selection: {
      projectKey: "demo-commerce",
      agentKey: "refund-agent",
      releaseId: "refund-agent-v1",
      environment: null,
      startMs: BASE_MS - 3_600_000,
      endMs: BASE_MS + 86_400_000,
      minimumRuns: 1,
      rootSpanName: "refund.request",
      ...overrides,
    },
    source,
    onProgress: (entry) => progress.push(entry),
  });
  return { result, progress };
}

const twenty = Array.from({ length: 20 }, (_, index) => traceOf(index + 1));

describe("the trace selection job", () => {
  it("mines a baseline and reports counts that reconcile", async () => {
    const { result } = await mine(sourceOf({ traces: twenty }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const counts = result.value.baseline.counts;
    expect(counts.tracesDiscovered).toBe(20);
    expect(counts.eligibleRuns).toBe(20);
    expect(counts.excludedTraces).toBe(0);
    expect(counts.routeFamilies).toBe(1);
    expect(counts.eligibleRuns + counts.excludedTraces).toBe(counts.tracesDiscovered);
  });

  it("reports each of PRD section 8.7's progress states, in order", async () => {
    const { progress } = await mine(sourceOf({ traces: twenty }));

    expect(progress.map((entry) => entry.stage)).toEqual([...MINING_STAGES]);
    for (const entry of progress) expect(entry.detail.length).toBeGreaterThan(0);
  });

  it("preserves the normaliser version and configuration hash on the baseline", async () => {
    const { result } = await mine(sourceOf({ traces: twenty }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.baseline.normaliserVersion).toBe(IDENTITY.version);
    expect(result.value.baseline.normaliserConfigHash).toBe(IDENTITY.configHash);
    expect(result.value.baseline.families[0]?.normaliserConfigHash).toBe(IDENTITY.configHash);
  });

  it("records the selection window, the minimum runs and the rare threshold", async () => {
    const { result } = await mine(sourceOf({ traces: twenty }), {
      minimumRuns: 20,
      rareThreshold: 0.1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.baseline.minimumRuns).toBe(20);
    expect(result.value.baseline.rareThreshold.decimal).toBe("0.100000");
    expect(result.value.baseline.sourceTimeStartMs).toBe(BASE_MS - 3_600_000);
    expect(result.value.baseline.sourceTimeEndMs).toBe(BASE_MS + 86_400_000);
  });

  it("blocks a baseline whose eligible run count is below the minimum", async () => {
    const { result } = await mine(sourceOf({ traces: twenty.slice(0, 3) }), { minimumRuns: 20 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.baseline.status).toBe("insufficient_runs");
    expect(result.value.baseline.disclosures.map((entry) => entry.code)).toContain(
      "INSUFFICIENT_RUNS",
    );
  });

  it("blocks a baseline whose dataset was truncated, even when it has enough runs", async () => {
    const { result } = await mine(sourceOf({ traces: twenty, truncated: true }), {
      minimumRuns: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.baseline.status).toBe("dataset_truncated");
    expect(result.value.baseline.retrieval.truncated).toBe(true);
    expect(result.value.baseline.disclosures.map((entry) => entry.code)).toContain(
      "DATASET_TRUNCATED",
    );
  });

  it("refuses to mine when a declared field type could not be trusted", async () => {
    const { result } = await mine(
      sourceOf({ traces: twenty, fieldTypeError: "declared bool, SigNoz reports string" }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("FIELD_TYPES_UNTRUSTED");
    expect(result.errors[0]?.message).toContain("SigNoz reports");
  });

  it("refuses to mine from a partial dataset when discovery failed", async () => {
    const { result } = await mine(sourceOf({ discoveryError: "page 2 returned TRANSPORT_ERROR" }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("DISCOVERY_FAILED");
  });

  it("refuses an invalid selection before it queries anything", async () => {
    const { result, progress } = await mine(sourceOf({ traces: twenty }), { minimumRuns: 0 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("SELECTION_INVALID");
    expect(progress).toEqual([]);
  });

  it("discloses the fields whose type the catalogue could not confirm", async () => {
    const { result } = await mine(
      sourceOf({ traces: twenty, unverified: ["timestamp", "service.name"] }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const disclosure = result.value.baseline.disclosures.find(
      (entry) => entry.code === "FIELD_TYPE_UNVERIFIED",
    );
    expect(disclosure?.detail).toContain("timestamp");
    expect(disclosure?.count).toBe(2);
    expect(result.value.baseline.retrieval.fieldTypesUnverified).toEqual([
      "timestamp",
      "service.name",
    ]);
  });

  it("discloses the excluded traces with a per-reason breakdown", async () => {
    const wrongRelease: RetrievedTrace = {
      ...traceOf(90),
      rows: traceOf(90).rows.map((row) => ({ ...row, "agent.release.id": "refund-agent-v2" })),
    };

    const { result } = await mine(sourceOf({ traces: [...twenty, wrongRelease] }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const disclosure = result.value.baseline.disclosures.find(
      (entry) => entry.code === "TRACES_EXCLUDED",
    );
    expect(disclosure?.count).toBe(1);
    expect(disclosure?.detail).toContain("RELEASE_MISMATCH 1");
  });

  it("discloses a rare family", async () => {
    const rare: RetrievedTrace = {
      ...traceOf(90),
      rows: renumberTrace(approvedRefundRows({ remove: ["c4calcul"] }), {
        traceId: traceOf(90).traceId,
        runId: "run_rare000000000001",
        startedAtUtc: new Date(BASE_MS).toISOString(),
      }),
    };

    const { result } = await mine(sourceOf({ traces: [...twenty, rare] }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.baseline.counts.rareFamilies).toBe(1);
    expect(result.value.baseline.disclosures.map((entry) => entry.code)).toContain(
      "RARE_FAMILY_PRESENT",
    );
  });

  it("counts a discovered trace that could not be fetched, and keeps the failure visible", async () => {
    const { result } = await mine(
      sourceOf({
        traces: twenty,
        discoveredTraceIds: [...twenty.map((trace) => trace.traceId), "tmissing"],
        failures: [
          { code: "TRACE_FETCH_FAILED", subject: "tmissing", message: "returned SUCCESS_EMPTY" },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.baseline.counts.tracesDiscovered).toBe(21);
    expect(result.value.baseline.counts.excludedByReason).toEqual([
      { reason: "TRACE_FETCH_FAILED", count: 1 },
    ]);
    expect(result.value.retrievalFailures).toHaveLength(1);
  });

  it("records how the dataset was retrieved", async () => {
    const { result } = await mine(sourceOf({ traces: twenty, pages: 3 }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.baseline.retrieval.pages).toBe(3);
    expect(result.value.baseline.retrieval.batchSize).toBeGreaterThan(0);
    expect(result.value.baseline.retrieval.startMs).toBe(BASE_MS - 3_600_000);
  });

  it("derives one baseline identifier for one selection, so a repeated job is recognisable", async () => {
    const first = await mine(sourceOf({ traces: twenty }));
    const second = await mine(sourceOf({ traces: [...twenty].reverse() }));

    expect(first.result.ok && second.result.ok).toBe(true);
    if (!first.result.ok || !second.result.ok) return;
    expect(second.result.value.baseline.id).toBe(first.result.value.baseline.id);
    expect(second.result.value.baseline.selectionHash).toBe(
      first.result.value.baseline.selectionHash,
    );
  });

  it("produces a byte-identical baseline for the same runs in a different order", async () => {
    const first = await mine(sourceOf({ traces: twenty }));
    const second = await mine(sourceOf({ traces: [...twenty].reverse() }));

    expect(first.result.ok && second.result.ok).toBe(true);
    if (!first.result.ok || !second.result.ok) return;

    // The graphs carry span identifiers, which differ per run by construction, so the comparison is
    // over the projection a baseline actually stores.
    const projection = (value: typeof first.result.value.baseline) => ({
      ...value,
      families: value.families.map((family) => ({ ...family, canonical: family.canonical })),
    });

    expect(JSON.stringify(projection(second.result.value.baseline))).toBe(
      JSON.stringify(projection(first.result.value.baseline)),
    );
  });

  it("mines nothing without failing when the window holds no runs", async () => {
    const { result } = await mine(sourceOf({ traces: [] }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.baseline.status).toBe("insufficient_runs");
    expect(result.value.baseline.families).toEqual([]);
    expect(result.value.baseline.counts.tracesDiscovered).toBe(0);
  });
});

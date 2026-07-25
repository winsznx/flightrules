import { describe, expect, it } from "vitest";
import { TEXT_LIMITS } from "./safety.js";
import {
  baselineIdentifier,
  type MiningSelectionInput,
  resolveSelection,
  routeFamilyIdentifier,
  SELECTION_DEFAULTS,
  selectionHash,
} from "./selection.js";

const VALID: MiningSelectionInput = {
  projectKey: "demo-commerce",
  agentKey: "refund-agent",
  releaseId: "refund-agent-v1",
  environment: "local",
  startMs: Date.parse("2026-07-25T00:00:00Z"),
  endMs: Date.parse("2026-07-26T00:00:00Z"),
  minimumRuns: 20,
  rootSpanName: "refund.request",
};

describe("resolving a mining selection", () => {
  it("fills the operational bounds a caller did not choose", () => {
    const selection = resolveSelection(VALID);

    expect(selection.successfulRunsOnly).toBe(SELECTION_DEFAULTS.successfulRunsOnly);
    expect(selection.excludeMissingRootSpan).toBe(SELECTION_DEFAULTS.excludeMissingRootSpan);
    expect(selection.maxTraces).toBe(SELECTION_DEFAULTS.maxTraces);
    expect(selection.batchSize).toBe(SELECTION_DEFAULTS.batchSize);
    expect(selection.representativesPerFamily).toBe(SELECTION_DEFAULTS.representativesPerFamily);
  });

  it("keeps the rare threshold as an exact fraction rather than a double", () => {
    expect(resolveSelection({ ...VALID, rareThreshold: 0.05 }).rareThreshold).toEqual({
      numerator: 5,
      denominator: 100,
      decimal: "0.050000",
    });
  });

  it("treats an absent environment as unconstrained rather than as a value", () => {
    expect(resolveSelection({ ...VALID, environment: undefined }).environment).toBeNull();
  });

  it("rejects a project or agent key the contract grammar would refuse", () => {
    expect(() => resolveSelection({ ...VALID, projectKey: "Demo Commerce" })).toThrow(RangeError);
    expect(() => resolveSelection({ ...VALID, agentKey: "-refund" })).toThrow(RangeError);
    expect(() => resolveSelection({ ...VALID, agentKey: "" })).toThrow(RangeError);
  });

  it("rejects a window that does not move forwards", () => {
    expect(() => resolveSelection({ ...VALID, endMs: VALID.startMs })).toThrow(RangeError);
    expect(() => resolveSelection({ ...VALID, startMs: 1.5 })).toThrow(RangeError);
  });

  it("rejects an empty release identifier or root span name", () => {
    expect(() => resolveSelection({ ...VALID, releaseId: "" })).toThrow(RangeError);
    expect(() => resolveSelection({ ...VALID, rootSpanName: "" })).toThrow(RangeError);
  });

  it("rejects a request for more traces than it will fetch, rather than quietly fetching fewer", () => {
    expect(() => resolveSelection({ ...VALID, maxTraces: TEXT_LIMITS.maxTraces + 1 })).toThrow(
      RangeError,
    );
    expect(() => resolveSelection({ ...VALID, maxTraces: 0 })).toThrow(RangeError);
  });

  it("rejects a minimum run count of zero, which would make every dataset sufficient", () => {
    expect(() => resolveSelection({ ...VALID, minimumRuns: 0 })).toThrow(RangeError);
  });

  it("rejects a rare threshold above one", () => {
    expect(() => resolveSelection({ ...VALID, rareThreshold: 1.5 })).toThrow(RangeError);
  });

  it("rejects a rare threshold with more precision than it can hold exactly", () => {
    expect(() => resolveSelection({ ...VALID, rareThreshold: 0.0000001 })).toThrow(RangeError);
  });
});

describe("selection identity", () => {
  it("hashes two identical selections to the same value, so a repeated job is recognisable", () => {
    expect(selectionHash(resolveSelection(VALID))).toBe(
      selectionHash(resolveSelection({ ...VALID })),
    );
  });

  it("changes the hash when anything that decides the dataset changes", () => {
    const base = selectionHash(resolveSelection(VALID));

    for (const variant of [
      { releaseId: "refund-agent-v2" },
      { environment: "staging" },
      { minimumRuns: 21 },
      { rootSpanName: "checkout.request" },
      { successfulRunsOnly: false },
      { excludeMissingRootSpan: false },
      { rareThreshold: 0.1 },
      { maxTraces: 500 },
      { maxSpansPerTrace: 5_000 },
      { representativesPerFamily: 5 },
      { startMs: VALID.startMs + 1 },
      { endMs: VALID.endMs + 1 },
    ] as const) {
      expect(selectionHash(resolveSelection({ ...VALID, ...variant }))).not.toBe(base);
    }
  });

  it("does not change the hash when only the fetch batching changes", () => {
    // #given a different batch size, which changes how the same dataset is fetched, not which it is
    expect(selectionHash(resolveSelection({ ...VALID, batchSize: 50 }))).toBe(
      selectionHash(resolveSelection(VALID)),
    );
  });

  it("derives the baseline identifier from the selection rather than generating one", () => {
    expect(baselineIdentifier(resolveSelection(VALID))).toBe(
      baselineIdentifier(resolveSelection({ ...VALID })),
    );
    expect(baselineIdentifier(resolveSelection(VALID))).toMatch(/^bl-[0-9a-f]{32}$/);
  });

  it("derives a family identifier from the baseline and the fingerprint", () => {
    const baseline = baselineIdentifier(resolveSelection(VALID));

    expect(routeFamilyIdentifier(baseline, "a".repeat(64))).toMatch(/^rf-[0-9a-f]{32}$/);
    expect(routeFamilyIdentifier(baseline, "a".repeat(64))).not.toBe(
      routeFamilyIdentifier(baseline, "b".repeat(64)),
    );
    expect(routeFamilyIdentifier("bl-other", "a".repeat(64))).not.toBe(
      routeFamilyIdentifier(baseline, "a".repeat(64)),
    );
  });
});

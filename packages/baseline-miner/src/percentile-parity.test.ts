import { percentileOfAscending } from "@flightrules/contract-engine";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { percentileOf } from "./statistics.js";

/**
 * The baseline and the release gate must measure a percentile the same way.
 *
 * The miner computes the baseline's p95 and the release aggregation computes the candidate's, in
 * two packages that deliberately do not depend on each other. If the two definitions ever drifted,
 * every latency and token regression the gate reports would be wrong by a rounding rule nobody
 * could see — a release could fail because of a percentile convention rather than behaviour.
 *
 * This test is the seam. It is cheap, and it is the only thing standing between "the same
 * definition" and "two functions that happen to agree on the examples someone tried".
 */

describe("percentile parity between the miner and the release gate", () => {
  it("agrees on the worked examples", () => {
    // #given ten ascending samples
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

    // #then both implementations pick the same nearest rank at every documented percentile
    for (const percent of [50, 75, 90, 95, 99]) {
      expect(percentileOfAscending(samples, percent)).toBe(percentileOf(samples, percent, 100));
    }
  });

  it("agrees on every non-empty ascending sample set", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 200 }),
        fc.constantFrom(50, 75, 90, 95, 99),
        (values, percent) => {
          // #given any ascending sample set
          const ascending = [...values].sort((a, b) => a - b);

          // #then the two implementations return the same value
          expect(percentileOfAscending(ascending, percent)).toBe(
            percentileOf(ascending, percent, 100),
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  it("differs only in how they answer an empty set", () => {
    // #given no samples at all
    // #then the miner refuses and the gate reports "not measured"; neither invents a value
    expect(() => percentileOf([], 95, 100)).toThrow(RangeError);
    expect(percentileOfAscending([], 95)).toBeNull();
  });
});

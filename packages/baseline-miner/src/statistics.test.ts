import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  atLeastRatio,
  belowRatio,
  distributionOf,
  ONE_RATIO,
  percentileOf,
  ratio,
  ratioFromDecimal,
  withMargin,
  ZERO_RATIO,
} from "./statistics.js";

describe("exact ratios", () => {
  it("renders a share to six decimal places by integer division", () => {
    // #given three of eight runs
    const share = ratio(3, 8);

    // #then the rendering is exact rather than a floating-point approximation
    expect(share.decimal).toBe("0.375000");
    expect(share.numerator).toBe(3);
    expect(share.denominator).toBe(8);
  });

  it("truncates rather than rounds, so a share below one never renders as one", () => {
    // #given a share one part short of the whole
    const share = ratio(999_999, 1_000_000);

    // #then it does not read as 1.000000
    expect(share.decimal).toBe("0.999999");
    expect(ONE_RATIO.decimal).toBe("1.000000");
  });

  it("reports zero and one as their own exact fractions", () => {
    expect(ZERO_RATIO.decimal).toBe("0.000000");
    expect(ratio(0, 7).decimal).toBe("0.000000");
    expect(ratio(7, 7).decimal).toBe("1.000000");
  });

  it("refuses a zero denominator instead of reporting a share of nothing", () => {
    expect(() => ratio(0, 0)).toThrow(RangeError);
    expect(() => ratio(1, -1)).toThrow(RangeError);
    expect(() => ratio(-1, 1)).toThrow(RangeError);
  });

  it("compares by cross-multiplication, so no division decides a threshold", () => {
    // #given two thirds and a threshold of 0.666667
    const observed = ratio(2, 3);
    const threshold = ratioFromDecimal(0.666667);

    // #then the comparison is exact in both directions
    expect(atLeastRatio(observed, threshold)).toBe(false);
    expect(belowRatio(observed, threshold)).toBe(true);
    expect(atLeastRatio(observed, ratioFromDecimal(0.666666))).toBe(true);
  });

  it("recovers the decimal digits a caller wrote rather than the nearest double", () => {
    // #given 0.05, which no binary double represents exactly
    const threshold = ratioFromDecimal(0.05);

    // #then the fraction is five hundredths
    expect(threshold.numerator).toBe(5);
    expect(threshold.denominator).toBe(100);
  });

  it("rejects a threshold with more precision than it can hold exactly", () => {
    expect(() => ratioFromDecimal(0.1234567)).toThrow(RangeError);
    expect(() => ratioFromDecimal(Number.NaN)).toThrow(RangeError);
    expect(() => ratioFromDecimal(-0.5)).toThrow(RangeError);
    expect(() => ratioFromDecimal(1e-7)).toThrow(RangeError);
  });

  it("treats a whole number as itself over one", () => {
    expect(ratioFromDecimal(1)).toEqual({ numerator: 1, denominator: 1, decimal: "1.000000" });
    expect(ratioFromDecimal(0)).toEqual({ numerator: 0, denominator: 1, decimal: "0.000000" });
  });
});

describe("nearest-rank percentiles", () => {
  it("returns the only observation for a one-sample dataset at every percentile", () => {
    const single = distributionOf([42]);

    expect(single?.count).toBe(1);
    expect(single?.min).toBe(42);
    expect(single?.max).toBe(42);
    expect(single?.median).toBe(42);
    expect(single?.p95).toBe(42);
    expect(single?.p99).toBe(42);
  });

  it("takes the lower of two observations as the median of a two-sample dataset", () => {
    // #given two samples; nearest rank at 50% is ceil(0.5 x 2) = 1
    const pair = distributionOf([10, 20]);

    // #then the median is an observed value, not their average
    expect(pair?.median).toBe(10);
    expect(pair?.p95).toBe(20);
    expect(pair?.mean).toEqual({ numerator: 30, denominator: 2, decimal: "15.000000" });
  });

  it("takes the middle observation for an odd sample count", () => {
    expect(distributionOf([5, 1, 3])?.median).toBe(3);
  });

  it("takes the lower middle observation for an even sample count", () => {
    expect(distributionOf([1, 3, 5, 7])?.median).toBe(3);
  });

  it("puts an exact percentile boundary on the observation the rank names", () => {
    // #given twenty ascending samples, so ceil(0.95 x 20) = 19
    const samples = Array.from({ length: 20 }, (_, index) => index + 1);

    expect(percentileOf(samples, 95, 100)).toBe(19);
    expect(percentileOf(samples, 90, 100)).toBe(18);
    expect(percentileOf(samples, 99, 100)).toBe(20);
    expect(percentileOf(samples, 50, 100)).toBe(10);
  });

  it("clamps a rank of zero to the first observation and never indexes past the last", () => {
    expect(percentileOf([7, 8, 9], 0, 100)).toBe(7);
    expect(percentileOf([7, 8, 9], 100, 100)).toBe(9);
    expect(percentileOf([7, 8, 9], 200, 100)).toBe(9);
  });

  it("refuses a percentile over an empty sample instead of inventing one", () => {
    expect(() => percentileOf([], 95, 100)).toThrow(RangeError);
    expect(() => percentileOf([1], 95, 0)).toThrow(RangeError);
  });

  it("returns no distribution for an empty dataset rather than a distribution of zeros", () => {
    expect(distributionOf([])).toBeNull();
  });

  it("keeps an explicit zero as an observation rather than treating it as missing", () => {
    // #given a dataset where every run reported zero retries
    const zeros = distributionOf([0, 0, 0]);

    // #then the distribution exists and reports zero, which is a different fact from no data
    expect(zeros).not.toBeNull();
    expect(zeros?.count).toBe(3);
    expect(zeros?.max).toBe(0);
    expect(zeros?.mean.decimal).toBe("0.000000");
  });

  it("refuses a dataset whose exact sum is not representable rather than losing precision", () => {
    const half = Math.floor(Number.MAX_SAFE_INTEGER / 2);

    expect(() => distributionOf([half, half, half])).toThrow(RangeError);
  });

  it("refuses a non-integer sample instead of truncating it", () => {
    expect(() => distributionOf([1.5])).toThrow(RangeError);
    expect(() => distributionOf([Number.NaN])).toThrow(RangeError);
  });

  it("refuses a negative sample, since every statistic here counts something", () => {
    expect(() => distributionOf([-1])).toThrow(RangeError);
  });
});

describe("safety margins", () => {
  it("rounds a margin up, so a bound is never tighter than the observation", () => {
    // #given 30 ms with a 20% margin, which is 36 exactly
    expect(withMargin(30, 20)).toBe(36);
    // #and 33 ms with a 20% margin, which is 39.6
    expect(withMargin(33, 20)).toBe(40);
  });

  it("returns the observation unchanged for a zero margin", () => {
    expect(withMargin(1, 0)).toBe(1);
    expect(withMargin(0, 50)).toBe(0);
  });

  it("refuses a negative margin and a margin that would overflow", () => {
    expect(() => withMargin(10, -1)).toThrow(RangeError);
    expect(() => withMargin(Number.MAX_SAFE_INTEGER, 100)).toThrow(RangeError);
  });
});

describe("statistical properties", () => {
  it("produces the same distribution whatever order the samples arrive in", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 100_000 }), { minLength: 1, maxLength: 200 }),
        (samples) => {
          const forward = distributionOf(samples);
          const reversed = distributionOf([...samples].reverse());
          const sorted = distributionOf([...samples].sort((a, b) => a - b));

          expect(reversed).toEqual(forward);
          expect(sorted).toEqual(forward);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("reports every percentile as a value the dataset actually contains", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 10_000 }), { minLength: 1, maxLength: 100 }),
        (samples) => {
          const distribution = distributionOf(samples) as NonNullable<
            ReturnType<typeof distributionOf>
          >;
          const present = new Set(samples);

          for (const value of [
            distribution.min,
            distribution.max,
            distribution.median,
            distribution.p50,
            distribution.p75,
            distribution.p90,
            distribution.p95,
            distribution.p99,
          ]) {
            expect(present.has(value)).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("keeps percentiles monotonic and bounded by the extremes", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 100 }),
        (samples) => {
          const d = distributionOf(samples) as NonNullable<ReturnType<typeof distributionOf>>;

          expect(d.min).toBeLessThanOrEqual(d.p50);
          expect(d.p50).toBeLessThanOrEqual(d.p75);
          expect(d.p75).toBeLessThanOrEqual(d.p90);
          expect(d.p90).toBeLessThanOrEqual(d.p95);
          expect(d.p95).toBeLessThanOrEqual(d.p99);
          expect(d.p99).toBeLessThanOrEqual(d.max);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("never renders a share outside zero and one, and never as a float", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5_000 }),
        fc.integer({ min: 1, max: 5_000 }),
        (numerator, denominator) => {
          const share = ratio(Math.min(numerator, denominator), denominator);
          expect(share.decimal).toMatch(/^[01]\.\d{6}$/);
          expect(Number.isInteger(share.numerator)).toBe(true);
          expect(Number.isInteger(share.denominator)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});

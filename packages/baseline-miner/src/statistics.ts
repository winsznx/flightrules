/**
 * Deterministic statistics over integer samples.
 *
 * Everything a proposal is derived from is a count, an attempt index, a whole millisecond or a token
 * count, so every statistic here is computed from integers and reported as integers or as exact
 * fractions. No floating-point value ever reaches the mining output: PRD section 11.12 requires
 * byte-equivalent results for equivalent input, and a double accumulated in a different order is the
 * one thing that can break that without any logic being wrong.
 *
 * Percentiles use the **nearest-rank** definition rather than interpolation, so every reported
 * percentile is a value some run actually produced. Interpolation would invent a number between two
 * observations and would need division to do it.
 */

/** An exact fraction with a fixed-precision decimal rendering for display and for evidence. */
export interface Ratio {
  readonly numerator: number;
  readonly denominator: number;
  /** Six decimal places, produced by integer division so it is identical on every platform. */
  readonly decimal: string;
}

const DECIMAL_SCALE = 1_000_000;
const DECIMAL_PLACES = 6;

export const ZERO_RATIO: Ratio = { numerator: 0, denominator: 1, decimal: "0.000000" };
export const ONE_RATIO: Ratio = { numerator: 1, denominator: 1, decimal: "1.000000" };

function assertSafeInteger(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${what} must be a safe integer, received ${String(value)}`);
  }
}

/**
 * Builds an exact ratio.
 *
 * A zero denominator is not silently turned into zero: "none of nothing" is not a support ratio, and
 * a caller that reaches this with an empty sample has a bug the ratio would hide.
 */
export function ratio(numerator: number, denominator: number): Ratio {
  assertSafeInteger(numerator, "a ratio numerator");
  assertSafeInteger(denominator, "a ratio denominator");
  if (denominator <= 0) {
    throw new RangeError(`a ratio denominator must be positive, received ${String(denominator)}`);
  }
  if (numerator < 0) {
    throw new RangeError(`a ratio numerator must not be negative, received ${String(numerator)}`);
  }
  return { numerator, denominator, decimal: renderDecimal(numerator, denominator) };
}

/**
 * Renders `numerator / denominator` to six places by integer arithmetic.
 *
 * Truncating rather than rounding, so the rendered value never reads as larger than the exact
 * fraction — a support ratio displayed as `1.000000` must mean every run, not 99.99995% of them.
 */
function renderDecimal(numerator: number, denominator: number): string {
  const scaled = Math.floor((numerator * DECIMAL_SCALE) / denominator);
  const whole = Math.floor(scaled / DECIMAL_SCALE);
  const fraction = scaled - whole * DECIMAL_SCALE;
  return `${whole}.${String(fraction).padStart(DECIMAL_PLACES, "0")}`;
}

/** `left >= right`, decided by cross-multiplication so no division is involved. */
export function atLeastRatio(left: Ratio, right: Ratio): boolean {
  return left.numerator * right.denominator >= right.numerator * left.denominator;
}

/** `left < right`, decided by cross-multiplication. */
export function belowRatio(left: Ratio, right: Ratio): boolean {
  return left.numerator * right.denominator < right.numerator * left.denominator;
}

/**
 * Parses a decimal threshold such as `0.05` into an exact fraction.
 *
 * `Number.prototype.toString` returns the shortest decimal that round-trips, which recovers the
 * digits the caller wrote, so `0.05` becomes 5/100 rather than the nearest binary double. The same
 * construction Phase 07 uses for contract thresholds, for the same reason.
 */
export function ratioFromDecimal(value: number): Ratio {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `a threshold must be a finite non-negative number, received ${String(value)}`,
    );
  }
  const text = value.toString();
  if (text.includes("e") || text.includes("E")) {
    throw new RangeError(`a threshold must not use exponent notation, received ${text}`);
  }
  const point = text.indexOf(".");
  if (point === -1) return ratio(value, 1);

  const digits = text.length - point - 1;
  if (digits > DECIMAL_PLACES) {
    throw new RangeError(
      `a threshold may carry at most ${DECIMAL_PLACES} decimal places, received ${text}`,
    );
  }
  const denominator = 10 ** digits;
  return ratio(Math.round(value * denominator), denominator);
}

/**
 * A distribution over one integer sample set.
 *
 * `mean` is an exact fraction rather than a rounded number, because a mean is the one statistic here
 * that is genuinely not an observed value; reporting it as a fraction keeps it exact and makes that
 * obvious. Percentiles are all observed values.
 */
export interface Distribution {
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly sum: number;
  readonly mean: Ratio;
  readonly median: number;
  readonly p50: number;
  readonly p75: number;
  readonly p90: number;
  readonly p95: number;
  readonly p99: number;
}

/**
 * The nearest-rank percentile of an ascending sample.
 *
 * `rank = ceil(p × n)`, one-indexed and clamped into `[1, n]`. Computed as one integer
 * multiplication and one integer division, so it cannot depend on floating-point rounding.
 */
export function percentileOf(
  ascending: readonly number[],
  percentNumerator: number,
  percentDenominator: number,
): number {
  if (ascending.length === 0) {
    throw new RangeError("a percentile requires at least one sample");
  }
  if (percentDenominator <= 0) {
    throw new RangeError("a percentile denominator must be positive");
  }
  const rank = Math.ceil((percentNumerator * ascending.length) / percentDenominator);
  const index = Math.min(Math.max(rank, 1), ascending.length) - 1;
  return ascending[index] as number;
}

/**
 * Builds a distribution.
 *
 * Every sample must be a safe integer, and the exact sum must be a safe integer too. A dataset large
 * enough to overflow the sum is refused rather than reported with silently lost precision — which is
 * why the sum is accumulated as a `bigint` before being narrowed. The caller bounds the dataset, so
 * this is a backstop rather than an expected path, but a backstop that throws is the only kind that
 * cannot produce a confidently wrong statistic.
 */
export function distributionOf(samples: readonly number[]): Distribution | null {
  if (samples.length === 0) return null;

  let total = 0n;
  for (const sample of samples) {
    assertSafeInteger(sample, "a distribution sample");
    // Every statistic this package computes is a count, an attempt index, a whole millisecond or a
    // token count, so a negative sample means the caller measured the wrong thing. Refusing it here
    // keeps `mean` an exact non-negative ratio rather than requiring a signed fraction nothing needs.
    if (sample < 0) {
      throw new RangeError(
        `a distribution sample must not be negative, received ${String(sample)}`,
      );
    }
    total += BigInt(sample);
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`the sum of ${samples.length} sample(s) exceeds the safe integer range`);
  }

  const ascending = [...samples].sort((a, b) => a - b);
  const sum = Number(total);

  return {
    count: ascending.length,
    min: ascending[0] as number,
    max: ascending[ascending.length - 1] as number,
    sum,
    mean: ratio(sum, ascending.length),
    median: percentileOf(ascending, 50, 100),
    p50: percentileOf(ascending, 50, 100),
    p75: percentileOf(ascending, 75, 100),
    p90: percentileOf(ascending, 90, 100),
    p95: percentileOf(ascending, 95, 100),
    p99: percentileOf(ascending, 99, 100),
  };
}

/**
 * Applies a percentage margin to an integer bound, rounding up.
 *
 * Rounding up so a margin can never produce a bound tighter than the observation it was derived
 * from. `ceil(value × (100 + margin) / 100)` in integer arithmetic.
 */
export function withMargin(value: number, marginPercent: number): number {
  assertSafeInteger(value, "a budget value");
  assertSafeInteger(marginPercent, "a margin percentage");
  if (marginPercent < 0) {
    throw new RangeError(
      `a margin percentage must not be negative, received ${String(marginPercent)}`,
    );
  }
  const scaled = value * (100 + marginPercent);
  if (!Number.isSafeInteger(scaled)) {
    throw new RangeError("applying the margin exceeds the safe integer range");
  }
  return Math.ceil(scaled / 100);
}

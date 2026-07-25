import { createHash } from "node:crypto";

/**
 * Bounds and sanitisation for telemetry-derived text.
 *
 * Span names, service names, tool names, data domains and attribute keys all come from instrumented
 * code FlightRules does not own, and Phase 08 puts them into rule identifiers, selector values,
 * generated YAML and evidence summaries. So every one of them passes through here first.
 *
 * Nothing is silently dropped: a value that had to be truncated or rewritten is reported as changed,
 * and the caller decides. A sanitiser that quietly altered a selector would produce a contract that
 * looked correct and selected different spans.
 */

export const TEXT_LIMITS = {
  /** Matches the DSL's `maxStringLength`, so a sanitised value cannot fail validation on length. */
  maxValueLength: 1_024,
  /** Matches the DSL's `maxIdentifierLength`. */
  maxIdentifierLength: 128,
  /** Longest slug taken from a label before the stable suffix is appended. */
  maxSlugLength: 80,
  /** Highest number of families a mining run will materialise (PRD's route-explosion response). */
  maxRouteFamilies: 5_000,
  /** Highest number of distinct canonical labels a family's statistics will materialise. */
  maxLabelsPerFamily: 2_000,
  /** Highest number of traces one mining run will retrieve. */
  maxTraces: 5_000,
  /** Highest number of rules a proposal will emit, below the DSL's own 500. */
  maxProposedRules: 400,
} as const;

/**
 * True for a character that must never reach a contract document or an evidence file.
 *
 * C0 and C1 controls, the line and paragraph separators, the zero-width and bidirectional
 * formatting characters, and the byte-order mark. The bidirectional controls are the reason this is
 * not simply a control-character check: `U+202E` reorders the rendering of everything after it, so a
 * span name carrying one can make a generated rule read as something other than what it enforces.
 */
function isForbiddenCodePoint(code: number): boolean {
  if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  if (code === 0x2028 || code === 0x2029) return true;
  if (code >= 0x200b && code <= 0x200f) return true;
  if (code >= 0x202a && code <= 0x202e) return true;
  if (code >= 0x2066 && code <= 0x2069) return true;
  return code === 0xfeff;
}

export interface SanitisedText {
  readonly value: string;
  readonly changed: boolean;
}

/**
 * Normalises and bounds a telemetry-derived string.
 *
 * NFC first, so two spellings of the same label do not produce two families' worth of statistics for
 * one step; then forbidden code points removed; then bounded by **code points** rather than UTF-16
 * units, so a truncation cannot split a surrogate pair and produce a lone surrogate that no encoder
 * can represent.
 */
export function sanitiseText(
  value: string,
  maxLength: number = TEXT_LIMITS.maxValueLength,
): SanitisedText {
  const normalised = value.normalize("NFC");
  const kept: string[] = [];
  let changed = normalised !== value;

  for (const character of normalised) {
    const code = character.codePointAt(0) as number;
    if (isForbiddenCodePoint(code)) {
      changed = true;
      continue;
    }
    if (kept.length >= maxLength) {
      changed = true;
      break;
    }
    kept.push(character);
  }

  return { value: kept.join(""), changed };
}

/** The DSL's identifier grammar (`packages/contract-schema/src/validate.ts`). */
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]*$/;

export function isContractIdentifier(value: string): boolean {
  return (
    value.length > 0 && value.length <= TEXT_LIMITS.maxIdentifierLength && IDENTIFIER.test(value)
  );
}

/**
 * Derives a stable, valid rule identifier from a telemetry-derived label.
 *
 * The slug is lower-cased ASCII with every other character folded to `-`, which means two different
 * labels can slug to the same text — `payment.refund` and `payment_refund`, or two labels that differ
 * only outside ASCII. So the identifier always ends with eight hexadecimal characters of a digest of
 * the **original** label, which makes it unique per label and stable across mining runs without
 * depending on the order labels were encountered in.
 *
 * A label that slugs to nothing still yields a valid identifier, because the digest alone satisfies
 * the grammar.
 */
export function ruleIdentifier(prefix: string, label: string): string {
  const digest = createHash("sha256").update(label).digest("hex").slice(0, 8);

  const folded: string[] = [];
  for (const character of label.toLowerCase()) {
    const isDigit = character >= "0" && character <= "9";
    const isLetter = character >= "a" && character <= "z";
    folded.push(isDigit || isLetter ? character : "-");
  }

  const slug = folded
    .join("")
    .slice(0, TEXT_LIMITS.maxSlugLength)
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");

  const identifier = slug.length === 0 ? `${prefix}-${digest}` : `${prefix}-${slug}-${digest}`;
  // Bounded by construction: the prefix is a literal, the slug is capped at 80 and the digest is 8.
  return identifier.slice(0, TEXT_LIMITS.maxIdentifierLength);
}

/** Code-unit comparison, written out so nothing here can be read as locale-sensitive. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sorted unique strings, for every set-valued statistic. */
export function sortedUnique(values: Iterable<string>): readonly string[] {
  return [...new Set(values)].sort(compareStrings);
}

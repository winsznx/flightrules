/**
 * Identifier recognition.
 *
 * Span names and attribute values are external input. PRD section 18.1 names regular-expression
 * denial of service as a threat to address, so recognition here works on bounded tokens with
 * character-class scans rather than backtracking patterns over an unbounded string. Every
 * predicate below is O(token length) with no alternation and no nesting.
 */

const UUID_LENGTH = 36;
const UUID_HYPHEN_POSITIONS = [8, 13, 18, 23];
const UUID_SEGMENT_LENGTHS = [8, 4, 4, 4, 12];

function isHexDigit(character: string): boolean {
  return (
    (character >= "0" && character <= "9") ||
    (character >= "a" && character <= "f") ||
    (character >= "A" && character <= "F")
  );
}

/** Any 8-4-4-4-12 hex form, including the non-RFC variants SigNoz and Postgres both emit. */
export function isUuid(token: string): boolean {
  if (token.length !== UUID_LENGTH) return false;
  for (const position of UUID_HYPHEN_POSITIONS) {
    if (token[position] !== "-") return false;
  }
  let index = 0;
  for (const segmentLength of UUID_SEGMENT_LENGTHS) {
    for (let offset = 0; offset < segmentLength; offset += 1) {
      if (!isHexDigit(token[index] as string)) return false;
      index += 1;
    }
    index += 1; // skip the hyphen, or run past the end on the final segment
  }
  return true;
}

/** Crockford base32, excluding I, L, O and U. ULIDs are always 26 characters. */
const ULID_LENGTH = 26;
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function isUlid(token: string): boolean {
  if (token.length !== ULID_LENGTH) return false;
  const upper = token.toUpperCase();
  for (const character of upper) {
    if (!CROCKFORD_ALPHABET.includes(character)) return false;
  }
  // A ULID's first character encodes the high bits of a 48-bit timestamp and cannot exceed '7'.
  return (upper[0] as string) <= "7";
}

/**
 * A long run of hex digits: trace IDs, span IDs, content hashes and the demo's `rfnd_<hex>`
 * suffixes. Sixteen is the shortest span ID SigNoz emits, so shorter runs are left alone to avoid
 * rewriting genuine names such as `v1beta`.
 */
const MIN_HEX_IDENTIFIER_LENGTH = 16;

export function isLongHex(token: string): boolean {
  if (token.length < MIN_HEX_IDENTIFIER_LENGTH) return false;
  for (const character of token) {
    if (!isHexDigit(character)) return false;
  }
  return true;
}

export function isAllDigits(token: string): boolean {
  if (token.length === 0) return false;
  for (const character of token) {
    if (character < "0" || character > "9") return false;
  }
  return true;
}

/**
 * Splits a value into tokens and the separators between them, so a rewritten token can be put
 * back exactly where it was. Splitting on a fixed separator set is what keeps this linear.
 *
 * `-` and `_` are deliberately **not** separators. They are the internal punctuation of the very
 * identifiers this module recognises: splitting on them would break `6ba7b810-9dad-11d1-...` into
 * five tokens that are individually unrecognisable, and would separate `run_` from the suffix it
 * prefixes. Only characters that genuinely delimit one field from the next belong here.
 */
const SEPARATORS = new Set(["/", ".", ":", " ", "=", "?", "&", "#", ",", ";", "@"]);

export interface Tokenised {
  readonly tokens: readonly string[];
  /** `separators[i]` is the character that followed `tokens[i]`, or "" at the end. */
  readonly separators: readonly string[];
}

export function tokenise(value: string): Tokenised {
  const tokens: string[] = [];
  const separators: string[] = [];
  let current = "";

  for (const character of value) {
    if (SEPARATORS.has(character)) {
      tokens.push(current);
      separators.push(character);
      current = "";
    } else {
      current += character;
    }
  }
  tokens.push(current);
  separators.push("");

  return { tokens, separators };
}

export function detokenise(parts: Tokenised): string {
  let result = "";
  for (let index = 0; index < parts.tokens.length; index += 1) {
    result += parts.tokens[index] ?? "";
    result += parts.separators[index] ?? "";
  }
  return result;
}

/**
 * Rewrites a compound token such as `run_01JAB...` or `customer-4f92c1` where a configured
 * prefix is followed by a volatile suffix. The prefix is preserved because it is the part that
 * carries meaning; only the suffix is replaced.
 */
export function splitPrefixedIdentifier(
  token: string,
  prefixes: readonly string[],
): { readonly prefix: string; readonly suffix: string } | undefined {
  for (const prefix of prefixes) {
    if (token.length <= prefix.length) continue;
    if (!token.startsWith(prefix)) continue;
    return { prefix, suffix: token.slice(prefix.length) };
  }
  return undefined;
}

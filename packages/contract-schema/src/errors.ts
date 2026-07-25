/**
 * Structured validation failures.
 *
 * Every failure names the exact path it concerns and a stable machine-readable code. A validator
 * that only returns prose forces the caller to parse English to decide whether to retry, and makes
 * a rejection test assert on wording rather than on behaviour.
 */

export const VALIDATION_CODES = [
  "SOURCE_EMPTY",
  "SOURCE_TOO_LARGE",
  "SOURCE_TOO_MANY_LINES",
  "YAML_MALFORMED",
  "YAML_MULTIPLE_DOCUMENTS",
  "YAML_ALIAS_FORBIDDEN",
  "YAML_ANCHOR_FORBIDDEN",
  "YAML_TAG_FORBIDDEN",
  "YAML_TOO_DEEP",
  "YAML_DUPLICATE_KEY",
  "UNSUPPORTED_VALUE_TYPE",
  "UNKNOWN_API_VERSION",
  "UNKNOWN_KIND",
  "UNKNOWN_FIELD",
  "UNKNOWN_RULE_TYPE",
  "REQUIRED",
  "INVALID_TYPE",
  "INVALID_ENUM",
  "INVALID_FORMAT",
  "INVALID_IDENTIFIER",
  "INVALID_RANGE",
  "INVALID_NUMBER",
  "STRING_TOO_LONG",
  "LIST_EMPTY",
  "LIST_TOO_LONG",
  "TOO_MANY_RULES",
  "DUPLICATE_RULE_ID",
  "DUPLICATE_VALUE",
  "EMPTY_SELECTOR",
  "CONTRADICTORY_RULES",
  "UNKNOWN_ROUTE_REFERENCE",
  "UNKNOWN_RULE_REFERENCE",
  "INVALID_PATTERN",
] as const;

export type ValidationCode = (typeof VALIDATION_CODES)[number];

export interface ValidationError {
  /**
   * Dotted path with bracketed indices, e.g. `spec.rules[3].cardinality.max`. Rooted at the
   * document, so it reads the same as the YAML the author wrote.
   */
  readonly path: string;
  readonly code: ValidationCode;
  readonly message: string;
}

/**
 * Accumulates errors instead of throwing on the first one.
 *
 * A contract with four mistakes should report four, not force four validate-and-fix cycles. The
 * path builder is immutable so a nested visitor cannot corrupt its caller's position.
 */
export class ErrorBag {
  readonly #errors: ValidationError[] = [];

  add(path: string, code: ValidationCode, message: string): void {
    this.#errors.push({ path, code, message });
  }

  get empty(): boolean {
    return this.#errors.length === 0;
  }

  /**
   * Sorted by path, then code, then message.
   *
   * Two validations of the same document must produce byte-identical error lists, and the order
   * errors happen to be discovered in depends on traversal details a caller should not see.
   */
  toList(): readonly ValidationError[] {
    return [...this.#errors].sort((a, b) => {
      if (a.path !== b.path) return a.path < b.path ? -1 : 1;
      if (a.code !== b.code) return a.code < b.code ? -1 : 1;
      return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
    });
  }
}

export function childPath(parent: string, key: string): string {
  return parent.length === 0 ? key : `${parent}.${key}`;
}

export function indexPath(parent: string, index: number): string {
  return `${parent}[${index}]`;
}

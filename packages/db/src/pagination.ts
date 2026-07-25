import { FlightRulesError } from "@flightrules/domain";

/**
 * Cursor pagination over the UUIDv7 primary key.
 *
 * The key is unique and time-ordered to one microsecond (migration 0002), so ordering by it alone
 * is total: no two rows tie, no page can repeat a row, and a row inserted between two requests
 * appears on the newest page rather than shifting every later page by one — which is exactly the
 * failure offset pagination has and the reason PRD section 15 asks for cursors.
 *
 * The cursor is opaque on purpose. It carries a version tag so a future change to the ordering key
 * rejects old cursors instead of quietly paginating by the wrong column.
 */

const CURSOR_VERSION = "v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const PAGE_SIZE = { default: 25, max: 100 } as const;

export interface PageRequest {
  readonly limit: number;
  /** The id every returned row must sort after (ascending) or before (descending). */
  readonly after: string | null;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export function encodeCursor(id: string): string {
  return Buffer.from(`${CURSOR_VERSION}:${id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const separator = decoded.indexOf(":");
  const version = separator === -1 ? "" : decoded.slice(0, separator);
  const id = separator === -1 ? "" : decoded.slice(separator + 1);
  if (version !== CURSOR_VERSION || !UUID_PATTERN.test(id)) {
    throw new FlightRulesError("CONFIG_INVALID", {
      message: "The pagination cursor is not valid. Start from the first page.",
    });
  }
  return id;
}

export function toPageRequest(input: {
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}): PageRequest {
  const requested = input.limit ?? PAGE_SIZE.default;
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > PAGE_SIZE.max) {
    throw new FlightRulesError("CONFIG_INVALID", {
      message: `A page size must be an integer between 1 and ${PAGE_SIZE.max}.`,
      details: { maximum: PAGE_SIZE.max },
    });
  }
  return {
    limit: requested,
    after: input.cursor === undefined ? null : decodeCursor(input.cursor),
  };
}

/**
 * Turns one over-fetched row into the next cursor.
 *
 * The query asks for `limit + 1` rows. The extra row is proof that another page exists, which is
 * the only signal that cannot be wrong: a page that happens to be exactly full is not evidence of
 * more rows, and treating it as such produces an empty final page on every list in the product.
 */
export function toPage<T extends { readonly id: string }>(
  rows: readonly T[],
  request: PageRequest,
): Page<T> {
  if (rows.length <= request.limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, request.limit);
  const last = items.at(-1);
  return { items, nextCursor: last ? encodeCursor(last.id) : null };
}

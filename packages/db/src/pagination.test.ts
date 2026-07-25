import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, PAGE_SIZE, toPage, toPageRequest } from "./pagination.js";

const ID_A = "019f9a62-2e4d-72bf-a9b4-230c05288f71";
const ID_B = "019f9a62-2e4d-72bf-a9b4-230c05288f72";

describe("cursor pagination", () => {
  it("round-trips an identifier", () => {
    expect(decodeCursor(encodeCursor(ID_A))).toBe(ID_A);
  });

  it("rejects a cursor that is not a FlightRules cursor", () => {
    // #given a caller-supplied string that decodes to something else
    const foreign = Buffer.from("v1:not-a-uuid", "utf8").toString("base64url");
    expect(() => decodeCursor(foreign)).toThrow(/not valid/);
    expect(() => decodeCursor("////")).toThrow(/not valid/);
  });

  it("rejects a cursor issued under a different ordering key", () => {
    const older = Buffer.from(`v0:${ID_A}`, "utf8").toString("base64url");
    expect(() => decodeCursor(older)).toThrow(/not valid/);
  });

  it("caps the page size", () => {
    expect(toPageRequest({}).limit).toBe(PAGE_SIZE.default);
    expect(toPageRequest({ limit: PAGE_SIZE.max }).limit).toBe(PAGE_SIZE.max);
    expect(() => toPageRequest({ limit: PAGE_SIZE.max + 1 })).toThrow(/page size/);
    expect(() => toPageRequest({ limit: 0 })).toThrow(/page size/);
    expect(() => toPageRequest({ limit: 1.5 })).toThrow(/page size/);
  });

  it("issues a next cursor only when an extra row proves another page exists", () => {
    // #given a query that asked for limit + 1 rows and got exactly limit back
    const exact = toPage([{ id: ID_A }, { id: ID_B }], { limit: 2, after: null });
    // #then there is no next page, because a full page is not evidence of more rows
    expect(exact.nextCursor).toBeNull();
    expect(exact.items).toHaveLength(2);

    // #given the over-fetched row came back
    const more = toPage([{ id: ID_A }, { id: ID_B }, { id: ID_B }], { limit: 2, after: null });
    // #then the extra row is dropped and the cursor points at the last returned row
    expect(more.items).toHaveLength(2);
    expect(more.nextCursor).toBe(encodeCursor(ID_B));
  });
});

import { describe, expect, it } from "vitest";
import { downloadNameSegment } from "./download-name";

/**
 * The suggested filename of a download (PRD Phase 16 task 12).
 *
 * The evidence bundle names itself after the release key, which the deploying system chooses and the
 * API accepts as any string of up to 200 characters. That value is interpolated into a
 * `content-disposition` header, so every character it can contain has to be accounted for here
 * rather than at the header.
 */

describe("a hostile release key cannot escape the content-disposition filename", () => {
  it("closes no quoted parameter", () => {
    // #given a key that would close `filename="…"` and append its own parameters
    const segment = downloadNameSegment('v2"; filename="owned.exe');

    // #then the quotes and the semicolon are gone
    expect(segment).not.toContain('"');
    expect(segment).not.toContain(";");
  });

  it("injects no header", () => {
    // #given a key carrying CRLF, which `undici` would reject by throwing
    const segment = downloadNameSegment("v2\r\nSet-Cookie: a=b");

    expect(segment).not.toContain("\r");
    expect(segment).not.toContain("\n");
  });

  it("traverses no path", () => {
    for (const hostile of ["../../../../etc/passwd", "..\\..\\windows\\system32", "/etc/shadow"]) {
      const segment = downloadNameSegment(hostile);
      expect(segment).not.toContain("/");
      expect(segment).not.toContain("\\");
      expect(segment.startsWith(".")).toBe(false);
    }
  });

  it("produces no hidden file and no name a shell reads as an option", () => {
    expect(downloadNameSegment(".bashrc").startsWith(".")).toBe(false);
    expect(downloadNameSegment("--version").startsWith("-")).toBe(false);
  });

  it("emits no control character", () => {
    const segment = downloadNameSegment(
      `v2${String.fromCharCode(0x1b)}[2Jx${String.fromCharCode(0)}`,
    );
    for (const character of segment) {
      expect((character.codePointAt(0) ?? 0) >= 0x20).toBe(true);
    }
  });

  it("bounds a very long key", () => {
    expect(downloadNameSegment("v".repeat(5_000)).length).toBeLessThanOrEqual(64);
  });

  it("falls back rather than producing an empty filename", () => {
    expect(downloadNameSegment("///")).toBe("release");
    expect(downloadNameSegment("")).toBe("release");
    // A key of nothing but Unicode confusables reduces to nothing, and must still name a file.
    expect(downloadNameSegment("𝖋𝖑𝖎𝖌𝖍𝖙")).toBe("release");
  });

  it("leaves an ordinary release key untouched", () => {
    expect(downloadNameSegment("refund-agent-v2")).toBe("refund-agent-v2");
    expect(downloadNameSegment("2026.07.26_build.1")).toBe("2026.07.26_build.1");
  });
});

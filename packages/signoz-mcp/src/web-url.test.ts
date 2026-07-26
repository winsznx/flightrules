import { describe, expect, it } from "vitest";
import { rehomeSignozUrl, signozTraceUrl, traceLink } from "./web-url.js";

/**
 * Every assertion here is anchored to a fact observed against the pinned SigNoz deployment, not to a
 * documented convention (SL-061). The `/trace/<id>` path and the internal-hostname origin are both
 * verbatim from what `signoz_get_trace_details` actually returned.
 */

const TRACE = "010b8d74e8ba968c4a8a194679ab7fb7";
/** Verbatim from the live MCP response. Note the host: a container name, not a reachable address. */
const RETURNED = `http://signoz-signoz-0:8080/trace/${TRACE}`;

describe("signozTraceUrl", () => {
  it("uses the path SigNoz's own webUrl uses", () => {
    // #then the constructed link and the one SigNoz returned differ only in origin
    expect(signozTraceUrl("http://localhost:8080", TRACE)).toBe(
      `http://localhost:8080/trace/${TRACE}`,
    );
    expect(new URL(RETURNED).pathname).toBe(`/trace/${TRACE}`);
  });

  it("tolerates a trailing slash on the configured base", () => {
    expect(signozTraceUrl("http://localhost:8080/", TRACE)).toBe(
      `http://localhost:8080/trace/${TRACE}`,
    );
  });

  it("refuses a trace identifier that is not one", () => {
    for (const value of ["", "not-a-trace", `${TRACE}extra`, TRACE.toUpperCase(), "../../admin"]) {
      expect(signozTraceUrl("http://localhost:8080", value)).toBeNull();
    }
  });

  it("refuses a base that is not an http origin", () => {
    // #then a hostile configuration value cannot become a `javascript:` anchor href
    for (const base of ["", "   ", "javascript:alert(1)", "data:text/html,x", "not a url"]) {
      expect(signozTraceUrl(base, TRACE)).toBeNull();
    }
  });
});

describe("rehomeSignozUrl", () => {
  it("keeps SigNoz's path and replaces the unreachable container host", () => {
    // #given the URL the live MCP returned, whose host no browser can resolve
    // #then the path survives and the origin becomes the operator's
    expect(rehomeSignozUrl("http://localhost:8080", RETURNED)).toBe(
      `http://localhost:8080/trace/${TRACE}`,
    );
  });

  it("preserves a query string, which only SigNoz knows the meaning of", () => {
    expect(
      rehomeSignozUrl("https://signoz.example.com", "http://signoz-signoz-0:8080/alerts?ruleId=7"),
    ).toBe("https://signoz.example.com/alerts?ruleId=7");
  });

  it("discards a stored value that is not a URL", () => {
    expect(rehomeSignozUrl("http://localhost:8080", "not a url")).toBeNull();
    expect(rehomeSignozUrl("http://localhost:8080", "javascript:alert(1)")).toBeNull();
    expect(rehomeSignozUrl("http://localhost:8080", null)).toBeNull();
  });
});

describe("traceLink", () => {
  it("prefers SigNoz's own path when there is one", () => {
    expect(traceLink("http://localhost:8080", TRACE, RETURNED)).toBe(
      `http://localhost:8080/trace/${TRACE}`,
    );
  });

  it("falls back to the verified path when the builder query returned none", () => {
    // #given the evaluator's path: `signoz_execute_builder_query` returns no webUrl at all (SL-061)
    expect(traceLink("http://localhost:8080", TRACE, null)).toBe(
      `http://localhost:8080/trace/${TRACE}`,
    );
  });

  it("returns null rather than a relative link when nothing is configured", () => {
    // #then an unconfigured deployment shows "no link" instead of a link to FlightRules itself
    expect(traceLink("", TRACE, null)).toBeNull();
  });
});

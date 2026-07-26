/**
 * Browser-reachable SigNoz links (PRD FR-017, PRD section 8.11, PRD Phase 14 task 7).
 *
 * PRD Phase 14 is explicit: "Generate links from verified identifiers. Do not build links from
 * guessed URL patterns without runtime verification." Both halves of the link below were verified
 * against the pinned deployment rather than recalled, and the verification found two things worth
 * recording (SL-061):
 *
 * 1. **`signoz_get_trace_details` returns a `webUrl`**, and its path is `/trace/<traceId>`. That is
 *    where the path here comes from — SigNoz's own answer, not a documented convention.
 * 2. **`signoz_execute_builder_query` returns no `webUrl` at all.** FlightRules must use the builder
 *    query to read custom span attributes (SL-020, SL-021), so the evaluator never receives a link
 *    for the traces it evaluates, and every `trace_runs.signoz_web_url` written by that path is
 *    null. A link therefore has to be constructed.
 * 3. **The host in the returned `webUrl` is SigNoz's internal container name**
 *    (`signoz-signoz-0:8080`), which no browser outside the Compose network can resolve. Even the
 *    link SigNoz supplies has to have its origin replaced by the address the operator configured.
 *
 * So the rule this module implements is: **the path is SigNoz's, the origin is the operator's.**
 * A stored `webUrl` is preferred for its path and re-homed onto the configured base; when there is
 * none, the verified `/trace/<id>` path is used. Nothing is invented, and a caller that supplies no
 * base URL gets `null` rather than a relative link that would resolve against FlightRules' own host.
 */

/** SigNoz trace identifiers are 32 lowercase hex characters. Anything else is not linked. */
const TRACE_ID = /^[0-9a-f]{32}$/;

/** Strips trailing slashes so the join below cannot produce a double slash. */
function origin(baseUrl: string): string | null {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) return null;
  try {
    const parsed = new URL(trimmed);
    // Only ever http or https. A `javascript:` or `data:` base would otherwise become an anchor
    // href, which is a cross-site scripting vector rather than a broken link.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * A browser-reachable link to one trace.
 *
 * Returns `null` for a trace identifier that is not one, so a hostile or truncated value becomes an
 * absent link rather than a link somewhere unexpected.
 */
export function signozTraceUrl(baseUrl: string, traceId: string): string | null {
  const base = origin(baseUrl);
  if (base === null || !TRACE_ID.test(traceId)) return null;
  return `${base}/trace/${traceId}`;
}

/**
 * Re-homes a `webUrl` SigNoz returned onto the configured, browser-reachable base.
 *
 * Keeps SigNoz's own path and query — which is the part only SigNoz knows — and replaces the origin,
 * which is the part only the operator knows. A stored value that is not a URL at all is discarded
 * rather than passed through.
 */
export function rehomeSignozUrl(baseUrl: string, storedUrl: string | null): string | null {
  const base = origin(baseUrl);
  if (base === null || storedUrl === null) return null;
  try {
    const stored = new URL(storedUrl);
    if (stored.protocol !== "http:" && stored.protocol !== "https:") return null;
    return `${base}${stored.pathname}${stored.search}`;
  } catch {
    return null;
  }
}

/**
 * The link to use for a trace: SigNoz's own path when it gave one, the verified path otherwise.
 *
 * This is the function every product surface should call, so there is exactly one answer to "where
 * does this trace live" and it is the same one on the Release Diff, the Violation Inspector and in
 * an exported evidence bundle.
 */
export function traceLink(
  baseUrl: string,
  traceId: string,
  storedUrl: string | null = null,
): string | null {
  return rehomeSignozUrl(baseUrl, storedUrl) ?? signozTraceUrl(baseUrl, traceId);
}

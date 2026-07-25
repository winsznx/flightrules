/**
 * Extraction of machine-readable payloads from MCP content entries.
 *
 * The pinned SigNoz MCP Server (v0.9.0) returns its payload three different ways depending on the
 * tool and the outcome, and the declared `outputSchema` does not predict which: 36 of its 41 tools
 * declare no output schema, yet most of them still return `structuredContent`, while
 * `signoz_execute_builder_query` — the tool the whole trace-evidence path depends on — returns
 * text only. So extraction is unconditional and ordered, never inferred from discovery metadata.
 *
 * A response may also carry several content entries where only one is the payload. The server
 * appends an advisory entry beginning `[Decisions applied]` whenever it substitutes a default the
 * request omitted. Joining entries before parsing corrupts the JSON, so every entry is parsed on
 * its own and the ones that are not JSON are surfaced as notices rather than discarded.
 */

/** A single candidate payload lifted out of a response, in the order it should be tried. */
export interface PayloadCandidate {
  readonly origin: "structuredContent" | "content";
  readonly index: number;
  readonly value: unknown;
}

export interface ExtractionResult {
  readonly candidates: readonly PayloadCandidate[];
  /** Text entries that are not JSON. Server advisories arrive this way. */
  readonly proseEntries: readonly string[];
  /** True when the response carried no content entries and no structured content at all. */
  readonly empty: boolean;
  /** Content entries of a type this client does not read, such as images. */
  readonly skippedEntryTypes: readonly string[];
}

const FENCE = "```";

/**
 * Removes a Markdown code fence by line structure rather than by matching a pattern across the
 * whole body. A regular expression spanning an unbounded payload is a denial-of-service surface
 * (PRD section 18.1), and the body here can be tens of thousands of characters.
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith(FENCE)) return text;

  const lines = trimmed.split("\n");
  if (lines.length < 2) return text;

  let last = lines.length - 1;
  while (last > 0 && lines[last]?.trim() !== FENCE) last -= 1;
  if (last === 0) return text;

  return lines.slice(1, last).join("\n");
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const body = stripCodeFence(text).trim();
  if (body.length === 0) return { ok: false };

  // JSON.parse accepts bare scalars. Only an object or an array can be a SigNoz payload, and
  // checking the first character before parsing keeps prose out of the candidate list cheaply.
  const first = body[0];
  if (first !== "{" && first !== "[") return { ok: false };

  try {
    return { ok: true, value: JSON.parse(body) };
  } catch {
    return { ok: false };
  }
}

interface ContentEntryLike {
  readonly type?: unknown;
  readonly text?: unknown;
}

/**
 * Lifts every usable payload out of a tool result. `structuredContent` is tried first because
 * when the server supplies it, it is the server's own parse of the same bytes. Content entries
 * follow in order, so a caller that validates each candidate in turn gets the first one that
 * matches its schema regardless of which entry the payload landed in.
 */
export function extractPayloads(raw: {
  readonly structuredContent?: unknown;
  readonly content?: unknown;
}): ExtractionResult {
  const candidates: PayloadCandidate[] = [];
  const proseEntries: string[] = [];
  const skippedEntryTypes: string[] = [];

  const structured = raw.structuredContent;
  if (structured !== undefined && structured !== null && typeof structured === "object") {
    candidates.push({ origin: "structuredContent", index: 0, value: structured });
  }

  const content = Array.isArray(raw.content) ? (raw.content as ContentEntryLike[]) : [];
  content.forEach((entry, index) => {
    if (entry === null || typeof entry !== "object") {
      skippedEntryTypes.push(typeof entry);
      return;
    }
    if (entry.type !== "text" || typeof entry.text !== "string") {
      skippedEntryTypes.push(typeof entry.type === "string" ? entry.type : "unknown");
      return;
    }

    const parsed = parseJson(entry.text);
    if (parsed.ok) {
      candidates.push({ origin: "content", index, value: parsed.value });
    } else if (entry.text.trim().length > 0) {
      proseEntries.push(entry.text);
    }
  });

  return {
    candidates,
    proseEntries,
    empty: candidates.length === 0 && proseEntries.length === 0 && skippedEntryTypes.length === 0,
    skippedEntryTypes,
  };
}

import { ERROR_CODES } from "@flightrules/domain";
import { describe, expect, it } from "vitest";
import {
  EXIT_CODE_DESCRIPTIONS,
  EXIT_CODES,
  exitCodeForDecision,
  exitCodeForError,
} from "./exit-codes.js";
import { RELEASE_DECISIONS } from "./release.js";

/**
 * The exit-code contract of PRD FR-012.
 *
 * These numbers are the product's interface with every CI system that will ever run it, so they are
 * asserted as literals rather than derived from the table under test. A test that read the value it
 * is checking from the same constant would pass after someone changed the constant.
 */

describe("exit codes", () => {
  it("pins the PRD's table as literal numbers", () => {
    // #then the five documented codes are exactly the PRD's
    expect(EXIT_CODES.pass).toBe(0);
    expect(EXIT_CODES.contractViolation).toBe(2);
    expect(EXIT_CODES.insufficientData).toBe(3);
    expect(EXIT_CODES.integrationError).toBe(4);
    expect(EXIT_CODES.invalidConfiguration).toBe(5);
  });

  it("maps every release decision to exactly one code", () => {
    // #given the four decisions the aggregation can produce
    const mapped = RELEASE_DECISIONS.map((decision) => [decision, exitCodeForDecision(decision)]);

    // #then each maps to the PRD's number
    expect(mapped).toEqual([
      ["pass", 0],
      ["fail", 2],
      ["insufficient_data", 3],
      ["error", 4],
    ]);
  });

  it("returns 0 only for a pass", () => {
    // #then no decision other than `pass` can produce a zero exit
    for (const decision of RELEASE_DECISIONS) {
      if (decision === "pass") continue;
      expect(exitCodeForDecision(decision)).not.toBe(0);
    }
  });

  it("never maps an error code to a pass", () => {
    // #given every declared error code
    // #then none of them exits 0, whatever it is
    for (const code of ERROR_CODES) {
      expect(exitCodeForError(code)).not.toBe(0);
    }
  });

  it("maps a configuration failure to 5 and a dependency failure to 4", () => {
    // #then an operator-fixable input problem is distinguishable from an unavailable dependency
    expect(exitCodeForError("CONFIG_INVALID")).toBe(5);
    expect(exitCodeForError("CONTRACT_INVALID")).toBe(5);
    expect(exitCodeForError("VALIDATION_FAILED")).toBe(5);
    expect(exitCodeForError("NOT_FOUND")).toBe(5);
    expect(exitCodeForError("SIGNOZ_UNREACHABLE")).toBe(4);
    expect(exitCodeForError("MCP_UNAVAILABLE")).toBe(4);
    expect(exitCodeForError("TRACE_FETCH_FAILED")).toBe(4);
    expect(exitCodeForError("EVALUATION_FAILED")).toBe(4);
  });

  it("maps incomplete evidence to 3", () => {
    // #then "we do not know yet" is its own code, never a pass and never a violation
    expect(exitCodeForError("RELEASE_INSUFFICIENT_DATA")).toBe(3);
    expect(exitCodeForError("BASELINE_INSUFFICIENT_RUNS")).toBe(3);
  });

  it("maps an unrecognised value to an integration error rather than a pass", () => {
    // #given something that is not an error code at all
    // #then the default is 4; an unknown failure is still a failure
    expect(exitCodeForError("NOT_A_CODE")).toBe(4);
    expect(exitCodeForError(undefined)).toBe(4);
    expect(exitCodeForError(null)).toBe(4);
    expect(exitCodeForError(0)).toBe(4);
  });

  it("documents every code it can return", () => {
    // #then `--help` and the runbook can render the table without a missing entry
    for (const code of Object.values(EXIT_CODES)) {
      expect(EXIT_CODE_DESCRIPTIONS[code]).toBeTypeOf("string");
      expect(EXIT_CODE_DESCRIPTIONS[code].length).toBeGreaterThan(0);
    }
  });

  it("reserves 1 for an unclassified crash", () => {
    // #then no classified path returns it
    const classified = [
      ...RELEASE_DECISIONS.map(exitCodeForDecision),
      ...ERROR_CODES.map(exitCodeForError),
    ];
    expect(classified).not.toContain(1);
  });
});

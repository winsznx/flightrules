import { FlightRulesError } from "@flightrules/domain";
import { contractContentHash } from "./canonical.js";
import { ErrorBag, type ValidationError } from "./errors.js";
import type { TrajectoryContract } from "./types.js";
import { validateContractValue } from "./validate.js";
import { loadContractDocument } from "./yaml.js";

/**
 * The single entry point for turning contract source into a validated contract.
 *
 * The result is a discriminated union rather than a throw. An invalid contract is the expected
 * answer to "is this contract valid" — the CLI must print every error and exit 5, the API must
 * return them as a field list, and Contract Studio must show them next to the editor. Throwing
 * would force all three to reconstruct the same list from an exception.
 */

export interface ParsedContract {
  readonly contract: TrajectoryContract;
  /** SHA-256 of the canonical form, matching PRD section 14.9's `content_hash`. */
  readonly contentHash: string;
  /** The document exactly as supplied, for PRD section 14.9's `yaml_text`. */
  readonly source: string;
}

export type ParseResult =
  | { readonly ok: true; readonly value: ParsedContract }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

export function parseContract(source: string): ParseResult {
  const bag = new ErrorBag();

  const loaded = loadContractDocument(source, bag);
  if (!loaded.ok) return { ok: false, errors: loaded.errors };

  const validated = validateContractValue(loaded.value, bag);
  if (!validated.ok) return { ok: false, errors: validated.errors };

  return {
    ok: true,
    value: {
      contract: validated.contract,
      contentHash: contractContentHash(validated.contract),
      source,
    },
  };
}

/**
 * Parses or throws `CONTRACT_INVALID`.
 *
 * For callers that already hold a contract they believe valid — the evaluator loading an activated
 * contract from the database, for instance — where an invalid document means the system is broken
 * rather than the user made a mistake. The errors travel in `details` so they are not lost.
 */
export function parseContractOrThrow(source: string): ParsedContract {
  const result = parseContract(source);
  if (result.ok) return result.value;
  throw new FlightRulesError("CONTRACT_INVALID", {
    details: { errorCount: result.errors.length, errors: result.errors },
  });
}

/** Renders errors as one line each, for a CLI or a log. Never includes the document itself. */
export function formatValidationErrors(errors: readonly ValidationError[]): string {
  return errors.map((error) => `${error.path}: ${error.code}: ${error.message}`).join("\n");
}

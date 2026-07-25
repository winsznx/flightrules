import { readFileSync } from "node:fs";
import { canonicalContractJson, contractContentHash } from "./canonical.js";
import { formatValidationErrors, parseContract } from "./parse.js";
import { readContractJsonSchema } from "./schema.js";

/**
 * The contract command's logic, separated from the process it runs in.
 *
 * Output streams and the file reader are injected, so exit codes and messages are testable without
 * spawning a subprocess or depending on a build having happened. `cli.ts` is the thin wrapper that
 * supplies the real ones.
 */

export const CLI_EXIT = {
  /** PRD FR-012. A contract that fails validation is invalid *configuration*, not a violation. */
  ok: 0,
  error: 4,
  invalidConfiguration: 5,
} as const;

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly readFile: (path: string) => string;
}

export const USAGE = `flightrules-contract <command> [options]

Commands:
  validate <path>   Validate a contract document. Exit 0 when valid, 5 when not.
  hash <path>       Print the SHA-256 content hash of a valid contract.
  canonical <path>  Print the canonical JSON of a valid contract.
  schema            Print the published JSON Schema.

Options:
  --json            Emit machine-readable JSON instead of text.
`;

export function defaultCliIo(): CliIo {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readFile: (path) => readFileSync(path, "utf8"),
  };
}

export function runContractCli(argv: readonly string[], io: CliIo): number {
  const json = argv.includes("--json");
  const args = argv.filter((argument) => argument !== "--json");
  const command = args[0];

  try {
    switch (command) {
      case "validate":
        return validate(requirePath(args[1]), io, json);
      case "hash":
        return withContract(requirePath(args[1]), io, (contract) => {
          io.stdout(`${contractContentHash(contract)}\n`);
        });
      case "canonical":
        return withContract(requirePath(args[1]), io, (contract) => {
          io.stdout(`${canonicalContractJson(contract)}\n`);
        });
      case "schema":
        io.stdout(`${JSON.stringify(readContractJsonSchema(), null, 2)}\n`);
        return CLI_EXIT.ok;
      default:
        io.stderr(USAGE);
        return CLI_EXIT.invalidConfiguration;
    }
  } catch (error: unknown) {
    // A missing or unreadable file is an integration failure, not an invalid contract: the document
    // was never seen, so nothing can be said about its validity.
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return CLI_EXIT.error;
  }
}

function requirePath(value: string | undefined): string {
  if (value === undefined || value.length === 0) throw new Error("A contract path is required.");
  return value;
}

function validate(filePath: string, io: CliIo, json: boolean): number {
  const result = parseContract(io.readFile(filePath));

  if (result.ok) {
    io.stdout(
      json
        ? `${JSON.stringify({
            valid: true,
            path: filePath,
            contentHash: result.value.contentHash,
            ruleCount: result.value.contract.spec.rules.length,
          })}\n`
        : `${filePath}: valid. ${result.value.contract.spec.rules.length} rule(s), content hash ${result.value.contentHash}.\n`,
    );
    return CLI_EXIT.ok;
  }

  io.stderr(
    json
      ? `${JSON.stringify({ valid: false, path: filePath, errors: result.errors })}\n`
      : `${filePath}: invalid. ${result.errors.length} error(s).\n${formatValidationErrors(result.errors)}\n`,
  );
  return CLI_EXIT.invalidConfiguration;
}

function withContract(
  filePath: string,
  io: CliIo,
  emit: (contract: Parameters<typeof contractContentHash>[0]) => void,
): number {
  const result = parseContract(io.readFile(filePath));
  if (!result.ok) {
    io.stderr(`${formatValidationErrors(result.errors)}\n`);
    return CLI_EXIT.invalidConfiguration;
  }
  emit(result.value.contract);
  return CLI_EXIT.ok;
}

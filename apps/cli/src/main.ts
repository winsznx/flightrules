import { EXIT_CODES, type ExitCode, exitCodeForError } from "@flightrules/contract-engine";
import { FlightRulesError } from "@flightrules/domain";
import { type CommandName, type ParsedCommand, parseArgs } from "./args.js";
import { ApiClient } from "./client.js";
import {
  baselineCapture,
  type CommandContext,
  type CommandOutcome,
  configVerify,
  contractValidate,
  evidenceExport,
  gateCheck,
  releaseEvaluate,
} from "./commands.js";
import { type Io, terminalSafe, USAGE, writeJson } from "./output.js";

/**
 * The CLI's single entry point.
 *
 * `run` returns an exit code rather than calling `process.exit`, so every path — including the
 * error paths that matter most — is exercised by a unit test with a fake `Io` rather than by
 * spawning a shell and hoping.
 *
 * PRD section 20.1: "the release gate never returns pass after an internal error." That is enforced
 * here, once, for every command: the only way to reach `0` is for a handler to return it, and any
 * thrown value becomes `exitCodeForError`, whose default is `4`. There is no catch-all that
 * swallows a failure into a success.
 */

export const CLI_VERSION = "0.1.0";

const HANDLERS: Readonly<
  Record<CommandName, (context: CommandContext) => Promise<CommandOutcome>>
> = {
  "config verify": configVerify,
  "contract validate": contractValidate,
  "baseline capture": baselineCapture,
  "release evaluate": releaseEvaluate,
  "gate check": gateCheck,
  "evidence export": evidenceExport,
};

export async function run(argv: readonly string[], rawIo: Io): Promise<ExitCode> {
  // Wrapped once, here, so every line any command writes is filtered. A span name, a tool name or a
  // rule summary arriving from telemetry reaches the human report, and a terminal treats an escape
  // sequence inside one as an instruction (PRD Phase 16 task 12).
  const io = terminalSafe(rawIo);
  let parsed: ParsedCommand;

  try {
    const result = parseArgs(argv, io.env);
    if (result.kind === "version") {
      io.stdout(`${CLI_VERSION}\n`);
      return EXIT_CODES.pass;
    }
    if (result.kind === "help") {
      io.stdout(USAGE);
      return EXIT_CODES.pass;
    }
    parsed = result.parsed;
  } catch (error) {
    // Argument errors happen before `--json` is known, so they are reported on stderr in the plain
    // form. A malformed invocation is a configuration error and exits 5.
    return fail(io, null, false, error);
  }

  const client = new ApiClient({
    baseUrl: parsed.global.apiUrl,
    fetch: io.fetch,
    timeoutSeconds: parsed.global.timeoutSeconds,
    ...(io.env["FLIGHTRULES_REQUEST_ID"] === undefined
      ? {}
      : { requestId: io.env["FLIGHTRULES_REQUEST_ID"] }),
  });

  try {
    const outcome = await HANDLERS[parsed.command]({ io, parsed, client });
    if (parsed.global.json) {
      writeJson(io, parsed.command, outcome.exitCode, outcome.result, null);
    } else {
      io.stdout(outcome.report);
    }
    return outcome.exitCode;
  } catch (error) {
    return fail(io, parsed.command, parsed.global.json, error);
  }
}

function fail(io: Io, command: CommandName | null, json: boolean, error: unknown): ExitCode {
  const typed =
    error instanceof FlightRulesError
      ? error
      : new FlightRulesError("EVALUATION_FAILED", {
          // The original message is deliberately dropped. An unexpected error's text can carry a
          // connection string, a header or a payload fragment (PRD section 18.2).
          message: "FlightRules failed unexpectedly and produced no decision.",
        });

  const exitCode = exitCodeForError(typed.code);
  if (json && command !== null) {
    writeJson(io, command, exitCode, null, typed);
  } else {
    io.stderr(`flightrules: ${typed.code}: ${typed.message}\n`);
  }
  return exitCode;
}

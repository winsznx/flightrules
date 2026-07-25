import { FlightRulesError } from "@flightrules/domain";
import { z } from "zod";

/**
 * Argument parsing (PRD Phase 11 tasks 5 and 6, PRD section 12.3).
 *
 * Hand-written rather than delegated to a parser library for two reasons that matter here: the
 * command set is fixed by the PRD and must not drift, and every value a script can supply is an
 * external input that PRD section 18.2 requires be validated before use. A rejected argument is a
 * typed `CONFIG_INVALID`, which the exit-code table turns into `5` — never a default that quietly
 * changes what was gated on.
 */

/** The PRD's six commands, in the PRD's order. Nothing else is accepted. */
export const COMMANDS = [
  "config verify",
  "contract validate",
  "baseline capture",
  "release evaluate",
  "gate check",
  "evidence export",
] as const;
export type CommandName = (typeof COMMANDS)[number];

export interface GlobalOptions {
  readonly json: boolean;
  readonly quiet: boolean;
  readonly apiUrl: string;
  readonly timeoutSeconds: number;
}

export interface ParsedCommand {
  readonly command: CommandName;
  readonly global: GlobalOptions;
  readonly positional: readonly string[];
  readonly options: Readonly<Record<string, string | boolean>>;
}

export type ParseResult =
  | { readonly kind: "command"; readonly parsed: ParsedCommand }
  | { readonly kind: "help"; readonly topic: CommandName | null }
  | { readonly kind: "version" };

const DEFAULT_API_URL = "http://localhost:4000";
const DEFAULT_TIMEOUT_SECONDS = 120;

/** Flags that never take a value. Anything else consumes the next token. */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "json",
  "quiet",
  "help",
  "version",
  "wait",
  "no-wait",
  "include-violations",
]);

const ApiUrl = z
  .string()
  .min(1)
  .max(2_048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an http or https URL");

function configError(message: string, details: Record<string, unknown> = {}): FlightRulesError {
  return new FlightRulesError("CONFIG_INVALID", { message, details });
}

/**
 * Splits `argv` into a command, its options and its positional arguments.
 *
 * Two-word commands are matched first and longest-first, so `contract validate` cannot be read as a
 * `contract` command with a stray positional. An unknown command is rejected rather than guessed at.
 */
export function parseArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ParseResult {
  const tokens = [...argv];

  const options: Record<string, string | boolean> = {};
  const positional: string[] = [];

  // `--` ends option parsing, so a path that starts with a dash can still be passed.
  let optionsEnded = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (optionsEnded) {
      positional.push(token);
      continue;
    }
    if (token === "--") {
      optionsEnded = true;
      continue;
    }
    if (token === "-h") {
      options["help"] = true;
      continue;
    }
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const body = token.slice(2);
    const equals = body.indexOf("=");
    if (equals >= 0) {
      const name = body.slice(0, equals);
      assertKnownOption(name);
      options[name] = body.slice(equals + 1);
      continue;
    }

    assertKnownOption(body);
    if (BOOLEAN_FLAGS.has(body)) {
      options[body] = true;
      continue;
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw configError(`--${body} requires a value.`, { option: body });
    }
    options[body] = value;
    index += 1;
  }

  if (options["version"] === true) return { kind: "version" };

  const command = matchCommand(positional);
  if (command === null) {
    if (options["help"] === true || positional.length === 0) {
      return { kind: "help", topic: null };
    }
    throw configError(
      `Unknown command "${positional.join(" ")}". Run "flightrules --help" for the command list.`,
      { supplied: positional.join(" ") },
    );
  }

  if (options["help"] === true) return { kind: "help", topic: command.name };

  return {
    kind: "command",
    parsed: {
      command: command.name,
      global: resolveGlobal(options, env),
      positional: command.rest,
      options,
    },
  };
}

function assertKnownOption(name: string): void {
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(name)) {
    throw configError(`"--${name}" is not a recognised option name.`, { option: name });
  }
}

function matchCommand(
  positional: readonly string[],
): { readonly name: CommandName; readonly rest: readonly string[] } | null {
  const two = positional.slice(0, 2).join(" ");
  for (const candidate of COMMANDS) {
    if (candidate === two) return { name: candidate, rest: positional.slice(2) };
  }
  return null;
}

function resolveGlobal(
  options: Readonly<Record<string, string | boolean>>,
  env: Readonly<Record<string, string | undefined>>,
): GlobalOptions {
  const rawUrl =
    typeof options["api-url"] === "string"
      ? options["api-url"]
      : (env["FLIGHTRULES_API_URL"] ?? DEFAULT_API_URL);
  const url = ApiUrl.safeParse(rawUrl);
  if (!url.success) {
    throw configError("The API URL must be an absolute http or https URL.", {
      option: "api-url",
    });
  }

  const timeout =
    options["timeout"] === undefined
      ? DEFAULT_TIMEOUT_SECONDS
      : integerOption(options["timeout"], "timeout", 1, 3_600);

  return {
    json: options["json"] === true,
    quiet: options["quiet"] === true,
    // Trailing slashes are stripped once here so no call site has to think about them.
    apiUrl: url.data.replace(/\/+$/, ""),
    timeoutSeconds: timeout,
  };
}

/** A required string option, rejected rather than defaulted when absent. */
export function requireString(
  options: Readonly<Record<string, string | boolean>>,
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  envName: string | null,
  bounds: { readonly max: number } = { max: 200 },
): string {
  const supplied = options[name];
  const value =
    typeof supplied === "string" ? supplied : envName === null ? undefined : env[envName];
  if (value === undefined || value.trim().length === 0) {
    throw configError(`--${name} is required${envName === null ? "" : ` (or set ${envName})`}.`, {
      option: name,
    });
  }
  if (value.length > bounds.max) {
    throw configError(`--${name} may not exceed ${bounds.max} characters.`, { option: name });
  }
  return value;
}

export function optionalString(
  options: Readonly<Record<string, string | boolean>>,
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  envName: string | null = null,
): string | undefined {
  const supplied = options[name];
  if (typeof supplied === "string") return supplied;
  if (envName !== null) return env[envName];
  return undefined;
}

export function integerOption(
  value: string | boolean | undefined,
  name: string,
  min: number,
  max: number,
): number {
  if (value === undefined) {
    throw configError(`--${name} is required.`, { option: name });
  }
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) {
    throw configError(`--${name} must be an integer.`, { option: name });
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw configError(`--${name} must be between ${min} and ${max}.`, { option: name });
  }
  return parsed;
}

export function integerOptionOr(
  value: string | boolean | undefined,
  name: string,
  min: number,
  max: number,
  fallback: number,
): number {
  return value === undefined ? fallback : integerOption(value, name, min, max);
}

/** `--wait` is the default; `--no-wait` turns it off. Supplying both is an error, not a race. */
export function waitFlag(options: Readonly<Record<string, string | boolean>>): boolean {
  const wait = options["wait"] === true;
  const noWait = options["no-wait"] === true;
  if (wait && noWait) {
    throw configError("--wait and --no-wait cannot both be given.", { option: "wait" });
  }
  return !noWait;
}

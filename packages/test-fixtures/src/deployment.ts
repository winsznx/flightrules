import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

/**
 * The image tags the committed casting must produce. Asserted against the **generated Compose
 * file** rather than the lock file, because Foundry records `version:` in the lock while still
 * writing a floating `:latest` tag into Compose unless `image:` is also set. The Compose file is
 * what Docker runs, so it is what the test reads. See ADR-0002 and source-lock entry SL-006.
 */
export const PINNED_IMAGES = [
  "signoz/signoz:v0.134.0",
  "signoz/signoz-otel-collector:v0.144.6",
  "signoz/signoz-mcp-server:v0.9.0",
  "postgres:16",
  "clickhouse/clickhouse-server:25.12.5",
  "clickhouse/clickhouse-keeper:25.12.5",
] as const;

/** Host ports the Compose flavor must publish for FlightRules to function. */
export const PUBLISHED_PORTS = {
  signozUi: 8080,
  mcp: 8000,
  otlpGrpc: 4317,
  otlpHttp: 4318,
} as const;

export async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(path.join(REPO_ROOT, relativePath), "utf8");
}

export async function readGeneratedCompose(): Promise<string> {
  return readRepoFile("pours/deployment/compose.yaml");
}

export async function readCasting(): Promise<string> {
  return readRepoFile("casting.yaml");
}

/** Extracts every `image:` value from a generated Compose file, in file order. */
export function extractComposeImages(compose: string): readonly string[] {
  return compose
    .split("\n")
    .map((line) => /^\s+image:\s*(\S+)\s*$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1] as string);
}

/** Extracts every published host port from a generated Compose file. */
export function extractPublishedPorts(compose: string): readonly number[] {
  return compose
    .split("\n")
    .map((line) => /^\s+-\s*"?(\d+):(\d+)"?\s*$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number.parseInt(match[1] as string, 10));
}

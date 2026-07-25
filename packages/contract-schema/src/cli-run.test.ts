import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLI_EXIT, type CliIo, runContractCli } from "./cli-run.js";

/**
 * The validation command.
 *
 * The exit codes are the contract with CI, so they are asserted directly. Exit 5 for an invalid
 * document and exit 4 for an unreadable one is the distinction that lets a pipeline tell "the policy
 * file is broken" from "the policy file is missing".
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const DEMO_CONTRACT = path.join(
  REPO_ROOT,
  "contracts",
  "demo-commerce",
  "refund-agent",
  "production",
  "contract.yaml",
);

interface Capture {
  readonly io: CliIo;
  readonly out: string[];
  readonly err: string[];
}

function capture(files: Readonly<Record<string, string>> = {}): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      readFile: (filePath) => {
        if (Object.hasOwn(files, filePath)) return files[filePath] as string;
        return readFileSync(filePath, "utf8");
      },
    },
  };
}

describe("validate", () => {
  it("exits 0 for the demo contract and reports the content hash", () => {
    const { io, out } = capture();
    expect(runContractCli(["validate", DEMO_CONTRACT], io)).toBe(CLI_EXIT.ok);
    expect(out.join("")).toContain("valid. 15 rule(s), content hash ");
  });

  it("exits 5 for an invalid contract and prints every error with its path", () => {
    const { io, err } = capture({ "bad.yaml": "apiVersion: flightrules.dev/v9\nkind: Nope\n" });
    expect(runContractCli(["validate", "bad.yaml"], io)).toBe(CLI_EXIT.invalidConfiguration);
    const output = err.join("");
    expect(output).toContain("apiVersion: UNKNOWN_API_VERSION");
    expect(output).toContain("kind: UNKNOWN_KIND");
  });

  it("emits machine-readable JSON on request", () => {
    const { io, out } = capture();
    expect(runContractCli(["validate", DEMO_CONTRACT, "--json"], io)).toBe(CLI_EXIT.ok);
    const parsed = JSON.parse(out.join("")) as { valid: boolean; ruleCount: number };
    expect(parsed.valid).toBe(true);
    expect(parsed.ruleCount).toBe(15);
  });

  it("emits machine-readable errors on request", () => {
    const { io, err } = capture({ "bad.yaml": "apiVersion: nope\n" });
    expect(runContractCli(["validate", "bad.yaml", "--json"], io)).toBe(
      CLI_EXIT.invalidConfiguration,
    );
    const parsed = JSON.parse(err.join("")) as {
      valid: boolean;
      errors: readonly { path: string; code: string }[];
    };
    expect(parsed.valid).toBe(false);
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.errors[0]).toHaveProperty("path");
    expect(parsed.errors[0]).toHaveProperty("code");
  });

  it("exits 4 when the document cannot be read at all", () => {
    // #given a path that does not exist
    const { io, err } = capture();

    // #then the failure is an integration error, not an invalid contract: nothing was ever seen,
    // so nothing can be said about validity
    expect(runContractCli(["validate", path.join(REPO_ROOT, "no-such-contract.yaml")], io)).toBe(
      CLI_EXIT.error,
    );
    expect(err.join("")).not.toContain("valid");
  });

  it("exits 5 when no path is given", () => {
    const { io } = capture();
    expect(runContractCli(["validate"], io)).toBe(CLI_EXIT.error);
  });
});

describe("hash and canonical", () => {
  it("prints a stable content hash", () => {
    const first = capture();
    const second = capture();
    expect(runContractCli(["hash", DEMO_CONTRACT], first.io)).toBe(CLI_EXIT.ok);
    expect(runContractCli(["hash", DEMO_CONTRACT], second.io)).toBe(CLI_EXIT.ok);
    expect(second.out.join("")).toBe(first.out.join(""));
    expect(first.out.join("").trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("prints canonical JSON that round-trips as JSON", () => {
    const { io, out } = capture();
    expect(runContractCli(["canonical", DEMO_CONTRACT], io)).toBe(CLI_EXIT.ok);
    const parsed = JSON.parse(out.join("")) as { contentHash: string };
    expect(parsed.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses to hash an invalid contract", () => {
    const { io } = capture({ "bad.yaml": "apiVersion: nope\n" });
    expect(runContractCli(["hash", "bad.yaml"], io)).toBe(CLI_EXIT.invalidConfiguration);
  });
});

describe("schema and usage", () => {
  it("prints the published JSON Schema", () => {
    const { io, out } = capture();
    expect(runContractCli(["schema"], io)).toBe(CLI_EXIT.ok);
    const parsed = JSON.parse(out.join("")) as { $id: string };
    expect(parsed.$id).toContain("trajectory-contract.v1alpha1");
  });

  it("exits 5 with usage for an unknown command", () => {
    const { io, err } = capture();
    expect(runContractCli(["explode"], io)).toBe(CLI_EXIT.invalidConfiguration);
    expect(err.join("")).toContain("flightrules-contract <command>");
  });
});

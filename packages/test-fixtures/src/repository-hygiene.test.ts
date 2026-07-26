import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, readRepoFile } from "./deployment.js";

/**
 * Repository-level regressions that only a whole-repository test can see (PRD Phase 16 tasks 2
 * and 16).
 *
 * Each assertion here pins a defect that entry verification for Phase 16 found in a repository
 * whose unit, integration and browser suites were all green. None of them is visible from inside a
 * package, because each is a disagreement *between* files: a Makefile target and the README that
 * documents it, a shared environment file and the four processes that read it, a package script
 * and the CI job that calls it.
 */

const AUDIT_SCRIPT = "scripts/audit-dependencies.mjs";

interface AuditModule {
  readonly matchAdvisories: (
    advisoriesByName: Record<
      string,
      readonly {
        readonly severity: string;
        readonly vulnerable_versions: string;
        readonly title: string;
        readonly url: string;
        readonly id: number;
      }[]
    >,
    installed: ReadonlyMap<string, readonly string[]>,
  ) => readonly {
    readonly name: string;
    readonly affectedVersions: readonly string[];
    readonly severity: string;
  }[];
  readonly atOrAbove: (severity: string, level: string) => boolean;
}

async function auditModule(): Promise<AuditModule> {
  const loaded: unknown = await import(pathToFileURL(path.join(REPO_ROOT, AUDIT_SCRIPT)).href);
  return loaded as AuditModule;
}

describe("the database Make targets load the environment they document", () => {
  /**
   * `make db-migrate` is step five of the README's getting-started sequence. It read no `.env`,
   * unlike `make api`, `make worker` and `make test-integration`, so on any machine that had not
   * exported `DATABASE_URL` by hand — which is every fresh machine — the documented step exited 5
   * with "DATABASE_URL is not set."
   */
  it.each(["db-migrate", "db-rollback", "db-status"])(
    "make %s sources .env before running",
    async (target) => {
      const makefile = await readRepoFile("Makefile");
      const body = makefile.split(`\n${target}:`)[1]?.split("\n\n")[0] ?? "";
      expect(body).toContain(". ./.env");
    },
  );
});

describe("the shared environment file does not relabel every process as the API", () => {
  /**
   * `.env` is loaded by the API, the worker, the CLI and every demo service. A single
   * `OTEL_SERVICE_NAME` in it is read by all of them, so the worker's spans, metrics and logs
   * arrived in SigNoz as `flightrules-api` and a violation could not be attributed to the process
   * that evaluated it. Each entrypoint already carries its own default.
   */
  it("does not set OTEL_SERVICE_NAME", async () => {
    const example = await readRepoFile(".env.example");
    const assignments = example
      .split("\n")
      .filter((line) => /^\s*OTEL_SERVICE_NAME\s*=/.test(line));
    expect(assignments).toEqual([]);
  });

  it("explains where the service name comes from instead", async () => {
    const example = await readRepoFile(".env.example");
    expect(example).toContain("OTEL_SERVICE_NAME is deliberately NOT set here");
    expect(example).toContain("flightrules-worker");
  });
});

describe("the dependency vulnerability gate", () => {
  /**
   * `pnpm audit` cannot complete against the current npm registry: `pnpm@10.33.0` hands a
   * gzip-encoded body that carries no `content-encoding` header straight to `Response.json()`.
   * Three consecutive runs on 2026-07-26 exited 1 with `Unexpected token '\x1f'`. The `security`
   * job of `.github/workflows/ci.yml` calls this script, so a gate that cannot run is a gate that
   * fails the first real workflow run.
   */
  it("is not pnpm audit", async () => {
    const manifest = JSON.parse(await readRepoFile("package.json")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts["scan:deps"]).not.toContain("pnpm audit");
    expect(manifest.scripts["scan:deps"]).toContain(AUDIT_SCRIPT);
  });

  it("decompresses a body whose encoding the registry does not declare", async () => {
    const source = await readRepoFile(AUDIT_SCRIPT);
    expect(source).toContain("gunzipSync");
    expect(source).toContain("0x1f");
    expect(source).toContain("0x8b");
  });

  it("reports an advisory only for the installed versions its range actually covers", async () => {
    const { matchAdvisories } = await auditModule();
    const findings = matchAdvisories(
      {
        minimist: [
          {
            severity: "critical",
            vulnerable_versions: "<0.2.4",
            title: "Prototype Pollution in minimist",
            url: "https://github.com/advisories/GHSA-xvch-5gv4-984h",
            id: 1_097_677,
          },
        ],
      },
      new Map([["minimist", ["0.0.8", "1.2.8"]]]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.affectedVersions).toEqual(["0.0.8"]);
  });

  it("drops an advisory that covers no installed version", async () => {
    const { matchAdvisories } = await auditModule();
    const findings = matchAdvisories(
      {
        postcss: [
          {
            severity: "high",
            vulnerable_versions: "<=8.5.17",
            title: "Path traversal in previous source map auto-loading",
            url: "https://github.com/advisories/GHSA-r28c-9q8g-f849",
            id: 1_000_001,
          },
        ],
      },
      new Map([["postcss", ["8.5.23"]]]),
    );
    expect(findings).toEqual([]);
  });

  it("gates on severity at or above the requested level", async () => {
    const { atOrAbove } = await auditModule();
    expect(atOrAbove("critical", "high")).toBe(true);
    expect(atOrAbove("high", "high")).toBe(true);
    expect(atOrAbove("moderate", "high")).toBe(false);
    expect(atOrAbove("low", "moderate")).toBe(false);
  });
});

describe("the postcss override that resolves the two high advisories", () => {
  /**
   * `next@16.2.11` depends on `postcss@8.4.31`, which two published high-severity advisories cover
   * with no patched version. `postcss@8.5.23` is outside both ranges, so the tree is pinned to it
   * rather than the finding being argued away.
   */
  it("pins postcss above both advisory ranges", async () => {
    const manifest = JSON.parse(await readRepoFile("package.json")) as {
      pnpm?: { overrides?: Record<string, string> };
    };
    expect(manifest.pnpm?.overrides?.["postcss"]).toBe("8.5.23");
  });

  it("leaves no 8.4.x postcss in the lockfile", async () => {
    const lockfile = await readRepoFile("pnpm-lock.yaml");
    expect(lockfile).not.toMatch(/^ {2}postcss@8\.4\./m);
  });
});

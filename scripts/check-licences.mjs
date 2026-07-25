#!/usr/bin/env node
/**
 * Dependency licence check.
 *
 * Uses `pnpm licenses list --json`, which reads the installed tree rather than a manifest, so it
 * sees transitive dependencies too. A licence outside the allowlist fails the build: the PRD
 * requires a dependency licence check, and "we looked and it seemed fine" is not a check.
 */
import { execFileSync } from "node:child_process";
import process from "node:process";

const ALLOWED = new Set([
  "0BSD",
  "Apache-2.0",
  "Artistic-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "CC-BY-3.0",
  "CC-BY-4.0",
  "ISC",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "Python-2.0",
  "Unlicense",
  "WTFPL",
  "Zlib",
]);

// Allowlist decisions that were not obvious, recorded here so a reviewer sees the reasoning
// next to the rule rather than in a separate document:
//
// - Artistic-2.0 (binaryextensions, editions, istextorbinary, textextensions, version-range):
//   OSI-approved and permissive for redistribution. These are transitive devDependencies of
//   secretlint and are never shipped in a runtime artefact. See ADR-0005.
// - CC-BY-3.0 (spdx-exceptions): an attribution-only data licence covering an SPDX identifier
//   list, not code. Transitive devDependency. See ADR-0005.

/** Copyleft licences that would impose obligations on a distributed Apache-2.0 product. */
const DENIED = new Set([
  "AGPL-1.0",
  "AGPL-3.0",
  "AGPL-3.0-only",
  "AGPL-3.0-or-later",
  "GPL-2.0",
  "GPL-3.0",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "SSPL-1.0",
  "BUSL-1.1",
  "Elastic-2.0",
]);

/** Splits SPDX expressions such as "MIT OR Apache-2.0" and "(MIT AND BSD-3-Clause)". */
function expressionIsAllowed(expression) {
  const normalised = expression.replace(/[()]/g, " ").trim();

  if (/\bOR\b/i.test(normalised)) {
    return normalised.split(/\s+OR\s+/i).some((part) => expressionIsAllowed(part.trim()));
  }
  if (/\bAND\b/i.test(normalised)) {
    return normalised.split(/\s+AND\s+/i).every((part) => expressionIsAllowed(part.trim()));
  }
  const id = normalised.replace(/\s+WITH\s+.*$/i, "").trim();
  return ALLOWED.has(id) && !DENIED.has(id);
}

function run() {
  let raw;
  try {
    raw = execFileSync("pnpm", ["licenses", "list", "--json"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    process.stderr.write(`Failed to read installed licences: ${error.message}\n`);
    return 1;
  }

  const byLicence = JSON.parse(raw);
  const violations = [];
  let packageCount = 0;

  for (const [licence, packages] of Object.entries(byLicence)) {
    for (const pkg of packages) {
      packageCount += 1;
      if (!expressionIsAllowed(licence)) {
        violations.push({ name: pkg.name, versions: pkg.versions ?? [], licence });
      }
    }
  }

  process.stdout.write(
    `Checked ${packageCount} installed package(s) across ${Object.keys(byLicence).length} licence expression(s).\n`,
  );

  if (violations.length > 0) {
    process.stderr.write("\nDisallowed licences found:\n");
    for (const violation of violations) {
      process.stderr.write(
        `  ${violation.name}@${violation.versions.join(",")} — ${violation.licence}\n`,
      );
    }
    process.stderr.write(
      "\nAdd the licence to the allowlist in scripts/check-licences.mjs only with a recorded\n" +
        "decision, or replace the dependency.\n",
    );
    return 1;
  }

  process.stdout.write("All dependency licences are permissive and allowed.\n");
  return 0;
}

process.exit(run());

#!/usr/bin/env node
/**
 * Dependency vulnerability audit.
 *
 * Replaces `pnpm audit`, which cannot complete against the current npm registry.
 *
 * `pnpm@10.33.0` requests the advisory endpoint with `accept-encoding: gzip` and then hands the
 * still-compressed body to `Response.json()`. Cloudflare, which fronts `registry.npmjs.org`,
 * returns that body gzip-encoded **without** a `content-encoding` header, so nothing downstream
 * decompresses it and every run dies with `Unexpected token '\x1f' ... is not valid JSON`. The
 * failure is total, not intermittent: three consecutive `pnpm audit --audit-level high` runs on
 * 2026-07-26 all exited 1 with that message, and the `security` job of
 * `.github/workflows/ci.yml` calls the same command. A security gate that has never run is not a
 * security gate.
 *
 * This queries the same documented endpoint and sniffs the gzip magic number itself, so an
 * undeclared encoding is handled rather than fatal. Version-to-advisory matching is done here with
 * `semver`, because the endpoint returns every advisory matching *any* submitted version of a
 * package and does not say which one — submitting `minimist@0.0.8` and `minimist@1.2.8` together
 * returns the `<0.2.4` advisory, which applies only to the first.
 *
 *   node scripts/audit-dependencies.mjs [--level low|moderate|high|critical] [--json]
 */
import { execFileSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { satisfies } from "semver";

const ENDPOINT = "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk";

/** Severity order, lowest first, as the registry reports it. */
const SEVERITIES = ["info", "low", "moderate", "high", "critical"];

/** How many packages to submit per request. The endpoint rejects an unbounded body. */
const BATCH_SIZE = 250;

const REQUEST_TIMEOUT_MS = 30_000;

function parseArguments(argv) {
  let level = "high";
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") json = true;
    else if (argument === "--level" || argument === "--audit-level") {
      const value = argv[index + 1];
      if (!SEVERITIES.includes(value)) {
        throw new Error(`--level must be one of ${SEVERITIES.join(", ")}; received ${value}`);
      }
      level = value;
      index += 1;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return { level, json };
}

/**
 * Every installed package and version, read from the installed tree rather than a manifest.
 *
 * `pnpm licenses list --json` is already the repository's way of enumerating the real tree
 * (`scripts/check-licences.mjs` uses it), so the two gates cannot disagree about what is installed.
 */
function installedPackages() {
  const raw = execFileSync("pnpm", ["licenses", "list", "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const byLicence = JSON.parse(raw);
  const versionsByName = new Map();
  for (const packages of Object.values(byLicence)) {
    for (const entry of packages) {
      const existing = versionsByName.get(entry.name) ?? new Set();
      for (const version of entry.versions ?? []) existing.add(version);
      versionsByName.set(entry.name, existing);
    }
  }
  return new Map([...versionsByName].map(([name, versions]) => [name, [...versions].sort()]));
}

/**
 * Reads a response body that may be gzip-encoded without saying so.
 *
 * Sniffing the two-byte magic number is the whole point: `Response.json()` is exactly what fails
 * against this endpoint.
 */
async function readJsonBody(response) {
  const bytes = Buffer.from(await response.arrayBuffer());
  const text =
    bytes[0] === 0x1f && bytes[1] === 0x8b
      ? gunzipSync(bytes).toString("utf8")
      : bytes.toString("utf8");
  return JSON.parse(text);
}

async function fetchAdvisories(batch) {
  const body = JSON.stringify(Object.fromEntries(batch));
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`The advisory endpoint returned HTTP ${response.status}.`);
  }
  return readJsonBody(response);
}

/**
 * Attributes each advisory to the installed versions it actually covers.
 *
 * An advisory whose range matches no installed version is dropped. Returning it would be the same
 * defect `pnpm audit` has in reverse: reporting a vulnerability the tree does not have.
 */
export function matchAdvisories(advisoriesByName, installed) {
  const findings = [];
  for (const [name, advisories] of Object.entries(advisoriesByName)) {
    const versions = installed.get(name) ?? [];
    for (const advisory of advisories) {
      const affected = versions.filter((version) =>
        satisfies(version, advisory.vulnerable_versions, { includePrerelease: true }),
      );
      if (affected.length === 0) continue;
      findings.push({
        name,
        affectedVersions: affected,
        severity: advisory.severity,
        title: advisory.title,
        url: advisory.url,
        id: advisory.id,
        vulnerableVersions: advisory.vulnerable_versions,
        patchedVersions: advisory.patched_versions ?? null,
      });
    }
  }
  findings.sort(
    (a, b) =>
      SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity) ||
      a.name.localeCompare(b.name),
  );
  return findings;
}

export function atOrAbove(severity, level) {
  return SEVERITIES.indexOf(severity) >= SEVERITIES.indexOf(level);
}

async function run(argv) {
  const { level, json } = parseArguments(argv);
  const installed = installedPackages();

  const entries = [...installed].map(([name, versions]) => [name, versions]);
  const advisoriesByName = {};
  for (let index = 0; index < entries.length; index += BATCH_SIZE) {
    const batch = entries.slice(index, index + BATCH_SIZE);
    Object.assign(advisoriesByName, await fetchAdvisories(batch));
  }

  const findings = matchAdvisories(advisoriesByName, installed);
  const blocking = findings.filter((finding) => atOrAbove(finding.severity, level));

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ level, packagesChecked: installed.size, findings, blocking: blocking.length }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(
      `Audited ${String(installed.size)} installed package(s) against the npm advisory database.\n`,
    );
    if (findings.length === 0) {
      process.stdout.write("No known advisory affects any installed version.\n");
    } else {
      for (const finding of findings) {
        const marker = atOrAbove(finding.severity, level) ? "FAIL" : "note";
        process.stdout.write(
          `  ${marker}  ${finding.severity.padEnd(8)} ${finding.name}@${finding.affectedVersions.join(",")}\n` +
            `        ${finding.title}\n` +
            `        vulnerable ${finding.vulnerableVersions}; patched ${finding.patchedVersions ?? "none published"}\n` +
            `        ${finding.url}\n`,
        );
      }
    }
  }

  if (blocking.length > 0) {
    process.stderr.write(
      `\n${String(blocking.length)} advisory at or above "${level}" affects this tree. Resolve it or record a\n` +
        "grounded decision in docs/evidence/phase-16/security-scans.md before release.\n",
    );
    return 1;
  }
  return 0;
}

// Importable by the unit test, which exercises the matching without reaching the network.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(await run(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(
      `Dependency audit failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}

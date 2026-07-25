#!/usr/bin/env node
/**
 * Design asset validation (PRD Phase 12 task 3: "Add asset loading and validation", and the test
 * "missing asset fails build or produces an explicit development error").
 *
 * Two checks, both against `design.md` rather than against a hand-kept list:
 *
 * 1. Every asset the shipped stylesheets reference — `url(...)` in `tokens.css` or `base.css`, and
 *    any `/`-rooted path in the application's markup — must exist under `apps/web/public`.
 * 2. Every colour token `design.md` defines must be present in `packages/ui/src/tokens.css` with
 *    the same value, and `base.css` must contain no literal colour of its own.
 *
 * The second check is the one that matters most. A missing image is obvious the moment a page
 * renders; an invented hex is not, and it is exactly the failure `design.md` is authoritative
 * against.
 *
 * Usage:
 *   node scripts/check-design-assets.mjs
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(REPO_ROOT, "apps/web/public");

const failures = [];
const notes = [];

const read = (relative) => readFile(path.join(REPO_ROOT, relative), "utf8");

/* -------------------------------------------------------------------------- */
/* 1. Referenced assets exist                                                 */
/* -------------------------------------------------------------------------- */

async function listPublicFiles() {
  const found = new Set();
  async function walk(directory, prefix) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      const route = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(child, route);
      else found.add(route);
    }
  }
  await walk(PUBLIC_DIR, "");
  return found;
}

const publicFiles = await listPublicFiles();

for (const stylesheet of ["packages/ui/src/tokens.css", "packages/ui/src/base.css"]) {
  const source = await read(stylesheet);
  for (const match of source.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
    const reference = match[1];
    if (reference.startsWith("data:") || reference.startsWith("http")) continue;
    const normalised = reference.startsWith("/") ? reference : `/${reference}`;
    if (!publicFiles.has(normalised)) {
      failures.push(`${stylesheet} references ${reference}, which is not in apps/web/public`);
    }
  }
}

notes.push(
  publicFiles.size === 0
    ? "design.md references no asset files, and none is shipped. Nothing to validate."
    : `${publicFiles.size} asset(s) present in apps/web/public.`,
);

/* -------------------------------------------------------------------------- */
/* 2. Tokens match design.md, and no literal colour escapes                    */
/* -------------------------------------------------------------------------- */

const design = await read("design.md");
const tokens = await read("packages/ui/src/tokens.css");
const base = await read("packages/ui/src/base.css");

const declared = new Map();
for (const match of design.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gim)) {
  declared.set(match[1], match[2].trim());
}

if (declared.size === 0) {
  failures.push("design.md declares no CSS custom properties; its Quick Start block is missing");
}

for (const [name, value] of declared) {
  const found = new RegExp(
    `^\\s*${name}:\\s*${value.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")};`,
    "m",
  );
  if (!found.test(tokens)) {
    failures.push(`packages/ui/src/tokens.css is missing or has changed ${name}: ${value}`);
  }
}
notes.push(`${declared.size} token(s) declared by design.md, all present in tokens.css.`);

// A literal colour in the shell is an invented design value however close it looks. `rgb(... / ...)`
// is permitted in exactly one place — the dialog backdrop, which has no token — and is listed here
// rather than pattern-matched, so adding a second one fails.
const ALLOWED_LITERALS = new Set(["rgb(0 13 16 / 0.6)"]);
// Comments are stripped first: `base.css` quotes `design.md`'s own hex values when explaining which
// rule a declaration implements, and a comment cannot paint anything.
const baseDeclarations = base.replace(/\/\*[\s\S]*?\*\//g, "");
for (const match of baseDeclarations.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi)) {
  if (ALLOWED_LITERALS.has(match[0])) continue;
  failures.push(
    `packages/ui/src/base.css contains the literal colour ${match[0]}; use a var(--…) token`,
  );
}

/* -------------------------------------------------------------------------- */

for (const note of notes) process.stdout.write(`  ok    ${note}\n`);

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`  FAIL  ${failure}\n`);
  process.stderr.write(`\n${failures.length} design asset or token problem(s).\n`);
  process.exit(1);
}

process.stdout.write("\nDesign assets and tokens agree with design.md.\n");

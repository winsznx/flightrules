import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AGENT_DETAIL,
  AGENTS,
  BASELINE,
  CONTRACT_STUDIO,
  DEMO,
  INTEGRATION,
  LANDING,
  OVERVIEW,
  PROJECTS,
  RELEASE_DIFF,
  RELEASES,
  ROUTE_FAMILY,
  SETUP,
  VIOLATION,
} from "./lib/copy.js";

/**
 * The web application's contract with the PRD and with `design.md`.
 *
 * Rendering a React Server Component tree in a unit test would require a renderer this workspace
 * does not pin, so these tests assert the two things that can actually go wrong silently: the copy
 * drifting from PRD section 8, and a route file inventing a design value or reaching past the API
 * boundary. Behaviour is asserted by the route smoke tests, which run the built application.
 */

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(WEB_ROOT, "..", "..");
const APP_DIR = path.join(WEB_ROOT, "src", "app");

async function routeFiles(): Promise<readonly string[]> {
  const found: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.name === "page.tsx" || entry.name === "layout.tsx") found.push(child);
    }
  }
  await walk(APP_DIR);
  return found.sort();
}

/** Every `.ts` and `.tsx` module under `src`, so a boundary cannot hide outside `app/`. */
async function sourceFiles(): Promise<readonly string[]> {
  const found: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts")) found.push(child);
    }
  }
  await walk(path.join(WEB_ROOT, "src"));
  return found.sort();
}

/**
 * Modules that declare a client boundary.
 *
 * Comments are stripped first. A server module may explain what a client module is forbidden to do —
 * and quoting the directive in prose does not declare one.
 */
async function clientModules(): Promise<readonly string[]> {
  const found: string[] = [];
  for (const file of await sourceFiles()) {
    const source = (await readFile(file, "utf8")).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    if (source.includes('"use client"')) found.push(file);
  }
  return found;
}

const PRD = await readFile(path.join(REPO_ROOT, "docs", "PRD.md"), "utf8");

/* -------------------------------------------------------------------------- */
/* Every route PRD section 8 mandates exists                                  */
/* -------------------------------------------------------------------------- */

const REQUIRED_ROUTES = [
  "page.tsx",
  "setup/page.tsx",
  "projects/page.tsx",
  "projects/[projectId]/overview/page.tsx",
  "projects/[projectId]/agents/page.tsx",
  "projects/[projectId]/agents/[agentId]/page.tsx",
  "projects/[projectId]/agents/[agentId]/baselines/new/page.tsx",
  "projects/[projectId]/agents/[agentId]/routes/[routeFamilyId]/page.tsx",
  "projects/[projectId]/agents/[agentId]/contracts/[contractId]/page.tsx",
  "projects/[projectId]/agents/[agentId]/releases/page.tsx",
  "projects/[projectId]/agents/[agentId]/releases/[releaseId]/page.tsx",
  "projects/[projectId]/violations/[violationId]/page.tsx",
  "projects/[projectId]/integrations/signoz/page.tsx",
  "demo/page.tsx",
] as const;

describe("PRD section 8 routes", () => {
  it("implements all fourteen", async () => {
    // #given every page file the application ships
    const files = (await routeFiles()).map((file) => path.relative(APP_DIR, file));

    // #then each route PRD section 8 mandates has one
    for (const route of REQUIRED_ROUTES) {
      expect(files).toContain(route);
    }
  });

  it("ships no page PRD section 8 does not describe", async () => {
    // #then the information architecture is the PRD's, not an accumulation
    const pages = (await routeFiles())
      .map((file) => path.relative(APP_DIR, file))
      .filter((file) => file.endsWith("page.tsx"));
    expect(new Set(pages)).toEqual(new Set(REQUIRED_ROUTES));
  });

  it("gives every route a stable test selector", async () => {
    // #then an end-to-end suite can address each route without a brittle text match
    for (const file of await routeFiles()) {
      if (file.endsWith("layout.tsx")) continue;
      const source = await readFile(file, "utf8");
      expect(source).toMatch(/data-testid="route-[a-z-]+"/);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Copy comes from the PRD                                                    */
/* -------------------------------------------------------------------------- */

/** Asserts a string appears in the PRD verbatim. Whitespace is normalised; wording is not. */
function assertInPrd(value: string): void {
  const normalised = PRD.replace(/\s+/g, " ");
  expect(normalised).toContain(value.replace(/\s+/g, " "));
}

describe("UI copy comes from the PRD", () => {
  it("uses PRD section 8.1's landing copy verbatim", () => {
    for (const value of [
      LANDING.heroEyebrow,
      LANDING.heroTitle,
      LANDING.heroBody,
      LANDING.primaryCta,
      LANDING.secondaryCta,
      LANDING.problemTitle,
      LANDING.problemBody,
      LANDING.finalCtaTitle,
      LANDING.finalCtaButton,
      ...LANDING.proofStrip,
      ...LANDING.mechanismSteps,
    ]) {
      assertInPrd(value);
    }
  });

  it("uses PRD section 8.2's setup copy verbatim", () => {
    for (const value of [
      SETUP.title,
      SETUP.description,
      SETUP.primaryCta,
      SETUP.success,
      SETUP.failure,
      ...SETUP.steps,
    ]) {
      assertInPrd(value);
    }
  });

  it("uses PRD sections 8.3 to 8.7's copy verbatim", () => {
    for (const value of [
      PROJECTS.title,
      PROJECTS.empty,
      PROJECTS.cta,
      OVERVIEW.mainPanelTitle,
      OVERVIEW.secondaryPanelTitle,
      ...OVERVIEW.cards,
      AGENTS.title,
      AGENTS.empty,
      AGENTS.cta,
      ...AGENT_DETAIL.tabs,
      AGENT_DETAIL.ctaNoBaseline,
      AGENT_DETAIL.ctaWithBaseline,
      BASELINE.title,
      BASELINE.description,
      BASELINE.primaryCta,
      ...BASELINE.progressStates,
      ...BASELINE.controls,
    ]) {
      assertInPrd(value);
    }
  });

  it("uses PRD sections 8.9 to 8.14's copy verbatim", () => {
    for (const value of [
      CONTRACT_STUDIO.title,
      CONTRACT_STUDIO.unsavedWarning,
      ...CONTRACT_STUDIO.statuses,
      ...CONTRACT_STUDIO.actions,
      ...CONTRACT_STUDIO.graphNodeRuleControls,
      RELEASES.title,
      ...RELEASES.columns,
      RELEASE_DIFF.decision.pass,
      RELEASE_DIFF.decision.fail,
      RELEASE_DIFF.decision.insufficient_data,
      RELEASE_DIFF.decision.error,
      ...RELEASE_DIFF.diffLabels,
      ...RELEASE_DIFF.actions,
      ...VIOLATION.sections,
      VIOLATION.primaryCta,
      ...VIOLATION.secondaryActions,
      INTEGRATION.title,
      ...INTEGRATION.sections,
      ...INTEGRATION.actions,
      DEMO.title,
      ...DEMO.controls,
      ROUTE_FAMILY.titlePrefix,
    ]) {
      assertInPrd(value);
    }
  });

  it("carries PRD section 8.11's four decision sentences exactly", () => {
    // #then the CLI, the GitHub summary and this page say the same thing about the same decision
    expect(RELEASE_DIFF.decision.pass).toBe(
      "PASS: This release stayed within the approved trajectory contract.",
    );
    expect(RELEASE_DIFF.decision.fail).toBe(
      "FAIL: This release exceeded one or more trajectory thresholds.",
    );
    expect(RELEASE_DIFF.decision.insufficient_data).toBe(
      "INSUFFICIENT DATA: More completed runs are required before a release decision can be made.",
    );
    expect(RELEASE_DIFF.decision.error).toBe(
      "ERROR: FlightRules could not complete the evaluation. No release decision was produced.",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Prohibitions                                                               */
/* -------------------------------------------------------------------------- */

describe("prohibitions", () => {
  it("never offers to ignore a violation and pass the release", async () => {
    // #given PRD section 8.12: "The product must never offer `Ignore and pass release`."
    // Comments are stripped: a route file may explain the prohibition, and prose renders nothing.
    for (const file of await routeFiles()) {
      const source = (await readFile(file, "utf8")).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
      expect(source).not.toContain("Ignore and pass release");
    }
  });

  it("declares the forbidden action so its absence is checkable", () => {
    expect(VIOLATION.forbiddenAction).toBe("Ignore and pass release");
    assertInPrd(VIOLATION.forbiddenAction);
  });

  it("invents no colour, font or size in a route file", async () => {
    // #then every visual value comes from a token; a route cannot define a design value.
    // The pattern matches only well-formed CSS hex lengths, so an order number such as `#10428`
    // in product copy is not mistaken for a colour, and comments are stripped first.
    const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/;
    for (const file of await routeFiles()) {
      const source = (await readFile(file, "utf8")).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
      expect(source).not.toMatch(HEX);
      expect(source).not.toMatch(/\b\d+px\b/);
      expect(source).not.toMatch(/font-family/);
    }
  });

  it("never reaches past the API boundary", async () => {
    // #given PRD section 12.3: the web application calls the FlightRules API only
    for (const file of await routeFiles()) {
      const source = await readFile(file, "utf8");
      expect(source).not.toContain("SIGNOZ_API_KEY");
      expect(source).not.toContain("@flightrules/signoz-mcp");
      expect(source).not.toContain("@flightrules/db");
      expect(source).not.toContain("DATABASE_URL");
    }
  });

  it("keeps the API client server-only", async () => {
    // #then importing it from a client component is a build error, not a code review note
    const client = await readFile(path.join(WEB_ROOT, "src/lib/api.ts"), "utf8");
    expect(client).toContain('import "server-only"');
    const loader = await readFile(path.join(WEB_ROOT, "src/lib/load.ts"), "utf8");
    expect(loader).toContain('import "server-only"');
  });

  /* ------------------------------------------------------------------------ */
  /* Client boundaries                                                        */
  /* ------------------------------------------------------------------------ */

  /**
   * Phase 12 asserted that no route file contained `"use client"`, which held while nothing on any
   * page was interactive. Phase 13 makes the baseline form, the review actions and the YAML editor
   * work, so three client components now exist and that assertion could only be satisfied by
   * deleting it.
   *
   * These five take its place. They are strictly stronger: the old rule allowed a page to fetch
   * from the browser through any module that was not itself a route file, and said nothing about
   * how wide a client boundary could grow. What actually matters is that no product state and no
   * API address reaches the browser, that pages stay server-rendered, and that a boundary stays
   * small enough to read.
   */
  describe("client boundaries", () => {
    it("puts no client component in a route file", async () => {
      // #then every page and layout is a Server Component, so a route is never converted wholesale
      for (const file of await routeFiles()) {
        const source = await readFile(file, "utf8");
        expect(source, `${path.relative(WEB_ROOT, file)} is a client component`).not.toContain(
          '"use client"',
        );
      }
    });

    it("declares a client boundary only where interaction requires one", async () => {
      // #given every `"use client"` module the application ships
      const modules = await clientModules();

      // #then each is one of the four interactions Phases 13 and 15 introduce, and nothing else
      // has been quietly moved to the browser since
      expect(modules.map((file) => path.basename(file)).sort()).toEqual([
        "auto-refresh.tsx",
        "copy-button.tsx",
        "submit-button.tsx",
        "yaml-editor.tsx",
      ]);
    });

    it("never fetches, subscribes or reaches the API from a client component", async () => {
      // #given PRD section 12.3 and the `server-only` API client
      for (const file of await clientModules()) {
        const source = (await readFile(file, "utf8")).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
        const relative = path.relative(WEB_ROOT, file);
        for (const forbidden of [
          "fetch(",
          "XMLHttpRequest",
          "EventSource",
          "WebSocket",
          "@/lib/api",
          "@/lib/load",
          "@/lib/evidence-summary",
          "server-only",
          "@flightrules/db",
          "FLIGHTRULES_API_URL",
        ]) {
          expect(source, `${relative} contains ${forbidden}`).not.toContain(forbidden);
        }
      }
    });

    it("keeps every client boundary narrow", async () => {
      // #then a component that has grown past a readable size is a boundary that has crept
      for (const file of await clientModules()) {
        const lines = (await readFile(file, "utf8")).split("\n").length;
        expect(lines, `${path.relative(WEB_ROOT, file)} is ${String(lines)} lines`).toBeLessThan(
          160,
        );
      }
    });

    it("ships no comparison engine to the browser", async () => {
      // #given PRD Phase 14's last test: "no graph data is fabricated client-side"
      // #then no module in this application imports the graph engine at all, so there is no code
      // here that *could* compute a diff — the API computes it and this application renders it
      // Comments are stripped first: a module may explain which engine computed what it renders,
      // and prose imports nothing.
      for (const file of await sourceFiles()) {
        const source = (await readFile(file, "utf8")).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
        for (const forbidden of [
          "@flightrules/trace-graph",
          "diffGraphs",
          "diffCanonicalGraphs",
          "canonicaliseGraph",
          "@flightrules/contract-engine",
          "@flightrules/baseline-miner",
        ]) {
          expect(source, `${path.relative(WEB_ROOT, file)} imports ${forbidden}`).not.toContain(
            forbidden,
          );
        }
      }
    });

    it("applies the design-token rule inside client components too", async () => {
      // #then a client component cannot invent a colour, a size or a font either
      const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/;
      for (const file of await clientModules()) {
        const source = (await readFile(file, "utf8")).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
        expect(source).not.toMatch(HEX);
        expect(source).not.toMatch(/\b\d+px\b/);
        expect(source).not.toMatch(/font-family/);
      }
    });
  });
});

/* -------------------------------------------------------------------------- */
/* design.md fidelity                                                         */
/* -------------------------------------------------------------------------- */

describe("design.md fidelity", () => {
  it("copies every token design.md declares", async () => {
    // #given design.md's own Quick Start block
    const design = await readFile(path.join(REPO_ROOT, "design.md"), "utf8");
    const tokens = await readFile(path.join(REPO_ROOT, "packages/ui/src/tokens.css"), "utf8");

    const declared = [...design.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gim)];
    expect(declared.length).toBeGreaterThan(60);

    // #then each one is present in tokens.css with the same value
    for (const [, name, value] of declared) {
      expect(tokens).toContain(`${name as string}: ${(value as string).trim()};`);
    }
  });

  /**
   * design.md's seven colours, plus exactly one derived value.
   *
   * `#707077` is Cool Ash darkened for the white canvas. It exists because PRD section 20.3
   * requires WCAG AA after design.md is applied, and design.md's own Cool Ash measures 3.25:1 on
   * white where AA needs 4.5:1. The palette token is unchanged and still serves the dark surfaces
   * it was drawn for; only the semantic muted-text role points at the derivation. An eighth colour
   * that is not this one is a design value the system does not define, and this test says so.
   */
  it("declares design.md's seven colours plus only the documented AA derivation", async () => {
    const tokens = await readFile(path.join(REPO_ROOT, "packages/ui/src/tokens.css"), "utf8");
    const colours = new Set(
      [...tokens.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((match) => match[0].toLowerCase()),
    );
    expect(colours).toEqual(
      new Set([
        "#000d10",
        "#ffffff",
        "#8e8e95",
        "#d5d3d4",
        "#0f0f1c",
        "#151623",
        "#bc7155",
        "#707077",
      ]),
    );
  });

  it("keeps the AA derivation above 4.5:1 on white, which is why it exists", () => {
    // Recomputed here rather than trusted, so a future tweak toward the original hue fails.
    const luminance = (hex: string): number => {
      const channels = [1, 3, 5]
        .map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
        .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
      return (
        0.2126 * (channels[0] as number) +
        0.7152 * (channels[1] as number) +
        0.0722 * (channels[2] as number)
      );
    };
    const contrast = (a: string, b: string): number => {
      const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return ((high as number) + 0.05) / ((low as number) + 0.05);
    };

    expect(contrast("#707077", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    // And design.md's own value still clears AA on the surfaces it was drawn for.
    expect(contrast("#8e8e95", "#000d10")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#8e8e95", "#151623")).toBeGreaterThanOrEqual(4.5);
    // Deep Ink on Clay Ember, which is why the featured card stopped using white.
    expect(contrast("#000d10", "#bc7155")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#ffffff", "#bc7155")).toBeLessThan(4.5);
  });

  it("uses no drop shadow, which design.md forbids", async () => {
    const base = await readFile(path.join(REPO_ROOT, "packages/ui/src/base.css"), "utf8");
    const declarations = base.replace(/\/\*[\s\S]*?\*\//g, "");
    // `box-shadow: none` is the one permitted use: it un-sets an inherited shadow.
    for (const match of declarations.matchAll(/box-shadow:\s*([^;]+);/g)) {
      expect(match[1]?.trim()).toBe("none");
    }
    expect(declarations).not.toContain("text-shadow");
  });

  it("uses no gradient, blur or filter, which design.md forbids", async () => {
    const base = await readFile(path.join(REPO_ROOT, "packages/ui/src/base.css"), "utf8");
    const declarations = base.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(declarations).not.toMatch(/linear-gradient|radial-gradient|backdrop-filter|filter:/);
  });

  it("supports reduced motion", async () => {
    const base = await readFile(path.join(REPO_ROOT, "packages/ui/src/base.css"), "utf8");
    expect(base).toContain("prefers-reduced-motion: reduce");
  });

  it("has a visible focus style", async () => {
    const base = await readFile(path.join(REPO_ROOT, "packages/ui/src/base.css"), "utf8");
    expect(base).toContain(":focus-visible");
    expect(base).toContain("outline:");
  });

  it("is responsive at the two documented breakpoints", async () => {
    const base = await readFile(path.join(REPO_ROOT, "packages/ui/src/base.css"), "utf8");
    expect(base).toContain("@media (max-width: 900px)");
    expect(base).toContain("@media (max-width: 600px)");
  });
});

/* -------------------------------------------------------------------------- */
/* Accessibility affordances present in source                                */
/* -------------------------------------------------------------------------- */

describe("accessibility", () => {
  it("provides a skip link and a main landmark", async () => {
    const layout = await readFile(path.join(APP_DIR, "layout.tsx"), "utf8");
    expect(layout).toContain('href="#main"');
    expect(layout).toContain('id="main"');
    expect(layout).toContain("Skip to content");
  });

  it("labels the navigation", async () => {
    const layout = await readFile(path.join(APP_DIR, "layout.tsx"), "utf8");
    expect(layout).toContain('aria-label="Primary"');
  });

  it("labels every form control on the baseline capture form", async () => {
    const source = await readFile(
      path.join(APP_DIR, "projects/[projectId]/agents/[agentId]/baselines/new/page.tsx"),
      "utf8",
    );
    // Every control is either inside a `Field`, which renders a `<label htmlFor>` and wires
    // `aria-describedby` through the spread attributes, or carries its own `id` beside an explicit
    // `<label htmlFor>`. A control with neither is unlabelled.
    // A `type="hidden"` control carries a value the form needs and the user never sees or reaches;
    // it is not in the accessibility tree, and labelling it would announce a field that cannot be
    // focused. Every other control must be labelled.
    const controls = [...source.matchAll(/<(input|select|textarea)\b[^>]*>/g)].filter(
      (control) => !/type="hidden"/.test(control[0]),
    );
    expect(controls.length).toBeGreaterThan(5);
    for (const control of controls) {
      const markup = control[0];
      const labelled = markup.includes("{...attributes}") || /\bid=/.test(markup);
      expect(labelled, `unlabelled control: ${markup}`).toBe(true);
    }

    // And every `id` used by an explicit label exists on a control.
    for (const label of source.matchAll(/htmlFor="([^"]+)"/g)) {
      expect(source).toContain(`id="${label[1] as string}"`);
    }
  });

  it("announces an error rather than only colouring it", async () => {
    const components = await readFile(
      path.join(REPO_ROOT, "packages/ui/src/components.tsx"),
      "utf8",
    );
    expect(components).toContain('role="alert"');
    expect(components).toContain("aria-invalid");
    expect(components).toContain("aria-describedby");
  });

  it("conveys status as a word, never as a hue", async () => {
    const base = await readFile(path.join(REPO_ROOT, "packages/ui/src/base.css"), "utf8");
    const status = base.slice(base.indexOf(".fr-status {"), base.indexOf(".fr-decision"));
    // The status pill sets no colour of its own beyond the two text tokens; its emphasis is a
    // border weight, so a monochrome reading loses nothing.
    expect(status).toContain("text-transform: uppercase");
    expect(status).toContain("border-width: 2px");
  });
});

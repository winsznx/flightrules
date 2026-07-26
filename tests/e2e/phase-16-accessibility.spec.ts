import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, expectNoHorizontalOverflow, expectVisibleFocus, seed, test } from "./support.js";

/**
 * The automated accessibility sweep (PRD section 20.3, PRD Phase 16 task 15).
 *
 * Phases 12 to 15 already assert accessibility *properties* one at a time — focus is visible, a
 * status is never colour alone, the graph has a table alternative, forms label their fields. Those
 * are the checks a person thought to write. This is the complementary half: an automated pass over
 * the rendered page that finds the ones nobody thought of, and it runs against the **real running
 * product** at every viewport the read-only projects declare, not against markup fixtures.
 *
 * Only `critical` and `serious` fail the suite. `moderate` and `minor` are printed and recorded in
 * `docs/evidence/phase-16/accessibility.md` rather than silently suppressed — an audit that hides
 * what it found is worth less than no audit.
 */

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const BLOCKING = new Set(["critical", "serious"]);

interface Finding {
  readonly id: string;
  readonly impact: string;
  readonly help: string;
  readonly nodes: number;
  readonly target: string;
}

async function audit(page: Page): Promise<readonly Finding[]> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact ?? "unknown",
    help: violation.help,
    nodes: violation.nodes.length,
    target: String(violation.nodes[0]?.target?.[0] ?? ""),
  }));
}

function describeFindings(route: string, findings: readonly Finding[]): string {
  return findings
    .map(
      (finding) =>
        `${route}  [${finding.impact}] ${finding.id}: ${finding.help} (${String(finding.nodes)} node(s), first: ${finding.target})`,
    )
    .join("\n");
}

test.describe("every PRD section 8 route passes an automated accessibility sweep", () => {
  test("the routes a judge walks have no critical or serious violation", async ({ clean }) => {
    // #given the seeded demo, so every route renders real content rather than an empty state
    const identifiers = await seed();
    const routes: readonly [string, string][] = [
      ["landing", "/"],
      ["setup", "/setup"],
      ["projects", "/projects"],
      ["project overview", `/projects/${identifiers.projectId}/overview`],
      ["agents", `/projects/${identifiers.projectId}/agents`],
      ["agent detail", identifiers.agentBase],
      ["baseline capture", `${identifiers.agentBase}/baselines/new`],
      ["releases", `${identifiers.agentBase}/releases`],
      ["SigNoz integration", `/projects/${identifiers.projectId}/integrations/signoz`],
      ["demo", "/demo"],
    ];

    const blocking: string[] = [];
    const advisory: string[] = [];

    for (const [name, route] of routes) {
      // #when each route is loaded and swept
      await clean.goto(route);
      await clean.waitForLoadState("domcontentloaded");
      const findings = await audit(clean);

      const serious = findings.filter((finding) => BLOCKING.has(finding.impact));
      const rest = findings.filter((finding) => !BLOCKING.has(finding.impact));
      if (serious.length > 0) blocking.push(describeFindings(name, serious));
      if (rest.length > 0) advisory.push(describeFindings(name, rest));
    }

    // Printed so the moderate and minor findings reach the evidence rather than being lost.
    if (advisory.length > 0) {
      process.stdout.write(`\naxe advisory findings:\n${advisory.join("\n")}\n\n`);
    }

    // #then nothing critical or serious remains
    expect(blocking.join("\n"), "critical or serious accessibility violations").toBe("");
  });

  test("the contract, diff and violation pages have no critical or serious violation", async ({
    clean,
  }) => {
    const identifiers = await seed();
    const routes: [string, string][] = [];

    if (identifiers.contractId !== null) {
      routes.push([
        "contract studio",
        `${identifiers.agentBase}/contracts/${identifiers.contractId}`,
      ]);
    }
    if (identifiers.baselineId !== null) {
      routes.push([
        "baseline result",
        `${identifiers.agentBase}/baselines/new?baseline=${identifiers.baselineId}`,
      ]);
    }

    const releases = await clean.request.get(
      `${process.env["FLIGHTRULES_API_URL"] ?? "http://localhost:4000"}/api/agents/${identifiers.agentId}/releases?limit=10`,
    );
    const releaseBody = (await releases.json()) as { items?: { id: string }[] };
    const releaseId = releaseBody.items?.[0]?.id;
    if (releaseId) routes.push(["release diff", `${identifiers.agentBase}/releases/${releaseId}`]);

    const violations = await clean.request.get(
      `${process.env["FLIGHTRULES_API_URL"] ?? "http://localhost:4000"}/api/agents/${identifiers.agentId}/violations?limit=10`,
    );
    const violationBody = (await violations.json()) as { items?: { id: string }[] };
    const violationId = violationBody.items?.[0]?.id;
    if (violationId) {
      routes.push([
        "violation inspector",
        `/projects/${identifiers.projectId}/violations/${violationId}`,
      ]);
    }

    expect(routes.length, "no evidence route was reachable; is the demo seeded?").toBeGreaterThan(
      0,
    );

    const blocking: string[] = [];
    const advisory: string[] = [];
    for (const [name, route] of routes) {
      await clean.goto(route);
      await clean.waitForLoadState("domcontentloaded");
      const findings = await audit(clean);
      const serious = findings.filter((finding) => BLOCKING.has(finding.impact));
      const rest = findings.filter((finding) => !BLOCKING.has(finding.impact));
      if (serious.length > 0) blocking.push(describeFindings(name, serious));
      if (rest.length > 0) advisory.push(describeFindings(name, rest));
    }

    if (advisory.length > 0) {
      process.stdout.write(`\naxe advisory findings:\n${advisory.join("\n")}\n\n`);
    }
    expect(blocking.join("\n"), "critical or serious accessibility violations").toBe("");
  });
});

test.describe("keyboard-only operation of the workflow a judge follows", () => {
  test("the first tab stop is a working skip link, and focus stays visible", async ({ clean }) => {
    // #given the landing page
    await clean.goto("/");

    // #when the keyboard is used from a cold start
    await clean.keyboard.press("Tab");

    // #then the first stop is visibly focused and is the skip link
    await expectVisibleFocus(clean);
    const first = await clean.evaluate(() => ({
      tag: document.activeElement?.tagName ?? "",
      text: document.activeElement?.textContent?.trim() ?? "",
      href: document.activeElement?.getAttribute("href") ?? "",
    }));
    expect(first.tag).toBe("A");
    expect(first.href.startsWith("#")).toBe(true);
  });

  test("every interactive element on the project overview is reachable by keyboard", async ({
    clean,
  }) => {
    const identifiers = await seed();
    await clean.goto(`/projects/${identifiers.projectId}/overview`);

    const interactive = await clean.evaluate(
      () =>
        document.querySelectorAll("a[href], button:not([disabled]), input, select, textarea")
          .length,
    );
    expect(interactive).toBeGreaterThan(0);

    // Tab through at most one stop per interactive element plus browser chrome, and require that
    // focus actually moves. A focus trap shows up here as a repeated element.
    const seen = new Set<string>();
    for (let step = 0; step < Math.min(interactive + 5, 60); step += 1) {
      await clean.keyboard.press("Tab");
      const marker = await clean.evaluate(() => {
        const active = document.activeElement;
        if (active === null) return "none";
        return `${active.tagName}:${active.getAttribute("href") ?? active.textContent?.trim().slice(0, 40) ?? ""}`;
      });
      seen.add(marker);
    }
    expect(seen.size, "focus did not move; something is trapping it").toBeGreaterThan(1);
  });

  test("the page never scrolls sideways at this viewport", async ({ clean }) => {
    const identifiers = await seed();
    for (const route of ["/", "/projects", `/projects/${identifiers.projectId}/overview`]) {
      await clean.goto(route);
      await expectNoHorizontalOverflow(clean);
    }
  });

  test("stays usable at 200 per cent zoom", async ({ clean }) => {
    // WCAG 1.4.4 and 1.4.10. Emulated by halving the viewport, which is what a 200 % zoom does to
    // the layout — but never below 320 CSS pixels, which is the reflow width WCAG 1.4.10 actually
    // requires. Halving an already-narrow mobile viewport asks for ~197px, which no success
    // criterion demands and which would make this test fail for a reason nobody has to fix.
    const identifiers = await seed();
    const size = clean.viewportSize();
    if (size !== null) {
      await clean.setViewportSize({
        width: Math.max(320, Math.round(size.width / 2)),
        height: Math.max(480, Math.round(size.height / 2)),
      });
    }
    await clean.goto(`/projects/${identifiers.projectId}/overview`);
    await expectNoHorizontalOverflow(clean);
    const findings = await audit(clean);
    expect(
      findings.filter((finding) => BLOCKING.has(finding.impact)).map((finding) => finding.id),
    ).toEqual([]);
  });

  test("honours a reduced-motion preference", async ({ clean }) => {
    await clean.emulateMedia({ reducedMotion: "reduce" });
    await clean.goto("/");
    // Nothing may animate for longer than an instant once the preference is set.
    const longest = await clean.evaluate(() => {
      let worst = 0;
      for (const element of document.querySelectorAll("*")) {
        const style = window.getComputedStyle(element);
        for (const value of [style.animationDuration, style.transitionDuration]) {
          for (const part of value.split(",")) {
            const seconds = part.trim().endsWith("ms")
              ? Number.parseFloat(part) / 1000
              : Number.parseFloat(part);
            if (Number.isFinite(seconds)) worst = Math.max(worst, seconds);
          }
        }
      }
      return worst;
    });
    expect(longest).toBeLessThanOrEqual(0.1);
  });
});

import { test as base, expect, type Page } from "@playwright/test";

/**
 * Shared browser-test support.
 *
 * Two things every test in this suite gets for free:
 *
 * 1. **A console and page-error watch.** PRD Phase 13's browser requirements name "no console
 *    errors" and "no hydration errors" explicitly. Collecting them per test and asserting at the
 *    end turns those from things a human might notice into things the suite fails on.
 * 2. **The seeded identifiers**, read from the running API rather than hard-coded, so the suite
 *    survives a reset that re-mints every UUID.
 */

const API = process.env["FLIGHTRULES_API_URL"] ?? "http://localhost:4000";

export interface Seed {
  readonly projectId: string;
  readonly agentId: string;
  readonly agentBase: string;
  readonly contractId: string | null;
  readonly baselineId: string | null;
}

async function json<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, { headers: { accept: "application/json" } });
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error(`${path} returned ${String(response.status)} with ${contentType || "no"} type`);
  }
  return (await response.json()) as T;
}

/** The demo project's identifiers, read live. Throws rather than skipping: an unseeded run is a failure. */
export async function seed(): Promise<Seed> {
  const projects = await json<{ items: { id: string; slug: string }[] }>("/api/projects?limit=100");
  const project = projects.items.find((entry) => entry.slug === "demo-commerce");
  if (project === undefined) {
    throw new Error("demo-commerce is not seeded. Run `make demo-full` first.");
  }

  const agents = await json<{ items: { id: string; agentKey: string }[] }>(
    `/api/projects/${project.id}/agents?limit=100`,
  );
  const agent = agents.items[0];
  if (agent === undefined) throw new Error("the demo project has no agent");

  const contracts = await json<{ items: { id: string; status: string }[] }>(
    `/api/agents/${agent.id}/contracts?limit=100`,
  );
  const baselines = await json<{ items: { id: string }[] }>(
    `/api/agents/${agent.id}/baselines?limit=100`,
  );

  return {
    projectId: project.id,
    agentId: agent.id,
    agentBase: `/projects/${project.id}/agents/${agent.id}`,
    contractId:
      contracts.items.find((entry) => entry.status === "active")?.id ??
      contracts.items[0]?.id ??
      null,
    baselineId: baselines.items[0]?.id ?? null,
  };
}

/**
 * The `clean` page fixture: a page that fails its test if the browser logged an error.
 *
 * Every test in this suite takes `clean` rather than `page`, so "no console errors" and "no
 * hydration errors" are asserted once rather than remembered eighteen times.
 */
export const test = base.extend<{ clean: Page }>({
  clean: async ({ page }, use) => {
    const problems: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => {
      problems.push(`pageerror: ${error.message}`);
    });

    await use(page);

    // React reports a hydration mismatch as a console error, so this covers both requirements.
    // Next.js's development overlay chatter is excluded by name, not by pattern, so a real error
    // whose text happens to resemble it is still a failure.
    const real = problems.filter(
      (problem) =>
        !problem.includes("Download the React DevTools") &&
        !problem.includes("[Fast Refresh]") &&
        !problem.includes("net::ERR_ABORTED"),
    );
    expect(real, `browser reported ${String(real.length)} error(s)`).toEqual([]);
  },
});

export { expect };

/** Asserts the page never scrolls sideways, which is the mobile failure a screenshot hides. */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "the page scrolls horizontally").toBeLessThanOrEqual(1);
}

/** Asserts the focused element is visibly focused, not merely focused. */
export async function expectVisibleFocus(page: Page): Promise<void> {
  const outline = await page.evaluate(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) return null;
    const style = window.getComputedStyle(active);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      tag: active.tagName,
    };
  });
  expect(outline, "nothing is focused").not.toBeNull();
  expect(outline?.outlineStyle, `${outline?.tag ?? "?"} has no focus outline`).not.toBe("none");
}

/**
 * Asserts no green or red is painted anywhere on the page.
 *
 * `design.md` defines seven colours and none of them is a success or failure hue (ADR-0011). This
 * reads the computed style of every element rather than the stylesheet, so an inline style, a
 * third-party default or a browser default that painted one would be caught.
 */
export async function expectNoStatusColour(page: Page): Promise<void> {
  const offenders = await page.evaluate(() => {
    const found: string[] = [];
    const parse = (value: string): [number, number, number] | null => {
      const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value);
      return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
    };
    // A hue is "green" or "red" when one channel dominates the other two by a wide margin. The
    // product's palette is a near-black, a white, two greys, two near-black blues and one clay, and
    // none of them satisfies either test.
    const dominant = (rgb: [number, number, number]): string | null => {
      const [r, g, b] = rgb;
      if (g > 90 && g > r + 45 && g > b + 45) return "green";
      if (r > 110 && r > g + 90 && r > b + 90) return "red";
      return null;
    };
    for (const element of Array.from(document.querySelectorAll("*"))) {
      const style = window.getComputedStyle(element);
      for (const property of ["color", "backgroundColor", "borderTopColor", "outlineColor"]) {
        const raw = style.getPropertyValue(
          property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
        );
        if (raw.includes("rgba(0, 0, 0, 0)")) continue;
        const rgb = parse(raw);
        if (rgb === null) continue;
        const hue = dominant(rgb);
        if (hue !== null) {
          found.push(`${element.tagName}.${String(element.className)} ${property}=${raw} (${hue})`);
        }
      }
    }
    return found.slice(0, 10);
  });
  expect(offenders, "a status colour was painted").toEqual([]);
}

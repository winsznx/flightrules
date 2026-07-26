import {
  expect,
  expectNoHorizontalOverflow,
  expectNoStatusColour,
  expectVisibleFocus,
  seed,
  test,
} from "./support";

/**
 * The Phase 13 surfaces at every width, and by keyboard.
 *
 * Separated from `phase-13-workflow.spec.ts` because that file is **destructive**: it purges the
 * managed SigNoz artefacts and resets the demo database, which is exactly what its exit gate
 * requires and exactly what would invalidate every read-only test that ran after it. This file
 * reads; that one rebuilds. The Playwright configuration runs the read-only projects first and the
 * destructive one last, so the two cannot interfere whichever order a developer asks for.
 */

test.describe("presentation, at every width", () => {
  test("the baseline page is usable by keyboard and never scrolls sideways", async ({
    clean: page,
  }) => {
    const demo = await seed();
    await page.goto(`${demo.agentBase}/baselines/new`);
    await expect(page.getByTestId("route-baseline-new")).toBeVisible();

    // #then nothing overflows, at this project's viewport
    await expectNoHorizontalOverflow(page);

    // #and the first tab stop is the skip link, which is visibly focused
    await page.keyboard.press("Tab");
    await expectVisibleFocus(page);
    await expect(page.locator(":focus")).toHaveText("Skip to content");

    // #and every form control is reachable and labelled
    for (const label of [
      "Release ID",
      "Environment",
      "Time range",
      "Minimum completed runs",
      "Rare route threshold",
      "Maximum traces to fetch",
      "Include successful runs only",
      "Exclude traces with missing root span",
    ]) {
      await expect(page.getByLabel(label)).toBeVisible();
    }

    // #and no status hue is painted
    await expectNoStatusColour(page);
  });

  test("the Contract Studio is readable and colourless at every width", async ({ clean: page }) => {
    const demo = await seed();
    test.skip(demo.contractId === null, "no contract is seeded");
    await page.goto(`${demo.agentBase}/contracts/${demo.contractId ?? ""}`);
    await expect(page.getByTestId("route-contract-studio")).toBeVisible();

    await expectNoHorizontalOverflow(page);
    await expectNoStatusColour(page);

    // The status is a word in upper case, never a colour.
    await expect(page.getByTestId("contract-status")).toHaveText(/^[A-Z ]+$/);
  });

  test("an unknown identifier shows the product's not-found state, not a crash", async ({
    clean: page,
  }) => {
    const demo = await seed();
    await page.goto(`${demo.agentBase}/contracts/00000000-0000-7000-8000-000000000000`);
    await expect(page.getByTestId("not-found-state")).toBeVisible();
  });
});

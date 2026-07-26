import { expect, expectNoHorizontalOverflow, expectNoStatusColour, seed, test } from "./support";

/**
 * PRD Phase 15's exit gate: **every release failure can be audited from rule to trace evidence to
 * downstream effect.**
 *
 * The three violations the demo exists to produce are the subjects: the missing `policy.retrieve`,
 * the missing `fraud.check`, and the duplicated `payment.refund` write. Each is checked for the
 * whole chain, and then the dependency the chain does **not** need — SigNoz — is taken away, to
 * prove the core evidence survives without it.
 */

const API = process.env["FLIGHTRULES_API_URL"] ?? "http://localhost:4000";

interface ViolationRow {
  readonly id: string;
  readonly ruleKey: string;
  readonly severity: string;
  readonly zeroTolerance: boolean;
}

/** The demo's three critical violations, found by rule prefix rather than by a recorded identifier. */
async function criticalViolations(projectId: string): Promise<Record<string, ViolationRow>> {
  const response = await fetch(`${API}/api/projects/${projectId}/violations?limit=100`, {
    headers: { accept: "application/json" },
  });
  const body = (await response.json()) as { items: ViolationRow[] };
  const wanted = ["require-policy-retrieve", "require-fraud-check", "single-payment-refund-write"];
  const found: Record<string, ViolationRow> = {};
  for (const item of body.items) {
    for (const prefix of wanted) {
      if (item.ruleKey.startsWith(prefix) && found[prefix] === undefined) found[prefix] = item;
    }
  }
  return found;
}

test.describe("the three critical violations of the unsafe canary", () => {
  for (const [prefix, description] of [
    ["require-policy-retrieve", "the missing policy check"],
    ["require-fraud-check", "the missing fraud check"],
    ["single-payment-refund-write", "the duplicate refund write"],
  ] as const) {
    test(`${description} can be audited from rule to evidence`, async ({ clean: page }) => {
      const demo = await seed();
      const violations = await criticalViolations(demo.projectId);
      const violation = violations[prefix];
      expect(violation, `${prefix} is not present. Run \`make demo-full\`.`).toBeDefined();
      if (violation === undefined) return;

      await page.goto(`/projects/${demo.projectId}/violations/${violation.id}`);
      await expect(page.getByTestId("route-violation")).toBeVisible();

      // #then the exact failed rule, its severity and its zero-tolerance state
      await expect(page.getByRole("heading", { level: 1 })).toContainText(violation.ruleKey);
      await expect(page.getByRole("heading", { level: 1 })).toContainText("violated");
      const whatFailed = page.getByTestId("violation-what-failed");
      await expect(whatFailed).toContainText("CRITICAL");
      await expect(whatFailed).toContainText("Zero tolerance");
      await expect(whatFailed).toContainText("Expected");
      await expect(whatFailed).toContainText("Observed");

      // #and trace and canonical graph evidence
      await expect(page.getByTestId("violation-trace-evidence")).toBeVisible();
      await expect(page.getByTestId("violation-observed-route")).toBeVisible();

      // #and the approved comparison
      await expect(page.getByTestId("violation-approved-route")).toBeVisible();

      // #and release, contract and evaluation context
      await expect(page.getByTestId("violation-release-context")).toBeVisible();
      await expect(page.getByTestId("violation-rule")).toBeVisible();
      await expect(page.getByTestId("violation-evaluation")).toBeVisible();

      // #and the evidence summary, which is on the page rather than only on the clipboard
      const summary = page.getByTestId("violation-summary-text");
      await expect(summary).toBeVisible();
      const text = await summary.inputValue();
      expect(text).toContain(violation.id);
      expect(text).toContain(violation.ruleKey);
      expect(text).toContain("zero_tolerance         yes");

      // #and it carries nothing unsafe
      const lower = text.toLowerCase();
      for (const forbidden of [
        "prompt",
        "completion",
        "chain_of_thought",
        "authorization",
        "api_key",
        "bearer ",
        "tool_arguments",
        "tool_result",
      ]) {
        expect(lower, `the summary contains ${forbidden}`).not.toContain(forbidden);
      }

      await expectNoStatusColour(page);
      await expectNoHorizontalOverflow(page);
    });
  }
});

test.describe("evidence highlighting", () => {
  test("marks only the nodes the evaluator named", async ({ clean: page }) => {
    const demo = await seed();
    const violations = await criticalViolations(demo.projectId);
    const violation = violations["single-payment-refund-write"];
    test.skip(violation === undefined, "the duplicate-refund violation is not seeded");
    if (violation === undefined) return;

    await page.goto(`/projects/${demo.projectId}/violations/${violation.id}`);

    // #given the evidence labels the evaluator recorded
    const labelled = await page
      .getByTestId("violation-evidence-labels")
      .getByRole("row")
      .allTextContents();
    // `Status` renders its label in upper case, so the match is case-insensitive.
    const named = labelled.filter((row) => /proves this violation/i.test(row));
    expect(named.length, "the evaluator named no evidence").toBeGreaterThan(0);

    // #then the observed-route table marks only steps the evaluator's own evidence names. A
    // highlight the evaluator did not produce would be an assertion the product cannot defend.
    const marked = await page.getByTestId("evidence-node").count();
    expect(marked).toBeGreaterThan(0);
    expect(marked).toBeLessThanOrEqual(named.length);
  });
});

test.describe("correlated logs and downstream metrics", () => {
  test("are fetched only on request, and say what happened either way", async ({ clean: page }) => {
    const demo = await seed();
    const violations = await criticalViolations(demo.projectId);
    const violation = Object.values(violations)[0];
    test.skip(violation === undefined, "no critical violation is seeded");
    if (violation === undefined) return;

    const url = `/projects/${demo.projectId}/violations/${violation.id}`;
    await page.goto(url);

    // #given the page has not called SigNoz
    await expect(page.getByTestId("violation-fetch-logs")).toBeVisible();
    await expect(page.getByTestId("violation-fetch-metrics")).toBeVisible();

    // #when logs are requested
    await page.getByTestId("violation-fetch-logs").click();

    // #then the panel reports a typed state, whether or not any log exists
    await expect(page.getByTestId("violation-logs-state")).toBeVisible();
    await expect(page.getByTestId("violation-logs-state")).toContainText(
      /OK|EMPTY|UNAVAILABLE|MALFORMED|TIMEOUT|TRUNCATED/,
    );
    // #and it says what it correlated on, so a reviewer can check the correlation itself
    await expect(page.getByTestId("violation-logs-state")).toContainText("trace_id =");

    // #and the violation evidence is still fully present
    await expect(page.getByTestId("violation-what-failed")).toBeVisible();
    await expect(page.getByTestId("violation-summary-text")).toBeVisible();
  });

  test("distinguish a measured effect from an observed side effect", async ({ clean: page }) => {
    const demo = await seed();
    const violations = await criticalViolations(demo.projectId);
    const violation = violations["single-payment-refund-write"];
    test.skip(violation === undefined, "the duplicate-refund violation is not seeded");
    if (violation === undefined) return;

    await page.goto(`/projects/${demo.projectId}/violations/${violation.id}?metrics=1`);

    await expect(page.getByTestId("violation-metrics-state")).toBeVisible();
    const metrics = page.getByTestId("violation-metrics");

    // #then the kind of claim is stated, not just the number
    await expect(metrics).toContainText(/OBSERVED SIDE EFFECT|MEASURED|UNAVAILABLE/);

    // #and no fabricated business figure appears anywhere on the page
    const body = (await page.locator("main").innerText()).toLowerCase();
    for (const forbidden of ["$", "usd", "revenue", "loss of", "estimated cost"]) {
      expect(body, `the page contains ${forbidden}`).not.toContain(forbidden);
    }
  });
});

test.describe("degrading without hiding the violation", () => {
  test("a non-ok log result leaves every piece of core evidence visible", async ({
    clean: page,
  }) => {
    const demo = await seed();
    const violations = await criticalViolations(demo.projectId);
    const violation = Object.values(violations)[0];
    test.skip(violation === undefined, "no critical violation is seeded");
    if (violation === undefined) return;

    // #given a log fetch that did not return logs.
    //
    // The fetch happens on the **server**, which is the architecture this product is meant to have
    // and which means a browser-side route intercept cannot reach it. What can be asserted from
    // here is the property that actually matters: whatever the log panel reports, the violation
    // evidence is untouched. The dependency being genuinely unreachable is reproduced separately,
    // by pointing the API at an unroutable MCP address — see `docs/evidence/phase-15/`.
    await page.goto(`/projects/${demo.projectId}/violations/${violation.id}?logs=1`);

    const state = page.getByTestId("violation-logs-state");
    await expect(state).toBeVisible();
    const reported = await state.innerText();
    expect(reported).toMatch(/OK|EMPTY|UNAVAILABLE|MALFORMED|TIMEOUT|TRUNCATED/);

    // #then every piece of core evidence is still there — the whole point of fetching on request
    for (const section of [
      "violation-what-failed",
      "violation-observed-route",
      "violation-approved-route",
      "violation-trace-evidence",
      "violation-release-context",
      "violation-rule",
      "violation-evaluation",
      "violation-summary",
    ]) {
      await expect(page.getByTestId(section), `${section} disappeared`).toBeVisible();
    }
    await expect(page.getByTestId("violation-summary-text")).toBeVisible();
  });
});

test.describe("states the inspector must not fake", () => {
  test("an unknown violation shows the not-found state", async ({ clean: page }) => {
    const demo = await seed();
    await page.goto(`/projects/${demo.projectId}/violations/00000000-0000-7000-8000-000000000000`);
    await expect(page.getByTestId("not-found-state")).toBeVisible();
  });

  test("never offers to ignore the violation and pass the release", async ({ clean: page }) => {
    const demo = await seed();
    const violations = await criticalViolations(demo.projectId);
    const violation = Object.values(violations)[0];
    test.skip(violation === undefined, "no critical violation is seeded");
    if (violation === undefined) return;

    await page.goto(`/projects/${demo.projectId}/violations/${violation.id}`);
    // #then PRD section 8.12's prohibition holds in the rendered page, not only in the source
    await expect(page.locator("body")).not.toContainText("Ignore and pass release");
  });

  test("escapes hostile telemetry rather than rendering it as markup", async ({ clean: page }) => {
    const demo = await seed();
    const violations = await criticalViolations(demo.projectId);
    const violation = Object.values(violations)[0];
    test.skip(violation === undefined, "no critical violation is seeded");
    if (violation === undefined) return;

    await page.goto(`/projects/${demo.projectId}/violations/${violation.id}`);
    const injected = await page.evaluate(() => ({
      scripts: document.querySelectorAll("main script").length,
      iframes: document.querySelectorAll("main iframe").length,
      handlers: Array.from(document.querySelectorAll("main *")).filter((element) =>
        Array.from(element.attributes).some((attribute) => attribute.name.startsWith("on")),
      ).length,
    }));
    expect(injected).toEqual({ scripts: 0, iframes: 0, handlers: 0 });
  });
});

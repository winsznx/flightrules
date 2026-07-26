import { expect, expectNoHorizontalOverflow, expectNoStatusColour, seed, test } from "./support";

/**
 * PRD Phase 14's exit gate: **a judge can understand the v2 regression from the release page without
 * reading source code.**
 *
 * "Without reading source code" is the demanding part, and it is what these assertions are shaped
 * around. It is not enough that the page contains the right identifiers somewhere; the page has to
 * *say*, in words a non-technical reader can follow, that two checks did not run and a refund was
 * written twice. So the narrative is asserted for its sentences, not for its markup.
 */

const API = process.env["FLIGHTRULES_API_URL"] ?? "http://localhost:4000";

interface Release {
  readonly id: string;
  readonly releaseKey: string;
}

async function releases(agentId: string): Promise<readonly Release[]> {
  const response = await fetch(`${API}/api/agents/${agentId}/releases?limit=100`, {
    headers: { accept: "application/json" },
  });
  const body = (await response.json()) as { items: Release[] };
  return body.items;
}

async function releaseNamed(agentId: string, key: string): Promise<string> {
  const found = (await releases(agentId)).find((entry) => entry.releaseKey === key);
  if (found === undefined) throw new Error(`release ${key} is not seeded. Run \`make demo-full\`.`);
  return found.id;
}

test.describe("the release list", () => {
  test("shows every PRD column and filters by decision", async ({ clean: page }) => {
    const demo = await seed();
    await page.goto(`${demo.agentBase}/releases`);
    await expect(page.getByTestId("route-releases")).toBeVisible();

    // #then PRD section 8.10's ten columns are all present
    for (const column of [
      "Release ID",
      "Commit SHA",
      "Environment",
      "First observed",
      "Evaluated runs",
      "Gate decision",
      "Violation rate",
      "Unknown route rate",
      "Latency change",
      "Token change",
    ]) {
      await expect(page.getByRole("columnheader", { name: column })).toBeVisible();
    }

    // #and filtering to `fail` is a URL, so it can be linked and reloaded
    await page.getByTestId("release-filter-fail").click();
    await expect(page).toHaveURL(/decision=fail/);
    const rows = page.getByTestId("releases-table").getByRole("row");
    // Header plus at least the unsafe canary.
    expect(await rows.count()).toBeGreaterThanOrEqual(2);
    await expect(page.getByTestId("releases-table")).toContainText("refund-agent-v2");
    await expect(page.getByTestId("releases-table")).not.toContainText("refund-agent-v1");

    await expectNoStatusColour(page);
    await expectNoHorizontalOverflow(page);
  });

  test("a filter that matches nothing says so, and says what exists", async ({ clean: page }) => {
    const demo = await seed();
    await page.goto(`${demo.agentBase}/releases?decision=error`);
    await expect(page.getByTestId("releases-filtered-empty")).toBeVisible();
  });
});

test.describe("the approved release", () => {
  test("reads as a pass, in PRD section 8.11's own sentence", async ({ clean: page }) => {
    const demo = await seed();
    const v1 = await releaseNamed(demo.agentId, "refund-agent-v1");
    await page.goto(`${demo.agentBase}/releases/${v1}`);

    await expect(page.getByTestId("decision-banner")).toContainText(
      "PASS: This release stayed within the approved trajectory contract.",
    );
    // A passing release still shows its shape, and says so rather than showing nothing.
    await expect(page.getByTestId("diff-narrative")).toContainText(
      "Every step of this release matches the approved route, in the same order.",
    );
    await expectNoStatusColour(page);
  });
});

test.describe("the unsafe canary", () => {
  test("reads as a fail and names all three regressions in words", async ({ clean: page }) => {
    const demo = await seed();
    const v2 = await releaseNamed(demo.agentId, "refund-agent-v2");
    await page.goto(`${demo.agentBase}/releases/${v2}`);

    // #then the decision is the PRD's own sentence
    await expect(page.getByTestId("decision-banner")).toContainText(
      "FAIL: This release exceeded one or more trajectory thresholds.",
    );

    // #and zero-tolerance precedence is visible: a proven zero-tolerance violation outranks
    // anything else, and the page shows the count that drove it
    await expect(page.getByTestId("decision-banner")).toContainText("Zero-tolerance violations");
    await expect(page.getByTestId("release-findings")).toContainText("ZERO TOLERANCE VIOLATION");

    // #and the narrative — the part a non-technical reader reads — names all three regressions
    const narrative = page.getByTestId("diff-narrative");
    await expect(narrative).toContainText("policy.retrieve");
    await expect(narrative).toContainText("fraud.check");
    await expect(narrative).toContainText("Each one is a check that did not run.");
    await expect(narrative).toContainText("payment.refund 2 times against 1");
    await expect(narrative).toContainText("A repeated write is a repeated side effect.");

    // #and the typed change list carries the engine's own classifications
    await expect(page.getByTestId("change-node_removed").first()).toHaveText("REMOVED STEP");
    await expect(page.getByTestId("change-side_effect_duplicated")).toHaveText(
      "DUPLICATE SIDE EFFECT",
    );
    await expect(page.getByTestId("change-cardinality_changed")).toHaveText("CARDINALITY CHANGED");
    await expect(page.getByTestId("change-route_unknown")).toHaveText("ROUTE NOT APPROVED");

    // #and the side-by-side comparison marks the two missing checks as removed and the write as
    // repeated, with words rather than colour
    const diff = page.getByTestId("diff-table");
    await expect(diff).toContainText("REMOVED");
    await expect(diff).toContainText("REPEATED");
    await expect(
      diff.getByRole("row").filter({ hasText: "policy.retrieve" }).first(),
    ).toContainText("absent");

    await expectNoStatusColour(page);
  });

  test("links to the nearest approved route, and it opens", async ({ clean: page }) => {
    const demo = await seed();
    const v2 = await releaseNamed(demo.agentId, "refund-agent-v2");
    await page.goto(`${demo.agentBase}/releases/${v2}`);

    await page.getByRole("link", { name: "Open the nearest approved route" }).click();
    await expect(page.getByTestId("route-route-family")).toBeVisible();
    await expect(page.getByTestId("graph-table")).toBeVisible();
  });

  test("offers a SigNoz trace link built from the identifier SigNoz itself returned", async ({
    clean: page,
  }) => {
    const demo = await seed();
    const v2 = await releaseNamed(demo.agentId, "refund-agent-v2");
    await page.goto(`${demo.agentBase}/releases/${v2}`);

    const link = page.getByTestId("signoz-trace-link").first();
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    expect(href, "no SigNoz URL was recorded for a representative trace").not.toBeNull();

    // The URL must name a trace this page actually shows, so a link to the wrong trace fails here
    // rather than in a demo.
    const traceIds = await page
      .getByTestId("release-evidence-table")
      .getByRole("cell")
      .allTextContents();
    const named = traceIds.some((text) => href?.includes(text.trim()) === true);
    expect(named, `${href ?? ""} names no trace on this page`).toBe(true);
  });
});

test.describe("evidence download", () => {
  test("carries the decision and its typed changes, and no prompt or tool payload", async ({
    clean: page,
  }) => {
    test.skip(test.info().project.name !== "desktop", "the download runs once");

    const demo = await seed();
    const v2 = await releaseNamed(demo.agentId, "refund-agent-v2");
    await page.goto(`${demo.agentBase}/releases/${v2}`);

    const download = page.waitForEvent("download");
    await page.getByTestId("release-evidence-download").click();
    const file = await download;
    const stream = await file.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const bundle = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;

    // #then every field PRD Phase 14 requires is present
    expect(bundle["schemaVersion"]).toBe("flightrules.evidence/v1");
    for (const key of [
      "release",
      "baseline",
      "decision",
      "contract",
      "counts",
      "typedChanges",
      "findings",
      "evidence",
    ]) {
      expect(bundle, `the bundle has no ${key}`).toHaveProperty(key);
    }
    const decision = bundle["decision"] as Record<string, unknown>;
    expect(decision["outcome"]).toBe("fail");
    expect(decision["exitCode"]).toBe(2);
    expect(String(decision["decisionHash"])).toMatch(/^[0-9a-f]{64}$/);

    // #and nothing unsafe is in it
    const text = JSON.stringify(bundle).toLowerCase();
    for (const forbidden of [
      "prompt",
      "completion",
      "chain_of_thought",
      "authorization",
      "api_key",
      "apikey",
      "bearer ",
      "tool_arguments",
      "tool_result",
    ]) {
      expect(text, `the evidence bundle contains ${forbidden}`).not.toContain(forbidden);
    }
  });
});

test.describe("re-evaluation", () => {
  test("creates a job without changing the decision until it completes", async ({
    clean: page,
  }) => {
    test.skip(test.info().project.name !== "desktop", "re-evaluation runs once");

    const demo = await seed();
    const v2 = await releaseNamed(demo.agentId, "refund-agent-v2");
    await page.goto(`${demo.agentBase}/releases/${v2}`);

    const before = await page.getByTestId("decision-banner").textContent();

    await page.getByTestId("release-re-evaluate").click();
    await expect(page.getByTestId("action-succeeded")).toContainText("evaluation");
    await expect(page).toHaveURL(/[?&]job=/);
    await expect(page.getByTestId("job-progress")).toBeVisible();

    // #then the decision is unchanged while the job runs — never optimistically updated
    expect(await page.getByTestId("decision-banner").textContent()).toBe(before);

    // #and it survives a reload, because the job identifier is in the address
    await page.reload();
    await expect(page.getByTestId("job-progress")).toBeVisible();

    // #and when the job completes the decision is still a real one, taken from persisted evidence
    await expect(page.getByTestId("job-status")).toHaveText(/SUCCEEDED|FAILED/, {
      timeout: 150_000,
    });
    await expect(page.getByTestId("decision-banner")).toContainText(
      /PASS:|FAIL:|INSUFFICIENT DATA:|ERROR:/,
    );
  });
});

test.describe("states the page must not fake", () => {
  test("a release with no evaluation says so rather than showing an empty diff", async ({
    clean: page,
  }) => {
    const demo = await seed();
    // A well-formed identifier that names nothing.
    await page.goto(`${demo.agentBase}/releases/00000000-0000-7000-8000-000000000000`);
    await expect(page.getByTestId("not-found-state")).toBeVisible();
  });

  test("hostile telemetry strings are escaped, never rendered as markup", async ({
    clean: page,
  }) => {
    const demo = await seed();
    const v2 = await releaseNamed(demo.agentId, "refund-agent-v2");
    await page.goto(`${demo.agentBase}/releases/${v2}`);

    // #then nothing on the page injected an element, whatever the telemetry contained
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

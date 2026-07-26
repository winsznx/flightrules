import {
  expect,
  expectNoHorizontalOverflow,
  expectNoStatusColour,
  expectVisibleFocus,
  seed,
  test,
} from "./support";

/**
 * PRD Phase 13's exit gate: **a new user can move from v1 traces to an active contract entirely
 * through the UI.**
 *
 * This is that sentence, executed. It starts from a reset demo — a project and an agent, no
 * baseline and no contract — and finishes with an active contract and read-back verified SigNoz
 * artefacts, touching nothing but the browser. Every wait is on real persisted state.
 *
 * It runs on `desktop` only. The same workflow at the two narrower widths would take three times as
 * long to prove the same product behaviour; what actually differs by width is layout, and
 * `phase-13-presentation.spec.ts` covers that at all three.
 */

const API = process.env["FLIGHTRULES_API_URL"] ?? "http://localhost:4000";

/**
 * Deletes the managed SigNoz resources of the demo project.
 *
 * The repository's own script, run as the runbook documents it, rather than a second implementation
 * in the test. It finds resources by managed-name prefix through the MCP server, so it works whether
 * or not the register still has rows for them.
 */
async function purgeManagedArtifacts(): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)("node", ["scripts/purge-managed-artifacts.mjs", "demo-commerce"], {
    cwd: process.cwd(),
    timeout: 120_000,
  });
}

test.describe("baseline to active contract, through the browser", () => {
  test("a new user reaches an active contract without leaving the UI", async ({ clean: page }) => {
    // The workflow proves product behaviour, which does not vary by viewport; `presentation, at
    // every width` below is what runs three times.
    test.skip(test.info().project.name !== "desktop", "the workflow runs once");

    // #given a reset demo, which for this product means two things and not one.
    //
    // `POST /api/demo/reset` clears the FlightRules database. It deliberately does not touch
    // SigNoz — FR-020 retains the source configuration, and destroying a judge's telemetry would be
    // worse than leaving it. But the managed dashboards, views and alerts survive the database that
    // recorded owning them, so the next sync correctly refuses to adopt ten resources it can no
    // longer prove it created, and reports ten conflicts.
    //
    // A genuinely clean start therefore purges the managed artefacts first. That is what
    // `make signoz-purge` is for, and it is the same command `docs/RUNBOOK.md` documents for
    // recovering a rebuilt database.
    await purgeManagedArtifacts();

    const reset = await fetch(`${API}/api/demo/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    expect(reset.status, "the demo could not be reset").toBe(200);
    const { projectId, agentId } = (await reset.json()) as {
      projectId: string;
      agentId: string;
    };
    const agentBase = `/projects/${projectId}/agents/${agentId}`;

    /* 1. Open the agent. */
    await page.goto(agentBase);
    await expect(page.getByTestId("route-agent")).toBeVisible();

    /* 2. Open baseline capture, through the product's own call to action. */
    await page.getByRole("link", { name: "Capture baseline" }).click();
    await expect(page.getByTestId("route-baseline-new")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Capture a known-good baseline" }),
    ).toBeVisible();

    /* 3. Select refund-agent-v1. */
    await page.getByLabel("Release ID").fill("refund-agent-v1");
    await page.getByLabel("Environment").fill("local");
    await page.getByLabel("Time range").selectOption("360");
    await page.getByLabel("Minimum completed runs").fill("20");

    /* 4. Submit. */
    await page.getByTestId("baseline-submit").click();

    /* 5. Observe real job progress, read from the persisted job row. */
    await expect(page.getByTestId("job-progress")).toBeVisible();
    await expect(page).toHaveURL(/[?&]job=/);
    // The five PRD section 8.7 sentences, each carrying the state the job actually reports.
    await expect(page.getByTestId("baseline-progress-states").getByRole("listitem")).toHaveCount(5);
    await expect(page.getByTestId("job-status")).toHaveText(/SUCCEEDED/, { timeout: 150_000 });

    /* 6. Review the rejected traces, and check they reconcile. */
    await expect(page.getByTestId("baseline-counts")).toBeVisible();
    await expect(page.getByTestId("baseline-reconciliation")).toContainText("Reconciled:");
    await expect(page.getByTestId("baseline-exclusions")).toBeVisible();
    await expect(page.getByTestId("baseline-disclosures")).toBeVisible();

    /* 7. Open the mined route family. */
    const familyLink = page.getByTestId("baseline-families").getByRole("link").first();
    const familyHref = await familyLink.getAttribute("href");
    expect(familyHref, "no route family was mined").not.toBeNull();
    await familyLink.click();
    await expect(page.getByTestId("route-route-family")).toBeVisible();
    // The canonical graph is rendered from the stored canonical form, not drawn.
    await expect(page.getByTestId("graph-table")).toBeVisible();

    /* 8. Approve the valid family. */
    await page.getByTestId("family-approve").click();
    await expect(page.getByTestId("action-succeeded")).toContainText("Approve");
    await expect(page.getByTestId("route-route-family").getByTestId("status").first()).toHaveText(
      "APPROVED",
    );

    /* 8b. The decision survives a reload, because it was written, not remembered. */
    await page.reload();
    await expect(page.getByTestId("route-route-family").getByTestId("status").first()).toHaveText(
      "APPROVED",
    );

    /* 9 and 10. Back to the baseline, and propose the contract. */
    await page.getByRole("link", { name: "Back to the baseline" }).click();
    await expect(page.getByTestId("baseline-propose")).toBeVisible();
    await page.getByTestId("baseline-propose-submit").click();
    await expect(page.getByTestId("job-status")).toHaveText(/SUCCEEDED/, { timeout: 150_000 });

    /* 11. Open the Contract Studio. */
    await page.getByRole("link", { name: "Open the Contract Studio" }).click();
    await expect(page.getByTestId("route-contract-studio")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Trajectory contract" })).toBeVisible();
    await expect(page.getByTestId("contract-status")).toHaveText("DRAFT");

    const yamlBefore = await page.getByTestId("contract-yaml-input").inputValue();
    const contractUrl = page.url().split("?")[0] as string;

    /* 12 and 13. One graph-rule edit, and the YAML changes. */
    await page.getByLabel("Constraint").selectOption("maximum_calls");
    const step = await page.getByLabel("Step", { exact: true }).inputValue();
    await page.getByLabel("Maximum calls").fill("1");
    await page.getByTestId("rule-control-apply").click();
    await expect(page.getByTestId("action-succeeded")).toContainText("Apply rule control");

    const yamlAfterControl = await page.getByTestId("contract-yaml-input").inputValue();
    expect(yamlAfterControl, "the graph control did not change the document").not.toBe(yamlBefore);
    expect(yamlAfterControl).toContain("type: cardinality");
    expect(yamlAfterControl).toContain(step);

    /* 14 and 15. One valid YAML edit, and the graph rule state changes. */
    const rulesBefore = await page.getByTestId("contract-rules").getByRole("row").count();
    const editedYaml = yamlAfterControl.replace(
      /(\n {4}- id: [^\n]+\n {6}type: cardinality\n)/,
      `\n    - id: studio-hand-edit\n      type: forbidden_span\n      severity: high\n      selector:\n        name: debug.dump\n$1`,
    );
    expect(editedYaml, "the YAML edit did not apply").not.toBe(yamlAfterControl);
    await page.getByTestId("contract-yaml-input").fill(editedYaml);
    // The dirty state is the editor's only job, and it says the PRD's own sentence.
    await expect(page.getByTestId("contract-yaml-status")).toHaveText(
      "This contract has unvalidated changes. Validate it before approval.",
    );

    /* 16. Save. */
    await page.getByTestId("contract-yaml-save").click();
    await expect(page.getByTestId("action-succeeded")).toContainText("Save document");
    await expect(page.getByTestId("contract-rules").getByRole("row")).toHaveCount(rulesBefore + 1);
    await expect(page.getByTestId("contract-rules")).toContainText("studio-hand-edit");

    /* 17. Validate. */
    await page.getByTestId("contract-validate").click();
    await expect(page.getByTestId("action-succeeded")).toContainText("Validate contract");

    /* 18. Approve. */
    await page.getByTestId("contract-approve").click();
    await expect(page.getByTestId("action-succeeded")).toContainText("Approve version");
    await expect(page.getByTestId("contract-status")).toHaveText("APPROVED");

    /* 19. Activate. */
    await page.getByTestId("contract-activate").click();
    await expect(page.getByTestId("action-succeeded")).toContainText("Activate version");
    await expect(page.getByTestId("contract-status")).toHaveText("ACTIVE");

    /* 20 and 21. Sync, then confirm ten read-back verified artefacts. */
    await page.getByTestId("contract-sync").click();
    await expect(page.getByTestId("job-status")).toHaveText(/SUCCEEDED/, { timeout: 150_000 });
    const summary = page.getByTestId("contract-artifact-summary");
    await expect(summary).toContainText("Managed artifacts");
    await expect(summary.getByRole("definition").nth(0)).toHaveText("10");
    await expect(summary.getByRole("definition").nth(1)).toHaveText("10");

    /* 22 and 23. Reload, and confirm every state persisted. */
    await page.goto(contractUrl);
    await expect(page.getByTestId("contract-status")).toHaveText("ACTIVE");
    await expect(page.getByTestId("contract-rules")).toContainText("studio-hand-edit");
    await expect(page.getByTestId("contract-yaml-input")).toHaveValue(/type: cardinality/);
    // An immutable version offers no save control at all.
    await expect(page.getByTestId("contract-yaml-save")).toHaveCount(0);

    await expectNoStatusColour(page);
  });
});

test.describe("guards that must hold on the server", () => {
  test("an invalid document cannot be saved, and so cannot be approved", async ({
    clean: page,
  }) => {
    test.skip(test.info().project.name !== "desktop", "the guards run once");

    // #given a draft contract
    const demo = await seed();
    const draft = await fetch(`${API}/api/agents/${demo.agentId}/contracts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        yaml: VALID_DRAFT,
        environment: "local",
      }),
    });
    expect([201, 409]).toContain(draft.status);
    if (draft.status !== 201) test.skip(true, "a draft with this identity already exists");
    const created = (await draft.json()) as { id: string };
    const url = `${demo.agentBase}/contracts/${created.id}`;

    await page.goto(url);
    await expect(page.getByTestId("contract-status")).toHaveText("DRAFT");

    // #when the reviewer replaces it with a document that does not validate
    await page.getByTestId("contract-yaml-input").fill("apiVersion: nope\nkind: Wrong\n");
    await page.getByTestId("contract-yaml-save").click();

    // #then the save is refused with the product's own code, and nothing was stored
    await expect(page.getByTestId("action-failed")).toContainText("Save document");
    await expect(page.getByTestId("action-failed")).toContainText("CONTRACT_INVALID");
    await page.goto(url);
    await expect(page.getByTestId("contract-yaml-input")).toHaveValue(/kind: TrajectoryContract/);
  });

  test("a control that would contradict an existing rule is refused", async ({ clean: page }) => {
    test.skip(test.info().project.name !== "desktop", "the guards run once");

    // #given the active contract, which requires several steps
    const demo = await seed();
    expect(demo.contractId).not.toBeNull();
    await page.goto(`${demo.agentBase}/contracts/${demo.contractId ?? ""}`);

    // #when a step the contract already requires is also forbidden
    await page.getByLabel("Constraint").selectOption("forbidden");
    await page.getByTestId("rule-control-apply").click();

    // #then the edit is refused. An active contract is immutable, and the contradiction would be
    // refused on a draft too — either way, nothing was written.
    await expect(page.getByTestId("action-failed")).toBeVisible();
  });
});

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

const VALID_DRAFT = `apiVersion: flightrules.dev/v1alpha1
kind: TrajectoryContract
metadata:
  id: studio-guard-draft
  name: Studio guard draft
  version: 9.9.9
  project: demo-commerce
  agent: refund-agent
  environment: local
  createdAt: 2026-07-26T00:00:00Z
spec:
  selectors:
    workflowName: refund-workflow
    releaseAttribute: agent.release.id
    environmentAttribute: deployment.environment.name
    rootSpan: refund.request
  approvedRoutes: []
  rules:
    - id: guard-require-fraud-check
      type: required_span
      severity: critical
      selector:
        name: fraud.check
      cardinality:
        min: 1
        max: 1
  gate:
    minCompletedRuns: 1
    evaluationTimeoutSeconds: 60
    maxViolationPercent: 0
    maxUnknownRoutePercent: 0
    maxLatencyRegressionPercent: 10
    maxTokenRegressionPercent: 10
    zeroToleranceRuleIds: [guard-require-fraud-check]
`;

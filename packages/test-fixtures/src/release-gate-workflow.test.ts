import { describe, expect, it } from "vitest";
import { readRepoFile } from "./deployment.js";

/**
 * The shape of the release-gate workflow (PRD Phase 11 tasks 8 to 10).
 *
 * A workflow cannot be unit-tested by running it, but the failure modes that matter most are
 * structural and are visible in the file: a step that swallows a non-zero exit, a gate that reports
 * success while merely uploading a result, an artifact that carries `.env`, a floating action
 * version. Each of those would make the product's central claim — a release pipeline fails because
 * of trajectory evidence — quietly false, and none of them would be caught by running the workflow
 * on a day when it happened to pass.
 *
 * The behavioural half of the proof is the live exit gate, which runs the same commands locally.
 */

const WORKFLOW = "release-gate.yml";

async function workflow(): Promise<string> {
  return readRepoFile(`.github/workflows/${WORKFLOW}`);
}

describe("release-gate workflow", () => {
  it("exists and runs on pushes and pull requests", async () => {
    const source = await workflow();
    expect(source).toContain("name: Release gate");
    expect(source).toContain("pull_request:");
    expect(source).toContain("workflow_dispatch:");
  });

  it("installs from the committed lockfile", async () => {
    // #then CI resolves the tree this repository was tested against, not a newer one
    const source = await workflow();
    expect(source).toContain("pnpm install --frozen-lockfile");
  });

  it("pins the toolchain to the versions the compatibility matrix records", async () => {
    const source = await workflow();
    expect(source).toContain('NODE_VERSION: "24.14.1"');
    expect(source).toContain('PNPM_VERSION: "10.33.0"');
    expect(source).toContain('FOUNDRY_VERSION: "v0.2.16"');
  });

  it("starts the real dependencies rather than stubbing them", async () => {
    // #then the gate is decided from real telemetry through a real SigNoz deployment
    const source = await workflow();
    expect(source).toContain("foundryctl cast -f casting.yaml");
    expect(source).toContain("scripts/bootstrap-signoz.sh");
    expect(source).toContain("scripts/verify-signoz.sh");
    expect(source).toContain("image: postgres:16");
    expect(source).toContain("scripts/run-demo-v1.sh");
    expect(source).toContain("scripts/run-demo-v2.sh");
  });

  it("runs the same CLI commands a developer runs locally", async () => {
    const source = await workflow();
    for (const command of [
      "config verify",
      "contract validate",
      "release evaluate",
      "gate check",
      "evidence export",
    ]) {
      expect(source).toContain(command);
    }
  });

  it("asserts the canary is rejected with exit code 2 specifically", async () => {
    // #then a 0 would mean the product's claim is false, and any other code would mean it failed
    // for the wrong reason; both fail the job
    const source = await workflow();
    expect(source).toContain('if [ "$code" -ne 2 ]; then');
    expect(source).toContain("a contract violation is exit 2");
  });

  it("never lets a step swallow a failure", async () => {
    // #then no `continue-on-error`, and no `|| true` on a step that decides the outcome
    const source = await workflow();
    // The key form, not the bare phrase: the file's own comment explains why it is absent.
    expect(source).not.toMatch(/^\s*continue-on-error\s*:/m);

    const decidingSteps = source
      .split("\n")
      .filter((line) => line.includes("gate check") || line.includes("-ne 2"));
    for (const line of decidingSteps) {
      expect(line).not.toContain("|| true");
    }
  });

  it("uploads evidence without letting the upload decide the result", async () => {
    // #then the artifact steps run `if: always()`, after the gate steps have already decided
    const source = await workflow();
    const gateIndex = source.indexOf("the canary gate returned");
    const uploadIndex = source.indexOf("upload-artifact");
    expect(gateIndex).toBeGreaterThan(0);
    expect(uploadIndex).toBeGreaterThan(gateIndex);
  });

  it("never uploads or prints the environment file that holds the minted API key", async () => {
    // #then `.env` cannot leave the runner
    const source = await workflow();
    expect(source).not.toMatch(/path:\s*\.env/);
    expect(source).not.toMatch(/cat\s+\.env/);
    expect(source).not.toMatch(/echo\s+.*SIGNOZ_API_KEY/);
    expect(source).not.toContain("upload-artifact@v4\n        with:\n          path: .");
  });

  it("declares no secret and hard-codes none", async () => {
    // #then the workflow needs no repository secret; the SigNoz key is minted per run
    const source = await workflow();
    expect(source).not.toContain("secrets.");
    expect(source).toMatch(/SIGNOZ_ADMIN_PASSWORD: \$\{\{ format\('ci-/);
  });

  it("requests only read permission", async () => {
    const source = await workflow();
    expect(source).toContain("permissions:\n  contents: read");
  });

  it("pins every action to a major version rather than a floating branch", async () => {
    const source = await workflow();
    const uses = [...source.matchAll(/uses:\s*(\S+)/g)].map((match) => match[1] as string);
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) {
      expect(action).toMatch(/@v\d+$/);
    }
  });

  it("tears the stack down whatever happened", async () => {
    const source = await workflow();
    expect(source).toContain("-p signoz down -v");
    expect(source).toContain("compose.app.yaml down -v");
  });

  it("has a documented local reproduction path", async () => {
    // #then a maintainer can run the same sequence without a runner
    const source = await workflow();
    expect(source).toContain("make demo-full");

    const makefile = await readRepoFile("Makefile");
    expect(makefile).toContain("demo-full:");
    expect(makefile).toContain("gate:");
  });
});

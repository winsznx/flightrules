import { describe, expect, it } from "vitest";
import {
  extractComposeImages,
  extractPublishedPorts,
  PINNED_IMAGES,
  PUBLISHED_PORTS,
  readCasting,
  readGeneratedCompose,
  readRepoFile,
} from "./deployment.js";

describe("committed SigNoz casting", () => {
  it("targets Docker Compose so a judge can reproduce it locally", async () => {
    const casting = await readCasting();
    expect(casting).toMatch(/mode:\s*docker/);
    expect(casting).toMatch(/flavor:\s*compose/);
  });

  it("enables the SigNoz MCP Server molding", async () => {
    const casting = await readCasting();
    expect(casting).toMatch(/mcp:\s*\n\s+spec:\s*\n(\s+.*\n)*\s+enabled:\s*true/);
  });

  it("sets an explicit image on every pinned molding, not only a version", async () => {
    const casting = await readCasting();
    // `version:` alone is recorded in the lock but leaves Compose on `:latest` (SL-006).
    expect(casting).toContain("image: signoz/signoz:v0.134.0");
    expect(casting).toContain("image: signoz/signoz-otel-collector:v0.144.6");
    expect(casting).toContain("image: signoz/signoz-mcp-server:v0.9.0");
  });

  it("contains no credential", async () => {
    const casting = await readCasting();
    expect(casting).not.toMatch(/SIGNOZ_API_KEY\s*:/i);
    expect(casting).not.toMatch(/password\s*:/i);
    expect(casting).not.toMatch(/secret\s*:/i);
  });
});

describe("generated deployment", () => {
  it("uses no floating latest tag", async () => {
    const images = extractComposeImages(await readGeneratedCompose());
    expect(images.length).toBeGreaterThan(0);
    expect(images.filter((image) => image.endsWith(":latest"))).toEqual([]);
  });

  it("pins every image the deployment needs", async () => {
    const images = new Set(extractComposeImages(await readGeneratedCompose()));
    for (const expected of PINNED_IMAGES) {
      expect(images).toContain(expected);
    }
  });

  it("gives every image an explicit tag or digest", async () => {
    for (const image of extractComposeImages(await readGeneratedCompose())) {
      expect(image).toMatch(/(:[\w.-]+|@sha256:[a-f0-9]{64})$/);
    }
  });

  it("publishes the ports FlightRules connects to", async () => {
    const ports = new Set(extractPublishedPorts(await readGeneratedCompose()));
    for (const port of Object.values(PUBLISHED_PORTS)) {
      expect(ports).toContain(port);
    }
  });

  it("does not publish ClickHouse, ClickHouse Keeper or the metastore to the host", async () => {
    const ports = new Set(extractPublishedPorts(await readGeneratedCompose()));
    for (const port of [9000, 8123, 9181, 5432]) {
      expect(ports).not.toContain(port);
    }
  });

  it("has a lock file recording the same pinned versions", async () => {
    const lock = await readRepoFile("casting.yaml.lock");
    expect(lock).toContain("v0.134.0");
    expect(lock).toContain("v0.144.6");
    expect(lock).toContain("v0.9.0");
  });
});

describe("Compose parsing helpers", () => {
  it("extracts image values in file order", () => {
    const images = extractComposeImages(
      ["services:", "  a:", "    image: foo:1", "  b:", "    image: bar:2"].join("\n"),
    );
    expect(images).toEqual(["foo:1", "bar:2"]);
  });

  it("extracts published host ports in both quoted and unquoted form", () => {
    const ports = extractPublishedPorts(
      ["    ports:", "    - 4317:4317", '    - "8080:8080"'].join("\n"),
    );
    expect(ports).toEqual([4317, 8080]);
  });

  it("ignores lines that are not image or port declarations", () => {
    expect(extractComposeImages("name: signoz\n  # image: commented:1\n")).toEqual([]);
    expect(extractPublishedPorts("    - CMD-SHELL\n")).toEqual([]);
  });
});

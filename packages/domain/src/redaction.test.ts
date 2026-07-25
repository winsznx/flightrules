import { afterEach, describe, expect, it } from "vitest";
import {
  clearRegisteredSecrets,
  FORBIDDEN_TELEMETRY_KEYS,
  isForbiddenTelemetryKey,
  isSecretKey,
  REDACTED,
  redact,
  redactString,
  registerSecretValue,
} from "./index.js";

afterEach(() => {
  clearRegisteredSecrets();
});

describe("secret redaction", () => {
  it("replaces values under secret-looking keys", () => {
    const result = redact({
      signozApiKey: "abcdef0123456789",
      authorization: "Bearer abc",
      user_password: "hunter2",
      nested: { refreshToken: "xyz", safe: "keep-me" },
    });

    expect(result).toEqual({
      signozApiKey: REDACTED,
      authorization: REDACTED,
      user_password: REDACTED,
      nested: { refreshToken: REDACTED, safe: "keep-me" },
    });
  });

  it("replaces a registered secret value even when the key looks harmless", () => {
    registerSecretValue("s3cr3t-api-key-value");
    const result = redact({ message: "call failed with SIGNOZ-API-KEY: s3cr3t-api-key-value" });
    expect(result).toEqual({ message: `call failed with SIGNOZ-API-KEY: ${REDACTED}` });
  });

  it("redacts a registered secret inside a plain string", () => {
    registerSecretValue("0123456789abcdef");
    expect(redactString("prefix 0123456789abcdef suffix")).toBe(`prefix ${REDACTED} suffix`);
  });

  it("ignores registered values too short to be a credible secret", () => {
    registerSecretValue("abc");
    expect(redactString("abc stays")).toBe("abc stays");
  });

  it("survives a cyclic structure instead of hanging", () => {
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic["self"] = cyclic;
    expect(redact(cyclic)).toEqual({ name: "root", self: "[circular]" });
  });

  it("normalises values that JSON cannot represent", () => {
    expect(redact({ big: 10n, missing: undefined, notANumber: Number.NaN })).toEqual({
      big: "10",
      missing: null,
      notANumber: "NaN",
    });
  });

  it("redacts inside arrays", () => {
    registerSecretValue("leaked-token-value");
    expect(redact(["fine", "leaked-token-value", { apiKey: "x" }])).toEqual([
      "fine",
      REDACTED,
      { apiKey: REDACTED },
    ]);
  });

  it.each([
    "apiKey",
    "SIGNOZ_API_KEY",
    "Authorization",
    "db_password",
    "clientSecret",
    "PRIVATE_KEY",
  ])("treats %s as a secret key", (key) => {
    expect(isSecretKey(key)).toBe(true);
  });

  it.each(["traceId", "spanName", "releaseId", "keyboard"])("treats %s as safe", (key) => {
    expect(isSecretKey(key)).toBe(false);
  });
});

describe("forbidden telemetry keys", () => {
  it("covers every prompt and tool-content field the PRD forbids by default", () => {
    expect(FORBIDDEN_TELEMETRY_KEYS).toEqual(
      expect.arrayContaining([
        "gen_ai.input.messages",
        "gen_ai.output.messages",
        "gen_ai.tool.call.arguments",
        "gen_ai.tool.call.result",
        "gen_ai.prompt",
        "gen_ai.completion",
      ]),
    );
  });

  it("recognises forbidden keys and permits safe GenAI keys", () => {
    expect(isForbiddenTelemetryKey("gen_ai.tool.call.arguments")).toBe(true);
    expect(isForbiddenTelemetryKey("gen_ai.tool.name")).toBe(false);
    expect(isForbiddenTelemetryKey("agent.side_effect")).toBe(false);
  });
});

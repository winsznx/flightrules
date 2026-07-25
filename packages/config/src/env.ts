import { z } from "zod";

/**
 * A SigNoz base URL must be an absolute http(s) URL. Loopback and private addresses are
 * permitted only when FlightRules is running in self-host mode, which is the default for the
 * demo. In hosted mode they are rejected to prevent server-side request forgery through a
 * user-supplied SigNoz URL (PRD section 18.1).
 */
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^\[?::1\]?$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /\.local$/i,
];

export function isPrivateHost(hostname: string): boolean {
  return PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
}

function httpUrl(field: string) {
  return z
    .string()
    .min(1, `${field} must not be empty`)
    .refine(
      (value) => {
        try {
          const url = new URL(value);
          return url.protocol === "http:" || url.protocol === "https:";
        } catch {
          return false;
        }
      },
      { message: `${field} must be an absolute http or https URL` },
    );
}

export const DeploymentModeSchema = z.enum(["self-host", "hosted"]);
export type DeploymentMode = z.infer<typeof DeploymentModeSchema>;

export const RuntimeModeSchema = z.enum(["scripted-demo", "live-provider-demo", "external-agent"]);
export type RuntimeMode = z.infer<typeof RuntimeModeSchema>;

const booleanFromEnv = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((value) => value === true || value === "true" || value === "1");

const positiveInt = (field: string) =>
  z
    .union([z.number().int(), z.string().regex(/^\d+$/, `${field} must be a positive integer`)])
    .transform((value) => (typeof value === "number" ? value : Number.parseInt(value, 10)))
    .refine((value) => value > 0, { message: `${field} must be greater than zero` });

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DEPLOYMENT_MODE: DeploymentModeSchema.default("self-host"),
    RUNTIME_MODE: RuntimeModeSchema.default("scripted-demo"),

    DATABASE_URL: z
      .string()
      .min(1, "DATABASE_URL is required")
      .refine((value) => value.startsWith("postgres://") || value.startsWith("postgresql://"), {
        message: "DATABASE_URL must be a postgres:// or postgresql:// connection string",
      }),

    SIGNOZ_URL: httpUrl("SIGNOZ_URL"),
    SIGNOZ_MCP_URL: httpUrl("SIGNOZ_MCP_URL"),
    SIGNOZ_API_KEY: z.string().min(1, "SIGNOZ_API_KEY is required"),

    OTEL_EXPORTER_OTLP_ENDPOINT: httpUrl("OTEL_EXPORTER_OTLP_ENDPOINT"),
    OTEL_SERVICE_NAME: z.string().min(1).default("flightrules-api"),
    DEPLOYMENT_ENVIRONMENT_NAME: z.string().min(1).default("local"),

    API_PORT: positiveInt("API_PORT").default(4000),
    WEB_PORT: positiveInt("WEB_PORT").default(3000),

    DEMO_MODE: booleanFromEnv.default(false),

    MAX_TRACES_PER_EVALUATION: positiveInt("MAX_TRACES_PER_EVALUATION").default(500),
    MAX_SPANS_PER_TRACE: positiveInt("MAX_SPANS_PER_TRACE").default(5000),
    MCP_REQUEST_TIMEOUT_MS: positiveInt("MCP_REQUEST_TIMEOUT_MS").default(30_000),

    IDEMPOTENCY_HASH_SALT: z
      .string()
      .min(16, "IDEMPOTENCY_HASH_SALT must be at least 16 characters"),
  })
  .superRefine((env, ctx) => {
    if (env.DEPLOYMENT_MODE !== "hosted") return;
    for (const field of ["SIGNOZ_URL", "SIGNOZ_MCP_URL", "OTEL_EXPORTER_OTLP_ENDPOINT"] as const) {
      const hostname = new URL(env[field]).hostname;
      if (isPrivateHost(hostname)) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `${field} must not point at a loopback, link-local or private address in hosted mode`,
        });
      }
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export class EnvValidationError extends Error {
  readonly issues: readonly { readonly path: string; readonly message: string }[];

  constructor(issues: readonly { readonly path: string; readonly message: string }[]) {
    const detail = issues.map((issue) => `  ${issue.path}: ${issue.message}`).join("\n");
    super(`Environment validation failed:\n${detail}`);
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

/**
 * Parses and validates process environment. Throws {@link EnvValidationError} listing every
 * problem at once rather than failing on the first, so an operator fixes one `.env` in one pass.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    message: issue.message,
  }));
  throw new EnvValidationError(issues);
}

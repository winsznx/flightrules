import { FlightRulesError } from "@flightrules/domain";
import { ARTIFACT_LABELS, projectManagedName } from "./names.js";

/**
 * The notification channel FR-015 requires be verified before an alert is created.
 *
 * The pinned server rejects an alert whose threshold names no existing channel, even when routing
 * is delegated to a policy, so a channel is not optional and cannot be faked. FlightRules will not
 * invent a Slack or PagerDuty credential, so the only destination it creates for itself is a
 * webhook, whose URL is supplied by configuration and classified honestly:
 *
 *   * `local` — a loopback or private address. The channel exists and SigNoz will attempt delivery,
 *     but nothing outside the machine receives it, so delivery is **not** claimed as verified.
 *   * `external` — a routable destination the operator configured deliberately.
 *
 * The classification is persisted with the artefact. Delivery is never reported as proven unless a
 * receipt was actually observed, which P0 does not attempt: the alert's *firing* is proven from
 * alert history, which is a SigNoz-side fact and does not depend on any destination.
 */

export type ChannelReach = "local" | "external";

export interface NotificationChannelSpec {
  readonly name: string;
  readonly type: "webhook";
  readonly webhook_url: string;
  readonly send_resolved: true;
}

export interface ChannelDestination {
  /** Scheme, host and port only. The path, query and any credential are never persisted. */
  readonly redactedUrl: string;
  readonly reach: ChannelReach;
}

const PRIVATE_HOST =
  /^(localhost|127\.|0\.0\.0\.0$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|host\.docker\.internal$)/i;

/**
 * Reduces a webhook URL to what is safe to store.
 *
 * A webhook URL is frequently a bearer credential in disguise — a Slack or Teams incoming hook is
 * exactly that — so the path is dropped rather than truncated, and userinfo is dropped outright.
 */
export function describeDestination(rawUrl: string): ChannelDestination {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new FlightRulesError("CONFIG_INVALID", {
      message: "The FlightRules alert webhook URL is not a valid absolute URL.",
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new FlightRulesError("CONFIG_INVALID", {
      message: "The FlightRules alert webhook URL must use http or https.",
      details: { protocol: parsed.protocol },
    });
  }
  return {
    redactedUrl: `${parsed.protocol}//${parsed.host}`,
    reach: PRIVATE_HOST.test(parsed.hostname) ? "local" : "external",
  };
}

export function compileNotificationChannel(
  projectSlug: string,
  webhookUrl: string,
): NotificationChannelSpec {
  // Validated for its own sake: a malformed URL must fail compilation, not the MCP write.
  describeDestination(webhookUrl);
  return {
    name: projectManagedName(projectSlug, ARTIFACT_LABELS.notifications),
    type: "webhook",
    webhook_url: webhookUrl,
    send_resolved: true,
  };
}

/**
 * What a read-back must agree on.
 *
 * The URL is deliberately absent. SigNoz returns the channel's configuration, and comparing a
 * secret-bearing URL would put it into the comparison record that is persisted and logged. The
 * name and the type are what the alert payload depends on.
 */
export function channelMaterialFields(
  spec: NotificationChannelSpec,
): Readonly<Record<string, unknown>> {
  return { name: spec.name, type: spec.type };
}

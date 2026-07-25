import { canonicalHash, canonicalJson } from "@flightrules/domain";
import { type AlertSpec, alertMaterialFields, compileAlerts } from "./alerts.js";
import {
  type ChannelDestination,
  channelMaterialFields,
  compileNotificationChannel,
  describeDestination,
  type NotificationChannelSpec,
} from "./channels.js";
import { compileDashboard, type DashboardSpec, dashboardMaterialFields } from "./dashboard.js";
import { type NameScope, ownershipNote, ownershipTags } from "./names.js";
import { ROOT_SPAN_DEFAULT } from "./queries.js";
import { compileSavedViews, type SavedViewSpec, viewMaterialFields } from "./views.js";

/**
 * Compilation (PRD Phase 10 tasks 2–5).
 *
 * `compileArtifacts` is a pure function. It reads no clock, opens no socket, touches no database
 * and iterates nothing whose order a database chose: the ten artefacts come out in a fixed
 * declaration order, and every hash is taken over the canonical serialisation the persistence layer
 * already uses. The same contract therefore compiles to byte-identical specifications on every run
 * and on every machine, which is what makes "a second identical sync creates none and updates
 * none" decidable without asking SigNoz.
 *
 * No LLM participates in compilation, in comparison or in verification.
 */

export const ARTIFACT_TYPES = ["notification_channel", "saved_view", "dashboard", "alert"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export interface DesiredArtifact {
  readonly type: ArtifactType;
  readonly managedName: string;
  /** sha256 over the canonical serialisation of `spec`. Stable across processes and machines. */
  readonly specHash: string;
  /** The exact arguments the create tool takes, flat, as the discovered schema requires. */
  readonly spec: Readonly<Record<string, unknown>>;
  /** Dotted paths into the stored resource that must survive the round trip. */
  readonly materialFields: Readonly<Record<string, unknown>>;
  /** Scoped to the agent, except the notification channel which is shared by the project. */
  readonly agentScoped: boolean;
}

export interface CompileInput {
  readonly projectSlug: string;
  readonly agentKey: string;
  readonly contractVersion: string;
  /** Root span of an agent run, from the agent's registration. */
  readonly rootSpanName?: string;
  /** Violations in one evaluation window above which the rate alert fires. */
  readonly violationThreshold?: number;
  readonly webhookUrl: string;
}

export interface CompiledArtifacts {
  readonly artifacts: readonly DesiredArtifact[];
  readonly channelName: string;
  readonly destination: ChannelDestination;
  /** sha256 over every artefact hash in order. One value that answers "did anything change?". */
  readonly planHash: string;
}

const DEFAULT_VIOLATION_THRESHOLD = 0;

export function compileArtifacts(input: CompileInput): CompiledArtifacts {
  const scope: NameScope = { projectSlug: input.projectSlug, agentKey: input.agentKey };
  const rootSpanName = input.rootSpanName ?? ROOT_SPAN_DEFAULT;
  const tags = ownershipTags(scope);
  const note = ownershipNote(scope, input.contractVersion);

  const channel = compileNotificationChannel(input.projectSlug, input.webhookUrl);
  const views = compileSavedViews(scope, note, tags);
  const dashboard = compileDashboard(scope, rootSpanName, note, tags);
  const alerts = compileAlerts(
    scope,
    channel.name,
    input.violationThreshold ?? DEFAULT_VIOLATION_THRESHOLD,
    input.contractVersion,
  );

  const artifacts: DesiredArtifact[] = [
    describeChannel(channel),
    ...views.map(describeView),
    describeDashboard(dashboard),
    ...alerts.map(describeAlert),
  ];

  return {
    artifacts,
    channelName: channel.name,
    destination: describeDestination(input.webhookUrl),
    planHash: canonicalHash(artifacts.map((artifact) => artifact.specHash)),
  };
}

/**
 * The channel's hash deliberately excludes the webhook URL.
 *
 * Rotating a webhook secret must not be reported as a specification change that rewrites every
 * alert; and a hash taken over a credential is a credential that has been copied into the artefact
 * register. The reach classification is included, because moving from a loopback destination to a
 * routable one genuinely is a change worth resyncing.
 */
function describeChannel(spec: NotificationChannelSpec): DesiredArtifact {
  const hashable = {
    name: spec.name,
    type: spec.type,
    send_resolved: spec.send_resolved,
    reach: describeDestination(spec.webhook_url).reach,
  };
  return {
    type: "notification_channel",
    managedName: spec.name,
    specHash: canonicalHash(hashable),
    spec: { ...spec },
    materialFields: channelMaterialFields(spec),
    agentScoped: false,
  };
}

function describeView(spec: SavedViewSpec): DesiredArtifact {
  return {
    type: "saved_view",
    managedName: spec.name,
    specHash: canonicalHash(spec),
    spec: { ...spec },
    materialFields: viewMaterialFields(spec),
    agentScoped: true,
  };
}

function describeDashboard(spec: DashboardSpec): DesiredArtifact {
  return {
    type: "dashboard",
    managedName: spec.title,
    specHash: canonicalHash(spec),
    spec: { ...spec },
    materialFields: dashboardMaterialFields(spec),
    agentScoped: true,
  };
}

function describeAlert(spec: AlertSpec): DesiredArtifact {
  return {
    type: "alert",
    managedName: spec.alert,
    specHash: canonicalHash(spec),
    spec: { ...spec },
    materialFields: alertMaterialFields(spec),
    agentScoped: true,
  };
}

/** Exposed so a test can assert byte equality rather than object equality. */
export function serialiseArtifacts(compiled: CompiledArtifacts): string {
  return canonicalJson(
    compiled.artifacts.map((artifact) => ({
      type: artifact.type,
      managedName: artifact.managedName,
      specHash: artifact.specHash,
      spec: artifact.spec,
    })),
  );
}

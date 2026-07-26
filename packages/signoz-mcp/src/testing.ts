import { REQUIRED_TOOLS } from "./client.js";
import type { RawToolResult } from "./normalise.js";
import type { ToolCall, ToolCaller } from "./transport.js";

/**
 * An in-memory stand-in for the pinned SigNoz MCP Server.
 *
 * This exists for exactly two questions the live server cannot answer on demand: what FlightRules
 * does when two syncs collide, and what it does when SigNoz goes away in the middle of one. Both
 * need the failure to happen at a chosen instruction — between a create and its read-back, say —
 * and neither can be staged against a real deployment without breaking it for everything else.
 *
 * It is a *transport* fake, not a client fake. Every call still travels the real
 * `SigNozMcpClient` — its retry policy, its circuit breaker, its response normalisation and its
 * schema validation — and the real `SigNozOperations` and `ArtifactSynchroniser` above it. What is
 * replaced is only the socket, so a test that passes here has exercised the product's own code.
 *
 * The response envelopes are the ones the pinned v0.9.0 server actually returns, including the
 * asymmetries the source lock records: `signoz_list_dashboards` keys its identifier `uuid` and
 * `signoz_list_alert_rules` keys its name `alert` and its identifier `ruleId` (SL-056), a channel
 * create answers with its own envelope rather than the create envelope, and `signoz_delete_view`
 * answers `{"status":"success"}` with no `data` at all (SL-058). A fake that normalised those away
 * would test a server FlightRules does not talk to.
 */

export type FakeArtifactKind = "view" | "dashboard" | "alert" | "channel";

interface StoredResource {
  readonly kind: FakeArtifactKind;
  readonly id: string;
  name: string;
  spec: Record<string, unknown>;
}

/** A scripted interruption: the call that should fail, and how. */
export interface FaultSpec {
  /** Tool name, or a prefix such as `signoz_create` to fail a whole family. */
  readonly tool: string;
  /** How the failure presents. `transport` throws; `error` is an MCP-declared tool error. */
  readonly mode: "transport" | "error" | "empty" | "html";
  /** Fail only from this occurrence onwards (1-based). Defaults to every occurrence. */
  readonly fromCall?: number;
  /** Stop failing after this many occurrences. Defaults to unlimited. */
  readonly times?: number;
  /**
   * Whether the resource is still created before the failure is raised.
   *
   * `true` reproduces the worst case in the whole sync path: SigNoz created the resource and the
   * response never came back, so FlightRules cannot know whether its write landed.
   */
  readonly afterEffect?: boolean;
}

export interface FakeSigNozOptions {
  readonly faults?: readonly FaultSpec[];
  /** Resources present before FlightRules ever runs, for unmanaged-conflict cases. */
  readonly preexisting?: readonly { kind: FakeArtifactKind; name: string; id?: string }[];
  /** Rows `signoz_execute_builder_query` pages over, honouring the query's limit and offset. */
  readonly rows?: readonly Record<string, unknown>[];
}

const LIST_TOOL: Readonly<Record<FakeArtifactKind, string>> = {
  view: "signoz_list_views",
  dashboard: "signoz_list_dashboards",
  alert: "signoz_list_alert_rules",
  channel: "signoz_list_notification_channels",
};

export class FakeSigNoz implements ToolCaller {
  readonly #resources = new Map<string, StoredResource>();
  readonly #faults: FaultSpec[];
  readonly #callCounts = new Map<string, number>();
  #nextId = 1;
  #rows: readonly Record<string, unknown>[];

  /** Every call made, in order, so a test can assert what was and was not sent. */
  readonly calls: ToolCall[] = [];

  constructor(options: FakeSigNozOptions = {}) {
    this.#faults = [...(options.faults ?? [])];
    this.#rows = options.rows ?? [];
    for (const resource of options.preexisting ?? []) {
      const id = resource.id ?? this.#mintId();
      this.#resources.set(id, {
        kind: resource.kind,
        id,
        name: resource.name,
        spec: { name: resource.name },
      });
    }
  }

  /** Adds a fault after construction, so an outage can begin part-way through a test. */
  injectFault(fault: FaultSpec): void {
    this.#faults.push(fault);
  }

  /** Replaces the row set the builder query pages over. */
  setRows(rows: readonly Record<string, unknown>[]): void {
    this.#rows = rows;
  }

  clearFaults(): void {
    this.#faults.length = 0;
    this.#callCounts.clear();
  }

  /** Every resource of a kind, as a test sees them. Duplicate names are visible here. */
  resourcesOf(kind: FakeArtifactKind): readonly { id: string; name: string }[] {
    return [...this.#resources.values()]
      .filter((resource) => resource.kind === kind)
      .map((resource) => ({ id: resource.id, name: resource.name }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** Every resource, whatever its kind. */
  allResources(): readonly { kind: FakeArtifactKind; id: string; name: string }[] {
    return [...this.#resources.values()]
      .map(({ kind, id, name }) => ({ kind, id, name }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** How many resources of any kind carry this name. More than one is a duplicate. */
  countNamed(name: string): number {
    return [...this.#resources.values()].filter((resource) => resource.name === name).length;
  }

  /** Simulates a human deleting a resource in the SigNoz console. */
  deleteByName(name: string): void {
    for (const [id, resource] of this.#resources) {
      if (resource.name === name) this.#resources.delete(id);
    }
  }

  /** Simulates a human renaming a resource in the SigNoz console. */
  renameByName(from: string, to: string): void {
    for (const resource of this.#resources.values()) {
      if (resource.name === from) resource.name = to;
    }
  }

  /** Simulates a human editing a resource, so the next read-back no longer matches. */
  editByName(name: string, change: Readonly<Record<string, unknown>>): void {
    for (const resource of this.#resources.values()) {
      if (resource.name === name) resource.spec = { ...resource.spec, ...change };
    }
  }

  async listToolNames(): Promise<readonly string[]> {
    return [
      ...REQUIRED_TOOLS,
      "signoz_delete_view",
      "signoz_delete_dashboard",
      "signoz_get_notification_channel",
      "signoz_create_notification_channel",
      "signoz_update_notification_channel",
      "signoz_delete_notification_channel",
      "signoz_query_metrics",
    ];
  }

  async listResourceUris(): Promise<readonly string[]> {
    return [];
  }

  serverInfo(): { readonly name: string; readonly version: string } | undefined {
    return { name: "fake-signoz-mcp", version: "0.9.0" };
  }

  async close(): Promise<void> {
    // Nothing to release.
  }

  async call(request: ToolCall, _signal: AbortSignal): Promise<RawToolResult> {
    this.calls.push(request);
    const fault = this.#faultFor(request.name);

    if (fault !== undefined && fault.afterEffect !== true) return this.#raise(fault);

    const result = this.#dispatch(request);

    // The dangerous case: the write landed and the answer did not.
    if (fault !== undefined) return this.#raise(fault);
    return result;
  }

  /* ------------------------------------------------------------------ */

  #mintId(): string {
    const id = `019f9c00-0000-7000-8000-${String(this.#nextId).padStart(12, "0")}`;
    this.#nextId += 1;
    return id;
  }

  #faultFor(tool: string): FaultSpec | undefined {
    for (const fault of this.#faults) {
      if (!tool.startsWith(fault.tool)) continue;
      const key = `${fault.tool}:${fault.mode}:${String(fault.fromCall ?? 0)}`;
      const seen = (this.#callCounts.get(key) ?? 0) + 1;
      this.#callCounts.set(key, seen);
      if (seen < (fault.fromCall ?? 1)) continue;
      if (fault.times !== undefined && seen >= (fault.fromCall ?? 1) + fault.times) continue;
      return fault;
    }
    return undefined;
  }

  #raise(fault: FaultSpec): RawToolResult {
    if (fault.mode === "transport") {
      throw new Error("fetch failed: ECONNREFUSED — the SigNoz MCP Server is not reachable");
    }
    if (fault.mode === "error") {
      return { content: [text("upstream SigNoz returned 503 Service Unavailable")], isError: true };
    }
    if (fault.mode === "html") {
      return {
        content: [
          text("<!doctype html><html><head><title>SigNoz</title></head><body></body></html>"),
        ],
      };
    }
    return { content: [] };
  }

  #dispatch(request: ToolCall): RawToolResult {
    const args = request.arguments as Record<string, unknown>;
    switch (request.name) {
      case "signoz_execute_builder_query":
      case "signoz_search_traces":
      case "signoz_get_trace_details":
        return this.#builderQuery(args);

      case "signoz_list_views":
        return json({ data: this.#list("view", (r) => ({ id: r.id, name: r.name })) });
      case "signoz_list_dashboards":
        return json({ data: this.#list("dashboard", (r) => ({ uuid: r.id, name: r.name })) });
      case "signoz_list_alert_rules":
        return json({ data: this.#list("alert", (r) => ({ ruleId: r.id, alert: r.name })) });
      case "signoz_list_notification_channels":
        return json({ data: this.#list("channel", (r) => ({ id: r.id, name: r.name })) });

      case "signoz_create_view":
        return json({ data: { id: this.#create("view", args) } });
      case "signoz_create_dashboard":
        return json({ data: { id: this.#create("dashboard", args) } });
      case "signoz_create_alert":
        return json({ data: { id: this.#create("alert", args) } });
      case "signoz_create_notification_channel": {
        const id = this.#create("channel", args);
        return json({
          channel: { status: "success", data: { id, ...args } },
          test_notification: { success: true, message: "delivered" },
        });
      }

      case "signoz_get_view":
        return this.#read("view", args, (resource) => ({ ...resource.spec, id: resource.id }));
      case "signoz_get_alert":
        return this.#read("alert", args, (resource) => ({ ...resource.spec, id: resource.id }));
      case "signoz_get_notification_channel":
        return this.#read("channel", args, (resource) => ({ ...resource.spec, id: resource.id }));
      case "signoz_get_dashboard":
        // A dashboard read-back nests its body one level down, which is why the compiler's material
        // field paths for a dashboard are prefixed `data.` and the other three types' are not.
        return this.#read("dashboard", args, (resource) => ({
          id: resource.id,
          webUrl: `http://signoz.internal/dashboard/${resource.id}`,
          data: { ...resource.spec },
        }));

      case "signoz_update_dashboard":
        return this.#update(
          "dashboard",
          args,
          (args["dashboard"] ?? {}) as Record<string, unknown>,
        );
      case "signoz_update_alert":
        return this.#update("alert", args, args);
      case "signoz_update_notification_channel":
        return this.#update("channel", args, args);
      case "signoz_update_view":
        // SL-057: unusable on the pinned server. FlightRules replaces a view by delete-and-create,
        // so any call to this tool is a regression and the fake refuses it rather than pretending.
        return { content: [text("signoz_update_view corrupted the stored view")], isError: true };

      case "signoz_delete_view": {
        this.#resources.delete(String(args["id"]));
        return json({ status: "success" });
      }
      case "signoz_delete_dashboard": {
        this.#resources.delete(String(args["id"]));
        return json({ status: "success" });
      }
      case "signoz_delete_notification_channel": {
        this.#resources.delete(String(args["id"]));
        return json({ status: "success", id: String(args["id"]) });
      }

      default:
        return {
          content: [text(`the fake server has no tool named ${request.name}`)],
          isError: true,
        };
    }
  }

  /**
   * A Query Builder raw response, paged the way the pinned server pages.
   *
   * The envelope nests rows two levels down — `data.data.results[].rows[].data` — and the limit and
   * offset live inside the composite query rather than beside it. Both shapes matter: a caller that
   * pages correctly against a flatter fake would page incorrectly against SigNoz.
   */
  #builderQuery(args: Record<string, unknown>): RawToolResult {
    const spec = (
      ((args["query"] as { compositeQuery?: { queries?: { spec?: Record<string, unknown> }[] } })
        ?.compositeQuery?.queries ?? [])[0] ?? {}
    ).spec;
    const limit = Number(spec?.["limit"] ?? this.#rows.length);
    const offset = Number(spec?.["offset"] ?? 0);
    const page = this.#rows.slice(offset, offset + limit);
    // `nextCursor` is how the pinned server signals that more rows remain. Omitting it would make
    // every fake result look like the last page, and a caller that paged incorrectly would pass.
    const hasMore = offset + page.length < this.#rows.length;
    return json({
      data: {
        data: {
          results: [
            {
              rows: page.map((row) => ({ data: row })),
              ...(hasMore ? { nextCursor: `offset:${String(offset + page.length)}` } : {}),
            },
          ],
        },
      },
    });
  }

  #list(kind: FakeArtifactKind, shape: (resource: StoredResource) => unknown): unknown[] {
    void LIST_TOOL[kind];
    return [...this.#resources.values()]
      .filter((resource) => resource.kind === kind)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map(shape);
  }

  #create(kind: FakeArtifactKind, spec: Record<string, unknown>): string {
    const id = this.#mintId();
    this.#resources.set(id, { kind, id, name: nameOf(kind, spec), spec: { ...spec } });
    return id;
  }

  #read(
    kind: FakeArtifactKind,
    args: Record<string, unknown>,
    shape: (resource: StoredResource) => unknown,
  ): RawToolResult {
    const resource = this.#resources.get(String(args["id"]));
    if (resource === undefined || resource.kind !== kind) {
      return { content: [text(`no ${kind} with id ${String(args["id"])}`)], isError: true };
    }
    return json({ data: shape(resource) });
  }

  #update(
    kind: FakeArtifactKind,
    args: Record<string, unknown>,
    spec: Record<string, unknown>,
  ): RawToolResult {
    const resource = this.#resources.get(String(args["id"]));
    if (resource === undefined || resource.kind !== kind) {
      return { content: [text(`no ${kind} with id ${String(args["id"])}`)], isError: true };
    }
    const { id: _ignored, ...body } = spec;
    resource.spec = { ...body };
    resource.name = nameOf(kind, body);
    return json({ data: { ...resource.spec, id: resource.id } });
  }
}

/**
 * Where each resource kind keeps its name in the body FlightRules submits.
 *
 * Three different keys for four kinds, matching the pinned server: an alert is named by `alert`, a
 * dashboard by `title`, and a view and a channel by `name`. The list tools then report all four
 * under `name` — except an alert, which reports `alert`. Both asymmetries are SL-056's.
 */
function nameOf(kind: FakeArtifactKind, spec: Record<string, unknown>): string {
  const key = kind === "alert" ? "alert" : kind === "dashboard" ? "title" : "name";
  const value = spec[key];
  return typeof value === "string" ? value : "";
}

function text(value: string): { type: string; text: string } {
  return { type: "text", text: value };
}

function json(payload: unknown): RawToolResult {
  return { content: [text(JSON.stringify(payload))] };
}

import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import SettingsMachinesPanel from "./SettingsMachinesPanel.svelte";
import type {
  CapabilityReport,
  IncomingMirror,
  InstanceIdentity,
  RemoteInstance,
  Session,
} from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";

const SELF: InstanceIdentity = {
  instanceId: "aaaaaaaa-0000-4000-8000-000000000001",
  name: "moes-tavern",
  version: "2.1.0",
  federationApi: 1,
  platform: "linux",
  arch: "x64",
};

let seq = 0;
function machine(over: Partial<RemoteInstance> = {}): RemoteInstance {
  seq++;
  return {
    instanceId: `bbbbbbbb-0000-4000-8000-00000000000${seq}`,
    name: `Machine ${seq}`,
    label: null,
    reportedName: `Machine ${seq}`,
    url: `https://m${seq}.example.ts.net`,
    tokenHint: "a9Fz",
    createdAt: Date.now() - 60_000,
    status: "connected",
    reason: null,
    checkedAt: Date.now() - 5_000,
    lastSeenAt: Date.now() - 5_000,
    info: { version: "2.1.0", federationApi: 1, platform: "macos", arch: "arm64" },
    projects: ["acme/app", "erwins-enkel/shepherd"],
    capabilities: null,
    released: true,
    ...over,
  };
}

/** A capability report (#2770) where `ok` lists the verified ids and `missing` maps the rest. */
function report(
  ok: string[],
  missing: Record<string, string>,
  over: Partial<CapabilityReport> = {},
): CapabilityReport {
  return {
    vocabulary: 1,
    probedAt: Date.now() - 180_000,
    ageMs: 180_000,
    stale: false,
    checks: [
      ...ok.map((id) => ({ id, ok: true, reason: null })),
      ...Object.entries(missing).map(([id, reason]) => ({ id, ok: false, reason })),
    ],
    ...over,
  };
}

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stubApi(opts: {
  self?: InstanceIdentity;
  machines?: RemoteInstance[];
  incoming?: IncomingMirror[];
  connect?: (body: Record<string, unknown>) => { payload: unknown; status: number };
  order?: string[];
}) {
  const calls: { url: string; method: string; body: string }[] = [];
  let machines = [...(opts.machines ?? [])];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? String(init.body) : "";
    calls.push({ url, method, body });
    const self = opts.self ?? SELF;
    if (url === "/api/instance") {
      if (method === "PATCH") return jsonRes({ ...self, name: JSON.parse(body).name ?? self.name });
      return jsonRes(self);
    }
    if (url === "/api/instance/capabilities" && method === "POST") {
      return jsonRes({ ...self, capabilities: report(["platform:linux", "agent:codex"], {}) });
    }
    if (url === "/api/remote-instances" && method === "POST") {
      const { payload, status } = opts.connect!(JSON.parse(body));
      // Listed from then on, as the server does.
      const added = (payload as { instance?: RemoteInstance }).instance;
      if (status === 201 && added) machines = [...machines, added];
      return jsonRes(payload, status);
    }
    if (url === "/api/remote-instances")
      return jsonRes({ instances: machines, incoming: opts.incoming ?? [] });
    if (url === "/api/settings" && opts.order) {
      if (method === "PUT") return jsonRes(JSON.parse(body));
      return jsonRes({ machinePlatformOrder: opts.order });
    }
    if (method === "DELETE") {
      machines = machines.filter((x) => !url.endsWith(x.instanceId));
      return jsonRes({ ok: true });
    }
    return jsonRes({ error: "not found" }, 404);
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The list header's toggle that unfolds the connect form. */
const connectToggle = () =>
  page.getByRole("button", { name: m.settings_machines_connect_title(), exact: true });
/** The form's submit button; `exact`, since the toggle's name contains it in EN. */
const connectButton = () =>
  page.getByRole("button", { name: m.settings_machines_connect_button(), exact: true });

describe("SettingsMachinesPanel", () => {
  it("shows this Shepherd's identity and an empty list", async () => {
    stubApi({});
    render(SettingsMachinesPanel);
    await expect.element(page.getByText("moes-tavern")).toBeVisible();
    await expect.element(page.getByText(SELF.instanceId)).toBeVisible();
    await expect.element(page.getByText(m.settings_machines_empty())).toBeVisible();
    await expect.element(page.getByText(m.settings_machines_incoming_empty())).toBeVisible();
    // The connect form stays folded behind the list header's toggle until asked for.
    await expect.element(connectToggle()).toHaveAttribute("aria-expanded", "false");
    await expect.element(page.getByText(m.settings_machines_trust())).not.toBeInTheDocument();
  });

  it("unfolds the connect form from the list header and focuses the address", async () => {
    stubApi({});
    render(SettingsMachinesPanel);
    await connectToggle().click();
    await expect.element(connectToggle()).toHaveAttribute("aria-expanded", "true");
    await expect.element(page.getByLabelText(m.settings_machines_url_label())).toHaveFocus();
    await expect.element(page.getByText(m.settings_machines_trust())).toBeVisible();
  });

  it("folds the form on cancel and forgets what was typed", async () => {
    stubApi({});
    render(SettingsMachinesPanel);
    await connectToggle().click();
    await page.getByLabelText(m.settings_machines_url_label()).fill("https://mac.example.ts.net");
    await page.getByLabelText(m.settings_machines_token_label()).fill("shp_secret");
    await page.getByRole("button", { name: m.common_cancel(), exact: true }).click();
    await expect
      .element(page.getByLabelText(m.settings_machines_url_label()))
      .not.toBeInTheDocument();
    await expect.element(connectToggle()).toHaveFocus();
    await connectToggle().click();
    await expect.element(page.getByLabelText(m.settings_machines_url_label())).toHaveValue("");
    await expect.element(page.getByLabelText(m.settings_machines_token_label())).toHaveValue("");
  });

  it("renders each connection state distinctly with its next step", async () => {
    stubApi({
      machines: [
        machine({ name: "Mac ok" }),
        machine({ name: "Mac off", status: "unreachable", reason: "timeout" }),
        machine({ name: "Mac 401", status: "unauthorized", reason: "token_rejected" }),
        machine({ name: "Mac old", status: "incompatible", reason: "api_missing" }),
      ],
    });
    render(SettingsMachinesPanel);
    await expect.element(page.getByText("Mac ok")).toBeVisible();
    for (const [status, label] of [
      ["connected", m.settings_machines_status_connected()],
      ["unreachable", m.settings_machines_status_unreachable()],
      ["unauthorized", m.settings_machines_status_unauthorized()],
      ["incompatible", m.settings_machines_status_incompatible()],
    ]) {
      const badge = document.querySelector(`[data-status="${status}"]`);
      expect(badge?.textContent?.trim()).toBe(label);
    }
    await expect.element(page.getByText(m.settings_machines_hint_timeout())).toBeVisible();
    await expect.element(page.getByText(m.settings_machines_hint_token_rejected())).toBeVisible();
    await expect.element(page.getByText(m.settings_machines_hint_api_missing())).toBeVisible();
    await expect
      .element(page.getByText(m.settings_machines_projects({ count: 2 })).first())
      .toBeVisible();
  });

  it("connects a machine and shows it, sending url, token and label", async () => {
    const added = machine({ name: "MacBook" });
    const calls = stubApi({ connect: () => ({ payload: { instance: added }, status: 201 }) });
    render(SettingsMachinesPanel);
    await connectToggle().click();
    await page.getByLabelText(m.settings_machines_url_label()).fill("https://mac.example.ts.net");
    await page.getByLabelText(m.settings_machines_token_label()).fill("shp_secret");
    await page.getByLabelText(m.settings_machines_label_label()).fill("MacBook");
    await connectButton().click();
    await expect.element(page.getByText("MacBook", { exact: true })).toBeVisible();
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(post!.body)).toEqual({
      url: "https://mac.example.ts.net",
      token: "shp_secret",
      label: "MacBook",
    });
    // A connected machine folds the form away, token and all.
    await expect
      .element(page.getByLabelText(m.settings_machines_token_label()))
      .not.toBeInTheDocument();
    await expect.element(connectToggle()).toHaveAttribute("aria-expanded", "false");
  });

  it("explains a refused connection", async () => {
    stubApi({
      connect: () => ({
        payload: { error: "remote_unauthorized", reason: "token_restricted" },
        status: 422,
      }),
    });
    render(SettingsMachinesPanel);
    await connectToggle().click();
    await page.getByLabelText(m.settings_machines_url_label()).fill("https://mac.example.ts.net");
    await page.getByLabelText(m.settings_machines_token_label()).fill("shp_secret");
    await connectButton().click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(
        `${m.settings_machines_status_unauthorized()}: ${m.settings_machines_hint_token_restricted()}`,
      );
    // A refusal keeps the form open so the operator can fix what it names.
    await expect.element(page.getByLabelText(m.settings_machines_url_label())).toBeVisible();
  });

  it("removes a machine after confirmation", async () => {
    const target = machine({ name: "Old Mac" });
    const calls = stubApi({ machines: [target] });
    render(SettingsMachinesPanel);
    await page
      .getByRole("button", { name: m.settings_machines_remove_aria({ name: "Old Mac" }) })
      .click();
    await page.getByRole("button", { name: m.settings_machines_remove_yes() }).click();
    await expect.element(page.getByText(m.settings_machines_empty())).toBeVisible();
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith(target.instanceId))).toBe(
      true,
    );
  });

  it("shows this Shepherd's capabilities with their age and re-checks them on demand", async () => {
    const calls = stubApi({
      self: {
        ...SELF,
        capabilities: report(["platform:linux", "agent:claude", "sandbox:trusted"], {
          "agent:codex": "not_logged_in",
          "android-sdk": "sdk_not_found",
          xcode: "other_platform",
        }),
      },
    });
    render(SettingsMachinesPanel);
    const caps = page.getByText(m.settings_machines_cap_agent_claude(), { exact: true });
    await expect.element(caps).toBeVisible();
    expect(document.querySelector("[data-capabilities]")?.textContent).toContain("3m");
    // Exactly codex and the SDK: Xcode belongs to another platform, so on Linux it is not missing.
    const missing = `${m.settings_machines_cap_agent_codex()} (${m.settings_machines_cap_reason_not_logged_in()}) · ${m.settings_machines_cap_android_sdk()} (${m.settings_machines_cap_reason_sdk_not_found()})`;
    await expect
      .element(page.getByText(m.settings_machines_caps_missing({ list: missing })))
      .toBeVisible();
    expect(document.querySelector("[data-stale]")).toBeNull();

    await page.getByRole("button", { name: m.settings_machines_caps_check() }).click();
    await expect
      .element(page.getByText(m.settings_machines_cap_agent_codex(), { exact: true }))
      .toBeVisible();
    expect(calls.some((c) => c.method === "POST" && c.url === "/api/instance/capabilities")).toBe(
      true,
    );
  });

  it("shows a machine's check slot, and its last known state when out of reach", async () => {
    const snapshot = {
      enabled: true,
      capacity: 2,
      holders: [{ sessionId: "s1", command: "vitest run", startedAt: 1, rssBytes: null }],
      waiters: [{ sessionId: "s2", position: 1, reason: "slot" as const }],
      brake: { active: true, reason: "memory" as const },
      pressure: {
        ramAvailableBytes: 1,
        ramTotalBytes: 4,
        swapUsedBytes: null,
        swapTotalBytes: null,
        memFullAvg10: null,
        memBrakeThreshold: null,
        cpuSomeAvg10: null,
      },
      memoryBySource: { agentsBytes: null, foreignBytes: null, foreignTop: [] },
    };
    stubApi({
      machines: [
        machine({ name: "Mac slot", heavySlot: { snapshot, readAt: Date.now(), stale: false } }),
        machine({
          name: "Mac gone",
          status: "unreachable",
          reason: "timeout",
          heavySlot: { snapshot, readAt: Date.now() - 120_000, stale: true },
        }),
        machine({ name: "Mac old", heavySlot: null }),
      ],
    });
    render(SettingsMachinesPanel);
    await expect
      .element(page.getByText(m.settings_machines_slot_waiting({ count: 1 })).first())
      .toBeVisible();
    expect(document.querySelectorAll("[data-heavy-slot] [data-brake]").length).toBe(2);
    expect(document.querySelectorAll("[data-heavy-slot] [data-stale]").length).toBe(1);
    expect(document.body.textContent).toContain(m.settings_machines_slot_none());
  });

  it("marks a machine's stale capabilities and says nothing was reported by an older one", async () => {
    stubApi({
      machines: [
        machine({
          name: "Mac stale",
          capabilities: report(
            ["platform:macos", "agent:claude"],
            {},
            { stale: true, ageMs: 1_200_000 },
          ),
        }),
        machine({ name: "Mac old", capabilities: null }),
      ],
    });
    render(SettingsMachinesPanel);
    await expect.element(page.getByText("Mac stale")).toBeVisible();
    const stale = document.querySelector("[data-stale]");
    expect(stale?.textContent?.trim()).toBe(m.settings_machines_caps_stale());
    await expect.element(page.getByText(m.settings_machines_caps_stale_hint())).toBeVisible();
    expect(stale?.closest("[data-capabilities]")?.textContent).toContain("20m");
    // This Shepherd (no report in the stub) and "Mac old" both say nothing was reported. The text
    // after the glossary marker identifies that line (the term's tooltip body is in the DOM too).
    const noneTail = m.settings_machines_caps_none().split("]]").pop()!;
    const blocks = [...document.querySelectorAll("[data-capabilities]")];
    expect(blocks).toHaveLength(3);
    expect(blocks.filter((b) => b.textContent?.includes(noneTail))).toHaveLength(2);
  });

  it("sets this Shepherd's platform order and says it must match everywhere (#2772)", async () => {
    const calls = stubApi({ machines: [machine()], order: ["linux", "macos"] });
    render(SettingsMachinesPanel);
    const select = page.getByRole("combobox", { name: m.settings_machines_order_label() });
    await expect.element(select).toHaveValue("linux,macos");
    await expect.element(page.getByText(m.settings_machines_order_note())).toBeInTheDocument();
    await select.selectOptions("macos,linux");
    await expect
      .poll(() => calls.find((c) => c.url === "/api/settings" && c.method === "PUT")?.body)
      .toBe(JSON.stringify({ machinePlatformOrder: ["macos", "linux"] }));
    await expect.element(select).toHaveValue("macos,linux");
  });

  it("leaves the platform order out while no machine is connected", async () => {
    stubApi({ order: ["linux", "macos"] });
    render(SettingsMachinesPanel);
    await expect.element(page.getByText(m.settings_machines_empty())).toBeVisible();
    await expect
      .element(page.getByRole("combobox", { name: m.settings_machines_order_label() }))
      .not.toBeInTheDocument();
  });

  it("shows a Windows machine as not released", async () => {
    stubApi({
      machines: [
        machine({
          name: "Win box",
          info: { version: "2.1.0", federationApi: 1, platform: "windows", arch: "x64" },
          released: false,
        }),
        machine({ name: "Mac fine" }),
      ],
    });
    render(SettingsMachinesPanel);
    await expect.element(page.getByText("Win box")).toBeVisible();
    const badges = document.querySelectorAll('[data-released="false"]');
    expect(badges).toHaveLength(1);
    expect(badges[0]?.textContent?.trim()).toBe(m.settings_machines_not_released());
    const row = document.querySelector(`[data-machine] .mch-name`);
    expect(row?.textContent).toBe("Win box");
    await expect
      .element(
        page.getByText(
          m.settings_machines_not_released_hint({
            platform: m.settings_machines_platform_windows(),
          }),
        ),
      )
      .toBeVisible();
  });

  describe("both directions (#3056)", () => {
    const MAC = "cccccccc-0000-4000-8000-000000000001";
    const OFF = "cccccccc-0000-4000-8000-000000000002";
    const PI = "cccccccc-0000-4000-8000-000000000003";
    const since = Date.now() - 60_000;
    const mirror = (over: Partial<IncomingMirror>): IncomingMirror => ({
      instanceId: null,
      name: null,
      tokenName: null,
      since,
      direction: "one",
      ...over,
    });
    const machines = () => [
      machine({ instanceId: MAC, name: "MacBook" }),
      machine({ instanceId: OFF, name: "build-box", status: "unreachable", reason: "timeout" }),
    ];
    const incoming = [
      mirror({ instanceId: MAC, name: "Kais-MBP", tokenName: "macbook", direction: "both" }),
      mirror({ instanceId: PI, name: "pi-lab", tokenName: "pi" }),
      mirror({ instanceId: OFF, name: "build-box", tokenName: "build" }),
      mirror({ tokenName: "old", direction: "unknown" }),
    ];
    const incomingRow = (id: string) => document.querySelector(`[data-incoming="${id}"]`);
    const connectHere = (name: string) =>
      page.getByRole("button", { name: m.settings_machines_connect_here({ name }) });

    it("lists who mirrors it and names the cause of each one-way link", async () => {
      stubApi({ machines: machines(), incoming });
      render(SettingsMachinesPanel);
      await expect.element(page.getByText(m.settings_machines_incoming_title())).toBeVisible();
      await expect.element(page.getByText(m.settings_machines_list_title())).toBeVisible();
      await expect.element(connectHere("pi-lab")).toBeVisible();

      // Both directions: under the name this Shepherd checked itself, not the claimed one.
      expect(incomingRow(MAC)?.querySelector(".mch-name")?.textContent).toBe("MacBook");
      expect(incomingRow(MAC)?.querySelector("[data-direction]")?.textContent?.trim()).toBe(
        m.settings_machines_direction_both(),
      );
      expect(incomingRow(MAC)?.textContent).toContain(
        m.settings_machines_incoming_token({ name: "macbook" }),
      );
      // Not connected here: says so, and offers to connect it.
      await expect
        .element(page.getByText(m.settings_machines_incoming_one_hint({ name: "pi-lab" })))
        .toBeVisible();
      // Connected here, but its check fails: no second connect, the status instead.
      await expect
        .element(
          page.getByText(
            m.settings_machines_incoming_offline_hint({
              status: m.settings_machines_status_unreachable(),
            }),
          ),
        )
        .toBeVisible();
      // An older Shepherd sends no ID: it goes by its token, the direction is unknown.
      expect(incomingRow("")?.querySelector(".mch-name")?.textContent).toBe("old");
      await expect
        .element(page.getByText(m.settings_machines_incoming_unknown_hint()))
        .toBeVisible();
      // Only the one Shepherd nothing here carries is offered for connecting.
      expect(document.querySelectorAll("[data-incoming] button")).toHaveLength(1);
    });

    it("Connect <name> here opens the connect form with that name", async () => {
      stubApi({ machines: machines(), incoming });
      render(SettingsMachinesPanel);
      await connectHere("pi-lab").click();
      await expect.element(connectToggle()).toHaveAttribute("aria-expanded", "true");
      await expect.element(page.getByLabelText(m.settings_machines_url_label())).toHaveFocus();
      await expect
        .element(page.getByLabelText(m.settings_machines_label_label()))
        .toHaveValue("pi-lab");
      // Opened from the list header instead, the form starts empty.
      await connectToggle().click();
      await connectToggle().click();
      await expect.element(page.getByLabelText(m.settings_machines_label_label())).toHaveValue("");
    });

    it("shows both directions as soon as the other direction is connected", async () => {
      const list = [mirror({ instanceId: PI, name: "pi-lab", tokenName: "pi" })];
      const pi = machine({ instanceId: PI, name: "pi-lab" });
      stubApi({
        incoming: list,
        connect: () => {
          // The server now confirms the peer's ID with its own check.
          list[0] = { ...list[0]!, direction: "both" };
          return { payload: { instance: pi }, status: 201 };
        },
      });
      render(SettingsMachinesPanel);
      await connectHere("pi-lab").click();
      await page.getByLabelText(m.settings_machines_url_label()).fill("https://pi.example.ts.net");
      await page.getByLabelText(m.settings_machines_token_label()).fill("shp_secret");
      await connectButton().click();
      await expect
        .poll(() =>
          incomingRow(PI)?.querySelector("[data-direction]")?.getAttribute("data-direction"),
        )
        .toBe("both");
      expect(
        document.querySelector(`[data-machine="${PI}"] [data-mirrors-back="true"]`),
      ).not.toBeNull();
    });

    it("each machine row counts its sessions, says it takes tasks and whether it mirrors back", async () => {
      const host = { instanceId: MAC, name: "MacBook", platform: "macos" };
      const remoteSessions = ["s1", "s2"].map(
        (id) => ({ id, host, connection: { state: "connected", since } }) as unknown as Session,
      );
      stubApi({ machines: machines(), incoming });
      render(SettingsMachinesPanel, { remoteSessions });
      await expect
        .element(page.getByText(m.settings_machines_sessions({ count: 2 })))
        .toBeVisible();
      const row = (id: string) => document.querySelector(`[data-machine="${id}"]`)!;
      expect(row(MAC).textContent).toContain(m.settings_machines_takes_tasks());
      expect(row(MAC).querySelector("[data-mirrors-back]")?.textContent?.trim()).toBe(
        m.settings_machines_mirrors_back(),
      );
      // Unreachable and not confirmed: no sessions, no tasks, and it doesn't see yours.
      expect(row(OFF).textContent).toContain(m.settings_machines_sessions_none());
      expect(row(OFF).textContent).not.toContain(m.settings_machines_takes_tasks());
      expect(row(OFF).querySelector('[data-mirrors-back="false"]')?.textContent?.trim()).toBe(
        m.settings_machines_mirrors_back_not(),
      );
    });
  });
});

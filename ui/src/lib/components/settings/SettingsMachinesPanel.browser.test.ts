import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import SettingsMachinesPanel from "./SettingsMachinesPanel.svelte";
import type { CapabilityReport, InstanceIdentity, RemoteInstance } from "#lib/types.js";
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
  connect?: (body: Record<string, unknown>) => { payload: unknown; status: number };
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
      return jsonRes(payload, status);
    }
    if (url === "/api/remote-instances") return jsonRes({ instances: machines });
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

describe("SettingsMachinesPanel", () => {
  it("shows this Shepherd's identity and an empty list", async () => {
    stubApi({});
    render(SettingsMachinesPanel);
    await expect.element(page.getByText("moes-tavern")).toBeVisible();
    await expect.element(page.getByText(SELF.instanceId)).toBeVisible();
    await expect.element(page.getByText(m.settings_machines_empty())).toBeVisible();
    await expect.element(page.getByText(m.settings_machines_trust())).toBeVisible();
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
    await page.getByLabelText(m.settings_machines_url_label()).fill("https://mac.example.ts.net");
    await page.getByLabelText(m.settings_machines_token_label()).fill("shp_secret");
    await page.getByLabelText(m.settings_machines_label_label()).fill("MacBook");
    await page.getByRole("button", { name: m.settings_machines_connect_button() }).click();
    await expect.element(page.getByText("MacBook", { exact: true })).toBeVisible();
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(post!.body)).toEqual({
      url: "https://mac.example.ts.net",
      token: "shp_secret",
      label: "MacBook",
    });
    await expect.element(page.getByLabelText(m.settings_machines_token_label())).toHaveValue("");
  });

  it("explains a refused connection", async () => {
    stubApi({
      connect: () => ({
        payload: { error: "remote_unauthorized", reason: "token_restricted" },
        status: 422,
      }),
    });
    render(SettingsMachinesPanel);
    await page.getByLabelText(m.settings_machines_url_label()).fill("https://mac.example.ts.net");
    await page.getByLabelText(m.settings_machines_token_label()).fill("shp_secret");
    await page.getByRole("button", { name: m.settings_machines_connect_button() }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(
        `${m.settings_machines_status_unauthorized()}: ${m.settings_machines_hint_token_restricted()}`,
      );
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
});

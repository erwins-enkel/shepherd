import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import SettingsMachinesPanel from "./SettingsMachinesPanel.svelte";
import type { InstanceIdentity, RemoteInstance } from "#lib/types.js";
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
    ...over,
  };
}

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stubApi(opts: {
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
    if (url === "/api/instance") {
      if (method === "PATCH") return jsonRes({ ...SELF, name: JSON.parse(body).name ?? SELF.name });
      return jsonRes(SELF);
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
});

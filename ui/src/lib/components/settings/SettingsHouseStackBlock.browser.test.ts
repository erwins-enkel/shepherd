import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import SettingsHouseStackBlock from "./SettingsHouseStackBlock.svelte";
import type { HouseStack, HouseStackResolution, Settings } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";

const STACK: HouseStack = { npm: ["svelte", "@sveltejs/kit"], crates: [], rustToolchain: true };

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stubApi(resolution: HouseStackResolution) {
  const calls: { url: string; method: string; body: string }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? String(init.body) : "";
    calls.push({ url, method, body });
    if (url === "/api/settings" && method === "PUT") return jsonRes(JSON.parse(body));
    if (url === "/api/house-stack/resolve") return jsonRes(resolution, resolution.ok ? 200 : 502);
    return jsonRes({ error: "not found" }, 404);
  });
  return calls;
}

const payload = { houseStack: STACK } as Settings;
const saveBtn = () => page.getByRole("button", { name: m.settings_house_stack_save() });
const checkBtn = () => page.getByRole("button", { name: m.settings_house_stack_check() });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SettingsHouseStackBlock", () => {
  it("saves the edited list and only checks a saved list", async () => {
    const calls = stubApi({ ok: false, errors: [] });
    render(SettingsHouseStackBlock, { payload });
    const npm = page.getByRole("textbox", { name: m.settings_house_stack_npm_label() });
    await expect.element(npm).toHaveValue("svelte\n@sveltejs/kit");
    await expect.element(saveBtn()).toBeDisabled();

    await npm.fill("svelte\n\n vite ");
    await expect.element(checkBtn()).toBeDisabled();
    await saveBtn().click();
    await expect.element(saveBtn()).toBeDisabled();
    const put = calls.find((c) => c.method === "PUT")!;
    expect(JSON.parse(put.body)).toEqual({
      houseStack: { npm: ["svelte", "vite"], crates: [], rustToolchain: true },
    });
    await expect.element(checkBtn()).toBeEnabled();
  });

  it("lists resolved versions", async () => {
    stubApi({
      ok: true,
      resolvedAt: "2026-10-15T08:00:00.000Z",
      npm: [{ name: "svelte", version: "5.40.1" }],
      crates: [],
      rustToolchain: "1.99.0",
    });
    render(SettingsHouseStackBlock, { payload });
    await checkBtn().click();
    await expect
      .element(page.getByText(m.settings_house_stack_resolved({ date: "2026-10-15" })))
      .toBeVisible();
    await expect.element(page.getByText("5.40.1")).toBeVisible();
    await expect.element(page.getByText("1.99.0")).toBeVisible();
  });

  it("shows per-package errors when resolution fails", async () => {
    stubApi({ ok: false, errors: [{ ecosystem: "npm", name: "svelte", reason: "timed out" }] });
    render(SettingsHouseStackBlock, { payload });
    await checkBtn().click();
    await expect.element(page.getByText(m.settings_house_stack_failed())).toBeVisible();
    await expect.element(page.getByText("timed out")).toBeVisible();
  });
});

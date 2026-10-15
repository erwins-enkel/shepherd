import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import AutomationBootstrap from "./AutomationBootstrap.svelte";
import { m } from "#lib/paraglide/messages.js";
import type { RepoBootstrapView } from "#lib/api.js";

const OFF: RepoBootstrapView = {
  state: "off",
  phase: 1,
  overrideAt: null,
  missing: [],
  suggested: false,
};

/** Fake the bootstrap API: GET answers `initial`; each PUT/POST answers the next queued view. */
function mockApi(initial: RepoBootstrapView, writes: RepoBootstrapView[] = []) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const view = method === "GET" ? initial : (writes.shift() ?? initial);
    return new Response(JSON.stringify(view), { status: 200 });
  });
  return calls;
}

const sw = () => page.getByRole("switch", { name: m.automation_bootstrap_name() });

afterEach(() => vi.restoreAllMocks());

describe("AutomationBootstrap (#3105)", () => {
  it("toggles bootstrap mode on and shows the phases and what is missing", async () => {
    const calls = mockApi(OFF, [{ ...OFF, state: "active", missing: ["P1", "P2", "P3", "P4"] }]);
    render(AutomationBootstrap, { repoPath: "/repo-a" });
    await expect.element(sw()).toHaveAttribute("aria-checked", "false");
    await sw().click();
    await expect.element(sw()).toHaveAttribute("aria-checked", "true");
    await expect
      .element(page.getByText(m.automation_bootstrap_missing({ missing: "P1, P2, P3, P4" })))
      .toBeVisible();
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({ state: "active" });
  });

  it("offers bootstrap mode for a repo without a manifest", async () => {
    mockApi({ ...OFF, suggested: true });
    render(AutomationBootstrap, { repoPath: "/repo-b" });
    await expect
      .element(page.getByRole("button", { name: m.automation_bootstrap_suggest_enable() }))
      .toBeVisible();
  });

  it("overrides only after an explicit confirm, then shows the active override", async () => {
    const active: RepoBootstrapView = { ...OFF, state: "active", phase: 2, missing: ["P2"] };
    const calls = mockApi(active, [{ ...active, overrideAt: 1_700_000_000_000 }]);
    render(AutomationBootstrap, { repoPath: "/repo-c" });
    await page.getByRole("button", { name: m.automation_bootstrap_override() }).click();
    await expect.element(page.getByText(m.automation_bootstrap_override_warn())).toBeVisible();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await page.getByRole("button", { name: m.automation_bootstrap_override_confirm() }).click();
    await expect
      .element(page.getByRole("button", { name: m.automation_bootstrap_override_revoke() }))
      .toBeVisible();
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toContain("/api/repo-bootstrap/override");
    expect(post?.body).toEqual({ on: true });
  });
});

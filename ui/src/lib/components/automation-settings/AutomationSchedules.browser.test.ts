import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import AutomationSchedules from "./AutomationSchedules.svelte";
import { m } from "#lib/paraglide/messages.js";
import type { Schedule } from "#lib/types.js";

const TRIAGE: Schedule = {
  id: "s1",
  repoPath: "/repo-a",
  name: "Triage",
  prompt: "/triage-feedback",
  days: 0b0011111,
  times: ["09:00", "18:00"],
  enabled: true,
  launch: {
    agentProvider: null,
    model: null,
    effort: null,
    autopilotEnabled: false,
    planGateEnabled: null,
    research: false,
    sandboxProfile: null,
    baseBranch: null,
  },
  createdAt: 1,
  updatedAt: 1,
  lastRun: null,
  nextAt: null,
};

/** Fake the schedules API: GET answers `list`; writes are recorded and answer `{}`. */
function mockApi(list: Schedule[]) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const body = method === "GET" ? { schedules: list } : {};
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return calls;
}

afterEach(() => vi.restoreAllMocks());

describe("AutomationSchedules (#3469)", () => {
  it("lists a schedule with its cadence and toggles it off", async () => {
    const calls = mockApi([TRIAGE]);
    render(AutomationSchedules, { repoPath: "/repo-a" });
    await expect.element(page.getByText("Triage")).toBeVisible();
    await expect.element(page.getByText(/09:00, 18:00/)).toBeVisible();
    await page.getByRole("switch", { name: m.schedules_enabled_aria({ name: "Triage" }) }).click();
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ enabled: false });
  });

  it("adds a schedule through the dialog, attended by default", async () => {
    const calls = mockApi([]);
    render(AutomationSchedules, { repoPath: "/repo-a" });
    await page.getByRole("button", { name: m.schedules_add() }).click();
    await page.getByLabelText(m.schedules_field_name()).fill("Triage");
    await page.getByLabelText(m.schedules_field_prompt()).fill("/triage-feedback");
    await page.getByRole("button", { name: m.schedules_save() }).click();
    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({
      repoPath: "/repo-a",
      name: "Triage",
      prompt: "/triage-feedback",
      days: 0b0011111,
      times: ["09:00"],
      launch: { autopilotEnabled: false, planGateEnabled: null, research: false },
    });
  });

  it("delete needs a second click", async () => {
    const calls = mockApi([TRIAGE]);
    render(AutomationSchedules, { repoPath: "/repo-a" });
    await page.getByRole("button", { name: m.schedules_delete() }).click();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await page.getByRole("button", { name: m.schedules_delete_confirm() }).click();
    await vi.waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  });
});

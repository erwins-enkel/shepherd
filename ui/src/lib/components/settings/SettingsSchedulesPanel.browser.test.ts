import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../../app.css";
import SettingsSchedulesPanel from "./SettingsSchedulesPanel.svelte";
import { m } from "#lib/paraglide/messages.js";
import type { Schedule } from "#lib/types.js";

function sched(id: string, repoPath: string, name: string, nextAt: number | null): Schedule {
  return {
    id,
    repoPath,
    name,
    prompt: "/triage-feedback",
    days: 0b0011111,
    times: ["09:00"],
    enabled: nextAt !== null,
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
    nextAt,
  };
}

const NOW = Date.now();
const LIST = [
  sched("off", "/w/alpha", "Paused audit", null),
  sched("late", "/w/alpha", "Weekly digest", NOW + 7_200_000),
  sched("soon", "/w/beta", "Triage", NOW + 3_600_000),
];

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

const titles = () =>
  Array.from(document.querySelectorAll(".sc-title")).map((e) => e.textContent?.trim());

afterEach(() => vi.restoreAllMocks());

describe("SettingsSchedulesPanel (#3475)", () => {
  it("lists every repo's schedules, soonest first, paused last", async () => {
    const calls = mockApi(LIST);
    render(SettingsSchedulesPanel, {});
    await expect.element(page.getByText("Triage")).toBeVisible();
    expect(calls[0].url).toMatch(/\/api\/schedules$/);
    expect(titles()).toEqual(["beta Triage", "alpha Weekly digest", "alpha Paused audit"]);
  });

  it("filters to one repo", async () => {
    mockApi(LIST);
    render(SettingsSchedulesPanel, {});
    await page.getByRole("combobox").selectOptions("/w/beta");
    await vi.waitFor(() => expect(titles()).toEqual(["beta Triage"]));
  });

  it("toggles a schedule and re-reads the global list", async () => {
    const calls = mockApi(LIST);
    render(SettingsSchedulesPanel, {});
    await page.getByRole("switch", { name: m.schedules_enabled_aria({ name: "Triage" }) }).click();
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toMatch(/\/api\/schedules\/soon$/);
    expect(patch.body).toEqual({ enabled: false });
    await vi.waitFor(() =>
      expect(calls.slice(calls.indexOf(patch)).some((c) => /\/api\/schedules$/.test(c.url))).toBe(
        true,
      ),
    );
  });

  it("edits in the schedule's own repo", async () => {
    mockApi(LIST);
    render(SettingsSchedulesPanel, {});
    await page.getByRole("button", { name: m.schedules_edit() }).first().click();
    await expect.element(page.getByLabelText(m.schedules_field_name())).toHaveValue("Triage");
  });

  it("Escape closes the edit dialog without reaching the Settings card", async () => {
    mockApi(LIST);
    render(SettingsSchedulesPanel, {});
    await expect.element(page.getByText("Triage")).toBeVisible();
    // a11yDialog's Escape listener on the Settings card is native, on an ancestor: here the mount
    // target, where Svelte's delegated `onkeydown` handlers also run (too late to stop it).
    const card = document.querySelector(".ssp-head")!.parentElement!;
    const cardEscape = vi.fn();
    card.addEventListener("keydown", (e) => e.key === "Escape" && cardEscape());
    await page.getByRole("button", { name: m.schedules_edit() }).first().click();
    await expect.element(page.getByLabelText(m.schedules_field_name())).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByLabelText(m.schedules_field_name())).not.toBeInTheDocument();
    expect(cardEscape).not.toHaveBeenCalled();
  });

  it("says so when no repo has schedules", async () => {
    mockApi([]);
    render(SettingsSchedulesPanel, {});
    await expect.element(page.getByText(m.settings_schedules_empty())).toBeVisible();
  });
});

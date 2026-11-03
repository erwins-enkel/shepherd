import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import { getLastUpdate, getUpdate } from "#lib/api.js";
import { m } from "#lib/paraglide/messages.js";
import type { UpdateCallRecord, UpdateStatus } from "#lib/types.js";
import SettingsUpdatePanel from "./SettingsUpdatePanel.svelte";

vi.mock("#lib/api.js", async (original) => ({
  ...(await original<typeof import("#lib/api.js")>()),
  getUpdate: vi.fn(),
  getLastUpdate: vi.fn(),
}));

const status: UpdateStatus = {
  behind: 0,
  current: "ccccccc",
  latest: "ccccccc",
  commits: [],
  checkedAt: 1,
};

const record = (over: Partial<UpdateCallRecord>): UpdateCallRecord => ({
  v: 1,
  requestId: null,
  at: Date.UTC(2026, 10, 3, 12),
  outcome: "applied",
  reason: null,
  from: "aaaaaaa",
  to: "bbbbbbb",
  discard: false,
  caller: { kind: "surface", ua: "Mozilla/5.0 (X11; Linux) Firefox/140.0" },
  session: null,
  machine: null,
  ...over,
});

const time = (at: number) =>
  new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getUpdate).mockResolvedValue(status);
});

it("names the surface and device behind the last update, with the commits", async () => {
  const last = record({});
  vi.mocked(getLastUpdate).mockResolvedValue(last);
  render(SettingsUpdatePanel);
  const origin = m.update_origin_surface_device({ device: "Firefox · Linux" });
  await expect
    .element(page.getByText(m.settings_update_last_applied({ time: time(last.at), origin })))
    .toBeVisible();
  await expect.element(page.getByText("aaaaaaa → bbbbbbb")).toBeVisible();
  await expect.element(page.getByText("ccccccc")).toBeVisible();
});

it("names the agent session ahead of the token it used", async () => {
  const last = record({
    outcome: "started",
    caller: { kind: "token", name: "ci-box", client: "other", ua: null },
    session: { id: "66666666-7777-4888-8999-000000000000", desig: "TASK-07" },
  });
  vi.mocked(getLastUpdate).mockResolvedValue(last);
  render(SettingsUpdatePanel);
  const origin = m.update_origin_session({
    session: "TASK-07",
    caller: m.update_origin_token({ name: "ci-box" }),
  });
  await expect
    .element(page.getByText(m.settings_update_last_started({ time: time(last.at), origin })))
    .toBeVisible();
});

it("says so when nothing is on record yet", async () => {
  vi.mocked(getLastUpdate).mockResolvedValue(null);
  render(SettingsUpdatePanel);
  await expect.element(page.getByText(m.settings_update_last_none())).toBeVisible();
});

it("reports a load failure in place", async () => {
  vi.mocked(getLastUpdate).mockRejectedValue(new Error("boom"));
  render(SettingsUpdatePanel);
  await expect.element(page.getByRole("alert")).toHaveTextContent(m.settings_update_load_failed());
});

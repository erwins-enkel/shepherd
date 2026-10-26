import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import SettingsSchedulesPanel from "./SettingsSchedulesPanel.svelte";
import { m } from "#lib/paraglide/messages.js";

// Its own file: the schedules store is a module singleton, and this needs one that has never
// loaded the every-repo list (#3475).
afterEach(() => vi.restoreAllMocks());

it("a failed first load says so instead of loading forever, and Retry reloads", async () => {
  let ok = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    ok ? new Response(JSON.stringify({ schedules: [] })) : new Response("boom", { status: 500 }),
  );
  render(SettingsSchedulesPanel, {});
  await expect.element(page.getByText(m.settings_schedules_load_failed())).toBeVisible();
  ok = true;
  await page.getByRole("button", { name: m.common_retry() }).click();
  await expect.element(page.getByText(m.settings_schedules_empty())).toBeVisible();
});

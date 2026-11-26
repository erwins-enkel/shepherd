import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import { m } from "#lib/paraglide/messages.js";
import { getPostgresRepos, getSettings, putPostgresSettings } from "#lib/api.js";
import type { PostgresSettings, Settings } from "#lib/types.js";
import SettingsPostgresBlock from "./SettingsPostgresBlock.svelte";

vi.mock("#lib/api.js", async (original) => ({
  ...(await original<typeof import("#lib/api.js")>()),
  getSettings: vi.fn(),
  getPostgresRepos: vi.fn(),
  putPostgresSettings: vi.fn(),
}));

let settings: PostgresSettings;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getPostgresRepos).mockResolvedValue({ repos: [] });
  settings = { enabled: false, port: 54318, idleMinutes: 15, image: "postgres:18" };
  vi.mocked(getSettings).mockImplementation(
    async () => ({ postgres: structuredClone(settings) }) as Settings,
  );
  vi.mocked(putPostgresSettings).mockImplementation(async (patch) => {
    settings = { ...settings, ...patch };
    return { postgres: structuredClone(settings) };
  });
});

const port = () => page.getByRole("spinbutton", { name: m.postgres_settings_port() });

it("fields stay disabled until Postgres is turned on, then save on change", async () => {
  render(SettingsPostgresBlock);
  await expect.element(port()).toBeDisabled();
  await page.getByRole("switch", { name: m.postgres_settings_enabled() }).click();
  expect(putPostgresSettings).toHaveBeenCalledWith({ enabled: true });
  await expect.element(port()).toBeEnabled();
  await port().fill("6000");
  (port().element() as HTMLInputElement).dispatchEvent(new Event("change", { bubbles: true }));
  await vi.waitFor(() => expect(putPostgresSettings).toHaveBeenLastCalledWith({ port: 6000 }));
  await expect.element(port()).toHaveValue(6000);
});

it("rejects an out-of-range port without saving and shows a save failure", async () => {
  settings.enabled = true;
  render(SettingsPostgresBlock);
  await port().fill("80");
  (port().element() as HTMLInputElement).dispatchEvent(new Event("change", { bubbles: true }));
  expect(putPostgresSettings).not.toHaveBeenCalled();
  vi.mocked(putPostgresSettings).mockRejectedValueOnce(new Error("400"));
  const idle = page.getByRole("spinbutton", { name: m.postgres_settings_idle() });
  await idle.fill("5");
  (idle.element() as HTMLInputElement).dispatchEvent(new Event("change", { bubbles: true }));
  await expect.element(page.getByText(m.postgres_settings_save_failed())).toBeVisible();
});

it("an older server without postgres settings shows unavailable", async () => {
  vi.mocked(getSettings).mockImplementation(async () => ({}) as Settings);
  render(SettingsPostgresBlock);
  await expect.element(page.getByText(m.postgres_settings_unavailable())).toBeVisible();
});

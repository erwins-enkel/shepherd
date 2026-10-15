import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import { m } from "#lib/paraglide/messages.js";
import type { AssistantPermissions, Settings } from "#lib/types.js";
import { putAssistantPermissions } from "#lib/api.js";
import SettingsAssistantPanel from "./SettingsAssistantPanel.svelte";

vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return { ...actual, putAssistantPermissions: vi.fn() };
});

const DEFAULTS: AssistantPermissions = {
  shell: "read",
  steer: "ask",
  sessions: "ask",
  approve: "ask",
  automation: "ask",
};
const payload = (p: AssistantPermissions = DEFAULTS) =>
  ({ assistantPermissions: p }) as unknown as Settings;

const select = (name: string) => page.getByRole("combobox", { name });

describe("SettingsAssistantPanel", () => {
  beforeEach(() => {
    vi.mocked(putAssistantPermissions).mockReset();
  });

  it("shows the shell row and one row per action group, seeded from the payload", async () => {
    render(SettingsAssistantPanel, { payload: payload({ ...DEFAULTS, approve: "off" }) });
    await expect.element(select(m.settings_assistant_shell_title())).toHaveValue("read");
    await expect.element(select(m.settings_assistant_steer_title())).toHaveValue("ask");
    await expect.element(select(m.settings_assistant_sessions_title())).toHaveValue("ask");
    await expect.element(select(m.settings_assistant_approve_title())).toHaveValue("off");
    await expect.element(select(m.settings_assistant_automation_title())).toHaveValue("ask");
  });

  it("saves one row at a time and keeps the server's merged answer", async () => {
    vi.mocked(putAssistantPermissions).mockResolvedValue({
      assistantPermissions: { ...DEFAULTS, steer: "allow" },
    });
    render(SettingsAssistantPanel, { payload: payload() });
    await select(m.settings_assistant_steer_title()).selectOptions("allow");
    await vi.waitFor(() =>
      expect(putAssistantPermissions).toHaveBeenCalledExactlyOnceWith({ steer: "allow" }),
    );
    await expect.element(select(m.settings_assistant_steer_title())).toHaveValue("allow");
  });

  it("puts the row back when the save fails", async () => {
    vi.mocked(putAssistantPermissions).mockRejectedValue(new Error("boom"));
    render(SettingsAssistantPanel, { payload: payload() });
    await select(m.settings_assistant_shell_title()).selectOptions("all");
    await vi.waitFor(() => expect(putAssistantPermissions).toHaveBeenCalledOnce());
    await expect.element(select(m.settings_assistant_shell_title())).toHaveValue("read");
  });
});

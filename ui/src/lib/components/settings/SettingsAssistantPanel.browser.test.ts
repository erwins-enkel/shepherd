import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import { getLocale, setLocale } from "#lib/paraglide/runtime.js";
import "../../../app.css";
import { m } from "#lib/paraglide/messages.js";
import type { AssistantPermissions, Settings } from "#lib/types.js";
import {
  putAssistantRuntime,
  switchOperatorAssistants,
  putAssistantPermissions,
} from "#lib/api.js";
import SettingsAssistantPanel from "./SettingsAssistantPanel.svelte";

vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return {
    ...actual,
    putAssistantPermissions: vi.fn(),
    putAssistantRuntime: vi.fn(),
    switchOperatorAssistants: vi.fn(),
  };
});

const DEFAULTS: AssistantPermissions = {
  shell: "read",
  steer: "ask",
  start: "allow",
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
    await expect.element(select(m.settings_assistant_start_title())).toHaveValue("allow");
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

const runtime = {
  enabled: true,
  preferredProvider: "claude" as const,
  automaticFallback: true,
  claude: { model: "opus", effort: "high" },
  codex: { model: "gpt-6-astra", effort: "high" },
};

describe("HUD runtime preferences", () => {
  it("saves its provider independently and switches all open conversations only on request", async () => {
    vi.mocked(putAssistantRuntime).mockResolvedValue({
      assistantRuntime: { ...runtime, preferredProvider: "codex" },
    });
    vi.mocked(switchOperatorAssistants).mockResolvedValue({ switches: {} });
    render(SettingsAssistantPanel, { payload: { ...payload(), assistantRuntime: runtime } });
    await select(m.settings_assistant_runtime_provider()).selectOptions("codex");
    await vi.waitFor(() =>
      expect(putAssistantRuntime).toHaveBeenCalledWith({ ...runtime, preferredProvider: "codex" }),
    );
    expect(switchOperatorAssistants).not.toHaveBeenCalled();
    await page.getByRole("button", { name: m.settings_assistant_runtime_switch() }).click();
    await vi.waitFor(() => expect(switchOperatorAssistants).toHaveBeenCalledOnce());
  });
});

for (const locale of ["en", "de"] as const) {
  it(`keeps runtime controls within a narrow ${locale} viewport and keyboard reachable`, async () => {
    const originalLocale = getLocale();
    await page.viewport(390, 844);
    setLocale(locale, { reload: false });
    try {
      render(SettingsAssistantPanel, { payload: { ...payload(), assistantRuntime: runtime } });
      const provider = select(m.settings_assistant_runtime_provider());
      await expect.element(provider).toBeVisible();
      provider.element().focus();
      await userEvent.keyboard("{Tab}");
      expect(document.activeElement?.getAttribute("aria-label")).toBe(
        m.settings_assistant_runtime_model({ provider: "Claude" }),
      );
      for (const control of document.querySelectorAll("select")) {
        const rect = control.getBoundingClientRect();
        expect(rect.left).toBeGreaterThanOrEqual(0);
        expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
      }
    } finally {
      setLocale(originalLocale, { reload: false });
      await page.viewport(1280, 900);
    }
  });
}

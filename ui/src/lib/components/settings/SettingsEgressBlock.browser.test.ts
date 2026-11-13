import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import { putEgressMutedHosts, putEgressStandardDefault, putEgressStandardHosts } from "#lib/api.js";
import { m } from "#lib/paraglide/messages.js";
import type { Settings } from "#lib/types.js";

vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return {
    ...actual,
    putEgressStandardHosts: vi.fn(),
    putEgressStandardDefault: vi.fn(),
    putEgressMutedHosts: vi.fn(),
  };
});

const { default: SettingsEgressBlock } = await import("./SettingsEgressBlock.svelte");

const payload = {
  egressStandardHosts: ["registry.npmjs.org"],
  egressStandardDefault: false,
  egressMutedHosts: ["ph.varlock.dev"],
} as Settings;

const saved = (over: Partial<Settings>) => ({ ...payload, ...over }) as never;

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("SettingsEgressBlock", () => {
  it("adds a standard host and shows the saved list", async () => {
    vi.mocked(putEgressStandardHosts).mockImplementation(async (hosts) =>
      saved({ egressStandardHosts: hosts }),
    );
    render(SettingsEgressBlock, { payload });
    const input = page.getByRole("textbox", { name: m.settings_egress_standard_title() });
    await input.fill("cdn.playwright.dev");
    await page.getByRole("button", { name: m.automation_egress_hosts_add() }).first().click();
    expect(putEgressStandardHosts).toHaveBeenCalledWith([
      "registry.npmjs.org",
      "cdn.playwright.dev",
    ]);
    await expect.element(page.getByText("cdn.playwright.dev", { exact: true })).toBeVisible();
  });

  it("flips the repo default", async () => {
    vi.mocked(putEgressStandardDefault).mockResolvedValue(saved({ egressStandardDefault: true }));
    render(SettingsEgressBlock, { payload });
    const sw = page.getByRole("switch", { name: m.settings_egress_standard_default_title() });
    await sw.click();
    expect(putEgressStandardDefault).toHaveBeenCalledWith(true);
    await expect.element(sw).toHaveAttribute("aria-checked", "true");
  });

  it("refuses a muted entry with a port and unmutes a host", async () => {
    vi.mocked(putEgressMutedHosts).mockImplementation(async (hosts) =>
      saved({ egressMutedHosts: hosts }),
    );
    render(SettingsEgressBlock, { payload });
    await page
      .getByRole("textbox", { name: m.settings_egress_muted_title() })
      .fill("x.example.com:8443");
    await page.getByRole("button", { name: m.automation_egress_hosts_add() }).nth(1).click();
    await expect.element(page.getByText(m.settings_egress_muted_err_invalid())).toBeVisible();
    expect(putEgressMutedHosts).not.toHaveBeenCalled();

    await page
      .getByRole("button", { name: m.settings_egress_muted_remove({ host: "ph.varlock.dev" }) })
      .click();
    expect(putEgressMutedHosts).toHaveBeenCalledWith([]);
    await expect.element(page.getByText(m.settings_egress_muted_empty())).toBeVisible();
  });
});

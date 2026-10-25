import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../../app.css";
import { m } from "#lib/paraglide/messages.js";
import { getSettings, putIssueFilter } from "#lib/api.js";
import { issueFilterSettings } from "#lib/issue-filter-settings.svelte.js";
import { DEFAULT_ISSUE_FILTER } from "#lib/issue-filter-migration.js";
import type { IssueFilterSettings, Settings } from "#lib/types.js";

// The server holds the filter; a write merges its patch and answers the full value.
let server: IssueFilterSettings;
vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return {
    ...actual,
    getSettings: vi.fn(async () => ({ issueFilter: server }) as unknown as Settings),
    putIssueFilter: vi.fn(async (patch: Partial<IssueFilterSettings>) => {
      server = { ...server, ...patch };
      return { issueFilter: server };
    }),
  };
});

const { default: SettingsIssueFilterBlock } = await import("./SettingsIssueFilterBlock.svelte");

beforeEach(() => {
  server = structuredClone(DEFAULT_ISSUE_FILTER);
  issueFilterSettings.clear();
  vi.mocked(putIssueFilter).mockClear();
});
afterEach(() => {
  issueFilterSettings.clear();
  document.body.innerHTML = "";
});

const seg = (group: string, label: string) =>
  page.getByRole("group", { name: group }).getByRole("button", { name: label, exact: true });

describe("SettingsIssueFilterBlock (#3019)", () => {
  it("loads the server value and shows the summary line", async () => {
    server = { ...server, scope: "mine", hiddenLabels: ["docs"] };
    render(SettingsIssueFilterBlock, {});
    await expect
      .element(seg(m.upnext_filter_scope_heading(), m.upnext_filter_scope_mine()))
      .toHaveAttribute("aria-pressed", "true");
    expect(vi.mocked(getSettings)).toHaveBeenCalled();
    await expect.element(page.getByText(m.settings_issue_filter_summary())).toBeInTheDocument();
    await expect.element(page.getByText("docs", { exact: true })).toBeInTheDocument();
  });

  it("round-trips every control through the server setting", async () => {
    render(SettingsIssueFilterBlock, {});
    await seg(m.upnext_filter_scope_heading(), m.upnext_filter_scope_all()).click();
    await seg(m.upnext_filter_forks_heading(), m.upnext_filter_forks_hide()).click();
    await page.getByRole("switch", { name: m.issues_filter_active_label() }).click();
    await page.getByRole("switch", { name: m.issues_filter_blocked_label() }).click();
    await page.getByRole("button", { name: m.settings_issue_filter_add_label() }).click();
    await userEvent.keyboard("wontfix{Enter}");
    await expect
      .poll(() => server)
      .toEqual({
        ...DEFAULT_ISSUE_FILTER,
        scope: "all",
        forks: "hide",
        hideActive: true,
        hideBlocked: false,
        hiddenLabels: ["wontfix"],
      });
    await expect
      .element(seg(m.upnext_filter_forks_heading(), m.upnext_filter_forks_hide()))
      .toHaveAttribute("aria-pressed", "true");

    await page
      .getByRole("button", { name: m.settings_issue_filter_remove_label({ label: "wontfix" }) })
      .click();
    await expect.poll(() => server.hiddenLabels).toEqual([]);
    expect(vi.mocked(putIssueFilter).mock.calls.at(-1)?.[0]).toEqual({ hiddenLabels: [] });
  });

  it("ignores a blank or already-hidden label", async () => {
    server = { ...server, hiddenLabels: ["Docs"] };
    render(SettingsIssueFilterBlock, {});
    await page.getByRole("button", { name: m.settings_issue_filter_add_label() }).click();
    await userEvent.keyboard("docs{Enter}");
    await page.getByRole("button", { name: m.settings_issue_filter_add_label() }).click();
    await userEvent.keyboard("   {Enter}");
    expect(putIssueFilter).not.toHaveBeenCalled();
  });

  it("follows a change pushed from another surface", async () => {
    render(SettingsIssueFilterBlock, {});
    await expect
      .element(seg(m.upnext_filter_scope_heading(), m.upnext_filter_scope_mine_unassigned()))
      .toHaveAttribute("aria-pressed", "true");
    issueFilterSettings.apply({ ...DEFAULT_ISSUE_FILTER, scope: "mine" });
    await expect
      .element(seg(m.upnext_filter_scope_heading(), m.upnext_filter_scope_mine()))
      .toHaveAttribute("aria-pressed", "true");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import { m } from "#lib/paraglide/messages.js";
import { putIssueFilter } from "#lib/api.js";
import { issueFilterSettings } from "#lib/issue-filter-settings.svelte.js";
import { DEFAULT_ISSUE_FILTER } from "#lib/issue-filter-migration.js";
import { repos } from "#lib/repos.svelte.js";
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

const { default: SettingsRepoOverridesBlock } = await import("./SettingsRepoOverridesBlock.svelte");

beforeEach(() => {
  server = structuredClone(DEFAULT_ISSUE_FILTER);
  issueFilterSettings.clear();
  vi.mocked(putIssueFilter).mockClear();
  repos.entries = [
    { name: "app", path: "/root/app", realPath: "/real/app", display: "app", isFork: false },
    { name: "lib", path: "/root/lib", realPath: "/real/lib", display: "lib", isFork: true },
  ] as typeof repos.entries;
});
afterEach(() => {
  issueFilterSettings.clear();
  repos.entries = [];
  document.body.innerHTML = "";
});

const select = (repo: string) =>
  page.getByRole("combobox", { name: m.settings_repo_overrides_select_aria({ repo }) });
const row = (repo: string) => document.querySelector(`tr[data-repo="${repo}"]`);

describe("SettingsRepoOverridesBlock (#3020)", () => {
  it("lists every repo with a FORK tag and the stored override", async () => {
    server = { ...server, repoOverrides: { "/real/lib": "all" } };
    render(SettingsRepoOverridesBlock, {});
    await expect.element(select("lib")).toHaveValue("all");
    await expect.element(select("app")).toHaveValue("standard");
    expect(row("lib")?.textContent).toContain(m.upnext_filter_tag_fork());
    expect(row("app")?.textContent).not.toContain(m.upnext_filter_tag_fork());
    expect(row("lib")?.classList.contains("differs")).toBe(true);
    expect(row("app")?.classList.contains("differs")).toBe(false);
  });

  it("round-trips a choice through the server, keyed by realpath; Standard removes it", async () => {
    render(SettingsRepoOverridesBlock, {});
    await select("app").selectOptions("hide");
    expect(vi.mocked(putIssueFilter)).toHaveBeenLastCalledWith({
      repoOverrides: { "/real/app": "hide" },
    });
    await expect.poll(() => server.repoOverrides).toEqual({ "/real/app": "hide" });
    await expect.poll(() => row("app")?.classList.contains("differs")).toBe(true);

    // A fresh load reads the persisted value back.
    issueFilterSettings.clear();
    document.body.innerHTML = "";
    render(SettingsRepoOverridesBlock, {});
    await expect.element(select("app")).toHaveValue("hide");

    await select("app").selectOptions("standard");
    await expect.poll(() => server.repoOverrides).toEqual({});
    await expect.poll(() => row("app")?.classList.contains("differs")).toBe(false);
  });

  it("matches a raw-path key, and rewrites it under the realpath on change", async () => {
    server = { ...server, repoOverrides: { "/root/app": "mine" } };
    render(SettingsRepoOverridesBlock, {});
    await expect.element(select("app")).toHaveValue("mine");
    await select("app").selectOptions("all");
    expect(vi.mocked(putIssueFilter)).toHaveBeenLastCalledWith({
      repoOverrides: { "/real/app": "all" },
    });
  });
});

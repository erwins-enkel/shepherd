import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import { m } from "#lib/paraglide/messages.js";
import type { RepoRunDefaults } from "#lib/api.js";
import { effortLabel } from "#lib/effort-guidance.js";
import { repoConfig } from "#lib/reviews.svelte.js";
import { repoSettingsWindow } from "#lib/repo-settings-window.svelte.js";

// The server's list, and the repo config the repo window loads and writes.
let server: RepoRunDefaults[] = [];
let cfg: Record<string, unknown> = {};
vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return {
    ...actual,
    getRepoRunDefaults: vi.fn(async () => ({ repos: server })),
    getRepoConfig: vi.fn(async () => cfg),
  };
});

const { default: Block } = await import("./SettingsRepoRunDefaultsBlock.svelte");

const own = (over: Partial<RepoRunDefaults>): RepoRunDefaults => ({
  repoPath: "/real/app",
  name: "app",
  agentProvider: "inherit",
  defaultModel: "inherit",
  defaultEffort: "inherit",
  defaultExecutionEffort: "inherit",
  ...over,
});
const cells = (repo: string) =>
  [...(document.querySelector(`tr[data-repo="${repo}"]`)?.children ?? [])].map((c) =>
    c.textContent?.trim(),
  );

afterEach(() => {
  repoSettingsWindow.target = null;
  repoConfig.loaded = {};
  server = [];
  document.body.innerHTML = "";
});

describe("SettingsRepoRunDefaultsBlock (#3447)", () => {
  it("lists a repo's own values and marks inherited ones", async () => {
    server = [
      own({ agentProvider: "codex", defaultEffort: "high", defaultExecutionEffort: "default" }),
    ];
    render(Block, { defaultAgentProvider: "claude" });
    await expect.element(page.getByRole("button", { name: /app/ })).toBeVisible();
    expect(cells("app")).toEqual([
      "app",
      m.agent_provider_codex(),
      m.settings_repo_run_defaults_inherits(),
      effortLabel("high"),
      m.execution_effort_same_as_planning(),
      m.settings_repo_run_defaults_open(),
    ]);
  });

  it("says every repo follows the defaults when none has its own value", async () => {
    render(Block, { defaultAgentProvider: "claude" });
    await expect.element(page.getByText(m.settings_repo_run_defaults_none())).toBeVisible();
    expect(document.querySelector("table")).toBeNull();
  });

  it("drops a model the effective CLI cannot run", async () => {
    server = [own({ defaultModel: "opus" })];
    render(Block, { defaultAgentProvider: "codex" });
    await expect.element(page.getByText(m.settings_repo_run_defaults_none())).toBeVisible();
  });

  it("Open shows the repo window at Agent environment; set back to inherit, the row leaves", async () => {
    server = [own({ agentProvider: "codex" })];
    render(Block, { defaultAgentProvider: "claude" });
    const open = page.getByRole("button", {
      name: m.settings_repo_run_defaults_open_aria({ repo: "app" }),
    });
    await open.click();
    expect(repoSettingsWindow.target).toMatchObject({ repoPath: "/real/app", section: "agent" });

    // The window loads the repo's config; it now inherits everything.
    cfg = { ...own({}), automationConfirmed: true, automationRowExists: true };
    await repoConfig.reload("/real/app");
    await expect.element(page.getByText(m.settings_repo_run_defaults_none())).toBeVisible();
  });
});

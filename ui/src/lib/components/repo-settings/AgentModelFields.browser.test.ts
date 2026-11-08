import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import { repoConfig } from "#lib/reviews.svelte.js";
import { m } from "#lib/paraglide/messages.js";
import type { AgentProvider, Settings } from "#lib/types.js";
import "../../../app.css";
import AgentModelFields from "./AgentModelFields.svelte";

/** The global settings an "inherit" follows. */
const globals = (cli: AgentProvider, over: Partial<Settings> = {}) =>
  ({
    defaultAgentProvider: cli,
    defaultModel: "opus",
    defaultCodexModel: "default",
    defaultEffort: "high",
    defaultClaudeEffort: "inherit",
    defaultCodexEffort: "inherit",
    defaultExecutionEffort: "default",
    ...over,
  }) as Settings;

it("saves ultra as a shared repository effort preference on a Codex repo", async () => {
  const save = vi.spyOn(repoConfig, "setDefaultEffort").mockResolvedValue(undefined);
  try {
    render(AgentModelFields, {
      repoPath: "/repo/ultra",
      fableAvailable: false,
      globals: globals("codex"),
    });
    await page
      .getByRole("combobox", { name: m.automation_default_effort_label() })
      .selectOptions("ultra");
    expect(save).toHaveBeenCalledWith("/repo/ultra", "ultra");
  } finally {
    save.mockRestore();
  }
});

describe("AgentModelFields coding CLI (#3441)", () => {
  const cliSelect = () => page.getByRole("combobox", { name: m.automation_coding_cli_label() });
  const modelSelect = () =>
    page.getByRole("combobox", { name: m.automation_default_model_label() });
  const effortSelect = () =>
    page.getByRole("combobox", { name: m.automation_default_effort_label() });
  const optionValues = (el: HTMLElement) =>
    Array.from((el as HTMLSelectElement).options).map((o) => o.value);
  const pin = (repo: string, cli: "inherit" | "claude" | "codex", model = "inherit") => {
    repoConfig.agentProvider = { ...repoConfig.agentProvider, [repo]: cli };
    repoConfig.defaultModel = { ...repoConfig.defaultModel, [repo]: model };
  };

  it("offers Inherit / Claude Code / Codex above the model and saves a pick", async () => {
    const save = vi.spyOn(repoConfig, "setAgentProvider").mockResolvedValue(undefined);
    try {
      render(AgentModelFields, {
        repoPath: "/repo/cli-pick",
        fableAvailable: false,
        globals: globals("claude"),
      });
      await expect.element(cliSelect()).toHaveValue("inherit");
      expect(optionValues(cliSelect().element() as HTMLElement)).toEqual([
        "inherit",
        "claude",
        "codex",
      ]);
      await expect
        .element(page.getByText(m.automation_coding_cli_hint_inherit({ cli: "Claude Code" })))
        .toBeVisible();
      await cliSelect().selectOptions("codex");
      expect(save).toHaveBeenCalledWith("/repo/cli-pick", "codex");
    } finally {
      save.mockRestore();
    }
  });

  it("lists only the effective CLI's models and efforts", async () => {
    pin("/repo/cli-codex", "codex", "gpt-5.4");
    render(AgentModelFields, {
      repoPath: "/repo/cli-codex",
      fableAvailable: false,
      globals: globals("claude"),
    });
    await expect.element(modelSelect()).toHaveValue("gpt-5.4");
    const models = optionValues(modelSelect().element() as HTMLElement);
    expect(models).toContain("gpt-5.4");
    expect(models).not.toContain("opus");
    expect(optionValues(effortSelect().element() as HTMLElement)).toContain("ultra");
    await expect
      .element(page.getByText(m.automation_coding_cli_hint_repo({ cli: "Codex" })))
      .toBeVisible();
  });

  it("shows Inherit for a stored model the effective CLI cannot run", async () => {
    pin("/repo/cli-unfit", "inherit", "opus");
    render(AgentModelFields, {
      repoPath: "/repo/cli-unfit",
      fableAvailable: false,
      globals: globals("codex"),
    });
    await expect.element(modelSelect()).toHaveValue("inherit");
    expect(optionValues(modelSelect().element() as HTMLElement)).not.toContain("opus");
    expect(optionValues(effortSelect().element() as HTMLElement)).toContain("ultra");
  });

  it("drops ultra from the effort list on a Claude repo", async () => {
    pin("/repo/cli-claude", "claude");
    render(AgentModelFields, {
      repoPath: "/repo/cli-claude",
      fableAvailable: false,
      globals: globals("codex"),
    });
    await expect.element(cliSelect()).toHaveValue("claude");
    expect(optionValues(effortSelect().element() as HTMLElement)).not.toContain("ultra");
    expect(optionValues(modelSelect().element() as HTMLElement)).toContain("opus");
  });
});

describe("AgentModelFields next start (#3443)", () => {
  const line = () => document.querySelector<HTMLElement>("[data-next-start]");

  it("waits for the global settings before naming the next start", async () => {
    render(AgentModelFields, { repoPath: "/repo/next-none", fableAvailable: false, globals: null });
    await expect
      .element(page.getByRole("combobox", { name: m.automation_coding_cli_label() }))
      .toBeVisible();
    expect(line()).toBeNull();
  });

  it("names each part with where it comes from, and the switch at Go", async () => {
    repoConfig.agentProvider = { ...repoConfig.agentProvider, "/repo/next": "codex" };
    repoConfig.defaultExecutionEffort = {
      ...repoConfig.defaultExecutionEffort,
      "/repo/next": "max",
    };
    render(AgentModelFields, {
      repoPath: "/repo/next",
      fableAvailable: false,
      globals: globals("claude"),
    });
    await expect.element(page.getByText(m.reposettings_next_start_label())).toBeVisible();
    const text = line()!.textContent!.replace(/\s+/g, " ");
    expect(text).toContain(`${m.agent_provider_codex()}${m.reposettings_origin_repo()}`);
    expect(text).toContain(`${m.newtask_model_default()}${m.reposettings_origin_global()}`);
    expect(text).toContain(m.reposettings_next_start_go({ effort: m.effort_label_max() }));
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import EpicPanel from "./EpicPanel.svelte";
import type { Epic } from "$lib/types";
import { m } from "$lib/paraglide/messages";

const api = vi.hoisted(() => ({
  updateEpic: vi.fn(async () => ({})),
  approveEpicNext: vi.fn(async () => ({})),
  importEpic: vi.fn(async () => ({})),
}));

vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return { ...actual, ...api };
});

function epic(over: Partial<Epic["run"]> = {}): Epic {
  return {
    repoPath: "/repo",
    parentIssueNumber: 327,
    parentTitle: "Epic parent",
    source: "native",
    children: [],
    warnings: [],
    run: {
      repoPath: "/repo",
      parentIssueNumber: 327,
      mode: "auto",
      status: "running",
      agentProvider: null,
      model: null,
      effort: null,
      ...over,
    },
  };
}

function changeSelect(label: string, value: string) {
  const select = page.getByLabelText(label).element() as HTMLSelectElement;
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  api.updateEpic.mockClear();
  api.approveEpicNext.mockClear();
  api.importEpic.mockClear();
});

describe("EpicPanel provider settings", () => {
  it("renders inherited CLI state and persists provider selection", async () => {
    render(EpicPanel, { repoPath: "/repo", parent: 327, epic: epic() });

    expect(
      (page.getByLabelText(m.epic_provider_label()).element() as HTMLSelectElement).value,
    ).toBe("inherit");
    changeSelect(m.epic_provider_label(), "codex");

    expect(api.updateEpic).toHaveBeenCalledWith("/repo", 327, {
      agentProvider: "codex",
      model: null,
      effort: null,
    });
  });

  it("persists model changes for an explicit provider", async () => {
    render(EpicPanel, {
      repoPath: "/repo",
      parent: 327,
      epic: epic({ agentProvider: "codex", model: null, effort: null }),
    });

    changeSelect(m.epic_model_label(), "gpt-5.5");

    expect(api.updateEpic).toHaveBeenCalledWith("/repo", 327, { model: "gpt-5.5" });
  });
});

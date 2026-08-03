import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../../app.css";
import type { PromptBudgetRecord } from "$lib/types";

const { default: PromptLens } = await import("./PromptLens.svelte");

afterEach(() => {
  document.body.innerHTML = "";
});

const record = (over: Partial<PromptBudgetRecord> = {}): PromptBudgetRecord => ({
  sessionId: "s-1",
  desig: "TASK-1",
  repoPath: "/repo",
  agentProvider: "claude",
  auto: false,
  delivery: "append-system-prompt",
  // 100 + 300 + 20 block chars + 2 separators × 2 chars = 424
  totalChars: 424,
  totalBytes: 430,
  totalTokens: 105,
  blocks: [
    { name: "engineering-posture", chars: 100, bytes: 102, tokens: 25 },
    { name: "tmpfs-worktree-notice", chars: 300, bytes: 304, tokens: 75 },
    { name: "branch-rename-notice", chars: 20, bytes: 20, tokens: 5 },
  ],
  createdAt: 1_000,
  ...over,
});

const blockNames = () =>
  Array.from(document.querySelectorAll(".block-name")).map((n) => n.textContent?.trim());

describe("PromptLens", () => {
  it("renders the newest spawn's totals and one row per block, largest first", async () => {
    render(PromptLens, { records: [record()] });

    expect(blockNames()).toEqual([
      "tmpfs-worktree-notice",
      "engineering-posture",
      "branch-rename-notice",
    ]);

    const totals = Array.from(document.querySelectorAll(".total-value")).map((n) =>
      n.textContent?.trim(),
    );
    expect(totals[0]).toBe((424).toLocaleString());
    expect(totals[1]).toBe((430).toLocaleString());
    // Tokens are an estimate and must be marked as one wherever they appear.
    expect(totals[2]).toBe("≈" + (105).toLocaleString());
    expect(document.querySelectorAll(".block-tokens")[0]?.textContent).toMatch(/^≈/);
  });

  it("block shares are of the blocks, not of the separator-inclusive total", async () => {
    render(PromptLens, { records: [record()] });
    const pcts = Array.from(document.querySelectorAll(".block-pct")).map((n) => n.textContent);
    // 300/420, 100/420, 20/420 — never computed against totalChars (424), which could not reach 100%.
    expect(pcts).toEqual(["71%", "24%", "5%"]);
  });

  it("picking a different spawn re-renders that spawn's blocks", async () => {
    const other = record({
      sessionId: "s-2",
      desig: "TASK-2",
      auto: true,
      agentProvider: "codex",
      delivery: "inline-prompt",
      totalChars: 12,
      totalBytes: 12,
      totalTokens: 3,
      blocks: [{ name: "research-directive", chars: 10, bytes: 10, tokens: 3 }],
    });
    render(PromptLens, { records: [record(), other] });

    // Defaults to the first (newest) record.
    expect(blockNames()).toEqual([
      "tmpfs-worktree-notice",
      "engineering-posture",
      "branch-rename-notice",
    ]);

    const select = document.querySelector("select") as HTMLSelectElement;
    expect(select.options.length).toBe(2);
    select.value = "s-2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    expect(blockNames()).toEqual(["research-directive"]);
    // A drain spawn on Codex delivers the same payload inline, not on --append-system-prompt.
    expect(document.querySelector(".delivery")?.textContent?.trim()).toBe("inline on the prompt");
  });

  it("shows an empty state rather than a broken panel when nothing was measured", async () => {
    render(PromptLens, { records: [] });
    expect(document.querySelectorAll(".block-row").length).toBe(0);
    expect(document.querySelector(".muted")?.textContent?.trim()).not.toBe("");
  });
});

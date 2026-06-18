import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import VisualReview from "./VisualReview.svelte";
import type { VisualBlock } from "$lib/types";

describe("VisualReview dispatcher", () => {
  it("renders a rich-text block content", async () => {
    const blocks: VisualBlock[] = [{ type: "rich-text", id: "r1", markdown: "**hello world**" }];
    render(VisualReview, { blocks });
    await expect.element(page.getByText("hello world")).toBeInTheDocument();
  });

  it("renders a callout block with tone label", async () => {
    const blocks: VisualBlock[] = [
      { type: "callout", id: "c1", tone: "info", markdown: "Take note." },
    ];
    render(VisualReview, { blocks });
    await expect.element(page.getByText("Info")).toBeInTheDocument();
    await expect.element(page.getByText("Take note.")).toBeInTheDocument();
  });

  it("renders mixed rich-text + callout blocks", async () => {
    const blocks: VisualBlock[] = [
      { type: "rich-text", id: "r1", markdown: "Summary text." },
      { type: "callout", id: "c1", tone: "risk", markdown: "Be careful." },
    ];
    render(VisualReview, { blocks });
    await expect.element(page.getByText("Summary text.")).toBeInTheDocument();
    await expect.element(page.getByText("Risk")).toBeInTheDocument();
    await expect.element(page.getByText("Be careful.")).toBeInTheDocument();
  });

  it("does not throw on unknown block type", () => {
    // file-tree + diff are unhandled in Phase 1 — should render nothing, not throw
    const blocks = [{ type: "file-tree", id: "ft1", entries: [] } as unknown as VisualBlock];
    expect(() => render(VisualReview, { blocks })).not.toThrow();
  });

  it("renders nothing for an empty blocks array", () => {
    const { container } = render(VisualReview, { blocks: [] });
    expect(container.querySelector(".visual-review")?.children.length).toBe(0);
  });
});

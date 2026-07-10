import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import FileTreeBlock from "./FileTreeBlock.svelte";

describe("FileTreeBlock", () => {
  it("renders directory structure from nested paths", async () => {
    const { container } = await render(FileTreeBlock, {
      block: {
        type: "file-tree",
        id: "ft1",
        entries: [
          { path: "src/a.ts", change: "modified" },
          { path: "src/b/c.ts", change: "added" },
        ],
      },
    });
    // "src" should appear exactly once as a parent directory row
    const rows = container.querySelectorAll(".ft-row");
    const texts = Array.from(rows).map((r) => r.textContent?.trim());
    const srcCount = texts.filter(
      (t) => t?.includes("src") && !t?.includes("a.ts") && !t?.includes("b"),
    ).length;
    expect(srcCount).toBe(1);
    // "b" should be a sub-directory
    const bRows = texts.filter((t) => /\bb\b/.test(t ?? ""));
    expect(bRows.length).toBeGreaterThanOrEqual(1);
    // c.ts should appear as a leaf nested under b
    await expect.element(page.getByText("c.ts")).toBeInTheDocument();
  });

  it("shows 'src' parent once and 'a.ts' and 'c.ts' as leaves", async () => {
    render(FileTreeBlock, {
      block: {
        type: "file-tree",
        id: "ft2",
        entries: [
          { path: "src/a.ts", change: "modified" },
          { path: "src/b/c.ts", change: "added" },
        ],
      },
    });
    await expect.element(page.getByText("a.ts")).toBeInTheDocument();
    await expect.element(page.getByText("c.ts")).toBeInTheDocument();
  });

  it("shows localized accessible label for a 'removed' entry", async () => {
    const { container } = await render(FileTreeBlock, {
      block: {
        type: "file-tree",
        id: "ft3",
        entries: [{ path: "old.ts", change: "removed" }],
      },
    });
    // The badge should carry aria-label="Removed"
    const badge = container.querySelector(".ft-badge");
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute("aria-label")).toBe("Removed");
    expect(badge?.getAttribute("title")).toBe("Removed");
    // The visible glyph is "D"
    expect(badge?.textContent?.trim()).toBe("D");
  });

  it("renders a note after the filename", async () => {
    render(FileTreeBlock, {
      block: {
        type: "file-tree",
        id: "ft4",
        entries: [{ path: "readme.md", change: "modified", note: "minor fixes" }],
      },
    });
    await expect.element(page.getByText("minor fixes")).toBeInTheDocument();
  });

  it("renders an optional title as a heading", async () => {
    render(FileTreeBlock, {
      block: {
        type: "file-tree",
        id: "ft5",
        title: "Changed files",
        entries: [{ path: "x.ts", change: "added" }],
      },
    });
    await expect.element(page.getByText("Changed files")).toBeInTheDocument();
  });

  it("renders no title element when title is absent", async () => {
    const { container } = await render(FileTreeBlock, {
      block: {
        type: "file-tree",
        id: "ft6",
        entries: [{ path: "x.ts", change: "added" }],
      },
    });
    expect(container.querySelector(".ft-title")).toBeNull();
  });
});

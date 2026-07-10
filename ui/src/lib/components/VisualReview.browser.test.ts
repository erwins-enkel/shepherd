import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import VisualReview from "./VisualReview.svelte";
import type { VisualBlock, DiffFile } from "$lib/types";

const TEST_DIFF_FILE: DiffFile = {
  path: "src/index.ts",
  status: "modified",
  additions: 1,
  deletions: 1,
  binary: false,
  hunks: [
    {
      header: "@@ -1,2 +1,2 @@",
      lines: [
        { kind: "del", content: "old", oldNo: 1 },
        { kind: "add", content: "new", newNo: 1 },
      ],
    },
  ],
};

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
    // verifies that truly unknown types (not file-tree/diff/rich-text/callout) render nothing, not throw
    const blocks = [{ type: "totally-unknown", id: "u1" } as unknown as VisualBlock];
    expect(() => render(VisualReview, { blocks })).not.toThrow();
  });

  it("renders nothing for an empty blocks array", async () => {
    const { container } = await render(VisualReview, { blocks: [] });
    expect(container.querySelector(".visual-review")?.children.length).toBe(0);
  });

  // ── Task 6 additions ────────────────────────────────────────────────────────

  it("renders a file-tree block (dispatches to FileTreeBlock)", async () => {
    const blocks: VisualBlock[] = [
      {
        type: "file-tree",
        id: "ft1",
        entries: [
          { path: "src/foo.ts", change: "added" },
          { path: "src/bar.ts", change: "modified" },
        ],
      },
    ];
    render(VisualReview, { blocks });
    await expect.element(page.getByText("foo.ts")).toBeInTheDocument();
    await expect.element(page.getByText("bar.ts")).toBeInTheDocument();
  });

  it("renders a diff block with summary (dispatches to DiffBlock)", async () => {
    const blocks: VisualBlock[] = [
      {
        type: "diff",
        id: "d1",
        path: "src/index.ts",
        summary: "Fixed the bug",
        file: TEST_DIFF_FILE,
      },
    ];
    render(VisualReview, { blocks });
    await expect.element(page.getByText("Fixed the bug")).toBeInTheDocument();
  });

  it("shows 'Highlighted changes' heading exactly once for two diff blocks", async () => {
    const blocks: VisualBlock[] = [
      {
        type: "diff",
        id: "d1",
        path: "src/a.ts",
        summary: "First diff",
        file: TEST_DIFF_FILE,
      },
      {
        type: "diff",
        id: "d2",
        path: "src/b.ts",
        summary: "Second diff",
        file: { ...TEST_DIFF_FILE, path: "src/b.ts" },
      },
    ];
    const { container } = await render(VisualReview, { blocks });
    const headings = container.querySelectorAll(".vr-highlight-head");
    expect(headings.length).toBe(1);
    await expect.element(page.getByText(/Highlighted changes/i)).toBeInTheDocument();
  });

  it("shows 'Highlighted changes' heading before the first diff block", async () => {
    const blocks: VisualBlock[] = [
      { type: "rich-text", id: "r1", markdown: "preamble" },
      {
        type: "diff",
        id: "d1",
        path: "src/x.ts",
        summary: "A diff",
        file: TEST_DIFF_FILE,
      },
    ];
    const { container } = await render(VisualReview, { blocks });
    await expect.element(page.getByText(/Highlighted changes/i)).toBeInTheDocument();
    // assert DOM order: heading must precede the first diff block output
    const heading = container.querySelector(".vr-highlight-head");
    const diffSummary = container.querySelector(".diff-summary, .vr-diff-summary, .diff-block");
    expect(heading).not.toBeNull();
    if (heading && diffSummary) {
      // Node.DOCUMENT_POSITION_FOLLOWING (4) means diffSummary comes after heading
      expect(
        heading.compareDocumentPosition(diffSummary) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it("does not show 'Highlighted changes' heading when no diff blocks", async () => {
    const blocks: VisualBlock[] = [{ type: "rich-text", id: "r1", markdown: "No diffs here." }];
    const { container } = await render(VisualReview, { blocks });
    expect(container.querySelector(".vr-highlight-head")).toBeNull();
  });

  // ── Phase 2 block types ──────────────────────────────────────────────────────

  it("renders a code block (dispatches to CodeBlock)", async () => {
    const blocks: VisualBlock[] = [
      { type: "code", id: "cb1", filename: "src/main.ts", code: "const x = 1;" },
    ];
    render(VisualReview, { blocks });
    await expect.element(page.getByText("src/main.ts")).toBeInTheDocument();
  });

  it("renders an annotated-code block (dispatches to AnnotatedCodeBlock)", async () => {
    const blocks: VisualBlock[] = [
      {
        type: "annotated-code",
        id: "acb1",
        filename: "src/handler.ts",
        annotations: [{ label: "Note:", note: "Entry point" }],
      },
    ];
    render(VisualReview, { blocks });
    await expect.element(page.getByText("src/handler.ts")).toBeInTheDocument();
    await expect.element(page.getByText("Entry point")).toBeInTheDocument();
  });

  it("renders a data-model block (dispatches to DataModelBlock)", async () => {
    const blocks: VisualBlock[] = [
      {
        type: "data-model",
        id: "dm1",
        inferred: true,
        entities: [{ id: "e1", name: "Order", fields: [{ name: "id", type: "uuid", pk: true }] }],
      },
    ];
    render(VisualReview, { blocks });
    await expect.element(page.getByText("Order")).toBeInTheDocument();
  });

  it("renders an api-endpoint block (dispatches to ApiEndpointBlock)", async () => {
    const blocks: VisualBlock[] = [
      { type: "api-endpoint", id: "ep1", method: "POST", path: "/api/orders", inferred: true },
    ];
    render(VisualReview, { blocks });
    await expect.element(page.getByText("POST")).toBeInTheDocument();
    await expect.element(page.getByText("/api/orders")).toBeInTheDocument();
  });

  it("renders a table block (dispatches to TableBlock)", async () => {
    const blocks: VisualBlock[] = [
      {
        type: "table",
        id: "tb1",
        columns: ["ConfigKey", "ConfigValue"],
        rows: [["db_host", "localhost"]],
      },
    ];
    const { container } = await render(VisualReview, { blocks });
    await expect.element(page.getByText("ConfigKey")).toBeInTheDocument();
    const cells = Array.from(container.querySelectorAll(".tb-td"));
    expect(cells.some((c) => c.textContent?.includes("db_host"))).toBe(true);
  });

  it("renders a checklist block (dispatches to ChecklistBlock)", async () => {
    const blocks: VisualBlock[] = [
      {
        type: "checklist",
        id: "ck1",
        items: [{ id: "i1", label: "Fix the bug", checked: false }],
      },
    ];
    render(VisualReview, { blocks });
    await expect.element(page.getByText("Fix the bug")).toBeInTheDocument();
  });
});

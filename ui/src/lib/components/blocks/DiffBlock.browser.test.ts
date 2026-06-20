import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import DiffBlock from "./DiffBlock.svelte";
import type { DiffFile } from "$lib/types";

const TEST_FILE: DiffFile = {
  path: "src/index.ts",
  status: "modified",
  additions: 3,
  deletions: 1,
  binary: false,
  hunks: [
    {
      header: "@@ -1,4 +1,6 @@",
      lines: [
        { kind: "ctx", content: "const a = 1;", oldNo: 1, newNo: 1 },
        { kind: "del", content: "const b = 2;", oldNo: 2 },
        { kind: "add", content: "const b = 3;", newNo: 2 },
        { kind: "add", content: "const c = 4;", newNo: 3 },
      ],
    },
  ],
};

describe("DiffBlock", () => {
  it("renders summary text", async () => {
    render(DiffBlock, {
      block: {
        type: "diff",
        id: "d1",
        path: "src/index.ts",
        summary: "Updated constant values",
        file: TEST_FILE,
      },
    });
    await expect.element(page.getByText("Updated constant values")).toBeInTheDocument();
  });

  it("renders the file path via DiffFileBlock when file is present", async () => {
    render(DiffBlock, {
      block: {
        type: "diff",
        id: "d2",
        path: "src/index.ts",
        summary: "Some changes",
        file: TEST_FILE,
      },
    });
    // DiffFileBlock renders the path in a .file-head button
    await expect.element(page.getByText(/src\/index\.ts/)).toBeInTheDocument();
  });

  it("renders path + summary without throwing when file is absent", async () => {
    expect(() =>
      render(DiffBlock, {
        block: {
          type: "diff",
          id: "d3",
          path: "src/missing.ts",
          summary: "Fallback summary",
        },
      }),
    ).not.toThrow();
    await expect.element(page.getByText("Fallback summary")).toBeInTheDocument();
    await expect.element(page.getByText("src/missing.ts")).toBeInTheDocument();
  });

  it("renders annotation label and note", async () => {
    render(DiffBlock, {
      block: {
        type: "diff",
        id: "d4",
        path: "src/index.ts",
        summary: "With annotations",
        file: TEST_FILE,
        annotations: [{ label: "Note:", note: "This is important" }],
      },
    });
    await expect.element(page.getByText("Note:")).toBeInTheDocument();
    await expect.element(page.getByText(/This is important/)).toBeInTheDocument();
  });

  it("separates annotation label and note with whitespace", async () => {
    render(DiffBlock, {
      block: {
        type: "diff",
        id: "d4ws",
        path: "src/index.ts",
        summary: "With annotations",
        file: TEST_FILE,
        annotations: [{ label: "Type", note: "widened openIssues element" }],
      },
    });
    const li = page
      .getByText(/widened openIssues element/)
      .element()
      .closest("li");
    expect(li?.textContent?.replace(/\s+/g, " ").trim()).toBe("Type widened openIssues element");
  });

  it("renders annotation without label", async () => {
    render(DiffBlock, {
      block: {
        type: "diff",
        id: "d5",
        path: "src/index.ts",
        summary: "Plain annotation",
        file: TEST_FILE,
        annotations: [{ note: "No label here" }],
      },
    });
    await expect.element(page.getByText("No label here")).toBeInTheDocument();
  });
});

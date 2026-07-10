import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import ChecklistBlock from "./ChecklistBlock.svelte";

describe("ChecklistBlock", () => {
  it("renders item labels", async () => {
    render(ChecklistBlock, {
      block: {
        type: "checklist",
        id: "cl1",
        items: [
          { id: "i1", label: "Write tests", checked: true },
          { id: "i2", label: "Deploy to prod", checked: false },
        ],
      },
    });
    await expect.element(page.getByText("Write tests")).toBeInTheDocument();
    await expect.element(page.getByText("Deploy to prod")).toBeInTheDocument();
  });

  it("renders checked glyph for checked items", async () => {
    const { container } = await render(ChecklistBlock, {
      block: {
        type: "checklist",
        id: "cl2",
        items: [{ id: "i1", label: "Done item", checked: true }],
      },
    });
    // checked item gets .cl-checked class
    const checkedEl = container.querySelector(".cl-checked");
    expect(checkedEl).not.toBeNull();
  });

  it("renders item notes when present", async () => {
    render(ChecklistBlock, {
      block: {
        type: "checklist",
        id: "cl3",
        items: [{ id: "i1", label: "Step one", note: "Check the logs first" }],
      },
    });
    await expect.element(page.getByText("Check the logs first")).toBeInTheDocument();
  });

  it("renders items with no checked state", async () => {
    render(ChecklistBlock, {
      block: {
        type: "checklist",
        id: "cl4",
        items: [{ id: "i1", label: "Pending task" }],
      },
    });
    await expect.element(page.getByText("Pending task")).toBeInTheDocument();
  });
});

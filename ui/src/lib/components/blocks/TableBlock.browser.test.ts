import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import TableBlock from "./TableBlock.svelte";

describe("TableBlock", () => {
  it("renders column headers", async () => {
    render(TableBlock, {
      block: {
        type: "table",
        id: "t1",
        columns: ["Name", "Type", "Description"],
        rows: [["id", "uuid", "Primary key"]],
      },
    });
    await expect.element(page.getByText("Name")).toBeInTheDocument();
    await expect.element(page.getByText("Type")).toBeInTheDocument();
    await expect.element(page.getByText("Description")).toBeInTheDocument();
  });

  it("renders row cells", async () => {
    const { container } = render(TableBlock, {
      block: {
        type: "table",
        id: "t2",
        columns: ["Field", "Value"],
        rows: [
          ["host", "localhost"],
          ["port", "5432"],
        ],
      },
    });
    const cells = Array.from(container.querySelectorAll(".tb-td"));
    const cellTexts = cells.map((c) => c.textContent ?? "");
    expect(cellTexts).toContain("host");
    expect(cellTexts).toContain("localhost");
    expect(cellTexts).toContain("port");
    expect(cellTexts).toContain("5432");
  });

  it("renders with no rows without throwing", () => {
    expect(() =>
      render(TableBlock, {
        block: { type: "table", id: "t3", columns: ["A", "B"], rows: [] },
      }),
    ).not.toThrow();
  });
});

import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import PuiTable from "./PuiTable.svelte";

describe("PuiTable", () => {
  it("renders column headers", async () => {
    render(PuiTable, {
      node: {
        type: "table",
        props: {
          columns: ["Name", "Status"],
          rows: [["widget-a", "ok"]],
        },
      },
    });
    await expect.element(page.getByText("Name")).toBeInTheDocument();
    await expect.element(page.getByText("Status")).toBeInTheDocument();
  });

  it("renders row cells", async () => {
    const { container } = await render(PuiTable, {
      node: {
        type: "table",
        props: {
          columns: ["Key", "Val"],
          rows: [["host", "localhost"]],
        },
      },
    });
    const cells = Array.from(container.querySelectorAll(".pui-td"));
    const texts = cells.map((c) => c.textContent ?? "");
    expect(texts).toContain("host");
    expect(texts).toContain("localhost");
  });

  it("shows empty state when no columns and no rows", async () => {
    render(PuiTable, {
      node: { type: "table", props: { columns: [], rows: [] } },
    });
    await expect.element(page.getByText("No data.")).toBeInTheDocument();
  });

  it("handles ragged rows without throwing", () => {
    expect(() =>
      render(PuiTable, {
        node: {
          type: "table",
          props: { columns: ["A", "B", "C"], rows: [["only-one"]] },
        },
      }),
    ).not.toThrow();
  });

  it("handles missing props without throwing", () => {
    expect(() => render(PuiTable, { node: { type: "table" } })).not.toThrow();
  });
});

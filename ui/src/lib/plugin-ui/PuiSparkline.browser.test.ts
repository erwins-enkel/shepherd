import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import PuiSparkline from "./PuiSparkline.svelte";

describe("PuiSparkline", () => {
  it("with points renders a polyline and no empty text", async () => {
    const { container } = render(PuiSparkline, {
      node: { type: "sparkline", props: { points: [1, 3, 2, 5, 4] } },
    });
    expect(container.querySelector("polyline")).not.toBeNull();
    const empties = container.querySelectorAll(".pui-spark-empty");
    expect(empties.length).toBe(0);
  });

  it("empty points array renders empty-state text", async () => {
    render(PuiSparkline, {
      node: { type: "sparkline", props: { points: [] } },
    });
    await expect.element(page.getByText("No data.")).toBeInTheDocument();
  });

  it("missing points renders empty-state text", async () => {
    render(PuiSparkline, {
      node: { type: "sparkline", props: {} },
    });
    await expect.element(page.getByText("No data.")).toBeInTheDocument();
  });

  it("single point renders without throwing", () => {
    expect(() =>
      render(PuiSparkline, {
        node: { type: "sparkline", props: { points: [5] } },
      }),
    ).not.toThrow();
  });

  it("NaN-laden array filters to finite values and renders without throwing", async () => {
    const { container } = render(PuiSparkline, {
      node: { type: "sparkline", props: { points: [1, "x", 3] } },
    });
    // "x" coerces to NaN and is filtered out; 1 and 3 remain → renders chart
    expect(container.querySelector("polyline")).not.toBeNull();
  });

  it("renders label when provided", async () => {
    const { container } = render(PuiSparkline, {
      node: { type: "sparkline", props: { points: [1, 2], label: "Requests" } },
    });
    // Label appears both in visible span and SVG <title>; query the span directly
    const labelEl = container.querySelector(".pui-spark-label");
    expect(labelEl?.textContent).toBe("Requests");
  });
});

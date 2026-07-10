import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import PuiTimeSeries from "./PuiTimeSeries.svelte";

describe("PuiTimeSeries", () => {
  it("with series renders a polyline", async () => {
    const { container } = await render(PuiTimeSeries, {
      node: {
        type: "time-series",
        props: {
          series: [{ label: "Latency", points: [10, 20, 15, 30] }],
        },
      },
    });
    expect(container.querySelector("polyline")).not.toBeNull();
  });

  it("area kind renders a polygon", async () => {
    const { container } = await render(PuiTimeSeries, {
      node: {
        type: "time-series",
        props: {
          kind: "area",
          series: [{ label: "Traffic", points: [5, 10, 8] }],
        },
      },
    });
    expect(container.querySelector("polygon")).not.toBeNull();
  });

  it("empty series renders empty-state text", async () => {
    render(PuiTimeSeries, {
      node: { type: "time-series", props: { series: [] } },
    });
    await expect.element(page.getByText("No data.")).toBeInTheDocument();
  });

  it("missing props renders empty-state text and does not throw", async () => {
    render(PuiTimeSeries, {
      node: { type: "time-series" },
    });
    await expect.element(page.getByText("No data.")).toBeInTheDocument();
  });

  it("legend shows provided series label", async () => {
    const { container } = await render(PuiTimeSeries, {
      node: {
        type: "time-series",
        props: {
          series: [{ label: "CPU", points: [1, 2, 3] }],
        },
      },
    });
    // Label appears in both the SVG <title> and legend span; query the legend span directly
    const legendLabel = container.querySelector(".pui-timeseries-legend-label");
    expect(legendLabel?.textContent).toBe("CPU");
  });

  it("clamps points outside [0, yMax] inside the viewBox", async () => {
    const { container } = await render(PuiTimeSeries, {
      node: {
        type: "time-series",
        props: {
          // yMax=10 but points exceed it / go negative — must stay in [PAD, H-PAD] (PAD=2, H=40)
          yMax: 10,
          series: [{ label: "Spiky", points: [-5, 50, 5] }],
        },
      },
    });
    const polyline = container.querySelector("polyline");
    expect(polyline).not.toBeNull();
    const ys = polyline!
      .getAttribute("points")!
      .split(" ")
      .map((pt) => Number(pt.split(",")[1]));
    // Every y stays within the drawable band [PAD, H-PAD] = [2, 38]
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(2);
      expect(y).toBeLessThanOrEqual(38);
    }
    // The over-max point clamps to the top edge (y === PAD), the negative to the bottom (y === H-PAD)
    expect(Math.min(...ys)).toBe(2);
    expect(Math.max(...ys)).toBe(38);
  });

  it("series with empty label is omitted from the legend", async () => {
    const { container } = await render(PuiTimeSeries, {
      node: {
        type: "time-series",
        props: {
          series: [
            { label: "", points: [1, 2, 3] },
            { label: "Visible", points: [4, 5, 6] },
          ],
        },
      },
    });
    const legend = container.querySelector(".pui-timeseries-legend");
    expect(legend).not.toBeNull();
    const items = legend!.querySelectorAll(".pui-timeseries-legend-item");
    // Only the labelled series appears in the legend
    expect(items.length).toBe(1);
  });
});

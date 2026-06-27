import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import PuiTimeSeries from "./PuiTimeSeries.svelte";

describe("PuiTimeSeries", () => {
  it("with series renders a polyline", async () => {
    const { container } = render(PuiTimeSeries, {
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
    const { container } = render(PuiTimeSeries, {
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
    const { container } = render(PuiTimeSeries, {
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

  it("series with empty label is omitted from the legend", async () => {
    const { container } = render(PuiTimeSeries, {
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

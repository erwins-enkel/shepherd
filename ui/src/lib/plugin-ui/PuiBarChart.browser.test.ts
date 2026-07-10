import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import PuiBarChart from "./PuiBarChart.svelte";

describe("PuiBarChart", () => {
  it("horizontal (default): container has role=list", async () => {
    const { container } = await render(PuiBarChart, {
      node: {
        type: "bar-chart",
        props: {
          bars: [{ label: "Alpha", value: 40 }],
        },
      },
    });
    expect(container.querySelector("[role=list]")).not.toBeNull();
  });

  it("horizontal: renders bar label text", async () => {
    render(PuiBarChart, {
      node: {
        type: "bar-chart",
        props: {
          bars: [{ label: "Alpha", value: 40 }],
        },
      },
    });
    await expect.element(page.getByText("Alpha")).toBeInTheDocument();
  });

  it("horizontal: each bar row has aria-label with label and value", async () => {
    const { container } = await render(PuiBarChart, {
      node: {
        type: "bar-chart",
        props: {
          bars: [{ label: "Beta", value: 75 }],
        },
      },
    });
    const row = container.querySelector('[aria-label="Beta: 75"]');
    expect(row).not.toBeNull();
  });

  it("vertical orientation renders without throwing and shows bar labels", async () => {
    render(PuiBarChart, {
      node: {
        type: "bar-chart",
        props: {
          orientation: "vertical",
          bars: [{ label: "Delta", value: 30 }],
        },
      },
    });
    await expect.element(page.getByText("Delta")).toBeInTheDocument();
  });

  it("value > max clamps fill to 100%", async () => {
    const { container } = await render(PuiBarChart, {
      node: {
        type: "bar-chart",
        props: {
          max: 50,
          bars: [{ label: "Over", value: 200 }],
        },
      },
    });
    const fill = container.querySelector(".pui-barchart-fill") as HTMLElement | null;
    expect(fill).not.toBeNull();
    expect(fill?.style.width).toBe("100%");
  });

  it("empty bars renders empty-state text", async () => {
    render(PuiBarChart, {
      node: { type: "bar-chart", props: { bars: [] } },
    });
    await expect.element(page.getByText("No data.")).toBeInTheDocument();
  });

  it("missing props renders empty-state text and does not throw", async () => {
    render(PuiBarChart, {
      node: { type: "bar-chart" },
    });
    await expect.element(page.getByText("No data.")).toBeInTheDocument();
  });
});

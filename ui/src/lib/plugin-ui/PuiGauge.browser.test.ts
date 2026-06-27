import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import PuiGauge from "./PuiGauge.svelte";

describe("PuiGauge", () => {
  it("renders label text when provided", async () => {
    const { container } = render(PuiGauge, {
      node: { type: "gauge", props: { value: 30, max: 100, label: "CPU Usage" } },
    });
    // The label appears both in a visible <span> and the SVG <title>; query the span directly
    const labelEl = container.querySelector(".pui-gauge-label");
    expect(labelEl?.textContent).toBe("CPU Usage");
  });

  it("renders caption text when provided", async () => {
    const { container } = render(PuiGauge, {
      node: { type: "gauge", props: { value: 30, max: 100, caption: "Monthly budget" } },
    });
    const captionEl = container.querySelector(".pui-gauge-caption");
    expect(captionEl?.textContent).toBe("Monthly budget");
  });

  it("role=meter has correct aria attributes for given value/max", async () => {
    const { container } = render(PuiGauge, {
      node: { type: "gauge", props: { value: 42, max: 200 } },
    });
    const meter = container.querySelector("[role=meter]") as SVGElement | null;
    expect(meter).not.toBeNull();
    expect(meter?.getAttribute("aria-valuenow")).toBe("42");
    expect(meter?.getAttribute("aria-valuemin")).toBe("0");
    expect(meter?.getAttribute("aria-valuemax")).toBe("200");
  });

  it("clamps value above max — meter present, no throw", async () => {
    const { container } = render(PuiGauge, {
      node: { type: "gauge", props: { value: 999, max: 100 } },
    });
    const meter = container.querySelector("[role=meter]");
    expect(meter).not.toBeNull();
    // dashOffset for a clamped-to-1 ratio should be 0 (full arc)
    const circles = container.querySelectorAll("circle");
    expect(circles.length).toBeGreaterThanOrEqual(2);
  });

  it("clamps negative value — meter present, no throw", async () => {
    const { container } = render(PuiGauge, {
      node: { type: "gauge", props: { value: -50, max: 100 } },
    });
    const meter = container.querySelector("[role=meter]");
    expect(meter).not.toBeNull();
  });

  it("renders without throwing when props are missing", () => {
    expect(() =>
      render(PuiGauge, {
        node: { type: "gauge" },
      }),
    ).not.toThrow();
  });

  it("shows value/max text in overlay", async () => {
    render(PuiGauge, {
      node: { type: "gauge", props: { value: 7, max: 10 } },
    });
    await expect.element(page.getByText("7/10")).toBeInTheDocument();
  });
});

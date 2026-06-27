import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import PuiMeter from "./PuiMeter.svelte";

describe("PuiMeter", () => {
  it("renders label and value/max", async () => {
    render(PuiMeter, {
      node: { type: "meter", props: { value: 42, max: 100, label: "Tokens" } },
    });
    await expect.element(page.getByText("Tokens")).toBeInTheDocument();
    await expect.element(page.getByText("42/100")).toBeInTheDocument();
  });

  it("clamps value above max to 100%", async () => {
    const { container } = render(PuiMeter, {
      node: { type: "meter", props: { value: 200, max: 100 } },
    });
    const fill = container.querySelector(".pui-meter-fill") as HTMLElement | null;
    expect(fill?.style.width).toBe("100%");
  });

  it("clamps negative value to 0%", async () => {
    const { container } = render(PuiMeter, {
      node: { type: "meter", props: { value: -10, max: 100 } },
    });
    const fill = container.querySelector(".pui-meter-fill") as HTMLElement | null;
    expect(fill?.style.width).toBe("0%");
  });

  it("renders caption when provided", async () => {
    render(PuiMeter, {
      node: { type: "meter", props: { value: 50, caption: "Monthly limit" } },
    });
    await expect.element(page.getByText("Monthly limit")).toBeInTheDocument();
  });

  it("renders without label or caption", () => {
    expect(() =>
      render(PuiMeter, {
        node: { type: "meter", props: { value: 50 } },
      }),
    ).not.toThrow();
  });
});

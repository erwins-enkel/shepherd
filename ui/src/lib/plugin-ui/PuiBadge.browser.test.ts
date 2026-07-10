import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import PuiBadge from "./PuiBadge.svelte";

describe("PuiBadge", () => {
  it("renders the label text", async () => {
    render(PuiBadge, {
      node: { type: "badge", props: { label: "OPEN", tone: "neutral" } },
    });
    await expect.element(page.getByText("OPEN")).toBeInTheDocument();
  });

  it("applies ok tone color (green)", async () => {
    const { container } = await render(PuiBadge, {
      node: { type: "badge", props: { label: "READY", tone: "ok" } },
    });
    const el = container.querySelector(".pui-badge") as HTMLElement | null;
    expect(el?.style.color).toBe("var(--color-green)");
  });

  it("applies error tone color (red)", async () => {
    const { container } = await render(PuiBadge, {
      node: { type: "badge", props: { label: "FAIL", tone: "error" } },
    });
    const el = container.querySelector(".pui-badge") as HTMLElement | null;
    expect(el?.style.color).toBe("var(--color-red)");
  });

  it("applies warn tone color", async () => {
    const { container } = await render(PuiBadge, {
      node: { type: "badge", props: { label: "CAUTION", tone: "warn" } },
    });
    const el = container.querySelector(".pui-badge") as HTMLElement | null;
    expect(el?.style.color).toBe("var(--status-warn)");
  });

  it("defaults to neutral for unknown tone", async () => {
    const { container } = await render(PuiBadge, {
      node: { type: "badge", props: { label: "X", tone: "bogus-tone" } },
    });
    const el = container.querySelector(".pui-badge") as HTMLElement | null;
    expect(el?.style.color).toBe("var(--color-muted)");
  });
});

import { describe, it, expect, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";

// Capture the last render id so tests can assert slug correctness.
let lastRenderId = "";
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (id: string, src: string) => {
      lastRenderId = id;
      if (src.includes("BOOM")) throw new Error("parse error");
      return { svg: "<svg data-testid='mmsvg'></svg>" };
    }),
  },
}));

import mermaid from "mermaid";
import MermaidBlock from "./MermaidBlock.svelte";

describe("MermaidBlock", () => {
  it("renders without throwing when source is present", () => {
    expect(() =>
      render(MermaidBlock, {
        block: { type: "mermaid", id: "m1", source: "graph TD; A-->B" },
      }),
    ).not.toThrow();
  });

  it("success path: renders mocked svg and inferred badge", async () => {
    render(MermaidBlock, {
      block: { type: "mermaid", id: "m2", source: "graph TD; A-->B" },
    });
    // The inferred badge should be present immediately (synchronous markup).
    await expect.element(page.getByText("inferred")).toBeInTheDocument();
    // The async effect injects the mocked svg — wait for it.
    await expect.element(page.getByTestId("mmsvg")).toBeInTheDocument();
  });

  it("error path: BOOM source renders error message and raw source, not the svg", async () => {
    render(MermaidBlock, {
      block: { type: "mermaid", id: "m3", source: "graph TD; BOOM" },
    });
    // Error message via i18n key.
    await expect.element(page.getByText("Diagram could not be rendered")).toBeInTheDocument();
    // Raw source in a <pre> element.
    await expect.element(page.getByText("graph TD; BOOM")).toBeInTheDocument();
    // No svg injected.
    expect(document.querySelector("[data-testid='mmsvg']")).toBeNull();
  });

  it("config-pin: mermaid.initialize is called with suppressErrorRendering:true", async () => {
    // Pins the config that triggers Mermaid's documented temp-node cleanup on
    // failure. Proves configuration, not DOM cleanup — the real-mermaid test does that.
    render(MermaidBlock, {
      block: { type: "mermaid", id: "m4", source: "graph TD; A-->B" },
    });
    await expect.element(page.getByTestId("mmsvg")).toBeInTheDocument();
    const calls = vi.mocked(mermaid.initialize).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.at(-1)?.[0]).toMatchObject({ suppressErrorRendering: true });
  });

  it("dirty id: block.id with whitespace and special chars renders success (no error fallback)", async () => {
    // "a b.c#d" contains whitespace, dot and hash — unsafe as a DOM id.
    // After slugging these become dashes, so mermaid.render() gets a safe id.
    render(MermaidBlock, {
      block: { type: "mermaid", id: "a b.c#d", source: "graph TD; A-->B" },
    });
    // SVG must appear — the dirty id must NOT cause the error fallback.
    await expect.element(page.getByTestId("mmsvg")).toBeInTheDocument();
    // Error fallback must be absent.
    expect(document.querySelector(".mb-error")).toBeNull();
    // The render id passed to mermaid must only contain safe chars (mm- prefix + safe chars + counter).
    expect(lastRenderId).toMatch(/^mm-[a-zA-Z0-9_-]+-\d+$/);
  });
});

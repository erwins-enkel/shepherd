import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import WireframeBlock from "./WireframeBlock.svelte";

describe("WireframeBlock", () => {
  it("renders the honesty badge unconditionally", async () => {
    render(WireframeBlock, {
      block: { type: "wireframe", id: "wf1", surface: "browser", html: "<div>hello</div>" },
    });
    // honesty badge must always be present — the label contains "Illustrative mockup"
    await expect.element(page.getByText(/illustrative mockup/i)).toBeInTheDocument();
  });

  it("renders the surface label for the given surface", async () => {
    render(WireframeBlock, {
      block: { type: "wireframe", id: "wf2", surface: "mobile", html: "<div>hello</div>" },
    });
    await expect.element(page.getByText(/mobile mockup/i)).toBeInTheDocument();
  });

  it("iframe has sandbox containing allow-same-origin and NOT allow-scripts", async () => {
    render(WireframeBlock, {
      block: { type: "wireframe", id: "wf3", surface: "browser", html: "<div>test</div>" },
    });
    const iframe = page
      .getByRole("none", { name: /browser mockup/i })
      .or(page.getByTitle(/browser mockup/i));
    await expect.element(iframe).toBeInTheDocument();
    const el = iframe.element() as HTMLIFrameElement;
    expect(el.sandbox.contains("allow-same-origin")).toBe(true);
    expect(el.sandbox.contains("allow-scripts")).toBe(false);
  });

  it("srcdoc contains CSP meta with default-src 'none'", async () => {
    render(WireframeBlock, {
      block: { type: "wireframe", id: "wf4", surface: "browser", html: "<div>csp test</div>" },
    });
    // Poll until srcdoc is set (async $effect)
    const iframe = page.getByTitle(/browser mockup/i);
    await expect.element(iframe).toBeInTheDocument();
    await expect
      .poll(() => {
        const el = iframe.element() as HTMLIFrameElement;
        return el.srcdoc;
      })
      .toContain("default-src 'none'");
    const el = iframe.element() as HTMLIFrameElement;
    expect(el.srcdoc).toContain("Content-Security-Policy");
  });

  it("DOMPurify strips script and href but keeps safe content", async () => {
    const dirtyHtml = `<div>ok</div><script>alert(1)</` + `script><a href="x">l</a>`;
    render(WireframeBlock, {
      block: { type: "wireframe", id: "wf5", surface: "browser", html: dirtyHtml },
    });
    const iframe = page.getByTitle(/browser mockup/i);
    await expect.element(iframe).toBeInTheDocument();
    // Wait for async effect to populate srcdoc
    await expect
      .poll(() => {
        const el = iframe.element() as HTMLIFrameElement;
        return el.srcdoc.length > 0;
      })
      .toBeTruthy();
    const el = iframe.element() as HTMLIFrameElement;
    expect(el.srcdoc).toContain("ok");
    expect(el.srcdoc).not.toContain("<script");
    expect(el.srcdoc).not.toContain("href");
  });

  it("renders caption when provided", async () => {
    render(WireframeBlock, {
      block: {
        type: "wireframe",
        id: "wf6",
        surface: "desktop",
        html: "<div>content</div>",
        caption: "Figure 1: design mockup",
      },
    });
    await expect.element(page.getByText("Figure 1: design mockup")).toBeInTheDocument();
  });
});

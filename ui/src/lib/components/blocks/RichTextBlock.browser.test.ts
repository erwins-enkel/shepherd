import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import RichTextBlock from "./RichTextBlock.svelte";

describe("RichTextBlock", () => {
  it("renders bold markdown as a <strong> element", async () => {
    const { container } = await render(RichTextBlock, {
      block: { type: "rich-text", id: "r1", markdown: "**bold**" },
    });
    // wait for async dynamic-import render to settle
    await expect.element(page.getByText("bold")).toBeInTheDocument();
    // the element wrapping "bold" must be a <strong>, not raw **bold** leaking as text
    const strongEl = container.querySelector("strong");
    expect(strongEl).not.toBeNull();
    expect(strongEl?.textContent).toBe("bold");
  });

  it("renders nothing when markdown is empty", async () => {
    const { container } = await render(RichTextBlock, {
      block: { type: "rich-text", id: "r2", markdown: "" },
    });
    // rt-md div should not exist
    expect(container.querySelector(".rt-md")).toBeNull();
  });

  it("sanitizes html in markdown body (no script content in rendered output)", async () => {
    const { container } = await render(RichTextBlock, {
      block: { type: "rich-text", id: "r3", markdown: "safe **text** here" },
    });
    // wait for async render
    await expect.element(page.getByText(/safe/)).toBeInTheDocument();
    // DOMPurify strips script tags — none should appear inside the component container
    expect(container.querySelector("script")).toBeNull();
  });
});

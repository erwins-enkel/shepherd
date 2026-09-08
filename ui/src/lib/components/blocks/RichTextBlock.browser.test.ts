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

  // ── #2194: fenced blocks ───────────────────────────────────────────────────
  // The recap prompt now asks for a "shape sketch" — a fenced ```diff of a component tree,
  // file layout or control flow — inside a rich-text block. Before #2194 there was no
  // :global(pre) rule at all, so that sketch rendered unstyled.

  it("renders a fenced block as a styled <pre> (not unstyled text)", async () => {
    const { container } = await render(RichTextBlock, {
      block: { type: "rich-text", id: "r4", markdown: "```\nplain fence\n```" },
    });
    await expect.element(page.getByText(/plain fence/)).toBeInTheDocument();
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    const style = getComputedStyle(pre as HTMLElement);
    // The token-driven surface must actually resolve — a missing rule leaves pre transparent.
    expect(style.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(style.overflowX).toBe("auto");
  });

  it("tints + and - lines of a ```diff fence, and leaves context lines alone", async () => {
    const { container } = await render(RichTextBlock, {
      block: {
        type: "rich-text",
        id: "r5",
        markdown: "```diff\n@@ shape @@\n- OldPanel\n+ NewPanel\n  Shared\n```",
      },
    });
    await expect.element(page.getByText(/NewPanel/)).toBeInTheDocument();
    const code = container.querySelector("pre > code.language-diff");
    expect(code).not.toBeNull();
    expect(code?.querySelector(".dl.add")?.textContent).toBe("+ NewPanel");
    expect(code?.querySelector(".dl.del")?.textContent).toBe("- OldPanel");
    expect(code?.querySelector(".dl.meta")?.textContent).toBe("@@ shape @@");
    expect(code?.querySelector(".dl.ctx")?.textContent).toBe("  Shared");
    // The trailing newline of the fence must not become a blank tinted row.
    expect(code?.querySelectorAll(".dl").length).toBe(4);
    // add and del must be visually distinct, not merely classed.
    const addBg = getComputedStyle(code?.querySelector(".dl.add") as HTMLElement).backgroundColor;
    const delBg = getComputedStyle(code?.querySelector(".dl.del") as HTMLElement).backgroundColor;
    expect(addBg).not.toBe(delBg);
    expect(addBg).not.toBe("rgba(0, 0, 0, 0)");
  });

  it("leaves a non-diff fence untinted", async () => {
    const { container } = await render(RichTextBlock, {
      block: { type: "rich-text", id: "r6", markdown: "```ts\nconst a = 1;\n```" },
    });
    await expect.element(page.getByText(/const a/)).toBeInTheDocument();
    expect(container.querySelector("pre")).not.toBeNull();
    // Only language-diff fences get per-line spans.
    expect(container.querySelectorAll(".dl").length).toBe(0);
  });

  it("does not let a diff fence smuggle markup past the sanitizer", async () => {
    const { container } = await render(RichTextBlock, {
      block: {
        type: "rich-text",
        id: "r7",
        markdown: "```diff\n+ <img src=x onerror=alert(1)>\n```",
      },
    });
    await expect.element(page.getByText(/onerror/)).toBeInTheDocument();
    // The line is rebuilt via textContent, so the tag stays inert text — never an element.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".dl.add")?.textContent).toBe("+ <img src=x onerror=alert(1)>");
  });
});

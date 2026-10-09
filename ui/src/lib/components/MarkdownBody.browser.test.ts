import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import { m } from "#lib/paraglide/messages.js";
import MarkdownBody from "./MarkdownBody.svelte";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MarkdownBody", () => {
  it("renders Markdown instead of showing the raw markers", async () => {
    const { container } = await render(MarkdownBody, {
      source: "## Warum\n\nDas ist **wichtig**.\n\n- eins\n- zwei",
    });
    await expect.poll(() => container.querySelector("h2")?.textContent).toBe("Warum");
    expect(container.querySelector("strong")?.textContent).toBe("wichtig");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.textContent).not.toContain("##");
    expect(container.textContent).not.toContain("**");
  });

  it("strips script and inline handlers", async () => {
    const { container } = await render(MarkdownBody, {
      source: 'ok <script>window.__x = 1</script><img src="x" onerror="window.__x = 1">',
    });
    await expect.poll(() => container.querySelector(".md-body")?.textContent).toContain("ok");
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")?.getAttribute("onerror")).toBeNull();
  });

  it("shows the empty hint for a blank body", async () => {
    await render(MarkdownBody, { source: "  " });
    await expect.element(page.getByText(m.issuedetail_no_description())).toBeInTheDocument();
  });

  it("opens links in a new tab instead of navigating the app", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const { container } = await render(MarkdownBody, { source: "[docs](https://example.com/d)" });
    await expect.poll(() => container.querySelector("a")).not.toBeNull();
    container.querySelector("a")!.click();
    expect(open).toHaveBeenCalledWith("https://example.com/d", "_blank", "noopener");
  });
});

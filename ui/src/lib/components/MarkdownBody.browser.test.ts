import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
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

describe("MarkdownBody session links", () => {
  const sessionDesigs = new Map([["TASK-31", "s31"]]);

  it("renders Markdown links around known tokens but leaves code and unknown tokens alone", async () => {
    const { container } = await render(MarkdownBody, {
      source:
        "**TASK-31**\n\n| Session |\n| --- |\n| TASK-31 |\n\n- TASK-31\n\n`TASK-31`\n\n```\nTASK-31\n```\n\nTASK-99",
      sessionDesigs,
      onSessionLink: vi.fn(),
    });
    await expect.poll(() => container.querySelectorAll("a[data-session-id]").length).toBe(3);
    expect(container.querySelector("strong > a")?.textContent).toBe("TASK-31");
    expect(container.querySelector("td > a")?.textContent).toBe("TASK-31");
    expect(container.querySelector("code a")).toBeNull();
    expect(container.textContent).toContain("TASK-99");
  });

  it("selects on click and Enter without opening a tab or changing the location", async () => {
    const onSessionLink = vi.fn();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const { container } = await render(MarkdownBody, {
      source: "**TASK-31**",
      sessionDesigs,
      onSessionLink,
    });
    await expect.poll(() => container.querySelector("a")).not.toBeNull();
    const a = container.querySelector("a")!;
    const href = location.href;
    a.click();
    a.focus();
    expect(document.activeElement).toBe(a);
    await userEvent.keyboard("{Enter}");
    expect(onSessionLink.mock.calls).toEqual([["s31"], ["s31"]]);
    expect(open).not.toHaveBeenCalled();
    expect(location.href).toBe(href);
  });

  it("updates links when the herd changes while the source stays the same", async () => {
    const { container, rerender } = await render(MarkdownBody, {
      source: "TASK-31",
      sessionDesigs: new Map(),
      onSessionLink: vi.fn(),
    });
    await expect.poll(() => container.querySelector("p")?.textContent).toBe("TASK-31");
    expect(container.querySelector("a")).toBeNull();
    await rerender({ sessionDesigs });
    await expect.poll(() => container.querySelector("a")?.dataset.sessionId).toBe("s31");
    await rerender({ sessionDesigs: new Map() });
    await expect.poll(() => container.querySelector("p")?.textContent).toBe("TASK-31");
    expect(container.querySelector("a")).toBeNull();
  });

  it("does not trust session markers supplied by the Markdown", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const onSessionLink = vi.fn();
    const { container } = await render(MarkdownBody, {
      source: '<a href="https://example.com/" data-session-id="s31">TASK-31</a>',
      sessionDesigs,
      onSessionLink,
    });
    await expect.poll(() => container.querySelector("a")).not.toBeNull();
    expect(container.querySelector("a")?.hasAttribute("data-session-id")).toBe(false);
    container.querySelector("a")!.click();
    expect(onSessionLink).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith("https://example.com/", "_blank", "noopener");
  });

  it("does not link without a navigation callback", async () => {
    const { container } = await render(MarkdownBody, { source: "TASK-31", sessionDesigs });
    await expect.poll(() => container.querySelector("p")?.textContent).toBe("TASK-31");
    expect(container.querySelector("a")).toBeNull();
  });
});

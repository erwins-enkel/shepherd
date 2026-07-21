import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-svelte";
import CodexReleaseNotes from "./CodexReleaseNotes.svelte";
import { renderCodexReleaseMarkdown } from "$lib/codex-release-notes-renderer";

const hostileMarkdown = `
![diagram](https://tracker.invalid/pixel.png)
<img src="https://tracker.invalid/raw.png" alt="raw image">
<script>hidden script</script><style>hidden style</style>
<details open class="global" id="global" style="color:red"><summary>Visible summary</summary>
Visible details
<table class="global"><thead><tr><th>Head</th></tr></thead><tbody><tr><td>Cell</td></tr></tbody></table>
</details>
<form><label>Visible form label</label><input name="secret"></form>

[relative](docs/guide.md) [root](/openai/codex/issues/7) [section](#section)
[danger](javascript:alert(1))
`;

describe("CodexReleaseNotes", () => {
  it("removes media URLs before DOMPurify and preserves safe visible raw-HTML structure", async () => {
    const [{ Marked }, { default: DOMPurify }] = await Promise.all([
      import("marked"),
      import("dompurify"),
    ]);
    let beforeSanitize = "";
    const html = await renderCodexReleaseMarkdown(hostileMarkdown, "0.145.0", {
      load: async () => ({ Marked, DOMPurify }),
      beforeSanitize: (value) => {
        beforeSanitize = value;
      },
    });

    expect(beforeSanitize).not.toContain("tracker.invalid");
    expect(beforeSanitize).not.toMatch(/<img|\bsrc\s*=/i);
    expect(beforeSanitize).toContain("diagram");
    expect(beforeSanitize).toContain("<details open>");
    expect(beforeSanitize).toContain("<summary>Visible summary</summary>");
    expect(beforeSanitize).toContain("<table>");
    expect(beforeSanitize).toContain("Visible form label");
    expect(beforeSanitize).not.toMatch(/<form|<input|\b(?:class|id|style)\s*=/i);

    expect(html).not.toMatch(/<img|<script|<style|<form|<input/i);
    expect(html).not.toMatch(/\b(?:class|id|style|src)\s*=/i);
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://github.com/openai/codex/docs/guide.md"');
    expect(html).toContain('href="https://github.com/openai/codex/issues/7"');
    expect(html).toContain(
      'href="https://github.com/openai/codex/releases/tag/rust-v0.145.0#section"',
    );
  });

  it("mounts only sanitized DOM and never creates an image element", async () => {
    const { container } = await render(CodexReleaseNotes, {
      version: "0.145.0",
      body: hostileMarkdown,
    });

    await expect.poll(() => container.textContent).toContain("Visible details");
    expect(container.querySelector("img, script, style, form, input")).toBeNull();
    expect(container.querySelector("details[open] summary")?.textContent).toBe("Visible summary");
    expect(container.querySelector("table th")?.textContent).toBe("Head");
    expect(container.querySelector("table td")?.textContent).toBe("Cell");
    expect(container.querySelector("a[href^='/']")).toBeNull();
  });
});

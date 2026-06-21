import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";

// NO vi.mock here — vi.mock is file-scoped, so this suite loads the REAL mermaid
// module in real chromium. This is the test that actually proves the leak fix:
// a failed render must show our .mb-error fallback AND leave no Mermaid error
// graphic (the bomb / "Syntax error in text") orphaned in document.body.
import MermaidBlock from "./MermaidBlock.svelte";

// Returns true if any Mermaid-authored error graphic leaked into the document.
// Covers the temp wrapper (`d` + our `mm-…` render id), the bomb's `.error-icon`,
// and the version-stamped error text Mermaid renders into it.
function hasLeakedMermaidError(): boolean {
  if (document.querySelector('[id^="dmm-"]')) return true; // orphaned temp wrapper
  if (document.querySelector(".error-icon, .error-text")) return true; // bomb graphic
  const text = document.body.textContent ?? "";
  if (/Syntax error in text/i.test(text)) return true;
  if (/mermaid version/i.test(text)) return true;
  return false;
}

describe("MermaidBlock (real mermaid)", () => {
  it("invalid syntax: shows .mb-error fallback and leaks no bomb into document.body", async () => {
    // Genuinely-invalid Mermaid. (Note: 'graph TD; BOOM' parses as VALID and would
    // render — it only fails under the unit mock's string match.)
    render(MermaidBlock, {
      block: { type: "mermaid", id: "real-bad", source: "@@@ not valid :::" },
    });

    // Fallback appearing proves mermaid still RE-THROWS under suppressErrorRendering:true
    // (the catch sets error=true). If it swallowed the error, neither svg nor
    // .mb-error would render and this would fail.
    await expect
      .element(page.getByText("Diagram could not be rendered"), { timeout: 15000 })
      .toBeInTheDocument();

    // The raw source is shown in the localized fallback (data passthrough).
    await expect.element(page.getByText("@@@ not valid :::")).toBeInTheDocument();

    // No Mermaid error graphic anywhere in the document — the actual regression guard.
    expect(hasLeakedMermaidError()).toBe(false);
  }, 20000);

  it("valid syntax: renders an svg and no fallback (real module path works)", async () => {
    render(MermaidBlock, {
      block: { type: "mermaid", id: "real-good", source: "graph TD; A-->B" },
    });

    await expect
      .poll(() => document.querySelector(".mb-svg svg") !== null, { timeout: 15000 })
      .toBe(true);
    expect(document.querySelector(".mb-error")).toBeNull();
    expect(hasLeakedMermaidError()).toBe(false);
  }, 20000);
});

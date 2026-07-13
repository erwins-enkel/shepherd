import { describe, it, expect, afterEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { FileDiff } from "@pierre/diffs";
import { theme } from "$lib/theme.svelte";
import PierreDiff from "./PierreDiff.svelte";

// BROWSER project: PierreDiff drives @pierre/diffs' vanilla FileDiff, which needs
// a real DOM (custom-element registration, shadow root, layout stylesheet). These
// assertions read the ACTUAL DOM Pierre produced — no mocks of Pierre itself.

const PATCH = `diff --git a/src/greet.ts b/src/greet.ts
index 1111111..2222222 100644
--- a/src/greet.ts
+++ b/src/greet.ts
@@ -1,3 +1,3 @@
 export function greet(name: string): string {
-  return "hello " + name;
+  return \`hello \${name}\`;
 }
`;

// A second, materially different patch so a signature actually differs.
const PATCH_2 = PATCH.replace("hello", "hey");

function host(): Element | null {
  return document.querySelector("diffs-container");
}

// The split marker Pierre stamps on the rendered <pre> inside the host's shadow
// root: "split" for side-by-side, "single" for unified.
function diffTypeMarker(): string | null | undefined {
  return host()?.shadowRoot?.querySelector("pre[data-diff-type]")?.getAttribute("data-diff-type");
}

// Pierre writes the active theme into a `<style data-theme-css>` in the shadow
// root as `:host { color-scheme: <dark|light>; … }`. Read it back to prove which
// theme is currently applied to the diff.
function appliedColorScheme(): "dark" | "light" | null {
  const css = host()?.shadowRoot?.querySelector("style[data-theme-css]")?.textContent ?? "";
  const m = css.match(/color-scheme:\s*(dark|light)/);
  return (m?.[1] as "dark" | "light") ?? null;
}

const originalPref = theme.pref;

afterEach(() => {
  vi.restoreAllMocks();
  theme.setPref(originalPref);
  document.body.innerHTML = "";
});

describe("PierreDiff", () => {
  it("registers <diffs-container> and renders the split layout", async () => {
    await render(PierreDiff, { patch: PATCH, signature: "sig-1", diffStyle: "split" });

    // Registration: importing FileDiff (via the wrapper) defines the custom element.
    await vi.waitFor(() => {
      expect(customElements.get("diffs-container"), "custom element defined").toBeTruthy();
    });

    // Host is appended asynchronously (after the dynamic import resolves), so
    // poll for it: present in the DOM and upgraded (its shadow root exists).
    await vi.waitFor(() => {
      expect(host(), "host element in DOM").toBeTruthy();
      expect(host()?.shadowRoot, "host upgraded with a shadow root").toBeTruthy();
    });

    // Split layout is active.
    await vi.waitFor(() => {
      expect(diffTypeMarker(), "split marker on rendered <pre>").toBe("split");
    });
  });

  it("toggling diffStyle to unified re-lays-out via setOptions+rerender", async () => {
    const screen = await render(PierreDiff, {
      patch: PATCH,
      signature: "sig-2",
      diffStyle: "split" as "split" | "unified",
    });

    await vi.waitFor(() => {
      expect(diffTypeMarker(), "starts split").toBe("split");
    });

    await screen.rerender({ patch: PATCH, signature: "sig-2", diffStyle: "unified" });

    // Same signature: the content-gate skips a re-parse; the diffStyle reaction
    // re-lays-out in place. Marker flips split -> single (Pierre's unified value).
    await vi.waitFor(() => {
      expect(diffTypeMarker(), "split marker gone / unified active").toBe("single");
    });
  });

  it("does not re-render Pierre when the signature is unchanged (anti-flash gate)", async () => {
    // Spy on the real FileDiff.render (same module the wrapper dynamic-imports —
    // Vite dedupes the specifier) to count actual Pierre renders.
    const renderSpy = vi.spyOn(FileDiff.prototype, "render");

    const screen = await render(PierreDiff, {
      patch: PATCH,
      signature: "sig-3",
      diffStyle: "split" as "split" | "unified",
    });

    await vi.waitFor(() => {
      expect(diffTypeMarker(), "rendered once").toBe("split");
    });
    expect(renderSpy.mock.calls.length, "one render for the initial mount").toBe(1);

    // A poll returning identical content (same signature) must NOT re-render.
    await screen.rerender({ patch: PATCH, signature: "sig-3", diffStyle: "split" });
    await new Promise((r) => setTimeout(r, 50)); // give any (unwanted) async render a chance
    expect(renderSpy.mock.calls.length, "same signature -> no second render").toBe(1);

    // A genuine content change (new signature) DOES re-render.
    await screen.rerender({ patch: PATCH_2, signature: "sig-3-changed", diffStyle: "split" });
    await vi.waitFor(() => {
      expect(renderSpy.mock.calls.length, "changed signature -> re-render").toBe(2);
    });
  });

  it("keeps the applied theme after a diffStyle toggle (no stale-options revert)", async () => {
    // Regression: Pierre's setThemeType swaps in a NEW fd.options object, so a
    // component-side options copy would freeze themeType at mount and the diffStyle
    // toggle would silently revert the diff's theme. Drive: dark -> light -> toggle.
    theme.setPref("dark");
    const screen = await render(PierreDiff, {
      patch: PATCH,
      signature: "sig-4",
      diffStyle: "split" as "split" | "unified",
    });

    await vi.waitFor(() => {
      expect(appliedColorScheme(), "starts dark").toBe("dark");
    });

    // App theme -> light: the diff re-themes.
    theme.setPref("light");
    await vi.waitFor(() => {
      expect(appliedColorScheme(), "re-themes to light").toBe("light");
    });

    // Toggle split -> unified: theme MUST stay light (would snap back to dark if
    // the merge source were a stale component-side options copy).
    await screen.rerender({ patch: PATCH, signature: "sig-4", diffStyle: "unified" });
    await vi.waitFor(() => {
      expect(diffTypeMarker(), "toggled to unified").toBe("single");
    });
    expect(appliedColorScheme(), "theme still light after toggle").toBe("light");
  });
});

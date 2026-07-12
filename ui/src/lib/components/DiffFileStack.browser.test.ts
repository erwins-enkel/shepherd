import { describe, it, expect, afterEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { m } from "$lib/paraglide/messages";
import type { DiffFile } from "$lib/types";
import DiffFileStack from "./DiffFileStack.svelte";

// BROWSER project: DiffFileStack mounts real <PierreDiff> hosts, which need a DOM.
//
// We stub IntersectionObserver with a no-op so the observer never auto-renders in
// the harness (the mounted stack is unconstrained in height, so a real observer
// would flag every section visible at once). That makes the lazy path the sole
// driver we assert here: `scrollToPath` force-renders. Real IO-driven lazy render
// is a runtime behaviour not exercised by this harness (documented limitation).
class NoopIO {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

const TEXT_PATCH = `diff --git a/src/greet.ts b/src/greet.ts
index 1111111..2222222 100644
--- a/src/greet.ts
+++ b/src/greet.ts
@@ -1,3 +1,3 @@
 export function greet(name: string): string {
-  return "hello " + name;
+  return \`hello \${name}\`;
 }
`;

const TEXT_PATH = "src/greet.ts";

const files: DiffFile[] = [
  {
    path: TEXT_PATH,
    status: "modified",
    additions: 1,
    deletions: 1,
    binary: false,
    patch: TEXT_PATCH,
  },
  { path: "logo.png", status: "added", additions: 0, deletions: 0, binary: true },
  {
    path: "huge.json",
    status: "modified",
    additions: 9000,
    deletions: 10,
    binary: false,
    truncated: true,
  },
];

function host(): Element | null {
  return document.querySelector("diffs-container");
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("DiffFileStack", () => {
  it("renders a section per file; binary/truncated show note cards, not Pierre hosts", async () => {
    vi.stubGlobal("IntersectionObserver", NoopIO);
    const { container } = await render(DiffFileStack, {
      files,
      diffStyle: "split" as "split" | "unified",
    });

    expect(container.querySelectorAll("[data-diff-path]").length, "one section per file").toBe(3);

    // Non-renderable files render their localized note text immediately.
    expect(document.body.textContent).toContain(m.diff_note_binary());
    expect(document.body.textContent).toContain(m.diff_note_truncated());

    // Nothing has been lazy-rendered yet (no-op observer, no scrollToPath call).
    expect(host(), "no Pierre host before any render").toBeNull();
  });

  it("scrollToPath force-renders an off-screen file (its Pierre host appears)", async () => {
    vi.stubGlobal("IntersectionObserver", NoopIO);
    // Spy on the section scroll so we can prove the corrective re-scroll has fired
    // by the time the awaited promise resolves (regression: the double-rAF must be
    // awaited, not left dangling after resolve).
    const scrollSpy = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const { component } = await render(DiffFileStack, {
      files,
      diffStyle: "split" as "split" | "unified",
    });

    expect(host(), "no host before scrollToPath").toBeNull();

    await (component as { scrollToPath: (p: string) => Promise<void> }).scrollToPath(TEXT_PATH);

    // The initial scroll + the corrective double-rAF scroll have BOTH run before the
    // promise resolved — asserted synchronously (no waitFor), so a dangling rAF
    // (resolving early) would fail here with only 1 call.
    expect(
      scrollSpy.mock.calls.length,
      "initial + awaited corrective scroll both fired before resolve",
    ).toBeGreaterThanOrEqual(2);

    // Pierre appends its <diffs-container> host asynchronously after the dynamic
    // import resolves — poll for it.
    await vi.waitFor(() => {
      expect(host(), "Pierre host present after scrollToPath").toBeTruthy();
    });
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import BacklogOverlay from "./BacklogOverlay.svelte";
import type { BacklogPayload, BacklogProject } from "$lib/types";

const noop = () => {};

function project(path: string): BacklogProject {
  return {
    path,
    display: path,
    slug: `org/${path}`,
    kind: "github",
    openIssues: 3,
    openPRs: 1,
    prKinds: null,
    workflows: null,
    ciStatus: null,
    hidden: false,
  };
}

// n projects → the master list wants to be n·rows tall; pre-fix (max-height only)
// the shell grows to fit that, so busy vs sparse payloads yield different shell heights.
function payload(n: number): BacklogPayload {
  return {
    pinnedPath: null,
    projects: Array.from({ length: n }, (_, i) => project(`/r/repo-${i}`)),
    totals: { openIssues: 0, openPRs: 0 },
  };
}

function props(over: Partial<Record<string, unknown>> = {}) {
  return {
    payload: payload(40),
    mobile: false,
    onissue: noop,
    onpr: noop,
    onadopt: noop,
    onlaunchtrain: noop,
    onclose: noop,
    onaddclone: noop,
    onaddfork: noop,
    onaddnewproject: noop,
    ...over,
  };
}

// Mirrors the "Settings dialog layout stability" guard added in PR #1369 for the
// Settings modal: the Repos modal shell (.card in BacklogOverlay) carries a fixed
// height: min(720px, 88vh), so switching between a content-heavy and a sparse repo
// list must NOT resize the shell — the master list scrolls inside instead.
describe("BacklogOverlay (Repos) shell layout stability", () => {
  afterEach(async () => {
    await page.viewport(1280, 900);
  });

  it("keeps the modal shell height stable across content changes", async () => {
    await page.viewport(1280, 900);
    const { rerender } = await render(BacklogOverlay, props({ payload: payload(40) }));

    const card = document.querySelector<HTMLElement>(".card");
    expect(card).not.toBeNull();
    // desktop shell, not the mobile full-screen sheet (whose height rules differ)
    expect(card!.classList.contains("mobile")).toBe(false);

    const before = card!.getBoundingClientRect();
    // Fixed height = min(720px, 88vh); at this viewport it resolves to the px clamp,
    // i.e. NOT the taller content-driven height a 40-repo list would otherwise force.
    const expected = Math.min(720, 0.88 * window.innerHeight);
    expect(Math.abs(before.height - expected)).toBeLessThanOrEqual(3);

    // The repo list — not the shell — is the scroller that absorbs overflow.
    const master = document.querySelector<HTMLElement>(".master-pane");
    expect(master).not.toBeNull();
    expect(getComputedStyle(master!).overflowY).toBe("auto");

    // Swap to a sparse payload: pre-fix this collapses the shell to its content;
    // with the fixed height the shell geometry must be unchanged.
    await rerender(props({ payload: payload(2) }));
    const after = document.querySelector<HTMLElement>(".card")!.getBoundingClientRect();
    expect(after.height).toBeCloseTo(before.height, 0);
    expect(after.top).toBeCloseTo(before.top, 0);
  });
});

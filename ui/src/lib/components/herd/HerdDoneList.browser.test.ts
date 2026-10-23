import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import HerdDoneList from "./HerdDoneList.svelte";
import { m } from "#lib/paraglide/messages.js";
import type { Session } from "#lib/types.js";
import { THEMES, expectQuietLegible } from "#lib/test-support/contrast.js";
import { recaps } from "#lib/recaps.svelte.js";
import type { Recap } from "#lib/types.js";

afterEach(() => {
  document.body.innerHTML = "";
});

const done = (id: string): Session =>
  ({
    id,
    desig: `TASK-${id}`,
    name: `name ${id}`,
    prompt: "",
    repoPath: "/repo/x",
    updatedAt: 0,
    archivedAt: 0,
  }) as unknown as Session;

const props = (extra: Record<string, unknown> = {}) => ({
  doneList: [done("a"), done("b")],
  doneSelectedId: null,
  nowMs: 1000,
  ...extra,
});

function row(id: string): HTMLElement {
  return document.querySelector<HTMLElement>(`.done-row[data-unit-id="${id}"]`)!;
}

describe("HerdDoneList bring-back context menu", () => {
  it("right-click opens a menu whose confirmed Bring back restores that row", async () => {
    const onbringback = vi.fn();
    render(HerdDoneList, { props: props({ onbringback }) });

    const e = new MouseEvent("contextmenu", {
      button: 2,
      clientX: 40,
      clientY: 40,
      bubbles: true,
      cancelable: true,
    });
    row("b").dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    const item = page.getByRole("menuitem", { name: m.donerecap_bringback() });
    await item.click();
    expect(onbringback).not.toHaveBeenCalled();
    await page.getByRole("menuitem", { name: m.donerecap_bringback_confirm() }).click();

    expect(onbringback).toHaveBeenCalledExactlyOnceWith("b");
    expect(document.querySelector(".card-menu")).toBeNull();
  });

  it("leaves the native context menu alone without onbringback", async () => {
    render(HerdDoneList, { props: props() });
    const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    row("a").dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(document.querySelector(".card-menu")).toBeNull();
  });
});

// #3283: slate (--status-done) is 3.0:1 on the panel — a parked verdict word reads muted.
describe("HerdDoneList parked verdict contrast", () => {
  afterEach(() => {
    recaps.map = {};
    document.documentElement.removeAttribute("data-theme");
  });
  for (const theme of THEMES) {
    it(`keeps the parked verdict legible and un-green: ${theme}`, async () => {
      document.documentElement.dataset.theme = theme;
      recaps.map = {
        a: { state: "ready", verdict: "parked", sessionId: "a" } as unknown as Recap,
      };
      render(HerdDoneList, { props: props() });
      await expect.element(page.getByText(m.recap_verdict_parked())).toBeInTheDocument();
      expectQuietLegible(document.querySelector<HTMLElement>(".done-verdict")!);
    });
  }
});

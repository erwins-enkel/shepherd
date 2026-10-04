import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import HerdDoneList from "./HerdDoneList.svelte";
import { m } from "$lib/paraglide/messages";
import type { Session } from "$lib/types";

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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { tick } from "svelte";
import "../../app.css";
import type { Steer } from "$lib/types";

// Stub the api so mount never hits the network: getCommands feeds the slash menu, and
// putSteers is a spy the tests inspect (getSteers is skipped — the store is pre-loaded).
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    getCommands: vi.fn(async () => ({ commands: [] })),
    putSteers: vi.fn(async (s: Steer[]) => s),
  };
});

const { default: SteersEditor } = await import("./SteersEditor.svelte");
const { steers } = await import("$lib/steers.svelte");
const { repos } = await import("$lib/repos.svelte");
const { putSteers } = await import("$lib/api");
const putSpy = vi.mocked(putSteers);

const steer = (p: Partial<Steer>): Steer => ({
  id: "1",
  label: "Ship",
  text: "ship it",
  inSteerBar: true,
  onIssues: false,
  ...p,
});

beforeEach(() => {
  steers.list = [
    steer({ id: "a", label: "Alpha", text: "do alpha" }),
    steer({ id: "b", label: "Bravo", text: "do bravo" }),
  ];
  steers.loaded = true; // skip the network load on mount
  steers.draftBuffer = [];
  repos.entries = [];
  repos.loaded = true; // skip the /api/repos network load on mount
  putSpy.mockClear();
});

afterEach(() => {
  document.body.innerHTML = "";
});

// rAF settle helper — SteersEditor focuses the targeted row on the next frame.
const frames = (n = 2) =>
  new Promise<void>((r) => {
    let i = 0;
    const step = () => (++i >= n ? r() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
// let a fire-and-forget autosave (steers.save → putSteers) settle
const settle = () => new Promise((r) => setTimeout(r, 0));

const row = (id: string) => document.querySelector<HTMLElement>(`.srow[data-steer-id="${id}"]`);

describe("SteersEditor focusSteerId", () => {
  it("expands and focuses the targeted steer's row", async () => {
    render(SteersEditor, { focusSteerId: "b" });
    await tick();
    await frames();

    const r = row("b");
    expect(r, "targeted row rendered").not.toBeNull();
    expect(r!.classList.contains("open"), "targeted row expanded").toBe(true);
    const ta = r!.querySelector("textarea.ptext") as HTMLTextAreaElement;
    expect(document.activeElement, "targeted prompt field focused").toBe(ta);

    expect(row("a")!.classList.contains("open")).toBe(false);
  });

  it("leaves every row collapsed when no steer is targeted", async () => {
    render(SteersEditor, {});
    await tick();
    await frames();
    expect(document.querySelectorAll(".srow.open").length).toBe(0);
  });
});

describe("SteersEditor settings search", () => {
  it("highlights a matching substring in its settings chrome", async () => {
    render(SteersEditor, { query: "saved" });
    await tick();
    const mark = document.querySelector(".editor mark");
    expect(mark?.textContent?.toLowerCase()).toBe("saved");
  });
});

describe("SteersEditor autosave — incomplete-row isolation", () => {
  it("saves a persisted-row edit while an invalid new row is present, excluding the new row", async () => {
    render(SteersEditor, {});
    await tick();

    // add a blank (invalid) new row, then expand the persisted row A and toggle a placement
    (document.querySelector(".add") as HTMLButtonElement).click();
    await tick();
    (row("a")!.querySelector(".rtitle") as HTMLButtonElement).click();
    await tick();
    putSpy.mockClear();

    const boxes = row("a")!.querySelectorAll<HTMLInputElement>(".cbx input");
    boxes[1]!.click(); // toggle "issues" on A → immediate autosave
    await settle();

    expect(putSpy).toHaveBeenCalledTimes(1);
    const payload = putSpy.mock.calls[0]![0];
    expect(payload.map((s) => s.id).sort()).toEqual(["a", "b"]); // the blank row is excluded
    expect(payload.find((s) => s.id === "a")!.onIssues).toBe(true);
  });

  it("blocks autosave while a persisted row is invalid, until it is refilled", async () => {
    render(SteersEditor, { focusSteerId: "a" });
    await tick();
    await frames();

    const name = row("a")!.querySelector("input.ntext") as HTMLInputElement;
    name.value = "";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    name.dispatchEvent(new FocusEvent("blur"));
    await settle();
    expect(putSpy, "empty label blocks the whole PUT").not.toHaveBeenCalled();

    name.value = "Renamed";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    name.dispatchEvent(new FocusEvent("blur"));
    await settle();
    expect(putSpy).toHaveBeenCalled();
    expect(putSpy.mock.calls.at(-1)![0].find((s) => s.id === "a")!.label).toBe("Renamed");
  });
});

describe("SteersEditor — close/navigation draft lifecycle", () => {
  it("flushes the valid baseline independently and recovers an invalid new row on unmount", async () => {
    steers.list = [steer({ id: "a", label: "Alpha", text: "do alpha" })];
    const { unmount } = await render(SteersEditor, { focusSteerId: "a" });
    await tick();

    // edit the persisted row (valid) and add a still-invalid new row with partial content
    const name = row("a")!.querySelector("input.ntext") as HTMLInputElement;
    name.value = "Alpha2";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    (document.querySelector(".add") as HTMLButtonElement).click();
    await tick();
    const newRow = [...document.querySelectorAll<HTMLElement>(".srow")].find(
      (el) => el.getAttribute("data-steer-id") !== "a",
    )!;
    const newName = newRow.querySelector("input.ntext") as HTMLInputElement;
    newName.value = "Wip";
    newName.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();

    await unmount();
    await settle();

    // every persisted write carried only the baseline row — the invalid draft never went out
    expect(putSpy).toHaveBeenCalled();
    for (const call of putSpy.mock.calls) {
      expect(call[0].every((s) => s.id === "a")).toBe(true);
    }
    expect(putSpy.mock.calls.some((c) => c[0].some((s) => s.label === "Alpha2"))).toBe(true);
    // the partial new row is recovered, not lost
    expect(steers.draftBuffer.length).toBe(1);
    expect(steers.draftBuffer[0]!.label).toBe("Wip");

    // remounting restores it and drains the buffer
    render(SteersEditor, {});
    await tick();
    await frames();
    const restored = document.querySelector(".srow.open input.ntext") as HTMLInputElement;
    expect(restored?.value).toBe("Wip");
    expect(steers.draftBuffer.length).toBe(0);
  });

  it("does not recover an entirely-empty added row", async () => {
    steers.list = [steer({ id: "a" })];
    const { unmount } = await render(SteersEditor, {});
    await tick();
    (document.querySelector(".add") as HTMLButtonElement).click();
    await tick();
    await unmount();
    expect(steers.draftBuffer.length).toBe(0);
  });
});

describe("SteersEditor — two-step remove", () => {
  it("deletes and persists exactly once on confirm", async () => {
    render(SteersEditor, {});
    await tick();
    (row("a")!.querySelector(".rtitle") as HTMLButtonElement).click();
    await tick();
    putSpy.mockClear();

    (row("a")!.querySelector(".rc-open") as HTMLButtonElement).click();
    await tick();
    // the confirm is now showing (survives the click that opened it)
    const yes = row("a")!.querySelector(".rc-yes") as HTMLButtonElement;
    expect(yes, "confirm shown").not.toBeNull();

    yes.click();
    await settle();

    expect(putSpy).toHaveBeenCalledTimes(1);
    expect(putSpy.mock.calls[0]![0].map((s) => s.id)).toEqual(["b"]);
    expect(row("a"), "row removed").toBeNull();
  });

  it("cancels the confirm on blur to outside its controls, with no delete", async () => {
    render(SteersEditor, {});
    await tick();
    (row("a")!.querySelector(".rtitle") as HTMLButtonElement).click();
    await tick();
    putSpy.mockClear();

    (row("a")!.querySelector(".rc-open") as HTMLButtonElement).click();
    await tick();
    const wrap = row("a")!.querySelector(".remove-wrap") as HTMLElement;
    wrap.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body }));
    await tick();

    expect(row("a")!.querySelector(".rc-yes"), "confirm dismissed").toBeNull();
    expect(row("a")!.querySelector(".rc-open"), "reverted to Remove…").not.toBeNull();
    expect(putSpy).not.toHaveBeenCalled();
    expect(row("a"), "row not deleted").not.toBeNull();
  });
});

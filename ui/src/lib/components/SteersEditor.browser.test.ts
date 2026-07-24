import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { tick } from "svelte";
import "../../app.css";
import type { Steer } from "$lib/types";

// Stub the api so mount never hits the network: getCommands feeds the slash menu,
// and getSteers is skipped because we pre-mark the store loaded.
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
  repos.loaded = true; // skip the /api/repos network load on mount
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

describe("SteersEditor focusSteerId", () => {
  it("expands and focuses the targeted steer's row", async () => {
    render(SteersEditor, { focusSteerId: "b" });
    await tick();
    await frames();

    const row = document.querySelector('.srow[data-steer-id="b"]') as HTMLElement;
    expect(row, "targeted row rendered").not.toBeNull();
    expect(row.classList.contains("editing"), "targeted row expanded").toBe(true);
    const ta = row.querySelector("textarea.text") as HTMLTextAreaElement;
    expect(document.activeElement, "targeted prompt field focused").toBe(ta);

    // The other row stays collapsed.
    const other = document.querySelector('.srow[data-steer-id="a"]') as HTMLElement;
    expect(other.classList.contains("editing")).toBe(false);
  });

  it("leaves every row collapsed when no steer is targeted", async () => {
    render(SteersEditor, {});
    await tick();
    await frames();

    const editing = document.querySelectorAll(".srow.editing");
    expect(editing.length).toBe(0);
  });
});

describe("SteersEditor settings search", () => {
  it("highlights a matching substring in its settings chrome", async () => {
    render(SteersEditor, { query: "saved" });
    await tick();

    const mark = document.querySelector(".editor mark");
    expect(mark?.textContent.toLowerCase()).toBe("saved");
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { tick } from "svelte";
import "../../app.css";
import type { RepoEntry } from "$lib/types";
import SteerRepoTokenField from "./SteerRepoTokenField.svelte";

function r(name: string, extra: Partial<RepoEntry> = {}): RepoEntry {
  return { name, path: `/r/${name}`, display: name, realPath: `/r/${name}`, ...extra };
}

// bar-ui + barboard share the "bar" substring; secret is hidden; herdr is the most recent.
const repos: RepoEntry[] = [
  r("shepherd", { lastUsedAt: 100 }),
  r("bar-ui", { lastUsedAt: 300, recentAgentCount: 5 }),
  r("barboard", { lastUsedAt: 200 }),
  r("herdr", { lastUsedAt: 500 }),
  r("secret", { lastUsedAt: 900, hidden: true }),
];

afterEach(() => {
  document.body.innerHTML = "";
});

function typeInto(input: HTMLInputElement, text: string) {
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const optionTexts = () => [...document.querySelectorAll(".opt")].map((o) => o.textContent?.trim());
const chipTexts = () =>
  [...document.querySelectorAll(".chip")].map((c) => c.textContent?.replace(/^\+\s*/, "").trim());

describe("SteerRepoTokenField — contract-driven filter + ranking", () => {
  it("filters candidateNames case-insensitively and excludes already-selected tokens", async () => {
    render(SteerRepoTokenField, { value: ["bar-ui"], repos, onchange: vi.fn() });
    const input = document.querySelector(".tinput") as HTMLInputElement;
    typeInto(input, "BAR");
    await tick();
    // both "bar-ui" and "barboard" match "bar", but bar-ui is already a token → excluded
    expect(optionTexts()).toEqual(["barboard"]);
  });

  it("ranks suggestions by lastUsedAt desc (tie recentAgentCount), excludes hidden, caps at 3", async () => {
    render(SteerRepoTokenField, { value: undefined, repos, onchange: vi.fn() });
    // herdr(500) > bar-ui(300) > barboard(200) > shepherd(100); secret is hidden → excluded; cap 3
    expect(chipTexts()).toEqual(["herdr", "bar-ui", "barboard"]);
  });

  it("keeps a hidden repo out of suggestions but reachable through the typeahead", async () => {
    render(SteerRepoTokenField, { value: undefined, repos, onchange: vi.fn() });
    expect(chipTexts().some((c) => c === "secret")).toBe(false);
    const input = document.querySelector(".tinput") as HTMLInputElement;
    typeInto(input, "secret");
    await tick();
    expect(optionTexts()).toEqual(["secret"]);
  });

  it("shows the X von Y count from the unique candidate total", async () => {
    render(SteerRepoTokenField, { value: ["bar-ui", "barboard"], repos, onchange: vi.fn() });
    // 2 selected of 5 unique candidate names (locale-agnostic assertion)
    expect(document.querySelector(".count")?.textContent?.trim()).toMatch(/2\D+5/);
  });
});

describe("SteerRepoTokenField — scope state machine", () => {
  it("adds a suggestion without transiently reverting an empty selection to ALLE", () => {
    const onchange = vi.fn();
    render(SteerRepoTokenField, { value: [], repos, onchange });
    const chip = [...document.querySelectorAll(".chip")].find((c) =>
      c.textContent?.includes("herdr"),
    ) as HTMLElement;
    chip.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    chip.click();
    expect(onchange).toHaveBeenCalledWith(["herdr"]);
    expect(onchange).not.toHaveBeenCalledWith(undefined); // never reverted mid-selection
  });

  it("reverts an empty selection to ALLE only when focus leaves the field", () => {
    const onchange = vi.fn();
    render(SteerRepoTokenField, { value: [], repos, onchange });
    const input = document.querySelector(".tinput") as HTMLElement;
    // focusout to an element OUTSIDE the field root reverts to undefined (ALLE)
    input.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body }),
    );
    expect(onchange).toHaveBeenCalledWith(undefined);
  });

  it("does not revert when focus moves to an element inside the field", () => {
    const onchange = vi.fn();
    render(SteerRepoTokenField, { value: [], repos, onchange });
    const input = document.querySelector(".tinput") as HTMLElement;
    const chip = document.querySelector(".chip") as HTMLElement; // inside the field root
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: chip }));
    expect(onchange).not.toHaveBeenCalledWith(undefined);
  });

  it("removes the last token on backspace with an empty input", () => {
    const onchange = vi.fn();
    render(SteerRepoTokenField, { value: ["shepherd", "bar-ui"], repos, onchange });
    const input = document.querySelector(".tinput") as HTMLInputElement;
    input.value = "";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    expect(onchange).toHaveBeenCalledWith(["shepherd"]);
  });

  it("removing the ✱ token switches to selection mode with zero tokens", () => {
    const onchange = vi.fn();
    render(SteerRepoTokenField, { value: undefined, repos, onchange });
    (document.querySelector(".token-all .tx") as HTMLElement).click();
    expect(onchange).toHaveBeenCalledWith([]);
  });
});

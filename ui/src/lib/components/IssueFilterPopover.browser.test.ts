import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../app.css";
import { m } from "#lib/paraglide/messages.js";
import { putIssueFilter } from "#lib/api.js";
import { issueFilterSettings } from "#lib/issue-filter-settings.svelte.js";
import { DEFAULT_ISSUE_FILTER } from "#lib/issue-filter-migration.js";
import type { IssueFilterSettings } from "#lib/types.js";

vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return {
    ...actual,
    putIssueFilter: vi.fn(async (patch: Partial<IssueFilterSettings>) => ({
      issueFilter: { ...issueFilterSettings.effective, ...patch },
    })),
  };
});

const { default: IssueFilterPopover } = await import("./IssueFilterPopover.svelte");

// The server-backed singleton starts each test at the loaded defaults:
// scope=mine_unassigned, hideActive=false, hideSubIssues=true, hideBlocked=true.
beforeEach(() => {
  issueFilterSettings.apply(structuredClone(DEFAULT_ISSUE_FILTER));
  vi.mocked(putIssueFilter).mockClear();
});

afterEach(() => {
  issueFilterSettings.clear();
  document.body.innerHTML = "";
});

// Helper: get the trigger button.
const triggerBtn = () =>
  document.querySelector("button[aria-haspopup='dialog']") as HTMLButtonElement | null;

// Helper: check if popover is open via aria-expanded on the trigger.
const isOpen = () => triggerBtn()?.getAttribute("aria-expanded") === "true";

// Helper: get the popover panel.
const popoverPanel = () => document.querySelector("[popover].filter-popover") as HTMLElement | null;

// Helper: query checkboxes inside the popover (always in DOM with native popover).
const checkboxes = () =>
  [...(popoverPanel()?.querySelectorAll("input[type=checkbox]") ?? [])] as HTMLInputElement[];

// Helper: get the badge text (if visible).
const badgeText = () => {
  const badge = triggerBtn()?.querySelector(".badge");
  return badge ? badge.textContent?.trim() : null;
};

const radiogroup = (name: string) =>
  popoverPanel()?.querySelector<HTMLElement>(`[role='radiogroup'][aria-label='${name}']`) ?? null;
const radioFor = (group: string, label: string) =>
  [...(radiogroup(group)?.querySelectorAll(".filter-row") ?? [])]
    .find((row) => row.querySelector(".row-label")?.textContent?.trim() === label)
    ?.querySelector<HTMLInputElement>("input[type=radio]") ?? null;
const checkboxFor = (label: string) =>
  [...(popoverPanel()?.querySelectorAll(".filter-row") ?? [])]
    .find((row) => row.querySelector(".row-label")?.textContent?.trim() === label)
    ?.querySelector<HTMLInputElement>("input[type=checkbox]") ?? null;
const hideToggleFor = (label: string) =>
  [...(popoverPanel()?.querySelectorAll<HTMLButtonElement>(".hide-toggle") ?? [])].find(
    (b) => b.textContent?.trim() === label,
  ) ?? null;

// Helper: get row labels from inside the popover panel.
const rowLabels = () =>
  [...(popoverPanel()?.querySelectorAll(".row-label") ?? [])].map((el) => el.textContent?.trim());

describe("IssueFilterPopover", () => {
  it("renders the trigger button; popover not open initially", async () => {
    render(IssueFilterPopover, { showMine: true });

    await expect.poll(() => triggerBtn()).toBeTruthy();

    // Popover should exist in DOM but aria-expanded should be false.
    expect(isOpen()).toBe(false);
    // The popover panel exists in DOM (native popover) but is not open.
    expect(popoverPanel()).toBeTruthy();
    // No checkboxes visible before opening — but with native popover they ARE in DOM.
    // Verify closed via aria-expanded, not checkbox count.
    expect(triggerBtn()!.getAttribute("aria-expanded")).toBe("false");
  });

  it("is labelled with a chevron by default", async () => {
    render(IssueFilterPopover, { showMine: true });
    await expect.poll(() => triggerBtn()).toBeTruthy();
    expect(triggerBtn()!.textContent).toContain(m.issue_filter_button());
    expect(triggerBtn()!.querySelector(".chevron")).not.toBeNull();
    expect(triggerBtn()!.querySelector("svg")).toBeNull();
  });

  it("iconOnly swaps the label and chevron for a funnel and keeps the count", async () => {
    render(IssueFilterPopover, { showMine: true, iconOnly: true });
    await expect.poll(() => triggerBtn()).toBeTruthy();
    expect(triggerBtn()!.textContent).not.toContain(m.issue_filter_button());
    expect(triggerBtn()!.querySelector(".chevron")).toBeNull();
    expect(triggerBtn()!.querySelector("svg")).not.toBeNull();
    // "mine & unassigned", "hide sub-issues" and "hide blocked" are on here: the count survives the icon.
    expect(badgeText()).toBe("3");
    expect(triggerBtn()!.getAttribute("aria-label")).toBe(m.issue_filter_button_aria({ count: 3 }));
    triggerBtn()!.click();
    await expect.poll(isOpen).toBe(true);
  });

  it("click trigger opens popover; scope, forks and three toggles render when showMine=true", async () => {
    render(IssueFilterPopover, { showMine: true });
    await expect.poll(() => triggerBtn()).toBeTruthy();
    expect(isOpen()).toBe(false);
    triggerBtn()!.click();
    await expect.poll(() => isOpen()).toBe(true);
    expect(checkboxes().length).toBe(3);
    expect(
      radioFor(m.upnext_filter_scope_heading(), m.upnext_filter_scope_mine_unassigned())!.checked,
    ).toBe(true);
    expect(radioFor(m.upnext_filter_forks_heading(), m.upnext_filter_forks_all())!.checked).toBe(
      true,
    );
    expect(rowLabels()).toContain(m.issues_filter_active_label());
    expect(rowLabels()).toContain(m.issues_filter_subissues_label());
    expect(rowLabels()).toContain(m.issues_filter_blocked_label());
  });

  it("badge reads 3 with the defaults (scope + sub-issues + blocked)", async () => {
    render(IssueFilterPopover, { showMine: true });
    await expect.poll(() => triggerBtn()).toBeTruthy();
    expect(badgeText()).toBe("3");
  });

  it("omits the sub-issue toggle (and its badge count) when showSubIssuesToggle=false", async () => {
    render(IssueFilterPopover, { showMine: true, showSubIssuesToggle: false });
    await expect.poll(() => triggerBtn()).toBeTruthy();
    expect(badgeText()).toBe("2");
    triggerBtn()!.click();
    await expect.poll(() => isOpen()).toBe(true);
    expect(checkboxes().length).toBe(2);
    expect(rowLabels()).not.toContain(m.issues_filter_subissues_label());
  });

  it("showMine=false drops the scope choice and its badge count", async () => {
    render(IssueFilterPopover, { showMine: false });
    await expect.poll(() => triggerBtn()).toBeTruthy();
    expect(badgeText()).toBe("2");
    triggerBtn()!.click();
    await expect.poll(() => isOpen()).toBe(true);
    expect(radiogroup(m.upnext_filter_scope_heading())).toBeNull();
    expect(radiogroup(m.upnext_filter_forks_heading())).toBeTruthy();
  });

  it("the forks rule counts only in a fork repo", async () => {
    issueFilterSettings.apply({ ...DEFAULT_ISSUE_FILTER, forks: "hide" });
    render(IssueFilterPopover, { showMine: true, isFork: true });
    await expect.poll(() => badgeText()).toBe("4");
    document.body.innerHTML = "";
    render(IssueFilterPopover, { showMine: true, isFork: false });
    await expect.poll(() => badgeText()).toBe("3");
  });

  it("toggling a hide checkbox writes the server setting", async () => {
    render(IssueFilterPopover, { showMine: true });
    await expect.poll(() => triggerBtn()).toBeTruthy();
    triggerBtn()!.click();
    await expect.poll(() => isOpen()).toBe(true);
    checkboxFor(m.issues_filter_active_label())!.click();
    await expect
      .poll(() => vi.mocked(putIssueFilter).mock.calls[0]?.[0])
      .toEqual({ hideActive: true });
    await expect.poll(() => issueFilterSettings.value?.hideActive).toBe(true);
  });

  it("picking a scope or forks option writes the server setting", async () => {
    render(IssueFilterPopover, { showMine: true });
    await expect.poll(() => triggerBtn()).toBeTruthy();
    triggerBtn()!.click();
    await expect.poll(() => isOpen()).toBe(true);
    radioFor(m.upnext_filter_scope_heading(), m.upnext_filter_scope_mine())!.click();
    await expect.poll(() => issueFilterSettings.value?.scope).toBe("mine");
    radioFor(m.upnext_filter_forks_heading(), m.upnext_filter_forks_own())!.click();
    await expect.poll(() => issueFilterSettings.value?.forks).toBe("own");
    expect(vi.mocked(putIssueFilter).mock.calls.map((c) => c[0])).toEqual([
      { scope: "mine" },
      { forks: "own" },
    ]);
  });

  it("hiding a label writes hiddenLabels and drops it from the include picker", async () => {
    render(IssueFilterPopover, { showMine: true, labels: ["bug", "docs"] });
    await expect.poll(() => triggerBtn()).toBeTruthy();
    triggerBtn()!.click();
    await expect.poll(() => isOpen()).toBe(true);
    hideToggleFor("docs")!.click();
    await expect.poll(() => issueFilterSettings.value?.hiddenLabels).toEqual(["docs"]);
    await expect.poll(() => labelToggles().map((b) => b.textContent?.trim())).toEqual(["bug"]);
    expect(hideToggleFor("docs")!.getAttribute("aria-pressed")).toBe("true");
    expect(badgeText()).toBe("4");
  });

  it("persistent controls are read-only until the server value loads", async () => {
    issueFilterSettings.clear();
    render(IssueFilterPopover, { showMine: true });
    await expect.poll(() => triggerBtn()).toBeTruthy();
    triggerBtn()!.click();
    await expect.poll(() => isOpen()).toBe(true);
    expect(checkboxes().every((c) => c.disabled)).toBe(true);
    expect(badgeText()).toBe("3");
  });

  it("Esc closes the popover", async () => {
    render(IssueFilterPopover, { showMine: true });
    await expect.poll(() => triggerBtn()).toBeTruthy();

    triggerBtn()!.click();
    await expect.poll(() => isOpen()).toBe(true);

    // Wait for the setTimeout(0) in the dismiss effect to register listeners.
    await new Promise((r) => setTimeout(r, 50));

    // Dispatch Escape key on window.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    await expect.poll(() => isOpen()).toBe(false);
  });

  it("outside pointerdown closes the popover", async () => {
    render(IssueFilterPopover, { showMine: true });
    await expect.poll(() => triggerBtn()).toBeTruthy();

    triggerBtn()!.click();
    await expect.poll(() => isOpen()).toBe(true);

    // Wait for the setTimeout(0) in the dismiss effect to register listeners.
    await new Promise((r) => setTimeout(r, 50));

    // Dispatch a pointerdown on document.body (outside both btn and popover).
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

    await expect.poll(() => isOpen()).toBe(false);
  });

  it("mounting does NOT steal focus from a pre-focused element", async () => {
    // Create an input and give it focus before rendering the popover.
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    render(IssueFilterPopover, { showMine: true });
    await expect.poll(() => triggerBtn()).toBeTruthy();

    // Allow any microtask / setTimeout(0) to settle.
    await new Promise((r) => setTimeout(r, 50));

    // Focus must still be on the input — the popover must not have stolen it.
    expect(document.activeElement).toBe(input);
  });

  it("opening then closing the popover restores focus to the trigger button", async () => {
    render(IssueFilterPopover, { showMine: true });
    await expect.poll(() => triggerBtn()).toBeTruthy();

    // Open the popover.
    triggerBtn()!.click();
    await expect.poll(() => isOpen()).toBe(true);
    // Allow focus-on-open setTimeout(0) to settle.
    await new Promise((r) => setTimeout(r, 50));

    // Close via Escape.
    await new Promise((r) => setTimeout(r, 50)); // let dismiss listener register
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await expect.poll(() => isOpen()).toBe(false);

    // Focus must be restored to the trigger button.
    expect(document.activeElement).toBe(triggerBtn());
  });
});

// ── Author + label filter sections ─────────────────────────────────────────────
// Helpers scoped to the picker sections.
const authorSection = () => radiogroup(m.issues_filter_author_heading());
const authorRadioFor = (login: string) =>
  [...(authorSection()?.querySelectorAll(".author-row") ?? [])]
    .find((row) => row.querySelector(".row-label")?.textContent?.trim() === login)
    ?.querySelector<HTMLInputElement>("input[type=radio]") ?? null;
const labelToggles = () =>
  [
    ...(popoverPanel()?.querySelectorAll(".label-toggle:not(.hide-toggle)") ?? []),
  ] as HTMLButtonElement[];
const labelToggleFor = (label: string) =>
  labelToggles().find((b) => b.textContent?.trim() === label) ?? null;

async function open(props: Record<string, unknown>) {
  render(IssueFilterPopover, props);
  await expect.poll(() => triggerBtn()).toBeTruthy();
  triggerBtn()!.click();
  await expect.poll(() => isOpen()).toBe(true);
}

describe("IssueFilterPopover — author + label pickers", () => {
  it("defaults: neither the author nor the label section renders when no options are passed", async () => {
    await open({ showMine: true });
    expect(authorSection()).toBeNull();
    expect(labelToggles().length).toBe(0);
  });

  it("author section: renders 'All authors' + one radio per author when >=2 authors", async () => {
    await open({ showMine: true, authors: ["kai", "scoop"] });
    expect(authorSection()).toBeTruthy();
    const radios = authorSection()!.querySelectorAll("input[type=radio]");
    // All authors + kai + scoop.
    expect(radios.length).toBe(3);
    expect(authorRadioFor(m.issues_filter_author_all())).toBeTruthy();
    expect(authorRadioFor("kai")).toBeTruthy();
    expect(authorRadioFor("scoop")).toBeTruthy();
  });

  it("author section is hidden below two authors when nothing is selected", async () => {
    await open({ showMine: true, authors: ["kai"], selectedAuthor: null });
    expect(authorSection()).toBeNull();
  });

  it("author: the selected author's radio is checked; 'All authors' is checked when none selected", async () => {
    await open({ showMine: true, authors: ["kai", "scoop"], selectedAuthor: "scoop" });
    expect(authorRadioFor("scoop")!.checked).toBe(true);
    expect(authorRadioFor(m.issues_filter_author_all())!.checked).toBe(false);
  });

  it("author callbacks: picking an author fires onauthor(login); 'All authors' fires onauthor(null)", async () => {
    const onauthor = vi.fn();
    await open({ showMine: true, authors: ["kai", "scoop"], selectedAuthor: "kai", onauthor });

    authorRadioFor("scoop")!.click();
    await expect.poll(() => onauthor).toHaveBeenCalledWith("scoop");

    authorRadioFor(m.issues_filter_author_all())!.click();
    await expect.poll(() => onauthor).toHaveBeenCalledWith(null);
  });

  it("refresh regression: a still-selected author keeps its clearable section when the option set shrinks to one", async () => {
    // A same-repo refresh removed the other author but kept 'kai', so availableAuthors is
    // now just ["kai"] — below the >=2 threshold. Because selectedAuthor stays set, the
    // section must remain rendered and clearable via 'All authors'.
    const onauthor = vi.fn();
    await open({ showMine: true, authors: ["kai"], selectedAuthor: "kai", onauthor });

    expect(authorSection()).toBeTruthy();
    expect(authorRadioFor("kai")!.checked).toBe(true);

    authorRadioFor(m.issues_filter_author_all())!.click();
    await expect.poll(() => onauthor).toHaveBeenCalledWith(null);
  });

  it("label section: chips render with aria-pressed reflecting selectedLabels", async () => {
    await open({ showMine: true, labels: ["BUG", "DOCS"], selectedLabels: ["BUG"] });
    expect(labelToggles().length).toBe(2);
    expect(labelToggleFor("BUG")!.getAttribute("aria-pressed")).toBe("true");
    expect(labelToggleFor("DOCS")!.getAttribute("aria-pressed")).toBe("false");
  });

  it("label callback: clicking a chip fires ontogglelabel(label)", async () => {
    const ontogglelabel = vi.fn();
    await open({ showMine: true, labels: ["BUG", "DOCS"], selectedLabels: [], ontogglelabel });

    labelToggleFor("DOCS")!.click();
    await expect.poll(() => ontogglelabel).toHaveBeenCalledWith("DOCS");
  });

  it("active count includes the selected author and every selected label", async () => {
    // Default store (mine + subs + blocked) = 3, + author (1) + labels (2) = 6.
    await open({
      showMine: true,
      authors: ["kai", "scoop"],
      selectedAuthor: "kai",
      labels: ["BUG", "DOCS"],
      selectedLabels: ["BUG", "DOCS"],
    });
    expect(badgeText()).toBe("6");
  });

  it("focus on open lands on the first default-filter control, not a per-view one", async () => {
    await open({
      showMine: true,
      authors: ["kai", "scoop"],
      selectedAuthor: "kai",
      labels: ["BUG"],
      selectedLabels: ["BUG"],
    });
    // Let the focus-on-open setTimeout(0) settle.
    await new Promise((r) => setTimeout(r, 50));
    expect(document.activeElement).toBe(
      radioFor(m.upnext_filter_scope_heading(), m.upnext_filter_scope_all()),
    );
  });
});

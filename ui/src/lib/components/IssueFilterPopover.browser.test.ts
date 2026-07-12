import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../app.css";
import { m } from "$lib/paraglide/messages";
import { issuesFilter } from "$lib/issues-filter.svelte";

const { default: IssueFilterPopover } = await import("./IssueFilterPopover.svelte");

// Reset the localStorage-backed singleton between tests so order can't leak state.
// Default state: hideOthers=true, hideActive=false, hideSubIssues=true.
beforeEach(() => {
  issuesFilter.set(true);
  issuesFilter.setActive(false);
  issuesFilter.setSubIssues(true);
});

afterEach(() => {
  issuesFilter.set(true);
  issuesFilter.setActive(false);
  issuesFilter.setSubIssues(true);
  localStorage.clear();
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

  it("click trigger opens popover; four rows render when showMine=true", async () => {
    render(IssueFilterPopover, { showMine: true });

    await expect.poll(() => triggerBtn()).toBeTruthy();

    // Initially closed.
    expect(isOpen()).toBe(false);

    triggerBtn()!.click();

    // After click, aria-expanded should be true and four checkbox rows present
    // (mine + active + subs + blocked).
    await expect.poll(() => isOpen()).toBe(true);
    expect(checkboxes().length).toBe(4);

    expect(rowLabels()).toContain(m.issues_filter_mine_label());
    expect(rowLabels()).toContain(m.issues_filter_active_label());
    expect(rowLabels()).toContain(m.issues_filter_subissues_label());
  });

  it("badge reads 3 with showMine=true, hideOthers=true, hideActive=false, hideSubIssues=true", async () => {
    // Default store: hideOthers=true, hideActive=false, hideSubIssues=true, hideBlocked=true
    // activeCount = 1 (mine) + 0 (active) + 1 (subs) + 1 (blocked) = 3
    render(IssueFilterPopover, { showMine: true });

    await expect.poll(() => triggerBtn()).toBeTruthy();
    expect(badgeText()).toBe("3");
  });

  it("badge reads 2 (not 3) when showMine=false even with hideOthers=true persisted; mine row absent", async () => {
    // hideOthers is true (default) but showMine=false → mine doesn't count.
    // activeCount = 0 (mine excluded) + 0 (active) + 1 (subs) + 1 (blocked) = 2
    render(IssueFilterPopover, { showMine: false });

    await expect.poll(() => triggerBtn()).toBeTruthy();
    expect(badgeText()).toBe("2");

    // Open the popover to verify mine row is absent.
    triggerBtn()!.click();
    await expect.poll(() => isOpen()).toBe(true);

    // Only 3 checkboxes: active + subs + blocked (no mine).
    expect(checkboxes().length).toBe(3);

    expect(rowLabels()).not.toContain(m.issues_filter_mine_label());
    expect(rowLabels()).toContain(m.issues_filter_active_label());
    expect(rowLabels()).toContain(m.issues_filter_subissues_label());
  });

  it("toggling the active checkbox flips issuesFilter.hideActive and persists to localStorage", async () => {
    // Start with hideActive=false.
    expect(issuesFilter.hideActive).toBe(false);

    render(IssueFilterPopover, { showMine: true });
    await expect.poll(() => triggerBtn()).toBeTruthy();

    triggerBtn()!.click();
    await expect.poll(() => isOpen()).toBe(true);

    expect(checkboxes().length).toBe(4);

    // Find the active checkbox by its row label text, not by checked state.
    const activeLabel = [...(popoverPanel()?.querySelectorAll(".filter-row") ?? [])].find(
      (row) =>
        row.querySelector(".row-label")?.textContent?.trim() === m.issues_filter_active_label(),
    );
    const activeCheckbox = activeLabel?.querySelector<HTMLInputElement>("input[type=checkbox]");
    expect(activeCheckbox).toBeTruthy();
    activeCheckbox!.click();

    // Store should flip to true.
    await expect.poll(() => issuesFilter.hideActive).toBe(true);
    // localStorage should persist "1".
    expect(localStorage.getItem("shepherd:issues-hide-active")).toBe("1");
  });

  it("toggling the mine checkbox flips issuesFilter.hideOthers and persists to localStorage", async () => {
    // Start with hideOthers=true.
    expect(issuesFilter.hideOthers).toBe(true);

    render(IssueFilterPopover, { showMine: true });
    await expect.poll(() => triggerBtn()).toBeTruthy();

    triggerBtn()!.click();
    await expect.poll(() => isOpen()).toBe(true);

    expect(checkboxes().length).toBe(4);

    // Mine checkbox is first and checked by default (hideOthers=true).
    const mineCheckbox = checkboxes()[0];
    expect(mineCheckbox.checked).toBe(true);
    mineCheckbox.click();

    // Store should flip to false.
    await expect.poll(() => issuesFilter.hideOthers).toBe(false);
    // localStorage should persist "0".
    expect(localStorage.getItem("shepherd:issues-hide-others")).toBe("0");
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
const authorSection = () =>
  popoverPanel()?.querySelector("[role='radiogroup']") as HTMLElement | null;
const authorRadioFor = (login: string) =>
  [...(authorSection()?.querySelectorAll(".author-row") ?? [])]
    .find((row) => row.querySelector(".row-label")?.textContent?.trim() === login)
    ?.querySelector<HTMLInputElement>("input[type=radio]") ?? null;
const labelToggles = () =>
  [...(popoverPanel()?.querySelectorAll(".label-toggle") ?? [])] as HTMLButtonElement[];
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

  it("focus on open still lands on the first boolean checkbox, not a radio, with sections present", async () => {
    await open({
      showMine: true,
      authors: ["kai", "scoop"],
      selectedAuthor: "kai",
      labels: ["BUG"],
      selectedLabels: ["BUG"],
    });
    // Let the focus-on-open setTimeout(0) settle.
    await new Promise((r) => setTimeout(r, 50));
    expect(document.activeElement).toBe(checkboxes()[0]);
  });
});

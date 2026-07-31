import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import type { Issue, RepoConfig, RepoEntry } from "$lib/types";
import { m } from "$lib/paraglide/messages";
import { HOLD_MS } from "$lib/keymap/hold.svelte";
import { NEW_TASK_KEYMAP } from "$lib/keymap/newTask";
import {
  listIssues,
  getEpics,
  getTodo,
  listBranches,
  getRepoConfig,
  putRepoConfig,
  listRepos,
  branchStatus,
  getCommands,
} from "$lib/api";

vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    listIssues: vi.fn(),
    getEpics: vi.fn(),
    getTodo: vi.fn(),
    listBranches: vi.fn(),
    getRepoConfig: vi.fn(),
    putRepoConfig: vi.fn(),
    listRepos: vi.fn(),
    branchStatus: vi.fn(),
    getCommands: vi.fn(),
  };
});

const { default: NewTask } = await import("../NewTask.svelte");

function cfg(): RepoConfig & { automationConfirmed: boolean; automationRowExists: boolean } {
  return {
    criticEnabled: true,
    criticAllPrs: false,
    criticSmellLensEnabled: false,
    autoAddressEnabled: false,
    learningsEnabled: true,
    autopilotEnabled: false,
    autoDrainEnabled: false,
    autoMergeEnabled: false,
    buildQueueEnabled: false,
    planGateEnabled: false,
    draftMode: false,
    signoffAuthority: "human",
    sandboxProfile: "trusted",
    maxAuto: 1,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
    defaultModel: "inherit",
    defaultEffort: "inherit",
    repoMode: "forge",
    autoOptimizeFlagged: false,
    manualStepsIssueEnabled: false,
    preWarmEpicLandingCi: false,
    hidden: false,
    previewStartScript: null,
    previewStartCommand: null,
    previewOpenMode: "ask",
    automationConfirmed: true,
    automationRowExists: true,
  };
}

// PromptSources (the side list carrying ⌘F / ⌥T / ↑↓) only mounts with a repo.
const repo: RepoEntry = {
  name: "demo",
  path: "/repo/demo",
  display: "demo",
  realPath: "/repo/demo",
};

const issue = (number: number, title: string): Issue =>
  ({ number, title, labels: [], author: "someone", labelColors: {} }) as unknown as Issue;

beforeEach(async () => {
  await page.viewport(1280, 900);
  vi.mocked(getTodo).mockResolvedValue({ exists: false, content: "" });
  vi.mocked(listIssues).mockResolvedValue({
    slug: "owner/repo",
    webUrl: null,
    issues: [issue(11, "first issue"), issue(22, "second issue"), issue(33, "third issue")],
    viewer: null,
  });
  vi.mocked(getEpics).mockResolvedValue({ epics: [], subIssues: [] });
  vi.mocked(listBranches).mockResolvedValue({ current: "main", branches: ["main"], default: null });
  vi.mocked(getRepoConfig).mockResolvedValue(cfg());
  vi.mocked(putRepoConfig).mockResolvedValue(cfg());
  vi.mocked(listRepos).mockResolvedValue({ repos: [repo], recentWindowDays: 30 });
  vi.mocked(branchStatus).mockResolvedValue({ ahead: 0, behind: 0, diverged: false } as never);
  vi.mocked(getCommands).mockResolvedValue({ commands: [] });
});

// Same convention as NewTask.browser.test.ts: components accumulate in the DOM
// otherwise, and every query below would start matching a stale dialog.
afterEach(() => {
  document.body.innerHTML = "";
});

const form = () => document.querySelector<HTMLElement>("form.card")!;
const caps = () => Array.from(document.querySelectorAll<HTMLElement>("[data-keymap]"));
const capIds = () => caps().map((el) => el.dataset.keymap!);
const scrim = () => document.querySelector(".keymap-scrim");

function key(type: "keydown" | "keyup", init: KeyboardEventInit) {
  form().dispatchEvent(new KeyboardEvent(type, { bubbles: true, ...init }));
}

/** Hold the primary modifier past the arming delay. */
async function holdModifier() {
  key("keydown", { key: "Control", code: "ControlLeft", ctrlKey: true });
  await vi.waitFor(() => expect(scrim()).toBeTruthy(), { timeout: HOLD_MS + 1500 });
}

describe("idle state", () => {
  it("costs exactly one line of chrome and shows no keycaps", async () => {
    render(NewTask, { props: { onsubmit: vi.fn(), initialRepoPath: repo.path } });
    await vi.waitFor(() => expect(form()).toBeTruthy());

    expect(scrim()).toBeNull();
    expect(caps()).toHaveLength(0);
    expect(document.body.textContent).toContain(m.keymap_footer_idle({ mod: "Ctrl" }));
  });

  it("drops the old prompt syntax hint entirely", async () => {
    // "# issue · / command · ⌘V image" is replaced by the keycaps, not moved.
    render(NewTask, { props: { onsubmit: vi.fn(), initialRepoPath: repo.path } });
    await vi.waitFor(() => expect(form()).toBeTruthy());
    expect(document.querySelector(".syntax-hint")).toBeNull();
  });
});

describe("hold to reveal", () => {
  it("shows the scrim and keycaps once the modifier is held", async () => {
    render(NewTask, { props: { onsubmit: vi.fn(), initialRepoPath: repo.path } });
    await vi.waitFor(() => expect(form()).toBeTruthy());

    await holdModifier();
    expect(caps().length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain(m.keymap_footer_held({ mod: "Ctrl" }));
  });

  it("stays silent when the combination completes inside the delay", async () => {
    render(NewTask, { props: { onsubmit: vi.fn(), initialRepoPath: repo.path } });
    await vi.waitFor(() => expect(form()).toBeTruthy());

    key("keydown", { key: "Control", code: "ControlLeft", ctrlKey: true });
    key("keydown", { key: "g", code: "KeyG", ctrlKey: true });
    await new Promise((r) => setTimeout(r, HOLD_MS + 120));
    expect(scrim()).toBeNull();
    expect(caps()).toHaveLength(0);
  });

  for (const [name, dismiss] of [
    ["keyup of the modifier", () => key("keyup", { key: "Control", code: "ControlLeft" })],
    ["window blur", () => window.dispatchEvent(new Event("blur"))],
    [
      "a pointer press",
      () => window.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })),
    ],
    ["Escape", () => key("keydown", { key: "Escape", code: "Escape", ctrlKey: true })],
  ] as const) {
    it(`hides again on ${name}`, async () => {
      render(NewTask, { props: { onsubmit: vi.fn(), initialRepoPath: repo.path } });
      await vi.waitFor(() => expect(form()).toBeTruthy());
      await holdModifier();

      dismiss();
      await vi.waitFor(() => expect(scrim()).toBeNull());
    });
  }
});

describe("registry ↔ DOM", () => {
  it("renders no keycap that isn't a registry row with an anchor", async () => {
    render(NewTask, { props: { onsubmit: vi.fn(), initialRepoPath: repo.path } });
    await vi.waitFor(() => expect(form()).toBeTruthy());
    await holdModifier();

    const anchored = new Set(NEW_TASK_KEYMAP.filter((e) => e.anchor !== null).map((e) => e.id));
    for (const id of capIds()) {
      expect(anchored.has(id), `keycap "${id}" has no anchored registry row`).toBe(true);
    }
  });

  it("renders each keycap exactly once", async () => {
    render(NewTask, { props: { onsubmit: vi.fn(), initialRepoPath: repo.path } });
    await vi.waitFor(() => expect(form()).toBeTruthy());
    await holdModifier();

    const ids = capIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("renders every anchored row this fixture can show", async () => {
    render(NewTask, { props: { onsubmit: vi.fn(), initialRepoPath: repo.path } });
    await vi.waitFor(() => expect(form()).toBeTruthy());
    await vi.waitFor(() => expect(document.querySelector(".issue-list-row")).toBeTruthy());
    await holdModifier();

    const ids = new Set(capIds());
    // Every anchor except the mic, which only mounts where the browser can
    // dictate — headless chromium generally cannot.
    for (const id of [
      "close",
      "submit",
      "focus-prompt",
      "issue-token",
      "command-token",
      "paste-image",
      "attach",
      "repo",
      "branch",
      "issue-filter",
      "sources-tab",
      "list-nav",
      "mode-code",
      "mode-research",
      "mode-epic",
      "engine",
      "model",
      "plan-gate",
      "autopilot",
    ]) {
      expect(ids.has(id), `no keycap rendered for "${id}"`).toBe(true);
    }
  });

  it("mutes an unavailable action's keycap instead of dropping it", async () => {
    // No prompt and no issue → ⌘↵ cannot fire, but users must still learn it.
    render(NewTask, { props: { onsubmit: vi.fn(), initialRepoPath: repo.path } });
    await vi.waitFor(() => expect(form()).toBeTruthy());
    await holdModifier();

    const submitCap = document.querySelector<HTMLElement>('[data-keymap="submit"]')!;
    expect(submitCap).toBeTruthy();
    expect(submitCap.classList.contains("muted")).toBe(true);
  });
});

describe("aria-keyshortcuts", () => {
  it("exposes each registered control's shortcut to assistive tech", async () => {
    render(NewTask, { props: { onsubmit: vi.fn(), initialRepoPath: repo.path } });
    await vi.waitFor(() => expect(form()).toBeTruthy());
    await vi.waitFor(() => expect(document.querySelector("#nt-model")).toBeTruthy());

    // Present WITHOUT holding: the keycaps are decoration, this is the semantics.
    expect(document.querySelector(".run")?.getAttribute("aria-keyshortcuts")).toBe("Control+Enter");
    expect(document.querySelector(".x")?.getAttribute("aria-keyshortcuts")).toBe("Escape");
    expect(document.querySelector("#nt-agent-provider")?.getAttribute("aria-keyshortcuts")).toBe(
      "Control+E",
    );
    expect(document.querySelector("#nt-model")?.getAttribute("aria-keyshortcuts")).toBe("Alt+M");
    expect(document.querySelector("#nt-base")?.getAttribute("aria-keyshortcuts")).toBe("Alt+B");
    const modes = Array.from(document.querySelectorAll(".seg-btn")).map((el) =>
      el.getAttribute("aria-keyshortcuts"),
    );
    expect(modes).toEqual(["Alt+1", "Alt+2", "Alt+3"]);
  });

  it("covers every anchored control, not just the ones carrying a chord", async () => {
    // Regression guard: keycaps are decoration, so a control that shows one but
    // exposes no aria-keyshortcuts is invisible to assistive tech.
    render(NewTask, { props: { onsubmit: vi.fn(), initialRepoPath: repo.path } });
    await vi.waitFor(() => expect(document.querySelector(".issue-list-row")).toBeTruthy());

    const anchors: Record<string, string> = {
      "focus-prompt": "#nt-prompt",
      attach: ".tool-btn",
      repo: ".rs-trigger",
      "issue-filter": ".filter-chip",
      "sources-tab": ".tab",
      "list-nav": ".issue-list-row.is-interactive",
    };
    for (const [id, selector] of Object.entries(anchors)) {
      const el = document.querySelector(selector);
      expect(el, `${id}: nothing matched ${selector}`).toBeTruthy();
      expect(el!.getAttribute("aria-keyshortcuts"), `${id} exposes no shortcut`).toBeTruthy();
    }
    // The guard switches are named through InstrumentToggle's own prop.
    const switches = Array.from(document.querySelectorAll('button[role="switch"]'));
    expect(switches.length).toBeGreaterThanOrEqual(2);
    for (const sw of switches) expect(sw.getAttribute("aria-keyshortcuts")).toBeTruthy();
  });

  it("announces the prompt's #, / and paste keys on the textarea", async () => {
    // Regression: those three rows anchor to the PROMPT label row, which is a
    // <label> — decoration only. Their keycaps are aria-hidden, so before this
    // the keys existed for sighted mouse-free users and nobody else. The prompt
    // is the control they all act on, and aria-keyshortcuts takes a list.
    render(NewTask, { props: { onsubmit: vi.fn(), initialRepoPath: repo.path } });
    await vi.waitFor(() => expect(document.querySelector("#nt-prompt")).toBeTruthy());

    const keys = (document.querySelector("#nt-prompt")!.getAttribute("aria-keyshortcuts") ?? "")
      .split(" ")
      .filter(Boolean);
    expect(keys).toContain("#");
    expect(keys).toContain("/");
    // Accepts either spelling: the primary modifier is Meta on macOS and
    // Control elsewhere, and this suite runs on whatever the runner reports.
    expect(
      keys.some((k) => /^(Meta|Control)\+V$/.test(k)),
      keys.join(" "),
    ).toBe(true);
    expect(
      keys.some((k) => /^(Meta|Control)\+P$/.test(k)),
      keys.join(" "),
    ).toBe(true);
    // No duplicates — the attribute is a set, not a concatenation.
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("carries ⌘↵ on the dual CTA too, cap and all", async () => {
    // Regression: the dual CTA is a whole separate branch of the submit button,
    // and it had neither the cap nor aria-keyshortcuts — so in the one state
    // where the button is ambiguous, the key that resolves it was invisible.
    render(NewTask, {
      props: { onsubmit: vi.fn(), initialRepoPath: repo.path, holdLikely: true },
    });
    await vi.waitFor(() => expect(document.querySelector(".run-dual")).toBeTruthy());

    const hold = document.querySelector<HTMLElement>(".run-hold")!;
    // Same spelling the ordinary CTA gets — both come from the `submit` row.
    expect(hold.getAttribute("aria-keyshortcuts") ?? "").toMatch(/^(Meta|Control)\+Enter$/);
    // "Submit anyway" forces past the hold; ⌘↵ does not, so it must NOT claim it.
    expect(
      document.querySelector(".run-anyway")?.getAttribute("aria-keyshortcuts") ?? null,
    ).toBeNull();

    await holdModifier();
    expect(hold.querySelector('[data-keymap="submit"]'), "no cap on the dual CTA").toBeTruthy();
    // …and still exactly one submit cap in the dialog, not one per branch.
    expect(document.querySelectorAll('[data-keymap="submit"]')).toHaveLength(1);
  });

  it("names arrow navigation with ARIA key names, not the ↑↓ glyph", async () => {
    render(NewTask, { props: { onsubmit: vi.fn(), initialRepoPath: repo.path } });
    await vi.waitFor(() => expect(document.querySelector(".issue-list-row")).toBeTruthy());
    const row = document.querySelector(".issue-list-row.is-interactive")!;
    expect(row.getAttribute("aria-keyshortcuts")).toBe("ArrowUp ArrowDown");
  });

  it("keeps the scrim and every keycap out of the accessibility tree", async () => {
    render(NewTask, { props: { onsubmit: vi.fn(), initialRepoPath: repo.path } });
    await vi.waitFor(() => expect(form()).toBeTruthy());
    await holdModifier();

    expect(scrim()?.getAttribute("aria-hidden")).toBe("true");
    for (const cap of caps()) expect(cap.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("key sheet (?)", () => {
  const sheet = () => document.querySelector<HTMLElement>(".ks");

  it("lists every registry row, grouped by zone", async () => {
    render(NewTask, { props: { onsubmit: vi.fn(), initialRepoPath: repo.path } });
    await vi.waitFor(() => expect(form()).toBeTruthy());

    // Focus outside a text field, then press `?`.
    document.querySelector<HTMLElement>(".run")?.focus();
    form().dispatchEvent(
      new KeyboardEvent("keydown", { key: "?", code: "Slash", shiftKey: true, bubbles: true }),
    );
    await vi.waitFor(() => expect(sheet()).toBeTruthy());

    const rows = sheet()!.querySelectorAll(".ks-row");
    expect(rows).toHaveLength(NEW_TASK_KEYMAP.length);
    for (const entry of NEW_TASK_KEYMAP) {
      expect(sheet()!.textContent, `"${entry.id}" missing from the card`).toContain(entry.label());
    }
    for (const zone of ["keymap_zone_global", "keymap_zone_prompt"] as const) {
      expect(sheet()!.textContent).toContain(m[zone]());
    }
  });

  it("carries the canonical blocking backdrop", async () => {
    render(NewTask, { props: { onsubmit: vi.fn(), initialRepoPath: repo.path } });
    await vi.waitFor(() => expect(form()).toBeTruthy());
    document.querySelector<HTMLElement>(".run")?.focus();
    form().dispatchEvent(
      new KeyboardEvent("keydown", { key: "?", code: "Slash", shiftKey: true, bubbles: true }),
    );
    await vi.waitFor(() => expect(sheet()).toBeTruthy());

    expect(document.querySelector(".ks-scrim")).toBeTruthy();
    expect(sheet()!.getAttribute("aria-modal")).toBe("true");
    expect(sheet()!.getAttribute("role")).toBe("dialog");
  });

  it("dims ⌘F and ↑↓ in the card once the side list shows Commands", async () => {
    // Regression: enablement rode on "the side panel is mounted", which stays
    // true across a tab flip. On the Commands tab the filter chip and the issue
    // rows are not rendered, so ⌘F and ↑↓ were still listed as available, were
    // still swallowed from the browser (suppressing native Find), and then ran
    // against an undefined target — a key advertised as live that does nothing.
    render(NewTask, { props: { onsubmit: vi.fn(), initialRepoPath: repo.path } });
    await vi.waitFor(() => expect(document.querySelector(".issue-list-row")).toBeTruthy());

    const openSheet = async () => {
      form().dispatchEvent(
        new KeyboardEvent("keydown", { key: "?", code: "Slash", shiftKey: true, bubbles: true }),
      );
      await vi.waitFor(() => expect(sheet()).toBeTruthy());
    };
    const rowFor = (label: string) =>
      Array.from(sheet()!.querySelectorAll<HTMLElement>(".ks-row")).find((r) =>
        r.textContent?.includes(label),
      );

    await openSheet();
    expect(rowFor(m.keymap_issue_filter())?.classList.contains("dim"), "⌘F on Issues").toBe(false);
    expect(rowFor(m.keymap_list_nav())?.classList.contains("dim"), "↑↓ on Issues").toBe(false);

    sheet()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.waitFor(() => expect(sheet()).toBeNull());

    const commandsTab = Array.from(document.querySelectorAll<HTMLElement>(".tab")).find(
      (t) => t.textContent?.trim() === m.promptsources_commands_tab(),
    );
    expect(commandsTab, "no Commands tab rendered").toBeTruthy();
    commandsTab!.click();
    await vi.waitFor(() => expect(document.querySelector(".issue-list-row")).toBeNull());

    await openSheet();
    expect(rowFor(m.keymap_issue_filter())?.classList.contains("dim"), "⌘F on Commands").toBe(true);
    expect(rowFor(m.keymap_list_nav())?.classList.contains("dim"), "↑↓ on Commands").toBe(true);
    // The tab switch itself still acts, so it must stay live.
    expect(rowFor(m.keymap_sources_tab())?.classList.contains("dim"), "⌥T").toBe(false);
  });

  it("does not open when `?` is typed into the prompt", async () => {
    // In a text field `?` is text, not a command.
    render(NewTask, { props: { onsubmit: vi.fn(), initialRepoPath: repo.path } });
    await vi.waitFor(() => expect(form()).toBeTruthy());

    const prompt = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
    prompt.focus();
    prompt.dispatchEvent(
      new KeyboardEvent("keydown", { key: "?", code: "Slash", shiftKey: true, bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 60));
    expect(sheet()).toBeNull();
  });

  it("does not open when `?` is typed into the prompt while the reveal is up", async () => {
    // The spec makes the text-field rule absolute: `?` opens the card only when
    // focus is NOT in a text/textarea field (README → "Textfelder"). There is no
    // held exception — in a text field `?` is a character, overlay or not.
    render(NewTask, { props: { onsubmit: vi.fn(), initialRepoPath: repo.path } });
    await vi.waitFor(() => expect(form()).toBeTruthy());
    await holdModifier();

    const prompt = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
    prompt.focus();
    // The modifier is released first: `?` is Shift+/, and a `?` still carrying
    // the primary modifier is a different chord entirely.
    key("keyup", { key: "Control", code: "ControlLeft" });
    prompt.dispatchEvent(
      new KeyboardEvent("keydown", { key: "?", code: "Slash", shiftKey: true, bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 60));
    expect(sheet()).toBeNull();

    // And with the modifier still down, which is the other half of "while the
    // reveal is up": Ctrl+? is not the `?` chord at all, so it must not open
    // the card either — nor leave the overlay claiming it would.
    await holdModifier();
    prompt.focus();
    prompt.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "?",
        code: "Slash",
        shiftKey: true,
        ctrlKey: true,
        bubbles: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 60));
    expect(sheet()).toBeNull();
  });

  it("closes on Escape", async () => {
    render(NewTask, { props: { onsubmit: vi.fn(), initialRepoPath: repo.path } });
    await vi.waitFor(() => expect(form()).toBeTruthy());
    document.querySelector<HTMLElement>(".run")?.focus();
    form().dispatchEvent(
      new KeyboardEvent("keydown", { key: "?", code: "Slash", shiftKey: true, bubbles: true }),
    );
    await vi.waitFor(() => expect(sheet()).toBeTruthy());

    sheet()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.waitFor(() => expect(sheet()).toBeNull());
  });
});

describe("shortcuts that reach the side list", () => {
  it("⌥T flips between Issues and Commands", async () => {
    render(NewTask, { props: { onsubmit: vi.fn(), initialRepoPath: repo.path } });
    await vi.waitFor(() => expect(document.querySelector(".ps-head")).toBeTruthy());

    const activeTab = () => document.querySelector<HTMLElement>(".tab.active")?.textContent?.trim();
    expect(activeTab()).toBe(m.promptsources_issues_tab());

    key("keydown", { key: "t", code: "KeyT", altKey: true });
    await vi.waitFor(() => expect(activeTab()).toBe(m.promptsources_commands_tab()));
  });

  it("↑↓ walk the issue rows and wrap at both ends", async () => {
    // Navigation that did not exist before this feature — the ↑↓ keycap on the
    // first row would otherwise promise something the list could not do.
    render(NewTask, { props: { onsubmit: vi.fn(), initialRepoPath: repo.path } });
    await vi.waitFor(() => expect(document.querySelector(".issue-list-row")).toBeTruthy());

    const rows = () =>
      Array.from(document.querySelectorAll<HTMLElement>(".issue-list-row.is-interactive"));
    const focusedIndex = () => rows().indexOf(document.activeElement as HTMLElement);

    rows()[0]!.focus();
    expect(focusedIndex()).toBe(0);

    const arrow = (k: "ArrowDown" | "ArrowUp") =>
      (document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", { key: k, bubbles: true }),
      );

    arrow("ArrowDown");
    await vi.waitFor(() => expect(focusedIndex()).toBe(1));
    arrow("ArrowUp");
    await vi.waitFor(() => expect(focusedIndex()).toBe(0));
    // wrap backwards from the first row to the last
    arrow("ArrowUp");
    await vi.waitFor(() => expect(focusedIndex()).toBe(rows().length - 1));
  });
});

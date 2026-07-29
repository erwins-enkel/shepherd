import { describe, expect, it, vi } from "vitest";
import { chordLabel } from "./chord";
import { allChords, matchKeymap, NEW_TASK_KEYMAP, keymapByZone, keymapEntry } from "./newTask";
import type { NewTaskKeymapCtx } from "./types";

/** A ctx where every flag is permissive and every action is a spy. */
function stubCtx(overrides: Partial<NewTaskKeymapCtx> = {}): NewTaskKeymapCtx {
  return {
    isMac: true,
    canSubmit: true,
    desktop: true,
    modeLocked: false,
    sourcesMounted: true,
    issueListReady: true,
    micAvailable: true,
    uploading: false,
    submit: vi.fn(),
    close: vi.fn(),
    openSheet: vi.fn(),
    focusPrompt: vi.fn(),
    insertToken: vi.fn(),
    attach: vi.fn(),
    dictate: vi.fn(),
    openRepoPicker: vi.fn(),
    cycleRepo: vi.fn(),
    focusBranch: vi.fn(),
    openIssueFilter: vi.fn(),
    toggleSourcesTab: vi.fn(),
    focusIssueList: vi.fn(),
    setMode: vi.fn(),
    focusEngine: vi.fn(),
    focusModel: vi.fn(),
    togglePlanGate: vi.fn(),
    toggleAutopilot: vi.fn(),
    ...overrides,
  };
}

function ev(init: { code?: string; key?: string } & Partial<KeyboardEvent>): KeyboardEvent {
  return {
    code: "",
    key: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  } as KeyboardEvent;
}

describe("registry shape", () => {
  it("has unique ids", () => {
    const ids = NEW_TASK_KEYMAP.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never binds the same chord twice", () => {
    // A duplicate would make dispatch order-dependent and silently shadow a row.
    const seen = new Map<string, string>();
    for (const { id, chord } of allChords()) {
      const sig = [chord.code ?? `key:${chord.key}`, chord.mod, chord.alt, chord.shift].join("|");
      expect(seen.has(sig), `${sig} bound by both ${seen.get(sig)} and ${id}`).toBe(false);
      seen.set(sig, id);
    }
  });

  it("gives every row a renderable key label on both platforms", () => {
    for (const entry of NEW_TASK_KEYMAP) {
      for (const isMac of [true, false]) {
        const label =
          entry.literal?.(isMac) ?? entry.chords.map((c) => chordLabel(c, isMac)).join(" ");
        expect(label.length, `${entry.id} has no key label`).toBeGreaterThan(0);
      }
    }
  });

  it("gives every row a non-empty description", () => {
    for (const entry of NEW_TASK_KEYMAP) {
      expect(entry.label().length, `${entry.id} has no description`).toBeGreaterThan(0);
    }
  });

  it("sorts every row into exactly one zone, and every zone is populated", () => {
    const grouped = keymapByZone();
    expect(grouped.flatMap((g) => g.entries)).toHaveLength(NEW_TASK_KEYMAP.length);
    for (const g of grouped) expect(g.entries.length, `zone ${g.zone} is empty`).toBeGreaterThan(0);
  });

  it("avoids the two chords browsers refuse to hand over", () => {
    // ⌘M is macOS "minimize window" and ⌘⇧A is Chrome's tab search — window and
    // tab level actions the page cannot preventDefault, so a keycap promising
    // them would lie. See IMPLEMENTATION-PLAN.md deviation 2.
    for (const { id, chord } of allChords()) {
      expect(!!chord.mod && chord.code === "KeyM", `${id} uses the unreachable ⌘M`).toBe(false);
      expect(
        !!chord.mod && !!chord.shift && chord.code === "KeyA",
        `${id} uses the unreachable ⌘⇧A`,
      ).toBe(false);
    }
  });
});

describe("matchKeymap", () => {
  it("dispatches a chord to its row", () => {
    expect(matchKeymap(ev({ key: "Enter", code: "Enter", metaKey: true }), true)?.id).toBe(
      "submit",
    );
    // Numeric-keypad Enter reports code "NumpadEnter" — matching on `key` is
    // what keeps it working.
    expect(matchKeymap(ev({ key: "Enter", code: "NumpadEnter", metaKey: true }), true)?.id).toBe(
      "submit",
    );
    // ...but ⇧⌘↵ is a different chord and must not submit.
    expect(
      matchKeymap(ev({ key: "Enter", code: "Enter", metaKey: true, shiftKey: true }), true),
    ).toBeNull();
    expect(matchKeymap(ev({ code: "KeyR", altKey: true }), true)?.id).toBe("repo");
    expect(matchKeymap(ev({ code: "Digit2", altKey: true }), true)?.id).toBe("mode-research");
    expect(matchKeymap(ev({ code: "Minus", key: "?", shiftKey: true }), true)?.id).toBe("sheet");
  });

  it("leaves keys it only documents to their real owner", () => {
    // ⌘V must reach the browser's paste; Escape must reach use:dialog.
    expect(matchKeymap(ev({ code: "KeyV", metaKey: true }), true)).toBeNull();
    expect(matchKeymap(ev({ key: "Escape", code: "Escape" }), true)).toBeNull();
  });

  it("returns nothing for an unbound key", () => {
    expect(matchKeymap(ev({ code: "KeyZ", metaKey: true }), true)).toBeNull();
  });

  it("still matches a disabled row, so the caller can swallow the chord", () => {
    // A disabled ⌘G must not fall through to the browser's "find again".
    const entry = matchKeymap(ev({ code: "KeyG", metaKey: true }), true);
    expect(entry?.id).toBe("plan-gate");
    expect(entry?.enabled(stubCtx({ modeLocked: true }))).toBe(false);
  });
});

describe("run", () => {
  it("routes each row to its own action", () => {
    const ctx = stubCtx();
    keymapEntry("submit").run?.(ctx);
    keymapEntry("plan-gate").run?.(ctx);
    keymapEntry("mode-epic").run?.(ctx);
    keymapEntry("repo-prev").run?.(ctx);
    keymapEntry("issue-token").run?.(ctx);
    expect(ctx.submit).toHaveBeenCalledOnce();
    expect(ctx.togglePlanGate).toHaveBeenCalledOnce();
    expect(ctx.setMode).toHaveBeenCalledWith("epic");
    expect(ctx.cycleRepo).toHaveBeenCalledWith(-1);
    expect(ctx.insertToken).toHaveBeenCalledWith("#");
  });
});

describe("enabled", () => {
  it("dims submit until the form is ready", () => {
    expect(keymapEntry("submit").enabled(stubCtx({ canSubmit: false }))).toBe(false);
    expect(keymapEntry("submit").enabled(stubCtx({ canSubmit: true }))).toBe(true);
  });

  it("dims the guards while research/epic mode locks them", () => {
    for (const id of ["plan-gate", "autopilot"]) {
      expect(keymapEntry(id).enabled(stubCtx({ modeLocked: true }))).toBe(false);
      expect(keymapEntry(id).enabled(stubCtx({ modeLocked: false }))).toBe(true);
    }
  });

  it("dims the side-list rows when the list is absent", () => {
    const gone = stubCtx({ sourcesMounted: false, issueListReady: false });
    for (const id of ["issue-filter", "sources-tab", "list-nav", "list-pick"]) {
      expect(keymapEntry(id).enabled(gone), `${id} should be disabled`).toBe(false);
    }
  });

  it("dims the rail rows on the mobile layout, where the rail is not mounted", () => {
    const phone = stubCtx({ desktop: false });
    for (const id of ["engine", "model", "plan-gate", "autopilot", "branch"]) {
      expect(keymapEntry(id).enabled(phone), `${id} should be disabled`).toBe(false);
    }
    // Rows whose anchor exists on both layouts stay live.
    expect(keymapEntry("submit").enabled(phone)).toBe(true);
    expect(keymapEntry("repo").enabled(phone)).toBe(true);
  });

  it("dims attach while an upload is in flight and dictation without a mic", () => {
    expect(keymapEntry("attach").enabled(stubCtx({ uploading: true }))).toBe(false);
    expect(keymapEntry("dictate").enabled(stubCtx({ micAvailable: false }))).toBe(false);
  });
});

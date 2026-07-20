import { describe, expect, it } from "bun:test";
import type { BlockReason } from "./blocked";
import type { HoldCode } from "./types";
import { blockReasonToHoldCode, renderHold } from "./hold";

// ── helpers ──────────────────────────────────────────────────────────────────

function block(shape: BlockReason["shape"], quotaKind?: BlockReason["quotaKind"]): BlockReason {
  return { shape, options: [], tail: [], quotaKind };
}

// ── parity test — byte-identical to push.ts NOTIFY_TEXT ──────────────────────
// These expected strings are copied verbatim from src/push.ts NOTIFY_TEXT.
// They must NOT be imported from blockSummary — that's the pin the parity test provides.

describe("push parity — EN", () => {
  it("menu", () => {
    const r = block("menu");
    expect(renderHold({ code: blockReasonToHoldCode(r), params: {} }, "en")).toBe(
      "Waiting on a menu choice.",
    );
  });

  it("yes-no", () => {
    const r = block("yes-no");
    expect(renderHold({ code: blockReasonToHoldCode(r), params: {} }, "en")).toBe(
      "Waiting on a yes/no.",
    );
  });

  it("awaiting-input", () => {
    const r = block("awaiting-input");
    expect(renderHold({ code: blockReasonToHoldCode(r), params: {} }, "en")).toBe(
      "Waiting on your input.",
    );
  });

  it("stall", () => {
    const r = block("stall");
    expect(renderHold({ code: blockReasonToHoldCode(r), params: {} }, "en")).toBe(
      "Quiet — no recent activity; may be stuck.",
    );
  });

  it("quota rework", () => {
    const r = block("quota", "rework");
    expect(renderHold({ code: blockReasonToHoldCode(r), params: {} }, "en")).toBe(
      "Auto-fix hit its limit — open findings still need you.",
    );
  });

  it("quota review", () => {
    const r = block("quota", "review");
    expect(renderHold({ code: blockReasonToHoldCode(r), params: {} }, "en")).toBe(
      "Critic keeps finding issues — auto-review paused.",
    );
  });

  it("quota error", () => {
    const r = block("quota", "error");
    expect(renderHold({ code: blockReasonToHoldCode(r), params: {} }, "en")).toBe(
      "Critic can't review this PR — needs you.",
    );
  });

  it("quota plan", () => {
    const r = block("quota", "plan");
    expect(renderHold({ code: blockReasonToHoldCode(r), params: {} }, "en")).toBe(
      "Plan review stuck — keeps requesting changes.",
    );
  });

  it("quota undefined quotaKind → other", () => {
    const r = block("quota", undefined);
    expect(renderHold({ code: blockReasonToHoldCode(r), params: {} }, "en")).toBe(
      "Waiting on your input.",
    );
  });
});

describe("push parity — DE", () => {
  it("menu", () => {
    const r = block("menu");
    expect(renderHold({ code: blockReasonToHoldCode(r), params: {} }, "de")).toBe(
      "Wartet auf eine Menüauswahl.",
    );
  });

  it("yes-no", () => {
    const r = block("yes-no");
    expect(renderHold({ code: blockReasonToHoldCode(r), params: {} }, "de")).toBe(
      "Wartet auf ein Ja/Nein.",
    );
  });

  it("awaiting-input", () => {
    const r = block("awaiting-input");
    expect(renderHold({ code: blockReasonToHoldCode(r), params: {} }, "de")).toBe(
      "Wartet auf deine Eingabe.",
    );
  });

  it("stall", () => {
    const r = block("stall");
    expect(renderHold({ code: blockReasonToHoldCode(r), params: {} }, "de")).toBe(
      "Ruhig — keine Aktivität; möglicherweise hängengeblieben.",
    );
  });

  it("quota rework", () => {
    const r = block("quota", "rework");
    expect(renderHold({ code: blockReasonToHoldCode(r), params: {} }, "de")).toBe(
      "Auto-Fix am Limit — offene Punkte brauchen dich.",
    );
  });

  it("quota review", () => {
    const r = block("quota", "review");
    expect(renderHold({ code: blockReasonToHoldCode(r), params: {} }, "de")).toBe(
      "Kritiker findet weiter Probleme — Auto-Review pausiert.",
    );
  });

  it("quota error", () => {
    const r = block("quota", "error");
    expect(renderHold({ code: blockReasonToHoldCode(r), params: {} }, "de")).toBe(
      "Kritiker kann den PR nicht prüfen — braucht dich.",
    );
  });

  it("quota plan", () => {
    const r = block("quota", "plan");
    expect(renderHold({ code: blockReasonToHoldCode(r), params: {} }, "de")).toBe(
      "Plan-Review hängt — fordert weiter Änderungen.",
    );
  });

  it("quota undefined quotaKind → other", () => {
    const r = block("quota", undefined);
    expect(renderHold({ code: blockReasonToHoldCode(r), params: {} }, "de")).toBe(
      "Wartet auf deine Eingabe.",
    );
  });
});

// ── blockReasonToHoldCode mapping table ──────────────────────────────────────

describe("blockReasonToHoldCode", () => {
  it.each([
    ["menu", undefined, "blocked-menu"],
    ["yes-no", undefined, "blocked-yes-no"],
    ["awaiting-input", undefined, "blocked-awaiting-input"],
    ["stall", undefined, "blocked-stall"],
    ["quota", "rework", "quota-rework"],
    ["quota", "review", "quota-review"],
    ["quota", "error", "quota-error"],
    ["quota", "plan", "quota-plan"],
    ["quota", undefined, "blocked-generic"],
  ] as [BlockReason["shape"], BlockReason["quotaKind"] | undefined, HoldCode][])(
    "%s / quotaKind=%s → %s",
    (shape, quotaKind, expected) => {
      expect(blockReasonToHoldCode(block(shape, quotaKind))).toBe(expected);
    },
  );
});

// ── renderHold returns non-empty for every HoldCode in both locales ───────────

const ALL_CODES: HoldCode[] = [
  "halted-error",
  "halted-usage",
  "autopilot-paused",
  "blocked-menu",
  "blocked-yes-no",
  "blocked-awaiting-input",
  "blocked-stall",
  "blocked-generic",
  "quota-rework",
  "quota-review",
  "quota-error",
  "quota-plan",
  "plan-rework",
  "critic-rework",
  "ci-red",
  "pr-conflict",
  "awaiting-merge",
  "train-error",
  "stalled",
  "recap-attention",
  "merging",
  "merge-rebasing",
  "ready-merge",
];

describe("renderHold — non-empty for all codes", () => {
  for (const code of ALL_CODES) {
    for (const locale of ["en", "de"]) {
      it(`${code} / ${locale}`, () => {
        const result = renderHold({ code }, locale);
        expect(result.length).toBeGreaterThan(0);
      });
    }
  }
});

// ── param interpolation ───────────────────────────────────────────────────────

describe("param interpolation", () => {
  it("plan-rework with round+cap contains '3/3'", () => {
    const result = renderHold({ code: "plan-rework", params: { round: 3, cap: 3 } }, "en");
    expect(result).toContain("3/3");
  });

  it("merge-rebasing with rebaseCount contains '2'", () => {
    const result = renderHold({ code: "merge-rebasing", params: { rebaseCount: 2 } }, "en");
    expect(result).toContain("2");
  });

  it("halted-usage with resetAt contains Intl-formatted time (en)", () => {
    const resetAt = new Date("2025-01-15T14:30:00").getTime();
    const result = renderHold({ code: "halted-usage", params: { resetAt } }, "en");
    // The formatted time in en-US for 2:30pm — just check it has something time-like
    const formatted = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(resetAt));
    expect(result).toContain(formatted);
  });

  it("autopilot-paused with question returns text containing the question", () => {
    const result = renderHold({ code: "autopilot-paused", params: { question: "X?" } }, "en");
    expect(result).toContain("X?");
  });

  it("halted-usage without resetAt returns non-empty string", () => {
    const result = renderHold({ code: "halted-usage" }, "en");
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toContain("undefined");
  });

  it("critic-rework with findings count", () => {
    const result = renderHold({ code: "critic-rework", params: { findings: 5 } }, "en");
    expect(result).toContain("5");
  });

  it("ci-red with pr number", () => {
    const result = renderHold({ code: "ci-red", params: { pr: 42 } }, "en");
    expect(result).toContain("42");
  });

  it("awaiting-merge with pr number", () => {
    const result = renderHold({ code: "awaiting-merge", params: { pr: 7 } }, "en");
    expect(result).toContain("7");
  });

  it("train-error with pr number", () => {
    const result = renderHold({ code: "train-error", params: { pr: 99 } }, "en");
    expect(result).toContain("99");
  });

  it("merging with pr number", () => {
    const result = renderHold({ code: "merging", params: { pr: 3 } }, "en");
    expect(result).toContain("3");
  });

  it("ready-merge with pr number", () => {
    const result = renderHold({ code: "ready-merge", params: { pr: 12 } }, "en");
    expect(result).toContain("12");
  });
});

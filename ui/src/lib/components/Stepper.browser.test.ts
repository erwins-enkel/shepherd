import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../app.css";
import type { GitState } from "$lib/types";
import { m } from "$lib/paraglide/messages";

// Stepper reads from the reviews store, which loads from $lib/api on init.
// Mock the two methods the store calls so no real network requests fire.
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return { ...actual, getReviews: vi.fn(async () => ({})), getReviewingIds: vi.fn(async () => []) };
});

// Import component + store AFTER mock is registered.
const { default: Stepper } = await import("./Stepper.svelte");
const { reviews } = await import("$lib/reviews.svelte");

beforeEach(() => {
  reviews.map = {};
  reviews.reviewing = {};
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Stepper planning-skipped swatch", () => {
  it("planning segment has skipped class when planPhase is null (gate off)", async () => {
    render(Stepper, {
      sessionId: "skipped-test-1",
      readyToMerge: false,
      planPhase: null,
    });

    const segs = document.querySelectorAll(".seg:not(.sw)");
    expect(segs.length, "five segments rendered").toBe(5);
    expect(segs[0].classList.contains("skipped"), "first segment has skipped class").toBe(true);
    expect(segs[1].classList.contains("skipped"), "second segment has no skipped class").toBe(
      false,
    );
  });

  it("planning segment has no skipped class when planPhase is 'planning'", async () => {
    render(Stepper, {
      sessionId: "skipped-test-2",
      readyToMerge: false,
      planPhase: "planning",
    });

    const segs = document.querySelectorAll(".seg:not(.sw)");
    expect(segs.length, "five segments rendered").toBe(5);
    expect(segs[0].classList.contains("skipped"), "first segment has no skipped class").toBe(false);
  });

  it("planning segment has no skipped class when planPhase is 'executing'", async () => {
    render(Stepper, {
      sessionId: "skipped-test-3",
      readyToMerge: false,
      planPhase: "executing",
    });

    const segs = document.querySelectorAll(".seg:not(.sw)");
    expect(segs.length, "five segments rendered").toBe(5);
    expect(segs[0].classList.contains("skipped"), "first segment has no skipped class").toBe(false);
  });
});

describe("Stepper aria-label contract", () => {
  it("session with open PR, failing CI, and changes-requested review verdict", async () => {
    const sessionId = "stepper-test-1";

    // Seed a changes-requested verdict for this session.
    const verdict = {
      sessionId,
      headSha: "abc123",
      decision: "changes_requested" as const,
      summary: "",
      body: "",
      findings: ["issue"],
      addressRound: 0,
      addressCap: 5,
      finalRoundPending: false,
      finalRoundTimeoutMs: 900_000,
      updatedAt: Date.now(),
    };
    reviews.map = { [sessionId]: verdict };

    const git: GitState = {
      kind: "github",
      state: "open",
      number: 42,
      url: "https://github.com/acme/repo/pull/42",
      title: "feat: a failing PR",
      mergeable: false,
      checks: "failure",
      deployConfigured: false,
    };

    render(Stepper, {
      sessionId,
      git,
      readyToMerge: false,
      planPhase: null,
    });

    // The aria-label must contain the current progress stage.
    // Stage should be "review" (verdict present + open PR).
    const progressStage = m.activity_stage_review();
    const progressLabel = m.activity_progress({ stage: progressStage });

    // CI failure word and review changes word.
    const ciWord = m.activity_ci_failure();
    const ciLabel = m.activity_ci_status({ state: ciWord });
    const reviewWord = m.activity_review_changes();
    const reviewLabel = m.activity_review_status({ state: reviewWord });

    // The bar is a <button> (activatable, focusable) — not a role=img.
    const stepper = document.querySelector("button.stepper");
    expect(stepper, "stepper button present").not.toBeNull();

    const label = stepper!.getAttribute("aria-label") ?? "";
    // Name discloses the activation target (opens the session), not only progress.
    expect(label, "aria-label discloses open-session action").toContain(m.stepper_open_hint());
    expect(label, "aria-label contains progress stage").toContain(progressLabel);
    expect(label, "aria-label contains CI failure").toContain(ciLabel);
    expect(label, "aria-label contains review changes-requested").toContain(reviewLabel);
  });
});

describe("Stepper legend tooltip", () => {
  it("opens the role=tooltip legend on keyboard focus (fine pointer)", async () => {
    render(Stepper, {
      sessionId: "legend-focus-1",
      readyToMerge: false,
      planPhase: "executing",
    });

    const stepper = document.querySelector("button.stepper") as HTMLButtonElement;
    expect(stepper, "stepper button present").not.toBeNull();
    // Legend is described-by the button and starts closed.
    const tipId = stepper.getAttribute("aria-describedby");
    expect(tipId, "button has aria-describedby").toBeTruthy();

    stepper.focus();
    await vi.waitFor(() => {
      const tip = document.getElementById(tipId!);
      expect(tip, "legend is the described element").not.toBeNull();
      expect(tip!.getAttribute("role"), "legend is a tooltip").toBe("tooltip");
      expect(tip!.matches(":popover-open"), "legend popover is open on focus").toBe(true);
    });

    // A plain-language description renders inside the open legend.
    const legend = document.getElementById(tipId!)!;
    expect(legend.textContent, "legend includes a stage description").toContain(
      m.stepper_desc_implementing(),
    );
  });
});

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

    // Find the stepper element by role.
    const stepper = document.querySelector('[role="img"]');
    expect(stepper, "stepper element present").not.toBeNull();

    const label = stepper!.getAttribute("aria-label") ?? "";
    expect(label, "aria-label contains progress stage").toContain(progressLabel);
    expect(label, "aria-label contains CI failure").toContain(ciLabel);
    expect(label, "aria-label contains review changes-requested").toContain(reviewLabel);
  });
});

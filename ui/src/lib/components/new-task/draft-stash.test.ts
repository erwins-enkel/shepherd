import { describe, it, expect, beforeEach } from "vitest";
import { DRAFT_TTL_MS, stashDraft, takeDraft, type NewTaskDraft } from "./draft-stash";

function draft(over: Partial<NewTaskDraft> = {}): NewTaskDraft {
  return {
    prompt: "Refactor the upload queue",
    repoPath: "/repo/a",
    baseBranch: "main",
    issueRef: null,
    attachedRepoPath: null,
    images: [],
    agentProvider: "claude",
    model: "auto",
    modelTouched: false,
    effort: "default",
    effortTouched: false,
    planGate: false,
    planGateTouched: false,
    autopilot: false,
    autopilotTouched: false,
    research: false,
    epicAuthoring: false,
    plain: false,
    modeTouched: false,
    designPreselected: false,
    sandboxProfile: "default",
    ...over,
  };
}

beforeEach(() => {
  takeDraft(); // drain whatever a previous test left behind
});

describe("draft stash", () => {
  it("hands a draft back inside the grace window", () => {
    const d = draft();
    stashDraft(d, 1_000);
    expect(takeDraft(1_000 + DRAFT_TTL_MS)).toBe(d);
  });

  it("drops a draft once the grace window has passed", () => {
    stashDraft(draft(), 1_000);
    expect(takeDraft(1_000 + DRAFT_TTL_MS + 1)).toBeNull();
  });

  it("hands a draft back only once", () => {
    stashDraft(draft(), 1_000);
    expect(takeDraft(1_001)).not.toBeNull();
    expect(takeDraft(1_002)).toBeNull();
  });

  it("ignores a draft with neither prompt text nor attachments", () => {
    stashDraft(draft({ prompt: "   " }), 1_000);
    expect(takeDraft(1_001)).toBeNull();
  });

  it("keeps an attachments-only draft", () => {
    const d = draft({ prompt: "", images: [{ path: "/srv/a.png", name: "a.png" }] });
    stashDraft(d, 1_000);
    expect(takeDraft(1_001)).toBe(d);
  });

  it("an empty dismissal does not clobber an earlier draft", () => {
    const d = draft();
    stashDraft(d, 1_000);
    stashDraft(draft({ prompt: "" }), 1_500);
    expect(takeDraft(1_600)).toBe(d);
  });
});

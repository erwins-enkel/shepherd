import { describe, expect, it } from "bun:test";
import { type SignoffAuthority, type SignoffView, signedOff } from "./signoff";

const HEAD = "abc123";
const OTHER_HEAD = "def456";

function view(overrides: Partial<SignoffView> = {}): SignoffView {
  return {
    humanApproved: false,
    reviewDecision: null,
    findings: [],
    reviewHeadSha: null,
    headSha: null,
    ...overrides,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

const noVerdict = view();

const humanApprovedView = view({ humanApproved: true });

const criticCleanView = view({
  reviewDecision: "commented",
  findings: [],
  reviewHeadSha: HEAD,
  headSha: HEAD,
});

const criticAdvisoryView = view({
  reviewDecision: "commented",
  findings: ["Fix the null check"],
  reviewHeadSha: HEAD,
  headSha: HEAD,
});

const criticStaleView = view({
  reviewDecision: "commented",
  findings: [],
  reviewHeadSha: OTHER_HEAD,
  headSha: HEAD,
});

const changesRequestedView = view({
  reviewDecision: "changes_requested",
  findings: ["Must fix this"],
  reviewHeadSha: HEAD,
  headSha: HEAD,
});

const errorView = view({
  reviewDecision: "error",
  findings: [],
  reviewHeadSha: HEAD,
  headSha: HEAD,
});

const nullReviewHeadView = view({
  reviewDecision: "commented",
  findings: [],
  reviewHeadSha: null,
  headSha: HEAD,
});

const nullHeadShaView = view({
  reviewDecision: "commented",
  findings: [],
  reviewHeadSha: HEAD,
  headSha: null,
});

const bothNullHeadsView = view({
  reviewDecision: "commented",
  findings: [],
  reviewHeadSha: null,
  headSha: null,
});

// ── no verdict (everything false) ────────────────────────────────────────────

describe("no verdict", () => {
  it.each(["human", "critic", "either"] as SignoffAuthority[])(
    "is NOT signed off under %s",
    (authority) => {
      expect(signedOff(authority, noVerdict)).toBe(false);
    },
  );
});

// ── human approved ───────────────────────────────────────────────────────────

describe("humanApproved=true", () => {
  it("is signed off under human", () => {
    expect(signedOff("human", humanApprovedView)).toBe(true);
  });

  it("is signed off under either", () => {
    expect(signedOff("either", humanApprovedView)).toBe(true);
  });

  it("is NOT signed off under critic", () => {
    expect(signedOff("critic", humanApprovedView)).toBe(false);
  });
});

// ── critic clean ─────────────────────────────────────────────────────────────

describe("critic clean (commented + [] + matching head)", () => {
  it("is signed off under critic", () => {
    expect(signedOff("critic", criticCleanView)).toBe(true);
  });

  it("is signed off under either", () => {
    expect(signedOff("either", criticCleanView)).toBe(true);
  });

  it("is NOT signed off under human", () => {
    expect(signedOff("human", criticCleanView)).toBe(false);
  });
});

// ── advisory commented-with-findings (the false-sign-off guard) ──────────────

describe("commented + NON-empty findings + matching head", () => {
  it.each(["human", "critic", "either"] as SignoffAuthority[])(
    "is NOT signed off under %s",
    (authority) => {
      expect(signedOff(authority, criticAdvisoryView)).toBe(false);
    },
  );
});

// ── stale head ────────────────────────────────────────────────────────────────

describe("critic stale (commented + [] but reviewHeadSha !== headSha)", () => {
  it.each(["human", "critic", "either"] as SignoffAuthority[])(
    "is NOT signed off under %s",
    (authority) => {
      expect(signedOff(authority, criticStaleView)).toBe(false);
    },
  );
});

// ── changes_requested ─────────────────────────────────────────────────────────

describe("changes_requested", () => {
  it.each(["human", "critic", "either"] as SignoffAuthority[])(
    "is NOT signed off under %s",
    (authority) => {
      expect(signedOff(authority, changesRequestedView)).toBe(false);
    },
  );
});

// ── error ─────────────────────────────────────────────────────────────────────

describe("error decision", () => {
  it.each(["human", "critic", "either"] as SignoffAuthority[])(
    "is NOT signed off under %s",
    (authority) => {
      expect(signedOff(authority, errorView)).toBe(false);
    },
  );
});

// ── null heads ────────────────────────────────────────────────────────────────

describe("null reviewHeadSha", () => {
  it.each(["human", "critic", "either"] as SignoffAuthority[])(
    "is NOT signed off under %s",
    (authority) => {
      expect(signedOff(authority, nullReviewHeadView)).toBe(false);
    },
  );
});

describe("null headSha", () => {
  it.each(["human", "critic", "either"] as SignoffAuthority[])(
    "is NOT signed off under %s",
    (authority) => {
      expect(signedOff(authority, nullHeadShaView)).toBe(false);
    },
  );
});

describe("both heads null", () => {
  it.each(["human", "critic", "either"] as SignoffAuthority[])(
    "is NOT signed off under %s",
    (authority) => {
      expect(signedOff(authority, bothNullHeadsView)).toBe(false);
    },
  );
});

// ── both signals true (either) ────────────────────────────────────────────────

describe("both human approved AND critic clean", () => {
  const bothView = view({
    humanApproved: true,
    reviewDecision: "commented",
    findings: [],
    reviewHeadSha: HEAD,
    headSha: HEAD,
  });
  it.each(["human", "critic", "either"] as SignoffAuthority[])(
    "is signed off under %s",
    (authority) => {
      expect(signedOff(authority, bothView)).toBe(true);
    },
  );
});

// ── no "approved" special path ────────────────────────────────────────────────

describe("no approved decision special-casing", () => {
  it("a view with reviewDecision cast to approved is NOT signed off", () => {
    // ReviewDecision has no "approved" value — assert no path treats it as sign-off
    const bogusView = view({
      reviewDecision: "approved" as never,
      findings: [],
      reviewHeadSha: HEAD,
      headSha: HEAD,
    });
    expect(signedOff("critic", bogusView)).toBe(false);
    expect(signedOff("either", bogusView)).toBe(false);
    expect(signedOff("human", bogusView)).toBe(false);
  });
});

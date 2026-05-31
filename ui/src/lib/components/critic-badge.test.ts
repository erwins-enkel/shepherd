import { describe, it, expect } from "vitest";
import { criticBadgeLabel } from "./critic-badge";
import type { ReviewVerdict } from "../types";

const v = (decision: ReviewVerdict["decision"]): ReviewVerdict => ({
  sessionId: "s",
  headSha: "h",
  decision,
  summary: "",
  body: "",
  updatedAt: 0,
});

describe("criticBadgeLabel", () => {
  it("returns null when there is no verdict", () => expect(criticBadgeLabel(undefined)).toBeNull());
  it("maps changes_requested", () =>
    expect(criticBadgeLabel(v("changes_requested"))).not.toBeNull());
  it("maps commented", () => expect(criticBadgeLabel(v("commented"))).not.toBeNull());
  it("maps error", () => expect(criticBadgeLabel(v("error"))).not.toBeNull());
});

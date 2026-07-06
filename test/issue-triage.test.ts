import { describe, expect, it } from "bun:test";
import {
  assembleComment,
  gateBody,
  mapCategoryToLabels,
  parseModelJson,
  sanitizeComment,
  validateDecision,
  type ValidatedDecision,
} from "../scripts/issue-triage";

// These tests exercise only the pure, network-free logic. No Anthropic API call
// is ever made — the classify()/fetch path is deliberately not imported here.

describe("gateBody", () => {
  it("rejects empty and too-short bodies before any paid call", () => {
    expect(gateBody("").ok).toBe(false);
    expect(gateBody("   \n  ").ok).toBe(false);
    expect(gateBody("too short").ok).toBe(false);
    expect(gateBody("too short").reason).toBe("body-too-short");
  });

  it("accepts a body at/over the minimum length", () => {
    expect(gateBody("x".repeat(30)).ok).toBe(true);
    expect(gateBody("This is a perfectly reasonable bug report body.").ok).toBe(true);
  });
});

describe("parseModelJson", () => {
  it("parses a bare JSON object", () => {
    expect(parseModelJson('{"category":"bug"}')).toEqual({ category: "bug" });
  });

  it("strips a ```json fence", () => {
    const raw = '```json\n{"category":"question"}\n```';
    expect(parseModelJson(raw)).toEqual({ category: "question" });
  });

  it("returns null on malformed JSON (no repair)", () => {
    expect(parseModelJson("not json at all")).toBeNull();
    expect(parseModelJson('{"category": "bug"')).toBeNull();
  });

  it("extracts the object from prose-wrapped output", () => {
    const raw = 'Sure! Here is the classification:\n{"category":"feature"}\nHope that helps.';
    expect(parseModelJson(raw)).toEqual({ category: "feature" });
  });
});

describe("validateDecision", () => {
  const base = {
    category: "bug",
    labels: ["bug"],
    reply_markdown: "Thanks for the report.",
    confidence: 0.9,
    language: "en",
  };

  it("accepts a well-formed decision", () => {
    const v = validateDecision(base);
    expect(v).not.toBeNull();
    expect(v?.category).toBe("bug");
    expect(v?.confidence).toBe(0.9);
    expect(v?.language).toBe("en");
  });

  it("no-ops (null) on an unknown category", () => {
    expect(validateDecision({ ...base, category: "wontfix" })).toBeNull();
  });

  it("classifies a feature (whose label 'enhancement' differs from the category name)", () => {
    // Regression: previously a model `labels: ["feature"]` failed the allowlist
    // gate and dropped every feature request. The labels field is now ignored.
    expect(validateDecision({ ...base, category: "feature", labels: ["feature"] })?.category).toBe(
      "feature",
    );
  });

  it("ignores any labels field the model emits (category is authoritative)", () => {
    expect(validateDecision({ ...base, labels: ["anything", "at:all"] })?.category).toBe("bug");
    expect(validateDecision({ ...base, labels: "not-an-array" })?.category).toBe("bug");
  });

  it("no-ops (null) on non-object / null input", () => {
    expect(validateDecision(null)).toBeNull();
    expect(validateDecision("bug")).toBeNull();
    expect(validateDecision(42)).toBeNull();
  });

  it("defaults confidence to 0 when missing or non-numeric, and clamps to [0,1]", () => {
    expect(validateDecision({ ...base, confidence: undefined })?.confidence).toBe(0);
    expect(validateDecision({ ...base, confidence: "high" })?.confidence).toBe(0);
    expect(validateDecision({ ...base, confidence: 5 })?.confidence).toBe(1);
    expect(validateDecision({ ...base, confidence: -2 })?.confidence).toBe(0);
  });

  it("defaults language to en unless explicitly de", () => {
    expect(validateDecision({ ...base, language: "fr" })?.language).toBe("en");
    expect(validateDecision({ ...base, language: undefined })?.language).toBe("en");
    expect(validateDecision({ ...base, language: "de" })?.language).toBe("de");
  });

  it("allows an omitted labels field (category is authoritative)", () => {
    const v = validateDecision({
      category: "question",
      reply_markdown: "",
      confidence: 0.5,
      language: "en",
    });
    expect(v?.category).toBe("question");
  });
});

describe("mapCategoryToLabels", () => {
  it("maps each category to its canonical label", () => {
    expect(mapCategoryToLabels("bug")).toEqual(["bug"]);
    expect(mapCategoryToLabels("feature")).toEqual(["enhancement"]);
    expect(mapCategoryToLabels("documentation")).toEqual(["documentation"]);
    expect(mapCategoryToLabels("question")).toEqual(["question"]);
    expect(mapCategoryToLabels("needs-info")).toEqual(["needs-info"]);
    expect(mapCategoryToLabels("invalid")).toEqual(["invalid"]);
  });
});

describe("sanitizeComment", () => {
  it("neutralizes @user and @org/team pings with a zero-width space", () => {
    const out = sanitizeComment("cc @octocat and @my-org/maintainers");
    expect(out).not.toContain("@octocat");
    expect(out).not.toContain("@my-org");
    expect(out).toContain("@​octocat");
    expect(out).toContain("@​my-org");
  });

  it("leaves plain text and email-like local parts' leading @ handled but content intact", () => {
    expect(sanitizeComment("no mentions here")).toBe("no mentions here");
  });
});

describe("assembleComment", () => {
  const opts = { commentOnBugFeature: true, answersEnabled: false };
  const dec = (over: Partial<ValidatedDecision>): ValidatedDecision => ({
    category: "bug",
    replyMarkdown: "reply",
    confidence: 0.9,
    language: "en",
    ...over,
  });

  it("wraps a bug reply with the 🤖 disclosure header and follow-up footer", () => {
    const { comment, shouldComment } = assembleComment(dec({ category: "bug" }), opts);
    expect(shouldComment).toBe(true);
    expect(comment).toContain("🤖");
    expect(comment).toContain("reply");
    expect(comment.toLowerCase()).toContain("maintainer");
  });

  it("goes label-only for bug/feature when the comment flag is off", () => {
    const off = { commentOnBugFeature: false, answersEnabled: false };
    expect(assembleComment(dec({ category: "bug" }), off).shouldComment).toBe(false);
    expect(assembleComment(dec({ category: "feature" }), off).shouldComment).toBe(false);
    // documentation still comments even when the bug/feature flag is off
    expect(assembleComment(dec({ category: "documentation" }), off).shouldComment).toBe(true);
  });

  it("defers questions by default even at high confidence (answers disabled)", () => {
    const { comment } = assembleComment(
      dec({ category: "question", replyMarkdown: "The answer is X.", confidence: 0.99 }),
      { commentOnBugFeature: true, answersEnabled: false },
    );
    expect(comment).not.toContain("The answer is X.");
    expect(comment).toContain("Discussions");
  });

  it("answers a confident question only when answers are enabled", () => {
    const { comment } = assembleComment(
      dec({ category: "question", replyMarkdown: "The answer is X.", confidence: 0.9 }),
      { commentOnBugFeature: true, answersEnabled: true },
    );
    expect(comment).toContain("The answer is X.");
    expect(comment.toLowerCase()).toContain("double-check");
  });

  it("still defers a low-confidence question even when answers are enabled", () => {
    const { comment } = assembleComment(
      dec({ category: "question", replyMarkdown: "Maybe X?", confidence: 0.3 }),
      { commentOnBugFeature: true, answersEnabled: true },
    );
    expect(comment).not.toContain("Maybe X?");
    expect(comment).toContain("Discussions");
  });

  it("uses German chrome when language is de", () => {
    const { comment } = assembleComment(
      dec({ category: "invalid", language: "de", replyMarkdown: "" }),
      opts,
    );
    expect(comment).toContain("Automatische Ersteinordnung");
    expect(comment).toContain("Discussions");
  });
});

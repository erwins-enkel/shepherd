import { test, expect } from "bun:test";
import { composeIssueCommentsBlock, ISSUE_COMMENTS_CHAR_BUDGET } from "../src/service";
import { GithubForge } from "../src/forge/github";
import { SHEPHERD_ISSUE_LOG_MARKER } from "../src/forge/types";
import type { IssueComment } from "../src/forge/types";

function c(over: Partial<IssueComment> = {}): IssueComment {
  return {
    author: "alice",
    authorAssociation: "MEMBER",
    body: "looks good",
    createdAt: Date.parse("2026-06-20T00:00:00Z"),
    ...over,
  };
}

// ── composeIssueCommentsBlock (pure) ──────────────────────────────────────────

test("empty / all-filtered → empty string", () => {
  expect(composeIssueCommentsBlock(7, [])).toBe("");
  // only bots + untrusted + Shepherd notes → nothing survives
  expect(
    composeIssueCommentsBlock(7, [
      c({ author: "dependabot[bot]" }),
      c({ authorAssociation: "NONE" }),
      c({ body: `⏸️ Waiting on @x to merge PR #7.` }),
    ]),
  ).toBe("");
});

test("renders trusted human comments chronologically with a header, fenced as untrusted", () => {
  const block = composeIssueCommentsBlock(42, [
    c({ author: "bob", body: "second", createdAt: Date.parse("2026-06-21T00:00:00Z") }),
    c({ author: "alice", body: "first", createdAt: Date.parse("2026-06-20T00:00:00Z") }),
  ]);
  expect(block).toContain("⟦UNTRUSTED:issue #42 comments:");
  expect(block).toContain("⟦/UNTRUSTED:issue #42 comments:");
  expect(block).toContain("GitHub Issue #42 comments:");
  expect(block).toContain("Comment by @alice (2026-06-20):\n> first");
  expect(block).toContain("Comment by @bob (2026-06-21):\n> second");
  // chronological: alice (first) precedes bob (second) inside the fence
  expect(block.indexOf("first")).toBeLessThan(block.indexOf("second"));
});

test("fences the rendered comment block as untrusted data", () => {
  const out = composeIssueCommentsBlock(7, [
    { author: "alice", authorAssociation: "OWNER", body: "please review", createdAt: 1 },
  ]);
  expect(out).toContain("⟦UNTRUSTED:issue #7 comments:");
  expect(out).toContain("please review");
  expect(out).toContain("⟦/UNTRUSTED:issue #7 comments:");
});

test("returns '' (unfenced) when no comment survives the trust filter", () => {
  expect(
    composeIssueCommentsBlock(7, [
      { author: "eve", authorAssociation: "NONE", body: "hi", createdAt: 1 },
    ]),
  ).toBe("");
});

test("blockquotes EVERY line of a multi-line body, not just the first", () => {
  const block = composeIssueCommentsBlock(1, [c({ body: "line one\nline two\nline three" })]);
  expect(block).toContain("> line one\n> line two\n> line three");
});

test("drops [bot] authors", () => {
  const block = composeIssueCommentsBlock(1, [
    c({ author: "dependabot[bot]", body: "bump dep" }),
    c({ author: "alice", body: "real" }),
  ]);
  expect(block).toContain("real");
  expect(block).not.toContain("bump dep");
});

test("scopes to repo-standing authorAssociation (drops NONE / CONTRIBUTOR)", () => {
  const block = composeIssueCommentsBlock(1, [
    c({ author: "owner", authorAssociation: "OWNER", body: "owner-says" }),
    c({ author: "collab", authorAssociation: "COLLABORATOR", body: "collab-says" }),
    c({ author: "rando", authorAssociation: "NONE", body: "rando-says" }),
    c({ author: "drive", authorAssociation: "CONTRIBUTOR", body: "drive-says" }),
  ]);
  expect(block).toContain("owner-says");
  expect(block).toContain("collab-says");
  expect(block).not.toContain("rando-says");
  expect(block).not.toContain("drive-says");
});

test("filters Shepherd's own notes via the marker (current) and wording (pre-marker)", () => {
  const block = composeIssueCommentsBlock(1, [
    c({ body: `✅ PR #7 merged.\n\n${SHEPHERD_ISSUE_LOG_MARKER}` }), // marker-tagged
    c({ body: "⏸️ Waiting on @scoop to merge PR #7." }), // pre-marker wording
    c({ body: "genuine human note" }),
  ]);
  expect(block).toContain("genuine human note");
  expect(block).not.toContain("merged");
  expect(block).not.toContain("Waiting on");
});

test("oversized thread keeps the NEWEST and names the dropped (oldest) end", () => {
  const big = "x".repeat(ISSUE_COMMENTS_CHAR_BUDGET); // each comment alone ~ the whole budget
  const comments = [
    c({ author: "a", body: `OLDEST ${big}`, createdAt: Date.parse("2026-06-20T00:00:00Z") }),
    c({ author: "b", body: `MIDDLE ${big}`, createdAt: Date.parse("2026-06-21T00:00:00Z") }),
    c({ author: "c", body: `NEWEST ${big}`, createdAt: Date.parse("2026-06-22T00:00:00Z") }),
  ];
  const block = composeIssueCommentsBlock(9, comments);
  expect(block).toContain("NEWEST");
  expect(block).not.toContain("OLDEST");
  expect(block).toContain("2 of 3 comments omitted — oldest comments dropped to fit size budget");
});

test("handles a missing author / createdAt without throwing", () => {
  const block = composeIssueCommentsBlock(1, [c({ author: "", createdAt: 0, body: "anon note" })]);
  expect(block).toContain("Comment by unknown:");
  expect(block).toContain("> anon note");
});

// ── GithubForge.listIssueComments (parse) ─────────────────────────────────────

test("listIssueComments parses gh JSON incl. authorAssociation", async () => {
  const runner = async (args: string[]) => {
    expect(args).toEqual(["issue", "view", "5", "--repo", "o/r", "--json", "comments"]);
    return JSON.stringify({
      comments: [
        {
          author: { login: "alice" },
          authorAssociation: "MEMBER",
          body: "hi",
          createdAt: "2026-06-20T10:00:00Z",
        },
        { author: null, body: "anon" }, // missing fields default safely
      ],
    });
  };
  const forge = new GithubForge("o/r", {}, runner);
  const comments = await forge.listIssueComments(5);
  expect(comments).toEqual([
    {
      author: "alice",
      authorAssociation: "MEMBER",
      body: "hi",
      createdAt: Date.parse("2026-06-20T10:00:00Z"),
    },
    { author: "", authorAssociation: "NONE", body: "anon", createdAt: 0 },
  ]);
});

test("listIssueComments tolerates empty output", async () => {
  const forge = new GithubForge("o/r", {}, async () => "");
  expect(await forge.listIssueComments(1)).toEqual([]);
});

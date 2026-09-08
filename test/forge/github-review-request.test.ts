import { expect, test } from "bun:test";
import { GithubForge } from "../../src/forge/github";
import { graphRateLimit } from "../../src/forge/rate-limit";
import { annotateHandoff } from "../../src/repo-roles";
import { CRITIC_REVIEW_MARKER } from "../../src/forge/types";

test("people picker falls back to paginated upstream assignees without push access", async () => {
  const calls: string[][] = [];
  const forge = new GithubForge(
    "team/project",
    {},
    async (args) => {
      calls.push(args);
      if (args.includes("repos/team/project/collaborators")) throw new Error("HTTP 403");
      return "Zoe\n alice \nALICE\n\nBob\n";
    },
    "me/project",
  );
  expect(await forge.listCollaborators()).toEqual({
    logins: ["alice", "Bob", "Zoe"],
    unavailable: false,
    source: "assignees",
  });
  expect(calls).toEqual([
    ["api", "--paginate", "repos/team/project/collaborators", "--jq", ".[].login"],
    ["api", "--paginate", "repos/team/project/assignees", "--jq", ".[].login"],
  ]);
});

test("an empty accessible collaborator list does not trigger fallback", async () => {
  const calls: string[][] = [];
  const forge = new GithubForge("team/project", {}, async (args) => {
    calls.push(args);
    return "";
  });
  expect(await forge.listCollaborators()).toEqual({
    logins: [],
    unavailable: false,
    source: "collaborators",
  });
  expect(calls).toHaveLength(1);
});

test("both people APIs failing is unavailable, not an empty accessible list", async () => {
  const forge = new GithubForge("team/project", {}, async () => {
    throw new Error("offline");
  });
  expect(await forge.listCollaborators()).toEqual({ logins: [], unavailable: true });
});

test("review request posts one reviewer to upstream, without modifying other requests", async () => {
  const calls: string[][] = [];
  const forge = new GithubForge(
    "team/project",
    {},
    async (args) => {
      calls.push(args);
      return "{}";
    },
    "me/project",
  );
  await forge.requestReview(42, "alice");
  expect(calls).toEqual([
    [
      "api",
      "--method",
      "POST",
      "repos/team/project/pulls/42/requested_reviewers",
      "-f",
      "reviewers[]=alice",
    ],
  ]);
});

test.each([
  ["HTTP 403: secret", "review_request_forbidden"],
  ["HTTP 422: secret", "review_request_invalid_reviewer"],
  ["network secret", "review_request_failed"],
])("request failure %s is sanitized and never retried", async (message, code) => {
  let calls = 0;
  const forge = new GithubForge("team/project", {}, async () => {
    calls++;
    throw new Error(message);
  });
  await expect(forge.requestReview(42, "alice")).rejects.toThrow(code);
  expect(calls).toBe(1);
});

test("fork PR author and target context survive CLI and REST status paths", async () => {
  const calls: string[][] = [];
  const forge = new GithubForge(
    "team/project",
    {},
    async (args) => {
      calls.push(args);
      if (args[0] === "pr")
        return JSON.stringify([
          {
            number: 42,
            state: "OPEN",
            url: "https://github.com/team/project/pull/42",
            title: "test",
            author: { login: "author" },
            headRepositoryOwner: { login: "me" },
            reviewRequests: [{ login: "alice" }],
          },
        ]);
      if (args.includes("repos/team/project/pulls"))
        return JSON.stringify([
          {
            number: 42,
            state: "open",
            user: { login: "author" },
            head: { repo: { owner: { login: "me" } } },
            requested_reviewers: [{ login: "alice" }],
          },
        ]);
      if (args.includes("repos/team/project/pulls/42/reviews")) return "[[]]";
      return "{}";
    },
    "me/project",
  );
  try {
    graphRateLimit.note({ remaining: 1000, resetAt: Date.now() + 60_000 });
    const cli = await forge.prStatus("feature");
    expect(cli).toMatchObject({
      number: 42,
      isFork: true,
      authorLogin: "author",
      requestedReviewers: ["alice"],
    });
    expect(calls[0]![calls[0]!.indexOf("--json") + 1]!.split(",")).toContain("author");
    graphRateLimit.noteLimitError(60);
    expect(await forge.prStatus("feature")).toMatchObject({
      number: 42,
      isFork: true,
      authorLogin: "author",
      requestedReviewers: ["alice"],
    });
  } finally {
    graphRateLimit.note({ remaining: 1000, resetAt: Date.now() + 60_000 });
  }
});

test.each([
  ["APPROVED", "merger"],
  ["CHANGES_REQUESTED", undefined],
  ["DISMISSED", "reviewer"],
] as const)("REST fallback preserves %s reviews for fork handoff", async (state, handoff) => {
  const calls: string[][] = [];
  const forge = new GithubForge(
    "team/project",
    {},
    async (args) => {
      calls.push(args);
      if (args.includes("repos/team/project/pulls/42/reviews")) {
        expect(args).toContain("--paginate");
        expect(args).toContain("--slurp");
        return JSON.stringify([
          [{ user: { login: "alice" }, state: "APPROVED", submitted_at: "2026-09-01T10:00:00Z" }],
          [
            { user: { login: "alice" }, state, submitted_at: "2026-09-01T11:00:00Z" },
            {
              user: { login: "critic" },
              state: "CHANGES_REQUESTED",
              body: CRITIC_REVIEW_MARKER,
              submitted_at: "2026-09-01T12:00:00Z",
            },
          ],
        ]);
      }
      if (args.includes("repos/team/project/pulls"))
        return JSON.stringify([
          {
            number: 42,
            state: "open",
            head: { ref: "feature", repo: { owner: { login: "me" } } },
          },
        ]);
      return "[]";
    },
    "me/project",
  );
  try {
    graphRateLimit.noteLimitError(60);
    const single = await forge.prStatus("feature");
    const batch = (await forge.listOpenPrSnapshot()).statuses.get("feature")!;
    for (const status of [single, batch]) {
      expect(status.latestReview?.author).toBe("alice");
      expect(status.latestReview?.state).toBe(
        state === "CHANGES_REQUESTED" ? "changes_requested" : "approved",
      );
      expect(status.reviewerStates).toEqual(
        state === "DISMISSED"
          ? {}
          : {
              alice: {
                state: state === "APPROVED" ? "approved" : "changes_requested",
                latestAt: Date.parse("2026-09-01T11:00:00Z"),
              },
            },
      );
      const git = annotateHandoff({ kind: "github", ...status }, "/no/such/repo", "me");
      expect(git.handoff).toBe(handoff);
      expect(git.reviewBlock?.reviewer).toBe(state === "CHANGES_REQUESTED" ? "alice" : undefined);
    }
    expect(
      calls.filter((args) => args.includes("repos/team/project/pulls/42/reviews")),
    ).toHaveLength(2);
  } finally {
    graphRateLimit.note({ remaining: 1000, resetAt: Date.now() + 60_000 });
  }
});

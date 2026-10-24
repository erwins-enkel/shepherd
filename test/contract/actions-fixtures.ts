import type { Recap } from "../../src/types";

/** The one payload the stubbed server cannot produce itself: `deps.recap` is unwired in
 *  test/contract/deps.ts, so no recap is ever generated. Typed with the server's own `Recap`,
 *  so a field rename in src/types.ts breaks `bun run typecheck` before it can drift past the
 *  contract. The contract's `Recap` is a documented subset with additionalProperties: true —
 *  the native client reads the seven fields the action bar shows and ignores the rest. */
export const recap: Recap = {
  sessionId: "sess_fixture",
  state: "ready",
  headSha: "0123456789abcdef0123456789abcdef01234567",
  base: "main",
  verdict: "needs_attention",
  headline: "Rate limiter lands, two follow-ups open",
  body: "Adds the token bucket and its tests. Two call sites still bypass it.",
  openItems: ["wire the admin route through the limiter", "document the burst window"],
  changedFiles: ["src/limiter.ts", "test/limiter.test.ts"],
  blocks: [
    {
      type: "diff",
      id: "diff-1",
      path: "src/limiter.ts",
      summary: "Add limiter",
      file: {
        path: "src/limiter.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        binary: false,
        hunks: [
          { header: "@@ -1,0 +1 @@", lines: [{ kind: "add", content: "limit();", newNo: 1 }] },
        ],
      },
    },
  ],
  spawnSessionId: "sess_recap_agent",
  cwd: "/tmp/wt",
  model: "claude-opus-5",
  spawnedAt: 1_800_000_000_000,
  generatedAt: 1_800_000_060_000,
  updatedAt: 1_800_000_060_000,
};

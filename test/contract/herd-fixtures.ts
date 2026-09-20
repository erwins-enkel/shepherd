import type { GitState } from "../../src/forge/types";
import type { SessionActivity } from "../../src/activity-signal";
import type { ReviewVerdict } from "../../src/types";
import type { LivenessWiring } from "../../src/poller";
import { readFileSync } from "node:fs";
import ts from "typescript";

const emitterSource = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");

/** Assert the production wiring, without importing index.ts and starting the real server.
 *  Fail closed if the emitter stops using an inline object, or adds/renames a property. */
export function assertClaudeAliveEmitterKeys(source: string, keys: string[]): void {
  const file = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  const emissions: string[][] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "emit" &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === "session:claude-alive"
    ) {
      const payload = node.arguments[1];
      if (!payload || !ts.isObjectLiteralExpression(payload)) {
        throw new Error(
          "liveness emitter no longer has an inline payload; update the fixture binding",
        );
      }
      emissions.push(
        payload.properties
          .map((property) => {
            const name = property.name;
            if (!name || (!ts.isIdentifier(name) && !ts.isStringLiteral(name))) {
              throw new Error("liveness emitter has an unbound payload property");
            }
            return name.text;
          })
          .sort(),
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (emissions.length !== 1 || JSON.stringify(emissions[0]) !== JSON.stringify([...keys].sort())) {
    throw new Error("liveness fixture keys differ from the production emitter");
  }
}

/** Bind both parameter types and emitted property names to the production wiring. */
export function claudeAliveEvent(
  ...[id, claudeAlive, liveness]: Parameters<LivenessWiring["onChange"]>
) {
  const payload = { id, claudeAlive, liveness };
  assertClaudeAliveEmitterKeys(emitterSource, Object.keys(payload));
  return payload;
}

/** Every field the classifier reads, on one row, so a rename in src/forge/types.ts breaks
 *  `bun run typecheck` before it can drift past the contract. Typed with the SERVER's GitState,
 *  which is the same object the contract's `detail` block describes — S0-prep-2 added the four
 *  properties it was missing (handoff/handoffWho/reviewBlock/headSha) to that schema, so there is
 *  exactly one description of this payload. */
export const gitOpenGreenHandedOff: GitState = {
  kind: "github",
  state: "open",
  number: 412,
  url: "https://example.test/pr/412",
  title: "Rate limiter",
  createdAt: 1_800_000_000_000,
  mergeable: true,
  checks: "success",
  noCi: false,
  mergeStateStatus: "clean",
  isDraft: false,
  isFork: false,
  authorLogin: "operator",
  requestedReviewers: ["reviewer-one"],
  handoff: "reviewer",
  handoffWho: "reviewer-one",
  headSha: "0123456789abcdef0123456789abcdef01234567",
  deployConfigured: false,
};

/** The `needsRework` shape: open, green, idle, and carrying a reviewBlock. */
export const gitChangesRequested: GitState = {
  ...gitOpenGreenHandedOff,
  handoff: undefined,
  handoffWho: undefined,
  reviewBlock: {
    reviewer: "reviewer-one",
    state: "changes_requested",
    latestAt: 1_800_000_060_000,
  },
};

/** `ciFailed`: open with a red rollup. */
export const gitCiRed: GitState = {
  ...gitOpenGreenHandedOff,
  checks: "failure",
  handoff: undefined,
};

export const activity: SessionActivity = {
  lastActivityTs: 1_800_000_030_000,
  summary: "editing src/limiter.ts",
  recentTs: [1_800_000_010_000, 1_800_000_020_000, 1_800_000_030_000],
  recentErrTs: [1_800_000_020_000],
  runtimeModel: "claude-opus-5",
  runtimeEffort: "high",
};

export const verdict: ReviewVerdict = {
  sessionId: "sess_fixture",
  headSha: "0123456789abcdef0123456789abcdef01234567",
  decision: "changes_requested",
  summary: "Two call sites bypass the limiter",
  body: "The admin route and the webhook handler skip it entirely.",
  findings: ["wire the admin route through the limiter", "document the burst window"],
  addressRound: 1,
  addressCap: 3,
  finalRoundPending: false,
  finalRoundTimeoutMs: 900_000,
  updatedAt: 1_800_000_060_000,
  // `ReviewVerdict` (src/types.ts:851-882) makes these five REQUIRED. Omitting any of them fails
  // `bun run typecheck`, which is a gate on this branch, before a single contract test runs.
  patchId: "",
  streakReviews: 1,
  reviewedPatchIds: [],
  errorRound: 0,
  seenNoteIds: [],
};

export const reviewerEnv = {
  id: "sess_fixture",
  provider: "claude" as const,
  model: "claude-opus-5",
  effort: "high",
};

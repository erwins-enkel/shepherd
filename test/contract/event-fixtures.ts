import type { AutoMergeStatus } from "../../src/automerge";
import type { BlockReason } from "../../src/blocked";
import type { SubagentEntry } from "../../src/hooks-ingest";
import type {
  EpicDraft,
  ExperimentRole,
  SessionPreviewEvent,
  SessionPreviewServeEvent,
  SessionStatus,
  SpawnNotice,
} from "../../src/types";
import type { UsageLimits, UsageProviderSnapshot } from "../../src/usage-limits";

/** Payloads for events the stubbed server cannot emit on its own. Each constant is annotated
 *  with the server's own type, so `bun run typecheck` fails if the server shape moves. The
 *  contract test emits them through deps.events and validates the frame the client sees.
 *
 *  session:status / session:renamed / session:ready are emitted from inline object literals in
 *  src/index.ts (the poller callbacks) and src/service.ts — there is no named payload type to
 *  import — so those three are annotated structurally, reusing the server's `SessionStatus`
 *  union for the one field that has a name. */

export const statusEvent: {
  id: string;
  status: SessionStatus;
  hasScratchpadFiles?: boolean;
} = {
  id: "sess_fixture",
  status: "blocked",
  hasScratchpadFiles: false,
};

export const renamedEvent: { id: string; name: string; branch: string | null } = {
  id: "sess_fixture",
  name: "renamed task",
  branch: "shepherd/renamed-task",
};

const block: BlockReason = {
  shape: "yes-no",
  options: [
    { label: "Yes", send: "y\n" },
    { label: "No", send: "n\n" },
  ],
  tail: ["Proceed? (y/n)"],
};
export const blockEvent: { id: string; block: BlockReason | null } = { id: "sess_fixture", block };
export const unblockEvent: { id: string; block: BlockReason | null } = {
  id: "sess_fixture",
  block: null,
};

export const readyEvent: { id: string; ready: boolean } = { id: "sess_fixture", ready: true };

export const automergeEvent: AutoMergeStatus = {
  repoPath: "/tmp/repo",
  enabled: true,
  state: "merging",
  detail: "PR #12",
  sessionId: "sess_fixture",
};

export const usageEvent: UsageLimits = {
  observed: {
    session5h: { pct: 40, resetAt: 1_800_000_000_000, scrapedAt: 1_799_999_000_000 },
    week: { pct: 9, resetAt: 1_800_500_000_000, scrapedAt: 1_799_999_000_000 },
  },
  session5h: { pct: 42, resetAt: 1_800_000_000_000 },
  week: { pct: 10, resetAt: 1_800_500_000_000 },
  perModelWeek: [
    { model: "fable", pct: 5, resetAt: null, scrapedAt: 1_799_000_000_000, stale: false },
  ],
  credits: null,
  stale: false,
  calibratedAt: 1_799_000_000_000,
  subscriptionOnly: false,
};

/** No provider sample yet; both observed windows are explicitly null on the wire. */
export const unobservedUsageEvent: UsageLimits = {
  ...usageEvent,
  observed: { session5h: null, week: null },
};

const codexUsage: Extract<UsageProviderSnapshot, { provider: "codex" }> = {
  provider: "codex",
  kind: "tokens",
  totalTokens: 120_000,
  session5hTokens: 3_000,
  weekTokens: 24_000,
  updatedAt: 1_799_999_000_000,
  stale: false,
  session5h: { pct: 3, resetAt: 1_800_000_000_000 },
  week: { pct: 7, resetAt: 1_800_500_000_000 },
};

/** Both engines, including the Codex weekly window behind the composer's CX·WK 93% free. */
export const providerUsageEvent: UsageLimits = {
  ...usageEvent,
  providers: [
    { provider: "claude", kind: "limits", ...usageEvent },
    {
      ...codexUsage,
      rateLimitSource: "rollout",
      rateLimitCheckedAt: 1_799_999_100_000,
      rateLimitFilesScanned: 2,
      rateLimitLatestEventAt: 1_799_999_000_000,
    },
  ],
};

/** No measured windows yet; Codex still supplies its raw token fallback. */
export const missingProviderWindowsUsageEvent: UsageLimits = {
  ...unobservedUsageEvent,
  providers: [
    {
      provider: "claude",
      kind: "limits",
      ...unobservedUsageEvent,
      session5h: null,
      week: null,
      perModelWeek: [],
      calibratedAt: null,
      stale: true,
    },
    {
      ...codexUsage,
      session5h: null,
      week: null,
      updatedAt: null,
      stale: true,
      rateLimitSource: "missing",
      rateLimitCheckedAt: 1_799_999_100_000,
      rateLimitFilesScanned: 0,
      rateLimitLatestEventAt: null,
    },
  ],
};

/** Optional provider observations and Codex scrape metadata may be absent. */
export const minimalProviderUsageEvent: UsageLimits = {
  ...usageEvent,
  providers: [
    {
      provider: "claude",
      kind: "limits",
      session5h: null,
      week: null,
      perModelWeek: [],
      credits: {
        pct: 5,
        spent: 1,
        cap: 20,
        currency: "USD",
        resetAt: null,
        scrapedAt: 1_799_999_000_000,
        stale: false,
      },
      stale: false,
      calibratedAt: null,
      subscriptionOnly: true,
    },
    codexUsage,
  ],
};

/** Shared runtime cases for the read response and the bare usage:limits event. */
export const usageCases = [
  ["no providers (older server)", usageEvent],
  ["unobserved without providers", unobservedUsageEvent],
  ["both providers", providerUsageEvent],
  ["missing provider windows", missingProviderWindowsUsageEvent],
  ["optional provider fields absent", minimalProviderUsageEvent],
] as const;

/** CLI `events tail` (#2482): the session:* frames beyond the native set. The server's own type
 *  where one exists; structural where the emit is an inline literal (src/service.ts,
 *  src/egress-watch.ts, src/server.ts handleSessionVariant). */
const epicDraft: EpicDraft = {
  sessionId: "sess_fixture",
  status: "draft",
  parent: { title: "Epic", body: "why", acceptanceCriteria: ["done"], nonGoals: [] },
  children: [
    { key: "c1", title: "first", body: "b", acceptanceCriteria: ["a"], blockedBy: [] },
    { key: "c2", title: "second", body: "b", acceptanceCriteria: [], blockedBy: ["c1"] },
  ],
  materializedChildren: { c1: 101 },
  parentNumber: null,
  parentUrl: null,
};
const experiment: {
  id: string;
  experimentId: string | null;
  experimentRole: ExperimentRole | null;
} = { id: "sess_fixture", experimentId: "exp_1", experimentRole: "variant" };
const injection: { id: string; count: number; labels: string[] } = {
  id: "sess_fixture",
  count: 1,
  labels: ["ignore-previous"],
};
const preview: SessionPreviewEvent = { id: "sess_fixture", previewPort: 7400 };
const previewServe: SessionPreviewServeEvent = { id: "sess_fixture", serve: "ok" };
const notice: SpawnNotice = {
  sessionId: "sess_fixture",
  kind: "plan",
  severity: "failed",
  reason: "over-budget",
  detail: "plan exceeds argv budget",
  steers: 1,
  inputKey: "abc123",
  updatedAt: 1_799_999_000_000,
};
const subagents: SubagentEntry[] = [
  { agentId: "a1", agentType: "Explore", startedAt: 1_799_999_000_000 },
  {
    agentId: "a2",
    agentType: "general-purpose",
    startedAt: 1_799_999_000_000,
    endedAt: 1_799_999_100_000,
  },
];

/** [event, payload] pairs, null branches included. */
export const cliSessionEvents: [string, unknown][] = [
  ["session:epic-draft", epicDraft],
  [
    "session:epic-draft",
    {
      ...epicDraft,
      status: "approved",
      parentNumber: 100,
      parentUrl: "https://example.test/i/100",
    } satisfies EpicDraft,
  ],
  ["session:experiment", experiment],
  ["session:experiment", { ...experiment, experimentId: null, experimentRole: null }],
  ["session:injection-detected", injection],
  ["session:preview", preview],
  ["session:preview", { id: "sess_fixture", previewPort: null } satisfies SessionPreviewEvent],
  ["session:preview-serve", previewServe],
  ["session:preview-serve", { id: "sess_fixture", serve: null } satisfies SessionPreviewServeEvent],
  [
    "session:spawn-notices",
    {
      id: "sess_fixture",
      notices: [
        notice,
        { ...notice, kind: "review", severity: "clamped", reason: null, inputKey: null },
      ] satisfies SpawnNotice[],
    },
  ],
  ["session:spawn-notices", { id: "sess_fixture", notices: [] }],
  ["session:subagents", { id: "sess_fixture", subagents }],
  [
    "session:uploads-dropped",
    { id: "sess_fixture", count: 2 } satisfies { id: string; count: number },
  ],
  [
    "session:egress-drop",
    { id: "sess_fixture", host: "evil.example" } satisfies { id: string; host: string },
  ],
];

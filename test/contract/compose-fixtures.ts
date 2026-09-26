import type { Issue } from "../../src/forge/types";
import type { SlashCommand } from "../../src/commands";
import type { Epic, EpicRun } from "../../src/epic-core";

/** Every field the picker and the filter pipeline read, across four rows that exercise each
 *  filter stage: one plain, one assigned to somebody else, one labelled shepherd:active, one
 *  blocked. Typed with the SERVER's Issue, so a rename in src/types.ts breaks `bun run typecheck`
 *  before it can drift past the contract. */
export const issues: Issue[] = [
  {
    number: 412,
    title: "Rate-limit the admin route",
    body: "The admin route bypasses the limiter entirely.",
    url: "https://example.test/i/412",
    labels: ["bug"],
    labelColors: { bug: "#d73a4a" },
    createdAt: 1_800_000_000_000,
    assignees: [],
    author: "operator",
  },
  {
    number: 413,
    title: "Document the burst window",
    body: "",
    url: "https://example.test/i/413",
    labels: [],
    createdAt: 1_800_000_010_000,
    assignees: ["somebody-else"],
    author: "somebody-else",
  },
  {
    number: 414,
    title: "Already being worked on",
    body: "",
    url: "https://example.test/i/414",
    labels: ["shepherd:active"],
    createdAt: 1_800_000_020_000,
    assignees: ["operator"],
    author: "operator",
  },
  {
    number: 415,
    title: "Waiting on upstream",
    body: "",
    url: "https://example.test/i/415",
    labels: ["blocked-upstream"],
    createdAt: 1_800_000_030_000,
    assignees: [],
    author: "operator",
    blockedBy: [999],
  },
];

export const commands: SlashCommand[] = [
  {
    id: "project:ship",
    name: "ship",
    displayName: "ship",
    description: "Open a PR and hand it to the reviewer",
    scope: "project",
    kind: "command",
    invocationName: "ship",
    sourceNamespace: "",
    providers: ["claude"],
    invocations: { claude: "/ship" },
  },
  {
    id: "user:video-brief",
    name: "video-brief",
    displayName: "video-brief",
    description: "Read a screen recording",
    scope: "user",
    kind: "skill",
    invocationName: "video-brief",
    sourceNamespace: "",
    providers: ["claude", "codex"],
    invocations: { claude: "/video-brief", codex: "$video-brief" },
  },
];

/** The minimum `GitForge` the two routes touch: `listIssues`, `currentUser`, `slug`, `webUrl`,
 *  `isLightweight`. `listBlockedByOpen` is deliberately absent — the route's blocker attachment
 *  fails open, and that is the path most real repos take. */
export function fakeForge(overrides: Record<string, unknown> = {}): unknown {
  return {
    slug: "owner/repo",
    webUrl: "https://example.test",
    isLightweight: false,
    listIssues: async () => issues,
    currentUser: async () => "operator",
    ...overrides,
  };
}

/** The full native-summary payload emitted by buildEpicSummaries in src/server.ts. */
export const epicListing = {
  epics: [
    {
      parentIssueNumber: 412,
      parentTitle: "Rate-limit the admin route",
      total: 2,
      merged: 0,
      status: "idle",
      source: "native",
      inFlight: 0,
      inFlightBy: [],
      assignedOthers: [],
      authoredByOther: null,
    },
  ],
  subIssues: [413, 414],
};

/** The shaper's actual wire types, shared with the plan question resolver. */
export const shapeRound = {
  draft: {
    problem: "Missing limits",
    outcome: "Bound requests",
    constraints: ["Keep API"],
    nonGoals: ["Rewrite"],
  },
  block: {
    type: "question-form",
    id: "shape-questions",
    questions: [
      { id: "scope", kind: "single", prompt: "Which scope?", options: ["Admin", "All"] },
      { id: "checks", kind: "multi", prompt: "Which checks?", options: ["Tests", "Metrics"] },
      { id: "detail", kind: "freeform", prompt: "Any detail?" },
    ],
  },
} satisfies Exclude<import("../../src/task-shape").ShapeResult, { error: string }>;

export const steers = [
  {
    id: "compose-steer",
    label: "Test",
    text: "Run tests",
    emoji: "🧪",
    inSteerBar: true,
    onIssues: false,
    repos: ["repo"],
    agentProviders: ["codex"],
  },
] satisfies import("../../src/types").Steer[];

export const leftovers = [
  { kind: "process", name: "vite", port: 5173, key: "pid:123", pid: 123, startTicks: 456 },
  {
    kind: "system",
    name: "proxy",
    port: null,
    key: "proxy:1",
    command: { bin: "proxy", args: ["stop"] },
  },
] satisfies import("../../src/process-reaper").Leftover[];

/** What drain.buildEpic assembles (src/epic-model.ts assembleEpic), typed with the server's Epic so
 *  a field rename breaks the typecheck before it can drift past the contract. */
export function epic(run: EpicRun): Epic {
  return {
    repoPath: run.repoPath,
    parentIssueNumber: run.parentIssueNumber,
    parentTitle: "Rate-limit the admin route",
    source: "native",
    children: [
      {
        number: 413,
        title: "Limiter",
        url: "https://example.test/i/413",
        order: 0,
        body: "Add the limiter.",
        blockedBy: [],
        state: "in-review",
        sessionId: "s-413",
        prNumber: 9,
        issueClosed: false,
        integrationMerged: false,
        claimed: true,
      },
      {
        number: 414,
        title: "Metrics",
        url: "https://example.test/i/414",
        order: 1,
        body: "",
        blockedBy: [413],
        state: "blocked",
        sessionId: null,
        prNumber: null,
        issueClosed: false,
        integrationMerged: false,
        claimed: false,
      },
    ],
    warnings: ["#414 blocked_by #999 is outside the epic — ignored"],
    noDependencyEdges: false,
    run,
  };
}

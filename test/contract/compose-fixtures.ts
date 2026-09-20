import type { Issue } from "../../src/forge/types";
import type { SlashCommand } from "../../src/commands";

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

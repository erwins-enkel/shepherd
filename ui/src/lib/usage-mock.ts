/**
 * Mock fixtures for the /usage token-spend dashboard (Phase 0 prototype).
 * No backend — all data is hand-written for visual prototyping.
 */
import type {
  UsageBreakdown,
  UsageKindUnits,
  UsageModelBreakdown,
  UsageRange,
  UsageTaskBreakdown,
} from "./types";

/** Single stable base to keep all timestamps deterministic across calls. */
const BASE = Date.now();

/** Plausible per-kind satellite split for prototyping — sorted desc by units. */
function byKind(totalSat: number): UsageKindUnits[] {
  const split: Array<[string, number, number]> = [
    ["review", 0.52, 9],
    ["recap", 0.21, 12],
    ["plan_gate", 0.14, 5],
    ["rundown", 0.08, 3],
    ["doc_agent", 0.05, 2],
  ];
  return split.map(([kind, frac, count]) => ({ kind, units: Math.round(totalSat * frac), count }));
}

/**
 * Build a mock task, deriving api-key-mode `dollars` from its own weighted units
 * (authoring + satellite) so the dollar figure can't drift from the units it represents —
 * mirrors the server formula in src/usage-breakdown.ts.
 */
function task(t: Omit<UsageTaskBreakdown, "dollars">): UsageTaskBreakdown {
  return { ...t, dollars: t.authoringUnits + t.satelliteUnits };
}

function modelBreakdown(byModel: Record<string, number>): UsageModelBreakdown {
  return {
    totalTokens: Object.values(byModel).reduce((sum, tokens) => sum + tokens, 0),
    byModel,
  };
}

function modelsFor(range: UsageRange): UsageBreakdown["models"] {
  if (range === "24h") {
    return {
      claude: modelBreakdown({
        "claude-opus-4-8": 2_400_000,
        "claude-sonnet-4-5": 1_150_000,
        fable: 420_000,
      }),
      codex: modelBreakdown({ "gpt-5.5": 1_800_000, "gpt-5.4": 350_000 }),
    };
  }
  if (range === "7d") {
    return {
      claude: modelBreakdown({
        "claude-opus-4-8": 12_800_000,
        "claude-sonnet-4-5": 7_300_000,
        "claude-haiku-4-5": 1_950_000,
        fable: 1_100_000,
      }),
      codex: modelBreakdown({ "gpt-5.5": 8_900_000, "gpt-5.4": 2_600_000, unknown: 240_000 }),
    };
  }
  if (range === "30d") {
    return {
      claude: modelBreakdown({
        "claude-opus-4-8": 48_600_000,
        "claude-sonnet-4-5": 29_400_000,
        "claude-haiku-4-5": 8_700_000,
        fable: 4_200_000,
      }),
      codex: modelBreakdown({ "gpt-5.5": 31_500_000, "gpt-5.4": 12_400_000, unknown: 860_000 }),
    };
  }
  return {
    claude: modelBreakdown({
      "claude-opus-4-8": 76_200_000,
      "claude-sonnet-4-5": 45_800_000,
      "claude-haiku-4-5": 13_100_000,
      fable: 6_700_000,
    }),
    codex: modelBreakdown({ "gpt-5.5": 49_600_000, "gpt-5.4": 18_900_000, unknown: 1_200_000 }),
  };
}

// ---------------------------------------------------------------------------
// Shepherd repo tasks (≥7 so "… N more" tail is exercised in the Spend lens)
// ---------------------------------------------------------------------------

const shepherdTasks24h: UsageTaskBreakdown[] = [
  task({
    sessionId: "s-001",
    desig: "TASK-07",
    name: "add-auth-flow",
    model: "claude-opus-4-8",
    authoringUnits: 84_000,
    satelliteUnits: 18_000,
    tokens: { input: 12_000, output: 3_400, cacheRead: 210_000, cacheWrite: 4_200 },
    byModel: { "claude-opus-4-8": 84_000 },
  }),
  task({
    sessionId: "s-002",
    desig: "TASK-12",
    name: "fix-toast-dedupe",
    model: "claude-opus-4-8",
    authoringUnits: 72_000,
    satelliteUnits: 14_500,
    tokens: { input: 10_500, output: 2_900, cacheRead: 180_000, cacheWrite: 3_600 },
    byModel: { "claude-opus-4-8": 62_000, "claude-sonnet-4-5": 10_000 },
  }),
  task({
    sessionId: "s-003",
    desig: "TASK-15",
    name: "usage-task-names",
    model: "claude-opus-4-8",
    authoringUnits: 61_000,
    satelliteUnits: 12_000,
    tokens: { input: 9_000, output: 2_500, cacheRead: 152_000, cacheWrite: 3_000 },
    byModel: { "claude-opus-4-8": 61_000 },
  }),
  task({
    sessionId: "s-004",
    desig: "TASK-18",
    name: "refactor-store",
    model: "claude-sonnet-4-5",
    authoringUnits: 28_000,
    satelliteUnits: 6_000,
    tokens: { input: 5_200, output: 1_100, cacheRead: 65_000, cacheWrite: 1_600 },
    byModel: { "claude-sonnet-4-5": 28_000 },
  }),
  task({
    sessionId: "s-005",
    desig: "TASK-21",
    name: "plan-gate-restart",
    model: "claude-opus-4-8",
    authoringUnits: 22_000,
    satelliteUnits: 4_500,
    tokens: { input: 3_800, output: 880, cacheRead: 55_000, cacheWrite: 1_200 },
    byModel: { "claude-opus-4-8": 18_000, "claude-haiku-4-5": 4_000 },
  }),
  task({
    sessionId: "s-006",
    desig: "TASK-24",
    name: "merge-train-marker",
    model: "claude-opus-4-8",
    authoringUnits: 17_000,
    satelliteUnits: 3_500,
    tokens: { input: 2_900, output: 680, cacheRead: 42_000, cacheWrite: 950 },
    byModel: { "claude-opus-4-8": 17_000 },
  }),
  task({
    sessionId: "s-007",
    desig: "TASK-27",
    name: "egress-allowlist",
    model: "claude-sonnet-4-5",
    authoringUnits: 11_000,
    satelliteUnits: 2_200,
    tokens: { input: 2_100, output: 440, cacheRead: 27_000, cacheWrite: 700 },
    byModel: { "claude-sonnet-4-5": 11_000 },
  }),
];

const shepherdAuth24h = shepherdTasks24h.reduce((a, t) => a + t.authoringUnits, 0); // 295_000
const shepherdSat24h = shepherdTasks24h.reduce((a, t) => a + t.satelliteUnits, 0); // 60_700

// web-app (2 tasks)
const webappTasks24h: UsageTaskBreakdown[] = [
  task({
    sessionId: "s-008",
    desig: "TASK-03",
    name: "glossary-popover",
    model: "claude-opus-4-8",
    authoringUnits: 76_000,
    satelliteUnits: 15_000,
    tokens: { input: 11_000, output: 3_100, cacheRead: 190_000, cacheWrite: 3_800 },
    byModel: { "claude-opus-4-8": 76_000 },
  }),
  task({
    sessionId: "s-009",
    desig: "TASK-04",
    name: "doc-agent-pr",
    model: "claude-sonnet-4-5",
    authoringUnits: 60_000,
    satelliteUnits: 12_200,
    tokens: { input: 9_200, output: 2_400, cacheRead: 150_000, cacheWrite: 3_100 },
    byModel: { "claude-sonnet-4-5": 50_000, "claude-opus-4-8": 10_000 },
  }),
];
const webappAuth24h = webappTasks24h.reduce((a, t) => a + t.authoringUnits, 0); // 136_000
const webappSat24h = webappTasks24h.reduce((a, t) => a + t.satelliteUnits, 0); // 27_200

// infra (1 task)
const infraTasks24h: UsageTaskBreakdown[] = [
  task({
    sessionId: "s-010",
    desig: "TASK-01",
    name: "readiness-tab",
    model: "claude-sonnet-4-5",
    authoringUnits: 38_000,
    satelliteUnits: 8_000,
    tokens: { input: 5_800, output: 1_520, cacheRead: 95_000, cacheWrite: 1_900 },
    byModel: { "claude-sonnet-4-5": 32_000, "claude-haiku-4-5": 6_000 },
  }),
];
const infraAuth24h = infraTasks24h.reduce((a, t) => a + t.authoringUnits, 0); // 38_000
const infraSat24h = infraTasks24h.reduce((a, t) => a + t.satelliteUnits, 0); // 8_000

// ---------------------------------------------------------------------------
// 7d data (multiplicative scale ~4×)
// ---------------------------------------------------------------------------

const shepherdTasks7d: UsageTaskBreakdown[] = [
  ...shepherdTasks24h,
  task({
    sessionId: "s-101",
    desig: "TASK-30",
    name: "epic-integration",
    model: "claude-opus-4-8",
    authoringUnits: 95_000,
    satelliteUnits: 19_000,
    tokens: { input: 13_500, output: 3_800, cacheRead: 238_000, cacheWrite: 4_700 },
    byModel: { "claude-opus-4-8": 95_000 },
  }),
  task({
    sessionId: "s-102",
    desig: "TASK-33",
    name: "critic-effort",
    model: "claude-opus-4-8",
    authoringUnits: 78_000,
    satelliteUnits: 16_000,
    tokens: { input: 11_200, output: 3_100, cacheRead: 195_000, cacheWrite: 3_900 },
    byModel: { "claude-opus-4-8": 68_000, "claude-sonnet-4-5": 10_000 },
  }),
];

const shepherdAuth7d = shepherdTasks7d.reduce((a, t) => a + t.authoringUnits, 0);
const shepherdSat7d = shepherdTasks7d.reduce((a, t) => a + t.satelliteUnits, 0);

const webappTasks7d: UsageTaskBreakdown[] = [
  ...webappTasks24h,
  task({
    sessionId: "s-110",
    desig: "TASK-05",
    name: "preview-serve",
    model: "claude-opus-4-8",
    authoringUnits: 88_000,
    satelliteUnits: 17_500,
    tokens: { input: 12_800, output: 3_500, cacheRead: 220_000, cacheWrite: 4_400 },
    byModel: { "claude-opus-4-8": 88_000 },
  }),
];
const webappAuth7d = webappTasks7d.reduce((a, t) => a + t.authoringUnits, 0);
const webappSat7d = webappTasks7d.reduce((a, t) => a + t.satelliteUnits, 0);

const infraTasks7d: UsageTaskBreakdown[] = [
  ...infraTasks24h,
  task({
    sessionId: "s-120",
    desig: "TASK-02",
    name: "tmpfs-guard",
    model: "claude-sonnet-4-5",
    authoringUnits: 42_000,
    satelliteUnits: 8_500,
    tokens: { input: 6_200, output: 1_680, cacheRead: 105_000, cacheWrite: 2_100 },
    byModel: { "claude-sonnet-4-5": 42_000 },
  }),
];
const infraAuth7d = infraTasks7d.reduce((a, t) => a + t.authoringUnits, 0);
const infraSat7d = infraTasks7d.reduce((a, t) => a + t.satelliteUnits, 0);

// ---------------------------------------------------------------------------
// 30d — add "docs" repo
// ---------------------------------------------------------------------------

const shepherdTasks30d: UsageTaskBreakdown[] = [
  ...shepherdTasks7d,
  task({
    sessionId: "s-201",
    desig: "TASK-36",
    name: "feature-catalog-gate",
    model: "claude-opus-4-8",
    authoringUnits: 110_000,
    satelliteUnits: 22_000,
    tokens: { input: 15_800, output: 4_400, cacheRead: 275_000, cacheWrite: 5_500 },
    byModel: { "claude-opus-4-8": 110_000 },
  }),
  task({
    sessionId: "s-202",
    desig: "TASK-39",
    name: "learnings-decay",
    model: "claude-opus-4-8",
    authoringUnits: 92_000,
    satelliteUnits: 18_500,
    tokens: { input: 13_200, output: 3_680, cacheRead: 230_000, cacheWrite: 4_600 },
    byModel: { "claude-opus-4-8": 80_000, "claude-sonnet-4-5": 12_000 },
  }),
  task({
    sessionId: "s-203",
    desig: "TASK-42",
    name: "rundown-digest",
    model: "claude-sonnet-4-5",
    authoringUnits: 45_000,
    satelliteUnits: 9_000,
    tokens: { input: 6_800, output: 1_800, cacheRead: 112_500, cacheWrite: 2_250 },
    byModel: { "claude-sonnet-4-5": 45_000 },
  }),
];
const shepherdAuth30d = shepherdTasks30d.reduce((a, t) => a + t.authoringUnits, 0);
const shepherdSat30d = shepherdTasks30d.reduce((a, t) => a + t.satelliteUnits, 0);

const webappTasks30d: UsageTaskBreakdown[] = [
  ...webappTasks7d,
  task({
    sessionId: "s-210",
    desig: "TASK-06",
    name: "api-key-auth",
    model: "claude-opus-4-8",
    authoringUnits: 98_000,
    satelliteUnits: 19_600,
    tokens: { input: 14_200, output: 3_920, cacheRead: 245_000, cacheWrite: 4_900 },
    byModel: { "claude-opus-4-8": 98_000 },
  }),
  task({
    sessionId: "s-211",
    desig: "TASK-07",
    name: "backlog-badges",
    model: "claude-opus-4-8",
    authoringUnits: 75_000,
    satelliteUnits: 15_000,
    tokens: { input: 10_900, output: 3_000, cacheRead: 187_500, cacheWrite: 3_750 },
    byModel: { "claude-opus-4-8": 65_000, "claude-sonnet-4-5": 10_000 },
  }),
];
const webappAuth30d = webappTasks30d.reduce((a, t) => a + t.authoringUnits, 0);
const webappSat30d = webappTasks30d.reduce((a, t) => a + t.satelliteUnits, 0);

const infraTasks30d: UsageTaskBreakdown[] = [
  ...infraTasks7d,
  task({
    sessionId: "s-220",
    desig: "TASK-03",
    name: "union-merge-driver",
    model: "claude-haiku-4-5",
    authoringUnits: 18_000,
    satelliteUnits: 3_600,
    tokens: { input: 2_900, output: 720, cacheRead: 45_000, cacheWrite: 900 },
    byModel: { "claude-haiku-4-5": 18_000 },
  }),
];
const infraAuth30d = infraTasks30d.reduce((a, t) => a + t.authoringUnits, 0);
const infraSat30d = infraTasks30d.reduce((a, t) => a + t.satelliteUnits, 0);

const docsTasks30d: UsageTaskBreakdown[] = [
  task({
    sessionId: "s-230",
    desig: "TASK-01",
    name: "recap-done-lens",
    model: "claude-sonnet-4-5",
    authoringUnits: 32_000,
    satelliteUnits: 6_400,
    tokens: { input: 4_800, output: 1_280, cacheRead: 80_000, cacheWrite: 1_600 },
    byModel: { "claude-sonnet-4-5": 32_000 },
  }),
];
const docsAuth30d = docsTasks30d.reduce((a, t) => a + t.authoringUnits, 0);
const docsSat30d = docsTasks30d.reduce((a, t) => a + t.satelliteUnits, 0);

// ---------------------------------------------------------------------------
// all — cumulative, adds more tasks
// ---------------------------------------------------------------------------

const shepherdTasksAll: UsageTaskBreakdown[] = [
  ...shepherdTasks30d,
  task({
    sessionId: "s-301",
    desig: "TASK-45",
    name: "onboarding-harness",
    model: "claude-opus-4-8",
    authoringUnits: 130_000,
    satelliteUnits: 26_000,
    tokens: { input: 18_800, output: 5_200, cacheRead: 325_000, cacheWrite: 6_500 },
    byModel: { "claude-opus-4-8": 130_000 },
  }),
  task({
    sessionId: "s-302",
    desig: "TASK-48",
    name: "installer-fix",
    model: "claude-opus-4-8",
    authoringUnits: 115_000,
    satelliteUnits: 23_000,
    tokens: { input: 16_500, output: 4_600, cacheRead: 287_500, cacheWrite: 5_750 },
    byModel: { "claude-opus-4-8": 105_000, "claude-sonnet-4-5": 10_000 },
  }),
  task({
    sessionId: "s-303",
    desig: "TASK-51",
    name: "i18n-parity",
    model: "claude-sonnet-4-5",
    authoringUnits: 58_000,
    satelliteUnits: 11_600,
    tokens: { input: 8_800, output: 2_320, cacheRead: 145_000, cacheWrite: 2_900 },
    byModel: { "claude-sonnet-4-5": 58_000 },
  }),
];
const shepherdAuthAll = shepherdTasksAll.reduce((a, t) => a + t.authoringUnits, 0);
const shepherdSatAll = shepherdTasksAll.reduce((a, t) => a + t.satelliteUnits, 0);

const webappTasksAll: UsageTaskBreakdown[] = [
  ...webappTasks30d,
  task({
    sessionId: "s-310",
    desig: "TASK-08",
    name: "fable-guard",
    model: "claude-opus-4-8",
    authoringUnits: 108_000,
    satelliteUnits: 21_600,
    tokens: { input: 15_600, output: 4_320, cacheRead: 270_000, cacheWrite: 5_400 },
    byModel: { "claude-opus-4-8": 108_000 },
  }),
];
const webappAuthAll = webappTasksAll.reduce((a, t) => a + t.authoringUnits, 0);
const webappSatAll = webappTasksAll.reduce((a, t) => a + t.satelliteUnits, 0);

const infraTasksAll: UsageTaskBreakdown[] = [
  ...infraTasks30d,
  task({
    sessionId: "s-320",
    desig: "TASK-04",
    name: "spend-lens",
    model: "claude-sonnet-4-5",
    authoringUnits: 55_000,
    satelliteUnits: 11_000,
    tokens: { input: 8_200, output: 2_200, cacheRead: 137_500, cacheWrite: 2_750 },
    byModel: { "claude-sonnet-4-5": 50_000, "claude-haiku-4-5": 5_000 },
  }),
];
const infraAuthAll = infraTasksAll.reduce((a, t) => a + t.authoringUnits, 0);
const infraSatAll = infraTasksAll.reduce((a, t) => a + t.satelliteUnits, 0);

const docsTasksAll: UsageTaskBreakdown[] = [
  ...docsTasks30d,
  task({
    sessionId: "s-330",
    desig: "TASK-02",
    name: "overhead-lens",
    model: "claude-haiku-4-5",
    authoringUnits: 14_000,
    satelliteUnits: 2_800,
    tokens: { input: 2_200, output: 560, cacheRead: 35_000, cacheWrite: 700 },
    byModel: { "claude-haiku-4-5": 14_000 },
  }),
];
const docsAuthAll = docsTasksAll.reduce((a, t) => a + t.authoringUnits, 0);
const docsSatAll = docsTasksAll.reduce((a, t) => a + t.satelliteUnits, 0);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Returns a realistic per-range fixture for the /usage breakdown. */
export function mockBreakdown(range: UsageRange): UsageBreakdown {
  switch (range) {
    case "24h": {
      const totalA = shepherdAuth24h + webappAuth24h + infraAuth24h;
      const totalS = shepherdSat24h + webappSat24h + infraSat24h;
      const total = totalA + totalS;
      return {
        range,
        generatedAt: BASE,
        totalUnits: total,
        authoringUnits: totalA,
        satelliteUnits: totalS,
        cacheReadUnits: Math.round(total * 0.75),
        generationUnits: Math.round(total * 0.25),
        satelliteByKind: byKind(totalS),
        dollars: total,
        models: modelsFor(range),
        repos: [
          {
            repoPath: "/home/user/shepherd",
            repoName: "shepherd",
            authoringUnits: shepherdAuth24h,
            satelliteUnits: shepherdSat24h,
            dollars: shepherdAuth24h + shepherdSat24h,
            tasks: shepherdTasks24h,
          },
          {
            repoPath: "/home/user/web-app",
            repoName: "web-app",
            authoringUnits: webappAuth24h,
            satelliteUnits: webappSat24h,
            dollars: webappAuth24h + webappSat24h,
            tasks: webappTasks24h,
          },
          {
            repoPath: "/home/user/infra",
            repoName: "infra",
            authoringUnits: infraAuth24h,
            satelliteUnits: infraSat24h,
            dollars: infraAuth24h + infraSat24h,
            tasks: infraTasks24h,
          },
        ],
      };
    }

    case "7d": {
      const totalA = shepherdAuth7d + webappAuth7d + infraAuth7d;
      const totalS = shepherdSat7d + webappSat7d + infraSat7d;
      const total = totalA + totalS;
      return {
        range,
        generatedAt: BASE,
        totalUnits: total,
        authoringUnits: totalA,
        satelliteUnits: totalS,
        cacheReadUnits: Math.round(total * 0.76),
        generationUnits: Math.round(total * 0.24),
        satelliteByKind: byKind(totalS),
        dollars: total,
        models: modelsFor(range),
        repos: [
          {
            repoPath: "/home/user/shepherd",
            repoName: "shepherd",
            authoringUnits: shepherdAuth7d,
            satelliteUnits: shepherdSat7d,
            dollars: shepherdAuth7d + shepherdSat7d,
            tasks: shepherdTasks7d,
          },
          {
            repoPath: "/home/user/web-app",
            repoName: "web-app",
            authoringUnits: webappAuth7d,
            satelliteUnits: webappSat7d,
            dollars: webappAuth7d + webappSat7d,
            tasks: webappTasks7d,
          },
          {
            repoPath: "/home/user/infra",
            repoName: "infra",
            authoringUnits: infraAuth7d,
            satelliteUnits: infraSat7d,
            dollars: infraAuth7d + infraSat7d,
            tasks: infraTasks7d,
          },
        ],
      };
    }

    case "30d": {
      const totalA = shepherdAuth30d + webappAuth30d + infraAuth30d + docsAuth30d;
      const totalS = shepherdSat30d + webappSat30d + infraSat30d + docsSat30d;
      const total = totalA + totalS;
      return {
        range,
        generatedAt: BASE,
        totalUnits: total,
        authoringUnits: totalA,
        satelliteUnits: totalS,
        cacheReadUnits: Math.round(total * 0.77),
        generationUnits: Math.round(total * 0.23),
        satelliteByKind: byKind(totalS),
        dollars: total,
        models: modelsFor(range),
        repos: [
          {
            repoPath: "/home/user/shepherd",
            repoName: "shepherd",
            authoringUnits: shepherdAuth30d,
            satelliteUnits: shepherdSat30d,
            dollars: shepherdAuth30d + shepherdSat30d,
            tasks: shepherdTasks30d,
          },
          {
            repoPath: "/home/user/web-app",
            repoName: "web-app",
            authoringUnits: webappAuth30d,
            satelliteUnits: webappSat30d,
            dollars: webappAuth30d + webappSat30d,
            tasks: webappTasks30d,
          },
          {
            repoPath: "/home/user/infra",
            repoName: "infra",
            authoringUnits: infraAuth30d,
            satelliteUnits: infraSat30d,
            dollars: infraAuth30d + infraSat30d,
            tasks: infraTasks30d,
          },
          {
            repoPath: "/home/user/docs",
            repoName: "docs",
            authoringUnits: docsAuth30d,
            satelliteUnits: docsSat30d,
            dollars: docsAuth30d + docsSat30d,
            tasks: docsTasks30d,
          },
        ],
      };
    }

    case "all": {
      const totalA = shepherdAuthAll + webappAuthAll + infraAuthAll + docsAuthAll;
      const totalS = shepherdSatAll + webappSatAll + infraSatAll + docsSatAll;
      const total = totalA + totalS;
      return {
        range,
        generatedAt: BASE,
        totalUnits: total,
        authoringUnits: totalA,
        satelliteUnits: totalS,
        cacheReadUnits: Math.round(total * 0.78),
        generationUnits: Math.round(total * 0.22),
        satelliteByKind: byKind(totalS),
        dollars: total,
        models: modelsFor(range),
        repos: [
          {
            repoPath: "/home/user/shepherd",
            repoName: "shepherd",
            authoringUnits: shepherdAuthAll,
            satelliteUnits: shepherdSatAll,
            dollars: shepherdAuthAll + shepherdSatAll,
            tasks: shepherdTasksAll,
          },
          {
            repoPath: "/home/user/web-app",
            repoName: "web-app",
            authoringUnits: webappAuthAll,
            satelliteUnits: webappSatAll,
            dollars: webappAuthAll + webappSatAll,
            tasks: webappTasksAll,
          },
          {
            repoPath: "/home/user/infra",
            repoName: "infra",
            authoringUnits: infraAuthAll,
            satelliteUnits: infraSatAll,
            dollars: infraAuthAll + infraSatAll,
            tasks: infraTasksAll,
          },
          {
            repoPath: "/home/user/docs",
            repoName: "docs",
            authoringUnits: docsAuthAll,
            satelliteUnits: docsSatAll,
            dollars: docsAuthAll + docsSatAll,
            tasks: docsTasksAll,
          },
        ],
      };
    }
  }
}

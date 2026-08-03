import { expect, test } from "bun:test";
import {
  buildQueueDirective,
  composeSystemPrompt,
  composeSystemPromptBlocks,
  type ComposeSystemPromptOptions,
} from "../src/service";
import {
  CHARS_PER_TOKEN,
  PROMPT_BLOCK_SEPARATOR,
  estimateTokens,
  joinPromptBlocks,
  measurePromptBlocks,
} from "../src/prompt-budget";
import { SessionStore } from "../src/store";

/** The spawn shapes the instrument has to cover. Every flag the composer branches on appears at
 *  least once, both providers appear, both plan-gate variants appear, and both operator languages
 *  appear — so a block that silently stopped being emitted fails the reconstruction assertion. */
const HOUSE_RULES = "<shepherd-house-rules>\n- keep it small\n</shepherd-house-rules>";
const MATRIX: {
  label: string;
  houseRules: string | null;
  autopilot: boolean;
  opts: ComposeSystemPromptOptions;
}[] = [
  { label: "attended, bare", houseRules: null, autopilot: false, opts: {} },
  { label: "attended + house rules", houseRules: HOUSE_RULES, autopilot: false, opts: {} },
  { label: "autopilot", houseRules: null, autopilot: true, opts: {} },
  { label: "research", houseRules: null, autopilot: false, opts: { research: true } },
  {
    label: "epic authoring",
    houseRules: null,
    autopilot: true,
    opts: { epicAuthoring: "draft the epic" },
  },
  { label: "landing repair", houseRules: null, autopilot: true, opts: { landingRepair: true } },
  {
    label: "plan gate interactive",
    houseRules: null,
    autopilot: true,
    opts: { planGate: "interactive" },
  },
  { label: "plan gate auto", houseRules: null, autopilot: true, opts: { planGate: "auto" } },
  {
    label: "build queue + preview + draft + trim",
    houseRules: HOUSE_RULES,
    autopilot: false,
    opts: { buildQueue: "PUT the steps", previewHint: true, draftMode: true, trimmed: true },
  },
  { label: "epic intent", houseRules: null, autopilot: false, opts: { epicIntent: true } },
  {
    label: "codex attended",
    houseRules: null,
    autopilot: false,
    opts: { agentProvider: "codex" },
  },
  {
    label: "codex autopilot + build queue",
    houseRules: HOUSE_RULES,
    autopilot: true,
    opts: { agentProvider: "codex", buildQueue: "PUT the steps" },
  },
  {
    label: "operator language de",
    houseRules: null,
    autopilot: false,
    opts: { operatorLanguage: "de" },
  },
];

// ── the acceptance invariant: the meter cannot drift from what is sent ───────────────────────────

test("#1999 blocks + separators reconstruct the exact emitted payload", () => {
  for (const c of MATRIX) {
    const payload = composeSystemPrompt(c.houseRules, c.autopilot, c.opts);
    const blocks = composeSystemPromptBlocks(c.houseRules, c.autopilot, c.opts);

    // 1. The parts really do join back into the byte-identical payload.
    expect(joinPromptBlocks(blocks)).toBe(payload);

    // 2. And the RECORDED sizes reconcile to it — per-block sizes plus the separators between them.
    const measured = measurePromptBlocks(blocks);
    const summedChars = measured.blocks.reduce((s, b) => s + b.chars, 0);
    const summedBytes = measured.blocks.reduce((s, b) => s + b.bytes, 0);
    const separators = (blocks.length - 1) * PROMPT_BLOCK_SEPARATOR.length;

    expect(measured.separatorChars).toBe(separators);
    expect(summedChars + separators).toBe(payload.length);
    expect(measured.totalChars).toBe(payload.length);
    expect(summedBytes + separators).toBe(Buffer.byteLength(payload, "utf8"));
    expect(measured.totalBytes).toBe(Buffer.byteLength(payload, "utf8"));
  }
});

test("#1999 every block is named after the tag wrapping it, and names are unique", () => {
  for (const c of MATRIX) {
    const blocks = composeSystemPromptBlocks(c.houseRules, c.autopilot, c.opts);
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) {
      expect(b.name).not.toBe("");
      // The instrument's whole value is that a measurement maps back to its text.
      expect(b.text.startsWith(`<${b.name}>`)).toBe(true);
      expect(b.text.endsWith(`</${b.name}>`)).toBe(true);
    }
    expect(new Set(blocks.map((b) => b.name)).size).toBe(blocks.length);
  }
});

// ── the baseline the epic's deletion slices are scored against ───────────────────────────────────

test("#1999 reproduces the epic's measured spawn-payload baseline (chars)", () => {
  // Issue #1999 / epic #2005 state these in CHARACTERS. Bytes are larger (these blocks are em-dash
  // dense), which is exactly why the instrument records both — see the byte assertions below.
  const baseline: [string, number, string][] = [
    ["attended Claude, no house rules", 8389, "8451"],
    ["+ autopilot", 9347, "9413"],
    ["plan-gate interactive", 13171, "13273"],
    ["research", 6320, "6370"],
  ];
  const payloads = [
    composeSystemPrompt(null, false),
    composeSystemPrompt(null, true),
    composeSystemPrompt(null, true, { planGate: "interactive" }),
    composeSystemPrompt(null, false, { research: true }),
  ];
  payloads.forEach((payload, i) => {
    const [label, chars, bytes] = baseline[i]!;
    const measured = measurePromptBlocks(
      composeSystemPromptBlocks(
        null,
        [false, true, true, false][i]!,
        [{}, {}, { planGate: "interactive" as const }, { research: true }][i]!,
      ),
    );
    expect(`${label}: ${measured.totalChars}`).toBe(`${label}: ${chars}`);
    expect(`${label}: ${measured.totalBytes}`).toBe(`${label}: ${bytes}`);
    expect(measured.totalChars).toBe(payload.length);
  });
});

test("#1999 kitchen sink: house rules + build queue + preview + draft + trim", () => {
  // The epic quotes 12,042 chars for this shape, but that number is NOT reproducible from the issue:
  // it depends on the house-rules text (unstated) and on the build-queue directive, whose length
  // varies with the session id / base URL / token baked into its curl commands. So this pins the
  // measurement to an EXPLICIT fixture instead — reproducible from this test forever after.
  const houseRules = "<shepherd-house-rules>\n- keep it small\n</shepherd-house-rules>";
  const buildQueue = buildQueueDirective({
    sessionId: "00000000-0000-4000-8000-000000000000",
    baseUrl: "http://127.0.0.1:7331",
    token: null,
    autopilot: false,
  });
  const blocks = composeSystemPromptBlocks(houseRules, false, {
    buildQueue,
    previewHint: true,
    draftMode: true,
    trimmed: true,
  });
  const measured = measurePromptBlocks(blocks);
  expect(measured.totalChars).toBe(13408);
  expect(measured.totalChars).toBe(
    composeSystemPrompt(houseRules, false, {
      buildQueue,
      previewHint: true,
      draftMode: true,
      trimmed: true,
    }).length,
  );
});

test("#1999 the unconditional floor is every spawn's standing notices", () => {
  // Research is the leanest spawn shape there is; whatever survives it is the floor the epic's
  // progressive-disclosure slice is aiming at.
  const names = composeSystemPromptBlocks(null, false, { research: true }).map((b) => b.name);
  expect(names).toEqual([
    "engineering-posture",
    "untrusted-content-boundary",
    "research-first-notice",
    "branch-rename-notice",
    "worktree-stash-notice",
    "tmpfs-worktree-notice",
    "research-directive",
  ]);
});

// ── the estimator ────────────────────────────────────────────────────────────────────────────────

test("#1999 token estimate is chars/CHARS_PER_TOKEN, rounded up", () => {
  expect(estimateTokens("")).toBe(0);
  expect(estimateTokens("a")).toBe(1);
  expect(estimateTokens("a".repeat(CHARS_PER_TOKEN))).toBe(1);
  expect(estimateTokens("a".repeat(CHARS_PER_TOKEN + 1))).toBe(2);
  // Totals are the sum of the per-block estimates, not a re-estimate of the joined string.
  const budget = measurePromptBlocks([
    { name: "a", text: "x".repeat(8) },
    { name: "b", text: "y".repeat(4) },
  ]);
  expect(budget.totalTokens).toBe(3);
});

test("#1999 measuring nothing spends nothing", () => {
  expect(measurePromptBlocks([])).toEqual({
    totalChars: 0,
    totalBytes: 0,
    totalTokens: 0,
    separatorChars: 0,
    blocks: [],
  });
});

test("#1999 multi-byte text is counted as chars AND bytes", () => {
  const budget = measurePromptBlocks([{ name: "a", text: "— — —" }]);
  expect(budget.totalChars).toBe(5);
  expect(budget.totalBytes).toBe(11); // three 3-byte em-dashes + two spaces
});

// ── persistence ──────────────────────────────────────────────────────────────────────────────────

const sessionInput = (id: string, desig: string) => ({
  id,
  name: desig,
  prompt: "p",
  repoPath: "/repo",
  baseBranch: "main",
  branch: null,
  worktreePath: "/wt",
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "term_a",
});

const budgetFor = (sessionId: string, createdAt: number, totalChars: number) => ({
  sessionId,
  delivery: "append-system-prompt" as const,
  totalChars,
  totalBytes: totalChars,
  totalTokens: Math.ceil(totalChars / CHARS_PER_TOKEN),
  blocks: [{ name: "engineering-posture", chars: totalChars, bytes: totalChars, tokens: 1 }],
  createdAt,
});

test("#1999 store: upsert replaces, read joins the session", () => {
  const store = new SessionStore(":memory:");
  const s = store.create(sessionInput("s-1", "TASK-1"));

  store.putSessionPromptBudget(budgetFor(s.id, 1000, 8389));
  store.putSessionPromptBudget(budgetFor(s.id, 2000, 6320)); // a relaunch re-measures

  const read = store.getSessionPromptBudget(s.id);
  expect(read?.totalChars).toBe(6320); // replaced, not accumulated
  expect(read?.createdAt).toBe(2000);
  expect(read?.desig).toBe(s.desig);
  expect(read?.repoPath).toBe("/repo");
  expect(read?.agentProvider).toBe("claude");
  expect(read?.auto).toBe(false);
  expect(read?.blocks).toEqual([
    { name: "engineering-posture", chars: 6320, bytes: 6320, tokens: 1 },
  ]);
  expect(store.listSessionPromptBudgets(50).length).toBe(1);
});

test("#1999 store: list is newest-first and hides measurements with no session", () => {
  const store = new SessionStore(":memory:");
  const a = store.create(sessionInput("s-a", "TASK-A"));
  const b = store.create(sessionInput("s-b", "TASK-B"));
  store.putSessionPromptBudget(budgetFor(a.id, 1000, 100));
  store.putSessionPromptBudget(budgetFor(b.id, 2000, 200));
  // A spawn that was assembled and then refused: measured, but no sessions row ever written.
  store.putSessionPromptBudget(budgetFor("never-spawned", 3000, 300));

  const list = store.listSessionPromptBudgets(50);
  expect(list.map((r) => r.sessionId)).toEqual([b.id, a.id]);
  expect(store.getSessionPromptBudget("never-spawned")).toBeNull();
  expect(store.listSessionPromptBudgets(1).map((r) => r.sessionId)).toEqual([b.id]);
});

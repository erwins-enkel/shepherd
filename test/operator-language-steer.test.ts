import { expect, test } from "bun:test";
import { SessionService, operatorLanguageSteerSuffix } from "../src/service";
import { operatorLanguageBlock } from "../src/operator-language";
import { config } from "../src/config";
import type { AgentProvider } from "../src/types";

const BLOCK = operatorLanguageBlock("de")!;

// ── (a) pure operatorLanguageSteerSuffix matrix ──────────────────────────────────────────────
// Only codex+de carries the block; every other cell is byte-empty (Claude gets the block on resume
// via --append-system-prompt, "en" has no directive at all).
test("operatorLanguageSteerSuffix: only codex+de carries the block, else empty", () => {
  expect(operatorLanguageSteerSuffix("codex", "de")).toBe(`\n\n${BLOCK}`);
  expect(operatorLanguageSteerSuffix("codex", "en")).toBe("");
  expect(operatorLanguageSteerSuffix("claude", "de")).toBe("");
  expect(operatorLanguageSteerSuffix("claude", "en")).toBe("");
});

// ── (b) service-level: block-presence on the delivered steer text ────────────────────────────
// The injection lives in replyToLive (below service.reply), so this is the authoritative test for
// the WHOLE Codex steer channel: every internal reply()-routed steer — autopilot proceed/openPr/
// CI-fix/rebase, plan-review/critic, plan-answer, releasePlanGate, preview START/SETUP, retry,
// build-queue RECONCILE/APPROVE, and the auto-merge rebase steer — shares this one code path.

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Real SessionService over a stub store + capturing herdr, with a single live pane. */
function harness(provider: AgentProvider) {
  const sent: string[] = [];
  const session = {
    id: "s1",
    herdrAgentId: "t1",
    repoPath: "/r",
    agentProvider: provider,
  };
  const store = {
    get: () => session,
    addSignal: () => {},
  };
  const svc = new SessionService({
    store: store as any,
    namer: async () => "x",
    worktree: { create: () => ({}) as any, remove: () => {} } as any,
    herdr: {
      start: async () => ({}) as any,
      list: () => [{ terminalId: "t1" }],
      stop: async () => {},
      send: async (_target: string, text: string) => {
        sent.push(text);
      },
    } as any,
  });
  return { svc, sent };
}

/** The bracketed-paste chunk delivered to the PTY (the one carrying the steer text). */
function pastePayload(sent: string[]): string {
  const chunk = sent.find((c) => c.startsWith(PASTE_START));
  expect(chunk).toBeDefined();
  return chunk!.slice(PASTE_START.length, chunk!.length - PASTE_END.length);
}

// A representative internal steer — using the auto-merge rebase steer's shape to make explicit that
// automerge.ts:372 (a distinct rebaseSteer from autopilot's) rides the same central injection.
const STEER =
  "You're in autopilot and your PR has passed review, but it can't merge as-is — rebase.";

test("service.reply appends the operator-language block to a Codex steer when operatorLanguage=de", async () => {
  const prev = config.operatorLanguage;
  config.operatorLanguage = "de";
  try {
    const h = harness("codex");
    expect(await h.svc.reply("s1", STEER)).toBe(true);
    const delivered = pastePayload(h.sent);
    expect(delivered).toBe(`${STEER}\n\n${BLOCK}`);
    expect(delivered).toContain("<operator-language>");
  } finally {
    config.operatorLanguage = prev;
  }
});

test("service.reply leaves a Codex steer byte-identical when operatorLanguage=en", async () => {
  const prev = config.operatorLanguage;
  config.operatorLanguage = "en";
  try {
    const h = harness("codex");
    expect(await h.svc.reply("s1", STEER)).toBe(true);
    expect(pastePayload(h.sent)).toBe(STEER);
  } finally {
    config.operatorLanguage = prev;
  }
});

test("service.reply leaves a Claude steer byte-identical even at operatorLanguage=de (resume-append covers Claude)", async () => {
  const prev = config.operatorLanguage;
  config.operatorLanguage = "de";
  try {
    const h = harness("claude");
    expect(await h.svc.reply("s1", STEER)).toBe(true);
    expect(pastePayload(h.sent)).toBe(STEER);
  } finally {
    config.operatorLanguage = prev;
  }
});

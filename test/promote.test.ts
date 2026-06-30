import { test, expect } from "bun:test";
import * as prettier from "prettier";
import {
  upsertLearningsBlock,
  sanitizeRule,
  formatLearningsBlockForTarget,
  LEARNINGS_START,
  LEARNINGS_END,
} from "../src/promote";

test("upsertLearningsBlock appends a block when none exists", () => {
  const out = upsertLearningsBlock("# Repo\n\nintro\n", ["use bun", "rebase onto main"]);
  expect(out).toContain(LEARNINGS_START);
  expect(out).toContain("- use bun");
  expect(out).toContain("- rebase onto main");
  expect(out.trimEnd().endsWith(LEARNINGS_END)).toBe(true);
});

test("upsertLearningsBlock replaces block contents idempotently", () => {
  const first = upsertLearningsBlock("# Repo\n", ["a"]);
  const second = upsertLearningsBlock(first, ["a"]);
  expect(second).toBe(first); // applying same rules twice is a no-op
  const third = upsertLearningsBlock(first, ["a", "b"]);
  expect(third).toContain("- b");
  // exactly one managed block, never duplicated
  expect(third.split(LEARNINGS_START).length - 1).toBe(1);
  expect(third.split(LEARNINGS_END).length - 1).toBe(1);
});

test("upsertLearningsBlock handles empty file", () => {
  const out = upsertLearningsBlock("", ["only rule"]);
  expect(out.startsWith(LEARNINGS_START)).toBe(true);
});

test("upsertLearningsBlock brackets the list with a blank line on both sides", () => {
  // prettier/CommonMark requires a blank line between the HTML-comment block and an adjacent
  // list — after the start marker AND before the end marker (the latter since prettier 3.9) —
  // else `prettier --check` fails in target repos (flowagent #418).
  const out = upsertLearningsBlock("# Repo\n", ["a", "b"]);
  expect(out).toContain(`${LEARNINGS_START}\n\n- a\n- b\n\n${LEARNINGS_END}`);
});

test("sanitizeRule normalizes whitespace and escapes leading markdown markers", () => {
  expect(sanitizeRule("  hello   world  ")).toBe("hello world");
  expect(sanitizeRule("a\nb\tc")).toBe("a b c");
  expect(sanitizeRule("- dash")).toBe("\\- dash");
  expect(sanitizeRule("* star")).toBe("\\* star");
  expect(sanitizeRule("+ plus")).toBe("\\+ plus");
  expect(sanitizeRule("1. num")).toBe("1\\. num");
  expect(sanitizeRule("2) paren")).toBe("2\\) paren");
  expect(sanitizeRule("# head")).toBe("\\# head");
  expect(sanitizeRule("Use bun.")).toBe("Use bun."); // non-marker text untouched
  // idempotent — re-sanitizing an already-escaped rule is a no-op (matters for the
  // global-accumulate read-back path, which re-emits extracted rules).
  expect(sanitizeRule(sanitizeRule("- dash"))).toBe("\\- dash");
});

// Free-form rule text that would make a naive block prettier-unstable (nested-list
// reinterpretation, whitespace collapse). Includes flowagent #418's real rule.
const PRETTIER_STABILITY_RULES = [
  "Use bun, not npm.",
  "- leading dash rule",
  "* leading asterisk rule",
  "+ leading plus rule",
  "1. leading numbered rule",
  "2) paren numbered rule",
  "# heading-like rule",
  "internal   double   spaces",
  "trailing whitespace here   ",
  "line one\nline two",
  "Use `bun run lint` before push.",
  "Run migrations/backfills/DB tests on local Docker+mocks only, never shared Neon/Aura; scope each mutation to one org via WHERE; shared writes need approval.",
];

test("upsertLearningsBlock output is byte-for-byte prettier-stable (default markdown config)", async () => {
  // Mirror what a target repo's `prettier --check .` does: prettier's Node API with an
  // explicit parser uses only default options (no .prettierrc lookup), so this matches an
  // arbitrary repo's default formatting. A stable (unchanged) result == the block won't
  // re-trip the Lint step. Cover the whole battery in one block, each rule alone, and the
  // empty-base case.
  const blocks = [
    upsertLearningsBlock("# Repo\n\nintro\n", PRETTIER_STABILITY_RULES),
    ...PRETTIER_STABILITY_RULES.map((r) => upsertLearningsBlock("# Repo\n", [r])),
    ...PRETTIER_STABILITY_RULES.map((r) => upsertLearningsBlock("", [r])),
  ];
  for (const content of blocks) {
    const formatted = await prettier.format(content, { parser: "markdown" });
    expect(formatted).toBe(content);
  }
});

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Promoter } from "../src/promote";
import { SessionStore } from "../src/store";

function fakeForge(over: Partial<any> = {}) {
  return {
    kind: "github",
    slug: "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    defaultBranch: async () => "main",
    openPr: async () => ({
      state: "open",
      number: 7,
      url: "https://pr/7",
      checks: "none",
      deployConfigured: false,
    }),
    ...over,
  } as never;
}

test("Promoter.promote opens a PR and marks the rule promoted", async () => {
  const store = new SessionStore(":memory:");
  const l = store.addLearning({
    repoPath: "/r",
    rule: "rebase onto main",
    rationale: "",
    evidence: [],
  });
  store.setLearningStatus(l.id, "active");
  const wtDir = mkdtempSync(join(tmpdir(), "promote-test-"));
  const gitCalls: string[][] = [];
  const removed: string[] = [];

  const p = new Promoter({
    store,
    worktree: {
      create: () => ({
        worktreePath: wtDir,
        branch: "shepherd/learnings-promote-x",
        isolated: true,
      }),
      remove: (path: string) => removed.push(path),
    },
    resolveForge: () => fakeForge(),
    git: async (_cwd, args) => {
      gitCalls.push(args);
    },
  });

  const res = await p.promote(l.id);
  expect(res).toEqual({ ok: true, url: "https://pr/7" });
  expect(store.getLearning(l.id)!.status).toBe("promoted");
  expect(store.getLearning(l.id)!.promotedPrUrl).toBe("https://pr/7");
  expect(readFileSync(join(wtDir, "CLAUDE.md"), "utf8")).toContain("- rebase onto main");
  expect(gitCalls.some((a) => a[0] === "push")).toBe(true);
  expect(removed).toContain(wtDir);
  // local branch force-deleted on cleanup (the pushed remote branch backs the PR)
  expect(gitCalls).toContainEqual(["branch", "-D", "shepherd/learnings-promote-x"]);
});

test("Promoter.promote falls back to the local base ref when origin/<base> is unavailable", async () => {
  const store = new SessionStore(":memory:");
  const l = store.addLearning({ repoPath: "/r", rule: "stay linear", rationale: "", evidence: [] });
  store.setLearningStatus(l.id, "active");
  const wtDir = mkdtempSync(join(tmpdir(), "promote-fallback-"));
  const baseRefs: string[] = [];
  const p = new Promoter({
    store,
    worktree: {
      // origin/main unavailable (offline); local main works — mirrors worktree.create
      // now throwing on an unresolvable base ref rather than returning isolated:false.
      create: (_repo: string, baseRef: string) => {
        baseRefs.push(baseRef);
        if (baseRef !== "main") throw new Error(`invalid reference: ${baseRef}`);
        return { worktreePath: wtDir, branch: "shepherd/fallback", isolated: true };
      },
      remove: () => {},
    },
    resolveForge: () => fakeForge(),
    git: async () => {},
  });
  const res = await p.promote(l.id);
  expect(res.ok).toBe(true);
  // tried origin/<base> first (hygiene), then fell back to the local base ref
  expect(baseRefs).toEqual(["origin/main", "main"]);
  expect(store.getLearning(l.id)!.status).toBe("promoted");
});

test("Promoter.promote rejects non-active rules", async () => {
  const store = new SessionStore(":memory:");
  const l = store.addLearning({ repoPath: "/r", rule: "x", rationale: "", evidence: [] });
  const p = new Promoter({
    store,
    worktree: {
      create: () => ({ worktreePath: "/x", branch: "b", isolated: true }),
      remove: () => {},
    },
    resolveForge: () => fakeForge(),
    git: async () => {},
  });
  const res = await p.promote(l.id);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.status).toBe(409);
});

test("Promoter.promote 400s when no forge configured", async () => {
  const store = new SessionStore(":memory:");
  const l = store.addLearning({ repoPath: "/r", rule: "x", rationale: "", evidence: [] });
  store.setLearningStatus(l.id, "active");
  const p = new Promoter({
    store,
    worktree: {
      create: () => ({ worktreePath: "/x", branch: "b", isolated: true }),
      remove: () => {},
    },
    resolveForge: () => null,
    git: async () => {},
  });
  const res = await p.promote(l.id);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.status).toBe(400);
});

test("Promoter.promote returns a generic 500 (not raw git stderr) on failure", async () => {
  const store = new SessionStore(":memory:");
  const l = store.addLearning({ repoPath: "/r", rule: "y", rationale: "", evidence: [] });
  store.setLearningStatus(l.id, "active");
  const wtDir = mkdtempSync(join(tmpdir(), "promote-fail-"));
  const p = new Promoter({
    store,
    worktree: {
      create: () => ({ worktreePath: wtDir, branch: "shepherd/x", isolated: true }),
      remove: () => {},
    },
    resolveForge: () => fakeForge(),
    git: async (_cwd, args) => {
      if (args[0] === "push") throw new Error("fatal: remote rejected [secret-token-in-stderr]");
    },
  });
  const res = await p.promote(l.id);
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.status).toBe(500);
    expect(res.error).toBe("promote failed"); // no raw stderr leaked to the client
  }
  // rule stays active (not wedged) so a retry can succeed
  expect(store.getLearning(l.id)!.status).toBe("active");
});

test("Promoter.promote rejects a concurrent double-click with 409", async () => {
  const store = new SessionStore(":memory:");
  const l = store.addLearning({ repoPath: "/r", rule: "z", rationale: "", evidence: [] });
  store.setLearningStatus(l.id, "active");
  const wtDir = mkdtempSync(join(tmpdir(), "promote-race-"));
  let releaseForge: () => void = () => {};
  const gate = new Promise<void>((resolve) => (releaseForge = resolve));
  const p = new Promoter({
    store,
    worktree: {
      create: () => ({ worktreePath: wtDir, branch: "shepherd/z", isolated: true }),
      remove: () => {},
    },
    // hold the first promote inside its first await so the second click overlaps it
    resolveForge: () => fakeForge({ defaultBranch: async () => (await gate, "main") }),
    git: async () => {},
  });
  const first = p.promote(l.id);
  const second = await p.promote(l.id); // claim was synchronous → this sees in-flight
  expect(second.ok).toBe(false);
  if (!second.ok) expect(second.status).toBe(409);
  releaseForge();
  const firstRes = await first;
  expect(firstRes.ok).toBe(true);
});

// --- resyncPromoted tests ---

test("Promoter.resyncPromoted rebuilds block and opens a PR", async () => {
  const store = new SessionStore(":memory:");
  const l1 = store.addLearning({
    repoPath: "/repo",
    rule: "rule one",
    rationale: "",
    evidence: [],
  });
  const l2 = store.addLearning({
    repoPath: "/repo",
    rule: "rule two",
    rationale: "",
    evidence: [],
  });
  store.setLearningStatus(l1.id, "active");
  store.setLearningStatus(l1.id, "promoted");
  store.setLearningStatus(l2.id, "active");
  store.setLearningStatus(l2.id, "promoted");

  const wtDir = mkdtempSync(join(tmpdir(), "resync-test-"));
  const gitCalls: string[][] = [];
  const removed: string[] = [];
  let prOpened = false;

  const p = new Promoter({
    store,
    worktree: {
      create: () => ({ worktreePath: wtDir, branch: "learnings-resync-abcd1234", isolated: true }),
      remove: (path: string) => removed.push(path),
    },
    resolveForge: () =>
      fakeForge({
        openPr: async () => {
          prOpened = true;
          return {
            state: "open",
            number: 8,
            url: "https://pr/8",
            checks: "none",
            deployConfigured: false,
          };
        },
      }),
    git: async (_cwd, args) => {
      gitCalls.push(args);
    },
    // start with stale CLAUDE.md (no learnings block)
    readClaudeMd: () => "# Repo\n\nsome existing content\n",
    writeClaudeMd: () => {},
  });

  const res = await p.resyncPromoted("/repo");
  expect(res).toEqual({ ok: true, url: "https://pr/8" });
  expect(prOpened).toBe(true);
  expect(gitCalls.some((a) => a[0] === "commit")).toBe(true);
  expect(gitCalls.some((a) => a[0] === "push")).toBe(true);
  // no DB status transition — rules stay promoted
  expect(store.getLearning(l1.id)!.status).toBe("promoted");
  expect(store.getLearning(l2.id)!.status).toBe("promoted");
  // cleanup ran
  expect(removed).toContain(wtDir);
});

test("Promoter.resyncPromoted dedups two promoted rules that collapse to one sanitized bullet", async () => {
  const store = new SessionStore(":memory:");
  // Distinct raw rules that sanitize to the same bullet ("\- dash"): raw-space dedup would
  // keep both and emit a duplicate; sanitized-space dedup collapses them to one.
  for (const rule of ["- dash", "-  dash"]) {
    const l = store.addLearning({ repoPath: "/repo-dup", rule, rationale: "", evidence: [] });
    store.setLearningStatus(l.id, "active");
    store.setLearningStatus(l.id, "promoted");
  }
  const wtDir = mkdtempSync(join(tmpdir(), "resync-dedup-"));
  let written = "";
  const p = new Promoter({
    store,
    worktree: {
      create: () => ({ worktreePath: wtDir, branch: "learnings-resync-dedup", isolated: true }),
      remove: () => {},
    },
    resolveForge: () => fakeForge(),
    git: async () => {},
    readClaudeMd: () => "# Repo\n",
    writeClaudeMd: (_p, c) => {
      written = c;
    },
  });
  const res = await p.resyncPromoted("/repo-dup");
  expect(res.ok).toBe(true);
  expect(extractLearningsBlockRules(written)).toEqual(["\\- dash"]); // exactly one bullet
});

test("Promoter.resyncPromoted is a no-op when CLAUDE.md already has the current block", async () => {
  const store = new SessionStore(":memory:");
  const l = store.addLearning({
    repoPath: "/repo2",
    rule: "stay linear",
    rationale: "",
    evidence: [],
  });
  store.setLearningStatus(l.id, "active");
  store.setLearningStatus(l.id, "promoted");

  const gitCalls: string[][] = [];
  let prOpened = false;

  // Precompute what the block should look like
  const { upsertLearningsBlock: ulb } = await import("../src/promote");
  const upToDate = ulb("# Repo\n\n", ["stay linear"]);

  const p = new Promoter({
    store,
    worktree: {
      create: () => ({ worktreePath: "/wt2", branch: "learnings-resync-xyz", isolated: true }),
      remove: () => {},
    },
    resolveForge: () =>
      fakeForge({
        openPr: async () => {
          prOpened = true;
          return {
            state: "open",
            number: 9,
            url: "https://pr/9",
            checks: "none",
            deployConfigured: false,
          };
        },
      }),
    git: async (_cwd, args) => {
      gitCalls.push(args);
    },
    readClaudeMd: () => upToDate,
    writeClaudeMd: () => {},
  });

  const res = await p.resyncPromoted("/repo2");
  expect(res).toEqual({ ok: true, url: "" });
  expect(prOpened).toBe(false);
  expect(gitCalls.some((a) => a[0] === "commit")).toBe(false);
});

test("Promoter.resyncPromoted returns no-op when no promoted rules exist", async () => {
  const store = new SessionStore(":memory:");
  // no learnings added for /repo3
  let worktreeCreated = false;

  const p = new Promoter({
    store,
    worktree: {
      create: () => {
        worktreeCreated = true;
        return { worktreePath: "/wt3", branch: "b", isolated: true };
      },
      remove: () => {},
    },
    resolveForge: () => fakeForge(),
    git: async () => {},
  });

  const res = await p.resyncPromoted("/repo3");
  expect(res).toEqual({ ok: true, url: "" });
  expect(worktreeCreated).toBe(false);
});

test("Promoter.resyncPromoted rejects a concurrent call for the same repo with 409", async () => {
  const store = new SessionStore(":memory:");
  const l = store.addLearning({ repoPath: "/repo4", rule: "rule x", rationale: "", evidence: [] });
  store.setLearningStatus(l.id, "active");
  store.setLearningStatus(l.id, "promoted");

  const wtDir = mkdtempSync(join(tmpdir(), "resync-race-"));
  let releaseForge: () => void = () => {};
  const gate = new Promise<void>((resolve) => (releaseForge = resolve));

  const p = new Promoter({
    store,
    worktree: {
      create: () => ({ worktreePath: wtDir, branch: "learnings-resync-racetest", isolated: true }),
      remove: () => {},
    },
    resolveForge: () => fakeForge({ defaultBranch: async () => (await gate, "main") }),
    git: async () => {},
    readClaudeMd: () => "",
    writeClaudeMd: () => {},
  });

  const first = p.resyncPromoted("/repo4");
  const second = await p.resyncPromoted("/repo4"); // inflight → 409
  expect(second.ok).toBe(false);
  if (!second.ok) expect(second.status).toBe(409);
  releaseForge();
  const firstRes = await first;
  expect(firstRes.ok).toBe(true);
});

// --- lightweight repo mode guard tests ---

test("Promoter.promote returns 400 with lightweight message for local forge and never calls openPr", async () => {
  const store = new SessionStore(":memory:");
  const l = store.addLearning({ repoPath: "/r", rule: "x", rationale: "", evidence: [] });
  store.setLearningStatus(l.id, "active");
  let openPrCalled = false;
  const localForge = fakeForge({
    kind: "local",
    openPr: async () => {
      openPrCalled = true;
      return { state: "open", number: 1, url: "u", checks: "none", deployConfigured: false };
    },
  });
  const p = new Promoter({
    store,
    worktree: {
      create: () => ({ worktreePath: "/x", branch: "b", isolated: true }),
      remove: () => {},
    },
    resolveForge: () => localForge,
    git: async () => {},
  });
  const res = await p.promote(l.id);
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.status).toBe(400);
    expect(res.error).toBe("learnings promotion is not available in lightweight repo mode");
  }
  expect(openPrCalled).toBe(false);
  // rule stays active (never wedged to promoted without a real PR)
  expect(store.getLearning(l.id)!.status).toBe("active");
});

test("Promoter.resyncPromoted returns 400 with lightweight message for local forge and never calls openPr", async () => {
  const store = new SessionStore(":memory:");
  const l = store.addLearning({ repoPath: "/repo5", rule: "rule a", rationale: "", evidence: [] });
  store.setLearningStatus(l.id, "active");
  store.setLearningStatus(l.id, "promoted");
  let openPrCalled = false;
  const localForge = fakeForge({
    kind: "local",
    openPr: async () => {
      openPrCalled = true;
      return { state: "open", number: 2, url: "u", checks: "none", deployConfigured: false };
    },
  });
  let worktreeCreated = false;
  const p = new Promoter({
    store,
    worktree: {
      create: () => {
        worktreeCreated = true;
        return { worktreePath: "/wt5", branch: "b", isolated: true };
      },
      remove: () => {},
    },
    resolveForge: () => localForge,
    git: async () => {},
  });
  const res = await p.resyncPromoted("/repo5");
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.status).toBe(400);
    expect(res.error).toBe("learnings promotion is not available in lightweight repo mode");
  }
  expect(openPrCalled).toBe(false);
  expect(worktreeCreated).toBe(false);
});

// --- extractLearningsBlockRules + promoteGlobal (issue #872) ---

import { extractLearningsBlockRules } from "../src/promote";

test("extractLearningsBlockRules returns [] when there is no managed block", () => {
  expect(extractLearningsBlockRules("# Repo\n\nhello\n")).toEqual([]);
  expect(extractLearningsBlockRules("")).toEqual([]);
});

test("extractLearningsBlockRules parses bullets and round-trips upsertLearningsBlock", () => {
  const content = upsertLearningsBlock("# Repo\n", ["use bun", "rebase onto main"]);
  expect(extractLearningsBlockRules(content)).toEqual(["use bun", "rebase onto main"]);
});

test("extractLearningsBlockRules tolerates CRLF + leading whitespace and ignores prose", () => {
  const block = [
    LEARNINGS_START,
    "  - indented rule",
    "- normal rule",
    "some prose line", // no bullet → ignored (block is Shepherd-owned)
    "",
    LEARNINGS_END,
  ].join("\r\n");
  const content = "# Repo\r\n\r\n" + block + "\r\n";
  expect(extractLearningsBlockRules(content)).toEqual(["indented rule", "normal rule"]);
});

/** Promoter wired only for global writes: store/worktree/forge are unused by promoteGlobal.
 *  Injected CLAUDE.md IO operates on `state` so the real ~/.claude is never touched. */
function globalPromoter(state: { content: string; writes: string[] }) {
  return new Promoter({
    store: new SessionStore(":memory:"),
    worktree: {
      create: () => {
        throw new Error("worktree unused by promoteGlobal");
      },
      remove: () => {},
    },
    resolveForge: () => null,
    git: async () => {},
    readClaudeMd: () => state.content,
    writeClaudeMd: (_p, c) => {
      state.content = c;
      state.writes.push(c);
    },
  });
}

test("promoteGlobal writes a fresh block when the global file is empty", async () => {
  const state = { content: "", writes: [] as string[] };
  const res = await globalPromoter(state).promoteGlobal("always rebase onto main");
  expect(res.ok).toBe(true);
  expect(state.writes.length).toBe(1);
  expect(extractLearningsBlockRules(state.writes[0]!)).toEqual(["always rebase onto main"]);
});

test("promoteGlobal accumulates onto the existing block (dedup, order-preserving)", async () => {
  const existing = upsertLearningsBlock("# Global\n\nintro\n", ["rule a"]);
  const state = { content: existing, writes: [] as string[] };
  const res = await globalPromoter(state).promoteGlobal("rule b");
  expect(res.ok).toBe(true);
  expect(extractLearningsBlockRules(state.writes[0]!)).toEqual(["rule a", "rule b"]);
  expect(state.writes[0]).toContain("intro"); // content outside the block is preserved
});

test("promoteGlobal is an idempotent no-op when the rule is already present", async () => {
  const existing = upsertLearningsBlock("", ["rule a"]);
  const state = { content: existing, writes: [] as string[] };
  const res = await globalPromoter(state).promoteGlobal("rule a");
  expect(res.ok).toBe(true);
  expect(state.writes.length).toBe(0); // already current → nothing written
});

test("promoteGlobal re-promote of a sanitize-altered rule is an idempotent no-op", async () => {
  // The stored block holds the *sanitized* form ("\- dash"); the incoming raw "- dash" must
  // dedup against it, not write a second bullet. (Plain "rule a" wouldn't catch this — sanitize
  // leaves it unchanged.)
  const existing = upsertLearningsBlock("", ["- dash"]);
  expect(extractLearningsBlockRules(existing)).toEqual(["\\- dash"]);
  const state = { content: existing, writes: [] as string[] };
  const res = await globalPromoter(state).promoteGlobal("- dash");
  expect(res.ok).toBe(true);
  expect(state.writes.length).toBe(0); // already current → no duplicate bullet, no write
});

test("promoteGlobal returns a structured 500 (not a throw) on an fs failure", async () => {
  const p = new Promoter({
    store: new SessionStore(":memory:"),
    worktree: {
      create: () => {
        throw new Error("unused");
      },
      remove: () => {},
    },
    resolveForge: () => null,
    git: async () => {},
    writeClaudeMd: () => {},
    readClaudeMd: () => {
      throw new Error("EACCES: permission denied, open '/root/.claude/CLAUDE.md'");
    },
  });
  const res = await p.promoteGlobal("a rule");
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.status).toBe(500);
    expect(res.error).toBe("global promote failed"); // no raw fs stderr leaked
  }
});

// ── formatLearningsBlockForTarget (#935: prettier-stable under proseWrap:"always") ───────────

const PROSE_WRAP_CFG = { proseWrap: "always", printWidth: 40 };
// Long enough to force prettier to wrap a bullet across printWidth:40 — exercises the
// wrap × leading-marker-escape × mid-line-token interaction, not just one generic long rule.
const WRAP_TAIL =
  " and then a good deal of extra trailing prose so prettier reflows this bullet across the configured print width";

function tmpRepoWithPrettier(cfg: object | null): string {
  const dir = mkdtempSync(join(tmpdir(), "promote-prosewrap-"));
  if (cfg) writeFileSync(join(dir, ".prettierrc"), JSON.stringify(cfg));
  return dir;
}

const blockSlice = (s: string) =>
  s.slice(s.indexOf(LEARNINGS_START), s.indexOf(LEARNINGS_END) + LEARNINGS_END.length);

test("formatLearningsBlockForTarget: proseWrap:always block passes whole-file prettier --check (full battery)", async () => {
  const claudePath = join(tmpRepoWithPrettier(PROSE_WRAP_CFG), "CLAUDE.md");
  const cfg = await prettier.resolveConfig(claudePath, { useCache: false });
  expect(cfg?.proseWrap).toBe("always");

  // Pre-canonicalize the surrounding prose so any whole-file diff is attributable to our block.
  const before = await prettier.format("# Project\n\nShort intro line.\n", {
    ...cfg,
    parser: "markdown",
  });
  const after = await prettier.format("## Notes\n\nShort outro line.\n", {
    ...cfg,
    parser: "markdown",
  });

  for (const base of PRETTIER_STABILITY_RULES) {
    const rule = base + WRAP_TAIL;
    const full = upsertLearningsBlock(before, [rule]) + "\n" + after;
    const result = await formatLearningsBlockForTarget(claudePath, full);

    // The bullet actually wrapped (start marker + ≥2 bullet lines) — confirms wrapping was exercised.
    const nonEmpty = blockSlice(result)
      .split("\n")
      .filter((l) => l.trim().length > 0);
    expect(nonEmpty.length).toBeGreaterThan(3);

    // Whole-file `prettier --check` is a byte-for-byte no-op: passes in context, escaping + tokens intact.
    expect(await prettier.format(result, { ...cfg, parser: "markdown" })).toBe(result);
    // And the helper reproduces prettier's own whole-file output.
    expect(result).toBe(await prettier.format(full, { ...cfg, parser: "markdown" }));
  }
});

test("formatLearningsBlockForTarget: block stays prettier-clean even when surrounding prose is dirty", async () => {
  const claudePath = join(tmpRepoWithPrettier(PROSE_WRAP_CFG), "CLAUDE.md");
  const cfg = await prettier.resolveConfig(claudePath, { useCache: false });

  // Deliberately NON-canonical surroundings: a long unwrapped paragraph prettier WOULD reflow.
  const dirtyBefore =
    "# Project\n\nThis surrounding paragraph is left deliberately unwrapped and far longer than the narrow print width so prettier would reflow it.\n";
  const full = upsertLearningsBlock(dirtyBefore, [
    "Run `bun run lint` before every push" + WRAP_TAIL,
  ]);
  const result = await formatLearningsBlockForTarget(claudePath, full);

  const wholeFormatted = await prettier.format(result, { ...cfg, parser: "markdown" });
  // Our block is already canonical — a whole-file pass does not touch it...
  expect(blockSlice(wholeFormatted)).toBe(blockSlice(result));
  // ...even though it DOES reflow the dirty surrounding prose (the clean-surroundings precondition
  // is about the user's content, never our block).
  expect(wholeFormatted).not.toBe(result);
});

test("formatLearningsBlockForTarget: idempotent under re-run and external reformat (no churn on resync)", async () => {
  const claudePath = join(tmpRepoWithPrettier(PROSE_WRAP_CFG), "CLAUDE.md");
  const cfg = await prettier.resolveConfig(claudePath, { useCache: false });
  const before = await prettier.format("# Project\n\nShort intro line.\n", {
    ...cfg,
    parser: "markdown",
  });
  const rule = "Use `bun run lint` before push" + WRAP_TAIL;
  const result = await formatLearningsBlockForTarget(
    claudePath,
    upsertLearningsBlock(before, [rule]),
  );

  // Re-running the helper is a no-op.
  expect(await formatLearningsBlockForTarget(claudePath, result)).toBe(result);
  // A faithful resync round-trip (regenerate single-line block from the same rule, re-stabilize)
  // reproduces identical bytes → next === current → no churn PR.
  expect(
    await formatLearningsBlockForTarget(claudePath, upsertLearningsBlock(result, [rule])),
  ).toBe(result);
  // An external whole-file prettier pass (e.g. a target CI that auto-formats) is also a no-op.
  expect(await prettier.format(result, { ...cfg, parser: "markdown" })).toBe(result);
});

test("formatLearningsBlockForTarget: pass-through when no config / proseWrap not 'always'", async () => {
  const content = upsertLearningsBlock("# Repo\n", ["Use bun, not npm" + WRAP_TAIL]);

  // No .prettierrc at all → unchanged.
  expect(
    await formatLearningsBlockForTarget(join(tmpRepoWithPrettier(null), "CLAUDE.md"), content),
  ).toBe(content);
  // proseWrap:"preserve" (default) → unchanged.
  expect(
    await formatLearningsBlockForTarget(
      join(tmpRepoWithPrettier({ proseWrap: "preserve", printWidth: 40 }), "CLAUDE.md"),
      content,
    ),
  ).toBe(content);
  // proseWrap:"never" → unchanged (our bullet is already single-line).
  expect(
    await formatLearningsBlockForTarget(
      join(tmpRepoWithPrettier({ proseWrap: "never", printWidth: 40 }), "CLAUDE.md"),
      content,
    ),
  ).toBe(content);
});

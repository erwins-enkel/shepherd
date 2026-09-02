#!/usr/bin/env bun
// Rendered-prompt fingerprints (issue #2156) — the PR gate's trigger.
//
// WHY NOT PATHS: `src/plan-gate.ts`, `src/critic-core.ts` and `src/rundown-core.ts` are busy
// service modules (45 / 20 / 15 commits in a recent three-month window — roughly 25 PRs a month),
// and almost none of that churn touches the prompt text. A path-triggered eval would spend $1-2 on
// nearly every one of those PRs. So the gate triggers on what actually matters: a change to the
// RENDERED PROMPT.
//
// Each builder is rendered over a fixed set of canonical inputs chosen to exercise its conditional
// blocks, normalized, and hashed. `.github/workflows/eval-prompts.yml` compares this file against
// the PR base's copy and runs only the evals whose hash moved.
//
// NORMALIZATION IS LOAD-BEARING. Every builder calls `fenceUntrusted` WITHOUT a nonce, so each
// render embeds fresh 12-hex `randomFenceToken()` values and a raw hash would differ on every run —
// the freshness gate would fail on a clean tree, permanently. `normalizeRender` therefore rewrites
// NONCE-SHAPED fence markers only. It deliberately does NOT reuse `untrusted.ts`'s own
// `FENCE_TOKEN_RE` (`/⟦\/?UNTRUSTED:[^⟧]*⟧/g`): that pattern also matches the bare `⟦UNTRUSTED:…⟧`
// markers QUOTED inside `UNTRUSTED_CONTENT_DIRECTIVE`, so using it would blank the directive's own
// prose and make edits to it invisible to the hash — silently losing the property that an edit to
// the directive re-gates all four evals. Requiring the `:<12 hex>` segment leaves them intact.
//
// Usage:
//   bun run gen:eval-fingerprints            # rewrite scripts/eval-fingerprints.json
//   bun run check:eval-fingerprints          # regenerate in memory, fail on drift (CI)

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { classifierPrompt } from "../src/autopilot-classify-core";
import { planReviewPrompt } from "../src/plan-gate";
import { prReviewPrompt, reviewPrompt } from "../src/critic-core";
import { buildRundownPrompt } from "../src/rundown-core";
import type { AssembledHerdState } from "../src/rundown-core";

export const FINGERPRINTS_PATH = join(import.meta.dir, "eval-fingerprints.json");

/** Matches a fence marker that carries a random nonce: `⟦UNTRUSTED:<label>:<12 hex>⟧` (and its
 *  closing `⟦/UNTRUSTED:…⟧` form). The `:<12 hex>` tail is what distinguishes a REAL fence from the
 *  bare markers quoted inside `UNTRUSTED_CONTENT_DIRECTIVE`, which must survive normalization. */
const NONCE_MARKER_RE = /⟦(\/?)UNTRUSTED:([^:⟧]*):[0-9a-f]{12}⟧/g;

/** Replace every per-render nonce with a fixed placeholder, leaving all other bytes untouched. */
export function normalizeRender(text: string): string {
  return text.replace(NONCE_MARKER_RE, "⟦$1UNTRUSTED:$2:<nonce>⟧");
}

/** One canonical render: a name (for drift diagnostics) and a thunk producing the prompt. */
interface Case {
  name: string;
  render: () => string;
}

// --- canonical inputs -------------------------------------------------------
// Small and fixed. Their CONTENT does not matter; their COVERAGE does — every conditional block in
// a builder must be exercised by at least one case, or an edit inside that block moves no hash.

const TASK = "Add a --since flag to the usage report.";
const PLAN = "## Goal\nScope the report to a date range.\n\n## Out of scope\n- --until.";
const ISSUE = "The report always covers all time, which makes week-over-week comparison manual.";
const PRIOR = ["scripts/usage-report.ts: the cutoff is compared as a string, not a timestamp."];
const NOTES = ["Reworked the cutoff to compare timestamps."];
const TAIL = ["The rate limiter is implemented and the tests pass.", "Ready to commit now? (y/n)"];
const DIFF_BASE = "origin/main";

const REVIEW_POLICY = "# REVIEW.md\n\nPrefer small PRs. Flag any new dependency.";
const HOUSE_RULES =
  "<shepherd-house-rules>\n- Guard every plan-phase branch.\n</shepherd-house-rules>";

/** Hold reason, so `renderHold` — which rewrites a session's `hold` into a `why` line — is
 *  exercised. Untouched by any other case, so an edit to its prose would otherwise move no hash. */
const HOLD = { code: "plan-question" as const };

const EPIC = {
  base: "epic/2156-eval-harness",
  baseSha: "0f1e2d3c4b5a69788796a5b4c3d2e1f000112233",
  delta: {
    paths: ["src/plan-gate.ts", "src/critic-core.ts"],
    pathsTruncated: 3,
    commits: ["feat(plan-gate): findings routing"],
    commitsTruncated: 1,
  },
};

const RUNDOWN_STATE: AssembledHerdState = {
  generatedFor: "2026-01-01T00:00:00.000Z",
  overnightDelta: { mergedPrs: [1, 2], archivedSessions: [{ id: "s-1", desig: "AAA" }] },
  sessions: [
    {
      desig: "AAA",
      sessionId: "s-1",
      repo: "/repo",
      tier: 1,
      signals: ["blocked-decision"],
      ageMs: 3600_000,
      backlogRank: 0,
      prNumber: 7,
    },
  ],
  epics: [],
  truncatedTier2: 0,
  truncatedTier3: 0,
};

const RUNDOWN_STATE_FULL: AssembledHerdState = {
  ...RUNDOWN_STATE,
  // Covers all three epic renderings (paused / ready / CI-failing) plus the truncation notice.
  epics: [
    {
      repo: "/repo",
      parent: 10,
      title: "Paused",
      landingPr: 11,
      stranded: false,
      pausedReason: "cap",
    },
    { repo: "/repo", parent: 20, title: "Ready", landingPr: 21, stranded: true },
    { repo: "/repo", parent: 30, title: "Red", landingPr: 31, stranded: false, ciFailing: true },
  ],
  truncatedTier2: 2,
  truncatedTier3: 5,
};

/**
 * The canonical render set, per eval. Coverage notes name the conditional block each case exists
 * for — when a builder grows a new conditional block, add a case here so edits inside it move the
 * hash, or that prose can be rewritten with the freshness gate staying green and the eval never
 * running. `test/eval-core.test.ts` CHECKS this invariant rather than trusting it: it asserts that
 * a string from each named block actually appears in some render.
 */
export const CASES: Record<string, Case[]> = {
  "stop-classifier": [
    { name: "en", render: () => classifierPrompt(TAIL, TASK, "en") },
    // The operator-language directive (#1627).
    { name: "de", render: () => classifierPrompt(TAIL, TASK, "de") },
  ],
  "plan-gate": [
    // No anchor -> the degraded LOCATION-REFERENCES tier; no issue, no prior findings, no round.
    { name: "minimal", render: () => planReviewPrompt(TASK, PLAN) },
    // Strong tier (ahead 0) — a structurally different location block.
    {
      name: "anchor-current",
      render: () =>
        planReviewPrompt(TASK, PLAN, [], ISSUE, "en", { sha: "a".repeat(40), ahead: 0 }, null),
    },
    // Ahead tier + staleness + re-review + the ROUND block + the clamp note.
    {
      name: "full",
      render: () =>
        planReviewPrompt(
          TASK,
          PLAN,
          PRIOR,
          ISSUE,
          "en",
          { sha: "b".repeat(40), ahead: 3 },
          { behind: 4, changedSince: ["src/store.ts"], more: 2 },
          { round: 5, cap: 12, planClamped: true },
        ),
    },
    // The German operator-language block.
    { name: "de", render: () => planReviewPrompt(TASK, PLAN, [], null, "de") },
  ],
  critic: [
    { name: "session-minimal", render: () => reviewPrompt(DIFF_BASE, TASK) },
    // #2154's two repo-policy blocks: reviewPolicyBlock and reviewerHouseRulesBlock. Neither is
    // reachable from any other case, so without this an edit to either renders no hash change.
    {
      name: "session-repo-policy",
      render: () =>
        reviewPrompt(DIFF_BASE, TASK, [], [], null, null, {
          reviewPolicy: REVIEW_POLICY,
          houseRules: HOUSE_RULES,
        }),
    },
    // epicBlock has THREE mutually exclusive headers, keyed on the base delta. `session-full`
    // covers the known-stale one; these cover current-with-base and could-not-enumerate.
    {
      name: "session-epic-current",
      render: () =>
        reviewPrompt(DIFF_BASE, TASK, [], [], null, {
          ...EPIC,
          delta: { paths: [], pathsTruncated: 0, commits: [], commitsTruncated: 0 },
        }),
    },
    {
      name: "session-epic-unknown-delta",
      render: () => reviewPrompt(DIFF_BASE, TASK, [], [], null, { ...EPIC, delta: null }),
    },
    // baseSha null -> the degraded mode that drops the base-inspection machinery entirely.
    {
      name: "session-epic-no-base-sha",
      render: () =>
        reviewPrompt(DIFF_BASE, TASK, [], [], null, { ...EPIC, baseSha: null, delta: null }),
    },
    // Plan block + clamp note + prior findings + author notes + issue + epic + round + smell lens.
    {
      name: "session-full",
      render: () =>
        reviewPrompt(DIFF_BASE, TASK, PRIOR, NOTES, ISSUE, EPIC, {
          plan: PLAN,
          smellLens: true,
          round: 5,
          cap: 12,
          planClamped: true,
        }),
    },
    { name: "pr-minimal", render: () => prReviewPrompt(DIFF_BASE, "Add --since", "") },
    {
      name: "pr-repo-policy",
      render: () =>
        prReviewPrompt(DIFF_BASE, "Add --since", ISSUE, null, null, {
          reviewPolicy: REVIEW_POLICY,
          houseRules: HOUSE_RULES,
        }),
    },
    // The epic-child block on the standalone critic.
    { name: "pr-epic", render: () => prReviewPrompt(DIFF_BASE, "Add --since", ISSUE, EPIC, null) },
    // The mutually-exclusive landing block.
    {
      name: "pr-landing",
      render: () =>
        prReviewPrompt(DIFF_BASE, "Land epic", ISSUE, null, {
          integrationBranch: "epic/2156-eval-harness",
          childCount: 4,
        }),
    },
  ],
  rundown: [
    { name: "minimal", render: () => buildRundownPrompt(RUNDOWN_STATE, "en") },
    // Epic blocks (paused / ready / CI-failing) + the truncation notice.
    { name: "full", render: () => buildRundownPrompt(RUNDOWN_STATE_FULL, "en") },
    // pauseReasonLabel has three strings and RUNDOWN_STATE_FULL only reaches "cap"; a held session
    // reaches renderHold. Both are used by the fixture set, so both must move a hash when edited.
    {
      name: "pause-reasons-and-hold",
      render: () =>
        buildRundownPrompt(
          {
            ...RUNDOWN_STATE_FULL,
            sessions: [{ ...RUNDOWN_STATE.sessions[0]!, hold: HOLD }],
            epics: [
              {
                repo: "/repo",
                parent: 40,
                title: "Conflict",
                landingPr: 41,
                stranded: false,
                pausedReason: "conflict",
              },
              {
                repo: "/repo",
                parent: 50,
                title: "Driver",
                landingPr: 51,
                stranded: false,
                pausedReason: "driver",
              },
            ],
          },
          "en",
        ),
    },
    { name: "de", render: () => buildRundownPrompt(RUNDOWN_STATE_FULL, "de") },
  ],
};

/**
 * Fingerprint one eval: render every canonical case TWICE, assert the normalized text is identical
 * (so any future nondeterminism fails loudly here rather than quietly redding the freshness gate),
 * and hash the concatenation.
 */
export function fingerprint(evalName: string): string {
  const cases = CASES[evalName];
  if (!cases) throw new Error(`no canonical cases for eval "${evalName}"`);
  const hash = createHash("sha256");
  for (const c of cases) {
    const first = normalizeRender(c.render());
    const second = normalizeRender(c.render());
    if (first !== second) {
      throw new Error(
        `non-deterministic render for ${evalName}/${c.name} after normalization — a new source of ` +
          `per-render randomness needs handling in normalizeRender()`,
      );
    }
    hash.update(`${evalName}/${c.name}\n${first}\n`);
  }
  return hash.digest("hex");
}

export function fingerprintAll(): Record<string, string> {
  return Object.fromEntries(Object.keys(CASES).map((name) => [name, fingerprint(name)]));
}

/**
 * Which evals must run for a PR: every eval whose rendered fingerprint differs from the base's
 * committed one. An eval MISSING from `base` counts as changed (the fingerprint file did not exist
 * there, so nothing is known about its prompt) — fail-open, because skipping a gate on unknown
 * state is the one outcome worth paying to avoid. PURE.
 */
export function changedEvals(base: Record<string, string>, head: Record<string, string>): string[] {
  return Object.keys(head).filter((name) => base[name] !== head[name]);
}

function serialize(fingerprints: Record<string, string>): string {
  return `${JSON.stringify(fingerprints, null, 2)}\n`;
}

/** Read a fingerprint JSON file, or `{}` when it is missing/unreadable/malformed. */
function readFingerprints(path: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

function main(): void {
  // `--changed <base.json>`: print the evals whose prompt changed vs that base, one per line.
  // Compared against the FRESHLY RENDERED head fingerprints, not the committed file, so a stale
  // commit cannot talk the gate out of running.
  const changedAt = process.argv.indexOf("--changed");
  if (changedAt !== -1) {
    const basePath = process.argv[changedAt + 1];
    if (!basePath) {
      console.error("[gen-eval-fingerprints] --changed needs a path to the base fingerprints file");
      process.exit(2);
    }
    for (const name of changedEvals(readFingerprints(basePath), fingerprintAll())) {
      console.log(name);
    }
    return;
  }

  const check = process.argv.includes("--check");
  const next = serialize(fingerprintAll());
  if (!check) {
    writeFileSync(FINGERPRINTS_PATH, next);
    console.log(`[gen-eval-fingerprints] wrote ${FINGERPRINTS_PATH}`);
    return;
  }
  let current = "";
  try {
    current = readFileSync(FINGERPRINTS_PATH, "utf8");
  } catch {
    console.error(
      "[gen-eval-fingerprints] scripts/eval-fingerprints.json is missing — run `bun run gen:eval-fingerprints`.",
    );
    process.exit(1);
  }
  if (current !== next) {
    console.error(
      "[gen-eval-fingerprints] prompt fingerprints are stale — a prompt builder changed without " +
        "regenerating. Run `bun run gen:eval-fingerprints` and commit the result.\n" +
        `committed: ${current.trim()}\nrendered:  ${next.trim()}`,
    );
    process.exit(1);
  }
  console.log("[gen-eval-fingerprints] fingerprints fresh");
}

if (import.meta.main) {
  main();
}

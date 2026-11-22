# Research: Matt Pocock's "comments considered harmful" audit — experiment, Readiness, Onboarding?

Source: [Matt Pocock, 2026-11-20](https://x.com/mattpocockuk/status/2123798388227403983). The prompt
asks an agent to sort every comment into one of four buckets and act on it:

- **Tautology** (repeats the code): delete.
- **Excuse** (justifies a hack): delete it and file an issue to fix the hack.
- **Stale** (talks about code that changed): delete.
- **Decision Record** (a non-obvious why): move it into an ADR.

After that the agent adds a **lint rule that bans comments**, uses a ratchet for the comments
that remain, writes a `/delete-comment` skill and estimates how many lines this saves.

**TL;DR: do not adopt the ban, and do not add it to Readiness or Onboarding.** We ran the
classification half on a sample of Shepherd's own code. The comments the prompt targets are
rare here: 9 of 120 sampled blocks (7.5%) are tautology or stale, and none are excuses. Of the
other 111, most (59) are API docs, and about 41 are local decision records, which have to sit
next to the code to stop agents from undoing them. Keep a narrow, classify-only version as an
optional one-off cleanup.

## What Shepherd's comments look like

Sample: 120 comment blocks picked by seeded random choice, 80 from `src/` and 40 from `ui/src`.
Tests and generated code are excluded. A block is a run of whole-line comments.

| Bucket            | src (80) | ui (40)  |
| ----------------- | -------- | -------- |
| Decision Record   | 29 (36%) | 21 (53%) |
| API doc (JSDoc)   | 43 (54%) | 16 (40%) |
| Tautology         | 6 (7.5%) | 1 (2.5%) |
| Stale             | 1 (1.3%) | 1 (2.5%) |
| Excuse            | 0        | 0        |
| Issue/PR ref only | 1 (1.3%) | 0        |
| eslint pragma     | 0        | 1 (2.5%) |

How big the comments are, across all 464 non-test `src/*.ts` files:

- **Volume:** 44.9k comment lines against 134.6k code lines, so 25% of non-blank lines are
  comments. In `ui/src` the share is 12.6%.
- **Long blocks:** 700 blocks run longer than 10 lines. They make up 27% of all comment lines;
  `plugins/types.ts:606`, for example, is an 82-line spec.
- **Issue references:** 3.5k `#NNNN` references, in 21% of blocks. They nearly always sit next
  to real content and are rarely the whole comment.

The two stale comments we found are both refactor drift:

- `plugin-update.ts:173` has an `apply()` JSDoc that now sits above `locate()`.
- `ui/src/lib/diagnostics-copy.ts:6` says a test doesn't exist, but it was added on
  2026-10-12.

## Why a ban hurts here

- **Most decision records are local.** Only about 9 of the 50 sampled are architecture-level
  and could become ADRs (for example `sandbox.ts:572`, about mise reshims under the read-only
  bind). The other ~80% are notes about races, ordering, sandbox boundaries and external-tool
  quirks:
  - `index.ts:2117` has to run before `sweepStaleMerging`.
  - `drain.ts:2946` serializes work per `(repo, parent)` so the same PR isn't opened twice.
  - `EpicDiagnoseEntry.svelte:223` sets a 16px font to avoid iOS focus-zoom.

  An agent editing that line won't open an ADR first, so moving the note out of the code
  removes exactly what stops a "simplifying" edit from bringing the bug back.

- **Research points the same way.** Accurate comments help agents and wrong ones hurt them,
  much more than missing ones
  ([Inside Out, arXiv 2512.16790](https://arxiv.org/pdf/2512.16790)). Removing comments helped
  one model on SWE-bench Verified and hurt another
  ([NeurIPS 2026, "Code Comments as an Alignment Surface"](https://neurips.cc/virtual/2026/176319)).
  Comments helped bug-fixing by up to 3× in
  [arXiv 2601.23059](https://arxiv.org/html/2601.23059v1). The lever is keeping comments
  accurate, not having fewer of them.
- **The ratchet tooling exists but isn't the bottleneck.** ESLint
  [bulk suppressions](https://eslint.org/docs/head/use/suppressions) (`--suppress-all`,
  committed `eslint-suppressions.json`) make a ratchet cheap, and
  [`eslint-plugin-no-comments`](https://npmjs.com/package/eslint-plugin-no-comments) or
  `eslint-plugin-ban-comments` would supply the rule. Tooling isn't what makes this a bad fit.
  The rule would encode a policy our data argues against.

## Readiness and Onboarding fit

- **Onboarding: no.** The `shepherd-onboarding` skill shapes work into epics and slices, and
  explicitly leaves tooling to Readiness. A comment audit is neither of those.
- **Readiness: no guardrail check.** Readiness checks (`src/readiness.ts`) score guardrails that
  prevent defect classes, such as types, lint, hooks, dead code and swallowed errors. A
  "comment-ban rule present" check would reward a policy whose payoff depends on the repo. In
  Matt's setting, where agents write throwaway comments, it may pay off. In a codebase where
  incidents get written down as comments, as in Shepherd, it doesn't. Readiness shouldn't
  prescribe it to other operators' repos.

## What is worth doing instead (optional, small)

1. **Classify-only audit, scoped to hot files.** Delete tautologies and fix or delete stale
   comments. Do not ban comments and do not move local records. Good candidates are
   `service.ts`, `poller.ts` (43% comments) and `types.ts` (42%).
2. **Detached-JSDoc check.** Look for a doc block whose `@param` names don't match the function
   below it, the way `plugin-update.ts` drifted. This catches the stale class mechanically.
3. **Turn "keep in sync" comments into tests.** Examples: `review-status.ts:1`,
   `ui/src/lib/placement.ts:17` ("Mirrors CAPABILITIES"). A test enforces what the comment only
   asks for.
4. **Promote the ~9 architecture-level records to `docs/adr/`** and leave a one-line pointer in
   the code. Only one ADR exists today.
5. **Trim the 700 blocks over 10 lines.** Long specs belong in `docs/`, with the code linking to
   them.

None of these is urgent. If item 1 or 2 is wanted, it can become an issue.

## Method

A sub-agent took a seeded `shuf` sample (openssl CTR stream, seeds 42 and 43), classified each
block and checked every stale claim with `git log` and grep. Comment-density figures come from
whole-line comment counts. Comments at the end of a code line are not counted.

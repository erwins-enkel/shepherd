# Research: making Shepherd legible to a first-time evaluator

**Verdict:** The intimidation is **structural, not cosmetic** — the site names the machinery before showing it working, and the fix is a storyboarded pipeline animation authored as **inline SVG + CSS in `site/src/components/`**, not a video. **HyperFrames is a conditional yes for a distributable video cut, and a no for the on-site artifact.**

Scope: this is a research/decision document. No product code changed. It carries a storyboard ready to implement, a tooling decision with conditions, and an appendix of doc-vs-code drift that any accurate illustration will collide with.

---

## 1. The problem, stated precisely

Target audience: **prospective users evaluating Shepherd** — people who reach the repo or site, form a judgement in under a minute, and leave without installing. Not existing users, not skeptics of agent tooling generally.

Reported intimidation, all four confirmed by the operator as things people actually say:

| #   | Complaint                           | What it really means                                                      |
| --- | ----------------------------------- | ------------------------------------------------------------------------- |
| 1   | Too many concepts at once           | Can't separate core from optional. Vocabulary wall.                       |
| 2   | "This is for someone more advanced" | Terminal-native aesthetic reads as a competence gate.                     |
| 3   | Fear of losing control              | "Many autonomous agents in parallel" sounds like mess you'll clean up.    |
| 4   | Setup / operational burden          | Self-hosted + herdr + worktrees + GitHub + CI = a weekend of yak-shaving. |

### 1.1 The receipt

`site/src/components/HowItWorks.astro:23`, step 03 of three, verbatim:

> "Watch and steer agents from your browser or phone. Every plan clears the plan gate first; GitHub-backed repos then merge only what survives the critic and the merge train, while local-only repos squash-merge locally."

One sentence. **Five undefined proper nouns** (plan gate, critic, merge train, GitHub-backed, local-only) and **two branching deployment modes**, delivered at the exact moment a stranger is deciding whether they are the target user. This is complaint #1 in a single line of copy, and it is a _structural_ failure — the section tells the reader what the machinery is **called** instead of showing what it **does**. Nothing about the wording fixes that; the section needs to become a picture.

### 1.2 The constraint that rules out the obvious cure

The reflex fix for intimidation is warmth: rounded shapes, friendly mascot, softer palette, reassuring copy. `PRODUCT.md` forbids it explicitly and correctly.

- Brand personality (`PRODUCT.md:25`): _"Terminal-native instrument. Three words: technical, composed, earned."_
- Voice (`:27`): _"No marketing warmth, no hand-holding, no exclamation."_
- Anti-reference (`:34`): _"Consumer chat app. No bubbly, emoji-forward, soft-and-friendly Slack/Discord coziness that undercuts the operator-tool seriousness."_

There is also a product reason beyond brand fidelity: softening would **misrepresent the product**, attracting users who then meet a terminal-native instrument and churn. The intimidation must be reduced by **clarity and honesty**, never by softness.

> **Design rule for the whole artifact:** reassurance comes from _showing the brakes_, not from lowering the voice.

---

## 2. The thesis

Two claims, co-led. The first is the draw; the second is why the first is safe.

> **Shepherd runs many agents at once — and it is built to stop.**

**Throughput is the actual reason anyone wants this.** One operator, a dozen parallel sessions, no human bottleneck (`PRODUCT.md:11`). Leading purely on restraint would sell a governance tool nobody asked for.

**Restraint is why throughput isn't chaos** — and it is the direct answer to complaint #3. This is not a positioning exercise; it is what the codebase structurally _is_. Shepherd is a pile of caps, and every one of them exists to stop the machine and hand the operator the wheel:

| Cap                   | Default                      | Behaviour at the cap                                                   | Implementation                             |
| --------------------- | ---------------------------- | ---------------------------------------------------------------------- | ------------------------------------------ |
| Plan gate rounds      | `config.planReviewCyclesCap` | Steer **suppressed**, findings withheld, `stall` signal, needs a human | `src/plan-gate.ts:838`                     |
| Critic address rounds | 3                            | Stops steering; badge escalates `round → final → stalled`              | `src/review.ts:80`, `src/review-status.ts` |
| Critic spawn ceiling  | 2 × cap                      | Stops re-reviewing entirely per streak                                 | `src/review.ts:296`                        |
| Autopilot steps       | 10                           | `autopilotPaused`, hands back                                          | `src/autopilot.ts:391`                     |
| Rebase attempts       | 5                            | Hands back                                                             | `src/automerge-core.ts:164`                |
| Drain hold codes      | 11 distinct                  | Refuses to start work at all                                           | `src/drain-core.ts:29`                     |
| MCP OAuth prompt      | n/a                          | **Never** steered — human-only by construction                         | `src/autopilot.ts`                         |

A raw `claude` agent has **none** of these. It runs until it finishes, runs out of context, or ships something. So the honest competitive claim is not "Shepherd is more powerful":

> **Shepherd is the more conservative option.** It is an agent built to stop, and to tell you why it stopped.

That inverts all four complaints at once, without a single warm word:

| Complaint          | Inversion                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Too many concepts  | The vocabulary is **diagnostic, not operational** — hold codes appear when something stops. You don't learn them to start.                                    |
| For advanced users | Readiness scores **your** repo and names the gaps. It meets you where you are (and is purely advisory — `src/readiness.ts:641`; a low score blocks no spawn). |
| Losing control     | Every named mechanism is a **brake**. See the table above.                                                                                                    |
| Setup burden       | One `curl … \| bash`, then point at a repo.                                                                                                                   |

---

## 3. The core mental model (what the artifact must install)

Everything below is read off the implementation.

> **A unit of work is a GitHub issue.** Shepherd gives it a **git worktree** and a **real interactive terminal**, lets a genuine `claude` session work in it, and puts **checkpoints** between "started" and "merged." What the run learns becomes a **house rule** for the next one.

Two facts a newcomer must absorb, because they are load-bearing and nothing currently states them plainly:

1. **Shepherd never runs the agent programmatically.** Every instruction it gives is _text typed into a live PTY_ (`service.reply`). That is the ToS stance (`PRODUCT.md:17`) and it explains the entire architecture.
2. **Agents review agents.** The plan reviewer and PR critic each run in a **disposable detached worktree** — the reviewer at the _base_ SHA, the critic at the _head_ SHA — with no network, communicating only via a JSON verdict file on disk (`src/plan-gate.ts:376`, `src/review.ts:329`).

Everything else — epic DAGs, Learnings, hold codes, Readiness — is **optional surface area** that blocks no first run. Saying so explicitly is itself a de-intimidation move.

---

## 4. Storyboard

Eight beats. Silent, looping, ~30–40s, autoplay. Copy is one line per beat, in the existing operator register.

Visual grammar: a single **task token** (a small labelled pip) travels left→right through the pipeline. Gates are vertical bars it must pass. Colour is semantic, taken from the site's existing custom properties — never decorative.

| #   | Beat                  | On screen                                                                                                                       | Copy                                                               |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1   | **An issue**          | A GitHub issue card with a `shepherd:auto` label. Token emerges from it.                                                        | "It starts as an issue."                                           |
| 2   | **A room of its own** | Token drops into a bounded box: `worktree + terminal`. A live cursor blinks.                                                    | "Its own worktree. Its own real terminal."                         |
| 3   | **Many at once**      | Camera pulls back — 5–6 parallel lanes, each with its own token at a different stage.                                           | "A dozen of these at once."                                        |
| 4   | **Plan, then stop**   | Token reaches gate 1 and **halts**. A second token spawns from a _clean copy_ of the repo, reads the plan, stamps a verdict.    | "It writes a plan — and stops. A second agent tries to refute it." |
| 5   | **Work**              | Gate opens. Token moves; diff lines accumulate.                                                                                 | "Then it works."                                                   |
| 6   | **Robot checks**      | Gates 2–3: CI + hygiene, then the Critic reading the diff _against the approved plan_.                                          | "CI. Hygiene. Then a third agent reads the diff."                  |
| 7   | **Land**              | Merge train; token merges into the trunk line.                                                                                  | "Only what survives lands."                                        |
| 8   | **The payload**       | Rewind: a token **bounces off a gate** and turns amber; the lane stops; a `needs you` marker appears. Other lanes keep running. | "And when it can't, it stops and tells you why."                   |

### Notes on the beats

- **Beat 3 is the throughput co-lead.** It must land before the gates, or the piece reads as bureaucracy.
- **Beat 8 is the payload; beats 1–7 exist to earn it.** Critically, the _other lanes keep moving_ — one blocked session does not stall the herd. That is simultaneously the answer to complaint #3 and the product's core promise.
- **Beat 4 must show the reviewer reading a separate copy.** The isolation is the whole reason the review is trustworthy, and it is currently invisible in every description.
- **Loop seam:** beat 8 → beat 1. The amber marker resolving into a fresh issue closes the cycle.
- **Deliberately absent:** epic DAGs, Learnings, Readiness, hold-code taxonomy, local-vs-GitHub modes. All optional; all currently contributing to complaint #1. A "what else is in the box" list belongs _below_ the animation, as text, for people who kept reading.
- **`prefers-reduced-motion`:** the animation must degrade to a static final-state diagram with all eight labels visible. This is a hard requirement and is the single strongest technical argument against a video (§5).

---

## 5. Tooling decision

### 5.1 On-site artifact → hand-authored inline SVG + CSS

Author directly in `site/src/components/` (Astro 7, plain CSS, no framework runtime), replacing or preceding the current `HowItWorks.astro` text list.

Rationale, in priority order:

1. **`prefers-reduced-motion` support.** A baked MP4 cannot honour it. Given `PRODUCT.md:49-53` commits to WCAG 2.1 AA, shipping a video here contradicts a stated accessibility position.
2. **Design-token fidelity.** CSS reads the site's live `--color-*` values and follows theme changes. A rendered video hard-codes a palette that drifts the moment tokens change.
3. **Weight and crispness.** Kilobytes vs megabytes; vector-crisp at any DPI; native transparency; a seamless infinite loop with no encode seam.
4. **Zero dependency and zero licence surface** on a site whose current footprint is fonts + analytics.

Shipping a video player to animate six boxes and an arrow is strictly worse on every axis.

### 5.2 Distributable video cut → HyperFrames, conditionally

If a README / release / YouTube / conference cut is wanted later, [HyperFrames](https://hyperframes.heygen.com/) is the right tool and the recommendation is **yes, with conditions**.

**What it actually is** — not vaporware. Deterministic frame capture: Puppeteer drives headless Chrome, the frame clock is `t = frame / fps`, frames are captured via CDP **BeginFrame**, FFmpeg encodes. Compositions are plain HTML with `data-start` / `data-duration` timing attributes plus a _paused_ GSAP timeline the renderer scrubs. ([determinism](https://hyperframes.heygen.com/concepts/determinism), [data attributes](https://hyperframes.heygen.com/concepts/data-attributes))

**Why it wins its category:**

- **Apache-2.0**, no seat or render fees. Its only live competitor, **Remotion, is $25/mo/seat** above 3 employees ([licence](https://www.remotion.pro/license)), and an open PR would make contractors count toward team size.
- **Motion Canvas — architecturally the best fit for this exact brief — is dead.** Last code commit 2025-02-16; no stable release since Dec 2024; [issue #1221 "Is the repo dead?"](https://github.com/motion-canvas/motion-canvas/issues/1221) unanswered; the domain went NXDOMAIN. Rule it out.
- **The diagram primitives exist**: a `flowchart` block, `svg-path-draw` (arrows drawing themselves via measured `getTotalLength()`), `constellation-hub`, and a blueprint named **`agent-progress-theater`** — _"badges flip one by one from numbered outline to a solid done color circle + white checkmark"_ — which is beat 6 already storyboarded.
- **Free local voice**: Kokoro-82M TTS and Whisper caption alignment run offline. A narrated cut costs nothing and needs no HeyGen account; avatars are not part of the OSS core at all.

**Conditions — all six are load-bearing:**

1. **Pin exactly** (`hyperframes@0.7.65`). Pre-1.0 at 1–3 releases/day; the `flowchart` block was rendering blank as recently as [#2548](https://github.com/heygen-com/hyperframes/issues/2548).
2. **Render with `--docker`.** Local mode is documented as _not_ reproducible across platforms.
3. **Set `DO_NOT_TRACK=1`.** PostHog telemetry is on by default.
4. **Strip the silent self-update directive.** ⚠️ See §5.3 — this is the serious one.
5. **Treat it as a build-time asset generator.** Render, commit the artifact, carry no runtime dependency. If it stalls like Motion Canvas, nothing is lost but the ability to re-cut.
6. **Keep the project out of the repo** (or gitignored) — the skills scaffold `hyperframes.json`, `.media/`, `renders/`, which would trip branch-hygiene and feature-catalog gates.

**Also note:** there is **no graph auto-layout** (zero hits for `dagre` / `elkjs` in source; nodes are absolutely-positioned divs with hand-written coordinates). Fine for a fixed 8-beat pipeline; a problem if the diagram must re-flow.

### 5.3 ⚠️ Security note, relevant to any Shepherd operator

[Open issue #2613](https://github.com/heygen-com/hyperframes/issues/2613): **11 of HyperFrames' Claude Code skills open with a directive telling the agent to run `npx hyperframes skills update <name>` "silently, don't ask"** on every invocation. Verified in `motion-graphics/SKILL.md` and `faceless-explainer/SKILL.md`.

Effect: an ongoing, silently-renewed trust relationship with whoever controls the `hyperframes` npm package, executed by your agent without surfacing it. Snyk and Socket flag the pattern as Critical/High. Local edits to `SKILL.md` **revert on the next update**. The same issue reports a shell-injection _shape_ (currently unreachable) in `media-use/scripts/lib/local-run.mjs`.

For an operator running a herd of autonomous agents this is a materially worse risk than for a single human user, and it is the strongest argument for keeping HyperFrames off the critical path and out of the repo.

### 5.4 Options considered and rejected

| Tool              | Verdict             | Reason                                                                                                                                                                                               |
| ----------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Remotion**      | Rejected            | $25/mo/seat above 3 employees; React-only, doesn't compose with an Astro/Svelte site                                                                                                                 |
| **Motion Canvas** | Rejected            | Abandoned — last code commit Feb 2025, domain dead                                                                                                                                                   |
| **D2**            | Keep, different job | No continuous tweening — `--animate-interval` is board crossfade. Cannot move a token through gates. But it has the auto-layout HyperFrames lacks: **keep for static `docs/` architecture diagrams** |
| **Excalidraw**    | Rejected            | No animation export in core; sketch aesthetic is off-brand                                                                                                                                           |

---

## 6. Appendix: doc-vs-code drift

Any accurate illustration collides with these. **Recommendation: correct the docs.** Each is currently _true in outcome, wrong in mechanism_ — which is exactly the kind of claim that erodes trust when a reader inspects the code.

| #   | Claim                                                      | Where                                 | Reality                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ---------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Merge train "rebases and re-verifies" PRs                  | `README.md:47`, `PRODUCT.md:19`       | **Shepherd never rebases.** `doRebase` types `rebaseSteer(baseBranch)` into the agent's live pane and bumps a counter (`src/automerge.ts:368`). Re-verification is _emergent_: the force-push moves the head, CI re-runs, the critic re-reviews. If the pane is dead, nothing happens.                                                                                               |
| 2   | Readiness "turns the gaps into setup tasks"                | `README.md:41`, `HowItWorks.astro:18` | Generates a _prescription_; a human must click to seed a New Task (`ui/src/lib/components/BacklogView.svelte:64`). Nothing is automatic and a low score blocks nothing.                                                                                                                                                                                                              |
| 3   | Critic "reviews every CI-green PR"                         | `PRODUCT.md:19`                       | Qualified: only when `criticEnabled` for the repo, only on PR open, only on a new head SHA, and it stops after 2 × cap findings-bearing reviews per streak (`src/review.ts:296`). A repo with zero workflows counts `checks: "none"` as cleared and is reviewed immediately (`src/checks-gate.ts:23`).                                                                               |
| 4   | "Shepherd only observes and steers"                        | `PRD.md §1`, `PRODUCT.md:17`          | True of the **agent**. Shepherd itself calls the GitHub API directly (`forge.merge`, `closeIssue`, `ensureBranch`), runs `git worktree` / `patch-id`, and spawns **five kinds of non-session LLM agents** (plan reviewer, critic, stop-classifier, distiller, optimizer) the operator never sees. Worth stating plainly — it's defensible, and hiding it looks worse than owning it. |
| 5   | `shepherd:active` "keeps two instances off the same issue" | `README.md:571`                       | The claim window is _narrowed_, not closed (`src/drain-core.ts:26`, `src/drain.ts:2545`). `README.md:588` already admits this; `:571` overstates it.                                                                                                                                                                                                                                 |
| 6   | Plan gate ⇒ "only an approved plan is released"            | implied throughout                    | True, but for a drain/autopilot session the release is automatic (`src/plan-gate.ts:799`) — **no human ever sees the plan.** The gate is agent-vs-agent. This is a _feature_, and stating it plainly is better than letting a reader discover it.                                                                                                                                    |

Fixing #1 and #2 is a prerequisite for the storyboard: beats 6–7 would otherwise depict a rebase Shepherd does not perform.

---

## 7. What was deliberately left out of the artifact

Recorded so it isn't re-litigated. All of it is real and none of it belongs in a 40-second first impression: epic DAGs and integration branches; the Learnings distiller and house-rule scoring; the 11 drain hold codes; `isFullAuto` and its four silent exclusions; local-only vs GitHub-backed modes; stall detection thresholds; the `shepherd:active` coordination protocol.

Every one of these is a candidate for a **second-tier** explainer aimed at users who already installed. They are complaint #1 in raw form, and putting any of them in front of an evaluator is what created the problem this document exists to solve.

---

## 8. Recommended next steps

1. **Fix drift #1 and #2** in `README.md` / `PRODUCT.md` (prerequisite — the storyboard depicts mechanism).
2. **Build the animation** as inline SVG + CSS in `site/src/components/`, replacing the `HowItWorks.astro` step list, with a `prefers-reduced-motion` static fallback.
3. **Re-word `HowItWorks.astro:23`** so no proper noun appears before the picture has shown what it does.
4. **Defer the video cut.** Revisit HyperFrames once the on-site animation exists — the SVG storyboard is the source material for it, and by then the pre-1.0 churn will have had time to settle.

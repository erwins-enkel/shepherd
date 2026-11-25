# Tobi Lütke on David Senra (2026-11-22): AI-coding takeaways for Shepherd

**Source:** David Senra, _"Jensen Huang, AI & Why Founders Are Irreplaceable | Tobi Lütke, Shopify"_,
released 2026-11-22 ([YouTube `w0oOxs0WKNk`](https://www.youtube.com/watch?v=w0oOxs0WKNk),
[episode page](https://www.davidsenra.com/podcast)). The AI-engineering segment runs roughly
**35:50–58:00**. Quotes below come from the auto-transcript (pulled with `yt-dlp`) and are lightly
cleaned up. This is not the January 2026 episode "21 Years of Building Shopify".

**Bottom line:** two of the five ideas are already Shepherd's model: verification over review, and
"factories" of agents with different jobs. Three are real gaps:

1. **Reverse prompting**: an operator-level retro of _how you prompt_. Shepherd stores the data
   for it but never looks at it.
2. **Lint strictness as coaching**: the Readiness lens checks that a linter _exists_, not how
   strict it is.
3. **Implicit state machines → TLA+**: Shepherd itself is full of them. They are where most of its
   restart and race bug history sits.

deepsec runs on the subscription (with one env trap) but works differently from the Cloudflare
audit skill, so it gets a bounded check on Shepherd before any adoption. The operator's decisions
are in §7.

---

## 1. What Tobi actually said

| #   | Claim (≈timestamp)                                                                                                                                                                                                                                                                                                                                                                                                                                         | Shepherd relevance                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| A   | **"Insufficiently ambitious prompting"** is the main reason people don't get value (35:59). His fix is **reverse prompting**: he sits with an engineer and has _their_ AI "go through all the prompts, cluster them in types… give us good examples… beginning, mid of product… the AI can actually do the meta analysis itself." The usual finding: "you had preconceived notions about how to solve the problem… but you didn't understand the problem." | Coaching gap, see §2                                       |
| B   | **Verification engineering**: "most of the work ends up becoming… creating acceptance tests. Here's how you know for sure that the thing that was created is good." Formal verification is "now by far the most important field in engineering." "Code review is basically our human-run formal verification, shitty version of it." (37:00–43:00)                                                                                                         | Already Shepherd's thesis; small Readiness gap, see §3     |
| C   | **Agents love rules, not abstractions.** Strict, house-specific linter rules feel oppressive to humans, but "the agents love them because they give them rules." Agents would rather write explicit code than read "the abstract tower of Babel." (41:00–42:40)                                                                                                                                                                                            | Readiness gap, see §4                                      |
| D   | **Implicit state machines → TLA+.** "Go into something like Claude Code and just ask your AI: find all implicit state machines in this codebase… then make a TLA model for it to make sure all the cases are specified. You will find a thousand bugs in your codebase." (43:30–44:20)                                                                                                                                                                     | Shepherd codebase, see §5                                  |
| E   | **deepsec**: "the cell [Vercel] made a great tool called Deep Sec. Use Deep Sec to look for security vulnerabilities." "Most companies are in some form of code red." (44:20–45:00)                                                                                                                                                                                                                                                                        | Pilot, see §6                                              |
| F   | **Factories**: "almost all engineering at Shopify now is happening through… factories: constellations of AI agents with different jobs… message boards… long-horizon tasks." Be ambitious and "have it do reps on solving the problem" rather than accelerate tasks. (50:00)                                                                                                                                                                               | This _is_ Shepherd (drain, plan gate, critic, merge train) |
| G   | **PR rate went 10–100×**, so he rewrote Shopify's internal git host in a weekend for about $2k of tokens. "Pre-work to make the next task cheaper" (rewrite a layer in Rust) is now affordable. (55:00–57:30)                                                                                                                                                                                                                                              | Validates merge-train throughput work; nothing new to do   |

Attribution caveat: the sources don't confirm that the "find implicit state machines → TLA+" recipe
originated with Tobi. The closest public precedent is Boris Cherny's widely shared report of Opus 5.5
writing TLA+/Lean models of the Claude Agent SDK. It is reported secondhand: 24 bugs and 16 PRs per
[explainx](https://explainx.ai/blog/boris-cherny-opus-5-5-lean-tla-formal-verification-sdk-2026).
I could not find the primary post.

---

## 2. Reverse prompting: an operator "prompt retro" (coaching, new)

**Today.** `src/prompt-recommend.ts` suggests the _next_ prompt for _one_ session from its terminal
history. Nothing looks across sessions at the operator's own prompting style. The flywheel that
came closest (learnings) was retired in #3139, and it distilled agent learnings, not operator
habits.

**Data Shepherd already has** (all local):

- `sessions.prompt`: the opening prompt of every task.
- `signals` rows of kind `reply`: every steer, with `headSha` (#2863).
- `plan_revisions` / `task_amendments`: how often the plan or task had to be corrected.
- Rework and outcome proxies: `reviews.addressRound`, `reviewer_spawns`, CI-red steers, archive
  reason (abandoned vs merged).

**Proposal:** an on-demand **Prompt retro**. Shepherd spawns a transient, read-only helper in the
house pattern (subscription spawn, `dontAsk`, scoped tools, untrusted fencing) over the last N
sessions. The helper should:

1. Cluster opening prompts by type, and steers by phase (start / mid / end of a task). This is
   Tobi's exact recipe.
2. Flag **solution-prescribing** prompts ("change X in file Y to do Z") versus **problem-describing**
   ones ("users see A when B; desired C"), and correlate each cluster with the rework proxies above.
3. Return 3–5 concrete examples, each with a rewritten "more ambitious" version. It should
   recommend nothing it cannot show evidence for.

**Where it lives.** The Readiness lens scores _repo_ guardrails, so a per-_operator_ retro is a
different axis. Options:

- (a) A "Prompting" tab beside Readiness.
- (b) A weekly line in the Herd rundown.
- (c) A skill or slash command only, with no UI.

**Decided: (c)**, the cheapest experiment, with zero server code (see §7).

**Cheap sibling (agent-side):** the plan-gate grill could add one line: _"If the request
prescribes a fix for what looks like a symptom, say so and name the better lever before
planning."_ This is Tobi's "maybe this isn't the problem at all if we change something else over
here." Keep it to one line: the plan prompt deliberately bans "why not X" essays
(`src/service.ts:2010-2023`, `src/plan-gate.ts:2313-2320`).

---

## 3. Verification engineering: mostly covered

Shepherd already runs this loop:

- **Success criteria:** required in every plan (`src/service.ts:1316`, `:2022`, `:2118`).
- **Plan gate:** adversarial review of the plan before execution.
- **Critic on green CI:** reviews every PR once its checks pass.
- **Checks gate and stall detection:** see `docs/research/ai-native-sdlc-playbook.md` §2.2.

The remaining gaps:

- **Readiness `test_runner` is presence-only** (`src/readiness.ts:354-360`: any non-placeholder
  `test` script passes). It could award partial credit for an **acceptance layer**: browser/e2e
  config (Playwright, Vitest browser mode), a `docs/acceptance/`-style checklist, or contract tests.
  This would be a low-weight check, worded as "how the agent knows for sure it's good".
- **Prompt and instruction evals** are still the playbook's "biggest miss" (only
  `scripts/eval-stop-classifier.ts` exists). This podcast changes nothing there.

---

## 4. "Agents love rules": score lint strictness, not presence

**Today.** `linter` (`src/readiness.ts:222`, `:338`) passes once any ESLint, Biome or other linter
config exists. Lint _strictness_ is not scored, although #4080 just did exactly that for tsconfig
strictness (`src/readiness-tsconfig.ts`).

**Proposal: a new `lint_strictness` guardrail** (decided, §7), mirroring `ts_strict`:

- **js-ts:** `--max-warnings 0` / `--max-warnings=0` in lint scripts or hooks; repo-specific rules
  (`no-restricted-syntax`, `no-restricted-imports`, a local `eslint-plugin-*` or `rules/` dir); rules
  promoted from `warn` to `error`; a type-aware preset (`recommendedTypeChecked`).
- **rust:** `clippy -- -D warnings` in the command corpus, or a `[lints]` table in `Cargo.toml`.
- **swift:** SwiftLint `strict: true` / `--strict`.

Shepherd dogfoods this already (e.g. the custom JSDoc rules in #4138, and the fallow gate). The
coaching copy writes itself: _"House rules feel oppressive to humans; agents treat them as free
guidance. Every bug class you can ban with a lint rule is one the critic never has to catch."_

---

## 5. Implicit state machines in Shepherd: a TLA+ pilot

I ran Tobi's prompt ("find all implicit state machines") against `src/` as a read-only sweep and
spot-checked the anchors. Ranked by bug history × concurrency × state split across stores:

| Rank | Machine                                     | Where the state lives                                                                                                                                                             | Why it's risky                                                                                                                                                                                                           |
| ---- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | **Session lifecycle**                       | About 10 `sessions` columns (`status`, `lastState`, `archivedAt`, `settledAt`, `shelved`, `haltReason`, `planPhase`, …) plus about 7 in-memory `*InFlight` leases in `service.ts` | `derivePhase` (`src/session-phase.ts`, #2586) is a read-only projection admitting that no single column says it. There is no transition function. Leases vanish on restart; past races #3016, #3370, resume double-spawn |
| 2    | **Drain claim + epic landing**              | GitHub `shepherd:active` label + settings-JSON pending-claim journal + in-memory `inflightClaims`/`retainClaimOnArchive` + `epic_integrated`/`epic_completed`                     | Four stores. `retainClaimOnArchive` is memory-only, so restart between settle and archive likely drops a claim that should be kept (my inference, untested). Densest bug-ref file                                        |
| 3    | **Plan gate**                               | `sessions.planPhase` + `plan_gates` (`decision`, `approved`, `round`, `livePlanHash`) + `reviewer_spawns.completedAt` + in-memory `inflight`/`cancelledHashes`                    | Restart-orphan disposition logic (#631, #2224, #3514); four writers including the auto-advance added when PRs appeared mid-"planning"                                                                                    |
| 4    | **Review / critic rounds**                  | `reviews` (`addressRound`, `errorRound`, `streakReviews`, `finalRoundPending`, `spawnAborted`, `autoRetryAt`) + in-memory `inflight`/`cancelledHeads`                             | Double spawn across an await, boot re-processing (#1816), pre-spawn abort rows (#1211)                                                                                                                                   |
| 5    | **Merge train / AutoMerge**                 | `mergingSince`/`mergingTrainId` columns + `#liveTrains` maps + automerge `enqueued`/`stackedHold` maps; rebase counters written by both `automerge.ts` and `autopilot.ts`         | `src/automerge.ts:843-848` documents a known stuck state with no release path                                                                                                                                            |
| 6    | **Remote dispatch**                         | Explicit 10-state `RemoteDispatchState` (`src/remote-instances/dispatch.ts:124`) with CAS-guarded SQL writes                                                                      | Already explicit, so it is the cheapest one to model and check against the code                                                                                                                                          |
| 7    | **Poller liveness / auto-revive**           | All in memory (`strandedSweeps`, `reviveGaveUp`, `pendingStopAt`, …); revive counter duplicated in `service`                                                                      | Stale-husk destructive action (#1156)                                                                                                                                                                                    |
| 8    | **`socket-pty-bridge` exit classification** | Six booleans (`src/socket-pty-bridge.ts:76-81`)                                                                                                                                   | Single process, no DB, known exit-vs-stdout race (#1529), so it is an ideal warm-up                                                                                                                                      |

This lines up with the recurring incident memories: drain claim ⟷ retire coupling, plan-gate restart
orphaning, reviewer name-squat orphans, conflict-nudge stale verdict, the CI-red "dead zone" (a
literal missing state). They are the class of bug Tobi predicts.

**Pilot shape:**

1. **Warm-up (#8 or #6):** have the agent write a TLA+ spec plus a `.cfg`, run TLC, and report
   counterexamples. This validates the toolchain and the agent's TLA+ fluency on code where the
   ground truth is easy to check.
2. **Real target: the plan gate (#3)** (decided, §7; #2 drain claim next): spec its lifecycle _including restart as an
   action_. Most past bugs are "restart mid-transition".
3. **The human writes the invariants.** Both practitioner write-ups stress this:
   [A. Jesse Jiryu Davis, 2026-05](https://emptysqua.re/blog/intro-to-tla-plus-for-the-llm-era) and
   [Hillel Wayne](https://buttondown.com/hillelwayne/archive/ai-is-a-gamechanger-for-tla-users).
   LLM-proposed properties tend to be "trivial, uninteresting, or too coupled to implementation", and
   on a counterexample the agent tends to "make the bug okay" or assume the race away instead of
   modelling the guard. Example invariants: _a claimed issue always has exactly one live owner or a
   pending journal entry_; _a session in `executing` always has an approved gate for its live plan
   hash_.
4. **Close the loop in code, cheaply:** for each spec'd machine, extract one explicit
   `State`/`transition()` (as `heavy-slot-core.ts` and `RemoteDispatchState` already do) and add
   `fast-check`-style property tests generated from the spec's actions. Trace validation against
   production logs is still "manual labour" per Wayne, so skip it.

**Tooling:** TLC (Java). Davis used the 1.8.0 prerelease because the last official release is old.
CI integration is optional and only worth adding after the pilot shows hits.
[Specula](https://github.com/specula-org/specula) is an AI-driven TLA+ bug-finding framework worth
a look during the pilot.

**Readiness angle:** don't score "has TLA+ specs", since nearly every repo would fail on a niche
signal. If the pilot pays off, add it as an unscored "advanced play" recipe: the two prompts above,
plus "write the invariants yourself".

---

## 6. deepsec: different from the Cloudflare skill, so check it first

**What it is** (Vercel, Apache-2.0, open-sourced 2026-05-04;
[blog](https://vercel.com/blog/introducing-deepsec-find-and-fix-vulnerabilities-in-your-code-base),
[repo](https://github.com/vercel-labs/deepsec), source read at `895e0bc`, 2026-11-23). It runs in
five stages: a free regex scan, agent investigation (Claude Agent SDK, Codex or pi), a second agent
pass that revalidates findings to cut false positives, then enrich and export. Output is per-file
JSON plus an `md-dir`/`json` export, with `severity`, `confidence`, `revalidation.verdict` and
`triage.priority`. There is no SARIF. Vercel claims a false-positive rate of roughly 10–20%. It
also ships its own `SKILL.md` (`/deepsec`), which asks for a scope (uncommitted, diff to main, or
whole repo) and then drives the CLI.

### Does it run on the subscription? Yes, with one trap

- **Mechanism:** `--model-auth local` skips the Vercel link and login entirely (`init.ts:275`). The
  Claude backend calls the Agent SDK's `query()`, which spawns the bundled `claude` binary with an
  allowlisted env that includes `HOME` (`packages/processor/src/agents/claude-agent-sdk.ts:117-146`).
  The child therefore uses the machine's `claude` login: `~/.claude` credentials, or
  `CLAUDE_CODE_OAUTH_TOKEN`.
- **Billing:** Anthropic support,
  ["Use the Claude Agent SDK with your Claude plan"](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
  (updated 2026-10-07): _"when you're signed in with your Claude plan, the Claude Agent SDK and
  `claude -p` still draw from your subscription limits."_ The June 2026 split into a separate
  SDK credit was **paused**. The October monthly API credits
  ([article 17154008](https://support.claude.com/en/articles/17154008)) apply only to runs with a
  Console API key.
- **Trap:** deepsec forwards `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` to the child whenever
  they are set. Per the
  [auth docs](https://code.claude.com/docs/en/authentication), in non-interactive mode "the key is
  always used when present". **Unset both before running**, or the scan silently bills the API key.
- **Practical limit:** "subscription" still means plan limits. deepsec defaults to Opus at max
  effort for every candidate file, so a whole-repo pass on Shepherd will likely burn a large share of
  a Max window. Start with the diff scope.
- **Policy note:** the Agent SDK docs forbid _third-party products_ from offering claude.ai login.
  Running a tool yourself under your own login is the case the support article describes. Shipping
  deepsec inside Shepherd for other operators would not be, so it stays an operator-run skill.

### How it differs from the Cloudflare skill

| Axis                 | `cloudflare/security-audit-skill` (runs 1–2)                                                                  | Vercel deepsec                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Form                 | Methodology only: a `SKILL.md` plus attack-class references and validators, executed by the interactive agent | A standalone CLI (`.deepsec/` workspace, its own npm install) that the agent drives                                                                   |
| How it finds targets | Threat-model first: recon → architecture → coverage ledger of trust-boundary _units_ → hunters per unit       | Scanner first: about 200 built-in regex matchers plus AI-generated repo matchers flag _files_, then one agent investigates each file                  |
| Verification         | Independent verifier per candidate; a finding needs a concrete principal, boundary and outcome                | A second "revalidate" agent pass; findings carry verdict and confidence                                                                               |
| Coverage limit       | Bounded by the ledger units the parent plans (budget = agent invocations)                                     | Bounded by matcher hits: code no matcher flags is never investigated. No framework matchers for `Bun.serve`; Rust detection only; Swift not mentioned |
| Re-runs              | Prior-run carryover of confirmed findings                                                                     | Per-file resumable state; `process --diff` PR mode; USD and duration caps                                                                             |
| Execution safety     | Strict: no target code outside an OS sandbox; read-only source                                                | The agent gets Read/Glob/Grep/Bash under `dontAsk`; the README says treat it as full shell access; optional Vercel Sandbox (needs a gateway key)      |
| Billing path         | The interactive session's own subagents                                                                       | Headless Agent SDK on the local login (above)                                                                                                         |

They are complementary rather than redundant. Cloudflare's skill reasons about trust boundaries,
which is where Shepherd's GHSAs came from (auth, ingress, membrane, IPC). deepsec sweeps files for
known-bad patterns at breadth, cheaply on re-runs. Whether that breadth finds anything the
boundary-driven runs missed is exactly what the pilot must measure.

**Pilot:**

1. Install it in a throwaway clone with `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` unset, using
   `--model-auth local --agent claude`.
2. Run `init --through coverage` first. The regex scan is free and shows how many Shepherd files
   the matchers even flag; if `src/server.ts` and the ingress files are barely hit, stop there.
3. Process a bounded slice, scoped to the files behind the published run-1/run-2 GHSAs. Score
   **recall against that known-positive set**, then count net-new findings that survive manual
   triage.
4. Run it inside the membrane or a VM, never in the host checkout.

**If it earns its place:**

- Security Watch could gain a second source that ingests the deepsec JSON export. Security Watch
  already does grouping, read-only triage and redacted issue filing.
- Readiness could add a low-weight `security_scan` guardrail (CodeQL, deepsec config, Semgrep).

---

## 7. Decisions (operator, 2026-11-25) and next steps

1. **Prompt retro ships as a skill first** (§2c). The natural home is
   `agent-skills/.claude/skills/prompt-retro/`, next to `shepherd-cli`, so every Shepherd session
   gets `/prompt-retro`. It reads past sessions through the `shepherd` CLI (opening prompts, steers,
   outcomes) and returns clusters, evidence-backed examples and rewrites. No server code. A UI home
   is decided after it has been used.
2. **`lint_strictness` becomes a new Readiness guardrail** (§4), not a sub-score of `linter`. It
   mirrors `ts_strict` (#4080), per ecosystem (js-ts, rust, swift), with EN + DE coaching copy.
3. **TLA+ pilot targets the plan gate** (§5 #3). An optional warm-up on `socket-pty-bridge` comes
   first. The human writes the invariants, and restart is modelled as an action.
4. **deepsec: check first** (§6). It runs on the subscription via `--model-auth local` once the API
   key env is unset. It differs materially from the Cloudflare skill, so the pilot (free coverage
   scan, then GHSA recall on a bounded slice) runs before any adoption.
5. **Later:** Readiness acceptance-layer credit (§3) and the one-line "symptom vs problem" grill
   nudge (§2).

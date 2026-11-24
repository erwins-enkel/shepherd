# Claude Ship vs Shepherd: overlap, collisions, what to do

**Brief:** Anthropic announced **Claude Ship** on **2026-11-23**
([article](https://claude.com/resources/articles/introducing-claude-ship),
[docs](https://code.claude.com/docs/en/claude-ship)). It covers the PR half of the loop: review,
keeping a PR green, and deciding what can merge. Shepherd already runs all three in its own way:
the critic, the autopilot CI and conflict steers, and the merge train. This note covers what
shipped, how it maps onto Shepherd, where the two **collide** on the same repo, and what is worth
building.

**This file is a research note, not code.** It was checked against the article, the
code.claude.com pages listed in §7, and Shepherd's source on 2026-11-24. Any build work is a
follow-up issue. §5 ranks the options.

## 1. What shipped

There are three parts. Code Review is generally available (GA). PR Steward and Claude Approvals
are in public beta. Claude Ship is for Team and Enterprise plans, GitHub only, and is unavailable
with ZDR, HIPAA or CMEK. Usage is billed on tokens to org usage credits, separate from plan usage.

| Part                 | Runs where                                                        | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Code Review**      | Anthropic cloud, through the Claude GitHub App                    | Reviews with several lenses, verifies findings adversarially and gives each a severity. Three levels: Quick, Standard and Deep. Runs once per PR, after every push, or on `@claude review`. Posts a **Claude Code Review** check run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **PR Steward**       | Cloud session, acts as the Claude GitHub App                      | Keeps a PR green. It fixes failing checks in code the PR touches, **merges base into the branch** to resolve conflicts, and acts on comments from people and review bots (including Code Review "Important" findings and the Approvals check). After each push it comments what it changed and how to undo it. Steered with `@claude …`, stopped with `@claude stop` or by removing the `claude-pr-steward-watching` label. **Never approves or merges.** Skips drafts, forks, bot-opened PRs and authors without write access.                                                                                                                                                                                            |
| **Claude Approvals** | Policy is evaluated on GitHub. Classifiers run in cloud sessions. | Reads a policy-as-code file, `.claude/approvals.yml` (`version`, `rules[]` each with `paths` and `purpose` plus a `verdict`, `advisory`, `findings` or `reuse` entry, `mode: observe\|enforce`, and `nested` files per subdirectory). Rules can read PR facts (files and lines changed, authors, approvers, base), `claude/code_review`, `claude/diff` (trivial / same_intent / different) and custom `repo/<name>` classifiers. A classifier is defined in `.claude/classifiers/<name>/def.yml` with a model, a prompt, typed outputs and a time/cost budget. **Rules cannot read CI.** Posts a **Claude Approvals** check and can approve on its own. Blocks merging only if branch protection makes the check required. |
| **`/ship`** (local)  | The user's own Claude Code session                                | Commits, pushes and opens the PR, runs `/code-review`, then keeps a **watch** (`/steward --tend`) for up to 7 days. During the watch it fixes CI, merges base in, and replies to and resolves review threads. Never merges. Force-push, approve and auto-merge commands are blocked. **Needs auto mode; under `bypassPermissions` no watch starts.** Counts as normal Claude Code usage.                                                                                                                                                                                                                                                                                                                                   |

## 2. Mapping onto Shepherd

| Claude Ship                               | Shepherd's equivalent today                                                                                                                                                                                                        | Difference                                                                                                                                                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code Review                               | Critic on PR (`src/review.ts`, `src/critic-core.ts`). Runs on CI-green, reads a per-repo `REVIEW.md` / `.shepherd/review.md` (`critic-core.ts:105`), gives severity, and steers findings back into the **live task agent's pane**. | Similar idea. Shepherd's critic runs locally on the subscription, needs no GitHub App, and works on Gitea and lightweight local repos. Claude's version runs in the cloud, is billed per token and is GitHub only.                     |
| PR Steward: CI                            | Autopilot `ciFixSteer` (`src/autopilot.ts:129`) and `src/ci-steer.ts`. The **original author agent** fixes it with full session context.                                                                                           | Steward is a new agent with no context and has to rebuild intent from the diff. Shepherd's agent already has the context.                                                                                                              |
| PR Steward: conflicts                     | `rebaseSteer` / `conflictRebaseSteer` (`autopilot.ts:139,169`). **Rebase plus force-push**, as the repo's branch hygiene requires.                                                                                                 | Steward and `/ship` **merge base in** and block force-push. The two strategies are opposites (see §3).                                                                                                                                 |
| PR Steward: human and bot review comments | **None.** Human reviews only send a push notification (`src/push.ts:1154`). No steer forwards a person's or a third-party bot's review comments to the agent. Only Shepherd's own critic findings steer.                           | **This is a real gap.** It is the part of Steward Shepherd lacks.                                                                                                                                                                      |
| Claude Approvals                          | Merge train gate (`src/automerge-core.ts:240+`): critic verdict, no findings, and green CI. Plus `src/merge-gate.ts`, the roles-based confirmation for manual merges. `src/drain-core.ts` holds the same gate for drain.           | Shepherd's policy is in code and binary: critic on or off plus three repo booleans. Approvals is a file in the repo with rules per path, human-seat counts and custom classifiers.                                                     |
| `/ship`                                   | A Shepherd session as a whole, including `openPrSteer`, the critic loop and the merge train.                                                                                                                                       | `/ship` is a single-session subset of what Shepherd does. Shepherd sessions **cannot use it**: task agents spawn with `--dangerously-skip-permissions` (`src/service.ts:4667`), which counts as bypassPermissions, so no watch starts. |

**Takeaway:** Anthropic built the PR loop Shepherd already has (critic, CI/conflict fix,
policy-gated merge) as cloud agents for GitHub orgs. Shepherd's advantages remain: the author agent
fixes its own PR with full context, it runs on the subscription with no per-token billing, it
works with Gitea and local repos, and it covers the pre-PR side (plan gate, build queue, drain,
epics). Claude Ship has three advantages: it reacts to **human review comments**, its merge policy
is **declarative and diffable**, and it needs **no always-on host**.

## 3. What breaks when a Shepherd-managed repo enables Claude Ship

These are concrete risks for any operator who turns Claude Ship on for a repo Shepherd also drains.

1. **Two agents pushing to one branch.** Steward and the Shepherd task agent both push. Steward
   merges base in, while Shepherd's conflict steer **rebases and force-pushes**, which discards
   Steward's commits and its "how to undo" trail. Steward then reacts to the new head, and the two
   can loop. Whether Steward acts on a Shepherd PR at all **depends on the agent's GitHub
   credential mode**. The agent runs `gh pr create` itself (`src/autopilot.ts:87`) with whatever
   credential its membrane holds (`src/agent-gh-env.ts`):
   - **GitHub App mode** (`SHEPHERD_AGENT_GH_APP_ID`/`_KEY_FILE`): the agent holds a per-repo
     installation token (`src/agent-gh-app.ts:1-5`), so the PR is **opened by a bot** and Steward
     skips it (§1). **This mode already avoids the collision.**
   - **Operator-token default** (no agent mode set): the PR is opened under the operator's own
     login, so **Steward will act on it**. This is the case where the collision is real.
   - **Dedicated token file** (`SHEPHERD_AGENT_GH_TOKEN_FILE`): the operator's token stays out,
     but the author is whatever account owns that token. A machine user is a regular GitHub user,
     not a bot (Approvals counts it as a person), so Steward probably acts on it. **Unverified.**
2. **Duplicate review cost and duplicate steers.** The Code Review findings and the Shepherd critic
   overlap. Steward fixes the Code Review "Important" findings while the critic steers the task
   agent about the same lines, so both agents act on the same problem.
3. **The Approvals check rolls into "CI failure".** `worstChecks` (`src/forge/github.ts:1216`)
   turns any failing check into `failure`. If the **Claude Approvals** check reports a failing
   conclusion while it waits for a human seat (its exact conclusion in that state is **not
   documented on the pages read; unverified**), Shepherd's CI-fix steer would tell the task agent to
   "fix CI" for something no commit can fix. If it reports pending instead, the merge train waits
   correctly, because it is a required check (`requiredChecks`, `github.ts:3379`).
4. **Review threads are not resolved.** Steward and `/ship` reply to and resolve threads. Shepherd
   does neither, so a Shepherd PR on an Approvals repo with seat or thread rules can stay blocked
   without Shepherd showing why.

None of these needs action until an operator enables Claude Ship on a Shepherd repo. If one does,
(1) matters only under the operator-token or token-file modes; under App mode, (2)–(4) remain,
because the docs list only drafts and forks as Code Review skips, and no author-based skip for
Approvals.

## 4. What does not transfer

- **Replacing the critic with Code Review.** That would mean per-token cloud billing, GitHub only,
  and a dependency on Team/Enterprise. It also conflicts with the rule that in-app LLM work goes
  through subscription spawns. The critic stays.
- **Delegating CI and conflict work to Steward.** A new agent without context is worse than the
  author agent fixing its own PR, and the merge-in strategy conflicts with the repo's rebase rule.
- **Running `/ship` inside Shepherd sessions.** It needs auto mode, which conflicts with the
  bypass spawn. Even in auto mode it would duplicate what the session already does.

## 5. Recommendations (ranked)

### R1: Steer human and third-party review comments to the task agent (worth building)

This closes the one functional gap Steward exposes. When a newer `pull_request_review` or review
comment arrives from a person, or from an allowlisted bot (CodeRabbit, Copilot, Claude Code
Review), send its text to the live agent as a fenced `⟦UNTRUSTED⟧` steer, with the same
conventions as the critic findings steer. Review authors need write access, which mirrors
Steward's rule. Optionally reply to and resolve threads the agent addressed. The hook point already
exists, because `attachGitPush` sees each newer human review (`src/push.ts:1154`). It should be
attended-aware: in autopilot, steer automatically; in attended mode, show it and let the operator
approve.

### R2: Coexistence guard for repos running Claude Ship (cheap, do before anyone enables it)

The cheapest guard against the push collision already exists: **GitHub App mode**. PRs it opens
are bot-opened, so Steward never touches them (§3 item 1). Recommend it in the docs for any repo
that enables Claude Ship. The code guard below is for the operator-token and token-file modes, and
for the review and check issues that remain in every mode.

Detect the signs Claude Ship is active on a PR: the `claude-pr-steward-watching` label, a
`Claude Code Review` or `Claude Approvals` check, or commits from the Claude App. When they appear:

- When Steward is watching (only possible outside App mode), tell the task agent to **merge base
  in instead of rebasing and force-pushing** on that PR, or to keep its hands off. Show a badge on
  the card.
- Do not count the **Claude Approvals** check toward the CI-fix steer's red signal. Treat it like
  a review gate, not CI.
- Optionally skip the Shepherd critic when Code Review already ran on the same head (a
  `criticEnabled` auto-off), so reviews are not paid for twice.

This first needs one spike: confirm the Approvals check conclusion while it waits on a human seat
(§3 item 3).

### R3: Read `.claude/approvals.yml` in the merge train (consider later)

Teams will now write approval policy as code in a format Anthropic defines. The merge train could
**honor** a subset of it: path rules, `seats`, and `claude/diff = trivial`. That way an autonomous
Shepherd merge never lands something the repo's policy would send to a human, even on repos that
did not buy Claude Ship. This builds on the "per-repo policy file" direction of the
[AI-native SDLC playbook R2](ai-native-sdlc-playbook.md). Do not implement the whole schema; classifiers need
Anthropic's cloud runtime. Defer this until the beta schema settles: unknown keys make the file
fail, so the format is still moving.

### R4: Positioning (docs/site, optional)

Shepherd and Claude Ship now overlap in what they claim. The difference worth stating is that
Claude Ship covers PR open → merge for GitHub orgs, billed per token. Shepherd covers intent →
plan → build → PR → merge on one operator's subscription, on any forge, with the author agent
looping on its own PR. Do this only if the operator wants that comparison public.

## 6. Open questions

- Will repos Shepherd manages actually turn on Claude Ship, and under which agent credential
  mode? Under App mode, R2 reduces to the check and review items.
- Does Steward act on PRs opened by a machine user (token-file mode)? (A spike.)
- R1: steer automatically in autopilot, or always hold for the operator?
- What conclusion does the Approvals check report while it waits for a human? (A spike, from R2.)

## 7. Sources

- Article: https://claude.com/resources/articles/introducing-claude-ship (dated 2026-11-23)
- Docs: https://code.claude.com/docs/en/claude-ship, `…/ship-command`, `…/pr-steward`,
  `…/approvals`, `…/approvals-policy`, `…/approvals-classifiers`, `…/code-review-setup`
- Not read (page-fetch limit): Steward setup, security and troubleshooting pages; Approvals GitHub
  rules page; Code Review costs page.
- Shepherd source at `10a6d9332`, at the file:line references above.

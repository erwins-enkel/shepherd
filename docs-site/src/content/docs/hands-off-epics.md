---
title: Hands-off epics
description: The automation-pane settings that let an epic drain end-to-end without operator intervention, and the blockers that will still legitimately stop it.
---

An **epic** is a tracking issue whose sub-issues are wired by dependency edges. Shepherd spawns a
session per ready child, collects their PRs on a shared integration branch, and lands everything as
one final PR. With the right automation defaults, an epic drains **end-to-end without operator
intervention** — it only stops on a genuine blocker.

This page documents the best-practice **automation-pane** settings for that, and what will still
stop the epic (so hands-off never means unsafe).

> Don't have an epic yet? See [Authoring an epic](/authoring-epics/) to structure one Shepherd
> recognizes, then come back here to drain it.

> The automation pane holds **repo-wide** defaults — "Repo automation", not this task alone.
> The "Apply hands-off defaults" button on the Epic panel writes these same repo-wide defaults, so
> they apply to every task in the repo, not only the epic you launched it from.

## Recommended settings

Open the automation pane (the **⚙ automation** pill) and set:

| Setting             | Recommended | Why |
| ------------------- | ----------- | --- |
| **Autopilot**       | **On**      | Drives each session through routine stops toward a PR instead of handing back to you. |
| **Full-auto merge** | **On**      | The merge train lands each ready PR automatically. Turning it on forces **Draft mode off** (they are mutually exclusive). |
| **Critic**          | **On**      | Auto code-review when CI goes green (on by default). Required for Auto-Address. |
| **Auto-Address**    | **On**      | Feeds critic findings back to the agent automatically, so routine review comments don't need you. |
| **Plan gate**       | **On** (keep) | Adversarial plan review before each session executes — see below. This is the seeded default; keep it. |
| **Epic mode**       | **Auto**    | On the Epic panel, "auto" drains without asking. "Attended" waits for **Approve next** on every spawn. |

The Epic panel's **Apply hands-off defaults** button sets Autopilot, Full-auto merge (Draft off),
Critic, and Auto-Address in one click, and switches the epic to **auto** mode. It deliberately does
**not** touch Plan gate (see the next section).

### Plan gate is hands-off-safe — keep it on

It's a common misconception that Plan gate forces you to approve every session's plan by hand. That
is only true for a session meant to be driven by hand — **interactive, with Autopilot off**. A
session that is meant to run hands-free releases itself: either because it is drain-spawned (every
epic child is) **or** because Autopilot is on, which is why an interactive task with Autopilot on
also needs no Go. The one exception is a **Codex** session sharing its working directory — Autopilot
requires an isolated worktree, so that session waits for your Go regardless. For an epic:

- When the adversarial plan reviewer **approves** a plan, the session is released **straight into
  execution** — no operator approval needed.
- When the reviewer **requests changes**, the findings are steered **back into the planning agent
  automatically** and it revises, for up to **5 rounds**.
- Only if a plan **still can't be approved after 5 rounds** does the epic hand back to you — a
  genuine "this plan can't converge" signal that *should* stop it.

So Plan gate gives you an adversarial plan review on every session **for free**, without blocking a
hands-off drain. Keep it on. If you want to skip plan review entirely, you *can* turn it off in the
automation pane — you'll trade away that pre-execution check; Critic (post-CI code review) still
runs regardless.

### Sign-off authority — leave it on "human"

You don't need to change **Sign-off by**. The sign-off gate only applies in **Draft mode**, and the
hands-off recommendation runs with Draft mode **off** (Full-auto merge on). With Draft off, the
sign-off authority is inert, so leaving it at the default "human" is safe and does not hold anything
up.

## What still stops a hands-off epic

Hands-off does not mean unattended-and-unsafe. Most pauses are **transient** — the epic keeps
in-flight work running and resumes on its own — and only a few are **terminal** holds that need you.

**Transient (self-resolving, no action needed):**

- **A critic REWORK you have Auto-Address for.** A blocking critic verdict pauses spawning *new*
  sibling sessions while the in-flight session keeps auto-addressing the findings. It resolves and
  the epic continues on its own — unless the agent can't clear it within the auto-address round cap
  (then it becomes a terminal hold, below).
- **A plan under adversarial review.** The plan reviewer iterates with the planning agent (up to 5
  rounds) before anything executes.
- **Usage ceiling.** New spawns pause when 5-hour / weekly usage reaches the repo's ceiling (default
  80%), then resume as usage drops.
- **Concurrency cap.** Only *N* auto-sessions run at once (default 1); the rest queue.

**Terminal (needs you):**

- **A stuck session** that can't make progress.
- **A REWORK the agent can't auto-resolve** within the auto-address round cap.
- **A plan the adversarial reviewer can't get approved** within 5 rounds.
- **A critic error** — Shepherd won't advance on an uncertain review.
- **The credit ceiling** — Shepherd never keeps spending pay-as-you-go credit unattended.
- **Epic base-branch divergence** — a child PR retargeted off the epic integration branch; the epic
  is blocked until it's pointed back at the integration branch.
- **A stack that lost a middle layer**, if you run with
  [stacked epic children](/reference/stacked-epic-children/) on — the layers above it can't land
  until you abandon or merge them.

## Starting the epic

1. Make sure the epic exists (a parent issue with sub-issues or an `epic-dag` body) — see
   [Authoring an epic](/authoring-epics/) to create one, and [Concepts & glossary](/reference/glossary/)
   for the epic model.
2. Open the epic's panel from its issue row.
3. If it's your first epic, the **Run this epic hands-off** panel offers **Apply hands-off
   defaults** — or set the pane manually per the table above.
4. Confirm the epic is in **auto** mode and press **Start**.

Shepherd spawns the first ready child immediately, then drains the rest as their dependencies
complete, landing one aggregate PR at the end.

## How long will this epic take?

Hover an epic's **EPIC** badge in the Herd to see how long it has run and when it is forecast to
land. The epic's detail in **Repos** adds time tiles, a timeline of every step and a **Duration**
column in its step list. Both read the same epic clock and forecast.

### The epic clock

The epic clock measures how long the epic has **run** — not how long ago it started.

- It **starts the first time the epic runs** — usually when you press **Start**.
- It runs **only while the epic is running**. **Pause** stops it, and paused time never counts.
- Only one epic leads per repo at a time. When another epic **supersedes** it, the epic shows as
  **stopped**: its clock stands, but it is **not reset**. When that epic runs again, the clock
  carries on from where it stood, and the gap counts like a pause.
- It stops when the last step is in and the **landing** begins — the epic's PR into main, its CI
  and the merge. The landing is timed on its own.

Once the epic has landed, its **Total** runs from the first start to the landing's merge, minus the
pauses.

### Agent time and waiting time

The clock is wall time. Two more figures show what happened during it:

- **Agent time** is the summed run time of every agent session that worked on the epic's steps.
  Parallel agents each count in full, so it can exceed the clock.
- **Waited, no agent ran** is the time the clock ran while no agent worked on any step — for
  example between one step merging and the next one starting, or while the next spawn waited on
  the usage ceiling or on an agent slot held by a task outside the epic.

Paused time never counts as waiting: the clock stood still. **Pause** leaves running sessions
intact, though, so an agent that keeps working while the epic is paused still adds to agent time.

### How the forecast is built

The forecast plays the rest of the epic through in three parts:

1. **A duration per step.** Shepherd blends two sources: the repo's median
   [lead time](/reference/glossary/#lead-time) over the last 30 days, counted as two samples, and
   every step this epic has already finished, measured from its first session until it merged into
   the epic's integration branch. The estimate is their mean, so the epic's own pace takes over as
   its steps finish. A running step is given what is left of the estimate, but never less than a
   tenth of it; a step running past 1.5× the estimate is flagged as taking much longer than usual.
2. **The order.** The open steps are laid out in epic order over the repo's agent slots — the
   **Cap** in the automation pane, the concurrency cap above. A step starts once the steps it
   depends on are done and a slot is free, so with one slot the steps run one after another. The
   forecast assumes the epic has the slots to itself: an auto-started task outside the epic that
   takes a slot pushes the real finish later.
3. **The landing.** After the last step comes the landing, priced at the median of the repo's past
   epic landings, or 20 minutes when the repo has never landed one. Once the landing is underway,
   only its remainder is left.

While the epic is paused or stopped there is no finish time; the forecast shows **Remaining from
resume** instead. With no repo median and no finished step yet, there is no forecast at all.

### Range and confidence

The **range** plays the same schedule through twice more, with the 25th and the 75th percentile of
the blended step durations. Until three of the epic's own steps are measured, those two durations
are pushed out to at least 25 % below and 35 % above the estimate. The range narrows with every
finished step.

**Confidence** says how much of the forecast rests on this epic's own steps. The first row that
fits applies:

| Confidence   | When |
| ------------ | ---- |
| **high**     | At least half of the epic's steps have merged, or four or more are measured. |
| **medium**   | Two or three steps measured. |
| **low**      | One step measured. |
| **very low** | None measured yet — the forecast rests on the repo median alone, and says so ("repo median only"). |

### Why the first estimate is wide

Before the first step merges, the forecast knows nothing about this epic. Every step is priced at
the repo median — a median over tasks of every size, not over steps like these — the range is
widened, and confidence is **very low**. Read it as a rough guide. Each finished step replaces part
of that guess with the epic's own pace, and the range narrows.

The first forecast after the first merge is kept as the **first estimate**. If a later forecast
lands 15 minutes or more past it, the hover shows the slip ("so far ~…") and, when one step is
taking much longer than usual, names it.

### The "faster with N slots" hint

When a step is ready but waits for a free agent slot, the epic's detail in Repos can offer **With
N agent slots done around ~… instead of ~…**. It appears only when every slot is taken by an
auto-started session and one more slot would land the epic at least 15 minutes sooner. Its **Allow
N slots** button opens the Automation tab with the **Cap** focused; it never changes the cap
itself.

Raising the cap costs:

- **One more agent at a time.** That is the point — and it means more spend at once.
- **It is repo-wide.** The cap counts every auto-started session in the repo, not only this epic's,
  so every auto-started task there gets the extra slot.
- **Usage drains faster.** More agents at once reach the usage ceiling sooner, and new spawns pause
  there until usage drops.

## When the landing PR's CI is red

A red landing PR is not your turn straight away. The epic's card on the **Epics to land** band
shows the red checks (each with its log), and a **Who's handling it** bar with the steps Shepherd
still takes before it hands over:

1. **Checks re-run** — Shepherd re-runs the failed jobs up to **2 times per head commit**, since a
   red check is often a flake. This runs while Full-auto merge, Auto-Drain or an epic run is active,
   on GitHub only, and never in Draft mode.
2. **Agent repair** — if CI is still red, Shepherd starts **one** repair agent. It fixes the cause
   (or the PR's metadata, e.g. a too-long title) and pushes straight to the integration branch —
   no new PR. This step runs **only with Auto-Drain on**; with it off, the card says it was skipped
   and links to the repo automation.
3. **You** — only once nothing automatic is left does the card say **your turn**.

**Fix CI failures** on the card starts a repair agent yourself at any time — it bypasses Auto-Drain
and the one-repair limit, and is refused only while a repair agent is already working. After a
repair that did not help, the card offers **Try again** and a link to the last repair session. A
landing PR that conflicts with main has the counterpart, **Resolve conflicts**.

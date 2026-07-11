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
is only true for **interactive** sessions with Autopilot off. For an epic, every child is
drain-spawned, so:

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

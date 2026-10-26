---
title: Scheduled prompts
description: Run a prompt or /skill in a repo on fixed weekdays and times. Each run starts a fresh, normal Shepherd session.
---

A **schedule** runs a prompt in one repo on a recurring cadence: chosen weekdays at
one or more wall-clock times. The prompt can be free text or a `/skill`, for
example `/triage-feedback` on Mon–Fri at 09:00 and 18:00.

Each run starts a **fresh, normal session**. It gets a Herd card, notifies you when
it blocks, and goes through PR, critic, merge train and archive like a task you
start from New Task. The card shows a **Scheduled · \<name\>** badge.

## Setting one up

Open the repo's **Repo automation** settings and find **Schedules**. **Add** opens
a dialog with:

- **Name** and **Prompt** (free text or a leading `/skill`).
- **Days**: weekday chips, with **Mon–Fri** and **Daily** presets.
- **Times**: one or more `HH:MM` times.
- **Launch**: Autopilot, plan gate, agent, model, effort, sandbox, base branch and
  research, as in New Task. Blank means the default at run time. A blank base
  branch means the repo's default branch.

Each row shows the cadence, the next run and the last outcome. It also has an
on/off switch, **Run now**, **Edit** and **Delete**.

## When a schedule runs

- **Times are the Shepherd server's local time.** There is no per-schedule time
  zone. Around daylight-saving changes, a time skipped by the spring-forward
  change runs right after the gap, and a time repeated in autumn runs once.
- **Creating or enabling a schedule never runs earlier slots.** If you enable a
  09:00 schedule at 14:00, the first run is at the next slot. Changing the days
  or times works the same way.
- **Missed runs catch up once.** If Shepherd was stopped or herdr was in
  maintenance at a slot, the latest missed slot runs once when Shepherd is back.
  If a newer slot has already arrived, only that one runs. A slot missed by more
  than **12 hours** is skipped (`skipped, missed by over 12h`) rather than run late.
- **Overlap skips.** While the schedule's previous run is still open (not
  archived) or waiting in the hold queue, the next slot is skipped. Archive the
  session to let the next slot start.
- **Holds apply.** If usage is above the hold threshold, or a plugin refuses the
  spawn, the run waits in the hold queue like any new task.
- **Run now** starts a run immediately, even for a disabled schedule. It is still
  skipped while the previous run is open.

## Attended by default

Autopilot is **off** for a new schedule. A skill that asks questions, such as a
triage run that wants a plan confirmed, waits for you and sends a notification.

With autopilot on, the run behaves like any autonomous session. That includes the
egress allowlist and the trimmed agent context. Skills in the repo's own
`.claude/skills` still load, but personal `~/.claude/skills` do not.

## API

The web UI calls `GET/POST /api/schedules`, `PATCH/DELETE /api/schedules/{id}`,
`POST /api/schedules/{id}/run` and `GET /api/schedules/{id}/runs`. These routes
need the operator login or a full-scope access token. A repo-scoped token is
refused.

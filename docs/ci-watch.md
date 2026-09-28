# CI Watch

The bundled **CI Watch** plugin turns failing CI on a repo's default branch into GitHub issues
that Shepherd's normal drain can fix: plan gate, critic and learnings included. It watches
scheduled, push and manually dispatched runs. It flake-probes a failing job once, classifies it
and runs a read-only triage agent. Then it files an issue that asks for a reproduction and a fix.
It never merges anything. Autonomy stops at the pull request.

Pull-request CI is out of scope. Autopilot and the critic already handle it.

It ships with Shepherd and is **off until you enable it** under **Settings → Plugins → CI Watch**.

What it uses:

- **A GitHub repo.** Gitea lists runs, but can't rerun jobs or serve failed-step logs, so on
  Gitea there is no flake probe and triage sees no log.
- **The judge (optional).** The classification step is the
  [fast stop classifier's](https://docs.shepherd.run/reference/configuration/#fast-stop-classifier-the-judge) JEV judge:
  `SHEPHERD_JUDGE=1` plus `JEV_API_KEY`. Its spend counts toward `SHEPHERD_JUDGE_DAILY_USD`.
  Without it, classification is skipped and every failure goes to triage.
- **Your subscription.** Triage spawns a read-only Sonnet agent per failure. Plugin agents are
  capped at 2 in flight and 20 runs a day. A triage that can't start (over the cap, or no agent
  available) is retried with backoff: after 15 minutes, then doubling up to 6 hours.

## 1. Enable it

Under **Settings**:

- **Enabled**: the master switch. While it is off, every tick does nothing.
- **Poll every**: default 5 minutes (1–1440).
- **Skip the flake probe for workflows**: comma-separated workflow-name globs (default
  `Eval*`). Use it for slow or sampled workflows, where a rerun proves nothing.
- **Language**: the panel's language (English or German).

Click **Save settings**.

## 2. Watch repositories

A repo is watched only once you add it **and** its **Watch this repo** box is ticked. Pick it
under **Add repository** and click **Add and watch**. Local-only (lightweight) repos can't be watched; they have no forge CI.

Each watched repo has its own form:

- **Watch this repo**: untick it to stop watching without losing the settings.
- **Auto-drain filed issues** (default off): filed issues get only the `ci-failure` label, so you
  decide when to start them. Turn this on to also add the repo's drain label (`autoLabel`), so
  the drain picks them up by itself.
- **Consecutive failures before filing** (default 1, max 20): how many red runs in a row a job
  needs before it is considered.
- **Per-workflow thresholds**: overrides as `glob=N`, comma-separated, for example
  `nightly*=3, e2e=2`. Globs match the workflow **name** (`*` and `?`, case-insensitive). The
  first match wins; otherwise the repo threshold applies.

Click **Save repo**.

The first poll of a repo only records its history as a baseline. It never files anything for
failures that were already there.

## What gets filed

**Poll**: once per interval, one runs request per watched repo. Cancelled runs and startup
failures are ignored. Matrix legs collapse into one job (`test (ubuntu, 20)` → `test`), so a
failure is tracked per **workflow + job**. A green run of that job resets its streak.

**Rules**: a failing job moves on only when all of these hold:

- it is still red;
- it has no open issue from an earlier filing;
- this red streak hasn't been classified yet;
- its streak has reached the threshold;
- the repo has had fewer than **3** issues filed today (UTC).

**Flake probe**: the plugin reruns the failed jobs once. If the rerun passes, the failure is
marked flaky and nothing is filed. The next red run probes again. Workflows that match a skip
glob, and runs that can't be rerun, go straight to classification. A probe with no answer after
6 hours counts as inconclusive, and classification runs.

**Classification**: the JEV judge sorts the failure into regression, flaky, infra,
secret/config or eval variance. Only regressions and secret/config problems, with at least 60 %
probability, go on. When the judge is off or unavailable, every failure goes on.

**Triage**: one read-only agent per failure reads the failed-step log and the repo. It decides
whether a change inside the repo would fix it. Only `fixable` with `high` confidence is filed.
Everything else appears under **Rejected by triage**.

**Issue**: the title is `CI failure: <workflow> / <job>`. The body links the run and names the
workflow, job and commit. It asks for:

- a local reproduction;
- a fix of the root cause, never a disabled or weakened check;
- a draft pull request with an explanation if the failure can't be reproduced.

The log excerpt and the triage notes follow in fenced **untrusted** sections, so they are never
read as instructions.

## Rejected by triage

The panel lists the latest rejections (by the classifier or by triage) with their reason and run.
**File anyway** files one regardless and bypasses the daily cap. The issue notes that an operator
override filed it.

## Lifecycle sync

After every poll, the plugin syncs up to 10 of the issues it filed before (oldest sync first):

- **Closed on GitHub** (by anyone): the issue stops syncing. The job's next red streak files a new
  one.
- **Went green before anyone started**: the issue is closed with a comment.
- **Already started**: an issue is started once any Shepherd session was spawned for it, or it
  has the `shepherd:active` label. Shepherd never closes it and never steers or wakes that
  session.
- **Failed again after a fix**: the new issue links the earlier one under "Previous fix didn't
  hold". After **2** automatic attempts, it is still filed, but without the drain label, so a
  person decides.

## Status

The status block in the panel shows:

- the last poll;
- the count for each outcome in it;
- the last error.

**Poll now** runs a poll immediately. It still requires **Enabled**.

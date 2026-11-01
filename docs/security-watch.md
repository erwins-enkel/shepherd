# Security Watch

The bundled **Security Watch** plugin turns open GitHub code scanning and Dependabot alerts on a
repo's default branch into issues that Shepherd's normal drain can fix: plan gate and critic
included. It filters the alerts, groups them and runs a read-only triage agent. Then it files an
issue that asks for a fix. It never dismisses an alert and never merges anything. Autonomy stops
at the pull request.

Secret scanning is out of scope: the fix for a leaked secret is rotating it, not a pull request.

It ships with Shepherd and is **off until you enable it** under **Settings → Plugins → Security
Watch**.

What it uses:

- **A GitHub repo with alerts on.** Other hosts and local-only repos have none. The `gh` token
  needs to read alerts; a classic token with `repo` can. A refusal shows in the panel as
  `forbidden`.
- **Your subscription.** Triage spawns a read-only Sonnet agent per group. Plugin agents are capped
  at 2 in flight and 20 runs a day. A triage that can't start is retried with backoff: after 15
  minutes, then doubling up to 6 hours.

## Public repos: read this first

GitHub hides these alerts from the public, even on a public repo. The anonymous API answers 401 and
the alert page answers 404. Fixing one in the open can publish it, so a repo that doesn't read as
private needs your **explicit opt-in**, per repo, before the plugin triages or files anything
there. **File anyway** and **File again** are refused too. Until then the status counts `needs-ack`.

With the opt-in on, the issue itself stays redacted: see [What gets filed](#what-gets-filed). These
can still make a finding public:

- **The fix pull request** shows the area of the code.
- **Critic reviews** are posted to the pull request. The critic reads the plan the agent wrote after
  reading the alerts, so a review can state the rule, file and weakness, including that a fix is
  incomplete and still exploitable. This holds for any session started from these issues, drained or
  manual. To keep critic text off GitHub, turn off the critic for that repo.
- **The agent.** It is told to keep details out of comments, commit subjects and the pull request.
  Nothing enforces that.

A repo that reads as `internal`, or whose visibility can't be read, is treated as public.

If a private repo later goes public, issues already filed there become visible with their details.

## 1. Enable it

Under **Settings**:

- **Enabled**: the master switch. While it is off, every tick does nothing.
- **Poll every**: default 30 minutes (5–1440).
- **Language**: the panel's language (English or German).

Click **Save settings**.

## 2. Watch repositories

Pick a repo under **Add repository** and click **Add and watch**. Each watched repo has its own form:

- **Watch this repo**: untick it to stop watching without losing the settings.
- **Auto-drain filed issues** (default off): filed issues get only the `security-alert` label, so you
  decide when to start them. Turn this on to also add the repo's drain label (`autoLabel`).
- **Minimum severity** (default high).
- **Code scanning** and **Dependabot**: which alerts to read.
- **Include test, generated, library and docs findings, and dev dependencies** (default off).
- **I accept that findings in this repo can become public**: only on a repo that doesn't read as
  private.

Click **Save repo**.

Alerts already open when you add a repo are worked too, worst first, within the caps below.

## What gets filed

**Poll**: once per interval, one list per source. Code scanning alerts group by **rule + file**.
Dependabot alerts group by **package + manifest**.

**Filters and holds**: an alert is skipped, and counted in the status, when:

- it is below the minimum severity;
- its rule has no security severity (code-quality rules);
- it is in test, generated, library or documentation code, or a development dependency, unless
  included;
- it is a Dependabot alert with no patched version;
- it is a Dependabot alert younger than **24 hours**, so Dependabot's own pull request gets there
  first.

**Rules**: a group moves on only when all of these hold:

- it has no open issue;
- its alerts haven't been triaged already;
- the repo has had fewer than **3** issues filed today (UTC);
- it is among the **3** worst this poll (highest severity, then oldest). The rest wait for the next
  poll.

**Triage**: one read-only agent per group reads the alert text and the repo. Only `fixable` with
`high` confidence is filed. Everything else appears under **Rejected by triage**.

**Private repo issue**: the title is `Code scanning: <rule> in <file>` or `Dependabot: <package> in
<manifest>`. The body links the alerts and names the severity, tool and CWEs. The alert text and
triage notes follow in fenced **untrusted** sections.

**Redacted issue** (anything else): the title is `Fix GitHub security alert group cs-<n>: read each
alert listed in this issue with gh api; keep alert details out of public text`. The body lists one
`gh api` command per alert, up to 50, and the rules for keeping details private. No rule, file,
package, severity, alert text or triage notes. The agent reads the details itself.

Both ask for a fix of the root cause and never a dismissal, ignore comment or weakened scanner
configuration. For Dependabot, the agent first checks for an open Dependabot pull request and stops
if one covers the package.

## Rejected by triage

The panel lists the latest rejections with their reason. **File anyway** files one regardless and
bypasses the daily cap, though it still counts toward it. The issue notes that an operator override
filed it. A new alert in the group triggers a new triage.

## Lifecycle sync

After every poll, the plugin syncs up to 10 of the issues it filed before (oldest sync first):

- **Closed on GitHub** (by anyone): the issue stops syncing.
- **All its alerts gone before anyone started**: the issue is closed with a generic comment. This
  needs a complete read of that source in this poll. A failed or truncated read closes nothing.
- **Already started**: an issue is started once any Shepherd session was spawned for it, or it has
  the `shepherd:active` label. Shepherd never closes it and never steers or wakes that session.

A group files again only on evidence:

- an alert the last issue didn't account for becomes eligible, or
- its alerts were seen gone and came back.

**A closed issue with the same alerts still open doesn't re-file**: a rescan may still be pending, or
someone closed it on purpose. Those groups appear under **Closed, alerts still open**, with **File
again**. Relaxing a filter doesn't re-file alerts that were already open when the issue was filed.

After **2** automatic attempts, a group still files, but without the drain label, so a person decides.

## Status

The status block in the panel shows the last poll, the count for each outcome in it and the last
error. Each repo also shows its visibility and whether each source could be read: `ok`, `truncated`,
`disabled`, `no-analysis`, `forbidden`, `not-found` or `error`.

**Poll now** runs a poll immediately. It still requires **Enabled**.

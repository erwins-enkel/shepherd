# Sentry

The bundled **Sentry** plugin turns production errors into GitHub issues that Shepherd's normal
drain can fix: plan gate, critic and learnings included. The plugin polls Sentry, filters
out noise, and runs a read-only triage agent. It then files a trimmed, PII-scrubbed issue
that asks for a failing reproduction test and a fix. It never merges anything. Autonomy
stops at the pull request.

It ships with Shepherd and is **off until you enable it** under **Settings → Plugins →
Sentry**.

## Before you start: turn Seer off

If Sentry's own AI fixer (Seer / Autofix) runs on the same projects, both will open fixes
for the same error. In Sentry, disable Seer's automated issue fixes for every project you
map here. Self-hosted Sentry has no Seer.

## 1. Create a Sentry token

In Sentry, go to **Settings → Developer Settings → Custom Integrations** and create an
**internal integration** with these scopes:

| Scope          | Why                                                           |
| -------------- | ------------------------------------------------------------- |
| `org:read`     | List the organization's issues                                |
| `project:read` | Project slugs and code mappings                               |
| `event:read`   | The latest event (stack trace, breadcrumbs)                   |
| `event:write`  | Notes on the Sentry issue linking the GitHub issue and fix PR |

Copy the token.

## 2. Connect

Under **Settings → Plugins → Sentry**:

- **Sentry host**: `https://sentry.io`, or your self-hosted URL.
- **Organization slug**: e.g. `acme`.
- **Token**: paste it here. It goes into the plugin secret store (`plugin-secrets.json`,
  mode 0600). It is never shown again and never sent to the UI. Leave the field empty to keep
  the saved token. If no token is saved, the plugin falls back to `SHEPHERD_SENTRY_TOKEN`
  from the server environment.
- **Poll every**: default 5 minutes.
- **Minimum events**: only issues seen more than this many times (default 10).
- **Enabled**: tick it and **Save settings**.

## 3. Map repos to Sentry projects

The plugin only files for repos you have **confirmed** a mapping for. **Detect mappings**
suggests them, in this order:

1. **The repo's own Sentry config**: `org`/`project` in the Sentry bundler plugin options
   in `vite.config.*`, `svelte.config.js`, `webpack.config.*`, `next.config.*` or
   `astro.config.*`, then `.sentryclirc` (`[defaults]`), then `sentry.properties`.
2. **Sentry code mappings**: matched against the repo's `origin` remote. The endpoint is
   undocumented, so the plugin ignores any failure.
3. **Manual**: pick a repo and type the project slug.

Click **Confirm** on a suggestion to use it. A suggestion whose config names a different
organization is flagged.

### Auto-drain Sentry issues (per repo, default off)

By default, filed issues get only the `sentry` label. You decide when to start them. Turn on
**Auto-drain Sentry issues** for a mapping to also add the repo's drain label
(`autoLabel`), so the drain picks them up by itself.

## What gets filed

**Poll**: once per interval, ONE call for the whole organization:

```
GET /api/0/organizations/{org}/issues/?project=-1&sort=new&limit=100
    &query=is:unresolved issue.priority:high substatus:[new,escalating,regressed] times_seen:>N
```

If Sentry rejects the `substatus` filter, the plugin retries once without it and filters
the status itself.

**Rules**: an issue is considered only when all of these hold:

- its project is mapped to a repo;
- it is new, escalating or regressed;
- it is not assigned to a person (team assignment is fine);
- it has not been filed yet. A regressed issue is filed again only for a regression Sentry
  recorded after the earlier filing, once that GitHub issue was closed (Sentry's
  `set_regression` activity timestamp is the evidence). See [Lifecycle sync](#lifecycle-sync);
- the repo has had fewer than **3** issues filed today (UTC);
- its latest event has at least one in-app stack frame that points to a file that exists in
  the repo.

Then comes **triage**: one read-only agent per issue decides whether a fix inside the repo
is plausible. Only `fixable` with `high` confidence is filed. Everything else appears under
**Rejected by triage**, where **File anyway** overrides it.

**Issue**: the title is `Sentry <SHORT-ID>: production error in <project>`. It never
contains exception text. The body lists:

- the Sentry link;
- event and user counts;
- first and last seen;
- the repo files in the stack trace, so path-scoped learnings apply;
- the task: write a failing test that reproduces the trace, fix it, and put
  `Fixes <SHORT-ID>` in the PR body so Sentry resolves the issue on release. If no
  reproduction is possible, explain why and open the PR as a draft.

The Sentry data follows in fenced **untrusted** sections: the error, in-app frames,
allow-listed tags and the last breadcrumbs. Anyone with a public DSN can shape event
data, so it is never treated as instructions. Before anything is written, the plugin
scrubs:

- emails, IP addresses, tokens, JWTs and credentials in URLs;
- query-string values and UUIDs.

User, request, context and extra payloads are never included.

## Lifecycle sync

After filing, every poll also syncs up to 10 of the issues it filed before (oldest sync
first). A record stops syncing once its GitHub issue is closed.

- **Writeback**: a Sentry note links the GitHub issue. When the session working on it opens
  a PR, another note links the PR. Shepherd never resolves the Sentry issue itself — the
  `Fixes <SHORT-ID>` line and your release commits do that. If Sentry refuses a note (for
  example, the token lacks `event:write`), the plugin logs it and doesn't retry.
- **Resolved or ignored in Sentry before anyone started**: the GitHub issue is closed with a
  comment.
- **A person assigned in Sentry**: an unstarted GitHub issue is closed with a comment, so
  the drain stays out of their way.
- **Already started**: an issue is started once any Shepherd session was spawned for it, or
  it has the `shepherd:active` label. Shepherd never closes it and never steers or wakes
  that session.
- **Regressed after a fix**: the new GitHub issue links the earlier issue and its PR under
  "Previous fix didn't hold". After **2** automatic attempts, a regression is still filed but
  without the drain label, so a person decides.

The sync also runs when every mapped repo is at its daily cap. It is skipped while Sentry
asks the plugin to back off.

## Rate limits and failures

The plugin honours `Retry-After` and `X-Sentry-Rate-Limit-Reset` on a 429. If neither
header is present, it backs off exponentially, up to 1 hour. It also pauses when
`X-Sentry-Rate-Limit-Remaining` hits 0. A poll is skipped in any of these cases:

- herdr maintenance is running;
- the plugin is disabled or not configured;
- no repo is mapped.

When every mapped repo is at its daily cap, only the [lifecycle sync](#lifecycle-sync) runs.

The status block in the panel shows:

- the last poll;
- what happened to each issue in it;
- the last error;
- any backoff.

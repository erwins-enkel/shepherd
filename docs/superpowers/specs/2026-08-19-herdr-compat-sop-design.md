# herdr compatibility SOP — design

**Date:** 2026-08-19 · **Status:** approved (brainstormed in-session) · **Trigger:** herdr 0.8.2 shipped
while Shepherd's ceiling is 0.8.0 (#2056); the in-app updater blocks it, and the procedure that
cleared 0.8.0 (#2039) lives only in that issue's prose.

## Problem

Every herdr release above `HERDR_LAST_SUPPORTED_VERSION` (`src/herdr-capabilities.ts`) has to be
checked against Shepherd before the ceiling moves. Twice a herdr record-shape change silently
disabled husk reapers (#721, #2029); 0.8.0 changed last-tab teardown semantics (#2039 / herdr
#1760). #2032 asked for a mechanical record-shape gate and it is still open. The knowledge of
_what_ to check and _how_ (isolated headless A/B server) is scattered across issues and never
anchored in the repo, so each bump re-derives it.

## Goal

One repo-anchored standard operating procedure that (1) an agent or human finds automatically
when touching the version gates, (2) mechanises every measurable check from #2032/#2039 into a
script with a PASS/REVIEW/FAIL report, (3) keeps a growing learnings log, and (4) is triggered
by a GitHub issue form. The 0.8.2 bump itself runs afterwards as the first real use of the SOP.

## Decisions (with the operator)

| Decision | Choice |
| --- | --- |
| Scope of this change | SOP + tooling; the 0.8.2 check/bump is a separate follow-up issue |
| Trigger | Issue form only (`.github/ISSUE_TEMPLATE/herdr-compat.yml`). No cron (nobody needs it — the operator sees the blocked modal daily), no link from the update modal (it would show every Shepherd user a maintainer-only action) |
| Tooling depth | Full A/B: static diffs from the binary **and** live probes against isolated headless servers (candidate vs. baseline) |
| Learnings | A learnings table inside the rule **and** a committed report per checked version under `docs/herdr-compat/<version>.md` |

## Components

### 1. The rule — `.claude/rules/herdr-version-bump.md`

`paths:` frontmatter covers `src/herdr-capabilities.ts`, `src/config.ts`, `src/herdr-install.ts`,
`src/herdr-update.ts`, `src/generated/herdr-*`, `scripts/gen-herdr-*`, `scripts/herdr-compat*`, so
Claude Code loads it the moment an agent touches a version gate. Synced to the docs site via
`docs-site/scripts/sync-docs.mjs` → `PAGES` (title "herdr version bumps") and the Reference sidebar
in `docs-site/astro.config.mjs`. Sections:

1. **When this applies** — a herdr stable release > ceiling; preview builds only on request.
2. **Non-negotiables** — the ceiling moves only in a PR that carries a `docs/herdr-compat/<v>.md`
   report with zero FAIL; `HERDR_SOCKET_SUPPORTED_PROTOCOLS` stays an explicit allowlist (18 never
   shipped stable); floors (`HERDR_EXTERNAL_REGISTRATION_VERSION`, `HERDR_FIRST_PANE_CONTROL_VERSION`)
   never move for a ceiling bump; `HERDR_LAST_FULL_SANDBOX_STATUS_VERSION` moves only when the
   #1716 probe flips; never touch the operator's live daemon — the script runs isolated servers.
3. **Procedure** — read release notes with a keyword list (tab/pane/agent/workspace/worktree/
   socket/api/protocol/CLI/close/status); run `bun run herdr:compat -- --candidate <v>`; triage
   REVIEW items by hand; regenerate schema/types/fixtures against the candidate; write code for
   every behavioural change; bump constants; update docs pins; What's-New entry; commit the report.
4. **Learnings table** — version → what broke → fix → ref, seeded from #721, #1890/#1893, #1716,
   #2029, #2032, #2039/#2056 (last-tab, protocol 18, org rename, `worktree --json`), #1898, #569,
   #1596, terminal contract (`scripts/verify-herdr-terminal.ts`). Every bump PR extends it.
5. **Bump PR checklist** — every file a bump touches (from #2056's diff): constants,
   `src/generated/herdr-schema.json` + `herdr-protocol.ts` (`check:herdr-types`),
   `test/fixtures/herdr-responses/manifest.json`, `test/herdr-capabilities.test.ts` pins,
   README "supports herdr up to", `docs-site/src/content/docs/getting-started.md`,
   `docs-site/scripts/gen-cli-reference.ts` → `EXPECTED_HERDR_VERSION` + regenerated CLI pages,
   `ui/src/lib/feature-announcements/entries/v<next>-herdr-<v>.ts` + EN/DE keys, the report file.

### 2. The script — `bun run herdr:compat -- --candidate <version> [--baseline <version>] [--static-only]`

Entry `scripts/herdr-compat.ts`; modules under `scripts/herdr-compat/`:

- `download.ts` — resolves the asset via `herdrAssetKey()` / `herdrReleaseUrl()` from
  `src/herdr-install.ts`, downloads to `~/.cache/shepherd/herdr-compat/<version>/herdr`
  (`chmod 755`), verifies `herdr --version` matches exactly (mirrors the downgrade path's
  verification; no SHA-256 — out of scope). Baseline defaults to the installed `config.herdrBin`
  if its version equals `HERDR_LAST_SUPPORTED_VERSION`, else downloads the ceiling.
- `schema-diff.ts` (pure) — `diffSchemas(base, candidate)`: protocol number, request methods
  added/removed, request-param property removals / newly-required params, result-variant property
  removals, enum narrowing/widening. `recordShapeGate(base, candidate)`: for `TabInfo`, `PaneInfo`,
  `AgentInfo` in `schemas.success_response.$defs` and `schemas.event.$defs` — field removed,
  required→optional, non-nullable→nullable ⇒ FAIL; added fields ⇒ info.
- `cli-surface.ts` (pure + runner) — `SHEPHERD_HERDR_COMMANDS` (the subcommands Shepherd invokes:
  `tab create/close/list/rename`, `pane run/close/list/process-info/send-keys/send-text/report-agent/
  report-agent-session`, `agent list/rename/send`, `workspace list/create`, `worktree add/list/
  prune/remove`, `api schema`, `status`, `server stop`, `update`), `parseHelpFlags(text)`,
  `diffHelp(base, candidate)`: removed flag / missing subcommand ⇒ FAIL, added ⇒ info.
- `isolated-server.ts` — `startIsolatedServer(bin, label)`: own `HOME`, `XDG_CONFIG_HOME`,
  `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`, `HERDR_SOCKET_PATH`, `HERDR_ENV` unset,
  under a short symlinked path (108-char socket limit); waits for `herdr status server` = running;
  `run(argv)` executes the CLI with that env and parses JSON; `stop()` = `herdr server stop` +
  remove symlink/dir; registered on `exit`/`SIGINT`/`SIGTERM` so no server survives an abort.
  Verified by hand in this session: the real daemon at `~/.config/herdr/herdr.sock` is untouched.
- `probes.ts` — per server, returns observations; the runner computes verdicts by comparing
  candidate vs. baseline:
  - L1 `tab list` → every tab has non-null `label` (FAIL if null)
  - L2 agentless tab has `agent_status: "unknown"` (FAIL otherwise)
  - L3 `pane process-info --pane <id>` on an agentless pane returns ≥1 foreground process after the
    shell settles (poll ≤5 s; FAIL if empty — that is the "reap nothing" failure mode of #2029)
  - L4 close a tab, create another: new `tab_id` ≠ closed id (FAIL if reused; #569)
  - L5 close the workspace's last tab → record `refused` / `closed-workspace-survives` /
    `closed-workspace-destroyed`; REVIEW if it differs from baseline (Shepherd handles both since
    #2056, so never FAIL)
  - L6 spawn-path replay: `workspace create` → `tab create --cwd --label --no-focus` →
    `pane run <pane> "sleep 300"` → `pane report-agent-session … --source shepherd --agent <n>
    --agent-session-id <id>` → `pane report-agent … --state working` → `agent list`: the agent
    record's key set must be a superset of the baseline's (lost key ⇒ FAIL); `agent_status` must be
    `working` (else REVIEW)
  - L7 `pane report-agent … --state idle` → observed status; `done` = unchanged #1716 (PASS,
    floor stays 0.7.4); `idle` ⇒ REVIEW ("#1716 may be fixed — consider moving
    `HERDR_LAST_FULL_SANDBOX_STATUS_VERSION`")
  - L8 `worktree list --porcelain` exits 0 in a throwaway `git init` repo (FAIL otherwise)
  - L9 `scripts/verify-herdr-terminal.ts` run with `HERDR_BIN=<candidate>` and the candidate
    server's env; non-zero exit ⇒ FAIL
- `report.ts` (pure) — renders the markdown report: header (candidate, baseline, protocols,
  release-notes URL, date, host platform, command line), verdict summary, one section per check
  with A/B tables and diff excerpts, and a "Next steps" block naming the regenerate commands
  (`HERDR_BIN=<cache> bun run gen:herdr-schema && bun run gen:herdr-types`, `gen:herdr-fixtures`)
  and the rule. Written to `docs/herdr-compat/<candidate>.md` (overwrites) and echoed to stdout.
  Exit code 1 if any FAIL, 0 otherwise (REVIEW never fails the run).

Tests (bun, offline): `test/herdr-compat-schema-diff.test.ts` (synthetic p17-vs-p19-style
fixtures: added method, removed method, required→optional, nullable flip, enum widen/narrow; the
vendored schema against itself = zero drift), `test/herdr-compat-cli-surface.test.ts`
(`parseHelpFlags` on captured help text; removed/added flags), `test/herdr-compat-report.test.ts`
(verdict roll-up, exit-code rule, file name). The live half is exercised manually: a self-A/B of
the installed 0.8.0 against itself must be all-PASS, and a dry run against 0.8.2 must complete and
produce a report (its content is the follow-up issue's input; the ceiling is **not** moved here).

### 3. The trigger — `.github/ISSUE_TEMPLATE/herdr-compat.yml`

Issue form "herdr compatibility check": title prefix `herdr <version>: compatibility check`,
label `herdr-compat` (created once via `gh label create`), fields: candidate version (required),
release-notes URL, protocol number (optional), "what the release notes flag" (textarea), and a
rendered phase checklist that links to the rule on the docs site and in the repo. The detailed
checklist lives only in the rule so the two cannot drift.

### 4. Visibility

README's "Shepherd supports herdr up to …" callout and `getting-started.md` gain one sentence
linking the SOP. `CLAUDE.md` stays untouched (rules self-load).

## Out of scope / follow-ups

- The 0.8.2 check and bump (follow-up issue created from the new template at the end of this PR).
- Cron-based detection; update-modal deep link; running the live half in CI (possible on Linux
  runners, but only after the script has carried one real bump); SHA-256 asset verification.

## Success criteria

- `bun run herdr:compat -- --candidate 0.8.0` (installed binary as both sides) exits 0 with every
  check PASS; `--candidate 0.8.2` completes and writes `docs/herdr-compat/0.8.2.md` (content
  informational; not committed by this PR).
- The real daemon's socket/status is unchanged before vs. after a run.
- `bun run lint`, `bun run test` (root), `cd ui && bun run check:docs-manifest`, docs-site
  `bun run check && bun run build` pass; the rule renders under Reference.
- Creating an issue from the new template applies `herdr-compat` and shows the phase checklist.

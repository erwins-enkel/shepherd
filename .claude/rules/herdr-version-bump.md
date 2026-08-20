---
paths:
  - "src/herdr-capabilities.ts"
  - "src/config.ts"
  - "src/herdr-install.ts"
  - "src/herdr-update.ts"
  - "src/generated/herdr-*"
  - "scripts/gen-herdr-*"
  - "scripts/herdr-compat*"
  - "scripts/verify-herdr-terminal.ts"
---

# herdr version bumps (REQUIRED before raising the support ceiling)

Shepherd drives an exact, measured herdr surface. `HERDR_LAST_SUPPORTED_VERSION` in
`src/herdr-capabilities.ts` is a **verified ceiling, not a guess**: every release above it is
unknown territory until this procedure has run against it. Twice a herdr record-shape change
silently killed husk reapers that kept compiling and logging nothing (#721, #2029); 0.8.0
changed last-tab teardown semantics underneath a best-effort `closeTab` (#2039). This SOP exists
so the next bump measures instead of assumes.

**Trigger:** a herdr **stable** release above the ceiling (the in-app updater shows "blocked",
the preflight banner warns). Open the check from the issue form **"herdr compatibility check"**
(`.github/ISSUE_TEMPLATE/herdr-compat.yml`, label `herdr-compat`). Preview builds only on
explicit request — the protocol allowlist deliberately skips preview-only protocols (18 never
shipped stable).

## Non-negotiables

- **The ceiling moves only in a PR that carries `docs/herdr-compat/<version>.md`** — the report
  `bun run herdr:compat` writes — **with zero FAIL** and every REVIEW triaged in writing (in the
  report or the PR).
- **`HERDR_SOCKET_SUPPORTED_PROTOCOLS` (`src/config.ts`) is an explicit allowlist, not a floor.**
  Admit a new protocol by number, after the schema diff shows what it changed.
- **Floors are floors.** `HERDR_EXTERNAL_REGISTRATION_VERSION` (0.7.5) and
  `HERDR_FIRST_PANE_CONTROL_VERSION` (0.7.3) never move for a ceiling bump.
  `HERDR_LAST_FULL_SANDBOX_STATUS_VERSION` (0.7.4) moves **only** when the L7 probe shows
  herdr #1716 actually fixed (an externally-registered agent's `--state idle` landing on `idle`,
  not `done`) — re-verify by hand before touching it.
- **Never touch the operator's live daemon.** All live verification runs against isolated
  headless servers (own `HOME`/`XDG_*`/`HERDR_SOCKET_PATH`); `scripts/herdr-compat/isolated-server.ts`
  is the recipe. If you find yourself pointing a probe at `~/.config/herdr/herdr.sock`, stop.
- **Declining a version is a valid outcome.** If a FAIL can't be addressed, the issue documents
  why (as #2039 documented 0.8.0's teardown change), the ceiling stays, and the blocked updater
  is correct behaviour.

## Procedure

1. **Read the candidate's release notes** (`https://github.com/herdrdev/herdr/releases`),
   watching for: tab/pane/agent/workspace lifecycle, close/teardown semantics, socket API or
   protocol, CLI flags, status/detection, install/update/asset changes, org or licence moves.
2. **Run the check:** `bun run herdr:compat -- --candidate <version>`. Static half: schema diff,
   the #2032 record-shape gate (`TabInfo`/`PaneInfo`/`AgentInfo` required/nullable drift = FAIL),
   and a `--help` diff over every subcommand Shepherd invokes. Live half: candidate vs. baseline
   (= current ceiling) as isolated servers, probes L1–L9 (reaper assumptions from #2029/#2032,
   tab-id reuse #569, last-tab behaviour #1760, the external-registration spawn replay #1890,
   the #1716 idle probe, the status surface, and the terminal contract via
   `scripts/verify-herdr-terminal.ts`). Report: `docs/herdr-compat/<version>.md`, exit 1 on FAIL.
3. **Triage every REVIEW, fix or consciously accept every FAIL.** Behavioural changes get code
   (as #2056's last-tab guard did) and a test pinning the new behaviour.
4. **Regenerate the vendored protocol** against the candidate:
   `HERDR_BIN=~/.cache/shepherd/herdr-compat/<version>/herdr bun run gen:herdr-schema && bun run gen:herdr-types`,
   then `bun run gen:herdr-fixtures` against a live candidate server (`check:herdr-types` gates CI).
5. **Walk the bump-PR checklist below**, extend the learnings table, run `bun run lint` and
   `bun run test`, and ship — ceiling bump, verification report and behavioural fixes in one PR.

## Bump-PR checklist

Every past bump touched more than the constants. From #2056's diff:

- [ ] `src/herdr-capabilities.ts` — `HERDR_LAST_SUPPORTED_VERSION`, `HERDR_LAST_SPAWNABLE_VERSION`
      (+ version pins in `test/herdr-capabilities.test.ts`)
- [ ] `src/config.ts` — extend `HERDR_SOCKET_SUPPORTED_PROTOCOLS` by name if the protocol moved
- [ ] `src/generated/herdr-schema.json` + `src/generated/herdr-protocol.ts` regenerated
- [ ] `test/fixtures/herdr-responses/manifest.json` recaptured (`gen:herdr-fixtures`)
- [ ] `docs/herdr-compat/<version>.md` — the report, committed
- [ ] `README.md` "supports herdr up to" + `docs-site/src/content/docs/getting-started.md`
- [ ] `docs-site/scripts/gen-cli-reference.ts` — `EXPECTED_HERDR_VERSION` pin + regenerated CLI
      pages (the check-generated-docs gate fires on the source edit)
- [ ] What's-New entry `ui/src/lib/feature-announcements/entries/v<next>-herdr-<version>.ts` + EN/DE keys (see the feature-catalog rule; the update modal blocks silently otherwise —
      the entry is where the operator learns the ceiling moved)
- [ ] Learnings table below extended with what this version taught us

## Learnings (extend with every bump)

| Version | What broke / what we learned                                                                                              | Fix                                                                                                | Ref                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------- |
| 0.6.x   | Record-shape change silently killed a husk reaper — code compiled, logged nothing                                         | Reaper fixed; lesson became #2032's gate                                                           | #721                      |
| 0.7.5   | `agent start` reshaped (canonical launcher); Shepherd's spawn broke                                                       | External-registration spawn path: `tab create` → `pane run` → `report-agent`                       | #1890, #1893              |
| 0.7.5   | Externally-registered agents can't report `idle` (lands on `done`) — sandbox status stuck                                 | `HERDR_LAST_FULL_SANDBOX_STATUS_VERSION` floor at 0.7.4 + two-path downgrade advisory              | herdr #1716, #1898        |
| 0.7.5   | `pane.label` / `agent.name` went optional; FOUR reapers dead at once, silently                                            | Key reapers on the tab label; fixture-shape regression tests                                       | #2029, #2034              |
| 0.8.0   | Closing a workspace's last tab destroys the workspace (was: refused) — `closeTab` swallowed the refusal harmlessly before | Last-tab guard at the closeTab choke point, both drivers; teardown rebuilds via `ensureWorkspace`  | #2039, #2056, herdr #1760 |
| 0.8.0   | Protocol 18 never shipped stable                                                                                          | Allowlist admits protocols by name, never `>=`                                                     | #2039                     |
| 0.8.0   | Upstream org rename (`ogulcancelik` → `herdrdev`) — install/downgrade hung off a GitHub redirect                          | All three URL sites in `herdr-install.ts` moved (incl. the shell template that builds its own URL) | #2039, #2056              |
| any     | `tab_id`s must not be reused across a close                                                                               | Probed on every bump (L4)                                                                          | #569                      |
| any     | A pane-inherited `HERDR_SOCKET_PATH` can override an explicit `HERDR_SESSION`                                             | Session socket wins; scrub `HERDR_ENV` in isolated probes                                          | #1596                     |
| any     | The terminal NDJSON contract (`socket-pty-bridge`) can drift without a schema change                                      | `scripts/verify-herdr-terminal.ts` runs as probe L9                                                | #1639                     |

## Opportunities file

Release notes often carry chances, not just risks (#2039 flagged `HERDR_PROCESS_DETECTION=child-groups`
as a path to retiring the sandbox advisory). Note them in the compat issue under "Opportunities" —
they become follow-up issues, never scope creep in the bump PR.

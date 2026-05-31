# Shepherd — Roadmap / TODO

## Backlog (from PRD)

- [ ] Per-project icon picker — F12 (untracked in PRD phasing; not built)
- [ ] Research chat with sub-agents + searxng; saved history — F9. Confirm searxng is still in stack.
- [ ] Hermes migration off `claude -p` onto interactive-via-herdr — compliance-critical, likely its own milestone (workstream 3)
- [ ] Per-agent sandboxing (firejail/bwrap/nspawn) + permission profiles — I3/I4, before any unattended autonomy

## Attention-routing (new — not in PRD; the "don't be the bottleneck" gap)

> Observation half is shipped (status lights, terminals, All-view). These close the
> act/triage half: pull the operator back, and help decide which agent first.

- [x] Blocked-triage queue — list of red agents + WHY each is blocked (tailed from terminal:
      permission prompt / question / test fail), batch-answer w/ quick replies. Server heuristic
      classifier + poller emit `session:block` + POST `/reply` (types into PTY) + "Needs you" drawer.
- [x] Agent activity feed — render existing PreToolUse/PostToolUse hook data as compact
      human log per agent ("edited server.ts · ran tests (2 failed) · waiting").
- [x] Push notifications — Web Push from PWA on blocked(needs-you)/done; reuses F3 hook
      telemetry + herdr status. Per-device locale → localized notification payloads (EN/DE).
- [x] Inline diff review — per-worktree `git diff` panel in HUD; review before merge,
      ToS-clean (read-only git). Precursor to F6 merge buttons.
- [x] Saved steers / broadcast — canned prompts ("commit & push", "rebase", "run tests")
      as one-tap buttons; optional fan-out to N selected agents. Mobile-critical.

## PRD open questions still unresolved

- [ ] Q5: Hermes migration sequencing — same milestone or after the rest of the backlog

## Done

- [x] In-app self-update — version badge + commit list + one-tap pull→build→restart when behind origin/main
- [x] Internationalization — Paraglide i18n (EN + DE catalogs) with in-app language switcher
- [x] PR status in session list — per-session PR/CI badge in the row + grid views (PrPoller snapshot)
- [x] Headless core: spawn interactive claude in worktrees via herdr, REST + WS (/events, /pty)
- [x] HUD UI: SvelteKit5 + Tailwind4 + xterm.js, status lights, live scrollable terminal
- [x] Repo + branch pickers (autocomplete, ~/Work compaction, most-recently-used default)
- [x] Per-project TODO.md panel (view + toggle + add + completed-item cleanup) — F8
- [x] Prompt sources: seed a task from a local TODO/issue or browse issues (GitHub + Gitea/Forgejo) — open-only
- [x] Per-session model picker (default/opus/sonnet/haiku)
- [x] Session decommission UI
- [x] Responsive mobile HUD + horizontally scrollable mobile control-key row — F4/I6
- [x] All/Focus view modes — read-only live terminal grid of the whole herd — F4 "All view"
- [x] Image drag-and-drop / paste → staged path injected into the prompt (bracketed-paste) — F11
- [x] Real usage/cost tracking from ~/.claude JSONL — per-session tokens + 5h/weekly gauges (daily `/usage` calibration, live recompute) — F10/I5
- [x] Git host PR/merge/redeploy buttons — F6/F7. Platform-agnostic (GitHub via `gh` + Gitea/Forgejo via REST); direct host API (resolves Q3); contextual rail in Viewport header; `~/.shepherd/forges.json` config.

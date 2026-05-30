# Shepherd — Roadmap / TODO

## Backlog (from PRD)

- [ ] Per-project icon picker — F12 (untracked in PRD phasing; not built)
- [ ] Research chat with sub-agents + searxng; saved history — F9. Confirm searxng is still in stack.
- [ ] Hermes migration off `claude -p` onto interactive-via-herdr — compliance-critical, likely its own milestone (workstream 3)
- [ ] Per-agent sandboxing (firejail/bwrap/nspawn) + permission profiles — I3/I4, before any unattended autonomy

## PRD open questions still unresolved

- [ ] Q5: Hermes migration sequencing — same milestone or after the rest of the backlog

## Done

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

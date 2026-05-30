# Shepherd — Roadmap / TODO

## Done

- [x] Headless core: spawn interactive claude in worktrees via herdr, REST + WS (/events, /pty)
- [x] HUD UI: SvelteKit5 + Tailwind4 + xterm.js, status lights, live terminal
- [x] Autocomplete repo picker
- [x] Per-project TODO.md panel (view + toggle + add)

## In progress (v4)

- [ ] Pick a TODO/issue when creating a task to seed the prompt
- [ ] Browse upstream GitHub issues (list + prompt-infusing selection)
- [ ] Custom opaque repo dropdown with ~/Work path compaction

## Next

- [ ] Responsive UI — works perfectly on mobile (v5)

## Backlog (from PRD)

- [ ] Git host buttons: open PR / merge / redeploy (gitea or forgejo)
- [ ] Research chat with sub-agents + searxng; saved history
- [ ] Real usage/cost tracking from ~/.claude session JSONL
- [ ] Hermes migration off `claude -p` onto interactive-via-herdr (compliance-critical)
- [ ] Per-agent sandboxing + permission profiles
- [ ] Drag-and-drop screenshots into the prompt

## Known minor follow-ups

- [ ] HEAD requests to non-API routes return 404 (browsers use GET; cosmetic)
- [ ] Viewport model label is a static "claude-4" hint

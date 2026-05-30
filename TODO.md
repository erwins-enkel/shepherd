# Shepherd — Roadmap / TODO

## Done

- [x] Headless core: spawn interactive claude in worktrees via herdr, REST + WS (/events, /pty)
- [x] HUD UI: SvelteKit5 + Tailwind4 + xterm.js, status lights, live terminal
- [x] Autocomplete repo picker
- [x] Per-project TODO.md panel (view + toggle + add)

## In progress (v4)

- [x] Pick a TODO/issue when creating a task to seed the prompt
- [x] Browse upstream GitHub issues (list + prompt-infusing selection)
- [x] Custom opaque repo dropdown with ~/Work path compaction

## Next

- [x] Responsive UI — works perfectly on mobile (v5)

## Backlog (from PRD)

- [ ] Git host buttons: open PR / merge / redeploy (gitea or forgejo)
- [ ] Research chat with sub-agents + searxng; saved history
- [ ] Real usage/cost tracking from ~/.claude session JSONL
- [ ] Hermes migration off `claude -p` onto interactive-via-herdr (compliance-critical)
- [ ] Per-agent sandboxing + permission profiles
- [ ] Drag-and-drop screenshots into the prompt

## Known minor follow-ups

- [x] HEAD requests to non-API routes return 404 (browsers use GET; cosmetic)
- [x] Viewport model label is a static "claude-4" hint — now per-session model picker (default/opus/sonnet/haiku)
- [x] Checking off items doesn't rearrange the to-do list status grouping
- [x] New task sheet offers all todos, even those checked off. Make sure only open issues are presented as well.
- [x] Repo filter should optionally sort by most recently used. It currently defaults to the first in the list. Should default to the last used.
- [x] Provide branch drop-down instead of just a text field similar to repo selection
- [x] Add clean up action for todo.md removing completed items and making sure the todo.md follows best practices
- [x] Can't scroll terminal window
- [x] Add decommission session UI

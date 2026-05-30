# Shepherd

Two packages, each with own deps: root (herdr/server, `bun`) + `ui/` (SvelteKit).

## Running checks in a fresh worktree

Shepherd worktrees start without `node_modules`. Install per package before linting/checking/testing:

| Package | Install                | Lint/check      | Test       |
| ------- | ---------------------- | --------------- | ---------- |
| Root    | `bun install`          | `bun run lint`  | `bun test` |
| UI      | `cd ui && bun install` | `bun run check` | `bun test` |

Run both halves when a change spans server + UI.

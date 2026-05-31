# Shepherd

Two packages, each with own deps: root (herdr/server, `bun`) + `ui/` (SvelteKit).

## Running checks in a fresh worktree

Shepherd worktrees start without `node_modules`. Install per package before linting/checking/testing:

| Package | Install                | Lint/check      | Test       |
| ------- | ---------------------- | --------------- | ---------- |
| Root    | `bun install`          | `bun run lint`  | `bun test` |
| UI      | `cd ui && bun install` | `bun run check` | `bun test` |

Run both halves when a change spans server + UI.

## Internationalization (REQUIRED for any UI work)

The UI is fully internationalized with Paraglide JS (EN + DE). **Never hardcode user-facing text.** Every display string — labels, buttons, placeholders, `title`/`aria-label`, empty/error/loading states, toast text, and **server-side notification payloads** — must route through a message:

1. Add the key to **both** `ui/messages/en.json` and `ui/messages/de.json`. Keys are snake_case and component-prefixed (`viewport_diff_tab`, `broadcast_failed`, `prbadge_open`); use `{param}` for interpolation.
2. Import and call it: `import { m } from "$lib/paraglide/messages"` → `m.my_key()` / `m.my_key({ count })`.
3. Reuse existing keys where one fits (e.g. `common_close`, `common_loading`).

Data passed through verbatim (tool-use summaries, PR titles, designations like `TASK-07`) is **not** translated — only chrome the app itself authors.

**Gate:** `cd ui && bun run check:i18n` enforces that all locale catalogs share an identical, non-empty key set (Paraglide silently falls back to EN for a missing key, so an incomplete `de.json` would otherwise ship looking fine). It runs in CI `verify` and the pre-push hook — a PR that adds an EN key without its DE counterpart fails. It does not detect hardcoded strings that skip the catalog entirely; that's on you and review.

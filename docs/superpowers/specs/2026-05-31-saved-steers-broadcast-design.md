# Saved steers / broadcast — design

## Summary

A **steer** is a canned prompt: `{ id, label, text }`. Operators save a list of
them and inject one into a session with a single tap instead of retyping common
instructions ("commit & push", "rebase", "run tests").

Two send paths:

- **Single** — tapping a steer chip fires `text + Enter` into the **focused**
  session immediately.
- **Broadcast** — the same text is fanned out to a **multi-selected set** of
  active sessions at once.

The canned list is stored **server-side** (shared across all devices reaching
Shepherd over Tailscale). Send mode is **fire immediately**; broadcast adds a
confirm step (the target picker).

## Server (`src/`)

### Storage

A single `steers` key in the existing settings KV
(`store.getSetting` / `store.setSetting`) holds a JSON-encoded array of
`{ id, label, text }`. On first read when the key is unset, seed and persist the
three defaults:

```
[
  { label: "commit & push", text: "commit & push" },
  { label: "rebase",        text: "rebase onto the base branch" },
  { label: "run tests",     text: "run the tests" },
]
```

(The seed `text` values are reasonable starting prompts; the operator edits them
in Settings.)

### Endpoints

- **`GET /api/steers`** → `Steer[]` (seeds + persists defaults if unset).
- **`PUT /api/steers`** with body `Steer[]` → validate, persist, return the
  normalized array.
- **`POST /api/broadcast`** with body `{ text: string, ids: string[] }` →
  `{ sent: number, total: number }`. Routed **before** the `/api/sessions/:id`
  matchers so `broadcast` is not mistaken for a session id. (Lives at top level
  `/api/broadcast`, not under `/api/sessions`, because it spans many sessions.)

All three require `Content-Type: application/json` for the body-bearing methods,
matching the existing `reply` route's guard.

### Validation (`validate.ts`)

`validateSteers(body): Steer[] | null` — mirrors the `validateRoot` style:

- body must be an array, length ≤ **40**.
- each entry: `label` and `text` are strings, trimmed, non-empty,
  `label` ≤ **60** chars, `text` ≤ **4000** chars.
- `id`: reuse a provided string id, else assign `randomUUID()`.
- returns the normalized array, or `null` on any violation (route returns 400
  with a message).

`validateBroadcast(body): { text: string; ids: string[] } | null` — `text`
trimmed non-empty (≤ 4000), `ids` an array of non-empty strings. `null` → 400.

### Service (`service.ts`)

```ts
/** Fan a steer out to many sessions. Skips unknown ids. */
broadcast(ids: string[], text: string): { sent: number; total: number } {
  let sent = 0;
  for (const id of ids) if (this.reply(id, text)) sent++;
  return { sent, total: ids.length };
}
```

Reuses the existing `reply(id, text)` (which appends `\r` and injects via
`herdr.send`). No new herdr surface.

## UI (`ui/src/`)

### Types & store

- `Steer { id: string; label: string; text: string }` in `lib/types.ts`.
- `lib/steers.svelte.ts` — a controller class (pattern from `theme.svelte.ts`):
  - `list = $state<Steer[]>([])`, loaded via `getSteers()` on construction.
  - `add()`, `update(id, patch)`, `remove(id)` mutate `list` then `persist()`
    (`putSteers(list)`); on server rejection, reload from server.
  - exported singleton, imported by `SteerBar` and `Settings`.

### API (`lib/api.ts`)

- `getSteers(): Promise<Steer[]>`
- `putSteers(list: Steer[]): Promise<Steer[]>`
- `broadcast(text: string, ids: string[]): Promise<{ sent: number; total: number }>`

### `SteerBar.svelte`

- Scrollable chip row reusing `ControlBar`'s look and the
  `pointerdown` + `preventDefault` tap handler (never blur the terminal / dismiss
  the mobile soft keyboard).
- Rendered when `tab === "term"` on **all** devices, placed just above the
  Viewport footer (above the mobile ctrl-row when present).
- Props: `steers`, `focusedId`, `onbroadcast` (opens the dialog).
- Leading **📡 Broadcast** chip is always shown; saved-steer chips follow.
  Empty list → only the Broadcast chip shows.
- Steer chip tap → `replySession(focusedId, text)` (server reply path; renders
  in the attached PTY exactly like Triage replies). Failures `.catch` to a brief
  inline flash, never crash.

### `BroadcastDialog.svelte`

- Opened from the Broadcast chip. Contents:
  - checkbox list of **active** sessions (`store.sessions`) with a **select-all**
    toggle;
  - a way to choose the text: tap one of the saved steers **or** free-type into a
    textarea;
  - **Send** → `broadcast(text, selectedIds)`; shows `sent X/Y`, then closes.
- Disabled Send until both a non-empty text and ≥1 target are chosen.

### Settings (`Settings.svelte`)

- New **"Saved steers"** section below the repo-root controls:
  - one row per steer: editable `label` + `text`, a delete button;
  - an **Add** button appends a blank row;
  - **Save** → `putSteers(list)`; server-validation errors surface inline.
- No reordering (YAGNI).

## Data flow

1. **Boot** — `steers` store fetches `GET /api/steers`.
2. **Single** — chip tap → `replySession(focusedId, text)` → herdr injects into
   that session's PTY → browser's attached terminal renders it.
3. **Broadcast** — Broadcast chip → dialog → `POST /api/broadcast { text, ids }`
   → server loops `reply` → returns `{ sent, total }` → dialog shows result.
4. **Edit** — Settings save → `PUT /api/steers` → store refreshes its `list`.

## Error handling

- Malformed `PUT /api/steers` or `POST /api/broadcast` body → **400** with a
  message; UI surfaces it inline (Settings) / in the dialog (broadcast).
- Single-send and broadcast failures are caught and shown inline (broadcast as
  `sent X/Y`); they never crash the Viewport.
- Empty steer list → chips hidden, Broadcast chip still present.

## Testing

**Server (`bun test`):**

- `service.broadcast` — counts successes, skips unknown ids, returns
  `{ sent, total }`.
- `validateSteers` / `validateBroadcast` — accept valid, reject bad shapes /
  over-cap / empty fields.
- Routes — `GET /api/steers` seeds defaults, `PUT /api/steers` validates +
  persists, `POST /api/broadcast` returns counts; following existing server-test
  patterns.

**UI (`bun test` / vitest):**

- `steers` store — load, add, remove, persist call shape.
- `SteerBar` — renders a chip per steer + the Broadcast chip; tap calls the
  reply path; following `controlKeys.test.ts` / `todo.test.ts` patterns.

## Out of scope (YAGNI)

- Reordering steers.
- Per-repo or per-session default steers.
- Variable / placeholder interpolation in steer text.
- A "fill input, don't send" mode.

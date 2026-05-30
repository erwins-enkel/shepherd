# Image drag-drop + mobile upload — design

**Date:** 2026-05-30
**Status:** Approved

## Goal

Let users attach screenshots/images to Claude in two places:

1. **New Task form** (`NewTask.svelte`) — drag-drop or 📎 button before a session exists.
2. **Live terminal** (`Viewport.svelte`) — drag-drop or 📎 button into a running session.

Claude Code reads images by **file path** (its Read tool returns PNG/JPG as vision
content). So every flow boils down to: get the image onto the server filesystem,
then surface its absolute path to Claude.

## Architecture context

- Frontend: SvelteKit static + Svelte 5, talks to a Bun server via REST + WS.
- New session: `POST /api/sessions {repoPath, baseBranch, prompt, model}` →
  `service.create` → `worktree.create` → `claude … <prompt>` (prompt is the final argv).
- Live terminal: xterm.js ↔ `/pty/:id` WS ↔ `PtyBridge` → herdr agent PTY → `claude` REPL.
  Frontend sends keystrokes via `conn.send(d)`.
- Worktree is created at session-creation time; for the New Task form it does **not**
  exist yet when the user attaches an image → staging dir, then move-on-create.

## Decisions

- **Storage:** images live inside each session's worktree
  (`<worktreePath>/.shepherd-uploads/`), auto-removed when the worktree is decommissioned.
- **New Task form:** Approach A — attachment chips + server-side move. Images upload to a
  staging dir, are tracked as a chip list (not raw text in the textarea), and on submit the
  server moves them into the new worktree and appends their paths to the prompt.
- **Terminal drop:** insert the path into the prompt and wait for the user (no auto-submit).

## Components

### 1. Shared upload endpoint — `POST /api/uploads`

- Content type `multipart/form-data`, one `file` field. Optional `?session=<id>` query.
- Auth + origin already enforced globally by `checkAuth` / `checkOrigin` (they cover POST).
- **Validation:**
  - MIME ∈ `{image/png, image/jpeg, image/gif, image/webp}` → else `415`.
  - Size ≤ 10 MB → else `413`.
- **Filename:** ignore the client-supplied name entirely. Generate `<uuid>.<ext>` where
  `ext` is derived from the validated MIME. Eliminates path traversal.
- **Destination:**
  - Valid `?session=<id>`: look up the session in the store **server-side**, write to
    `<worktreePath>/.shepherd-uploads/` (worktree path is server-controlled, never client
    input). Unknown id → `404`.
  - No session: write to staging dir `<repoRoot>/.shepherd-uploads-staging/`.
  - `mkdir -p` the target dir.
- **Response:** `{ path: "/abs/path/<uuid>.png" }` (absolute path).

### 2. New Task flow (Approach A)

- `NewTask.svelte`:
  - Drop zone covering the whole form card (`dragover`/`drop`, preventDefault, highlight
    while dragging).
  - 📎 attach button → hidden `<input type="file" accept="image/*" multiple>`. Button shown
    always (desktop + mobile).
  - Dropped/picked files upload to `/api/uploads` (no session) → staging paths.
  - Attached images render as **removable chips** below the textarea (filename + ✕), held in
    a local `images = $state<string[]>([])` of staging paths. The prompt textarea stays clean.
- API contract:
  - `CreateInput` (ui) and `CreateSessionInput` (server) gain `images?: string[]`.
  - `api.ts createSession` includes `images` in the JSON body.
- `validateCreate` (server): new optional `images` key.
  - Must be an array, ≤ 10 entries, each a string.
  - Each entry must resolve **inside the staging dir** and be an existing file (mirror the
    `safeRepoDir` realpath-containment pattern). Reject otherwise → `400`.
  - Add `images` to `ALLOWED_KEYS`.
- `service.create`: after `worktree.create`, move each staged file into
  `<worktreePath>/.shepherd-uploads/`, then append to the prompt argv:
  ```
  <user prompt>

  Attached images:
  /abs/worktree/.shepherd-uploads/<uuid>.png
  ```
  Move (not copy) so the staging dir self-empties. If a session has no isolated worktree
  (cwd fallback), still write into `<worktreePath>/.shepherd-uploads/`.

### 3. Live terminal flow

- `Viewport.svelte`:
  - `dragover` / `drop` handlers on the `term-mount` element (preventDefault, highlight on
    drag-enter, clear on leave/drop).
  - 📎 button on touch devices (`mobile || touch`, matching the existing `ControlBar` gate),
    placed in/next to the control-key row → same hidden file input.
  - Upload to `/api/uploads?session=<id>` → path saved in the session's worktree → inject
    `" <abs-path> "` (space-padded) into the PTY via `conn.send(...)`, as if typed.
  - Multiple files → inject each path, space-separated.
  - No auto-submit: the user adds wording and presses Enter.

### 4. Mobile button

- Both surfaces trigger the same hidden `<input type="file" accept="image/*" multiple>` via a
  visible 📎 button. On iOS the picker offers camera + photo library automatically.
- Form: button always visible. Terminal: visible on `mobile || touch`.

### 5. Cleanup

- Worktree images: removed with the worktree on decommission (`worktree.remove`) — no new code.
- Staging dir: orphans occur only when a user attaches then abandons the form. On server
  startup, sweep files older than 24 h in `<repoRoot>/.shepherd-uploads-staging/`.
  Best-effort, small.

## Error handling

- Upload failures (bad MIME, too large, unknown session) → endpoint returns the status; the
  frontend surfaces a brief inline error and does not add a chip / inject a path.
- A failed upload never blocks typing or session creation.
- `validateCreate` rejects malformed/over-cap/out-of-containment `images` before any worktree
  is created.

## Out of scope (YAGNI)

- Clipboard paste, non-image file types, image previews/thumbnails, upload progress bars.
- Drop + button + chips only.

## Testing

- `validate.test`: `images` validation — containment to staging dir, ≤ 10 cap, non-existent
  path rejected, non-array / non-string rejected, unknown key still rejected.
- `service.test`: staged files moved into `<worktree>/.shepherd-uploads/` and their paths
  appended to the prompt argv; staging entries removed after move.
- Upload endpoint: MIME rejection (415), size rejection (413), traversal-safe generated
  filename, session destination vs staging destination, unknown session → 404.

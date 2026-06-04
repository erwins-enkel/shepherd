# Shepherd Capture (Chrome extension)

MV3 Chromium extension that captures the active tab (screenshot + page metadata)
and files it as a live Shepherd task via the task API (spawn-now). Phase 1 MVP.

## Develop

```bash
cd extension
bun install
bun run build      # → extension/dist (loadable unpacked)
bun run check      # svelte-check
bun run lint
bun test           # vitest (pure units)
bun run check:i18n # EN+DE catalog parity
```

## Load unpacked

1. `bun run build`.
2. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked**
   → select `extension/dist`.
3. Copy the extension's **ID** shown on the card — you need it for the server.

## Configure

Open the extension's **options** (right-click the icon → Options) and set:

- **Base URL** — your Shepherd core, e.g. `http://localhost:7330` (or your
  Tailscale `https://<host>.ts.net` URL when remote).
- **Token** — required only if the server runs with `SHEPHERD_TOKEN` set.
- **Repo path** — must resolve inside the server's `SHEPHERD_REPO_ROOT`
  (e.g. `~/Work/my-repo`).
- **Base branch**, **Model** (optional).

## Server setup (one-time)

The extension's `fetch` sends `Origin: chrome-extension://<id>`. Shepherd's origin
guard allowlists by the URL **hostname**, which for that origin is the **raw
extension ID**. Add it to the server's allowlist:

```bash
SHEPHERD_ALLOWED_HOSTS="<your-extension-id>" bun run start
```

If you skip this, spawn-now returns `403` and the popup shows the
"add this extension's ID to SHEPHERD_ALLOWED_HOSTS" error.

| Failure | Popup message    | Fix                                              |
| ------- | ---------------- | ------------------------------------------------ |
| `403`   | origin rejected  | add the extension ID to `SHEPHERD_ALLOWED_HOSTS` |
| `401`   | auth failed      | set the correct token in options                 |
| `400`   | repo not allowed | point repo path inside `SHEPHERD_REPO_ROOT`      |
| network | unreachable      | check base URL / that the core is running        |

## Manual verification checklist (Phase 1 acceptance)

- [ ] `bun run build` produces a loadable `dist/`.
- [ ] Loading unpacked shows the **Shepherd Capture** toolbar icon.
- [ ] With the server running + extension ID in `SHEPHERD_ALLOWED_HOSTS` and a
      valid repo configured: click the icon on any normal web page → popup shows a
      screenshot thumbnail + the target repo.
- [ ] Type a task, click **Spawn now** → popup shows `TASK-NN`.
- [ ] The session appears live in the Shepherd HUD, with the screenshot attached
      and the fenced browser-context block appended to the prompt.
- [ ] On a `chrome://` page the popup shows the "can't capture this page" message.
- [ ] Switching the browser UI language to German shows translated chrome.

## Out of scope (later phases — see issue #308)

GitHub-issue delivery path, URL→repo rules, console/network capture, axe-core
a11y audit, per-signal toggles, element picker, full-page stitch, keyboard
shortcut.

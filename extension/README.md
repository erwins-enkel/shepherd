# Shepherd Capture (Chrome extension)

MV3 Chromium extension that captures the active tab (screenshot + page metadata)
and files it as a live Shepherd task via the task API (spawn-now). Phase 2 adds
capture signals (screenshot, a11y, console errors, failed requests).

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

- **Base URL** — your Shepherd core. Two forms are supported:
  - **Local:** `http://localhost:7330` (granted statically by the manifest).
  - **Remote (Tailscale):** `https://<host>.ts.net` — saving a ts.net URL prompts
    the browser to grant access to that host (an optional host permission); accept
    it once and captures file against your remote core. Revoke any time from
    `chrome://extensions`. Any other host is rejected.
- **Token** — required only if the server runs with `SHEPHERD_TOKEN` set.
- **Repo path** — the default target repo; must resolve inside the server's
  `SHEPHERD_REPO_ROOT` (e.g. `~/Work/my-repo`).
- **Base branch**, **Model** (optional).
- **Routing rules** (optional) — see [Delivery & routing](#delivery--routing).

## Signals

A capture can attach optional, page-derived context. Toggle per-capture in the
popup; set defaults in **Options**:

- **Screenshot** — the visible-tab PNG (on by default).
- **Accessibility (axe-core)** — runs an axe audit on the page and appends up to
  20 findings. No extra permission; off by default (adds latency).
- **Console errors** / **Failed requests** — require enabling **recording** in
  Options, which asks for access to **all sites** so a background recorder can
  buffer `console.error`/`warn`, uncaught errors, and failed `fetch`/XHR/resource
  loads as they happen. Failed requests include the **full request URL** (query
  strings may contain tokens), which is forwarded to Shepherd in the task. Turn
  recording off to revoke that permission. Because the recorder injects at
  document load, a tab opened before you enabled recording won't have a buffer —
  reload it (the popup shows a hint when this happens).

All page-derived strings are sanitized (newline/backtick-neutralized) before they
enter the fenced context block, so a crafted page can't break out of the fence.

## Delivery & routing

**Delivery target** (picked per-capture in the popup):

- **Spawn session** (default) — the Phase-1 path: uploads the screenshot (when
  attached) and spawns a live Shepherd session whose prompt is your text plus the
  fenced context block.
- **Issue** — files the capture as an issue (title + body) on the target
  repo's forge (GitHub via `gh`, Gitea via its API) instead of spawning. The issue
  body is your prompt plus the same fenced metadata/signals block. The popup shows
  an **Issue title** field (prefilled from the page title; required). A screenshot
  is **not** embedded — a remote issue can't reference the confined local upload
  path — so the attach checkbox is disabled in issue mode; the metadata and signals
  still ride in the body.

**URL→repo rules** (optional, in **Options**): map a captured tab's URL to a target
repo so a capture files against the right project automatically instead of the
single default **Repo path**. Each rule is a `pattern → repo path` pair:

- The **pattern** is a glob (`*` wildcards) matched case-insensitively against the
  tab's full URL, e.g. `https://app.example.com/*` or `*staging.example.com*`.
- Rules are evaluated top-to-bottom; the **first match wins**. No match falls back
  to the default **Repo path**.
- The popup shows the resolved repo and a **(routed)** hint when a rule overrode the
  default. Routing applies to both delivery targets.

## Server setup (one-time)

The extension's `fetch` sends `Origin: chrome-extension://<id>`. Shepherd's origin
guard allowlists by the URL **hostname**, which for that origin is the **raw
extension ID**. Add it to the server's allowlist:

```bash
SHEPHERD_ALLOWED_HOSTS="<your-extension-id>" bun run start
```

If you skip this, spawn-now returns `403` and the popup shows the
"add this extension's ID to SHEPHERD_ALLOWED_HOSTS" error.

| Failure | Popup message                 | Fix                                                                                                       |
| ------- | ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| `403`   | origin rejected               | add the extension ID to `SHEPHERD_ALLOWED_HOSTS`                                                          |
| `401`   | auth failed                   | set the correct token in options                                                                          |
| `400`   | "Shepherd rejected: <detail>" | request invalid — the server's detail says what (e.g. repo path outside `SHEPHERD_REPO_ROOT`, bad branch) |
| `413`   | screenshot too large          | viewport screenshot exceeded the upload size limit                                                        |
| `415`   | screenshot format unsupported | unexpected capture format (should not happen for PNG)                                                     |
| network | unreachable                   | check base URL / that the core is running                                                                 |

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
- [ ] Enabling **recording** in Options shows Chrome's all-sites permission prompt
      once; accepting registers the recorder (console/network checkboxes become
      enabled in the popup).
- [ ] On a page that logged a `console.error` and made a request that 404s, a
      capture with console+network on shows non-zero counts and includes both in
      the session prompt's fenced block.
- [ ] Enabling **Accessibility** re-runs capture and the prompt block gains an
      `Accessibility (N)` section.
- [ ] Unticking **Screenshot** files a session with no image attached.
- [ ] Turning recording **off** in Options revokes the all-sites permission
      (popup console/network checkboxes go disabled again).
- [ ] Switching the browser UI language to German translates the new chrome.
- [ ] Setting the base URL to your `https://<host>.ts.net` core and clicking
      **Save** shows Chrome's host-access prompt once; accepting saves, and a
      capture files against the remote core. (Entering a non-localhost,
      non-`ts.net` host shows the "unsupported host" message and doesn't save.)
- [ ] Selecting **GitHub issue** as the delivery target shows the title field
      (prefilled from the page title) and disables the screenshot checkbox; filing
      with a non-empty title opens an issue on the target repo and the popup shows
      `Filed issue #N` linking to it. Clearing the title and filing shows the
      "enter an issue title" message instead.
- [ ] Adding a routing rule whose pattern matches the current tab (e.g.
      `https://github.com/*` → a different repo) makes the popup show that repo with
      a **(routed)** hint, and the capture files against it; a non-matching tab falls
      back to the default repo.

## Out of scope (later phases — see issue #338)

Element picker, full-page stitch (#342); keyboard shortcut, toolbar icons (#343).

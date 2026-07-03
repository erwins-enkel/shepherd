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
bun run package    # build, then zip dist/ → shepherd-capture-<version>.zip (CWS upload)
```

`bun run package` shells out to the system **`zip`** binary (preinstalled on macOS
and the CI ubuntu runner; otherwise `apt-get install zip` / `brew install zip`). The
zip is git-ignored.

## Load unpacked

1. `bun run build`.
2. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked**
   → select `extension/dist`.
3. The extension's **ID** is now fixed at `bflahkibnmcbijbhelmpjbohpfhlbaig`
   (pinned by the manifest `key`), so it no longer drifts per directory/machine.
   The card shows the same ID. This ID is **allowlisted by default** on the server,
   so no pairing step is needed for a standard install (see [Server setup](#server-setup)).

## Open the popup

Click the toolbar icon, or press **Alt+Shift+S** (rebindable at
`chrome://extensions/shortcuts`).

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

## Capture modes

The **Capture** selector in the popup chooses how the screenshot is produced:

- **Visible area** (default) — the current viewport (`chrome.tabs.captureVisibleTab`).
- **Full page** — scrolls the page in viewport-height slices, captures each, and
  stitches them into one tall PNG (worker-side `OffscreenCanvas`). Bounded to keep
  capture quick; a page taller than the cap is captured from the top and the popup
  says so. `fixed`/`sticky` elements (pinned headers, cookie banners) are hidden
  after the first slice so they appear once at the top instead of repeating down
  every slice — a genuinely sticky in-content element is therefore absent below the
  fold in the stitched image.
- **Pick element…** — arms an in-page hover overlay; click an element to crop the
  capture to its bounds (Esc / right-click cancels). The popup closes for the click
  and the toolbar icon shows a **✓** badge when the cropped capture is ready —
  reopen the popup to review and file it.

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

## Server setup

**No pairing step is required.** The extension's `fetch` sends
`Origin: chrome-extension://<id>`; Shepherd's origin guard allowlists by the URL
**hostname**, which for that origin is the **raw extension ID**. That fixed ID
(`bflahkibnmcbijbhelmpjbohpfhlbaig`, pinned by the manifest `key`) is **baked into
the server's default allowlist**, so a stock `bun run start` accepts captures from
this extension out of the box:

```bash
bun run start
```

The origin allowlist is CSRF hygiene, not authentication (`SHEPHERD_TOKEN` is the
real auth boundary), so shipping this fixed, public ID as allowed-by-default is safe.

**Only** if you override `SHEPHERD_ALLOWED_HOSTS` with a custom list do you need to
include this extension's ID in it — the built-in Capture ID is always appended
regardless, so in practice you never have to add it manually.

| Failure | Popup message                 | Fix                                                                                                       |
| ------- | ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| `403`   | origin rejected               | only if a custom `SHEPHERD_ALLOWED_HOSTS` is set — the built-in Capture ID is allowed by default          |
| `401`   | auth failed                   | set the correct token in options                                                                          |
| `400`   | "Shepherd rejected: <detail>" | request invalid — the server's detail says what (e.g. repo path outside `SHEPHERD_REPO_ROOT`, bad branch) |
| `413`   | screenshot too large          | viewport screenshot exceeded the upload size limit                                                        |
| `415`   | screenshot format unsupported | unexpected capture format (should not happen for PNG)                                                     |
| network | unreachable                   | check base URL / that the core is running                                                                 |

## Manual verification checklist (Phase 1 acceptance)

- [ ] `bun run build` produces a loadable `dist/`.
- [ ] Loading unpacked shows the branded **Shepherd sheep** toolbar icon.
- [ ] Pressing **Alt+Shift+S** opens the capture popup.
- [ ] With the server running (stock `bun run start`, no `SHEPHERD_ALLOWED_HOSTS`
      needed) and a valid repo configured: click the icon on any normal web page →
      popup shows a screenshot thumbnail + the target repo.
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

Horizontal full-page stitch.

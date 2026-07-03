# Shepherd Capture — Chrome Web Store submission copy

Paste-ready text for registering the **Unlisted** store item. This is a committed draft so
the copy is reviewable in-repo; the human operator transcribes it into the CWS dashboard at
submission. Refined against the shipped manifest (`manifest.config.ts`, v1.0.0) and the
research report (#1359, `docs/research/extension-chrome-web-store-readiness.md` §6–7).

> **Reviewer note.** Shepherd Capture is a companion to a **self-hosted local Shepherd core**
> (`http://localhost:7330`, or a `*.ts.net` remote over Tailscale). It does nothing without one
> running — which is why **Unlisted** (share-by-link, not searchable) is the correct tier.

---

## Listing basics

- **Name:** Shepherd Capture
- **Category:** Developer Tools
- **Language:** English (primary); German chrome is shipped, listing may be localized later.
- **Visibility:** **Unlisted**
- **Remote code:** **No** — all logic ships in the package (axe-core is bundled, not fetched;
  only _data_ is sent to the user's own server, never executed code).

## Single-purpose statement

> Shepherd Capture captures the current browser tab — a screenshot plus page metadata and
> optional diagnostics (accessibility findings, console errors, failed requests) — and files it
> as a task or issue on the user's own self-hosted Shepherd instance.

## Short description (≤132 chars)

> Capture the current tab — screenshot, metadata, and diagnostics — straight into your own
> self-hosted Shepherd as a task or issue.

## Detailed description

> Shepherd Capture turns the tab you're looking at into an actionable Shepherd task without
> leaving the page. Click the toolbar icon (or press Alt+Shift+S) to grab a screenshot —
> visible area, full page, or a picked element — together with the page URL and title. Attach
> optional signals: an axe-core accessibility audit, buffered console errors, and failed network
> requests. Then spawn a live Shepherd session or file a repo issue, with URL→repo routing so a
> capture lands in the right project automatically.
>
> Shepherd Capture is a companion to a Shepherd core you run yourself. It sends captures only to
> the server you configure — your local machine (`http://localhost:7330`) or your own Shepherd
> over Tailscale (`https://<host>.ts.net`). Nothing is sent to the extension's authors or any
> third party. Settings and your access token stay in local browser storage and are never synced.

## Per-permission justifications

| Permission  | Justification                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| `activeTab` | Screenshot + read metadata of the current tab, only when the user invokes the action.                                    |
| `scripting` | Inject the element-picker overlay and the axe-core accessibility audit into the active page on user request.             |
| `tabs`      | Read the active tab's URL and title to build the capture context and apply URL→repo routing rules.                       |
| `storage`   | Persist local settings (server base URL, token, repo path, base branch, model, routing rules) in `chrome.storage.local`. |

## Host-permission justifications

| Host                            | When granted                                  | Justification                                                                                                                                                                        |
| ------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `http://localhost:7330/*`       | at install (static)                           | Send captures to the user's own locally-running Shepherd core.                                                                                                                       |
| `https://*.ts.net/*` (optional) | runtime, on saving a `ts.net` base URL        | Optionally reach the user's self-hosted Shepherd over their Tailnet.                                                                                                                 |
| `<all_urls>` (optional)         | runtime, only when the user enables recording | Buffer `console.error`/`warn`, uncaught errors, and failed requests so they can ride along with a capture. Requested on the recording opt-in and revocable by turning recording off. |

## Data-usage disclosures (certifications)

- Data handled: **website content** (screenshots, page URL/title, console/network diagnostics)
  and **authentication information** (the Shepherd access token, stored locally).
- I certify: data is **not sold** to third parties; data is **not used or transferred for
  purposes unrelated** to the item's single purpose; data is **not used for creditworthiness or
  lending**. The extension transmits captures **only** to the user's own configured Shepherd
  server and to no other destination.

## Privacy policy (body text — host at a public URL, then paste the URL into the dashboard)

> **Shepherd Capture — Privacy Policy**
>
> Shepherd Capture is a companion to a self-hosted Shepherd instance that the user runs and
> controls. It exists to send captured browser context to that server and nowhere else.
>
> **What it handles.** When you invoke a capture, the extension collects: the current page's URL
> and title; a screenshot of the visible tab, the full page, or a picked element; and — only when
> you explicitly enable them — an axe-core accessibility report, buffered `console.error`/`warn`
> and uncaught-error messages, and failed network-request URLs. Note that failed-request URLs can
> contain query-string tokens; enable console/network recording with that in mind. The extension
> also stores your settings and Shepherd access token.
>
> **Where it goes.** Captured data is transmitted **only** to the Shepherd server you configure
> (`http://localhost:7330` on your own machine, or your own `https://<host>.ts.net` core over
> Tailscale). It is **never** sent to the extension's developers or to any third party. The
> developers receive nothing and act as no kind of data controller or processor for your captures.
>
> **Local storage.** Your settings and access token are kept in `chrome.storage.local` on your
> device. They are never synced to any account and never leave your browser except as the
> `Authorization` header on requests to your own configured server.
>
> **Your control.** Uninstalling the extension removes all locally-stored settings. Optional host
> access (all-sites recording; Tailscale) is granted at runtime and revocable at any time from
> `chrome://extensions`.
>
> **Contact.** <add a contact email or link before publishing>

---

## Manual publish procedure (human/ops)

1. Produce the zip: `cd extension && bun run package` → `extension/shepherd-capture-<version>.zip`
   (or download the artifact from the **Extension package** GitHub Actions run). The zip is
   git-ignored. Requires the system **`zip`** binary on PATH (preinstalled on macOS and the CI
   runner; otherwise `apt-get install zip` / `brew install zip`).
2. In the CWS dashboard, create/update the item and upload the zip.
3. Upload listing assets: the 128×128 store icon (`store-assets/store-icon-128.png`), ≥1
   screenshot at 1280×800, and the 440×280 promo tile (see `store-assets/README.md`).
4. Fill the **Privacy practices** tab with the single-purpose statement, per-permission +
   per-host justifications, and data-usage certifications above; set the privacy-policy URL.
5. Set **remote code = No**, visibility **Unlisted**, and submit for review.

## Out-of-scope prerequisites (human/ops — not doable in code)

- Register the CWS developer account + pay the one-time **$5** fee; declare **Trader/Non-Trader**.
- **Host the privacy policy** body above at a public URL and add a contact address.
- Produce the **screenshot(s)** and **promo tile**.
- After registration, read back the item's **final assigned ID** and reconcile it — see below.

## Task 5 — ID reconciliation (follow-up after registration)

The store may assign a different ID than the self-generated manifest `key`. Once the final
published ID is known, update it in **two** places so unpacked dev builds and the published item
share one ID:

- `SHEPHERD_CAPTURE_EXTENSION_ID` in `src/config.ts` (the server's default allowlist entry), and
- `key` in `extension/manifest.config.ts`.

Interim value (the pinned unpacked ID): `bflahkibnmcbijbhelmpjbohpfhlbaig`.

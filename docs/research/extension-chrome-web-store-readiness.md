# Shipping Shepherd Capture to the Chrome Web Store

**Brief:** The `extension/` package (Shepherd Capture — an MV3 Chromium extension that captures the
active tab into a Shepherd session/issue) is today a proof of concept with an **elaborate,
developer-only install**: build from source, load unpacked, and manually pair the extension ID into the
server's `SHEPHERD_ALLOWED_HOSTS`. This note maps what it would actually take to distribute it through
the Chrome Web Store so a Shepherd user can install it in one click and get automatic updates.

**This file is a research/reference note — not code.** It states the confirmed 2026 Chrome Web Store
policy reality, does a gap analysis against the current extension, and recommends a phased path.
Implementation would be one or more follow-up PRs.

---

## 1. TL;DR

**The blocker is not Chrome Web Store policy — the extension is essentially store-shippable today.** The
friction you feel is the _unpacked-dev distribution model_, not the code. Almost all of it dissolves by
publishing as an **Unlisted** store item.

- **Unlisted** = share-by-link, **not** searchable/discoverable, but still Google-hosted, auto-updated,
  and reviewed under the same policy as a public listing. It is the correct vehicle for software whose
  audience only benefits if they already run a Shepherd core.
- The single biggest install step — _copy the extension ID → paste into `SHEPHERD_ALLOWED_HOSTS` →
  restart the server_ — **disappears** once we ship the extension's permanent store ID as a **default
  entry in Shepherd's origin allowlist**. Publishing fixes the ID permanently and publicly, so there is
  nothing secret to protect and no per-user pairing to perform.
- What's genuinely _new_ work: a **privacy policy URL** (required — the extension handles user data), a
  **packaging/publish pipeline** (none exists), **listing assets** (icons/screenshots/promo tile), and
  **per-permission justifications** at submission.
- The two things a reviewer will actually scrutinize: the optional **`<all_urls>`** recorder permission
  (already runtime-granted — keep it that way) and the fact that the extension **does nothing without a
  running Shepherd core** (mitigate with a clear first-run screen, else risk a "non-functional" rejection).

**Recommended path:** ship **Unlisted**, remove the pairing step server-side, add the privacy policy +
packaging pipeline, then submit. Public/discoverable is a later, optional step with a higher review bar.

---

## 2. Where the friction actually lives today

From `extension/README.md` and the source, the current install is:

1. **Build from source** — `bun install && bun run build`, then Chrome → `chrome://extensions` →
   Developer mode → **Load unpacked** → `extension/dist`.
2. **Manual server pairing** — the extension's `fetch` sends `Origin: chrome-extension://<id>`;
   Shepherd's origin guard allowlists by hostname (the raw ID), so the user must set
   `SHEPHERD_ALLOWED_HOSTS="bflahkibnmcbijbhelmpjbohpfhlbaig"` and restart. Skip it → spawn-now `403`.
   The ID is already pinned via the manifest `key` (`extension/manifest.config.ts:40`) so it doesn't
   drift, but the paste-and-restart step remains.
3. **Options config** — base URL, token, repo path, base branch, model, routing rules
   (`src/lib/config.ts`, `src/options/Options.svelte`).
4. **On-demand permission grants** — a Tailscale `*.ts.net` host on saving a remote base URL
   (`src/lib/remote-host.ts`), and `<all_urls>` when enabling the console/network recorder
   (`src/lib/recorder-control.ts`).

Steps 1 and 2 are the "elaborate" part and are exactly what store distribution removes. Step 3 is
partly irreducible (a self-hosted tool needs to know where its server is) but can be smoothed. Step 4 is
already best-practice (runtime-optional) and should stay.

**Architectural fact that shapes everything:** the extension is a **companion to a self-hosted local
core** (`http://localhost:7330`, or a `*.ts.net` remote over Tailscale). Whoever installs it gets
nothing without running Shepherd. That is fine — and is precisely why **Unlisted** is the right listing
tier.

---

## 3. Confirmed 2026 Chrome Web Store policy (the parts that matter here)

Sourced from Google's developer docs; the full source list is in [§8](#8-sources).

- **Developer account:** one-time **US $5** registration fee (covers up to 20 items). Mandatory email
  verification; the account email **cannot be changed later**. A **Trader / Non-Trader** declaration is
  required — declaring _Trader_ publishes a legal name + phone + physical address on the listing;
  _Non-Trader_ (hobby/non-commercial) avoids that. No government-ID/biometric check is documented.
- **Visibility tiers** (same review + same policy for all three):
  - **Public** — listed and searchable.
  - **Unlisted** — not listed, not searchable; **anyone with the store URL can install**. Genuine
    share-by-link, not login-gated.
  - **Private** — installable only by named Trusted Testers / Google Groups you own. Good for a first
    closed test.
  - **All store-hosted items (incl. Unlisted) receive Chrome's automatic updates** — the core reason to
    publish rather than self-host.
- **Review:** nominally a few days ("up to a few weeks" per Google; contact support only after 3 weeks).
  Secondary reporting flags an elevated 2026 backlog — budget ~1–3 weeks. **Slower/closer review is
  triggered by** new developers, new items, and **broad host permissions** — `*://*/*`, `https://*/*`,
  `<all_urls>` are explicitly high-scrutiny. **Narrow host patterns are favorable.**
- **No remotely-hosted code (MV3):** all executable logic ships in the package. Bundling libraries
  (**axe-core is fine** — it's bundled, `build:axe` copies it in) is compliant; fetching **data** from a
  server is fine **as long as you never execute fetched code**. The submission form has an explicit
  "using remote code?" field — answer **No**.
- **localhost is allowed and unproblematic:**
  - MV3's CSP tightening applies to **script/object** sources, **not** `connect-src` — the service
    worker/extension pages may `fetch()` any origin, including `http://localhost`.
  - Fetching `http://localhost` from the **service worker / extension page** (which is what
    `src/lib/transport.ts` does) is **not** mixed-content — `chrome-extension://` is a secure context and
    localhost is a special-cased trustworthy origin. (The mixed-content trap only bites content scripts
    running inside an `https://` page.) Shepherd Capture talks to the server from the popup/worker, so
    it is clear.
  - You still need the host permission for `http://localhost:7330/*` — which the manifest already
    declares statically. Narrow and favorable.
- **Privacy practices tab (required at submission):** a **single-purpose** statement, a **per-permission
  and per-host justification** for each declared permission, **data-usage disclosures + certifications**
  (not selling data, etc.), and a **hosted privacy policy URL** — required the moment the item handles
  any user data.
- **Listing assets (minimum):** a **128×128** store icon, **≥1 screenshot** (1280×800 preferred, or
  640×400), and the **440×280** small promo tile. Description up to 16,000 chars.

---

## 4. Gap analysis — Shepherd Capture vs. store requirements

| Requirement                          | Status                                                                        | Work needed                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| MV3 manifest, no remote code         | ✅ Compliant — axe-core bundled, only data fetched                            | Set remote-code field "No"                                                           |
| Narrow host permissions              | ✅ `http://localhost:7330/*` static; `*.ts.net/*` + `<all_urls>` **optional** | Keep `<all_urls>` runtime-granted; write tight justifications                        |
| Stable public ID / no manual pairing | ⚠️ Pinned for unpacked, but users still edit `SHEPHERD_ALLOWED_HOSTS`         | **Ship the store ID in Shepherd's default allowlist** (see §5)                       |
| Store icon 128×128                   | ✅ `public/icons/icon-128.png` exists                                         | Confirm ~16px transparent padding                                                    |
| Screenshots / promo tile             | ❌ None                                                                       | Produce ≥1 screenshot + 440×280 tile                                                 |
| Privacy policy URL                   | ❌ None                                                                       | **Author + host a privacy policy** (see §6)                                          |
| Per-permission justifications        | ❌ Not written                                                                | Draft for `activeTab`/`scripting`/`tabs`/`storage`/localhost/`<all_urls>`/`*.ts.net` |
| Single-purpose statement             | ✅ Purpose is narrow ("capture the current tab into a Shepherd task")         | Phrase it for the form                                                               |
| Packaging / publish pipeline         | ❌ No zip/publish step (`build` → `dist/` only)                               | Add a zip step + optional CI publish (see §7)                                        |
| Version string                       | ⚠️ `0.0.1` in `manifest.config.ts`                                            | Bump to a real `1.0.0` for first submission                                          |
| i18n listing                         | ✅ EN+DE already (`default_locale`, `__MSG_*__`, Paraglide)                   | Optionally localize the store listing too                                            |

---

## 5. The pairing step is the real prize — kill it server-side

Today the most "involved" part of setup is the origin allowlist dance. It exists because Shepherd's
origin guard rejects unknown `chrome-extension://<id>` origins with a `403`.

**Once the extension is published, its ID is permanent and public.** There is nothing to protect by
withholding it — a `chrome-extension://<id>` origin is not a credential (the token is). So:

- **Add the published extension ID to Shepherd's _default_ `SHEPHERD_ALLOWED_HOSTS`** (or a dedicated
  built-in constant the origin guard always accepts). A fresh user then never touches the env var —
  install from the store, point it at `localhost:7330`, done. This is the single highest-leverage change
  and it is small.
- **Verify the ID handoff before baking it in.** The store may assign its **own** ID on first upload
  rather than honoring the self-generated manifest `key` in `manifest.config.ts:40`. Either way the
  workflow is deterministic: **register the item → read back the final permanent ID from the dashboard →
  bake that exact ID into (a) Shepherd's default allowlist and (b) the manifest `key`** (so unpacked dev
  builds keep matching prod). Do this once; it never drifts again.
- The token (`SHEPHERD_TOKEN`) remains the real auth boundary — the allowlist is origin hygiene, not
  authentication, so shipping the ID by default does not weaken anything.

This turns steps 1+2 of §2 into "install, then set repo path."

---

## 6. Data handling & the privacy policy (a genuine must-do)

The extension is not a passive capture tool — it ships **user data** to a server:

- page URL, title, and metadata (`src/lib/capture.ts`, `context-block.ts`);
- a **screenshot** of the visible tab / full page / a picked element;
- **console errors/warnings**, **uncaught errors**, and **failed request URLs** — and the README itself
  warns those failed-request URLs **may contain tokens in query strings** (`README.md` §Signals);
- **axe-core accessibility findings**.

Even though the destination is the user's _own_ Shepherd core, the Chrome Web Store's data-handling
rules key off _the extension collecting/transmitting user data_, not off who owns the endpoint. So:

- A **hosted privacy policy URL is required** at submission. It should state plainly: data is sent only
  to the user's own configured Shepherd server; nothing goes to Shepherd's authors or any third party;
  storage is `chrome.storage.local` (never synced — `config.ts` notes the token stays local).
- Complete the **data-usage disclosures** and certifications (not sold, not used for unrelated purposes).
- Consider a **UX note about the failed-request-URL/token exposure** near the recorder toggle so users
  opt in with eyes open — this is both good practice and a point a reviewer may probe.

The Shepherd going-public docs (`docs/going-public-checklist.md`) are the natural home to reference the
new privacy policy from.

---

## 7. Recommended phased path

**Phase 0 — decide the tier (halt for go/no-go).** Confirm **Unlisted** is the target (recommended).
Public/discoverable raises the review bar because a reviewer installs the extension with **no Shepherd
core running** and sees a non-functional tool — a documented rejection risk. If Public is truly wanted,
Phase 0 must add a demo/onboarding story (e.g. a first-run screen that explains the localhost
requirement, or a read-only demo mode). Don't build downstream steps until this is settled.

**Phase 1 — remove the pairing friction (server-side, shippable independently).** Bake the (soon-to-be)
published ID into Shepherd's default allowlist per §5. Can land before anything store-related and
immediately improves the load-unpacked experience too.

**Phase 2 — store-readiness scaffolding.**

- Bump `version` to `1.0.0`.
- Add a **package step**: zip `dist/` for upload (a `bun run package` that builds then zips). Optionally
  a CI job using the Chrome Web Store API for one-command publishes on tag.
- Author + host the **privacy policy**; wire the URL into the submission.
- Produce **listing assets**: 128×128 icon (confirm padding), ≥1 screenshot at 1280×800, a 440×280 promo
  tile. The branded sheep mark and the existing popup make easy screenshot fodder.
- Draft the **single-purpose statement** and **per-permission justifications** (table below).

**Phase 3 — register + submit.** Pay the $5, create the item, declare Trader/Non-Trader, upload the zip,
fill Privacy practices, set visibility **Unlisted**, submit. Read back the final ID and reconcile §5.

**Phase 4 — iterate.** Optionally add a first-run onboarding screen, localize the listing (DE), and — if
desired later — graduate to Public with the onboarding story from Phase 0.

**Draft per-permission justifications (Phase 2):**

| Permission                           | Justification                                                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `activeTab`                          | Capture a screenshot + metadata of the current tab only when the user clicks the action.                         |
| `scripting`                          | Inject the element-picker/axe-core audit into the active page on user request.                                   |
| `tabs`                               | Read the active tab's URL/title to build the capture context and apply URL→repo routing.                         |
| `storage`                            | Persist local settings (server URL, token, repo, routing rules) via `chrome.storage.local`.                      |
| `http://localhost:7330/*` (host)     | Send captures to the user's own locally-running Shepherd core.                                                   |
| `https://*.ts.net/*` (optional host) | Optionally reach the user's self-hosted Shepherd over their Tailnet; requested at runtime.                       |
| `<all_urls>` (optional host)         | Optionally buffer console/network errors for capture; requested at runtime only when the user enables recording. |

---

## 8. Sources

Chrome Web Store developer docs (fetched 2026): registration & fees
(`developer.chrome.com/docs/webstore/register`, `.../set-up-account`), distribution/visibility
(`.../cws-dashboard-distribution`), review process (`.../review-process`), privacy practices
(`.../cws-dashboard-privacy`), user-data FAQ (`.../program-policies/user-data-faq`), MV3 requirements &
remote-code migration (`.../program-policies/mv3-requirements`,
`developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code`), CSP reference
(`.../reference/manifest/content-security-policy`), listing images (`.../webstore/images`), update
lifecycle (`.../extensions-update-lifecycle`), trader-verification FAQ. Secondary (directional only, so
flagged): 2026 fee/review-time blogs, and a chromium-extensions group thread confirming unlisted/public
review parity. The exact "$5" figure and 2026 review latency rest on secondary sources; Unlisted
auto-update is inferred from "store-hosted items auto-update" with no doc excluding Unlisted.

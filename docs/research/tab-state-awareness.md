# Communicating herd state & operator awareness via the browser tab

**Brief:** Explore how Shepherd can communicate session/herd state to the operator — and adapt to
whether the operator is actually watching — through the operator's **browser tab** (title, favicon,
app-icon badge) and the browser's **attention-detection** APIs. Motivation: an operator usually parks
Shepherd in a background tab while working elsewhere; today that tab gives them nothing until they
switch back or an OS push fires.

**This file is a research/reference note — not code.** It maps the current architecture, the confirmed
2026 browser-support reality, and a recommended design. Implementation would be one or more follow-up
PRs. A live, self-contained sandbox that drives the real tab (built while researching this) is linked
in [§7](#7-sandbox).

---

## 1. TL;DR

Shepherd already has a **two-tier attention model** and is missing the middle rung:

- **Focused** → the live WS-driven UI shows everything. (Have.)
- **Away / tab closed** → Web Push fires an OS banner. (Have — `src/push.ts`, `src/ready-notify.ts`,
  gated by the server `Presence` class in `src/presence.ts`.)
- **Backgrounded but browser still open** → **nothing today.** This is the gap. The operator's Shepherd
  tab sits in the tab strip showing a static `Shepherd` title and a static favicon while a session goes
  blocked or a PR turns ready.

Fill that gap with an **ambient tab channel** that is glanceable, permission-free, and lighter than an
OS push: an attention **count in the title** (`(2) Shepherd`), a **severity-colored favicon**, and — for
installed-PWA users — an **App Badge**. Drive escalation off the `Presence` heartbeat Shepherd already
tracks; keep the "am I away" decision on the **server**, because the client cannot reliably report it.

**Recommended to build (validated by the sandbox):** title count · severity favicon · App Badge
(progressive) · the attended→background→away ladder · progress-ring favicon for epic/build runs ·
completion flourish on herd drain · optional glyph-ticker title for power users.

**Evaluated and rejected:** a **breathing/animated** favicon (throttled to ~1 Hz in exactly the
background tabs that matter; annoyance profile) and **title-flashing** (WCAG 2.2.2 "Pause, Stop, Hide"
concern, reads as adware). Both were prototyped and dropped.

---

## 2. What Shepherd already has

Grounding the design in the current code so the new channel reuses it rather than reinventing it.

| Concern                                 | Where                                      | Behaviour                                                                                                                                                                                                                                       |
| --------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Session state vocabulary**            | `ui/src/lib/types.ts`                      | `SessionStatus = running \| idle \| blocked \| done \| archived`; plus ready-to-merge, reviewing (critic/plan-gate), CI, epic-run states.                                                                                                       |
| **Display-status refinement**           | `ui/src/lib/display-status.ts`             | `working-blocked` sessions render as `running`, not `blocked` — the count must use the _display_ status, not the raw one.                                                                                                                       |
| **Operator presence (client → server)** | `ui/src/lib/store.svelte.ts` (`connect()`) | Reports `{type:"presence", active}` over the `/events` WS, where `active = visibilityState==="visible" && document.hasFocus()`. Re-asserts on `visibilitychange`/`focus`/`blur`/`pageshow`, and **force-reconnects** a frozen socket on resume. |
| **Presence (server)**                   | `src/presence.ts`                          | Tracks two sets: `active` (focused+visible windows → `isActive()`) and `connected` (any open dashboard → `hasClients()`). Fires `onActivate` on the 0→1 connected edge for a catch-up sweep.                                                    |
| **Push gating**                         | `src/push.ts`, `src/ready-notify.ts`       | `push.notify` returns `false` (defers) while `isActive()` — OS banners are suppressed while the operator is actively looking. `reducedPushMode` + a 5 s ready-dwell debounce avoid churn.                                                       |
| **Visibility-gated polling**            | `ui/src/lib/visibility.ts`                 | `pollWhileVisible` skips interval ticks while `document.hidden`; fires immediately on return.                                                                                                                                                   |
| **Tab chrome**                          | `ui/src/app.html`                          | `<title>Shepherd</title>` is **static**; favicon is a static `favicon.svg`. Neither ever reflects state.                                                                                                                                        |

The key insight: **the server already knows `isActive` vs `hasClients`.** The ambient tier maps onto the
already-tracked "connected but not active" state, and it needs **no new server signal** — the tab is
open, so the client can paint its own title/favicon locally.

---

## 3. Browser-support reality (2026)

Confirmed against MDN / caniuse / web.dev / spec repos (sources inline). Two independent research passes;
full source lists at the end of each subsection.

### 3a. Outbound — signaling state to the tab

| Mechanism                                            | Chrome/Edge           | Firefox  | Safari                   | Install req?            | Background-tab safe?             | Verdict                          |
| ---------------------------------------------------- | --------------------- | -------- | ------------------------ | ----------------------- | -------------------------------- | -------------------------------- |
| `document.title` count/state                         | ✅                    | ✅       | ✅                       | no                      | ✅ (not throttled)               | **Ship — core**                  |
| Favicon **static** color/dot/count swap (canvas→PNG) | ✅                    | ✅       | ✅                       | no                      | ✅ (not throttled)               | **Ship — core**                  |
| Favicon **SVG dynamic fill**                         | ✅                    | ✅       | ❌                       | no                      | ✅                               | Upgrade only, PNG fallback       |
| Favicon **animated** (rAF/interval)                  | ⚠️ throttled ~1 Hz bg | ✅       | ⚠️ erratic               | no                      | ❌ **throttled when it matters** | **Rejected**                     |
| **App Badge** (`setAppBadge`)                        | ✅ Win/macOS          | ❌ never | ✅ 17+ macOS / iOS 16.4+ | **yes (installed PWA)** | ✅ (dock/taskbar, from SW)       | **Progressive enhancement**      |
| Notifications API "silent" tier                      | ✅                    | ✅       | ✅ (installed)           | desktop no              | —                                | Escalation tier, **not** ambient |
| Declarative / per-tab badging                        | ❌ proposal, rejected | ❌       | ❌                       | —                       | —                                | **Do not target**                |

Notes that shape the design:

- **Title truncates from the right**, so the count must be a **front paren**: `(3) Shepherd`. Keep the app
  name so the tab stays identifiable. Screen readers do **not** reliably announce mid-session title
  changes → title/favicon are **visual-only**; mirror to `aria-live` (see [§6](#6-cross-cutting-a11y-i18n-design-system)).
- **Static** favicon swaps (set `link.href` on a state change) are **not** throttled in background tabs.
  **Animated** ones are (Chromium drops to ~1 Hz unfocused) — which is why breathing is out; a Web
  Worker + OffscreenCanvas is the only reliable animation path and isn't worth it here.
- **App Badge is dock/taskbar/home-screen, not the tab strip, and needs an installed PWA.** Global
  `setAppBadge` support ≈ 45%. Keep title+favicon as the baseline; badge is a bonus for installed users.
  Callable from a service worker → can badge even with no tab open.
- Sources: [title/a11y](https://hidde.blog/accessible-page-titles-in-a-single-page-app/) ·
  [favicon throttling](https://favicon.im/blog/animated-favicon-live-demo) ·
  [SVG favicons](https://css-tricks.com/svg-favicons-and-all-the-fun-things-we-can-do-with-them/) ·
  [App Badge — MDN](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Display_badge_on_app_icon) ·
  [caniuse setAppBadge](https://caniuse.com/mdn-api_navigator_setappbadge) ·
  [W3C Badging](https://w3c.github.io/badging/) ·
  [declarative-badge rejected — w3ctag/design-reviews#387](https://github.com/w3ctag/design-reviews/issues/387).

### 3b. Inbound — detecting whether the operator is attending

| Signal                                        | Chrome/Edge | Firefox                 | Safari              | Verdict                                      |
| --------------------------------------------- | ----------- | ----------------------- | ------------------- | -------------------------------------------- |
| Page Visibility (`visibilitychange`/`hidden`) | ✅          | ✅ (most reliable)      | ✅ (mobile gotchas) | **Core — depend on**                         |
| `document.hasFocus()` + focus/blur            | ✅          | ✅                      | ✅                  | **Core (desktop); noisy on mobile)**         |
| Page Lifecycle `pagehide`/`pageshow`          | ✅          | ✅                      | ✅                  | **Depend on for resume**                     |
| Page Lifecycle `freeze`/`resume`              | ✅          | ❌                      | ❌                  | Chromium bonus                               |
| **Idle Detection** (`IdleDetector`)           | ✅ 94+      | ❌ **declared harmful** | ❌ **refused**      | **Never a dependency**                       |
| `navigator.userActivation`                    | ✅          | ✅                      | ✅                  | Gate for permissioned calls, _not_ attention |

Notes that shape the design:

- The reliable three-state is really **two** reliable states — _attended_ (`visible && hasFocus()`) vs
  _not_ — plus an **inferred** _away_. `visibilitychange` can be **skipped** on the hide side (mobile app
  switcher) and the restore side (bfcache/freeze), so the client must listen to the **union**
  `visibilitychange + pageshow + focus + resume` and, on any resume, **force-reconnect the WS** (iOS
  freezes a backgrounded tab and the socket hangs _without_ a `close`). Shepherd's `connect()` already
  does exactly this.
- **`IdleDetector` is a non-starter as a dependency**: Chromium-only, permission-gated (≥60 s threshold,
  needs user activation), and **formally rejected by both Mozilla ("harmful") and Apple**. Usable _only_
  as an opt-in Chromium-desktop luxury ("alert me when I step away").
- **"Away" must be inferred server-side** from a dropped presence heartbeat — never trusted from a client
  "I'm leaving" event that may never fire on mobile. Shepherd already routes push through `Presence`, so
  this is a small extension, not a new subsystem.
- Sources: [Page Visibility — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API) ·
  [switcher gap — w3c/page-visibility#59](https://github.com/w3c/page-visibility/issues/59) ·
  [Page Lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api) ·
  [iOS WS freeze — WebKit #228296](https://bugs.webkit.org/show_bug.cgi?id=228296) ·
  [IdleDetector — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Idle_Detection_API) ·
  [Mozilla "harmful" — standards-positions#453](https://github.com/mozilla/standards-positions/issues/453).

---

## 4. Recommended design — the attention ladder

Three rungs, chosen by the tier the operator is in. **The tier is already computable from Shepherd's
existing presence data**; only the _middle rung's rendering_ is new.

```
tier            detected by                              channel
─────────────   ──────────────────────────────────────   ──────────────────────────────────
ATTENDED        server isActive() (client: visible+focus)  live WS UI — no tab signal
BACKGROUND      hasClients() && !isActive()                AMBIENT: title count + favicon + App Badge   ← NEW
AWAY            heartbeat dropped / !hasClients()          OS push (existing push.ts pipeline)
                (+ IdleDetector opt-in on Chromium)
```

### 4a. The attention count (what `N` means)

`N` = sessions that need the **operator**, using _display_ status:

- `blocked` **and not** working-blocked (a genuine awaiting-input dialog),
- **ready-to-merge** (the `ready` set from `ready-stage`),
- **plan-gate / critic question awaiting an answer** (#803 question-forms).

CI-failed is **not** counted toward `N` but **does** drive favicon severity (red) — it's "look when you
can," not "act now." _(Exact inclusion is a tuning decision — see [§8](#8-open-questions).)_

### 4b. Rendering (the kept mechanisms)

- **Title:** `(${N}) Shepherd` when `N>0`, else `Shepherd`. Front-paren, app-name retained.
- **Favicon:** static canvas swap; **highest-severity session owns the color** —
  red (CI failed) › amber (blocked/needs-input) › green (ready) › neutral (quiet). Optional count digit
  on the badge (toggle: number vs plain dot). Green stays **reserved for genuinely-ready**, matching the
  design-system rule.
- **App Badge:** feature-detected `setAppBadge(N)` / `clearAppBadge()`, wired so a service worker can set
  it without an open tab. No-op fallback for non-installed / unsupported.
- **Progress-ring favicon:** for a _focused single long run_ (epic/build) the favicon shows a filling
  ring — coarse static swaps (~3/s) that survive throttling, not a rAF loop.
- **Completion flourish:** brief ✓ favicon when the herd fully drains (`N` goes `>0 → 0`), then restore.
- **Glyph-ticker title (opt-in):** `▶3 ✋1 ✓2 Shepherd` for power users who want the breakdown; off by
  default because it's denser and less universally legible than the count.

### 4c. Escalation policy

- The ambient tier is **client-only and additive** — the tab is open, so no server round-trip and no
  permission. It does **not** change push gating on its own.
- Push continues to fire when `!isActive()` per today's pipeline. A future **"quiet mode"** could reserve
  push for `!hasClients()` (no tab open at all) and lean on the ambient tier while a tab is merely
  backgrounded — but that trades timeliness for calm and should be an explicit operator preference, not a
  default. _(Open question.)_
- **`IdleDetector`** stays an opt-in Chromium enhancement only: when granted, `userState:"idle"` /
  `screenState:"locked"` can promote BACKGROUND→AWAY early so push fires sooner. Never assumed present.

---

## 5. Implementation sketch (for the follow-up PR, not this note)

- **`ui/src/lib/tab-signal.svelte.ts`** — a single deep module: derives `N` + severity from the session
  store (reusing `display-status`), and owns `document.title`, the `<link rel="icon">` canvas swap, and
  `setAppBadge`. One `$effect` in the root `+layout.svelte` drives it. Debounce on actual
  count/severity change (sessions churn).
- **Favicon canvas:** render at `32 * devicePixelRatio`, draw the base mark + severity dot, `toDataURL`,
  swap the `<link>` href. Ship a PNG base; the SVG-fill upgrade is optional (Chromium/FF only).
- **No new server signal for the ambient tier.** Optionally surface a per-device toggle (like the
  existing `PushCategories`) for glyph-ticker and quiet-mode.
- **Reuse, don't duplicate,** the resume/reconnect union already in `store.svelte.ts`.

---

## 6. Cross-cutting: a11y, i18n, design-system

- **A11y:** favicon and title are invisible to screen readers and title changes aren't reliably announced
  mid-session → mirror every state change into an `aria-live="polite"` region so SR users reach parity.
  No blinking/flashing (WCAG 2.2.2) — reinforces dropping breathing + title-flash.
- **i18n (Paraglide):** the base app name `Shepherd` and numeric count are data, not translated; the
  glyph-ticker uses glyphs, not words. But the **`aria-live` announcement is chrome** → needs
  `en.json`+`de.json` keys (e.g. `tab_attention_count` → "{count} sessions need you"), per the i18n gate.
- **Design system:** severity colors must be `var(--status-*)` / `--color-*` tokens resolved to hex at
  canvas-paint time, never raw literals; **green reserved for READY**, matching the existing rule.

---

## 7. Sandbox

A throwaway, self-contained rig (no Shepherd wiring) drives the **real** tab title, favicon, and App
Badge and simulates a herd + the attention ladder — built to let the operator _feel_ each mechanism
before committing. It confirmed the A/B/C selection above (and the rejection of breathing + flash).
Not part of any PR; served ephemerally over `tailscale serve` during the research session.

---

## 8. Open questions

- **Count membership:** does CI-failed / reviewing count toward `N`, or only drive favicon severity?
- **Quiet mode:** should a backgrounded-but-open tab _suppress_ OS push in favour of the ambient signal
  (opt-in), or is push-when-unfocused still the right default?
- **Multi-operator:** when several operators are connected (`Presence` already tracks this), should the
  tab hint "someone else is on it" to avoid double-handling? Deferred — separate concern.
- **App Badge reach:** what fraction of operators install the PWA? Determines how much to invest in the
  badge path vs treating it as pure bonus.

# Shepherd Capture — capture fidelity (element picker + full-page stitch)

Issue: #342 (follow-up to #338 / #336). Reworks the screenshot stage of the
extension capture pipeline beyond a single visible-tab PNG. Upload + spawn/issue
transport is unchanged — only how `screenshotDataUrl` is produced changes.

## Two new capture modes

The popup gains a **capture mode** selector (defaults to today's behavior):

- **Visible area** (`visible`, default) — unchanged `chrome.tabs.captureVisibleTab`.
- **Full page** (`fullpage`) — scroll the page in viewport-height slices, capture
  each, and stitch them onto one tall PNG via `OffscreenCanvas` in the worker.
- **Pick element** (`element`) — an in-page hover overlay; the clicked element's
  bounds crop the visible capture.

`visible`/`fullpage` extend the existing synchronous `capture` message (the popup
stays open while the worker scrolls+captures). `element` is a separate async flow
because it needs an in-page click *after* the popup closes.

## Pure geometry (unit-tested) — `lib/screenshot.ts`

- `computeStitchPlan({ pageHeight, viewportHeight, maxTiles })` → `{ steps, coveredHeight, truncated }`.
  Vertical scroll offsets (CSS px); final slice clamped to the page bottom so the
  last tile aligns (overlap overwritten at draw time). Caps at `maxTiles` and sets
  `truncated` (no silent cap — popup surfaces it).
- `cropRegionForElement(rect, viewport, dpr)` → `{ sx, sy, sw, sh } | null`. Clamps
  an element's viewport-relative CSS rect to the visible viewport, scales to device
  pixels. `null` when the clamped region has zero area (element fully offscreen).

## Worker (`background.ts`) — chrome orchestration (not unit-tested)

- `captureFullPage(tab)`: read page dims → `computeStitchPlan` → per step
  `executeScript` scrollTo + throttle (captureVisibleTab is ~2/s) → `createImageBitmap`
  → draw onto `OffscreenCanvas(vw·dpr × coveredHeight·dpr)` → `convertToBlob` →
  data URL. Restores original scroll. Returns `{ dataUrl, truncated }`.
- `capture` message gains `mode`; `captureActiveTab` branches `fullpage` →
  `captureFullPage`, else single visible capture.
- Element picker flow:
  - `start-picker` (carries toggles): persist toggles to `chrome.storage.session`,
    inject `picker.js`, return. Popup then `window.close()`.
  - `picker.js` (esbuild → `public/picker.js`, isolated world): hover outline +
    instruction bar; click → message `picker-pick` with rect/viewport/dpr; `Esc` →
    `picker-cancel`.
  - On `picker-pick`: `captureVisibleTab` → crop via `cropRegionForElement` +
    `OffscreenCanvas` → build metadata + `gatherSignals` (stored toggles) → store
    `CaptureResult` in `chrome.storage.session` + set action badge `✓`.
  - On `picker-cancel`: clear badge + pending toggles.
- Popup `init`: if a pending element capture exists in session, consume it (clear +
  badge off) and show it instead of a fresh visible capture.

## i18n + housekeeping

- New keys in **both** `extension/messages/{en,de}.json`: mode labels, picker
  instruction/cancel, full-page truncation note, element-captured hint.
- Picker overlay strings come from Paraglide `m.*` bundled into `picker.js`.
- `build:picker` esbuild script in `package.json` (mirrors `build:recorder`).
- Feature-announcements catalog gate is ui/src-only → no entry (extension UX).

## Out of scope (kept for later)

Keyboard shortcut, horizontal stitch, toolbar icons.

## Unresolved questions

- none — defaults chosen (mode selector default `visible`; maxTiles 12; badge as
  reopen affordance since MV3 can't reopen the popup).

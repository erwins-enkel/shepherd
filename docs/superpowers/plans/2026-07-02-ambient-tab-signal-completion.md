# Ambient Tab Signal Completion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete issue #1327's ambient tab signal by adding the three approved-but-unshipped pieces: a progress-ring favicon for the selected session's build run, an opt-in glyph-ticker title, and a per-device toggle for it.

**Architecture:** Pure `deriveTabState` (in `tab-signal.svelte.ts`) gains per-severity tallies; the side-effecting `TabSignal` controller gains a ticker-title mode and a progress-ring favicon renderer with `dot > ring` precedence; a new `localStorage`-backed `tabTicker` singleton holds the opt-in bit; the root `+page.svelte` `$effect` computes the selected session's ring fraction and threads everything into `tabSignal.update`. A single `role="switch"` in `SettingsDevicePanel.svelte` binds the toggle.

**Tech Stack:** SvelteKit, Svelte 5 runes (`$state`), TypeScript, Vitest (node + browser projects), Paraglide i18n.

## Global Constraints

- **Design tokens only** — severity/ring colors via `var(--color-*)` resolved to hex at paint time through the existing guarded var-chain (`resolveColor`/`groundColor`); ring uses `--color-muted` → `--muted` → `#7c8c86`. Never a raw literal in markup/CSS.
- **i18n parity** — every new user-facing string added to BOTH `ui/messages/en.json` and `ui/messages/de.json`, snake_case, component-prefixed (`settings_tab_ticker_*`). `cd ui && bun run check:i18n` must pass.
- **Feature catalog** — this ships user-facing UX; add exactly one `ui/src/lib/feature-announcements/entries/v1.41.0-tab-glyph-title.ts` fragment in this PR.
- **The glyph string itself** (`⚠2 ✋1 ✓3 ▶4`) is data-shaped (fixed symbols + counts), assembled in code — NOT a translated message, same rationale as the numeric `(N)`.
- **Ticker glyph order** is most-urgent-first: `⚠` ci-red › `✋` blocked › `✓` ready › `▶` running; zero-count groups omitted.
- **Ring gating** — the ring favicon paints only when backgrounded AND `count === 0` AND the selected session `displayStatus === "running"` AND its build queue has steps; the severity dot always wins when `count > 0`.
- **Checks before PR** — from `ui/`: `bun install` (fresh worktree), `bun run check`, `bun run check:i18n`, `bun run test`. Fix failures before committing.
- **Branch hygiene** — one feature branch off latest `origin/main`, linear, no merge commits.

---

### Task 1: `tabTicker` per-device preference module

**Files:**
- Create: `ui/src/lib/tab-ticker.svelte.ts`
- Test: `ui/src/lib/tab-ticker.svelte.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export const tabTicker` — an instance with `enabled: boolean` (`$state`), `toggle(): void`, `set(v: boolean): void`; and `export { read as readTabTicker }`. Consumed by Task 4 (`+page.svelte` reads `tabTicker.enabled`) and Task 5 (`SettingsDevicePanel` binds it).

- [ ] **Step 1: Write the failing test**

Create `ui/src/lib/tab-ticker.svelte.test.ts`. **Node vitest has no `localStorage`** and the singleton's `read()` runs at import time — so stub `localStorage` BEFORE importing the module, exactly like `build-queue-collapse.svelte.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";

// Stub localStorage before importing the module so the singleton's read() call
// at init doesn't touch a real or missing localStorage.
const store: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => {
    store[key] = value;
  },
  removeItem: (key: string) => {
    delete store[key];
  },
  clear: () => {
    for (const k of Object.keys(store)) delete store[k];
  },
};
// @ts-expect-error stubbing global
globalThis.localStorage = localStorageMock;

import { tabTicker, readTabTicker } from "./tab-ticker.svelte";

const KEY = "shepherd:tab-glyph-ticker";

beforeEach(() => {
  localStorageMock.clear();
  tabTicker.set(false); // reset singleton
  localStorageMock.clear(); // clear the reset's side-effect write
});

describe("tabTicker store", () => {
  it("defaults to OFF (false) when localStorage is empty", () => {
    expect(tabTicker.enabled).toBe(false);
  });

  it("read() returns true when the key is '1'", () => {
    store[KEY] = "1";
    expect(readTabTicker()).toBe(true);
  });

  it("read() returns false when the key is absent", () => {
    expect(readTabTicker()).toBe(false);
  });

  it("set(true) writes '1' and flips enabled", () => {
    tabTicker.set(true);
    expect(store[KEY]).toBe("1");
    expect(tabTicker.enabled).toBe(true);
  });

  it("set(false) removes the key", () => {
    store[KEY] = "1";
    tabTicker.set(false);
    expect(store[KEY]).toBeUndefined();
  });

  it("toggle flips the value", () => {
    expect(tabTicker.enabled).toBe(false);
    tabTicker.toggle();
    expect(tabTicker.enabled).toBe(true);
    tabTicker.toggle();
    expect(tabTicker.enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && bunx vitest run src/lib/tab-ticker.svelte.test.ts`
Expected: FAIL — cannot resolve `./tab-ticker.svelte`.

- [ ] **Step 3: Write minimal implementation**

Create `ui/src/lib/tab-ticker.svelte.ts`:

```ts
// Per-device opt-in for the compact glyph tab title (⚠ ✋ ✓ ▶ counts) instead of
// the plain (N). Persisted in localStorage; mirrors build-queue-collapse.svelte.ts.
const KEY = "shepherd:tab-glyph-ticker";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

class TabTicker {
  enabled = $state(read());
  toggle() {
    this.set(!this.enabled);
  }
  set(v: boolean) {
    this.enabled = v;
    try {
      if (v) localStorage.setItem(KEY, "1");
      else localStorage.removeItem(KEY);
    } catch {
      /* private mode / SSR — preference just won't survive reload */
    }
  }
}

export const tabTicker = new TabTicker();
export { read as readTabTicker };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && bunx vitest run src/lib/tab-ticker.svelte.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/tab-ticker.svelte.ts ui/src/lib/tab-ticker.svelte.test.ts
git commit -m "feat(ui): per-device tabTicker preference (compact glyph title)"
```

---

### Task 2: Extend `deriveTabState` with per-severity tallies

**Files:**
- Modify: `ui/src/lib/tab-signal.svelte.ts` (the `TabState` interface + `deriveTabState`)
- Test: `ui/src/lib/tab-signal.svelte.test.ts`

**Interfaces:**
- Consumes: existing `sessionSeverity`, `Session`, `GitState`, `displayStatus`.
- Produces: `TabState` now = `{ count: number; severity: Severity; ci: number; blocked: number; ready: number; running: number }`. `deriveTabState(sessions, git, workingBlocked)` returns all six. `ci + blocked + ready === count` (invariant); `running` counts `displayStatus === "running"` sessions independently. Consumed by Task 3 (controller title) and Task 4 (effect wiring).

- [ ] **Step 1: Update existing tests to tolerate the new fields, and add tally tests**

In `ui/src/lib/tab-signal.svelte.test.ts`: the existing assertions use `.toEqual({ count, severity })` which is an exact match and will break once `deriveTabState` returns extra keys. Change each existing `expect(...).toEqual({ count, severity })` to `expect(...).toMatchObject({ count, severity })` (allows the new keys). Then append these new tests:

```ts
test("tallies split by severity; running counted independently", () => {
  const sessions = [
    sess("green", "done", true), // ready
    sess("amber", "blocked"), // blocked
    sess("red", "running"), // ci-red
    sess("run", "running"), // plain running (not in count)
  ];
  const g = { red: git("failure") };
  expect(deriveTabState(sessions, g, {})).toEqual({
    count: 3,
    severity: "red",
    ci: 1,
    blocked: 1,
    ready: 1,
    running: 2, // "red" (running+failure) and "run" both render running
  });
});

test("empty herd → all tallies zero", () => {
  expect(deriveTabState([], {}, {})).toEqual({
    count: 0,
    severity: "none",
    ci: 0,
    blocked: 0,
    ready: 0,
    running: 0,
  });
});

test("ci+blocked+ready === count invariant on a mixed herd", () => {
  const sessions = [sess("a", "blocked"), sess("b", "done", true), sess("c", "running")];
  const g = { c: git("failure") };
  const s = deriveTabState(sessions, g, {});
  expect(s.ci + s.blocked + s.ready).toBe(s.count);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && bunx vitest run src/lib/tab-signal.svelte.test.ts`
Expected: FAIL — `deriveTabState` result lacks `ci`/`blocked`/`ready`/`running`.

- [ ] **Step 3: Implement the tallies**

In `ui/src/lib/tab-signal.svelte.ts`, replace the `TabState` interface:

```ts
export interface TabState {
  /** Count of sessions needing the operator now (blocked · ci-red · ready-to-merge). */
  count: number;
  /** Highest severity across those sessions (red › amber › green › none). */
  severity: Severity;
  /** Per-rule tallies for the glyph-ticker title (ci+blocked+ready === count). */
  ci: number;
  blocked: number;
  ready: number;
  /** Sessions rendering as running (displayStatus), independent of `count`. */
  running: number;
}
```

Replace `deriveTabState`:

```ts
/** Pure: derive the tab count + highest severity + per-rule tallies from the store. */
export function deriveTabState(
  sessions: Session[],
  git: Record<string, GitState>,
  workingBlocked: Record<string, boolean>,
): TabState {
  let count = 0;
  let severity: Severity = "none";
  let ci = 0;
  let blocked = 0;
  let ready = 0;
  let running = 0;
  for (const s of sessions) {
    if (displayStatus(s, workingBlocked) === "running") running++;
    const sev = sessionSeverity(s, git[s.id], workingBlocked);
    if (sev === "none") continue;
    count++;
    if (sev === "red") ci++;
    else if (sev === "amber") blocked++;
    else if (sev === "green") ready++;
    if (SEVERITY_RANK[sev] > SEVERITY_RANK[severity]) severity = sev;
  }
  return { count, severity, ci, blocked, ready, running };
}
```

(Note: a ci-red session that is `running` is counted in both `ci` and `running` — intended; the ring only shows when `count === 0` anyway.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && bunx vitest run src/lib/tab-signal.svelte.test.ts`
Expected: PASS (all existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/tab-signal.svelte.ts ui/src/lib/tab-signal.svelte.test.ts
git commit -m "feat(ui): deriveTabState per-severity tallies for glyph ticker"
```

---

### Task 3: Controller — ticker title + progress-ring favicon

**Files:**
- Modify: `ui/src/lib/tab-signal.svelte.ts` (the `TabSignal` class + `resolveMuted`)
- Test: `ui/src/lib/tab-signal.browser.test.ts`

**Interfaces:**
- Consumes: `TabState` fields from Task 2.
- Produces: `TabSignal.update(next)` now accepts `{ count, severity, attended, ticker?, ci?, blocked?, ready?, running?, ringFraction? }` — the tally + `ticker` + `ringFraction` fields are OPTIONAL (default: tallies `0`, `ticker` `false`, `ringFraction` `null`) so hand-built test payloads and the wiring in Task 4 both typecheck. Consumed by Task 4.

- [ ] **Step 1: Write failing browser tests**

Append to `ui/src/lib/tab-signal.browser.test.ts`:

```ts
test("glyph ticker ON: compact grouped title, urgent-first, zero groups omitted", () => {
  const signal = createTabSignal();
  signal.update({
    count: 3,
    severity: "red",
    attended: false,
    ticker: true,
    ci: 1,
    blocked: 0,
    ready: 2,
    running: 4,
  });
  flush();
  // ⚠ ci, ✋ blocked(omitted, 0), ✓ ready, ▶ running — order urgent-first
  expect(document.title).toBe("⚠1 ✓2 ▶4 Shepherd");
});

test("glyph ticker ON but all groups zero → plain base title", () => {
  const signal = createTabSignal();
  signal.update({ count: 0, severity: "none", attended: false, ticker: true });
  flush();
  expect(document.title).toBe("Shepherd");
});

test("progress ring: PNG favicon when count 0 + ringFraction set, no title change", () => {
  const signal = createTabSignal();
  signal.update({ count: 0, severity: "none", attended: false, ringFraction: 0.5 });
  flush();
  expect(link.href.startsWith("data:image/png")).toBe(true);
  expect(document.title).toBe("Shepherd");
});

test("severity dot wins over the progress ring when count > 0", () => {
  const signal = createTabSignal();
  // both a live count and a ring fraction present → dot path, badge set
  signal.update({ count: 2, severity: "amber", attended: false, ringFraction: 0.9 });
  flush();
  expect(link.href.startsWith("data:image/png")).toBe(true);
  expect(setBadge).toHaveBeenLastCalledWith(2);
  expect(document.title).toBe("(2) Shepherd");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && bunx vitest run --project browser src/lib/tab-signal.browser.test.ts` (use the repo's browser-test invocation; check `package.json` scripts, e.g. `bun run test` runs both projects)
Expected: FAIL — ticker title not produced; `update` rejects unknown fields / ring not rendered.

- [ ] **Step 3: Implement controller changes**

In `ui/src/lib/tab-signal.svelte.ts`:

(a) Add the muted resolver next to `resolveColor` / `groundColor`:

```ts
/** Resolve the progress-ring color (muted: in-progress but not urgent); safe fallback. */
function resolveMuted(): string {
  const cs = getComputedStyle(document.documentElement);
  for (const name of ["--color-muted", "--muted"]) {
    const v = cs.getPropertyValue(name).trim();
    if (v && !v.startsWith("var(")) return v;
  }
  return "#7c8c86";
}
```

(b) Widen the `update`/`#apply`/`#next` payload type. Define a type alias above the class and use it everywhere the inline `{ count; severity; attended }` object appears:

```ts
type UpdatePayload = {
  count: number;
  severity: Severity;
  attended: boolean;
  ticker?: boolean;
  ci?: number;
  blocked?: number;
  ready?: number;
  running?: number;
  ringFraction?: number | null;
};
```

Change `#next: UpdatePayload | null = null;`, `update(next: UpdatePayload)`, and `#apply(p: UpdatePayload)`.

(c) Rewrite `#apply` — destructure with defaults, add ticker title + ring precedence:

```ts
#apply(p: UpdatePayload) {
  const {
    count,
    severity,
    attended,
    ticker = false,
    ci = 0,
    blocked = 0,
    ready = 0,
    running = 0,
    ringFraction = null,
  } = p;
  this.#lazyInit();
  this.#announce(count);

  const drained = this.#lastCount > 0 && count === 0 && !attended;
  this.#lastCount = count;

  if (attended) {
    this.#setTitle(this.#baseTitle);
    this.#clearBadge();
    this.#cancelFlourish();
    this.#restoreFavicon();
    return;
  }

  // Background tier — title.
  if (ticker) this.#setTitle(this.#tickerTitle(ci, blocked, ready, running));
  else this.#setTitle(count > 0 ? `(${count}) ${this.#baseTitle}` : this.#baseTitle);

  if (count > 0) this.#setBadge(count);
  else this.#clearBadge();

  if (drained) {
    this.#flourish();
    return;
  }
  if (this.#flourishTimer) return; // an in-progress flourish owns the favicon

  // Favicon precedence: severity dot › progress ring › restore.
  if (severity !== "none") this.#setFavicon(this.#renderDot(severity));
  else if (ringFraction != null) this.#setFavicon(this.#renderRing(ringFraction));
  else this.#restoreFavicon();
}
```

(d) Add the ticker-title builder (urgent-first, zero groups omitted):

```ts
/** Compact grouped title: ⚠ci ✋blocked ✓ready ▶running (non-zero groups only). */
#tickerTitle(ci: number, blocked: number, ready: number, running: number): string {
  const groups: string[] = [];
  if (ci) groups.push(`⚠${ci}`);
  if (blocked) groups.push(`✋${blocked}`);
  if (ready) groups.push(`✓${ready}`);
  if (running) groups.push(`▶${running}`);
  return groups.length ? `${groups.join(" ")} ${this.#baseTitle}` : this.#baseTitle;
}
```

(e) Add the ring renderer (coarse arc; base mark + full muted track + progress arc, ground-ringed for contrast):

```ts
/** Base mark + a coarse progress arc (clockwise from 12 o'clock). */
#renderRing(fraction: number): string {
  const [canvas, ctx, size] = this.#canvas();
  const f = Math.max(0, Math.min(1, fraction));
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.4;
  const w = Math.max(1, size * 0.12);
  const start = -Math.PI / 2;
  // faint full track for contrast on any favicon ground
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = groundColor();
  ctx.lineWidth = w + size * 0.06;
  ctx.stroke();
  // progress arc
  ctx.beginPath();
  ctx.arc(cx, cy, r, start, start + f * Math.PI * 2);
  ctx.strokeStyle = resolveMuted();
  ctx.lineWidth = w;
  ctx.lineCap = "round";
  ctx.stroke();
  return canvas.toDataURL("image/png");
}
```

Also update the two existing inline payload annotations inside `#flourish` (the `const n = this.#next;` branch already reads `.attended`/`.severity`; it now may also read `.ringFraction` — extend that restore branch:

```ts
this.#flourishTimer = setTimeout(() => {
  this.#flourishTimer = null;
  const n = this.#next;
  if (!n || n.attended) return this.#restoreFavicon();
  if (n.severity !== "none") return this.#setFavicon(this.#renderDot(n.severity));
  if (n.ringFraction != null) return this.#setFavicon(this.#renderRing(n.ringFraction));
  this.#restoreFavicon();
}, FLOURISH_MS);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && bun run test` (runs unit + browser projects)
Expected: PASS — new ticker/ring tests green, all prior tab-signal tests still green.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/tab-signal.svelte.ts ui/src/lib/tab-signal.browser.test.ts
git commit -m "feat(ui): glyph-ticker title + progress-ring favicon (dot wins over ring)"
```

---

### Task 4: Wire the root `$effect` in `+page.svelte`

**Files:**
- Modify: `ui/src/routes/+page.svelte` (imports + the `$effect` at ~line 136)

**Interfaces:**
- Consumes: `tabTicker` (Task 1), extended `deriveTabState` (Task 2), extended `tabSignal.update` (Task 3), `store.buildQueues[id]` (`Record<string, BuildQueue>`), `selected` (`$derived` session|null), `displayStatus` (already imported at `:65`).
- Produces: nothing new; drives the controller.

- [ ] **Step 1: Add the import**

At the top of the `<script>` (near line 5 where `tab-signal` is imported), add:

```ts
import { tabTicker } from "$lib/tab-ticker.svelte";
```

- [ ] **Step 2: Replace the effect body**

Replace the existing effect (currently):

```ts
$effect(() => {
  const { count, severity } = deriveTabState(store.sessions, store.git, store.workingBlocked);
  tabSignal.update({ count, severity, attended: store.attended });
});
```

with:

```ts
$effect(() => {
  const st = deriveTabState(store.sessions, store.git, store.workingBlocked);
  // Progress ring: selected session's build-queue completion, but ONLY when it is
  // running and nothing needs the operator (the severity dot always wins).
  const sel = selected;
  const q = sel ? store.buildQueues[sel.id] : undefined;
  let ringFraction: number | null = null;
  if (
    sel &&
    st.count === 0 &&
    displayStatus(sel, store.workingBlocked) === "running" &&
    q &&
    q.steps.length > 0
  ) {
    const done = q.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
    ringFraction = done / q.steps.length;
  }
  tabSignal.update({ ...st, attended: store.attended, ticker: tabTicker.enabled, ringFraction });
});
```

Note: `selected` is defined later in the file (`$derived` at `:562`) — Svelte 5 `$derived` + `$effect` handle the forward reference fine at runtime since the effect reads it lazily. If the SvelteKit compiler flags use-before-declaration, move nothing; `$derived` values are hoisted-safe. Verify with `bun run check`.

- [ ] **Step 3: Type/compile check**

Run: `cd ui && bun run check`
Expected: PASS (no svelte-check/tsc errors). If `selected` ordering errors, relocate the effect below the `selected` declaration.

- [ ] **Step 4: Commit**

```bash
git add ui/src/routes/+page.svelte
git commit -m "feat(ui): drive tab signal ring + ticker from the root effect"
```

---

### Task 5: Toggle UI + i18n keys

**Files:**
- Modify: `ui/src/lib/components/settings/SettingsDevicePanel.svelte`
- Modify: `ui/messages/en.json`, `ui/messages/de.json`

**Interfaces:**
- Consumes: `tabTicker` (Task 1), `m.settings_tab_ticker_*`.
- Produces: a visible per-device switch.

- [ ] **Step 1: Add i18n keys (both locales)**

In `ui/messages/en.json` add (near the `settings_colorblind_*` keys):

```json
"settings_tab_ticker_title": "Compact tab title",
"settings_tab_ticker_hint": "When a background tab needs you, show grouped glyph counts (⚠ CI failed · ✋ blocked · ✓ ready · ▶ running) instead of a single number. Off by default.",
"settings_tab_ticker_on": "Compact tab title on",
"settings_tab_ticker_off": "Compact tab title off",
```

In `ui/messages/de.json` add the matching keys:

```json
"settings_tab_ticker_title": "Kompakter Tab-Titel",
"settings_tab_ticker_hint": "Zeigt im Hintergrund-Tab gruppierte Symbolzähler (⚠ CI fehlgeschlagen · ✋ blockiert · ✓ bereit · ▶ läuft) statt einer einzelnen Zahl. Standardmäßig aus.",
"settings_tab_ticker_on": "Kompakter Tab-Titel an",
"settings_tab_ticker_off": "Kompakter Tab-Titel aus",
```

- [ ] **Step 2: Add the import + toggle block**

In `SettingsDevicePanel.svelte`, add to the script imports:

```ts
import { tabTicker } from "$lib/tab-ticker.svelte";
```

After the colorblind `</div>` block (the `.rc` div ending ~line 127), insert:

```svelte
<div class="rc">
  <span class="micro">{m.settings_tab_ticker_title()}</span>
  <p class="hint">{m.settings_tab_ticker_hint()}</p>
  <button
    type="button"
    class="toggle"
    role="switch"
    aria-checked={tabTicker.enabled}
    onclick={() => tabTicker.toggle()}
  >
    <span class="track" class:on={tabTicker.enabled}><span class="knob"></span></span>
    <span class="state"
      >{tabTicker.enabled ? m.settings_tab_ticker_on() : m.settings_tab_ticker_off()}</span
    >
  </button>
</div>
```

- [ ] **Step 3: Run i18n + type checks**

Run: `cd ui && bun run check:i18n && bun run check`
Expected: PASS — locale key sets identical; no svelte-check errors.

- [ ] **Step 4: Commit**

```bash
git add ui/src/lib/components/settings/SettingsDevicePanel.svelte ui/messages/en.json ui/messages/de.json
git commit -m "feat(ui): compact-tab-title toggle in device settings"
```

---

### Task 6: Feature-announcement entry + full verification

**Files:**
- Create: `ui/src/lib/feature-announcements/entries/v1.41.0-tab-glyph-title.ts`
- Modify: `ui/messages/en.json`, `ui/messages/de.json` (announcement keys)

**Interfaces:**
- Consumes: `FeatureAnnouncement` type.
- Produces: one catalog entry (satisfies the feature-catalog gate).

- [ ] **Step 1: Add announcement i18n keys (both locales)**

`ui/messages/en.json`:

```json
"feat_tab_glyph_title_title": "Compact tab title",
"feat_tab_glyph_title_body": "Turn on a denser background-tab title that groups what needs you by glyph — ⚠ CI failed, ✋ blocked, ✓ ready, ▶ running — plus a progress ring on the favicon for the session you're watching. Enable it in Settings → this device.",
```

`ui/messages/de.json`:

```json
"feat_tab_glyph_title_title": "Kompakter Tab-Titel",
"feat_tab_glyph_title_body": "Aktiviere einen dichteren Hintergrund-Tab-Titel, der nach Symbol gruppiert, was deine Aufmerksamkeit braucht — ⚠ CI fehlgeschlagen, ✋ blockiert, ✓ bereit, ▶ läuft — plus einen Fortschrittsring im Favicon der beobachteten Sitzung. Aktivierbar unter Einstellungen → dieses Gerät.",
```

- [ ] **Step 2: Create the entry fragment**

`ui/src/lib/feature-announcements/entries/v1.41.0-tab-glyph-title.ts`:

```ts
import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  id: "tab-glyph-title",
  sinceVersion: "1.41.0",
  titleKey: "feat_tab_glyph_title_title",
  bodyKey: "feat_tab_glyph_title_body",
} satisfies FeatureAnnouncement;

export default entry;
```

- [ ] **Step 3: Full verification sweep**

Run, from `ui/`:

```bash
cd ui && bun run check:i18n && bun run check && bun run test
```

Expected: all PASS. Then run the repo hygiene/feature-catalog gate if available locally:

```bash
cd .. && bash scripts/check-feature-catalog.sh 2>/dev/null || echo "gate runs in CI"
```

Expected: catalog check passes (a `feat(...)` touching UI now has a matching entry fragment).

- [ ] **Step 4: Commit**

```bash
git add ui/src/lib/feature-announcements/entries/v1.41.0-tab-glyph-title.ts ui/messages/en.json ui/messages/de.json
git commit -m "feat(ui): announce compact tab title + progress ring in feature catalog"
```

---

### Task 7: Open the pull request

**Files:** none (git/gh only).

- [ ] **Step 1: Rebase-check branch hygiene**

Run:

```bash
git fetch origin && git rebase origin/main
bash scripts/check-branch-hygiene.sh 2>/dev/null || echo "gate runs in CI"
```

Expected: linear, no merge commits; rebase clean (or resolve the union-merge catalog trivially).

- [ ] **Step 2: Final full check across touched halves (UI only here)**

```bash
cd ui && bun install && bun run check && bun run check:i18n && bun run test
```

Expected: all PASS.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin HEAD
gh pr create --title "feat(ui): complete ambient tab signal — progress ring + glyph ticker + toggle" --body "$(cat <<'EOF'
Completes the three approved-but-unshipped pieces of #1327's ambient tab signal:

- **Progress-ring favicon** — the selected session's build-queue completion (`done/total` steps), shown only when the tab is backgrounded, that session is running, and nothing needs the operator (the severity dot always wins).
- **Opt-in glyph-ticker title** — `⚠ci ✋blocked ✓ready ▶running Shepherd` (urgent-first, zero groups omitted) replacing the plain `(N)` when enabled.
- **Per-device toggle** — "Compact tab title" switch in Settings → this device (`localStorage`, default OFF).

Ring color is muted (`--color-muted`) so in-progress reads calm; anything urgent surfaces the severity dot instead.

## Relationship to #1332
No functional overlap: #1332 owns the #803 plan-gate/critic-question tier (server work), which this PR does NOT touch. The ring + glyph-ticker built here are the "bonus / separate follow-ups if pursued" bullets in #1332's body (no dedicated issue existed) — **this PR resolves those two bullets**. Shared seam: both edit `deriveTabState`/`TabState`, but with disjoint fields; this lands first, #1332 rebases.

## Verification
- `cd ui && bun run check && bun run check:i18n && bun run test` all green.
- New unit tests: `deriveTabState` tallies + invariant. New browser tests: ticker title formatting, ring favicon swap, dot-wins-over-ring precedence. New persistence test for `tabTicker`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR opened. No manual operator steps (purely client-side; no env/flag/migration).

---

## Self-Review

**Spec coverage:**
- Progress ring (selected session build queue, gated) → Task 3 (`#renderRing`) + Task 4 (`ringFraction`). ✓
- Glyph ticker (`⚠ ✋ ✓ ▶`, urgent-first, zero-omit) → Task 2 (tallies) + Task 3 (`#tickerTitle`). ✓
- Per-device toggle default OFF → Task 1 (`tabTicker`) + Task 5 (switch). ✓
- Muted ring color via guarded var-chain → Task 3 (`resolveMuted`). ✓
- i18n parity → Tasks 5 + 6. ✓
- Feature catalog entry → Task 6. ✓
- Tests (pure + browser + persistence) → Tasks 1–3. ✓
- Non-goals (no master switch, no quiet-mode, N=ci-red unchanged, #803 deferred, no server change) → nothing in any task touches them. ✓
- #1332 coordination → PR body (Task 7). ✓

**Placeholder scan:** no TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `TabState` (6 fields) defined in Task 2 is consumed with those exact names in Tasks 3–4; `UpdatePayload` optional fields in Task 3 match the object spread in Task 4 (`...st, attended, ticker, ringFraction`); `tabTicker.enabled`/`toggle` names consistent across Tasks 1, 4, 5; `store.buildQueues` + `BuildStep.status` (`"done"|"skipped"`) match `types.ts`. ✓

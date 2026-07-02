# Anonymous Usage Telemetry (Aptabase) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit opt-in, anonymous usage telemetry from the herdr-server to Aptabase, gated behind a first-run consent prompt and a Settings toggle, honouring `DO_NOT_TRACK`.

**Architecture:** A self-contained server-side `TelemetryService` posts events directly to Aptabase's documented HTTP API (`POST {host}/api/v0/events`, `App-Key` header) — no SDK, no browser. Consent is a persisted enum setting (`telemetryConsent`) exposed via `/api/settings`; a Svelte consent modal + Settings toggle drive it. All emission is gated: consent granted **and** `DO_NOT_TRACK` unset **and** an App-Key configured.

**Tech Stack:** Bun + TypeScript (server), SQLite key/value settings, SvelteKit + Svelte 5 + Tailwind 4 (UI), Paraglide i18n (EN+DE).

## Global Constraints

- **No new runtime dependency** — Aptabase has no Node SDK; use `fetch` directly. Root `dependencies` in `package.json` stays unchanged.
- **Emission gate (all three required):** `config.telemetryConsent === "granted"` AND `config.doNotTrack === false` AND `config.aptabaseAppKey !== null` (host resolvable). Any failing ⇒ hard no-op (no buffering, no network).
- **`DO_NOT_TRACK`** — [console DNT standard](https://consoledonottrack.com); truthy env value hard-disables telemetry and suppresses the consent prompt.
- **Anonymity** — never send hostname, username, cwd, repo paths, or free-form strings. Only the typed event names + primitive props allowlist + documented `systemProps`.
- **Enum value space:** `telemetryConsent ∈ {"unset","granted","denied"}`, default `"unset"`.
- **i18n:** every user-facing string added to BOTH `ui/messages/en.json` and `ui/messages/de.json` (identical key sets); verify `cd ui && bun run check:i18n`.
- **Design system:** UI uses `var(--color-*)` tokens + `--fs-*` sizes only — no raw hex/px. Reuse `.scrim`/`.overlay` + existing `.toggle`/`.gbtn` recipes. Modal must dim+blur.
- **Feature discovery:** add one `ui/src/lib/feature-announcements/entries/v1.40.0-anonymous-telemetry.ts` fragment (this ships in `1.40.0`; if the release has bumped by landing, match the new version in filename + `sinceVersion`).
- **Glossary:** add a `telemetry` external term with EN+DE Wikipedia slugs + `gloss_telemetry_term`/`gloss_telemetry_def` keys.
- **Commit style:** conventional commits; end messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **A11y:** modal buttons/toggles meet the 44×44px tap target floor (the existing `.toggle` recipe already sets `min-height: 44px`).

---

### Task 1: Telemetry consent value-space module

**Files:**
- Create: `src/telemetry-consent.ts`
- Test: `test/telemetry-consent.test.ts`

**Interfaces:**
- Produces: `type TelemetryConsent = "unset" | "granted" | "denied"`, `normalizeTelemetryConsent(value: unknown): TelemetryConsent | null`

Mirrors `src/auth-mode.ts:19-37`.

- [ ] **Step 1: Write the failing test**

```ts
// test/telemetry-consent.test.ts
import { test, expect } from "bun:test";
import { normalizeTelemetryConsent } from "../src/telemetry-consent";

test("accepts the three valid values", () => {
  expect(normalizeTelemetryConsent("unset")).toBe("unset");
  expect(normalizeTelemetryConsent("granted")).toBe("granted");
  expect(normalizeTelemetryConsent("denied")).toBe("denied");
});

test("rejects unknown / wrong-type values", () => {
  expect(normalizeTelemetryConsent("yes")).toBeNull();
  expect(normalizeTelemetryConsent("")).toBeNull();
  expect(normalizeTelemetryConsent(1)).toBeNull();
  expect(normalizeTelemetryConsent(null)).toBeNull();
  expect(normalizeTelemetryConsent(undefined)).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/telemetry-consent.test.ts`
Expected: FAIL — `Cannot find module '../src/telemetry-consent'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/telemetry-consent.ts
export type TelemetryConsent = "unset" | "granted" | "denied";

export const TELEMETRY_CONSENTS: readonly TelemetryConsent[] = [
  "unset",
  "granted",
  "denied",
] as const;

export function isTelemetryConsent(v: unknown): v is TelemetryConsent {
  return typeof v === "string" && (TELEMETRY_CONSENTS as readonly string[]).includes(v);
}

/**
 * Normalize an arbitrary value (env var, DB row, request body) to a valid
 * TelemetryConsent, or null if unrecognised / wrong type.
 */
export function normalizeTelemetryConsent(value: unknown): TelemetryConsent | null {
  return isTelemetryConsent(value) ? value : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/telemetry-consent.test.ts`
Expected: PASS (both tests)

- [ ] **Step 5: Commit**

```bash
git add src/telemetry-consent.ts test/telemetry-consent.test.ts
git commit -m "feat(telemetry): add telemetryConsent value-space module

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `TelemetryService` (host resolution, gate, enrichment, transport)

**Files:**
- Create: `src/telemetry.ts`
- Test: `test/telemetry.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (self-contained; no store/server import).
- Produces:
  - `type TelemetryEventName = "app_launched" | "session_created" | "epic_drained" | "pr_opened"`
  - `resolveAptabaseHost(appKey: string | null, hostOverride: string | null): string | null`
  - `type PostEventFn = (host: string, appKey: string, batch: unknown[]) => Promise<void>`
  - `class TelemetryService` with:
    - `constructor(deps: TelemetryDeps)`
    - `event(name: TelemetryEventName, props?: Record<string, string | number | boolean>): void`
    - `flush(): Promise<void>`
  - `interface TelemetryDeps { appKey: string | null; hostOverride: string | null; enabled: () => boolean; postEvent?: PostEventFn; now?: () => number; schedule?: (fn: () => void) => void; }`

Modeled on the injectable-`fetch` pattern in `src/herdr-update.ts:106-161` and `src/push.ts:112-122`.

**Design notes for the implementer:**
- `resolveAptabaseHost`: `null` appKey ⇒ `null`. Else derive from the region prefix of `A-<REGION>-…`: `US` → `https://us.aptabase.com`, `EU` → `https://eu.aptabase.com`. `SH` (self-hosted) requires `hostOverride` (return it, or `null` if absent). An explicit `hostOverride` always wins (trailing slash trimmed). Unknown region ⇒ `hostOverride ?? null`.
- `event()` is fire-and-forget: if `!ready()` return immediately (no buffering); else push an `EventBody` onto the in-memory buffer and call `schedule(() => void this.flush())`. Coalesce: don't schedule if a flush is already pending.
- `ready()` = `this.enabled() && this.host !== null && this.appKey !== null`.
- `flush()`: drain the buffer in slices of ≤25, `await postEvent(host, appKey, slice)` per slice, swallow all errors (best-effort; never throw into callers). Aptabase's batch endpoint is `POST {host}/api/v0/events` capped at 25.
- `EventBody` shape (Aptabase): `{ timestamp: ISO8601, sessionId, eventName, systemProps, props }`. `systemProps` = `{ isDebug:false, osName, osVersion, locale, appVersion, engineName, engineVersion, sdkVersion }`. Map `process.platform` → `"macOS"|"Windows"|"Linux"|<platform>`; `osVersion = os.release()`; `engineName = process.versions.bun ? "bun" : "node"`; `engineVersion = process.versions.bun ?? process.versions.node`; `appVersion` imported from `../package.json`; `locale = process.env.LANG ?? "unknown"`; `sdkVersion = "shepherd-telemetry@1"`. `sessionId` = one crypto-random id generated in the constructor.
- Default `schedule = (fn) => setTimeout(fn, 200)`; default `now = () => Date.now()`; default `postEvent = defaultPost` (below). Never send hostname/username/paths.

- [ ] **Step 1: Write the failing test**

```ts
// test/telemetry.test.ts
import { test, expect } from "bun:test";
import { TelemetryService, resolveAptabaseHost, type PostEventFn } from "../src/telemetry";

const sync = (fn: () => void) => fn();

function svc(over: Partial<Parameters<typeof TelemetryService.prototype.constructor>[0]> = {}) {
  const calls: { host: string; appKey: string; batch: any[] }[] = [];
  const postEvent: PostEventFn = async (host, appKey, batch) => {
    calls.push({ host, appKey, batch });
  };
  const s = new TelemetryService({
    appKey: "A-US-1234567890",
    hostOverride: null,
    enabled: () => true,
    postEvent,
    schedule: sync,
    now: () => 0,
    ...over,
  });
  return { s, calls };
}

test("resolveAptabaseHost derives region host, requires override for SH", () => {
  expect(resolveAptabaseHost("A-US-x", null)).toBe("https://us.aptabase.com");
  expect(resolveAptabaseHost("A-EU-x", null)).toBe("https://eu.aptabase.com");
  expect(resolveAptabaseHost("A-SH-x", null)).toBeNull();
  expect(resolveAptabaseHost("A-SH-x", "https://a.example.com/")).toBe("https://a.example.com");
  expect(resolveAptabaseHost(null, null)).toBeNull();
});

test("emits a POST with correct host/App-Key/body when enabled", async () => {
  const { s, calls } = svc();
  s.event("app_launched", { arch: "arm64" });
  await s.flush();
  expect(calls.length).toBe(1);
  expect(calls[0].host).toBe("https://us.aptabase.com");
  expect(calls[0].appKey).toBe("A-US-1234567890");
  const ev = calls[0].batch[0];
  expect(ev.eventName).toBe("app_launched");
  expect(ev.props).toEqual({ arch: "arm64" });
  expect(typeof ev.systemProps.osName).toBe("string");
  expect(ev.systemProps.sdkVersion).toBe("shepherd-telemetry@1");
});

test("no-op when consent not granted", async () => {
  const { s, calls } = svc({ enabled: () => false });
  s.event("app_launched");
  await s.flush();
  expect(calls.length).toBe(0);
});

test("no-op when App-Key absent", async () => {
  const { s, calls } = svc({ appKey: null });
  s.event("app_launched");
  await s.flush();
  expect(calls.length).toBe(0);
});

test("never leaks host/username/path in systemProps", async () => {
  const { s, calls } = svc();
  s.event("app_launched");
  await s.flush();
  const sp = JSON.stringify(calls[0].batch[0].systemProps);
  expect(sp).not.toContain(process.env.HOME ?? " nope");
  expect(sp.toLowerCase()).not.toContain("username");
});

test("batches in slices of <=25", async () => {
  const { s, calls } = svc();
  for (let i = 0; i < 30; i++) s.event("session_created");
  await s.flush();
  const total = calls.reduce((n, c) => n + c.batch.length, 0);
  expect(total).toBe(30);
  for (const c of calls) expect(c.batch.length).toBeLessThanOrEqual(25);
});

test("swallows postEvent failure (never throws)", async () => {
  const boom: PostEventFn = async () => {
    throw new Error("network down");
  };
  const { s } = svc({ postEvent: boom });
  s.event("app_launched");
  await s.flush(); // must not reject
  expect(true).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/telemetry.test.ts`
Expected: FAIL — `Cannot find module '../src/telemetry'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/telemetry.ts
import os from "node:os";
import pkg from "../package.json" with { type: "json" };

export type TelemetryEventName =
  | "app_launched"
  | "session_created"
  | "epic_drained"
  | "pr_opened";

export type PostEventFn = (host: string, appKey: string, batch: unknown[]) => Promise<void>;

export interface TelemetryDeps {
  appKey: string | null;
  hostOverride: string | null;
  enabled: () => boolean;
  postEvent?: PostEventFn;
  now?: () => number;
  schedule?: (fn: () => void) => void;
}

interface EventBody {
  timestamp: string;
  sessionId: string;
  eventName: string;
  systemProps: Record<string, unknown>;
  props: Record<string, string | number | boolean>;
}

const MAX_BATCH = 25;

const defaultPost: PostEventFn = (host, appKey, batch) =>
  fetch(`${host}/api/v0/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "App-Key": appKey },
    body: JSON.stringify(batch),
  }).then(() => undefined);

/** Derive the Aptabase ingestion host from the App-Key region, honouring an explicit override. */
export function resolveAptabaseHost(
  appKey: string | null,
  hostOverride: string | null,
): string | null {
  const override = hostOverride ? hostOverride.replace(/\/+$/, "") : null;
  if (override) return override;
  if (!appKey) return null;
  const region = appKey.split("-")[1]?.toUpperCase();
  if (region === "US") return "https://us.aptabase.com";
  if (region === "EU") return "https://eu.aptabase.com";
  return null; // SH / unknown without an explicit override
}

function osName(): string {
  switch (process.platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return process.platform;
  }
}

export class TelemetryService {
  private readonly appKey: string | null;
  private readonly host: string | null;
  private readonly enabled: () => boolean;
  private readonly postEvent: PostEventFn;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void) => void;
  private readonly sessionId: string;
  private readonly buffer: EventBody[] = [];
  private pending = false;

  constructor(deps: TelemetryDeps) {
    this.appKey = deps.appKey;
    this.host = resolveAptabaseHost(deps.appKey, deps.hostOverride);
    this.enabled = deps.enabled;
    this.postEvent = deps.postEvent ?? defaultPost;
    this.now = deps.now ?? (() => Date.now());
    this.schedule = deps.schedule ?? ((fn) => void setTimeout(fn, 200));
    this.sessionId = crypto.randomUUID();
  }

  private ready(): boolean {
    return this.enabled() && this.host !== null && this.appKey !== null;
  }

  private systemProps(): Record<string, unknown> {
    return {
      isDebug: false,
      osName: osName(),
      osVersion: os.release(),
      locale: process.env.LANG ?? "unknown",
      appVersion: (pkg as { version: string }).version,
      engineName: process.versions.bun ? "bun" : "node",
      engineVersion: process.versions.bun ?? process.versions.node,
      sdkVersion: "shepherd-telemetry@1",
    };
  }

  event(name: TelemetryEventName, props: Record<string, string | number | boolean> = {}): void {
    if (!this.ready()) return;
    this.buffer.push({
      timestamp: new Date(this.now()).toISOString(),
      sessionId: this.sessionId,
      eventName: name,
      systemProps: this.systemProps(),
      props,
    });
    if (this.pending) return;
    this.pending = true;
    this.schedule(() => {
      this.pending = false;
      void this.flush();
    });
  }

  async flush(): Promise<void> {
    if (this.host === null || this.appKey === null) {
      this.buffer.length = 0;
      return;
    }
    while (this.buffer.length > 0) {
      const slice = this.buffer.splice(0, MAX_BATCH);
      try {
        await this.postEvent(this.host, this.appKey, slice);
      } catch {
        // best-effort telemetry: drop the batch, never surface to callers
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/telemetry.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/telemetry.ts test/telemetry.test.ts
git commit -m "feat(telemetry): add TelemetryService with Aptabase HTTP client

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Config env wiring

**Files:**
- Modify: `src/config.ts` (add fields to the `config` object at `:370`; import the normalizer)

**Interfaces:**
- Consumes: `normalizeTelemetryConsent` (Task 1)
- Produces on `config`: `aptabaseAppKey: string | null`, `aptabaseHostOverride: string | null`, `doNotTrack: boolean`, `telemetryConsent: TelemetryConsent`

- [ ] **Step 1: Add the import**

At the top of `src/config.ts`, alongside the existing normalizer imports (near `import { normalizeAuthModeSetting } from "./auth-mode";`):

```ts
import { normalizeTelemetryConsent } from "./telemetry-consent";
```

- [ ] **Step 2: Add the config fields**

Inside the `export const config = {` object literal (near the `authMode:` seed at `src/config.ts:571` and the `vapidPublic`/`vapidPrivate` string-or-null fields at `:432-433`), add:

```ts
  // ── anonymous usage telemetry (Aptabase) ────────────────────────────────
  // Master enable: absent App-Key ⇒ telemetry is a hard no-op (forks, CI, dev
  // send nothing). SHEPHERD_APTABASE_HOST overrides the ingestion host for
  // self-hosted instances; when unset the host is derived from the App-Key
  // region (see resolveAptabaseHost). DO_NOT_TRACK (consoledonottrack.com)
  // hard-disables telemetry and suppresses the first-run consent prompt.
  aptabaseAppKey: process.env.SHEPHERD_APTABASE_APP_KEY ?? null,
  aptabaseHostOverride: process.env.SHEPHERD_APTABASE_HOST ?? null,
  doNotTrack: process.env.DO_NOT_TRACK === "1",
  // Persisted consent (DB row overrides this env seed at boot; see index.ts).
  telemetryConsent:
    normalizeTelemetryConsent(process.env.SHEPHERD_TELEMETRY_CONSENT) ?? "unset",
```

- [ ] **Step 3: Verify it type-checks**

Run: `bun run typecheck`
Expected: PASS (no errors referencing config.ts)

- [ ] **Step 4: Commit**

```bash
git add src/config.ts
git commit -m "feat(telemetry): add Aptabase + DO_NOT_TRACK config fields

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Server boot wiring — construct service, boot override, gated `app_launched`

**Files:**
- Modify: `src/index.ts` (import; boot-override block near `:276`; service construction near `:536`; deferred `app_launched` near the first-run resolution at `:2326`)

**Interfaces:**
- Consumes: `TelemetryService` (Task 2), `normalizeTelemetryConsent` (Task 1), `config.*` (Task 3), the `firstRun` gate, `deferredStarts`.
- Produces: a module-scoped `telemetry` instance used by the server (Task 5) — export it if `server.ts` imports it, otherwise thread it through the deps the server already receives. **Check how `src/server.ts` obtains its `deps`** (the `Ctx["deps"]` object) and add `telemetry` to that deps object so `putTelemetryConsent` can call it.

- [ ] **Step 1: Add imports**

Near the other `./` imports at the top of `src/index.ts`:

```ts
import { TelemetryService } from "./telemetry";
import { normalizeTelemetryConsent } from "./telemetry-consent";
```

- [ ] **Step 2: Boot-time DB override for telemetryConsent**

Alongside the `authMode` override block at `src/index.ts:276-280`, add:

```ts
const savedTc = store.getSetting("telemetryConsent");
if (savedTc !== null) {
  const v = normalizeTelemetryConsent(savedTc);
  if (v !== null) config.telemetryConsent = v;
}
```

- [ ] **Step 3: Construct the service**

Near the other service constructions (e.g. after `const learningsSvc = new LearningsService(store, events);` at `src/index.ts:536`):

```ts
const telemetry = new TelemetryService({
  appKey: config.aptabaseAppKey,
  hostOverride: config.aptabaseHostOverride,
  enabled: () => config.telemetryConsent === "granted" && !config.doNotTrack,
});
```

- [ ] **Step 4: Thread `telemetry` into the server deps**

Locate where the server request-handler `deps` object is assembled (the object carrying `store`, `events`, services — grep `src/index.ts` for where the `serve`/handler deps are built, and the `Ctx["deps"]` type in `src/server.ts`). Add `telemetry` to both the type and the constructed object. Add to the `Ctx["deps"]` type in `src/server.ts`:

```ts
  telemetry: import("./telemetry").TelemetryService;
```

(or a top-level `import type { TelemetryService } from "./telemetry";` then `telemetry: TelemetryService;`).

- [ ] **Step 5: Emit `app_launched` once the first-run gate is open**

At the first-run resolution point (`src/index.ts:2326-2329`), register the emit so it fires only after onboarding (mirrors every other gated subsystem). Replace:

```ts
if (firstRun.pending) firstRun.onResolve(startBackground);
else startBackground();
```

with the emit folded into the deferred set (add before the block, so it runs inside `startBackground`):

```ts
deferredStarts.push(() => {
  telemetry.event("app_launched");
});
if (firstRun.pending) firstRun.onResolve(startBackground);
else startBackground();
```

(`telemetry.event` is a no-op unless consent is granted, so a boot before the user answers the prompt sends nothing; the next launch after granting records the install. The unset→granted transition is also captured in Task 5.)

- [ ] **Step 6: Verify build + typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/server.ts
git commit -m "feat(telemetry): wire TelemetryService at boot with gated app_launched

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Server `/api/settings` — expose consent + validating PUT handler

**Files:**
- Modify: `src/server.ts` (GET fields in `handleSettings` at `:757`; `SETTING_PATCHES` entry at `:845`; new `putTelemetryConsent` handler near `putAuthMode` at `:3988`; import the normalizer + config)
- Test: `test/telemetry-settings.test.ts` (or extend an existing server settings test if one exists — grep `test/` for `handleSettings`/`/api/settings`)

**Interfaces:**
- Consumes: `normalizeTelemetryConsent` (Task 1), `config` (Task 3), `deps.telemetry` (Task 4), `deps.store`.
- Produces: GET `/api/settings` includes `telemetryConsent` + `telemetryAvailable`; PUT `{telemetryConsent}` persists + live-updates + emits `app_launched` on the `unset|denied → granted` transition.

- [ ] **Step 1: Add the import**

Near the other value-space imports in `src/server.ts`:

```ts
import { normalizeTelemetryConsent } from "./telemetry-consent";
import { resolveAptabaseHost } from "./telemetry";
```

- [ ] **Step 2: Expose consent in the GET response**

In `handleSettings` GET (`src/server.ts:757-800`), add to the returned object (near `authMode: config.authMode,`):

```ts
      telemetryConsent: config.telemetryConsent,
      // The UI shows the consent prompt / toggle only when telemetry can actually
      // run: an App-Key is configured (host resolvable) AND DO_NOT_TRACK is unset.
      telemetryAvailable:
        !config.doNotTrack &&
        resolveAptabaseHost(config.aptabaseAppKey, config.aptabaseHostOverride) !== null,
```

- [ ] **Step 3: Write the failing test**

```ts
// test/telemetry-settings.test.ts
import { test, expect } from "bun:test";
import { putTelemetryConsent } from "../src/server";

function fakeDeps() {
  const settings = new Map<string, string>();
  const events: string[] = [];
  return {
    deps: {
      store: {
        setSetting: (k: string, v: string) => settings.set(k, v),
        getSetting: (k: string) => settings.get(k) ?? null,
      },
      telemetry: { event: (n: string) => events.push(n) },
    } as any,
    settings,
    events,
  };
}

test("rejects an invalid consent value with 400", async () => {
  const { deps } = fakeDeps();
  const r = putTelemetryConsent("maybe", deps);
  expect(r.status).toBe(400);
});

test("persists + live-updates on granted, and emits app_launched on the transition", async () => {
  const { deps, settings, events } = fakeDeps();
  const r = putTelemetryConsent("granted", deps);
  expect(r.status).toBe(200);
  expect(settings.get("telemetryConsent")).toBe("granted");
  expect(events).toEqual(["app_launched"]); // unset -> granted fires once
});

test("denied persists but emits nothing", async () => {
  const { deps, settings, events } = fakeDeps();
  const r = putTelemetryConsent("denied", deps);
  expect(r.status).toBe(200);
  expect(settings.get("telemetryConsent")).toBe("denied");
  expect(events).toEqual([]);
});
```

> Note: `putTelemetryConsent` reads/writes `config.telemetryConsent` for the live value and the transition check. Because `config` is a shared singleton, run these assertions on the store/emit side (as above) to stay order-independent; if you assert `config.telemetryConsent` directly, reset it at the top of each test.

- [ ] **Step 4: Run test to verify it fails**

Run: `bun test ./test/telemetry-settings.test.ts`
Expected: FAIL — `putTelemetryConsent` is not exported.

- [ ] **Step 5: Add the handler + register it**

Add the handler near `putAuthMode` (`src/server.ts:3988`), and **export** it (the other `put*` handlers are module-private; export this one for the unit test — or if the file's convention forbids that, test via the `SETTING_PATCHES` dispatch instead):

```ts
// Consent is the only persisted telemetry state. Granting for the first time emits
// app_launched immediately so the very first opt-in records an install without waiting
// for the next boot. Denying/ungranting is silent. DO_NOT_TRACK still hard-gates emission
// downstream (TelemetryService.enabled), so a granted consent under DNT sends nothing.
export function putTelemetryConsent(value: unknown, deps: Ctx["deps"]): Response {
  const v = normalizeTelemetryConsent(value);
  if (v === null || v === "unset") {
    return json({ error: "telemetryConsent must be 'granted' or 'denied'" }, 400);
  }
  const wasGranted = config.telemetryConsent === "granted";
  config.telemetryConsent = v; // live: gate re-reads this
  deps.store.setSetting("telemetryConsent", v); // persist across restarts
  if (v === "granted" && !wasGranted) deps.telemetry.event("app_launched");
  return json({ telemetryConsent: config.telemetryConsent });
}
```

Register it in the `SETTING_PATCHES` table (`src/server.ts:845-878`), alongside `["authMode", putAuthMode],`:

```ts
  ["telemetryConsent", putTelemetryConsent],
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test ./test/telemetry-settings.test.ts`
Expected: PASS (all three).

- [ ] **Step 7: Commit**

```bash
git add src/server.ts test/telemetry-settings.test.ts
git commit -m "feat(telemetry): expose + persist telemetryConsent via /api/settings

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: UI types + API client

**Files:**
- Modify: `ui/src/lib/types.ts` (`Settings` interface at `:47`)
- Modify: `ui/src/lib/api.ts` (near the `put*` wrappers at `:462-474`)

**Interfaces:**
- Consumes: server GET/PUT shape (Task 5).
- Produces: `Settings.telemetryConsent: "unset" | "granted" | "denied"`, `Settings.telemetryAvailable: boolean`; `putTelemetryConsent(consent): Promise<{ telemetryConsent: string }>`.

- [ ] **Step 1: Extend the `Settings` interface**

In `ui/src/lib/types.ts` (inside `export interface Settings {`, near `reducedPushMode: boolean;` at `:128`):

```ts
  /** Anonymous usage-telemetry consent. "unset" until the operator answers the first-run prompt. */
  telemetryConsent: "unset" | "granted" | "denied";
  /** True when telemetry can run (App-Key configured AND DO_NOT_TRACK unset) — gates the prompt + toggle. */
  telemetryAvailable: boolean;
```

- [ ] **Step 2: Add the API wrapper**

In `ui/src/lib/api.ts`, alongside the other single-field wrappers (after `putSessionHousekeeping` at `:466-474`):

```ts
// Set anonymous-telemetry consent ("granted" | "denied"). Server persists + live-applies.
export const putTelemetryConsent = (
  consent: "granted" | "denied",
): Promise<{ telemetryConsent: string }> => patchSettings({ telemetryConsent: consent });
```

- [ ] **Step 3: Verify type-check**

Run: `cd ui && bun run check`
Expected: PASS (svelte-check clean for these files).

- [ ] **Step 4: Commit**

```bash
git add ui/src/lib/types.ts ui/src/lib/api.ts
git commit -m "feat(telemetry): add telemetry settings type + API client wrapper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: i18n keys for consent UI

**Files:**
- Modify: `ui/messages/en.json`, `ui/messages/de.json`

**Interfaces:**
- Produces the message keys consumed by Tasks 8–10. Add all of the following to **both** catalogs (English values shown; provide accurate German in `de.json`).

- [ ] **Step 1: Add the keys to `en.json`**

```json
"telemetry_consent_title": "Help improve Shepherd?",
"telemetry_consent_body": "Shepherd can send anonymous usage [[telemetry|telemetry]] — your OS, version, and which features are used. No code, file paths, repo names, or personal data ever leave your machine. You can change this any time in Settings.",
"telemetry_consent_accept": "Share anonymous usage",
"telemetry_consent_decline": "No thanks",
"settings_telemetry_title": "Anonymous usage telemetry",
"settings_telemetry_hint": "Send anonymous, aggregate usage data (OS, version, feature usage) to help prioritise Shepherd's roadmap. No code or personal data.",
"settings_telemetry_on": "On",
"settings_telemetry_off": "Off",
"settings_telemetry_unavailable": "Disabled by DO_NOT_TRACK or not configured on this server.",
"settings_telemetry_save_failed": "Couldn't save the telemetry setting.",
"gloss_telemetry_term": "telemetry",
"gloss_telemetry_def": "Automatic collection of anonymous usage and diagnostic data from software, sent back to its developers to guide improvements.",
"feat_anonymous_telemetry_title": "Optional anonymous usage telemetry",
"feat_anonymous_telemetry_body": "Shepherd can now send anonymous, privacy-first usage data (OS, version, feature usage — never code or personal data) to help prioritise the roadmap. It's off until you opt in, respects DO_NOT_TRACK, and can be toggled any time in Settings."
```

- [ ] **Step 2: Add the same keys to `de.json`** (accurate German translations, same keys, non-empty). Example for two:

```json
"telemetry_consent_title": "Shepherd verbessern helfen?",
"settings_telemetry_title": "Anonyme Nutzungstelemetrie",
```

(Translate every key added in Step 1.)

- [ ] **Step 3: Verify parity**

Run: `cd ui && bun run check:i18n`
Expected: `✓ i18n: 2 locales in parity (N keys each)`

- [ ] **Step 4: Commit**

```bash
git add ui/messages/en.json ui/messages/de.json
git commit -m "feat(telemetry): add i18n keys for telemetry consent UI

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Settings toggle

**Files:**
- Modify: `ui/src/lib/components/Settings.svelte` (session panel `:1191-1449`; state near `:167`; handler near `:701`; hydrate in `onMount` near `:827`; import the API wrapper near `:23`)

**Interfaces:**
- Consumes: `putTelemetryConsent` (Task 6), `Settings.telemetryConsent`/`telemetryAvailable` (Task 6), the i18n keys (Task 7).

- [ ] **Step 1: Import the API wrapper + state**

Add to the API import block: `putTelemetryConsent`. Add state near `:167`:

```svelte
let telemetryOn = $state(false);
let telemetryAvailable = $state(false);
let telemetryBusy = $state(false);
```

- [ ] **Step 2: Hydrate in `onMount`**

Where settings are read (`const s = await getSettings();` at `:827`):

```svelte
telemetryOn = s.telemetryConsent === "granted";
telemetryAvailable = s.telemetryAvailable;
```

- [ ] **Step 3: Add the handler** (near `toggleReducedPush` at `:701`)

```svelte
async function toggleTelemetry() {
  if (telemetryBusy) return;
  telemetryBusy = true;
  const next = !telemetryOn;
  try {
    const r = await putTelemetryConsent(next ? "granted" : "denied");
    telemetryOn = r.telemetryConsent === "granted";
  } catch {
    toasts.info(m.settings_telemetry_save_failed(), {
      key: "telemetry-consent",
      duration: null,
      alert: true,
    });
  } finally {
    telemetryBusy = false;
  }
}
```

- [ ] **Step 4: Add the toggle markup** in the session panel (mirror the housekeeping toggle at `:1217-1235`)

```svelte
<div class="rc">
  <span class="micro">{m.settings_telemetry_title()}</span>
  <p class="hint">{m.settings_telemetry_hint()}</p>
  {#if telemetryAvailable}
    <button
      type="button"
      class="toggle"
      role="switch"
      aria-checked={telemetryOn}
      disabled={telemetryBusy}
      onclick={toggleTelemetry}
    >
      <span class="track" class:on={telemetryOn}><span class="knob"></span></span>
      <span class="state">{telemetryOn ? m.settings_telemetry_on() : m.settings_telemetry_off()}</span>
    </button>
  {:else}
    <p class="hint">{m.settings_telemetry_unavailable()}</p>
  {/if}
</div>
```

- [ ] **Step 5: Verify**

Run: `cd ui && bun run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/components/Settings.svelte
git commit -m "feat(telemetry): add telemetry toggle to Settings

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: First-run consent modal

**Files:**
- Create: `ui/src/lib/components/TelemetryConsent.svelte`
- Modify: `ui/src/routes/+page.svelte` (state near `:435`/`:506`; `loadSettings()` at `:576-598`; render near the `<Onboarding …>` site at `:2540`)

**Interfaces:**
- Consumes: `putTelemetryConsent` (Task 6), `Settings.telemetryConsent`/`telemetryAvailable`, i18n keys (Task 7), `dialog` action (`$lib/a11yDialog`), `GlossaryText`.
- Shown when `telemetryAvailable && telemetryConsent === "unset"`, and only after the onboarding (repo-pick) gate is resolved (don't stack two blocking modals — see Step 3 gating).

- [ ] **Step 1: Create the modal component** (mirrors `Onboarding.svelte:63-113` `.scrim` recipe + scoped `.gbtn` at `:200-225`)

```svelte
<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { dialog } from "$lib/a11yDialog";
  import GlossaryText from "./GlossaryText.svelte";
  import { putTelemetryConsent } from "$lib/api";

  const { onresolved }: { onresolved: () => void } = $props();
  let busy = $state(false);

  async function choose(consent: "granted" | "denied") {
    if (busy) return;
    busy = true;
    try {
      await putTelemetryConsent(consent);
    } catch {
      // best-effort; if the PUT fails the prompt reappears next load
    } finally {
      busy = false;
      onresolved();
    }
  }
</script>

<div class="scrim" role="presentation">
  <div
    class="card"
    role="dialog"
    aria-modal="true"
    aria-labelledby="telemetry-consent-title"
    use:dialog={{}}
  >
    <header class="head">
      <h2 id="telemetry-consent-title">{m.telemetry_consent_title()}</h2>
    </header>
    <div class="body">
      <p><GlossaryText text={m.telemetry_consent_body()} /></p>
    </div>
    <footer class="foot">
      <button type="button" class="gbtn" disabled={busy} onclick={() => choose("denied")}>
        {m.telemetry_consent_decline()}
      </button>
      <button type="button" class="gbtn primary" disabled={busy} onclick={() => choose("granted")}>
        {m.telemetry_consent_accept()}
      </button>
    </footer>
  </div>
</div>

<style>
  .scrim {
    z-index: 61;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: calc(16px + env(safe-area-inset-top)) 16px calc(16px + env(safe-area-inset-bottom));
  }
  .card {
    width: min(440px, 100%);
    display: flex;
    flex-direction: column;
    gap: 14px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 10px;
    padding: 20px;
  }
  .head h2 {
    margin: 0;
    font-size: var(--fs-lg);
    color: var(--color-ink-bright);
  }
  .body p {
    margin: 0;
    font-size: var(--fs-base);
    color: var(--color-ink);
    line-height: 1.5;
  }
  .foot {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
  .gbtn {
    border: 1px solid var(--color-line-bright);
    border-radius: 6px;
    padding: 7px 16px;
    background: var(--color-panel-2);
    color: var(--color-ink-bright);
    font: inherit;
    cursor: pointer;
    min-height: 44px;
  }
  .gbtn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .gbtn.primary {
    background: var(--color-amber);
    border-color: var(--color-amber);
    color: var(--color-panel);
  }
</style>
```

> The `.gbtn` values are copied from `Onboarding.svelte:200-225`. If that recipe changes, copy its current values — do not diverge.

- [ ] **Step 2: Add state + hydrate in `+page.svelte`**

Near `let showOnboarding = $state(false);` (`:435`):

```svelte
let showTelemetryConsent = $state(false);
```

In `loadSettings()` (`:576-598`), after `settings = s;`:

```svelte
// Ask for telemetry consent once the operator has onboarded and telemetry can run.
if (s.telemetryAvailable && s.telemetryConsent === "unset" && !s.firstRunPending) {
  showTelemetryConsent = true;
}
```

- [ ] **Step 3: Render the modal** (near the `<Onboarding …>` render at `:2540`). Gate on `!onboardingBlocking` so it never stacks over the blocking repo-pick modal:

```svelte
{#if showTelemetryConsent && !onboardingBlocking}
  <TelemetryConsent
    onresolved={() => {
      showTelemetryConsent = false;
      loadSettings();
    }}
  />
{/if}
```

Add the import near the other component imports at the top of `+page.svelte`:

```svelte
import TelemetryConsent from "$lib/components/TelemetryConsent.svelte";
```

- [ ] **Step 4: Verify**

Run: `cd ui && bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/components/TelemetryConsent.svelte ui/src/routes/+page.svelte
git commit -m "feat(telemetry): add first-run consent modal

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: Glossary + feature-announcement entries

**Files:**
- Modify: `ui/src/lib/glossary.ts` (registry array at `:19`)
- Create: `ui/src/lib/feature-announcements/entries/v1.40.0-anonymous-telemetry.ts`

**Interfaces:**
- Consumes: `gloss_telemetry_term`/`gloss_telemetry_def` + `feat_anonymous_telemetry_title`/`_body` keys (Task 7).

- [ ] **Step 1: Add the glossary entry** (external term → Wikipedia; mirror the `pr` entry at `glossary.ts:24-34`)

```ts
  {
    id: "telemetry",
    kind: "external",
    termKey: "gloss_telemetry_term",
    bodyKey: "gloss_telemetry_def",
    wikipedia: {
      en: "Telemetry#Software",
      de: "Telemetrie_(Software)",
    },
  },
```

- [ ] **Step 2: Create the feature-announcement fragment**

```ts
// ui/src/lib/feature-announcements/entries/v1.40.0-anonymous-telemetry.ts
import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Opt-in anonymous usage telemetry. No targetId — the toggle lives in the
  // Settings modal, which isn't mounted until opened, so there's no stable
  // coachmark anchor. What's-New drawer only.
  id: "anonymous-telemetry",
  sinceVersion: "1.40.0",
  titleKey: "feat_anonymous_telemetry_title",
  bodyKey: "feat_anonymous_telemetry_body",
} satisfies FeatureAnnouncement;

export default entry;
```

- [ ] **Step 3: Verify the gates**

Run: `node scripts/check-glossary.mjs` (from repo root)
Expected: passes (glossary referential integrity).
Run: `cd ui && bun run check:i18n`
Expected: parity holds.

- [ ] **Step 4: Commit**

```bash
git add ui/src/lib/glossary.ts ui/src/lib/feature-announcements/entries/v1.40.0-anonymous-telemetry.ts
git commit -m "feat(telemetry): add glossary + feature-announcement entries

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: Full verification + follow-up issue

**Files:** none (verification only) — plus one `gh issue create`.

- [ ] **Step 1: Root server checks**

Run (repo root): `bun install && bun run lint && bun run typecheck && bun test`
Expected: all pass. Fix any failure before proceeding.

- [ ] **Step 2: UI checks**

Run: `cd ui && bun install && bun run check && bun test`
Expected: all pass.

- [ ] **Step 3: Hygiene gates (what CI/pre-push enforce)**

Run (repo root):
```bash
bash scripts/check-feature-catalog.sh
node scripts/check-glossary.mjs
(cd ui && bun run check:i18n)
```
Expected: all pass.

- [ ] **Step 4: Manual smoke (the gate matrix, end-to-end)**

With a throwaway App-Key set, confirm the gate by observing the outbound request (e.g. temporary `console.error` in `defaultPost`, or a local catch-all). Verify:
- No App-Key ⇒ no request on boot or on grant.
- App-Key + consent `unset` ⇒ prompt appears; no request until answered.
- Grant ⇒ one `app_launched` POST with correct `App-Key` header; systemProps has osName/appVersion, no HOME path.
- `DO_NOT_TRACK=1` ⇒ prompt suppressed, toggle shows unavailable, no request even if consent was `granted`.
Remove any temporary logging before committing.

- [ ] **Step 5: File the fast-follow issue for feature-usage events**

```bash
gh issue create \
  --title "Telemetry: wire session_created / epic_drained / pr_opened events" \
  --body "The TelemetryService (src/telemetry.ts) already types these event names. Wire telemetry.event(...) at the confirmed emit sites once the v1 event set is finalised (spec open question #2). Ref spec: docs/superpowers/specs/2026-07-02-aptabase-telemetry-design.md. app_launched already ships."
```

- [ ] **Step 6: Open the PR**

Push the branch and open a single PR. Include in the body:
- Summary of the opt-in, DNT-respecting design.
- A `shepherd:manual-steps` block declaring the deploy-time env setup:

```shepherd:manual-steps
- [ ] Provision an Aptabase app (Cloud or self-hosted) and set SHEPHERD_APTABASE_APP_KEY (and SHEPHERD_APTABASE_HOST if self-hosted) in the server environment. Without it, telemetry stays a no-op.
```

---

## Self-Review

**Spec coverage:**
- Consent model (prompt on first run, no default) → Tasks 5 (state), 9 (modal). ✓
- Data scope health + `app_launched` → Task 4; feature-usage events typed but deferred to a follow-up issue (Task 11 step 5) — a deliberate, documented scope narrowing of the spec's "health + feature usage", pending open question #2. ✓ (flagged)
- Server-side thin client → Task 2. ✓
- DO_NOT_TRACK → Tasks 3 (config), 5 (availability), 9 (prompt suppression). ✓
- App-Key master enable + host derivation/override → Tasks 2, 3, 5. ✓
- No persistent install ID → Task 2 (per-process sessionId only). ✓
- Anonymity/scrub → Task 2 (systemProps allowlist; leak test). ✓
- Gate matrix tests → Task 2; real-wiring test (PUT emits) → Task 5. ✓
- UI toggle + settings persistence → Tasks 6, 8. ✓
- i18n EN+DE → Task 7. ✓
- Feature announcement + glossary → Task 10. ✓
- Manual operator steps → Task 11 step 6. ✓

**Placeholder scan:** German values in Task 7 Step 2 are the one intentional "fill in" — real translation is required at implementation, not a sk-ippable stub. No other TBD/TODO.

**Type consistency:** `telemetryConsent` enum values, `resolveAptabaseHost` signature, `TelemetryService.event`/`flush`, `putTelemetryConsent(value, deps)`, and the `Settings` fields are consistent across Tasks 1–9.

**Known verification-time unknowns (resolve during implementation, don't guess):**
- Task 4 Step 4: the exact shape/location of the server `deps` object and `Ctx["deps"]` type — inspect `src/server.ts` + `src/index.ts` to thread `telemetry` correctly.
- Task 5 Step 5: whether the file's lint config permits exporting a `put*` handler for the unit test; if not, test through `SETTING_PATCHES` dispatch instead.

# Plugin-driven UI widgets for Shepherd — design research

**Recommendation (settled):** extend the plugin system with a **declarative component-descriptor** capability — plugins return a small JSON tree of `type` + `props` nodes that the Shepherd host renders from a **whitelisted registry of native Svelte components** (the Server-Driven-UI / SDUI pattern). This is the natural extension of the JSON status blob plugins already push (`ctx.publishStatus`), it inherits Shepherd's design tokens / i18n / glossary for free, it carries **no code across the trust seam**, and "the registry is the contract" means even a buggy plugin can only recompose components the host already ships. The untrusted-marketplace machinery — sandboxed iframes, web-component bundles, Module Federation, frontend sandboxes, signing — is **over-engineered for Shepherd's trusted, single-author, local-first model** and should be skipped. Reserve a sandboxed `<iframe>` strictly for the narrow future case of embedding arbitrary external pages.

**Headline finding:** Shepherd already has every load-bearing half built. Plugins push live JSON over the `/events` WebSocket and it renders in **Settings → Plugins** today (`SettingsPluginsPanel.svelte`); the UI is Svelte 5 with a semantic-token layer and a proven `marked` + DOMPurify sanitization pattern. The gap is purely additive: a **descriptor schema**, a **whitelisted renderer**, a small **component registry**, and a **placement (contribution-point) layer** so a plugin's panel slots into a known UI region. No change to the trust model, no change to spawn isolation, no new external dependency.

**Motivating use case:** the sibling **`claude-swap`** plugin (`/home/patrick/Work/shepherd-claude-swap`) already computes exactly the data an operator wants to _see_ — per-account 5h/7d quota, pool readiness, live session→account assignments, last spawn decision — and dumps it as a raw JSON blob the panel renders verbatim. It wants a real panel (quota bars, an assignment table, ready/rate-limited badges) but the platform only offers a `<pre>`-style JSON dump. This document is the bridge from "plugin emits JSON" to "plugin describes a panel."

Sources: see §5. Code refs are `path:line` against this worktree.

---

## 1. The concrete demand: what claude-swap _would_ render

`claude-swap` is purely backend logic — it serves no UI. It rotates agent spawns across Claude accounts via `ctx.onSpawn`, persists sticky `sessionId→account` assignments to `ctx.state`, exposes `GET /stats` + `POST /reset` routes, and calls `ctx.publishStatus(buildStatus())` at boot and after every 60s pool refresh. The status blob (`shepherd-claude-swap/src/status.ts:18`) is already a rich, typed object:

```jsonc
{
  "config":   { "cswapBin": "cswap", "rateLimitPct": 100, "excludeSlots": [], ... },
  "pool":     [ { "number": 1, "email": "…", "usable": true, "rateLimited": false,
                  "fiveHourPct": 5, "sevenDayPct": 12, "ready": true, "active": false }, … ],
  "assignments": { "<sessionId>": 1, … },
  "cursor":   2,
  "lastSpawn": { "sessionId": "…", "accountNumber": 1, "at": "2026-06-27T…" },
  "lastError": null
}
```

Today an operator sees this as an **expandable JSON dump** in Settings → Plugins. What the author obviously _wants_ (inferred straight from the shape): per-account **quota bars** (5h / 7d %), a **ready / rate-limited** badge column, a **session→account assignment table**, and a **last-decision** line. Every datum already exists; only the _rendering_ is missing — and the plugin has no way to express it. That is the precise capability gap this report scopes.

---

## 2. Current state — what the platform offers and where it stops

### 2.1 Plugin system (server, in-process, **trusted**)

Plugins are trusted single-author in-process code (one Bun event loop, server privileges; **not sandboxed** — `docs/plugins.md`). The whole contract is the versioned `ctx` seam (`PluginContext`, `src/plugins/types.ts:80`). Manifest (`plugin.json`, `src/plugins/types.ts:15`): `id`, `name`, `version`, `apiVersion` (must equal `PLUGIN_API_VERSION` = 1), optional `capabilities[]` (advisory in v1), optional `enabled`.

| Capability                                                | Contract (`src/plugins/types.ts`)                              | UI relevance                      |
| --------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------- |
| `ctx.onSpawn(fn)`                                         | Mutate spawn env/args/credentialDir, 5s-bounded, fail-open     | none                              |
| `ctx.events.subscribe(fn)`                                | Read-only core event stream                                    | none (plugins can't emit)         |
| **`ctx.publishStatus(json)`**                             | Push free-form JSON → emits `plugin:status` over `/events`     | **the only UI integration today** |
| `ctx.state`                                               | Durable per-plugin K/V (SQLite `plugin_state`)                 | backing data                      |
| `ctx.route(method, path, fn)`                             | Any method at `/api/plugins/<id>/<path>`, behind operator auth | data API, not surfaced            |
| `ctx.log`, `ctx.config`, `ctx.manifest`, `ctx.abortSpawn` | logging / config / manifest / hard-block                       | none                              |

Health (`ok` / `errored` / `timed-out`) is **core-derived and unspoofable** (`src/plugins/loader.ts:305`). Plugins **cannot** register UI pages, sidebar items, components, or routes in the frontend. `publishStatus` is view-only JSON; `ctx.route` serves data the UI never auto-mounts.

### 2.2 Frontend (SvelteKit, Svelte 5 runes)

- **Panel today:** `ui/src/lib/components/settings/SettingsPluginsPanel.svelte` — one row per plugin (name, version, health badge, last error, expandable JSON). Tab hidden when no plugins (`Settings.svelte:109`).
- **Data flow:** bootstrap `GET /api/plugins` → `PluginInfo[]` (`ui/src/lib/types.ts:1131`, `api.ts:1031`); live updates pushed as `plugin:status` over the `/events` **WebSocket** → `store.applyPluginStatus` (`store.svelte.ts:161`). No polling. The reactive plumbing for live plugin UI **already exists**.
- **Composition:** panels are **hardcoded per route/tab** (`+page.svelte`, `Viewport.svelte`, `Settings.svelte`). There is **no dynamic widget/slot registry** — adding plugin widgets needs either explicit host wiring at known regions, or a new descriptor-driven `DynamicPanel`.
- **Sanitization already solved:** `marked` + **DOMPurify** lazy-import pattern renders untrusted markdown across `DoneRecapPanel.svelte`, `GitRail.svelte`, `HerdrUpdateModal.svelte` (`dompurify@^3.4.11` in `ui/package.json`). Shiki handles code (`ui/src/lib/highlight.ts`). No iframe/sandbox usage exists for widgets.

### 2.3 Non-negotiable UI constraints (`CLAUDE.md`)

Any plugin UI **must** satisfy: semantic tokens only (`var(--color-*)`, `var(--fs-*)` — no raw hex/px; `ui/src/app.css`); full i18n via Paraglide (`m.*`, EN+DE parity, `check:i18n` gate); component recipes from `/design-system`; feature-announcements catalog entry; glossary entries for new terms; modal scrim+blur rule. **These constraints are themselves the strongest argument for the descriptor approach** — host-shipped components are already compliant; plugin-shipped HTML/JS would route _around_ every one of these gates.

---

## 3. Prior art — six models, and which fit a trusted local host

The industry machinery exists to do two things Shepherd does **not** need: load **untrusted** third-party code safely, and **decouple** plugin lifecycle from the host build. Evaluate against _fit_, not against an adversary.

| Model                               | How the plugin ships UI                                                                        | Isolation boundary                                               | Fit for Shepherd                                                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **VS Code webviews**                | Extension sets full HTML; iframe-isolated; `postMessage` only; CSP required                    | Strong (iframe + no host API)                                    | Boundary is overkill; **steal the _other_ half** (declarative `contributes` points + `when`-clause placement) |
| **VS Code contribution points**     | Declare `views`/`menus`/`commands` in manifest; host renders **natively**                      | N/A (host renders)                                               | **Direct fit** — model for the placement layer (§4.2)                                                         |
| **Grafana panel plugins**           | Ship a React bundle; host lazy-loads via SystemJS/Module-Federation into its own tree          | None by default (opt-in sandbox, off)                            | Over-engineered; runs third-party JS at host privilege                                                        |
| **Backstage frontend plugins**      | npm/MF package mounted into the app                                                            | **None by design** ("same access as the app")                    | Confirms: dynamic loading ≠ isolation; not worth the build complexity                                         |
| **Server-Driven UI** (Airbnb Ghost) | Server returns **JSON tree of component refs**; client renders from a **whitelisted registry** | The JSON _is_ the contract — no code crosses                     | **Best fit** — see below                                                                                      |
| **Sandboxed iframe**                | Plugin serves a full page; host frames it cross-origin; `postMessage`                          | Strong (origin + browsing context, fails _closed_)               | Reserve for embedding **external** pages only                                                                 |
| **Web components**                  | Plugin ships JS calling `customElements.define`; host mounts `<el>`                            | Shadow DOM is **not** a security boundary; JS runs in host world | Over-engineered; framework-runtime duplication, no Svelte context across boundary, theming only via `--var`   |

### The four candidate mechanisms, weighed for _this_ model

- **(a) Declarative descriptor → whitelisted Svelte registry (SDUI).** Plugin returns `{ type, props, children }` nodes; host looks each `type` up in a registry of components it already ships and renders. **Safe by construction** (no code/markup crosses), fully themed/i18n'd/SSR-friendly, lightest runtime, and a _direct extension of the JSON blob plugins already push_. **← Recommended.**
- **(b) `{@html}` + DOMPurify.** Trust removes the security _motivation_, but you still run plugin markup in the host origin with **zero integration upside** — no tokens, no i18n, no reactivity — while carrying a sanitizer + XSS surface for nothing over (a). **Worst fit.**
- **(c) Sandboxed iframe.** The untrusted-content answer; all cost (separate document, manual sizing via `postMessage`, broken theming/i18n, perf) and no benefit for a trusted author. **Over-engineered;** keep only for arbitrary external embeds.
- **(d) Web component / JS bundle.** Buys framework-agnostic authoring + independent deploy — neither needed (one author, local build) — at the cost of interop friction, runtime duplication, lost Svelte context, and `--var`-only theming. **Over-engineered.**

The known SDUI tax (versioning + a fixed vocabulary) is **mild here**: one author controls both registry and plugins, so adding a component and using it ship in the same change. A `schemaVersion` field plus a fallback "unknown component" tile cover the rest.

---

## 4. What it would take (implementation sketch)

Additive across three layers. Nothing below changes the trust model or spawn isolation.

### 4.1 The descriptor contract (server: `src/plugins/`)

Add a UI-descriptor type and a new `ctx` capability beside `publishStatus`:

```ts
// src/plugins/types.ts  (new)
export interface PluginUINode {
  type: string;                       // must match a registry key, else → fallback tile
  props?: Record<string, unknown>;    // JSON-serializable only
  children?: PluginUINode[];
}
export interface PluginUIView {
  schemaVersion: 1;
  slot: "settings-panel" | "session-sidebar" | "dashboard-card"; // contribution point
  title?: string;                     // i18n: key OR {key,params}, never raw prose
  root: PluginUINode;
}
// ctx addition:
ctx.publishUI(view: PluginUIView | null): void;   // mirrors publishStatus; null clears
```

- Reuse the **exact transport** `publishStatus` uses: emit a `plugin:ui` event over `/events`; store the latest view in `PluginInfo` alongside `status`. Bootstrap surfaces it via `GET /api/plugins`. (`loader.ts:305`, `server.ts:4410`.)
- **Validate at the seam** (`loader.ts`): cap node count / tree depth, reject non-serializable props, drop unknown `slot`s. Validation is a safety budget against a _buggy_ plugin, not a malicious one.
- Bump `PLUGIN_API_VERSION`? No — additive `ctx` method, existing plugins unaffected; gate on `typeof ctx.publishUI === "function"` in plugin code.

### 4.2 The renderer + registry (UI: `ui/src/lib/plugin-ui/`)

A **dumb recursive renderer** + a **whitelist**:

```ts
// ui/src/lib/plugin-ui/registry.ts
export const PLUGIN_UI_REGISTRY = {
  stack: PuiStack, // layout: vertical/horizontal, gap via --space-*
  text: PuiText, // --fs-* sized, i18n-aware
  badge: PuiBadge, // reuse .badge recipe; tone ∈ status tokens
  meter: PuiMeter, // labelled progress bar (→ claude-swap quota bars)
  table: PuiTable, // columns + rows (→ assignment table)
  "key-value": PuiKeyValue,
  callout: PuiCallout, // info/warn/error tones
} as const;
```

```svelte
<!-- ui/src/lib/plugin-ui/PluginUIRenderer.svelte -->
{#if node.type in PLUGIN_UI_REGISTRY}
  {@const Comp = PLUGIN_UI_REGISTRY[node.type]}
  <Comp {...sanitizeProps(node.props)}>
    {#each node.children ?? [] as child}
      <PluginUIRenderer node={child} /> <!-- recurse; depth already capped server-side -->
    {/each}
  </Comp>
{:else}
  <UnknownNodeTile type={node.type} /> <!-- graceful forward-compat fallback -->
{/if}
```

Every registry component is authored **once**, in-repo, against the design system → tokens/i18n/glossary/a11y satisfied for free. No `{@html}`, no plugin code execution. `SettingsPluginsPanel.svelte` renders `view` when present, else the JSON dump (back-compat).

### 4.3 Placement (contribution points)

Start with **one slot** (`settings-panel`) — claude-swap's panel renders inside Settings → Plugins, zero new navigation. The `slot` enum is the VS-Code-style contribution layer: later add `session-sidebar` / `dashboard-card` by host-wiring a `<PluginUIRenderer>` at those regions, no schema change.

### 4.4 Phasing

1. **Phase 0 (spike / go-no-go):** `publishUI` + renderer + the seeded registry (`stack`/`text`/`badge`/`meter`/`table`/`key-value`/`callout`), wired only into the Plugins panel; port claude-swap's status blob to a `PluginUIView`. Validates the contract end-to-end against a real plugin before any further investment.
2. **Phase 1:** harden validation (depth/size caps, prop sanitization, malformed-view handling), i18n the `title`/`text` plumbing, feature-announcement entry, `/design-system` recipes for the new `Pui*` primitives.
3. **Phase 2:** additional slots; interactivity — **landed via #1209** as the `action-button` node (`POST /api/plugins/<thisPluginId>/<path>` with a plugin-authored body, reusing `ctx.route`), scoped to the plugin's own namespace. The jump from _display_ to _interaction_ was the anticipated complexity cliff; #1209 took it on with a constrained, POST-only, namespace-scoped primitive rather than general forms. (The "display-only" framing in §5 below is historical — superseded.)

### 4.5 Cost / surface

Net-new: ~1 server type + 1 `ctx` method + transport reuse; ~1 renderer + ~6 small Svelte components + 1 registry; ~1 panel edit. No new runtime dependency (DOMPurify already present and **not even needed** for the descriptor path). Gates touched: feature-announcements, i18n (EN+DE for any chrome the primitives author), `/design-system` recipes.

**Component vocabulary (current):** display nodes `stack`, `text`, `badge`, `meter`, `table`, `key-value`, `callout` (Phase 0) + `gauge`, `sparkline`, `time-series`, `bar-chart`, `timeline` (#1189); and the first **interactive** node, `action-button` (#1209) — POSTs a plugin-authored body to the plugin's own route, with an optional `confirm` gate.

---

## 5. Risks & settled decisions

- **Display vs interaction.** _v1 was display-only_ (this was the spike's deliberate scope). **Superseded by #1209:** interactivity now exists as the single, constrained `action-button` node — POST-only, scoped to the plugin's own route namespace, behind operator auth, with an optional confirm gate. General forms/optimistic-state remain out of scope; the cliff was crossed narrowly, not wholesale.
- **Trust boundary is real but narrow.** Plugins are trusted, so the descriptor guards against _bugs_ (runaway trees, bad props), not _attackers_. Keep the caps anyway — fail-open, never crash the panel.
- **Don't reach for `{@html}`/iframe/web-components.** They solve problems Shepherd doesn't have and route around the design-system/i18n gates. Iframe is the _only_ future-justified escape hatch, and only for arbitrary external web content.
- **Schema evolution.** `schemaVersion` + unknown-node fallback tile = forward-compatible; one author owning both ends keeps the SDUI versioning tax negligible.

**Decisions (settled with operator):**

1. **Display-only v1 — superseded by #1209.** v1 deliberately shipped no interactivity (the auth/CSRF + optimistic-state complexity cliff, and claude-swap needed none then). #1209 reopened this once a concrete consumer (a per-account "Make primary" picker) needed it, adding the constrained `action-button` node: POST-only, scoped to the plugin's own namespace, behind the existing operator auth. The original "deferred later phase" decision is now realized.
2. **Settings → Plugins panel is the only wired slot for v1.** The descriptor still carries a `slot` field, but the host mounts only `settings-panel`; `session-sidebar` / `dashboard-card` are added later as pure host-wiring with no schema change.
3. **Registry grows on demand.** Seed with what claude-swap needs (`stack`, `text`, `badge`, `meter`, `table`, `key-value`, `callout`); add new node types when a real plugin requires one (component + first use ship together). `schemaVersion` + unknown-node fallback tile keep it forward-compatible — no fixed/frozen vocabulary.
4. **claude-swap is the Phase-0 consumer.** The go/no-go spike ports claude-swap's existing status blob to a `PluginUIView` — real, rich, typed data that exercises every seeded component — rather than a synthetic in-repo demo.

---

### Sources

Prior art: VS Code [webviews](https://code.visualstudio.com/api/extension-guides/webview) · [contribution points](https://code.visualstudio.com/api/references/contribution-points) · [when-clause contexts](https://code.visualstudio.com/api/references/when-clause-contexts); Grafana [plugin anatomy](https://grafana.com/developers/plugin-tools/key-concepts/anatomy-of-a-plugin) · [frontend sandbox](https://grafana.com/docs/grafana/latest/administration/plugin-management/plugin-frontend-sandbox/); Backstage [frontend plugins](https://backstage.io/docs/frontend-system/architecture/plugins/) · [threat model](https://backstage.io/docs/overview/threat-model/); SDUI [Airbnb Ghost Platform](https://medium.com/airbnb-engineering/a-deep-dive-into-airbnbs-server-driven-ui-system-842244c5f5) · [implementing SDUI](https://neciudan.dev/implementing-server-driven-ui); [web.dev sandboxed iframes](https://web.dev/articles/sandboxed-iframes) · [MDN postMessage](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage); [Svelte custom elements](https://svelte.dev/docs/svelte/custom-elements) · [MDN shadow DOM](https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_shadow_DOM).

In-repo: `src/plugins/types.ts`, `src/plugins/loader.ts`, `src/server.ts:4404`, `docs/plugins.md`; `ui/src/lib/components/settings/SettingsPluginsPanel.svelte`, `ui/src/lib/store.svelte.ts:161`, `ui/src/lib/types.ts:1131`, `ui/src/lib/api.ts:1031`, `ui/src/app.css`, `ui/src/lib/highlight.ts`. Sibling plugin: `shepherd-claude-swap/index.ts`, `shepherd-claude-swap/src/status.ts`.

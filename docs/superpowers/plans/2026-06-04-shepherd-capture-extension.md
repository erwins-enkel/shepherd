# Shepherd Capture (Chrome extension, Phase 1 MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a loadable MV3 Chromium extension that captures the active tab's screenshot + metadata and files it as a live Shepherd session via the task API (spawn-now), with EN+DE i18n parity.

**Architecture:** New root package `extension/` (own deps, `bun`), built with Vite 8 + `@crxjs/vite-plugin` + Svelte 5 + Tailwind 4.1 + Paraglide. A background service worker owns all `chrome.*` orchestration and extension-origin network calls; the popup/options are thin Svelte views. Pure units (`transport`, `context-block`, `capture` helpers, `config`) are `fetch`/`chrome`-injected and unit-tested with vitest; `chrome.*` orchestration is verified via a documented manual load-unpacked checklist.

**Tech Stack:** TypeScript, Svelte 5, Tailwind 4.1, Vite 8, `@crxjs/vite-plugin@2.4.0`, `@inlang/paraglide-js`, `@types/chrome`, vitest.

**Spec:** `docs/superpowers/specs/2026-06-04-shepherd-capture-extension-design.md`

---

## File Structure

```
extension/
  package.json                 # own deps + scripts (build/lint/check/test/check:i18n)
  tsconfig.json
  vite.config.ts               # crx({manifest}) + svelte + tailwind + paraglide
  svelte.config.js             # vitePreprocess (TS in components)
  manifest.config.ts           # defineManifest(...) — MV3
  eslint.config.js             # extension-scoped, webextension globals
  .gitignore                   # dist/, src/lib/paraglide/
  README.md                    # setup + manual load checklist
  project.inlang/
    settings.json
    plugins/                   # copied from ui/project.inlang/plugins/
  messages/
    en.json
    de.json
  scripts/
    check-i18n.mjs             # ported parity gate
  index.html  (popup)          # action default_popup
  options.html                 # options_page
  src/
    app.css                    # @import "tailwindcss"
    lib/
      types.ts                 # shared types + message envelopes
      context-block.ts         # pure: PageMetadata -> markdown
      transport.ts             # pure (fetch-injected): uploads + sessions
      capture.ts               # dataUrlToBlob + buildMetadata (pure)
      config.ts                # chrome.storage.local wrapper
    background.ts              # service worker (chrome.* orchestration)
    popup/
      main.ts                  # mount Popup.svelte
      Popup.svelte
    options/
      main.ts                  # mount Options.svelte
      Options.svelte
  test/
    context-block.test.ts
    transport.test.ts
    capture.test.ts
    config.test.ts
```

`CLAUDE.md` package table gains an `extension/` row (Task 11).

---

### Task 1: Package scaffold + build toolchain

**Files:**
- Create: `extension/package.json`
- Create: `extension/tsconfig.json`
- Create: `extension/.gitignore`
- Create: `extension/manifest.config.ts`
- Create: `extension/vite.config.ts`
- Create: `extension/svelte.config.js`
- Create: `extension/eslint.config.js`
- Create: `extension/src/app.css`
- Create: `extension/index.html`
- Create: `extension/options.html`
- Create: `extension/src/popup/main.ts`
- Create: `extension/src/popup/Popup.svelte` (stub)
- Create: `extension/src/options/main.ts`
- Create: `extension/src/options/Options.svelte` (stub)
- Create: `extension/src/background.ts` (stub)

- [ ] **Step 1: Create `extension/package.json`**

```json
{
  "name": "extension",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "paraglide-js compile --project ./project.inlang --outdir ./src/lib/paraglide && vite build",
    "preview": "vite preview",
    "paraglide": "paraglide-js compile --project ./project.inlang --outdir ./src/lib/paraglide",
    "prepare": "paraglide-js compile --project ./project.inlang --outdir ./src/lib/paraglide || echo ''",
    "check": "paraglide-js compile --project ./project.inlang --outdir ./src/lib/paraglide && svelte-check --tsconfig ./tsconfig.json",
    "check:i18n": "node scripts/check-i18n.mjs",
    "lint": "eslint --no-error-on-unmatched-pattern src",
    "test": "vitest run"
  },
  "devDependencies": {
    "@crxjs/vite-plugin": "^2.4.0",
    "@inlang/paraglide-js": "^2.18.1",
    "@sveltejs/vite-plugin-svelte": "^7.0.0",
    "@tailwindcss/vite": "^4.3.0",
    "@tsconfig/svelte": "^5.0.4",
    "@types/chrome": "^0.0.287",
    "eslint": "^10.4.1",
    "eslint-plugin-svelte": "^3.19.0",
    "globals": "^17.6.0",
    "svelte": "^5.55.2",
    "svelte-check": "^4.4.6",
    "typescript": "^6.0.2",
    "typescript-eslint": "^8.60.0",
    "vite": "^8.0.7",
    "vitest": "^4.1.7"
  }
}
```

- [ ] **Step 2: Create `extension/.gitignore`**

```
node_modules/
dist/
src/lib/paraglide/
```

- [ ] **Step 3: Create `extension/tsconfig.json`**

```json
{
  "extends": "@tsconfig/svelte/tsconfig.json",
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "allowJs": true,
    "checkJs": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "strict": true,
    "types": ["chrome", "vite/client"],
    "verbatimModuleSyntax": true
  },
  "include": ["src/**/*.ts", "src/**/*.svelte", "manifest.config.ts", "vite.config.ts"],
  "exclude": ["src/lib/paraglide", "node_modules", "dist"]
}
```

- [ ] **Step 4: Create `extension/manifest.config.ts`**

```ts
import { defineManifest } from "@crxjs/vite-plugin";

// Phase 1 MVP manifest. Title is the untranslated product name (see spec i18n
// section). host_permissions defaults to the local Shepherd core; users widen
// it to a ts.net URL via the browser's optional-host prompt in a later phase —
// for MVP the localhost default plus <all_urls> activeTab capture suffices.
export default defineManifest({
  manifest_version: 3,
  name: "Shepherd Capture",
  version: "0.0.1",
  description: "Capture the current tab into a Shepherd task.",
  action: {
    default_title: "Shepherd Capture",
    default_popup: "index.html",
  },
  options_page: "options.html",
  background: {
    service_worker: "src/background.ts",
    type: "module",
  },
  permissions: ["activeTab", "scripting", "tabs", "storage"],
  host_permissions: ["http://localhost:7330/*"],
});
```

- [ ] **Step 5: Create `extension/vite.config.ts`**

```ts
import { crx } from "@crxjs/vite-plugin";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [svelte(), tailwindcss(), crx({ manifest })],
  // crxjs needs a stable port for HMR in MV3
  server: { port: 5180, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
});
```

- [ ] **Step 5b: Create `extension/svelte.config.js`** (vitePreprocess enables `<script lang="ts">` for both `vite-plugin-svelte` and `svelte-check`)

```js
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default {
  preprocess: vitePreprocess(),
};
```

- [ ] **Step 6: Create `extension/eslint.config.js`**

```js
import js from "@eslint/js";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import ts from "typescript-eslint";

export default [
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs.recommended,
  ...svelte.configs.prettier,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.webextensions },
    },
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    files: ["**/*.svelte", "**/*.svelte.ts"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.webextensions },
      parserOptions: { parser: ts.parser, extraFileExtensions: [".svelte"] },
    },
  },
  { ignores: ["dist/", "src/lib/paraglide/", "scripts/"] },
];
```

- [ ] **Step 7: Create `extension/src/app.css`**

```css
@import "tailwindcss";
```

- [ ] **Step 8: Create `extension/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Shepherd Capture</title>
  </head>
  <body class="w-[380px]">
    <div id="app"></div>
    <script type="module" src="/src/popup/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 9: Create `extension/options.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Shepherd Capture — Options</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/options/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 10: Create `extension/src/popup/main.ts`**

```ts
import { mount } from "svelte";
import "../app.css";
import Popup from "./Popup.svelte";

mount(Popup, { target: document.getElementById("app")! });
```

- [ ] **Step 11: Create `extension/src/options/main.ts`**

```ts
import { mount } from "svelte";
import "../app.css";
import Options from "./Options.svelte";

mount(Options, { target: document.getElementById("app")! });
```

- [ ] **Step 12: Create stub `extension/src/popup/Popup.svelte`**

```svelte
<main class="p-3 text-sm">Shepherd Capture</main>
```

- [ ] **Step 13: Create stub `extension/src/options/Options.svelte`**

```svelte
<main class="p-3 text-sm">Shepherd Capture options</main>
```

- [ ] **Step 14: Create stub `extension/src/background.ts`**

```ts
// Service worker entry. Orchestration is filled in Task 8.
chrome.runtime.onInstalled.addListener(() => {
  // no-op for now
});
```

- [ ] **Step 15: Copy Paraglide plugin vendor files + create project settings + base messages**

Run:
```bash
mkdir -p extension/project.inlang/plugins extension/messages
cp ui/project.inlang/plugins/plugin-message-format@4.4.0.js ui/project.inlang/plugins/plugin-m-function-matcher@2.2.6.js extension/project.inlang/plugins/
```

Create `extension/project.inlang/settings.json`:
```json
{
  "$schema": "https://inlang.com/schema/project-settings",
  "baseLocale": "en",
  "locales": ["en", "de"],
  "modules": [
    "./project.inlang/plugins/plugin-message-format@4.4.0.js",
    "./project.inlang/plugins/plugin-m-function-matcher@2.2.6.js"
  ],
  "plugin.inlang.messageFormat": {
    "pathPattern": "./messages/{locale}.json"
  }
}
```

Create `extension/messages/en.json` (a non-empty placeholder so the first build's paraglide compile succeeds; real keys land in Task 7):
```json
{
  "$schema": "https://inlang.com/schema/inlang-message-format",
  "popup_title": "Shepherd Capture"
}
```

Create `extension/messages/de.json`:
```json
{
  "$schema": "https://inlang.com/schema/inlang-message-format",
  "popup_title": "Shepherd Capture"
}
```

- [ ] **Step 16: Wire Paraglide into the Vite build**

Edit `extension/vite.config.ts` — add the paraglide plugin import and entry so `m.*` compiles. Replace the file with:
```ts
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import { crx } from "@crxjs/vite-plugin";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./src/lib/paraglide",
      // popup/options pages have localStorage; fall back to browser lang.
      strategy: ["localStorage", "preferredLanguage", "baseLocale"],
    }),
    svelte(),
    tailwindcss(),
    crx({ manifest }),
  ],
  server: { port: 5180, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
});
```

- [ ] **Step 17: Install deps and verify the build**

Run:
```bash
cd extension && bun install && bun run build
```
Expected: install succeeds; build writes `extension/dist/manifest.json` + `dist/index.html` + `dist/options.html` + the service-worker bundle, exit 0.

Verify:
```bash
test -f extension/dist/manifest.json && echo "MANIFEST OK"
```
Expected: `MANIFEST OK`.

- [ ] **Step 18: Commit**

```bash
git add extension/ ':!extension/node_modules'
git commit -m "feat(extension): scaffold MV3 build toolchain (crxjs+svelte+tailwind+paraglide)"
```

---

### Task 2: i18n parity gate

**Files:**
- Create: `extension/scripts/check-i18n.mjs`

- [ ] **Step 1: Create `extension/scripts/check-i18n.mjs`** (ported from `ui/scripts/check-i18n.mjs`, path points at `extension/messages`)

```js
#!/usr/bin/env node
// i18n gate for the extension: every locale catalog under extension/messages/
// must carry the SAME set of keys, none empty. Paraglide silently falls back to
// the base locale for a missing key, so this turns an incomplete translation
// into a hard failure. Mirrors ui/scripts/check-i18n.mjs.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MESSAGES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "messages");
const META_KEYS = new Set(["$schema"]);

const files = readdirSync(MESSAGES_DIR).filter((f) => f.endsWith(".json"));
if (files.length < 2) {
  console.error(`i18n: expected ≥2 locale catalogs in ${MESSAGES_DIR}, found ${files.length}`);
  process.exit(1);
}

/** @type {Map<string, Set<string>>} */
const keysByLocale = new Map();
/** @type {Map<string, string[]>} */
const emptyByLocale = new Map();

for (const file of files) {
  const locale = file.replace(/\.json$/, "");
  const data = JSON.parse(readFileSync(join(MESSAGES_DIR, file), "utf8"));
  const keys = new Set();
  const empty = [];
  for (const [k, v] of Object.entries(data)) {
    if (META_KEYS.has(k)) continue;
    keys.add(k);
    if (typeof v === "string" && v.trim() === "") empty.push(k);
  }
  keysByLocale.set(locale, keys);
  emptyByLocale.set(locale, empty);
}

const locales = [...keysByLocale.keys()];
const union = new Set(locales.flatMap((l) => [...keysByLocale.get(l)]));

const problems = [];
for (const locale of locales) {
  const has = keysByLocale.get(locale);
  const missing = [...union].filter((k) => !has.has(k)).sort();
  if (missing.length)
    problems.push(`  ${locale}.json missing ${missing.length}: ${missing.join(", ")}`);
  const empty = emptyByLocale.get(locale);
  if (empty.length) problems.push(`  ${locale}.json empty values: ${empty.join(", ")}`);
}

if (problems.length) {
  console.error(
    `i18n: catalog parity check failed (${locales.join(", ")} must share identical, non-empty keys):\n${problems.join("\n")}`,
  );
  process.exit(1);
}

console.log(`✓ i18n: ${locales.length} locales in parity (${union.size} keys each)`);
```

- [ ] **Step 2: Run the gate against the placeholder catalogs**

Run:
```bash
cd extension && bun run check:i18n
```
Expected: `✓ i18n: 2 locales in parity (1 keys each)`.

- [ ] **Step 3: Verify it fails on a missing key (sanity)**

Run:
```bash
cd extension && node -e "import('node:fs').then(fs=>fs.writeFileSync('messages/de.json',JSON.stringify({'\$schema':'https://inlang.com/schema/inlang-message-format'},null,2)))" && (bun run check:i18n; echo "exit=$?")
```
Expected: prints a parity failure naming `de.json missing 1: popup_title` and `exit=1`.

Restore parity:
```bash
cd extension && git checkout messages/de.json
```

- [ ] **Step 4: Commit**

```bash
git add extension/scripts/check-i18n.mjs
git commit -m "feat(extension): port i18n catalog-parity gate"
```

---

### Task 3: Shared types + context-block formatter (pure, TDD)

**Files:**
- Create: `extension/src/lib/types.ts`
- Create: `extension/src/lib/context-block.ts`
- Test: `extension/test/context-block.test.ts`

- [ ] **Step 1: Create `extension/src/lib/types.ts`**

```ts
/** Auto-captured page metadata (Phase 1 signals). */
export interface PageMetadata {
  url: string;
  title: string;
  viewportW: number;
  viewportH: number;
  devicePixelRatio: number;
  userAgent: string;
  locale: string;
  /** ISO-8601 capture timestamp. */
  timestamp: string;
}

/** Result of capturing the active tab. */
export interface CaptureResult {
  /** PNG data URL from chrome.tabs.captureVisibleTab. */
  screenshotDataUrl: string;
  metadata: PageMetadata;
}

/** Persisted extension config (chrome.storage.local; never synced). */
export interface CaptureConfig {
  baseUrl: string;
  token: string;
  repoPath: string;
  baseBranch: string;
  model: "opus" | "sonnet" | "haiku" | "default";
}

/** What the popup sends the background worker to spawn a session. */
export interface SpawnPayload {
  prompt: string;
  metadata: PageMetadata;
  screenshotDataUrl: string;
}

/** Typed transport failure the popup maps to a localized message. */
export type TransportErrorKind =
  | "origin"
  | "auth"
  | "confinement"
  | "unreachable"
  | "unknown";

export class TransportError extends Error {
  kind: TransportErrorKind;
  status: number | null;
  constructor(kind: TransportErrorKind, status: number | null, message: string) {
    super(message);
    this.name = "TransportError";
    this.kind = kind;
    this.status = status;
  }
}

/** Discriminated message envelope: popup/options <-> background worker. */
export type WorkerRequest =
  | { type: "capture" }
  | { type: "spawn"; payload: SpawnPayload };

export type WorkerResponse =
  | { ok: true; type: "capture"; result: CaptureResult }
  | { ok: true; type: "spawn"; desig: string }
  | { ok: false; errorKind: TransportErrorKind | "capture"; message: string };
```

- [ ] **Step 2: Write the failing test `extension/test/context-block.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { formatContextBlock } from "../src/lib/context-block";
import type { PageMetadata } from "../src/lib/types";

const META: PageMetadata = {
  url: "https://example.com/app?q=1",
  title: "Example App",
  viewportW: 1280,
  viewportH: 720,
  devicePixelRatio: 2,
  userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
  locale: "en-US",
  timestamp: "2026-06-04T10:00:00.000Z",
};

describe("formatContextBlock", () => {
  it("renders a fenced block with all metadata fields", () => {
    const out = formatContextBlock(META);
    expect(out.startsWith("```text")).toBe(true);
    expect(out.trimEnd().endsWith("```")).toBe(true);
    expect(out).toContain("Shepherd Capture — browser context");
    expect(out).toContain("URL: https://example.com/app?q=1");
    expect(out).toContain("Title: Example App");
    expect(out).toContain("Viewport: 1280×720 @2x");
    expect(out).toContain("User agent: Mozilla/5.0 (X11; Linux x86_64)");
    expect(out).toContain("Locale: en-US");
    expect(out).toContain("Captured: 2026-06-04T10:00:00.000Z");
  });
});
```

- [ ] **Step 3: Run it to verify failure**

Run:
```bash
cd extension && bun run test -- context-block
```
Expected: FAIL — cannot find module `../src/lib/context-block`.

- [ ] **Step 4: Create `extension/src/lib/context-block.ts`**

```ts
import type { PageMetadata } from "./types";

/**
 * Format captured page metadata as a fenced markdown block to append to the
 * task prompt. Fenced as `text` so the agent reads it as data, not instruction.
 * Optional sections (console/network, a11y) are appended by later phases; this
 * Phase-1 version emits metadata only.
 */
export function formatContextBlock(meta: PageMetadata): string {
  const lines = [
    "Shepherd Capture — browser context",
    `URL: ${meta.url}`,
    `Title: ${meta.title}`,
    `Viewport: ${meta.viewportW}×${meta.viewportH} @${meta.devicePixelRatio}x`,
    `User agent: ${meta.userAgent}`,
    `Locale: ${meta.locale}`,
    `Captured: ${meta.timestamp}`,
  ];
  return "```text\n" + lines.join("\n") + "\n```";
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
cd extension && bun run test -- context-block
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add extension/src/lib/types.ts extension/src/lib/context-block.ts extension/test/context-block.test.ts
git commit -m "feat(extension): shared types + context-block formatter"
```

---

### Task 4: Transport (pure, fetch-injected, TDD)

**Files:**
- Create: `extension/src/lib/transport.ts`
- Test: `extension/test/transport.test.ts`

- [ ] **Step 1: Write the failing test `extension/test/transport.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import { spawnNow } from "../src/lib/transport";
import { TransportError, type CaptureConfig, type PageMetadata } from "../src/lib/types";

const CONFIG: CaptureConfig = {
  baseUrl: "http://localhost:7330",
  token: "secret",
  repoPath: "~/Work/foo",
  baseBranch: "main",
  model: "opus",
};

const META: PageMetadata = {
  url: "https://example.com",
  title: "Example",
  viewportW: 800,
  viewportH: 600,
  devicePixelRatio: 1,
  userAgent: "UA",
  locale: "en-US",
  timestamp: "2026-06-04T10:00:00.000Z",
};

const blob = () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });

function jsonRes(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("spawnNow", () => {
  it("uploads the screenshot, then creates a session with the staged path + bearer auth", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ path: "/staging/abc.png" }, 200))
      .mockResolvedValueOnce(jsonRes({ desig: "TASK-42" }, 201));

    const desig = await spawnNow(fetchFn, CONFIG, {
      prompt: "Fix the button",
      metadata: META,
      screenshot: blob(),
    });

    expect(desig).toBe("TASK-42");
    expect(fetchFn).toHaveBeenCalledTimes(2);

    const [uploadUrl, uploadInit] = fetchFn.mock.calls[0];
    expect(uploadUrl).toBe("http://localhost:7330/api/uploads");
    expect(uploadInit.method).toBe("POST");
    expect(uploadInit.headers.Authorization).toBe("Bearer secret");
    expect(uploadInit.body).toBeInstanceOf(FormData);

    const [sessUrl, sessInit] = fetchFn.mock.calls[1];
    expect(sessUrl).toBe("http://localhost:7330/api/sessions");
    expect(sessInit.headers["Content-Type"]).toBe("application/json");
    const sent = JSON.parse(sessInit.body);
    expect(sent.repoPath).toBe("~/Work/foo");
    expect(sent.baseBranch).toBe("main");
    expect(sent.model).toBe("opus");
    expect(sent.images).toEqual(["/staging/abc.png"]);
    expect(sent.prompt).toContain("Fix the button");
    expect(sent.prompt).toContain("```text");
    expect(sent.prompt).toContain("URL: https://example.com");
  });

  it("omits Authorization when no token and omits model when 'default'", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ path: "/staging/x.png" }, 200))
      .mockResolvedValueOnce(jsonRes({ desig: "TASK-1" }, 201));

    await spawnNow(fetchFn, { ...CONFIG, token: "", model: "default" }, {
      prompt: "hi",
      metadata: META,
      screenshot: blob(),
    });

    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(JSON.parse(fetchFn.mock.calls[1][1].body).model).toBeUndefined();
  });

  it.each([
    [403, "origin"],
    [401, "auth"],
    [400, "confinement"],
    [500, "unknown"],
  ])("maps upload status %i to TransportError kind %s", async (status, kind) => {
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonRes({ error: "no" }, status));
    await expect(
      spawnNow(fetchFn, CONFIG, { prompt: "p", metadata: META, screenshot: blob() }),
    ).rejects.toMatchObject({ kind });
    expect(fetchFn).toHaveBeenCalledTimes(1); // never reaches session create
  });

  it("maps a network throw to 'unreachable'", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(
      spawnNow(fetchFn, CONFIG, { prompt: "p", metadata: META, screenshot: blob() }),
    ).rejects.toMatchObject({ kind: "unreachable" });
  });

  it("maps a session-create error status too (after a successful upload)", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ path: "/staging/x.png" }, 200))
      .mockResolvedValueOnce(jsonRes({ error: "bad repo" }, 400));
    await expect(
      spawnNow(fetchFn, CONFIG, { prompt: "p", metadata: META, screenshot: blob() }),
    ).rejects.toBeInstanceOf(TransportError);
  });
});
```

- [ ] **Step 2: Run it to verify failure**

Run:
```bash
cd extension && bun run test -- transport
```
Expected: FAIL — cannot find module `../src/lib/transport`.

- [ ] **Step 3: Create `extension/src/lib/transport.ts`**

```ts
import { formatContextBlock } from "./context-block";
import {
  TransportError,
  type CaptureConfig,
  type PageMetadata,
  type TransportErrorKind,
} from "./types";

export type FetchFn = (input: string, init: any) => Promise<Response>;

interface SpawnInput {
  prompt: string;
  metadata: PageMetadata;
  screenshot: Blob;
}

function kindForStatus(status: number): TransportErrorKind {
  if (status === 403) return "origin";
  if (status === 401) return "auth";
  if (status === 400) return "confinement";
  return "unknown";
}

function authHeaders(token: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function ensureOk(res: Response): Promise<void> {
  if (res.ok) return;
  let detail = "";
  try {
    const body = (await res.json()) as { error?: string };
    detail = body.error ?? "";
  } catch {
    /* ignore non-JSON bodies */
  }
  throw new TransportError(kindForStatus(res.status), res.status, detail || `HTTP ${res.status}`);
}

/** POST the PNG to /api/uploads; return the confined staging path. */
async function uploadScreenshot(
  fetchFn: FetchFn,
  config: CaptureConfig,
  screenshot: Blob,
): Promise<string> {
  const form = new FormData();
  form.append("file", screenshot, "capture.png");
  let res: Response;
  try {
    res = await fetchFn(`${config.baseUrl}/api/uploads`, {
      method: "POST",
      headers: authHeaders(config.token),
      body: form,
    });
  } catch {
    throw new TransportError("unreachable", null, "could not reach Shepherd");
  }
  await ensureOk(res);
  const body = (await res.json()) as { path?: string };
  if (!body.path) throw new TransportError("unknown", res.status, "upload returned no path");
  return body.path;
}

/** POST /api/sessions with the staged image + composed prompt; return desig. */
async function createSession(
  fetchFn: FetchFn,
  config: CaptureConfig,
  prompt: string,
  imagePath: string,
): Promise<string> {
  const payload: Record<string, unknown> = {
    repoPath: config.repoPath,
    baseBranch: config.baseBranch,
    prompt,
    images: [imagePath],
  };
  if (config.model !== "default") payload.model = config.model;

  let res: Response;
  try {
    res = await fetchFn(`${config.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(config.token) },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new TransportError("unreachable", null, "could not reach Shepherd");
  }
  await ensureOk(res);
  const body = (await res.json()) as { desig?: string };
  if (!body.desig) throw new TransportError("unknown", res.status, "session returned no desig");
  return body.desig;
}

/**
 * Spawn-now: stage the screenshot, then create a session whose prompt is the
 * user text plus the fenced metadata context block. Returns the desig.
 */
export async function spawnNow(
  fetchFn: FetchFn,
  config: CaptureConfig,
  input: SpawnInput,
): Promise<string> {
  const path = await uploadScreenshot(fetchFn, config, input.screenshot);
  const prompt = `${input.prompt}\n\n${formatContextBlock(input.metadata)}`;
  return createSession(fetchFn, config, prompt, path);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd extension && bun run test -- transport
```
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add extension/src/lib/transport.ts extension/test/transport.test.ts
git commit -m "feat(extension): fetch-injected transport (uploads -> sessions) with typed errors"
```

---

### Task 5: Config store (chrome.storage.local, TDD with stub)

**Files:**
- Create: `extension/src/lib/config.ts`
- Test: `extension/test/config.test.ts`

- [ ] **Step 1: Write the failing test `extension/test/config.test.ts`**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, isConfigured, loadConfig, saveConfig } from "../src/lib/config";

// Minimal in-memory chrome.storage.local stub.
function installChromeStub(initial: Record<string, unknown> = {}) {
  let store = { ...initial };
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: vi.fn(async (keys: string[] | string) => {
          const ks = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const k of ks) if (k in store) out[k] = store[k];
          return out;
        }),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          store = { ...store, ...obj };
        }),
      },
    },
  };
  return () => store;
}

describe("config", () => {
  beforeEach(() => installChromeStub());

  it("returns defaults merged when storage is empty", async () => {
    const cfg = await loadConfig();
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });

  it("round-trips a saved config", async () => {
    await saveConfig({
      baseUrl: "http://localhost:7330",
      token: "t",
      repoPath: "~/Work/x",
      baseBranch: "main",
      model: "sonnet",
    });
    const cfg = await loadConfig();
    expect(cfg.repoPath).toBe("~/Work/x");
    expect(cfg.model).toBe("sonnet");
  });

  it("isConfigured is false until baseUrl + repoPath are set", async () => {
    expect(isConfigured(DEFAULT_CONFIG)).toBe(false);
    expect(
      isConfigured({ ...DEFAULT_CONFIG, baseUrl: "http://localhost:7330", repoPath: "~/Work/x" }),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify failure**

Run:
```bash
cd extension && bun run test -- config
```
Expected: FAIL — cannot find module `../src/lib/config`.

- [ ] **Step 3: Create `extension/src/lib/config.ts`**

```ts
import type { CaptureConfig } from "./types";

const KEY = "captureConfig";

export const DEFAULT_CONFIG: CaptureConfig = {
  baseUrl: "http://localhost:7330",
  token: "",
  repoPath: "",
  baseBranch: "main",
  model: "default",
};

/** Load config from chrome.storage.local, merged over defaults. */
export async function loadConfig(): Promise<CaptureConfig> {
  const got = await chrome.storage.local.get(KEY);
  return { ...DEFAULT_CONFIG, ...((got[KEY] as Partial<CaptureConfig>) ?? {}) };
}

/** Persist config (local only — never synced; holds the token). */
export async function saveConfig(config: CaptureConfig): Promise<void> {
  await chrome.storage.local.set({ [KEY]: config });
}

/** True once the minimum required fields for a spawn are present. */
export function isConfigured(config: CaptureConfig): boolean {
  return config.baseUrl.trim() !== "" && config.repoPath.trim() !== "";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd extension && bun run test -- config
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/src/lib/config.ts extension/test/config.test.ts
git commit -m "feat(extension): chrome.storage.local config store"
```

---

### Task 6: Capture helpers (pure parts, TDD)

**Files:**
- Create: `extension/src/lib/capture.ts`
- Test: `extension/test/capture.test.ts`

- [ ] **Step 1: Write the failing test `extension/test/capture.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { buildMetadata, dataUrlToBlob, type PageInfo } from "../src/lib/capture";

const PAGE_INFO: PageInfo = {
  viewportW: 1024,
  viewportH: 768,
  devicePixelRatio: 1.5,
  userAgent: "UA-string",
  locale: "de-DE",
};

describe("dataUrlToBlob", () => {
  it("decodes a PNG data URL into a Blob of the right type", async () => {
    // 1x1 transparent PNG
    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const blob = dataUrlToBlob(dataUrl);
    expect(blob.type).toBe("image/png");
    expect(blob.size).toBeGreaterThan(0);
  });
});

describe("buildMetadata", () => {
  it("merges tab fields + page info + timestamp into PageMetadata", () => {
    const meta = buildMetadata(
      { url: "https://x.test/p", title: "X" },
      PAGE_INFO,
      "2026-06-04T10:00:00.000Z",
    );
    expect(meta).toEqual({
      url: "https://x.test/p",
      title: "X",
      viewportW: 1024,
      viewportH: 768,
      devicePixelRatio: 1.5,
      userAgent: "UA-string",
      locale: "de-DE",
      timestamp: "2026-06-04T10:00:00.000Z",
    });
  });

  it("falls back to empty strings when tab url/title are missing", () => {
    const meta = buildMetadata({}, PAGE_INFO, "2026-06-04T10:00:00.000Z");
    expect(meta.url).toBe("");
    expect(meta.title).toBe("");
  });
});
```

- [ ] **Step 2: Run it to verify failure**

Run:
```bash
cd extension && bun run test -- capture
```
Expected: FAIL — cannot find module `../src/lib/capture`.

- [ ] **Step 3: Create `extension/src/lib/capture.ts`**

```ts
import type { PageMetadata } from "./types";

/** In-page signals gathered by the injected function (see background.ts). */
export interface PageInfo {
  viewportW: number;
  viewportH: number;
  devicePixelRatio: number;
  userAgent: string;
  locale: string;
}

/** Decode a `data:` URL (e.g. captureVisibleTab PNG) into a Blob. */
export function dataUrlToBlob(dataUrl: string): Blob {
  const [header, b64] = dataUrl.split(",");
  const mime = header.match(/data:([^;]+)/)?.[1] ?? "application/octet-stream";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** Merge tab-level fields with injected page info into PageMetadata. */
export function buildMetadata(
  tab: { url?: string; title?: string },
  info: PageInfo,
  timestamp: string,
): PageMetadata {
  return {
    url: tab.url ?? "",
    title: tab.title ?? "",
    viewportW: info.viewportW,
    viewportH: info.viewportH,
    devicePixelRatio: info.devicePixelRatio,
    userAgent: info.userAgent,
    locale: info.locale,
    timestamp,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd extension && bun run test -- capture
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/src/lib/capture.ts extension/test/capture.test.ts
git commit -m "feat(extension): capture helpers (dataUrl->Blob, metadata merge)"
```

---

### Task 7: Message catalogs (EN + DE, all Phase-1 strings)

**Files:**
- Modify: `extension/messages/en.json`
- Modify: `extension/messages/de.json`

- [ ] **Step 1: Replace `extension/messages/en.json`**

```json
{
  "$schema": "https://inlang.com/schema/inlang-message-format",
  "popup_title": "Shepherd Capture",
  "popup_capturing": "Capturing this page…",
  "popup_prompt_label": "Task",
  "popup_prompt_placeholder": "Describe the task (what's wrong, what to do)…",
  "popup_repo_label": "Target repo",
  "popup_screenshot_alt": "Captured screenshot of the current tab",
  "popup_metadata_label": "Captured context",
  "popup_submit": "Spawn now",
  "popup_submitting": "Spawning…",
  "popup_success": "Created {desig}",
  "popup_no_config": "Configure Shepherd Capture before filing a task.",
  "popup_open_options": "Open settings",
  "popup_cant_capture": "This page can't be captured (browser or store page).",
  "popup_empty_prompt": "Enter a task description first.",
  "err_origin": "Shepherd rejected the request origin. Add this extension's ID to SHEPHERD_ALLOWED_HOSTS.",
  "err_auth": "Authentication failed. Check the Shepherd token in settings.",
  "err_confinement": "The repo path is not allowed under SHEPHERD_REPO_ROOT.",
  "err_unreachable": "Couldn't reach Shepherd at {baseUrl}.",
  "err_unknown": "Something went wrong: {message}",
  "options_title": "Shepherd Capture settings",
  "options_baseurl_label": "Shepherd base URL",
  "options_token_label": "Shepherd token (optional)",
  "options_repopath_label": "Repo path",
  "options_basebranch_label": "Base branch",
  "options_model_label": "Model",
  "options_model_default": "Claude's default",
  "options_save": "Save",
  "options_saved": "Saved"
}
```

- [ ] **Step 2: Replace `extension/messages/de.json`**

```json
{
  "$schema": "https://inlang.com/schema/inlang-message-format",
  "popup_title": "Shepherd Capture",
  "popup_capturing": "Seite wird erfasst…",
  "popup_prompt_label": "Aufgabe",
  "popup_prompt_placeholder": "Aufgabe beschreiben (was ist falsch, was ist zu tun)…",
  "popup_repo_label": "Ziel-Repository",
  "popup_screenshot_alt": "Screenshot des aktuellen Tabs",
  "popup_metadata_label": "Erfasster Kontext",
  "popup_submit": "Jetzt starten",
  "popup_submitting": "Wird gestartet…",
  "popup_success": "{desig} erstellt",
  "popup_no_config": "Richte Shepherd Capture ein, bevor du eine Aufgabe anlegst.",
  "popup_open_options": "Einstellungen öffnen",
  "popup_cant_capture": "Diese Seite kann nicht erfasst werden (Browser- oder Store-Seite).",
  "popup_empty_prompt": "Gib zuerst eine Aufgabenbeschreibung ein.",
  "err_origin": "Shepherd hat den Anfrage-Ursprung abgelehnt. Füge die ID dieser Erweiterung zu SHEPHERD_ALLOWED_HOSTS hinzu.",
  "err_auth": "Authentifizierung fehlgeschlagen. Prüfe den Shepherd-Token in den Einstellungen.",
  "err_confinement": "Der Repo-Pfad ist unter SHEPHERD_REPO_ROOT nicht erlaubt.",
  "err_unreachable": "Shepherd unter {baseUrl} nicht erreichbar.",
  "err_unknown": "Etwas ist schiefgelaufen: {message}",
  "options_title": "Shepherd-Capture-Einstellungen",
  "options_baseurl_label": "Shepherd-Basis-URL",
  "options_token_label": "Shepherd-Token (optional)",
  "options_repopath_label": "Repo-Pfad",
  "options_basebranch_label": "Basis-Branch",
  "options_model_label": "Modell",
  "options_model_default": "Claudes Standard",
  "options_save": "Speichern",
  "options_saved": "Gespeichert"
}
```

- [ ] **Step 3: Verify parity + compile**

Run:
```bash
cd extension && bun run check:i18n && bun run paraglide
```
Expected: `✓ i18n: 2 locales in parity (29 keys each)`; paraglide compiles into `src/lib/paraglide/` with no error.

- [ ] **Step 4: Commit**

```bash
git add extension/messages/en.json extension/messages/de.json
git commit -m "feat(extension): EN+DE message catalogs for popup/options/errors"
```

---

### Task 8: Background service worker (orchestration)

**Files:**
- Modify: `extension/src/background.ts`

- [ ] **Step 1: Replace `extension/src/background.ts`**

```ts
import { buildMetadata, dataUrlToBlob, type PageInfo } from "./lib/capture";
import { loadConfig } from "./lib/config";
import { spawnNow } from "./lib/transport";
import { TransportError, type CaptureResult, type WorkerRequest, type WorkerResponse } from "./lib/types";

/** Injected into the page to read viewport/UA/locale at capture time. */
function readPageInfo(): PageInfo {
  return {
    viewportW: window.innerWidth,
    viewportH: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    userAgent: navigator.userAgent,
    locale: navigator.language,
  };
}

async function captureActiveTab(): Promise<CaptureResult> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.windowId) throw new Error("no-active-tab");

  const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });

  const [{ result: info }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: readPageInfo,
  });

  const metadata = buildMetadata(
    { url: tab.url, title: tab.title },
    info as PageInfo,
    new Date().toISOString(),
  );
  return { screenshotDataUrl, metadata };
}

chrome.runtime.onMessage.addListener(
  (req: WorkerRequest, _sender, sendResponse: (r: WorkerResponse) => void) => {
    (async () => {
      try {
        if (req.type === "capture") {
          const result = await captureActiveTab();
          sendResponse({ ok: true, type: "capture", result });
          return;
        }
        if (req.type === "spawn") {
          const config = await loadConfig();
          const desig = await spawnNow(fetch, config, {
            prompt: req.payload.prompt,
            metadata: req.payload.metadata,
            screenshot: dataUrlToBlob(req.payload.screenshotDataUrl),
          });
          sendResponse({ ok: true, type: "spawn", desig });
          return;
        }
      } catch (err) {
        if (err instanceof TransportError) {
          sendResponse({ ok: false, errorKind: err.kind, message: err.message });
        } else {
          sendResponse({ ok: false, errorKind: "capture", message: String(err) });
        }
      }
    })();
    return true; // keep the message channel open for the async response
  },
);
```

- [ ] **Step 2: Typecheck**

Run:
```bash
cd extension && bun run check
```
Expected: svelte-check reports 0 errors (background.ts + lib types resolve).

- [ ] **Step 3: Commit**

```bash
git add extension/src/background.ts
git commit -m "feat(extension): background worker orchestrates capture + spawn"
```

---

### Task 9: Options page (Svelte)

**Files:**
- Modify: `extension/src/options/Options.svelte`

- [ ] **Step 1: Replace `extension/src/options/Options.svelte`**

```svelte
<script lang="ts">
  import { m } from "../lib/paraglide/messages";
  import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../lib/config";
  import type { CaptureConfig } from "../lib/types";

  let config = $state<CaptureConfig>({ ...DEFAULT_CONFIG });
  let saved = $state(false);

  loadConfig().then((c) => (config = c));

  const models: CaptureConfig["model"][] = ["default", "opus", "sonnet", "haiku"];

  async function onSave(e: Event) {
    e.preventDefault();
    await saveConfig(config);
    saved = true;
    setTimeout(() => (saved = false), 1500);
  }
</script>

<main class="mx-auto max-w-md p-6 font-sans text-sm text-gray-900">
  <h1 class="mb-4 text-lg font-semibold">{m.options_title()}</h1>
  <form class="flex flex-col gap-3" onsubmit={onSave}>
    <label class="flex flex-col gap-1">
      <span class="text-gray-600">{m.options_baseurl_label()}</span>
      <input
        class="rounded border border-gray-300 px-2 py-1"
        type="url"
        bind:value={config.baseUrl}
        placeholder="http://localhost:7330"
      />
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-gray-600">{m.options_token_label()}</span>
      <input
        class="rounded border border-gray-300 px-2 py-1"
        type="password"
        bind:value={config.token}
        autocomplete="off"
      />
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-gray-600">{m.options_repopath_label()}</span>
      <input
        class="rounded border border-gray-300 px-2 py-1"
        type="text"
        bind:value={config.repoPath}
        placeholder="~/Work/my-repo"
      />
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-gray-600">{m.options_basebranch_label()}</span>
      <input
        class="rounded border border-gray-300 px-2 py-1"
        type="text"
        bind:value={config.baseBranch}
      />
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-gray-600">{m.options_model_label()}</span>
      <select class="rounded border border-gray-300 px-2 py-1" bind:value={config.model}>
        {#each models as model (model)}
          <option value={model}>{model === "default" ? m.options_model_default() : model}</option>
        {/each}
      </select>
    </label>

    <div class="mt-2 flex items-center gap-3">
      <button class="rounded bg-gray-900 px-3 py-1.5 text-white" type="submit">
        {m.options_save()}
      </button>
      {#if saved}<span class="text-green-600">{m.options_saved()}</span>{/if}
    </div>
  </form>
</main>
```

- [ ] **Step 2: Typecheck + build**

Run:
```bash
cd extension && bun run check && bun run build
```
Expected: 0 check errors; build emits `dist/options.html`.

- [ ] **Step 3: Commit**

```bash
git add extension/src/options/Options.svelte
git commit -m "feat(extension): options page (base URL, token, repo, branch, model)"
```

---

### Task 10: Popup (Svelte) — capture, edit, spawn

**Files:**
- Modify: `extension/src/popup/Popup.svelte`

- [ ] **Step 1: Replace `extension/src/popup/Popup.svelte`**

```svelte
<script lang="ts">
  import { m } from "../lib/paraglide/messages";
  import { isConfigured, loadConfig } from "../lib/config";
  import type {
    CaptureConfig,
    CaptureResult,
    TransportErrorKind,
    WorkerRequest,
    WorkerResponse,
  } from "../lib/types";

  type View = "loading" | "needs-config" | "ready" | "submitting" | "done" | "error";

  let view = $state<View>("loading");
  let config = $state<CaptureConfig | null>(null);
  let capture = $state<CaptureResult | null>(null);
  let prompt = $state("");
  let desig = $state("");
  let errorMsg = $state("");

  function send(req: WorkerRequest): Promise<WorkerResponse> {
    return chrome.runtime.sendMessage(req);
  }

  function localizeError(kind: TransportErrorKind | "capture", message: string): string {
    switch (kind) {
      case "origin":
        return m.err_origin();
      case "auth":
        return m.err_auth();
      case "confinement":
        return m.err_confinement();
      case "unreachable":
        return m.err_unreachable({ baseUrl: config?.baseUrl ?? "" });
      case "capture":
        return m.popup_cant_capture();
      default:
        return m.err_unknown({ message });
    }
  }

  async function init() {
    const cfg = await loadConfig();
    config = cfg;
    if (!isConfigured(cfg)) {
      view = "needs-config";
      return;
    }
    const res = await send({ type: "capture" });
    if (res.ok && res.type === "capture") {
      capture = res.result;
      view = "ready";
    } else if (!res.ok) {
      errorMsg = localizeError(res.errorKind, res.message);
      view = "error";
    }
  }

  async function submit() {
    if (!capture) return;
    if (prompt.trim() === "") {
      errorMsg = m.popup_empty_prompt();
      view = "error";
      return;
    }
    view = "submitting";
    const res = await send({
      type: "spawn",
      payload: {
        prompt,
        metadata: capture.metadata,
        screenshotDataUrl: capture.screenshotDataUrl,
      },
    });
    if (res.ok && res.type === "spawn") {
      desig = res.desig;
      view = "done";
    } else if (!res.ok) {
      errorMsg = localizeError(res.errorKind, res.message);
      view = "error";
    }
  }

  init();
</script>

<main class="flex w-[380px] flex-col gap-3 p-3 font-sans text-sm text-gray-900">
  <h1 class="font-semibold">{m.popup_title()}</h1>

  {#if view === "loading"}
    <p class="text-gray-500">{m.popup_capturing()}</p>
  {:else if view === "needs-config"}
    <p class="text-gray-600">{m.popup_no_config()}</p>
    <button
      class="self-start rounded bg-gray-900 px-3 py-1.5 text-white"
      onclick={() => chrome.runtime.openOptionsPage()}
    >
      {m.popup_open_options()}
    </button>
  {:else if view === "done"}
    <p class="rounded bg-green-50 px-3 py-2 text-green-700">{m.popup_success({ desig })}</p>
  {:else if capture}
    <img
      class="w-full rounded border border-gray-200"
      src={capture.screenshotDataUrl}
      alt={m.popup_screenshot_alt()}
    />

    <label class="flex flex-col gap-1">
      <span class="text-gray-600">{m.popup_prompt_label()}</span>
      <textarea
        class="min-h-20 rounded border border-gray-300 px-2 py-1"
        bind:value={prompt}
        placeholder={m.popup_prompt_placeholder()}
      ></textarea>
    </label>

    <p class="text-xs text-gray-500">
      {m.popup_repo_label()}: <span class="font-mono">{config?.repoPath}</span>
    </p>

    {#if view === "error"}
      <p class="rounded bg-red-50 px-3 py-2 text-red-700">{errorMsg}</p>
    {/if}

    <button
      class="rounded bg-gray-900 px-3 py-1.5 text-white disabled:opacity-50"
      onclick={submit}
      disabled={view === "submitting"}
    >
      {view === "submitting" ? m.popup_submitting() : m.popup_submit()}
    </button>
  {:else if view === "error"}
    <p class="rounded bg-red-50 px-3 py-2 text-red-700">{errorMsg}</p>
  {/if}
</main>
```

- [ ] **Step 2: Typecheck + build**

Run:
```bash
cd extension && bun run check && bun run build
```
Expected: 0 check errors; build emits `dist/index.html` + service worker + assets.

- [ ] **Step 3: Lint the whole package**

Run:
```bash
cd extension && bun run lint
```
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add extension/src/popup/Popup.svelte
git commit -m "feat(extension): popup — capture, edit prompt, spawn-now"
```

---

### Task 11: README + CLAUDE.md package table + feature catalog note

**Files:**
- Create: `extension/README.md`
- Modify: `CLAUDE.md` (package table)

- [ ] **Step 1: Create `extension/README.md`**

````markdown
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

| Failure | Popup message | Fix |
| ------- | ------------- | --- |
| `403` | origin rejected | add the extension ID to `SHEPHERD_ALLOWED_HOSTS` |
| `401` | auth failed | set the correct token in options |
| `400` | repo not allowed | point repo path inside `SHEPHERD_REPO_ROOT` |
| network | unreachable | check base URL / that the core is running |

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
````

- [ ] **Step 2: Add the `extension/` row to the `CLAUDE.md` package table**

Open `CLAUDE.md`, find the table under "Running checks in a fresh worktree":

```
| Package | Install                | Lint/check      | Test       |
| ------- | ---------------------- | --------------- | ---------- |
| Root    | `bun install`          | `bun run lint`  | `bun test` |
| UI      | `cd ui && bun install` | `bun run check` | `bun test` |
```

Add a third row so it reads:

```
| Package   | Install                       | Lint/check      | Test       |
| --------- | ----------------------------- | --------------- | ---------- |
| Root      | `bun install`                 | `bun run lint`  | `bun test` |
| UI        | `cd ui && bun install`        | `bun run check` | `bun test` |
| Extension | `cd extension && bun install` | `bun run check` | `bun test` |
```

- [ ] **Step 3: Commit**

```bash
git add extension/README.md CLAUDE.md
git commit -m "docs(extension): setup + manual checklist; add package-table row"
```

---

### Task 12: Feature-announcements catalog entry

The repo gates user-facing `feat`s on a `feature-announcements.ts` entry (see
CLAUDE.md "Feature discovery"). This extension ships **no `ui/src` UX**, so the
heuristic gate (`scripts/check-feature-catalog.sh`) won't arm — but the feature
IS user-facing. Add a catalog entry so the What's-New drawer reflects it, keeping
the discovery system honest.

**Files:**
- Modify: `ui/src/lib/feature-announcements.ts`
- Modify: `ui/messages/en.json`
- Modify: `ui/messages/de.json`

- [ ] **Step 1: Read the current catalog shape**

Run:
```bash
sed -n '1,80p' ui/src/lib/feature-announcements.ts
```
Note the `FeatureAnnouncement` type fields and the current newest `sinceVersion`, and confirm how the array is declared (append a new entry to `featureAnnouncements`).

- [ ] **Step 2: Append an entry to `featureAnnouncements`** in `ui/src/lib/feature-announcements.ts`

```ts
  {
    id: "chrome-capture-extension",
    sinceVersion: "1.16.0",
    titleKey: "feature_capture_extension_title",
    bodyKey: "feature_capture_extension_body",
  },
```

> If the table's existing entries use a different newest `sinceVersion`, match the repo's current unreleased version instead of `1.16.0`. Verify against `package.json`'s `version` + recent entries; pick the next minor if unsure.

- [ ] **Step 3: Add EN keys to `ui/messages/en.json`**

```json
  "feature_capture_extension_title": "Capture a page into a task",
  "feature_capture_extension_body": "Install the Shepherd Capture browser extension to turn the tab you're looking at into a task — screenshot and page context attached — in one click."
```

- [ ] **Step 4: Add DE keys to `ui/messages/de.json`**

```json
  "feature_capture_extension_title": "Seite als Aufgabe erfassen",
  "feature_capture_extension_body": "Installiere die Shepherd-Capture-Browsererweiterung, um den aktuellen Tab mit einem Klick in eine Aufgabe zu verwandeln – Screenshot und Seitenkontext inklusive."
```

- [ ] **Step 5: Verify UI i18n parity + typecheck**

Run:
```bash
cd ui && bun install && bun run check:i18n && bun run check
```
Expected: i18n parity passes; svelte-check reports 0 errors.

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/feature-announcements.ts ui/messages/en.json ui/messages/de.json
git commit -m "feat(extension): announce browser-capture extension in What's-New catalog"
```

---

### Task 13: Final verification

- [ ] **Step 1: Full extension gate**

Run:
```bash
cd extension && bun install && bun run check:i18n && bun run lint && bun run check && bun test && bun run build
```
Expected: every step exits 0; `dist/manifest.json` present.

- [ ] **Step 2: UI half (touched in Task 12)**

Run:
```bash
cd ui && bun run check:i18n && bun run check && bun test
```
Expected: all pass.

- [ ] **Step 3: Confirm acceptance criteria against the spec**

Re-read `docs/superpowers/specs/2026-06-04-shepherd-capture-extension-design.md` "Acceptance criteria" and tick each off (build/lint/typecheck, capture+populate popup, spawn-now stages+creates session, EN+DE parity gated, README documents origin/token/base-URL). The live-HUD checks are the **manual** items in `extension/README.md`.

- [ ] **Step 4: Open the PR** (per workflow rules — branch already cut for issue #308)

```bash
git push -u origin HEAD
gh pr create --fill --base main
```
PR body must: link issue #308; note it lands **Phase 1 only** with later phases deferred; list the manual-verification steps the reviewer should run (load unpacked + the README checklist). Mention the feature-catalog entry (Task 12) explicitly so the critic can confirm it.

---

## Notes for the executor

- **Run everything from `extension/`** unless a step says otherwise. The package has its own `node_modules`; `bun install` there first.
- **Don't import `m.*` (Paraglide) in `background.ts`, `transport.ts`, or any worker-side module** — the service worker has no `localStorage`, and the design keeps localization in the popup/options only. Worker code returns typed error *kinds*; the popup maps them to messages.
- **No binary icons in Phase 1** — the manifest omits `default_icon`; Chrome shows its default. Icons are a polish-phase follow-up.
- **TDD ordering matters** for Tasks 3–6: write the test, watch it fail, implement, watch it pass, commit. Don't fold steps together.
- If `@crxjs/vite-plugin` build emits a manifest warning about the missing icon, that's expected and non-fatal for MVP.

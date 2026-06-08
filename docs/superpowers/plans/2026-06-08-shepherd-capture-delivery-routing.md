# Shepherd Capture — Delivery & Routing (#341) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Shepherd Capture two delivery targets — the existing spawn-now **session** plus a new **GitHub-issue** path — and route a capture to the right repo automatically via configurable **URL→repo rules**, instead of one fixed `repoPath`.

**Architecture:** Reuse Phase-1's pure-core + thin-glue split.
- **Server (root):** a new optional forge method `createIssue` (GitHub via `gh issue create`, Gitea via the issues REST API) behind a new `POST /api/issues` route that mirrors `handleSessionCreate`'s repo-confinement + JSON guards. Bun-tested.
- **Extension:** a new pure `routing.ts` (`resolveRepo`) + extended `transport.ts` (`fileIssue`) + `config`/`types`, vitest-tested; popup gains a delivery-target picker + issue-title field + computed effective-repo line; options gains a URL→repo rules editor. EN+DE catalogs extended.

**Tech Stack:** TypeScript, Bun (root), Svelte 5 + Tailwind 4.1 + Paraglide + vitest (extension), `gh`/Gitea REST (forge).

**Out of scope (later):** embedding the screenshot *into* a GitHub issue (GitHub markdown can't reference the confined local upload path; the issue body carries the metadata/signals context block only, the screenshot stays a spawn-now-only attachment — documented in the popup). Element picker / full-page stitch (#342), keyboard shortcut / toolbar icons (#343).

---

## File Structure

```
src/
  forge/types.ts        # +createIssue?(o:{title,body}) → {number,url}            (Task 1)
  forge/github.ts       # implement createIssue via `gh issue create`            (Task 1)
  forge/gitea.ts        # implement createIssue via POST /repos/:slug/issues      (Task 1)
  server.ts             # +handleIssueCreate (POST /api/issues), register it      (Task 2)
test/
  server-issues.test.ts # NEW: POST /api/issues happy + 400 paths                (Task 2)

extension/src/
  lib/types.ts          # +RoutingRule, +DeliveryTarget, extend CaptureConfig /
                        #  SpawnPayload (repoPath override) / WorkerRequest        (Task 3)
  lib/routing.ts        # NEW pure: resolveRepo(url, rules, fallback)              (Task 4)
  lib/config.ts         # +routingRules default + merge                           (Task 5)
  lib/transport.ts      # +fileIssue(); thread repoPath override into spawnNow     (Task 6)
  background.ts         # +"file-issue" worker branch; pass repoPath through        (Task 7)
  popup/Popup.svelte    # delivery picker + title field + effective-repo line      (Task 8)
  options/Options.svelte# URL→repo rules editor                                    (Task 9)
extension/messages/{en,de}.json  # +delivery/routing/issue keys                    (Task 10)
extension/test/
  routing.test.ts       # NEW: resolveRepo                                         (Task 4)
  transport.test.ts     # extend: fileIssue                                        (Task 6)
extension/README.md     # delivery targets + routing rules + manual checklist      (Task 11)
```

Run server tasks from repo root (`bun install`, `bun run lint`, `bun test ./test`). Run extension tasks from `extension/` (`bun install`, `bun run check`, `bun run check:i18n`, `bun run test`).

---

### Task 1: Forge `createIssue`

**Files:** `src/forge/types.ts`, `src/forge/github.ts`, `src/forge/gitea.ts`

- [ ] **types.ts** — add to `GitForge`, alongside the other optional write methods (keep it optional, gated like `comment?`/`closeIssue?`):
  ```ts
  /** Open a new issue (capture-extension delivery path). Returns the created
   *  issue's number + URL. Optional: hosts without an issue-create API omit it
   *  and POST /api/issues 400s. */
  createIssue?(o: { title: string; body: string }): Promise<{ number: number; url: string }>;
  ```
- [ ] **github.ts** — implement via the existing `this.run` (`gh`):
  - `gh issue create --repo <slug> --title <title> --body <body>` prints the new issue URL on stdout.
  - Parse `number` from the trailing `/<n>` of the URL; return `{ number, url }` (trimmed).
- [ ] **gitea.ts** — implement via the existing `this.req` helper: `POST /api/v1/repos/<slug>/issues` with `{ title, body }`; map response `{ number, html_url }` → `{ number, url }`.
- [ ] **Verify:** `bun run lint` + `bunx tsc --noEmit` clean.

**Note:** model `createIssue` on the existing `openPr` (github) / `closeIssue` (gitea) shapes — same runner/req, same error propagation (no try/catch; let it throw so the route maps it to 502).

---

### Task 2: `POST /api/issues` route + tests

**Files:** `src/server.ts`, `test/server-issues.test.ts`

- [ ] Add `handleIssueCreate({ req, parts, deps })` modeled on `handleSessionCreate` + `handleActionsRerun`:
  - Match `POST` + `parts[0]==="api"` + `parts[1]==="issues"` + `!parts[2]`; else `return null`.
  - `requireJsonContentType(req)` guard.
  - Body `{ repo, title, body }`. `safeRepoDir(body.repo ?? "", config.repoRoot)` → 400 `invalid repo` if falsy.
  - Validate `title`: non-empty trimmed string ≤ 200 chars → 400 else. `body`: string ≤ 16000 chars (empty allowed) → 400 else.
  - `const forge = deps.resolveForge?.(dir) ?? null;` → `if (!forge?.createIssue) return json({ error: "issues unavailable for repo" }, 400);`
  - `try { const issue = await forge.createIssue({ title, body }); return json({ ...issue, slug: forge.slug }, 201); } catch (e) { return json({ error: e instanceof Error ? e.message : "issue create failed" }, 502); }`
- [ ] Register `handleIssueCreate` in `ROUTE_HANDLERS` (next to `handleIssues`).
- [ ] **test/server-issues.test.ts** (model on `test/server-backlog.test.ts`'s `fakeForge`/`buildDeps`):
  - 201: POST valid `{ repo, title, body }` to a forge whose `createIssue` returns `{ number: 7, url }` → body has `number`, `url`, `slug`.
  - 400: invalid/out-of-root repo; missing/blank title; forge without `createIssue`.
  - 502: `createIssue` throws.
- [ ] **Verify:** `bun test ./test` green; `bun run lint` clean.

---

### Task 3: Extension types

**File:** `extension/src/lib/types.ts`

- [ ] Add:
  ```ts
  /** One URL→repo routing rule. `pattern` is a glob (`*` wildcards) matched
   *  case-insensitively against the captured tab's full URL; first match wins. */
  export interface RoutingRule { pattern: string; repoPath: string; }
  /** Where a capture is delivered. */
  export type DeliveryTarget = "session" | "issue";
  ```
- [ ] Extend `CaptureConfig` with `routingRules: RoutingRule[]`.
- [ ] Extend `SpawnPayload` with `repoPath: string` (the routing-resolved effective repo; replaces the implicit `config.repoPath` at spawn time).
- [ ] Add issue request to the envelope:
  ```ts
  | { type: "file-issue"; payload: { repoPath: string; title: string; prompt: string; metadata: PageMetadata; signals?: CapturedSignals } }
  ```
  and the response `| { ok: true; type: "issue"; number: number; url: string }`.
- [ ] **Verify:** `cd extension && bun run check` (will fail until later tasks compile callers — acceptable mid-plan; final verify in Task 8/9).

---

### Task 4: `routing.ts` (pure) + tests

**Files:** `extension/src/lib/routing.ts` (new), `extension/test/routing.test.ts` (new)

- [ ] `resolveRepo(url: string, rules: RoutingRule[], fallback: string): string`:
  - For each rule in order: skip if `pattern.trim()` or `repoPath.trim()` empty; convert glob → anchored case-insensitive regex (escape regex metachars, `*` → `.*`); if it matches `url`, return `rule.repoPath`.
  - No match → `fallback`.
  - Guard against an invalid pattern throwing (treat as no-match).
- [ ] **routing.test.ts:** exact host match wins; `*` wildcard; first-match-wins ordering; empty pattern skipped; no-match → fallback; case-insensitive.
- [ ] **Verify:** `cd extension && bun run test` green for this file.

---

### Task 5: config defaults

**File:** `extension/src/lib/config.ts`

- [ ] Add `routingRules: []` to `DEFAULT_CONFIG`.
- [ ] In `loadConfig`, carry `routingRules` through (it's covered by the existing `...stored` spread; just ensure the default is present so a never-saved config has `[]`). No deep-merge needed (array replace is correct).

---

### Task 6: transport `fileIssue` + repo override + tests

**Files:** `extension/src/lib/transport.ts`, `extension/test/transport.test.ts`

- [ ] Thread the effective repo: add `repoPath: string` to `SpawnInput`; in `createSession` use `input.repoPath` instead of `config.repoPath`. Update `spawnNow` signature/caller accordingly.
- [ ] Add:
  ```ts
  /** File the capture as a GitHub/Gitea issue: title + (prompt + context block) body.
   *  No screenshot upload — a remote issue can't reference the confined local path. */
  export async function fileIssue(fetchFn, config, input: {
    repoPath: string; title: string; prompt: string; metadata: PageMetadata; signals?: CapturedSignals;
  }): Promise<{ number: number; url: string }>
  ```
  - `body = \`${input.prompt}\n\n${formatContextBlock(input.metadata, input.signals)}\``.
  - POST `${config.baseUrl}/api/issues` with `application/json` + auth headers, `{ repo: input.repoPath, title: input.title, body }`.
  - Reuse `ensureOk`/`kindForStatus`/the `unreachable` catch exactly like `createSession`.
  - Parse `{ number, url }`; throw `TransportError("unknown", …)` if either missing.
- [ ] **transport.test.ts:** extend the existing fetch-stub style — `fileIssue` posts the right URL/body and returns `{number,url}`; a 400 surfaces `invalid`; an unreachable fetch surfaces `unreachable`.
- [ ] **Verify:** `cd extension && bun run test` green.

---

### Task 7: background worker branch

**File:** `extension/src/background.ts`

- [ ] In the `onMessage` handler add a `req.type === "file-issue"` branch: `loadConfig()`, call `fileIssue(fetch, config, req.payload)`, `sendResponse({ ok: true, type: "issue", number, url })`. `TransportError` maps as in the spawn branch.
- [ ] Update the existing `spawn` branch to pass `repoPath: req.payload.repoPath` into `spawnNow`.

---

### Task 8: popup delivery picker + title + effective repo

**File:** `extension/src/popup/Popup.svelte`

- [ ] Compute `let effectiveRepo = $derived(capture ? resolveRepo(capture.metadata.url, config?.routingRules ?? [], config?.repoPath ?? "") : (config?.repoPath ?? ""))`.
- [ ] Replace the static repo line (`m.popup_repo_label`) with one showing `effectiveRepo`; when it differs from `config.repoPath`, append a subtle "(routed)" hint (`m.popup_repo_routed`).
- [ ] Add a delivery-target control (two radios or a `<select>`): `m.popup_target_session` (default) / `m.popup_target_issue`, bound to `let target = $state<DeliveryTarget>("session")`.
- [ ] When `target === "issue"`: show a title `<input>` bound to `issueTitle`, prefilled once from `capture.metadata.title`. The screenshot/attach checkbox stays visible but a note (`m.popup_issue_no_screenshot`) clarifies it's session-only; disable the screenshot checkbox in issue mode.
- [ ] `submit()` branches on `target`:
  - `session` → existing spawn, now with `repoPath: effectiveRepo`.
  - `issue` → require non-empty `issueTitle` (else `m.popup_issue_empty_title` error); send `{ type: "file-issue", payload: { repoPath: effectiveRepo, title: issueTitle, prompt, metadata, signals } }`; on success set `done` view showing `m.popup_issue_success({ number })` as a link to `url`.
- [ ] Keep the existing empty-prompt guard for both targets.
- [ ] **Verify:** `cd extension && bun run check` clean.

---

### Task 9: options routing-rules editor

**File:** `extension/src/options/Options.svelte`

- [ ] Add a "Routing rules" `<fieldset>` (mirrors the Signals one): legend `m.options_routing_title`, hint `m.options_routing_hint`.
- [ ] Render `config.routingRules` as rows, each with a `pattern` input (`m.options_routing_pattern_ph`), a `repoPath` input (`m.options_routing_repo_ph`), and a remove button (`m.options_routing_remove`, `aria-label`).
- [ ] An "Add rule" button (`m.options_routing_add`) appends `{ pattern: "", repoPath: "" }`.
- [ ] Rules persist with the rest of the form on **Save** (already `saveConfig(config)`); drop fully-empty rows (both fields blank) on save so the list stays clean.
- [ ] **Verify:** `cd extension && bun run check` clean.

---

### Task 10: i18n catalogs

**Files:** `extension/messages/en.json`, `extension/messages/de.json`

- [ ] Add every new key to **both** catalogs (EN + DE), snake_case, `popup_`/`options_` prefixed:
  `popup_target_label`, `popup_target_session`, `popup_target_issue`, `popup_repo_routed`,
  `popup_issue_title_label`, `popup_issue_no_screenshot`, `popup_issue_empty_title`,
  `popup_issue_success` (`{number}`), `options_routing_title`, `options_routing_hint`,
  `options_routing_pattern_ph`, `options_routing_repo_ph`, `options_routing_add`,
  `options_routing_remove`.
- [ ] **Verify:** `cd extension && bun run check:i18n` passes (key-set parity).

---

### Task 11: README + final verification

**File:** `extension/README.md`

- [ ] Document the two delivery targets + the URL→repo rules (format, first-match-wins, glob) + the screenshot-not-in-issues caveat. Extend the manual load-unpacked checklist with: file-as-issue happy path, a routing rule overriding the default repo, and the issue-title required guard.
- [ ] **Final verify (both packages):**
  - Root: `bun run lint` && `bunx tsc --noEmit` && `bun test ./test`.
  - Extension: `bun run check` && `bun run check:i18n` && `bun run test` && `bun run lint`.

---

## Unresolved questions

1. Screenshot-in-issue omitted (can't embed confined local path) — accept body-only issues? **Assumed yes.**
2. Routing match = glob on full URL, first-match-wins — vs host-only? **Assumed full-URL glob** (more flexible, host is a substring case).
3. `createIssue` optional + per-forge gated (GitHub + Gitea both implemented) — vs GitHub-only? **Assumed both.**

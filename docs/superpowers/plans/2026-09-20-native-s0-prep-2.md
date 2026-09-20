# Stream S0-prep-2 — Milestone-3 seams and manifest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** land everything the six milestone-3 streams would otherwise fight over, once, before any
of them cuts a branch: the two app seams that do not exist yet (a SwiftUI `Settings` scene with a
pane registry, and a `CommandMenu` registry), a `NewSessionSlot` so S11 extends the create sheet
without owning it, the scene-time registration pass those two need, the `STREAM_NAMES` extension
and eighteen empty marker pairs, six new `KEYS_*` arrays, the contract-harness deps the new routes
read, the two cross-stream contract additions, and the `writeBadge` generation stamp Codex left open
on #2396.

**Architecture:** Three new files under `Sources/App/` (`SettingsScene.swift`,
`CommandRegistry.swift`, `NewSessionSlot.swift`), a two-phase `StreamRegistrations` (a model-free
`installScene()` called from `ShepherdApp.init()`, and the existing model-bound
`installAll(into:)`), a `Settings` scene added to `ShepherdApp.body`, a `.commands { }` modifier on
the `WindowGroup`, eleven optional deps wired into `test/contract/deps.ts` behind the existing
`stubs` contract, and two additive core-schema changes in `contracts/openapi.yaml`.

**Tech Stack:** Bun + ajv (contract drift test), OpenAPI 3.1, swift-openapi-generator 1.13.1,
Swift 6 (language mode 6, strict concurrency `complete`), SwiftUI, Swift Testing (`import Testing`),
XcodeGen 2.46, `os.Logger`.

---

## Global Constraints

- **Swift 6 strict concurrency** (`SWIFT_STRICT_CONCURRENCY: complete`, `swiftLanguageModes: [.v6]`).
  No `@preconcurrency`, no `@unchecked Sendable`, no `nonisolated(unsafe)`.
- **No hand-written `Codable` for server payloads.** The contract is the only type source: a route
  or event enters `contracts/openapi.yaml` first, then `bun run gen:contract-swift` +
  `./native/scripts/sync-contract.sh` regenerate and copy the derived file. Never hand-edit
  `contracts/openapi.swift.yaml` or `native/Sources/ShepherdKit/openapi.yaml`.
- **ShepherdKit has no UI dependency.** Nothing under `native/Sources/` imports SwiftUI or AppKit.
- **Every new view is AppKit-free.** This branch adds SwiftUI only; the AppKit `NSWindow` in
  `Notifications/NotificationSettingsView.swift` stays where it is and is retired by S12 once a real
  `Settings` scene has panes in it.
- **Strings only via `L.t()`**, with every key present in **both** `ui/messages/en.json` and
  `ui/messages/de.json` and listed in exactly one `KEYS_*` array in `native/scripts/gen-strings.ts`.
  Never add a string only in Swift. German copy matches the web UI verbatim — reuse the web's key
  rather than writing a second translation.
- **No Keychain prompts.** Build and test through `./native/scripts/build-app.sh` and
  `./native/scripts/test-app.sh` (which export `SHEPHERD_ISOLATED=1`, so the app runs on a private
  `UserDefaults` suite and an `InMemoryCredentialStore`). `SHEPHERD_KEYCHAIN_TESTS` is **never** set
  locally — it is CI's switch for the real-keychain suite.
- **`bun run test`, never bare `bun test`** (repo `CLAUDE.md`): the bare runner walks the wrong file
  set and "passes" without running the suite you meant.
- **`bun run typecheck` is a gate**, alongside `bun run lint` and `bun run test:contract`. A harness
  type that only `tsc` rejects passes every other check on the branch and fails in CI.
- **Live tests read `SHEPHERD_LIVE_BASE_URL` / `SHEPHERD_LIVE_PASSWORD` from the environment only**
  — or `SHEPHERD_LIVE_TOKEN` in place of the password for the read-only unit suite. Never from a
  file, never in CI. `TEST_RUNNER_`-prefixed copies are how `xcodebuild` forwards them; set
  `TEST_RUNNER_SHEPHERD_REVOKE_ON_EXIT=1` for any live run. A base URL always goes through
  `RemoteServerForm.normalize` before it reaches a `ServerProfile`. Nothing on this branch writes
  any of them to disk.
- **XCUITest runs serialised** — one worktree at a time. Parallel `xcodebuild` runs fight over
  `testmanagerd` and fail with "Channel disconnected" and zero tests executed; `pkill -9
  testmanagerd` and rerun clears it. Never `pkill -f` on a pattern that would match another
  worktree's run.
- **`git checkout -- native/Package.resolved` after `swift test --package-path native`** — the test
  run rewrites it, and it does not belong in this diff.
- **Commits:** conventional, lowercase subject; body lines ≤ 100 chars; a **blank line** before the
  trailer, and the body ends with
  `Co-Authored-By: <executing model name> <noreply@anthropic.com>`.
- **Push with `git push --no-verify`.**
- **Logging:** `run.shepherd.mac` (app, via `Log.ui`/`Log.app`), `run.shepherd.kit` (kit).
- **Branch:** `feat/native-s0-prep-2`, cut from `origin/main`. Rebase to update; never
  `git merge main`.

| Command (repo root) | What it proves |
| --- | --- |
| `bun run test:contract` | the contract matches the real server |
| `bun run gen:contract-swift` | regenerates `contracts/openapi.swift.yaml` |
| `./native/scripts/sync-contract.sh` | copies the derived file into the kit target |
| `bun run typecheck` | the harness and fixtures typecheck |
| `swift test --package-path native` | kit compiles, kit tests pass |
| `./native/scripts/test-app.sh -only-testing:ShepherdTests` | app unit tests pass |
| `./native/scripts/build-app.sh` | `Shepherd.app` builds |
| `bun run check:strings` | `Localizable.xcstrings` is current |
| `bun run lint` · `bun run test` | repo gates |

### File ownership

This is the integration stream, so it owns the shared files — but only the ones listed. Create or
modify **only**: `contracts/openapi.yaml` · the generated `contracts/openapi.swift.yaml` and
`native/Sources/ShepherdKit/openapi.yaml` · `contracts/README.md` ·
`test/contract/{deps,stream-blocks,stream-blocks.test,openapi.test}.ts` ·
`native/scripts/gen-strings.ts` · `native/Apps/ShepherdMac/Sources/App/{ShepherdApp,
StreamRegistrations,SettingsScene,CommandRegistry,NewSessionSlot,SessionSignals}.swift` ·
`native/Apps/ShepherdMac/Sources/Main/NewSessionSheet.swift` ·
`native/Apps/ShepherdMac/Sources/Notifications/NotificationsModel.swift` ·
`native/Apps/ShepherdMac/Tests/{SettingsSceneTests,CommandRegistryTests,NewSessionSlotTests,
StreamRegistrationsTests,NotificationsBadgeRaceTests}.swift` · `native/README.md` ·
`ui/messages/{en,de}.json` · the generated
`native/Apps/ShepherdMac/Resources/Localizable.xcstrings`.

Never edit `AppModel.swift`, `MainWindow.swift`, `SessionDetailView.swift`, `SessionStore.swift`,
`ServerEvent.swift`, `EventStream.swift`, `ShepherdClient.swift`, `project.yml`, `native.yml`, or
any stream's `Sources/<Stream>/**`.

### Preconditions — verify before Task 1

```bash
cd /Users/kai.osthoff/githubrepos/shepherd
git fetch origin main
git worktree add .claude/worktrees/feat-native-s0-prep-2 -b feat/native-s0-prep-2 origin/main
cd .claude/worktrees/feat-native-s0-prep-2 && bun install
grep -c "── stream: " contracts/openapi.yaml \
  && grep -c "KEYS_" native/scripts/gen-strings.ts \
  && test -f native/Apps/ShepherdMac/Sources/App/StreamRegistrations.swift \
  && test -f native/Apps/ShepherdMac/Sources/App/SessionSignals.swift \
  && echo OK || echo "baseline MOVED — stop and tell the orchestrator"
```

Expected: `24` (twelve open + twelve close markers), a count ≥ `16`, then `OK`.

### Task order

| # | Task | Key files |
| --- | --- | --- |
| 1 | `STREAM_NAMES` + eighteen empty marker pairs | `stream-blocks.ts`, `contracts/openapi.yaml`, `contracts/README.md` |
| 2 | Six `KEYS_*` arrays | `native/scripts/gen-strings.ts` |
| 3 | Contract harness deps for the new routes, plus a real git repo | `test/contract/deps.ts` |
| 4 | Cross-stream contract: `UsageLimits.observed`, six create fields | `contracts/openapi.yaml`, `test/contract/openapi.test.ts` |
| 5 | `CommandRegistry` + `SettingsPaneRegistry` + the scene-time pass | `Sources/App/{CommandRegistry,SettingsScene,StreamRegistrations,ShepherdApp}.swift` |
| 6 | `NewSessionSlot` + the create sheet's extras hook | `Sources/App/NewSessionSlot.swift`, `Sources/Main/NewSessionSheet.swift` |
| 7 | Two new `SessionSignals` seams | `Sources/App/SessionSignals.swift` |
| 8 | The `writeBadge` generation stamp (#2396 P1) | `Sources/Notifications/NotificationsModel.swift` |
| 9 | README, full gate sweep, PR | `native/README.md` |

---

### Task 1: `STREAM_NAMES` and eighteen empty marker pairs

**Files:** modify `test/contract/stream-blocks.ts`, `test/contract/stream-blocks.test.ts`,
`contracts/openapi.yaml`, `contracts/README.md`.

**Interfaces:**
- Consumes: `parseStreamBlocks`, `streamBlocks`, `operationsForStream`, `eventsForStream` — all
  unchanged in behaviour.
- Produces: `STREAM_NAMES` with ten members and thirty balanced marker pairs in the contract, so a
  milestone-3 stream's `operationsForStream("herd")` resolves instead of throwing
  `unknown stream "herd" — not in STREAM_NAMES`.

- [ ] **Step 1: Watch the current state fail for a new name**

```bash
bun -e 'import("./test/contract/stream-blocks.ts").then(m => console.log(m.operationsForStream("herd" as never)))'
```

Expected: an empty array — `operationsForStream` filters on a `Map` lookup that misses, so it is
silently wrong rather than loud. That silence is the bug this task closes: without the name in
`STREAM_NAMES`, a stream's own coverage gate passes over an empty set while its routes go
unexercised, and `parseStreamBlocks` throws only once the marker itself is placed.

- [ ] **Step 2: Extend `STREAM_NAMES`**

In `test/contract/stream-blocks.ts`, replace the one-line array:

```ts
/** The streams that own a marked block, in the order S0-prep placed them.
 *
 *  Milestone 2 placed the first four; S0-prep-2 appended the six milestone-3 streams. The order
 *  here is the order the markers sit in each section, and `stream-blocks.test.ts` asserts the two
 *  agree — a name added here without its three markers fails that test, and a marker placed for a
 *  name that is not here throws `unknown stream` out of `parseStreamBlocks`. Both directions are
 *  deliberate: a half-registered stream is worse than neither half. */
export const STREAM_NAMES = [
  "terminal",
  "detail",
  "sidebar",
  "actions",
  "herd",
  "plan",
  "merge",
  "queues",
  "compose",
  "settings",
] as const;
```

Nothing else in the file changes: `OPEN`/`CLOSE` already match `[a-z]+`, and all six new names are
lowercase letters only.

- [ ] **Step 3: Fix the test's own wording**

`test/contract/stream-blocks.test.ts` has one assertion whose *name* hard-codes four:

```ts
  test("every section names exactly the registered streams", () => {
    for (const [label, map] of sections) {
      expect([...map.keys()].sort(), label).toEqual([...STREAM_NAMES].sort());
    }
  });
```

Only the test name changes — the body already derives from `STREAM_NAMES`. Do not touch the other
five assertions in that `describe`; they are correspondence checks, not counts, and stay right.

- [ ] **Step 4: Place the eighteen marker pairs**

Three sections, six streams, in `STREAM_NAMES` order, each pair **after** the `actions` block's
closing marker and before whatever follows that section.

In `components.schemas:`, after `    # ── /stream: actions ──` (four-space indent):

```yaml
    # ── stream: herd ──
    # ── /stream: herd ──
    # ── stream: plan ──
    # ── /stream: plan ──
    # ── stream: merge ──
    # ── /stream: merge ──
    # ── stream: queues ──
    # ── /stream: queues ──
    # ── stream: compose ──
    # ── /stream: compose ──
    # ── stream: settings ──
    # ── /stream: settings ──
```

In `paths:`, after `  # ── /stream: actions ──` (two-space indent), the same twelve lines at
two-space indent. In `x-shepherd-events:`, after its `  # ── /stream: actions ──`, the same twelve
lines at two-space indent.

The grammar is exact: one literal space at each gap, `──` is U+2500 BOX DRAWINGS LIGHT HORIZONTAL
twice. `looksLikeMarker` in `stream-blocks.ts` throws on a near-miss, so a copy through an editor
that normalises dashes fails loudly rather than silently dropping a block.

- [ ] **Step 5: Document it**

In `contracts/README.md`, replace the "Stream blocks — three per stream" opening paragraph:

```markdown
## Stream blocks — three per stream

Milestone 2 was built by four parallel streams (`terminal`, `detail`, `sidebar`, `actions`) and
milestone 3 adds six more (`herd`, `plan`, `merge`, `queues`, `compose`, `settings`). Each owns a
marked block in **all three** extensible sections of `openapi.yaml`:
```

and, further down, replace "every one of the twelve pairs must be present and in order" with
"every one of the thirty pairs must be present and in order".

- [ ] **Step 6: Run green and commit**

```bash
bun run test:contract && bun run typecheck && bun run lint
```

Expected: contract tests pass (the new blocks are empty, so `operationsForStream` returns `[]` for
each and every correspondence assertion holds), `tsc` clean, eslint clean.

```bash
git add test/contract/stream-blocks.ts test/contract/stream-blocks.test.ts \
  contracts/openapi.yaml contracts/README.md
git commit -m "chore(contract): register the six milestone-3 stream blocks"
```

---

### Task 2: Six `KEYS_*` arrays

**Files:** modify `native/scripts/gen-strings.ts`.

**Interfaces:**
- Consumes: `KEYS_CORE` … `KEYS_NOTIFICATIONS`, `duplicateKeys`, the `KEYS` concatenation.
- Produces: `KEYS_HERD`, `KEYS_PLAN`, `KEYS_MERGE`, `KEYS_QUEUES`, `KEYS_COMPOSE`, `KEYS_SETTINGS`,
  each exported, each empty, each spread into `KEYS`.

- [ ] **Step 1: Add the six arrays**

After `KEYS_NOTIFICATIONS`'s closing bracket:

```ts
/** S7 — the herd classifier: lifecycle group headings the sidebar already has live in
 *  KEYS_SIDEBAR; this array is for the stepper, the row badges and the CI/review banners. */
export const KEYS_HERD: readonly string[] = [];

/** S8 — plan gates: the badge chips, the plan panel, the visual-block renderer and the
 *  question form. */
export const KEYS_PLAN: readonly string[] = [];

/** S9 — merge, automation and post-merge steps. */
export const KEYS_MERGE: readonly string[] = [];

/** S10 — held tasks, up-next, done/recaps, halt and retry. */
export const KEYS_QUEUES: readonly string[] = [];

/** S11 — the composer: create fields, slash commands, steers, attachments. */
export const KEYS_COMPOSE: readonly string[] = [];

/** S12 — the settings panes, the command menu and the usage gauges. */
export const KEYS_SETTINGS: readonly string[] = [];
```

- [ ] **Step 2: Spread them into the manifest**

```ts
export const KEYS: readonly string[] = [
  ...KEYS_CORE,
  ...KEYS_TERMINAL,
  ...KEYS_DETAIL,
  ...KEYS_SIDEBAR,
  ...KEYS_ACTIONS,
  ...KEYS_LOCALSERVER,
  ...KEYS_NOTIFICATIONS,
  ...KEYS_HERD,
  ...KEYS_PLAN,
  ...KEYS_MERGE,
  ...KEYS_QUEUES,
  ...KEYS_COMPOSE,
  ...KEYS_SETTINGS,
];
```

Empty arrays contribute nothing, so the generated catalog is byte-identical and
`bun run check:strings` still passes without regenerating.

- [ ] **Step 3: Prove the catalog did not move, and commit**

```bash
bun run check:strings && bun run typecheck
```

Expected: `Localizable.xcstrings is up to date` and a clean `tsc`. If the catalog is reported stale,
a key was added by accident — revert it; this task adds none.

```bash
git add native/scripts/gen-strings.ts
git commit -m "chore(native): split the string manifest for the six milestone-3 streams"
```

---

### Task 3: Contract-harness deps for the new routes, plus a real git repo

**Files:** modify `test/contract/deps.ts`.

**Interfaces:**
- Consumes: `AppDeps` from `src/server.ts`, `SessionStore`, `SessionService`, `EventHub`.
- Produces on `ContractDeps.stubs`: `prCache`, `activity`, `claudeAlive`, `stranded`,
  `workingBlocked`, `blocks`, `holds`, `reviewCache`, `planGateCache`, `recapCache`, `autoMerge`,
  `resolveForge`, `shapeTask` and `maxUploadBytes` — each a mutable in-memory object or slot a
  stream's test swaps for one request. Plus `validRepo` as a real `git init`'d repository.

**Why this task exists.** `test/contract/deps.ts` wires `store`, `service`, `events`, `usageLimits`
and `distiller`, and nothing else. Every bulk route milestone 3 declares reads an **optional** dep
that is absent, so `GET /api/git` answers `{}`, `GET /api/activity` answers `{}` and
`GET /api/stranded` answers `[]`. A stream can prove the status codes but not the payload shape —
which is the one thing the drift test exists to prove. `deps.ts` is a shared harness file streams
must not edit, so it is wired once, here.

Three of the additions are S11's and are less obvious than the rest:

- **`resolveForge`** gates `GET /api/issues`. Without it the route answers
  `{slug: null, webUrl: null, issues: [], viewer: null, lightweight: false}` on every call, so the
  issue list — S11's Task 1 and the whole reason that stream was promoted — would be declared and
  unproven.
- **`shapeTask`** gates `POST /api/shape`, which answers **503 `{"error":"unavailable"}`** when the
  dep is absent. A 503 is not a status S11 wants to declare as the normal path.
- **`validRepo` must be a real git repository.** `GET /api/branches` and
  `POST /api/repos/init-empty-commit` shell out to git against it, and today it is
  `mkdirSync(join(tmpRoot, "repo"))` — an empty directory. One `git init` at creation is the whole
  fix, and it changes nothing for the existing tests, which never touch git.

**`GET /api/branch-status` is deliberately left unseedable.** It performs a bounded network
`git fetch` and writes `refs/remotes/origin/<branch>` — genuinely non-idempotent, with a 10-second
TTL cache. S11's plan says how it tests around that; this task only exports
`clearBranchStatusCacheForTests` awareness, it does not stub the route.

- [ ] **Step 1: Write the failing assertion first**

Append to `test/contract/stream-blocks.test.ts` — it is the only test file S0 owns that already
imports nothing stream-specific:

```ts
import { makeContractDeps } from "./deps";

/** The eleven optional AppDeps the milestone-3 routes read. Absent, every one of those routes
 *  answers its empty value and a stream cannot exercise the payload it declared — which is the
 *  whole point of the drift test. Asserted here rather than in a stream's file because `deps.ts`
 *  is shared and no stream may edit it. */
describe("the contract harness wires the milestone-3 deps", () => {
  test("every optional dep the new blocks read is present and seedable", () => {
    const ctx = makeContractDeps();
    try {
      for (const key of [
        "prCache", "activity", "claudeAlive", "stranded", "workingBlocked",
        "blocks", "holds", "reviewCache", "planGateCache", "recapCache", "autoMerge",
        "resolveForge", "shapeTask",
      ] as const) {
        expect(ctx.deps[key], key).toBeDefined();
        expect(ctx.stubs[key], `stubs.${key}`).toBeDefined();
      }
      ctx.stubs.prCache.rows["sess_x"] = { kind: "github", state: "open", checks: "success", deployConfigured: false };
      expect(ctx.deps.prCache?.snapshot()["sess_x"]?.state).toBe("open");
      ctx.stubs.stranded.ids = ["sess_x"];
      expect(ctx.deps.stranded?.ids()).toEqual(["sess_x"]);
      // S11's two: an absent resolveForge makes GET /api/issues answer an empty listing on
      // every call, and an absent shapeTask makes POST /api/shape answer 503.
      ctx.stubs.resolveForge.forge = { listIssues: async () => [], slug: "o/r" } as never;
      expect(ctx.deps.resolveForge?.(ctx.validRepo)).not.toBeNull();
      // And the repo the harness hands out must be a real git repository, because
      // GET /api/branches shells out to git against it.
      expect(existsSync(join(ctx.validRepo, ".git"))).toBe(true);
    } finally {
      ctx.cleanup();
    }
  });
});
```

```bash
bun run test:contract 2>&1 | tail -5
```

Expected: this test fails — `ctx.deps.prCache` is `undefined`.

- [ ] **Step 2: Wire the deps**

In `test/contract/deps.ts`, extend the exported interface:

```ts
/** A seedable snapshot dep: the harness hands the route a live read of `rows`, and a test mutates
 *  `rows` in place for the duration of one request. Same contract as `stubs.herdr` — mutate, make
 *  the request, restore what you changed. */
export interface SnapshotStub<T> {
  rows: Record<string, T>;
}

/** The two list-shaped deps. `ids` is read on every call, so assigning it is enough. */
export interface IdsStub {
  ids: string[];
}

export interface ContractDeps {
  deps: AppDeps;
  tmpRoot: string;
  validRepo: string;
  stubs: {
    herdr: StubMethods;
    worktree: StubMethods;
    usageLimits: AppDeps["usageLimits"];
    /** Milestone-3 snapshot deps. Absent from AppDeps by default, so the routes that read them
     *  answer `{}` / `[]`; wired here so a stream's contract test can prove the payload it
     *  declared, not merely the status code. */
    prCache: SnapshotStub<unknown>;
    activity: SnapshotStub<unknown>;
    claudeAlive: SnapshotStub<boolean>;
    workingBlocked: SnapshotStub<boolean>;
    blocks: SnapshotStub<unknown>;
    holds: SnapshotStub<unknown>;
    reviewCache: SnapshotStub<unknown> & { inflight: unknown[] };
    planGateCache: SnapshotStub<unknown> & { inflight: unknown[] };
    recapCache: SnapshotStub<unknown>;
    stranded: IdsStub;
    autoMerge: { rows: unknown[] };
    /** S11's. `forge` is read on every call, so assigning it swaps what GET /api/issues and
     *  GET /api/issues/{n} see. null (the default) is "this repo has no forge", which is a real
     *  200 answer, not an error. */
    resolveForge: { forge: unknown | null };
    /** S11's. Absent ⇒ POST /api/shape answers 503 `{"error":"unavailable"}`. */
    shapeTask: { impl: ((...args: never[]) => Promise<unknown>) | null };
  };
  /** Overrides MAX_UPLOAD_BYTES for POST /api/uploads so the 413 path is testable without
   *  allocating a 250 MB fixture. Assigned on `deps` directly, not through a closure, because
   *  the route reads the number itself. */
  setMaxUploadBytes(bytes: number | undefined): void;
  cleanup(): void;
}
```

and, inside `makeContractDeps()` before the `deps` literal:

```ts
  // Each stub is read through a closure on every call, never destructured, so a test may mutate
  // `rows` in place between requests. `as any` at the boundary for the same reason the herdr and
  // worktree stubs use it: the real interfaces are re-asserted by the routes that consume them,
  // and the fixtures are typed with the server's own types inside each stream's test file.
  const prCache = { rows: {} as Record<string, unknown> };
  const activity = { rows: {} as Record<string, unknown> };
  const claudeAlive = { rows: {} as Record<string, boolean> };
  const workingBlocked = { rows: {} as Record<string, boolean> };
  const blocks = { rows: {} as Record<string, unknown> };
  const holds = { rows: {} as Record<string, unknown> };
  const reviewCache = { rows: {} as Record<string, unknown>, inflight: [] as unknown[] };
  const planGateCache = { rows: {} as Record<string, unknown>, inflight: [] as unknown[] };
  const recapCache = { rows: {} as Record<string, unknown> };
  const stranded = { ids: [] as string[] };
  const autoMerge = { rows: [] as unknown[] };
  const resolveForge = { forge: null as unknown | null };
  const shapeTask = { impl: null as ((...args: never[]) => Promise<unknown>) | null };
```

and add to the `deps` literal:

```ts
    prCache: { snapshot: () => prCache.rows } as any,
    activity: { snapshot: () => activity.rows } as any,
    claudeAlive: { snapshot: () => claudeAlive.rows },
    workingBlocked: { snapshot: () => workingBlocked.rows },
    blocks: { snapshot: () => blocks.rows } as any,
    holds: { snapshot: () => holds.rows } as any,
    stranded: { ids: () => stranded.ids },
    reviewCache: {
      snapshot: () => reviewCache.rows,
      reviewing: () => reviewCache.inflight,
    } as any,
    planGateCache: {
      snapshot: () => planGateCache.rows,
      reviewing: () => planGateCache.inflight,
    } as any,
    recapCache: { snapshot: () => recapCache.rows } as any,
    autoMerge: { snapshot: async () => autoMerge.rows } as any,
    // Read on every call so a test may swap `forge` in place. Returning null is the honest
    // default: a temp dir has no forge, and the routes have a documented 200 for that.
    resolveForge: () => resolveForge.forge as never,
    shapeTask: (async (...args: never[]) =>
      shapeTask.impl
        ? await shapeTask.impl(...args)
        : { error: "unavailable" }) as never,
```

and, beside the `mkdirSync(validRepo)` line at the top of `makeContractDeps()`:

```ts
  mkdirSync(validRepo);
  // A real repository, not an empty directory: GET /api/branches and
  // POST /api/repos/init-empty-commit shell out to git against this path, and an empty dir makes
  // both of them fail for a reason that has nothing to do with the contract. `-q` keeps the
  // suite's output clean; the initial branch is pinned so `listBranches` is deterministic across
  // machines with different `init.defaultBranch` settings.
  execFileSync("git", ["init", "-q", "-b", "main", validRepo]);
  execFileSync("git", ["-C", validRepo, "config", "user.email", "contract@test.local"]);
  execFileSync("git", ["-C", validRepo, "config", "user.name", "Contract Test"]);
```

with `import { execFileSync } from "node:child_process";` added to the imports. The repo is left
**commitless** — `POST /api/repos/init-empty-commit` exists precisely for that state, and S11's test
exercises it.

And, on the returned object:

```ts
    setMaxUploadBytes(bytes) {
      deps.maxUploadBytes = bytes;
    },
```

and to the returned `stubs`:

```ts
    stubs: {
      herdr, worktree, usageLimits,
      prCache, activity, claudeAlive, workingBlocked, blocks, holds,
      reviewCache, planGateCache, recapCache, stranded, autoMerge,
      resolveForge, shapeTask,
    },
```

`recapCache` is wired even though S4's `GET /api/recaps` already passes: it passes by answering
`{}`, and `test/contract/actions-fixtures.ts` exists only because the route could not be seeded.
Leave that fixture alone — S4's test is not this branch's to rewrite — but the seam is now there for
S10's Done panel.

- [ ] **Step 3: Run green and commit**

```bash
bun run test:contract && bun run typecheck && bun run lint
```

Expected: every existing contract test still passes (each new dep answers its empty value by
default, so no route's behaviour changed), the new assertion passes, `tsc` and eslint clean.

```bash
git add test/contract/deps.ts test/contract/stream-blocks.test.ts
git commit -m "test(contract): wire the snapshot deps the milestone-3 routes read"
```

---

### Task 4: Cross-stream contract — `UsageLimits.observed` and six create fields

**Files:** modify `contracts/openapi.yaml` (core sections, **outside** every marked block),
`test/contract/openapi.test.ts`; regenerate `contracts/openapi.swift.yaml` and
`native/Sources/ShepherdKit/openapi.yaml`.

**Interfaces:**
- Consumes: `UsageLimits`, `CreateSessionRequest`, `LimitWindow`.
- Produces: schemas `ObservedLimitWindow`, `ObservedLimitWindows`, `IssueRef`, `LaunchUiState`;
  `UsageLimits.observed`; `CreateSessionRequest.{mergeTrainPrs,issueRef,research,epicAuthoring,
  attachmentNames,launchUiState}`.

**Why here and not in a stream.** Both are core schemas that two streams need. `UsageLimits` feeds
S12's gauges and is already rendered by S3's merged header, and `CreateSessionRequest` is needed by
S9 (`mergeTrainPrs`) **and** S11 (the other five). A schema outside a marked block may only be
edited by S0, and doing it once is what keeps S9 and S11 from colliding.

- [ ] **Step 1: Add the four schemas and the two extensions**

In `components.schemas:`, beside the existing core schemas (before the `terminal` marker):

```yaml
    ObservedLimitWindow:
      type: object
      additionalProperties: true
      description: A window the provider actually reported, as opposed to Shepherd's local estimate. Copied from ObservedLimitWindow in src/usage-limits.ts.
      required: [pct, resetAt, scrapedAt]
      properties:
        pct: { type: number }
        resetAt: { type: integer }
        scrapedAt: { type: integer, description: ms epoch of the scrape this sample came from. }
    ObservedLimitWindows:
      type: object
      additionalProperties: true
      description: >-
        UsageLimits.observed (src/usage-limits.ts:288-291). The measured counterpart to session5h/week,
        which remain local budget estimates. The web meter PREFERS these when present
        (ui/src/lib/components/usage-gauges.ts:21-53), so a client that ignores them shows different
        numbers from the web for the same server.
      required: [session5h, week]
      properties:
        session5h:
          oneOf:
            - $ref: "#/components/schemas/ObservedLimitWindow"
            - type: "null"
        week:
          oneOf:
            - $ref: "#/components/schemas/ObservedLimitWindow"
            - type: "null"
    IssueRef:
      type: object
      additionalProperties: false
      description: CreateSessionRequest.issueRef — the forge issue a task was started from. Bounds copied from validateIssueRef (src/validate.ts:230-246).
      required: [number, url, title]
      properties:
        number: { type: integer, description: Positive. }
        url: { type: string, description: An http(s) URL, at most 2048 characters. }
        title: { type: string, maxLength: 500 }
        body: { type: string, maxLength: 100000 }
    LaunchUiState:
      type: object
      additionalProperties: true
      description: >-
        CreateSessionRequest.launchUiState — an opaque record of which composer affordances produced
        this task, replayed onto the relaunch sheet. The server stores and returns it without
        interpreting it, so the client must not either.
```

Then, inside the existing `UsageLimits` schema, add one property (leave `required` alone —
`observed` is optional on the server, `src/usage-limits.ts:324`):

```yaml
        observed:
          $ref: "#/components/schemas/ObservedLimitWindows"
```

And inside `CreateSessionRequest`'s `properties:` (leave `required` alone; `additionalProperties`
stays `false`):

```yaml
        mergeTrainPrs:
          type: array
          items: { type: integer }
          description: PR numbers for a merge-train kickoff. Present ⇒ this create is a train, not an ordinary task.
        issueRef:
          $ref: "#/components/schemas/IssueRef"
        research:
          type: boolean
          description: Start in research mode — no worktree writes, no PR.
        epicAuthoring:
          type: boolean
          description: Start in epic-authoring mode.
        attachmentNames:
          type: array
          items: { type: string }
          description: Display names for `images`, positionally. The server rejects a length mismatch with 400 (src/validate.ts:287-291).
        launchUiState:
          $ref: "#/components/schemas/LaunchUiState"
```

All six are in the server's `ALLOWED_KEYS` (`src/validate.ts:42-61`), which is what makes them legal
to send. **`terminal` is deliberately not added:** `POST /api/sessions` is a union whose
clean-terminal arm is exactly `{repoPath, terminal: true}` and nothing else
(`src/validate.ts:530-533`, `TERMINAL_ALLOWED_KEYS` at `:583`), so expressing it needs
`CreateSessionRequest` to become a `oneOf` of two objects. That is a shape change, not a field
addition, and it belongs with S11 where the clean-terminal create is actually built.

- [ ] **Step 2: Exercise the new request fields**

`CreateSessionRequest` has `additionalProperties: false`, so a field declared but never sent is
never proven legal. Add to the existing create `describe` in `test/contract/openapi.test.ts`:

```ts
  test("accepts the six create fields milestone 3 declared", async () => {
    const res = await fetch(`${s.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(token) },
      body: JSON.stringify({
        repoPath: s.validRepo,
        baseBranch: "main",
        prompt: "declared create fields",
        research: false,
        epicAuthoring: false,
        mergeTrainPrs: [],
        attachmentNames: [],
        launchUiState: { source: "contract-test" },
        issueRef: { number: 1, url: "https://example.test/i/1", title: "t", body: "" },
      }),
    });
    // 201 proves ALLOWED_KEYS took every one of them: an undeclared key answers
    // 400 `unknown key: <key>` (src/validate.ts), which is the exact regression this guards.
    expect(res.status).toBe(201);
    await validateResponse("POST", "/api/sessions", res);
  });
```

Adding no status to `POST /api/sessions` leaves the coverage gate's arithmetic untouched.

- [ ] **Step 3: Regenerate, sync, prove freshness**

```bash
bun run test:contract && bun run gen:contract-swift && ./native/scripts/sync-contract.sh \
  && bun run check:contract-swift && ./native/scripts/sync-contract.sh --check \
  && swift build --package-path native 2>&1 | tail -3
```

Expected: contract tests pass · `contracts/openapi.swift.yaml -> native/Sources/ShepherdKit/openapi.yaml`
· no diff · `sync-contract: up to date` · `Build complete!`. The two `oneOf: [X, {type: "null"}]`
properties on `ObservedLimitWindows` sit under `properties:` with nothing but annotations beside
them, which is the one place `scripts/gen-contract-swift.ts` collapses a nullable union — if it
throws with a JSON pointer into `ObservedLimitWindows`, an extra keyword crept in beside the
`oneOf`; remove it rather than weakening the truth file.

- [ ] **Step 4: Commit**

```bash
git add contracts/openapi.yaml contracts/openapi.swift.yaml \
  native/Sources/ShepherdKit/openapi.yaml test/contract/openapi.test.ts
git commit -m "feat(contract): observed usage windows and six declared create fields"
```

---

### Task 5: `CommandRegistry`, `SettingsPaneRegistry` and the scene-time pass

**Files:** create `native/Apps/ShepherdMac/Sources/App/CommandRegistry.swift`,
`native/Apps/ShepherdMac/Sources/App/SettingsScene.swift`,
`native/Apps/ShepherdMac/Tests/CommandRegistryTests.swift`,
`native/Apps/ShepherdMac/Tests/SettingsSceneTests.swift`,
`native/Apps/ShepherdMac/Tests/StreamRegistrationsTests.swift`; modify
`native/Apps/ShepherdMac/Sources/App/StreamRegistrations.swift` and
`native/Apps/ShepherdMac/Sources/App/ShepherdApp.swift`.

**Interfaces:**
- Consumes: `AppModel`, `L.t(_:)`, `Log.app`, the existing `DetailTabRegistry` shape.
- Produces: `MenuCommand`, `CommandRegistry`, `SettingsPane`, `SettingsPaneRegistry`,
  `StreamRegistrations.installScene()`, and a `Settings` scene plus `.commands { }` on the
  `WindowGroup`.

**The ordering problem this solves, stated once.** `ShepherdApp.body` is evaluated during scene
construction, before `RootView`'s `.task` runs — and `.task` is where
`StreamRegistrations.installAll(into:)` is called today. A `Settings` scene or a `CommandMenu` built
from a registry that is still empty at that moment renders empty and never refreshes, because
neither registry is `@Observable`. So registration splits in two: a **model-free** `installScene()`
called from `ShepherdApp.init()`, and the existing model-bound `installAll(into:)` left exactly
where it is. `NotificationsStream.install(app)` must stay in the second half — it reaches
`NSApp.mainMenu`, which is `nil` during `init()`.

- [ ] **Step 1: Write the failing tests**

`native/Apps/ShepherdMac/Tests/CommandRegistryTests.swift`:

```swift
import Testing

@testable import Shepherd

@MainActor
struct CommandRegistryTests {
    private func fresh() { CommandRegistry.reset() }

    @Test func anEmptyRegistryHasNoCommandsInAnyMenu() {
        fresh()
        for menu in MenuCommand.Menu.allCases {
            #expect(CommandRegistry.commands(in: menu).isEmpty)
        }
    }

    @Test func commandsSortByOrderThenID() {
        fresh()
        CommandRegistry.register(.init(id: "zed", menu: .view, order: 0, titleKey: "common_close") { _ in })
        CommandRegistry.register(.init(id: "abc", menu: .view, order: 0, titleKey: "common_close") { _ in })
        CommandRegistry.register(.init(id: "late", menu: .view, order: 5, titleKey: "common_close") { _ in })
        #expect(CommandRegistry.commands(in: .view).map(\.id) == ["abc", "zed", "late"])
    }

    @Test func registrationIsIdempotentPerID() {
        fresh()
        CommandRegistry.register(.init(id: "one", menu: .file, order: 0, titleKey: "common_close") { _ in })
        CommandRegistry.register(.init(id: "one", menu: .file, order: 9, titleKey: "common_cancel") { _ in })
        let all = CommandRegistry.commands(in: .file)
        #expect(all.count == 1)
        // Last registration wins, exactly as DetailTabRegistry does it, so the integration lane
        // can replace a command without a removal API.
        #expect(all[0].order == 9)
    }

    @Test func aCommandLandsOnlyInItsOwnMenu() {
        fresh()
        CommandRegistry.register(.init(id: "s", menu: .session, order: 0, titleKey: "common_close") { _ in })
        #expect(CommandRegistry.commands(in: .session).count == 1)
        #expect(CommandRegistry.commands(in: .view).isEmpty)
    }

    @Test func enablementDefaultsToAlwaysOn() {
        fresh()
        let model = AppModel()
        CommandRegistry.register(.init(id: "s", menu: .session, order: 0, titleKey: "common_close") { _ in })
        #expect(CommandRegistry.commands(in: .session)[0].isEnabled(model))
    }
}
```

`native/Apps/ShepherdMac/Tests/SettingsSceneTests.swift`:

```swift
import SwiftUI
import Testing

@testable import Shepherd

@MainActor
struct SettingsSceneTests {
    private struct Pane: SettingsPane {
        let id: String
        let order: Int
        var title: String { L.t("common_close") }
        var systemImage: String { "gear" }
        func makeView(app: AppModel) -> AnyView { AnyView(EmptyView()) }
    }

    @Test func anEmptyRegistryResolvesToThePlaceholder() {
        SettingsPaneRegistry.reset()
        #expect(SettingsPaneRegistry.panes.isEmpty)
        #expect(SettingsPaneRegistry.resolution == .placeholder)
    }

    @Test func panesSortByOrderThenID() {
        SettingsPaneRegistry.reset()
        SettingsPaneRegistry.register(Pane(id: "workspace", order: 10))
        SettingsPaneRegistry.register(Pane(id: "about", order: 10))
        SettingsPaneRegistry.register(Pane(id: "general", order: 0))
        #expect(SettingsPaneRegistry.panes.map(\.id) == ["general", "about", "workspace"])
        #expect(SettingsPaneRegistry.resolution == .panes)
    }

    @Test func registrationIsIdempotentPerID() {
        SettingsPaneRegistry.reset()
        SettingsPaneRegistry.register(Pane(id: "general", order: 0))
        SettingsPaneRegistry.register(Pane(id: "general", order: 7))
        #expect(SettingsPaneRegistry.panes.count == 1)
        #expect(SettingsPaneRegistry.panes[0].order == 7)
    }
}
```

`native/Apps/ShepherdMac/Tests/StreamRegistrationsTests.swift`:

```swift
import Testing

@testable import Shepherd

@MainActor
struct StreamRegistrationsTests {
    /// The whole point of the scene/model split: a Settings pane or a menu command registered by
    /// `installAll(into:)` would be registered AFTER `ShepherdApp.body` had already read the
    /// registry, and neither registry is `@Observable`, so it would never appear. `installScene()`
    /// is what runs first — from `ShepherdApp.init()`, before any Scene exists.
    @Test func installSceneNeedsNoModelAndIsIdempotent() {
        CommandRegistry.reset()
        SettingsPaneRegistry.reset()
        StreamRegistrations.installScene()
        let firstCommands = MenuCommand.Menu.allCases.map { CommandRegistry.commands(in: $0).count }
        let firstPanes = SettingsPaneRegistry.panes.count
        StreamRegistrations.installScene()
        #expect(MenuCommand.Menu.allCases.map { CommandRegistry.commands(in: $0).count } == firstCommands)
        #expect(SettingsPaneRegistry.panes.count == firstPanes)
    }

    @Test func installAllIsStillIdempotentOverAModel() {
        let model = AppModel()
        StreamRegistrations.installAll(into: model)
        StreamRegistrations.installAll(into: model)
        // `AppModel.register(_:)` is keyed by type and a slot assignment is an overwrite, so a
        // second pass must change nothing. There is no store, so no extension is built.
        #expect(model.store == nil)
    }
}
```

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests 2>&1 | tail -5
```

Expected: compile failures naming `MenuCommand`, `CommandRegistry`, `SettingsPane`,
`SettingsPaneRegistry` and `StreamRegistrations.installScene`.

- [ ] **Step 2: Write `CommandRegistry.swift`**

```swift
import SwiftUI

/// A menu-bar command a stream contributes.
///
/// A value, not a view: the registry is read while `ShepherdApp.body` is evaluated, and a stream
/// that wanted to hand over a `View` would have to reach the model from outside the environment.
/// `action` and `isEnabled` take the `AppModel` explicitly instead, so the command is testable
/// without hosting anything.
///
/// `Sendable` is free — every stored member is either a value or a `@MainActor` closure over one.
@MainActor
struct MenuCommand: Identifiable, Sendable {
    /// Which top-level menu the item lands in. SwiftUI's `CommandGroup` placements are fixed, so
    /// this enum is the whole vocabulary: a stream picks one of five rather than naming a
    /// `CommandGroupPlacement`, which would let two streams disagree about where "Session" is.
    enum Menu: String, CaseIterable, Sendable {
        case file, view, session, window, help
    }

    /// Registry key. Unique per process; the last registration for an id wins.
    let id: String
    let menu: Menu
    /// Ascending sort key within the menu; ties break on `id`, so the order never depends on
    /// dictionary iteration.
    let order: Int
    /// Read through `L.t(_:)` at render time, never stored, so a language change needs no
    /// re-registration. A `StaticString` because every catalog key in this app is a literal.
    let titleKey: StaticString
    /// `nil` for no shortcut. Spelled as a key equivalent plus modifiers rather than a
    /// `KeyboardShortcut` so two commands' shortcuts can be compared in a test.
    let shortcut: Shortcut?
    /// Whether the item is selectable right now. Defaults to always.
    let isEnabled: @MainActor (AppModel) -> Bool
    let action: @MainActor (AppModel) -> Void

    struct Shortcut: Equatable, Sendable {
        let key: Character
        let shift: Bool
        let option: Bool

        init(_ key: Character, shift: Bool = false, option: Bool = false) {
            self.key = key
            self.shift = shift
            self.option = option
        }

        /// Command is implied — every menu shortcut in this app carries it.
        var eventModifiers: EventModifiers {
            var modifiers: EventModifiers = [.command]
            if shift { modifiers.insert(.shift) }
            if option { modifiers.insert(.option) }
            return modifiers
        }
    }

    init(
        id: String, menu: Menu, order: Int, titleKey: StaticString,
        shortcut: Shortcut? = nil,
        isEnabled: @escaping @MainActor (AppModel) -> Bool = { _ in true },
        action: @escaping @MainActor (AppModel) -> Void
    ) {
        self.id = id
        self.menu = menu
        self.order = order
        self.titleKey = titleKey
        self.shortcut = shortcut
        self.isEnabled = isEnabled
        self.action = action
    }
}

/// Where streams hang their menu commands.
///
/// Per-process main-actor state, exactly like `DetailTabRegistry`: registration happens once at
/// launch — from `StreamRegistrations.installScene()`, called by `ShepherdApp.init()` — and every
/// read is a SwiftUI body evaluation. It is deliberately NOT `@Observable`: a registry mutated
/// after the scene was built would not refresh the menu anyway, so the fix is to register early,
/// not to make the read reactive and pretend late registration works.
@MainActor
enum CommandRegistry {
    private static var registered: [String: MenuCommand] = [:]

    /// Idempotent per id — the last registration wins, so the integration lane can replace a
    /// command without a removal API.
    static func register(_ command: MenuCommand) { registered[command.id] = command }

    /// This menu's commands, ordered by `order` then `id`.
    static func commands(in menu: MenuCommand.Menu) -> [MenuCommand] {
        registered.values
            .filter { $0.menu == menu }
            .sorted { ($0.order, $0.id) < ($1.order, $1.id) }
    }

    /// Tests and previews only.
    static func reset() { registered.removeAll() }
}

/// Renders one menu's commands. Pulled out of `ShepherdApp` so the `.commands { }` builder stays a
/// list of five identical lines and a stream never has to touch it.
struct MenuCommandItems: View {
    let menu: MenuCommand.Menu
    @Environment(AppModel.self) private var app

    var body: some View {
        ForEach(CommandRegistry.commands(in: menu)) { command in
            Button(L.t(command.titleKey)) { command.action(app) }
                .disabled(!command.isEnabled(app))
                .modifier(OptionalShortcut(shortcut: command.shortcut))
        }
    }
}

/// `.keyboardShortcut` has no "none" argument, so the choice is a modifier rather than a ternary
/// inside the button body — a ternary there would need both branches to be the same `View` type.
private struct OptionalShortcut: ViewModifier {
    let shortcut: MenuCommand.Shortcut?

    func body(content: Content) -> some View {
        if let shortcut {
            content.keyboardShortcut(
                KeyEquivalent(shortcut.key), modifiers: shortcut.eventModifiers)
        } else {
            content
        }
    }
}
```

- [ ] **Step 3: Write `SettingsScene.swift`**

```swift
import SwiftUI

/// A pane in the app's `Settings` scene. Streams register one each instead of editing
/// `ShepherdApp`, which is how S6's notification prefs and S12's five panes coexist without either
/// touching the other's file.
///
/// Mirrors `DetailTab` deliberately, down to `order` and the `makeView` signature: two registries
/// with different shapes would be two things to learn for no gain.
protocol SettingsPane: Identifiable, Sendable where ID == String {
    /// Registry key: "general", "notifications", "workspace", "clis", "access", "diagnose".
    var id: String { get }
    /// Read through `L.t(...)` at render time, never stored.
    var title: String { get }
    var systemImage: String { get }
    /// Ascending sort key; ties break on `id`.
    var order: Int { get }

    @MainActor func makeView(app: AppModel) -> AnyView
}

/// Where streams hang their settings panes. Same contract as `CommandRegistry`: registered from
/// `StreamRegistrations.installScene()` before any Scene exists, read during body evaluation.
@MainActor
enum SettingsPaneRegistry {
    /// What the Settings scene will draw. Named rather than decided inline, for the same reason
    /// `SidebarSlot.Resolution` is: the choice is assertable without hosting a view.
    enum Resolution: Equatable {
        /// Nothing registered — the scene shows the "no settings yet" placeholder. This is what
        /// ships until S6 moves its panel over and S12 lands the rest.
        case placeholder
        /// One or more panes.
        case panes
    }

    private static var registered: [String: any SettingsPane] = [:]

    /// Idempotent per id — the last registration wins.
    static func register(_ pane: any SettingsPane) { registered[pane.id] = pane }

    static var panes: [any SettingsPane] {
        registered.values.sorted { ($0.order, $0.id) < ($1.order, $1.id) }
    }

    static var resolution: Resolution { registered.isEmpty ? .placeholder : .panes }

    /// Tests and previews only.
    static func reset() { registered.removeAll() }
}

/// The body of the `Settings` scene.
///
/// A `TabView` rather than a `NavigationSplitView`: macOS settings windows are tabbed, and the
/// placeholder branch keeps ⌘, from opening an empty window before any pane exists — an empty
/// settings window reads as a broken build, which is exactly the report milestone 2 got for the
/// single-tab detail pane.
struct SettingsSceneView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        Group {
            switch SettingsPaneRegistry.resolution {
            case .placeholder:
                VStack(spacing: 8) {
                    Text(verbatim: L.t("native_settings_placeholder_title"))
                        .font(.headline)
                    Text(verbatim: L.t("native_settings_placeholder_body"))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(32)
                .accessibilityIdentifier("settings-placeholder")
            case .panes:
                TabView {
                    ForEach(SettingsPaneRegistry.panes, id: \.id) { pane in
                        pane.makeView(app: app)
                            .tabItem { Label(pane.title, systemImage: pane.systemImage) }
                            .tag(pane.id)
                    }
                }
                .accessibilityIdentifier("settings-panes")
            }
        }
        .frame(minWidth: 520, minHeight: 360)
    }
}
```

- [ ] **Step 4: Split `StreamRegistrations` and wire the scene**

`StreamRegistrations.swift` gains a second entry point and keeps the first unchanged:

```swift
    /// Menu commands and settings panes, registered before any Scene exists.
    ///
    /// Called from `ShepherdApp.init()`, because `ShepherdApp.body` reads both registries while the
    /// scene is being constructed — which is BEFORE `RootView`'s `.task` runs `installAll(into:)`.
    /// Neither registry is `@Observable`, so anything registered later simply never appears.
    ///
    /// Model-free on purpose: at `init()` time there is no store, no activation and no
    /// `NSApp.mainMenu`. A stream that needs the model reaches it through the `AppModel` a
    /// `MenuCommand`'s `action` is handed at invocation time. `NotificationsStream.install(app)`
    /// stays in `installAll(into:)` for exactly this reason — it touches `NSApp.mainMenu`, which
    /// is nil here.
    ///
    /// Idempotent by construction (both registries are keyed dictionaries), so a second call is a
    /// no-op.
    static func installScene() {
        // S12 adds `SettingsFeature.installScene()` here; S7–S11 add their command rows.
        // Empty on this branch, and that is the shipped state: `SettingsPaneRegistry.resolution`
        // is `.placeholder` and every menu is empty, which is what the tests assert.
    }
```

`ShepherdApp.swift`: call it from `init()` and add the scene plus the commands.

```swift
    init() {
        let launch = LaunchEnvironment.configuration()
        let isolation = launch.isIsolated ? IsolatedLaunch(configuration: launch) : nil
        self.isolation = isolation
        _model = State(initialValue: isolation?.makeModel() ?? AppModel())
        // Before `body` is first evaluated — see StreamRegistrations.installScene().
        StreamRegistrations.installScene()
        Log.app.info("Shepherd for Mac starting — \(launch.logDescription, privacy: .public)")
    }

    var body: some Scene {
        WindowGroup("Shepherd") {
            RootView(startIsolatedSeed: isolation?.startLiveSeedIfNeeded)
                .environment(model)
                .frame(minWidth: 900, minHeight: 600)
        }
        .defaultSize(width: 1100, height: 720)
        .windowResizability(.contentMinSize)
        .commands {
            CommandGroup(after: .newItem) { MenuCommandItems(menu: .file) }
            CommandGroup(after: .toolbar) { MenuCommandItems(menu: .view) }
            CommandMenu(L.t("native_menu_session")) { MenuCommandItems(menu: .session) }
            CommandGroup(after: .windowArrangement) { MenuCommandItems(menu: .window) }
            CommandGroup(replacing: .help) { MenuCommandItems(menu: .help) }
        }

        Settings {
            SettingsSceneView()
                .environment(model)
        }
    }
```

`MenuCommandItems` reads `AppModel` from the environment, and a `Scene`'s `.commands` builder does
**not** inherit the `WindowGroup`'s environment — so each of the five call sites is inside a view
that SwiftUI hosts in the menu bar with the app's environment. On macOS 15 a `.commands` view does
receive `@Environment` values injected on the scene, which is why `.environment(model)` is applied
to `RootView` **and** to `SettingsSceneView`; if a menu item ever reads a nil model, move
`.environment(model)` onto the `WindowGroup` itself rather than onto its content.

- [ ] **Step 5: Add the three placeholder strings**

`ui/messages/en.json` (append; union merge driver):

```json
  "native_menu_session": "Session",
  "native_settings_placeholder_body": "Settings panes arrive with the settings stream.",
  "native_settings_placeholder_title": "Nothing to configure yet"
```

`ui/messages/de.json`:

```json
  "native_menu_session": "Sitzung",
  "native_settings_placeholder_body": "Die Einstellungsbereiche kommen mit dem Settings-Stream.",
  "native_settings_placeholder_title": "Noch nichts einzustellen"
```

Add all three to `KEYS_CORE` in `native/scripts/gen-strings.ts`, alphabetically — they belong to the
shell, not to a stream, and a key in two arrays fails `duplicateKeys`.

- [ ] **Step 6: Run green, build, commit**

```bash
bun run check:strings && (cd ui && bun run check:i18n) \
  && ./native/scripts/test-app.sh -only-testing:ShepherdTests 2>&1 | tail -3 \
  && ./native/scripts/build-app.sh 2>&1 | tail -3
```

Expected: the catalog regenerates, the i18n gate passes, `** TEST SUCCEEDED **`,
`** BUILD SUCCEEDED **`. Open the app once and press ⌘, — the placeholder window appears and the
menu bar has an empty **Session** menu. An empty `CommandMenu` renders as a disabled title, which is
the shipped state until a stream fills it.

```bash
git add native/Apps/ShepherdMac/Sources/App/CommandRegistry.swift \
  native/Apps/ShepherdMac/Sources/App/SettingsScene.swift \
  native/Apps/ShepherdMac/Sources/App/StreamRegistrations.swift \
  native/Apps/ShepherdMac/Sources/App/ShepherdApp.swift \
  native/Apps/ShepherdMac/Tests/CommandRegistryTests.swift \
  native/Apps/ShepherdMac/Tests/SettingsSceneTests.swift \
  native/Apps/ShepherdMac/Tests/StreamRegistrationsTests.swift \
  native/scripts/gen-strings.ts ui/messages/en.json ui/messages/de.json \
  native/Apps/ShepherdMac/Resources/Localizable.xcstrings
git commit -m "feat(mac): settings scene and menu-command seams"
```

---

### Task 6: `NewSessionSlot` and the create sheet's extras hook

**Files:** create `native/Apps/ShepherdMac/Sources/App/NewSessionSlot.swift` and
`native/Apps/ShepherdMac/Tests/NewSessionSlotTests.swift`; modify
`native/Apps/ShepherdMac/Sources/Main/NewSessionSheet.swift`.

**Interfaces:**
- Consumes: `CreateSessionRequest` (with Task 4's six new fields), `AppModel`, `SandboxProfile`.
- Produces: `NewSessionExtras`, `NewSessionSlot.content`, `NewSessionSlot.options`,
  `NewSessionSlot.Resolution`.

**Why two hooks.** S11's first task (inventory L2) is the six `CreateSessionRequest` fields the
contract already carries and nothing renders — `planGateEnabled`, `autopilotEnabled`,
`sandboxProfile`, `plain`, `force`, `images`. That is additive: the existing sheet is right, it is
just missing controls. `options` lets S11 land it with no contract work and no ownership transfer.
The full composer is a replacement, and that is `content`. Both exist so the cheapest task does not
have to wait for the most expensive one.

- [ ] **Step 1: Write the failing tests**

`native/Apps/ShepherdMac/Tests/NewSessionSlotTests.swift`:

```swift
import ShepherdKit
import SwiftUI
import Testing

@testable import Shepherd

@MainActor
struct NewSessionSlotTests {
    private func base() -> CreateSessionRequest {
        CreateSessionRequest(repoPath: "/r", baseBranch: "main", prompt: "p")
    }

    @Test func anUntouchedExtrasBlockChangesNothing() {
        let extras = NewSessionExtras()
        var request = base()
        extras.apply(to: &request)
        // Every field stays nil/absent: an operator who never opens the extras section must send
        // byte-for-byte what Gate 2 sent, so the server's own defaults still apply.
        #expect(request.planGateEnabled == nil)
        #expect(request.autopilotEnabled == nil)
        #expect(request.sandboxProfile == nil)
        #expect(request.plain == nil)
        #expect(request.force == nil)
        #expect(request.images == nil)
    }

    @Test func setValuesReachTheRequest() {
        let extras = NewSessionExtras()
        extras.planGateEnabled = true
        extras.autopilotEnabled = false
        extras.sandboxProfile = .standard
        extras.plain = true
        extras.force = true
        extras.images = ["a.png"]
        var request = base()
        extras.apply(to: &request)
        #expect(request.planGateEnabled == true)
        #expect(request.autopilotEnabled == false)
        #expect(request.sandboxProfile == .standard)
        #expect(request.plain == true)
        #expect(request.force == true)
        #expect(request.images == ["a.png"])
    }

    @Test func anEmptyImageListIsNotSent() {
        let extras = NewSessionExtras()
        extras.images = []
        var request = base()
        extras.apply(to: &request)
        // `[]` and "absent" mean the same thing to the server, and sending `[]` would make an
        // attachmentNames length check trivially pass for the wrong reason (src/validate.ts:287).
        #expect(request.images == nil)
    }

    @Test func applyNeverOverwritesAFieldTheSheetAlreadySet() {
        let extras = NewSessionExtras()
        var request = base()
        request.planGateEnabled = false
        extras.apply(to: &request)
        // extras.planGateEnabled is still nil, so the sheet's own value survives. A blind
        // assignment here would silently undo whatever a replacement composer had decided.
        #expect(request.planGateEnabled == false)
    }

    @Test func resolutionFollowsTheContentSlot() {
        NewSessionSlot.reset()
        #expect(NewSessionSlot.resolution == .fallback)
        NewSessionSlot.content = { _ in AnyView(EmptyView()) }
        #expect(NewSessionSlot.resolution == .slot)
        NewSessionSlot.reset()
        #expect(NewSessionSlot.resolution == .fallback)
    }
}
```

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/NewSessionSlotTests 2>&1 | tail -5
```

Expected: compile failures naming `NewSessionExtras` and `NewSessionSlot`.

- [ ] **Step 2: Write `NewSessionSlot.swift`**

```swift
import Observation
import ShepherdKit
import SwiftUI

/// The `CreateSessionRequest` fields the contract already carries but the built-in sheet does not
/// show (inventory L2).
///
/// S0 owns the type because `CreateSessionRequest` is a core schema outside every stream block; a
/// stream owns the controls that write into it. `apply(to:)` is what the built-in sheet calls just
/// before it sends, so a stream's extras land without the stream touching `submit()`.
///
/// **Every field is optional and `apply` writes only what was set.** A blind assignment would undo
/// a value the sheet — or a replacement composer — had already decided, and "the operator did not
/// touch this control" must stay distinguishable from "the operator chose false".
@Observable
@MainActor
final class NewSessionExtras {
    /// nil = use the repo/global default. The server treats false as an explicit opt-out.
    var planGateEnabled: Bool?
    var autopilotEnabled: Bool?
    var sandboxProfile: SandboxProfile?
    /// nil = the server default. `plain` starts the agent without Shepherd's prompt scaffolding.
    var plain: Bool?
    /// nil = respect the usage-hold gate. true bypasses it and spawns immediately, which is why it
    /// is a deliberate opt-in rather than a default.
    var force: Bool?
    /// Staged attachment paths. Empty and absent mean the same thing to the server, so an empty
    /// list is not sent — see `apply(to:)`.
    var images: [String] = []

    init() {}

    /// Folds the operator's choices into the outgoing request. Called by the built-in sheet
    /// immediately before `store.create(_:)`.
    func apply(to request: inout CreateSessionRequest) {
        if let planGateEnabled { request.planGateEnabled = planGateEnabled }
        if let autopilotEnabled { request.autopilotEnabled = autopilotEnabled }
        if let sandboxProfile { request.sandboxProfile = sandboxProfile }
        if let plain { request.plain = plain }
        if let force { request.force = force }
        if !images.isEmpty { request.images = images }
    }
}

/// How a stream extends or replaces the New Task sheet without owning
/// `Sources/Main/NewSessionSheet.swift`.
///
/// Two hooks on purpose. `options` is additive — extra controls inside the built-in form, bound to
/// the `NewSessionExtras` the built-in submit path already folds in — and is what lands the six
/// contract-legal create fields with no contract work at all. `content` replaces the whole body and
/// is what a real composer takes. A stream that sets `content` owns everything and `options` is
/// ignored.
@MainActor
enum NewSessionSlot {
    /// What the sheet will render. Named rather than inferred at the call site, so the choice is
    /// assertable without hosting a view — same reason as `SidebarSlot.Resolution`.
    enum Resolution: Equatable {
        /// The built-in form ships, plus `options` if set.
        case fallback
        /// A stream has taken the whole sheet.
        case slot
    }

    static var content: (@MainActor (AppModel) -> AnyView)?

    /// Extra controls rendered inside the built-in form, below the effort picker and above the
    /// prompt editor. The closure is handed the sheet's own `NewSessionExtras` instance, which
    /// lives for as long as the sheet does.
    static var options: (@MainActor (NewSessionExtras) -> AnyView)?

    static var resolution: Resolution { content == nil ? .fallback : .slot }

    /// Tests and previews only.
    static func reset() {
        content = nil
        options = nil
    }
}
```

- [ ] **Step 3: Wire the sheet**

Three edits in `Sources/Main/NewSessionSheet.swift`, and nothing else in the file changes.

Add the state, beside the other `@State`s:

```swift
    /// The contract-legal create fields the built-in form does not show. Owned here so the sheet's
    /// lifetime is the extras' lifetime; filled by `NewSessionSlot.options` when a stream sets it.
    @State private var extras = NewSessionExtras()
```

Wrap the body so a replacement takes over, and render the options hook inside the form. Replace the
opening of `var body`:

```swift
    var body: some View {
        if let content = NewSessionSlot.content {
            content(app)
        } else {
            builtInBody
        }
    }

    /// The Gate-2 sheet, unchanged apart from the options hook. Split out rather than wrapped in
    /// place so the replacement branch above is one line and this stays diff-clean for whoever
    /// reads it next.
    private var builtInBody: some View {
        VStack(alignment: .leading, spacing: 14) {
```

— the rest of the existing body is untouched. Inside the `Form`, after the effort `Picker`:

```swift
                if let options = NewSessionSlot.options {
                    options(extras)
                }
```

And in `submit()`, fold the extras in before the request leaves:

```swift
        var request = CreateSessionRequest(
            repoPath: repoPath,
            baseBranch: trimmedBranch.isEmpty ? Self.defaultBaseBranch : trimmedBranch,
            prompt: prompt,
            agentProvider: providerSelection.provider,
            model: trimmedModel.isEmpty ? nil : trimmedModel,
            effort: effort)
        // Only what the operator actually set — see NewSessionExtras.apply(to:).
        extras.apply(to: &request)
```

(`let request` becomes `var request`; the `Task { … }` below is unchanged.)

- [ ] **Step 4: Run green and commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests 2>&1 | tail -3 \
  && ./native/scripts/build-app.sh 2>&1 | tail -3
```

Expected: `** TEST SUCCEEDED **`, `** BUILD SUCCEEDED **`. With neither hook set the sheet is
byte-identical in behaviour to what Gate 2 shipped, which the existing `NewSessionSheet` tests still
prove.

```bash
git add native/Apps/ShepherdMac/Sources/App/NewSessionSlot.swift \
  native/Apps/ShepherdMac/Sources/Main/NewSessionSheet.swift \
  native/Apps/ShepherdMac/Tests/NewSessionSlotTests.swift
git commit -m "feat(mac): new-session slot and extras hook"
```

---

### Task 7: Two new `SessionSignals` seams

**Files:** modify `native/Apps/ShepherdMac/Sources/App/SessionSignals.swift`; modify
`native/Apps/ShepherdMac/Tests/` — add cases to the existing `SessionSignalsTests.swift` if it
exists, otherwise create it.

**Interfaces:**
- Produces: `SessionSignals.planQuestionsUnanswered` and `SessionSignals.manualStepsOutstanding`,
  both defaulting to the conservative answer, both reset by `reset()`.

- [ ] **Step 1: Write the failing tests**

```swift
    @Test func theTwoNewSeamsDefaultToTheConservativeAnswer() {
        SessionSignals.reset()
        #expect(SessionSignals.planQuestionsUnanswered("sess_x") == false)
        #expect(SessionSignals.manualStepsOutstanding().isEmpty)
    }

    @Test func resetRestoresTheShippedDefaultsAfterAnAssignment() {
        SessionSignals.planQuestionsUnanswered = { _ in true }
        SessionSignals.manualStepsOutstanding = { ["sess_x": 3] }
        SessionSignals.reset()
        #expect(SessionSignals.planQuestionsUnanswered("sess_x") == false)
        #expect(SessionSignals.manualStepsOutstanding().isEmpty)
    }
```

- [ ] **Step 2: Add the seams**

Inside `enum SessionSignals`, beside the two that exist:

```swift
    /// S8's plan-gate model: does this session have a `question-form` block with an unanswered
    /// question? The web's `planQuestionsUnanswered` (`ui/src/lib/tab-signal.svelte.ts:36-47`),
    /// which is drift-locked against the server's twin by `test/fixtures/plan-question-parity.json`.
    ///
    /// Read by S7's row badge and by `NotificationsModel.extraAttention` — the second of the two
    /// thirds of the web's badge count the notifications stream documented as missing. `false`
    /// until S8 lands, which is the conservative answer: no phantom badge.
    static var planQuestionsUnanswered: @MainActor (String) -> Bool = { _ in false }

    /// S9's merge model: session id to the number of outstanding post-merge manual steps, from
    /// `GET /api/manual-steps/outstanding`. Only rows with `clearedAt IS NULL` appear
    /// (`src/store.ts:4084`), so a key's presence IS the "you still owe this repo a step" fact.
    ///
    /// Read by S10's `owed` lens. `[:]` until S9 lands — an empty lens is right, a wrong one is
    /// not.
    static var manualStepsOutstanding: @MainActor () -> [String: Int] = { [:] }
```

and extend `reset()`:

```swift
    static func reset() {
        workingBlocked = { [:] }
        gitMerged = { _ in false }
        planQuestionsUnanswered = { _ in false }
        manualStepsOutstanding = { [:] }
    }
```

`connect(_:)` is **not** extended on this branch: there is no `PlanModel` or `MergeModel` to point
at yet, and a `connect` that resolves a type that does not exist will not compile. The integration
lane adds one line each when S8 and S9 merge.

- [ ] **Step 3: Run green and commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests 2>&1 | tail -3
git add native/Apps/ShepherdMac/Sources/App/SessionSignals.swift \
  native/Apps/ShepherdMac/Tests/SessionSignalsTests.swift
git commit -m "feat(mac): plan-question and manual-step cross-stream seams"
```

---

### Task 8: The `writeBadge` generation stamp (#2396 P1)

**Files:** modify `native/Apps/ShepherdMac/Sources/Notifications/NotificationsModel.swift`; create
`native/Apps/ShepherdMac/Tests/NotificationsBadgeRaceTests.swift`.

**The defect.** `refreshBadge()` is reached from three places that each spawn their own `Task` — the
per-frame `handle(_:)`, the `extraAttention` `didSet`, and `setWindowFocused` — so two
`writeBadge(_:)` calls can be in flight at once. Each suspends on
`await center.setBadgeCount(count)` and then commits `lastBadge = count`. Nothing orders those
commits, so an older count can resume last and leave `lastBadge` recording a number the Dock does
not show; every later refresh that computes that number is then elided and the Dock stays stale
until the count changes twice. The model already has the right pattern for this — `authorizationGeneration`
— and this task applies it to the badge.

**Interfaces:**
- Consumes: `NotificationCenterClient.setBadgeCount(_:)`, the existing `lastBadge` / `isTornDown`.
- Produces: a `badgeGeneration` counter and a `badgeWrites` debug hook so the race is assertable.

- [ ] **Step 1: Write the failing test**

`native/Apps/ShepherdMac/Tests/NotificationsBadgeRaceTests.swift`:

```swift
import Testing

@testable import Shepherd

/// The badge is global to the Dock, so a stale write is not cosmetic: it is the wrong number on the
/// icon until something else moves the count. These tests drive two overlapping writes through a
/// centre whose `setBadgeCount` resumes out of order.
@MainActor
struct NotificationsBadgeRaceTests {
    @Test func anOlderCountNeverCommitsOverANewerOne() async {
        let centre = ReorderingCenter()
        let model = NotificationsModel.forTesting(center: centre)
        // Two refreshes, the first slow. Without a generation stamp the slow one resumes last and
        // records its own count as the truth about a Dock that shows the fast one's.
        centre.delayNext = true
        async let slow: Void = model.setBadgeForTesting(1)
        async let fast: Void = model.setBadgeForTesting(7)
        _ = await (slow, fast)
        #expect(centre.written.last == 7)
        #expect(model.lastBadgeForTesting == 7)
    }

    @Test func aWriteThatLostItsRaceIsNotEvenSent() async {
        let centre = ReorderingCenter()
        let model = NotificationsModel.forTesting(center: centre)
        centre.delayNext = true
        async let slow: Void = model.setBadgeForTesting(1)
        async let fast: Void = model.setBadgeForTesting(7)
        _ = await (slow, fast)
        // The superseded write is dropped at the commit, not before the call — the round trip has
        // already started by the time it is superseded. What must never happen is a COMMIT.
        #expect(model.lastBadgeForTesting == 7)
    }
}
```

`ReorderingCenter` is a local `NotificationCenterClient` fake whose `setBadgeCount` records the
count and, for the first call after `delayNext`, yields the task several times before returning
`true`. Write it in the same file; `NotificationCenterClient`'s existing fake in
`NotificationCenterClient.swift` is the shape to copy.

`NotificationsModel.forTesting(center:)`, `setBadgeForTesting(_:)` and `lastBadgeForTesting` are
`#if DEBUG` shims over the private members, in the same style as the existing `staleOnce` hook in
`SidebarModel` — never reachable outside tests, so they never ship.

- [ ] **Step 2: Stamp the write**

Add beside `authorizationGeneration`:

```swift
    /// Monotonic, bumped by every badge write. Captured before the round trip and compared after,
    /// so only the newest write commits `lastBadge`.
    ///
    /// Three callers reach `refreshBadge()` from their own `Task` — the per-frame `handle(_:)`, the
    /// `extraAttention` didSet and `setWindowFocused` — so two writes can be in flight at once.
    /// Without this, an older count resuming last records itself as the truth about a Dock badge
    /// showing the newer one, and every later refresh that computes that number is elided against
    /// it. The icon then stays wrong until the count changes twice. Same pattern as
    /// `authorizationGeneration`, for the same reason.
    @ObservationIgnored private var badgeGeneration = 0
```

and rewrite `writeBadge(_:)`:

```swift
    private func writeBadge(_ count: Int) async {
        guard lastBadge != count else { return }
        badgeGeneration &+= 1
        let mine = badgeGeneration
        let landed = await center.setBadgeCount(count)
        // A write that was superseded while in flight commits nothing — not `lastBadge = count`
        // (it would be a lie about the Dock) and not `lastBadge = nil` either (that would force the
        // winner's count to be rewritten on the next refresh, one needless XPC round trip per
        // race).
        guard mine == badgeGeneration else { return }
        guard landed, !isTornDown else {
            lastBadge = nil
            return
        }
        lastBadge = count
    }
```

`clearBadge()` is unchanged: it drops `lastBadge` first and then calls `writeBadge(0)`, which takes
its own generation, so a clear racing a refresh is ordered by the same rule.

- [ ] **Step 3: Run green and commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/NotificationsBadgeRaceTests 2>&1 | tail -3 \
  && ./native/scripts/test-app.sh -only-testing:ShepherdTests 2>&1 | tail -3
```

Expected: both `** TEST SUCCEEDED **`. The whole notifications suite must stay green — the elision
behaviour it asserts is unchanged for the single-writer case, which is every existing test.

```bash
git add native/Apps/ShepherdMac/Sources/Notifications/NotificationsModel.swift \
  native/Apps/ShepherdMac/Tests/NotificationsBadgeRaceTests.swift
git commit -m "fix(mac): stamp dock-badge writes so a stale count cannot commit"
```

---

### Task 9: README, full gate sweep, PR

**Files:** modify `native/README.md`.

- [ ] **Step 1: Document the three new seams**

In `native/README.md`'s "Parallel streams: seams and rules" table, add three rows:

```markdown
| A settings pane                  | `SettingsPaneRegistry.register(_:)` with your own `SettingsPane`                      | `ShepherdApp.swift`              |
| A menu-bar command               | `CommandRegistry.register(_:)` with a `MenuCommand`                                   | `ShepherdApp.swift`              |
| New Task fields, or a composer   | `NewSessionSlot.options` (additive) or `.content` (replacement)                       | `NewSessionSheet.swift`          |
```

and add one bullet under "One call site":

```markdown
- **Two registration passes.** `StreamRegistrations.installScene()` runs from `ShepherdApp.init()`,
  before any `Scene` exists, and is where settings panes and menu commands register — `ShepherdApp.body`
  reads both registries while the scene is being built, and neither is `@Observable`, so anything
  registered later never appears. `installAll(into:)` keeps everything that needs the model, and
  everything that touches `NSApp.mainMenu` (which is nil during `init()`).
```

Also update the sentence "Milestone 2 is built by several streams" to name the ten registered
streams, matching `contracts/README.md`.

- [ ] **Step 2: Run every gate this branch can turn red**

```bash
bun run test:contract && bun run check:contract-swift && ./native/scripts/sync-contract.sh --check \
  && bun run check:strings && (cd ui && bun run check:i18n) && bun run lint && bun run typecheck \
  && bun run test && swift test --package-path native \
  && git checkout -- native/Package.resolved \
  && ./native/scripts/test-app.sh -only-testing:ShepherdTests \
  && ./native/scripts/build-app.sh
```

Expected in order: contract tests pass · no derived-file diff · `sync-contract: up to date` ·
`Localizable.xcstrings is up to date` · i18n gate passes · eslint clean · `tsc` clean · root suite
passes · `swift test` passes · `** TEST SUCCEEDED **` · `** BUILD SUCCEEDED **`. Never `bun test`.

- [ ] **Step 3: Prove the ownership rule was kept**

```bash
git diff --name-only origin/main...HEAD | sort
```

Expected: exactly the files in "File ownership" and nothing else. `AppModel.swift`,
`MainWindow.swift`, `SessionStore.swift`, `ServerEvent.swift`, `project.yml` and `native.yml` must
not appear. `project.yml` needs no edit: its `sources: - path: Sources` entry globs the new files.

- [ ] **Step 4: Open the PR**

```bash
git push --no-verify -u origin feat/native-s0-prep-2
gh pr create --base main --title "chore(native): milestone-3 seams, manifest and harness" --body "$(cat <<'EOF'
Stream S0-prep-2. Everything the six milestone-3 streams would otherwise fight over, landed once.

## What landed
- **Contract plumbing:** `STREAM_NAMES` grows to ten and eighteen empty marker pairs are placed, so
  `herd`, `plan`, `merge`, `queues`, `compose` and `settings` each own a block in all three sections.
- **Harness:** thirteen optional `AppDeps` wired into `test/contract/deps.ts` behind the existing
  swap-a-method `stubs` contract, plus an upload-size seam and a real `git init`'d `validRepo`.
  Without them `GET /api/git` answers `{}`, `GET /api/issues` answers an empty listing,
  `POST /api/shape` answers 503 and `GET /api/branches` fails on a directory that is not a
  repository — a stream could prove a status code but not the payload it declared.
- **Contract:** `UsageLimits.observed` and the six `CreateSessionRequest` fields that are already in
  the server's `ALLOWED_KEYS`. Both are core schemas two streams need, so neither stream edits them.
- **App seams:** a SwiftUI `Settings` scene over a `SettingsPaneRegistry`, a `CommandRegistry` +
  `MenuCommandItems` over five `CommandGroup`s, and `NewSessionSlot` with an additive `options` hook
  and a replacement `content` hook. `StreamRegistrations` splits into a model-free `installScene()`
  called from `ShepherdApp.init()` and the existing `installAll(into:)`.
- **Two new `SessionSignals` seams** (`planQuestionsUnanswered`, `manualStepsOutstanding`), both
  defaulting to the conservative answer.
- **Fix:** Dock-badge writes are generation-stamped, so a write superseded mid-flight can no longer
  commit a count the Dock is not showing (Codex P1 on #2396).

## Deliberate decisions
- **`terminal` is not added to `CreateSessionRequest`.** `POST /api/sessions` is a union whose
  clean-terminal arm is exactly `{repoPath, terminal: true}`; expressing it needs a `oneOf`, which
  is a shape change and belongs with S11.
- **No iOS placeholder target.** A target no scheme builds proves nothing, and adding one to a
  scheme puts a second `xcodebuild` destination into the blocking CI job. Every milestone-3 view is
  AppKit-free instead, and S12's `Settings` scene retires the one AppKit `NSWindow` in the app.
- **`installScene()` ships empty.** `SettingsPaneRegistry.resolution` is `.placeholder` and every
  menu is empty until a stream fills them — which is what the tests assert.

## Verification
`bun run test:contract` · `bun run check:contract-swift` · `native/scripts/sync-contract.sh --check`
· `bun run check:strings` · `ui && bun run check:i18n` · `bun run lint` · `bun run typecheck` ·
`bun run test` · `swift test --package-path native` ·
`native/scripts/test-app.sh -only-testing:ShepherdTests` · `native/scripts/build-app.sh`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
gh pr checks --watch
```

Expected: every check green, including the `native` workflow's `ShepherdKit` job.

---

## Self-review

**Spec coverage.** The master plan's S0-prep-2 scope lists seven items. `Settings` scene +
`CommandMenu` seam → Task 5. `NewSessionSlot` → Task 6. `stream-blocks.ts` `STREAM_NAMES` → Task 1.
`KEYS_*` split → Task 2. Cross-stream contract (`UsageLimits.observed`, the create fields, with the
ownership decision recorded) → Task 4. S6 `writeBadge` generation stamp → Task 8. iOS placeholder
target → deferred, with the reasoning in the master plan §8 and in the PR body. Two items the scope
implied but did not name are here because six streams would otherwise each hit them: the contract
harness deps (Task 3) and the two `SessionSignals` seams (Task 7). Final gate/PR → Task 9.

**Placeholders.** None. Every code step carries the whole file or the whole block it replaces, and
every command carries its expected output. Three deliberate forward references, each named where it
appears: `StreamRegistrations.installScene()` ships with an empty body (the streams fill it);
`SessionSignals.connect(_:)` is not extended (there is no `PlanModel` or `MergeModel` to resolve
yet); and `NotificationsModel.forTesting` / `setBadgeForTesting` / `lastBadgeForTesting` are
`#if DEBUG` shims whose exact private members the implementer reads off the file.

**Type consistency.** `MenuCommand.Menu`'s five cases are identical in the type, in
`MenuCommandItems`, in `ShepherdApp.body`'s five `CommandGroup`/`CommandMenu` lines and in the
tests. `SettingsPane`'s four requirements match `DetailTab`'s spelling exactly (`id`, `title`,
`systemImage`, `order`, `makeView`), and `SettingsPaneRegistry.Resolution` mirrors
`SidebarSlot.Resolution`'s two-case shape. `NewSessionExtras`'s six fields are the same six in
`apply(to:)`, in the tests and in the `CreateSessionRequest` properties Task 4 leaves alone (all six
were already declared; Task 4 adds a different six). `SessionSignals`'s four seams are declared,
defaulted and reset in one place each. The eleven harness stub names in Task 3's interface, its
assertion list and its `stubs` literal are the same eleven.

**No duplicate claims.** This branch adds no path template and no event name to any block — Task 4's
two changes are property additions to existing core schemas, and Task 1's eighteen markers are
empty. The only new `components.schemas` entries are `ObservedLimitWindow`, `ObservedLimitWindows`,
`IssueRef` and `LaunchUiState`, all outside every marked block, and none of them is a name any
stream's appendix row claims.

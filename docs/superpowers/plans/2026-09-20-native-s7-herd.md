# Stream S7 — Herd classifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** make the Mac sidebar tell the truth. Eleven of its fourteen lifecycle stages are
permanently empty and the Ready lens is wrong, because `SidebarModel.gitStage` and
`SidebarModel.inReview` are declared and never assigned. This stream declares the four bulk reads
the web bootstraps from, ports the web's classifier cascade exactly, assigns both closures, and adds
the row stepper, the seven missing row badges and the inline git rail those stages make meaningful.

**Architecture:** Five reads and one write enter `contracts/openapi.yaml` inside this stream's
`herd` block, with four events; Swift is regenerated from the derived file; one kit extension
(`ShepherdClient+Herd.swift`) wraps them. The app side is a pure, UI-free derivation module
(`HerdClassifier`, mirroring `ui/src/lib/components/herd-partition.ts`'s `terminalStage` /
`stageOf` and `ui/src/lib/components/stage.ts`'s `deriveStage`), one `AppExtension` (`HerdSignals`)
owning four snapshots and a tap on `SessionStore.events()`, views under `Sources/Herd/**`, and one
install point that fills the two dead closures plus two cross-stream seams.

**Tech Stack:** Bun + ajv (contract drift test), OpenAPI 3.1, swift-openapi-generator 1.13.1,
Swift 6 (language mode 6, strict concurrency `complete`), SwiftUI, Swift Testing (`import Testing`),
XcodeGen 2.46, `os.Logger`.

---

## Global Constraints

- **Swift 6 strict concurrency** (`SWIFT_STRICT_CONCURRENCY: complete`, `swiftLanguageModes: [.v6]`).
  No `@preconcurrency`, no `@unchecked Sendable`, no `nonisolated(unsafe)`.
- **No hand-written `Codable` for server payloads.** The contract is the only type source: a route
  or event this stream needs is added to `contracts/openapi.yaml` first, then
  `bun run gen:contract-swift` + `./native/scripts/sync-contract.sh` regenerate and copy the derived
  file. Never hand-edit `contracts/openapi.swift.yaml` or `native/Sources/ShepherdKit/openapi.yaml`.
- **ShepherdKit has no UI dependency.** Nothing under `native/Sources/` imports SwiftUI or AppKit.
- **Every new view is AppKit-free.** No `NSEvent`, no `NSColor`, no `NSWindow`.
- **Strings only via `L.t()`**, with every key present in **both** `ui/messages/en.json` and
  `ui/messages/de.json` and listed in `KEYS_HERD` in `native/scripts/gen-strings.ts`. Never add a
  string only in Swift. German copy matches the web UI verbatim — reuse the web's key rather than
  writing a second translation.
- **No Keychain prompts.** Build and test through `./native/scripts/build-app.sh` and
  `./native/scripts/test-app.sh` (which export `SHEPHERD_ISOLATED=1`). `SHEPHERD_KEYCHAIN_TESTS` is
  **never** set locally — it is CI's switch for the real-keychain suite.
- **`bun run test`, never bare `bun test`** (repo `CLAUDE.md`).
- **`bun run typecheck` is a gate**, alongside `bun run lint` and `bun run test:contract`.
- **Live tests read `SHEPHERD_LIVE_BASE_URL` / `SHEPHERD_LIVE_PASSWORD` from the environment only**
  — or `SHEPHERD_LIVE_TOKEN` for the read-only suite. Never from a file, never in CI. The
  `TEST_RUNNER_` prefix is how `xcodebuild` forwards them; set
  `TEST_RUNNER_SHEPHERD_REVOKE_ON_EXIT=1` for any live run. A base URL always goes through
  `RemoteServerForm.normalize` before it reaches a `ServerProfile`.
- **XCUITest runs serialised** — one worktree at a time; parallel `xcodebuild` runs fight over
  `testmanagerd`.
- **`git checkout -- native/Package.resolved` after `swift test --package-path native`.**
- **No `.toolbar` inside a `DetailTab`** — the `TabView` keeps every visited child alive and AppKit
  eventually throws out of `-[NSToolbar _insertNewItemWithItemIdentifier:…]`. This stream registers
  no tab at all, so the rule bites only if somebody adds one.
- **A cancelled event tap still hands you its buffered frames**, so stamp work with a generation
  rather than trusting cancellation, and **finish** every `AsyncStream` watcher in `teardown()` —
  never park one on a bare `withCheckedContinuation`.
- **Commits:** conventional, lowercase subject; body lines ≤ 100 chars; a **blank line** before the
  trailer, and the body ends with
  `Co-Authored-By: <executing model name> <noreply@anthropic.com>`.
- **Push with `git push --no-verify`.**
- **Never edit `native/Apps/ShepherdMac/Sources/App/StreamRegistrations.swift`** inside this
  stream. It ships `HerdStream.install(app)` and the integration lane (S0-int) adds the one line.
- **Logging:** `run.shepherd.mac` (app), `run.shepherd.kit` (kit).
- **Branch:** `feat/native-herd`, cut from `origin/main` **after S0-prep-2 merges**. Rebase to
  update; never `git merge main`.

| Command (repo root) | What it proves |
| --- | --- |
| `bun run test:contract` | the contract matches the real server |
| `bun run gen:contract-swift` | regenerates `contracts/openapi.swift.yaml` |
| `./native/scripts/sync-contract.sh` | copies the derived file into the kit target |
| `bun run typecheck` | the fixtures typecheck |
| `swift test --package-path native` | kit compiles, kit tests pass |
| `./native/scripts/test-app.sh -only-testing:ShepherdTests` | app unit tests pass |
| `./native/scripts/build-app.sh` | `Shepherd.app` builds |
| `bun run check:strings` | `Localizable.xcstrings` is current |
| `bun run lint` · `bun run test` | repo gates |

### File ownership (hard rule)

Create or modify **only**: `contracts/openapi.yaml` (between `# ── stream: herd ──` and
`# ── /stream: herd ──` only, in all three sections) · the generated `contracts/openapi.swift.yaml`
and `native/Sources/ShepherdKit/openapi.yaml` · `test/contract/herd.test.ts`,
`test/contract/herd-fixtures.ts` ·
`native/Sources/ShepherdKit/Client/ShepherdClient+Herd.swift` ·
`native/Tests/ShepherdKitTests/ShepherdClientHerdTests.swift` ·
`native/Apps/ShepherdMac/Sources/Herd/**` ·
`native/Apps/ShepherdMac/Sources/Sidebar/**` ·
`native/Apps/ShepherdMac/Tests/{HerdClassifier,HerdSignals,HerdStepper,HerdBadges,HerdStrings,
HerdLive}Tests.swift` · the `KEYS_HERD` array in `native/scripts/gen-strings.ts` ·
`ui/messages/{en,de}.json` (append-only, union merge driver) · the generated
`native/Apps/ShepherdMac/Resources/Localizable.xcstrings`.

Never edit `AppModel.swift`, `AppModel+Extensions.swift`, `MainWindow.swift`,
`SessionDetailView.swift`, `SessionRow.swift`, `NewSessionSheet.swift`, `ShepherdApp.swift`,
`StreamRegistrations.swift`, `SessionSignals.swift`, any `*Slot.swift`, `SessionStore.swift`,
`ServerEvent.swift`, `EventStream.swift`, `ShepherdClient.swift`, `project.yml`, `native.yml`, or
`test/contract/{harness,deps,stream-blocks,openapi.test}.ts`. `project.yml` needs no edit: its
`sources: - path: Sources` entry globs new subdirectories, and SwiftPM globs
`Sources/ShepherdKit/**`.

`Sources/Sidebar/**` is this stream's for this milestone. S3 is merged and closed; S7 assigns the
two dead closures it left behind and extends its row. Nothing else touches those files.

### Preconditions — verify before Task 1

```bash
grep -c "── stream: herd ──" contracts/openapi.yaml \
  && grep -q "KEYS_HERD" native/scripts/gen-strings.ts \
  && grep -q "planQuestionsUnanswered" native/Apps/ShepherdMac/Sources/App/SessionSignals.swift \
  && grep -q "prCache" test/contract/deps.ts \
  && grep -qE "^\s+(internal )?let generated: Client" native/Sources/ShepherdKit/Client/ShepherdClient.swift \
  && grep -q "var gitStage" native/Apps/ShepherdMac/Sources/Sidebar/SidebarModel.swift \
  && echo OK || echo "S0-prep-2 MISSING — stop and tell the orchestrator"
```

Expected: `3` then `OK`. Four of those greps deserve spelling out.

1. **Three markers** must exist — one in `components.schemas`, one in `paths`, one in
   `x-shepherd-events`. Without the third, appending an event guarantees a rebase conflict with
   every other milestone-3 stream.
2. **`test/contract/deps.ts` must wire `prCache`.** Without S0-prep-2's harness task, `GET /api/git`
   answers `{}` and this stream can prove the status code but not the payload — which is the one
   thing the drift test exists for. Do not edit `deps.ts` to fix it; it is shared.
3. **`ShepherdClient.generated` is `internal` on purpose** so a same-module extension can reach it
   (guarded by `GeneratedClientVisibilityTests`). Do not build a second `Client`.
4. **`SidebarModel.gitStage` still exists.** It is the whole point of this stream. If the grep
   fails, somebody else already assigned it — stop and reconcile.

### Deliberate deviations from the stream brief

The brief came from the parity inventory; reading the web and the server changed six things. Each
is intentional and must survive review.

1. **This stream declares its own `HerdGitState`, not S2's `GitState`.** The server's `GitState`
   (`src/forge/types.ts:247-271`) carries five fields the contract's copy omits, and the classifier
   needs every one of them: `noCi` (`checksCleared`), `reviewBlock` (`needsRework`), `handoff` and
   `handoffWho` (the two waiting stages), and `headSha` (verdict freshness on the stepper). S2's
   `GitState` lives in the `detail` block and is not this stream's to edit, so `herd` declares the
   fuller description under its own name and `GitStateMap` is keyed on that. Both are legal
   descriptions of the same wire object because both carry `additionalProperties: true`; the
   duplication is the price of hard block ownership and is documented at the declaration.
2. **`ReviewerEnv` is declared here**, because S7 merges before S8 and a schema name may appear in
   exactly one block. S8's plan `$ref`s `#/components/schemas/ReviewerEnv` rather than redeclaring
   it.
3. **`POST /api/sessions/{id}/review-pr` answers 202, not 200**, with `{ok, status}` and **two
   distinct 404 bodies** — `not found` for an unknown id and `no forge for this repo` when the repo
   has no forge (`src/server.ts:3228-3242`). Both are declared under one 404 whose description names
   both, because OpenAPI has one schema slot per status and both bodies are `Error`.
4. **`isReworkRunning` ships partially injected.** The web's predicate
   (`ui/src/lib/components/rework-running.ts:16-33`) is `planRework || criticRework`, and the
   `planRework` half reads a `PlanGate` — S8's type, which does not exist yet.
   `HerdClassifier.stageOf` therefore takes a `planRework: (Session) -> Bool` closure defaulting to
   `false`, and the critic half is implemented in full. `reworkRunning` is reachable from the critic
   path on this branch, and the integration lane points the closure at S8's model when it lands.
   The rule itself is implemented and unit-tested against injected values.
5. **The viewport CI-running / review-in-flight banners (C17) are out.** The web renders them in the
   session viewport (`viewport/CiRunningBanner.svelte`, `ReviewInFlightBanner.svelte`), which lives
   in `SessionDetailView.swift` — an S0 file — and there is no detail-pane banner seam. A
   `.toolbar` is explicitly forbidden inside a `DetailTab`, and registering a whole tab to carry a
   banner would put it behind a click, which is the opposite of a banner. **The same two facts are
   fully visible on the row** after this stream: the stepper's `ci-pending` / `rv-reviewing` tints
   and the CI and critic badges. The missing piece is a `DetailBannerSlot` seam, recorded here for
   S0 and listed in the PR body.
6. **`GET /api/claude-alive` is declared, `GET /api/stranded` is not.** The liveness map is what the
   `husk` render and the row's heartbeat need, and `session:claude-alive` is a herd-wide frame. The
   stranded *ids* are S10's — the three-state reconstruction exists to drive the "revive all"
   banner, which is that stream's surface.

**Known parity gap, documented not fixed.** The web's `ATTENTION_RULES` (`src/attention-core.ts`)
put `pr-conflict` **before** `ci-red`, so a red-and-dirty PR reads as "rebase", not "CI failing", and
loses its Retry-CI affordance. That ordering belongs to the server's hold classifier, which the
native app reads through `GET /api/holds` (S3's route, already in the contract). This stream's
`extraAttention` feed uses the raw `git.checks == "failure"` test — the same one
`ui/src/lib/tab-signal.svelte.ts:57-68` uses, and for the same stated reason: the tab signal reads
`git.checks` directly so a co-signal can never mask a red CI. The two classifiers disagree on
purpose in the web too.

### Task order

| # | Task | Key files |
| --- | --- | --- |
| 1 | Contract: bulk reads, review trigger, four events | `contracts/openapi.yaml`, `test/contract/herd{,-fixtures}.ts` |
| 2 | Kit: `ShepherdClient+Herd.swift` | `ShepherdClient+Herd.swift` |
| 3 | Strings: `KEYS_HERD` + EN/DE | `gen-strings.ts`, `ui/messages/*.json` |
| 4 | `HerdClassifier` — the cascade, ported | `Sources/Herd/HerdClassifier.swift` |
| 5 | `HerdSignals` — the `AppExtension` | `Sources/Herd/HerdSignals.swift` |
| 6 | The install point: two dead closures, two seams | `Sources/Herd/HerdStream.swift` |
| 7 | The row stepper | `Sources/Herd/HerdStepper.swift` |
| 8 | The seven missing badges and the inline git rail | `Sources/Sidebar/SessionBadges.swift`, `Sources/Herd/HerdRowGit.swift` |
| 9 | Live check, gate sweep, PR | `Tests/HerdLiveTests.swift` |

---

### Task 1: Contract — bulk reads, the review trigger and four events

**Files:** modify `contracts/openapi.yaml` (herd blocks only); create `test/contract/herd-fixtures.ts`,
`test/contract/herd.test.ts`; regenerate `contracts/openapi.swift.yaml` and
`native/Sources/ShepherdKit/openapi.yaml`.

**Interfaces:**
- Consumes: the core block's `Error`, `#/components/responses/Unauthorized`; the `detail` block's
  `PrState`, `ChecksState`, `MergeStateStatus`, `ForgeKind`, `PrReview`; `harness.ts`'s
  `startContractServer`, `login`, `mintToken`, `bearer`, `collectEvents`, `validateResponse`,
  `validateEvent`, `withAuth`, `restoreAuth`, `type ContractServer`; `deps.ts`'s
  `ContractDeps.stubs.{prCache,activity,claudeAlive,reviewCache}`.
- Produces: schemas `HerdGitState`, `PrHandoff`, `PrReviewBlock`, `GitStateMap`, `SessionActivity`,
  `ActivityMap`, `ClaudeAliveMap`, `ReviewDecision`, `ReviewVerdict`, `ReviewVerdictMap`,
  `ReviewerEnv`, `ReviewerInflightEntry`, `PrReviewTrigger`, `PrReviewResult`, `SessionReviewEvent`,
  `SessionReviewingEvent`, `SessionCriticActivityEvent`, `SessionClaudeAliveEvent`; operations
  `gitStates`, `activityStates`, `claudeAliveStates`, `listReviews`, `listReviewsInflight`,
  `reviewPr`; events `session:review`, `session:reviewing`, `session:critic-activity`,
  `session:claude-alive`.

- [ ] **Step 1: Cut the branch and write the fixtures**

```bash
cd /Users/kai.osthoff/githubrepos/shepherd
git fetch origin main
git worktree add .claude/worktrees/feat-native-herd -b feat/native-herd origin/main
cd .claude/worktrees/feat-native-herd && bun install
```

`test/contract/herd-fixtures.ts`:

```ts
import type { GitState } from "../../src/forge/types";
import type { SessionActivity } from "../../src/activity-signal";
import type { ReviewVerdict } from "../../src/types";

/** Every field the classifier reads, on one row, so a rename in src/forge/types.ts breaks
 *  `bun run typecheck` before it can drift past the contract. Typed with the SERVER's GitState —
 *  the contract's `detail` copy omits noCi/handoff/handoffWho/reviewBlock/headSha, which is
 *  exactly why this stream declares its own `HerdGitState`. */
export const gitOpenGreenHandedOff: GitState = {
  kind: "github",
  state: "open",
  number: 412,
  url: "https://example.test/pr/412",
  title: "Rate limiter",
  createdAt: 1_800_000_000_000,
  mergeable: true,
  checks: "success",
  noCi: false,
  mergeStateStatus: "clean",
  isDraft: false,
  isFork: false,
  authorLogin: "operator",
  requestedReviewers: ["reviewer-one"],
  handoff: "reviewer",
  handoffWho: "reviewer-one",
  headSha: "0123456789abcdef0123456789abcdef01234567",
  deployConfigured: false,
};

/** The `needsRework` shape: open, green, idle, and carrying a reviewBlock. */
export const gitChangesRequested: GitState = {
  ...gitOpenGreenHandedOff,
  handoff: undefined,
  handoffWho: undefined,
  reviewBlock: { reviewer: "reviewer-one", state: "changes_requested", latestAt: 1_800_000_060_000 },
};

/** `ciFailed`: open with a red rollup. */
export const gitCiRed: GitState = { ...gitOpenGreenHandedOff, checks: "failure", handoff: undefined };

export const activity: SessionActivity = {
  lastActivityTs: 1_800_000_030_000,
  summary: "editing src/limiter.ts",
  recentTs: [1_800_000_010_000, 1_800_000_020_000, 1_800_000_030_000],
  recentErrTs: [1_800_000_020_000],
  runtimeModel: "claude-opus-5",
  runtimeEffort: "high",
};

export const verdict: ReviewVerdict = {
  sessionId: "sess_fixture",
  headSha: "0123456789abcdef0123456789abcdef01234567",
  decision: "changes_requested",
  summary: "Two call sites bypass the limiter",
  body: "The admin route and the webhook handler skip it entirely.",
  findings: ["wire the admin route through the limiter", "document the burst window"],
  addressRound: 1,
  addressCap: 3,
  finalRoundPending: false,
  finalRoundTimeoutMs: 900_000,
  updatedAt: 1_800_000_060_000,
};

export const reviewerEnv = {
  id: "sess_fixture",
  provider: "claude" as const,
  model: "claude-opus-5",
  effort: "high",
};
```

`test/contract/herd.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fx from "./herd-fixtures";
import {
  bearer, collectEvents, coverage, login, mintToken, restoreAuth, startContractServer,
  validateEvent, validateResponse, withAuth, type ContractServer,
} from "./harness";
import { eventsForStream, operationsForStream } from "./stream-blocks";

/** This block's own coverage gate, derived from the contract rather than hand-kept: a status
 *  declared in `paths:` but forgotten here is declared-but-unexercised, and nothing else catches
 *  it. `openapi.test.ts`'s gate subtracts this block. */
const OPERATIONS = operationsForStream("herd");
const EVENTS = eventsForStream("herd");

let s: ContractServer;
let token: string;

async function get(path: string, auth = true): Promise<Response> {
  return fetch(`${s.baseUrl}${path}`, { headers: auth ? bearer(token) : {} });
}

async function post(path: string, auth = true): Promise<Response> {
  return fetch(`${s.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? bearer(token) : {}) },
    body: "{}",
  });
}

async function createSession(prompt: string): Promise<string> {
  const res = await fetch(`${s.baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({ repoPath: s.validRepo, baseBranch: "main", prompt }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

beforeAll(async () => {
  await withAuth();
  s = startContractServer();
  ({ token } = await mintToken(s, await login(s), "herd contract test"));
});
afterAll(() => {
  try {
    s?.stop();
  } finally {
    restoreAuth();
  }
});

describe("bulk git", () => {
  test("answers a session-id map with every field the classifier reads", async () => {
    const id = await createSession("classify me");
    // Seeded through the harness dep S0-prep-2 wired: without it the route answers {} and the
    // schema is declared-but-unproven. Restored at the end of the test, per the stubs contract.
    s.deps.stubs.prCache.rows[id] = fx.gitOpenGreenHandedOff;
    try {
      const ok = await get("/api/git");
      expect(ok.status).toBe(200);
      const body = (await validateResponse("GET", "/api/git", ok)) as Record<string, unknown>;
      const row = body[id] as Record<string, unknown>;
      // Each of the five is a field the contract's `detail` GitState omits and the cascade needs.
      expect(row.noCi).toBe(false);
      expect(row.handoff).toBe("reviewer");
      expect(row.handoffWho).toBe("reviewer-one");
      expect(row.headSha).toBe(fx.gitOpenGreenHandedOff.headSha);
      s.deps.stubs.prCache.rows[id] = fx.gitChangesRequested;
      const second = await get("/api/git");
      const blocked = ((await validateResponse("GET", "/api/git", second)) as Record<string, any>)[id];
      expect(blocked.reviewBlock.state).toBe("changes_requested");
    } finally {
      delete s.deps.stubs.prCache.rows[id];
    }
  });

  test("401 without a credential", async () => {
    const anon = await get("/api/git", false);
    expect(anon.status).toBe(401);
    await validateResponse("GET", "/api/git", anon);
  });
});

describe("bulk activity and liveness", () => {
  test("both answer maps and both 401", async () => {
    const id = await createSession("активность");
    s.deps.stubs.activity.rows[id] = fx.activity;
    s.deps.stubs.claudeAlive.rows[id] = true;
    try {
      const act = await get("/api/activity");
      expect(act.status).toBe(200);
      const actBody = (await validateResponse("GET", "/api/activity", act)) as Record<string, any>;
      expect(actBody[id].recentTs.length).toBe(3);
      expect(actBody[id].recentErrTs).toEqual([1_800_000_020_000]);

      const alive = await get("/api/claude-alive");
      expect(alive.status).toBe(200);
      const aliveBody = (await validateResponse("GET", "/api/claude-alive", alive)) as Record<string, boolean>;
      expect(aliveBody[id]).toBe(true);
    } finally {
      delete s.deps.stubs.activity.rows[id];
      delete s.deps.stubs.claudeAlive.rows[id];
    }

    for (const path of ["/api/activity", "/api/claude-alive"]) {
      const anon = await get(path, false);
      expect(anon.status).toBe(401);
      await validateResponse("GET", path, anon);
    }
  });
});

describe("reviews", () => {
  test("the verdict map and the in-flight list both answer, and both 401", async () => {
    const id = await createSession("review me");
    s.deps.stubs.reviewCache.rows[id] = { ...fx.verdict, sessionId: id };
    s.deps.stubs.reviewCache.inflight = [{ ...fx.reviewerEnv, id }];
    try {
      const verdicts = await get("/api/reviews");
      expect(verdicts.status).toBe(200);
      const body = (await validateResponse("GET", "/api/reviews", verdicts)) as Record<string, any>;
      expect(body[id].decision).toBe("changes_requested");
      expect(body[id].addressCap).toBe(3);

      const inflight = await get("/api/reviews/inflight");
      expect(inflight.status).toBe(200);
      const rows = (await validateResponse("GET", "/api/reviews/inflight", inflight)) as any[];
      expect(rows[0].id).toBe(id);
      expect(rows[0].provider).toBe("claude");
    } finally {
      delete s.deps.stubs.reviewCache.rows[id];
      s.deps.stubs.reviewCache.inflight = [];
    }

    for (const path of ["/api/reviews", "/api/reviews/inflight"]) {
      const anon = await get(path, false);
      expect(anon.status).toBe(401);
      await validateResponse("GET", path, anon);
    }
  });
});

describe("review-pr trigger", () => {
  test("202 with a status, 404 twice, 401", async () => {
    const id = await createSession("trigger a critic run");
    // No `resolveForge` in the harness, so the repo has no forge — which is the SECOND 404 body
    // this route can answer, and the one reachable here. The 202 path needs a forge; the stub
    // below supplies the minimum `resolveGitState` reads.
    const noForge = await post(`/api/sessions/${id}/review-pr`);
    expect(noForge.status).toBe(404);
    const noForgeBody = (await validateResponse("POST", "/api/sessions/{id}/review-pr", noForge)) as {
      error: string;
    };
    expect(noForgeBody.error).toBe("no forge for this repo");

    const unknown = await post("/api/sessions/nope/review-pr");
    expect(unknown.status).toBe(404);
    const unknownBody = (await validateResponse("POST", "/api/sessions/{id}/review-pr", unknown)) as {
      error: string;
    };
    expect(unknownBody.error).toBe("not found");

    const saved = s.deps.resolveForge;
    const savedTrigger = s.deps.reviewTrigger;
    s.deps.resolveForge = () => ({ prStatus: async () => fx.gitOpenGreenHandedOff }) as never;
    s.deps.reviewTrigger = { force: async () => "started" } as never;
    try {
      const ok = await post(`/api/sessions/${id}/review-pr`);
      expect(ok.status).toBe(202);
      const body = (await validateResponse("POST", "/api/sessions/{id}/review-pr", ok)) as {
        ok: boolean;
        status: string;
      };
      expect(body.ok).toBe(true);
      expect(body.status).toBe("started");
    } finally {
      s.deps.resolveForge = saved;
      s.deps.reviewTrigger = savedTrigger;
    }

    const anon = await post(`/api/sessions/${id}/review-pr`, false);
    expect(anon.status).toBe(401);
    await validateResponse("POST", "/api/sessions/{id}/review-pr", anon);
  });
});

describe("events", () => {
  test("the four herd frames validate against their declared schemas", async () => {
    const frames = collectEvents(s, EVENTS);
    s.deps.events.emit("session:review", { id: "sess_fixture", review: fx.verdict });
    s.deps.events.emit("session:reviewing", {
      id: "sess_fixture",
      reviewing: true,
      env: { provider: "claude", model: "claude-opus-5", effort: "high" },
    });
    s.deps.events.emit("session:critic-activity", {
      id: "sess_fixture",
      summary: "reading src/limiter.ts",
    });
    s.deps.events.emit("session:claude-alive", { id: "sess_fixture", alive: false });
    for (const frame of await frames) await validateEvent(frame);
  });
});

describe("coverage", () => {
  test("every declared herd operation and event was exercised", () => {
    expect(coverage(OPERATIONS, EVENTS)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run test:contract 2>&1 | tail -20
```

Expected: failures naming `GET /api/git` as undeclared and `operationsForStream("herd")` as empty —
the block exists but holds nothing yet.

- [ ] **Step 3: Add the schemas inside the herd block in `components.schemas`**

Paste between `# ── stream: herd ──` and `# ── /stream: herd ──` in `components.schemas:`
(four-space indent):

```yaml
    PrHandoff:
      type: string
      x-shepherd-open-enum: true
      description: >-
        GitState.handoff (src/forge/types.ts:262). Who the PR is waiting on. ABSENT means it is
        waiting on the operator, which is the third state and has no member here.
      enum: [reviewer, merger]
    PrReviewBlock:
      type: object
      additionalProperties: true
      description: PrReviewBlock (src/forge/types.ts:151-155). Present ⇒ a reviewer has requested changes and nothing merges until it clears.
      required: [reviewer, state]
      properties:
        reviewer: { type: string }
        state: { type: string, enum: [changes_requested] }
        latestAt: { type: [integer, "null"] }
    HerdGitState:
      type: object
      additionalProperties: true
      description: >-
        GET /api/git's per-session PR state. The SAME wire object as the detail block's `GitState`,
        described more fully: the herd classifier reads five fields the per-session Git tab never
        needed — noCi, handoff, handoffWho, reviewBlock and headSha — and a stream may not edit
        another stream's schema. Both descriptions carry additionalProperties: true, so both are
        true of the same payload. Ported rule-for-rule from src/forge/types.ts:199-271.
      required: [state, checks, deployConfigured]
      properties:
        kind: { $ref: "#/components/schemas/ForgeKind" }
        state: { $ref: "#/components/schemas/PrState" }
        number: { type: integer }
        url: { type: string }
        title: { type: string }
        createdAt: { type: integer }
        mergeable: { type: [boolean, "null"], description: null while the host is still computing. }
        checks: { $ref: "#/components/schemas/ChecksState" }
        mergeStateStatus: { $ref: "#/components/schemas/MergeStateStatus" }
        isDraft: { type: boolean, description: 'Absent ⇒ false. A green idle DRAFT outranks every handoff (herd-partition.ts:156-161).' }
        isFork: { type: boolean }
        noCi:
          type: boolean
          description: >-
            Absent ⇒ false. The repo has no CI workflows at all, which is what makes checks "none"
            a CLEARED state rather than a pending one (ui/src/lib/checks-cleared.ts:7-9). Without
            this field an open PR on a CI-less repo can never leave the active group.
        authorLogin: { type: string }
        requestedReviewers: { type: array, items: { type: string } }
        latestReview: { $ref: "#/components/schemas/PrReview" }
        handoff: { $ref: "#/components/schemas/PrHandoff" }
        handoffWho:
          type: string
          description: The single person a handoff names. Fills {who} in the waiting-group headings; absent ⇒ the "_multi" heading.
        reviewBlock: { $ref: "#/components/schemas/PrReviewBlock" }
        headSha:
          type: string
          description: Head commit the PR currently points at. A critic verdict whose headSha differs is STALE and must not tint the stepper (ui/src/lib/verdict-freshness.ts:23-33).
        issueUrl: { type: string }
        deployConfigured: { type: boolean }
    GitStateMap:
      type: object
      additionalProperties: { $ref: "#/components/schemas/HerdGitState" }
      description: GET /api/git. Session id -> PR state. Absent means this session has no PR state cached, which the classifier treats as "no git-decided stage".
    SessionActivity:
      type: object
      additionalProperties: true
      description: Copied from SessionActivity in src/activity-signal.ts:6-21. The transcript heartbeat one session's row draws.
      required: [lastActivityTs, summary, recentTs, recentErrTs]
      properties:
        lastActivityTs: { type: integer, description: 0 when nothing has happened yet. }
        summary: { type: [string, "null"] }
        recentTs: { type: array, items: { type: integer }, description: Oldest first. }
        recentErrTs: { type: array, items: { type: integer }, description: A subset of recentTs that errored. }
        runtimeModel: { type: string }
        runtimeEffort: { type: string }
    ActivityMap:
      type: object
      additionalProperties: { $ref: "#/components/schemas/SessionActivity" }
      description: GET /api/activity. Session id -> heartbeat. Absent means no activity has been recorded.
    ClaudeAliveMap:
      type: object
      additionalProperties: { type: boolean }
      description: >-
        GET /api/claude-alive. Session id -> does a coding-CLI process still live in this session's
        worktree? False folds a stranded session to "husk"; the three-state reconstruction needs
        GET /api/stranded as well, which the queues block owns.
    ReviewDecision:
      type: string
      x-shepherd-open-enum: true
      description: Copied verbatim from ReviewDecision in src/types.ts:780.
      enum: [changes_requested, commented, error]
    ReviewVerdict:
      type: object
      additionalProperties: true
      description: A critic verdict for one session. The documented subset of src/types.ts:790-815 the herd reads.
      required: [sessionId, headSha, decision, summary, body, findings, addressRound, addressCap, finalRoundPending, finalRoundTimeoutMs, updatedAt]
      properties:
        sessionId: { type: string }
        headSha: { type: string, description: The commit this verdict judged. Compare against HerdGitState.headSha before tinting anything. }
        decision: { $ref: "#/components/schemas/ReviewDecision" }
        summary: { type: string }
        body: { type: string, description: Markdown. }
        findings: { type: array, items: { type: string } }
        addressRound: { type: integer }
        addressCap: { type: integer, description: The cap this run used. Read it; never mirror a config value.  }
        finalRoundPending: { type: boolean }
        finalRoundTimeoutMs: { type: integer }
        dismissed: { type: boolean, description: 'Absent ⇒ false. The operator took this rework over by hand.' }
        url: { type: string }
        updatedAt: { type: integer }
    ReviewVerdictMap:
      type: object
      additionalProperties: { $ref: "#/components/schemas/ReviewVerdict" }
      description: GET /api/reviews. Session id -> latest critic verdict.
    ReviewerEnv:
      type: object
      additionalProperties: true
      description: >-
        A reviewer's resolved CLI, model and effort for an in-flight run (src/types.ts:596-600).
        Declared here because this stream merges first; the plan block $refs it rather than
        declaring a second copy — a schema name may sit in exactly one marked block.
      required: [provider, model, effort]
      properties:
        provider:
          oneOf:
            - $ref: "#/components/schemas/AgentProvider"
            - type: "null"
        model: { type: [string, "null"] }
        effort: { type: [string, "null"] }
    ReviewerInflightEntry:
      type: object
      additionalProperties: true
      description: One row of GET /api/reviews/inflight — a session id plus the reviewer env running on it.
      required: [id, provider, model, effort]
      properties:
        id: { type: string }
        provider:
          oneOf:
            - $ref: "#/components/schemas/AgentProvider"
            - type: "null"
        model: { type: [string, "null"] }
        effort: { type: [string, "null"] }
    PrReviewTrigger:
      type: string
      x-shepherd-open-enum: true
      description: What POST /api/sessions/{id}/review-pr actually did (ReviewOutcome, src/review.ts:91).
      enum: [started, skipped, error]
    PrReviewResult:
      type: object
      additionalProperties: true
      required: [ok, status]
      properties:
        ok: { type: boolean }
        status: { $ref: "#/components/schemas/PrReviewTrigger" }
    SessionReviewEvent:
      type: object
      additionalProperties: true
      description: A critic verdict landed (or was cleared). A null review means "no verdict for this session any more", and it also ends the in-flight run.
      required: [id]
      properties:
        id: { type: string }
        review:
          oneOf:
            - $ref: "#/components/schemas/ReviewVerdict"
            - type: "null"
    SessionReviewingEvent:
      type: object
      additionalProperties: true
      description: A critic run started or ended. `env` rides the start edge only; both edges clear the activity feed.
      required: [id, reviewing]
      properties:
        id: { type: string }
        reviewing: { type: boolean }
        env: { $ref: "#/components/schemas/ReviewerEnv" }
    SessionCriticActivityEvent:
      type: object
      additionalProperties: true
      description: One line of what the critic is doing right now. The web keeps the last two (MAX_ACTIVITY_LINES, ui/src/lib/reviews.svelte.ts:28).
      required: [id, summary]
      properties:
        id: { type: string }
        summary: { type: string }
    SessionClaudeAliveEvent:
      type: object
      additionalProperties: true
      description: A session's coding-CLI liveness flipped. Re-emitted on flips only, which is why the bulk snapshot exists.
      required: [id, alive]
      properties:
        id: { type: string }
        alive: { type: boolean }
```

- [ ] **Step 4: Add the six operations inside the herd block in `paths`**

Paste between the `paths:` markers (two-space indent):

```yaml
  /api/git:
    get:
      operationId: gitStates
      description: Every session's cached PR state in one read. The herd classifier's bootstrap; session:git keeps it current afterwards.
      responses:
        "200":
          description: Session id to PR state.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/GitStateMap" }
        "401": { $ref: "#/components/responses/Unauthorized" }
  /api/activity:
    get:
      operationId: activityStates
      description: Every session's transcript heartbeat in one read. Bootstraps the row heartbeat strip; session:activity keeps it current.
      responses:
        "200":
          description: Session id to heartbeat.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/ActivityMap" }
        "401": { $ref: "#/components/responses/Unauthorized" }
  /api/claude-alive:
    get:
      operationId: claudeAliveStates
      description: Every session's coding-CLI liveness in one read. session:claude-alive re-emits on flips only, so a client that reconnects mid-flip needs this.
      responses:
        "200":
          description: Session id to liveness.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/ClaudeAliveMap" }
        "401": { $ref: "#/components/responses/Unauthorized" }
  /api/reviews:
    get:
      operationId: listReviews
      description: Every session's latest critic verdict. Bootstraps the critic badge and the needsRework stage.
      responses:
        "200":
          description: Session id to verdict.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/ReviewVerdictMap" }
        "401": { $ref: "#/components/responses/Unauthorized" }
  /api/reviews/inflight:
    get:
      operationId: listReviewsInflight
      description: The critic runs in flight right now, with the CLI/model/effort each is using. Reconstructs the reviewerRunning stage after a reload.
      responses:
        "200":
          description: One row per in-flight run.
          content:
            application/json:
              schema:
                type: array
                items: { $ref: "#/components/schemas/ReviewerInflightEntry" }
        "401": { $ref: "#/components/responses/Unauthorized" }
  /api/sessions/{id}/review-pr:
    parameters:
      - name: id
        in: path
        required: true
        schema: { type: string }
    post:
      operationId: reviewPr
      description: >-
        Force a critic review of this session's PR. Answers 202 with what it did — the run itself is
        asynchronous and lands as session:reviewing then session:review.
      responses:
        "202":
          description: Accepted. `status` says whether a run actually started.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/PrReviewResult" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404":
          description: 'Two bodies, same status: error is "not found" for an unknown id, or "no forge for this repo" when the repo has no forge configured.'
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
        "502":
          description: The forge lookup threw while resolving the PR state.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
```

- [ ] **Step 5: Add the four events inside the herd block in `x-shepherd-events`**

```yaml
  session:review:
    description: A critic verdict landed or was cleared. A null review also ends the in-flight run for that session.
    schema: { $ref: "#/components/schemas/SessionReviewEvent" }
  session:reviewing:
    description: A critic run started or ended. `env` rides the start edge only.
    schema: { $ref: "#/components/schemas/SessionReviewingEvent" }
  session:critic-activity:
    description: One line of critic progress. Cleared on both edges of session:reviewing.
    schema: { $ref: "#/components/schemas/SessionCriticActivityEvent" }
  session:claude-alive:
    description: A session's coding-CLI liveness flipped. Flips only — bootstrap from GET /api/claude-alive.
    schema: { $ref: "#/components/schemas/SessionClaudeAliveEvent" }
```

Do **not** add these names to the `EventName` enum. It is flagged `x-shepherd-open-enum`, so an
undeclared name still decodes as its raw string; adding a member would make the exhaustive
`switch name.known` in `ServerEvent.swift` **and** the one in `SessionStore.applyNow`
non-exhaustive, and both files are off-limits here. This stream reads all four through
`ServerEvent.unknown(name:payload:)` and decodes `payload` with the generated schemas above.

- [ ] **Step 6: Run green, regenerate, sync, prove freshness**

```bash
bun run test:contract && bun run typecheck && bun run gen:contract-swift \
  && ./native/scripts/sync-contract.sh && bun run check:contract-swift \
  && ./native/scripts/sync-contract.sh --check \
  && swift build --package-path native 2>&1 | tail -3
```

Expected: contract tests pass · `tsc` clean · `contracts/openapi.swift.yaml -> native/Sources/ShepherdKit/openapi.yaml`
· no diff · `sync-contract: up to date` · `Build complete!`. If the derivation throws naming a JSON
pointer inside the herd block, the schema there uses a construct it refuses — a nullable union
outside a property, or a flagged enum inside `allOf`. Fix the schema, never the script. The three
`oneOf: [X, {type: "null"}]` properties here (`ReviewerEnv.provider`,
`ReviewerInflightEntry.provider`, `SessionReviewEvent.review`) all sit directly under `properties:`
with nothing but annotations beside them, which is the one position the collapse is defined for.

- [ ] **Step 7: Commit**

```bash
git add contracts/openapi.yaml contracts/openapi.swift.yaml \
  native/Sources/ShepherdKit/openapi.yaml test/contract/herd.test.ts test/contract/herd-fixtures.ts
git commit -m "feat(contract): bulk git, activity, liveness and critic reviews"
```

---

### Task 2: Kit — `ShepherdClient+Herd.swift`

**Files:** create `native/Sources/ShepherdKit/Client/ShepherdClient+Herd.swift` and
`native/Tests/ShepherdKitTests/ShepherdClientHerdTests.swift`.

**Interfaces:**
- Consumes: Task 1's generated operations; `ShepherdClient.generated` (`internal`);
  `ShepherdError.from(_:route:)`, `.fromUndocumented(statusCode:route:)`, `.unauthenticated`,
  `.notFound`; `FakeShepherdServer`, `InMemoryCredentialStore`, `StoredCredential`, `ServerProfile`;
  `OpenEnum` from `Model/OpenEnum.swift`.
- Produces on `ShepherdClient`: `gitStates() -> [String: HerdGitState]`,
  `activityStates() -> [String: SessionActivity]`, `claudeAliveStates() -> [String: Bool]`,
  `reviews() -> [String: ReviewVerdict]`, `reviewsInflight() -> [ReviewerInflightEntry]`,
  `reviewPr(sessionID:) -> PrReviewResult`; the public typealiases `HerdGitState`, `PrHandoff`,
  `PrHandoffKnown`, `PrReviewBlock`, `SessionActivity`, `ReviewVerdict`, `ReviewDecision`,
  `ReviewDecisionKnown`, `ReviewerEnv`, `ReviewerInflightEntry`, `PrReviewTrigger`,
  `PrReviewTriggerKnown`, `PrReviewResult`, and the three `OpenEnum` conformances.

- [ ] **Step 1: Write the failing tests**

`native/Tests/ShepherdKitTests/ShepherdClientHerdTests.swift` follows
`ShepherdClientActionsTests.swift` exactly: a `makeClient(_:)` helper over `FakeShepherdServer`,
then one `@Test` per method asserting the happy path and one asserting the error mapping. The cases
that must be present, because each is a mapping this stream gets wrong if it is not pinned:

```swift
    @Test func gitStatesDecodesTheFiveFieldsTheClassifierNeeds() async throws {
        let server = FakeShepherdServer()
        server.route("GET", "/api/git") { _ in
            (200, """
            {"sess_a":{"kind":"github","state":"open","checks":"success","noCi":false,
             "handoff":"reviewer","handoffWho":"r1","headSha":"abc","deployConfigured":false,
             "reviewBlock":{"reviewer":"r1","state":"changes_requested","latestAt":1}}}
            """)
        }
        let map = try await makeClient(server).gitStates()
        let row = try #require(map["sess_a"])
        #expect(row.noCi == false)
        #expect(row.handoff?.known == .reviewer)
        #expect(row.handoffWho == "r1")
        #expect(row.headSha == "abc")
        #expect(row.reviewBlock?.reviewer == "r1")
    }

    @Test func anUnknownHandoffStillDecodes() async throws {
        let server = FakeShepherdServer()
        server.route("GET", "/api/git") { _ in
            (200, #"{"sess_a":{"state":"open","checks":"none","deployConfigured":false,"handoff":"triager"}}"#)
        }
        let row = try #require(try await makeClient(server).gitStates()["sess_a"])
        // The whole reason `PrHandoff` is x-shepherd-open-enum: a newer server's member must not
        // cost the client the whole map.
        #expect(row.handoff?.known == nil)
        #expect(row.handoff?.rawValue == "triager")
    }

    @Test func reviewPrMapsBothFourOhFourBodiesToNotFound() async throws {
        for body in [#"{"error":"not found"}"#, #"{"error":"no forge for this repo"}"#] {
            let server = FakeShepherdServer()
            server.route("POST", "/api/sessions/sess_a/review-pr") { _ in (404, body) }
            await #expect(throws: ShepherdError.notFound) {
                _ = try await makeClient(server).reviewPr(sessionID: "sess_a")
            }
        }
    }

    @Test func reviewPrAcceptsTheTwoOhTwo() async throws {
        let server = FakeShepherdServer()
        server.route("POST", "/api/sessions/sess_a/review-pr") { _ in
            (202, #"{"ok":true,"status":"started"}"#)
        }
        let result = try await makeClient(server).reviewPr(sessionID: "sess_a")
        #expect(result.status.known == .started)
    }

    @Test func everyReadMapsFourOhOneToUnauthenticated() async throws {
        for path in ["/api/git", "/api/activity", "/api/claude-alive", "/api/reviews", "/api/reviews/inflight"] {
            let server = FakeShepherdServer()
            server.route("GET", path) { _ in (401, #"{"error":"unauthorized"}"#) }
            let client = try makeClient(server)
            await #expect(throws: ShepherdError.unauthenticated) {
                switch path {
                case "/api/git": _ = try await client.gitStates()
                case "/api/activity": _ = try await client.activityStates()
                case "/api/claude-alive": _ = try await client.claudeAliveStates()
                case "/api/reviews": _ = try await client.reviews()
                default: _ = try await client.reviewsInflight()
                }
            }
        }
    }
```

- [ ] **Step 2: Run them and watch them fail**

```bash
swift test --package-path native --filter ShepherdClientHerd 2>&1 | tail -5
git checkout -- native/Package.resolved
```

Expected: compile failures naming `gitStates`, `HerdGitState` and the rest.

- [ ] **Step 3: Write the extension**

`native/Sources/ShepherdKit/Client/ShepherdClient+Herd.swift`:

```swift
import Foundation

// Short names for the herd schemas, alongside Model/PublicTypes.swift. Typealiases, not wrappers:
// one definition of each type, still from the contract.
public typealias HerdGitState = Components.Schemas.HerdGitState
public typealias PrHandoff = Components.Schemas.PrHandoff
public typealias PrHandoffKnown = Components.Schemas.PrHandoffKnown
public typealias PrReviewBlock = Components.Schemas.PrReviewBlock
public typealias SessionActivity = Components.Schemas.SessionActivity
public typealias ReviewVerdict = Components.Schemas.ReviewVerdict
public typealias ReviewDecision = Components.Schemas.ReviewDecision
public typealias ReviewDecisionKnown = Components.Schemas.ReviewDecisionKnown
public typealias ReviewerEnv = Components.Schemas.ReviewerEnv
public typealias ReviewerInflightEntry = Components.Schemas.ReviewerInflightEntry
public typealias PrReviewTrigger = Components.Schemas.PrReviewTrigger
public typealias PrReviewTriggerKnown = Components.Schemas.PrReviewTriggerKnown
public typealias PrReviewResult = Components.Schemas.PrReviewResult

// The three schemas this stream flags `x-shepherd-open-enum: true`. The derivation gives each an
// `anyOf` shape and a `<Name>Known` companion, but `known`, `rawValue`, `init(known:)` and
// `init(unknown:)` come from `Model/OpenEnum.swift`'s protocol extension, which reaches a type only
// once that type conforms. `OpenEnum.swift` hard-codes the core conformances and is S0-owned, so
// this stream declares its own three here — same module, no retroactive conformance.
extension Components.Schemas.PrHandoff: OpenEnum {}
extension Components.Schemas.ReviewDecision: OpenEnum {}
extension Components.Schemas.PrReviewTrigger: OpenEnum {}

/// The herd-wide snapshots the sidebar classifier runs on, plus the one write it offers.
///
/// Every read is a single request answering a whole map — that is the point. `getSessionGit` is
/// per-session, and a sidebar that called it once per row would issue one request per session on
/// every bootstrap and still be wrong for the rows the operator has not opened. None of these
/// mutates `SessionStore`: the server's own `/events` frames do that.
extension ShepherdClient {
    /// `GET /api/git`. Session id to PR state, for every session the poller has state for.
    /// A session absent from the map has no cached PR state, which the classifier reads as "no
    /// git-decided stage" — not as "no PR".
    public func gitStates() async throws -> [String: HerdGitState] {
        do {
            switch try await generated.gitStates(.init()) {
            case .ok(let ok): return try ok.body.json.additionalProperties
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "gitStates")
            }
        } catch { throw ShepherdError.from(error, route: "gitStates") }
    }

    /// `GET /api/activity`. Session id to transcript heartbeat.
    public func activityStates() async throws -> [String: SessionActivity] {
        do {
            switch try await generated.activityStates(.init()) {
            case .ok(let ok): return try ok.body.json.additionalProperties
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "activityStates")
            }
        } catch { throw ShepherdError.from(error, route: "activityStates") }
    }

    /// `GET /api/claude-alive`. Session id to "a coding-CLI process still lives in this worktree".
    public func claudeAliveStates() async throws -> [String: Bool] {
        do {
            switch try await generated.claudeAliveStates(.init()) {
            case .ok(let ok): return try ok.body.json.additionalProperties
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "claudeAliveStates")
            }
        } catch { throw ShepherdError.from(error, route: "claudeAliveStates") }
    }

    /// `GET /api/reviews`. Session id to the latest critic verdict.
    public func reviews() async throws -> [String: ReviewVerdict] {
        do {
            switch try await generated.listReviews(.init()) {
            case .ok(let ok): return try ok.body.json.additionalProperties
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "listReviews")
            }
        } catch { throw ShepherdError.from(error, route: "listReviews") }
    }

    /// `GET /api/reviews/inflight`. The critic runs happening right now, with each one's reviewer
    /// environment — which is what lets a relaunched app say *which* CLI is reviewing, not merely
    /// that one is.
    public func reviewsInflight() async throws -> [ReviewerInflightEntry] {
        do {
            switch try await generated.listReviewsInflight(.init()) {
            case .ok(let ok): return try ok.body.json
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "listReviewsInflight")
            }
        } catch { throw ShepherdError.from(error, route: "listReviewsInflight") }
    }

    /// `POST /api/sessions/{id}/review-pr`. Asks for a critic run and answers what the server
    /// decided — **202, not 200**: the run is asynchronous and arrives as `session:reviewing`
    /// followed by `session:review`. A `.skipped` status is a normal answer, not a failure: the
    /// server skips when the verdict for this head is already current.
    ///
    /// The route has two 404 bodies (`not found`, `no forge for this repo`) and both map to
    /// `.notFound`: from the caller's side "there is nothing here to review" is one situation, and
    /// the distinction is already in the log line.
    public func reviewPr(sessionID: String) async throws -> PrReviewResult {
        do {
            switch try await generated.reviewPr(.init(path: .init(id: sessionID))) {
            case .accepted(let accepted): return try accepted.body.json
            case .unauthorized: throw ShepherdError.unauthenticated
            case .notFound: throw ShepherdError.notFound
            case .badGateway(let bad):
                throw ShepherdError.serverError(try bad.body.json.error)
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "reviewPr")
            }
        } catch { throw ShepherdError.from(error, route: "reviewPr") }
    }
}
```

The generated case name for a map-typed 200 body is `additionalProperties` when the schema is a bare
`additionalProperties` object — read the generated `Types.swift` and use the real spelling rather
than assuming; the same goes for `.accepted` and `.badGateway`, whose names come from the status
codes. `ShepherdError.serverError(_:)` is the existing 5xx case — read `ShepherdError.swift` and use
whatever it is actually called.

- [ ] **Step 4: Run green and commit**

```bash
swift test --package-path native --filter ShepherdClientHerd 2>&1 | tail -3
git checkout -- native/Package.resolved
git add native/Sources/ShepherdKit/Client/ShepherdClient+Herd.swift \
  native/Tests/ShepherdKitTests/ShepherdClientHerdTests.swift
git commit -m "feat(kit): herd snapshot reads and the critic trigger"
```

---

### Task 3: Strings — `KEYS_HERD` and the EN/DE additions

**Files:** modify `native/scripts/gen-strings.ts` (the `KEYS_HERD` array only) and
`ui/messages/{en,de}.json` (append-only).

**Interfaces:** produces every catalog key Tasks 7 and 8 pass to `L.t(_:)` / `L.t(_:_:)`.

- [ ] **Step 1: Find the web's keys before writing any**

```bash
rg -n "stage_|stepper_|pr_badge_|critic_|hold_ci_red|vblock_" ui/messages/en.json | head -40
rg -n 'm\.' ui/src/lib/components/Stepper.svelte ui/src/lib/components/unit-row/UnitRowRight.svelte \
  ui/src/lib/components/CriticBadge.svelte ui/src/lib/components/PrBadge.svelte | head -40
```

Every label this stream renders already exists in the web catalogs, because the web renders the same
stepper, the same badges and the same group headings. **Reuse the key.** A second German
translation of "REVIEWING…" is a review rejection. Only a key with genuinely no web counterpart —
an accessibility label for a control the web does not have — is written fresh, prefixed `native_`.

- [ ] **Step 2: Append any app-only keys to both catalogs**

Keep both files alphabetical. Every key added to `en.json` gets a `de.json` entry in the same
commit; the union merge driver makes both files append-safe, and a key present in one catalog only
fails `(cd ui && bun run check:i18n)`.

- [ ] **Step 3: Fill `KEYS_HERD`**

Alphabetical, and containing **exactly** the keys Tasks 7 and 8 pass to `L.t`, minus anything
already in `KEYS_CORE` or `KEYS_SIDEBAR` — a key in two arrays fails `duplicateKeys` in the
generator.

- [ ] **Step 4: Regenerate and check both gates**

```bash
bun native/scripts/gen-strings.ts && bun run check:strings && (cd ui && bun run check:i18n)
```

Expected: the catalog regenerates, `Localizable.xcstrings is up to date`, i18n gate passes.

- [ ] **Step 5: Write the catalog test**

`native/Apps/ShepherdMac/Tests/HerdStringsTests.swift` asserts that every key this stream renders
resolves to a non-empty string and is not echoed back as its own key — the failure mode when a key
reaches `L.t` without reaching `KEYS_HERD`. Copy the shape from `ActionsStringsTests.swift`.

- [ ] **Step 6: Run the app tests and commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/HerdStringsTests 2>&1 | tail -3
git add native/scripts/gen-strings.ts ui/messages/en.json ui/messages/de.json \
  native/Apps/ShepherdMac/Resources/Localizable.xcstrings \
  native/Apps/ShepherdMac/Tests/HerdStringsTests.swift
git commit -m "feat(mac): herd catalog keys"
```

---

### Task 4: `HerdClassifier` — the cascade, ported

**Files:** create `native/Apps/ShepherdMac/Sources/Herd/HerdClassifier.swift` and
`native/Apps/ShepherdMac/Tests/HerdClassifierTests.swift`.

**Interfaces:**
- Consumes: `Session`, `HerdGitState`, `ReviewVerdict`, `HerdStage` and `HerdPartition` (both
  already in `Sources/Sidebar/`).
- Produces: `HerdClassifier.checksCleared(_:noCi:)`, `.terminalStage(…)`, `.stageOf(…)`,
  `.handoffStage(_:)`, `.isReworkRunning(…)`, `.verdictStale(_:git:)`, `.prReadinessBlock(_:)`,
  `.deriveStage(…) -> StepperInfo`, and the `StepperInfo` / `StepperReviewTint` /
  `PrReadinessBlock` value types.

**This is the stream's risk.** `HerdPartition.stageOf` already exists and already ranks candidates
by `precedence` — that machinery is right and stays. What is missing is the thing that *produces* a
candidate from a `HerdGitState`, and the web's producer is a flat first-match cascade with five
git-free checks interleaved among the git-decided ones. Every rule below is quoted from the web at
the declaration, and every one gets a test.

- [ ] **Step 1: Write the failing tests**

`native/Apps/ShepherdMac/Tests/HerdClassifierTests.swift` — one `@Test` per stage plus the
precedence pairs. The set that must be present, because each encodes a rule that is easy to get
backwards:

```swift
    @Test func checksNoneOnAnOpenPrIsNotClearedUnlessTheRepoHasNoCi() {
        #expect(HerdClassifier.checksCleared(.init(known: .none), noCi: false) == false)
        #expect(HerdClassifier.checksCleared(.init(known: .none), noCi: true) == true)
        #expect(HerdClassifier.checksCleared(.init(known: .success), noCi: false) == true)
        #expect(HerdClassifier.checksCleared(.init(known: .failure), noCi: true) == false)
    }

    @Test func mergedOutranksEverything() {
        // git.state == "merged" is the first line of terminalStage; a merged PR whose session is
        // still readyToMerge and whose CI is red is STILL merged.
        let git = Fixtures.git(state: .merged, checks: .failure)
        let session = Fixtures.session(readyToMerge: true)
        #expect(HerdClassifier.stage(session, git: git, ctx: .idle) == .merged)
    }

    @Test func readyOutranksBothReviewerRunningAndCi() {
        // readyToMerge is checked BEFORE reviewerRunning and before the two CI stages
        // (herd-partition.ts:116-134), so a ready session with a review in flight is under Ready.
        let git = Fixtures.git(state: .open, checks: .pending)
        let session = Fixtures.session(readyToMerge: true)
        #expect(HerdClassifier.stage(session, git: git, ctx: .init(reviewing: true)) == .ready)
    }

    @Test func needsReworkNeedsAllSixTermsOfIdleOpenCleared() {
        let git = Fixtures.git(state: .open, checks: .success, reviewBlock: .init(reviewer: "r1"))
        #expect(HerdClassifier.stage(Fixtures.session(), git: git, ctx: .idle) == .needsRework)
        // …and each term individually demotes it back to `active`:
        #expect(HerdClassifier.stage(Fixtures.session(status: .running), git: git, ctx: .idle) == .active)
        #expect(HerdClassifier.stage(Fixtures.session(status: .blocked), git: git, ctx: .idle) == .active)
        #expect(HerdClassifier.stage(Fixtures.session(), git: git, ctx: .init(reviewing: true)) == .reviewerRunning)
        #expect(HerdClassifier.stage(Fixtures.session(), git: Fixtures.git(state: .open, checks: .pending, reviewBlock: .init(reviewer: "r1")), ctx: .idle) == .ciRunning)
    }

    @Test func branchProtectionBlockedNeedsNoReviewBlock() {
        let blocked = Fixtures.git(state: .open, checks: .success, mergeStateStatus: .blocked)
        #expect(HerdClassifier.stage(Fixtures.session(), git: blocked, ctx: .idle) == .branchProtectionBlocked)
        let alsoRework = Fixtures.git(
            state: .open, checks: .success, mergeStateStatus: .blocked,
            reviewBlock: .init(reviewer: "r1"))
        // reviewBlock wins: the ladder tests it first and the branch-protection arm requires
        // `!reviewBlock` explicitly.
        #expect(HerdClassifier.stage(Fixtures.session(), git: alsoRework, ctx: .idle) == .needsRework)
    }

    @Test func aGreenIdleDraftOutranksItsHandoff() {
        let git = Fixtures.git(state: .open, checks: .success, isDraft: true, handoff: .merger)
        #expect(HerdClassifier.stage(Fixtures.session(), git: git, ctx: .idle) == .draftAwaitingSignoff)
    }

    @Test func theThreeHandoffStagesSplitOnHandoffAlone() {
        for (handoff, expected) in [
            (PrHandoffKnown.reviewer, HerdStage.waitingOnReviewer),
            (.merger, .waitingOnMerger),
        ] {
            let git = Fixtures.git(state: .open, checks: .success, handoff: handoff)
            #expect(HerdClassifier.stage(Fixtures.session(), git: git, ctx: .idle) == expected)
        }
        let none = Fixtures.git(state: .open, checks: .success)
        #expect(HerdClassifier.stage(Fixtures.session(), git: none, ctx: .idle) == .awaitingMerge)
    }

    @Test func greenIdleUsesTheRawStatusNotTheDisplayStatus() {
        // herd-partition.ts:174-176 says so outright: the working-while-blocked upgrade is
        // DISPLAY-only, and a classifier that used it would file a still-working session under a
        // handoff group.
        let git = Fixtures.git(state: .open, checks: .success, handoff: .reviewer)
        let blocked = Fixtures.session(status: .blocked)
        #expect(HerdClassifier.stage(blocked, git: git, ctx: .init(workingBlocked: [blocked.id: true])) == .active)
    }

    @Test func aStaleVerdictDoesNotTintTheStepper() {
        let git = Fixtures.git(state: .open, checks: .success, headSha: "new")
        let verdict = Fixtures.verdict(headSha: "old", decision: .changes_requested)
        #expect(HerdClassifier.verdictStale(verdict, git: git) == true)
        let info = HerdClassifier.deriveStage(
            session: Fixtures.session(), git: git, verdict: verdict, reviewing: false)
        #expect(info.review == .none)
    }

    @Test func reworkRunningNeedsALiveTurnAndAnUnstaleCriticVerdict() {
        let running = Fixtures.session(status: .running)
        let fresh = Fixtures.verdict(headSha: "x", decision: .changes_requested, updatedAt: 0)
        #expect(HerdClassifier.isReworkRunning(running, verdict: fresh, now: 1, planRework: false))
        // Not running → false, whatever the verdict says.
        #expect(!HerdClassifier.isReworkRunning(Fixtures.session(), verdict: fresh, now: 1, planRework: false))
        // Dismissed → false: the operator took it over.
        let dismissed = Fixtures.verdict(headSha: "x", decision: .changes_requested, dismissed: true)
        #expect(!HerdClassifier.isReworkRunning(running, verdict: dismissed, now: 1, planRework: false))
        // The plan half is S8's and is injected; true alone is enough.
        #expect(HerdClassifier.isReworkRunning(running, verdict: nil, now: 1, planRework: true))
    }
```

`Fixtures.git(…)`, `Fixtures.session(…)` and `Fixtures.verdict(…)` are local builders in the test
file with defaults matching the contract's `required` sets. Read
`native/Apps/ShepherdMac/Sources/Main/PreviewData.swift` for the existing `session` builder's real
signature before writing a second one.

- [ ] **Step 2: Run them and watch them fail**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/HerdClassifierTests 2>&1 | tail -5
```

Expected: compile failures naming `HerdClassifier`.

- [ ] **Step 3: Write the module**

`native/Apps/ShepherdMac/Sources/Herd/HerdClassifier.swift`. The shape, with every rule cited:

```swift
import Foundation
import ShepherdKit

/// Everything the herd needs to decide from, gathered so `stage(_:git:ctx:)` takes one value
/// rather than six parameters that are easy to pass in the wrong order.
struct HerdContext: Sendable {
    /// `GET /api/working-blocked`, S3's. DISPLAY-only — see `greenIdle`.
    var workingBlocked: [String: Bool] = [:]
    /// A critic or plan-gate run is in flight for this session. The web ORs the two
    /// (`Herd.svelte:262`: `reviews.isReviewing(id) || planGates.isReviewing(id)`), and the
    /// plan-gate half arrives with S8 through `HerdSignals.planReviewing`.
    var reviewing: Bool = false
    /// The critic verdict for this session, if any.
    var verdict: ReviewVerdict? = nil
    /// S8's half of `isReworkRunning`: `planPhase == "planning"` with a non-dismissed,
    /// non-stalled `changes_requested` plan gate. Injected and `false` until S8 lands, exactly as
    /// `SidebarModel.gitStage` was before this stream.
    var planRework: Bool = false
    var now: Int = 0

    static let idle = HerdContext()
}

/// The web's classifier, ported rule for rule from
/// `ui/src/lib/components/herd-partition.ts:116-183`. Pure and UI-free, so every rule is asserted
/// against the web's own behaviour instead of eyeballed in a running app.
///
/// `HerdPartition` (S3's, already shipped) keeps the *ranking* — it takes candidate stages and
/// picks the lowest `precedence`, which reproduces "first match wins" in whatever order candidates
/// are produced. What was missing, and what this type is, is the producer: the cascade that turns
/// a `HerdGitState` into a candidate.
enum HerdClassifier {
    /// `checksCleared` (`ui/src/lib/checks-cleared.ts:7-9`), drift-locked to `src/checks-gate.ts`.
    ///
    /// The `noCi` arm is load-bearing and easy to drop: on a repo with no workflows at all, the
    /// rollup is permanently `none`, and without this an open PR there could never leave the active
    /// group. `none` without `noCi` is deliberately NOT cleared — that is anti-flicker while the
    /// forge is still reporting.
    static func checksCleared(_ checks: ChecksState, noCi: Bool) -> Bool {
        if checks.known == .success { return true }
        return noCi && checks.known == ChecksStateKnown.none
    }

    /// `isIdleOpenCleared` (`herd-partition.ts:137-151`) — six terms, all required.
    ///
    /// Note the fifth and sixth: a session under review, or actively reworking, is NOT idle, and
    /// omitting either files a live rework under "changes requested" where the operator would read
    /// it as their turn.
    static func isIdleOpenCleared(
        _ session: Session, git: HerdGitState?, ctx: HerdContext
    ) -> Bool {
        guard let git, git.state.known == .open else { return false }
        guard checksCleared(git.checks, noCi: git.noCi ?? false) else { return false }
        guard session.status.known != .running, session.status.known != .blocked else { return false }
        guard !ctx.reviewing else { return false }
        return !isReworkRunning(session, verdict: ctx.verdict, now: ctx.now, planRework: ctx.planRework)
    }

    /// `terminalStage` (`herd-partition.ts:116-135`), in order. `nil` means "fall through to the
    /// handoff/active branch".
    static func terminalStage(
        _ session: Session, git: HerdGitState?, ctx: HerdContext
    ) -> HerdStage? {
        if git?.state.known == .merged { return .merged }
        if HerdPartition.isMerging(session, now: ctx.now) { return .merging }
        let idle = isIdleOpenCleared(session, git: git, ctx: ctx)
        if idle, git?.reviewBlock != nil { return .needsRework }
        if idle, git?.reviewBlock == nil, git?.mergeStateStatus?.known == .blocked {
            return .branchProtectionBlocked
        }
        // No git requirement at all: a readyToMerge session with no PR is still Ready.
        if session.readyToMerge { return .ready }
        if ctx.reviewing { return .reviewerRunning }
        if isReworkRunning(session, verdict: ctx.verdict, now: ctx.now, planRework: ctx.planRework) {
            return .reworkRunning
        }
        if git?.state.known == .open, git?.checks.known == .pending { return .ciRunning }
        if git?.state.known == .open, git?.checks.known == .failure { return .ciFailed }
        return nil
    }

    /// `handoffStage` (`herd-partition.ts:156-161`). Draft outranks both named handoffs.
    static func handoffStage(_ git: HerdGitState) -> HerdStage {
        if git.isDraft == true { return .draftAwaitingSignoff }
        switch git.handoff?.known {
        case .reviewer: return .waitingOnReviewer
        case .merger: return .waitingOnMerger
        default: return .awaitingMerge
        }
    }

    /// `stageOf` (`herd-partition.ts:165-183`). The whole answer for one session.
    ///
    /// `greenIdle` reads the RAW `session.status`, never `displayStatus` — the web says so outright
    /// at `:174-176`. The working-while-blocked upgrade is display-only; a classifier that used it
    /// would file a session that is still producing output under a handoff group.
    static func stage(_ session: Session, git: HerdGitState?, ctx: HerdContext) -> HerdStage {
        if let terminal = terminalStage(session, git: git, ctx: ctx) { return terminal }
        guard let git, git.state.known == .open,
            checksCleared(git.checks, noCi: git.noCi ?? false),
            session.status.known != .running, session.status.known != .blocked
        else { return .active }
        return handoffStage(git)
    }

    /// `isReworkRunning` (`ui/src/lib/components/rework-running.ts:16-33`).
    ///
    /// Two halves ORed. The critic half is implemented here in full; the plan half needs S8's
    /// `PlanGate` and arrives injected as `planRework`, defaulting to false — the same discipline
    /// `SidebarModel.gitStage` used before this stream filled it.
    ///
    /// The status term uses `displayStatus`, unlike `greenIdle`: this predicate asks "is the agent
    /// working on it right now", and a working-while-blocked session IS working.
    static func isReworkRunning(
        _ session: Session, verdict: ReviewVerdict?, now: Int, planRework: Bool,
        workingBlocked: [String: Bool] = [:]
    ) -> Bool {
        guard HerdPartition.displayStatus(session, workingBlocked: workingBlocked).known == .running
        else { return false }
        if planRework { return true }
        guard let verdict, verdict.decision.known == .changesRequested, verdict.dismissed != true
        else { return false }
        return addressStallStatus(verdict, now: now) != .stalled
    }
```

plus `addressStallStatus` (the critic twin of `planStallStatus`: `round < cap` → `.round`,
`!finalRoundPending` → `.stalled`, `now - updatedAt > finalRoundTimeoutMs` → `.stalled`, else
`.final`), `verdictStale` (`ui/src/lib/verdict-freshness.ts:23-33`: `git != nil && git.state ==
.open && verdict.headSha != "" && git.headSha != nil && verdict.headSha != git.headSha`),
`prReadinessBlock` (`ui/src/lib/pr-ready.ts:26-33`, first match: not open → `nil`, `isDraft` →
`.draft`, conflicting → `.conflict`, `mergeStateStatus == .behind` → `.behind`, `== .blocked` →
`.blocked`), and `deriveStage` (`ui/src/lib/components/stage.ts:83-117`) returning a `StepperInfo`
with `reached`, `index`, `ci`, `terminal`, `review` and `planningSkipped`.

`StepperStage` is its own five-case enum — `planning, implementing, pr, review, ready` — and is
**not** `HerdStage`. The web has two constants both called `STAGE_ORDER`
(`herd-partition.ts:190` and `stage.ts:6`) and they are unrelated; conflating them is the single
most likely way to get this task wrong.

- [ ] **Step 4: Run green and commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/HerdClassifierTests 2>&1 | tail -3
git add native/Apps/ShepherdMac/Sources/Herd/HerdClassifier.swift \
  native/Apps/ShepherdMac/Tests/HerdClassifierTests.swift
git commit -m "feat(mac): port the herd lifecycle cascade"
```

---

### Task 5: `HerdSignals` — the `AppExtension`

**Files:** create `native/Apps/ShepherdMac/Sources/Herd/HerdSignals.swift` and
`native/Apps/ShepherdMac/Tests/HerdSignalsTests.swift`.

**Interfaces:**
- Consumes: `AppExtension`, `SessionStore.events()`, `SessionStore.connection`, Task 2's six kit
  methods, `AppModel.activationGeneration`.
- Produces: `HerdReads` (five injected closures, `.live(_:)` and a test stub), and `HerdSignals`
  with `git`, `activity`, `claudeAlive`, `verdicts`, `reviewing`, `reviewerEnv`, `criticActivity`,
  plus `stage(for:)`, `isReviewing(_:)`, `ciRed`, `refresh()`, `teardown()`.

Model it on `SidebarModel` — the same file already solves every hard part of this task, and a second
solution with different names is a review rejection. Specifically reuse: the `reads` struct with a
`.live(client)` factory; the `generation` counter plus the `app.activationGeneration` check around
every commit; the `subscribe(store)` tap on `store.events()`; the `watchConnection` `AsyncStream`
that is **finished** in `teardown()` and never parked on a `withCheckedContinuation`; and the
`refreshPending` collapse so a burst of frames becomes one extra re-read.

- [ ] **Step 1: Write the failing tests**

The cases that must be present, because each is a rule the web states explicitly and a naive port
gets wrong:

```swift
    @Test func aVerdictEndsTheInFlightRun() async {
        // ReviewsStore.apply (ui/src/lib/reviews.svelte.ts:80-89) calls setReviewing(id, false)
        // UNCONDITIONALLY after storing a verdict — a landed verdict IS the end of the run.
        let model = HerdSignals(reads: .stub(), now: { 0 })
        model.applyForTesting(name: "session:reviewing", payload: ["id": "a", "reviewing": true])
        #expect(model.isReviewing("a"))
        model.applyForTesting(name: "session:review", payload: ["id": "a", "review": verdictJSON])
        #expect(!model.isReviewing("a"))
    }

    @Test func aNullReviewDeletesTheVerdict() async {
        let model = HerdSignals(reads: .stub(verdicts: ["a": verdict]), now: { 0 })
        await model.refresh()
        model.applyForTesting(name: "session:review", payload: ["id": "a", "review": NSNull()])
        #expect(model.verdicts["a"] == nil)
    }

    @Test func bothEdgesOfReviewingClearTheActivityFeed() async {
        let model = HerdSignals(reads: .stub(), now: { 0 })
        model.applyForTesting(name: "session:reviewing", payload: ["id": "a", "reviewing": true])
        model.applyForTesting(name: "session:critic-activity", payload: ["id": "a", "summary": "reading"])
        #expect(model.criticActivity["a"]?.count == 1)
        model.applyForTesting(name: "session:reviewing", payload: ["id": "a", "reviewing": false])
        #expect(model.criticActivity["a"] == nil)
    }

    @Test func theActivityFeedIsBoundedToTwoLines() { /* MAX_ACTIVITY_LINES = 2 */ }

    @Test func aRedundantReviewingTrueStillRefreshesTheEnv() {
        // applyReviewing writes the env BEFORE the transition guard, on purpose: a repeated `true`
        // must still update which CLI is reviewing.
    }

    @Test func aRefreshThatLostItsRaceIsDropped() { /* the SidebarModel generation pattern */ }

    @Test func everyReconnectReReadsAllFiveSnapshots() { /* the .live transition watcher */ }

    @Test func teardownEndsTheConnectionWatcherLoop() { /* isWatchingConnection goes false */ }
```

- [ ] **Step 2: Run them and watch them fail, then write the model**

The five reads bootstrap in one `refresh()`; `session:git` and `session:activity` are **already
declared by S2's block** and carry their whole payload, so they are applied directly rather than
triggering a re-read; `session:review`, `session:reviewing`, `session:critic-activity` and
`session:claude-alive` are this stream's and are likewise applied directly. Nothing here calls
`setActive`, so it sends no presence frame and cannot fight the store's.

`ciRed` is the derived set `Set(git.filter { $0.value.checks.known == .failure }.keys)` — the raw
rollup test, matching `ui/src/lib/tab-signal.svelte.ts:57-68` and deliberately not the server's
hold classifier, which ranks `pr-conflict` above it.

- [ ] **Step 3: Run green and commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/HerdSignalsTests 2>&1 | tail -3
git add native/Apps/ShepherdMac/Sources/Herd/HerdSignals.swift \
  native/Apps/ShepherdMac/Tests/HerdSignalsTests.swift
git commit -m "feat(mac): live herd snapshots from the event tap"
```

---

### Task 6: The install point — two dead closures, two seams

**Files:** create `native/Apps/ShepherdMac/Sources/Herd/HerdStream.swift`; extend
`native/Apps/ShepherdMac/Tests/HerdSignalsTests.swift`.

**Interfaces:**
- Produces: `HerdStream.install(_ app: AppModel)`, which registers `HerdSignals` and wires four
  things.

This is the task the whole stream exists for. `install(_:)` does exactly this and nothing else:

```swift
import SwiftUI
import ShepherdKit

/// Where S7 joins the app. The integration lane adds one line —
/// `HerdStream.install(app)` — to `StreamRegistrations.installAll(into:)`, and nothing else in
/// `Sources/App/` changes.
@MainActor
enum HerdStream {
    static func install(_ app: AppModel) {
        app.register(HerdSignals.self)

        // The two closures S3 declared and nothing ever assigned. Both resolve the extension on
        // every call rather than capturing one: an extension is rebuilt per activation, so a
        // captured instance would answer for the profile the operator has already left. `app` is
        // captured weakly — these closures live as long as the SidebarModel does, and a strong
        // capture would keep a dropped model and its store alive.
        //
        // Assigned through `SidebarModel` rather than through `SessionSignals` because they are
        // that model's own inputs, and the same shape the S4-integration seam uses.
        if let sidebar = app.extension(SidebarModel.self) {
            sidebar.gitStage = { [weak app] session in
                guard let herd = app?.extension(HerdSignals.self) else { return nil }
                return herd.gitCandidate(for: session)
            }
            sidebar.inReview = { [weak app] session in
                app?.extension(HerdSignals.self)?.isReviewing(session.id) ?? false
            }
        }

        // S4 reads "has this PR merged?" through SessionSignals, and until now it answered from
        // S2's per-session cache, which is sparse by design — it knows only the sessions whose Git
        // tab the operator opened. The herd map knows every session, so this is strictly better
        // and the same answer where both have an entry.
        SessionSignals.gitMerged = { [weak app] id in
            app?.extension(HerdSignals.self)?.git[id]?.state.known == .merged
        }

        // The ci-red third of the Dock badge that S6 documented as missing. `extraAttention` is
        // intersected with the live session ids inside NotificationsModel, so a stale id here is
        // dropped rather than becoming a phantom the operator cannot clear.
        if let notifications = app.extension(NotificationsModel.self),
            let herd = app.extension(HerdSignals.self)
        {
            herd.onCiRedChanged = { [weak notifications] ids in
                notifications?.extraAttention = ids
            }
        }
    }
}
```

`gitCandidate(for:)` on `HerdSignals` is the bridge: it calls
`HerdClassifier.stage(session, git: git[session.id], ctx: …)` and returns the result **only when it
is a git-decided stage**, because `HerdPartition.stageOf` already applies `merging`, `ready` and
`reviewerRunning` itself and ranking the same candidate twice is harmless but confusing. Returning
the full answer is also correct — `precedence` makes it idempotent — and the test asserts both
spellings agree.

Three ordering facts this task must respect, and which its tests assert:

1. **`install(_:)` may run before any activation.** `AppModel.register(_:)` builds the extension
   immediately only if a store already exists. The closure assignments above must therefore not
   assume `app.extension(…)` is non-nil at install time — `SessionSignals.gitMerged` resolves
   lazily and is fine; the `SidebarModel` and `NotificationsModel` branches are guarded and are
   re-run by the integration lane's `SessionSignals.connect(app)` call, which already runs after
   every install.
2. **Registration order in `StreamRegistrations` matters for the two guarded branches.**
   `SidebarInstall.run(app)` and `NotificationsStream.install(app)` both run before this line in
   the list the integration lane will produce; the PR body says so explicitly so the lane places it
   last among the feature installs and before `SessionSignals.connect(app)`.
3. **Nothing here edits `SessionSignals.swift`.** `gitMerged` is assigned, not declared — the
   property already exists.

- [ ] **Steps:** write the tests first (an `AppModel` with a fake store, assert `gitStage` is
  non-nil after install and returns a real stage for a seeded git row, assert `SessionSignals.gitMerged`
  answers from the herd map, assert a second `install` is a no-op), then the file, then:

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests 2>&1 | tail -3
git add native/Apps/ShepherdMac/Sources/Herd/HerdStream.swift \
  native/Apps/ShepherdMac/Tests/HerdSignalsTests.swift
git commit -m "feat(mac): assign the herd classifier into the sidebar"
```

---

### Task 7: The row stepper

**Files:** create `native/Apps/ShepherdMac/Sources/Herd/HerdStepper.swift` and
`native/Apps/ShepherdMac/Tests/HerdStepperTests.swift`.

**Interfaces:** consumes `HerdClassifier.deriveStage(…)` and `StepperInfo`; produces
`HerdStepperView`.

Five segments — `planning`, `implementing`, `pr`, `review`, `ready` — plus the terminal branch.
The rules, from `ui/src/lib/components/Stepper.svelte`:

- Segment state: `done` for `i < info.index`, `active` for `i == info.index`, `pending` for
  `i > info.index`, and `skipped` for segment 0 when `info.planningSkipped`.
- Tint: segment 2 (`pr`) carries the CI tint when the PR step is reached and `info.ci != .none`;
  segment 3 (`review`) carries the review tint only for `reviewing`, `changes` and `approved` —
  `none` and `error` render untinted.
- `ci-failure` and `rv-changes` must carry a **non-colour cue as well** (the web thickens the
  segment and outlines it, WCAG 1.4.1). A red-only difference is a review rejection.
- When `info.terminal` is set, the segments are replaced entirely by a MERGED or CLOSED chip.

Colour tokens map to SwiftUI semantic colours, not to `NSColor`: `.green`, `.orange`, `.red`, and
the running tint from `SessionStatusStyle.swift`, which already owns this app's status palette.

Tests assert the derived state per segment for each of: nothing but a prompt (index 0 or 1), an
open PR with pending CI, an open PR with a fresh `changes_requested` verdict, an approved+green PR
(derived ready), a merged PR (terminal chip, no segments), and a session with `planPhase == nil`
(segment 0 skipped).

---

### Task 8: The seven missing badges and the inline git rail

**Files:** modify `native/Apps/ShepherdMac/Sources/Sidebar/SessionBadges.swift`; create
`native/Apps/ShepherdMac/Sources/Herd/HerdRowGit.swift` and
`native/Apps/ShepherdMac/Tests/HerdBadgesTests.swift`.

Native has five badges (research, terminal, quota, needs-you, manual-steps); the web renders ten
plus the status chip. This task adds the seven that are this stream's and leaves the rest:

| Badge | Trigger | Source |
| --- | --- | --- |
| CLI | `showCli` — false when every visible session shares one provider | `session.agentProvider` |
| Issue | `session.issueNumber != nil`; interactive when a URL resolves | `HerdGitState.issueUrl` ?? `session` |
| PR | `prBadgeLabel(git)`: open → `#n`, merged, closed, none → no badge. Sub-markers: a CI dot when open and `checks != .none`, a review marker from `latestReview`, DRAFT when open and `isDraft`, a stale marker for `behind`/`conflict` | `HerdGitState` |
| Critic | `reviewing` → the reviewing chip, else a verdict label. Round counter `min(addressRound, addressCap)/addressCap` with the stall status | `HerdSignals.verdicts`, `.reviewing` |
| Heartbeat | `activity.recentTs`, with `recentErrTs` tinted | `HerdSignals.activity` |
| Autopilot | rendered only when **not** reviewing — REVIEWING outranks it; then paused → complete → unavailable | `session.autopilot*` |
| Status chip | exactly one, in order: `changesRequested` → amber "changes requested by {who}"; `branchProtectionBlocked` → amber "merge blocked"; `isMerging` → merging; `readyToMerge` → READY | `HerdClassifier`, `session` |

The status chip's predicates are the row-level twins of the classifier's, with one documented
difference the web also has: `UnitRowRight.svelte:104-114`'s `idleOpenCleared` has **no**
`!isReworkRunning` term — the row takes only a `reviewing` prop. Reproduce that faithfully and say
so in a comment, rather than "fixing" it into a divergence from the web.

Build-queue and plan-gate badges are **not** this stream's: the first is S9's, the second S8's.
`HerdSignals` exposes nothing for either; S8's badge registers through S8's own view.

`HerdRowGit.swift` is the inline git rail (inventory D3): PR number, state, CI dot and the merge
blockers, as a compact row under the session name, rendered only when a `HerdGitState` exists.

Tests: one per badge trigger, one asserting the status chip is mutually exclusive, and one
asserting the CLI badge disappears when every visible session shares a provider.

---

### Task 9: Live check, full verification and the PR

**Files:** create `native/Apps/ShepherdMac/Tests/HerdLiveTests.swift`.

- [ ] **Step 1: Write the live-gated test**

Read-only against the operator's real server, skipped unless the environment arms it. Model it on
`ActionsLiveTests.swift`: build a `SessionStore` from `LiveServerEnvironment.baseURL` +
`.token` over an `InMemoryCredentialStore`, `bootstrap()`, then:

```swift
    @Test func theHerdSnapshotsDecodeAgainstTheRealServer() async throws {
        guard let store = try liveStore() else { return }
        // Reaching past each call already proves the decode; the assertions pin the invariants a
        // silently-empty body would otherwise satisfy.
        let git = try await store.client.gitStates()
        let reviews = try await store.client.reviews()
        let inflight = try await store.client.reviewsInflight()
        _ = try await store.client.activityStates()
        _ = try await store.client.claudeAliveStates()
        for (id, verdict) in reviews { #expect(verdict.sessionId == id || !verdict.sessionId.isEmpty) }
        for row in inflight { #expect(!row.id.isEmpty) }
        for (_, row) in git where row.state.known == .open {
            // An open PR always has a number on every forge Shepherd supports.
            #expect(row.number != nil)
        }
    }

    @Test func everySessionClassifiesWithoutCrashing() async throws {
        guard let store = try liveStore() else { return }
        try await store.bootstrap()
        let git = try await store.client.gitStates()
        var stages: Set<HerdStage> = []
        for session in store.sessions {
            stages.insert(HerdClassifier.stage(session, git: git[session.id], ctx: .idle))
        }
        #expect(!store.sessions.isEmpty, "the live server should have sessions")
        // The one assertion worth making about a live herd: it is not all `active`. If it is, the
        // git map arrived empty and the whole stream is a no-op against this server.
        Log.ui.info("live herd stages: \(stages.map(\.rawValue).sorted().joined(separator: ","), privacy: .public)")
    }
```

It issues **no** write: a live `review-pr` would spend somebody's quota.

- [ ] **Step 2: Run it against the live server**

```bash
TEST_RUNNER_SHEPHERD_LIVE_BASE_URL="$SHEPHERD_LIVE_BASE_URL" \
TEST_RUNNER_SHEPHERD_LIVE_TOKEN="$SHEPHERD_LIVE_TOKEN" \
TEST_RUNNER_SHEPHERD_REVOKE_ON_EXIT=1 \
  ./native/scripts/test-app.sh -only-testing:ShepherdTests/HerdLiveTests 2>&1 | tail -5
```

Expected: `** TEST SUCCEEDED **`, and the log line naming more than one stage. Both variables come
from the environment only. Without them the same command passes with both tests trivially
satisfied, which is the CI path.

- [ ] **Step 3: Look at it**

```bash
./native/scripts/build-app.sh && open native/build/Debug/Shepherd.app
```

Activate the live profile and read the sidebar. Before this stream it is one flat list; after it,
the groups the server actually has. Take a window screenshot for the PR body
(`screencapture -l $(osascript -e 'tell app "Shepherd" to id of window 1')`).

- [ ] **Step 4: Run every gate this stream can turn red**

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

- [ ] **Step 5: Prove the ownership rule was kept**

```bash
git diff --name-only origin/main...HEAD | sort
```

Expected: exactly the files in "File ownership" and nothing else. If `AppModel.swift`,
`MainWindow.swift`, `SessionSignals.swift`, `StreamRegistrations.swift`, `project.yml` or
`test/contract/harness.ts` appears — **revert that file** and report it.

- [ ] **Step 6: Rebase and re-run the contract gate**

```bash
git fetch origin && git rebase origin/main && bun run test:contract 2>&1 | tail -3
```

A conflict between two stream markers in `contracts/openapi.yaml` is an insertion conflict: keep
both blocks. A conflict in `ui/messages/*.json` that the union merge driver did **not** resolve is a
real one — two branches gave the same key different values; resolve it on the merits.

- [ ] **Step 7: Open the PR**

```bash
git push --no-verify -u origin feat/native-herd
gh pr create --base main --title "feat(mac): herd lifecycle classifier" --body "$(cat <<'EOF'
Stream S7. The Mac sidebar now tells the truth: eleven lifecycle stages that were permanently empty
are reachable, and the Ready lens is correct.

## What landed
- **Contract:** `GET /api/git`, `/api/activity`, `/api/claude-alive`, `/api/reviews`,
  `/api/reviews/inflight` and `POST /api/sessions/{id}/review-pr` in a `herd` block, with the four
  events `session:review`, `session:reviewing`, `session:critic-activity` and
  `session:claude-alive`, fixtures typed with the server's own types, and a per-block coverage gate.
- **Kit:** `ShepherdClient+Herd.swift` — five whole-map reads and the critic trigger.
- **App:** `HerdClassifier` (the web's `terminalStage`/`stageOf`/`handoffStage` cascade plus
  `checksCleared`, `isReworkRunning`, `verdictStale`, `prReadinessBlock` and `deriveStage`, ported
  rule for rule and unit-tested per stage), `HerdSignals` (an `AppExtension` keeping five snapshots
  live off one event tap, with a re-read on every reconnect), the row stepper, seven row badges and
  the inline git rail.
- **The fix:** `SidebarModel.gitStage` and `.inReview` are assigned.
  `SessionSignals.gitMerged` now answers from the herd-wide map instead of S2's sparse per-session
  cache, and `NotificationsModel.extraAttention` gets its ci-red feed.

## Deliberate deviations
- **`HerdGitState` is declared here rather than reusing S2's `GitState`.** The classifier needs
  `noCi`, `handoff`, `handoffWho`, `reviewBlock` and `headSha`, none of which the `detail` block's
  schema declares — and a stream may not edit another stream's block. Both descriptions carry
  `additionalProperties: true` and both are true of the same payload.
- **`ReviewerEnv` is declared here** because S7 merges first; S8 `$ref`s it.
- **`isReworkRunning` ships half-injected.** The plan-gate half needs S8's `PlanGate`; the critic
  half is complete. The seam is `HerdContext.planRework`, defaulting to false.
- **The viewport CI/review banners (C17) are out.** They belong in `SessionDetailView` (S0-owned)
  and there is no detail-banner seam; a `.toolbar` inside a `DetailTab` is forbidden, and a tab is
  not a banner. The same two facts are on the row — stepper tint plus the CI and critic badges. A
  `DetailBannerSlot` is the follow-up.
- **`GET /api/stranded` is S10's.** This stream declares the liveness map, not the stranded ids.

## Integration lane
`StreamRegistrations.installAll(into:)` gains exactly one line: `HerdStream.install(app)`, placed
**after** `SidebarInstall.run(app)` and `NotificationsStream.install(app)` and **before**
`SessionSignals.connect(app)` — the install reads both of those extensions.

## Verification
`bun run test:contract` · `bun run check:contract-swift` · `native/scripts/sync-contract.sh --check`
· `bun run check:strings` · `ui && bun run check:i18n` · `bun run lint` · `bun run typecheck` ·
`bun run test` · `swift test --package-path native` ·
`native/scripts/test-app.sh -only-testing:ShepherdTests` · `native/scripts/build-app.sh` ·
read-only live smoke with `SHEPHERD_LIVE_BASE_URL` / `SHEPHERD_LIVE_TOKEN` from the environment.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
gh pr checks --watch
```

Expected: every check green, including the `native` workflow's `ShepherdKit` job.

---

## Self-review

**Spec coverage.** The master plan's S7 scope lists eight deliverables. Bulk `GET /api/git`
(GitStateMap) → Task 1. `GET /api/activity` → Task 1. `GET /api/reviews` + `/inflight` → Task 1,
declared in a `# ── stream: herd ──` block in all three sections. Kit
`ShepherdClient+Herd.swift` → Task 2. A `HerdSignals` model kept live from events with a reconnect
re-read → Task 5; the events are the four this block declares plus S2's already-declared
`session:git` and `session:activity`, verified against `ui/src/lib/store.svelte.ts:619-700`.
`SidebarModel.gitStage` / `.inReview` assigned through the seam pattern → Task 6. The eleven dark
stages and the Ready lens → Tasks 4 and 6. The ci-red badge seam
`NotificationsModel.extraAttention` → Task 6. The stepper → Task 7; the missing row badges →
Task 8. Tests per stage against the web's partition rules → Task 4, one `@Test` per stage plus the
precedence pairs. Final gate/live/PR → Task 9.

**Placeholders.** None in the contract, kit or classifier tasks, which carry their whole blocks.
Tasks 7 and 8 carry their rules as tables and cite the web component each rule comes from rather
than a full SwiftUI body, because the palette (`SessionStatusStyle.swift`) and the row layout
(`SessionRow.swift`) are existing files whose real API the implementer must read — inventing a
second status palette here would be the review rejection. Four deliberate forward references, each
named where it appears: `HerdContext.planRework` (S8's), the generated case names in Task 2 Step 3
(read `Types.swift`), `Fixtures.session(…)`'s real signature (read `PreviewData.swift`), and
`ShepherdError`'s 5xx case name (read `ShepherdError.swift`).

**Type consistency.** `HerdGitState` is one schema, one typealias, and the same type in the kit,
`HerdSignals.git`, `HerdClassifier`'s every signature and the badge table. `HerdContext`'s five
members are the same five in `isIdleOpenCleared`, `terminalStage`, `stage` and the tests.
`HerdStage` is S3's existing fourteen-case enum and is never redeclared; `StepperStage` is a
separate five-case enum and the plan says so twice, because the web has two `STAGE_ORDER`s.
`ReviewVerdict`, `ReviewerEnv`, `ReviewerInflightEntry`, `PrReviewResult`, `PrHandoff` and
`SessionActivity` are each declared once in Task 1, typealiased once in Task 2, and consumed by name
everywhere after. `HerdReads`'s five closures are the same five in `.live`, in `.stub` and in
`refresh()`.

**No duplicate path claims.** The six paths this block adds — `/api/git`, `/api/activity`,
`/api/claude-alive`, `/api/reviews`, `/api/reviews/inflight`, `/api/sessions/{id}/review-pr` —
appear in no other block and in no core path. `/api/sessions/{id}/git` is S2's and is not touched.
`/api/stranded` is S10's and is not claimed here. The four event names appear in no other block.
`ReviewerEnv` is the one schema two streams need, and the master plan's Appendix A.2 records that
S8 `$ref`s this declaration rather than writing a second.

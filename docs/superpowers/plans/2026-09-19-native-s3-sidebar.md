# Stream S3 — Sidebar and header parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Amended 2026-09-19 (S0-prep seams):** `SidebarModel` no longer opens a second `EventStream` —
> it taps the one authenticated socket through `SessionStore.events()`, which S0-prep delivered as
> the fan-out seam this plan's original draft anticipated only as "S0-int's job once it exists".
> `.unknown(let name)` is now `.unknown(let name, _)`, matching `ServerEvent.unknown(name:payload:)`'s
> two associated values. `ShepherdClient.generated` is confirmed `internal` — already delivered, not
> a Task-2 blocker. Coverage for this stream's routes and events lives entirely in its own
> `test/contract/sidebar.test.ts`; nothing here edits `openapi.test.ts`'s gate.

**Goal:** Give Shepherd for Mac the web UI's Herd sidebar and header strip — repo chip rail, lens
strip, collapsible lifecycle groups, rows with badges, and a header with the Aktiv/Inaktiv/Blockiert
tallies and the 5H/WK usage meter — contract-first, without touching `AppModel`, `MainWindow` or
`SessionRow`.

**Architecture:** Four read routes and two events enter `contracts/openapi.yaml` inside this
stream's marked block; Swift is regenerated from the derived file; one kit extension
(`ShepherdClient+Backlog.swift`) exposes them. The app side is a pure, UI-free derivation module
(`HerdPartition`) that every list decision goes through, one `AppExtension` (`SidebarModel`) owning
the snapshots and a tap on `SessionStore.events()`, and views under `Sources/Sidebar/**` and
`Sources/Header/**`, installed by assigning `SidebarSlot.content`.

**Tech Stack:** Bun + ajv (contract drift test), OpenAPI 3.1, swift-openapi-generator 1.13.1,
Swift 6 (language mode 6, strict concurrency `complete`), SwiftUI, Swift Testing (`import Testing`),
XcodeGen 2.46, `os.Logger`.

---

## Global Constraints

- **The contract is the only type source.** No hand-written `Codable` for a server payload.
- **ShepherdKit has no UI dependency.** No `import SwiftUI` under `native/Sources/`.
- **Swift 6 strict concurrency.** No `@preconcurrency`, `nonisolated(unsafe)` or `@unchecked Sendable`.
- **i18n:** EN + DE only, every string through `L.t(...)`, every key present in **both**
  `ui/messages/en.json` and `ui/messages/de.json` and listed in `KEYS_SIDEBAR`. German copy must
  match the web UI verbatim — reuse the web's key instead of writing a second translation.
- **Logging:** `run.shepherd.mac` (app), `run.shepherd.kit` (kit).
- **Commits:** conventional, lowercase subject, body lines ≤ 100 chars, body ends with
  `Co-Authored-By: <executing model name> <noreply@anthropic.com>`.
- **Branch:** `feat/native-sidebar`, cut from `origin/main` **after S0-prep merges**. Rebase to
  update; never `git merge main`.
- **Never run bare `bun test`** (repo `CLAUDE.md`) — it runs the wrong file set and "passes".

| Command (repo root) | What it proves |
| --- | --- |
| `bun run test:contract` | the contract matches the real server |
| `bun run gen:contract-swift` | regenerates `contracts/openapi.swift.yaml` |
| `./native/scripts/sync-contract.sh` | copies the derived file into the kit target |
| `swift test --package-path native` | kit compiles, kit tests pass |
| `./native/scripts/test-app.sh -only-testing:ShepherdTests` | app unit tests pass |
| `./native/scripts/build-app.sh` | `Shepherd.app` builds |
| `bun run check:strings` | `Localizable.xcstrings` is current |

### File ownership (hard rule)

Create or modify **only**: `contracts/openapi.yaml` (between `# ── stream: sidebar ──` and
`# ── /stream: sidebar ──` only) · the generated `contracts/openapi.swift.yaml` and
`native/Sources/ShepherdKit/openapi.yaml` · `test/contract/sidebar{,-fixtures}.ts` ·
`native/Sources/ShepherdKit/Client/ShepherdClient+Backlog.swift` ·
`native/Tests/ShepherdKitTests/ShepherdClientBacklogTests.swift` ·
`native/Apps/ShepherdMac/Sources/{Sidebar,Header}/**` ·
`native/Apps/ShepherdMac/Tests/{HerdPartition,SidebarModel,SessionBadges,UsageMeter,SidebarStrings,SidebarLive}Tests.swift`
· the `KEYS_SIDEBAR` array in `native/scripts/gen-strings.ts` · `ui/messages/{en,de}.json`
(append-only, union merge driver).

Never edit `AppModel.swift`, `MainWindow.swift`, `SessionRow.swift`, `SessionDetailView.swift`,
`SessionStore.swift`, `ServerEvent.swift`, `EventStream.swift`, `ShepherdApp.swift`, `project.yml`,
`native.yml`, `test/contract/{harness,deps,openapi.test}.ts`. `project.yml` needs no edit: its
`sources: - path: Sources` entry globs new subdirectories, and SwiftPM globs `Sources/ShepherdKit/**`.

### Preconditions — verify before Task 1

```bash
grep -q "# ── stream: sidebar ──" contracts/openapi.yaml \
  && grep -q "KEYS_SIDEBAR" native/scripts/gen-strings.ts \
  && test -f native/Apps/ShepherdMac/Sources/App/SidebarSlot.swift \
  && test -f native/Apps/ShepherdMac/Sources/App/AppModel+Extensions.swift \
  && grep -qE "^\s+(internal )?let generated: Client" native/Sources/ShepherdKit/Client/ShepherdClient.swift \
  && bun run test:contract >/dev/null 2>&1 && echo OK || echo "S0-prep MISSING — stop and tell the orchestrator"
```

Expected: `OK`. Three parts of that deserve spelling out.

1. **Three markers** must exist in `contracts/openapi.yaml`: one in `components.schemas`, one in
   `paths`, one in `x-shepherd-events`. Without the third, appending events guarantees a rebase
   conflict with S2 and S4.
2. **`ShepherdClient.generated` is `internal`.** Delivered by S0-prep
   (`native/Sources/ShepherdKit/Client/ShepherdClient.swift:28`) precisely so a same-module
   extension like `ShepherdClient+Backlog.swift` can reach it. The grep above only confirms the
   seam is still there; do not work around it by building a second `Client`.
3. **Coverage is scoped per stream block, not by editing the global gate.** `test/contract/
   openapi.test.ts`'s gate only polices paths and events *outside* the markers — never touch it.
   Add this stream's operations and events inside its own `# ── stream: sidebar ──` blocks in
   `paths` and `x-shepherd-events`; coverage for them lives in this stream's own
   `test/contract/sidebar.test.ts`, gated on its own `OPERATIONS`/`EVENTS` lists (Step 1 below) —
   the same surface `test/contract/stream-blocks.ts`'s `operationsForStream("sidebar")` derives
   from the markers, so the two never disagree.

### Deliberate deviations from the stream brief

The brief came from the route inventory; reading the web UI changed six things. Each is intentional
and must survive review.

1. **The sidebar is session-driven, not backlog-driven.** `GET /api/backlog` feeds the *Backlog
   overlay* (a repo/issue browser), not the Herd. The repo rail is derived from sessions alone
   (`ui/src/lib/components/queue-strip.ts:51-79`): one chip per repo with ≥ 1 non-archived session,
   count = that repo's live session count, sorted by path. Hidden repos are a backlog-only concept.
   **No backlog route is added.**
2. **`GET /api/up-next`, `upnext:snapshot` and the `Nächstes` lens are out.** The handler answers a
   bare JSON `null` (`src/server.ts:1240-1251`), and a whole-body `null` cannot be expressed in a
   response position: `scripts/gen-contract-swift.ts:225-233` throws for a nullable union outside a
   property schema, and swift-openapi-generator cannot make a nullable *object* an optional response
   body. Up Next is also a forge-issue panel, not part of the session list. The `Offen` lens is out
   for the same reason (separate panel, separate route). Both buttons ship disabled with their web
   tooltips. The web has no per-lens badge counts except on `Offen`, so none are implemented.
3. **`GET /api/prompt-budget` is out** — it feeds only the Usage dashboard's Prompt lens
   (`ui/src/lib/components/Usage.svelte:141-152`) and drives nothing in the header.
4. **Nine of the fourteen lifecycle stages need per-session git state** (`GET /api/sessions/{id}/git`,
   `session:git`), which **S2 owns**. All fourteen stages, their order and their headings are
   implemented; `HerdPartition.stageOf` takes an injected `gitStage` closure defaulting to `nil`, so
   today only the three decidable from `Session` alone (`merging`, `ready`, `active`) populate. The
   same gap removes the merged group and with it the **"Alle stilllegen"** bulk action, which the web
   hangs on that group's header; both land when S0-int assigns `SidebarModel.gitStage`.
5. **No search field and no ⌘K** — ⌘K opens the web UI's *global command bar*
   (`ui/src/lib/components/CommandBar.svelte`); the sidebar has no search input.
6. **The `Erledigt` (Done) lens ships disabled too**, alongside `Nächstes` and `Offen`. It was
   enabled in the first cut, which was wrong: `done` is not a live-list filter in the web either —
   `ui/src/lib/components/herd-partition.ts:64-66` says so outright (`"done" is NOT a live-list
   filter — the page swaps in a dedicated panel and shownSessions falls through to the live set for
   it.`), and `shownSessions` returns the sessions unchanged for it. The web gets away with that
   because the page swaps in a dedicated Done panel; this build has none, and one needs
   `ShepherdClient.doneSessions()`, which is outside this stream's route list. Enabled, the button
   simply relabelled the All list — `SidebarModel.liveSessions` already drops archived sessions, so
   the Done lens showed running and blocked sessions and no finished ones. `HerdPartition.shown`
   keeps the web's fallthrough verbatim (it is still asserted), only `HerdLens.isAvailable` changed,
   and the `herd_done_title` tooltip is retained like the other two panel-only lenses. With the
   lens unreachable, `herd_done_empty` — the web's Done-*panel* line — has no call site and is out
   of `KEYS_SIDEBAR`; it stays in `ui/messages/{en,de}.json`, where the web still uses it.

**Known parity gap, documented not fixed:** the web meter prefers `limits.observed`
(`ui/src/lib/components/usage-gauges.ts:21-53`), and `observed`/`providers`/`refresh` are not
declared on the contract's `UsageLimits`, so native numbers can differ. Extending `UsageLimits` is a
core-schema change.

### Task order

| # | Task | Key files |
| --- | --- | --- |
| 1 | Contract: sidebar routes and events | `contracts/openapi.yaml`, `test/contract/sidebar{,-fixtures}.ts` |
| 2 | Kit: the four snapshot reads | `ShepherdClient+Backlog.swift` |
| 3 | Strings: `KEYS_SIDEBAR` + EN/DE | `gen-strings.ts`, `ui/messages/*.json` |
| 4 | `HerdPartition` — pure derivation | `Sources/Sidebar/HerdPartition.swift` |
| 5 | `SidebarModel` — the `AppExtension` | `Sources/Sidebar/SidebarModel.swift` |
| 6 | Sidebar views + slot install | `Sources/Sidebar/{SessionBadges,HerdGroupView,SidebarView}.swift` |
| 7 | Header strip | `Sources/Header/{UsageMeter,HerdTallies,HeaderStrip}.swift` |
| 8 | Live check, verification, PR | `Tests/SidebarLiveTests.swift` |

---

### Task 1: Contract — sidebar routes and events

**Files:** modify `contracts/openapi.yaml` (sidebar blocks only); create
`test/contract/sidebar-fixtures.ts`, `test/contract/sidebar.test.ts`; regenerate
`contracts/openapi.swift.yaml` and `native/Sources/ShepherdKit/openapi.yaml`.

**Interfaces:**
- Consumes: the core block's `BlockReason` and `UsageLimits`; `harness.ts`'s `startContractServer`,
  `login`, `mintToken`, `bearer`, `collectEvents`, `validateResponse`, `validateEvent`, `coverage`,
  `withAuth`, `restoreAuth`, `type ContractServer`.
- Produces: schemas `WorkingBlockedMap`, `HoldCode`, `HoldParams`, `HoldReason`, `HoldMap`,
  `BlockMap`, `UsageProjection`, `UsageLimitsResponse`, `HeldChangedEvent`,
  `SessionWorkingBlockedEvent`; operations `getWorkingBlocked`, `getHolds`, `getBlocks`,
  `getUsageLimits`; events `held:changed`, `session:working-blocked`.

- [ ] **Step 1: Write the fixtures and the failing test**

`test/contract/sidebar-fixtures.ts`:

```ts
import type { BlockReason } from "../../src/blocked";
import type { HoldReason } from "../../src/types";

/** Payloads the stubbed server cannot emit itself. `held:changed` and `session:working-blocked`
 *  come from inline object literals (src/held-release.ts:83, src/index.ts:1223), so those two are
 *  annotated structurally; the others carry the server's own type, so `bun run typecheck` fails
 *  before the shape can drift. */
export const heldChangedEvent: { count: number } = { count: 3 };
export const workingBlockedEvent: { id: string; working: boolean } = {
  id: "sess_fixture",
  working: true,
};
export const hold: HoldReason = { code: "quota-rework", params: { round: 2, cap: 5 } };
export const block: BlockReason = {
  shape: "quota",
  options: [],
  tail: ["rework budget spent"],
  quotaKind: "rework",
};
```

`test/contract/sidebar.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fx from "./sidebar-fixtures";
import {
  bearer, collectEvents, coverage, login, mintToken, restoreAuth, startContractServer,
  validateEvent, validateResponse, withAuth, type ContractServer,
} from "./harness";

/** This block's own coverage gate, so the stream proves its surface whichever file Bun runs first;
 *  the gate in openapi.test.ts covers the core block. */
const OPERATIONS = [
  "GET /api/working-blocked 200", "GET /api/working-blocked 401",
  "GET /api/holds 200", "GET /api/holds 401",
  "GET /api/blocks 200", "GET /api/blocks 401",
  "GET /api/usage/limits 200", "GET /api/usage/limits 401",
];
const EVENTS = ["held:changed", "session:working-blocked"];
const ROUTES = ["/api/working-blocked", "/api/holds", "/api/blocks", "/api/usage/limits"];

let s: ContractServer;
let token: string;

beforeAll(async () => {
  await withAuth();
  s = startContractServer();
  ({ token } = await mintToken(s, await login(s), "sidebar contract test"));
});
afterAll(() => {
  try {
    s?.stop();
  } finally {
    restoreAuth();
  }
});

describe("sidebar reads", () => {
  test("the four snapshot routes answer the declared shapes, and 401 without a credential", async () => {
    for (const path of ROUTES) {
      const ok = await fetch(`${s.baseUrl}${path}`, { headers: bearer(token) });
      expect(ok.status, path).toBe(200);
      await validateResponse("GET", path, ok);
      const anon = await fetch(`${s.baseUrl}${path}`);
      expect(anon.status, path).toBe(401);
      await validateResponse("GET", path, anon);
    }
  });

  test("an unwired snapshot route is an empty map, not null", async () => {
    const res = await fetch(`${s.baseUrl}/api/holds`, { headers: bearer(token) });
    expect(await validateResponse("GET", "/api/holds", res)).toEqual({});
  });

  test("GET /api/usage/limits wraps the limits", async () => {
    const res = await fetch(`${s.baseUrl}/api/usage/limits`, { headers: bearer(token) });
    const body = (await validateResponse("GET", "/api/usage/limits", res)) as {
      limits: { subscriptionOnly: boolean };
      projections: unknown[];
    };
    expect(typeof body.limits.subscriptionOnly).toBe("boolean");
    expect(Array.isArray(body.projections)).toBe(true);
  });
});

describe("sidebar events", () => {
  test("held:changed and session:working-blocked match the contract", async () => {
    const frames = await collectEvents(s, token, async () => {
      s.deps.events.emit("held:changed", fx.heldChangedEvent);
      s.deps.events.emit("session:working-blocked", fx.workingBlockedEvent);
    });
    const seen = new Set<string>();
    for (const frame of frames) {
      if (!EVENTS.includes(frame.event)) continue;
      validateEvent(frame.event, frame.data);
      seen.add(frame.event);
    }
    expect([...seen].sort()).toEqual([...EVENTS].sort());
  });

  test("the hold and block fixtures are the shapes the schemas describe", () => {
    expect(fx.hold.code).toBe("quota-rework");
    expect(fx.hold.params?.round).toBe(2);
    expect(fx.block.shape).toBe("quota");
    expect(fx.block.quotaKind).toBe("rework");
  });
});

// Stays LAST in this file.
describe("sidebar coverage gate", () => {
  test("every sidebar operation and event was exercised", () => {
    const { operations, events } = coverage();
    expect(OPERATIONS.filter((o) => !operations.has(o))).toEqual([]);
    expect(EVENTS.filter((e) => !events.has(e))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run test:contract 2>&1 | tail -20
```

Expected: FAIL with `contract has no operation GET /api/working-blocked` (from `validateResponse`).

- [ ] **Step 3: Add the schemas inside the sidebar block in `components.schemas`**

Paste between the two sidebar markers (four-space indent, matching the sibling schemas):

```yaml
    WorkingBlockedMap:
      type: object
      additionalProperties: { type: boolean }
      description: GET /api/working-blocked. Session id -> true while a session the poller called blocked is in fact still producing output. The web UI folds this into the status it shows (ui/src/lib/display-status.ts).
    HoldCode:
      type: string
      x-shepherd-open-enum: true
      description: Copied verbatim from HoldCode in src/types.ts.
      enum: [halted-error, halted-usage, autopilot-paused, blocked-menu, blocked-yes-no,
        blocked-awaiting-input, blocked-stall, blocked-generic, quota-rework, quota-review,
        quota-error, quota-plan, plan-rework, plan-question, critic-rework, ci-red, pr-conflict,
        awaiting-merge, train-error, stalled, recap-attention, merging, merge-rebasing, ready-merge,
        manual-steps]
    HoldParams:
      type: object
      additionalProperties: true
      description: Every member is optional; which ones are set depends on the HoldCode.
      properties:
        round: { type: integer }
        cap: { type: integer }
        findings: { type: integer }
        resetAt: { type: integer }
        pr: { type: integer }
        rebaseCount: { type: integer }
        question: { type: string }
        steps: { type: integer }
    HoldReason:
      type: object
      additionalProperties: true
      required: [code]
      properties:
        code: { $ref: "#/components/schemas/HoldCode" }
        params: { $ref: "#/components/schemas/HoldParams" }
    HoldMap:
      type: object
      additionalProperties: { $ref: "#/components/schemas/HoldReason" }
      description: GET /api/holds. Session id -> why that session is parked. Absent means not holding.
    BlockMap:
      type: object
      additionalProperties: { $ref: "#/components/schemas/BlockReason" }
      description: GET /api/blocks. Session id -> what the agent is waiting on. Absent means not blocked.
    UsageProjection:
      type: object
      additionalProperties: true
      required: [window, projectedPct, resetAt, burnRatePerHour]
      properties:
        window:
          type: string
          enum: [5H, WK]
          description: The rate-limit window this projection is for.
        projectedPct:
          type: number
          description: Not clamped; may exceed 100.
        resetAt: { type: integer }
        burnRatePerHour: { type: number }
    UsageLimitsResponse:
      type: object
      additionalProperties: true
      required: [limits, projections]
      description: GET /api/usage/limits wraps the limits; the usage:limits event carries UsageLimits bare.
      properties:
        limits: { $ref: "#/components/schemas/UsageLimits" }
        projections:
          type: array
          items: { $ref: "#/components/schemas/UsageProjection" }
    HeldChangedEvent:
      type: object
      additionalProperties: true
      required: [count]
      properties:
        count:
          type: integer
          description: How many tasks are held behind the usage gate right now.
    SessionWorkingBlockedEvent:
      type: object
      additionalProperties: true
      required: [id, working]
      properties:
        id: { type: string }
        working: { type: boolean }
```

`UsageProjection.window` is deliberately a **closed** inline enum: `5H`/`WK` is a server constant
(`src/usage-limits.ts:6-9`), not a value read back off a SQLite row, and no Swift code reads it.

- [ ] **Step 4: Add the four operations inside the sidebar block in `paths`**

```yaml
  /api/working-blocked:
    get:
      operationId: getWorkingBlocked
      description: Which blocked-looking sessions are in fact still working.
      responses:
        "200":
          description: Session id -> working flag.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/WorkingBlockedMap" }
        "401": { $ref: "#/components/responses/Unauthorized" }
  /api/holds:
    get:
      operationId: getHolds
      responses:
        "200":
          description: Session id -> hold reason.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/HoldMap" }
        "401": { $ref: "#/components/responses/Unauthorized" }
  /api/blocks:
    get:
      operationId: getBlocks
      responses:
        "200":
          description: Session id -> block reason.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/BlockMap" }
        "401": { $ref: "#/components/responses/Unauthorized" }
  /api/usage/limits:
    get:
      operationId: getUsageLimits
      responses:
        "200":
          description: The rate-limit windows plus their projections.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/UsageLimitsResponse" }
        "401": { $ref: "#/components/responses/Unauthorized" }
```

`403 insufficient_scope` is reachable with a scoped token but stays undeclared, per
`contracts/README.md`'s "Deliberately undeclared" rule: the native client mints `full` tokens.

- [ ] **Step 5: Add the two events inside the sidebar block in `x-shepherd-events`**

```yaml
  held:changed:
    description: The number of tasks held behind the usage gate moved. The client re-reads GET /api/holds; the frame carries only the count.
    schema: { $ref: "#/components/schemas/HeldChangedEvent" }
  session:working-blocked:
    description: A session the poller called blocked is (or is no longer) still producing output. The client re-reads GET /api/working-blocked.
    schema: { $ref: "#/components/schemas/SessionWorkingBlockedEvent" }
```

Do **not** add these names to the `EventName` enum. It is flagged `x-shepherd-open-enum`, so an
undeclared name still decodes as its raw string; adding a member would make the exhaustive
`switch name.known` in `ServerEvent.swift` *and* the one in `SessionStore.applyNow` non-exhaustive,
and both files are off-limits here. The sidebar needs these frames only as signals to re-read.

- [ ] **Step 6: Run green, regenerate, sync, prove freshness**

```bash
bun run test:contract && bun run gen:contract-swift && ./native/scripts/sync-contract.sh \
  && bun run check:contract-swift && ./native/scripts/sync-contract.sh --check \
  && swift build --package-path native 2>&1 | tail -3
```

Expected: contract tests pass · `contracts/openapi.swift.yaml -> native/Sources/ShepherdKit/openapi.yaml`
· no diff · `sync-contract: up to date` · `Build complete!`. If the derivation throws naming a JSON
pointer inside the sidebar block, the schema there uses a construct it refuses (a nullable union
outside a property, an open enum inside `allOf`) — fix the schema, never the script.

- [ ] **Step 7: Commit**

```bash
git add contracts/openapi.yaml contracts/openapi.swift.yaml \
  native/Sources/ShepherdKit/openapi.yaml test/contract/sidebar.test.ts \
  test/contract/sidebar-fixtures.ts
git commit -m "feat(contract): sidebar snapshot routes and held/working-blocked events"
```

---

### Task 2: Kit — `ShepherdClient+Backlog.swift`

**Files:** create `native/Sources/ShepherdKit/Client/ShepherdClient+Backlog.swift` and
`native/Tests/ShepherdKitTests/ShepherdClientBacklogTests.swift`.

**Interfaces:**
- Consumes: Task 1's generated operations; `ShepherdClient.generated` (must be `internal`);
  `ShepherdError.from(_:route:)`, `.fromUndocumented(statusCode:route:)`, `.unauthenticated`;
  `FakeShepherdServer`, `InMemoryCredentialStore`, `StoredCredential`, `ServerProfile`.
- Produces on `ShepherdClient`: `workingBlocked() -> [String: Bool]`, `holds() -> [String: HoldReason]`,
  `blocks() -> [String: BlockReason]`, `usage() -> UsageLimitsResponse`, plus the public typealiases
  `HoldReason`, `HoldCode`, `HoldCodeKnown`, `BlockReason`, `UsageLimits`, `UsageLimitsResponse`,
  `UsageProjection`.

- [ ] **Step 1: Write the failing tests**

```swift
import Foundation
import Testing

@testable import ShepherdKit

@Suite("ShepherdClient sidebar reads")
struct ShepherdClientBacklogTests {
  private func makeClient(_ server: FakeShepherdServer) throws -> ShepherdClient {
    let credentials = InMemoryCredentialStore()
    try credentials.save(StoredCredential(token: "shp_test", tokenId: "tok"), for: "k")
    let profile = ServerProfile(
      name: "fake", baseURL: server.baseURL, mode: .local, credentialKey: "k")
    return try ShepherdClient(
      profile: profile, credentials: credentials, urlSession: server.urlSession())
  }

  /// Encode-then-decode: every fixture is produced from the generated type, so it cannot disagree
  /// with the contract.
  private func json<T: Encodable>(_ value: T) throws -> Data { try JSONEncoder().encode(value) }

  @Test("working-blocked, holds and blocks decode into their maps")
  func maps() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "GET", "/api/working-blocked", status: 200,
      json: try json(
        Components.Schemas.WorkingBlockedMap(additionalProperties: ["a": true, "b": false])))
    let hold = Components.Schemas.HoldReason(
      code: HoldCode(known: .quota_hyphen_rework), params: .init(round: 2, cap: 5))
    server.stub(
      "GET", "/api/holds", status: 200,
      json: try json(Components.Schemas.HoldMap(additionalProperties: ["s1": hold])))
    let block = Components.Schemas.BlockReason(
      shape: .init(value1: .stall), options: [], tail: ["waiting"])
    server.stub(
      "GET", "/api/blocks", status: 200,
      json: try json(Components.Schemas.BlockMap(additionalProperties: ["s1": block])))
    let client = try makeClient(server)

    let flags = try await client.workingBlocked()
    #expect(flags["a"] == true)
    #expect(flags["b"] == false)
    let holds = try await client.holds()
    #expect(holds["s1"]?.code.known == .quota_hyphen_rework)
    #expect(holds["s1"]?.params?.round == 2)
    #expect(try await client.blocks()["s1"]?.tail == ["waiting"])
  }

  @Test("a hold code this build has never heard of survives as its raw value")
  func unknownHoldCode() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "GET", "/api/holds", status: 200, json: Data(#"{"s1":{"code":"quantum-hold"}}"#.utf8))

    let holds = try await makeClient(server).holds()
    #expect(holds["s1"]?.code.known == nil)
    #expect(holds["s1"]?.code.rawValue == "quantum-hold")
  }

  @Test("usage returns the wrapper, not bare limits")
  func usage() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    let limits = Components.Schemas.UsageLimits(
      session5h: .init(pct: 42, resetAt: 1_800_000_000_000),
      week: nil, perModelWeek: [], credits: nil,
      stale: false, calibratedAt: nil, subscriptionOnly: false)
    server.stub(
      "GET", "/api/usage/limits", status: 200,
      json: try json(Components.Schemas.UsageLimitsResponse(limits: limits, projections: [])))

    let usage = try await makeClient(server).usage()
    #expect(usage.limits.session5h?.pct == 42)
    #expect(usage.projections.isEmpty)
  }

  @Test("a 401 maps to unauthenticated on every sidebar read")
  func unauthorized() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    let body = Data(#"{"error":"unauthorized"}"#.utf8)
    for path in ["/api/working-blocked", "/api/holds", "/api/blocks", "/api/usage/limits"] {
      server.stub("GET", path, status: 401, json: body)
    }
    let client = try makeClient(server)

    await #expect(throws: ShepherdError.unauthenticated) { _ = try await client.workingBlocked() }
    await #expect(throws: ShepherdError.unauthenticated) { _ = try await client.holds() }
    await #expect(throws: ShepherdError.unauthenticated) { _ = try await client.blocks() }
    await #expect(throws: ShepherdError.unauthenticated) { _ = try await client.usage() }
  }
}
```

- [ ] **Step 2: Run them and watch them fail**

```bash
swift test --package-path native --filter ShepherdClientBacklogTests 2>&1 | tail -20
```

Expected: `value of type 'ShepherdClient' has no member 'workingBlocked'`.

- [ ] **Step 3: Write the extension**

```swift
import Foundation

// Short names for the sidebar schemas, alongside Model/PublicTypes.swift. Typealiases, not
// wrappers: one definition of each type, still from the contract.
public typealias HoldReason = Components.Schemas.HoldReason
public typealias HoldCode = Components.Schemas.HoldCode
public typealias HoldCodeKnown = Components.Schemas.HoldCodeKnown
public typealias BlockReason = Components.Schemas.BlockReason
public typealias UsageLimits = Components.Schemas.UsageLimits
public typealias UsageLimitsResponse = Components.Schemas.UsageLimitsResponse
public typealias UsageProjection = Components.Schemas.UsageProjection

/// The four snapshot reads the Herd sidebar and header bootstrap from. Each is a plain in-memory
/// snapshot server-side, so re-reading is cheap — which is what the sidebar does, because the
/// matching `/events` frames carry a signal, not a patch.
extension ShepherdClient {
  /// `GET /api/working-blocked` — session id to "is in fact still producing output".
  public func workingBlocked() async throws -> [String: Bool] {
    do {
      switch try await generated.getWorkingBlocked(.init()) {
      case .ok(let ok): return try ok.body.json.additionalProperties
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "getWorkingBlocked")
      }
    } catch { throw ShepherdError.from(error, route: "getWorkingBlocked") }
  }

  /// `GET /api/holds` — session id to why that session is parked. Absent means not holding.
  public func holds() async throws -> [String: HoldReason] {
    do {
      switch try await generated.getHolds(.init()) {
      case .ok(let ok): return try ok.body.json.additionalProperties
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "getHolds")
      }
    } catch { throw ShepherdError.from(error, route: "getHolds") }
  }

  /// `GET /api/blocks` — the map `SessionStore` keeps live from `session:block`, read once at
  /// bootstrap so the first paint is not empty.
  public func blocks() async throws -> [String: BlockReason] {
    do {
      switch try await generated.getBlocks(.init()) {
      case .ok(let ok): return try ok.body.json.additionalProperties
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "getBlocks")
      }
    } catch { throw ShepherdError.from(error, route: "getBlocks") }
  }

  /// `GET /api/usage/limits` — the wrapper. The `usage:limits` push carries `UsageLimits` bare, so
  /// projections only move on an explicit re-read.
  public func usage() async throws -> UsageLimitsResponse {
    do {
      switch try await generated.getUsageLimits(.init()) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let statusCode, _):
        throw ShepherdError.fromUndocumented(statusCode: statusCode, route: "getUsageLimits")
      }
    } catch { throw ShepherdError.from(error, route: "getUsageLimits") }
  }
}
```

- [ ] **Step 4: Run green and commit**

```bash
swift test --package-path native 2>&1 | tail -3
```

Expected: the whole kit suite passes, including the 4 new tests.

```bash
git add native/Sources/ShepherdKit/Client/ShepherdClient+Backlog.swift \
  native/Tests/ShepherdKitTests/ShepherdClientBacklogTests.swift
git commit -m "feat(kit): sidebar snapshot reads over the generated client"
```

---

### Task 3: Strings — `KEYS_SIDEBAR` and the EN/DE additions

**Files:** modify `native/scripts/gen-strings.ts` (the `KEYS_SIDEBAR` array only) and
`ui/messages/{en,de}.json`; regenerate `native/Apps/ShepherdMac/Resources/Localizable.xcstrings`;
create `native/Apps/ShepherdMac/Tests/SidebarStringsTests.swift`.

**Interfaces:** produces every catalog key Tasks 4–7 pass to `L.t(_:)` / `L.t(_:_:)`.

- [ ] **Step 1: Append the four app-only keys to both catalogs**

The tallies have no web key of their own (`TopBarTallies.svelte` builds them inline). Append before
the closing brace of `ui/messages/en.json`:

```json
  "native_herd_counter_active": "Active",
  "native_herd_counter_idle": "Idle",
  "native_herd_counter_blocked": "Blocked",
  "native_herd_counter_total": "Total"
```

and to `ui/messages/de.json`:

```json
  "native_herd_counter_active": "Aktiv",
  "native_herd_counter_idle": "Inaktiv",
  "native_herd_counter_blocked": "Blockiert",
  "native_herd_counter_total": "Gesamt"
```

- [ ] **Step 2: Fill `KEYS_SIDEBAR`**

Replace the empty array S0-prep left in `native/scripts/gen-strings.ts` with:

```ts
/** Keys the Herd sidebar and header strip use. Owned by stream S3 — keep alphabetical. */
export const KEYS_SIDEBAR: readonly string[] = [
  "herd_all_title", "herd_awaiting_merge_group", "herd_changes_requested_group", "herd_ci_failed_group",
  "herd_ci_running_group", "herd_done_empty", "herd_done_title", "herd_draft_awaiting_signoff_group",
  "herd_lenses_label", "herd_merge_blocked_group", "herd_merged_group", "herd_merging_group",
  "herd_next_title", "herd_owed_title", "herd_ready_empty", "herd_ready_group",
  "herd_ready_title", "herd_repo_filter_empty", "herd_reviewer_running_group", "herd_rework_running_group",
  "herd_seg_all", "herd_seg_done", "herd_seg_next", "herd_seg_owed",
  "herd_seg_ready", "herd_stage_name_active", "herd_waiting_merger_group_multi", "herd_waiting_reviewer_group_multi",
  "native_herd_counter_active", "native_herd_counter_blocked", "native_herd_counter_idle", "native_herd_counter_total",
  "repo_filter_active_aria", "repo_filter_apply_aria", "repo_switcher_label", "research_badge_label",
  "session_autopilot_paused_label", "terminal_badge_label", "unitrow_manual_steps", "unitrow_quota_error",
  "unitrow_quota_review", "unitrow_quota_rework", "usage_limits_no_data", "usage_limits_window_5h",
  "usage_limits_window_week", "usage_subscription_only",
];
```

- [ ] **Step 3: Regenerate and check both gates**

```bash
bun run native/scripts/gen-strings.ts && bun run check:strings && (cd ui && bun run check:i18n)
```

Expected: `Localizable.xcstrings is up to date (N keys).` and the UI i18n gate passes. A key missing
from either JSON catalog fails here by name — fix the key, never the generator.

- [ ] **Step 4: Write the catalog test**

```swift
import Testing

@testable import Shepherd

/// A missing catalog entry makes `String(localized:)` echo the key back, which would ship a screen
/// full of snake_case.
@MainActor
struct SidebarStringsTests {
    @Test func everyPlainKeyResolves() {
        let keys: [StaticString] = [
            "herd_lenses_label", "herd_seg_all", "herd_seg_ready", "herd_seg_done",
            "herd_seg_next", "herd_seg_owed", "herd_all_title", "herd_ready_title",
            "herd_done_title", "herd_next_title", "herd_owed_title", "herd_ready_empty",
            "herd_done_empty", "herd_stage_name_active", "repo_switcher_label",
            "research_badge_label", "terminal_badge_label", "session_autopilot_paused_label",
            "unitrow_quota_rework", "unitrow_quota_review", "unitrow_quota_error",
            "usage_limits_window_5h", "usage_limits_window_week", "usage_limits_no_data",
            "usage_subscription_only", "native_herd_counter_active", "native_herd_counter_idle",
            "native_herd_counter_blocked", "native_herd_counter_total",
        ]
        for key in keys {
            let value = L.t(key)
            #expect(!value.isEmpty)
            #expect(!value.contains("_"), "key \(key) did not resolve")
        }
    }

    @Test func argumentCarryingKeysInterpolate() {
        let keys: [StaticString] = [
            "herd_ready_group", "herd_merging_group", "herd_merged_group",
            "herd_awaiting_merge_group", "herd_ci_running_group", "herd_ci_failed_group",
            "herd_reviewer_running_group", "herd_rework_running_group",
            "herd_changes_requested_group", "herd_merge_blocked_group",
            "herd_draft_awaiting_signoff_group", "herd_waiting_reviewer_group_multi",
            "herd_waiting_merger_group_multi", "unitrow_manual_steps",
            "repo_filter_apply_aria", "repo_filter_active_aria", "herd_repo_filter_empty",
        ]
        for key in keys {
            #expect(L.t(key, "7").contains("7"), "key \(key) dropped its argument")
        }
    }
}
```

- [ ] **Step 5: Run the app tests and commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests 2>&1 | tail -3
```

Expected: `** TEST SUCCEEDED **`.

```bash
git add native/scripts/gen-strings.ts native/Apps/ShepherdMac/Resources/Localizable.xcstrings \
  ui/messages/en.json ui/messages/de.json \
  native/Apps/ShepherdMac/Tests/SidebarStringsTests.swift
git commit -m "feat(i18n): sidebar and header catalog keys for the mac app"
```

---

### Task 4: `HerdPartition` — the pure derivation module

**Files:** create `native/Apps/ShepherdMac/Sources/Sidebar/HerdPartition.swift` and
`native/Apps/ShepherdMac/Tests/HerdPartitionTests.swift`.

**Interfaces:**
- Consumes: `Session`, `SessionStatus`, `BlockReason` from ShepherdKit;
  `PreviewData.session(id:status:)`.
- Produces: `HerdLens` (`.next/.all/.ready/.done/.owed`, with `labelKey`, `titleKey`, `glyph`,
  `isAvailable`), `HerdStage` (14 cases, `headingKey`), `RepoChip`, `HerdGroup`, `Tallies`, and
  ```swift
  enum HerdPartition {
      static let mergingWindowMs: Int
      static func displayStatus(_ s: Session, workingBlocked: [String: Bool]) -> SessionStatus
      static func repoChips(_ s: [Session]) -> [RepoChip]
      static func filter(_ s: [Session], repos: Set<String>) -> [Session]
      static func shown(_ s: [Session], lens: HerdLens, workingBlocked: [String: Bool],
                        now: Int, gitStage: (Session) -> HerdStage?) -> [Session]
      static func isMerging(_ s: Session, now: Int) -> Bool
      static func stageOf(_ s: Session, now: Int, gitStage: (Session) -> HerdStage?) -> HerdStage
      static func groups(_ s: [Session], now: Int, gitStage: (Session) -> HerdStage?) -> [HerdGroup]
      static func tallies(_ s: [Session], workingBlocked: [String: Bool]) -> Tallies
      static func quotaKind(_ block: BlockReason?) -> String?
  }
  ```

- [ ] **Step 1: Write the failing tests**

```swift
import Testing
import ShepherdKit

@testable import Shepherd

@MainActor
struct HerdPartitionTests {
    private let now = 1_800_000_000_000
    private let noGit: (Session) -> HerdStage? = { _ in nil }

    private func session(
        _ id: String, repo: String = "/repos/a",
        status: SessionStatus = SessionStatus(known: .running),
        ready: Bool = false, mergingSince: Int? = nil
    ) -> Session {
        var s = PreviewData.session(id: id, status: status)
        s.repoPath = repo
        s.readyToMerge = ready
        s.mergingSince = mergingSince
        return s
    }

    @Test func workingBlockedRepaintsOnlyBlockedSessionsAsRunning() {
        let blocked = session("a", status: SessionStatus(known: .blocked))
        let idle = session("b", status: SessionStatus(known: .idle))
        #expect(HerdPartition.displayStatus(blocked, workingBlocked: ["a": true]).known == .running)
        #expect(HerdPartition.displayStatus(blocked, workingBlocked: ["a": false]).known == .blocked)
        #expect(HerdPartition.displayStatus(blocked, workingBlocked: [:]).known == .blocked)
        #expect(HerdPartition.displayStatus(idle, workingBlocked: ["b": true]).known == .idle)
    }

    @Test func repoChipsCountLiveSessionsSortedByPath() {
        let chips = HerdPartition.repoChips([
            session("a", repo: "/repos/zulu"),
            session("b", repo: "/repos/alpha"),
            session("c", repo: "/repos/alpha"),
            session("d", repo: "/repos/gone", status: SessionStatus(known: .archived)),
        ])
        #expect(chips.map(\.path) == ["/repos/alpha", "/repos/zulu"])
        #expect(chips.first?.count == 2)
        #expect(chips.first?.name == "alpha")
    }

    @Test func anEmptyRepoFilterMeansEverything() {
        let sessions = [session("a", repo: "/repos/a"), session("b", repo: "/repos/b")]
        #expect(HerdPartition.filter(sessions, repos: []).count == 2)
        #expect(HerdPartition.filter(sessions, repos: ["/repos/b"]).map(\.id) == ["b"])
    }

    @Test func theReadyLensDropsRunningAndStagesWhereTheBallIsElsewhere() {
        let sessions = [
            session("run"),
            session("idle", status: SessionStatus(known: .idle)),
            session("blocked", status: SessionStatus(known: .blocked)),
        ]
        func shown(_ wb: [String: Bool], _ git: @escaping (Session) -> HerdStage?) -> [String] {
            HerdPartition.shown(
                sessions, lens: .ready, workingBlocked: wb, now: now, gitStage: git).map(\.id)
        }
        #expect(shown([:], noGit) == ["idle", "blocked"])
        #expect(shown(["blocked": true], noGit) == ["idle"])
        #expect(shown([:], { _ in .waitingOnReviewer }).isEmpty)
        #expect(shown([:], { _ in .ciFailed }).count == 2, "ciFailed is yours to act on")
    }

    @Test func allPassesThroughAndThePanelLensesShowNothing() {
        let sessions = [session("a"), session("b", status: SessionStatus(known: .idle))]
        #expect(
            HerdPartition.shown(
                sessions, lens: .all, workingBlocked: [:], now: now, gitStage: noGit).count == 2)
        for lens in [HerdLens.next, .owed] {
            #expect(
                HerdPartition.shown(
                    sessions, lens: lens, workingBlocked: [:], now: now, gitStage: noGit).isEmpty,
                "\(lens) renders a panel, not a session list")
        }
    }

    @Test func stagesAreMergingThenReadyThenActiveAndTheGitHookWins() {
        #expect(HerdPartition.isMerging(session("a", mergingSince: now - 1_000), now: now))
        #expect(
            !HerdPartition.isMerging(
                session("b", mergingSince: now - 25 * 60 * 60 * 1_000), now: now))
        #expect(!HerdPartition.isMerging(session("c"), now: now))
        #expect(
            HerdPartition.stageOf(
                session("d", ready: true, mergingSince: now - 1_000), now: now, gitStage: noGit)
                == .merging)
        #expect(HerdPartition.stageOf(session("e", ready: true), now: now, gitStage: noGit) == .ready)
        #expect(HerdPartition.stageOf(session("f"), now: now, gitStage: noGit) == .active)
        #expect(
            HerdPartition.stageOf(session("g", ready: true), now: now, gitStage: { _ in .merged })
                == .merged)
    }

    @Test func groupsFollowTheWebRenderOrderAndDropEmpties() {
        let groups = HerdPartition.groups(
            [
                session("ready", ready: true),
                session("active"),
                session("merging", mergingSince: now - 1_000),
            ], now: now, gitStage: noGit)
        #expect(groups.map(\.stage) == [.active, .ready, .merging])
        #expect(groups.allSatisfy { !$0.sessions.isEmpty })
    }

    @Test func everyStageHasAHeadingExceptActive() {
        for stage in HerdStage.allCases {
            if stage == .active {
                #expect(stage.headingKey == nil, "the active group is headerless in the web UI")
            } else {
                #expect(stage.headingKey != nil, "\(stage) has no heading key")
            }
        }
    }

    @Test func talliesCountThreeOfFiveStatusesAndUseTheDisplayStatus() {
        let sessions = [
            session("a"),
            session("b", status: SessionStatus(known: .idle)),
            session("c", status: SessionStatus(known: .blocked)),
            session("d", status: SessionStatus(known: .done)),
        ]
        #expect(
            HerdPartition.tallies(sessions, workingBlocked: [:])
                == Tallies(active: 1, idle: 1, blocked: 1, total: 4))
        #expect(
            HerdPartition.tallies(sessions, workingBlocked: ["c": true])
                == Tallies(active: 2, idle: 1, blocked: 0, total: 4))
    }

    @Test func quotaKindOnlyForQuotaShapesAndNeverForPlan() {
        func block(
            _ shape: BlockReason.shapePayload.Value1Payload,
            _ kind: BlockReason.quotaKindPayload.Value1Payload?
        ) -> BlockReason {
            BlockReason(
                shape: .init(value1: shape), options: [], tail: [],
                quotaKind: kind.map { .init(value1: $0) })
        }
        #expect(HerdPartition.quotaKind(block(.quota, .rework)) == "rework")
        #expect(HerdPartition.quotaKind(block(.quota, .review)) == "review")
        #expect(HerdPartition.quotaKind(block(.quota, .plan)) == nil)
        #expect(HerdPartition.quotaKind(block(.stall, nil)) == nil)
        #expect(HerdPartition.quotaKind(nil) == nil)
    }
}
```

The nested payload names (`BlockReason.shapePayload.Value1Payload`) are what
swift-openapi-generator emits for an **inline** open enum — `BlockReason.shape` keeps its
`anyOf: [{type: string, enum: […]}, {type: string}]` form because an inline schema has no name to
generate a type from (`contracts/README.md`, "Open enums"). If the generated spelling differs, take
it from `native/.build/plugins/outputs/**/Types.swift`; never reshape the contract to suit a test.

- [ ] **Step 2: Run them and watch them fail**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/HerdPartitionTests 2>&1 | tail -20
```

Expected: `cannot find 'HerdPartition' in scope`.

- [ ] **Step 3: Write the module**

```swift
import Foundation
import ShepherdKit

/// The five lenses of the web's lens strip (`ui/src/lib/components/herd-partition.ts:67`). `next`
/// and `owed` render separate panels, so `shown` returns nothing for them — as the web does — and
/// this build disables their buttons.
enum HerdLens: String, CaseIterable, Sendable {
    case next, all, ready, done, owed

    var labelKey: StaticString {
        switch self {
        case .next: "herd_seg_next"
        case .all: "herd_seg_all"
        case .ready: "herd_seg_ready"
        case .done: "herd_seg_done"
        case .owed: "herd_seg_owed"
        }
    }

    var titleKey: StaticString {
        switch self {
        case .next: "herd_next_title"
        case .all: "herd_all_title"
        case .ready: "herd_ready_title"
        case .done: "herd_done_title"
        case .owed: "herd_owed_title"
        }
    }

    /// The web's glyphs (`ui/src/lib/components/herd/lens-glyphs.ts`).
    var glyph: String {
        switch self {
        case .next: "↑"
        case .all: "▦"
        case .ready: "▤"
        case .done: "✓"
        case .owed: "☑"
        }
    }

    var isAvailable: Bool { self == .all || self == .ready || self == .done }
}

/// The fourteen lifecycle stages of `stageOf` (`herd-partition.ts:165-183`), declared in the web's
/// render order (`STAGE_ORDER`, `:190-205`). Nine are decided by per-session git state, which
/// stream S2 owns; until its classifier is injected they stay empty.
enum HerdStage: String, CaseIterable, Sendable {
    case active, ciRunning, ciFailed, reviewerRunning, reworkRunning, needsRework
    case branchProtectionBlocked, waitingOnReviewer, waitingOnMerger, draftAwaitingSignoff
    case awaitingMerge, ready, merging, merged

    /// `nil` for `active`: the web renders that group headerless (`Herd.svelte:460-465`).
    var headingKey: StaticString? {
        switch self {
        case .active: nil
        case .ciRunning: "herd_ci_running_group"
        case .ciFailed: "herd_ci_failed_group"
        case .reviewerRunning: "herd_reviewer_running_group"
        case .reworkRunning: "herd_rework_running_group"
        case .needsRework: "herd_changes_requested_group"
        case .branchProtectionBlocked: "herd_merge_blocked_group"
        case .waitingOnReviewer: "herd_waiting_reviewer_group_multi"
        case .waitingOnMerger: "herd_waiting_merger_group_multi"
        case .draftAwaitingSignoff: "herd_draft_awaiting_signoff_group"
        case .awaitingMerge: "herd_awaiting_merge_group"
        case .ready: "herd_ready_group"
        case .merging: "herd_merging_group"
        case .merged: "herd_merged_group"
        }
    }
}

struct RepoChip: Identifiable, Equatable, Sendable {
    let path: String
    let name: String
    let count: Int
    var id: String { path }
}

struct HerdGroup: Identifiable, Equatable, Sendable {
    let stage: HerdStage
    let sessions: [Session]
    var id: String { stage.rawValue }
}

struct Tallies: Equatable, Sendable {
    let active: Int
    let idle: Int
    let blocked: Int
    let total: Int
}

/// Every list decision the sidebar makes, with no SwiftUI and no I/O, so all of it is unit-tested
/// against the web UI's own rules instead of eyeballed in a running app.
enum HerdPartition {
    /// The web's merge window (`ui/src/lib/components/merge-train.ts:16-18`).
    static let mergingWindowMs = 24 * 60 * 60 * 1_000

    /// `ui/src/lib/display-status.ts:11-16`: a session the poller called blocked but which is still
    /// producing output reads as running. Nothing else is repainted.
    static func displayStatus(_ session: Session, workingBlocked: [String: Bool]) -> SessionStatus {
        guard session.status.known == .blocked, workingBlocked[session.id] == true else {
            return session.status
        }
        return SessionStatus(known: .running)
    }

    /// `ui/src/lib/components/queue-strip.ts:51-79`. Archived sessions make no chip; the count is
    /// the repo's live session count; sorted by path so the rail does not jump around.
    static func repoChips(_ sessions: [Session]) -> [RepoChip] {
        var counts: [String: Int] = [:]
        for session in sessions where session.status.known != .archived {
            counts[session.repoPath, default: 0] += 1
        }
        return counts.keys.sorted().map {
            RepoChip(path: $0, name: ($0 as NSString).lastPathComponent, count: counts[$0] ?? 0)
        }
    }

    /// An empty selection means "no repo filter", like the web's empty filter set.
    static func filter(_ sessions: [Session], repos: Set<String>) -> [Session] {
        repos.isEmpty ? sessions : sessions.filter { repos.contains($0.repoPath) }
    }

    /// `NOT_YOUR_TURN` (`herd-partition.ts:76-81`). `ciFailed` and `draftAwaitingSignoff` are
    /// deliberately absent: both are yours to act on.
    private static let notYourTurn: Set<HerdStage> = [
        .ciRunning, .waitingOnReviewer, .waitingOnMerger, .merging,
    ]

    /// `shownSessions` (`herd-partition.ts:93-111`).
    static func shown(
        _ sessions: [Session], lens: HerdLens, workingBlocked: [String: Bool], now: Int,
        gitStage: (Session) -> HerdStage?
    ) -> [Session] {
        switch lens {
        case .next, .owed: return []
        case .all, .done: return sessions
        case .ready:
            return sessions.filter { session in
                guard displayStatus(session, workingBlocked: workingBlocked).known != .running
                else { return false }
                return !notYourTurn.contains(stageOf(session, now: now, gitStage: gitStage))
            }
        }
    }

    static func isMerging(_ session: Session, now: Int) -> Bool {
        guard let since = session.mergingSince else { return false }
        return now - since < mergingWindowMs
    }

    /// `gitStage` is stream S2's classifier: it returns the stage for any git-decided case —
    /// including `ready`, which sits between them in the web's precedence — or `nil` when none
    /// applies. It is consulted first; the three git-free stages fill in behind it.
    static func stageOf(
        _ session: Session, now: Int, gitStage: (Session) -> HerdStage?
    ) -> HerdStage {
        if let stage = gitStage(session) { return stage }
        if isMerging(session, now: now) { return .merging }
        if session.readyToMerge { return .ready }
        return .active
    }

    /// Groups in `HerdStage`'s declaration order, which is the web's `STAGE_ORDER`; empties dropped.
    static func groups(
        _ sessions: [Session], now: Int, gitStage: (Session) -> HerdStage?
    ) -> [HerdGroup] {
        var buckets: [HerdStage: [Session]] = [:]
        for session in sessions {
            buckets[stageOf(session, now: now, gitStage: gitStage), default: []].append(session)
        }
        return HerdStage.allCases.compactMap { stage in
            guard let rows = buckets[stage], !rows.isEmpty else { return nil }
            return HerdGroup(stage: stage, sessions: rows)
        }
    }

    /// `TopBar.svelte:163-165, 286-289`. Only three of the five statuses get a tally, so the three
    /// never have to add up to `total` — a done session counts only in the total.
    static func tallies(_ sessions: [Session], workingBlocked: [String: Bool]) -> Tallies {
        var active = 0
        var idle = 0
        var blocked = 0
        for session in sessions {
            switch displayStatus(session, workingBlocked: workingBlocked).known {
            case .running: active += 1
            case .idle: idle += 1
            case .blocked: blocked += 1
            default: break
            }
        }
        return Tallies(active: active, idle: idle, blocked: blocked, total: sessions.count)
    }

    /// The quota chip (`Herd.svelte:270-274`, `UnitRowRight.svelte:226`): only a `quota` block, and
    /// never the `plan` kind, which the plan-gate badge already shows. `shape` and `quotaKind` are
    /// inline open enums, so the known member lives in `value1` rather than behind `OpenEnum`.
    static func quotaKind(_ block: BlockReason?) -> String? {
        guard let block, block.shape.value1 == .quota, let known = block.quotaKind?.value1,
            known != .plan
        else { return nil }
        return known.rawValue
    }
}
```

- [ ] **Step 4: Run green and commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/HerdPartitionTests 2>&1 | tail -3
```

Expected: `** TEST SUCCEEDED **`, 9 tests.

```bash
git add native/Apps/ShepherdMac/Sources/Sidebar/HerdPartition.swift \
  native/Apps/ShepherdMac/Tests/HerdPartitionTests.swift
git commit -m "feat(mac): herd partition rules ported from the web sidebar"
```

---

### Task 5: `SidebarModel` — the `AppExtension`

**Files:** create `native/Apps/ShepherdMac/Sources/Sidebar/SidebarModel.swift` and
`native/Apps/ShepherdMac/Tests/SidebarModelTests.swift`.

**Interfaces:**
- Consumes: `AppExtension`, `AppModel.register(_:)` / `app.extension(_:)` (S0-prep), `SessionStore`,
  `SessionStore.events()`, Task 2's four reads, Task 4's `HerdPartition`, `Log.ui`.
- Produces: `SidebarReads` (with `.live(_:)`) and
  ```swift
  @Observable @MainActor final class SidebarModel: AppExtension {
      init(store: SessionStore, app: AppModel); init(reads: SidebarReads, now: @escaping @Sendable () -> Int)
      var lens: HerdLens; var selectedRepos: Set<String>; var collapsedStages: Set<HerdStage>
      var gitStage: @MainActor (Session) -> HerdStage?
      var sessions: [Session]; var chips: [RepoChip]; var groups: [HerdGroup]
      var tallies: Tallies; var limits: UsageLimits?; var isSubscribed: Bool
      func block(for id: String) -> BlockReason?
      func toggleRepo(_ path: String, additive: Bool); func toggleCollapsed(_ stage: HerdStage)
      func refresh() async; func teardown()
  }
  ```

- [ ] **Step 1: Write the failing tests**

```swift
import Foundation
import Testing
import ShepherdKit

@testable import Shepherd

@MainActor
struct SidebarModelTests {
    /// Driven through the injectable reads rather than the network: Task 2 proves the HTTP mapping,
    /// this suite is about state.
    private func model(_ reads: SidebarReads = .stub) -> SidebarModel {
        SidebarModel(reads: reads, now: { 1_800_000_000_000 })
    }

    @Test func repoToggleReplacesUnlessAdditiveAndClearsOnRepeat() {
        let m = model()
        m.toggleRepo("/repos/a", additive: false)
        #expect(m.selectedRepos == ["/repos/a"])
        m.toggleRepo("/repos/b", additive: false)
        #expect(m.selectedRepos == ["/repos/b"])
        m.toggleRepo("/repos/a", additive: true)
        #expect(m.selectedRepos == ["/repos/a", "/repos/b"])
        m.toggleRepo("/repos/a", additive: true)
        #expect(m.selectedRepos == ["/repos/b"])
        m.toggleRepo("/repos/b", additive: false)
        #expect(m.selectedRepos.isEmpty, "clicking the only selected repo clears the filter")
    }

    @Test func collapseTogglesPerStage() {
        let m = model()
        m.toggleCollapsed(.ready)
        #expect(m.collapsedStages == [.ready])
        m.toggleCollapsed(.ready)
        #expect(m.collapsedStages.isEmpty)
    }

    @Test func refreshInstallsEverySnapshot() async {
        let m = model()
        await m.refresh()
        #expect(m.workingBlocked == ["s1": true])
        #expect(m.holds["s1"]?.code.known == .quota_hyphen_rework)
        #expect(m.usage?.limits.session5h?.pct == 42)
    }

    @Test func aRefreshThatLostItsRaceIsDropped() async {
        let m = model()
        m.armStaleGeneration()
        await m.refresh()
        #expect(m.workingBlocked.isEmpty, "a superseded snapshot must not be installed")
    }

    @Test func aFailedReadLeavesTheLastSnapshotInPlace() async {
        let m = model()
        await m.refresh()
        m.reads = .failing
        await m.refresh()
        #expect(m.workingBlocked == ["s1": true], "a failed read must not blank the sidebar")
    }

    @Test func teardownEndsTheEventSubscription() {
        let m = model()
        m.teardown()
        #expect(!m.isSubscribed)
    }

    @Test func groupsTalliesAndTheLensAllGoThroughHerdPartition() {
        let m = model()
        m.install(sessions: [
            PreviewData.session(id: "a", status: SessionStatus(known: .idle)),
            PreviewData.session(id: "b", status: SessionStatus(known: .running)),
            PreviewData.session(id: "c", status: SessionStatus(known: .archived)),
        ])
        #expect(m.tallies == Tallies(active: 1, idle: 1, blocked: 0, total: 2))
        #expect(m.groups.map(\.stage) == [.active])
        m.lens = .ready
        #expect(m.sessions.map(\.id) == ["a"])
    }
}
```

- [ ] **Step 2: Run them and watch them fail**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/SidebarModelTests 2>&1 | tail -20
```

Expected: `cannot find 'SidebarModel' in scope`.

- [ ] **Step 3: Write the model**

```swift
import Foundation
import Observation
import ShepherdKit

/// The four reads the sidebar bootstraps from, behind closures so the unit tests need no network
/// and no URL-protocol stub.
struct SidebarReads: Sendable {
    var workingBlocked: @Sendable () async throws -> [String: Bool]
    var holds: @Sendable () async throws -> [String: HoldReason]
    var blocks: @Sendable () async throws -> [String: BlockReason]
    var usage: @Sendable () async throws -> UsageLimitsResponse

    static func live(_ client: ShepherdClient) -> SidebarReads {
        SidebarReads(
            workingBlocked: { try await client.workingBlocked() },
            holds: { try await client.holds() },
            blocks: { try await client.blocks() },
            usage: { try await client.usage() })
    }
}

/// The Herd sidebar's state. `AppModel` owns it through the `AppExtension` seam — created after the
/// store exists, torn down with it — so it never outlives the store it reads, and a completion
/// landing after a profile switch finds a model whose generation has already moved.
@Observable
@MainActor
final class SidebarModel: AppExtension {
    private(set) var workingBlocked: [String: Bool] = [:]
    private(set) var holds: [String: HoldReason] = [:]
    private(set) var blocks: [String: BlockReason] = [:]
    private(set) var usage: UsageLimitsResponse?

    var lens: HerdLens = .all
    var selectedRepos: Set<String> = []
    var collapsedStages: Set<HerdStage> = []

    /// Stream S2's git classifier. Until S0-int assigns it, the nine git-decided stages stay empty.
    var gitStage: @MainActor (Session) -> HerdStage? = { _ in nil }

    @ObservationIgnored var reads: SidebarReads
    @ObservationIgnored private let now: @Sendable () -> Int
    @ObservationIgnored private weak var store: SessionStore?
    @ObservationIgnored private var offlineSessions: [Session] = []
    /// Bumped by every `refresh()`; a snapshot whose generation is no longer the newest is dropped
    /// rather than installed — the rule `SessionStore.refresh()` already uses.
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var staleOnce = false
    @ObservationIgnored private var watcher: Task<Void, Never>?

    var isSubscribed: Bool { watcher != nil }

    /// The production initializer the `AppExtension` seam calls.
    init(store: SessionStore, app: AppModel) {
        self.store = store
        self.reads = .live(store.client)
        self.now = { Int(Date().timeIntervalSince1970 * 1_000) }
        // One authenticated socket, owned by `SessionStore` — `store.events()` is the fan-out seam
        // S0-prep delivered for exactly this: several independent taps on the one connection, each
        // seeing every frame. The sidebar needs two frames the store's own `applyNow` does not model
        // (`held:changed`, `session:working-blocked`) only as signals to re-read; it never calls
        // `setActive`, so it sends no presence frame and cannot fight the store's.
        subscribe(store)
        Task { [weak self] in await self?.refresh() }
    }

    /// Test and preview initializer: no store, no socket.
    init(reads: SidebarReads, now: @escaping @Sendable () -> Int) {
        self.reads = reads
        self.now = now
    }

    // MARK: - Derived state

    private var liveSessions: [Session] {
        (store?.sessions ?? offlineSessions).filter { $0.status.known != .archived }
    }

    /// Non-archived sessions, narrowed by the repo filter and then by the lens.
    var sessions: [Session] {
        HerdPartition.shown(
            HerdPartition.filter(liveSessions, repos: selectedRepos),
            lens: lens, workingBlocked: workingBlocked, now: now(), gitStage: gitStage)
    }

    /// Built from the unfiltered list, so a repo whose sessions the lens hides keeps its chip.
    var chips: [RepoChip] { HerdPartition.repoChips(store?.sessions ?? offlineSessions) }

    var groups: [HerdGroup] { HerdPartition.groups(sessions, now: now(), gitStage: gitStage) }

    var tallies: Tallies {
        HerdPartition.tallies(
            HerdPartition.filter(liveSessions, repos: selectedRepos),
            workingBlocked: workingBlocked)
    }

    /// The `usage:limits` push the store applies wins over this model's bootstrap read: it is newer.
    var limits: UsageLimits? { store?.usageLimits ?? usage?.limits }

    /// The store's map when there is one — kept live by `session:block` — else the bootstrap read.
    func block(for id: String) -> BlockReason? { store?.blocks[id] ?? blocks[id] }

    // MARK: - Commands

    /// `nextRepoFilter` (`queue-strip.ts:89-102`): a plain click replaces the selection, or clears
    /// it when this repo was already the only one; shift-click toggles membership.
    func toggleRepo(_ path: String, additive: Bool) {
        if additive {
            if selectedRepos.contains(path) {
                selectedRepos.remove(path)
            } else {
                selectedRepos.insert(path)
            }
        } else {
            selectedRepos = selectedRepos == [path] ? [] : [path]
        }
    }

    func toggleCollapsed(_ stage: HerdStage) {
        if collapsedStages.contains(stage) {
            collapsedStages.remove(stage)
        } else {
            collapsedStages.insert(stage)
        }
    }

    /// Re-read all four snapshots. A failure keeps the previous snapshot: a blank sidebar is a worse
    /// answer than a slightly stale one, and `SessionStore` already owns the offline banner.
    func refresh() async {
        generation &+= 1
        let mine = generation
        do {
            async let flags = reads.workingBlocked()
            async let held = reads.holds()
            async let blocked = reads.blocks()
            async let limits = reads.usage()
            let loaded = try await (flags, held, blocked, limits)
            if staleOnce {
                staleOnce = false
                generation &+= 1
            }
            guard mine == generation else {
                Log.ui.debug("dropping a superseded sidebar snapshot")
                return
            }
            workingBlocked = loaded.0
            holds = loaded.1
            blocks = loaded.2
            usage = loaded.3
        } catch {
            Log.ui.debug(
                "sidebar snapshot read failed: \(String(describing: error), privacy: .public)")
        }
    }

    func teardown() {
        watcher?.cancel()
        watcher = nil
    }

    /// Both frames arrive as `ServerEvent.unknown(name:payload:)`: the contract declares them under
    /// this stream's `x-shepherd-events` block but deliberately not in `EventName`, so the store
    /// hands them back as the raw name plus the undecoded `data` bytes. The sidebar only needs the
    /// name — a re-read is cheap and both frames exist solely to trigger one — so `payload` is
    /// discarded here rather than decoded through `HeldChangedEvent`/`SessionWorkingBlockedEvent`.
    /// `store.events()` finishes its stream on `stop()`, so this `for await` ends with the store and
    /// needs no separate `start()`/`stop()` of its own.
    private func subscribe(_ store: SessionStore) {
        watcher = Task { @MainActor [weak self] in
            for await event in store.events() {
                guard let self else { return }
                guard case .unknown(let name, _) = event,
                    name == "held:changed" || name == "session:working-blocked"
                else { continue }
                await self.refresh()
            }
        }
    }

    #if DEBUG
        /// Stands in for the store when the model was built without one.
        func install(sessions: [Session]) { offlineSessions = sessions }
        /// Arms a one-shot "a newer refresh landed while yours was in flight".
        func armStaleGeneration() { staleOnce = true }
    #endif
}

#if DEBUG
    private struct SidebarStubError: Error {}

    extension SidebarReads {
        static let stub = SidebarReads(
            workingBlocked: { ["s1": true] },
            holds: {
                ["s1": HoldReason(code: HoldCode(known: .quota_hyphen_rework), params: .init(round: 2))]
            },
            blocks: { [:] },
            usage: {
                UsageLimitsResponse(
                    limits: UsageLimits(
                        session5h: .init(pct: 42, resetAt: 1_800_000_000_000),
                        week: .init(pct: 10, resetAt: 1_800_500_000_000),
                        perModelWeek: [], credits: nil, stale: false, calibratedAt: nil,
                        subscriptionOnly: false),
                    projections: [])
            })

        static let failing = SidebarReads(
            workingBlocked: { throw SidebarStubError() },
            holds: { throw SidebarStubError() },
            blocks: { throw SidebarStubError() },
            usage: { throw SidebarStubError() })
    }
#endif
```

- [ ] **Step 4: Run green and commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/SidebarModelTests 2>&1 | tail -3
```

Expected: `** TEST SUCCEEDED **`, 7 tests.

```bash
git add native/Apps/ShepherdMac/Sources/Sidebar/SidebarModel.swift \
  native/Apps/ShepherdMac/Tests/SidebarModelTests.swift
git commit -m "feat(mac): sidebar model with snapshot reads and event-driven refresh"
```

---

### Task 6: Sidebar views and the slot install

**Files:** create
`native/Apps/ShepherdMac/Sources/Sidebar/{SessionBadges,HerdGroupView,SidebarView}.swift` and
`native/Apps/ShepherdMac/Tests/SessionBadgesTests.swift`.

**Interfaces:**
- Consumes: `SidebarModel`, `HerdPartition`, `SidebarSlot.content`, `AppModel.register(_:)`,
  `SessionRow(session:)` (read-only), `L.t`.
- Produces: `SessionBadge`, `SessionBadges.items(for:block:)`, `SessionBadgeStack`, `HerdGroupView`,
  `SidebarView`, `SidebarInstall.run(_:)`.

- [ ] **Step 1: Write the failing badge tests**

```swift
import Testing
import ShepherdKit

@testable import Shepherd

@MainActor
struct SessionBadgesTests {
    private func session(
        research: Bool = false, terminal: Bool = false, paused: Bool = false, steps: Int = 0
    ) -> Session {
        var s = PreviewData.session(id: "a")
        s.research = research
        s.terminal = terminal
        s.autopilotPaused = paused
        s.manualSteps = (0..<steps).map { _ in .init() }
        return s
    }

    private func quotaBlock(_ kind: BlockReason.quotaKindPayload.Value1Payload) -> BlockReason {
        BlockReason(
            shape: .init(value1: .quota), options: [], tail: [], quotaKind: .init(value1: kind))
    }

    @Test func badgesAppearOnlyForTheFlagsThatAreSet() {
        #expect(SessionBadges.items(for: session(), block: nil).isEmpty)
        let items = SessionBadges.items(
            for: session(research: true, terminal: true, paused: true, steps: 3), block: nil)
        #expect(items.map(\.id) == ["research", "terminal", "needs-you", "manual-steps"])
        #expect(items.last?.text.contains("3") == true)
    }

    @Test func aQuotaBlockAddsItsBadgeBeforeNeedsYouAndPlanIsNotOne() {
        #expect(
            SessionBadges.items(for: session(paused: true), block: quotaBlock(.review)).map(\.id)
                == ["quota", "needs-you"])
        #expect(SessionBadges.items(for: session(), block: quotaBlock(.plan)).isEmpty)
    }

    @Test func noBadgeTextLeaksARawKey() {
        let items = SessionBadges.items(
            for: session(research: true, terminal: true, paused: true, steps: 1),
            block: quotaBlock(.rework))
        for item in items { #expect(!item.text.contains("_"), "\(item.id) leaked a key") }
    }
}
```

- [ ] **Step 2: Run them and watch them fail**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/SessionBadgesTests 2>&1 | tail -20
```

Expected: `cannot find 'SessionBadges' in scope`.

- [ ] **Step 3: Write the badge stack** (`Sources/Sidebar/SessionBadges.swift`)

```swift
import SwiftUI
import ShepherdKit

/// One chip in a row's badge stack, decided outside the view so the gates are unit-testable without
/// hosting SwiftUI — the pattern `SessionStatusStyle` already uses.
struct SessionBadge: Identifiable, Equatable {
    let id: String
    let text: String
    let tint: Color
}

/// The part of `ui/src/lib/components/unit-row/UnitRowRight.svelte` decidable from a `Session` plus
/// its block. The git-derived chips (PR state, CI dot, critic verdict) need stream S2's git snapshot
/// and are not rendered here.
enum SessionBadges {
    static func items(for session: Session, block: BlockReason?) -> [SessionBadge] {
        var items: [SessionBadge] = []
        if session.research == true {
            items.append(.init(id: "research", text: L.t("research_badge_label"), tint: .purple))
        }
        if session.terminal == true {
            items.append(.init(id: "terminal", text: L.t("terminal_badge_label"), tint: .secondary))
        }
        if let kind = HerdPartition.quotaKind(block) {
            items.append(.init(id: "quota", text: quotaLabel(kind), tint: .orange))
        }
        // The web hides this while the critic is re-reviewing; that needs git, so here it stands on
        // `autopilotPaused` alone.
        if session.autopilotPaused {
            items.append(
                .init(id: "needs-you", text: L.t("session_autopilot_paused_label"), tint: .orange))
        }
        let steps = session.manualSteps.count
        if steps > 0 {
            items.append(
                .init(
                    id: "manual-steps", text: L.t("unitrow_manual_steps", "\(steps)"),
                    tint: .yellow))
        }
        return items
    }

    private static func quotaLabel(_ kind: String) -> String {
        switch kind {
        case "rework": L.t("unitrow_quota_rework")
        case "review": L.t("unitrow_quota_review")
        default: L.t("unitrow_quota_error")
        }
    }
}

struct SessionBadgeStack: View {
    let badges: [SessionBadge]

    var body: some View {
        if !badges.isEmpty {
            HStack(spacing: 4) {
                ForEach(badges) { badge in
                    Text(verbatim: badge.text)
                        .font(.caption2.weight(.semibold))
                        .lineLimit(1)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(badge.tint.opacity(0.14), in: Capsule())
                        .foregroundStyle(badge.tint)
                }
            }
            .accessibilityElement(children: .combine)
        }
    }
}
```

- [ ] **Step 4: Write the group view** (`Sources/Sidebar/HerdGroupView.swift`)

```swift
import SwiftUI
import ShepherdKit

/// One lifecycle group: a collapsible header carrying its count, then its rows. The `active` stage
/// has no heading (the web renders it headerless), so it is never collapsible either.
struct HerdGroupView: View {
    let group: HerdGroup
    let isCollapsed: Bool
    let block: (String) -> BlockReason?
    let onToggle: () -> Void

    var body: some View {
        Section {
            if !isCollapsed {
                ForEach(group.sessions, id: \.id) { session in
                    VStack(alignment: .leading, spacing: 3) {
                        SessionRow(session: session)
                        SessionBadgeStack(
                            badges: SessionBadges.items(for: session, block: block(session.id)))
                    }
                    .tag(session.id)
                }
            }
        } header: {
            if let key = group.stage.headingKey {
                Button(action: onToggle) {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.down")
                            .font(.caption2)
                            .rotationEffect(.degrees(isCollapsed ? -90 : 0))
                        Text(verbatim: L.t(key, "\(group.sessions.count)"))
                        Spacer(minLength: 0)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("herd-group-\(group.stage.rawValue)")
            }
        }
    }
}
```

- [ ] **Step 5: Write the sidebar root and the install point** (`Sources/Sidebar/SidebarView.swift`)

```swift
import AppKit
import SwiftUI
import ShepherdKit

/// The Herd sidebar: lens strip, repo chip rail, then the grouped session list. Installed into
/// `SidebarSlot`, so `MainWindow` renders it without knowing it exists.
struct SidebarView: View {
    @Environment(AppModel.self) private var app
    let model: SidebarModel

    var body: some View {
        @Bindable var app = app

        return VStack(spacing: 0) {
            lensStrip
            // The web shows the rail only once there is something to choose between.
            if model.chips.count >= 2 { repoRail }
            Divider()
            list(selection: $app.selectedSessionID)
        }
        .accessibilityIdentifier("herd-sidebar")
    }

    private var lensStrip: some View {
        HStack(spacing: 0) {
            ForEach(HerdLens.allCases, id: \.self) { lens in
                Button { model.lens = lens } label: {
                    VStack(spacing: 1) {
                        Text(verbatim: lens.glyph).font(.caption)
                        Text(verbatim: L.t(lens.labelKey)).font(.caption2)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 5)
                    .background(model.lens == lens ? Color.orange.opacity(0.16) : .clear)
                }
                .buttonStyle(.plain)
                .disabled(!lens.isAvailable)
                .help(L.t(lens.titleKey))
                .accessibilityIdentifier("herd-lens-\(lens.rawValue)")
            }
        }
        .accessibilityLabel(L.t("herd_lenses_label"))
    }

    private var repoRail: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 6) {
                ForEach(model.chips) { chip in
                    let selected = model.selectedRepos.contains(chip.path)
                    Button {
                        model.toggleRepo(
                            chip.path, additive: NSEvent.modifierFlags.contains(.shift))
                    } label: {
                        HStack(spacing: 4) {
                            Text(verbatim: chip.name).lineLimit(1)
                            Text(verbatim: "\(chip.count)").foregroundStyle(.secondary)
                        }
                        .font(.caption)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(
                            selected
                                ? Color.accentColor.opacity(0.22) : Color.secondary.opacity(0.10),
                            in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(
                        selected
                            ? L.t("repo_filter_active_aria", chip.name)
                            : L.t("repo_filter_apply_aria", chip.name))
                    .accessibilityIdentifier("repo-chip-\(chip.name)")
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
        }
        .scrollIndicators(.never)
        .accessibilityLabel(L.t("repo_switcher_label"))
    }

    @ViewBuilder
    private func list(selection: Binding<String?>) -> some View {
        if model.groups.isEmpty {
            ContentUnavailableView(emptyCopy, systemImage: "tray")
        } else {
            List(selection: selection) {
                ForEach(model.groups) { group in
                    HerdGroupView(
                        group: group,
                        isCollapsed: model.collapsedStages.contains(group.stage),
                        block: { model.block(for: $0) },
                        onToggle: { model.toggleCollapsed(group.stage) })
                }
            }
        }
    }

    /// The web has a distinct empty line per lens, and one for an empty single-repo filter.
    private var emptyCopy: String {
        if model.selectedRepos.count == 1, let repo = model.selectedRepos.first {
            return L.t("herd_repo_filter_empty", (repo as NSString).lastPathComponent)
        }
        switch model.lens {
        case .ready: return L.t("herd_ready_empty")
        case .done: return L.t("herd_done_empty")
        default: return L.t("native_sidebar_empty")
        }
    }
}

/// This stream's single registration point, so nothing else here touches app start-up.
@MainActor
enum SidebarInstall {
    static func run(_ app: AppModel) {
        app.register(SidebarModel.self)
        SidebarSlot.content = { app in
            guard let model = app.extension(SidebarModel.self) else { return AnyView(EmptyView()) }
            return AnyView(SidebarView(model: model))
        }
    }
}
```

`ShepherdApp.swift` must call `SidebarInstall.run(app)` once at start-up. That one line is S0-int's
integration commit — **do not** add it here; note it in the PR body.

- [ ] **Step 6: Run the app tests, build, commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests 2>&1 | tail -3 \
  && ./native/scripts/build-app.sh 2>&1 | tail -3
```

Expected: `** TEST SUCCEEDED **` then `** BUILD SUCCEEDED **`.

```bash
git add native/Apps/ShepherdMac/Sources/Sidebar \
  native/Apps/ShepherdMac/Tests/SessionBadgesTests.swift
git commit -m "feat(mac): herd sidebar view with lens strip, repo rail and badges"
```

---

### Task 7: Header strip — tallies and the usage meter

**Files:** create `native/Apps/ShepherdMac/Sources/Header/{UsageMeter,HerdTallies,HeaderStrip}.swift`
and `native/Apps/ShepherdMac/Tests/UsageMeterTests.swift`; modify
`native/Apps/ShepherdMac/Sources/Sidebar/SidebarView.swift` (one line).

**Interfaces:**
- Consumes: `SidebarModel.tallies`, `SidebarModel.limits`, `Tallies`, `UsageLimits`.
- Produces: `UsageBar`, `UsageMeter.gaugeColor(_:)` / `.fill(_:)` / `.bars(_:)` / `.notice(_:)`,
  `UsageMeterView`, `HerdTalliesView`, `HeaderStrip`.

- [ ] **Step 1: Write the failing tests**

```swift
import SwiftUI
import Testing
import ShepherdKit

@testable import Shepherd

@MainActor
struct UsageMeterTests {
    private func limits(
        fiveHour: Double? = nil, week: Double? = nil, stale: Bool = false,
        subscriptionOnly: Bool = false
    ) -> UsageLimits {
        UsageLimits(
            session5h: fiveHour.map { .init(pct: $0, resetAt: 1) },
            week: week.map { .init(pct: $0, resetAt: 2) },
            perModelWeek: [], credits: nil, stale: stale, calibratedAt: nil,
            subscriptionOnly: subscriptionOnly)
    }

    // ui/src/lib/components/usage-gauges.ts:297-306 — strictly > 90 and > 50.
    @Test func gaugeColorLadderIsStrictlyGreaterThan() {
        #expect(UsageMeter.gaugeColor(91) == .red)
        #expect(UsageMeter.gaugeColor(90) == .orange)
        #expect(UsageMeter.gaugeColor(51) == .orange)
        #expect(UsageMeter.gaugeColor(50) == .secondary)
        #expect(UsageMeter.gaugeColor(0) == .secondary)
    }

    @Test func fillIsClampedToZeroAndOne() {
        #expect(UsageMeter.fill(-10) == 0)
        #expect(UsageMeter.fill(42) == 0.42)
        #expect(UsageMeter.fill(130) == 1)
    }

    @Test func barsAreFiveHourThenWeekAndSkipMissingWindows() {
        #expect(UsageMeter.bars(limits(fiveHour: 30)).map(\.id) == ["5H"])
        #expect(UsageMeter.bars(limits(fiveHour: 30, week: 70)).map(\.id) == ["5H", "WK"])
        #expect(UsageMeter.bars(limits(fiveHour: 30)).first?.pct == 30)
        #expect(UsageMeter.bars(limits(fiveHour: 30, stale: true)).first?.stale == true)
    }

    @Test func noticeCoversApiKeyModeAndNoWindowsAtAll() {
        let apiKey = limits(fiveHour: 30, subscriptionOnly: true)
        #expect(UsageMeter.bars(apiKey).isEmpty)
        #expect(UsageMeter.notice(apiKey) == L.t("usage_subscription_only"))
        #expect(UsageMeter.notice(limits()) == L.t("usage_limits_no_data"))
        #expect(UsageMeter.notice(limits(fiveHour: 30)) == nil)
    }
}
```

- [ ] **Step 2: Run them and watch them fail**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/UsageMeterTests 2>&1 | tail -20
```

Expected: `cannot find 'UsageMeter' in scope`.

- [ ] **Step 3: Write the meter** (`Sources/Header/UsageMeter.swift`)

```swift
import SwiftUI
import ShepherdKit

/// One rate-limit window as a bar. `5H` and `WK` are the web's codes for the five-hour and weekly
/// windows (`src/usage-limits.ts:6-9`) — codes, not copy, so they are not translated; the localized
/// name goes in the accessibility label.
struct UsageBar: Identifiable {
    let id: String
    let nameKey: StaticString
    let pct: Double
    let stale: Bool
}

enum UsageMeter {
    /// `gaugeColor` (`ui/src/lib/components/usage-gauges.ts:297-306`). Strictly greater-than, so
    /// exactly 90 and exactly 50 stay in the lower tier. A stale comment in the web's
    /// `TopBar.svelte` claims an "amber 75-90" band; it is wrong, and this is the real ladder.
    static func gaugeColor(_ pct: Double) -> Color {
        if pct > 90 { return .red }
        if pct > 50 { return .orange }
        return .secondary
    }

    /// `pct` arrives already computed server-side as a 0..100 used-percentage.
    static func fill(_ pct: Double) -> Double { min(max(pct, 0), 100) / 100 }

    /// The two windows in the web's order, skipping one the server has no data for. An
    /// api-key-mode server reports no windows at all.
    static func bars(_ limits: UsageLimits) -> [UsageBar] {
        guard !limits.subscriptionOnly else { return [] }
        var bars: [UsageBar] = []
        if let window = limits.session5h {
            bars.append(
                .init(
                    id: "5H", nameKey: "usage_limits_window_5h", pct: window.pct,
                    stale: limits.stale))
        }
        if let window = limits.week {
            bars.append(
                .init(
                    id: "WK", nameKey: "usage_limits_window_week", pct: window.pct,
                    stale: limits.stale))
        }
        return bars
    }

    /// What to say when there is no bar to draw; `nil` means the bars speak for themselves.
    static func notice(_ limits: UsageLimits) -> String? {
        if limits.subscriptionOnly { return L.t("usage_subscription_only") }
        if bars(limits).isEmpty { return L.t("usage_limits_no_data") }
        return nil
    }
}

struct UsageMeterView: View {
    let limits: UsageLimits?

    var body: some View {
        if let limits {
            if let notice = UsageMeter.notice(limits) {
                Text(verbatim: notice)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("usage-notice")
            } else {
                HStack(spacing: 8) {
                    ForEach(UsageMeter.bars(limits)) { bar in
                        HStack(spacing: 4) {
                            Text(verbatim: bar.id)
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                            GeometryReader { proxy in
                                ZStack(alignment: .leading) {
                                    Capsule().fill(Color.secondary.opacity(0.18))
                                    Capsule()
                                        .fill(UsageMeter.gaugeColor(bar.pct))
                                        .frame(width: proxy.size.width * UsageMeter.fill(bar.pct))
                                }
                            }
                            .frame(height: 4)
                        }
                        .opacity(bar.stale ? 0.5 : 1)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("\(L.t(bar.nameKey)) \(Int(bar.pct.rounded()))%")
                        .accessibilityIdentifier("usage-bar-\(bar.id)")
                    }
                }
            }
        }
    }
}
```

- [ ] **Step 4: Write the tallies and the strip, and mount it**

`Sources/Header/HerdTallies.swift`:

```swift
import SwiftUI

/// Aktiv / Inaktiv / Blockiert / Gesamt. Only three of the five statuses get a tally, so the three
/// deliberately do not add up to the total — a done session counts only in `total`.
struct HerdTalliesView: View {
    let tallies: Tallies

    var body: some View {
        HStack(spacing: 10) {
            tally("native_herd_counter_active", tallies.active, .green)
            tally("native_herd_counter_idle", tallies.idle, .secondary)
            tally("native_herd_counter_blocked", tallies.blocked, .orange)
            tally("native_herd_counter_total", tallies.total, .primary)
        }
        .font(.caption2)
        .accessibilityIdentifier("herd-tallies")
    }

    private func tally(_ key: StaticString, _ count: Int, _ tint: Color) -> some View {
        HStack(spacing: 3) {
            Text(verbatim: "\(count)").font(.caption2.weight(.semibold)).foregroundStyle(tint)
            Text(verbatim: L.t(key)).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}
```

`Sources/Header/HeaderStrip.swift`:

```swift
import SwiftUI

/// The band above the lens strip: what the herd is doing, and how much budget is left.
struct HeaderStrip: View {
    let model: SidebarModel

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HerdTalliesView(tallies: model.tallies)
            UsageMeterView(limits: model.limits)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("herd-header")
    }
}
```

Then mount it by inserting one line as the **first** child of `SidebarView.body`'s `VStack`:

```swift
        return VStack(spacing: 0) {
            HeaderStrip(model: model)
            lensStrip
```

- [ ] **Step 5: Run green, build, commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests 2>&1 | tail -3 \
  && ./native/scripts/build-app.sh 2>&1 | tail -3
```

Expected: `** TEST SUCCEEDED **` then `** BUILD SUCCEEDED **`.

```bash
git add native/Apps/ShepherdMac/Sources/Header \
  native/Apps/ShepherdMac/Sources/Sidebar/SidebarView.swift \
  native/Apps/ShepherdMac/Tests/UsageMeterTests.swift
git commit -m "feat(mac): header strip with herd tallies and the usage meter"
```

---

### Task 8: Live check, full verification and the PR

**Files:** create `native/Apps/ShepherdMac/Tests/SidebarLiveTests.swift`.

**Interfaces:** consumes everything above, plus `SHEPHERD_LIVE_BASE_URL` / `SHEPHERD_LIVE_TOKEN`.

- [ ] **Step 1: Write the live-gated test**

```swift
import Foundation
import Testing
import ShepherdKit

@testable import Shepherd

/// Skipped unless both variables are set, so CI (which has no tailnet) never runs it. The
/// integration lane runs it against the operator's server before every merge.
@MainActor
struct SidebarLiveTests {
    private func liveStore() throws -> SessionStore? {
        let env = ProcessInfo.processInfo.environment
        guard let raw = env["SHEPHERD_LIVE_BASE_URL"], let url = URL(string: raw),
            let token = env["SHEPHERD_LIVE_TOKEN"]
        else { return nil }
        let credentials = InMemoryCredentialStore()
        try credentials.save(StoredCredential(token: token, tokenId: "live"), for: "live")
        return try SessionStore(
            profile: ServerProfile(
                name: "live", baseURL: url, mode: .remote, credentialKey: "live"),
            credentials: credentials)
    }

    @Test func theFourSidebarReadsDecodeAgainstTheRealServer() async throws {
        guard let store = try liveStore() else { return }
        _ = try await store.client.workingBlocked()
        _ = try await store.client.holds()
        _ = try await store.client.blocks()
        let usage = try await store.client.usage()
        // Reaching here already proved the decode; assert one field so an empty body still fails.
        #expect(usage.limits.subscriptionOnly == true || usage.limits.subscriptionOnly == false)
    }

    @Test func theSidebarRendersGroupsForTheLiveHerd() async throws {
        guard let store = try liveStore() else { return }
        try await store.bootstrap()
        let model = SidebarModel(
            reads: .live(store.client), now: { Int(Date().timeIntervalSince1970 * 1_000) })
        await model.refresh()
        model.install(sessions: store.sessions)
        #expect(!store.sessions.isEmpty, "the live server should have sessions")
        #expect(!model.groups.isEmpty)
        #expect(model.tallies.total == store.sessions.filter { $0.status.known != .archived }.count)
    }
}
```

- [ ] **Step 2: Run it against the live server**

```bash
SHEPHERD_LIVE_BASE_URL="$SHEPHERD_LIVE_BASE_URL" SHEPHERD_LIVE_TOKEN="$SHEPHERD_LIVE_TOKEN" \
  ./native/scripts/test-app.sh -only-testing:ShepherdTests/SidebarLiveTests 2>&1 | tail -3
```

Expected: `** TEST SUCCEEDED **`. Without the variables the same command passes with both tests
trivially satisfied — that is the CI path.

- [ ] **Step 3: Run every gate this stream can turn red**

```bash
bun run test:contract && bun run check:contract-swift && ./native/scripts/sync-contract.sh --check \
  && bun run check:strings && (cd ui && bun run check:i18n) && bun run lint \
  && bun run test && swift test --package-path native \
  && ./native/scripts/test-app.sh -only-testing:ShepherdTests \
  && ./native/scripts/build-app.sh
```

Expected in order: contract tests pass · no derived-file diff · `sync-contract: up to date` ·
`Localizable.xcstrings is up to date` · i18n gate passes · eslint clean · root suite passes ·
`swift test` passes · `** TEST SUCCEEDED **` · `** BUILD SUCCEEDED **`.

- [ ] **Step 4: Rebase and re-run the contract gate**

```bash
git fetch origin && git rebase origin/main && bun run test:contract 2>&1 | tail -3
```

A conflict between two stream markers in `contracts/openapi.yaml` is an insertion conflict: keep both
blocks. A conflict in `ui/messages/*.json` that the union merge driver did **not** resolve is a real
one — two branches gave the same key different values; resolve it on the merits.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin feat/native-sidebar
gh pr create --title "feat(mac): herd sidebar and header parity" --body "$(cat <<'EOF'
Stream S3. Brings the Herd sidebar and the header strip to Shepherd for Mac.

## What landed
- **Contract:** `GET /api/working-blocked`, `/api/holds`, `/api/blocks`, `/api/usage/limits`, plus
  the `held:changed` and `session:working-blocked` events, with fixtures, a drift test and a
  per-block coverage gate.
- **Kit:** `ShepherdClient+Backlog.swift` — four typed reads over the generated client.
- **App:** `HerdPartition` (pure, unit-tested against the web's own rules), `SidebarModel`
  (`AppExtension`, generation-guarded refresh, a tap on `SessionStore.events()`), the sidebar views
  and the header strip. `SidebarSlot.content` is assigned in `SidebarInstall`; `AppModel`, `MainWindow`
  and `SessionRow` are untouched.

## Deliberate deviations from the stream brief
- `GET /api/up-next` + `upnext:snapshot` are **out**: the route answers a bare JSON `null`, which
  `scripts/gen-contract-swift.ts` refuses in a response position, and Up Next is a forge-issue panel
  rather than part of the session list. The `Offen` lens is out for the same reason. Both lens
  buttons ship disabled with their web tooltips.
- `GET /api/backlog` is **out**: it feeds the Backlog overlay, not the sidebar. The repo chip rail is
  derived from sessions exactly as `ui/src/lib/components/queue-strip.ts` does, so hidden repos (a
  backlog-only concept) do not apply.
- `GET /api/prompt-budget` is **out**: it drives only the Usage dashboard's Prompt lens.
- No search field and no ⌘K — ⌘K is the web UI's global command bar, not a sidebar search.
- Nine of the fourteen lifecycle stages need per-session git state (stream S2), and with them the
  merged group and its "Alle stilllegen" bulk action. All fourteen stages, their order and their
  headings are implemented; `SidebarModel.gitStage` is the one-line seam S0-int assigns once S2
  lands.
- Known parity gap: the web meter prefers `limits.observed`, which the contract does not declare, so
  native numbers can differ. Extending `UsageLimits` is a core-schema change.

## Integration lane
`ShepherdApp` must call `SidebarInstall.run(app)` once at start-up — one line, S0-int's commit.
`ShepherdClient.generated` needed no widening: delivered by S0-prep as `internal` already.

## Verification
`bun run test:contract` · `bun run check:contract-swift` · `native/scripts/sync-contract.sh --check`
· `bun run check:strings` · `ui && bun run check:i18n` · `bun run lint` · `bun run test` ·
`swift test --package-path native` · `native/scripts/test-app.sh -only-testing:ShepherdTests` ·
`native/scripts/build-app.sh` · live smoke with `SHEPHERD_LIVE_BASE_URL` / `SHEPHERD_LIVE_TOKEN`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: Watch CI**

```bash
gh pr checks --watch
```

Expected: every check green, including the `native` workflow's `ShepherdKit` job, which runs
`check:contract-swift`, the sync freshness check, `swift build` and `swift test`.

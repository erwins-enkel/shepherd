# Stream S4 — Session actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Shepherd for Mac the per-session actions the web UI offers — stop the agent, resume
it, rename the session, amend the task, toggle ready-to-merge, relaunch, regenerate the recap — as a
quick-action bar under the detail pane with keyboard shortcuts, confirmations on the destructive
ones, and the recap's "Handlungsbedarf" line, contract-first and without touching a shared file.

**Architecture:** Six write routes and one read enter `contracts/openapi.yaml` inside this stream's
`actions` block, with two events (`session:recap`, `session:amendments`); Swift is regenerated from
the derived file; one kit extension (`ShepherdClient+Actions.swift`) wraps them. The app side is a
pure availability module (`ActionRules`, mirroring `ui/src/lib/format.ts`'s `canResume`/`canRelaunch`
and `UnitRow.svelte`'s `stoppable`), one `AppExtension` (`ActionsModel`) owning the recap/amendment
snapshots and a tap on `SessionStore.events()`, and views under `Sources/Actions/**` installed by
assigning `ActionBarSlot.content`. Every call goes through the existing `SessionCommandState` gate
from `Sources/Main/MainWindow.swift` — reused, never re-implemented.

**Tech Stack:** Bun + ajv (contract drift test), OpenAPI 3.1, swift-openapi-generator, Swift 6
(language mode 6, strict concurrency `complete`), SwiftUI, Swift Testing (`import Testing`),
XcodeGen, `os.Logger`.

---

## Global Constraints

- **Swift 6 strict concurrency** (`SWIFT_STRICT_CONCURRENCY: complete`, `swiftLanguageModes: [.v6]`).
  No `@preconcurrency`, no `@unchecked Sendable`, no `nonisolated(unsafe)`.
- **No hand-written `Codable` for server payloads.** The contract is the only type source: a route or
  event this stream needs is added to `contracts/openapi.yaml` first, then
  `bun run gen:contract-swift` + `./native/scripts/sync-contract.sh` regenerate and copy the derived
  file. Never hand-edit `contracts/openapi.swift.yaml` or `native/Sources/ShepherdKit/openapi.yaml`.
- **ShepherdKit has no UI dependency.** Nothing under `native/Sources/` imports SwiftUI or AppKit.
- **Strings only via `L.t()`**, with every key present in **both** `ui/messages/en.json` and
  `ui/messages/de.json` and listed in `KEYS_ACTIONS` in `native/scripts/gen-strings.ts`. Never add a
  string only in Swift. German copy matches the web UI verbatim — reuse the web's key rather than
  writing a second translation.
- **No Keychain prompts.** Build and test through `./native/scripts/build-app.sh` and
  `./native/scripts/test-app.sh` (which export `SHEPHERD_ISOLATED=1`, so the app runs on a private
  `UserDefaults` suite and an `InMemoryCredentialStore`). `SHEPHERD_KEYCHAIN_TESTS` is **never** set
  locally — it is CI's switch for the real-keychain suite.
- **`bun run test`, never bare `bun test`** (repo `CLAUDE.md`): the bare runner walks the wrong file
  set and "passes" without running the suite you meant.
- **Live tests read `SHEPHERD_LIVE_BASE_URL` / `SHEPHERD_LIVE_PASSWORD` from the environment only**
  — or `SHEPHERD_LIVE_TOKEN` in place of the password for the read-only unit suite, which is what
  `LiveServerEnvironment.token` already reads and what Task 8 uses. Never from a file, never in CI.
  Nothing in this branch writes any of the three to disk.
- **Commits:** conventional, lowercase subject; body lines ≤ 100 chars; body ends with
  `Co-Authored-By: <executing model name> <noreply@anthropic.com>`.
- **Push with `git push --no-verify`.**
- **Never edit `native/Apps/ShepherdMac/Sources/App/StreamRegistrations.swift`** inside this stream.
  It ships `ActionsStream.install(app)` and the integration lane (S0-int) adds the one line.
- **Logging:** `run.shepherd.mac` (app, via `Log.ui`/`Log.app`), `run.shepherd.kit` (kit).
- **Branch:** `feat/native-actions`, cut from `origin/main`. Rebase to update; never
  `git merge main`.

| Command (repo root) | What it proves |
| --- | --- |
| `bun run test:contract` | the contract matches the real server |
| `bun run gen:contract-swift` | regenerates `contracts/openapi.swift.yaml` |
| `./native/scripts/sync-contract.sh` | copies the derived file into the kit target |
| `swift test --package-path native` | kit compiles, kit tests pass |
| `./native/scripts/test-app.sh -only-testing:ShepherdTests` | app unit tests pass |
| `./native/scripts/build-app.sh` | `Shepherd.app` builds |
| `bun run check:strings` | `Localizable.xcstrings` is current |
| `bun run lint` · `bun run test` | repo gates |

### File ownership (hard rule)

Create or modify **only**: `contracts/openapi.yaml` (between `# ── stream: actions ──` and
`# ── /stream: actions ──` only, in all three sections) · the generated
`contracts/openapi.swift.yaml` and `native/Sources/ShepherdKit/openapi.yaml` ·
`test/contract/actions.test.ts`, `test/contract/actions-fixtures.ts` ·
`native/Sources/ShepherdKit/Client/ShepherdClient+Actions.swift` ·
`native/Tests/ShepherdKitTests/ShepherdClientActionsTests.swift` ·
`native/Apps/ShepherdMac/Sources/Actions/**` ·
`native/Apps/ShepherdMac/Tests/{ActionRules,ActionsModel,ActionBar,ActionsStrings,ActionsLive}Tests.swift`
· the `KEYS_ACTIONS` array in `native/scripts/gen-strings.ts` · `ui/messages/{en,de}.json`
(append-only, union merge driver) · the generated
`native/Apps/ShepherdMac/Resources/Localizable.xcstrings`.

Never edit `AppModel.swift`, `AppModel+Extensions.swift`, `MainWindow.swift`,
`SessionDetailView.swift`, `SessionRow.swift`, `ShepherdApp.swift`, `StreamRegistrations.swift`,
`ActionBarSlot.swift`, `SessionStore.swift`, `ServerEvent.swift`, `EventStream.swift`,
`ShepherdClient.swift`, `project.yml`, `native.yml`,
`test/contract/{harness,deps,stream-blocks,openapi.test}.ts`. `project.yml` needs no edit: its
`sources: - path: Sources` entry globs new subdirectories, and SwiftPM globs
`Sources/ShepherdKit/**`.

### Preconditions — verify before Task 1

```bash
grep -c "── stream: actions ──" contracts/openapi.yaml \
  && grep -q "KEYS_ACTIONS" native/scripts/gen-strings.ts \
  && test -f native/Apps/ShepherdMac/Sources/App/ActionBarSlot.swift \
  && test -f native/Apps/ShepherdMac/Sources/App/AppModel+Extensions.swift \
  && grep -q "final class SessionCommandState" native/Apps/ShepherdMac/Sources/Main/MainWindow.swift \
  && grep -qE "^\s+(internal )?let generated: Client" native/Sources/ShepherdKit/Client/ShepherdClient.swift \
  && echo OK || echo "S0-prep MISSING — stop and tell the orchestrator"
```

Expected: `3` then `OK`. The three markers are the ones in `components.schemas:`, `paths:` **and**
`x-shepherd-events:` — without the third, appending an event guarantees a rebase conflict with S2
and S3.

Three facts that matter and are easy to get wrong:

1. **`ShepherdClient.generated` is `internal` on purpose** so a same-module extension file can reach
   it (`native/Sources/ShepherdKit/Client/ShepherdClient.swift`, guarded by
   `GeneratedClientVisibilityTests`). Do not build a second `Client`.
2. **Coverage is scoped per stream block.** The gate at the end of `test/contract/openapi.test.ts`
   subtracts `streamOwnedPaths()`/`streamOwnedEvents()` — never touch it. This stream's surface is
   covered by its own `test/contract/actions.test.ts`, which ends with its own gate.
3. **`SessionCommandState` already exists** (`native/Apps/ShepherdMac/Sources/Main/MainWindow.swift`,
   same module, with `SessionCommandStateTests` and `NoticeBar` beside it). Reuse it; a second
   busy/error gate with a different name is a review rejection.

### Deliberate deviations from the stream brief

The brief listed a chip row (`ok`, `folge dir`, `commit-push-merge`, `rebase`, `run tests`,
`handoff-issue`, `tldr-status`) over `/reply`, `/recommend-prompt`, `/go`, `/answer-plan-questions`
and `/relaunch`. Reading the web UI changed five things. Each is intentional and must survive review.

1. **There is no preset-chip row in the web UI.** No component renders those chips; `grep -rn
   "quick" ui/src/lib/components` finds only the command bar and the lens strip. The per-session
   actions the web actually offers are `CardMenu.svelte`'s ten items (right-click / long-press on a
   session card), `viewport/ViewportHeaderActions.svelte`'s Resume and Decommission, and the
   hold-row CTA in `UnitRow.svelte`. **This plan implements the `CardMenu` set that has its own
   route and is not owned by another stream.**
2. **`POST /api/sessions/{id}/reply` is S1's**, per the master plan's stream table ("send input via
   the PTY; `POST /api/sessions/{id}/reply` for the prompt bar"). A path may appear once in
   `contracts/openapi.yaml`, so S4 does not declare it, does not wrap it and offers no steer action.
   `POST /api/sessions/{id}/recommend-prompt` goes with it: a recommended prompt with no composer to
   land in is a dead route.
3. **`/go` and `/answer-plan-questions` are out.** Both act on the plan gate, whose payload family
   (`PlanGate`, its `question-form` `VisualBlock`s, `session:plangate`) no stream owns yet, and
   whose success paths cannot be driven through the stubbed contract server without writing gate
   rows directly into the store. Releasing a gate the app cannot display is an action without
   context. They belong with a later plan-gate stream, together with the `hold-row` CTA.
4. **Merge PR, `Start as variant…`, `Continue with…`, `Relaunch in another repo…` and
   `Clean terminal in main repo` are out.** The first is S2's (`/git/merge`, with its own
   `MergeConfirmDialog` gate); the next two need a provider/model picker plus `ExperimentRole`
   handling; the last two are create flows, not session actions.
5. **Decommission stays where it is.** `MainWindow`'s toolbar already archives with a
   `confirmationDialog` (`native_archive_confirm_*`). Adding a second archive affordance to the bar
   would give the operator two buttons with different confirmation mechanics for one destructive
   act. The bar shows the actions the toolbar does not.

**Known parity gaps, documented not fixed.** The web gates Relaunch on `git?.state !== "merged"` and
Stop on the **display** status (`displayStatus(s, workingBlocked)`, which promotes a
working-while-blocked session back to "running"). `GitState` is S2's and `/api/working-blocked` is
S3's, so `ActionRules` takes both as injected values defaulting to `nil`/`[:]`; S0-int assigns
`ActionsModel.gitState` and `ActionsModel.workingBlocked` once those land. The rules themselves are
implemented in full and unit-tested against injected values.

### Task order

| # | Task | Key files |
| --- | --- | --- |
| 1 | Contract: action routes, recap read, two events | `contracts/openapi.yaml`, `test/contract/actions{,-fixtures}.ts` |
| 2 | Kit: `ShepherdClient+Actions.swift` | `ShepherdClient+Actions.swift` |
| 3 | Strings: `KEYS_ACTIONS` + EN/DE | `gen-strings.ts`, `ui/messages/*.json` |
| 4 | `ActionRules` — pure availability | `Sources/Actions/ActionRules.swift` |
| 5 | `ActionsModel` — the `AppExtension` | `Sources/Actions/ActionsModel.swift` |
| 6 | The action bar, shortcuts and the slot install | `Sources/Actions/{ActionBarView,ActionsStream}.swift` |
| 7 | Rename and Amend sheets | `Sources/Actions/{RenameSheet,AmendSheet}.swift` |
| 8 | Live check, gate sweep, PR | `Tests/ActionsLiveTests.swift` |

---

### Task 1: Contract — action routes, the recap read and two events

**Files:** modify `contracts/openapi.yaml` (actions blocks only); create
`test/contract/actions-fixtures.ts`, `test/contract/actions.test.ts`; regenerate
`contracts/openapi.swift.yaml` and `native/Sources/ShepherdKit/openapi.yaml`.

**Interfaces:**
- Consumes: the core block's `Session`, `Ok`, `Error`, `#/components/responses/Unauthorized`;
  `harness.ts`'s `startContractServer`, `login`, `mintToken`, `bearer`, `collectEvents`,
  `validateResponse`, `validateEvent`, `coverage`, `withAuth`, `restoreAuth`, `type ContractServer`.
- Produces: schemas `ResumeRequest`, `RenameRequest`, `RenameResult`, `AmendmentRequest`,
  `TaskAmendment`, `AmendmentCreated`, `ReadyRequest`, `RelaunchResult`, `RecapState`,
  `RecapStateKnown`, `RecapVerdict`, `RecapVerdictKnown`, `Recap`, `RecapMap`,
  `RecapRegenerateStatus`, `RecapRegenerateStatusKnown`, `RecapRegenerateResult`,
  `SessionRecapEvent`, `SessionAmendmentsEvent`; operations `resumeSession`, `renameSession`,
  `amendSession`, `setSessionReady`, `relaunchSession`, `regenerateRecap`, `listRecaps`; events
  `session:recap`, `session:amendments`.

- [ ] **Step 1: Cut the branch and write the fixtures**

```bash
cd /Users/kai.osthoff/githubrepos/shepherd
git fetch origin main
git worktree add .claude/worktrees/feat-native-actions -b feat/native-actions origin/main
cd .claude/worktrees/feat-native-actions && bun install
```

`test/contract/actions-fixtures.ts`:

```ts
import type { Recap } from "../../src/types";

/** The one payload the stubbed server cannot produce itself: `deps.recap` is unwired in
 *  test/contract/deps.ts, so no recap is ever generated. Typed with the server's own `Recap`,
 *  so a field rename in src/types.ts breaks `bun run typecheck` before it can drift past the
 *  contract. The contract's `Recap` is a documented subset with additionalProperties: true —
 *  the native client reads the seven fields the action bar shows and ignores the rest. */
export const recap: Recap = {
  sessionId: "sess_fixture",
  state: "ready",
  headSha: "0123456789abcdef0123456789abcdef01234567",
  base: "main",
  verdict: "needs_attention",
  headline: "Rate limiter lands, two follow-ups open",
  body: "Adds the token bucket and its tests. Two call sites still bypass it.",
  openItems: ["wire the admin route through the limiter", "document the burst window"],
  changedFiles: ["src/limiter.ts", "test/limiter.test.ts"],
  spawnSessionId: "sess_recap_agent",
  cwd: "/tmp/wt",
  model: "claude-opus-5",
  spawnedAt: 1_800_000_000_000,
  generatedAt: 1_800_000_060_000,
  updatedAt: 1_800_000_060_000,
};
```

`test/contract/actions.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fx from "./actions-fixtures";
import {
  bearer, collectEvents, coverage, login, mintToken, restoreAuth, startContractServer,
  validateEvent, validateResponse, withAuth, type ContractServer,
} from "./harness";
import { eventsForStream, operationsForStream } from "./stream-blocks";

/** This block's own coverage gate, so the stream proves its surface whichever file Bun runs
 *  first; the gate in openapi.test.ts covers the core block and subtracts this one.
 *
 *  Derived from the contract, never hand-kept. A literal list drifts silently in one direction
 *  only — a status declared in `paths:` but forgotten here is declared-but-unexercised, and
 *  nothing anywhere catches it, which is the exact hole the per-stream split exists to close.
 *  `operationsForStream` reads the same marked block this task writes, so the gate fails the
 *  moment the two disagree. */
const OPERATIONS = operationsForStream("actions");
const EVENTS = eventsForStream("actions");

let s: ContractServer;
let token: string;

/** JSON POST with the bearer. Every route in this block takes a JSON body or none; the ones
 *  that gate on the content-type (reply/rename/amendments/ready) get one unconditionally. */
async function post(path: string, body?: unknown, auth = true): Promise<Response> {
  return fetch(`${s.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? bearer(token) : {}),
    },
    body: JSON.stringify(body ?? {}),
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
  ({ token } = await mintToken(s, await login(s), "actions contract test"));
});
afterAll(() => {
  try {
    s?.stop();
  } finally {
    restoreAuth();
  }
});

describe("resume", () => {
  test("adopts a session that has a conversation, refuses one that has none", async () => {
    const id = await createSession("resume me");
    // resumeTarget() needs hasConversation(): a claude session id. The stub spawns a pane but
    // never records one, so this is the one piece of state the route cannot reach on its own.
    s.deps.store.update(id, { claudeSessionId: "claude-fixture" });
    const ok = await post(`/api/sessions/${id}/resume`, { force: false });
    expect(ok.status).toBe(200);
    const body = (await validateResponse("POST", "/api/sessions/{id}/resume", ok)) as {
      id: string;
    };
    expect(body.id).toBe(id);

    const gone = await post("/api/sessions/nope/resume", {});
    expect(gone.status).toBe(409);
    await validateResponse("POST", "/api/sessions/{id}/resume", gone);

    const anon = await post(`/api/sessions/${id}/resume`, {}, false);
    expect(anon.status).toBe(401);
    await validateResponse("POST", "/api/sessions/{id}/resume", anon);
  });
});

describe("rename", () => {
  test("renames, rejects an empty name and an unknown id", async () => {
    const id = await createSession("rename me");
    const ok = await post(`/api/sessions/${id}/rename`, { name: "fresh name" });
    expect(ok.status).toBe(200);
    const body = (await validateResponse("POST", "/api/sessions/{id}/rename", ok)) as {
      session: { name: string };
      branchRenamed: boolean;
    };
    expect(body.session.name).toBe("fresh-name");
    expect(typeof body.branchRenamed).toBe("boolean");

    const bad = await post(`/api/sessions/${id}/rename`, { name: "   " });
    expect(bad.status).toBe(400);
    await validateResponse("POST", "/api/sessions/{id}/rename", bad);

    const gone = await post("/api/sessions/nope/rename", { name: "x" });
    expect(gone.status).toBe(404);
    await validateResponse("POST", "/api/sessions/{id}/rename", gone);

    const anon = await post(`/api/sessions/${id}/rename`, { name: "x" }, false);
    expect(anon.status).toBe(401);
    await validateResponse("POST", "/api/sessions/{id}/rename", anon);
  });
});

describe("amendments", () => {
  test("records an amendment, rejects an empty one and an unknown id", async () => {
    const id = await createSession("amend me");
    const ok = await post(`/api/sessions/${id}/amendments`, {
      text: "Also cover the admin route.",
      steer: false,
    });
    expect(ok.status).toBe(201);
    const body = (await validateResponse("POST", "/api/sessions/{id}/amendments", ok)) as {
      amendment: { sessionId: string; retractedAt: number | null };
      steered: boolean;
    };
    expect(body.amendment.sessionId).toBe(id);
    expect(body.amendment.retractedAt).toBeNull();
    expect(body.steered).toBe(false);

    const bad = await post(`/api/sessions/${id}/amendments`, { text: "   " });
    expect(bad.status).toBe(400);
    await validateResponse("POST", "/api/sessions/{id}/amendments", bad);

    const gone = await post("/api/sessions/nope/amendments", { text: "x" });
    expect(gone.status).toBe(404);
    await validateResponse("POST", "/api/sessions/{id}/amendments", gone);

    const anon = await post(`/api/sessions/${id}/amendments`, { text: "x" }, false);
    expect(anon.status).toBe(401);
    await validateResponse("POST", "/api/sessions/{id}/amendments", anon);
  });
});

describe("ready to merge", () => {
  test("toggles the flag, rejects a non-boolean and an unknown id", async () => {
    const id = await createSession("ready me");
    const ok = await post(`/api/sessions/${id}/ready`, { ready: true });
    expect(ok.status).toBe(200);
    await validateResponse("POST", "/api/sessions/{id}/ready", ok);
    expect(s.deps.store.get(id)?.readyToMerge).toBe(true);

    const bad = await post(`/api/sessions/${id}/ready`, { ready: "yes" });
    expect(bad.status).toBe(400);
    await validateResponse("POST", "/api/sessions/{id}/ready", bad);

    const gone = await post("/api/sessions/nope/ready", { ready: true });
    expect(gone.status).toBe(404);
    await validateResponse("POST", "/api/sessions/{id}/ready", gone);

    const anon = await post(`/api/sessions/${id}/ready`, { ready: true }, false);
    expect(anon.status).toBe(401);
    await validateResponse("POST", "/api/sessions/{id}/ready", anon);
  });
});

describe("relaunch", () => {
  test("spawns a replacement and archives the original", async () => {
    const id = await createSession("relaunch me");
    const ok = await post(`/api/sessions/${id}/relaunch`);
    expect(ok.status).toBe(201);
    const body = (await validateResponse("POST", "/api/sessions/{id}/relaunch", ok)) as {
      session: { id: string };
      archived: boolean;
    };
    expect(body.session.id).not.toBe(id);
    expect(typeof body.archived).toBe("boolean");
  });

  test("rejects an unknown override key, an unknown id and an archived session", async () => {
    const bad = await post(`/api/sessions/${await createSession("bad override")}/relaunch`, {
      notAnOverride: 1,
    });
    expect(bad.status).toBe(400);
    await validateResponse("POST", "/api/sessions/{id}/relaunch", bad);

    const gone = await post("/api/sessions/nope/relaunch");
    expect(gone.status).toBe(404);
    await validateResponse("POST", "/api/sessions/{id}/relaunch", gone);

    const archived = await createSession("archived first");
    const del = await fetch(`${s.baseUrl}/api/sessions/${archived}`, {
      method: "DELETE",
      headers: bearer(token),
    });
    expect(del.status).toBe(200);
    const conflict = await post(`/api/sessions/${archived}/relaunch`);
    expect(conflict.status).toBe(409);
    await validateResponse("POST", "/api/sessions/{id}/relaunch", conflict);

    const anon = await post("/api/sessions/nope/relaunch", {}, false);
    expect(anon.status).toBe(401);
    await validateResponse("POST", "/api/sessions/{id}/relaunch", anon);
  });
});

describe("recaps", () => {
  test("GET /api/recaps answers a map", async () => {
    const ok = await fetch(`${s.baseUrl}/api/recaps`, { headers: bearer(token) });
    expect(ok.status).toBe(200);
    expect(await validateResponse("GET", "/api/recaps", ok)).toEqual({});

    const anon = await fetch(`${s.baseUrl}/api/recaps`);
    expect(anon.status).toBe(401);
    await validateResponse("GET", "/api/recaps", anon);
  });

  test("regenerate answers 202 with a status, 404 for an unknown id", async () => {
    const id = await createSession("recap me");
    const ok = await post(`/api/sessions/${id}/recap/regenerate`);
    expect(ok.status).toBe(202);
    const body = (await validateResponse(
      "POST", "/api/sessions/{id}/recap/regenerate", ok)) as { ok: boolean; status: string };
    expect(body.ok).toBe(true);
    // deps.recap is unwired in test/contract/deps.ts, so the handler's `?? "error"` answers.
    expect(body.status).toBe("error");

    const gone = await post("/api/sessions/nope/recap/regenerate");
    expect(gone.status).toBe(404);
    await validateResponse("POST", "/api/sessions/{id}/recap/regenerate", gone);

    const anon = await post(`/api/sessions/${id}/recap/regenerate`, {}, false);
    expect(anon.status).toBe(401);
    await validateResponse("POST", "/api/sessions/{id}/recap/regenerate", anon);
  });
});

describe("actions events", () => {
  test("session:amendments rides a real POST; session:recap comes from the fixture", async () => {
    const id = await createSession("event source");
    const frames = await collectEvents(s, token, async () => {
      await post(`/api/sessions/${id}/amendments`, { text: "Event-driving amendment." });
      s.deps.events.emit("session:recap", { id, recap: fx.recap });
    });
    const seen = new Set<string>();
    for (const frame of frames) {
      if (!EVENTS.includes(frame.event)) continue;
      validateEvent(frame.event, frame.data);
      seen.add(frame.event);
    }
    expect([...seen].sort()).toEqual([...EVENTS].sort());
  });
});

// Stays LAST in this file.
describe("actions coverage gate", () => {
  test("every actions operation and event was exercised", () => {
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

Expected: FAIL with `contract has no operation POST /api/sessions/{id}/resume` (from
`validateResponse`).

- [ ] **Step 3: Add the schemas inside the actions block in `components.schemas`**

Paste between `# ── stream: actions ──` and `# ── /stream: actions ──` in `components.schemas:`
(four-space indent, matching the sibling schemas):

```yaml
    ResumeRequest:
      type: object
      additionalProperties: false
      description: POST /api/sessions/{id}/resume. `force` tears a stale husk down and respawns instead of adopting a live pane (src/service.ts resumeInner). The web's card menu always forces.
      properties:
        force: { type: boolean }
    RenameRequest:
      type: object
      additionalProperties: false
      required: [name]
      properties:
        name:
          type: string
          description: Free text; the server slugifies it (slugifyManual) before storing. Must not be blank after trimming.
    RenameResult:
      type: object
      additionalProperties: true
      required: [session, branchRenamed]
      properties:
        session: { $ref: "#/components/schemas/Session" }
        branchRenamed:
          type: boolean
          description: False when an open PR pinned the git branch, so only the display name moved (src/server.ts resolveRenameBranch).
    AmendmentRequest:
      type: object
      additionalProperties: false
      required: [text]
      properties:
        text:
          type: string
          description: The operator's scope amendment. Trimmed, non-empty, at most 2000 characters (AMENDMENT_MAX_CHARS, src/task-amendments.ts).
        steer:
          type: boolean
          description: Also deliver the text to the live agent. The amendment is recorded either way; `steered` in the response reports whether delivery landed.
    TaskAmendment:
      type: object
      additionalProperties: true
      required: [id, sessionId, text, createdAt, retractedAt]
      description: Copied from TaskAmendment in src/task-amendments.ts.
      properties:
        id: { type: string }
        sessionId: { type: string }
        text: { type: string }
        createdAt: { type: integer }
        retractedAt: { type: [integer, "null"] }
    AmendmentCreated:
      type: object
      additionalProperties: true
      required: [amendment, steered]
      properties:
        amendment: { $ref: "#/components/schemas/TaskAmendment" }
        steered: { type: boolean }
    ReadyRequest:
      type: object
      additionalProperties: false
      required: [ready]
      description: POST /api/sessions/{id}/ready — the manual "parked / ready to merge" flag, orthogonal to SessionStatus.
      properties:
        ready: { type: boolean }
    RelaunchResult:
      type: object
      additionalProperties: true
      required: [session, archived]
      properties:
        session:
          $ref: "#/components/schemas/Session"
        archived:
          type: boolean
          description: Whether the original was torn down. False means the replacement spawned but the original is still on the list and needs closing by hand.
    RecapState:
      type: string
      x-shepherd-open-enum: true
      description: Copied verbatim from RecapState in src/types.ts.
      enum: [generating, ready, failed, empty]
    RecapVerdict:
      type: string
      x-shepherd-open-enum: true
      description: Copied verbatim from RecapVerdict in src/types.ts. `needs_attention` is the web's "Handlungsbedarf" line.
      enum: [ready, parked, needs_attention]
    Recap:
      type: object
      additionalProperties: true
      description: The documented subset of src/types.ts Recap the native action bar reads. The server sends more; additionalProperties keeps the rest legal.
      required: [sessionId, state, headline, body, openItems, updatedAt]
      properties:
        sessionId: { type: string }
        state: { $ref: "#/components/schemas/RecapState" }
        verdict:
          oneOf:
            - $ref: "#/components/schemas/RecapVerdict"
            - type: "null"
        headline: { type: string, description: 'At most 100 characters; "" until ready.' }
        body: { type: string, description: 'Markdown; "" until ready.' }
        openItems: { type: array, items: { type: string } }
        changedFiles: { type: array, items: { type: string } }
        generatedAt: { type: [integer, "null"] }
        updatedAt: { type: integer }
    RecapMap:
      type: object
      additionalProperties: { $ref: "#/components/schemas/Recap" }
      description: GET /api/recaps. Session id -> recap. Absent means no recap exists for that session.
    RecapRegenerateStatus:
      type: string
      x-shepherd-open-enum: true
      description: What the on-demand regenerate did (src/server.ts handleSessionRecapRegenerate). `error` is also the answer when the recap service is unwired.
      enum: [started, empty, error]
    RecapRegenerateResult:
      type: object
      additionalProperties: true
      required: [ok, status]
      properties:
        ok: { type: boolean }
        status: { $ref: "#/components/schemas/RecapRegenerateStatus" }
    SessionRecapEvent:
      type: object
      additionalProperties: true
      required: [id, recap]
      properties:
        id: { type: string }
        recap: { $ref: "#/components/schemas/Recap" }
    SessionAmendmentsEvent:
      type: object
      additionalProperties: true
      description: Always the session's FULL current amendment list, so an empty array is a genuine all-clear (src/service.ts emitSessionAmendments).
      required: [id, amendments]
      properties:
        id: { type: string }
        amendments: { type: array, items: { $ref: "#/components/schemas/TaskAmendment" } }
```

- [ ] **Step 4: Add the seven operations inside the actions block in `paths`**

Paste between `# ── stream: actions ──` and `# ── /stream: actions ──` in `paths:` (two-space
indent):

```yaml
  /api/sessions/{id}/resume:
    parameters:
      - name: id
        in: path
        required: true
        schema: { type: string }
    post:
      operationId: resumeSession
      description: Resume a finished session. Adopts a live pane unless `force`, which tears the husk down and respawns. 409 covers every "cannot resume" case, including an unknown id.
      requestBody:
        required: false
        content:
          application/json:
            schema: { $ref: "#/components/schemas/ResumeRequest" }
      responses:
        "200":
          description: The resumed session.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Session" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "409":
          description: Cannot resume — unknown id, archived, no conversation to resume, or refused by the auto gate.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
  /api/sessions/{id}/rename:
    parameters:
      - name: id
        in: path
        required: true
        schema: { type: string }
    post:
      operationId: renameSession
      description: Rename the session. The git branch moves too unless an open PR pins it.
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/RenameRequest" }
      responses:
        "200":
          description: The renamed session and whether its branch moved.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/RenameResult" }
        "400":
          description: Body is not {name -> non-blank string}.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404":
          description: Unknown id.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
        "409":
          description: 'error is "name_taken" — the target branch name is already in use.'
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
  /api/sessions/{id}/amendments:
    parameters:
      - name: id
        in: path
        required: true
        schema: { type: string }
    post:
      operationId: amendSession
      description: Record an operator scope amendment beside the original task. Persisted first, steered second, so `steered false` never means "not recorded".
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/AmendmentRequest" }
      responses:
        "201":
          description: The recorded amendment and whether it reached the agent.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/AmendmentCreated" }
        "400":
          description: Missing, blank or over-long text.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404":
          description: Unknown id.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
  /api/sessions/{id}/ready:
    parameters:
      - name: id
        in: path
        required: true
        schema: { type: string }
    post:
      operationId: setSessionReady
      description: Set or clear the manual ready-to-merge flag.
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/ReadyRequest" }
      responses:
        "200":
          description: Flag applied.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Ok" }
        "400":
          description: Body is not {ready -> boolean}.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404":
          description: Unknown id.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
  /api/sessions/{id}/relaunch:
    parameters:
      - name: id
        in: path
        required: true
        schema: { type: string }
    post:
      operationId: relaunchSession
      description: Spawn a fresh replacement carrying the original's prompt and settings, then decommission the original. Destructive — the original's worktree goes away. Send no body for a plain relaunch; overrides are the composer's surface and are not declared here.
      responses:
        "201":
          description: The replacement, and whether the original was torn down.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/RelaunchResult" }
        "400":
          description: The body carried an unknown or invalid override key.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404":
          description: Unknown id.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
        "409":
          description: 'Already archived, or a relaunch of this id is in flight (code "in_progress").'
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
  /api/sessions/{id}/recap/regenerate:
    parameters:
      - name: id
        in: path
        required: true
        schema: { type: string }
    post:
      operationId: regenerateRecap
      description: Force a fresh recap for this session. Accepted, not completed — the recap arrives later as a session:recap frame.
      responses:
        "202":
          description: Accepted, with what the regenerate actually did.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/RecapRegenerateResult" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404":
          description: Unknown id.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
  /api/recaps:
    get:
      operationId: listRecaps
      description: Bootstrap snapshot of every recap the server has cached.
      responses:
        "200":
          description: Session id -> recap.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/RecapMap" }
        "401": { $ref: "#/components/responses/Unauthorized" }
```

`403 insufficient_scope` is reachable with a scoped token but stays undeclared, per
`contracts/README.md`'s "Deliberately undeclared" rule: the native client mints `full` tokens.
The same rule covers `415` from `requireJsonContentType` and malformed-JSON `400`.

**Two statuses this block must settle, because the derived gate will not let them sit
half-declared.** Both are real server behaviour that the hand-kept list used to paper over:

1. **`POST /api/sessions/{id}/rename` → `409 name_taken`** (`src/server.ts:3381`, `:3385`). Declared
   above. Exercise it by adding a case to the rename `describe` in Step 1's `actions.test.ts`: create two
   sessions and rename the second onto the first's name, then `validateResponse` the 409. If the stub cannot reach it — `test/contract/deps.ts` hardcodes
   `worktree.branchExists` to `false` and wires no `prCache`, so only the slug-collision branch is
   live — **delete the `"409"` entry from the rename path** rather than leave it declared and
   unexercised. A status the contract promises and no test drives is worse than one the client
   maps through `fromUndocumented`.
2. **`POST /api/sessions/{id}/relaunch` → `502`** (`src/server.ts:3699` `issue_unresolved`,
   `src/server.ts:3710` `relaunch failed`). **Not** declared above, and **not** on
   `contracts/README.md`'s deliberately-undeclared list either — the contract already declares a
   `502` on `POST /api/sessions` and `test/contract/openapi.test.ts` drives it. Add it to the
   relaunch path above with the `Error` schema, and drive it from the relaunch `describe` in
   Step 1's `actions.test.ts` the same way `openapi.test.ts` drives the create-session 502.
   If it proves unreachable through the stub, say so in the PR body as a known coverage hole
   instead of silently omitting it — `ShepherdClient.relaunch` will otherwise surface a real
   upstream failure as a generic `fromUndocumented` error.

- [ ] **Step 5: Add the two events inside the actions block in `x-shepherd-events`**

```yaml
  session:recap:
    description: A session's recap was created, regenerated or changed state. Carries the whole recap, so no re-read is needed.
    schema: { $ref: "#/components/schemas/SessionRecapEvent" }
  session:amendments:
    description: A session's amendment list changed. Always the FULL current list, so an empty array is a genuine all-clear.
    schema: { $ref: "#/components/schemas/SessionAmendmentsEvent" }
```

Do **not** add these names to the `EventName` enum. It is flagged `x-shepherd-open-enum`, so an
undeclared name still decodes as its raw string; adding a member would make the exhaustive
`switch name.known` in `ServerEvent.swift` **and** the one in `SessionStore.applyNow` non-exhaustive,
and both files are off-limits here. This stream reads both frames through
`ServerEvent.unknown(name:payload:)` and decodes `payload` with the generated schemas above.

- [ ] **Step 6: Run green, regenerate, sync, prove freshness**

```bash
bun run test:contract && bun run gen:contract-swift && ./native/scripts/sync-contract.sh \
  && bun run check:contract-swift && ./native/scripts/sync-contract.sh --check \
  && swift build --package-path native 2>&1 | tail -3
```

Expected: contract tests pass · `contracts/openapi.swift.yaml -> native/Sources/ShepherdKit/openapi.yaml`
· no diff · `sync-contract: up to date` · `Build complete!`. If the derivation throws naming a JSON
pointer inside the actions block, the schema there uses a construct it refuses (a nullable union
outside a property, a flagged enum inside `allOf`) — fix the schema, never the script.

- [ ] **Step 7: Commit**

```bash
git add contracts/openapi.yaml contracts/openapi.swift.yaml \
  native/Sources/ShepherdKit/openapi.yaml test/contract/actions.test.ts \
  test/contract/actions-fixtures.ts
git commit -m "feat(contract): session action routes, recap read and amendment events"
```

---

### Task 2: Kit — `ShepherdClient+Actions.swift`

**Files:** create `native/Sources/ShepherdKit/Client/ShepherdClient+Actions.swift` and
`native/Tests/ShepherdKitTests/ShepherdClientActionsTests.swift`.

**Interfaces:**
- Consumes: Task 1's generated operations; `ShepherdClient.generated` (`internal`);
  `ShepherdError.from(_:route:)`, `.fromUndocumented(statusCode:route:)`, `.fromConflict(_:)`,
  `.unauthenticated`, `.notFound`, `.badRequest(_:)`; `FakeShepherdServer`,
  `InMemoryCredentialStore`, `StoredCredential`, `ServerProfile`.
- Produces on `ShepherdClient`: `resume(sessionID:force:) -> Session`,
  `rename(sessionID:name:) -> RenameResult`, `amend(sessionID:text:steer:) -> AmendmentCreated`,
  `setReadyToMerge(sessionID:ready:) -> Void`, `relaunch(sessionID:) -> RelaunchResult`,
  `regenerateRecap(sessionID:) -> RecapRegenerateResult`, `recaps() -> [String: Recap]`, plus the
  public typealiases `RenameResult`, `TaskAmendment`, `AmendmentCreated`, `Recap`, `RecapState`,
  `RecapStateKnown`, `RecapVerdict`, `RecapVerdictKnown`, `RelaunchResult`,
  `RecapRegenerateResult`, `RecapRegenerateStatus`, `RecapRegenerateStatusKnown`, and the three
  `OpenEnum` conformances (`RecapState`, `RecapVerdict`, `RecapRegenerateStatus`) that give those
  wrappers their `known` / `rawValue` / `init(known:)` / `init(unknown:)`.

- [ ] **Step 1: Write the failing tests**

`native/Tests/ShepherdKitTests/ShepherdClientActionsTests.swift`:

```swift
import Foundation
import Testing

@testable import ShepherdKit

@Suite("ShepherdClient session actions")
struct ShepherdClientActionsTests {
  private func makeClient(_ server: FakeShepherdServer) throws -> ShepherdClient {
    let credentials = InMemoryCredentialStore()
    try credentials.save(StoredCredential(token: "shp_test", tokenId: "tok"), for: "k")
    let profile = ServerProfile(
      name: "fake", baseURL: server.baseURL, mode: .local, credentialKey: "k")
    return try ShepherdClient(
      profile: profile, credentials: credentials, urlSession: server.urlSession())
  }

  /// Encode-then-decode: every fixture is produced from the generated type, so it cannot
  /// disagree with the contract.
  private func json<T: Encodable>(_ value: T) throws -> Data { try JSONEncoder().encode(value) }

  @Test("resume returns the session it resumed")
  func resume() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/resume", status: 200, json: try json(Fixtures.session(id: "s1")))
    #expect(try await makeClient(server).resume(sessionID: "s1").id == "s1")
  }

  @Test("a refused resume is a conflict, not a silent no-op")
  func resumeRefused() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/resume", status: 409,
      json: Data(#"{"error":"cannot resume"}"#.utf8))
    await #expect(throws: ShepherdError.self) {
      _ = try await makeClient(server).resume(sessionID: "s1")
    }
  }

  @Test("rename reports whether the branch moved")
  func rename() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/rename", status: 200,
      json: try json(
        Components.Schemas.RenameResult(
          session: Fixtures.session(id: "s1"), branchRenamed: false)))

    let result = try await makeClient(server).rename(sessionID: "s1", name: "fresh name")
    #expect(result.branchRenamed == false)
    #expect(result.session.id == "s1")
  }

  @Test("a taken name surfaces the server's own sentence")
  func renameTaken() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/rename", status: 409,
      json: Data(#"{"error":"name_taken"}"#.utf8))
    await #expect(throws: ShepherdError.self) {
      _ = try await makeClient(server).rename(sessionID: "s1", name: "taken")
    }
  }

  @Test("amend records the amendment and reports whether it was steered")
  func amend() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    let amendment = Components.Schemas.TaskAmendment(
      id: "am1", sessionId: "s1", text: "Also cover the admin route.",
      createdAt: 1_800_000_000_000, retractedAt: nil)
    server.stub(
      "POST", "/api/sessions/s1/amendments", status: 201,
      json: try json(
        Components.Schemas.AmendmentCreated(amendment: amendment, steered: true)))

    let created = try await makeClient(server).amend(
      sessionID: "s1", text: "Also cover the admin route.", steer: true)
    #expect(created.steered == true)
    #expect(created.amendment.retractedAt == nil)
  }

  @Test("an empty amendment is a bad request carrying the server's words")
  func amendRejected() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/amendments", status: 400,
      json: Data(#"{"error":"text must not be empty"}"#.utf8))
    await #expect(throws: ShepherdError.badRequest("text must not be empty")) {
      _ = try await makeClient(server).amend(sessionID: "s1", text: " ", steer: false)
    }
  }

  @Test("the ready toggle returns nothing but throws on 404")
  func ready() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("POST", "/api/sessions/s1/ready", status: 200, json: Data(#"{"ok":true}"#.utf8))
    server.stub(
      "POST", "/api/sessions/gone/ready", status: 404, json: Data(#"{"error":"not found"}"#.utf8))
    let client = try makeClient(server)

    try await client.setReadyToMerge(sessionID: "s1", ready: true)
    await #expect(throws: ShepherdError.notFound) {
      try await client.setReadyToMerge(sessionID: "gone", ready: true)
    }
  }

  @Test("relaunch returns the replacement and whether the original was archived")
  func relaunch() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/relaunch", status: 201,
      json: try json(
        Components.Schemas.RelaunchResult(
          session: Fixtures.session(id: "s2"), archived: true)))

    let result = try await makeClient(server).relaunch(sessionID: "s1")
    #expect(result.session.id == "s2")
    #expect(result.archived == true)
  }

  @Test("regenerate returns the status the server chose")
  func regenerate() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/recap/regenerate", status: 202,
      json: try json(
        Components.Schemas.RecapRegenerateResult(
          ok: true, status: RecapRegenerateStatus(known: .started))))

    let result = try await makeClient(server).regenerateRecap(sessionID: "s1")
    #expect(result.status.known == .started)
  }

  @Test("recaps decodes the map, and an unheard-of state survives as its raw value")
  func recaps() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "GET", "/api/recaps", status: 200,
      json: Data(
        #"{"s1":{"sessionId":"s1","state":"quantum","headline":"h","body":"b","openItems":[],"updatedAt":7}}"#
          .utf8))

    let map = try await makeClient(server).recaps()
    #expect(map["s1"]?.state.known == nil)
    #expect(map["s1"]?.state.rawValue == "quantum")
    #expect(map["s1"]?.updatedAt == 7)
  }

  @Test("a 401 maps to unauthenticated on every action")
  func unauthorized() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    let body = Data(#"{"error":"unauthorized"}"#.utf8)
    for (method, path) in [
      ("POST", "/api/sessions/s1/resume"), ("POST", "/api/sessions/s1/rename"),
      ("POST", "/api/sessions/s1/amendments"), ("POST", "/api/sessions/s1/ready"),
      ("POST", "/api/sessions/s1/relaunch"), ("POST", "/api/sessions/s1/recap/regenerate"),
      ("GET", "/api/recaps"),
    ] {
      server.stub(method, path, status: 401, json: body)
    }
    let client = try makeClient(server)

    await #expect(throws: ShepherdError.unauthenticated) {
      _ = try await client.resume(sessionID: "s1")
    }
    await #expect(throws: ShepherdError.unauthenticated) {
      _ = try await client.rename(sessionID: "s1", name: "x")
    }
    await #expect(throws: ShepherdError.unauthenticated) {
      _ = try await client.amend(sessionID: "s1", text: "x", steer: false)
    }
    await #expect(throws: ShepherdError.unauthenticated) {
      try await client.setReadyToMerge(sessionID: "s1", ready: true)
    }
    await #expect(throws: ShepherdError.unauthenticated) {
      _ = try await client.relaunch(sessionID: "s1")
    }
    await #expect(throws: ShepherdError.unauthenticated) {
      _ = try await client.regenerateRecap(sessionID: "s1")
    }
    await #expect(throws: ShepherdError.unauthenticated) { _ = try await client.recaps() }
  }
}
```

If `Fixtures.session(id:)` does not exist under that exact name in
`native/Tests/ShepherdKitTests/Fixtures.swift`, read that file and use the factory it does provide —
do not add a second session factory.

- [ ] **Step 2: Run them and watch them fail**

```bash
swift test --package-path native --filter ShepherdClientActionsTests 2>&1 | tail -20
```

Expected: `value of type 'ShepherdClient' has no member 'resume'`.

- [ ] **Step 3: Write the extension**

`native/Sources/ShepherdKit/Client/ShepherdClient+Actions.swift`:

```swift
import Foundation

// Short names for the action schemas, alongside Model/PublicTypes.swift. Typealiases, not
// wrappers: one definition of each type, still from the contract.
public typealias RenameResult = Components.Schemas.RenameResult
public typealias TaskAmendment = Components.Schemas.TaskAmendment
public typealias AmendmentCreated = Components.Schemas.AmendmentCreated
public typealias Recap = Components.Schemas.Recap
public typealias RecapState = Components.Schemas.RecapState
public typealias RecapStateKnown = Components.Schemas.RecapStateKnown
public typealias RecapVerdict = Components.Schemas.RecapVerdict
public typealias RecapVerdictKnown = Components.Schemas.RecapVerdictKnown
public typealias RelaunchResult = Components.Schemas.RelaunchResult
public typealias RecapRegenerateResult = Components.Schemas.RecapRegenerateResult
public typealias RecapRegenerateStatus = Components.Schemas.RecapRegenerateStatus
public typealias RecapRegenerateStatusKnown = Components.Schemas.RecapRegenerateStatusKnown

// The three schemas this stream flags `x-shepherd-open-enum: true`. The derivation gives each an
// `anyOf` shape and a `<Name>Known` companion, but `known`, `rawValue`, `init(known:)` and
// `init(unknown:)` come from `Model/OpenEnum.swift`'s protocol extension, which reaches a type only
// once that type conforms. `OpenEnum.swift` itself hard-codes the nine core conformances and is
// S0-owned, so this stream declares its own three here — same module, no retroactive conformance.
// Without these lines every `RecapVerdict(known:)` and `.known` below fails to compile.
extension Components.Schemas.RecapState: OpenEnum {}
extension Components.Schemas.RecapVerdict: OpenEnum {}
extension Components.Schemas.RecapRegenerateStatus: OpenEnum {}

/// The per-session commands the action bar issues.
///
/// Every one of them maps the generated `Output` enum onto a value or a `ShepherdError`, so
/// callers never see a generated response case. None of them mutates `SessionStore`: the
/// server's own `/events` frames do that, which is what keeps a command issued here and a
/// command issued from the web UI indistinguishable to the list.
extension ShepherdClient {
  /// `POST /api/sessions/{id}/resume`. `force` defaults to `true`, matching the web's card menu
  /// (`resumeSession(id, true)`): it is the escape hatch for a husk the liveness sweep still
  /// believes in, and a non-forced resume of a live pane is a no-op the operator reads as a
  /// broken button.
  public func resume(sessionID: String, force: Bool = true) async throws -> Session {
    do {
      switch try await generated.resumeSession(
        .init(path: .init(id: sessionID), body: .json(.init(force: force)))
      ) {
      case .ok(let ok): return try ok.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .conflict(let conflict): throw ShepherdError.fromConflict(try conflict.body.json)
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "resumeSession")
      }
    } catch { throw ShepherdError.from(error, route: "resumeSession") }
  }

  /// `POST /api/sessions/{id}/rename`. The server slugifies `name`; `branchRenamed` is false when
  /// an open PR pinned the branch, which the caller must say out loud — a silent display-only
  /// rename reads as a half-failed command.
  public func rename(sessionID: String, name: String) async throws -> RenameResult {
    do {
      switch try await generated.renameSession(
        .init(path: .init(id: sessionID), body: .json(.init(name: name)))
      ) {
      case .ok(let ok): return try ok.body.json
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .conflict(let conflict): throw ShepherdError.fromConflict(try conflict.body.json)
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "renameSession")
      }
    } catch { throw ShepherdError.from(error, route: "renameSession") }
  }

  /// `POST /api/sessions/{id}/amendments`. The amendment is persisted before it is steered, so a
  /// `steered == false` result still means "recorded".
  public func amend(
    sessionID: String, text: String, steer: Bool
  ) async throws -> AmendmentCreated {
    do {
      switch try await generated.amendSession(
        .init(path: .init(id: sessionID), body: .json(.init(text: text, steer: steer)))
      ) {
      case .created(let created): return try created.body.json
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "amendSession")
      }
    } catch { throw ShepherdError.from(error, route: "amendSession") }
  }

  /// `POST /api/sessions/{id}/ready` — the manual "parked / ready to merge" flag. The server
  /// answers `{ok:true}` and pushes the change as `session:ready`, so there is nothing to return.
  public func setReadyToMerge(sessionID: String, ready: Bool) async throws {
    do {
      switch try await generated.setSessionReady(
        .init(path: .init(id: sessionID), body: .json(.init(ready: ready)))
      ) {
      case .ok: return
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "setSessionReady")
      }
    } catch { throw ShepherdError.from(error, route: "setSessionReady") }
  }

  /// `POST /api/sessions/{id}/relaunch` with no body — the plain relaunch. Destructive: the
  /// original's worktree goes away. `archived == false` means the replacement is up but the
  /// original still needs closing by hand.
  public func relaunch(sessionID: String) async throws -> RelaunchResult {
    do {
      switch try await generated.relaunchSession(.init(path: .init(id: sessionID))) {
      case .created(let created): return try created.body.json
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .conflict(let conflict): throw ShepherdError.fromConflict(try conflict.body.json)
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "relaunchSession")
      }
    } catch { throw ShepherdError.from(error, route: "relaunchSession") }
  }

  /// `POST /api/sessions/{id}/recap/regenerate`. Accepted, not completed — the recap itself
  /// arrives later as a `session:recap` frame.
  public func regenerateRecap(sessionID: String) async throws -> RecapRegenerateResult {
    do {
      switch try await generated.regenerateRecap(.init(path: .init(id: sessionID))) {
      case .accepted(let accepted): return try accepted.body.json
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "regenerateRecap")
      }
    } catch { throw ShepherdError.from(error, route: "regenerateRecap") }
  }

  /// `GET /api/recaps` — the bootstrap snapshot. Every later change rides `session:recap`.
  public func recaps() async throws -> [String: Recap] {
    do {
      switch try await generated.listRecaps(.init()) {
      case .ok(let ok): return try ok.body.json.additionalProperties
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "listRecaps")
      }
    } catch { throw ShepherdError.from(error, route: "listRecaps") }
  }
}
```

If the generated case for the 202 response is not spelled `.accepted`, read the generated
`Operations.RegenerateRecap.Output` in `.build/` and use the spelling the generator chose; do not
change the contract to suit a guess.

**Generated enum-case spelling.** `native/Sources/ShepherdKit/openapi-generator-config.yaml` sets
`namingStrategy: idiomatic` and `accessModifier: public`, so every `Components.Schemas.*` type is
visible from the app target too, and a multi-word enum member becomes camelCase:
`needs_attention` → `.needsAttention`, `started` → `.started`. Characters the strategy cannot fold
keep the defensive substitution — which is why `EventName`'s members read `.session_colon_new`.
Confirm any case name you are unsure of against the generated code in `native/.build/` before
writing it; never rename a contract member to make a guess compile.

- [ ] **Step 4: Run green and commit**

```bash
swift test --package-path native 2>&1 | tail -3
```

Expected: the whole kit suite passes, including the 11 new tests.

```bash
git add native/Sources/ShepherdKit/Client/ShepherdClient+Actions.swift \
  native/Tests/ShepherdKitTests/ShepherdClientActionsTests.swift
git commit -m "feat(kit): session action commands over the generated client"
```

---

### Task 3: Strings — `KEYS_ACTIONS` and the EN/DE additions

**Files:** modify `native/scripts/gen-strings.ts` (the `KEYS_ACTIONS` array only) and
`ui/messages/{en,de}.json`; regenerate `native/Apps/ShepherdMac/Resources/Localizable.xcstrings`;
create `native/Apps/ShepherdMac/Tests/ActionsStringsTests.swift`.

**Interfaces:** produces every catalog key Tasks 4–7 pass to `L.t(_:)` / `L.t(_:_:)`.

- [ ] **Step 1: Append the app-only keys to both catalogs**

Most copy already exists in the web catalogs and is reused verbatim (`cardmenu_*`, `amend_*`,
`viewport_rename_*`, `gitrail_ready*`, `recap_*`, `relaunch_*`, `common_*`). Six lines have no web
key: the bar's own label, the two confirmation dialogs the native app uses in place of the web's
two-step arm and undo toast, and the ready-toggle's off-state label. Append before the closing brace
of `ui/messages/en.json`:

```json
  "native_actions_bar_label": "Session actions",
  "native_actions_relaunch_confirm_title": "Relaunch this session?",
  "native_actions_relaunch_confirm_body": "A fresh session starts with the same task, and this one is decommissioned — its worktree is removed. Uncommitted work in it is lost.",
  "native_actions_relaunch_confirm_action": "Discard & relaunch",
  "native_actions_ready_off": "Not ready",
  "native_actions_failed": "That action failed: {reason}"
```

and to `ui/messages/de.json`:

```json
  "native_actions_bar_label": "Sitzungs-Aktionen",
  "native_actions_relaunch_confirm_title": "Sitzung neu starten?",
  "native_actions_relaunch_confirm_body": "Eine frische Sitzung startet mit derselben Aufgabe, diese wird stillgelegt — ihr Worktree wird entfernt. Nicht committete Arbeit darin geht verloren.",
  "native_actions_relaunch_confirm_action": "Verwerfen & neu starten",
  "native_actions_ready_off": "Nicht bereit",
  "native_actions_failed": "Diese Aktion ist fehlgeschlagen: {reason}"
```

Every placeholder is written in Paraglide's `{name}` form, which is what `gen-strings.ts` renumbers
into the `.xcstrings` catalog's positional `%1$@`. Never write `%1$@` into a message catalog by
hand: the EN string is what the generator reads placeholder order from, and a key the web never
renders is still a key the web's i18n gate checks.

- [ ] **Step 2: Fill `KEYS_ACTIONS`**

Replace the empty array S0-prep left in `native/scripts/gen-strings.ts` with:

```ts
/** S4 — the quick-action bar and the "Handlungsbedarf" recap line. Keep alphabetical. */
export const KEYS_ACTIONS: readonly string[] = [
  "amend_failed", "amend_original_task", "amend_placeholder", "amend_recorded",
  "amend_recorded_and_steered", "amend_recorded_not_steered", "amend_sending",
  "amend_steer_label", "amend_steer_offline", "amend_submit", "amend_title",
  "cardmenu_amend", "cardmenu_relaunch", "cardmenu_rename", "cardmenu_resume",
  "cardmenu_resume_failed", "cardmenu_stop", "cardmenu_stop_failed", "cardmenu_stop_title",
  "cardmenu_stop_toast", "gitrail_ready", "gitrail_ready_aria", "gitrail_ready_off_title",
  "gitrail_ready_on_title", "native_actions_bar_label", "native_actions_failed",
  "native_actions_ready_off", "native_actions_relaunch_confirm_action",
  "native_actions_relaunch_confirm_body", "native_actions_relaunch_confirm_title",
  "recap_open_items", "recap_regenerate", "recap_regenerate_failed", "recap_verdict_needs_attention",
  "recap_verdict_parked", "recap_verdict_ready", "relaunch_archive_failed", "relaunch_done",
  "relaunch_in_progress", "relaunch_issue_unresolved", "toast_renamed",
  "viewport_rename_branch_kept", "viewport_rename_failed", "viewport_rename_name_taken",
  "viewport_rename_placeholder",
];
```

`common_cancel`, `common_close`, `common_retry` and `common_save` are already in `KEYS_CORE`; a key
in two arrays fails the generator by name.

- [ ] **Step 3: Regenerate and check both gates**

```bash
bun run native/scripts/gen-strings.ts && bun run check:strings && (cd ui && bun run check:i18n)
```

Expected: `Localizable.xcstrings is up to date (N keys).` and the UI i18n gate passes. A key missing
from either JSON catalog fails here by name — fix the key, never the generator.

- [ ] **Step 4: Write the catalog test**

`native/Apps/ShepherdMac/Tests/ActionsStringsTests.swift`:

```swift
import Testing

@testable import Shepherd

/// A missing catalog entry makes `String(localized:)` echo the key back, which would ship a bar
/// full of snake_case.
@MainActor
struct ActionsStringsTests {
    @Test func everyPlainKeyResolves() {
        let keys: [StaticString] = [
            "amend_failed", "amend_original_task", "amend_placeholder", "amend_recorded",
            "amend_recorded_and_steered", "amend_recorded_not_steered", "amend_sending",
            "amend_steer_label", "amend_steer_offline", "amend_submit",
            "cardmenu_amend", "cardmenu_relaunch", "cardmenu_rename", "cardmenu_resume",
            "cardmenu_stop", "cardmenu_stop_title", "gitrail_ready", "gitrail_ready_aria",
            "gitrail_ready_off_title", "gitrail_ready_on_title", "native_actions_bar_label",
            "native_actions_ready_off", "native_actions_relaunch_confirm_action",
            "native_actions_relaunch_confirm_body", "native_actions_relaunch_confirm_title",
            "recap_open_items", "recap_regenerate", "recap_regenerate_failed",
            "recap_verdict_needs_attention", "recap_verdict_parked", "recap_verdict_ready",
            "relaunch_archive_failed", "relaunch_in_progress", "relaunch_issue_unresolved",
            "viewport_rename_branch_kept", "viewport_rename_failed",
            "viewport_rename_name_taken", "viewport_rename_placeholder",
        ]
        for key in keys {
            let value = L.t(key)
            #expect(!value.isEmpty)
            #expect(!value.contains("_"), "key \(key) did not resolve")
        }
    }

    @Test func argumentCarryingKeysInterpolate() {
        let keys: [StaticString] = [
            "amend_title", "cardmenu_resume_failed", "cardmenu_stop_failed",
            "cardmenu_stop_toast", "native_actions_failed", "relaunch_done", "toast_renamed",
        ]
        for key in keys {
            #expect(L.t(key, "MARKER").contains("MARKER"), "key \(key) dropped its argument")
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
  native/Apps/ShepherdMac/Tests/ActionsStringsTests.swift
git commit -m "feat(i18n): session-action catalog keys for the mac app"
```

---

### Task 4: `ActionRules` — the pure availability module

**Files:** create `native/Apps/ShepherdMac/Sources/Actions/ActionRules.swift` and
`native/Apps/ShepherdMac/Tests/ActionRulesTests.swift`.

**Interfaces:**
- Consumes: `Session`, `SessionStatus`, `SessionStatusKnown` (ShepherdKit), `L`.
- Produces: `SessionAction` (`Identifiable`, `CaseIterable`, `Sendable`) with
  `id`, `systemImage`, `isDestructive`, `shortcut`, `label(for:)`, `help(for:)`; `ActionShortcut`
  (`key: Character`, `modifiers: EventModifiers`); `ActionRules` with
  `static func displayStatus(_:workingBlocked:) -> SessionStatusKnown?`,
  `static func isMerging(_:now:) -> Bool`,
  `static func allows(_:session:workingBlocked:gitMerged:now:) -> Bool`,
  `static func available(for:workingBlocked:gitMerged:now:) -> [SessionAction]`, and
  `static let mergeMarkBackstop: Int`.

- [ ] **Step 1: Write the failing tests**

`native/Apps/ShepherdMac/Tests/ActionRulesTests.swift`:

```swift
import Foundation
import ShepherdKit
import Testing

@testable import Shepherd

/// The web's rules, ported: `stoppable` (UnitRow.svelte), `canResume` and `canRelaunch`
/// (ui/src/lib/format.ts) and `isMerging` (ui/src/lib/components/merge-train.ts). Each test
/// names the web predicate it pins.
@MainActor
struct ActionRulesTests {
    private let now = 1_800_000_000_000

    private func session(
        id: String = "s1",
        status: SessionStatusKnown = .idle,
        claudeSessionID: String = "claude-1",
        provider: String? = nil,
        terminal: Bool = false,
        readyToMerge: Bool = false,
        autopilotComplete: Bool = false,
        mergingSince: Int? = nil
    ) -> Session {
        var s = PreviewData.session(id: id, status: SessionStatus(known: status))
        s.claudeSessionId = claudeSessionID
        s.agentProvider = provider.flatMap { AgentProvider(rawValue: $0) }
        s.terminal = terminal
        s.readyToMerge = readyToMerge
        s.autopilotComplete = autopilotComplete
        s.mergingSince = mergingSince
        return s
    }

    // stoppable = dStatus === "running" && !session.terminal
    @Test func stopFollowsTheDisplayStatus() {
        let running = session(status: .running)
        #expect(ActionRules.allows(.stop, session: running, now: now))
        #expect(!ActionRules.allows(.stop, session: session(status: .idle), now: now))
        #expect(
            !ActionRules.allows(.stop, session: session(status: .running, terminal: true), now: now),
            "a clean terminal never receives the stop ESC")

        // A blocked session the poller found still producing output reads as running.
        let blocked = session(id: "b", status: .blocked)
        #expect(!ActionRules.allows(.stop, session: blocked, now: now))
        #expect(
            ActionRules.allows(.stop, session: blocked, workingBlocked: ["b": true], now: now))
    }

    // canResume: (codex || claudeSessionId) && (idle || done) && !terminal
    @Test func resumeNeedsAConversationAndAParkedSession() {
        #expect(ActionRules.allows(.resume, session: session(status: .idle), now: now))
        #expect(ActionRules.allows(.resume, session: session(status: .done), now: now))
        #expect(!ActionRules.allows(.resume, session: session(status: .running), now: now))
        #expect(
            !ActionRules.allows(.resume, session: session(claudeSessionID: ""), now: now),
            "a claude session with no conversation id has nothing to resume")
        #expect(
            ActionRules.allows(
                .resume, session: session(claudeSessionID: "", provider: "codex"), now: now),
            "codex resumes from its own launch record, not a claude session id")
        #expect(!ActionRules.allows(.resume, session: session(terminal: true), now: now))
    }

    // canRelaunch: !terminal && !readyToMerge && !autopilotComplete && !merged && !isMerging
    @Test func relaunchIsOnlyForWorkStillInFlight() {
        #expect(ActionRules.allows(.relaunch, session: session(), now: now))
        #expect(!ActionRules.allows(.relaunch, session: session(terminal: true), now: now))
        #expect(!ActionRules.allows(.relaunch, session: session(readyToMerge: true), now: now))
        #expect(
            !ActionRules.allows(.relaunch, session: session(autopilotComplete: true), now: now))
        #expect(
            !ActionRules.allows(.relaunch, session: session(), gitMerged: true, now: now),
            "a merged PR means the work landed; relaunching would duplicate it")
        #expect(
            !ActionRules.allows(.relaunch, session: session(mergingSince: now - 1_000), now: now))
        #expect(
            ActionRules.allows(
                .relaunch,
                session: session(mergingSince: now - ActionRules.mergeMarkBackstop - 1), now: now),
            "a merge mark older than the 24h backstop is stale and does not block")
    }

    @Test func renameAmendAndRecapAreOfferedForEveryLiveSession() {
        for action in [SessionAction.rename, .amend, .regenerateRecap] {
            #expect(ActionRules.allows(action, session: session(status: .running), now: now))
            #expect(
                !ActionRules.allows(action, session: session(status: .archived), now: now),
                "\(action.id) has nothing to act on once the session is archived")
        }
    }

    @Test func theReadyToggleIsHiddenForTerminalsAndArchivedSessions() {
        #expect(ActionRules.allows(.toggleReady, session: session(), now: now))
        #expect(!ActionRules.allows(.toggleReady, session: session(terminal: true), now: now))
        #expect(!ActionRules.allows(.toggleReady, session: session(status: .archived), now: now))
    }

    @Test func availableIsOrderedAndFiltered() {
        let ids = ActionRules.available(for: session(status: .idle), now: now).map(\.id)
        #expect(ids == ["resume", "rename", "amend", "toggle-ready", "regenerate-recap", "relaunch"])
        #expect(!ids.contains("stop"))
        #expect(ActionRules.available(for: session(status: .archived), now: now).isEmpty)
    }

    @Test func everyActionHasADistinctShortcutAndTheDestructiveOneHasNone() {
        let shortcuts = SessionAction.allCases.compactMap(\.shortcut)
        let pairs = shortcuts.map { "\($0.key)-\($0.modifiers.rawValue)" }
        #expect(Set(pairs).count == pairs.count, "two actions claim the same chord")
        #expect(SessionAction.relaunch.shortcut == nil)
        #expect(SessionAction.relaunch.isDestructive)
        #expect(!SessionAction.rename.isDestructive)
    }

    @Test func labelsAndHelpResolve() {
        let s = session()
        for action in SessionAction.allCases {
            #expect(!action.label(for: s).contains("_"), "\(action.id) label did not resolve")
            #expect(!action.help(for: s).contains("_"), "\(action.id) help did not resolve")
        }
        #expect(SessionAction.toggleReady.label(for: session(readyToMerge: true)) == L.t("gitrail_ready"))
        #expect(
            SessionAction.toggleReady.label(for: session(readyToMerge: false))
                == L.t("native_actions_ready_off"))
    }
}
```

- [ ] **Step 2: Run them and watch them fail**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/ActionRulesTests 2>&1 | tail -20
```

Expected: `cannot find 'ActionRules' in scope`.

- [ ] **Step 3: Write the module**

`native/Apps/ShepherdMac/Sources/Actions/ActionRules.swift`:

```swift
import Foundation
import ShepherdKit
import SwiftUI

/// A chord the action bar binds. Separate from SwiftUI's `KeyboardShortcut` so the set can be
/// asserted for collisions without hosting a view.
struct ActionShortcut: Equatable, Sendable {
    let key: Character
    let modifiers: EventModifiers
}

/// One per-session command the bar offers.
///
/// The set is the subset of the web's `CardMenu.svelte` whose route this stream owns. Merge PR
/// (S2), the variant/continue pickers, the cross-repo relaunch composer, the clean-terminal
/// create and Decommission (already in `MainWindow`'s toolbar) are deliberately absent — see the
/// plan's "Deliberate deviations".
enum SessionAction: String, Identifiable, CaseIterable, Sendable {
    case stop
    case resume
    case rename
    case amend
    case toggleReady
    case regenerateRecap
    case relaunch

    /// Stable id, also the accessibility identifier suffix. Kebab-case so it reads in a test
    /// failure the same way it reads in Accessibility Inspector.
    var id: String {
        switch self {
        case .stop: "stop"
        case .resume: "resume"
        case .rename: "rename"
        case .amend: "amend"
        case .toggleReady: "toggle-ready"
        case .regenerateRecap: "regenerate-recap"
        case .relaunch: "relaunch"
        }
    }

    var systemImage: String {
        switch self {
        case .stop: "stop.circle"
        case .resume: "play.circle"
        case .rename: "pencil"
        case .amend: "plus.bubble"
        case .toggleReady: "checkmark.seal"
        case .regenerateRecap: "text.badge.star"
        case .relaunch: "arrow.triangle.2.circlepath"
        }
    }

    /// Destructive actions go behind a `confirmationDialog`, never a bare click. The web arms
    /// Relaunch in two steps for the same reason; a dialog says what is lost, which a label swap
    /// cannot.
    var isDestructive: Bool { self == .relaunch }

    /// Window-scoped chords, bound on the bar's own buttons. `nil` for the destructive action:
    /// a chord that discards a worktree is a chord somebody hits by accident.
    ///
    /// The app's main menu lives on the `Scene` in `ShepherdApp.swift`, which this stream must
    /// not edit, so there are no `CommandGroup` entries. A button in the view hierarchy carries
    /// its shortcut for the whole key window, which is exactly the scope a per-session action
    /// wants.
    var shortcut: ActionShortcut? {
        switch self {
        case .stop: ActionShortcut(key: ".", modifiers: .command)
        case .resume: ActionShortcut(key: "r", modifiers: .command)
        case .rename: ActionShortcut(key: "r", modifiers: [.command, .shift])
        case .amend: ActionShortcut(key: "a", modifiers: [.command, .shift])
        case .toggleReady: ActionShortcut(key: "m", modifiers: [.command, .shift])
        case .regenerateRecap: ActionShortcut(key: "e", modifiers: [.command, .shift])
        case .relaunch: nil
        }
    }

    /// Web copy, reused verbatim. The ready toggle is the only label that depends on state.
    func label(for session: Session) -> String {
        switch self {
        case .stop: L.t("cardmenu_stop")
        case .resume: L.t("cardmenu_resume")
        case .rename: L.t("cardmenu_rename")
        case .amend: L.t("cardmenu_amend")
        case .toggleReady:
            session.readyToMerge ? L.t("gitrail_ready") : L.t("native_actions_ready_off")
        case .regenerateRecap: L.t("recap_regenerate")
        case .relaunch: L.t("cardmenu_relaunch")
        }
    }

    /// Tooltip / accessibility hint.
    func help(for session: Session) -> String {
        switch self {
        case .stop: L.t("cardmenu_stop_title")
        case .resume: L.t("cardmenu_resume")
        case .rename: L.t("viewport_rename_aria")
        case .amend: L.t("cardmenu_amend")
        case .toggleReady:
            session.readyToMerge ? L.t("gitrail_ready_on_title") : L.t("gitrail_ready_off_title")
        case .regenerateRecap: L.t("recap_regenerate")
        case .relaunch: L.t("native_actions_relaunch_confirm_title")
        }
    }
}

/// Which actions a session may receive right now.
///
/// Pure and UI-free, so every visibility decision the bar makes is assertable without hosting a
/// view — and so the port of each web predicate can be pinned one test at a time.
///
/// Two inputs belong to other streams and default to "unknown": `workingBlocked` (S3's
/// `GET /api/working-blocked`) and `gitMerged` (S2's `GET /api/sessions/{id}/git`). Both default
/// to the conservative answer, and `ActionsModel` exposes them as assignable seams the
/// integration lane fills once those streams land.
enum ActionRules {
    /// `MERGE_MARK_BACKSTOP_MS` from `ui/src/lib/components/merge-train.ts` and
    /// `src/attention-core.ts` — 24 hours. A merge mark older than this is stale.
    static let mergeMarkBackstop = 24 * 60 * 60_000

    /// `displayStatus(s, workingBlocked)` from `ui/src/lib/display-status.ts`: a `blocked`
    /// session the poller found still producing output reads as `running`. `nil` for a status
    /// this build has never heard of — an open enum, so that is a real case.
    static func displayStatus(
        _ session: Session, workingBlocked: [String: Bool] = [:]
    ) -> SessionStatusKnown? {
        if session.status.known == .blocked, workingBlocked[session.id] == true { return .running }
        return session.status.known
    }

    /// `isMerging(s, now)` from `ui/src/lib/components/merge-train.ts`.
    static func isMerging(_ session: Session, now: Int) -> Bool {
        guard let since = session.mergingSince else { return false }
        return now - since < mergeMarkBackstop
    }

    static func allows(
        _ action: SessionAction,
        session: Session,
        workingBlocked: [String: Bool] = [:],
        gitMerged: Bool = false,
        now: Int
    ) -> Bool {
        // Nothing acts on an archived session: its worktree is gone and its row is only history.
        guard session.status.known != .archived else { return false }
        let display = displayStatus(session, workingBlocked: workingBlocked)

        switch action {
        case .stop:
            return display == .running && !session.terminal
        case .resume:
            guard !session.terminal else { return false }
            let isCodex = session.agentProvider?.rawValue == "codex"
            let hasConversation = isCodex || !session.claudeSessionId.isEmpty
            return hasConversation && (session.status.known == .idle || session.status.known == .done)
        case .rename, .amend, .regenerateRecap:
            return true
        case .toggleReady:
            return !session.terminal
        case .relaunch:
            guard !session.terminal else { return false }
            guard !session.readyToMerge, !session.autopilotComplete else { return false }
            guard !gitMerged else { return false }
            return !isMerging(session, now: now)
        }
    }

    /// The bar's order: the state-changing verbs first, the destructive one last, matching the
    /// web menu's top-to-bottom reading order.
    static let order: [SessionAction] = [
        .stop, .resume, .rename, .amend, .toggleReady, .regenerateRecap, .relaunch,
    ]

    static func available(
        for session: Session,
        workingBlocked: [String: Bool] = [:],
        gitMerged: Bool = false,
        now: Int
    ) -> [SessionAction] {
        order.filter {
            allows($0, session: session, workingBlocked: workingBlocked, gitMerged: gitMerged, now: now)
        }
    }
}
```

`PreviewData.session(id:status:)` lives in `native/Apps/ShepherdMac/Sources/Main/PreviewData.swift`
— read it before writing the tests and use the signature it actually has.

- [ ] **Step 4: Run green and commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/ActionRulesTests 2>&1 | tail -3
```

Expected: `** TEST SUCCEEDED **`.

```bash
git add native/Apps/ShepherdMac/Sources/Actions/ActionRules.swift \
  native/Apps/ShepherdMac/Tests/ActionRulesTests.swift
git commit -m "feat(mac): action availability rules ported from the web ui"
```

---

### Task 5: `ActionsModel` — the `AppExtension`

**Files:** create `native/Apps/ShepherdMac/Sources/Actions/ActionsModel.swift` and
`native/Apps/ShepherdMac/Tests/ActionsModelTests.swift`.

**Interfaces:**
- Consumes: `AppExtension`, `AppModel.register(_:)` / `app.extension(_:)`, `SessionStore`,
  `SessionStore.events()`, `ServerEvent.unknown(name:payload:)`, Task 2's client methods,
  Task 4's `ActionRules`, `Log.ui`.
- Produces: `ActionReads` (with `.live(_:)`) and
  ```swift
  @Observable @MainActor final class ActionsModel: AppExtension {
      init(store: SessionStore, app: AppModel)
      init(reads: ActionReads, now: @escaping @Sendable () -> Int)
      var recaps: [String: Recap]
      var amendments: [String: [TaskAmendment]]
      var workingBlocked: [String: Bool]
      var gitMerged: Set<String>
      var isSubscribed: Bool
      func recap(for id: String) -> Recap?
      func amendments(for id: String) -> [TaskAmendment]
      func actions(for session: Session) -> [SessionAction]
      func refresh() async
      func apply(_ event: ServerEvent)
      func teardown()
  }
  ```

- [ ] **Step 1: Write the failing tests**

`native/Apps/ShepherdMac/Tests/ActionsModelTests.swift`:

```swift
import Foundation
import ShepherdKit
import Testing

@testable import Shepherd

@MainActor
struct ActionsModelTests {
    /// Driven through the injectable reads rather than the network: Task 2 proves the HTTP
    /// mapping, this suite is about state.
    private func model(_ reads: ActionReads = .stub) -> ActionsModel {
        ActionsModel(reads: reads, now: { 1_800_000_000_000 })
    }

    private func frame(_ name: String, _ json: String) -> ServerEvent {
        .unknown(name: name, payload: Data(json.utf8))
    }

    @Test func refreshInstallsTheRecapSnapshot() async {
        let m = model()
        await m.refresh()
        #expect(m.recap(for: "s1")?.headline == "Rate limiter lands")
    }

    @Test func aRefreshThatLostItsRaceIsDropped() async {
        let m = model()
        m.armStaleGeneration()
        await m.refresh()
        #expect(m.recaps.isEmpty, "a superseded snapshot must not be installed")
    }

    @Test func aFailedReadLeavesTheLastSnapshotInPlace() async {
        let m = model()
        await m.refresh()
        m.reads = .failing
        await m.refresh()
        #expect(m.recap(for: "s1") != nil, "a failed read must not blank the recap line")
    }

    @Test func aRecapFrameReplacesOneEntry() {
        let m = model()
        m.apply(
            frame(
                "session:recap",
                #"{"id":"s9","recap":{"sessionId":"s9","state":"ready","verdict":"parked","headline":"h9","body":"b","openItems":["x"],"updatedAt":9}}"#
            ))
        #expect(m.recap(for: "s9")?.verdict?.known == .parked)
        #expect(m.recap(for: "s9")?.openItems == ["x"])
    }

    @Test func anAmendmentsFrameReplacesTheWholeList() {
        let m = model()
        m.apply(
            frame(
                "session:amendments",
                #"{"id":"s9","amendments":[{"id":"a1","sessionId":"s9","text":"t","createdAt":1,"retractedAt":null}]}"#
            ))
        #expect(m.amendments(for: "s9").count == 1)
        // An empty array is a genuine all-clear, not "no news".
        m.apply(frame("session:amendments", #"{"id":"s9","amendments":[]}"#))
        #expect(m.amendments(for: "s9").isEmpty)
    }

    @Test func anUndecodableFrameIsIgnoredRatherThanCrashing() {
        let m = model()
        m.apply(frame("session:recap", #"{"nope":true}"#))
        m.apply(frame("session:recap", ""))
        m.apply(frame("some:other:event", "{}"))
        #expect(m.recaps.isEmpty)
    }

    @Test func archivingDropsTheSessionsDerivedState() {
        let m = model()
        m.apply(frame("session:amendments", #"{"id":"s9","amendments":[]}"#))
        m.apply(
            frame(
                "session:recap",
                #"{"id":"s9","recap":{"sessionId":"s9","state":"ready","headline":"h","body":"b","openItems":[],"updatedAt":1}}"#
            ))
        m.apply(.sessionArchived(.init(id: "s9")))
        #expect(m.recap(for: "s9") == nil)
        #expect(m.amendments(for: "s9").isEmpty)
    }

    @Test func actionsGoThroughActionRulesWithTheInjectedSeams() {
        let m = model()
        var session = PreviewData.session(id: "s1", status: SessionStatus(known: .idle))
        session.claudeSessionId = "claude-1"
        #expect(m.actions(for: session).contains(.relaunch))

        m.gitMerged = ["s1"]
        #expect(!m.actions(for: session).contains(.relaunch), "a merged PR hides relaunch")

        var blocked = PreviewData.session(id: "s2", status: SessionStatus(known: .blocked))
        blocked.claudeSessionId = "claude-2"
        #expect(!m.actions(for: blocked).contains(.stop))
        m.workingBlocked = ["s2": true]
        #expect(m.actions(for: blocked).contains(.stop))
    }

    @Test func teardownEndsTheEventSubscription() {
        let m = model()
        m.teardown()
        #expect(!m.isSubscribed)
    }
}
```

- [ ] **Step 2: Run them and watch them fail**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/ActionsModelTests 2>&1 | tail -20
```

Expected: `cannot find 'ActionsModel' in scope`.

- [ ] **Step 3: Write the model**

`native/Apps/ShepherdMac/Sources/Actions/ActionsModel.swift`:

```swift
import Foundation
import Observation
import ShepherdKit

/// The one read the action bar bootstraps from, behind a closure so the unit tests need no
/// network and no URL-protocol stub.
struct ActionReads: Sendable {
    var recaps: @Sendable () async throws -> [String: Recap]

    static func live(_ client: ShepherdClient) -> ActionReads {
        ActionReads(recaps: { try await client.recaps() })
    }
}

/// The action bar's state: the recap line's source, the amendment counts, and the two seams
/// that belong to other streams.
///
/// An `AppExtension`, so it is built in `AppModel.activate(_:)` once the store exists and torn
/// down right before that store stops. It holds its store strongly, which is safe precisely
/// because of that lifecycle.
///
/// Everything it shows is re-derivable: `refresh()` re-reads the whole recap map, and the two
/// frames it taps each carry a complete replacement for one session. That is deliberate — a tap
/// is not a guaranteed-complete log (it drops its own oldest past 64 buffered, and `EventStream`
/// loses frames while a socket is down), so nothing here may depend on an unbroken sequence.
@Observable
@MainActor
final class ActionsModel: AppExtension {
    private(set) var recaps: [String: Recap] = [:]
    private(set) var amendments: [String: [TaskAmendment]] = [:]

    /// S3's `GET /api/working-blocked`. Empty until the integration lane assigns it; empty is
    /// the conservative answer (a blocked session reads as blocked, so Stop stays hidden).
    var workingBlocked: [String: Bool] = [:]
    /// Session ids whose PR has merged — S2's `GET /api/sessions/{id}/git`. Empty until the
    /// integration lane assigns it; empty means Relaunch stays offered, matching the web's
    /// behaviour before its own git snapshot arrives.
    var gitMerged: Set<String> = []

    /// Whether the event tap is still running. Read by the tests; `teardown()` clears it.
    private(set) var isSubscribed = false

    var reads: ActionReads
    private let now: @Sendable () -> Int
    private weak var app: AppModel?

    /// Drops a snapshot whose activation has moved on. Bumped by `teardown()` and by
    /// `armStaleGeneration()` (tests only), and compared across every `await`.
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var tap: Task<Void, Never>?

    init(store: SessionStore, app: AppModel) {
        self.reads = .live(store.client)
        self.now = { Int(Date().timeIntervalSince1970 * 1_000) }
        self.app = app
        subscribe(to: store)
        Task { [weak self] in await self?.refresh() }
    }

    /// Test/preview seam: no store, no socket, injected clock.
    init(reads: ActionReads, now: @escaping @Sendable () -> Int) {
        self.reads = reads
        self.now = now
    }

    // MARK: - Reads

    func recap(for id: String) -> Recap? { recaps[id] }
    func amendments(for id: String) -> [TaskAmendment] { amendments[id] ?? [] }

    func actions(for session: Session) -> [SessionAction] {
        ActionRules.available(
            for: session,
            workingBlocked: workingBlocked,
            gitMerged: gitMerged.contains(session.id),
            now: now())
    }

    /// Re-reads the recap snapshot. A failure is logged and dropped: the bar keeps the last
    /// snapshot rather than blanking, because a missing recap line reads as "nothing to do".
    func refresh() async {
        let mine = generation
        do {
            let loaded = try await reads.recaps()
            guard mine == generation else { return }
            recaps = loaded
        } catch {
            Log.ui.error(
                "recap snapshot read failed: \(String(describing: error), privacy: .public)")
        }
    }

    /// Tests only: make the next in-flight refresh look superseded.
    func armStaleGeneration() { generation &+= 1 }

    // MARK: - Events

    private func subscribe(to store: SessionStore) {
        isSubscribed = true
        let events = store.events()
        tap = Task { [weak self] in
            for await event in events {
                guard let self else { return }
                self.apply(event)
            }
            self?.isSubscribed = false
        }
    }

    /// Applies one frame. Both of this stream's events arrive as `.unknown(name:payload:)` —
    /// `EventName` is an open enum and `ServerEvent.swift` is S0-owned, so a stream decodes its
    /// own payload with the generated schema its own contract block declares.
    func apply(_ event: ServerEvent) {
        switch event {
        case .sessionArchived(let payload):
            recaps[payload.id] = nil
            amendments[payload.id] = nil
        case .unknown(let name, let payload):
            guard let payload else { return }
            switch name {
            case "session:recap":
                guard let frame = decode(Components.Schemas.SessionRecapEvent.self, payload)
                else { return }
                recaps[frame.id] = frame.recap
            case "session:amendments":
                guard let frame = decode(Components.Schemas.SessionAmendmentsEvent.self, payload)
                else { return }
                // The server always sends the FULL current list, so an empty array is a genuine
                // all-clear and must replace, not merge.
                amendments[frame.id] = frame.amendments
            default:
                return
            }
        default:
            return
        }
    }

    /// A frame this build cannot read is dropped, never fatal: the server emits shapes a newer
    /// Shepherd may have widened, and one bad frame must not take the bar down.
    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) -> T? {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            Log.ui.debug("dropping an undecodable actions frame")
            return nil
        }
    }

    // MARK: - Lifecycle

    func teardown() {
        generation &+= 1
        tap?.cancel()
        tap = nil
        isSubscribed = false
        app = nil
    }
}

extension ActionReads {
    /// A fixed snapshot for the unit tests and previews.
    static let stub = ActionReads(recaps: {
        [
            "s1": Recap(
                sessionId: "s1",
                state: RecapState(known: .ready),
                verdict: RecapVerdict(known: .needsAttention),
                headline: "Rate limiter lands",
                body: "Adds the token bucket and its tests.",
                openItems: ["wire the admin route through the limiter"],
                changedFiles: ["src/limiter.ts"],
                generatedAt: 1_800_000_060_000,
                updatedAt: 1_800_000_060_000)
        ]
    })

    /// Every read throws, for the "a failure must not blank the bar" test.
    static let failing = ActionReads(recaps: { throw ShepherdError.transport("stub") })
}
```

If `ShepherdError.transport` takes a different associated value, read
`native/Sources/ShepherdKit/Model/ShepherdError.swift` and use the real case; do not add one.

- [ ] **Step 4: Run green and commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/ActionsModelTests 2>&1 | tail -3
```

Expected: `** TEST SUCCEEDED **`.

```bash
git add native/Apps/ShepherdMac/Sources/Actions/ActionsModel.swift \
  native/Apps/ShepherdMac/Tests/ActionsModelTests.swift
git commit -m "feat(mac): actions app-extension with recap and amendment state"
```

---

### Task 6: The action bar, its shortcuts and the slot install

**Files:** create `native/Apps/ShepherdMac/Sources/Actions/ActionBarView.swift`,
`native/Apps/ShepherdMac/Sources/Actions/ActionsStream.swift` and
`native/Apps/ShepherdMac/Tests/ActionBarTests.swift`.

**Interfaces:**
- Consumes: `ActionBarSlot.content`, `SessionCommandState` and `NoticeBar` (both in
  `Sources/Main/MainWindow.swift`, same module — reused, not re-implemented),
  `ShepherdErrorCopy.message(_:)`, `ActionsModel`, `ActionRules`, `SessionAction`, `L`, `Log.ui`,
  Task 7's `RenameSheet` and `AmendSheet`.
- Produces: `RecapLine`, `ActionBarView`, `ActionsStream.install(_:)`, and
  `ActionBarView.Sheet` (`.rename`, `.amend`).

- [ ] **Step 1: Write the failing tests**

`native/Apps/ShepherdMac/Tests/ActionBarTests.swift`:

```swift
import ShepherdKit
import SwiftUI
import Testing

@testable import Shepherd

/// Serialized: `ActionBarSlot` is per-process state, and `resetStreamSeams()` in `init` is what
/// keeps the fallback suites honest.
@MainActor
@Suite(.serialized)
struct ActionBarTests {
    init() { resetStreamSeams() }

    @Test func theSlotIsEmptyUntilTheStreamInstallsItself() {
        #expect(ActionBarSlot.resolution == .fallback)
        ActionsStream.install(
            AppModel(defaults: Self.scratchDefaults(), credentials: InMemoryCredentialStore()))
        #expect(ActionBarSlot.resolution == .slot)
    }

    @Test func installingTwiceRegistersOneExtension() {
        let app = AppModel(defaults: Self.scratchDefaults(), credentials: InMemoryCredentialStore())
        ActionsStream.install(app)
        ActionsStream.install(app)
        #expect(app.extensionFactories.count == 1)
    }

    @Test func theRecapLineNamesTheVerdictAndCountsOpenItems() {
        let ready = RecapLine.Content(
            verdict: L.t("recap_verdict_ready"), headline: "All green", openItems: 0)
        #expect(RecapLine.content(for: nil) == nil)

        let recap = Recap(
            sessionId: "s1", state: RecapState(known: .ready),
            verdict: RecapVerdict(known: .needsAttention), headline: "Two follow-ups open",
            body: "b", openItems: ["a", "b"], changedFiles: [], generatedAt: 1, updatedAt: 1)
        let content = RecapLine.content(for: recap)
        #expect(content?.verdict == L.t("recap_verdict_needs_attention"))
        #expect(content?.headline == "Two follow-ups open")
        #expect(content?.openItems == 2)
        #expect(content != ready)
    }

    @Test func aRecapStillGeneratingHasNoLineYet() {
        let recap = Recap(
            sessionId: "s1", state: RecapState(known: .generating), verdict: nil,
            headline: "", body: "", openItems: [], changedFiles: [], generatedAt: nil,
            updatedAt: 1)
        #expect(RecapLine.content(for: recap) == nil, "an empty headline is not a line")
    }

    @Test func anUnknownVerdictFallsBackToTheRawValue() {
        let recap = Recap(
            sessionId: "s1", state: RecapState(known: .ready),
            verdict: RecapVerdict(unknown: "quantum"), headline: "h", body: "b",
            openItems: [], changedFiles: [], generatedAt: 1, updatedAt: 1)
        #expect(RecapLine.content(for: recap)?.verdict == "quantum")
    }

    /// A throwaway suite so the test never reads or writes the operator's own profiles. Pair it
    /// with `InMemoryCredentialStore()` at every call site: `AppModel.init` defaults `credentials`
    /// to `KeychainCredentialStore()`, and that is the unattended-run stall this plan's "No
    /// Keychain prompts" constraint exists to prevent. Every existing app test does the same.
    private static func scratchDefaults() -> UserDefaults {
        UserDefaults(suiteName: "run.shepherd.mac.actiontests.\(UUID().uuidString)")!
    }
}
```

- [ ] **Step 2: Run them and watch them fail**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/ActionBarTests 2>&1 | tail -20
```

Expected: `cannot find 'ActionsStream' in scope`.

- [ ] **Step 3: Write the recap line and the bar**

`native/Apps/ShepherdMac/Sources/Actions/ActionBarView.swift`:

```swift
import ShepherdKit
import SwiftUI

/// The web's recap verdict chip plus its headline — the "Handlungsbedarf" line.
///
/// The derivation is a static function over a value rather than a computed property on the
/// view, so the three interesting cases (no recap, a recap still generating, a verdict this
/// build has never heard of) are assertable without hosting SwiftUI.
enum RecapLine {
    struct Content: Equatable, Sendable {
        let verdict: String
        let headline: String
        let openItems: Int
    }

    /// `nil` when there is nothing worth a line: no recap at all, or one whose headline is still
    /// empty because it has not finished generating.
    static func content(for recap: Recap?) -> Content? {
        guard let recap, !recap.headline.isEmpty else { return nil }
        return Content(
            verdict: label(for: recap.verdict),
            headline: recap.headline,
            openItems: recap.openItems.count)
    }

    /// An open enum: a verdict this build does not know still renders, as its raw wire value,
    /// rather than vanishing.
    private static func label(for verdict: RecapVerdict?) -> String {
        guard let verdict else { return "" }
        switch verdict.known {
        case .ready: return L.t("recap_verdict_ready")
        case .parked: return L.t("recap_verdict_parked")
        case .needsAttention: return L.t("recap_verdict_needs_attention")
        case nil: return verdict.rawValue
        }
    }

    static func tint(for verdict: RecapVerdict?) -> Color {
        switch verdict?.known {
        case .ready: .green
        case .needsAttention: .orange
        case .parked: .secondary
        default: .secondary
        }
    }
}

/// The quick-action bar under the detail pane.
///
/// Every action goes through `SessionCommandState` — the same gate `MainWindow`'s toolbar uses
/// for archive and interrupt — so exactly one command runs at a time, a failure lands in a
/// `NoticeBar` in the operator's language, and a completion for a store the operator has left
/// touches nothing. The one destructive action is behind a `confirmationDialog`.
struct ActionBarView: View {
    let session: Session
    let store: SessionStore
    let model: ActionsModel
    /// Reads the live store identity for `SessionCommandState.isCurrent`.
    let app: AppModel

    enum Sheet: String, Identifiable {
        case rename
        case amend
        var id: String { rawValue }
    }

    @State private var command = SessionCommandState()
    @State private var sheet: Sheet?
    @State private var confirmingRelaunch = false
    /// A one-line success note (renamed, relaunched, amendment recorded) that fades on the next
    /// command. Separate from `command.message`, which is only ever a failure.
    @State private var note: String?

    private var actions: [SessionAction] { model.actions(for: session) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let message = command.message {
                NoticeBar(message: message) { command.clear() }
            }
            if let note {
                NoticeBar(message: note) { self.note = nil }
            }
            if let recap = RecapLine.content(for: model.recap(for: session.id)) {
                recapLine(recap)
            }
            buttons
        }
        .accessibilityIdentifier("action-bar")
        .accessibilityLabel(L.t("native_actions_bar_label"))
        .confirmationDialog(
            L.t("native_actions_relaunch_confirm_title"),
            isPresented: $confirmingRelaunch,
            titleVisibility: .visible
        ) {
            Button(L.t("native_actions_relaunch_confirm_action"), role: .destructive) {
                relaunch()
            }
            Button(L.t("common_cancel"), role: .cancel) {}
        } message: {
            Text(verbatim: L.t("native_actions_relaunch_confirm_body"))
        }
        .sheet(item: $sheet) { which in
            switch which {
            case .rename:
                RenameSheet(session: session, store: store, app: app) { renamed in
                    note = renamed
                    sheet = nil
                }
            case .amend:
                AmendSheet(session: session, store: store, app: app) { recorded in
                    note = recorded
                    sheet = nil
                }
            }
        }
        // A different session is a different set of commands; carrying a notice across would
        // attribute one session's failure to another.
        .onChange(of: session.id) { _, _ in
            command.clear()
            note = nil
        }
    }

    private func recapLine(_ content: RecapLine.Content) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(verbatim: content.verdict)
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(
                    RecapLine.tint(for: model.recap(for: session.id)?.verdict).opacity(0.18),
                    in: Capsule())
                .foregroundStyle(RecapLine.tint(for: model.recap(for: session.id)?.verdict))
            Text(verbatim: content.headline)
                .font(.callout)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            if content.openItems > 0 {
                Text(verbatim: "\(L.t("recap_open_items")): \(content.openItems)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .accessibilityIdentifier("action-bar-recap")
    }

    private var buttons: some View {
        HStack(spacing: 8) {
            ForEach(actions) { action in
                Button {
                    run(action)
                } label: {
                    Label(action.label(for: session), systemImage: action.systemImage)
                }
                .help(action.help(for: session))
                .disabled(command.busy)
                .modifier(ShortcutModifier(shortcut: action.shortcut))
                .accessibilityIdentifier("action-\(action.id)")
            }
            Spacer(minLength: 0)
            if command.busy { ProgressView().controlSize(.small) }
        }
        .buttonStyle(.bordered)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    // MARK: - Running a command

    private func run(_ action: SessionAction) {
        switch action {
        case .rename: sheet = .rename
        case .amend: sheet = .amend
        case .relaunch: confirmingRelaunch = true
        case .stop: interrupt()
        case .resume: resume()
        case .toggleReady: toggleReady()
        case .regenerateRecap: regenerateRecap()
        }
    }

    private func interrupt() {
        let name = session.name
        Task {
            let ok = await command.run(
                { try await store.interrupt(id: session.id) },
                failureCopy: { _ in L.t("cardmenu_stop_failed", name) },
                isCurrent: { app.store === store })
            if ok { note = L.t("cardmenu_stop_toast", name) }
        }
    }

    private func resume() {
        let name = session.name
        Task {
            await command.run(
                { _ = try await store.client.resume(sessionID: session.id) },
                failureCopy: { _ in L.t("cardmenu_resume_failed", name) },
                isCurrent: { app.store === store })
        }
    }

    private func toggleReady() {
        let next = !session.readyToMerge
        Task {
            await command.run(
                { try await store.client.setReadyToMerge(sessionID: session.id, ready: next) },
                failureCopy: { L.t("native_actions_failed", $0) },
                isCurrent: { app.store === store })
        }
    }

    private func regenerateRecap() {
        Task {
            await command.run(
                { _ = try await store.client.regenerateRecap(sessionID: session.id) },
                failureCopy: { _ in L.t("recap_regenerate_failed") },
                isCurrent: { app.store === store })
        }
    }

    private func relaunch() {
        Task {
            var outcome: RelaunchResult?
            let ok = await command.run(
                { outcome = try await store.client.relaunch(sessionID: session.id) },
                failureCopy: { L.t("native_actions_failed", $0) },
                isCurrent: { app.store === store })
            guard ok, let outcome else { return }
            // The replacement arrives as session:new; the original leaves as session:archived,
            // and `MainWindow.reconcileSelection` moves the selection off it. Saying so matters
            // when it did NOT: a relaunch that could not decommission the original leaves two
            // rows, and the operator has to know which one is live.
            note =
                outcome.archived
                ? L.t("relaunch_done", outcome.session.desig ?? outcome.session.name)
                : L.t("relaunch_archive_failed")
        }
    }
}

/// `keyboardShortcut` has no optional form, so the choice is made once here instead of at seven
/// call sites.
private struct ShortcutModifier: ViewModifier {
    let shortcut: ActionShortcut?

    func body(content: Content) -> some View {
        if let shortcut {
            content.keyboardShortcut(KeyEquivalent(shortcut.key), modifiers: shortcut.modifiers)
        } else {
            content
        }
    }
}
```

`Session.desig` is optional in the contract; if the generated property is non-optional, drop the
`??` and pass it directly.

- [ ] **Step 4: Write the install point**

`native/Apps/ShepherdMac/Sources/Actions/ActionsStream.swift`:

```swift
import ShepherdKit
import SwiftUI

/// This stream's single entry point. The integration lane adds exactly one line to
/// `StreamRegistrations.installAll(into:)`:
///
///     ActionsStream.install(app)
///
/// Idempotent: `AppModel.register` is keyed by extension type, and the slot assignment is a
/// plain overwrite, so the launch task may run it more than once.
@MainActor
enum ActionsStream {
    static func install(_ app: AppModel) {
        app.register(ActionsModel.self)
        ActionBarSlot.content = { session, store, app in
            // A bar with no live extension has no recap and no seams to read, which happens
            // only between `register` and the first activation. Rendering nothing is right:
            // the actions themselves need the model's rules.
            guard let model = app.extension(ActionsModel.self) else { return AnyView(EmptyView()) }
            return AnyView(
                ActionBarView(session: session, store: store, model: model, app: app))
        }
        Log.app.info("actions stream installed")
    }
}
```

- [ ] **Step 5: Run the app tests, build, and look at it**

`ActionBarView` above already presents `RenameSheet` and `AmendSheet`, which Task 7 writes, so this
build is green only once both files exist. Executing strictly in order: write Task 7's two files
first, then come back and run this step.

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests 2>&1 | tail -3 \
  && ./native/scripts/build-app.sh 2>&1 | tail -2
```

Expected: `** TEST SUCCEEDED **` and `** BUILD SUCCEEDED **`.

- [ ] **Step 6: Commit**

```bash
git add native/Apps/ShepherdMac/Sources/Actions/ActionBarView.swift \
  native/Apps/ShepherdMac/Sources/Actions/ActionsStream.swift \
  native/Apps/ShepherdMac/Tests/ActionBarTests.swift
git commit -m "feat(mac): session action bar with the recap line and shortcuts"
```

---

### Task 7: Rename and Amend sheets

**Files:** create `native/Apps/ShepherdMac/Sources/Actions/RenameSheet.swift` and
`native/Apps/ShepherdMac/Sources/Actions/AmendSheet.swift`; extend
`native/Apps/ShepherdMac/Tests/ActionBarTests.swift`.

**Interfaces:**
- Consumes: `SessionCommandState`, `NoticeBar`, `ShepherdErrorCopy`, `ShepherdClient.rename`,
  `ShepherdClient.amend`, `ActionsModel`, `L`.
- Produces: `RenameSubmission` (`static func validate(_:) -> Bool`,
  `static func note(for:) -> String`), `RenameSheet`, `AmendSubmission`
  (`static let maxCharacters: Int`, `static func validate(_:) -> Bool`,
  `static func note(steered:) -> String`), `AmendSheet`.

- [ ] **Step 1: Write the failing tests**

Append to `native/Apps/ShepherdMac/Tests/ActionBarTests.swift`, inside the `ActionBarTests` struct:

```swift
    @Test func renameRejectsABlankNameAndReportsAPinnedBranch() {
        #expect(!RenameSubmission.validate(""))
        #expect(!RenameSubmission.validate("   "))
        #expect(RenameSubmission.validate("fresh name"))

        let moved = Components.Schemas.RenameResult(
            session: PreviewData.session(id: "s1", status: SessionStatus(known: .idle)),
            branchRenamed: true)
        var pinned = moved
        pinned.branchRenamed = false
        #expect(RenameSubmission.note(for: moved) == L.t("toast_renamed", moved.session.name))
        #expect(
            RenameSubmission.note(for: pinned) == L.t("viewport_rename_branch_kept"),
            "a display-only rename must say the branch stayed put")
    }

    @Test func amendRejectsBlankAndOverLongTextAndReportsDelivery() {
        #expect(!AmendSubmission.validate(""))
        #expect(!AmendSubmission.validate("  \n "))
        #expect(AmendSubmission.validate("Also cover the admin route."))
        #expect(!AmendSubmission.validate(String(repeating: "x", count: AmendSubmission.maxCharacters + 1)))
        #expect(AmendSubmission.validate(String(repeating: "x", count: AmendSubmission.maxCharacters)))

        #expect(AmendSubmission.note(steered: true) == L.t("amend_recorded_and_steered"))
        #expect(AmendSubmission.note(steered: false) == L.t("amend_recorded_not_steered"))
    }
```

- [ ] **Step 2: Run them and watch them fail**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/ActionBarTests 2>&1 | tail -20
```

Expected: `cannot find 'RenameSubmission' in scope`.

- [ ] **Step 3: Write the rename sheet**

`native/Apps/ShepherdMac/Sources/Actions/RenameSheet.swift`:

```swift
import ShepherdKit
import SwiftUI

/// Pure rules for the rename sheet, pulled out of the view so they are testable without
/// hosting SwiftUI (pattern: `LoginSheetState`, `NewSessionSubmission`).
enum RenameSubmission {
    /// The server rejects a name that is blank after trimming (`parseRenameName`), so the sheet
    /// refuses to send one rather than round-tripping a 400.
    static func validate(_ raw: String) -> Bool {
        !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// What to tell the operator afterwards. A rename whose branch did NOT move is not a
    /// failure, but it is also not what was asked for — an open PR pinned the head branch — and
    /// saying so is the difference between a surprise and an explanation.
    static func note(for result: RenameResult) -> String {
        result.branchRenamed
            ? L.t("toast_renamed", result.session.name)
            : L.t("viewport_rename_branch_kept")
    }
}

struct RenameSheet: View {
    let session: Session
    let store: SessionStore
    let app: AppModel
    /// Called with the success note once the rename lands; the caller dismisses.
    let onDone: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name: String = ""
    @State private var command = SessionCommandState()

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(verbatim: L.t("viewport_rename_aria")).font(.headline)
            if let message = command.message {
                NoticeBar(message: message) { command.clear() }
            }
            TextField(L.t("viewport_rename_placeholder"), text: $name)
                .textFieldStyle(.roundedBorder)
                .onSubmit(submit)
                .accessibilityIdentifier("rename-field")
            HStack {
                Spacer()
                Button(L.t("common_cancel"), role: .cancel) { dismiss() }
                Button(L.t("common_save"), action: submit)
                    .buttonStyle(.borderedProminent)
                    .disabled(!RenameSubmission.validate(name) || command.busy)
                    .accessibilityIdentifier("rename-submit")
            }
        }
        .padding(20)
        .frame(width: 420)
        .onAppear { name = session.name }
    }

    private func submit() {
        guard RenameSubmission.validate(name) else { return }
        let typed = name
        Task {
            var result: RenameResult?
            let ok = await command.run(
                { result = try await store.client.rename(sessionID: session.id, name: typed) },
                // 409 name_taken comes back as the server's own word; give it the sentence the
                // web shows rather than echoing "name_taken" at the operator.
                failureCopy: { raw in
                    raw == "name_taken"
                        ? L.t("viewport_rename_name_taken") : L.t("viewport_rename_failed")
                },
                isCurrent: { app.store === store })
            guard ok, let result else { return }
            onDone(RenameSubmission.note(for: result))
        }
    }
}
```

- [ ] **Step 4: Write the amend sheet**

`native/Apps/ShepherdMac/Sources/Actions/AmendSheet.swift`:

```swift
import ShepherdKit
import SwiftUI

/// Pure rules for the amend sheet.
enum AmendSubmission {
    /// `AMENDMENT_MAX_CHARS` in `src/task-amendments.ts`. Enforced here so the counter and the
    /// server agree; the server still re-checks.
    static let maxCharacters = 2_000

    static func validate(_ raw: String) -> Bool {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed.count <= maxCharacters
    }

    /// The amendment is persisted before it is steered, so a delivery that did not land is still
    /// a recorded amendment — and must not read as a failure.
    static func note(steered: Bool) -> String {
        steered ? L.t("amend_recorded_and_steered") : L.t("amend_recorded_not_steered")
    }
}

struct AmendSheet: View {
    let session: Session
    let store: SessionStore
    let app: AppModel
    let onDone: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var steer = true
    @State private var command = SessionCommandState()

    private var remaining: Int {
        AmendSubmission.maxCharacters - text.trimmingCharacters(in: .whitespacesAndNewlines).count
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(verbatim: L.t("amend_title", session.name)).font(.headline)
            if let message = command.message {
                NoticeBar(message: message) { command.clear() }
            }
            GroupBox(L.t("amend_original_task")) {
                ScrollView {
                    Text(verbatim: session.prompt)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                .frame(maxHeight: 120)
            }
            TextEditor(text: $text)
                .font(.body)
                .frame(minHeight: 120)
                .overlay(alignment: .topLeading) {
                    if text.isEmpty {
                        Text(verbatim: L.t("amend_placeholder"))
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 8)
                            .allowsHitTesting(false)
                    }
                }
                .accessibilityIdentifier("amend-field")
            HStack {
                Toggle(isOn: $steer) {
                    Text(verbatim: L.t("amend_steer_label"))
                }
                Spacer()
                Text(verbatim: "\(remaining)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(remaining < 0 ? .red : .secondary)
            }
            HStack {
                Spacer()
                Button(L.t("common_cancel"), role: .cancel) { dismiss() }
                Button(command.busy ? L.t("amend_sending") : L.t("amend_submit"), action: submit)
                    .buttonStyle(.borderedProminent)
                    .disabled(!AmendSubmission.validate(text) || command.busy)
                    .accessibilityIdentifier("amend-submit")
            }
        }
        .padding(20)
        .frame(width: 520)
    }

    private func submit() {
        guard AmendSubmission.validate(text) else { return }
        let typed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let alsoSteer = steer
        Task {
            var created: AmendmentCreated?
            let ok = await command.run(
                {
                    created = try await store.client.amend(
                        sessionID: session.id, text: typed, steer: alsoSteer)
                },
                failureCopy: { _ in L.t("amend_failed") },
                isCurrent: { app.store === store })
            guard ok, let created else { return }
            // Not steering at all is a clean "recorded"; asking to steer and missing is the
            // case the operator has to hear about.
            onDone(alsoSteer ? AmendSubmission.note(steered: created.steered) : L.t("amend_recorded"))
        }
    }
}
```

- [ ] **Step 5: Run green, build, commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests 2>&1 | tail -3 \
  && ./native/scripts/build-app.sh 2>&1 | tail -2
```

Expected: `** TEST SUCCEEDED **` and `** BUILD SUCCEEDED **`.

```bash
git add native/Apps/ShepherdMac/Sources/Actions/RenameSheet.swift \
  native/Apps/ShepherdMac/Sources/Actions/AmendSheet.swift \
  native/Apps/ShepherdMac/Tests/ActionBarTests.swift
git commit -m "feat(mac): rename and amend sheets for the action bar"
```

---

### Task 8: Live check, full verification and the PR

**Files:** create `native/Apps/ShepherdMac/Tests/ActionsLiveTests.swift`.

**Interfaces:** consumes everything above, plus `SHEPHERD_LIVE_BASE_URL` /
`SHEPHERD_LIVE_PASSWORD` (or `SHEPHERD_LIVE_TOKEN`), read through the existing
`LiveServerEnvironment` in `native/Apps/ShepherdMac/Tests/LiveServerTests.swift`.

- [ ] **Step 1: Write the live-gated test**

`native/Apps/ShepherdMac/Tests/ActionsLiveTests.swift`:

```swift
import Foundation
import ShepherdKit
import Testing

@testable import Shepherd

/// Skipped unless the environment arms it, so CI (which has no tailnet) never runs it. Read-only
/// against the operator's real server: it decodes the recap snapshot and derives the bar for a
/// real session, and it issues **no** write command — a live relaunch would discard somebody's
/// worktree.
@MainActor
struct ActionsLiveTests {
    private func liveStore() throws -> SessionStore? {
        guard let raw = LiveServerEnvironment.baseURL, let url = URL(string: raw),
            let token = LiveServerEnvironment.token
        else { return nil }
        let credentials = InMemoryCredentialStore()
        try credentials.save(StoredCredential(token: token, tokenId: "live"), for: "live")
        return try SessionStore(
            profile: ServerProfile(
                name: "live", baseURL: url, mode: .remote, credentialKey: "live"),
            credentials: credentials)
    }

    @Test func theRecapSnapshotDecodesAgainstTheRealServer() async throws {
        guard let store = try liveStore() else { return }
        let recaps = try await store.client.recaps()
        // Reaching here already proved the decode; assert one invariant so an empty body still
        // fails if the route ever stops answering a map.
        for (id, recap) in recaps {
            #expect(recap.sessionId == id || !recap.sessionId.isEmpty)
        }
    }

    @Test func theBarDerivesActionsForTheLiveHerd() async throws {
        guard let store = try liveStore() else { return }
        try await store.bootstrap()
        let model = ActionsModel(
            reads: .live(store.client), now: { Int(Date().timeIntervalSince1970 * 1_000) })
        await model.refresh()
        #expect(!store.sessions.isEmpty, "the live server should have sessions")
        for session in store.sessions where session.status.known != .archived {
            let actions = model.actions(for: session)
            #expect(
                actions.contains(.rename) && actions.contains(.amend),
                "every live session can be renamed and amended")
            if session.terminal {
                #expect(!actions.contains(.relaunch), "a clean terminal is never relaunchable")
            }
        }
    }
}
```

- [ ] **Step 2: Run it against the live server**

```bash
TEST_RUNNER_SHEPHERD_LIVE_BASE_URL="$SHEPHERD_LIVE_BASE_URL" \
TEST_RUNNER_SHEPHERD_LIVE_TOKEN="$SHEPHERD_LIVE_TOKEN" \
  ./native/scripts/test-app.sh -only-testing:ShepherdTests/ActionsLiveTests 2>&1 | tail -3
```

Expected: `** TEST SUCCEEDED **`. Both variables come from the environment only — never from a
file, never committed. Without them the same command passes with both tests trivially satisfied,
which is the CI path.

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
`swift test` passes · `** TEST SUCCEEDED **` · `** BUILD SUCCEEDED **`. Never `bun test`.

- [ ] **Step 4: Prove the ownership rule was kept**

```bash
git diff --name-only origin/main...HEAD | sort
```

Expected: exactly the files in "File ownership" and nothing else. If `AppModel.swift`,
`MainWindow.swift`, `ShepherdApp.swift`, `StreamRegistrations.swift`, `project.yml` or
`test/contract/harness.ts` appears — **revert that file** and report it.

- [ ] **Step 5: Rebase and re-run the contract gate**

```bash
git fetch origin && git rebase origin/main && bun run test:contract 2>&1 | tail -3
```

A conflict between two stream markers in `contracts/openapi.yaml` is an insertion conflict: keep both
blocks. A conflict in `ui/messages/*.json` that the union merge driver did **not** resolve is a real
one — two branches gave the same key different values; resolve it on the merits.

- [ ] **Step 6: Open the PR**

```bash
git push --no-verify -u origin feat/native-actions
gh pr create --base main --title "feat(mac): session action bar" --body "$(cat <<'EOF'
Stream S4. Brings the web UI's per-session actions to Shepherd for Mac.

## What landed
- **Contract:** `POST /api/sessions/{id}/{resume,rename,amendments,ready,relaunch,recap/regenerate}`
  and `GET /api/recaps`, plus the `session:recap` and `session:amendments` events, with fixtures, a
  drift test and a per-block coverage gate.
- **Kit:** `ShepherdClient+Actions.swift` — seven typed commands over the generated client.
- **App:** `ActionRules` (the web's `stoppable` / `canResume` / `canRelaunch` / `isMerging`
  predicates, ported and unit-tested), `ActionsModel` (`AppExtension`, generation-guarded refresh, a
  tap on `SessionStore.events()`), the action bar with its recap "Handlungsbedarf" line and
  window-scoped shortcuts, and the rename and amend sheets. Every command runs through the existing
  `SessionCommandState`; relaunch is behind a `confirmationDialog`. `AppModel`, `MainWindow` and
  `StreamRegistrations` are untouched.

## Deliberate deviations from the stream brief
- The brief's preset chips (ok, folge dir, commit-push-merge, …) **do not exist in the web UI**;
  the per-session actions it actually offers are `CardMenu`'s items, the viewport header's
  Resume/Decommission and the hold-row CTA. This PR implements the `CardMenu` subset whose route it
  owns.
- `/reply` and `/recommend-prompt` are **out** — `/reply` belongs to S1 (the prompt bar), and a
  recommended prompt with no composer to land in is a dead route.
- `/go` and `/answer-plan-questions` are **out**: both act on the plan gate, whose payload family
  no stream owns and whose success paths cannot be driven through the stubbed contract server.
- Merge PR (S2's `/git/merge`), the variant/continue pickers, the cross-repo relaunch composer and
  the clean-terminal create are **out**.
- Decommission stays in `MainWindow`'s toolbar, which already confirms it; a second archive
  affordance with different confirmation mechanics would be worse than one.
- Known parity gaps: `ActionRules` takes `workingBlocked` (S3) and `gitMerged` (S2) as injected
  values defaulting to the conservative answer. `ActionsModel.workingBlocked` and
  `ActionsModel.gitMerged` are the one-line seams S0-int assigns once those streams land.

## Integration lane
`StreamRegistrations.installAll(into:)` gains exactly one line: `ActionsStream.install(app)`.

## Verification
`bun run test:contract` · `bun run check:contract-swift` · `native/scripts/sync-contract.sh --check`
· `bun run check:strings` · `ui && bun run check:i18n` · `bun run lint` · `bun run test` ·
`swift test --package-path native` · `native/scripts/test-app.sh -only-testing:ShepherdTests` ·
`native/scripts/build-app.sh` · read-only live smoke with `SHEPHERD_LIVE_BASE_URL` /
`SHEPHERD_LIVE_TOKEN` from the environment.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 7: Watch CI**

```bash
gh pr checks --watch
```

Expected: every check green, including the `native` workflow's `ShepherdKit` job, which runs
`check:contract-swift`, the sync freshness check, `swift build` and `swift test`.

---

## Self-review

**Spec coverage.** The design spec's sub-project 4 asks for a toolbar with "new session, interrupt,
archive, profile switcher" (already shipped) and names no further session actions; the master plan's
S4 row asks for a quick-action bar and the recap line. Bar → Task 6. Recap line
("Handlungsbedarf" = `recap_verdict_needs_attention`) → Tasks 1, 5, 6. Confirmations for destructive
actions → Task 6's `confirmationDialog` for relaunch, plus the existing archive dialog left in the
toolbar. Keyboard shortcuts → `SessionAction.shortcut`, Task 4, bound in Task 6, collision-tested.
`L.t()` + `KEYS_ACTIONS` → Task 3. `ActionBarSlot` install → Task 6. Contract blocks for every route
used → Task 1. `SessionCommandState` reuse → Tasks 6 and 7, named as a precondition. Tests → Tasks
1, 2, 3, 4, 5, 6, 7 each end with one. Gate/live/PR → Task 8.

**Placeholders.** None. Every code step carries the whole file or the whole block; every command
carries its expected output. Three deliberate forward references, each called out where it appears:
`RenameSheet`/`AmendSheet` (written in Task 7, called in Task 6 — Step 5 of Task 6 builds only after
Task 7 in a linear read, so run Task 6's build after Task 7 if executing strictly in order),
`Fixtures.session(id:)` and `PreviewData.session(id:status:)` (existing helpers — read the file and
use the real signature), and the generated 202 case name in Task 2 Step 3.

**Type consistency.** `SessionAction`'s seven cases are identical in Task 4 (definition), Task 5
(`ActionsModel.actions(for:)`), Task 6 (`run(_:)`) and the tests. `ActionRules.allows` has the same
four-parameter signature (`session:workingBlocked:gitMerged:now:`) everywhere it is called.
`ActionShortcut` is defined once and consumed once (`ShortcutModifier`). `ActionReads` has exactly
one member (`recaps`) in the struct, in `.live`, in `.stub` and in `.failing`. `RenameResult`,
`AmendmentCreated`, `RelaunchResult`, `RecapRegenerateResult`, `Recap`, `RecapState`, `RecapVerdict`
and `TaskAmendment` are the same typealiases in Task 2's extension, Task 5's model and Tasks 6–7's
views, and each is declared exactly once. `RecapLine.Content`'s three fields are the same in the
producer and in `ActionBarTests`. The 45 keys in `KEYS_ACTIONS` are exactly the union of the keys
Tasks 4, 6 and 7 pass to `L.t` minus the four already in `KEYS_CORE`, and exactly the keys asserted
in `ActionsStringsTests`.

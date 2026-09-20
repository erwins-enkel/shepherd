# Stream S9 — Merge, automation and post-merge Implementation Plan

**Goal:** make merge trains, per-session automation, durable owed steps and build queues usable from the Mac, with explicit confirmation for consequential actions.

**Architecture:** contract-first generated payloads, one `ShepherdClient+Merge.swift`
extension, activation-scoped observable models and SwiftUI views. Stream registration is split
between the model-free `installScene()` pass and `install(app)` after the store exists.

**Tech stack:** Swift 6, complete strict concurrency, SwiftUI, Observation, Swift Testing,
Bun contract tests and the repository's existing OpenAPI generator.

## Global Constraints

<!-- prettier-ignore-start -->


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

<!-- prettier-ignore-end -->

### Stream-specific bindings to the verbatim baseline

The preceding S7 block is reproduced verbatim. In this stream its three S7-specific bindings are
`KEYS_MERGE`, `MergeStream.install(app)`, and
`feat/native-merge`. All other rules apply literally. This stream **does** install views, so the
no-`.toolbar` rule applies to every detail tab. Every `AppModel` test supplies both
`InMemoryCredentialStore` and a UUID-named throwaway `UserDefaults` suite, removed in `defer`.
No test opens the Keychain. Use `SHEPHERD_LIVE_TOKEN` for these read-only checks; the supplied
operator token is never revoked. `REVOKE_ON_EXIT` applies only to credentials a harness itself
mints, never to an environment-provided token.

### Ownership and prerequisites

Own `Sources/Merge/**`, `ShepherdClient+Merge.swift`, `ShepherdClientMergeTests.swift`,
`Tests/Merge*Tests.swift`, `test/contract/merge.test.ts` and `merge-fixtures.ts`, only the three `merge` blocks in
`contracts/openapi.yaml`, their generated copies, `KEYS_MERGE`, append-only EN/DE entries and the
generated string catalog. App paths are relative to `native/Apps/ShepherdMac/`; kit paths to
`native/Sources/ShepherdKit/Client/` and `native/Tests/ShepherdKitTests/`.

Never edit `StreamRegistrations.swift`, `ShepherdApp.swift`, any `*Slot.swift`, `SessionSignals.swift`,
`AppModel.swift`, `MainWindow.swift`, `SessionStore.swift`, `ServerEvent.swift`, `EventName`, shared harness files, S7's sidebar, S10's
queues or S11's composer. `NewSessionSlot.content/options` stays S11's; a train calls
`store.create` with S0's extended `CreateSessionRequest`, not the composer extras hook.

Start after S0-prep-2 and S7 have merged; rebase onto S10 for its `owed` lens integration.
The master schedule's Phase D is authoritative over the S9 scope paragraph's stale “Phase C”.

```bash
test "$(rg -c '# ── stream: merge ──' contracts/openapi.yaml)" = 3
rg 'KEYS_MERGE' native/scripts/gen-strings.ts
rg 'manualStepsOutstanding' native/Apps/ShepherdMac/Sources/App/SessionSignals.swift
rg 'mergeTrainPrs' contracts/openapi.yaml
rg 'autoMerge:|prCache:' test/contract/deps.ts
test -f native/Apps/ShepherdMac/Sources/App/CommandRegistry.swift
test -f native/Apps/ShepherdMac/Sources/Herd/HerdSignals.swift
```

A missing marker or seam is an S0 prerequisite failure; report it instead of editing shared files.

### Verified decisions and integration handoffs

- `autopilot` is **PUT**, not the appendix's POST (`handleSessionAutopilot`, `src/server.ts:3514`).
  Add the disjoint `PUT /api/sessions/{id}/automerge` as well: otherwise the requested control
  cannot write. Both accept `{enabled: true|false|null}`; null inherits the repo default.
- Redeploy is **200/400/401/404/502**, never 409 (`forgeRedeploy`, `handleSessionGit`). No configured
  workflow is 400, missing session/forge is 404, a forge failure is 502. Drain queue adds 400 for
  invalid `repo`. Queue GET has no 400. Queue GET returns an empty **object queue**, never null.
- Add the unclaimed `POST /api/sessions/{id}/queue/approve` (200/401/404) used by the web's
  approval control. “Start” reuses S1's reply; it never redeclares that path. A real reply failure
  in approval is an undeclared 500, per `contracts/README.md`. There are no `/done` or `/skip`
  manual-step routes. Acknowledging pre-merge steps means “I own these”, not “completed”.
- `automerge:status` and `AutoMergeStatus` are **core-owned and already declared**. Reuse them;
  do not add a ninth event or a duplicate schema. All eight appendix events land in `merge`.
- Drain configuration belongs to S12's `repo-config`. S9 renders status and backlog; it does not
  create a duplicate config path or invent a POST drain action. The S12 workspace pane later
  supplies the write controls. Global automerge configuration follows that same ownership.
- The current web confirmation displays method/branch deletion, rather than offering pickers.
  Native offers the requested pickers using S2's existing `mergePR(sessionID:method:deleteBranch:)`.
  The current contract omits `GitState.mergeGate` and the merge request's `confirm` object.
  S9 must not widen the `detail` block. The S0-owned prerequisite below must merge before Task 7
  can pass: takeover confirmation is part of S9's merge scope, not a deferred parity limit.
  S0 owns the shared contract/wrapper extension; S9 owns its confirmation UI and tests. Never
  infer responsibility from `GitState.handoff` (a different, CI-dependent fact).
  Train confirmation lists every chosen PR and warns that the
  driver can land other people's PRs; it never claims that every target belongs to the operator.
- `SidebarSlot` and `ActionBarSlot` are single closures. Task 9 composes their existing content,
  once per process, and resolves the live model at render time. S0 installs S9 after S3/S4/S10.
  S0 points S10's `owed` panel at `MergeOwedView`; no S10 file changes on this branch.

| Task | Deliverable                                              |
| ---- | -------------------------------------------------------- |
| 1    | Verified contract, real-server fixtures and coverage     |
| 2    | Generated kit wrappers and transport assertions          |
| 3    | `KEYS_MERGE` and catalog checks                          |
| 4    | Pure train, queue and owed rules                         |
| 5    | Activation-safe `MergeModel`                             |
| 6    | Durable manual steps and the owed panel                  |
| 7    | Merge confirmation, autopilot and automerge controls     |
| 8    | Train kickoff, drain, build queue and post-merge actions |
| 9    | Tabs, slot composition, commands and cross-stream seams  |
| 10   | Read-only live checks, full gates and PR                 |

Contract snippets below are mapping members. When inserting them, indent schema members by four
spaces, path/event members by two, the core PATCH by four, and core Settings properties by eight.
Preserve the existing marked blocks and never insert a second top-level path or schema key.

### Task 1: Declare and prove the merge contract

**Files:** `contracts/openapi.yaml`, generated copies, `test/contract/merge-fixtures.ts`, `merge.test.ts`.

**Interfaces:** consumes S0 harness `s.stubs`, the real route handlers, existing `Session`, `AutoMergeStatus`, `Ok`, `Error`; produces 16 operations on 14 disjoint templates and eight events.

The matrix is verified against `src/server.ts` handlers and `src/validate.ts:1137–1207`.
No status is inferred from a neighboring route. Wrong-method 404/405 responses and middleware
415/CSRF responses are not advertised as successful operations.

| Operation                                    | Declared statuses       |
| -------------------------------------------- | ----------------------- |
| `GET /api/automerge`                         | 200, 401                |
| `PUT /api/sessions/{id}/autopilot`           | 200, 400, 401, 404      |
| `PUT /api/sessions/{id}/automerge`           | 200, 400, 401, 404      |
| `POST /api/sessions/{id}/git/redeploy`       | 200, 400, 401, 404, 502 |
| `GET /api/sessions/clear-merged`             | 200, 401                |
| `POST /api/sessions/clear-merged`            | 200, 401                |
| `GET /api/manual-steps/outstanding`          | 200, 401                |
| `POST /api/manual-steps/{id}/steps/{stepId}` | 200, 400, 401, 404      |
| `POST /api/manual-steps/{id}/dismiss`        | 200, 401, 404           |
| `POST /api/sessions/{id}/ack-manual-steps`   | 200, 401, 404           |
| `GET /api/drain`                             | 200, 401                |
| `GET /api/drain/queue`                       | 200, 400, 401           |
| `GET /api/queues`                            | 200, 401                |
| `GET /api/sessions/{id}/queue`               | 200, 401, 404           |
| `PUT /api/sessions/{id}/queue`               | 200, 400, 401, 404      |
| `POST /api/sessions/{id}/queue/approve`      | 200, 401, 404           |

- [ ] **Step 1: Write typed fixtures and a failing real-server test**

```ts
// test/contract/merge-fixtures.ts
import type { AutoMergeStatus } from "../../src/automerge";
import type { DrainStatus, QueuedItem } from "../../src/drain";
import type { PostMergeStep, BuildStepInput } from "../../src/types";
export const auto: AutoMergeStatus = {
  repoPath: "/fixture",
  enabled: true,
  state: "manual_steps",
  detail: "TASK-1",
  sessionId: "a",
};
export const drain: DrainStatus = {
  repoPath: "/fixture",
  enabled: true,
  paused: true,
  reason: "usage",
  detail: "80",
  queued: 1,
  inFlight: 1,
  max: 2,
  epicParent: null,
};
export const queued: QueuedItem[] = [{ number: 7, title: "Ship", url: "https://example.test/i/7" }];
export const steps: PostMergeStep[] = [
  { id: "one", text: "Rotate fixture key", postMerge: true, doneAt: null },
];
export const build: BuildStepInput[] = [
  { id: "one", title: "Build", detail: "Run checks", status: "pending" },
];
```

```ts
// test/contract/merge.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  bearer,
  collectEvents,
  coverage,
  login,
  mintToken,
  restoreAuth,
  startContractServer,
  validateEvent,
  validateResponse,
  withAuth,
  type ContractServer,
} from "./harness";
import { eventsForStream, operationsForStream } from "./stream-blocks";
import * as fx from "./merge-fixtures";
let s: ContractServer;
let token: string;
let id: string;
const OPS = operationsForStream("merge");
const EVENTS = eventsForStream("merge");
async function request(
  method: string,
  template: string,
  status: number,
  body?: unknown,
  path = template.replaceAll("{id}", id).replaceAll("{stepId}", "one"),
  auth = true,
) {
  const res = await fetch(s.baseUrl + path, {
    method,
    headers: { "content-type": "application/json", ...(auth ? bearer(token) : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(res.status, `${method} ${path}`).toBe(status);
  return await validateResponse(method, template, res);
}
beforeAll(async () => {
  await withAuth();
  s = startContractServer();
  ({ token } = await mintToken(s, await login(s), "merge contract"));
  const r = await fetch(s.baseUrl + "/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({ repoPath: s.validRepo, baseBranch: "main", prompt: "fixture" }),
  });
  expect(r.status).toBe(201);
  id = ((await r.json()) as { id: string }).id;
});
afterAll(() => {
  try {
    s?.stop();
  } finally {
    restoreAuth();
  }
});

test("bulk snapshots are non-empty, and drain validates repo", async () => {
  const savedDrain = s.deps.drain;
  const savedAuto = s.stubs.autoMerge.rows;
  s.stubs.autoMerge.rows = [{ ...fx.auto, repoPath: s.validRepo, sessionId: id }];
  s.deps.drain = {
    snapshot: async () => [{ ...fx.drain, repoPath: s.validRepo }],
    queue: async () => fx.queued,
  } as never;
  try {
    const auto = (await request("GET", "/api/automerge", 200)) as (typeof fx.auto)[];
    expect(auto[0]?.sessionId).toBe(id);
    const drain = (await request("GET", "/api/drain", 200)) as (typeof fx.drain)[];
    expect(drain[0]?.queued).toBe(1);
    const rows = await request(
      "GET",
      "/api/drain/queue",
      200,
      undefined,
      `/api/drain/queue?repo=${encodeURIComponent(s.validRepo)}`,
    );
    expect(rows).toEqual(fx.queued);
    await request("GET", "/api/drain/queue", 400, undefined, "/api/drain/queue?repo=/outside");
  } finally {
    s.deps.drain = savedDrain;
    s.stubs.autoMerge.rows = savedAuto;
  }
});

test("both per-session overrides support true, false and explicit null", async () => {
  for (const name of ["autopilot", "automerge"]) {
    const p = `/api/sessions/{id}/${name}`;
    for (const enabled of [true, false, null]) {
      const body = (await request("PUT", p, 200, { enabled })) as Record<string, unknown>;
      expect(body[name === "autopilot" ? "autopilotEnabled" : "autoMergeEnabled"]).toBe(enabled);
    }
    await request("PUT", p, 400, { enabled: "yes" });
    await request("PUT", p, 404, { enabled: true }, `/api/sessions/missing/${name}`);
  }
});

test("redeploy guards and forge errors", async () => {
  const p = "/api/sessions/{id}/git/redeploy";
  const saved = s.stubs.resolveForge.forge;
  try {
    s.stubs.resolveForge.forge = null;
    await request("POST", p, 404);
    await request("POST", p, 404, undefined, "/api/sessions/missing/git/redeploy");
    s.stubs.resolveForge.forge = { deployWorkflow: null };
    expect(await request("POST", p, 400)).toEqual({ error: "no deploy workflow configured" });
    let calls = 0;
    s.stubs.resolveForge.forge = {
      deployWorkflow: "deploy.yml",
      redeploy: async () => {
        calls++;
      },
    };
    expect(await request("POST", p, 200)).toEqual({ ok: true });
    expect(calls).toBe(1);
    s.stubs.resolveForge.forge = {
      deployWorkflow: "deploy.yml",
      redeploy: async () => {
        throw new Error("fixture failure");
      },
    };
    expect(await request("POST", p, 502)).toEqual({ error: "fixture failure" });
  } finally {
    s.stubs.resolveForge.forge = saved;
  }
});

test("owed materialization outlives its session; tick, untick, dismiss and acknowledge differ", async () => {
  s.deps.store.materializePostMergeSteps({
    sessionId: "pruned",
    desig: "TASK-1",
    repoPath: s.validRepo,
    prNumber: 7,
    prTitle: "Ship",
    steps: fx.steps,
  });
  const outstanding = (await request("GET", "/api/manual-steps/outstanding", 200)) as {
    sessionId: string;
  }[];
  expect(outstanding.map((r) => r.sessionId)).toContain("pruned");
  const p = "/api/manual-steps/{id}/steps/{stepId}";
  const actual = "/api/manual-steps/pruned/steps/one";
  await request("POST", p, 400, { done: 1 }, actual);
  await request("POST", p, 404, { done: true }, "/api/manual-steps/missing/steps/one");
  const done = (await request("POST", p, 200, { done: true }, actual)) as {
    clearedAt: number | null;
  };
  expect(done.clearedAt).not.toBeNull();
  const undone = (await request("POST", p, 200, { done: false }, actual)) as {
    clearedAt: number | null;
  };
  expect(undone.clearedAt).toBeNull();
  const dismissed = (await request(
    "POST",
    "/api/manual-steps/{id}/dismiss",
    200,
    undefined,
    "/api/manual-steps/pruned/dismiss",
  )) as { clearedAt: number | null };
  expect(dismissed.clearedAt).not.toBeNull();
  await request(
    "POST",
    "/api/manual-steps/{id}/dismiss",
    404,
    undefined,
    "/api/manual-steps/missing/dismiss",
  );
  await request("POST", "/api/sessions/{id}/ack-manual-steps", 200);
  expect(s.deps.store.get(id)?.manualStepsAckedAt).not.toBeNull();
  await request(
    "POST",
    "/api/sessions/{id}/ack-manual-steps",
    404,
    undefined,
    "/api/sessions/missing/ack-manual-steps",
  );
});

test("build queue GET is non-null, writes validate, approval is a separate action", async () => {
  const p = "/api/sessions/{id}/queue";
  expect(await request("GET", p, 200)).toMatchObject({ sessionId: id, steps: [], approved: false });
  await request("GET", p, 404, undefined, "/api/sessions/missing/queue");
  for (const steps of [
    [{ title: "" }],
    [
      { id: "dup", title: "a" },
      { id: "dup", title: "b" },
    ],
    Array.from({ length: 101 }, () => ({ title: "x" })),
  ]) {
    await request("PUT", p, 400, { steps });
  }
  const q = (await request("PUT", p, 200, { steps: fx.build })) as { steps: { id: string }[] };
  expect(q.steps[0]?.id).toBe("one");
  await request("PUT", p, 404, { steps: fx.build }, "/api/sessions/missing/queue");
  expect(await request("GET", "/api/queues", 200)).toHaveProperty(id);
  const approved = (await request("POST", "/api/sessions/{id}/queue/approve", 200)) as {
    approved: boolean;
  };
  expect(approved.approved).toBe(true);
  await request(
    "POST",
    "/api/sessions/{id}/queue/approve",
    404,
    undefined,
    "/api/sessions/missing/queue/approve",
  );
});

test("clear-merged sends only the explicitly reviewed ids", async () => {
  const saved = s.deps.service.archiveMany;
  const savedLeftovers = s.deps.service.leftovers;
  const savedProbes = s.deps.service.leftoverProbesUnavailable;
  s.stubs.prCache.rows[id] = { state: "merged", checks: "success", deployConfigured: false };
  let targets: string[] = [];
  s.deps.service.archiveMany = async (ids) => {
    targets = ids;
    return { cleared: ids, leftovers: 0 };
  };
  s.deps.service.leftovers = () => [];
  s.deps.service.leftoverProbesUnavailable = () => true;
  try {
    expect(await request("GET", "/api/sessions/clear-merged", 200)).toEqual({
      ids: [id],
      leftovers: 0,
      probesUnavailable: true,
    });
    expect(await request("POST", "/api/sessions/clear-merged", 200, { ids: [] })).toEqual({
      cleared: [],
      leftovers: 0,
    });
    expect(targets).toEqual([]);
    await request("POST", "/api/sessions/clear-merged", 200, { ids: [id, "not-merged"] });
    expect(targets).toEqual([id]);
  } finally {
    s.deps.service.archiveMany = saved;
    s.deps.service.leftovers = savedLeftovers;
    s.deps.service.leftoverProbesUnavailable = savedProbes;
    delete s.stubs.prCache.rows[id];
  }
});

test("eight frames, including null-clearing variants, arrive over the socket", async () => {
  const cases: [string, unknown][] = [
    ["session:automerge", { id, enabled: null }],
    [
      "session:autopilot",
      { id, paused: true, complete: false, question: "Choose?", enabled: null },
    ],
    ["session:autopilot", { id, paused: false, complete: true, question: null }],
    ["session:merging", { id, since: 1, trainId: "train" }],
    ["session:merging", { id, since: null, trainId: null }],
    ["mergetrain:landed", { repoPath: s.validRepo }],
    ["post-merge-steps:changed", {}],
    [
      "session:manual-steps",
      { id, manualSteps: fx.steps.map(({ id, text, postMerge }) => ({ id, text, postMerge })) },
    ],
    ["session:manual-steps", { id, manualSteps: [], manualStepsAckedAt: 1 }],
    ["queue:update", s.deps.store.getBuildQueue(id)],
    ["drain:status", fx.drain],
  ];
  const frames = await collectEvents(s, token, async () => {
    for (const [name, data] of cases) s.deps.events.emit(name, data);
  });
  for (const name of EVENTS) {
    const received = frames.filter((f) => f.event === name);
    expect(received.length).toBeGreaterThan(0);
    for (const frame of received) validateEvent(frame.event, frame.data);
  }
});

test("this file owns its 401 sweep", async () => {
  for (const op of OPS.filter((o) => o.endsWith(" 401"))) {
    const [method, template] = op.split(" ") as [string, string];
    await request(method, template, 401, method === "GET" ? undefined : {}, undefined, false);
  }
});
describe("merge coverage gate — last", () => {
  test("nonempty block, every declared status and event", () => {
    expect(OPS.length).toBeGreaterThan(35);
    expect(EVENTS.length).toBe(8);
    const { operations, events } = coverage();
    expect(OPS.filter((o) => !operations.has(o))).toEqual([]);
    expect(EVENTS.filter((e) => !events.has(e))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run red, then insert the complete contract blocks**

```bash
bun run test:contract
```

Expected red: `listAutomerge` is undeclared. Insert the following members between the existing
`merge` markers in `components.schemas`, `paths`, and `x-shepherd-events`, respectively.

```yaml
AutomationOverride:
  type: object
  additionalProperties: false
  required:
    - enabled
  properties:
    enabled:
      type:
        - boolean
        - "null"
      x-shepherd-explicit-null: true
MergeStep:
  type: object
  additionalProperties: true
  required:
    - id
    - text
    - postMerge
    - doneAt
  properties:
    id:
      type: string
    text:
      type: string
    postMerge:
      type: boolean
    doneAt:
      type:
        - integer
        - "null"
PostMergeSteps:
  type: object
  additionalProperties: true
  required:
    - sessionId
    - desig
    - repoPath
    - prNumber
    - prTitle
    - steps
    - trackingIssueUrl
    - trackingIssueNumber
    - createdAt
    - updatedAt
    - clearedAt
  properties:
    sessionId:
      type: string
    desig:
      type: string
    repoPath:
      type: string
    prNumber:
      type:
        - integer
        - "null"
    prTitle:
      type: string
    steps:
      type: array
      items:
        $ref: "#/components/schemas/MergeStep"
    trackingIssueUrl:
      type:
        - string
        - "null"
    trackingIssueNumber:
      type:
        - integer
        - "null"
    createdAt:
      type: integer
    updatedAt:
      type: integer
    clearedAt:
      type:
        - integer
        - "null"
ManualStepToggle:
  type: object
  additionalProperties: false
  required:
    - done
  properties:
    done:
      type: boolean
BuildStepStatus:
  type: string
  enum:
    - pending
    - active
    - done
    - skipped
  x-shepherd-open-enum: true
BuildStep:
  type: object
  additionalProperties: true
  required:
    - id
    - title
    - detail
    - status
    - position
  properties:
    id:
      type: string
    title:
      type: string
    detail:
      type: string
    status:
      $ref: "#/components/schemas/BuildStepStatus"
    position:
      type: integer
BuildStepInput:
  type: object
  additionalProperties: false
  required:
    - title
  properties:
    id:
      type: string
      minLength: 1
      maxLength: 200
    title:
      type: string
      minLength: 1
      maxLength: 200
    detail:
      type: string
      maxLength: 4000
    status:
      type: string
      enum:
        - pending
        - active
        - done
        - skipped
BuildQueue:
  type: object
  additionalProperties: true
  required:
    - sessionId
    - steps
    - approved
  properties:
    sessionId:
      type: string
    steps:
      type: array
      items:
        $ref: "#/components/schemas/BuildStep"
    approved:
      type: boolean
    approvalKind:
      type: string
BuildQueueMap:
  type: object
  additionalProperties:
    $ref: "#/components/schemas/BuildQueue"
BuildQueueWrite:
  type: object
  additionalProperties: false
  required:
    - steps
  properties:
    steps:
      type: array
      items:
        $ref: "#/components/schemas/BuildStepInput"
      maxItems: 100
DrainStatus:
  type: object
  additionalProperties: true
  required:
    - repoPath
    - enabled
    - paused
    - reason
    - detail
    - queued
    - inFlight
    - max
    - epicParent
  properties:
    repoPath:
      type: string
    enabled:
      type: boolean
    paused:
      type: boolean
    reason:
      type:
        - string
        - "null"
    detail:
      type:
        - string
        - "null"
    queued:
      type: integer
    inFlight:
      type: integer
    max:
      type: integer
    epicParent:
      type:
        - integer
        - "null"
DrainQueuedItem:
  type: object
  additionalProperties: true
  required:
    - number
    - title
    - url
  properties:
    number:
      type: integer
    title:
      type: string
    url:
      type: string
ClearMergedPreview:
  type: object
  additionalProperties: true
  required:
    - ids
    - leftovers
    - probesUnavailable
  properties:
    ids:
      type: array
      items:
        type: string
    leftovers:
      type: integer
    probesUnavailable:
      type: boolean
ClearMergedRequest:
  type: object
  additionalProperties: false
  required:
    - ids
  properties:
    ids:
      type: array
      items:
        type: string
ClearMergedResult:
  type: object
  additionalProperties: true
  required:
    - cleared
    - leftovers
  properties:
    cleared:
      type: array
      items:
        type: string
    leftovers:
      type: integer
SessionAutomergeEvent:
  type: object
  additionalProperties: true
  required:
    - id
    - enabled
  properties:
    id:
      type: string
    enabled:
      type:
        - boolean
        - "null"
SessionAutopilotEvent:
  type: object
  additionalProperties: true
  required:
    - id
    - paused
    - complete
  properties:
    id:
      type: string
    paused:
      type: boolean
    complete:
      type: boolean
    question:
      type:
        - string
        - "null"
    enabled:
      type:
        - boolean
        - "null"
SessionMergingEvent:
  type: object
  additionalProperties: true
  required:
    - id
    - since
    - trainId
  properties:
    id:
      type: string
    since:
      type:
        - integer
        - "null"
    trainId:
      type:
        - string
        - "null"
MergeTrainLandedEvent:
  type: object
  additionalProperties: true
  required:
    - repoPath
  properties:
    repoPath:
      type: string
PostMergeStepsChangedEvent:
  type: object
  additionalProperties: true
  properties: {}
MergeManualStep:
  type: object
  additionalProperties: true
  required:
    - id
    - text
    - postMerge
  properties:
    id:
      type: string
    text:
      type: string
    postMerge:
      type: boolean
SessionManualStepsEvent:
  type: object
  additionalProperties: true
  required:
    - id
    - manualSteps
  properties:
    id:
      type: string
    manualSteps:
      type: array
      items:
        $ref: "#/components/schemas/MergeManualStep"
    manualStepsAckedAt:
      type:
        - integer
        - "null"
AutomergeStatusList:
  type: array
  items:
    $ref: "#/components/schemas/AutoMergeStatus"
OutstandingManualSteps:
  type: array
  items:
    $ref: "#/components/schemas/PostMergeSteps"
DrainStatusList:
  type: array
  items:
    $ref: "#/components/schemas/DrainStatus"
DrainQueueList:
  type: array
  items:
    $ref: "#/components/schemas/DrainQueuedItem"
```

```yaml
/api/automerge:
  get:
    operationId: listAutomerge
    responses:
      "200":
        description: Success.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/AutomergeStatusList"
      "401":
        $ref: "#/components/responses/Unauthorized"
/api/sessions/{id}/autopilot:
  parameters:
    - name: id
      in: path
      required: true
      schema:
        type: string
  put:
    operationId: setSessionAutopilot
    requestBody:
      required: true
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/AutomationOverride"
    responses:
      "200":
        description: Success.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Session"
      "400":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
      "401":
        $ref: "#/components/responses/Unauthorized"
      "404":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
/api/sessions/{id}/automerge:
  parameters:
    - name: id
      in: path
      required: true
      schema:
        type: string
  put:
    operationId: setSessionAutomerge
    requestBody:
      required: true
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/AutomationOverride"
    responses:
      "200":
        description: Success.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Session"
      "400":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
      "401":
        $ref: "#/components/responses/Unauthorized"
      "404":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
/api/sessions/{id}/git/redeploy:
  parameters:
    - name: id
      in: path
      required: true
      schema:
        type: string
  post:
    operationId: redeploySession
    responses:
      "200":
        description: Success.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Ok"
      "400":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
      "401":
        $ref: "#/components/responses/Unauthorized"
      "404":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
      "502":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
/api/sessions/clear-merged:
  get:
    operationId: previewClearMerged
    responses:
      "200":
        description: Success.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/ClearMergedPreview"
      "401":
        $ref: "#/components/responses/Unauthorized"
  post:
    operationId: clearMergedSessions
    requestBody:
      required: true
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/ClearMergedRequest"
    responses:
      "200":
        description: Success.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/ClearMergedResult"
      "401":
        $ref: "#/components/responses/Unauthorized"
/api/manual-steps/outstanding:
  get:
    operationId: listOutstandingManualSteps
    responses:
      "200":
        description: Success.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/OutstandingManualSteps"
      "401":
        $ref: "#/components/responses/Unauthorized"
/api/manual-steps/{id}/steps/{stepId}:
  parameters:
    - name: id
      in: path
      required: true
      schema:
        type: string
    - name: stepId
      in: path
      required: true
      schema:
        type: string
  post:
    operationId: setManualStepDone
    requestBody:
      required: true
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/ManualStepToggle"
    responses:
      "200":
        description: Success.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/PostMergeSteps"
      "400":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
      "401":
        $ref: "#/components/responses/Unauthorized"
      "404":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
/api/manual-steps/{id}/dismiss:
  parameters:
    - name: id
      in: path
      required: true
      schema:
        type: string
  post:
    operationId: dismissManualSteps
    responses:
      "200":
        description: Success.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/PostMergeSteps"
      "401":
        $ref: "#/components/responses/Unauthorized"
      "404":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
/api/sessions/{id}/ack-manual-steps:
  parameters:
    - name: id
      in: path
      required: true
      schema:
        type: string
  post:
    operationId: ackManualSteps
    responses:
      "200":
        description: Success.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Ok"
      "401":
        $ref: "#/components/responses/Unauthorized"
      "404":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
/api/drain:
  get:
    operationId: listDrain
    responses:
      "200":
        description: Success.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/DrainStatusList"
      "401":
        $ref: "#/components/responses/Unauthorized"
/api/drain/queue:
  get:
    operationId: listDrainQueue
    parameters:
      - name: repo
        in: query
        required: true
        schema:
          type: string
    responses:
      "200":
        description: Success.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/DrainQueueList"
      "400":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
      "401":
        $ref: "#/components/responses/Unauthorized"
/api/queues:
  get:
    operationId: listBuildQueues
    responses:
      "200":
        description: Success.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/BuildQueueMap"
      "401":
        $ref: "#/components/responses/Unauthorized"
/api/sessions/{id}/queue:
  parameters:
    - name: id
      in: path
      required: true
      schema:
        type: string
  get:
    operationId: getBuildQueue
    responses:
      "200":
        description: Success.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/BuildQueue"
      "401":
        $ref: "#/components/responses/Unauthorized"
      "404":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
  put:
    operationId: putBuildQueue
    requestBody:
      required: true
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/BuildQueueWrite"
    responses:
      "200":
        description: Success.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/BuildQueue"
      "400":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
      "401":
        $ref: "#/components/responses/Unauthorized"
      "404":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
/api/sessions/{id}/queue/approve:
  parameters:
    - name: id
      in: path
      required: true
      schema:
        type: string
  post:
    operationId: approveBuildQueue
    responses:
      "200":
        description: Success.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/BuildQueue"
      "401":
        $ref: "#/components/responses/Unauthorized"
      "404":
        description: Handler refusal; see the verified status matrix.
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Error"
```

```yaml
session:automerge:
  schema:
    $ref: "#/components/schemas/SessionAutomergeEvent"
session:autopilot:
  schema:
    $ref: "#/components/schemas/SessionAutopilotEvent"
session:merging:
  schema:
    $ref: "#/components/schemas/SessionMergingEvent"
mergetrain:landed:
  schema:
    $ref: "#/components/schemas/MergeTrainLandedEvent"
post-merge-steps:changed:
  schema:
    $ref: "#/components/schemas/PostMergeStepsChangedEvent"
session:manual-steps:
  schema:
    $ref: "#/components/schemas/SessionManualStepsEvent"
queue:update:
  schema:
    $ref: "#/components/schemas/BuildQueue"
drain:status:
  schema:
    $ref: "#/components/schemas/DrainStatus"
```

- [ ] **Step 3: Run green, regenerate, and commit**

```bash
bun run test:contract && bun run typecheck && bun run gen:contract-swift
./native/scripts/sync-contract.sh && bun run check:contract-swift
./native/scripts/sync-contract.sh --check
git add contracts native/Sources/ShepherdKit/openapi.yaml test/contract/merge.test.ts test/contract/merge-fixtures.ts
git commit -m "feat(contract): merge automation and durable operator steps"
```

### Task 2: Wrap the generated operations

**Files:** `ShepherdClient+Merge.swift`, `ShepherdClientMergeTests.swift`.

**Interfaces:** consumes Task 1 generated operations and internal `generated`; produces thin async methods, generated typealiases and exact status mapping.

- [ ] **Step 1: Write transport assertions before the wrappers**

```swift
import Foundation
import Testing
@testable import ShepherdKit
struct ShepherdClientMergeTests {
    func client(_ server: FakeShepherdServer) throws -> ShepherdClient {
        let credentials = InMemoryCredentialStore()
        try credentials.save(.init(token: "shp_test", tokenId: "test"), for: "merge")
        return try ShepherdClient(profile: .init(name: "fake", baseURL: server.baseURL,
            mode: .local, credentialKey: "merge"), credentials: credentials,
            urlSession: server.urlSession())
    }
    @Test func explicitNullIsSentToInherit() async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.on("PUT", "/api/sessions/a/autopilot") { req in
            let data = try #require(req.body)
            let body = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            #expect(body["enabled"] is NSNull)
            return FakeResponse(body: try Fixtures.json(Fixtures.session(id: "a")))
        }
        _ = try await client(server).setSessionAutopilot(id: "a", body: .value(nil))
        #expect(server.requests().count == 1)
    }
    @Test func redeployFailureHasTheRealStatusMapping() async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.on("POST", "/api/sessions/a/git/redeploy") { _ in
            FakeResponse(statusCode: 400, body: Data(#"{"error":"no deploy workflow configured"}"#.utf8))
        }
        await #expect(throws: ShepherdError.badRequest("no deploy workflow configured")) {
            _ = try await client(server).redeploySession(id: "a")
        }
    }
    @Test func clearEmptyListCannotBecomeClearAll() async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.on("POST", "/api/sessions/clear-merged") { req in
            let data = try #require(req.body)
            let body = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            #expect(body["ids"] as? [String] == [])
            return FakeResponse(body: Data(#"{"cleared":[],"leftovers":0}"#.utf8))
        }
        let result = try await client(server).clearMergedSessions(body: .init(ids: []))
        #expect(result.cleared.isEmpty)
    }
}
```

```bash
swift test --package-path native --filter ShepherdClientMerge
git checkout -- native/Package.resolved
```

- [ ] **Step 2: Add the complete extension**

```swift
import Foundation
import OpenAPIRuntime

public typealias AutomationOverride = Components.Schemas.AutomationOverride
public typealias MergeStep = Components.Schemas.MergeStep
public typealias PostMergeSteps = Components.Schemas.PostMergeSteps
public typealias ManualStepToggle = Components.Schemas.ManualStepToggle
public typealias BuildStepStatus = Components.Schemas.BuildStepStatus
public typealias BuildStep = Components.Schemas.BuildStep
public typealias BuildStepInput = Components.Schemas.BuildStepInput
public typealias BuildQueue = Components.Schemas.BuildQueue
public typealias BuildQueueMap = Components.Schemas.BuildQueueMap
public typealias BuildQueueWrite = Components.Schemas.BuildQueueWrite
public typealias DrainStatus = Components.Schemas.DrainStatus
public typealias DrainQueuedItem = Components.Schemas.DrainQueuedItem
public typealias ClearMergedPreview = Components.Schemas.ClearMergedPreview
public typealias ClearMergedRequest = Components.Schemas.ClearMergedRequest
public typealias ClearMergedResult = Components.Schemas.ClearMergedResult
public typealias SessionAutomergeEvent = Components.Schemas.SessionAutomergeEvent
public typealias SessionAutopilotEvent = Components.Schemas.SessionAutopilotEvent
public typealias SessionMergingEvent = Components.Schemas.SessionMergingEvent
public typealias MergeTrainLandedEvent = Components.Schemas.MergeTrainLandedEvent
public typealias PostMergeStepsChangedEvent = Components.Schemas.PostMergeStepsChangedEvent
public typealias MergeManualStep = Components.Schemas.MergeManualStep
public typealias SessionManualStepsEvent = Components.Schemas.SessionManualStepsEvent
extension Components.Schemas.BuildStepStatus: OpenEnum {}
extension Components.Schemas.AutomationOverride {
    public static func value(_ enabled: Bool?) throws -> Self {
        .init(enabled: try OpenAPIValueContainer(unvalidatedValue: enabled))
    }
}

extension ShepherdClient {
    public func listAutomerge() async throws -> [Components.Schemas.AutoMergeStatus] {
        do {
            switch try await generated.listAutomerge(.init()) {
            case .ok(let ok): return try ok.body.json
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "listAutomerge")
            }
        } catch { throw ShepherdError.from(error, route: "listAutomerge") }
    }
    public func setSessionAutopilot(id: String, body: AutomationOverride) async throws -> Components.Schemas.Session {
        do {
            switch try await generated.setSessionAutopilot(.init(path: .init(id: id), body: .json(body))) {
            case .ok(let ok): return try ok.body.json
            case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .notFound: throw ShepherdError.notFound
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "setSessionAutopilot")
            }
        } catch { throw ShepherdError.from(error, route: "setSessionAutopilot") }
    }
    public func setSessionAutomerge(id: String, body: AutomationOverride) async throws -> Components.Schemas.Session {
        do {
            switch try await generated.setSessionAutomerge(.init(path: .init(id: id), body: .json(body))) {
            case .ok(let ok): return try ok.body.json
            case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .notFound: throw ShepherdError.notFound
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "setSessionAutomerge")
            }
        } catch { throw ShepherdError.from(error, route: "setSessionAutomerge") }
    }
    public func redeploySession(id: String) async throws -> Components.Schemas.Ok {
        do {
            switch try await generated.redeploySession(.init(path: .init(id: id))) {
            case .ok(let ok): return try ok.body.json
            case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .notFound: throw ShepherdError.notFound
            case .badGateway(let bad): throw ShepherdError.fromUpstream(try bad.body.json)
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "redeploySession")
            }
        } catch { throw ShepherdError.from(error, route: "redeploySession") }
    }
    public func previewClearMerged() async throws -> Components.Schemas.ClearMergedPreview {
        do {
            switch try await generated.previewClearMerged(.init()) {
            case .ok(let ok): return try ok.body.json
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "previewClearMerged")
            }
        } catch { throw ShepherdError.from(error, route: "previewClearMerged") }
    }
    public func clearMergedSessions(body: ClearMergedRequest) async throws -> Components.Schemas.ClearMergedResult {
        do {
            switch try await generated.clearMergedSessions(.init(body: .json(body))) {
            case .ok(let ok): return try ok.body.json
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "clearMergedSessions")
            }
        } catch { throw ShepherdError.from(error, route: "clearMergedSessions") }
    }
    public func listOutstandingManualSteps() async throws -> [Components.Schemas.PostMergeSteps] {
        do {
            switch try await generated.listOutstandingManualSteps(.init()) {
            case .ok(let ok): return try ok.body.json
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "listOutstandingManualSteps")
            }
        } catch { throw ShepherdError.from(error, route: "listOutstandingManualSteps") }
    }
    public func setManualStepDone(id: String, stepId: String, body: ManualStepToggle) async throws -> Components.Schemas.PostMergeSteps {
        do {
            switch try await generated.setManualStepDone(.init(path: .init(id: id, stepId: stepId), body: .json(body))) {
            case .ok(let ok): return try ok.body.json
            case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .notFound: throw ShepherdError.notFound
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "setManualStepDone")
            }
        } catch { throw ShepherdError.from(error, route: "setManualStepDone") }
    }
    public func dismissManualSteps(id: String) async throws -> Components.Schemas.PostMergeSteps {
        do {
            switch try await generated.dismissManualSteps(.init(path: .init(id: id))) {
            case .ok(let ok): return try ok.body.json
            case .unauthorized: throw ShepherdError.unauthenticated
            case .notFound: throw ShepherdError.notFound
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "dismissManualSteps")
            }
        } catch { throw ShepherdError.from(error, route: "dismissManualSteps") }
    }
    public func ackManualSteps(id: String) async throws -> Components.Schemas.Ok {
        do {
            switch try await generated.ackManualSteps(.init(path: .init(id: id))) {
            case .ok(let ok): return try ok.body.json
            case .unauthorized: throw ShepherdError.unauthenticated
            case .notFound: throw ShepherdError.notFound
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "ackManualSteps")
            }
        } catch { throw ShepherdError.from(error, route: "ackManualSteps") }
    }
    public func listDrain() async throws -> [Components.Schemas.DrainStatus] {
        do {
            switch try await generated.listDrain(.init()) {
            case .ok(let ok): return try ok.body.json
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "listDrain")
            }
        } catch { throw ShepherdError.from(error, route: "listDrain") }
    }
    public func listDrainQueue(repo: String) async throws -> [Components.Schemas.DrainQueuedItem] {
        do {
            switch try await generated.listDrainQueue(.init(query: .init(repo: repo))) {
            case .ok(let ok): return try ok.body.json
            case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "listDrainQueue")
            }
        } catch { throw ShepherdError.from(error, route: "listDrainQueue") }
    }
    public func listBuildQueues() async throws -> [String: BuildQueue] {
        do {
            switch try await generated.listBuildQueues(.init()) {
            case .ok(let ok): return try ok.body.json.additionalProperties
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "listBuildQueues")
            }
        } catch { throw ShepherdError.from(error, route: "listBuildQueues") }
    }
    public func getBuildQueue(id: String) async throws -> Components.Schemas.BuildQueue {
        do {
            switch try await generated.getBuildQueue(.init(path: .init(id: id))) {
            case .ok(let ok): return try ok.body.json
            case .unauthorized: throw ShepherdError.unauthenticated
            case .notFound: throw ShepherdError.notFound
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "getBuildQueue")
            }
        } catch { throw ShepherdError.from(error, route: "getBuildQueue") }
    }
    public func putBuildQueue(id: String, body: BuildQueueWrite) async throws -> Components.Schemas.BuildQueue {
        do {
            switch try await generated.putBuildQueue(.init(path: .init(id: id), body: .json(body))) {
            case .ok(let ok): return try ok.body.json
            case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .notFound: throw ShepherdError.notFound
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "putBuildQueue")
            }
        } catch { throw ShepherdError.from(error, route: "putBuildQueue") }
    }
    public func approveBuildQueue(id: String) async throws -> Components.Schemas.BuildQueue {
        do {
            switch try await generated.approveBuildQueue(.init(path: .init(id: id))) {
            case .ok(let ok): return try ok.body.json
            case .unauthorized: throw ShepherdError.unauthenticated
            case .notFound: throw ShepherdError.notFound
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "approveBuildQueue")
            }
        } catch { throw ShepherdError.from(error, route: "approveBuildQueue") }
    }
}
```

`AutomationOverride.enabled` is **required nullable**. The generated Swift optional currently
omits nil on encode, which sends `{}` and receives 400. The checked transport regression proves
that this is real. S0 must land this narrowly scoped derivation rule before the green gate; S9
cannot edit `scripts/gen-contract-swift.ts`. Insert it at the start of `transformSchema`:

```ts
if (node["x-shepherd-explicit-null"] === true) {
  const types = node.type;
  if (
    !nullableOk ||
    !Array.isArray(types) ||
    types.length !== 2 ||
    !types.includes("null") ||
    !types.some((t) => t === "boolean" || t === "string")
  ) {
    throw new Error(`invalid explicit-null scalar at ${pointer}`);
  }
  // Required opaque scalar in Swift, preserving JSON null rather than omitting it.
  // The truth schema still validates boolean|string-or-null, and stream factories are typed.
  return { description: "Required JSON scalar; use the stream's typed value factory." };
}
```

The required list stays intact because this flag is on a nullable **type array**, not a nullable
union. The generated field becomes `OpenAPIValueContainer`; the typed factory accepts only Bool?
and never hand-writes Codable or a request encoder. S12 reuses the same rule for explicit-null
reviewer/merger clearing. S0 adds this regression to its generator tests:

```ts
test("explicit null write scalars remain required opaque generated values", async () => {
  const input = `openapi: 3.1.0
info: {title: Fixture, version: '1'}
paths: {}
components:
  schemas:
    Override:
      type: object
      required: [enabled]
      properties:
        enabled:
          type: [boolean, 'null']
          x-shepherd-explicit-null: true
`;
  const result = Bun.YAML.parse(await deriveSwiftSpec(input)) as {
    components: {
      schemas: { Override: { required: string[]; properties: { enabled: { type?: unknown } } } };
    };
  };
  expect(result.components.schemas.Override.required).toEqual(["enabled"]);
  expect(result.components.schemas.Override.properties.enabled.type).toBeUndefined();
});
```

This is an S0 prerequisite with exact code, not permission to edit shared generator files from S9.

- [ ] **Step 3: Run green and commit**

```bash
swift test --package-path native --filter ShepherdClientMerge
git checkout -- native/Package.resolved
git add native/Sources/ShepherdKit/Client/ShepherdClient+Merge.swift native/Tests/ShepherdKitTests/ShepherdClientMergeTests.swift
git commit -m "feat(kit): merge automation operations"
```

### Task 3: Register every visible string

**Files:** `native/scripts/gen-strings.ts` (`KEYS_MERGE` only), EN/DE catalogs, generated `.xcstrings`, `Tests/MergeStringsTests.swift`.

**Interfaces:** consumes existing web message keys, S0 string generation; produces localized labels without hard-coded operator prose.

- [ ] **Step 1: Add a red catalog assertion**

```swift
import Testing
@testable import Shepherd
struct MergeStringsTests {
    @Test func nativeLabelsResolve() {
        #expect(L.t("native_merge_overview") != "native_merge_overview")
        #expect(L.t("mergeconfirm_review_block", "reviewer") != "mergeconfirm_review_block")
    }
}
```

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/MergeStringsTests
```

- [ ] **Step 2: Apply the complete EN/DE additions and owning key array**

```python
from pathlib import Path
import json, re
root = Path.cwd()
additions = {'native_merge_load_failed': ('Could not load merge state. Reconnect to retry.',
                              'Merge-Status konnte nicht geladen werden. Erneut verbinden.'),
 'native_merge_action_failed': ('The action failed. Refresh and try again.',
                                'Die Aktion ist fehlgeschlagen. Aktualisieren und erneut '
                                'versuchen.'),
 'native_merge_queue': ('Build queue', 'Build-Warteschlange'),
 'native_merge_remove': ('Remove', 'Entfernen'),
 'native_merge_step': ('Step title', 'Schritttitel'),
 'native_merge_step_detail': ('Step details', 'Schrittdetails'),
 'native_merge_add': ('Add step', 'Schritt hinzufügen'),
 'native_merge_approve': ('Approve queue', 'Warteschlange freigeben'),
 'native_merge_overview': ('Merge & automation', 'Merge & Automatisierung'),
 'native_merge_train': ('Start merge train', 'Merge-Train starten'),
 'native_merge_excluded': ('{count} PRs in other repositories excluded',
                           '{count} PRs in anderen Repositories ausgeschlossen'),
 'native_merge_train_warning': ('This starts an agent that can land the listed PRs, including '
                                'PRs owned by others.',
                                'Dies startet einen Agenten, der die aufgeführten PRs '
                                'einschließlich fremder PRs mergen kann.'),
 'native_merge_base': ('Target branch', 'Zielbranch'),
 'native_merge_autopilot': ('Autopilot', 'Autopilot'),
 'native_merge_automerge': ('Automatic merge', 'Automatischer Merge'),
 'native_merge_paused': ('Autopilot paused', 'Autopilot pausiert'),
 'native_merge_complete': ('Autopilot complete', 'Autopilot abgeschlossen'),
 'native_merge_method': ('Merge method', 'Merge-Methode'),
 'native_merge_delete_branch': ('Delete source branch', 'Quellbranch löschen'),
 'native_merge_redeploy': ('Redeploy', 'Erneut bereitstellen'),
 'native_merge_ack': ('I own the manual steps', 'Ich übernehme die manuellen Schritte'),
 'native_merge_inherit': ('Repository default', 'Repository-Standard'),
 'native_merge_off': ('Off', 'Aus'),
 'native_merge_on': ('On', 'An'),
 'native_merge_move_up': ('Move up', 'Nach oben'),
 'native_merge_move_down': ('Move down', 'Nach unten')}
for language, index in [("en", 0), ("de", 1)]:
    path = root / "ui/messages" / (language + ".json")
    catalog = json.loads(path.read_text())
    for key, values in additions.items():
        if key in catalog:
            assert catalog[key] == values[index], key
        else:
            catalog[key] = values[index]
    path.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n")
path = root / "native/scripts/gen-strings.ts"
source = path.read_text()
name = "KEYS_MERGE"
pattern = r"export const " + name + r": readonly string\[\] = \[[\s\S]*?\];"
assert len(re.findall(pattern, source)) == 1
other = re.sub(pattern, "", source)
owned = set(re.findall(r'"([a-z0-9_]+)"', other))
keys = ['buildqueue_start',
 'buildqueue_start_steer',
 'clearmerged_confirm',
 'clearmerged_leftovers',
 'clearmerged_probes_unavailable',
 'clearmerged_title',
 'common_cancel',
 'common_save',
 'herd_merge_train_prompt',
 'mergeconfirm_confirm',
 'native_merge_ack',
 'native_merge_action_failed',
 'native_merge_add',
 'native_merge_approve',
 'native_merge_automerge',
 'native_merge_autopilot',
 'native_merge_base',
 'native_merge_complete',
 'native_merge_delete_branch',
 'native_merge_excluded',
 'native_merge_inherit',
 'native_merge_load_failed',
 'native_merge_method',
 'native_merge_move_down',
 'native_merge_move_up',
 'native_merge_off',
 'native_merge_on',
 'native_merge_overview',
 'native_merge_paused',
 'native_merge_queue',
 'native_merge_redeploy',
 'native_merge_remove',
 'native_merge_step',
 'native_merge_step_detail',
 'mergeconfirm_handoff_reviewer',
 'mergeconfirm_handoff_merger',
 'mergeconfirm_review_block',
 'native_merge_train',
 'native_merge_train_warning',
 'owed_dismiss',
 'owed_dismiss_confirm',
 'owed_empty',
 'owed_post_merge_badge',
 'owed_title',
 'owed_tracking_issue']
for language in ["en", "de"]:
    catalog = json.loads((root / "ui/messages" / (language + ".json")).read_text())
    assert all(key in catalog for key in keys)
replacement = "export const " + name + ": readonly string[] = [\n" + "".join(
    "  " + json.dumps(key) + ",\n" for key in sorted(set(keys) - owned)
) + "];"
path.write_text(re.sub(pattern, lambda _: replacement, source))
```

- [ ] **Step 3: Regenerate, run green and commit**

```bash
bun native/scripts/gen-strings.ts
bun native/scripts/gen-strings.ts --check
./native/scripts/test-app.sh -only-testing:ShepherdTests/MergeStringsTests
git add native/scripts/gen-strings.ts ui/messages native/Apps/ShepherdMac/Resources/Localizable.xcstrings native/Apps/ShepherdMac/Tests/MergeStringsTests.swift
git commit -m "feat(mac): localize merge automation"
```

### Task 4: Port train, queue and owed rules

**Files:** `Sources/Merge/MergeRules.swift`, `Tests/MergeRulesTests.swift`.

**Interfaces:** consumes web `components/merge-train.ts`, `components/BuildQueuePanel.svelte`, `components/PostMergeStepsPanel.svelte`; produces pure decisions independently tested from views.

- [ ] **Step 1: Write the rule tests**

```swift
import Foundation
import Testing
import ShepherdKit
@testable import Shepherd
struct MergeRulesTests {
    func queue(_ statuses: [String], approved: Bool = true) throws -> BuildQueue {
        let rows = statuses.enumerated().map { ["id": String($0.offset), "title": "Step",
            "detail": "", "status": $0.element, "position": $0.offset] as [String: Any] }
        return try JSONDecoder().decode(BuildQueue.self, from: JSONSerialization.data(withJSONObject:
            ["sessionId": "a", "approved": approved, "steps": rows]))
    }
    @Test func trainPicksLargestRepoAndFirstSeenTie() {
        let a = MergeReadyPR(id: "a", number: 1, title: "A", url: "", repo: "/a")
        let b = MergeReadyPR(id: "b", number: 2, title: "B", url: "", repo: "/b")
        let c = MergeReadyPR(id: "c", number: 3, title: "C", url: "", repo: "/b")
        #expect(MergeRules.train([a,b]).repo == "/a")
        #expect(MergeRules.train([a,b,c]).prs == [b,c])
        #expect(MergeRules.train([a,b,c]).excluded == 1)
        #expect(MergeRules.train([]).repo == nil)
        let request = MergeRules.request(repo: "/b", base: "release", prs: [b,c])
        #expect(request.mergeTrainPrs == [2,3])
        #expect(request.planGateEnabled == false)
        #expect(request.autopilotEnabled == false)
        #expect(request.baseBranch == "release")
    }
    @Test func skippedResolvesButDoesNotRestart() throws {
        let q = try queue(["done","skipped","pending"])
        #expect(MergeRules.resolved(q) == 2)
        #expect(!MergeRules.canStart(q, status: "idle", planning: false, reviewBlocked: false, ended: false))
        let skipped = try queue(["skipped"])
        #expect(!MergeRules.canStart(skipped, status: "idle", planning: false, reviewBlocked: false, ended: false))
    }
    @Test func queueRulesCoverReviewAndDrift() throws {
        let q = try queue(["pending"])
        #expect(MergeRules.canStart(q, status: "blocked", planning: false, reviewBlocked: false, ended: false))
        #expect(!MergeRules.canStart(q, status: "running", planning: false, reviewBlocked: false, ended: false))
        #expect(!MergeRules.canStart(q, status: "idle", planning: true, reviewBlocked: true, ended: false))
        #expect(!MergeRules.drifted(q, planning: true, openPR: false))
        #expect(MergeRules.drifted(q, planning: true, openPR: true))
        let awaiting = try queue(["pending"], approved: false)
        #expect(MergeRules.canApprove(awaiting, status: "idle", planning: false, reviewBlocked: false, ended: false))
        #expect(!MergeRules.canApprove(awaiting, status: "archived", planning: false, reviewBlocked: false, ended: true))
    }
    @Test func readinessRequiresOpenNumberedUnreviewedPR() throws {
        var s = PreviewData.session(); s.readyToMerge = true
        let g = try JSONDecoder().decode(GitState.self, from: Data(#"{"state":"open","checks":"success","number":7,"deployConfigured":false}"#.utf8))
        #expect(MergeRules.ready([s], git: [s.id:g], reviewing: []).count == 1)
        #expect(MergeRules.ready([s], git: [s.id:g], reviewing: [s.id]).isEmpty)
        #expect(MergeRules.ready([s], git: [:], reviewing: []).isEmpty)
        s.readyToMerge = false
        #expect(MergeRules.ready([s], git: [s.id:g], reviewing: []).isEmpty)
    }
}
```

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/MergeRulesTests
```

- [ ] **Step 2: Implement the pure rules**

```swift
import Foundation
import ShepherdKit
struct MergeReadyPR: Identifiable, Equatable, Sendable {
    var id: String; var number: Int; var title: String; var url: String; var repo: String
}
enum MergeRules {
    static func ready(_ sessions: [Session], git: [String: GitState], reviewing: Set<String>) -> [MergeReadyPR] {
        sessions.compactMap { s in
            guard s.readyToMerge, !reviewing.contains(s.id), let g = git[s.id],
                g.state.known == .open, let number = g.number else { return nil }
            return .init(id: s.id, number: number, title: g.title ?? "", url: g.url ?? "", repo: s.repoPath)
        }
    }
    static func train(_ prs: [MergeReadyPR]) -> (repo: String?, prs: [MergeReadyPR], excluded: Int) {
        var order: [String] = []; var groups: [String: [MergeReadyPR]] = [:]
        for pr in prs {
            if groups[pr.repo] == nil { order.append(pr.repo) }
            groups[pr.repo, default: []].append(pr)
        }
        var best: String?
        for repo in order where groups[repo, default: []].count > groups[best ?? "", default: []].count { best = repo }
        let chosen = groups[best ?? "", default: []]
        return (best, chosen, prs.count - chosen.count)
    }
    static func request(repo: String, base: String, prs: [MergeReadyPR]) -> CreateSessionRequest {
        let lines = prs.map { pr in
            "- #\(pr.number)" + (pr.title.isEmpty ? "" : " \(pr.title)") + (pr.url.isEmpty ? "" : " — \(pr.url)")
        }.joined(separator: "\n")
        var request = CreateSessionRequest(repoPath: repo, baseBranch: base,
            prompt: L.t("herd_merge_train_prompt", lines))
        request.mergeTrainPrs = prs.map(\.number)
        request.planGateEnabled = false; request.autopilotEnabled = false
        return request
    }
    static func resolved(_ q: BuildQueue) -> Int {
        q.steps.filter { $0.status.known == .done || $0.status.known == .skipped }.count
    }
    static func drifted(_ q: BuildQueue, planning: Bool, openPR: Bool) -> Bool {
        q.approved && !q.steps.isEmpty && q.steps.allSatisfy { $0.status.known == .pending } && (!planning || openPR)
    }
    static func canApprove(_ q: BuildQueue, status: String, planning: Bool, reviewBlocked: Bool, ended: Bool) -> Bool {
        !q.approved && !q.steps.isEmpty && !(planning && reviewBlocked) && !ended && status != "archived"
    }
    static func canStart(_ q: BuildQueue, status: String, planning: Bool, reviewBlocked: Bool, ended: Bool) -> Bool {
        q.approved && !q.steps.isEmpty && q.steps.allSatisfy { $0.status.known == .pending || $0.status.known == .skipped }
        && resolved(q) < q.steps.count && !(planning && reviewBlocked) && !ended
        && ["idle", "blocked", "done"].contains(status)
    }
    static func owed(_ records: [PostMergeSteps], repos: Set<String>) -> [PostMergeSteps] {
        records.filter { $0.clearedAt == nil && (repos.isEmpty || repos.contains($0.repoPath)) }
    }
}
```

The 350 ms arm delay matches `merge-confirm.ts`. S7 owns the 24-hour stale-merging backstop;
S9 reads that classifier instead of starting a second expiry clock. Unknown queue status values
render neutrally and cannot be edited or started. Done and skipped both resolve progress.

- [ ] **Step 3: Run green and commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/MergeRulesTests
git add native/Apps/ShepherdMac/Sources/Merge/MergeRules.swift native/Apps/ShepherdMac/Tests/MergeRulesTests.swift
git commit -m "feat(mac): port merge and queue rules"
```

### Task 5: Keep merge state activation-scoped

**Files:** `Sources/Merge/MergeModel.swift`, `Tests/MergeModelTests.swift`.

**Interfaces:** consumes store multicast events, activation generation, injected reads; produces one model, coalesced snapshots, finite watcher lifetime, durable owed counts.

- [ ] **Step 1: Write deterministic teardown and prune tests**

```swift
import Foundation
import Testing
import ShepherdKit
@testable import Shepherd
actor MergeLatch {
    private var continuation: CheckedContinuation<MergeSnapshot, Never>?
    private(set) var waiting = false
    private(set) var calls = 0
    func read() async -> MergeSnapshot {
        await withCheckedContinuation { continuation = $0; waiting = true; calls += 1 }
    }
    func release(_ value: MergeSnapshot) { continuation?.resume(returning: value); continuation = nil; waiting = false }
}
@Suite(.serialized) @MainActor struct MergeModelTests {
    @Test func lateReadAfterTeardownCannotPublish() async {
        let latch = MergeLatch()
        let model = MergeModel(reads: .init(snapshot: { await latch.read() }))
        let pending = Task { await model.refresh() }
        while !(await latch.waiting) { await Task.yield() }
        model.teardown()
        await latch.release(.init())
        await pending.value
        #expect(!model.settled)
        #expect(!model.busy)
    }
    @Test func eventDuringSnapshotForcesAnotherReadWithoutPublishingOldData() async {
        let latch = MergeLatch()
        let model = MergeModel(reads:.init(snapshot:{await latch.read()}))
        let loading = Task {await model.refresh()}
        while await latch.calls < 1 {await Task.yield()}
        model.invalidate()
        await latch.release(.init())
        while await latch.calls < 2 {await Task.yield()}
        #expect(!model.settled)
        model.teardown(); await latch.release(.init()); await loading.value
        #expect(!model.settled)
    }
    @Test func pruneDropsQueuesButPreservesFrozenOwed() async throws {
        let owed = try JSONDecoder().decode(PostMergeSteps.self, from: Data(#"{"sessionId":"gone","desig":"TASK-1","repoPath":"/a","prNumber":7,"prTitle":"Ship","steps":[{"id":"one","text":"Check","postMerge":true,"doneAt":null}],"trackingIssueUrl":null,"trackingIssueNumber":null,"createdAt":1,"updatedAt":1,"clearedAt":null}"#.utf8))
        let queue = try JSONDecoder().decode(BuildQueue.self, from: Data(#"{"sessionId":"gone","steps":[],"approved":false}"#.utf8))
        let model = MergeModel(reads: .init(snapshot: { .init(queues: ["gone":queue], owed:[owed]) }))
        await model.refresh(); model.prune(liveIDs: [])
        #expect(model.snapshot.queues.isEmpty)
        #expect(model.outstanding == ["gone":1])
        #expect(MergeRules.owed(model.snapshot.owed, repos: ["/b"]).isEmpty)
        model.teardown()
    }
    @Test func externalAutomationFramesRefreshSessionRows() async {
        var rowsRead = 0
        let model = MergeModel(reads: .init(snapshot: { .init() }, sessionRows: { rowsRead += 1 }))
        defer { model.teardown() }
        for name in ["session:autopilot", "session:automerge", "session:manual-steps", "session:merging"] {
            let previous = rowsRead
            model.receive(name: name)
            while rowsRead == previous { await Task.yield() }
            #expect(rowsRead > previous)
        }
        model.teardown()
        let stoppedAt = rowsRead
        model.receive(name: "session:autopilot")
        await model.refresh()
        #expect(rowsRead == stoppedAt)
    }
    @Test func registrationNeverTouchesKeychain() {
        let suite = "MergeModelTests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
        app.register(MergeModel.self); app.register(MergeModel.self)
        #expect(app.extensionFactories.count == 1)
        #expect(app.extension(MergeModel.self) == nil)
        app.teardown()
    }
}
```

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/MergeModelTests
```

- [ ] **Step 2: Implement the complete model**

```swift
import Foundation
import Observation
import ShepherdKit

struct MergeSnapshot: Sendable {
    var automation: [Components.Schemas.AutoMergeStatus] = []
    var drain: [DrainStatus] = []
    var queues: [String: BuildQueue] = [:]
    var owed: [PostMergeSteps] = []
}
struct MergeReads: Sendable {
    var snapshot: @Sendable () async throws -> MergeSnapshot
    var sessionRows: @MainActor @Sendable () async throws -> Void = {}
    @MainActor static func live(_ store: SessionStore) -> Self {
        let client = store.client
        return .init(snapshot: {
            async let auto = client.listAutomerge()
            async let drain = client.listDrain()
            async let queues = client.listBuildQueues()
            async let owed = client.listOutstandingManualSteps()
            return try await MergeSnapshot(automation: auto, drain: drain, queues: queues, owed: owed)
        }, sessionRows: { try await store.refresh() })
    }
}
@Observable @MainActor
final class MergeModel: AppExtension {
    private(set) var snapshot = MergeSnapshot()
    private(set) var error: String?
    private(set) var busy = false
    private(set) var settled = false
    private(set) var watching = false
    var showOverview = false
    @ObservationIgnored private let reads: MergeReads
    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private weak var store: SessionStore?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var revision = 0
    @ObservationIgnored private var stopped = false
    @ObservationIgnored private var refreshing = false
    @ObservationIgnored private var pending = false
    @ObservationIgnored private var eventTask: Task<Void, Never>?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var watchTask: Task<Void, Never>?
    @ObservationIgnored private var writeTask: Task<Void, Never>?
    @ObservationIgnored private var wake: AsyncStream<Void>.Continuation?

    init(reads: MergeReads) { self.reads = reads }
    init(store: SessionStore, app: AppModel) {
        self.store = store; self.app = app; self.reads = .live(store)
        let mine = generation
        let activation = app.activationGeneration
        // Subscribe before scheduling the bootstrap. Buffered old frames are generation-guarded.
        eventTask = Task { [weak self, weak store] in
            guard let store else { return }
            for await event in store.events() {
                guard let self, self.valid(mine, activation), !Task.isCancelled else { return }
                switch event {
                case .automergeStatus, .sessionNew, .sessionArchived, .sessionStatus:
                    self.invalidate()
                case .unknown(let name, _):
                    self.receive(name: name)
                default: break
                }
            }
        }
        let (stream, signal) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        wake = signal
        watchTask = Task { [weak self, weak store] in
            guard let store else { return }
            self?.watching = true
            defer { self?.watching = false }
            var iterator = stream.makeAsyncIterator()
            var wasLive = false
            while let self, self.valid(mine, activation), !Task.isCancelled {
                let state = withObservationTracking {
                    (store.connection, Set(store.sessions.map(\.id)))
                } onChange: { signal.yield(()) }
                self.prune(liveIDs: state.1)
                let live = state.0 == .live
                if live && !wasLive { self.invalidate() }
                wasLive = live
                guard await iterator.next() != nil else { return }
            }
        }
        invalidate()
    }
    static let refreshEvents: Set<String> = ["session:automerge", "session:autopilot",
        "session:merging", "mergetrain:landed", "post-merge-steps:changed",
        "session:manual-steps", "queue:update", "drain:status"]
    private func valid(_ mine: Int, _ activation: Int?) -> Bool {
        !stopped && mine == generation && activation == app?.activationGeneration
    }
    func receive(name: String) {
        guard Self.refreshEvents.contains(name) else { return }
        invalidate()
    }
    func invalidate() {
        guard !stopped else { return }
        revision &+= 1
        pending = true
        guard !refreshing else { return }
        refreshTask = Task { [weak self] in await self?.refresh() }
    }
    func refresh() async {
        guard !stopped else { return }
        if refreshing { pending = true; return }
        refreshing = true
        let mine = generation, activation = app?.activationGeneration
        defer { refreshing = false }
        repeat {
            pending = false
            let started = revision
            do {
                // SessionStore ignores these frames. Refresh its session rows too, so another
                // client's autopilot/ack change and merge-train progress reach the controls.
                try await reads.sessionRows()
                guard valid(mine, activation), !Task.isCancelled else { return }
                let value = try await reads.snapshot()
                guard valid(mine, activation), !Task.isCancelled else { return }
                // A frame during the GET makes the snapshot suspect. Re-read, don't overwrite it.
                if started != revision { pending = true; continue }
                snapshot = value
                if let store { prune(liveIDs: Set(store.sessions.map(\.id))) }
                error = nil; settled = true
            } catch {
                guard valid(mine, activation), !Task.isCancelled else { return }
                self.error = L.t("native_merge_load_failed"); settled = true
            }
        } while pending && !stopped
    }
    func prune(liveIDs: Set<String>) {
        snapshot.queues = snapshot.queues.filter { liveIDs.contains($0.key) }
        // Owed records deliberately survive archive AND physical session pruning.
        // Automation/drain are repo-keyed, not session-keyed; replace them on full refresh.
    }
    var outstanding: [String: Int] {
        Dictionary(uniqueKeysWithValues: snapshot.owed.filter { $0.clearedAt == nil }.map {
            ($0.sessionId, $0.steps.filter { $0.doneAt == nil }.count)
        })
    }
    func perform<Value: Sendable>(
        commit: @escaping @MainActor (Value) -> Void = { _ in },
        failure: @escaping @MainActor () -> Void = {},
        _ action: @escaping @MainActor () async throws -> Value
    ) {
        guard !busy, !stopped else { return }
        busy = true; error = nil
        let mine = generation, activation = app?.activationGeneration
        writeTask = Task { [weak self] in
            do {
                let value = try await action()
                guard let self, self.valid(mine, activation), !Task.isCancelled else { return }
                commit(value); self.busy = false; self.invalidate()
            } catch {
                guard let self, self.valid(mine, activation), !Task.isCancelled else { return }
                self.busy = false
                self.error = ShepherdErrorCopy.message(error)
                failure()
            }
        }
    }
    func teardown() {
        guard !stopped else { return }
        stopped = true; generation &+= 1; revision &+= 1
        wake?.finish(); wake = nil
        eventTask?.cancel(); watchTask?.cancel(); refreshTask?.cancel(); writeTask?.cancel()
        eventTask = nil; watchTask = nil; refreshTask = nil; writeTask = nil
        store = nil; app = nil; busy = false; pending = false
    }
}
```

The stream refreshes authoritative snapshots and SessionStore rows for its eight unknown frames; it does not modify
`EventName` or start a second socket. The observation continuation is retained and **finished** in
teardown so a suspended iterator exits. Views are keyed by activation generation, including sheet
content, preventing local preview state from appearing under a newly selected profile. HTTP
cancellation cannot undo an already accepted write; success still needs a generation guard.

- [ ] **Step 3: Run green and commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/MergeModelTests
git add native/Apps/ShepherdMac/Sources/Merge/MergeModel.swift native/Apps/ShepherdMac/Tests/MergeModelTests.swift
git commit -m "feat(mac): activation-safe merge snapshots"
```

### Task 6: Render durable owed steps

**Files:** `Sources/Merge/MergeOwedView.swift`, `Tests/MergeOwedTests.swift`.

**Interfaces:** consumes Task 5 durable records, S10 owed lens via S0; produces post-merge tick/untick, dismiss, tracking issue and repo filtering.

- [ ] **Step 1: Test the frozen-record rule before the view**

```swift
import Testing
@testable import Shepherd
@MainActor struct MergeOwedTests {
    @Test func owedIsNotLimitedToCurrentSessions() {
        #expect(MergeRules.owed([], repos: []).isEmpty)
        #expect(MergeModel.refreshEvents.contains("post-merge-steps:changed"))
        #expect(MergeModel.refreshEvents.contains("session:manual-steps"))
    }
}
```

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/MergeOwedTests
```

- [ ] **Step 2: Add the complete owed view**

```swift
import SwiftUI
import ShepherdKit

struct MergeOwedView: View {
    let model: MergeModel
    let client: ShepherdClient
    var repos: Set<String> = []
    @State private var dismissID: String?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(L.t("owed_title")).font(.headline)
                if !model.settled { ProgressView() }
                if let error = model.error { Text(verbatim: error).foregroundStyle(.red) }
                ForEach(MergeRules.owed(model.snapshot.owed, repos: repos), id: \.sessionId) { record in
                    GroupBox {
                        VStack(alignment: .leading) {
                            Text(verbatim: "\(record.desig) · \(record.repoPath) · \(record.prTitle)")
                            if let raw = record.trackingIssueUrl, let url = URL(string: raw),
                                ["http", "https"].contains(url.scheme ?? "") {
                                Link(L.t("owed_tracking_issue"), destination: url)
                            }
                            ForEach(record.steps, id: \.id) { step in
                                Toggle(isOn: Binding(get: { step.doneAt != nil }, set: { done in
                                    model.perform { _ = try await client.setManualStepDone(
                                        id: record.sessionId, stepId: step.id, body: .init(done: done)) }
                                })) {
                                    HStack {
                                        if step.postMerge { Text(L.t("owed_post_merge_badge")) }
                                        Text(verbatim: step.text).strikethrough(step.doneAt != nil)
                                    }
                                }.disabled(model.busy)
                            }
                            Button(L.t("owed_dismiss")) { dismissID = record.sessionId }
                        }
                    }
                }
                if model.settled && model.error == nil && MergeRules.owed(model.snapshot.owed, repos: repos).isEmpty {
                    Text(L.t("owed_empty"))
                }
            }.padding()
        }
        .confirmationDialog(L.t("owed_dismiss_confirm"), isPresented: Binding(
            get: { dismissID != nil }, set: { if !$0 { dismissID = nil } })) {
                Button(L.t("owed_dismiss"), role: .destructive) {
                    guard let id = dismissID else { return }
                    dismissID = nil
                    model.perform { _ = try await client.dismissManualSteps(id: id) }
                }
        }
        .accessibilityIdentifier("merge-owed")
    }
}
```

The archived/pruned fixture in Task 5 is the substantive owed regression. The web's durable
outstanding endpoint is authoritative; do not filter by the live session list. A dismissed record
and a record whose final step was checked disappear on the next snapshot. The pre-merge ownership
acknowledgement remains a separate button in Task 7. The native panel labels steps with plain text;
it never interprets an operator instruction as an action to execute automatically.

- [ ] **Step 3: Run green and commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/MergeOwedTests -only-testing:ShepherdTests/MergeModelTests
git add native/Apps/ShepherdMac/Sources/Merge/MergeOwedView.swift native/Apps/ShepherdMac/Tests/MergeOwedTests.swift
git commit -m "feat(mac): durable owed manual steps"
```

### S0 prerequisite for Task 7: complete the existing manual-merge contract

**Blocking for Task 7 and S9 acceptance; independent Tasks 1–6 may proceed.** This is S0's
integration work under the master's shared-file protocol, because `GitState`, `MergePrBody`,
`POST /api/sessions/{id}/git/merge` and `ShepherdClient+Detail.swift` already belong to S2.
It is not another approved core-path exception for S9. Keep that path in `detail`, with its
existing 200/401/404/409/502 statuses and its existing Error response mapping. Do not put a
second merge operation or a second GitState in `merge`. S0 lands this before S9 rebases for Task 7.

S0 appends these two schemas in **detail**, reusing S0-prep-2's already merged `PrHandoff`
read-side open enum (S7 supplies its OpenEnum conformance before S9 merges):

```yaml
MergeResponsibility:
  type: object
  additionalProperties: true
  properties:
    handoff:
      $ref: "#/components/schemas/PrHandoff"
    handoffWho: { type: string }
    reviewBlockBy: { type: string }
MergeConfirmation:
  type: object
  additionalProperties: false
  properties:
    headSha: { type: [string, "null"] }
    baseRefName: { type: [string, "null"] }
    handoff: { type: [string, "null"], enum: [reviewer, merger, null] }
    handoffWho: { type: [string, "null"] }
    reviewBlockBy: { type: [string, "null"] }
```

S0 adds the following optional members to `GitState.properties`; `headSha` already exists
from S0-prep-2 and must not be added twice:

```yaml
baseRefName: { type: string }
mergeGate:
  $ref: "#/components/schemas/MergeResponsibility"
```

And this member to `MergePrBody.properties`:

```yaml
confirm:
  $ref: "#/components/schemas/MergeConfirmation"
```

`parseMergeConfirm` treats absent scalar members exactly like null, so these optional fields do
not need the explicit-null generator flag. Update `MergePrBody.description` to describe the
optional confirmation. Regenerate and sync before changing the wrapper. In S0's
`ShepherdClient+Detail.swift`, replace only the `mergePR` signature and generated-body expression:

```swift
public func mergePR(
    sessionID: String, method: MergeMethod?, deleteBranch: Bool?,
    confirm: Components.Schemas.MergeConfirmation? = nil
) async throws -> GitState
// Keep the existing function body/status handling; replace its request body argument with:
body: .json(.init(method: method, deleteBranch: deleteBranch, confirm: confirm))
```

The default preserves S2 callers and tests. S0 adds this test **before** the coverage gate in
`test/contract/detail.test.ts`, using that file's real `post`, `ok`, `fx.makeForge` and harness
helpers. Missing and stale confirmations must not invoke the forge. These are additional cases
of already declared statuses, not a new S9 coverage exemption.

```ts
test("manual merge confirms the displayed revision and configured responsibility", async () => {
  const savedForge = s.deps.resolveForge,
    savedRoles = s.deps.readRoles;
  const savedGit = s.stubs.prCache.rows[ok];
  const calls: { number: number; options: unknown }[] = [];
  const current = {
    state: "open",
    checks: "success",
    number: 12,
    deployConfigured: false,
    headSha: "head-a",
    baseRefName: "release",
  };
  s.deps.readRoles = () => ({ reviewer: null, merger: "owner" });
  s.deps.resolveForge = () =>
    fx.makeForge({
      currentUser: async () => "operator",
      prStatus: async () => current,
      merge: async (number: number, options: unknown) => {
        calls.push({ number, options });
      },
    });
  const template = "/api/sessions/{id}/git/merge";
  const invoke = async (confirm?: unknown) => {
    const res = await post(`/api/sessions/${ok}/git/merge`, { confirm });
    const body = await validateResponse("POST", template, res);
    return { status: res.status, body };
  };
  try {
    const missing = await invoke();
    expect(missing.status).toBe(409);
    expect(missing.body).toMatchObject({ code: "merge_confirm_required" });
    const confirmed = {
      headSha: "head-a",
      baseRefName: "release",
      handoff: "merger",
      handoffWho: "owner",
      reviewBlockBy: null,
    };
    const stale = await invoke({ ...confirmed, headSha: "head-old" });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "merge_confirm_stale" });
    expect(calls).toEqual([]);
    expect((await invoke(confirmed)).status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ number: 12, options: { expectedHeadSha: "head-a" } });
  } finally {
    s.deps.resolveForge = savedForge;
    s.deps.readRoles = savedRoles;
    if (savedGit === undefined) delete s.stubs.prCache.rows[ok];
    else s.stubs.prCache.rows[ok] = savedGit;
  }
});
```

S9 creates `Sources/Merge/MergeConfirmationRules.swift`:

```swift
import ShepherdKit

enum MergeConfirmationRules {
    static func payload(_ git: GitState) -> Components.Schemas.MergeConfirmation {
        .init(headSha: git.headSha, baseRefName: git.baseRefName,
            handoff: git.mergeGate?.handoff.flatMap { .init(rawValue: $0.rawValue) },
            handoffWho: git.mergeGate?.handoffWho, reviewBlockBy: git.mergeGate?.reviewBlockBy)
    }
}
```

Add this substantive case to `MergeRulesTests` and the transport case to
`ShepherdClientMergeTests` after rebasing onto the S0 prerequisite:

```swift
@Test func confirmationUsesGateAndActualTargetRatherThanHerdHandoff() throws {
    let git = try JSONDecoder().decode(GitState.self, from: Data(#"{"state":"open","checks":"pending","number":7,"deployConfigured":false,"headSha":"head-a","baseRefName":"release","handoff":"reviewer","handoffWho":"wrong","mergeGate":{"handoff":"merger","handoffWho":"owner","reviewBlockBy":"reviewer"}}"#.utf8))
    let confirm = MergeConfirmationRules.payload(git)
    #expect(confirm.headSha == "head-a")
    #expect(confirm.baseRefName == "release")
    #expect(confirm.handoff?.rawValue == "merger")
    #expect(confirm.handoffWho == "owner")
    #expect(confirm.reviewBlockBy == "reviewer")
}
```

```swift
@Test func mergeCarriesTheConfirmedRevisionAndResponsibility() async throws {
    let server = FakeShepherdServer(); defer { server.tearDown() }
    server.on("POST", "/api/sessions/a/git/merge") { request in
        let data = try #require(request.body)
        let body = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let confirm = try #require(body["confirm"] as? [String: Any])
        #expect(confirm["headSha"] as? String == "head-a")
        #expect(confirm["baseRefName"] as? String == "release")
        #expect(confirm["handoffWho"] as? String == "owner")
        return FakeResponse(body: Data(#"{"state":"merged","checks":"success","deployConfigured":false}"#.utf8))
    }
    let result = try await client(server).mergePR(sessionID: "a", method: .squash,
        deleteBranch: false, confirm: .init(headSha: "head-a", baseRefName: "release",
            handoff: .merger, handoffWho: "owner"))
    #expect(result.state.known == .merged)
    #expect(server.requests().count == 1)
}
```

```bash
bun run test:contract
bun run gen:contract-swift && ./native/scripts/sync-contract.sh
swift test --package-path native --filter ShepherdClientMerge
./native/scripts/test-app.sh -only-testing:ShepherdTests/MergeRulesTests
git checkout -- native/Package.resolved
```

### Task 7: Add session automation and guarded merge actions

**Files:** `Sources/Merge/MergeSessionView.swift`, `MergeConfirmationRules.swift`; extend Task 2/4 tests as above.

**Interfaces:** consumes the S0-extended S2 merge wrapper, generated tri-state settings, Task 2 transport tests; produces AppKit-free merge detail view without a toolbar.

- [ ] **Step 1: Run the refusal and explicit-null tests red if the view wiring changes the payload**

```bash
swift test --package-path native --filter ShepherdClientMerge
```

- [ ] **Step 2: Build the session view**

```swift
import SwiftUI
import ShepherdKit

struct MergeSessionView: View {
    let app: AppModel
    let session: Session
    let store: SessionStore
    let model: MergeModel
    @State private var method: MergeMethod = .squash
    @State private var deleteBranch = true
    @State private var confirm = false
    @State private var candidate: GitState?
    @State private var redeploy = false
    @State private var armed = false
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(verbatim: session.name).font(.headline)
            if let error = model.error { Text(verbatim: error).foregroundStyle(.red) }
            automation(L.t("native_merge_autopilot"), value: session.autopilotEnabled) { value in
                model.perform { _ = try await store.client.setSessionAutopilot(id: session.id, body: .value(value)) }
            }
            automation(L.t("native_merge_automerge"), value: session.autoMergeEnabled) { value in
                model.perform { _ = try await store.client.setSessionAutomerge(id: session.id, body: .value(value)) }
            }
            if session.autopilotPaused { Text(L.t("native_merge_paused")) }
            if session.autopilotComplete { Text(L.t("native_merge_complete")) }
            Picker(L.t("native_merge_method"), selection: $method) {
                Text(verbatim: "squash").tag(MergeMethod.squash)
                Text(verbatim: "merge").tag(MergeMethod.merge)
                Text(verbatim: "rebase").tag(MergeMethod.rebase)
            }
            Toggle(L.t("native_merge_delete_branch"), isOn: $deleteBranch)
            Button(L.t("mergeconfirm_confirm")) {
                candidate = nil; armed = false
                model.perform(commit: { git in
                    guard let git, git.state.known == .open, git.number != nil else { return }
                    candidate = git; confirm = true
                }) { try await store.client.git(sessionID: session.id) }
            }
            Button(L.t("native_merge_redeploy")) { redeploy = true }
            ForEach(session.manualSteps, id: \.id) { step in
                Text(verbatim: step.text)
            }
            Button(L.t("native_merge_ack")) {
                model.perform { _ = try await store.client.ackManualSteps(id: session.id) }
            }.disabled(session.manualSteps.isEmpty)
            // The bulk endpoint omits sessions without a persisted queue. Offer their empty
            // editor too; otherwise the first step could never be created from the native app.
            let q = model.snapshot.queues[session.id]
                ?? BuildQueue(sessionId: session.id, steps: [], approved: false)
            MergeQueueView(app: app, queue: q, session: session, store: store, model: model)
        }
        .padding().disabled(model.busy)
        .sheet(isPresented: $confirm) {
            VStack(alignment: .leading, spacing: 12) {
                Text(verbatim: "#\(candidate?.number ?? 0) \(candidate?.title ?? session.name)")
                Text(verbatim: candidate?.baseRefName ?? "—")
                Text(verbatim: candidate?.headSha ?? "—")
                Text(verbatim: method.rawValue)
                if let gate = candidate?.mergeGate {
                    if let who = gate.handoffWho {
                        Text(gate.handoff?.known == .reviewer
                            ? L.t("mergeconfirm_handoff_reviewer", who)
                            : L.t("mergeconfirm_handoff_merger", who))
                    }
                    if let reviewer = gate.reviewBlockBy { Text(L.t("mergeconfirm_review_block", reviewer)) }
                }
                Toggle(L.t("native_merge_delete_branch"), isOn: $deleteBranch)
                if let error = model.error { Text(verbatim: error).foregroundStyle(.red) }
                HStack {
                    Button(L.t("common_cancel")) { confirm = false }.keyboardShortcut(.cancelAction)
                    Button(L.t("mergeconfirm_confirm")) {
                        guard armed, !model.busy, let candidate,
                            candidate.mergeGate?.handoff == nil || candidate.mergeGate?.handoff?.known != nil else { return }
                        let payload = MergeConfirmationRules.payload(candidate)
                        armed = false
                        model.perform(commit: { _ in confirm = false; self.candidate = nil },
                            failure: { confirm = false; self.candidate = nil }) {
                            try await store.client.mergePR(sessionID: session.id,
                                method: method, deleteBranch: deleteBranch, confirm: payload)
                        }
                    }.disabled(!armed || model.busy || candidate == nil
                        || (candidate?.mergeGate?.handoff != nil && candidate?.mergeGate?.handoff?.known == nil))
                }
            }.padding().task {
                armed = false
                do { try await Task.sleep(for: .milliseconds(350)); armed = true }
                catch { armed = false }
            }
        }
        .confirmationDialog(L.t("native_merge_redeploy"), isPresented: $redeploy) {
            Button(L.t("native_merge_redeploy")) {
                model.perform { _ = try await store.client.redeploySession(id: session.id) }
            }
        }
        .accessibilityIdentifier("detail-tab-merge")
    }
    private func automation(_ title: String, value: Bool?, change: @escaping (Bool?) -> Void) -> some View {
        Picker(title, selection: Binding(get: { value.map { $0 ? 1 : 0 } ?? -1 }, set: {
            change($0 == -1 ? nil : $0 == 1)
        })) {
            Text(L.t("native_merge_inherit")).tag(-1)
            Text(L.t("native_merge_off")).tag(0)
            Text(L.t("native_merge_on")).tag(1)
        }
    }
}
```

Compare manually in the isolated fixture app: inherited/false/true each select distinctly;
paused and complete remain distinct labels; Escape cancels; clicking during the 350 ms arm period
sends nothing; the dialog names the actual PR target (not the session's original base branch),
revision and responsible people. A 409 discards the spent confirmation and shows the failure in
its parent; reopening performs a fresh GET and arms for another 350 ms. Never retry automatically.
The view identity includes both activation and session ID, so switching sessions closes all
pending confirmations. The server remains
the authority on readiness. A successful request is followed by store/snapshot refresh, not an
optimistic local PR state. Never add `.toolbar` to this view or its children.

- [ ] **Step 3: Build, run rule/transport regressions and commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/MergeRulesTests
swift test --package-path native --filter ShepherdClientMerge
git checkout -- native/Package.resolved
git add native/Apps/ShepherdMac/Sources/Merge/MergeSessionView.swift native/Apps/ShepherdMac/Sources/Merge/MergeConfirmationRules.swift native/Apps/ShepherdMac/Tests/MergeRulesTests.swift native/Tests/ShepherdKitTests/ShepherdClientMergeTests.swift
git commit -m "feat(mac): session merge and automation controls"
```

### Task 8: Add trains, drain backlog, build queue and clear-merged

**Files:** `Sources/Merge/MergePanels.swift`.

**Interfaces:** consumes Task 4 rules, S1 reply, S0 train request fields, read-only drain snapshots; produces overview, explicit train and clear confirmations, stable-ID queue editor.

- [ ] **Step 1: Run queue/selection regressions before rendering**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/MergeRulesTests
swift test --package-path native --filter ShepherdClientMerge
```

- [ ] **Step 2: Implement the panels**

```swift
import SwiftUI
import ShepherdKit

@MainActor enum MergeInputs {
    static var git: (AppModel) -> [String: GitState] = { _ in [:] }
    static var reviewing: (AppModel, String) -> Bool = { _, _ in false }
    static var planReviewBlocked: (AppModel, String) -> Bool = { _, _ in true }
    static var terminalEnded: (AppModel, String) -> Bool = { _, _ in true }
}
struct MergeQueueView: View {
    let app: AppModel
    let queue: BuildQueue
    let session: Session
    let store: SessionStore
    let model: MergeModel
    @State private var title = ""
    private var planning: Bool { session.planPhase?.rawValue == "planning" }
    private var ended: Bool { session.status.known == .archived || MergeInputs.terminalEnded(app, session.id) }
    var body: some View {
        GroupBox(L.t("native_merge_queue")) {
            VStack(alignment: .leading) {
                // Skipped resolves progress but never earns the green done glyph.
                ProgressView(value: Double(MergeRules.resolved(queue)), total: Double(max(1, queue.steps.count)))
                ForEach(queue.steps, id: \.id) { step in
                    HStack {
                        Image(systemName: step.status.known == .done ? "checkmark.circle" :
                            step.status.known == .skipped ? "minus.circle" : "circle")
                        MergeStepEditor(step: step) { title, detail in
                            var steps = queue.steps
                            guard let index = steps.firstIndex(where: { $0.id == step.id }) else { return }
                            steps[index].title = title; steps[index].detail = detail; write(steps)
                        }
                        Button { move(step.id, by: -1) } label: { Image(systemName: "arrow.up") }
                            .accessibilityLabel(L.t("native_merge_move_up"))
                        Button { move(step.id, by: 1) } label: { Image(systemName: "arrow.down") }
                            .accessibilityLabel(L.t("native_merge_move_down"))
                        Button(L.t("native_merge_remove")) { write(queue.steps.filter { $0.id != step.id }) }
                    }
                }
                TextField(L.t("native_merge_step"), text: $title)
                Button(L.t("native_merge_add")) {
                    var steps = queue.steps
                    steps.append(.init(id: UUID().uuidString, title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                        detail: "", status: .init(known: .pending), position: steps.count))
                    write(steps); title = ""
                }.disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || title.count > 200 || queue.steps.count >= 100)
                if MergeRules.canApprove(queue, status: session.status.rawValue, planning: planning,
                    reviewBlocked: MergeInputs.planReviewBlocked(app, session.id), ended: ended) {
                    Button(L.t("native_merge_approve")) {
                        model.perform { _ = try await store.client.approveBuildQueue(id: session.id) }
                    }
                }
                if MergeRules.canStart(queue, status: session.status.rawValue, planning: planning,
                    reviewBlocked: MergeInputs.planReviewBlocked(app, session.id), ended: ended) {
                    Button(L.t("buildqueue_start")) {
                        model.perform { try await store.client.replySession(id: session.id, text: L.t("buildqueue_start_steer")) }
                    }
                }
            }.disabled(model.busy || queue.steps.contains { $0.status.known == nil })
        }
    }
    private func move(_ id: String, by offset: Int) {
        var rows = queue.steps
        guard let index = rows.firstIndex(where: { $0.id == id }), rows.indices.contains(index + offset) else { return }
        rows.swapAt(index, index + offset); write(rows)
    }
    private func write(_ steps: [BuildStep]) {
        // Preserve the agent's stable IDs and statuses on replace. Unknown states are not edited.
        guard steps.allSatisfy({ $0.status.known != nil }) else { return }
        let rows = steps.map { BuildStepInput(id: $0.id, title: $0.title, detail: $0.detail,
            status: .init(rawValue: $0.status.rawValue)) }
        model.perform { _ = try await store.client.putBuildQueue(id: session.id, body: .init(steps: rows)) }
    }
}
struct MergeStepEditor: View {
    let step: BuildStep
    let save: (String, String) -> Void
    @State private var title = ""
    @State private var detail = ""
    var body: some View {
        VStack {
            TextField(L.t("native_merge_step"), text: $title)
            TextField(L.t("native_merge_step_detail"), text: $detail)
            Button(L.t("common_save")) {
                save(title.trimmingCharacters(in: .whitespacesAndNewlines), detail)
            }.disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || title.count > 200 || detail.count > 4000
                || (title == step.title && detail == step.detail))
        }.onAppear { title = step.title; detail = step.detail }
        .onChange(of: step.title) { title = step.title }
        .onChange(of: step.detail) { detail = step.detail }
    }
}
struct MergeOverviewView: View {
    let app: AppModel
    let store: SessionStore
    let model: MergeModel
    @State private var trainOpen = false
    @State private var base = "main"
    @State private var trainPRs: [MergeReadyPR] = []
    @State private var excluded = 0
    @State private var clearPreview: ClearMergedPreview?
    @State private var clearOpen = false
    @State private var queue: [DrainQueuedItem] = []
    @State private var armed = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(L.t("native_merge_overview")).font(.headline)
                if let error = model.error { Text(verbatim: error).foregroundStyle(.red) }
                ForEach(model.snapshot.automation, id: \.repoPath) { state in
                    Text(verbatim: "\(state.repoPath) · \(state.state ?? "—") · \(state.detail ?? "")")
                }
                ForEach(model.snapshot.drain, id: \.repoPath) { state in
                    HStack {
                        Text(verbatim: "\(state.repoPath) · \(state.inFlight)/\(state.max) · \(state.queued)")
                        if state.paused { Text(verbatim: state.reason ?? "—").foregroundStyle(.orange) }
                        Button(L.t("native_merge_queue")) {
                            model.perform(commit: { queue = $0 }) { try await store.client.listDrainQueue(repo: state.repoPath) }
                        }
                    }
                }
                ForEach(queue, id: \.number) { row in Text(verbatim: "#\(row.number) \(row.title)") }
                Button(L.t("native_merge_train")) {
                    let prs = MergeRules.ready(store.sessions, git: MergeInputs.git(app),
                        reviewing: Set(store.sessions.filter { MergeInputs.reviewing(app, $0.id) }.map(\.id)))
                    let chosen = MergeRules.train(prs)
                    trainPRs = chosen.prs; excluded = chosen.excluded
                    base = store.sessions.first(where: { $0.id == chosen.prs.first?.id })?.baseBranch ?? "main"
                    trainOpen = true
                }
                Button(L.t("clearmerged_title")) {
                    model.perform(commit: { clearPreview = $0; clearOpen = true }) {
                        try await store.client.previewClearMerged()
                    }
                }
                MergeOwedView(model: model, client: store.client)
            }.padding()
        }
        .sheet(isPresented: $trainOpen) {
            VStack(alignment: .leading) {
                Text(L.t("native_merge_train"))
                ForEach(trainPRs) { pr in Text(verbatim: "#\(pr.number) \(pr.title) · \(pr.repo)") }
                Text(L.t("native_merge_excluded", String(excluded)))
                Text(L.t("native_merge_train_warning"))
                TextField(L.t("native_merge_base"), text: $base)
                Button(L.t("common_cancel")) { trainOpen = false }.keyboardShortcut(.cancelAction)
                Button(L.t("native_merge_train")) {
                    guard let repo = trainPRs.first?.repo, armed else { return }
                    let request = MergeRules.request(repo: repo, base: base, prs: trainPRs)
                    model.perform { _ = try await store.create(request) }
                    trainOpen = false
                }.disabled(!armed || trainPRs.isEmpty || base.trimmingCharacters(in: .whitespaces).isEmpty || model.busy)
            }.padding().task {
                armed = false
                do { try await Task.sleep(for: .milliseconds(350)); armed = true } catch { armed = false }
            }
        }
        .sheet(isPresented: $clearOpen) {
            if let preview = clearPreview {
                VStack(alignment: .leading) {
                    Text(L.t("clearmerged_title"))
                    ForEach(preview.ids, id: \.self) { id in Text(verbatim: id) }
                    if preview.probesUnavailable { Text(L.t("clearmerged_probes_unavailable")) }
                    if preview.leftovers > 0 { Text(L.t("clearmerged_leftovers", String(preview.leftovers))) }
                    Button(L.t("common_cancel")) { clearOpen = false }.keyboardShortcut(.cancelAction)
                    Button(L.t("clearmerged_confirm", String(preview.ids.count)), role: .destructive) {
                        let ids = preview.ids
                        model.perform { _ = try await store.client.clearMergedSessions(body: .init(ids: ids)) }
                        clearOpen = false
                    }.disabled(preview.ids.isEmpty || model.busy)
                }.padding()
            }
        }
    }
}
```

Title/detail edits stay local until Save; typing never starts a request. Unknown statuses disable
the whole editor, including removal, so deleting an unknown row cannot bypass the guard.
Queue writes preserve IDs and statuses; the server assigns positions from the array order.
The queue's current approval is server-owned, so always re-read after replacement. Show drain
pause reason rather than offering a pretend drain API. Clear-merged lists the exact preview IDs,
leftover count and unavailable-probe warning; even an empty list is serialized explicitly. The
server intersects that list again, so sessions that become merged after preview are not cleared.
A train selects the most populated repository, preserving first-seen tie order; PRs from other
repositories are counted and excluded, exactly as the web does.

- [ ] **Step 3: Run green and commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/MergeRulesTests
bun run test:contract
git add native/Apps/ShepherdMac/Sources/Merge/MergePanels.swift
git commit -m "feat(mac): trains queues drain and post-merge actions"
```

### Task 9: Install views and publish seams

**Files:** `Sources/Merge/MergeStream.swift`, `Tests/MergeRegistrationTests.swift`.

**Interfaces:** consumes S0 registries and single-closure slots; produces idempotent model registration, composed sidebar/actions, merge command and tab.

- [ ] **Step 1: Write registry assertions**

```swift
import Foundation
import SwiftUI
import Testing
import ShepherdKit
@testable import Shepherd
@Suite(.serialized) @MainActor struct MergeRegistrationTests {
    @Test func installsOnceAndPreservesEarlierSlots() {
        let suite = "MergeRegistration-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer {
            defaults.removePersistentDomain(forName: suite)
            SidebarSlot.reset(); ActionBarSlot.reset(); DetailTabRegistry.reset()
            CommandRegistry.reset(); MergeStream.resetForTests()
        }
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
        var sidebarCalls = 0; var actionCalls = 0
        SidebarSlot.content = { _ in sidebarCalls += 1; return AnyView(EmptyView()) }
        ActionBarSlot.content = { _,_,_ in actionCalls += 1; return AnyView(EmptyView()) }
        MergeStream.installScene(); MergeStream.installScene()
        MergeStream.install(app); MergeStream.install(app)
        #expect(app.extensionFactories.count == 1)
        #expect(DetailTabRegistry.tabs.filter { $0.id == "merge" }.count == 1)
        #expect(CommandRegistry.commands(in: .session).filter { $0.id == "merge.overview" }.count == 1)
        _ = SidebarSlot.content?(app)
        #expect(sidebarCalls == 1)
        #expect(actionCalls == 0)
        app.teardown()
    }
}
```

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/MergeRegistrationTests
```

- [ ] **Step 2: Implement registration**

```swift
import SwiftUI
import ShepherdKit

struct MergeDetailTab: DetailTab {
    let id = "merge", systemImage = "arrow.triangle.merge", order = 600
    var title: String { L.t("native_merge_overview") }
    @MainActor func makeView(session: Session, store: SessionStore, app: AppModel) -> AnyView {
        guard let model = app.extension(MergeModel.self) else { return AnyView(EmptyView()) }
        return AnyView(MergeSessionView(app: app, session: session, store: store, model: model)
            .id("\(app.activationGeneration):\(session.id)"))
    }
}
struct MergeLauncher: View {
    let app: AppModel
    var body: some View {
        if let store = app.store, let model = app.extension(MergeModel.self) {
            @Bindable var model = model
            Button(L.t("native_merge_overview")) { model.showOverview = true }
                .sheet(isPresented: $model.showOverview) {
                    MergeOverviewView(app: app, store: store, model: model)
                        .id(app.activationGeneration).frame(minWidth: 620, minHeight: 440)
                }
        }
    }
}
@MainActor enum MergeStream {
    private static var wrapped = false
    static func installScene() {
        CommandRegistry.register(.init(id: "merge.overview", menu: .session, order: 600,
            titleKey: "native_merge_overview", isEnabled: { $0.extension(MergeModel.self) != nil },
            action: { $0.extension(MergeModel.self)?.showOverview = true }))
    }
    static func install(_ app: AppModel) {
        app.register(MergeModel.self)
        DetailTabRegistry.register(MergeDetailTab())
        guard !wrapped else { return }
        // S0 calls after S3/S4/S10. Never turn a nil fallback sidebar into an empty sidebar.
        guard let sidebar = SidebarSlot.content else { return }
        let actions = ActionBarSlot.content
        SidebarSlot.content = { app in
            AnyView(VStack(spacing: 0) { sidebar(app); MergeLauncher(app: app) })
        }
        ActionBarSlot.content = { session, store, app in
            AnyView(HStack {
                if let actions { actions(session, store, app) }
                if let model = app.extension(MergeModel.self), let q = model.snapshot.queues[session.id] {
                    Label("\(MergeRules.resolved(q))/\(q.steps.count)", systemImage: "list.bullet.rectangle")
                        .accessibilityLabel(L.t("native_merge_queue"))
                }
            })
        }
        wrapped = true
    }
    // Call only alongside SidebarSlot.reset/ActionBarSlot.reset in serialized tests.
    static func resetForTests() { wrapped = false }
}
```

- [ ] **Step 3: Give S0 the exact integration changes; do not edit its files**

```swift
// StreamRegistrations.installScene():
MergeStream.installScene()
// StreamRegistrations.installAll(into:), after S3/S4/S10:
MergeStream.install(app)
// Cross-stream composition in that same integration lane:
MergeInputs.git = { $0.extension(HerdSignals.self)?.git ?? [:] }
MergeInputs.reviewing = { app, id in app.extension(HerdSignals.self)?.isReviewing(id) ?? false }
MergeInputs.planReviewBlocked = { app, id in
    guard let plan = app.extension(PlanModel.self) else { return true }
    return PlanSignals.planReviewing(id) || plan.gates[id] != nil
}
MergeInputs.terminalEnded = { app, id in
    guard let herd = app.extension(HerdSignals.self) else { return true }
    return herd.claudeAlive[id] == false
}
SessionSignals.manualStepsOutstanding = { [weak app] in
    app?.extension(MergeModel.self)?.outstanding ?? [:]
}
QueuesPanels.register(.owed) { [weak app] in
    guard let app, let store = app.store, let model = app.extension(MergeModel.self) else {
        return AnyView(EmptyView())
    }
    return AnyView(MergeOwedView(model: model, client: store.client).id(app.activationGeneration))
}
```

The web blocks queue actions for both a reviewing **and an available** plan review; a boolean
reviewing-only seam is insufficient, hence the gate-presence lookup above. The native queue lives
outside the terminal tab: S0 uses S7's explicit `claudeAlive == false` as the ended-agent signal,
rather than capturing a view-owned terminal model. Missing models fail closed until integration.

S0 must register this owed replacement after `QueuesStream.install`, whose default panel uses the
same key. S7's existing repo selection can pass its selected repo set into `MergeOwedView.repos`;
without a selection the panel deliberately shows all repositories. Scene registration takes no
AppModel and performs no I/O. No new session composer slot is assigned by S9.

- [ ] **Step 4: Run green and commit**

```bash
./native/scripts/test-app.sh -only-testing:ShepherdTests/MergeRegistrationTests
git add native/Apps/ShepherdMac/Sources/Merge/MergeStream.swift native/Apps/ShepherdMac/Tests/MergeRegistrationTests.swift
git commit -m "feat(mac): install merge stream through registries"
```

### Task 10: Finish gates, read-only live smoke and PR

**Files:** `Tests/MergeLiveTests.swift`, stream branch and PR.

**Interfaces:** consumes all previous tasks and an optional operator-provided bearer; produces reviewable parity evidence and explicit integration handoff.

- [ ] **Step 1: Add an opt-in read-only live test**

```swift
import Foundation
import Testing
import ShepherdKit
@testable import Shepherd
struct MergeLiveTests {
    @Test func readOnlyOperatorServer() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let raw = env["SHEPHERD_LIVE_BASE_URL"],
              let token = env["SHEPHERD_LIVE_TOKEN"], !token.isEmpty else { return }
        let url = try RemoteServerForm.normalize(raw)
        let credentials = InMemoryCredentialStore()
        try credentials.save(.init(token: token, tokenId: "external"), for: "live")
        let client = try ShepherdClient(profile: .init(name: "live", baseURL: url,
            mode: .remote, credentialKey: "live"), credentials: credentials)
        async let auto = client.listAutomerge()
        async let drain = client.listDrain()
        async let queues = client.listBuildQueues()
        async let owed = client.listOutstandingManualSteps()
        let result = try await (auto, drain, queues, owed)
        #expect(result.2.allSatisfy { $0.key == $0.value.sessionId })
        #expect(result.3.allSatisfy { $0.clearedAt == nil })
    }
}
```

Live checks send GETs only. Never merge, toggle automation, start a train, approve/start a queue,
drain, redeploy, clear, acknowledge, tick or dismiss against the operator server. Fixture tests
exercise writes locally. If live credentials are absent, report “not run”; a skipped test is not
live evidence. Do not print the token or put it in a command line argument.

- [ ] **Step 2: Run the complete gates once**

```bash
bun run lint
bun run typecheck
bun run test
bun run test:contract
bun run gen:contract-swift && bun run check:contract-swift
./native/scripts/sync-contract.sh --check
bun native/scripts/gen-strings.ts --check
swift test --package-path native
./native/scripts/test-app.sh -only-testing:ShepherdTests
./native/scripts/build-app.sh
git checkout -- native/Package.resolved
rg 'import AppKit|NSWindow|\.toolbar' native/Apps/ShepherdMac/Sources/Merge || true
git diff --check
git diff --name-only origin/main
```

The `rg` check must have no matches. Audit changed paths against Ownership above. Compare every
rule test with the named web helper, inspect the actual generated null encoder, and confirm all
declared statuses appear in this stream's own coverage gate. Verify with an isolated profile switch
that a queued GET/event completion cannot repaint the new profile and closing the app finishes the
watcher. Task 7 and the S9 acceptance gate are blocked until the S0 takeover prerequisite and
its contract/transport regressions have merged; a refusal-only UI does not complete S9.

- [ ] **Step 3: Commit final tests and open the stream PR**

```bash
git add native/Apps/ShepherdMac/Tests/MergeLiveTests.swift
git commit -m "test(mac): read-only merge smoke and final gates"
git push --no-verify -u origin feat/native-merge
cat > /tmp/native-merge-pr.md <<'BODY'
Adds the merge contract and generated client, activation-safe merge snapshots, durable owed
steps, session automation, merge confirmation, trains, drain status, build queues and clear-merged.

Validation: contract status/event coverage, Swift transport/rule/lifecycle tests, app build,
lint, typecheck, contract and string drift. Record the actual read-only live outcome before posting.

Integration: S0 installs the scene/model and owed panel, wires MergeInputs and manualStepsOutstanding.
Requires the merged S0 mergeGate/baseRefName/confirm extension; takeover confirmation is included.
BODY
gh pr create --base main --title "feat(native): merge automation and post-merge" --body-file /tmp/native-merge-pr.md
```
